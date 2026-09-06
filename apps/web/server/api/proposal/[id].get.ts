import { requireFullRead } from '../../utils/legacy-financial-read';
/**
 * GET /api/proposal/[id] — show a single categorization proposal with
 * full detail including decoded simulation evidence.
 *
 * Retrieves the proposal from the workflow store, decodes simulation
 * evidence from the stored preconditions, and checks staleness against
 * the proposal's expiry timestamp.
 *
 * Response envelope:
 *   {
 *     proposal: ActionProposalDetail,
 *     simulation: SimulationEvidence | null,
 *     stale: boolean,
 *     simulationStatus: 'present' | 'missing' | 'stale'
 *   }
 */

import { getWorkflowStore, okEnvelope, errorEnvelope } from '../../utils/workflow-store';
import type { ActionProposal } from '@balanceframe/workflow-store';

// ---------------------------------------------------------------------------
// Simulation evidence types — mirrors the package-level shape without
// introducing a hard dependency on @balanceframe/application at the web tier.
// ---------------------------------------------------------------------------

/** An example transaction from simulation. */
export interface SimulationExample {
  readonly txId: string;
  readonly payee: string | null;
  readonly amount: { minorUnits: string; currency: string };
  readonly currentCategory: string | null;
  readonly wouldChange: boolean;
}

/** Full simulation evidence stored alongside a rule proposal. */
export interface SimulationEvidence {
  readonly transactionsMatched: number;
  readonly transactionsAffected: readonly string[];
  readonly categoryDistribution: Record<string, number>;
  readonly conflicts: readonly string[];
  readonly examples: readonly SimulationExample[];
  readonly simulatedAt: string;
}

/** Decoded preconditions potentially carrying simulation evidence. */
interface PreconditionsWithSimulation {
  merchant?: string;
  source?: string;
  reviewId?: string;
  simulation?: SimulationEvidence;
}

/** Enriched proposal detail returned to the client. */
export interface ActionProposalDetail {
  readonly id: string;
  readonly operation: string;
  readonly budgetId: string;
  readonly transactionId: string | null;
  readonly categoryId: string;
  readonly payloadHash: string;
  readonly policyVersion: string;
  readonly preconditions: string;
  readonly expiresAt: string;
  readonly actorId: string;
  readonly provenance: string;
  readonly providerModel: string | null;
  readonly correlationId: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;
}

/** Full response payload for the proposal detail endpoint. */
export interface ProposalDetailPayload {
  readonly proposal: ActionProposalDetail;
  readonly simulation: SimulationEvidence | null;
  readonly stale: boolean;
  readonly simulationStatus: 'present' | 'missing' | 'stale';
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

  const proposalId = event.context.params?.id;
  if (!proposalId) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_PROPOSAL_ID',
      'Proposal ID is required.',
      authInfo,
      false,
      requestId,
    );
  }

  try {
    const proposal = await wf.store.getProposal(proposalId);
    if (!proposal || proposal.budgetId !== fullRead.budgetId) {
      setResponseStatus(event, 404);
      return errorEnvelope(
        'PROPOSAL_NOT_FOUND',
        `Proposal not found: ${proposalId}`,
        authInfo,
        false,
        requestId,
      );
    }

    if (proposal.operation !== 'set_category' && proposal.operation !== 'create_rule') {
      setResponseStatus(event, 400);
      return errorEnvelope(
        'UNSUPPORTED_OPERATION',
        'Unsupported proposal operation.',
        authInfo,
        false,
        requestId,
      );
    }

    // Decode simulation evidence from stored preconditions
    let simulation: SimulationEvidence | null = null;
    let simulationStatus: 'present' | 'missing' | 'stale' = 'missing';

    try {
      const parsed: PreconditionsWithSimulation = JSON.parse(proposal.preconditions);
      simulation = parsed.simulation ?? null;
    } catch {
      simulation = null;
    }

    // Expiry check — treat expired proposals as stale regardless of content
    let expired = false;
    try {
      expired = new Date(proposal.expiresAt).getTime() <= Date.now();
    } catch {
      expired = true;
    }

    simulationStatus = !simulation ? 'missing' : expired ? 'stale' : 'present';

    const detail: ActionProposalDetail = {
      id: proposal.id,
      operation: proposal.operation,
      budgetId: proposal.budgetId,
      transactionId: proposal.payload.transactionId,
      categoryId: proposal.payload.categoryId,

      payloadHash: proposal.payloadHash,
      policyVersion: proposal.policyVersion,
      preconditions: proposal.preconditions,
      expiresAt: proposal.expiresAt,
      actorId: proposal.actorId,
      provenance: proposal.provenance,
      providerModel: proposal.providerModel,
      correlationId: proposal.correlationId,
      supersededAt: proposal.supersededAt,
      createdAt: proposal.createdAt,
    };

    const payload: ProposalDetailPayload = {
      proposal: detail,
      simulation,
      stale: expired || simulationStatus === 'stale',
      simulationStatus,
    };

    return okEnvelope(payload, authInfo, requestId);
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'PROPOSAL_SHOW_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      false,
      requestId,
    );
  }
});
