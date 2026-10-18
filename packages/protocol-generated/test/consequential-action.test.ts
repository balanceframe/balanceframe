import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  consequentialActionPlanSchema,
  consequentialActionVerificationSchema,
  decisionCardRequestSchema,
  planConsequentialActionRequestSchema,
  sourceObservationSchema,
  verifyConsequentialActionRequestSchema,
} from '../src/validators.js';

import type {
  ConsequentialActionIntent,
  ConsequentialActionPlan,
  DecisionCardRequest,
  FinancialSnapshot,
  PlanConsequentialActionRequest,
  VerifyConsequentialActionRequest,
} from '../src/index.js';

type MoneyObject = { minorUnits: string; currency: string };
type FoundationFixture = {
  full: FinancialSnapshot;
  claims: { context: DecisionCardRequest['context'] };
};
type LiquidityFixture = {
  snapshotId: string;
  contentHash: string;
  evaluatedAt: string;
  horizon: DecisionCardRequest['context']['horizon'];
  facts: NonNullable<FinancialSnapshot['liquidity']>;
  liquidityPolicy: DecisionCardRequest['liquidityPolicy'];
  claimSet: DecisionCardRequest['claimSet'];
  scenario: { items: DecisionCardRequest['items'] };
  validUntil: string;
  maxBudgetSnapshotAgeMinutes: number;
};
type ActionFixture = Pick<PlanConsequentialActionRequest,
  'intent' | 'currentLedger' | 'resolvedEvidence' | 'financialPolicyVersion' | 'evaluatedAt' | 'idempotencyKey'> & {
    alternateDonorIntent: ConsequentialActionIntent;
    alternateDonorEligibility: Array<{ categoryId: string; donorEligible: boolean }>;
    compositeIntent: ConsequentialActionIntent;
    expectedReallocationImpact: {
      sourceCategoryId: string;
      destinationCategoryId: string;
      safeToRedirectAfter: MoneyObject;
    };
    evidenceProjectionIntent: ConsequentialActionIntent;
    sourceObservation: {
      kind: 'economic_event_resolution';
      scope: { kind: 'transaction'; id: string };
      state: 'resolved';
      observedAt: string;
      contentHash: string;
      version: string;
      evidence: Array<{ evidenceId: string; kind: 'economic_event_resolution'; authorized: true; redaction: 'visible' }>;
    };
  };

