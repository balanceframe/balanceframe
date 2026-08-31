import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type Money = {
  minorUnits: string;
  currency: string;
};

type DecisionScope = {
  kind: string;
  id?: string;
};

type EvidenceReference = {
  evidenceId: string;
  kind: string;
  authorized: boolean;
  redaction: 'visible' | 'redacted';
};

type SourceObservation = {
  kind: string;
  scope: DecisionScope;
  state: string;
  observedAt: string | null;
  evidence: EvidenceReference[];
};

type ProspectiveClaim = {
  claimId: string;
  kind: 'reservation' | 'commitment';
  sourceId: string;
  scope: DecisionScope;
  amount: Money;
  status: 'active' | 'released';
  effectiveFrom: string;
  expiresAt: string | null;
  visibility: 'visible' | 'redacted';
  policyVersion: string;
  snapshotId: string;
};

type DecisionIssue = {
  code: string;
  severity: string;
  effect: string;
  scope: DecisionScope;
  evidence: EvidenceReference[];
  redaction: string;
};

type PurchaseDecision = {
  metadata: {
    contractVersion: string;
    decisionId: string;
    decisionKind: string;
    requestId: string;
    correlationId: string;
    context: {
      evaluatedAt: string;
      snapshotId: string;
      contentHash: string;
      policyVersion: string;
      policyHash: string;
    };
  };
  readiness: 'ready' | 'qualified' | 'blocked';
  before: { amounts: Array<{ label: string; scope: DecisionScope; amount: Money }> };
  after: { amounts: Array<{ label: string; scope: DecisionScope; amount: Money }> };
  issues: DecisionIssue[];
  evidence: EvidenceReference[];
  expiresAt: string;
  payload: {
    allowable: boolean;
    reasonCodes: string[];
    categoryBudget: Money;
    categorySpent: Money;
    categoryRemaining: Money;
    projectedBalance: Money | null;
  };
};

type FinancialDecisionFixture = {
  full: {
    contractVersion: string;
    snapshotId: string;
    contentHash: string;
    source: {
      ledgerBackend: string;
      ledgerId: string;
      budgetId: string;
      spaceId: string | null;
    };
    capturedAt: string;
    sourceNormalizationVersion: string;
    legacySnapshot: {
      schemaVersion: string;
      actualVersion: string;
      snapshotDate: string;
      accounts: Array<{
        id: string;
        clearedBalance: Money;
        importedBalance: Money;
      }>;
      transactions: Array<{ id: string; accountId: string; date: string; amount: Money }>;
      schedules: Array<{ id: string; accountId: string; nextExpected: string; amount: Money }>;
    };
    coverage: Record<string, string>;
    inclusionScope: {
      pendingActivity: string;
      unclearedActivity: string;
    };
    observations: SourceObservation[];
  };
  unknownVsEmpty: {
    unknownCoverage: Record<string, string>;
    explicitEmptyCoverage: Record<string, string>;
  };
  ambiguities: {
    observations: SourceObservation[];
  };
  claims: {
    context: {
      evaluatedAt: string;
      horizon: { startsAt: string; endsAt: string };
      policy: {
        pendingMode: string;
        uncategorizedMode: string;
        unclearedMode: string;
        maxBankSyncAgeMinutes: number | null;
        maxBudgetSnapshotAgeMinutes: number | null;
        accountOverrides: { includeOnly: string[] | null; exclude: string[] };
      };
      policyVersion: string;
      policyHash: string;
      snapshotId: string;
      contentHash: string;
    };
    items: ProspectiveClaim[];
    evaluation: {
      eligibleClaimIds: string[];
      reservationTotal: Money | null;
      commitmentTotal: Money | null;
      issues: DecisionIssue[];
    };
  };
  decisions: {
    ready: PurchaseDecision;
    qualified: PurchaseDecision;
    blocked: PurchaseDecision;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../protocol/fixtures/financial-decision-foundation.json',
);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as FinancialDecisionFixture;

function observation(observations: SourceObservation[], kind: string): SourceObservation {
  const found = observations.find((candidate) => candidate.kind === kind);
  expect(found, `missing ${kind} observation`).toBeDefined();
  return found!;
}

function claim(claimId: string): ProspectiveClaim {
  const found = fixture.claims.items.find((candidate) => candidate.claimId === claimId);
  expect(found, `missing ${claimId}`).toBeDefined();
  return found!;
}

function sensitiveInferenceKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(sensitiveInferenceKeys);
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => [
    ...(/model|provider/i.test(key) ? [key] : []),
    ...sensitiveInferenceKeys(nested),
  ]);
}

