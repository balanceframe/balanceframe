import type { CoverageState } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import {
  decisionContextSchema,
  decisionIssueCodeSchema,
  decisionIssueSchema,
  decisionScopeSchema,
  evidenceReferenceSchema,
  financialSemanticClassSchema,
  financialSnapshotSchema,
  moneySchema,
  prospectiveClaimEvaluationSchema,
  prospectiveClaimSchema,
  purchaseProspectiveDecisionEnvelopeSchema,
  redactionStateSchema,
  remediationSchema,
} from '@balanceframe/protocol-generated/validators';

const UTC_NOW = '2026-08-23T12:34:56Z';
const UTC_LATER = '2026-09-22T12:34:56Z';

const POLICY = {
  pendingMode: 'includeConservatively',
  uncategorizedMode: 'reserveFullAmount',
  unclearedMode: 'include',
  maxBankSyncAgeMinutes: null,
  maxBudgetSnapshotAgeMinutes: 60,
  accountOverrides: {
    includeOnly: null,
    exclude: ['account-closed'],
  },
};

const DECISION_CONTEXT = {
  evaluatedAt: UTC_NOW,
  horizon: {
    startsAt: UTC_NOW,
    endsAt: UTC_LATER,
  },
  policy: POLICY,
  policyVersion: 'policy-17',
  policyHash: 'sha256:effective-policy',
  snapshotId: 'snapshot-2026-08-23',
  contentHash: 'sha256:snapshot-content',
};

const VISIBLE_EVIDENCE = {
  evidenceId: 'bank-sync:checking:884',
  kind: 'bank_sync',
  authorized: true,
  redaction: 'visible',
};

const REDACTED_EVIDENCE = {
  evidenceId: 'claim:private-reservation',
  kind: 'prospective_claim',
  authorized: false,
  redaction: 'redacted',
};

const REMEDIATION = {
  code: 'refresh_source',
  action: 'Refresh the source account before relying on this conclusion',
};

const KNOWN_ISSUE_CODES = [
  'account_freshness_coverage',
  'pending_availability',
  'schedule_coverage',
  'duplicate_transfer_ambiguity',
  'credit_payment_uncertainty',
  'reservation_conflict',
  'wallet_balance_uncertainty',
  'receipt_total_mismatch',
  'economic_event_ambiguity',
  'currency_mismatch',
] as const;

const LEGACY_SNAPSHOT = {
  schemaVersion: '1.0',
  actualVersion: '2026.08.1',
  snapshotDate: UTC_NOW,
  accounts: [
    {
      id: 'account-checking',
      name: 'Checking',
      accountType: 'checking',
      offBudget: false,
      isClosed: false,
      clearedBalance: { minorUnits: '9223372036854775807', currency: 'USD' },
      importedBalance: { minorUnits: '-9223372036854775808', currency: 'USD' },
      mtid: 'source-account-checking',
    },
  ],
  transactions: [
    {
      id: 'transaction-pending',
      accountId: 'account-checking',
      date: '2024-02-29',
      payeeId: null,
      payeeName: 'Corner Shop',
      categoryId: 'category-groceries',
      categoryName: 'Groceries',
      amount: { minorUnits: '-1', currency: 'USD' },
      cleared: false,
      reconciled: false,
      importedId: 'import-pending',
      importedPayee: 'CORNER SHOP',
      notes: null,
      tags: ['pending'],
      transferAccountId: null,
      subtransactions: [],
    },
  ],
  categories: [
    {
      id: 'category-groceries',
      name: 'Groceries',
      groupName: 'Living',
      isIncome: false,
      mtid: null,
      deleted: false,
    },
  ],
  payees: [
    {
      id: 'payee-shop',
      name: 'Corner Shop',
      transferAccountId: null,
      mtid: null,
    },
  ],
  rules: [
    {
      id: 'rule-shop',
      name: 'Categorize shop',
      order: 1,
      trigger: { field: 'payee', op: 'is', value: 'Corner Shop' },
      actions: [{ op: 'set-category', value: 'category-groceries' }],
      inactive: false,
    },
  ],
  schedules: [
    {
      id: 'schedule-card-payment',
      frequency: 'monthly',
      amount: { minorUnits: '1', currency: 'USD' },
      payeeName: 'Credit Card Payment',
      accountId: 'account-checking',
      nextExpected: '2026-08-31',
    },
  ],
  budgets: [
    {
      id: 'budget-2026-08',
      month: '2026-08',
      categories: {},
    },
  ],
  tags: [{ id: 'tag-pending', name: 'pending' }],
};

