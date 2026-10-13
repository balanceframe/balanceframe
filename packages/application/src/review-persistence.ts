import type { PendingReviewResult } from './commands.js';
import type { Money, Transaction } from '@balanceframe/protocol-generated';
import type { CreateReviewItemsInput, ReviewRuleSetScope, WorkflowStore, MerchantDerivation } from '@balanceframe/workflow-store';
import { merchantDerivationSchema } from '@balanceframe/workflow-store';
import { createHash } from 'node:crypto';
import { merchantPublicSuggestionSchema, merchantReviewProofSchema, sameMerchantReviewBinding } from './merchant-service.js';

/** Minimal atomic publication surface; the store owns durable identity and supersession. */
export type ReviewItemWriter = Pick<WorkflowStore, 'createReviewItems'>;
export interface PendingReviewPersistenceOptions {
  scope?: ReviewRuleSetScope;
  authorize?: () => boolean;
}
/** Authoritative review facts; no balances or synthetic financial flags are required. */
export type CanonicalReviewSourceTransaction = Pick<Transaction, 'id' | 'accountId' | 'categoryId' | 'payeeId' | 'payeeName' | 'date' | 'amount'> & {
  subtransactions: CanonicalReviewSourceTransaction[];
};
/** Captured source used independently of classifier evidence for review authorization. */
export interface CanonicalReviewSource {
  transactions: CanonicalReviewSourceTransaction[];
  merchantDerivation?: MerchantDerivation;
}

/** A source ID identifies exactly one root or nested child in the complete capture. */
export function indexCanonicalTransactions<T extends { id: string; subtransactions?: readonly T[] }>(rows: readonly T[]): Map<string, T> {
  const transactions = new Map<string, T>();
  const collect = (entries: readonly T[]): void => {
    for (const transaction of entries) {
      if (!transaction.id || transactions.has(transaction.id)) throw new Error('Duplicate canonical review source');
      transactions.set(transaction.id, transaction);
      if (transaction.subtransactions !== undefined) collect(transaction.subtransactions);
    }
  };
  collect(rows);
  return transactions;
}

const displayCurrencies = new Set(Intl.supportedValuesOf('currency'));
const displayDigits = new Map<string, number>();

/** Convert exact Money for legacy display only; refuse unknown currencies or unsafe numeric precision. */
export function moneyToDisplayAmount(money: Money): number {
  const minor = Number(money.minorUnits);
  if (!/^-?(0|[1-9]\d*)$/u.test(money.minorUnits) || !Number.isSafeInteger(minor) || !displayCurrencies.has(money.currency))
    throw new RangeError('Money cannot be represented as a numeric display amount');
  let digits = displayDigits.get(money.currency);
  if (digits === undefined) {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency: money.currency }).resolvedOptions().maximumFractionDigits;
    if (digits === undefined) throw new RangeError('Currency minor-unit exponent is unavailable');
    displayDigits.set(money.currency, digits);
  }
  return minor / 10 ** digits;
}

/**
 * Persist deterministic review candidates idempotently.
 *
 * Each candidate is bound to its canonical source transaction, independently
 * of classifier evidence, so scoped review authority can be checked before SDK access.
 *
 * Exact source Money is retained. Native candidates reference one complete scoped
 * rule set; no matching rule IDs are repeated in Review evidence.
 */
