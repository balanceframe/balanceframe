/**
 * POST /api/proposal/[id]/execute — execute a rule proposal by creating the
 * Actual rule, syncing the budget, and superseding the proposal.
 *
 * Flow:
 *   1. Load the proposal from the workflow store
 *   2. Validate it is not superseded or expired
 *   3. Extract `nativeRule` from the proposal's preconditions
 *   4. Verify the actor has an active approval for this proposal payload
 *   5. Atomically claim the idempotency record (prevents concurrent duplicates)
 *   6. If first owner: consume approval, connect to Actual, create rule, sync,
 *      supersede proposal, complete idempotency record
 *   7. If retry/replay: return cached success or error from idempotency record
 *
 * Error codes:
 *   400 — MISSING_PROPOSAL_ID
 *   404 — PROPOSAL_NOT_FOUND
 *   409 — PROPOSAL_SUPERSEDED / PROPOSAL_EXPIRED / EXECUTION_IN_PROGRESS
 *   422 — NATIVE_RULE_MISSING
 *   500 — RULE_EXECUTION_FAILED
 */

import { setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../../utils/workflow-store';
import { createMutationConnectionManager } from '../../../utils/mutation-executor';

// ---------------------------------------------------------------------------
// Minimal ledger handle — mirrors the createRule contract from BudgetLedger
// without introducing a hard dependency on @balanceframe/actual-adapter types
// in Nitro's module resolution.
// ---------------------------------------------------------------------------

interface LedgerHandle {
  createRule(rule: {
    name?: string;
    stage?: string | null;
    conditionsOp?: string;
    conditions: unknown[];
    actions: unknown[];
  }): Promise<{ success: boolean; id?: string; error?: string; code?: string }>;
  synchronize(): Promise<unknown>;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'rule.execute');
  const requestId = crypto.randomUUID();

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
    // 3. Extract nativeRule from preconditions
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

    const nativeRule = preconditionsObject.nativeRule as Record<string, unknown> | undefined;
    if (!nativeRule || typeof nativeRule !== 'object') {
      setResponseStatus(event, 422);
      return errorEnvelope(
        'NATIVE_RULE_MISSING',
        'Proposal does not contain a nativeRule in its preconditions.',
        authInfo,
        false,
        requestId,
      );
    }

    const conditions = Array.isArray(nativeRule.conditions) ? nativeRule.conditions : [];
    const actions = Array.isArray(nativeRule.actions) ? nativeRule.actions : [];

    // Extract a human-readable rule name from the payee_name condition
    const payeeCondition = conditions.find(
      (c: unknown) =>
        typeof c === 'object' && c !== null && (c as Record<string, unknown>).field === 'payee_name',
    );
    const ruleName = payeeCondition
      ? String((payeeCondition as Record<string, unknown>).value ?? 'unnamed_rule')
      : 'unnamed_rule';

    // -------------------------------------------------------------------
    // 4. Verify active approval before idempotency claim
    //
    // Check the actor has an active approval matching the proposal payload
    // BEFORE claiming the idempotency record.  This prevents creating
    // idempotency records for unauthorised requests that would otherwise
    // require explicit cleanup or expire on their own.
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
    // 5. Atomic claim via idempotency record
    //
    // Use a deterministic key scoped to the actor so concurrent requests
    // by the same actor serialise.  The idempotency key includes the
    // authenticated actor identity so a different actor cannot replay or
    // observe another actor's execution result without their own
    // authorization check.
    // Only the first caller (isOwner === true) proceeds with consumption
    // and mutation; subsequent callers observe the completed record or
    // return EXECUTION_IN_PROGRESS.
    // -------------------------------------------------------------------
    const idempotencyKey = `${proposalId}:execute:${actorId}`;
    const serialisedEffect = JSON.stringify({
      ruleName,
      conditions,
      actions,
      conditionsOp: nativeRule.conditionsOp ?? 'and',
      stage: nativeRule.stage ?? null,
      payloadHash: proposal.payloadHash,
    });

    const claim = await wf.store.createIdempotencyRecord({
      idempotencyKey,
      proposalId,
      operation: 'rule_execute',
      serialisedEffect,
    });

    if (!claim.isOwner) {
      // Another request already claimed execution.
      // Check whether it completed.
      const currentProposal = await wf.store.getProposal(proposalId);
      if (currentProposal?.supersededAt) {
        // The rule was already created — return idempotent success.
        return okEnvelope(
          {
            ruleId: null,
            name: ruleName,
            proposalId,
            alreadyExecuted: true,
          },
          authInfo,
          requestId,
        );
      }

      const currentRecord = await wf.store.getIdempotencyRecord(idempotencyKey);
      if (currentRecord?.completed && currentRecord.errorMessage) {
        setResponseStatus(event, 500);
        return errorEnvelope(
          'RULE_EXECUTION_FAILED',
          currentRecord.errorMessage,
          authInfo,
          false,
          requestId,
        );
      }

      if (currentRecord?.completed) {
        // Completed successfully but proposal not superseded (edge case).
        return okEnvelope(
          {
            ruleId: null,
            name: ruleName,
            proposalId,
            alreadyExecuted: true,
          },
          authInfo,
          requestId,
        );
      }

      setResponseStatus(event, 409);
      return errorEnvelope(
        'EXECUTION_IN_PROGRESS',
        'Concurrent execution in progress for this proposal. Retry after completion.',
        authInfo,
        false,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 6. Consume the approval atomically BEFORE any external mutation
    //
    // We own the idempotency record, so only this request will reach this
    // point.  consumeApproval throws if the approval has already been
    // consumed (e.g. by a concurrent actor-specific approval check before
    // the idempotency claim was finalised).
    // -------------------------------------------------------------------
    try {
      await wf.store.consumeApproval(matchingApproval.id);
    } catch (err) {
      await wf.store.completeIdempotencyRecord(
        idempotencyKey,
        `Approval already consumed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setResponseStatus(event, 409);
      return errorEnvelope(
        'APPROVAL_CONSUMPTION_FAILED',
        err instanceof Error ? err.message : 'Failed to consume approval',
        authInfo,
        false,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 7. Connect to Actual ledger
    // -------------------------------------------------------------------
    const manager = createMutationConnectionManager();

    let ledger: LedgerHandle;
    try {
      const connected = await manager.restore();
      ledger = connected.connector as unknown as LedgerHandle;
    } catch (err) {
      // Record the failure so retries see the cached error
      await wf.store.completeIdempotencyRecord(
        idempotencyKey,
        `Failed to restore budget connection: ${err instanceof Error ? err.message : String(err)}`,
      );
      setResponseStatus(event, 503);
      return errorEnvelope(
        'LEDGER_UNAVAILABLE',
        `Failed to restore budget connection: ${err instanceof Error ? err.message : String(err)}`,
        authInfo,
        true,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 8. Create the rule via connector
    // -------------------------------------------------------------------
    let createResult: { success: boolean; id?: string; error?: string; code?: string };
    try {
      createResult = await ledger.createRule({
        name: ruleName,
        stage: (nativeRule.stage as string | null | undefined) ?? null,
        conditionsOp: (nativeRule.conditionsOp as string | undefined) ?? 'and',
        conditions,
        actions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create rule via ledger';
      await wf.store.completeIdempotencyRecord(idempotencyKey, message);
      setResponseStatus(event, 500);
      return errorEnvelope('RULE_EXECUTION_FAILED', message, authInfo, false, requestId);
    }

    if (!createResult.success) {
      const message = createResult.error ?? 'Ledger returned failure without message';
      await wf.store.completeIdempotencyRecord(idempotencyKey, message);
      setResponseStatus(event, 500);
      return errorEnvelope('RULE_EXECUTION_FAILED', message, authInfo, false, requestId);
    }

    // -------------------------------------------------------------------
    // 9. Post-creation synchronize (non-fatal)
    // -------------------------------------------------------------------
    try {
      await ledger.synchronize();
    } catch {
      // Non-fatal — the rule was created
    }

    // -------------------------------------------------------------------
    // 10. Supersede the proposal
    // -------------------------------------------------------------------
    try {
      await wf.store.supersedeProposal(proposalId);
    } catch {
      // Non-fatal — the rule is created and approval consumed
    }

    // -------------------------------------------------------------------
    // 11. Complete the idempotency record (success)
    // -------------------------------------------------------------------
    await wf.store.completeIdempotencyRecord(idempotencyKey, null);

    return okEnvelope(
      {
        ruleId: createResult.id ?? null,
        name: ruleName,
        proposalId,
      },
      authInfo,
      requestId,
    );
  } catch (e) {
    setResponseStatus(event, 500);

    return errorEnvelope(
      'RULE_EXECUTION_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      false,
      requestId,
    );
  }
});