const OBSERVATIONS = [
  {
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'account-checking' },
    state: 'fresh',
    observedAt: UTC_NOW,
    evidence: [VISIBLE_EVIDENCE],
  },
  {
    kind: 'pending_activity',
    scope: { kind: 'transaction', id: 'transaction-pending' },
    state: 'included',
    observedAt: UTC_NOW,
    evidence: [VISIBLE_EVIDENCE],
  },
  {
    kind: 'uncleared_activity',
    scope: { kind: 'account', id: 'account-checking' },
    state: 'stale',
    observedAt: '2026-08-20T09:00:00Z',
    evidence: [],
  },
  {
    kind: 'schedule_coverage',
    scope: { kind: 'schedule', id: 'schedule-card-payment' },
    state: 'complete',
    observedAt: UTC_NOW,
    evidence: [VISIBLE_EVIDENCE],
  },
  {
    kind: 'credit_card_obligation_coverage',
    scope: { kind: 'account', id: 'account-card' },
    state: 'unavailable',
    observedAt: null,
    evidence: [],
  },
  {
    kind: 'duplicate_candidate',
    scope: { kind: 'transaction', id: 'transaction-pending' },
    state: 'present',
    observedAt: UTC_NOW,
    evidence: [REDACTED_EVIDENCE],
  },
  {
    kind: 'transfer_ambiguity',
    scope: { kind: 'transaction', id: 'transaction-pending' },
    state: 'ambiguous',
    observedAt: UTC_NOW,
    evidence: [REDACTED_EVIDENCE],
  },
  {
    kind: 'reconciliation',
    scope: { kind: 'account', id: 'account-checking' },
    state: 'unreconciled',
    observedAt: UTC_NOW,
    evidence: [VISIBLE_EVIDENCE],
  },
  {
    kind: 'currency_compatibility',
    scope: { kind: 'claim', id: 'claim-eur' },
    state: 'incompatible',
    observedAt: UTC_NOW,
    evidence: [VISIBLE_EVIDENCE],
  },
] as const;

const FINANCIAL_SNAPSHOT = {
  contractVersion: '1.0',
  snapshotId: 'snapshot-2026-08-23',
  contentHash: 'sha256:snapshot-content',
  source: {
    ledgerBackend: 'actual',
    ledgerId: 'ledger-local-17',
    budgetId: 'budget-household',
    spaceId: 'space-family',
  },
  capturedAt: UTC_NOW,
  sourceNormalizationVersion: 'actual-normalizer/3.2.1',
  legacySnapshot: LEGACY_SNAPSHOT,
  coverage: {
    accounts: 'complete',
    transactions: 'complete',
    categories: 'empty',
    payees: 'empty',
    rules: 'empty',
    schedules: 'complete',
    budgets: 'empty',
    tags: 'empty',
  },
  inclusionScope: {
    pendingActivity: 'included',
    unclearedActivity: 'excluded',
  },
  observations: OBSERVATIONS,
};

const STRUCTURED_ISSUE = {
  code: 'reservation_conflict',
  severity: 'critical',
  effect: 'blocks',
  scope: { kind: 'category', id: 'category-groceries' },
  evidence: [VISIBLE_EVIDENCE, REDACTED_EVIDENCE],
  remediation: REMEDIATION,
  redaction: 'redacted',
};

const ACTIVE_RESERVATION = {
  claimId: 'reservation-max',
  kind: 'reservation',
  sourceId: 'source-reservation-max',
  scope: { kind: 'account', id: 'account-checking' },
  amount: { minorUnits: '9223372036854775807', currency: 'USD' },
  status: 'active',
  effectiveFrom: UTC_NOW,
  expiresAt: UTC_LATER,
  visibility: 'visible',
  policyVersion: 'policy-17',
  snapshotId: 'snapshot-2026-08-23',
};

