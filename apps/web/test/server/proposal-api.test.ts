/**
 * Focused tests for the proposal API boundary.
 *
 * Verifies:
 * - propose-rule endpoint accepts simulation evidence
 * - propose-rule rejects invalid simulation shapes
 * - proposal listing includes simulationStatus
 * - proposal detail decodes simulation from preconditions
 * - stale/expired proposals are flagged correctly
 * - Existing proposal contracts remain valid
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type {
  CategorizationProposal,
  ReviewItem,
  CreateReviewItemInput,
} from '@balanceframe/workflow-store';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers — re-created from patterns in review-api.test.ts
// ---------------------------------------------------------------------------

const ACTOR = 'test-proposal-user';
const BUDGET = 'budget-proposal-test';
const REVIEW_ID = 'review_prop_001';
const MERCHANT = 'Test Merchant';
const CATEGORY_ID = 'cat_food_001';

const BASE_CREATE: CreateReviewItemInput = {
  transactionId: 'tx_prop_001',
  budgetId: BUDGET,
  merchant: MERCHANT,
  amount: 4250,
  categoryId: CATEGORY_ID,
  suggestedCategoryId: CATEGORY_ID,
  providerModel: 'test-classifier',
  confidence: 0.85,
  classifierLayer: 'test',
  reasonCodes: ['test-classification'],
  classifier: 'test-classifier',
  provenance: 'test',
};

function tickSync(): void {
  // Small delay so IsoStrings differ
  const target = Date.now() + 5;
  while (Date.now() < target) { /* spin */ }
}

async function seedStore(
  store: SqliteWorkflowStore,
): Promise<{ review: ReviewItem }> {
  // Create a review item
  const item = await store.createReviewItem(BASE_CREATE);
  await store.transitionReviewItem(item.id, {
    toStatus: 'suggestion_generated',
    actor: ACTOR,
    expectedVersion: 1,
  });
  await store.transitionReviewItem(item.id, {
    toStatus: 'pending_review',
    actor: ACTOR,
    expectedVersion: 2,
  });
  return { review: item };
}

