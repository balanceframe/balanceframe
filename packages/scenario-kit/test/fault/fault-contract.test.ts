import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LiquidityService, ConnectionManager } from '@balanceframe/application';
import type {
  AccountAwareSpendabilityRequest,
  DecisionCardRequest,
  FinancialSnapshot,
  TransferPlan,
  TransferSettlementRecord,
} from '@balanceframe/protocol-generated';
import type { ManualTransactionInput } from '../../../actual-adapter/src/types.js';
import {
  accountAwareSpendabilityRequestSchema,
  decisionCardRequestSchema,
} from '@balanceframe/protocol-generated/validators';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';

import { actualLiquidityRequest } from '../../../../tests/contract/fixtures/actual-liquidity.js';
import { materializeScenario, SCENARIO_CATALOG_VERSION } from '../../src/catalog.js';

const REFERENCE_ANCHOR = new Date('2026-09-06T12:00:00.000Z');
const EVALUATED_AT = '2026-09-06T10:00:00Z';
const SERVICE_NOW = '2026-09-06T10:01:00.000Z';
const SERVICE_EXPIRY = '2026-09-06T10:10:00.000Z';
const ACTOR = { actorId: 'fault-owner', budgetId: 'fixture' } as const;
function reportFault(faultId: string): void {
  const { currentTestName, assertionCalls } = expect.getState();
  if (!currentTestName || assertionCalls < 1) {
    throw new Error('Fault verification requires a named behavioral assertion');
  }
  console.log(
    JSON.stringify({
      type: 'fault-verification',
      catalogVersion: SCENARIO_CATALOG_VERSION,
      faultId,
      anchor: REFERENCE_ANCHOR.toISOString(),
      status: 'passed',
      assertions: { name: currentTestName, count: assertionCalls },
      evidence: { backend: 'native-service-fault', actualWrite: false },
    }),
  );
}

type JsonObject = Record<string, unknown>;

interface NativeFaultBinding {
  evaluateAccountAwareSpendability(input: string): string;
  evaluateDecisionCard(input: string): string;
  verifyTransferSettlement(input: string): string;
}

const native = createRequire(import.meta.url)('@balanceframe/native') as NativeFaultBinding;

function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function jsonArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => jsonObject(item, `${label}[${index}]`));
}

function fixture(path: string): JsonObject {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as JsonObject;
}

/**
 * Composes the checked-in normalized domain and foundation inputs exactly as the
 * native contract tests do. This is a protocol fixture, not an Actual workspace
 * and contains no connector response or bank receipt.
 */
function accountAwareRequest(): AccountAwareSpendabilityRequest {
  const domain = fixture('../../../../protocol/fixtures/account-aware-liquidity.json');
  const foundation = fixture('../../../../protocol/fixtures/financial-decision-foundation.json');
  const full = jsonObject(foundation.full, 'foundation.full');
  const coverage = jsonObject(full.coverage, 'foundation.full.coverage');
  const claims = jsonObject(foundation.claims, 'foundation.claims');
  const context = jsonObject(claims.context, 'foundation.claims.context');

  return accountAwareSpendabilityRequestSchema.parse({
    financialSnapshot: {
      ...full,
      snapshotId: domain.snapshotId,
      contentHash: domain.contentHash,
      liquidity: domain.facts,
      coverage: { ...coverage, categories: 'complete' },
    },
    context: {
      ...context,
      snapshotId: domain.snapshotId,
      contentHash: domain.contentHash,
      evaluatedAt: domain.evaluatedAt,
      horizon: domain.horizon,
      policyVersion: jsonObject(domain.liquidityPolicy, 'domain.liquidityPolicy').version,
      policyHash: jsonObject(domain.liquidityPolicy, 'domain.liquidityPolicy').policyHash,
    },
    liquidityPolicy: domain.liquidityPolicy,
    claimSet: domain.claimSet,
    priorAllocation: null,
    scenario: domain.scenario,
    validUntil: domain.validUntil,
  });
}

/**
 * Builds the immutable Decision Card fixture used by the native contract. The
 * source arrays are deliberately empty where the canonical facts are already
 * present in `financialSnapshot.liquidity`; fault cases only add the specific
 * source-boundary fact under test.
 */