describe('financial decision vocabulary', () => {
  it('accepts every semantic financial class, including all Phase 8.8 additions', () => {
    const labels = [
      'ledgerFact',
      'envelopeAvailability',
      'cashFlowProjection',
      'advice',
      'proposal',
      'executionResult',
      'purchaseOutcome',
      'accountLiquidity',
      'reservation',
      'commitment',
      'sourceObservation',
      'normalizedEvidence',
      'economicEventResolution',
      'redactedConclusion',
    ];

    expect(labels.map((label) => financialSemanticClassSchema.parse(label))).toEqual(labels);
  });

  it('accepts all known issue codes and preserves an unknown future code', () => {
    expect(KNOWN_ISSUE_CODES.map((code) => decisionIssueCodeSchema.parse(code))).toEqual(
      KNOWN_ISSUE_CODES,
    );

    const unknown = 'future_safety_sensitive_issue';
    expect(decisionIssueCodeSchema.parse(unknown)).toBe(unknown);
  });

  it('preserves all decision scopes exactly', () => {
    const scopes = [
      { kind: 'global' },
      { kind: 'account', id: 'account-1' },
      { kind: 'category', id: 'category-1' },
      { kind: 'transaction', id: 'transaction-1' },
      { kind: 'schedule', id: 'schedule-1' },
      { kind: 'claim', id: 'claim-1' },
    ];

    expect(scopes.map((scope) => decisionScopeSchema.parse(scope))).toEqual(scopes);
  });

  it('preserves structured evidence, remediation, issues, and redaction', () => {
    expect(evidenceReferenceSchema.parse(REDACTED_EVIDENCE)).toEqual(REDACTED_EVIDENCE);
    expect(remediationSchema.parse(REMEDIATION)).toEqual(REMEDIATION);
    expect(redactionStateSchema.parse('visible')).toBe('visible');
    expect(redactionStateSchema.parse('redacted')).toBe('redacted');
    expect(decisionIssueSchema.parse(STRUCTURED_ISSUE)).toEqual(STRUCTURED_ISSUE);
  });

  it('retains unknown issue codes and redacted state without reinterpretation', () => {
    const issue = {
      code: 'provider_specific_integrity_failure',
      severity: 'warning',
      effect: 'qualifies',
      scope: { kind: 'global' },
      evidence: [REDACTED_EVIDENCE],
      redaction: 'redacted',
    };

    const parsed = decisionIssueSchema.parse(issue);
    expect(parsed).toEqual(issue);
    expect(parsed.code).toBe('provider_specific_integrity_failure');
    expect(parsed.redaction).toBe('redacted');
    expect(parsed.evidence[0]?.redaction).toBe('redacted');
  });
});

describe('money and canonical time boundaries', () => {
  it.each([
    ['0', 'USD'],
    ['1', 'EUR'],
    ['-1', 'GBP'],
    ['9223372036854775807', 'USD'],
    ['-9223372036854775808', 'USD'],
  ])('accepts signed i64 minor units %s', (minorUnits, currency) => {
    expect(moneySchema.parse({ minorUnits, currency })).toEqual({ minorUnits, currency });
  });

  it.each([
    { minorUnits: '9223372036854775808', currency: 'USD' },
    { minorUnits: '-9223372036854775809', currency: 'USD' },
    { minorUnits: '+1', currency: 'USD' },
    { minorUnits: '1.0', currency: 'USD' },
    { minorUnits: '', currency: 'USD' },
    { minorUnits: 1, currency: 'USD' },
  ])('rejects non-canonical or out-of-range minor units $minorUnits', (money) => {
    expect(moneySchema.safeParse(money).success).toBe(false);
  });

  it('accepts leap-day dates and fixed UTC timestamps', () => {
    expect(financialSnapshotSchema.safeParse(FINANCIAL_SNAPSHOT).success).toBe(true);
    expect(prospectiveClaimSchema.safeParse(ACTIVE_RESERVATION).success).toBe(true);
  });

  it.each([
    '2026-08-23T13:34:56+01:00',
    '2026-08-23T12:34:56.000+00:00',
    '2026-08-23 12:34:56Z',
    '2026-08-23T12:34:56',
    '2026-02-29T12:34:56Z',
  ])('rejects a non-canonical UTC timestamp %s', (capturedAt) => {
    expect(financialSnapshotSchema.safeParse({ ...FINANCIAL_SNAPSHOT, capturedAt }).success).toBe(
      false,
    );
  });

  it.each(['2023-02-29', '2026-00-01', '2026-01-00', '2026-13-01', '2026-01-32'])(
    'rejects an invalid canonical date %s',
    (date) => {
      const transactions = [
        {
          ...LEGACY_SNAPSHOT.transactions[0],
          date,
        },
      ];
      const snapshot = {
        ...FINANCIAL_SNAPSHOT,
        legacySnapshot: { ...LEGACY_SNAPSHOT, transactions },
      };
      expect(financialSnapshotSchema.safeParse(snapshot).success).toBe(false);
    },
  );
});

