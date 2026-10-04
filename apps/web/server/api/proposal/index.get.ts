import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { ProposalAcquisitionError } from '@balanceframe/workflow-store';
import type { ActionProposal, GenericProposalOperation } from '@balanceframe/workflow-store';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import type { ProposalApprovalView } from '../../utils/proposal-approval-view';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import { errorEnvelope, getWorkflowStore, okEnvelope, sanitizeError } from '../../utils/workflow-store';

interface ActionProposalListItem {
  readonly id: string;
  readonly operation: GenericProposalOperation;
  readonly budgetId: string;
  readonly transactionId: string | null;
  readonly categoryId: string | null;
  readonly ruleId: string | null;
  readonly preconditions: string;
  readonly expiresAt: string;
  readonly actorId: string;
  readonly provenance: string;
  readonly providerModel: string | null;
  readonly correlationId: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;
  readonly simulationStatus: 'present' | 'missing' | 'stale';
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Proposals are unavailable.', null, true, requestId);
  }

  try {
    const proposals = await workflow.store.listProposals({
      budgetId: selected.space.budgetId,
      superseded: false,
      operations: ['set_category', 'create_rule', 'update_rule', 'delete_rule'],
      limit: -1,
    });
    const items: ActionProposalListItem[] = [];
    const now = new Date().toISOString();
    for (const proposal of proposals) {
      if (proposal.spaceId !== selected.space.id ||
          (proposal.operation !== 'set_category' && proposal.operation !== 'create_rule' &&
           proposal.operation !== 'update_rule' && proposal.operation !== 'delete_rule')) continue;
      let view: ProposalApprovalView | null;
      try {
        view = await buildProposalApprovalView({
          store: workflow.store, proposal, actorId: selected.auth.actorId, auth: selected.auth, now,
          requestId,
        });
      } catch (error) {
        if (error instanceof ProposalAcquisitionError &&
            (error.reasonCode === 'authorization_denied' ||
             error.reasonCode === 'policy_version_mismatch' ||
             error.reasonCode === 'payload_hash_mismatch')) continue;
        throw error;
      }
      if (!view) continue;
      const payload = view.payload;
      items.push({
        id: proposal.id,
        operation: proposal.operation,
        budgetId: proposal.budgetId,
        transactionId: payload && 'transactionId' in payload ? payload.transactionId : null,
        categoryId: payload && 'categoryId' in payload ? payload.categoryId : null,
        ruleId: payload && 'ruleId' in payload ? payload.ruleId : null,
        preconditions: JSON.stringify(view.preconditions),
        expiresAt: proposal.expiresAt,
        actorId: proposal.actorId,
        provenance: proposal.provenance,
        providerModel: proposal.providerModel,
        correlationId: proposal.correlationId,
        supersededAt: proposal.supersededAt,
        createdAt: proposal.createdAt,
        simulationStatus: computeSimulationStatus(proposal),
      });
    }
    return okEnvelope({ proposals: items, total: items.length }, null, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, null, false, requestId);
  }
});

function computeSimulationStatus(proposal: ActionProposal): 'present' | 'missing' | 'stale' {
  let preconditions: unknown;
  try {
    preconditions = JSON.parse(proposal.preconditions) as unknown;
  } catch {
    return 'missing';
  }
  if (!preconditions || typeof preconditions !== 'object' || Array.isArray(preconditions))
    return 'missing';
  const simulation = Object.prototype.hasOwnProperty.call(preconditions, 'simulation')
    ? (preconditions as Record<string, unknown>).simulation
    : null;
  if (!simulation || typeof simulation !== 'object' || Array.isArray(simulation))
    return 'missing';
  const expiry = Date.parse(proposal.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now() ? 'stale' : 'present';
}
