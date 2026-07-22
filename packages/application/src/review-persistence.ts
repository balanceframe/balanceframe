import type { PendingReviewResult } from './commands.js';

/** Minimal workflow-store surface needed to persist deterministic review items. */
export interface ReviewItemWriter {
  createReviewItem(input: {
    budgetId: string;
    transactionId: string;
    categoryId: string;
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
 * Each candidate is stored with its payee name, amount, and date mapped
 * into the evidence fields that buildReviewQueueItem on the server side
 * consumes (normalizedMerchant, originalName, amount).
 *
 * Amount is converted from minorUnits (cents) to a number for the
 * server-side queue item builder.  categoryId is left empty because
 * deterministic candidates flag uncategorized transactions — no current
 * category exists.
 */
export async function persistPendingReviewResult(
  store: ReviewItemWriter,
  budgetId: string,
  result: PendingReviewResult,
): Promise<number> {
  let persisted = 0;
  for (const candidate of result.candidates) {
    const minor = Number(candidate.amount.minorUnits);
    const amount = Number.isFinite(minor) ? Math.abs(minor) / 100 : 0;
    const payeeName = candidate.payeeName ?? '';

    await store.createReviewItem({
      budgetId,
      transactionId: candidate.transactionId,
      categoryId: '',
      classifier: 'deterministic',
      promptVersion: 'deterministic-v1',
      transactionVersion: 1,
      priority: 0,
      evidence: {
        reasons: candidate.reasons,
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
