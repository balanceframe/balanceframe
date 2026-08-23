import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DecisionContext,
  FinancialSnapshot,
  ProspectiveClaim,
  ProspectiveDecisionEnvelope,
  PurchaseEvaluation,
} from '@balanceframe/protocol-generated';
import { describe, expect, it, vi } from 'vitest';

import { purchaseEvaluationAnalysis } from '../src/analysis';
import type {
  AnalysisProtocol,
  PurchaseEvaluationParams,
  PurchaseEvaluationResult,
} from '../src/commands';
import { createNativeAnalysisProtocol, type NativeBindingShim } from '../src/composition';

type FoundationFixture = {
  full: FinancialSnapshot;
  claims: {
    context: DecisionContext;
    items: ProspectiveClaim[];
  };
  decisions: {
    ready: ProspectiveDecisionEnvelope<PurchaseEvaluation>;
    qualified: ProspectiveDecisionEnvelope<PurchaseEvaluation>;
    blocked: ProspectiveDecisionEnvelope<PurchaseEvaluation>;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../protocol/fixtures/financial-decision-foundation.json',
);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as FoundationFixture;

const PURCHASE_PARAMS: PurchaseEvaluationParams = {
  categoryId: 'fd-category-groceries',
  accountId: 'fd-account-checking',
  amount: { minorUnits: '5500', currency: 'USD' },
  context: fixture.claims.context,
  claims: fixture.claims.items,
  requestId: fixture.decisions.blocked.metadata.requestId,
  correlationId: fixture.decisions.blocked.metadata.correlationId,
  decisionId: fixture.decisions.blocked.metadata.decisionId,
  validUntil: fixture.decisions.blocked.expiresAt,
  redaction: fixture.decisions.blocked.redaction,
};
function legacyPurchaseResult(): PurchaseEvaluationResult {
  return {
    allowable: true,
    reasonCodes: ['sufficient_budget'],
    categoryBudget: { minorUnits: '20000', currency: 'USD' },
    categorySpent: { minorUnits: '10000', currency: 'USD' },
    categoryRemaining: { minorUnits: '4500', currency: 'USD' },
    projectedBalance: { minorUnits: '119500', currency: 'USD' },
    hasEnvelope: true,
  };
}

function nativeShim(overrides: Partial<NativeBindingShim> = {}): NativeBindingShim {
  const legacy = legacyPurchaseResult();
  return {
    analyzeDeterministic: () => JSON.stringify({}),
    analyzeSnapshot: () => JSON.stringify({}),
    findCategorizationCandidates: () => JSON.stringify([]),
    evaluatePurchase: () => JSON.stringify(legacy),
    evaluateProspectivePurchase: () => JSON.stringify(fixture.decisions.ready),
    projectCashFlow: () => JSON.stringify({}),
    evaluateTargetHealth: () => JSON.stringify({}),
    evaluateFinancialState: () => JSON.stringify({}),
    computeDataQuality: () => JSON.stringify({}),
    computeLiquidityCoverage: () => JSON.stringify({}),
    computeBillCalendar: () => JSON.stringify({}),
    computeBudgetVariance: () => JSON.stringify({}),
    detectIrregularObligations: () => JSON.stringify({}),
    assessIncomeReliability: () => JSON.stringify({}),
    evaluateForecastCalibration: () => JSON.stringify({}),
    compareScenarios: () => JSON.stringify({}),
    evaluateMultidimensionalHealth: () => JSON.stringify({}),
    ...overrides,
  };
}

function canonicalLedger() {
  const synchronize = vi.fn(async () => ({
    snapshot: fixture.full.legacySnapshot,
    financialSnapshot: fixture.full,
  }));
  return { ledger: { synchronize }, synchronize };
}

function decisionResult(
  decision: ProspectiveDecisionEnvelope<PurchaseEvaluation>,
): PurchaseEvaluationResult {
  return {
    ...decision.payload,
    hasEnvelope: decision.before.amounts.some(({ label }) => label === 'envelopeAvailability'),
    decision,
  };
}

describe('createNativeAnalysisProtocol — canonical prospective purchase decisions', () => {
  it('delegates the canonical snapshot, fixed context, claims, and proposed purchase without invoking the legacy binding', async () => {
    const prospectiveCalls: string[] = [];
    const legacyEvaluate = vi.fn(() => JSON.stringify(legacyPurchaseResult()));
    const shim = nativeShim({
      evaluatePurchase: legacyEvaluate,
      evaluateProspectivePurchase(input) {
        prospectiveCalls.push(input);
        return JSON.stringify(fixture.decisions.blocked);
      },
    });
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const { ledger, synchronize } = canonicalLedger();

    const result = await protocol.purchaseEvaluation!(ledger, PURCHASE_PARAMS);

    expect(synchronize).toHaveBeenCalledOnce();
    expect(legacyEvaluate).not.toHaveBeenCalled();
    expect(prospectiveCalls).toHaveLength(1);

    const input = JSON.parse(prospectiveCalls[0]) as Record<string, unknown>;
    expect(input).not.toHaveProperty('snapshot');
    expect(input).toMatchObject({
      financialSnapshot: fixture.full,
      requestId: PURCHASE_PARAMS.requestId,
      correlationId: PURCHASE_PARAMS.correlationId,
      decisionId: PURCHASE_PARAMS.decisionId,
      validUntil: PURCHASE_PARAMS.validUntil,
      redaction: PURCHASE_PARAMS.redaction,
      context: fixture.claims.context,
      claims: fixture.claims.items,
      categoryId: PURCHASE_PARAMS.categoryId,
      proposedTransaction: {
        accountId: PURCHASE_PARAMS.accountId,
        date: '2026-08-23',
        amount: PURCHASE_PARAMS.amount,
        categoryId: PURCHASE_PARAMS.categoryId,
      },
    });

    expect(result).toEqual(decisionResult(fixture.decisions.blocked));
    expect(result.decision).toEqual(fixture.decisions.blocked);
    expect(result.decision?.issues.map(({ code }) => code)).toContain('fd_future_safety_code');
    expect(result.reasonCodes).toContain('fd_future_reason_code');
  });

  it('preserves every typed decision field and derives hasEnvelope only from semantic envelope availability', async () => {
    const withoutEnvelope = structuredClone(fixture.decisions.qualified);
    withoutEnvelope.before.amounts = withoutEnvelope.before.amounts.filter(
      ({ label }) => label !== 'envelopeAvailability',
    );
    withoutEnvelope.after.amounts = withoutEnvelope.after.amounts.filter(
      ({ label }) => label !== 'envelopeAvailability',
    );
    const shim = nativeShim({
      evaluateProspectivePurchase: () => JSON.stringify(withoutEnvelope),
    });
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const { ledger } = canonicalLedger();

    const result = await protocol.purchaseEvaluation!(ledger, PURCHASE_PARAMS);

    expect(result).toEqual({
      ...withoutEnvelope.payload,
      hasEnvelope: false,
      decision: withoutEnvelope,
    });
    expect(result.decision).toEqual(withoutEnvelope);
    expect(result.decision).toMatchObject({
      metadata: {
        contractVersion: withoutEnvelope.metadata.contractVersion,
        decisionId: withoutEnvelope.metadata.decisionId,
        requestId: withoutEnvelope.metadata.requestId,
        correlationId: withoutEnvelope.metadata.correlationId,
        context: fixture.claims.context,
      },
      readiness: 'qualified',
      before: withoutEnvelope.before,
      after: withoutEnvelope.after,
      issues: withoutEnvelope.issues,
      evidence: withoutEnvelope.evidence,
      alternatives: withoutEnvelope.alternatives,
      expiresAt: withoutEnvelope.expiresAt,
      redaction: withoutEnvelope.redaction,
      payload: withoutEnvelope.payload,
    });
  });

  it.each(['categoryBudget', 'categorySpent', 'categoryRemaining'] as const)(
    'rejects a prospective decision with missing %s instead of fabricating zero money',
    async (field) => {
      const malformed = structuredClone(fixture.decisions.ready) as unknown as Record<
        string,
        unknown
      >;
      const payload = malformed.payload as Record<string, unknown>;
      delete payload[field];
      const shim = nativeShim({
        evaluateProspectivePurchase: () => JSON.stringify(malformed),
      });
      const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
      const { ledger } = canonicalLedger();

      await expect(protocol.purchaseEvaluation!(ledger, PURCHASE_PARAMS)).rejects.toThrow();
    },
  );

  it.each([
    ['categoryBudget', { minorUnits: 20000, currency: 'USD' }],
    ['categorySpent', { minorUnits: '10000' }],
    ['categoryRemaining', null],
  ] as const)(
    'rejects malformed %s money instead of coercing or defaulting it',
    async (field, invalidMoney) => {
      const malformed = structuredClone(fixture.decisions.ready) as unknown as Record<
        string,
        unknown
      >;
      const payload = malformed.payload as Record<string, unknown>;
      payload[field] = invalidMoney;
      const shim = nativeShim({
        evaluateProspectivePurchase: () => JSON.stringify(malformed),
      });
      const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
      const { ledger } = canonicalLedger();

      await expect(protocol.purchaseEvaluation!(ledger, PURCHASE_PARAMS)).rejects.toThrow();
    },
  );

  it('falls back to evaluatePurchase and preserves its legacy wire output when the new binding is unavailable', async () => {
    const expected = legacyPurchaseResult();
    const legacyCalls: string[] = [];
    const shim = nativeShim({
      evaluatePurchase(input) {
        legacyCalls.push(input);
        return JSON.stringify(expected);
      },
    });
    delete shim.evaluateProspectivePurchase;
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const synchronize = vi.fn(async () => ({ snapshot: fixture.full.legacySnapshot }));

    const result = await protocol.purchaseEvaluation!({ synchronize }, PURCHASE_PARAMS);

    expect(result).toEqual(expected);
    expect(result).not.toHaveProperty('decision');
    expect(legacyCalls).toHaveLength(1);
    expect(JSON.parse(legacyCalls[0])).toMatchObject({
      snapshot: fixture.full.legacySnapshot,
      categoryId: PURCHASE_PARAMS.categoryId,
      proposedTransaction: {
        amount: PURCHASE_PARAMS.amount,
        date: '2026-08-23',
        categoryId: PURCHASE_PARAMS.categoryId,
      },
    });
  });
});

describe('purchaseEvaluationAnalysis — typed application JSON', () => {
  it('returns legacy fields and the unchanged typed decision without a model call', async () => {
    const expected = decisionResult(fixture.decisions.blocked);
    const purchaseEvaluation = vi.fn(async () => expected);
    const protocol = { purchaseEvaluation } as AnalysisProtocol;

    const envelope = await purchaseEvaluationAnalysis(
      {
        args: [],
        mode: 'observe',
        actorId: 'usr_financial_decision',
        requestId: 'fd-request-application-2026-08-23',
        ledger: { canonical: true },
        freshness: {
          actualDownloadedAt: '2026-08-23T12:00:00Z',
          bankSyncedAt: '2026-08-23T11:58:00Z',
          pendingTransactionsIncluded: true,
          stalenessDays: 0,
          isStale: false,
        },
        analysisProtocol: protocol,
      },
      PURCHASE_PARAMS,
    );

    expect(purchaseEvaluation).toHaveBeenCalledWith({ canonical: true }, PURCHASE_PARAMS);
    expect(envelope.status).toBe('ok');
    expect(envelope.result).toEqual(expected);
    expect(envelope.result?.decision).toEqual(fixture.decisions.blocked);
    expect(envelope.result?.decision?.issues.map(({ code }) => code)).toContain(
      'fd_future_safety_code',
    );
  });
});