export async function persistPendingReviewResult(
  store: ReviewItemWriter,
  budgetId: string,
  result: PendingReviewResult,
  snapshot: CanonicalReviewSource,
  options?: PendingReviewPersistenceOptions,
): Promise<number> {
  const transactions = indexCanonicalTransactions(snapshot.transactions);
  if (result.candidates.some((candidate) => !transactions.has(candidate.transactionId)))
    throw new Error('Canonical review source transaction is unavailable');
  if (!Array.isArray(result.nativeRuleBlocks) || !Array.isArray(result.nativeRuleParts) || !Array.isArray(result.nativeRuleSets)) throw new Error('Review result has no complete native rule tables');
  if (options?.scope && options.scope.budgetId !== budgetId) throw new Error('Review selected source budget changed');
  const merchantDerivation = snapshot.merchantDerivation === undefined ? undefined : merchantDerivationSchema.parse(snapshot.merchantDerivation);
  const items: CreateReviewItemsInput['items'] = [];
  for (const candidate of result.candidates) {
    const transaction = transactions.get(candidate.transactionId)!;
    const signedAmount = BigInt(transaction.amount.minorUnits);
    const sourceMoney = { ...transaction.amount };
    let amount: number | undefined;
    try { amount = Math.abs(moneyToDisplayAmount(sourceMoney)); } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    const payeeName = transaction.payeeName ?? '';
    const merchantProof = candidate.merchantProof === undefined ? undefined : merchantReviewProofSchema.parse(candidate.merchantProof);
    const merchantEvidence = candidate.merchantEvidence === undefined ? undefined : merchantPublicSuggestionSchema.parse(candidate.merchantEvidence);
    if (candidate.source === 'merchant-inferred' && (!merchantProof || candidate.ruleSetIndex !== undefined ||
      merchantProof.transactionId !== candidate.transactionId || merchantProof.categoryId !== candidate.proposedCategoryId ||
      merchantProof.accountId !== transaction.accountId || merchantProof.reviewContext.scope.budgetId !== budgetId ||
      merchantProof.evidenceKey !== `merchant:transaction:${candidate.transactionId}` ||
      (options?.scope && (merchantProof.reviewContext.scope.spaceId !== options.scope.spaceId ||
        merchantProof.reviewContext.scope.connectionId !== options.scope.connectionId)) ||
      (merchantEvidence && !sameMerchantReviewBinding(merchantProof, merchantEvidence))))
      throw new Error('Merchant Review classification has incomplete target evidence');
    if (candidate.source === 'merchant-inferred' && (!merchantDerivation ||
      merchantDerivation.scope.spaceId !== merchantProof!.reviewContext.scope.spaceId ||
      merchantDerivation.scope.budgetId !== merchantProof!.reviewContext.scope.budgetId ||
      merchantDerivation.scope.connectionId !== merchantProof!.reviewContext.scope.connectionId ||
      Date.parse(merchantDerivation.expiresAt) !== Date.parse(merchantProof!.reviewContext.expiresAt)))
      throw new Error('Merchant Review classification has no trusted derivation ownership');
    if (candidate.source !== 'merchant-inferred' && (merchantProof !== undefined || merchantEvidence !== undefined))
      throw new Error('Unexpected merchant Review evidence');
    if (candidate.source === 'native-rule' && (typeof candidate.proposedCategoryId !== 'string' || !candidate.proposedCategoryId ||
      typeof candidate.proposedCategoryName !== 'string' || typeof candidate.ruleSetIndex !== 'number' || !Number.isInteger(candidate.ruleSetIndex) ||
      candidate.ruleSetIndex < 0 || candidate.ruleSetIndex > 0xffff_ffff || !result.nativeRuleSets[candidate.ruleSetIndex]))
      throw new Error('Native Review classification has incomplete target evidence');
    if (candidate.source !== 'native-rule' && candidate.ruleSetIndex !== undefined)
      throw new Error('Unexpected native Review provenance');
    // Raw bank fields and current decision catalogs are projected afresh at read time.
    const retainedMerchantEvidence = merchantEvidence && {
      transactionId: merchantEvidence.transactionId, accountId: merchantEvidence.accountId,
      payeeId: merchantEvidence.payeeId, categoryId: merchantEvidence.categoryId, tier: merchantEvidence.tier,
      reasonCodes: merchantEvidence.reasonCodes, supportCount: merchantEvidence.supportCount,
      evidenceKey: merchantEvidence.evidenceKey, evidenceRevision: merchantEvidence.evidenceRevision,
      reviewContext: merchantEvidence.reviewContext, categoryHistory: merchantEvidence.categoryHistory,
      alternatives: merchantEvidence.alternatives, ruleCandidates: merchantEvidence.ruleCandidates,
      evidence: merchantEvidence.evidence.map((item) => ({
        ...item, rawText: null, normalizedText: item.field === 'categoryId' ? item.normalizedText : null,
      })),
      contradictions: merchantEvidence.contradictions.map((item) => ({
        ...item, rawText: null, normalizedText: item.field === 'categoryId' ? item.normalizedText : null,
      })),
    };
    const classifier = candidate.source === 'merchant-inferred' ? 'merchant' : candidate.source === 'native-rule' ? 'rule' : 'deterministic';
    const revision = candidate.source === 'native-rule' ? undefined : createHash('sha256').update(JSON.stringify([
      [transaction.id, transaction.accountId, transaction.categoryId, transaction.payeeId, transaction.payeeName, transaction.date, transaction.amount],
      candidate.proposedCategoryId ?? null, merchantProof?.evidenceRevision ?? null,
    ])).digest('hex');
    items.push({
      budgetId,
      ...(candidate.ruleSetIndex === undefined ? {} : { ruleSetIndex: candidate.ruleSetIndex }),
      transactionId: candidate.transactionId,
      sourceTransaction: {
        id: transaction.id, accountId: transaction.accountId, categoryId: transaction.categoryId ?? null,
        direction: signedAmount < 0n ? 'outgoing' : 'incoming',
        amount: {
          minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
          currency: transaction.amount.currency,
        },
      },
      categoryId: candidate.proposedCategoryId ?? '',
      classifier,
      promptVersion: candidate.source === 'merchant-inferred' ? 'merchant/2' : 'deterministic-v1',
      priority: 0,
      evidence: {
        reasons: candidate.reasons,
        ...(revision === undefined ? {} : { sourceRevision: revision }),
        sourcePayeeId: transaction.payeeId,
        ...(merchantProof ? { merchantProof, merchantDerivation } : {}),
        ...(retainedMerchantEvidence ? { merchantEvidence: retainedMerchantEvidence } : {}),
        ...(candidate.source === 'native-rule' ? { proposedCategoryName: candidate.proposedCategoryName } : {}),
        payeeName,
        date: transaction.date,
        money: sourceMoney,
        currency: sourceMoney.currency,
        ...(amount === undefined ? {} : { amount }),
        normalizedMerchant: payeeName,
        originalName: payeeName,
        currentCategory: '',
        account: '',
      },
      provenance: 'Actual synchronized snapshot deterministic analysis',
    });
  }
  return (await store.createReviewItems({
    items, nativeRuleBlocks: result.nativeRuleBlocks, nativeRuleParts: result.nativeRuleParts, nativeRuleSets: result.nativeRuleSets,
    ...(options?.scope === undefined ? {} : { scope: options.scope }),
    ...(options?.authorize === undefined ? {} : { authorize: options.authorize }),
  })).length;
}
