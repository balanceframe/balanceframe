import type { PendingReviewResult } from './commands.js';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import type { ReviewActionAuthorization } from '@balanceframe/workflow-store';

/** Minimal workflow-store surface needed to persist deterministic review items. */
export interface ReviewItemWriter {
  createReviewItem(input: {
    budgetId: string;
    transactionId: string;
    categoryId: string;
    sourceTransaction: ReviewActionAuthorization['transaction'];
    classifier: string;
    promptVersion?: string;
    transactionVersion?: number;
    priority?: number;
    evidence?: Record<string, unknown>;
    provenance: string;
  }): Promise<unknown>;
}

/**
 * Persist deterministic review candidates idempotently.
 *
 * Each candidate is bound to its canonical source transaction, independently
 * of classifier evidence, so scoped review authority can be checked before SDK access.
 *
 * Amount is converted from minorUnits (cents) for queue evidence. Rule
 * candidates retain their proposed category and exact native rule IDs;
 * ordinary uncategorized candidates have no proposed category.
 */
export async function persistPendingReviewResult(
  store: ReviewItemWriter,
  budgetId: string,
  result: PendingReviewResult,
  snapshot: ProtocolSnapshot,
): Promise<number> {
  const transactions = new Map(snapshot.transactions.map((transaction) => [transaction.id, transaction]));
  if (transactions.size !== snapshot.transactions.length ||
      result.candidates.some((candidate) => !transactions.has(candidate.transactionId)))
    throw new Error('Canonical review source transaction is unavailable');
  let persisted = 0;
  for (const candidate of result.candidates) {
    const minor = Number(candidate.amount.minorUnits);
    const amount = Number.isFinite(minor) ? Math.abs(minor) / 100 : 0;
    const payeeName = candidate.payeeName ?? '';
    const transaction = transactions.get(candidate.transactionId)!;
    const signedAmount = BigInt(transaction.amount.minorUnits);

    await store.createReviewItem({
      budgetId,
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
      classifier: candidate.ruleIds ? 'rule' : 'deterministic',
      promptVersion: 'deterministic-v1',
      transactionVersion: 1,
      priority: 0,
      evidence: {
        reasons: candidate.reasons,
        ...(candidate.ruleIds ? {
          ruleIds: candidate.ruleIds,
          proposedCategoryName: candidate.proposedCategoryName,
        } : {}),
        payeeName,
        date: candidate.date,
        amount,
        normalizedMerchant: payeeName,
        originalName: payeeName,
        currentCategory: '',
        account: '',
      },
      provenance: 'Actual synchronized snapshot deterministic analysis',
    });
    persisted += 1;
  }
  return persisted;
}