describe('financialSnapshotSchema', () => {
  it('accepts the full canonical snapshot and preserves every observation kind and state', () => {
    const parsed = financialSnapshotSchema.parse(FINANCIAL_SNAPSHOT);
    expect(parsed).toEqual(FINANCIAL_SNAPSHOT);
    expect(parsed.observations.map(({ kind }) => kind)).toEqual(
      OBSERVATIONS.map(({ kind }) => kind),
    );
    expect(parsed.observations.map(({ state }) => state)).toEqual(
      OBSERVATIONS.map(({ state }) => state),
    );
    expect(parsed.observations[5]?.evidence[0]?.redaction).toBe('redacted');
  });

  it('accepts the legacy v1 snapshot shape without new optional source metadata', () => {
    const parsed = financialSnapshotSchema.parse(FINANCIAL_SNAPSHOT);
    expect(parsed.legacySnapshot).toEqual(LEGACY_SNAPSHOT);
    expect(parsed.legacySnapshot.schemaVersion).toBe('1.0');
    expect(parsed.legacySnapshot).not.toHaveProperty('actualDownloadedAt');
    expect(parsed.legacySnapshot).not.toHaveProperty('encrypted');
    expect(parsed.legacySnapshot).not.toHaveProperty('bankSyncedAt');
  });

  it('defaults omitted coverage and inclusion treatments to unknown, not empty or excluded', () => {
    const parsed = financialSnapshotSchema.parse({
      ...FINANCIAL_SNAPSHOT,
      coverage: {},
      inclusionScope: {},
    });

    expect(parsed.coverage).toEqual({
      accounts: 'unknown',
      transactions: 'unknown',
      categories: 'unknown',
      payees: 'unknown',
      rules: 'unknown',
      schedules: 'unknown',
      budgets: 'unknown',
      tags: 'unknown',
    });
    expect(parsed.inclusionScope).toEqual({
      pendingActivity: 'unknown',
      unclearedActivity: 'unknown',
    });
  });

  it('accepts explicit unavailable coverage in the generated type and Zod contract', () => {
    const unavailableCoverage = {
      accounts: 'unavailable',
      transactions: 'unavailable',
      categories: 'unavailable',
      payees: 'unavailable',
      rules: 'unavailable',
      schedules: 'unavailable',
      budgets: 'unavailable',
      tags: 'unavailable',
    } satisfies Record<keyof typeof FINANCIAL_SNAPSHOT.coverage, CoverageState>;
    const snapshot = {
      ...FINANCIAL_SNAPSHOT,
      coverage: unavailableCoverage,
    };

    expect(financialSnapshotSchema.parse(snapshot).coverage).toEqual(unavailableCoverage);
  });
});

