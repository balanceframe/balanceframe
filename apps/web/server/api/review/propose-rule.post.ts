/**
 * POST /api/review/propose-rule — create a rule proposal from a review item.
 *
 * Accepts JSON body: { reviewId, merchant, categoryId, simulation? }.
 * The optional `simulation` field carries simulation evidence from the
 * Rust simulateRule call (computed by the caller).  When present it is
 * stored in the proposal's precondition and validated for minimum matches.
 *
 * A rule proposal without simulation evidence is still created (the execution
 * phase requires it), but the endpoint warns when simulation is missing.
 *
 * Returns:
 *   { proposalId, operation, merchant, categoryId, simulation, simulationStatus, message }
 */

import { readBody } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../utils/workflow-store';

// ---------------------------------------------------------------------------
// Inline simulation shape — mirrors RuleSimulationResult from
// @balanceframe/application without a hard web-tier dependency.
// ---------------------------------------------------------------------------

interface SimulationExample {
  readonly txId: string;
  readonly payee: string | null;
  readonly amount: { minorUnits: string; currency: string };
  readonly currentCategory: string | null;
  readonly wouldChange: boolean;
}

interface StoredSimulation {
  readonly transactionsMatched: number;
  readonly transactionsAffected: readonly string[];
  readonly categoryDistribution: Record<string, number>;
  readonly conflicts: readonly string[];
  readonly examples: readonly SimulationExample[];
  readonly simulatedAt: string;
}

function isValidSimulation(value: unknown): value is StoredSimulation {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.transactionsMatched === 'number' &&
    o.transactionsMatched > 0 &&
    typeof o.simulatedAt === 'string'
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'rule.create');
  const requestId = crypto.randomUUID();

  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_JSON', 'Request body must be valid JSON', authInfo, false, requestId);
  }

  const reviewId = typeof body.reviewId === 'string' ? body.reviewId.trim() : '';
  const merchant = typeof body.merchant === 'string' ? body.merchant.trim() : '';
  const categoryId = typeof body.categoryId === 'string' ? body.categoryId.trim() : '';

  if (!reviewId || !merchant || !categoryId) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'MISSING_FIELDS',
      'reviewId, merchant, and categoryId are required',
      authInfo,
      false,
      requestId,
    );
  }

  // Validate simulation evidence if provided
  const rawSimulation = body.simulation;
  let simulation: StoredSimulation | null = null;
  let simulationWarning: string | null = null;

  if (rawSimulation != null) {
    if (!isValidSimulation(rawSimulation)) {
      setResponseStatus(event, 422);
      return errorEnvelope(
        'INVALID_SIMULATION',
        'Invalid simulation evidence: must have transactionsMatched > 0 and simulatedAt',
        authInfo,
        false,
        requestId,
      );
    }
    simulation = rawSimulation as StoredSimulation;
  } else {
    simulationWarning = 'No simulation evidence provided. The proposal will require simulation before execution.';
  }

  const actorId = getActorId(event);

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  let budgetId = '';
  try {
    const reviewItem = await wf.store.getReviewItem(reviewId);
    if (reviewItem) {
      budgetId = reviewItem.budgetId;
    }
  } catch {
    // Non-fatal — proceed with empty budgetId
  }

  try {
    const preconditions: Record<string, unknown> = {
      merchant,
      source: 'review',
      reviewId,
    };
    if (simulation) {
      preconditions.simulation = simulation;
    }

    const proposal = await wf.store.createProposal({
      operation: 'create_rule',
      budgetId,
      transactionId: '__rule__',
      categoryId,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions: JSON.stringify(preconditions),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actorId,
      provenance: 'review-action',
      providerModel: null,
      correlationId: requestId,
    });

    return okEnvelope(
      {
        proposalId: proposal.id,
        operation: 'create_rule',
        merchant,
        categoryId,
        simulation,
        simulationStatus: simulation ? 'present' as const : 'missing' as const,
        simulationWarning,
        message: simulation
          ? `Rule proposal created. Simulation matched ${simulation.transactionsMatched} transaction(s).`
          : 'Rule proposal created. Use proposals.approve to authorize and proposals.execute to create the rule.',
      },
      authInfo,
      requestId,
    );
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'PROPOSAL_FAILED',
      e instanceof Error ? e.message : 'Failed to create rule proposal',
      authInfo,
      false,
      requestId,
    );
  }
});
