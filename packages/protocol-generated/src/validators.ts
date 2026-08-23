import { z } from 'zod';

const SIGNED_I64_MIN = BigInt('-9223372036854775808');
const SIGNED_I64_MAX = BigInt('9223372036854775807');
const signedI64Pattern = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;
const signedI64StringSchema = z
  .string()
  .regex(signedI64Pattern)
  .refine((value) => {
    if (!signedI64Pattern.test(value)) {
      return false;
    }
    const parsed = BigInt(value);
    return parsed >= SIGNED_I64_MIN && parsed <= SIGNED_I64_MAX;
  });

const canonicalDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const canonicalUtcTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!;
}

function isCanonicalDate(value: string): boolean {
  const match = canonicalDatePattern.exec(value);
  return (
    match !== null && isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  );
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const match = canonicalUtcTimestampPattern.exec(value);
  return (
    match !== null &&
    isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59
  );
}

const canonicalDateSchema = z.string().refine(isCanonicalDate);
const canonicalUtcTimestampSchema = z.string().refine(isCanonicalUtcTimestamp);

export const moneySchema = z.object({
  minorUnits: signedI64StringSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const accountTypeSchema = z.enum([
  'checking',
  'savings',
  'creditCard',
  'cash',
  'investment',
  'mortgage',
  'loan',
  'other',
]);

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountType: accountTypeSchema,
  offBudget: z.boolean(),
  isClosed: z.boolean(),
  clearedBalance: moneySchema,
  importedBalance: moneySchema,
  mtid: z.string().nullable(),
});

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  groupName: z.string().nullable(),
  isIncome: z.boolean(),
  mtid: z.string().nullable(),
  deleted: z.boolean(),
});

export const payeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  transferAccountId: z.string().nullable(),
  mtid: z.string().nullable(),
});

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().nonnegative(),
  trigger: z.unknown(),
  actions: z.unknown(),
  inactive: z.boolean(),
});

export const scheduleSchema = z.object({
  id: z.string(),
  frequency: z.string(),
  amount: moneySchema,
  payeeName: z.string().nullable(),
  accountId: z.string(),
  nextExpected: z.string(),
});

export const budgetCategorySchema = z.object({
  categoryId: z.string(),
  amount: moneySchema,
  carryover: moneySchema,
  carryoverFromPrevious: moneySchema,
  carriesOver: z.boolean(),
});

export const budgetMonthSchema = z.object({
  id: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  categories: z.record(budgetCategorySchema),
});

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// ---------------------------------------------------------------------------
// Suggestion / Provenance — inference output from Rust (camelCase)
// ---------------------------------------------------------------------------

export const provenanceSchema = z
  .object({
    payloadHash: z.string(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
    inferencePolicyVersion: z.string().nullable().optional(),
    createdAt: z.string(),
    actorId: z.string().nullable().optional(),
  })
  .strict();

export const historyRecordSchema = z
  .object({
    transactionId: z.string(),
    payeeName: z.string(),
    categoryId: z.string(),
    categoryName: z.string(),
    amount: moneySchema,
    date: z.string(),
  })
  .strict();

export const suggestionSchema = z
  .object({
    transactionId: z.string(),
    proposedCategoryId: z.string(),
    categoryName: z.string(),
    confidence: z.number(),
    reasonCodes: z.array(z.string()),
    evidence: z.array(z.string()),
    spaceId: z.string().nullable().optional(),
    connectionId: z.string().nullable().optional(),
    budgetId: z.string().nullable().optional(),
    transactionVersion: z.string().nullable().optional(),
    rawMerchant: z.string().nullable().optional(),
    normalizedMerchant: z.string().nullable().optional(),
    researchSummary: z.string().nullable().optional(),
    alternativeCategoryIds: z.array(z.string()).optional(),
    rationale: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
    inferencePolicyVersion: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    actorId: z.string().nullable().optional(),
    payloadHash: z.string().nullable().optional(),
    provenance: provenanceSchema.nullable().optional(),
    history: z.array(historyRecordSchema).optional(),
    id: z.string().optional(),
    alternatives: z
      .array(
        z
          .object({
            categoryId: z.string(),
            reason: z.string(),
          })
          .strict(),
      )
      .optional(),
    errors: z.array(z.string()).optional(),
    deterministicEvidence: z.record(z.unknown()).optional(),
  })
  .strict();
export const canonicalTransactionSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    id: z.string(),
    accountId: z.string(),
    date: z.string(),
    payeeId: z.string().nullable(),
    payeeName: z.string().nullable(),
    categoryId: z.string().nullable(),
    categoryName: z.string().nullable(),
    amount: moneySchema,
    cleared: z.boolean(),
    reconciled: z.boolean(),
    importedId: z.string().nullable(),
    importedPayee: z.string().nullable(),
    notes: z.string().nullable(),
    tags: z.string().array(),
    transferAccountId: z.string().nullable(),
    subtransactions: z.array(canonicalTransactionSchema),
  }),
);

