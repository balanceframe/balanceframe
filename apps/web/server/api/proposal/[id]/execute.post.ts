/**
 * POST /api/proposal/[id]/execute — execute a rule proposal via the
 * RuleMutationService, which enforces simulation, precondition checks,
 * payload binding, idempotency, and post-write verification.
 *
 * Flow:
 *   1. Load the proposal from the workflow store
 *   2. Validate it is not superseded or expired
 *   3. Extract rule data from the proposal's preconditions
 *   4. Verify the actor has an active approval for this proposal payload
 *   5. Connect to the Actual ledger via ConnectionManager.restore()
 *   6. Create the native rule mutation protocol (or return NOT_IMPLEMENTED)
 *   7. Compose RuleMutationService and execute
 *   8. Supersede the proposal on success
 *   9. Map the service result to the API envelope
 *
 * Error codes:
 *   400 — MISSING_PROPOSAL_ID
 *   404 — PROPOSAL_NOT_FOUND
 *   403 — PROPOSAL_NOT_APPROVED
 *   409 — PROPOSAL_SUPERSEDED / PROPOSAL_EXPIRED
 *   422 — INVALID_PRECONDITIONS / NATIVE_RULE_MISSING
 *   501 — NOT_IMPLEMENTED (native protocol unavailable)
 *   503 — LEDGER_UNAVAILABLE
 *   500 — RULE_EXECUTION_FAILED
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  buildAuthorizationInfo,
  sanitizeError,
} from '../../../utils/workflow-store';
import { createMutationConnectionManager } from '../../../utils/mutation-executor';
import {
  RuleMutationService,
  createNativeRuleMutationProtocol,
} from '@balanceframe/application';
import type { BudgetLedger } from '@balanceframe/actual-adapter';
import type { RustRuleMutationProtocol, ExecuteRuleResult } from '@balanceframe/application';

/**
 * Map reason codes from the service to HTTP status codes and public error codes.
 * All transient/unexpected failures are marked retryable.
 */