function decisionCardRequest(): DecisionCardRequest {
  const accountRequest = accountAwareRequest();
  const snapshot = structuredClone(accountRequest.financialSnapshot);
  snapshot.capturedAt = EVALUATED_AT;
  snapshot.coverage = {
    ...snapshot.coverage,
    accounts: 'complete',
    categories: 'complete',
    transactions: 'complete',
    schedules: 'complete',
    budgets: 'complete',
  };
  snapshot.observations = [];
  snapshot.legacySnapshot = {
    ...snapshot.legacySnapshot,
    accounts: [],
    transactions: [],
    categories: [],
    budgets: [],
    schedules: [],
  };

  const context = structuredClone(accountRequest.context);
  context.evaluatedAt = EVALUATED_AT;
  context.policy = {
    ...context.policy,
    maxBudgetSnapshotAgeMinutes: 15,
    maxBankSyncAgeMinutes: null,
  };
  const item = structuredClone(accountRequest.scenario.items[0]);
  return decisionCardRequestSchema.parse({
    financialSnapshot: snapshot,
    context,
    liquidityPolicy: accountRequest.liquidityPolicy,
    claimSet: accountRequest.claimSet,
    priorAllocation: null,
    items: [{ ...item, priority: 'planned' }],
    categoryPolicies: [
      {
        categoryId: 'food',
        kind: 'ordinary',
        donorEligible: false,
        minimumRetained: { minorUnits: '0', currency: 'USD' },
        projectedRemainingNeed: { minorUnits: '0', currency: 'USD' },
      },
    ],
    validUntil: accountRequest.validUntil,
    requestId: 'fault-contract-request',
    correlationId: 'fault-contract-correlation',
    decisionId: 'fault-contract-decision',
  });
}

function evaluateDecisionCard(request: DecisionCardRequest): JsonObject {
  return jsonObject(
    JSON.parse(native.evaluateDecisionCard(JSON.stringify(request))),
    'native decision card',
  );
}

function minorUnits(value: unknown, label: string): string {
  return String(jsonObject(value, label).minorUnits);
}

function cardCategory(card: JsonObject, side: 'before' | 'after', categoryId: string): JsonObject {
  const state = jsonObject(card[side], `card.${side}`);
  const categories = jsonArray(state.categories, `card.${side}.categories`);
  const category = categories.find((candidate) => candidate.categoryId === categoryId);
  if (!category) throw new Error(`Missing ${side} category ${categoryId}`);
  return category;
}

function makeSettlementRecord(
  plan: TransferPlan,
  pairId: string,
  accountId: string,
  amount: string,
  suffix: string,
): TransferSettlementRecord {
  return {
    id: `fault-${suffix}`,
    accountId,
    amount: { minorUnits: amount, currency: plan.minimumAmount.currency },
    observedAt: '2026-09-06T12:00:00Z',
    occurredAt: '2026-09-06',
    importedId: `fault-import-${suffix}`,
    providerReference: null,
    pairId,
    reconciled: true,
    reversed: false,
    provenance: 'actual_import',
  };
}

/**
 * Fault seam: normalized settlement evidence is supplied directly to the pure
 * native verifier. These are not Actual rows and are never persisted as bank
 * data; two independently paired candidates deliberately make one plan leg
 * non-unique.
 */
function ambiguousSettlementRecords(plan: TransferPlan): TransferSettlementRecord[] {
  const leg = plan.legs[0];
  if (!leg) throw new Error('Transfer plan must contain one leg');
  const amount = leg.amount.minorUnits;
  return [
    makeSettlementRecord(plan, 'fault-pair-a', leg.sourceAccountId, `-${amount}`, 'source-a'),
    makeSettlementRecord(plan, 'fault-pair-a', leg.destinationAccountId, amount, 'destination-a'),
    makeSettlementRecord(plan, 'fault-pair-b', leg.sourceAccountId, `-${amount}`, 'source-b'),
    makeSettlementRecord(plan, 'fault-pair-b', leg.destinationAccountId, amount, 'destination-b'),
  ];
}