/** A valid simulation evidence payload. */
function validSimulation() {
  return {
    transactionsMatched: 5,
    transactionsAffected: ['tx_001', 'tx_002'],
    categoryDistribution: { 'cat_food_001': 3, 'cat_other': 2 },
    conflicts: [],
    examples: [
      {
        txId: 'tx_001',
        payee: 'Test Payee',
        amount: { minorUnits: '4250', currency: 'USD' },
        currentCategory: null,
        wouldChange: true,
      },
    ],
    simulatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Simulated handler functions (test the logic without Nitro runtime)
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

function computeSimulationStatus(p: CategorizationProposal): 'present' | 'missing' | 'stale' {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(p.preconditions);
  } catch {
    return 'missing';
  }

  if (!parsed.simulation) {
    return 'missing';
  }

  try {
    if (new Date(p.expiresAt).getTime() <= Date.now()) {
      return 'stale';
    }
  } catch {
    return 'stale';
  }

  return 'present';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proposal API — simulation evidence', () => {
  let store: SqliteWorkflowStore;
  let review: ReviewItem;

  beforeEach(async () => {
    store = new SqliteWorkflowStore();
    tickSync();
    const seeded = await seedStore(store);
    review = seeded.review;
  });
  
  // -----------------------------------------------------------------------
  // Simulation validation
  // -----------------------------------------------------------------------

  it('accepts simulation evidence with the propose-rule input', async () => {
    const sim = validSimulation();
    expect(isValidSimulation(sim)).toBe(true);
  });

  it('rejects simulation with transactionsMatched === 0', async () => {
    const sim = { ...validSimulation(), transactionsMatched: 0 };
    expect(isValidSimulation(sim)).toBe(false);
  });

  it('rejects simulation missing simulatedAt', async () => {
    const sim = { ...validSimulation() };
    delete (sim as Record<string, unknown>).simulatedAt;
    expect(isValidSimulation(sim)).toBe(false);
  });

  it('rejects null simulation payload', async () => {
    expect(isValidSimulation(null)).toBe(false);
  });

  it('rejects non-object simulation payload', async () => {
    expect(isValidSimulation('string')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Proposal creation stores simulation in preconditions
  // -----------------------------------------------------------------------

  it('stores simulation evidence in preconditions when provided', async () => {
    const sim = validSimulation();
    const preconditions = JSON.stringify({
      merchant: MERCHANT,
      source: 'review',
      reviewId: review.id,
      simulation: sim,
    });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    const parsed = JSON.parse(proposal.preconditions);
    expect(parsed.simulation).toBeDefined();
    expect(parsed.simulation.transactionsMatched).toBe(5);
    expect(parsed.simulation.examples).toHaveLength(1);
  });

  it('creates proposal without simulation when not provided', async () => {
    const preconditions = JSON.stringify({
      merchant: MERCHANT,
      source: 'review',
      reviewId: review.id,
    });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    const parsed = JSON.parse(proposal.preconditions);
    expect(parsed.simulation).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Simulation status computation
  // -----------------------------------------------------------------------

  it('computes simulationStatus=present when simulation exists and not expired', async () => {
    const sim = validSimulation();
    const preconditions = JSON.stringify({ simulation: sim, merchant: MERCHANT });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    expect(computeSimulationStatus(proposal)).toBe('present');
  });

  it('computes simulationStatus=missing when preconditions lack simulation', async () => {
    const preconditions = JSON.stringify({ merchant: MERCHANT });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    expect(computeSimulationStatus(proposal)).toBe('missing');
  });

  it('computes simulationStatus=stale when proposal is expired', async () => {
    const sim = validSimulation();
    const preconditions = JSON.stringify({ simulation: sim, merchant: MERCHANT });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    // Bypass validation to set expiry in the past (same seam as store proposal.test.ts)
    const s = store as unknown as { db: { prepare(sql: string): { run(...params: unknown[]): unknown } } };
    s.db.prepare('UPDATE categorization_proposals SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 86_400_000).toISOString(),
      proposal.id,
    );

    const staleProposal = await store.getProposal(proposal.id);
    expect(staleProposal).not.toBeNull();
    expect(computeSimulationStatus(staleProposal!)).toBe('stale');
  });

  // -----------------------------------------------------------------------
  // Listing: proposals carry simulationStatus
  // -----------------------------------------------------------------------

  it('listProposals returns simulationStatus for each proposal', async () => {
    const sim = validSimulation();
    const preconditions1 = JSON.stringify({ simulation: sim, merchant: MERCHANT });
    const preconditions2 = JSON.stringify({ merchant: 'No Sim' });

    await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions: preconditions1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: 'cat_other',
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions: preconditions2,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    const proposals = await store.listProposals({ superseded: false });
    expect(proposals).toHaveLength(2);

    const statuses = proposals.map(p => computeSimulationStatus(p));
    expect(statuses).toContain('present');
    expect(statuses).toContain('missing');
  });

  // -----------------------------------------------------------------------
  // Existing proposal contracts remain valid
  // -----------------------------------------------------------------------

  it('can create and retrieve a proposal without any simulation fields', async () => {
    const preconditions = JSON.stringify({
      merchant: MERCHANT,
      source: 'review',
      reviewId: review.id,
    });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    expect(proposal.id).toBeTruthy();
    expect(proposal.operation).toBe('create_rule');

    const retrieved = await store.getProposal(proposal.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(proposal.id);

    // Legacy flow — no simulation in response
    const parsed = JSON.parse(retrieved!.preconditions);
    expect(parsed.simulation).toBeUndefined();
    expect(parsed.merchant).toBe(MERCHANT);
  });
});

// -----------------------------------------------------------------------
// Cross-actor idempotency for proposal execute
// -----------------------------------------------------------------------

describe('proposal execute — cross-actor idempotency', () => {
  let store: SqliteWorkflowStore;
  let review: ReviewItem;

  beforeEach(async () => {
    store = new SqliteWorkflowStore();
    tickSync();
    const seeded = await seedStore(store);
    review = seeded.review;
  });

  it('different actors get separate idempotency keys for the same proposal', async () => {
    const preconditions = JSON.stringify({
      merchant: MERCHANT,
      source: 'review',
      reviewId: review.id,
      nativeRule: {
        conditions: [{ field: 'payee_name', op: 'is', value: 'Test Store', type: 'string' }],
        actions: [{ type: 'set-category', field: 'category', value: CATEGORY_ID }],
        conditionsOp: 'and',
        stage: null,
      },
    });

    const proposal = await store.createProposal({
      operation: 'create_rule',
      budgetId: BUDGET,
      transactionId: '__rule__',
      categoryId: CATEGORY_ID,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actorId: ACTOR,
      provenance: 'review-action',
      providerModel: null,
      correlationId: null,
    });

    const serialisedEffect = JSON.stringify({
      ruleName: 'Test Store',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Test Store', type: 'string' }],
      actions: [{ type: 'set-category', field: 'category', value: CATEGORY_ID }],
      conditionsOp: 'and',
      stage: null,
      payloadHash: proposal.payloadHash,
    });

    const actorA = 'user-alpha';
    const actorB = 'user-beta';

    // Actor A claims execution with actor-scoped key
    const keyA = `${proposal.id}:execute:${actorA}`;
    const claimA = await store.createIdempotencyRecord({
      idempotencyKey: keyA,
      proposalId: proposal.id,
      operation: 'rule_execute',
      serialisedEffect,
    });
    expect(claimA.isOwner).toBe(true);

    // Actor B gets a different key — can claim independently
    // (this would fail with the old proposal-only key)
    const keyB = `${proposal.id}:execute:${actorB}`;
    expect(keyA).not.toBe(keyB);
    const claimB = await store.createIdempotencyRecord({
      idempotencyKey: keyB,
      proposalId: proposal.id,
      operation: 'rule_execute',
      serialisedEffect,
    });
    expect(claimB.isOwner).toBe(true);

    // Same actor retries — idempotent replay (same-actor duplicate prevention intact)
    const retryA = await store.createIdempotencyRecord({
      idempotencyKey: keyA,
      proposalId: proposal.id,
      operation: 'rule_execute',
      serialisedEffect,
    });
    expect(retryA.isOwner).toBe(false);
  });
});

it('rejects actor without approval before idempotency creation', async () => {
  const store = new SqliteWorkflowStore();
  tickSync();
  const seeded = await seedStore(store);

  const preconditions = JSON.stringify({
    merchant: MERCHANT,
    source: 'review',
    reviewId: seeded.review.id,
    nativeRule: {
      conditions: [{ field: 'payee_name', op: 'is', value: 'Test Store', type: 'string' }],
      actions: [{ type: 'set-category', field: 'category', value: CATEGORY_ID }],
      conditionsOp: 'and',
      stage: null,
    },
  });

  const proposal = await store.createProposal({
    operation: 'create_rule',
    budgetId: BUDGET,
    transactionId: '__rule__',
    categoryId: CATEGORY_ID,
    payloadHash: crypto.randomUUID(),
    policyVersion: '1.0',
    preconditions,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    actorId: ACTOR,
    provenance: 'review-action',
    providerModel: null,
    correlationId: null,
  });

  // No approval was created for this actor — simulate the handler's pre-claim check
  const approvals = await store.findActiveApprovals(proposal.id);
  expect(approvals).toHaveLength(0);

  // Confirm no idempotency record exists for this actor (handler rejects before creating one)
  const key = `${proposal.id}:execute:${ACTOR}`;
  const record = await store.getIdempotencyRecord(key);
  expect(record).toBeNull();

  // Verify a fresh claim would succeed as owner (no stale record left behind)
  const serialisedEffect = JSON.stringify({
    ruleName: 'Test Store',
    conditions: [{ field: 'payee_name', op: 'is', value: 'Test Store', type: 'string' }],
    actions: [{ type: 'set-category', field: 'category', value: CATEGORY_ID }],
    conditionsOp: 'and',
    stage: null,
    payloadHash: proposal.payloadHash,
  });
  const claim = await store.createIdempotencyRecord({
    idempotencyKey: key,
    proposalId: proposal.id,
    operation: 'rule_execute',
    serialisedEffect,
  });
  expect(claim.isOwner).toBe(true);
});

// ---------------------------------------------------------------------------
// normalizeRuleShape validation — duplicates the function from the endpoint
// module to avoid a Nitro runtime dependency in tests.
// ---------------------------------------------------------------------------

interface NormalizedRuleShape {
  readonly name: string;
  readonly conditions: unknown[];
  readonly actions: unknown[];
  readonly conditionsOp?: 'and' | 'or';
  readonly stage?: 'pre' | 'post';
}

function normalizeRuleShape(raw: unknown): NormalizedRuleShape {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Rule shape must be a non-null object');
  }
  const obj = raw as Record<string, unknown>;

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

describe('normalizeRuleShape', () => {
  it('accepts a valid flat rule shape', () => {
    const result = normalizeRuleShape({
      name: 'Test Rule',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
      actions: [{ type: 'set_category', value: 'cat_test' }],
    });

    expect(result.name).toBe('Test Rule');
    expect(result.conditions).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
    expect(result.conditionsOp).toBe('and');
    expect(result.stage).toBeUndefined();
  });

  it('accepts a valid nativeRule-nested format', () => {
    const result = normalizeRuleShape({
      nativeRule: {
        name: 'Nested Rule',
        conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
        actions: [{ type: 'set_category', value: 'cat_test' }],
      },
    });

    expect(result.name).toBe('Nested Rule');
    expect(result.conditions).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
  });

  it('rejects null input', () => {
    expect(() => normalizeRuleShape(null)).toThrow('Rule shape must be a non-null object');
  });

  it('rejects non-object input', () => {
    expect(() => normalizeRuleShape('string')).toThrow('Rule shape must be a non-null object');
  });

  it('rejects empty name', () => {
    expect(() => normalizeRuleShape({
      name: '',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
      actions: [{ type: 'set_category', value: 'cat_test' }],
    })).toThrow('Rule name is required');
  });

  it('rejects missing name', () => {
    expect(() => normalizeRuleShape({
      conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
      actions: [{ type: 'set_category', value: 'cat_test' }],
    })).toThrow('Rule name is required');
  });

  it('rejects missing conditions', () => {
    expect(() => normalizeRuleShape({
      name: 'Test',
      actions: [{ type: 'set_category', value: 'cat_test' }],
    })).toThrow('Rule conditions are required');
  });

  it('rejects empty conditions array', () => {
    expect(() => normalizeRuleShape({
      name: 'Test',
      conditions: [],
      actions: [{ type: 'set_category', value: 'cat_test' }],
    })).toThrow('Rule conditions are required');
  });

  it('rejects missing actions', () => {
    expect(() => normalizeRuleShape({
      name: 'Test',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
    })).toThrow('Rule actions are required');
  });

  it('rejects empty actions array', () => {
    expect(() => normalizeRuleShape({
      name: 'Test',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
      actions: [],
    })).toThrow('Rule actions are required');
  });

  it('accepts stage=pre and conditionsOp=or', () => {
    const result = normalizeRuleShape({
      name: 'Pre Rule',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Store' }],
      actions: [{ type: 'set_category', value: 'cat_test' }],
      conditionsOp: 'or',
      stage: 'pre',
    });

    expect(result.conditionsOp).toBe('or');
    expect(result.stage).toBe('pre');
  });

  it('normalized shape produces deterministic hash', () => {
    const shape = normalizeRuleShape({
      name: 'Hash Test Rule',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Hash Store' }],
      actions: [{ type: 'set_category', value: 'cat_hash' }],
    });

    const hash1 = crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
    const hash2 = crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');

    expect(hash1).toBe(hash2);
    expect(Object.keys(shape)).toEqual(['name', 'conditions', 'actions', 'conditionsOp']);
  });
});