function mapServiceError(reasonCodes: string[]): { status: number; code: string; retryable: boolean } {
  // Replay of a previously failed or successful execution — idempotent
  if (reasonCodes.includes('idempotency_replay')) {
    return { status: 200, code: 'IDEMPOTENCY_REPLAY', retryable: false };
  }

  // Concurrent execution collision — retryable
  if (reasonCodes.includes('idempotency_in_progress')) {
    return { status: 409, code: 'EXECUTION_IN_PROGRESS', retryable: true };
  }

  // Authorization / approval failures — NOT retryable
  if (reasonCodes.includes('member_inactive') || reasonCodes.includes('insufficient_capability') || reasonCodes.includes('insufficient_scope')) {
    return { status: 403, code: 'AUTHORIZATION_DENIED', retryable: false };
  }
  if (reasonCodes.includes('approval_not_found') || reasonCodes.includes('approval_consumed') || reasonCodes.includes('approval_expired') || reasonCodes.includes('approval_superseded') || reasonCodes.includes('approval_proposal_mismatch')) {
    return { status: 409, code: 'APPROVAL_FAILED', retryable: false };
  }
  if (reasonCodes.includes('payload_hash_mismatch')) {
    return { status: 422, code: 'PAYLOAD_HASH_MISMATCH', retryable: false };
  }

  // Proposal state failures — NOT retryable
  if (reasonCodes.includes('proposal_not_found')) {
    return { status: 404, code: 'PROPOSAL_NOT_FOUND', retryable: false };
  }
  if (reasonCodes.includes('proposal_superseded')) {
    return { status: 409, code: 'PROPOSAL_SUPERSEDED', retryable: false };
  }
  if (reasonCodes.includes('proposal_expired')) {
    return { status: 409, code: 'PROPOSAL_EXPIRED', retryable: false };
  }
  if (reasonCodes.includes('unsupported_operation')) {
    return { status: 422, code: 'UNSUPPORTED_OPERATION', retryable: false };
  }

  // Precondition / simulation failures — NOT retryable (bad proposal data)
  if (reasonCodes.includes('rule_name_conflict') || reasonCodes.includes('simulation_no_matches') || reasonCodes.includes('simulation_conflicts')) {
    return { status: 422, code: 'PRECONDITION_FAILED', retryable: false };
  }

  // Planning / simulation errors — transient
  if (reasonCodes.includes('plan_failed') || reasonCodes.includes('simulation_failed')) {
    return { status: 500, code: 'PLANNING_FAILED', retryable: true };
  }

  // Sync / reread failures — transient
  if (reasonCodes.includes('sync_failed') || reasonCodes.includes('reread_failed') || reasonCodes.includes('stale_snapshot')) {
    return { status: 503, code: 'LEDGER_SYNC_FAILED', retryable: true };
  }

  // Idempotency mismatch — retryable
  if (reasonCodes.includes('idempotency_replay_mismatch')) {
    return { status: 409, code: 'IDEMPOTENCY_MISMATCH', retryable: false };
  }

  // Write failures — retryable (transient ledger failure)
  if (reasonCodes.includes('write_failed')) {
    return { status: 500, code: 'RULE_EXECUTION_FAILED', retryable: true };
  }

  // Fallback — treat as retryable to be safe
  return { status: 500, code: 'RULE_EXECUTION_FAILED', retryable: true };
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const authCheck = await requireAuthorization(event, 'rule.execute');
  if (!authCheck.ok) return authCheck.response;
  const authInfo = authCheck.info;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  const proposalId = event.context.params?.id;
  if (!proposalId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', authInfo, false, requestId);
  }

  try {
    // -------------------------------------------------------------------
    // 1. Load the proposal
    // -------------------------------------------------------------------
    const proposal = await wf.store.getProposal(proposalId);
    if (!proposal) {
      setResponseStatus(event, 404);
      return errorEnvelope('PROPOSAL_NOT_FOUND', 'Proposal not found.', authInfo, false, requestId);
    }

    // -------------------------------------------------------------------
    // 2. Validate proposal state
    // -------------------------------------------------------------------
    if (proposal.supersededAt) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PROPOSAL_SUPERSEDED',
        'This proposal has already been superseded.',
        authInfo,
        false,
        requestId,
      );
    }

    const expiryTime = new Date(proposal.expiresAt).getTime();
    if (expiryTime <= Date.now()) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PROPOSAL_EXPIRED',
        'This proposal has expired.',
        authInfo,
        false,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 3. Extract rule data from preconditions (for display / approval matching)
    // -------------------------------------------------------------------
    let preconditionsObject: Record<string, unknown>;
    try {
      preconditionsObject = JSON.parse(proposal.preconditions) as Record<string, unknown>;
    } catch {
      setResponseStatus(event, 422);
      return errorEnvelope(
        'INVALID_PRECONDITIONS',
        'Proposal preconditions are not valid JSON.',
        authInfo,
        false,
        requestId,
      );
    }

    // The service's buildRuleProposal handles both flat and nativeRule-nested
    // formats internally, but for early validation we extract the name here.
    const ruleName =
      (preconditionsObject.name as string) ??
      (preconditionsObject.nativeRule &&
        typeof preconditionsObject.nativeRule === 'object' &&
        ((preconditionsObject.nativeRule as Record<string, unknown>).name as string)) ??
      'unnamed_rule';

    // -------------------------------------------------------------------
    // 4. Verify active approval
    //
    // Find an active approval matching this actor and payload hash BEFORE
    // composing the service.  The service performs deeper validation (binding,
    // status, expiry) once invoked, but this early check avoids unnecessary
    // connection overhead for clearly unauthorised requests.
    // -------------------------------------------------------------------
    const actorId = getActorId(event);
    const activeApprovals = await wf.store.findActiveApprovals(proposalId);
    const matchingApproval = activeApprovals.find(
      (a) => a.actorId === actorId && a.payloadHash === proposal.payloadHash,
    );
    if (!matchingApproval) {
      setResponseStatus(event, 403);
      return errorEnvelope(
        'PROPOSAL_NOT_APPROVED',
        'This proposal has no active approval for the current actor. ' +
          'Call POST /api/proposal/[id]/approve first to authorize execution.',
        authInfo,
        false,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 5. Connect to Actual ledger
    // -------------------------------------------------------------------
    const manager = createMutationConnectionManager();

    let ledger: BudgetLedger;
    try {
      const connected = await manager.restore();
      ledger = connected.connector as unknown as BudgetLedger;
    } catch (err) {
      const safe = sanitizeError(err, requestId, 'LEDGER_UNAVAILABLE', true);
      setResponseStatus(event, 503);
      return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
    }

    // -------------------------------------------------------------------
    // 6. Create native rule mutation protocol
    //
    // The Rust protocol (planCreateRule, simulateRule, verifyRuleMutation)
    // is required for safe execution.  If the native addon is unavailable on
    // this server, return a stable NOT_IMPLEMENTED response rather than
    // mutating Actual without simulation/verification.
    // -------------------------------------------------------------------
    let rust: RustRuleMutationProtocol;
    try {
      rust = await createNativeRuleMutationProtocol();
    } catch (err) {
      sanitizeError(err, requestId, 'NOT_IMPLEMENTED', false);
      setResponseStatus(event, 501);
      return errorEnvelope(
        'NOT_IMPLEMENTED',
        'Rule execution requires the native rule mutation protocol, ' +
          'which is not available on this server.',
        authInfo,
        false,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 7. Compose RuleMutationService and execute
    //
    // The service handles the full secure flow:
    //   - Authorization (evaluateAuthorization)
    //   - Idempotency claim (atomic check-and-create)
    //   - Approval validation (binding, payload hash, status)
    //   - Approval consumption (one-time lock)
    //   - Audit start
    //   - Snapshot synchronize + staleness check
    //   - Rust planCreateRule (precondition check)
    //   - Rust simulateRule (simulation with evidence)
    //   - ledger.createRule (the actual mutation — the only write to Actual)
    //   - Reread + Rust verifyRuleMutation (postcondition verification)
    //   - Idempotency completion
    //   - Audit completion
    // -------------------------------------------------------------------
    const idempotencyKey = `${proposalId}:execute:${actorId}`;
    const service = new RuleMutationService(wf.store, ledger, rust);

    let result: ExecuteRuleResult;
    try {
      result = await service.execute({
        proposalId,
        actorId,
        idempotencyKey,
        approvalId: matchingApproval.id,
        requestId,
      });
    } catch (err) {
      const safe = sanitizeError(err, requestId, 'RULE_EXECUTION_FAILED', true);
      setResponseStatus(event, 500);
      return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
    }

    // -------------------------------------------------------------------
    // 8. Handle replay (idempotent completion)
    // -------------------------------------------------------------------
    if (result.reasonCodes.includes('idempotency_replay')) {
      if (result.success && result.verified) {
        // Previous execution completed successfully
        return okEnvelope(
          {
            ruleId: result.ruleId,
            name: ruleName,
            proposalId,
            alreadyExecuted: true,
          },
          authInfo,
          requestId,
        );
      }
      // Previous execution failed — return cached error
      const { status, code, retryable } = mapServiceError(result.reasonCodes);
      setResponseStatus(event, status);
      return errorEnvelope(
        code,
        result.message ?? 'Previous execution failed',
        authInfo,
        retryable,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 9. Handle execution failure
    // -------------------------------------------------------------------
    if (!result.success) {
      const { status, code, retryable } = mapServiceError(result.reasonCodes);
      setResponseStatus(event, status);
      return errorEnvelope(
        code,
        result.message ?? 'Rule execution failed',
        authInfo,
        retryable,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 10. Supersede the proposal on success (non-fatal)
    // -------------------------------------------------------------------
    try {
      await wf.store.supersedeProposal(proposalId);
    } catch {
      // Non-fatal — the rule is created and verified
    }

    // -------------------------------------------------------------------
    // 11. Return success
    // -------------------------------------------------------------------
    return okEnvelope(
      {
        ruleId: result.ruleId,
        name: ruleName,
        proposalId,
      },
      authInfo,
      requestId,
    );
  } catch (e) {
    const safe = sanitizeError(e, requestId, 'RULE_EXECUTION_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