const money = (minorUnits: string | number, currency = 'USD'): MoneyObject => ({ minorUnits: String(minorUnits), currency });
const readFixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`../../../protocol/fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const liquidityFixture = readFixture('account-aware-liquidity.json') as LiquidityFixture;
const foundationFixture = readFixture('financial-decision-foundation.json') as FoundationFixture;
const actionFixture = readFixture('consequential-action.json') as ActionFixture;

function composeDecisionCardRequest(): DecisionCardRequest {
  const snapshot = structuredClone(foundationFixture.full);
  snapshot.snapshotId = liquidityFixture.snapshotId;
  snapshot.contentHash = liquidityFixture.contentHash;
  snapshot.capturedAt = liquidityFixture.evaluatedAt;
  snapshot.liquidity = structuredClone(liquidityFixture.facts);
  snapshot.coverage.accounts = 'complete';
  snapshot.coverage.categories = 'complete';
  snapshot.coverage.transactions = 'complete';
  snapshot.coverage.schedules = 'complete';
  snapshot.coverage.budgets = 'complete';
  snapshot.legacySnapshot.accounts = [];
  snapshot.legacySnapshot.transactions = [];
  snapshot.legacySnapshot.categories = [];
  snapshot.legacySnapshot.budgets = [];
  snapshot.legacySnapshot.schedules = [];
  snapshot.observations = [{
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'checking' },
    state: 'fresh',
    observedAt: liquidityFixture.evaluatedAt,
    evidence: [{ evidenceId: 'checking-freshness', kind: 'bank_sync', authorized: true, redaction: 'visible' }],
  }];
  snapshot.observations.push(structuredClone(actionFixture.sourceObservation));
  const facts = snapshot.liquidity;
  if (!facts) throw new Error('canonical liquidity facts are required');
  const checking = facts.accounts.find((account) => account.accountId === 'checking');
  if (!checking) throw new Error('canonical checking account is required');
  checking.recordedBalance = money(13_000);
  facts.categories[0]!.availability = money(0);
  const reserve = structuredClone(facts.categories[0]!);
  reserve.categoryId = 'reserve';
  reserve.cashBucketId = 'reserve';
  reserve.availability = money(6_000);
  const reserveTwo = structuredClone(reserve);
  reserveTwo.categoryId = 'reserve-two';
  reserveTwo.cashBucketId = 'reserve-two';
  facts.categories.push(reserve, reserveTwo);

  const context = structuredClone(foundationFixture.claims.context);
  context.evaluatedAt = liquidityFixture.evaluatedAt;
  context.horizon = structuredClone(liquidityFixture.horizon);
  context.snapshotId = liquidityFixture.snapshotId;
  context.contentHash = liquidityFixture.contentHash;
  context.policyVersion = liquidityFixture.liquidityPolicy.version;
  context.policyHash = liquidityFixture.liquidityPolicy.policyHash;
  context.policy.maxBudgetSnapshotAgeMinutes = liquidityFixture.maxBudgetSnapshotAgeMinutes;
  context.policy.maxBankSyncAgeMinutes = null;
  const item = { ...structuredClone(liquidityFixture.scenario.items[0]!), priority: 'planned' as const };
  item.purchaseAt = '2026-09-06T12:00:00Z';
  item.requiredBy = '2026-09-06T12:00:00Z';
  return decisionCardRequestSchema.parse({
    financialSnapshot: snapshot,
    context,
    liquidityPolicy: structuredClone(liquidityFixture.liquidityPolicy),
    claimSet: structuredClone(liquidityFixture.claimSet),
    priorAllocation: null,
    items: [item],
    categoryPolicies: [
      { categoryId: 'food', kind: 'ordinary', donorEligible: false, minimumRetained: money(0), projectedRemainingNeed: money(0) },
      { categoryId: 'reserve', kind: 'ordinary', donorEligible: true, minimumRetained: money(1_000), projectedRemainingNeed: money(2_000) },
      { categoryId: 'reserve-two', kind: 'ordinary', donorEligible: false, minimumRetained: money(1_000), projectedRemainingNeed: money(2_000) },
    ],
    validUntil: liquidityFixture.validUntil,
    requestId: 'request-consequential-action-1',
    correlationId: 'correlation-consequential-action-1',
    decisionId: 'decision-consequential-action-1',
  }) as DecisionCardRequest;
}

function request(intent: ConsequentialActionIntent = actionFixture.intent): PlanConsequentialActionRequest {
  return planConsequentialActionRequestSchema.parse({
    decisionCardRequest: composeDecisionCardRequest(),
    intent: structuredClone(intent),
    currentLedger: structuredClone(actionFixture.currentLedger),
    resolvedEvidence: structuredClone(actionFixture.resolvedEvidence),
    financialPolicyVersion: actionFixture.financialPolicyVersion,
    evaluatedAt: actionFixture.evaluatedAt,
    idempotencyKey: actionFixture.idempotencyKey,
    supplementalObservations: [],
  }) as PlanConsequentialActionRequest;
}

const manualTransaction = (amount: string, splits: Array<{ categoryId: string; amount: MoneyObject }> = []) => ({
  parentId: 'manual-parent-1',
  correlationId: 'manual-correlation-1',
  accountId: 'checking',
  amount: money(amount),
  date: '2026-09-06',
  categoryId: splits.length === 0 ? 'food' : null,
  payeeName: 'Local shop',
  notes: null,
  splits,
});

function planShape(action: ConsequentialActionIntent): ConsequentialActionPlan {
  return {
    version: '1',
    action,
    source: {
      snapshotId: 'snapshot-1',
      contentHash: 'composite-hash-1',
      policyVersion: 'policy-1',
      claimSetRevision: 'claims-1',
      financialPolicyVersion: 'financial-policy-1',
      evidenceHash: 'c'.repeat(64),
      invalidatedFreshnessAccounts: [],
      manualPayeeBindings: [],
      invalidatedSupplementalFacts: [],
      accountsCoverageBefore: 'complete',
      transactionsCoverageBefore: 'empty',
      preconditionsHash: 'a'.repeat(64),
      invariantsHash: 'b'.repeat(64),
    },
    evidenceReferences: structuredClone(actionFixture.resolvedEvidence.filter((evidence) => evidence.evidenceId === 'checking-freshness')),
    expiresAt: liquidityFixture.validUntil,
    idempotencyKey: actionFixture.idempotencyKey,
    reasonCodes: ['safe_reallocation'],
    impacts: [{
      kind: 'category_reallocation',
      sourceCategoryId: 'reserve',
      sourceAsOfMonth: '2026-09',
      destinationCategoryId: 'food',
      destinationAsOfMonth: '2026-09',
      amount: money(2_000),
      sourceProtected: false,
      sourceAvailabilityBefore: money(6_000),
      sourceAvailabilityAfter: money(4_000),
      sourceUncommittedAvailabilityBefore: money(6_000),
      sourceUncommittedAvailabilityAfter: money(4_000),
      minimumRetained: money(1_000),
      projectedRemainingNeed: money(2_000),
      safeToRedirectAfter: structuredClone(actionFixture.expectedReallocationImpact.safeToRedirectAfter),
      rationale: 'donor_category_surplus_redirected',
    }],
    expectedPostconditions: [
      { kind: 'assignment', categoryId: 'reserve', asOfMonth: '2026-09', amount: money(4_000) },
      { kind: 'assignment', categoryId: 'food', asOfMonth: '2026-09', amount: money(2_000) },
      { kind: 'account_balance', accountId: 'checking', balance: money(13_000) },
    ],
    dispatchPreconditions: [{
      atomIndex: 0,
      accountBalances: [],
      assignments: [
        { categoryId: 'food', asOfMonth: '2026-09', amount: money(0), postAmount: money(2_000) },
        { categoryId: 'reserve', asOfMonth: '2026-09', amount: money(6_000), postAmount: money(4_000) },
      ],
    }],
    actionHash: 'c'.repeat(64),
  };
}

describe('consequential action generated JSON boundary', () => {
  it('requires bounded native post-prefix assignment targets independently of their preconditions', () => {
    const plan = planShape(actionFixture.intent);
    const dispatch = plan.dispatchPreconditions[0]!;
    dispatch.assignments = dispatch.assignments.map((assignment) => ({
      ...assignment,
      postAmount: money(assignment.categoryId === 'food' ? 2_000 : 4_000),
    }));
    expect(consequentialActionPlanSchema.safeParse(plan).success).toBe(true);

    const target = dispatch.assignments[0] as unknown as Record<string, unknown>;
    delete target.postAmount;
    expect(consequentialActionPlanSchema.safeParse(plan).success).toBe(false);
    target.postAmount = money('9223372036854775808');
    expect(consequentialActionPlanSchema.safeParse(plan).success).toBe(false);
    target.postAmount = money(2_000);
    expect(consequentialActionPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('accepts the shared canonical reallocation request and rejects unknown fields', () => {
    const value = request();
    expect(value.decisionCardRequest.items[0]!.amount).toEqual(money(2_000));
    expect(value.intent).toEqual(actionFixture.intent);
    expect(value.currentLedger.assignments).toHaveLength(3);
    expect(value.resolvedEvidence[0]!.state).toBe('resolved');
    expect(sourceObservationSchema.safeParse(actionFixture.sourceObservation).success).toBe(true);
    expect(actionFixture.sourceObservation.evidence[0]!.kind).toBe('economic_event_resolution');
    expect(actionFixture.resolvedEvidence[1]!.version).toBe(actionFixture.sourceObservation.version);
    expect(actionFixture.resolvedEvidence[1]!.contentHash).toBe(actionFixture.sourceObservation.contentHash);
    expect(actionFixture.resolvedEvidence[1]!.subjectId).toBe(actionFixture.sourceObservation.scope.id);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      state: 'stale',
    }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      version: '',
    }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      evidence: [{ ...actionFixture.sourceObservation.evidence[0]!, authorized: false }],
    }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      evidence: [{ ...actionFixture.sourceObservation.evidence[0]!, redaction: 'redacted' }],
    }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      evidence: [{ ...actionFixture.sourceObservation.evidence[0]!, kind: 'other' }],
    }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      evidence: [],
    }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({
      ...actionFixture.sourceObservation,
      unexpected: true,
    }).success).toBe(false);

    const unknown = structuredClone(value) as PlanConsequentialActionRequest & { untrusted?: boolean };
    unknown.untrusted = true;
    expect(planConsequentialActionRequestSchema.safeParse(unknown).success).toBe(false);
    const unknownIntent = structuredClone(value) as PlanConsequentialActionRequest & { intent: Record<string, unknown> };
    unknownIntent.intent.extra = true;
    expect(planConsequentialActionRequestSchema.safeParse(unknownIntent).success).toBe(false);
  });

  it('validates value-free supplemental projections and exact invalidation paths', () => {
    const projected = {
      ...request(),
      supplementalObservations: [{
        accountId: 'checking',
        fields: ['currency', 'currentLedgerConfirmed', 'unsettledFlows'],
        flowIds: ['supplemental-flow-1'],
        obligationIds: [],
      }],
    };
    expect(planConsequentialActionRequestSchema.safeParse(projected).success).toBe(true);
    expect(planConsequentialActionRequestSchema.safeParse({
      ...projected,
      supplementalObservations: [{
        accountId: 'checking',
        fields: ['balance'],
        flowIds: [],
        obligationIds: [],
      }],
    }).success).toBe(false);

    const source = {
      ...planShape(actionFixture.intent).source,
      invalidatedSupplementalFacts: [{
        accountId: 'checking',
        fields: ['currency', 'currentLedgerConfirmed', 'unsettledFlows'],
        paths: ['currency', 'currencyEvidence', 'freshnessEvidence'],
        flowIds: ['supplemental-flow-1'],
        obligationIds: [],
      }],
    };
    expect(consequentialActionPlanSchema.safeParse({
      ...planShape(actionFixture.intent),
      source,
    }).success).toBe(true);
    expect(consequentialActionPlanSchema.safeParse({
      ...planShape(actionFixture.intent),
      source: {
        ...source,
        invalidatedSupplementalFacts: [{
          ...source.invalidatedSupplementalFacts[0]!,
          paths: ['bankCaptureClock'],
        }],
      },
    }).success).toBe(false);
  });

  it('strictly accepts every atom and the ordered non-nested composite', () => {
    const actions: ConsequentialActionIntent[] = [
      actionFixture.intent,
      actionFixture.alternateDonorIntent,
      { kind: 'manual_transaction', transaction: manualTransaction('-1000') },
      { kind: 'manual_transaction', transaction: manualTransaction('-1000', [
        { categoryId: 'food', amount: money(-600) },
        { categoryId: 'reserve', amount: money(-400) },
      ]) },
      actionFixture.evidenceProjectionIntent,
      { kind: 'wallet_materialization', walletId: 'wallet-new-1', accountName: 'Emergency savings', currency: 'USD' },
      { kind: 'transfer', transferId: 'ledger-transfer-1', correlationId: 'transfer-correlation-1', sourceAccountId: 'checking', destinationAccountId: 'savings', amount: money(1_000), date: '2026-09-06' },
      actionFixture.compositeIntent,
    ];
    for (const intent of actions) expect(planConsequentialActionRequestSchema.safeParse(request(intent)).success).toBe(true);

    const nested = {
      ...request(),
      intent: { kind: 'composite', actions: [actionFixture.compositeIntent] },
    };
    expect(planConsequentialActionRequestSchema.safeParse(nested).success).toBe(false);
  });

  it('leaves arithmetic and target identity checks to Rust while retaining exact Money wire values', () => {
    const wrongSplitTotal = request({
      kind: 'manual_transaction',
      transaction: manualTransaction('-1000', [{ categoryId: 'food', amount: money(-999) }]),
    });
    expect(planConsequentialActionRequestSchema.safeParse(wrongSplitTotal).success).toBe(true);
    const badId = request();
    if (badId.intent.kind === 'reallocation') badId.intent.assignments[0]!.sourceCategoryId = 'missing-category';
    expect(planConsequentialActionRequestSchema.safeParse(badId).success).toBe(true);
    const unknownEvidence = request(actionFixture.evidenceProjectionIntent);
    unknownEvidence.resolvedEvidence[1]!.state = 'stale';
    expect(planConsequentialActionRequestSchema.safeParse(unknownEvidence).success).toBe(true);
  });

  it('validates the exact plan, typed impact, and phase-specific verification wires', () => {
    const plan = consequentialActionPlanSchema.parse(planShape(actionFixture.intent)) as ConsequentialActionPlan;
    const payeeBoundPlan = planShape(actionFixture.intent);
    payeeBoundPlan.source.manualPayeeBindings = [
      { parentId: 'manual-parent-new', payeeName: 'Local shop', existingPayeeId: null },
      { parentId: 'manual-parent-existing', payeeName: 'Local shop', existingPayeeId: 'payee-1' },
    ];
    expect(consequentialActionPlanSchema.safeParse(payeeBoundPlan).success).toBe(true);
    expect(plan.actionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.impacts[0]).toMatchObject({
      kind: 'category_reallocation',
      sourceProtected: false,
      sourceAvailabilityBefore: money(6_000),
      sourceAvailabilityAfter: money(4_000),
      minimumRetained: money(1_000),
      projectedRemainingNeed: money(2_000),
      safeToRedirectAfter: actionFixture.expectedReallocationImpact.safeToRedirectAfter,
      rationale: 'donor_category_surplus_redirected',
    });
    const verifyRequest: VerifyConsequentialActionRequest = {
      plan,
      phase: 'preconditions',
      decisionCardRequest: composeDecisionCardRequest(),
      currentLedger: structuredClone(actionFixture.currentLedger),
      resolvedEvidence: structuredClone(actionFixture.resolvedEvidence),
      financialPolicyVersion: actionFixture.financialPolicyVersion,
      evaluatedAt: actionFixture.evaluatedAt,
    };
    expect(verifyConsequentialActionRequestSchema.safeParse(verifyRequest).success).toBe(true);
    const withoutPolicyVersion: Record<string, unknown> = { ...verifyRequest };
    delete withoutPolicyVersion.financialPolicyVersion;
    expect(verifyConsequentialActionRequestSchema.safeParse(withoutPolicyVersion).success).toBe(false);
    expect(verifyConsequentialActionRequestSchema.safeParse({ ...verifyRequest, phase: 'post-write' }).success).toBe(false);
    expect(consequentialActionVerificationSchema.parse({ valid: true, reason: null, actionHash: plan.actionHash })).toEqual({
      valid: true, reason: null, actionHash: plan.actionHash,
    });
    expect(consequentialActionVerificationSchema.safeParse({
      valid: false, reason: 'postcondition_mismatch', actionHash: plan.actionHash,
    }).success).toBe(true);
    expect(consequentialActionVerificationSchema.safeParse({
      valid: false, reason: 'made_up', actionHash: plan.actionHash,
    }).success).toBe(false);
  });
});