describe('prospective claims and decision context', () => {
  it('accepts reservation and commitment claims across active and released states', () => {
    const commitment = {
      ...ACTIVE_RESERVATION,
      claimId: 'commitment-min',
      kind: 'commitment',
      sourceId: 'source-commitment-min',
      scope: { kind: 'schedule', id: 'schedule-card-payment' },
      amount: { minorUnits: '-9223372036854775808', currency: 'USD' },
      status: 'released',
      effectiveFrom: '2024-02-29T00:00:00Z',
      expiresAt: null,
      visibility: 'redacted',
    };

    expect(prospectiveClaimSchema.parse(ACTIVE_RESERVATION)).toEqual(ACTIVE_RESERVATION);
    expect(prospectiveClaimSchema.parse(commitment)).toEqual(commitment);
  });

  it('rejects invalid claim money and non-UTC claim boundaries', () => {
    expect(
      prospectiveClaimSchema.safeParse({
        ...ACTIVE_RESERVATION,
        amount: { minorUnits: '9223372036854775808', currency: 'USD' },
      }).success,
    ).toBe(false);
    expect(
      prospectiveClaimSchema.safeParse({
        ...ACTIVE_RESERVATION,
        effectiveFrom: '2026-08-23T12:34:56-04:00',
      }).success,
    ).toBe(false);
  });

  it('requires and preserves the complete fixed decision context', () => {
    expect(decisionContextSchema.parse(DECISION_CONTEXT)).toEqual(DECISION_CONTEXT);
    const { policy: _policy, ...withoutPolicy } = DECISION_CONTEXT;
    expect(decisionContextSchema.safeParse(withoutPolicy).success).toBe(false);
  });

  it.each([
    {
      evaluatedAt: '2026-08-23T12:34:56.412Z',
      startsAt: '2026-08-23T12:34:56.412Z',
      endsAt: '2026-09-22T12:34:56.412Z',
    },
    {
      evaluatedAt: '2026-08-23T12:34:56.123456789Z',
      startsAt: '2026-08-23T12:34:56.123456789Z',
      endsAt: '2026-09-22T12:34:56.123456789Z',
    },
  ])('accepts fractional UTC seconds throughout the decision context', (timestamps) => {
    const context = {
      ...DECISION_CONTEXT,
      evaluatedAt: timestamps.evaluatedAt,
      horizon: {
        startsAt: timestamps.startsAt,
        endsAt: timestamps.endsAt,
      },
    };

    expect(decisionContextSchema.parse(context)).toEqual(context);
  });

  it('rejects an invalid or non-UTC decision horizon', () => {
    expect(
      decisionContextSchema.safeParse({
        ...DECISION_CONTEXT,
        evaluatedAt: '2026-08-23T12:34:56+00:00',
      }).success,
    ).toBe(false);
    expect(
      decisionContextSchema.safeParse({
        ...DECISION_CONTEXT,
        horizon: { ...DECISION_CONTEXT.horizon, endsAt: '2026-02-29T00:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('preserves deterministic claim evaluation totals, nullable totals, and unknown issues', () => {
    const unknownIssue = {
      code: 'duplicate_claim_id',
      severity: 'critical',
      effect: 'blocks',
      scope: { kind: 'claim', id: 'reservation-max' },
      evidence: [REDACTED_EVIDENCE],
      remediation: null,
      redaction: 'redacted',
    };
    const evaluation = {
      eligibleClaimIds: ['reservation-max'],
      reservationTotal: { minorUnits: '9223372036854775807', currency: 'USD' },
      commitmentTotal: null,
      issues: [unknownIssue],
    };

    const parsed = prospectiveClaimEvaluationSchema.parse(evaluation);
    expect(parsed).toEqual(evaluation);
    expect(parsed.issues[0]?.code).toBe('duplicate_claim_id');
    expect(parsed.issues[0]?.redaction).toBe('redacted');
  });
});

describe('purchaseProspectiveDecisionEnvelopeSchema', () => {
  it('accepts a typed purchase envelope without changing the legacy PurchaseEvaluation payload', () => {
    const semanticState = (minorUnits: string) => ({
      amounts: [
        {
          label: 'envelopeAvailability',
          scope: { kind: 'category', id: 'category-groceries' },
          amount: { minorUnits, currency: 'USD' },
        },
      ],
    });
    const purchaseEvaluation = {
      allowable: false,
      reasonCodes: ['reservation_conflict'],
      categoryBudget: { minorUnits: '5000', currency: 'USD' },
      categorySpent: { minorUnits: '2000', currency: 'USD' },
      categoryRemaining: { minorUnits: '-500', currency: 'USD' },
      projectedBalance: { minorUnits: '1', currency: 'USD' },
    };
    const envelope = {
      metadata: {
        contractVersion: '1.0',
        decisionId: 'decision-purchase-1',
        decisionKind: 'purchase',
        requestId: 'request-purchase-1',
        correlationId: 'correlation-1',
        context: DECISION_CONTEXT,
      },
      readiness: 'blocked',
      before: semanticState('2500'),
      after: semanticState('-500'),
      issues: [STRUCTURED_ISSUE],
      evidence: [VISIBLE_EVIDENCE],
      alternatives: [
        {
          alternativeId: 'alternative-wait',
          summary: 'Wait until the next funding date',
          resultingState: semanticState('2500'),
        },
      ],
      expiresAt: '2026-08-23T12:49:56Z',
      redaction: 'redacted',
      payload: purchaseEvaluation,
    };

    const parsed = purchaseProspectiveDecisionEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
    expect(parsed.payload).toEqual(purchaseEvaluation);
    expect(parsed.redaction).toBe('redacted');
    expect(parsed.issues[0]?.evidence[1]?.redaction).toBe('redacted');

    for (const expiresAt of ['2026-08-23T12:49:56.412Z', '2026-08-23T12:49:56.123456789Z']) {
      expect(
        purchaseProspectiveDecisionEnvelopeSchema.parse({ ...envelope, expiresAt }).expiresAt,
      ).toBe(expiresAt);
    }
  });

  it('rejects an untyped transport-style or malformed purchase payload', () => {
    const base = {
      metadata: {
        contractVersion: '1.0',
        decisionId: 'decision-purchase-1',
        decisionKind: 'purchase',
        requestId: 'request-purchase-1',
        correlationId: 'correlation-1',
        context: DECISION_CONTEXT,
      },
      readiness: 'ready',
      before: { amounts: [] },
      after: { amounts: [] },
      issues: [],
      evidence: [],
      alternatives: [],
      expiresAt: UTC_LATER,
      redaction: 'visible',
    };

    expect(
      purchaseProspectiveDecisionEnvelopeSchema.safeParse({
        ...base,
        payload: { allowable: true, reasonCodes: [] },
      }).success,
    ).toBe(false);
    expect(
      purchaseProspectiveDecisionEnvelopeSchema.safeParse({
        schemaVersion: '1',
        result: { ...base, payload: {} },
      }).success,
    ).toBe(false);
  });
});
