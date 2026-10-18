import Ajv, { type AnySchemaObject, type ValidateFunction } from 'ajv';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  consequentialActionIntentSchema,
  consequentialActionPlanSchema,
  consequentialActionVerificationSchema,
  planConsequentialActionRequestSchema,
  verifyConsequentialActionRequestSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  ConsequentialActionIntent,
  ConsequentialActionPlan,
  DecisionCardRequest,
  FinancialSnapshot,
  PlanConsequentialActionRequest,
  SourceObservation,
  VerifyConsequentialActionRequest,
} from '@balanceframe/protocol-generated';

type JsonObject = Record<string, unknown>;
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
type LedgerEffect = {
  accountId: string;
  amount: MoneyObject;
  date: string;
  categoryId: string | null;
  payeeName: string | null;
  notes: string | null;
  splits: Array<{ categoryId: string; amount: MoneyObject }>;
};
type ActionFixture = Pick<PlanConsequentialActionRequest,
  'intent' | 'currentLedger' | 'resolvedEvidence' | 'financialPolicyVersion' | 'evaluatedAt' | 'idempotencyKey'> & {
    alternateDonorIntent: ConsequentialActionIntent;
    compositeIntent: ConsequentialActionIntent;
    evidenceProjectionIntent: ConsequentialActionIntent;
    sourceObservation: SourceObservation & { ledgerEffect: LedgerEffect };
  };
type NativeBindings = {
  planConsequentialAction(input: string): string;
  verifyConsequentialAction(input: string): string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadJson = (filePath: string): unknown => JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
const loadSchema = (name: string): AnySchemaObject =>
  loadJson(path.resolve(__dirname, '../../protocol/json-schema', name)) as AnySchemaObject;
const money = (minorUnits: string | number, currency = 'USD'): MoneyObject => ({
  minorUnits: String(minorUnits),
  currency,
});
const readFixture = (name: string) =>
  loadJson(path.resolve(__dirname, '../../protocol/fixtures', name)) as unknown;
const liquidityFixture = readFixture('account-aware-liquidity.json') as LiquidityFixture;
const foundationFixture = readFixture('financial-decision-foundation.json') as FoundationFixture;
const actionFixture = readFixture('consequential-action.json') as ActionFixture;

const ajv = new Ajv({ allErrors: true, strict: false });
for (const name of [
  'protocol-v1.json',
  'financial-snapshot-v1.json',
  'prospective-claim-v1.json',
  'prospective-decision-v1.json',
  'account-aware-liquidity-v1.json',
  'decision-card-v1.json',
]) {
  ajv.addSchema(loadSchema(name));
}
const actionJsonSchema = loadSchema('consequential-action-v1.json');
ajv.addSchema(actionJsonSchema);

function rootValidator(schema: AnySchemaObject): ValidateFunction {
  if (typeof schema.$id !== 'string') throw new Error('Consequential action schema root must declare $id');
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`AJV could not compile schema root ${schema.$id}`);
  return validate;
}

function definitionValidator(name: string): ValidateFunction {
  if (typeof actionJsonSchema.$id !== 'string') throw new Error('Consequential action schema root must declare $id');
  return ajv.compile({ $ref: `${actionJsonSchema.$id}#/$defs/${name}` });
}

const validateRequest = rootValidator(actionJsonSchema);
const validateIntent = definitionValidator('ConsequentialActionIntent');
const validatePlan = definitionValidator('ConsequentialActionPlan');
const validateVerifyRequest = definitionValidator('VerifyConsequentialActionRequest');
const validateVerification = definitionValidator('ConsequentialActionVerification');
const native = createRequire(import.meta.url)(
  path.resolve(__dirname, '../../crates/node-binding/balanceframe.node'),
) as NativeBindings;

function expectJsonValid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function expectRequestValid(value: PlanConsequentialActionRequest): void {
  expectJsonValid(validateRequest, value);
  expect(planConsequentialActionRequestSchema.safeParse(value).success).toBe(true);
}

function expectRequestInvalid(value: unknown): void {
  expect(validateRequest(value)).toBe(false);
  expect(planConsequentialActionRequestSchema.safeParse(value).success).toBe(false);
}

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
  return {
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
  };
}

function request(intent: ConsequentialActionIntent = actionFixture.intent): PlanConsequentialActionRequest {
  return {
    decisionCardRequest: composeDecisionCardRequest(),
    intent: structuredClone(intent),
    currentLedger: structuredClone(actionFixture.currentLedger),
    resolvedEvidence: structuredClone(actionFixture.resolvedEvidence),
    financialPolicyVersion: actionFixture.financialPolicyVersion,
    evaluatedAt: actionFixture.evaluatedAt,
    idempotencyKey: actionFixture.idempotencyKey,
    supplementalObservations: [],
  };
}