describe('financial decision foundation fixture', () => {
  it('has deterministic named scenarios and full snapshot identities', () => {
    expect(Object.keys(fixture)).toEqual([
      'full',
      'unknownVsEmpty',
      'ambiguities',
      'claims',
      'decisions',
    ]);
    expect(fixture.full).toMatchObject({
      contractVersion: '1.0',
      snapshotId: 'fd-snapshot-2026-08-23',
      contentHash: 'sha256:fd-snapshot-2026-08-23',
      source: {
        ledgerBackend: 'actual',
        ledgerId: 'fd-ledger-household',
        budgetId: 'fd-budget-household',
        spaceId: 'fd-space-family',
      },
      capturedAt: '2026-08-23T12:00:00Z',
      sourceNormalizationVersion: 'fd-fixture/1',
    });
    expect(fixture.full.legacySnapshot).toMatchObject({
      schemaVersion: '1',
      actualVersion: '26.8.0',
      snapshotDate: '2026-08-23T12:00:00Z',
    });
    expect(fixture.full.legacySnapshot.accounts.map(({ id }) => id)).toEqual([
      'fd-account-checking',
      'fd-account-card',
      'fd-account-cash',
    ]);
    expect(fixture.full.legacySnapshot.transactions.map(({ id }) => id)).toEqual([
      'fd-transaction-pending',
      'fd-transaction-existing',
      'fd-transfer-one-sided',
    ]);
    expect(fixture.full.legacySnapshot.schedules.map(({ id }) => id)).toEqual([
      'fd-schedule-card-payment',
    ]);
    expect(fixture.full.legacySnapshot.accounts[0]?.clearedBalance).toEqual({
      minorUnits: '125000',
      currency: 'USD',
    });
    expect(fixture.full.legacySnapshot.transactions[0]?.amount).toEqual({
      minorUnits: '-1250',
      currency: 'USD',
    });
    expect(fixture.full.legacySnapshot.schedules[0]).toMatchObject({
      accountId: 'fd-account-checking',
      nextExpected: '2026-08-31',
      amount: { minorUnits: '25000', currency: 'USD' },
    });
  });

  it('distinguishes omitted unknown coverage from explicit empty coverage', () => {
    expect(fixture.unknownVsEmpty.unknownCoverage).toEqual({
      accounts: 'complete',
    });
    expect('transactions' in fixture.unknownVsEmpty.unknownCoverage).toBe(false);
    expect('schedules' in fixture.unknownVsEmpty.unknownCoverage).toBe(false);
    expect(fixture.unknownVsEmpty.explicitEmptyCoverage).toEqual({
      accounts: 'complete',
      transactions: 'empty',
      categories: 'empty',
      payees: 'empty',
      rules: 'empty',
      schedules: 'empty',
      budgets: 'empty',
      tags: 'empty',
    });
  });

  it('preserves complete collection coverage and per-account freshness', () => {
    expect(fixture.full.coverage).toEqual({
      accounts: 'complete',
      transactions: 'complete',
      categories: 'empty',
      payees: 'empty',
      rules: 'empty',
      schedules: 'complete',
      budgets: 'empty',
      tags: 'empty',
    });

    const freshness = fixture.full.observations.filter(({ kind }) => kind === 'account_freshness');
    expect(freshness).toEqual([
      {
        kind: 'account_freshness',
        scope: { kind: 'account', id: 'fd-account-checking' },
        state: 'fresh',
        observedAt: '2026-08-23T11:58:00Z',
        evidence: [
          {
            evidenceId: 'fd-bank-sync-checking-884',
            kind: 'bank_sync',
            authorized: true,
            redaction: 'visible',
          },
        ],
      },
      {
        kind: 'account_freshness',
        scope: { kind: 'account', id: 'fd-account-card' },
        state: 'stale',
        observedAt: '2026-08-20T09:00:00Z',
        evidence: [
          {
            evidenceId: 'fd-bank-sync-card-119',
            kind: 'bank_sync',
            authorized: true,
            redaction: 'visible',
          },
        ],
      },
      {
        kind: 'account_freshness',
        scope: { kind: 'account', id: 'fd-account-cash' },
        state: 'unavailable',
        observedAt: null,
        evidence: [
          {
            evidenceId: 'fd-connector-error-cash-7',
            kind: 'connector_error',
            authorized: false,
            redaction: 'redacted',
          },
        ],
      },
    ]);
  });

  it('records pending, uncleared, schedule, and card-payment obligations', () => {
    expect(fixture.full.inclusionScope).toEqual({
      pendingActivity: 'included',
      unclearedActivity: 'included',
    });
    expect(observation(fixture.full.observations, 'pending_activity')).toEqual({
      kind: 'pending_activity',
      scope: { kind: 'account', id: 'fd-account-checking' },
      state: 'included',
      observedAt: '2026-08-23T12:00:00Z',
      evidence: [
        {
          evidenceId: 'fd-transaction-pending',
          kind: 'transaction',
          authorized: true,
          redaction: 'visible',
        },
      ],
    });
    expect(observation(fixture.full.observations, 'uncleared_activity')).toEqual({
      kind: 'uncleared_activity',
      scope: { kind: 'account', id: 'fd-account-checking' },
      state: 'included',
      observedAt: '2026-08-23T12:00:00Z',
      evidence: [
        {
          evidenceId: 'fd-transaction-pending',
          kind: 'transaction',
          authorized: true,
          redaction: 'visible',
        },
      ],
    });
    expect(observation(fixture.full.observations, 'schedule_coverage')).toEqual({
      kind: 'schedule_coverage',
      scope: { kind: 'schedule', id: 'fd-schedule-card-payment' },
      state: 'complete',
      observedAt: '2026-08-23T12:00:00Z',
      evidence: [
        {
          evidenceId: 'fd-schedule-card-payment',
          kind: 'schedule',
          authorized: true,
          redaction: 'visible',
        },
      ],
    });
    expect(observation(fixture.full.observations, 'credit_card_obligation_coverage')).toEqual({
      kind: 'credit_card_obligation_coverage',
      scope: { kind: 'account', id: 'fd-account-card' },
      state: 'complete',
      observedAt: '2026-08-23T12:00:00Z',
      evidence: [
        {
          evidenceId: 'fd-schedule-card-payment',
          kind: 'schedule',
          authorized: true,
          redaction: 'visible',
        },
        {
          evidenceId: 'fd-account-card',
          kind: 'account',
          authorized: true,
          redaction: 'visible',
        },
      ],
    });
  });

  it('makes duplicate, one-sided transfer, reconciliation, and currency ambiguity exact', () => {
    expect(fixture.ambiguities.observations).toEqual([
      {
        kind: 'duplicate_candidate',
        scope: { kind: 'transaction', id: 'fd-transaction-pending' },
        state: 'present',
        observedAt: '2026-08-23T12:00:00Z',
        evidence: [
          {
            evidenceId: 'fd-import-pending',
            kind: 'imported_transaction',
            authorized: true,
            redaction: 'visible',
          },
          {
            evidenceId: 'fd-transaction-existing',
            kind: 'duplicate_candidate',
            authorized: true,
            redaction: 'visible',
          },
        ],
      },
      {
        kind: 'transfer_ambiguity',
        scope: { kind: 'transaction', id: 'fd-transfer-one-sided' },
        state: 'ambiguous',
        observedAt: '2026-08-23T12:00:00Z',
        evidence: [
          {
            evidenceId: 'fd-transfer-counterpart-card',
            kind: 'transfer_candidate',
            authorized: false,
            redaction: 'redacted',
          },
        ],
      },
      {
        kind: 'reconciliation',
        scope: { kind: 'account', id: 'fd-account-checking' },
        state: 'unreconciled',
        observedAt: '2026-08-23T12:00:00Z',
        evidence: [
          {
            evidenceId: 'fd-transaction-pending',
            kind: 'transaction',
            authorized: true,
            redaction: 'visible',
          },
        ],
      },
      {
        kind: 'currency_compatibility',
        scope: { kind: 'account', id: 'fd-account-card' },
        state: 'incompatible',
        observedAt: '2026-08-23T12:00:00Z',
        evidence: [
          {
            evidenceId: 'fd-account-currency-USD',
            kind: 'account_currency',
            authorized: true,
            redaction: 'visible',
          },
          {
            evidenceId: 'fd-claim-currency-EUR',
            kind: 'claim_currency',
            authorized: true,
            redaction: 'visible',
          },
        ],
      },
    ]);
  });

  it('uses a complete fixed context and active, released, expired, and future claims', () => {
    expect(fixture.claims.context).toEqual({
      evaluatedAt: '2026-08-23T12:00:00Z',
      horizon: {
        startsAt: '2026-08-23T12:00:00Z',
        endsAt: '2026-09-22T12:00:00Z',
      },
      policy: {
        pendingMode: 'includeConservatively',
        uncategorizedMode: 'reserveFullAmount',
        unclearedMode: 'include',
        maxBankSyncAgeMinutes: null,
        maxBudgetSnapshotAgeMinutes: null,
        accountOverrides: { includeOnly: null, exclude: [] },
      },
      policyVersion: 'fd-policy-v1',
      policyHash: 'sha256:fd-policy-v1',
      snapshotId: 'fd-snapshot-2026-08-23',
      contentHash: 'sha256:fd-snapshot-2026-08-23',
    });
    expect(claim('fd-claim-active-reservation')).toMatchObject({
      kind: 'reservation',
      sourceId: 'fd-source-active-reservation',
      scope: { kind: 'category', id: 'fd-category-groceries' },
      amount: { minorUnits: '1000', currency: 'USD' },
      status: 'active',
      effectiveFrom: '2026-08-23T12:00:00Z',
      expiresAt: '2026-09-01T00:00:00Z',
    });
    expect(claim('fd-claim-active-commitment')).toMatchObject({
      kind: 'commitment',
      scope: { kind: 'schedule', id: 'fd-schedule-card-payment' },
      amount: { minorUnits: '2500', currency: 'USD' },
      status: 'active',
      effectiveFrom: '2026-08-01T00:00:00Z',
      expiresAt: null,
    });
    expect(claim('fd-claim-released-reservation')).toMatchObject({
      kind: 'reservation',
      amount: { minorUnits: '200', currency: 'USD' },
      status: 'released',
    });
    expect(claim('fd-claim-expired-commitment')).toMatchObject({
      kind: 'commitment',
      amount: { minorUnits: '300', currency: 'USD' },
      status: 'active',
      expiresAt: '2026-08-23T12:00:00Z',
    });
    expect(claim('fd-claim-future-reservation')).toMatchObject({
      kind: 'reservation',
      amount: { minorUnits: '400', currency: 'USD' },
      status: 'active',
      effectiveFrom: '2026-08-23T12:00:01Z',
    });
    expect(claim('fd-claim-redacted-reservation')).toMatchObject({
      kind: 'reservation',
      sourceId: 'fd-source-redacted-reservation',
      scope: { kind: 'category', id: 'fd-category-groceries' },
      amount: { minorUnits: '500', currency: 'USD' },
      visibility: 'redacted',
    });
  });

  it('binds claims to policy and snapshot identity and preserves unknown issue codes', () => {
    expect(claim('fd-claim-policy-mismatch')).toMatchObject({
      policyVersion: 'fd-policy-v0',
      snapshotId: 'fd-snapshot-2026-08-23',
    });
    expect(claim('fd-claim-snapshot-mismatch')).toMatchObject({
      policyVersion: 'fd-policy-v1',
      snapshotId: 'fd-snapshot-stale',
    });
    expect(fixture.claims.evaluation).toMatchObject({
      eligibleClaimIds: [
        'fd-claim-active-reservation',
        'fd-claim-active-commitment',
        'fd-claim-redacted-reservation',
      ],
      reservationTotal: { minorUnits: '1500', currency: 'USD' },
      commitmentTotal: { minorUnits: '2500', currency: 'USD' },
    });
    expect(fixture.claims.evaluation.issues.map(({ code }) => code)).toEqual([
      'policy_version_mismatch',
      'snapshot_mismatch',
      'reservation_conflict',
    ]);
    expect(
      fixture.claims.evaluation.issues.find(({ code }) => code === 'policy_version_mismatch'),
    ).toMatchObject({
      severity: 'critical',
      effect: 'blocks',
      scope: { kind: 'claim', id: 'fd-claim-policy-mismatch' },
      evidence: [
        {
          evidenceId: 'fd-source-policy-mismatch',
          kind: 'prospective_claim',
          authorized: true,
          redaction: 'visible',
        },
      ],
      redaction: 'visible',
    });
    expect(
      fixture.claims.evaluation.issues.find(({ code }) => code === 'reservation_conflict'),
    ).toMatchObject({
      severity: 'critical',
      effect: 'blocks',
      scope: { kind: 'category', id: 'fd-category-groceries' },
      evidence: [],
      redaction: 'redacted',
    });
  });

  it('provides exact ready, qualified, and fail-closed blocked decisions', () => {
    const expectations = [
      {
        decision: fixture.decisions.ready,
        id: 'fd-decision-ready',
        requestId: 'fd-request-ready',
        readiness: 'ready',
        expiresAt: '2026-08-23T12:15:00Z',
        before: '10000',
        after: '7500',
        allowable: true,
        reasonCodes: ['within_budget'],
      },
      {
        decision: fixture.decisions.qualified,
        id: 'fd-decision-qualified',
        requestId: 'fd-request-qualified',
        readiness: 'qualified',
        expiresAt: '2026-08-23T12:10:00Z',
        before: '7500',
        after: '5000',
        allowable: true,
        reasonCodes: ['within_budget', 'pending_availability'],
      },
      {
        decision: fixture.decisions.blocked,
        id: 'fd-decision-blocked',
        requestId: 'fd-request-blocked',
        readiness: 'blocked',
        expiresAt: '2026-08-23T12:05:00Z',
        before: '5000',
        after: '-500',
        allowable: false,
        reasonCodes: ['reservation_conflict', 'fd_future_reason_code'],
      },
    ] as const;

    for (const expected of expectations) {
      expect(expected.decision.metadata).toMatchObject({
        contractVersion: '1.0',
        decisionId: expected.id,
        decisionKind: 'purchase',
        requestId: expected.requestId,
        correlationId: 'fd-correlation-2026-08-23',
        context: {
          evaluatedAt: '2026-08-23T12:00:00Z',
          snapshotId: 'fd-snapshot-2026-08-23',
          contentHash: 'sha256:fd-snapshot-2026-08-23',
          policyVersion: 'fd-policy-v1',
          policyHash: 'sha256:fd-policy-v1',
        },
      });
      expect(expected.decision.readiness).toBe(expected.readiness);
      expect(expected.decision.expiresAt).toBe(expected.expiresAt);
      expect(expected.decision.before.amounts[0]).toEqual({
        label: 'envelopeAvailability',
        scope: { kind: 'category', id: 'fd-category-groceries' },
        amount: { minorUnits: expected.before, currency: 'USD' },
      });
      expect(expected.decision.after.amounts[0]).toEqual({
        label: 'envelopeAvailability',
        scope: { kind: 'category', id: 'fd-category-groceries' },
        amount: { minorUnits: expected.after, currency: 'USD' },
      });
      expect(expected.decision.payload.allowable).toBe(expected.allowable);
      expect(expected.decision.payload.reasonCodes).toEqual(expected.reasonCodes);
      expect(expected.decision.payload.categoryBudget.currency).toBe('USD');
      expect(expected.decision.payload.categorySpent.currency).toBe('USD');
      expect(expected.decision.payload.categoryRemaining.currency).toBe('USD');
    }

    expect(fixture.decisions.qualified.issues).toMatchObject([
      {
        code: 'pending_availability',
        severity: 'warning',
        effect: 'qualifies',
        scope: { kind: 'transaction', id: 'fd-transaction-pending' },
      },
    ]);
    expect(fixture.decisions.blocked.issues.map(({ code }) => code)).toEqual([
      'reservation_conflict',
      'fd_future_safety_code',
    ]);
    expect(fixture.decisions.blocked.issues[1]).toMatchObject({
      code: 'fd_future_safety_code',
      severity: 'critical',
      effect: 'qualifies',
      scope: { kind: 'global' },
    });
    expect(fixture.decisions.blocked.readiness).toBe('blocked');
  });

  it('contains no model or provider fields', () => {
    expect(sensitiveInferenceKeys(fixture)).toEqual([]);
  });
});
