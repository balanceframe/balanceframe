import { z } from 'zod';
import { decisionExplanationFactsSchema } from '@balanceframe/inference';
import type { DecisionExplanationProvider } from '@balanceframe/inference';
import { decisionCardSchema, moneySchema } from '@balanceframe/protocol-generated/validators';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import type { PublicDecisionCard } from './liquidity-public.js';

/** Trusted composition dependencies; clients never select provider or policy. */
export interface DecisionCardExplanationRuntime {
  provider?: DecisionExplanationProvider;
  policy: () => unknown;
  authorize?: () => Promise<void>;
  admit?: () => boolean;
}
const factSchema = decisionExplanationFactsSchema.element
  .extend({
    resourceId: z.string().min(1).max(256).optional(),
    amount: moneySchema.optional(),
  })
  .strict();
/** Only server-rendered canonical facts and non-authoritative provider provenance are public. */
export const decisionCardExplanationViewSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('explained'),
      facts: z.array(factSchema).min(1).max(8),
      provenance: z
        .object({
          provider: z.string().min(1).max(128),
          model: z.string().min(1).max(128),
          promptVersion: z.literal('decision-card-explanation-v1'),
          policyRevision: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal('manual'),
      code: z.enum([
        'disabled',
        'unavailable',
        'invalid_response',
        'refused',
        'changed',
        'timeout',
        'rate_limited',
      ]),
    })
    .strict(),
]);
export type DecisionCardExplanationView = z.infer<typeof decisionCardExplanationViewSchema>;
/** Mandatory deterministic context is never selected or omitted by the provider. */
export const decisionCardExplanationSummarySchema = z.object({
  outcome: decisionCardSchema.shape.outcome,
  budgetFundingStatus: decisionCardSchema.shape.budgetFundingStatus,
  paymentLiquidityStatus: decisionCardSchema.shape.paymentLiquidityStatus,
  blockers: decisionCardSchema.shape.blockers,
});

/** Ignore only Actual's generated read clocks; retain authority, expiry and provenance metadata. */
export function decisionCardExplanationSource(snapshot: FinancialSnapshot): unknown {
  const sameCapture = (value: unknown) => typeof value === 'string' &&
    Date.parse(value) === Date.parse(snapshot.capturedAt);
  function ledgerEvidence(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ledgerEvidence);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
      key === 'observedAt' && record.source === 'actual_ledger' && record.expiresAt === null && sameCapture(item)
        ? null : ledgerEvidence(item),
    ]));
  }
  const readClockKinds = new Set([
    'account_collection_coverage', 'account_coverage', 'account_type', 'account_balance',
    'credit_card_obligation_coverage', 'pending_activity', 'uncleared_activity',
    'duplicate_candidate', 'transfer_ambiguity', 'schedule_coverage', 'currency_compatibility',
  ]);
  const { snapshotId: _id, contentHash: _hash, capturedAt: _capture, ...source } = snapshot;
  const { snapshotDate: _date, actualDownloadedAt, ...ledger } = snapshot.legacySnapshot;
  const { ledgerContentHash: _ledgerHash, ...liquidity } = snapshot.liquidity ?? {};
  return {
    ...source,
    legacySnapshot: { ...ledger, ...(actualDownloadedAt !== undefined && !sameCapture(actualDownloadedAt) ? { actualDownloadedAt } : {}) },
    observations: snapshot.observations.map((observation) => ({ ...observation,
      ...(readClockKinds.has(observation.kind) && sameCapture(observation.observedAt) ? { observedAt: null } : {}),
    })),
    liquidity: snapshot.liquidity ? ledgerEvidence(liquidity) : snapshot.liquidity,
  };
}

/** Minimize an already-authorized projection; resource IDs and Money never enter provider facts. */
export function decisionCardExplanationFacts(
  card: PublicDecisionCard,
): z.infer<typeof factSchema>[] {
  const facts: z.input<typeof factSchema>[] = [
    { id: 'f0', kind: 'outcome', code: card.outcome },
    { id: 'f1', kind: 'budget_funding', code: card.budgetFundingStatus },
    { id: 'f2', kind: 'payment_liquidity', code: card.paymentLiquidityStatus },
  ];
  for (const [kind, state] of [
    ['category_before', card.before],
    ['category_after', card.after],
  ] as const)
    for (const category of state?.categories.slice(0, 8) ?? [])
      facts.push({
        id: `f${facts.length}`,
        kind,
        resourceId: category.categoryId,
        amount: category.availability,
      });
  for (const [kind, codes] of [
    ['blocker', card.blockers],
    ['reason', card.reasons ?? []],
  ] as const)
    for (const code of codes.filter((code) => /^[a-z][a-z0-9_]{0,95}$/.test(code)).slice(0, 16))
      facts.push({ id: `f${facts.length}`, kind, code });
  return facts.map((fact) => factSchema.parse(fact));
}