function createServiceManager(
  snapshot: FinancialSnapshot,
  writeAttempts: ManualTransactionInput[],
): ConnectionManager {
  const config = JSON.stringify({
    version: 1,
    serverUrl: 'http://fault-injection',
    budgetId: ACTOR.budgetId,
    budgetName: 'Fault fixture',
    groupId: ACTOR.budgetId,
  });
  return new ConnectionManager({
    readFile: async () => config,
    writeFile: async () => {},
    credentialStore: {
      load: async () => ({ serverUrl: 'http://fault-injection', secretKey: 'fault-injection' }),
      store: async () => {},
    },
    connectorFactory: async () => ({
      connect: async () => [
        { id: ACTOR.budgetId, groupId: ACTOR.budgetId, name: 'Fault fixture', encrypted: false },
      ],
      selectBudget: async () => ({
        id: ACTOR.budgetId,
        groupId: ACTOR.budgetId,
        name: 'Fault fixture',
        encrypted: false,
      }),
      synchronize: async () => ({ financialSnapshot: snapshot, snapshot: snapshot.legacySnapshot }),
      /** Explicit fault seam: the response is interrupted after this write attempt. */
      createManualTransaction: async (input: ManualTransactionInput) => {
        writeAttempts.push(input);
        throw new Error('fault-injection: connector response interrupted after write acceptance');
      },
      disconnect: async () => {},
    }),
  });
}

async function createCompletionService(): Promise<{
  store: SqliteWorkflowStore;
  snapshot: FinancialSnapshot;
}> {
  const source = actualLiquidityRequest(true);
  const snapshot = source.financialSnapshot;
  const store = new SqliteWorkflowStore(':memory:');
  await store.claimBootstrap({
    name: 'Fault owner',
    email: 'fault-owner@example.invalid',
    claimId: 'fault-bootstrap',
  });
  await store.finalizeBootstrap({ claimId: 'fault-bootstrap', ownerUserId: ACTOR.actorId });
  await store.upsertActorMembership(
    ACTOR.actorId,
    'active',
    ['observe'],
    `budget:${ACTOR.budgetId}`,
  );
  store.liquidity.provisionOwnerAccess({
    ...ACTOR,
    now: SERVICE_NOW,
    resources: [
      { resourceKind: 'account', resourceId: 'cash' },
      { resourceKind: 'category', resourceId: 'food' },
    ],
  });
  store.liquidity.savePolicy({
    ...ACTOR,
    expectedVersion: null,
    now: SERVICE_NOW,
    policy: source.liquidityPolicy,
    approvalPolicy: { minimumApprovers: 1 },
  });
  return { store, snapshot };
}

