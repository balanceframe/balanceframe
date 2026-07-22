/**
 * POST /api/proposal/[id]/execute — execute a rule proposal by creating the
 * Actual rule, syncing the budget, and superseding the proposal.
 *
 * Flow:
 *   1. Load the proposal from the workflow store
 *   2. Validate it is not superseded or expired
 *   3. Extract `nativeRule` from the proposal's preconditions
 *   4. Connect to Actual via createDefaultConnectionManager
 *   5. Call connector.createRule() with the native rule shape
 *   6. Perform a post-creation synchronize
 *   7. Supersede the proposal (prevents replay)
 *   8. Return the created rule ID and name
 *
 * Error codes:
 *   400 — MISSING_PROPOSAL_ID
 *   404 — PROPOSAL_NOT_FOUND
 *   409 — PROPOSAL_SUPERSEDED / PROPOSAL_EXPIRED
 *   422 — NATIVE_RULE_MISSING
 *   503 — STORE_UNAVAILABLE / LEDGER_UNAVAILABLE
 *   500 — RULE_EXECUTION_FAILED
 */

import { setResponseStatus } from 'h3';
import { createDefaultConnectionManager } from '@balanceframe/application';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../../utils/workflow-store';

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

    // Approval is consumed only after the ledger mutation succeeds. Keeping
    // it active during validation/connection/mutation lets transient ledger
    // failures be retried without re-approval.

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
    // 4. Extract nativeRule from preconditions
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
    // 4. Connect to Actual ledger
    // -------------------------------------------------------------------
    const manager = createDefaultConnectionManager();

    let ledger: LedgerHandle;
    try {
      const connected = await manager.restore();
      // The connector at runtime is an ActualConnector.
      // Cast through unknown to match the minimal LedgerHandle interface.
      ledger = connected.connector as unknown as LedgerHandle;
    } catch (err) {
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
    // 5. Create the rule via connector
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
      setResponseStatus(event, 500);
      return errorEnvelope(
        'RULE_EXECUTION_FAILED',
        err instanceof Error ? err.message : 'Failed to create rule via ledger',
        authInfo,
        false,
        requestId,
      );
    }

    if (!createResult.success) {
      setResponseStatus(event, 500);
      return errorEnvelope(
        'RULE_EXECUTION_FAILED',
        createResult.error ?? 'Ledger returned failure without message',
        authInfo,
        false,
        requestId,
      );
    }

    // -------------------------------------------------------------------
    // 6. Post-creation synchronize
    // -------------------------------------------------------------------
    try {
      await ledger.synchronize();
    } catch {
      // Non-fatal — the rule was created; sync failure shouldn't block
    }

    // -------------------------------------------------------------------
    // 7. Re-check and consume the approval after successful mutation
    // -------------------------------------------------------------------
    const activeApprovalsAfterMutation = await wf.store.findActiveApprovals(proposalId);
    const matchingApprovalAfterMutation = activeApprovalsAfterMutation.find(
      (a) => a.actorId === actorId && a.payloadHash === proposal.payloadHash,
    );
    if (!matchingApprovalAfterMutation) {
      setResponseStatus(event, 403);
      return errorEnvelope(
        'PROPOSAL_NOT_APPROVED',
        'This proposal has no active approval for the current actor.',
        authInfo,
        false,
        requestId,
      );
    }
    try {
      await wf.store.consumeApproval(matchingApprovalAfterMutation.id);
    } catch (err) {
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
    // 7. Supersede the proposal (prevents replay)
    // -------------------------------------------------------------------
    try {
      await wf.store.supersedeProposal(proposalId);
    } catch {
      // Non-fatal — proposal still exists but won't be re-executed
    }

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