export const canonicalProtocolSnapshotSchema = z.object({
  schemaVersion: z.literal('1'),
  actualVersion: z.string(),
  snapshotDate: z.string(),
  accounts: accountSchema.array(),
  transactions: z.array(canonicalTransactionSchema),
  categories: categorySchema.array(),
  payees: payeeSchema.array(),
  rules: ruleSchema.array(),
  schedules: scheduleSchema.array(),
  budgets: budgetMonthSchema.array(),
  tags: tagSchema.array(),
});

export type Money = z.infer<typeof moneySchema>;
export type Account = z.infer<typeof accountSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Payee = z.infer<typeof payeeSchema>;
export type Transaction = z.infer<typeof canonicalTransactionSchema>;
export type ProtocolSnapshot = z.infer<typeof canonicalProtocolSnapshotSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type BudgetCategory = z.infer<typeof budgetCategorySchema>;
export type BudgetMonth = z.infer<typeof budgetMonthSchema>;
export type Tag = z.infer<typeof tagSchema>;

export type Provenance = z.infer<typeof provenanceSchema>;
export type HistoryRecord = z.infer<typeof historyRecordSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;

// ---------------------------------------------------------------------------
// Phase 8 — Budget Intelligence Zod schemas (camelCase, decimal-string Money)
// ---------------------------------------------------------------------------

export const purchaseEvaluationSchema = z
  .object({
    allowable: z.boolean(),
    reasonCodes: z.array(z.string()),
    categoryBudget: moneySchema,
    categorySpent: moneySchema,
    categoryRemaining: moneySchema,
    projectedBalance: moneySchema.nullable(),
  })
  .strict();

export const monthlyProjectionSchema = z
  .object({
    month: z.string(),
    projectedIncome: moneySchema,
    projectedExpenses: moneySchema,
    netChange: moneySchema,
    endingBalance: moneySchema,
  })
  .strict();

export const cashFlowProjectionResponseSchema = z
  .object({
    projectionMonths: z.number().int(),
    monthlyProjections: z.array(monthlyProjectionSchema),
  })
  .strict();

const healthLabelSchema = z.enum(['healthy', 'overspent', 'underfunded', 'at_risk']);

export const categoryHealthSchema = z
  .object({
    categoryId: z.string(),
    categoryName: z.string(),
    budgeted: moneySchema,
    spent: moneySchema,
    remaining: moneySchema,
    healthLabel: healthLabelSchema,
  })
  .strict();

export const targetHealthResultSchema = z
  .object({
    categoryHealth: z.array(categoryHealthSchema),
    overallLabel: z.string(),
  })
  .strict();

export const financialStateLabelSchema = z
  .object({
    label: z.enum(['healthy', 'stable', 'at_risk', 'critical']),
    score: z.number(),
    reasonCodes: z.array(z.string()),
  })
  .strict();

export type PurchaseEvaluation = z.infer<typeof purchaseEvaluationSchema>;
export type MonthlyProjection = z.infer<typeof monthlyProjectionSchema>;
export type CashFlowProjectionResponse = z.infer<typeof cashFlowProjectionResponseSchema>;
export type CategoryHealth = z.infer<typeof categoryHealthSchema>;
export type TargetHealthResult = z.infer<typeof targetHealthResultSchema>;
export type FinancialStateLabel = z.infer<typeof financialStateLabelSchema>;

// ---------------------------------------------------------------------------
// Phase 8.8 — Canonical financial decisions and snapshots
// ---------------------------------------------------------------------------

export const financialSemanticClassSchema = z.enum([
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
]);

// Unknown issue codes are deliberately retained for forward compatibility.
export const decisionIssueCodeSchema = z.string();
export const decisionIssueSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const decisionIssueEffectSchema = z.enum(['qualifies', 'blocks']);

export const decisionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('account'), id: z.string() }).strict(),
  z.object({ kind: z.literal('category'), id: z.string() }).strict(),
  z.object({ kind: z.literal('transaction'), id: z.string() }).strict(),
  z.object({ kind: z.literal('schedule'), id: z.string() }).strict(),
  z.object({ kind: z.literal('claim'), id: z.string() }).strict(),
]);