function manualTransaction(
  amount: string,
  splits: Array<{ categoryId: string; amount: MoneyObject }> = [],
) {
  return {
    parentId: 'manual-parent-1',
    correlationId: 'manual-correlation-1',
    accountId: 'checking',
    amount: money(amount),
    date: '2026-09-06',
    categoryId: splits.length === 0 ? 'food' : null,
    payeeName: 'Local shop',
    notes: null,
    splits,
  };
}

function verifyRequest(
  plan: ConsequentialActionPlan,
  source: PlanConsequentialActionRequest,
  phase: VerifyConsequentialActionRequest['phase'] = 'preconditions',
): VerifyConsequentialActionRequest {
  return {
    plan,
    phase,
    decisionCardRequest: source.decisionCardRequest,
    currentLedger: source.currentLedger,
    resolvedEvidence: source.resolvedEvidence,
    financialPolicyVersion: source.financialPolicyVersion,
    evaluatedAt: source.evaluatedAt,
  };
}

function nativeVerify(value: VerifyConsequentialActionRequest): JsonObject {
  return JSON.parse(native.verifyConsequentialAction(JSON.stringify(value))) as JsonObject;
}

describe('consequential action JSON Schema, Zod, and native boundary', () => {
  it('accepts every closed atom and ordered non-nested composite through JSON Schema and Zod', () => {
    const intents: ConsequentialActionIntent[] = [
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

    for (const intent of intents) {
      expectJsonValid(validateIntent, intent);
      expectRequestValid(request(intent));
    }
  });

  it('rejects unknown fields, nested composites, unsafe Money, malformed currency, and missing policy versions', () => {
    const valid = request();
    expectRequestValid(valid);

    const unknownRoot = { ...valid, untrusted: true };
    expectRequestInvalid(unknownRoot);
    expect(() => native.planConsequentialAction(JSON.stringify(unknownRoot))).toThrow();
    const unknownNested = request(actionFixture.compositeIntent);
    if (unknownNested.intent.kind !== 'composite') throw new Error('canonical composite fixture is required');
    const manual = unknownNested.intent.actions.find((action) => action.kind === 'manual_transaction');
    if (!manual || manual.kind !== 'manual_transaction') throw new Error('composite transaction atom is required');
    Reflect.set(manual.transaction, 'unexpected', true);
    expectRequestInvalid(unknownNested);
    expect(() => native.planConsequentialAction(JSON.stringify(unknownNested))).toThrow();

    const nestedComposite = {
      ...valid,
      intent: { kind: 'composite', actions: [actionFixture.compositeIntent] },
    };
    expectRequestInvalid(nestedComposite);
    expect(() => native.planConsequentialAction(JSON.stringify(nestedComposite))).toThrow();
    const emptyComposite = { ...valid, intent: { kind: 'composite', actions: [] } };
    expectRequestInvalid(emptyComposite);
    expect(() => native.planConsequentialAction(JSON.stringify(emptyComposite))).toThrow();

    const unsafeMoney = request();
    if (unsafeMoney.intent.kind !== 'reallocation') throw new Error('canonical reallocation fixture is required');
    unsafeMoney.intent.assignments[0]!.amount.minorUnits = '9223372036854775808';
    expectRequestInvalid(unsafeMoney);
    expect(() => native.planConsequentialAction(JSON.stringify(unsafeMoney))).toThrow();
    for (const minorUnits of ['0', '-1', '9223372036854775808', '-9223372036854775809']) {
      const intent = structuredClone(actionFixture.intent);
      if (intent.kind !== 'reallocation') throw new Error('canonical reallocation fixture is required');
      intent.assignments[0]!.amount.minorUnits = minorUnits;
      expect(validateIntent(intent)).toBe(false);
      expect(consequentialActionIntentSchema.safeParse(intent)).toMatchObject({ success: false });
      const transfer: ConsequentialActionIntent = {
        kind: 'transfer',
        transferId: 'ledger-transfer-1',
        correlationId: 'transfer-correlation-1',
        sourceAccountId: 'checking',
        destinationAccountId: 'savings',
        amount: money(minorUnits),
        date: '2026-09-06',
      };
      expect(validateIntent(transfer)).toBe(false);
      expect(consequentialActionIntentSchema.safeParse(transfer)).toMatchObject({ success: false });
    }

    for (const minorUnits of ['0', '-9223372036854775808', '9223372036854775807']) {
      const signedMoneyIntent: ConsequentialActionIntent = {
        kind: 'manual_transaction',
        transaction: manualTransaction(minorUnits),
      };
      expectJsonValid(validateIntent, signedMoneyIntent);
      expect(consequentialActionIntentSchema.safeParse(signedMoneyIntent).success).toBe(true);
    }

    const malformedSignedMoneyIntent: ConsequentialActionIntent = {
      kind: 'manual_transaction',
      transaction: manualTransaction('-not-money'),
    };
    expect(validateIntent(malformedSignedMoneyIntent)).toBe(false);
    expect(() => consequentialActionIntentSchema.safeParse(malformedSignedMoneyIntent)).not.toThrow();
    expect(consequentialActionIntentSchema.safeParse(malformedSignedMoneyIntent)).toMatchObject({
      success: false,
    });

    const malformedMinorUnits = request();
    if (malformedMinorUnits.intent.kind !== 'reallocation') throw new Error('canonical reallocation fixture is required');
    malformedMinorUnits.intent.assignments[0]!.amount.minorUnits = 'not-money';
    expect(validateIntent(malformedMinorUnits.intent)).toBe(false);
    expect(consequentialActionIntentSchema.safeParse(malformedMinorUnits.intent)).toMatchObject({
      success: false,
    });
    expect(() => native.planConsequentialAction(JSON.stringify(malformedMinorUnits))).toThrow();

    const malformedTransfer: ConsequentialActionIntent = {
      kind: 'transfer',
      transferId: 'ledger-transfer-1',
      correlationId: 'transfer-correlation-1',
      sourceAccountId: 'checking',
      destinationAccountId: 'savings',
      amount: money('not-money'),
      date: '2026-09-06',
    };
    expect(validateIntent(malformedTransfer)).toBe(false);
    expect(consequentialActionIntentSchema.safeParse(malformedTransfer)).toMatchObject({
      success: false,
    });
    expect(() => native.planConsequentialAction(JSON.stringify(request(malformedTransfer)))).toThrow();

    const malformedCurrency = request();
    if (malformedCurrency.intent.kind !== 'reallocation') throw new Error('canonical reallocation fixture is required');
    malformedCurrency.intent.assignments[0]!.amount.currency = 'usd';
    expectRequestInvalid(malformedCurrency);
    expect(() => native.planConsequentialAction(JSON.stringify(malformedCurrency))).toThrow();
    const mismatchedCurrency = request();
    if (mismatchedCurrency.intent.kind !== 'reallocation') throw new Error('canonical reallocation fixture is required');
    mismatchedCurrency.intent.assignments[0]!.amount.currency = 'EUR';
    expectRequestValid(mismatchedCurrency);
    expect(() => native.planConsequentialAction(JSON.stringify(mismatchedCurrency))).toThrow();

    const missingSupplementalObservations = structuredClone(valid) as unknown as JsonObject;
    delete missingSupplementalObservations.supplementalObservations;
    expectRequestInvalid(missingSupplementalObservations);
    expect(() => native.planConsequentialAction(JSON.stringify(missingSupplementalObservations))).toThrow();
    const missingPolicyVersion = { ...valid } as Record<string, unknown>;
    delete missingPolicyVersion.financialPolicyVersion;
    expectRequestInvalid(missingPolicyVersion);
    expect(() => native.planConsequentialAction(JSON.stringify(missingPolicyVersion))).toThrow();
  });

  it('round-trips a complete native plan through both schema layers and verifies readback', () => {
    const source = request();
    expectRequestValid(source);
    const plan = JSON.parse(native.planConsequentialAction(JSON.stringify(source))) as ConsequentialActionPlan;
    expectJsonValid(validatePlan, plan);
    expect(consequentialActionPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.action).toEqual(source.intent);
    expect(plan.source.financialPolicyVersion).toBe(source.financialPolicyVersion);
    expect(plan.evidenceReferences).toEqual([actionFixture.resolvedEvidence[0]]);
    expect(plan.source.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.source.invalidatedSupplementalFacts).toEqual([]);
    expect(plan.source.manualPayeeBindings).toEqual([]);
    expect(plan.expectedPostconditions).toEqual([
      { kind: 'assignment', categoryId: 'food', asOfMonth: '2026-09', amount: money(2_000) },
      { kind: 'assignment', categoryId: 'reserve', asOfMonth: '2026-09', amount: money(4_000) },
      { kind: 'account_balance', accountId: 'checking', balance: money(13_000) },
      { kind: 'account_balance', accountId: 'savings', balance: money(20_000) },
    ]);
    expect(plan.actionHash).toMatch(/^[0-9a-f]{64}$/);

    const preconditions = verifyRequest(plan, source);
    expectJsonValid(validateVerifyRequest, preconditions);
    expect(verifyConsequentialActionRequestSchema.safeParse(preconditions).success).toBe(true);
    const preconditionResult = nativeVerify(preconditions);
    expectJsonValid(validateVerification, preconditionResult);
    expect(consequentialActionVerificationSchema.safeParse(preconditionResult).success).toBe(true);
    expect(preconditionResult).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });

    const postRead = structuredClone(source);
    postRead.currentLedger.assignments.find(({ categoryId }) => categoryId === 'food')!.amount = money(2_000);
    postRead.currentLedger.assignments.find(({ categoryId }) => categoryId === 'reserve')!.amount = money(4_000);
    const facts = postRead.decisionCardRequest.financialSnapshot.liquidity;
    if (!facts) throw new Error('canonical liquidity facts are required');
    facts.categories.find(({ categoryId }) => categoryId === 'food')!.availability = money(2_000);
    facts.categories.find(({ categoryId }) => categoryId === 'reserve')!.availability = money(4_000);
    const postconditions = verifyRequest(plan, postRead, 'postconditions');
    expectJsonValid(validateVerifyRequest, postconditions);
    expect(verifyConsequentialActionRequestSchema.safeParse(postconditions).success).toBe(true);
    const postconditionResult = nativeVerify(postconditions);
    expectJsonValid(validateVerification, postconditionResult);
    expect(postconditionResult).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });
    const unknownPlan = { ...plan, untrusted: true };
    expect(validatePlan(unknownPlan)).toBe(false);
    expect(consequentialActionPlanSchema.safeParse(unknownPlan).success).toBe(false);
    const missingPlanPolicyVersion = structuredClone(plan) as unknown as JsonObject;
    delete (missingPlanPolicyVersion.source as JsonObject).financialPolicyVersion;
    expect(validatePlan(missingPlanPolicyVersion)).toBe(false);
    expect(consequentialActionPlanSchema.safeParse(missingPlanPolicyVersion).success).toBe(false);
    for (const field of ['evidenceHash', 'invalidatedSupplementalFacts', 'manualPayeeBindings']) {
      const missingPlanSourceField = structuredClone(plan) as unknown as JsonObject;
      delete (missingPlanSourceField.source as JsonObject)[field];
      expect(validatePlan(missingPlanSourceField)).toBe(false);
      expect(consequentialActionPlanSchema.safeParse(missingPlanSourceField).success).toBe(false);
      expect(() => native.verifyConsequentialAction(JSON.stringify({
        ...preconditions,
        plan: missingPlanSourceField,
      }))).toThrow();
    }

    const missingPolicyVersion = { ...preconditions } as Record<string, unknown>;
    delete missingPolicyVersion.financialPolicyVersion;
    expect(validateVerifyRequest(missingPolicyVersion)).toBe(false);
    expect(verifyConsequentialActionRequestSchema.safeParse(missingPolicyVersion).success).toBe(false);
    expect(() => native.verifyConsequentialAction(JSON.stringify(missingPolicyVersion))).toThrow();
    const unknownVerifyField = { ...preconditions, untrusted: true };
    expect(validateVerifyRequest(unknownVerifyField)).toBe(false);
    expect(verifyConsequentialActionRequestSchema.safeParse(unknownVerifyField).success).toBe(false);
  });

  it('binds current event-resolution evidence into a native projection plan', () => {
    const source = request(actionFixture.evidenceProjectionIntent);
    if (source.intent.kind !== 'evidence_projection') throw new Error('canonical evidence projection intent is required');
    source.intent.transaction.parentId = 'projection-parent-generated-1';
    source.intent.transaction.correlationId = 'projection-correlation-generated-1';
    source.currentLedger.assignments.find(({ categoryId }) => categoryId === 'food')!.amount = money(2_000);
    const facts = source.decisionCardRequest.financialSnapshot.liquidity;
    if (!facts) throw new Error('canonical liquidity facts are required');
    facts.categories.find(({ categoryId }) => categoryId === 'food')!.availability = money(2_000);
    source.decisionCardRequest.items[0].amount = {
      minorUnits: (-BigInt(source.intent.transaction.amount.minorUnits)).toString(),
      currency: source.intent.transaction.amount.currency,
    };
    expectRequestValid(source);
    expect(actionFixture.sourceObservation.ledgerEffect).toEqual({
      accountId: source.intent.transaction.accountId,
      amount: source.intent.transaction.amount,
      date: source.intent.transaction.date,
      categoryId: source.intent.transaction.categoryId,
      payeeName: source.intent.transaction.payeeName,
      notes: source.intent.transaction.notes,
      splits: source.intent.transaction.splits,
    });

    const plan = JSON.parse(native.planConsequentialAction(JSON.stringify(source))) as ConsequentialActionPlan;
    expectJsonValid(validatePlan, plan);
    expect(consequentialActionPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.action).toEqual(source.intent);
    expect(plan.expectedPostconditions).toContainEqual(expect.objectContaining({
      kind: 'transaction',
      parentId: 'projection-parent-generated-1',
    }));
    expect(plan.evidenceReferences).toContainEqual(expect.objectContaining({
      evidenceId: 'fd-transaction-pending',
      subjectId: 'manual-parent-evidence-1',
      contentHash: 'fd-transaction-pending-content-1',
      version: 'fd-resolution/1',
      state: 'resolved',
    }));

    const preconditions = verifyRequest(plan, source);
    expectJsonValid(validateVerifyRequest, preconditions);
    expect(verifyConsequentialActionRequestSchema.safeParse(preconditions).success).toBe(true);
    const result = nativeVerify(preconditions);
    expectJsonValid(validateVerification, result);
    expect(result).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });
    for (const mismatch of ['amount', 'categoryId', 'date'] as const) {
      const changed = structuredClone(source);
      if (changed.intent.kind !== 'evidence_projection') throw new Error('canonical evidence projection intent is required');
      if (mismatch === 'amount') changed.intent.transaction.amount = money(-501);
      if (mismatch === 'categoryId') changed.intent.transaction.categoryId = 'reserve';
      if (mismatch === 'date') changed.intent.transaction.date = '2026-09-07';
      expectRequestValid(changed);
      expect(() => native.planConsequentialAction(JSON.stringify(changed))).toThrow();
    }
  });

  it('has native verification reject tampered composites, evidence, and policy material', () => {
    const compositeSource = request(actionFixture.compositeIntent);
    const compositePlan = JSON.parse(
      native.planConsequentialAction(JSON.stringify(compositeSource)),
    ) as ConsequentialActionPlan;
    expectJsonValid(validatePlan, compositePlan);
    expect(consequentialActionPlanSchema.safeParse(compositePlan).success).toBe(true);
    expect(compositePlan.source.manualPayeeBindings).toEqual([
      {
        parentId: 'manual-parent-composite-1',
        payeeName: 'Local shop',
        existingPayeeId: null,
      },
    ]);
    expect(compositePlan.source.invalidatedSupplementalFacts).toEqual([]);
    if (compositePlan.action.kind !== 'composite') throw new Error('native composite plan is required');
    const changedComposite = structuredClone(compositePlan);
    if (changedComposite.action.kind !== 'composite') throw new Error('native composite plan is required');
    const changedAtom = changedComposite.action.actions.find((action) => action.kind === 'manual_transaction');
    if (!changedAtom || changedAtom.kind !== 'manual_transaction') throw new Error('manual transaction atom is required');
    changedAtom.transaction.amount.minorUnits = '-501';
    expect(nativeVerify(verifyRequest(changedComposite, compositeSource))).toMatchObject({
      valid: false,
      reason: 'invalid_plan',
    });

    const source = request();
    const plan = JSON.parse(native.planConsequentialAction(JSON.stringify(source))) as ConsequentialActionPlan;
    const changedEvidencePlan = structuredClone(plan);
    changedEvidencePlan.evidenceReferences[0]!.contentHash = 'tampered-evidence-content';
    expect(nativeVerify(verifyRequest(changedEvidencePlan, source))).toMatchObject({
      valid: false,
      reason: 'invalid_plan',
    });
    const changedEvidence = structuredClone(source);
    changedEvidence.resolvedEvidence[0]!.contentHash = 'changed-checking-evidence';
    expect(nativeVerify(verifyRequest(plan, changedEvidence))).toMatchObject({
      valid: false,
      reason: 'evidence_changed',
    });

    const changedPolicyAmount = structuredClone(source);
    const donorPolicy = changedPolicyAmount.decisionCardRequest.categoryPolicies.find(
      ({ categoryId }) => categoryId === 'reserve',
    );
    if (!donorPolicy) throw new Error('canonical donor policy is required');
    donorPolicy.minimumRetained = money(1_001);
    expect(nativeVerify(verifyRequest(plan, changedPolicyAmount))).toMatchObject({
      valid: false,
      reason: 'source_changed',
    });
    const changedPolicyVersion = structuredClone(source);
    changedPolicyVersion.financialPolicyVersion = 'financial-policy-2';
    expect(nativeVerify(verifyRequest(plan, changedPolicyVersion))).toMatchObject({
      valid: false,
      reason: 'policy_changed',
    });
  });
});