describe('fault-contract native/service scenarios', () => {
  it('ambiguous-transfer rejects multiple independently paired settlement candidates', () => {
    const catalog = materializeScenario('account-transfer', REFERENCE_ANCHOR);
    expect(catalog.entry.kind).toBe('purchase');
    expect(catalog.entry.input.amount.minorUnits).toBe('2000');

    const request = accountAwareRequest();
    const evaluation = jsonObject(
      JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
      'native account-aware evaluation',
    );
    expect(evaluation.budgetFundingStatus).toBe('funded');
    expect(evaluation.paymentLiquidityStatus).toBe('transfer_required');
    const purchase = jsonArray(evaluation.purchases, 'evaluation.purchases')[0];
    if (!purchase) throw new Error('Transfer fixture must return one purchase');
    const plan = jsonObject(
      purchase.transferPlan,
      'evaluation.purchases[0].transferPlan',
    ) as unknown as TransferPlan;
    expect(plan.minimumAmount.minorUnits).toBe('3000');
    expect(plan.legs).toHaveLength(1);

    const result = jsonObject(
      JSON.parse(
        native.verifyTransferSettlement(
          JSON.stringify({
            plan,
            evaluatedAt: '2026-09-06T12:00:00Z',
            records: ambiguousSettlementRecords(plan),
            consumedEvidenceIds: [],
          }),
        ),
      ),
      'native ambiguous settlement result',
    );
    expect(result).toMatchObject({
      confirmed: false,
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
      evidenceIds: [],
      claimEffects: null,
    });
    expect(result.reasons).toEqual(expect.arrayContaining(['ambiguous_transfer_pair']));
    reportFault('ambiguous-transfer');
  });

  it.each([
    ['missing', []],
    [
      'duplicate',
      [
        {
          kind: 'account_collection_coverage',
          scope: { kind: 'global' },
          state: 'complete',
          observedAt: EVALUATED_AT,
          evidence: [],
        },
        {
          kind: 'account_collection_coverage',
          scope: { kind: 'global' },
          state: 'complete',
          observedAt: EVALUATED_AT,
          evidence: [],
        },
      ],
    ],
  ] as const)('source-coverage-receipt-integrity rejects %s global receipt', (kind, receipts) => {
    const catalog = materializeScenario('missing-account-evidence', REFERENCE_ANCHOR);
    expect(catalog.observations.observations).toHaveLength(0);

    // Fault injection at the native source-coverage boundary; no connector or
    // bank data is written, and the duplicate values are deliberately invalid.
    const request = decisionCardRequest();
    request.financialSnapshot.coverage.accounts = 'partial';
    request.financialSnapshot.observations = [
      ...request.financialSnapshot.observations,
      ...receipts,
    ];
    const card = evaluateDecisionCard(decisionCardRequestSchema.parse(request));
    expect(card.outcome).toBe('insufficient_data');
    expect(card.budgetFundingStatus).toBe('funded');
    expect(card.paymentLiquidityStatus).toBe('insufficient_data');
    expect(card.after).toBeNull();
    expect(card.blockers).toEqual(expect.arrayContaining(['incomplete_accounts_coverage']));
    reportFault(`source-coverage-receipt-integrity:${kind}`);
  });

  it('authoritative-schedule-claim-overlap counts one economic obligation once', () => {
    const catalog = materializeScenario('commitment-overlap', REFERENCE_ANCHOR);
    const sourceItem = catalog.sessions.origin?.items[0];
    if (!sourceItem) throw new Error('Commitment-overlap catalog must contain an origin item');
    const commitmentAmount = sourceItem.amount.minorUnits;
    const request = decisionCardRequest();
    request.items[0]!.amount = { minorUnits: '500', currency: 'USD' };
    const snapshot = request.financialSnapshot;
    const legacy = snapshot.legacySnapshot;
    legacy.schedules = [
      {
        id: 'fault-authoritative-schedule',
        frequency: 'monthly',
        amount: { minorUnits: `-${commitmentAmount}`, currency: 'USD' },
        payeeName: 'Authoritative scheduled obligation',
        accountId: 'checking',
        nextExpected: '2026-09-10',
      },
    ];
    const account = snapshot.liquidity?.accounts.find(
      (candidate) => candidate.accountId === 'checking',
    );
    if (!account) throw new Error('Decision card fixture must contain checking facts');
    account.obligations = [
      {
        id: 'fault-obligation',
        economicObligationId: 'schedule:fault-authoritative-schedule:2026-09-10',
        categoryId: 'food',
        amount: { minorUnits: commitmentAmount, currency: 'USD' },
        dueAt: '2026-09-10T12:00:00Z',
        paid: false,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ];
    request.claimSet = {
      revision: 'fault-claims-1',
      bundles: [
        {
          id: 'fault-overlap-claim',
          creationSnapshotId: request.context.snapshotId,
          creationPolicyVersion: request.context.policyVersion,
          state: 'active',
          expiresAt: request.validUntil,
          initiated: false,
          effects: [
            {
              kind: 'category',
              resourceId: 'food',
              amount: { minorUnits: commitmentAmount, currency: 'USD' },
              economicObligationId: 'schedule:fault-authoritative-schedule:2026-09-10',
              categoryId: 'food',
              includedInBalance: false,
              matchedTransactionIds: [],
            },
          ],
        },
      ],
    };
    const card = evaluateDecisionCard(decisionCardRequestSchema.parse(request));
    const before = cardCategory(card, 'before', 'food');
    const after = cardCategory(card, 'after', 'food');
    expect(card.outcome).toBe('safe_after_date');
    expect(before.commitments).toMatchObject({ minorUnits: commitmentAmount, currency: 'USD' });
    expect(after.commitments).toMatchObject({ minorUnits: commitmentAmount, currency: 'USD' });
    expect(before.reservations).toMatchObject({ minorUnits: '0', currency: 'USD' });
    expect(after.reservations).toMatchObject({ minorUnits: '0', currency: 'USD' });
    expect(minorUnits(after.availability, 'card.after.food.availability')).toBe('1500');
    reportFault('authoritative-schedule-claim-overlap');
  });

  it('completion-crash-retry retains the initiated debit hold and never issues a second connector write', async () => {
    const catalog = materializeScenario('commitment-overlap', REFERENCE_ANCHOR);
    const sourceItem = catalog.sessions.origin?.items[0];
    if (!sourceItem) throw new Error('Commitment-overlap catalog must contain an origin item');
    const { store, snapshot } = await createCompletionService();
    const writeAttempts: ManualTransactionInput[] = [];
    const faultManager = createServiceManager(snapshot, writeAttempts);
    const faultService = new LiquidityService({
      connectionManager: faultManager,
      mutationConnectionManager: faultManager,
      store,
      native,
      clock: () => new Date(SERVICE_NOW),
    });
    try {
      const session = await faultService.saveSession(ACTOR, null, {
        accountId: 'cash',
        expiresAt: SERVICE_EXPIRY,
        items: [
          {
            ...sourceItem,
            accountId: 'cash',
            categoryId: 'food',
            purchaseAt: SERVICE_NOW,
            requiredBy: SERVICE_NOW,
          },
        ],
      });
      expect(session.card).toMatchObject({ outcome: 'funded_now' });
      const proposed = await faultService.proposeSessionCompletion(ACTOR, session.id, {
        expectedSessionVersion: session.version,
        idempotencyKey: 'fault-completion-propose',
      });
      expect(proposed).toMatchObject({ phase: 'proposed', debit: { amount: -1500 } });
      const approved = await faultService.approveSessionCompletion(ACTOR, proposed.id, {
        payloadHash: proposed.payloadHash!,
        expectedVersion: proposed.version,
        idempotencyKey: 'fault-completion-approve',
      });
      expect(approved.phase).toBe('approved');

      const interrupted = await faultService.executeSessionCompletion(ACTOR, proposed.id, {
        payloadHash: proposed.payloadHash!,
        expectedVersion: approved.version,
        idempotencyKey: 'fault-completion-execute',
      });
      expect(interrupted).toMatchObject({
        phase: 'review_required',
        outcome: 'reconciliation_required',
        reviewRequired: true,
        debit: { amount: -1500 },
      });
      expect(writeAttempts).toHaveLength(1);
      expect(writeAttempts[0]).toMatchObject({
        amount: -1500,
        accountId: 'cash',
        categoryId: 'food',
      });
      const held = store.liquidity.getClaimSet({ ...ACTOR, now: SERVICE_NOW }).bundles;
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ state: 'initiated', initiated: true });
      expect(held[0]?.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'account_debit',
            resourceId: 'cash',
            amount: { minorUnits: '1500', currency: 'USD' },
          }),
        ]),
      );

      const retry = await faultService.executeSessionCompletion(ACTOR, interrupted.id, {
        payloadHash: proposed.payloadHash!,
        expectedVersion: interrupted.version,
        idempotencyKey: 'fault-completion-retry',
      });
      expect(retry.phase).toBe('review_required');
      expect(writeAttempts).toHaveLength(1);

      const unresolved = await faultService.reconcileSessionCompletion(ACTOR, interrupted.id, {
        payloadHash: proposed.payloadHash!,
        expectedVersion: retry.version,
        idempotencyKey: 'fault-completion-reconcile',
      });
      expect(unresolved).toMatchObject({
        phase: 'review_required',
        outcome: 'ambiguous',
        reviewRequired: true,
        manualTransactionId: null,
      });
      expect(writeAttempts).toHaveLength(1);
      expect(store.liquidity.getClaimSet({ ...ACTOR, now: SERVICE_NOW }).bundles[0]).toMatchObject({
        state: 'initiated',
        initiated: true,
      });
      reportFault('completion-crash-retry');
    } finally {
      await faultManager.disconnect();
      store.close();
    }
  });
});