export const redactionStateSchema = z.enum(['visible', 'redacted']);

export const evidenceReferenceSchema = z
  .object({
    evidenceId: z.string(),
    kind: z.string(),
    authorized: z.boolean(),
    redaction: redactionStateSchema,
  })
  .strict();

export const remediationSchema = z
  .object({
    code: z.string(),
    action: z.string(),
  })
  .strict();

export const decisionIssueSchema = z
  .object({
    code: decisionIssueCodeSchema,
    severity: decisionIssueSeveritySchema,
    effect: decisionIssueEffectSchema,
    scope: decisionScopeSchema,
    evidence: z.array(evidenceReferenceSchema),
    remediation: remediationSchema.nullable().optional(),
    redaction: redactionStateSchema,
  })
  .strict();

export const snapshotSourceSchema = z
  .object({
    ledgerBackend: z.string(),
    ledgerId: z.string(),
    budgetId: z.string(),
    spaceId: z.string().nullable(),
  })
  .strict();

export const coverageStateSchema = z.enum([
  'complete',
  'empty',
  'partial',
  'unknown',
  'unavailable',
]);

export const snapshotCoverageSchema = z
  .object({
    accounts: coverageStateSchema.default('unknown'),
    transactions: coverageStateSchema.default('unknown'),
    categories: coverageStateSchema.default('unknown'),
    payees: coverageStateSchema.default('unknown'),
    rules: coverageStateSchema.default('unknown'),
    schedules: coverageStateSchema.default('unknown'),
    budgets: coverageStateSchema.default('unknown'),
    tags: coverageStateSchema.default('unknown'),
  })
  .strict();

export const pendingActivityTreatmentSchema = z.enum(['included', 'excluded', 'unknown']);
export const unclearedActivityTreatmentSchema = z.enum(['included', 'excluded', 'unknown']);

export const inclusionScopeSchema = z
  .object({
    pendingActivity: pendingActivityTreatmentSchema.default('unknown'),
    unclearedActivity: unclearedActivityTreatmentSchema.default('unknown'),
  })
  .strict();

export const observationKindSchema = z.enum([
  'account_freshness',
  'account_coverage',
  'account_type',
  'account_balance',
  'pending_activity',
  'uncleared_activity',
  'schedule_coverage',
  'credit_card_obligation_coverage',
  'duplicate_candidate',
  'transfer_ambiguity',
  'reconciliation',
  'currency_compatibility',
]);

export const observationStateSchema = z.enum([
  'fresh',
  'stale',
  'unavailable',
  'unknown',
  'included',
  'complete',
  'present',
  'ambiguous',
  'unreconciled',
  'incompatible',
]);

export const sourceObservationSchema = z
  .object({
    kind: observationKindSchema,
    scope: decisionScopeSchema,
    state: observationStateSchema,
    observedAt: canonicalUtcTimestampSchema.nullable(),
    evidence: z.array(evidenceReferenceSchema),
  })
  .strict();

const financialSnapshotTransactionSchema = canonicalTransactionSchema.superRefine(
  (transaction, context) => {
    const inspectTransaction = (
      candidate: {
        date: string;
        subtransactions: Array<{ date: string; subtransactions: unknown[] }>;
      },
      path: Array<string | number>,
    ): void => {
      if (!isCanonicalDate(candidate.date)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid canonical calendar date',
          path: [...path, 'date'],
        });
      }
      candidate.subtransactions.forEach((subtransaction, index) => {
        inspectTransaction(
          subtransaction as {
            date: string;
            subtransactions: Array<{ date: string; subtransactions: unknown[] }>;
          },
          [...path, 'subtransactions', index],
        );
      });
    };

    inspectTransaction(transaction, []);
  },
);

const financialSnapshotLegacyProtocolSchema = z
  .object({
    schemaVersion: z.string(),
    actualVersion: z.string(),
    snapshotDate: z.string(),
    accounts: z.array(accountSchema),
    transactions: z.array(financialSnapshotTransactionSchema),
    categories: z.array(categorySchema),
    payees: z.array(payeeSchema),
    rules: z.array(ruleSchema),
    schedules: z.array(scheduleSchema.extend({ nextExpected: canonicalDateSchema })),
    budgets: z.array(budgetMonthSchema),
    tags: z.array(tagSchema),
    actualDownloadedAt: canonicalUtcTimestampSchema.nullable().optional(),
    encrypted: z.boolean().nullable().optional(),
    bankSyncedAt: canonicalUtcTimestampSchema.nullable().optional(),
    unlocked: z.boolean().nullable().optional(),
  })
  .strict();

