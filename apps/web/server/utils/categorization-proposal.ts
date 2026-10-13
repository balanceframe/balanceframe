import type { MutationPlan, RustMutationProtocol } from '@balanceframe/application';
import type { Category, ProtocolSnapshot, Transaction } from '@balanceframe/protocol-generated';
import type { CategoryActionPayload, ReviewItem } from '@balanceframe/workflow-store';

export interface CategorizationProposalIntent {
  readonly payload: CategoryActionPayload;
  readonly preconditions: Record<string, unknown>;
  readonly nativePlan: MutationPlan;
}

/** Build the exact executable set-category envelope from one fresh snapshot and Native plan. */
export function buildCategorizationProposalIntent(input: {
  readonly protocol: RustMutationProtocol;
  readonly snapshot: Pick<ProtocolSnapshot, 'actualVersion' | 'schemaVersion'>;
  readonly transaction: Transaction;
  readonly category: Category;
  readonly review?: ReviewItem;
  readonly presentation?: { readonly message?: string; readonly reason?: string };
}): CategorizationProposalIntent {
  const { transaction, category } = input;
  const signedAmount = BigInt(transaction.amount.minorUnits);
  const direction = signedAmount < 0n ? 'outgoing' : 'incoming';
  const amount = {
    minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
    currency: transaction.amount.currency,
  };
  const nativePlan = input.protocol.planSetCategory(transaction, category);
  const payload: CategoryActionPayload = {
    kind: 'set_category',
    transactionId: transaction.id,
    categoryId: category.id,
    composite: {
      operations: [{
        operation: 'set_category',
        transactionId: transaction.id,
        accountId: transaction.accountId,
        direction,
        amount,
        categoryId: category.id,
      }],
      reallocations: [],
      transferRecommendations: [],
      ledgerProjections: [],
      evidenceReferences: [],
      nativePayloadHash: nativePlan.hash,
    },
  };
  const preconditions: Record<string, unknown> = {
    ...(input.review ? {
      reviewId: input.review.id,
      ...(typeof input.review.evidence.sourceRevision === 'string'
        ? { reviewSourceRevision: input.review.evidence.sourceRevision } : {}),
      reviewProvenance: {
        budgetId: input.review.budgetId,
        transactionId: input.review.transactionId,
        categoryId: input.review.categoryId,
        status: input.review.status,
        version: input.review.version,
      },
    } : {}),
    currentCategoryId: transaction.categoryId ?? null,
    transaction: {
      id: transaction.id,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId ?? null,
      direction,
      amount,
    },
    nativePlan,
    actualVersion: input.snapshot.actualVersion,
    snapshotSchemaVersion: input.snapshot.schemaVersion,
    ...(input.presentation ? { presentation: input.presentation } : {}),
  };
  return { payload, preconditions, nativePlan };
}
