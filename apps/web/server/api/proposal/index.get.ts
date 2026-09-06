import { requireFullRead } from '../../utils/legacy-financial-read';
/**
 * GET /api/proposal — list categorization proposals.
 *
 * Queries persisted proposals from the workflow store.
 * Returns non-superseded proposals ordered by creation time descending.
 * Each proposal includes a `simulationStatus` field computed from
 * stored preconditions.
 *
 * Response envelope:
 *   { proposals: ActionProposalListItem[], total: number }
 */

import type { ActionProposal } from '@balanceframe/workflow-store';
import { getWorkflowStore, okEnvelope, errorEnvelope } from '../../utils/workflow-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A proposal list item enriched with simulation status and preconditions. */
export interface ActionProposalListItem {
  readonly id: string;
  readonly operation: string;
  readonly budgetId: string;
  readonly transactionId: string | null;
  readonly categoryId: string;
  /** JSON-encoded preconditions (includes merchant, source, reviewId, nativeRule, simulation). */
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

interface PreconditionsShape {
  merchant?: string;
  source?: string;
  reviewId?: string;
  nativeRule?: unknown;
  simulation?: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const fullRead = await requireFullRead(event);
  if (!fullRead.ok) return fullRead.response;
  const authInfo = fullRead.info;
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const proposals = await wf.store.listProposals({
      budgetId: fullRead.budgetId,
      superseded: false,
      operations: ['set_category', 'create_rule'],
    });

    const items: ActionProposalListItem[] = proposals
      .filter((p) => p.operation === 'set_category' || p.operation === 'create_rule')
      .map((p) => {
        const simulationStatus = computeSimulationStatus(p);
        return {
          id: p.id,
          operation: p.operation,
          budgetId: p.budgetId,
          transactionId: p.payload.transactionId,
          categoryId: p.payload.categoryId,

          preconditions: p.preconditions,
          expiresAt: p.expiresAt,
          actorId: p.actorId,
          provenance: p.provenance,
          providerModel: p.providerModel,
          correlationId: p.correlationId,
          supersededAt: p.supersededAt,
          createdAt: p.createdAt,
          simulationStatus,
        };
      });

    // Independent total count for pagination
    const total = await wf.store.countProposals({
      budgetId: fullRead.budgetId,
      superseded: false,
      operations: ['set_category', 'create_rule'],
    });

    return okEnvelope({ proposals: items, total }, authInfo, requestId);
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'LIST_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      false,
      requestId,
    );
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSimulationStatus(p: ActionProposal): 'present' | 'missing' | 'stale' {
  let parsed: PreconditionsShape;
  try {
    parsed = JSON.parse(p.preconditions);
  } catch {
    return 'missing';
  }

  if (!parsed.simulation) {
    return 'missing';
  }

  // Stale if the proposal itself is expired
  try {
    if (new Date(p.expiresAt).getTime() <= Date.now()) {
      return 'stale';
    }
  } catch {
    return 'stale';
  }

  return 'present';
}
