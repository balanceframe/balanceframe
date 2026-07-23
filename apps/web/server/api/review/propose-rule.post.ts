/**
 * POST /api/review/propose-rule — create a rule proposal from a review item.
 *
 * Accepts JSON body: { reviewId, merchant, categoryId, name?, simulation? }.
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
import crypto from 'node:crypto';

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
// Rule shape validation & normalization
// ---------------------------------------------------------------------------

export interface NormalizedRuleShape {
  readonly name: string;
  readonly conditions: unknown[];
  readonly actions: unknown[];
  readonly conditionsOp?: 'and' | 'or';
  readonly stage?: 'pre' | 'post';
}

/**
 * Validate and normalize a rule shape from raw input, supporting both
 * flat format ({ name, conditions, actions }) and nativeRule-nested
 * format ({ nativeRule: { name, conditions, actions } }).
 *
 * Throws a descriptive error when required fields are missing or invalid.
 * The returned object has deterministic key ordering suitable for hashing.
 */
export function normalizeRuleShape(raw: unknown): NormalizedRuleShape {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Rule shape must be a non-null object');
  }
  const obj = raw as Record<string, unknown>;

  // Support both flat format and nativeRule-nested format
  const ruleData: Record<string, unknown> =
    obj.nativeRule && typeof obj.nativeRule === 'object'
      ? obj.nativeRule as Record<string, unknown>
      : obj;

  const name = ruleData.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Rule name is required and must be a non-empty string');
  }

  const conditions = ruleData.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error('Rule conditions are required and must be a non-empty array');
  }

  const actions = ruleData.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('Rule actions are required and must be a non-empty array');
  }

  const stageVal = ruleData.stage;
  const stage: 'pre' | 'post' | undefined =
    stageVal === 'pre' ? 'pre' :
    stageVal === 'post' ? 'post' :
    undefined;

  return {
    name: name.trim(),
    conditions,
    actions,
    conditionsOp: ruleData.conditionsOp === 'or' ? 'or' : 'and',
    ...(stage ? { stage } : {}),
  };
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

  // Derive a rule name from the body or construct one from merchant/category
  const ruleName = typeof body.name === 'string' && body.name.trim().length > 0
    ? body.name.trim()
    : `Auto-rule: ${merchant} -> ${categoryId}`;

  // Build the raw rule shape and normalize it once before hashing
  const rawRule = {
    name: ruleName,
    conditionsOp: 'and',
    conditions: [{ field: 'payee_name', op: 'is', value: merchant }],
    actions: [{ field: 'category', op: 'set', value: categoryId }],
  };

  let normalizedRule: NormalizedRuleShape;
  try {
    normalizedRule = normalizeRuleShape(rawRule);
  } catch (e) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'INVALID_RULE_SHAPE',
      e instanceof Error ? e.message : 'Invalid rule shape',
      authInfo,
      false,
      requestId,
    );
  }

  // Hash the exact normalized shape — this is what execution will produce
  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify(normalizedRule))
    .digest('hex');

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
      nativeRule: normalizedRule,
    };
    if (simulation) {
      preconditions.simulation = simulation;
    }

    const proposal = await wf.store.createProposal({
      operation: 'create_rule',
      budgetId,
      transactionId: '__rule__',
      categoryId,
      payloadHash,
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
        name: normalizedRule.name,
        simulation,
        simulationStatus: simulation ? 'present' as const : 'missing' as const,
        simulationWarning,
        message: simulation
          ? `Rule proposal created. Simulation matched ${simulation.transactionsMatched} transaction(s).`
          : 'Rule proposal created. Use proposals.approve to authorize and proposals.execute to create the rule.',
        conditions: normalizedRule.conditions,
        actions: normalizedRule.actions,
        rulePreview: `If payee_name is ${merchant}, set category to ${categoryId}`,
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