export const financialSnapshotSchema = z
  .object({
    contractVersion: z.string(),
    snapshotId: z.string(),
    contentHash: z.string(),
    source: snapshotSourceSchema,
    capturedAt: canonicalUtcTimestampSchema,
    sourceNormalizationVersion: z.string(),
    legacySnapshot: financialSnapshotLegacyProtocolSchema,
    coverage: snapshotCoverageSchema,
    inclusionScope: inclusionScopeSchema,
    observations: z.array(sourceObservationSchema),
  })
  .strict();

export const pendingModeSchema = z.enum(['include', 'exclude', 'includeConservatively']);
export const uncategorizedModeSchema = z.enum(['block', 'reserveFullAmount', 'ignore']);
export const unclearedModeSchema = z.enum(['include', 'exclude']);

export const accountOverridesSchema = z
  .object({
    includeOnly: z.array(z.string()).nullable(),
    exclude: z.array(z.string()),
  })
  .strict();

export const decisionDataPolicySchema = z
  .object({
    pendingMode: pendingModeSchema,
    uncategorizedMode: uncategorizedModeSchema,
    unclearedMode: unclearedModeSchema,
    maxBankSyncAgeMinutes: z.number().int().nonnegative().nullable(),
    maxBudgetSnapshotAgeMinutes: z.number().int().nonnegative().nullable(),
    accountOverrides: accountOverridesSchema,
  })
  .strict();

export const decisionHorizonSchema = z
  .object({
    startsAt: canonicalUtcTimestampSchema,
    endsAt: canonicalUtcTimestampSchema,
  })
  .strict();

export const decisionContextSchema = z
  .object({
    evaluatedAt: canonicalUtcTimestampSchema,
    horizon: decisionHorizonSchema,
    policy: decisionDataPolicySchema,
    policyVersion: z.string(),
    policyHash: z.string(),
    snapshotId: z.string(),
    contentHash: z.string(),
  })
  .strict();

export const prospectiveClaimKindSchema = z.enum(['reservation', 'commitment']);
export const prospectiveClaimStatusSchema = z.enum(['active', 'released']);

export const prospectiveClaimSchema = z
  .object({
    claimId: z.string(),
    kind: prospectiveClaimKindSchema,
    sourceId: z.string(),
    scope: decisionScopeSchema,
    amount: moneySchema,
    status: prospectiveClaimStatusSchema,
    effectiveFrom: canonicalUtcTimestampSchema,
    expiresAt: canonicalUtcTimestampSchema.nullable(),
    visibility: redactionStateSchema,
    policyVersion: z.string(),
    snapshotId: z.string(),
  })
  .strict();

export const prospectiveClaimEvaluationSchema = z
  .object({
    eligibleClaimIds: z.array(z.string()),
    reservationTotal: moneySchema.nullable(),
    commitmentTotal: moneySchema.nullable(),
    issues: z.array(decisionIssueSchema),
  })
  .strict();

export const decisionReadinessSchema = z.enum(['ready', 'qualified', 'blocked']);

export const decisionAmountSchema = z
  .object({
    label: financialSemanticClassSchema,
    scope: decisionScopeSchema,
    amount: moneySchema,
  })
  .strict();

export const decisionSemanticStateSchema = z
  .object({
    amounts: z.array(decisionAmountSchema),
  })
  .strict();

export const decisionAlternativeSchema = z
  .object({
    alternativeId: z.string(),
    summary: z.string(),
    resultingState: decisionSemanticStateSchema,
  })
  .strict();

export const prospectiveDecisionMetadataSchema = z
  .object({
    contractVersion: z.string(),
    decisionId: z.string(),
    decisionKind: z.string(),
    requestId: z.string(),
    correlationId: z.string(),
    context: decisionContextSchema,
  })
  .strict();

const purchaseDecisionMetadataSchema = prospectiveDecisionMetadataSchema.extend({
  decisionKind: z.literal('purchase'),
});

export const purchaseProspectiveDecisionEnvelopeSchema = z
  .object({
    metadata: purchaseDecisionMetadataSchema,
    readiness: decisionReadinessSchema,
    before: decisionSemanticStateSchema,
    after: decisionSemanticStateSchema,
    issues: z.array(decisionIssueSchema),
    evidence: z.array(evidenceReferenceSchema),
    alternatives: z.array(decisionAlternativeSchema),
    expiresAt: canonicalUtcTimestampSchema,
    redaction: redactionStateSchema,
    payload: purchaseEvaluationSchema,
  })
  .strict();
