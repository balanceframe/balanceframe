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

/** Persist deterministic review candidates idempotently for later correction or approval. */
export async function persistPendingReviewResult(
  store: ReviewItemWriter,
  budgetId: string,
  result: PendingReviewResult,
): Promise<number> {
  let persisted = 0;
  for (const candidate of result.candidates) {
    await store.createReviewItem({
      budgetId,
      transactionId: candidate.transactionId,
      categoryId: '',
      classifier: 'deterministic',
      promptVersion: 'deterministic-v1',
      transactionVersion: 1,
      priority: 0,
      evidence: { reasons: candidate.reasons, payeeName: candidate.payeeName, date: candidate.date },
      provenance: 'Actual synchronized snapshot deterministic analysis',
    });
    persisted += 1;
  }
  return persisted;
}
