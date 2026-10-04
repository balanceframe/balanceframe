import { z } from 'zod';
import type { LiquidityActor, ReviewItem, WorkflowStore } from '@balanceframe/workflow-store';
import { buildReviewQueueItem } from './workflow-store';
import type { ProjectedReviewEvidence, ReviewQueueItem } from './workflow-store';

const Money = z.object({
  minorUnits: z.string().regex(/^-?(0|[1-9]\d*)$/),
  currency: z.string().min(1),
}).passthrough();

export const ReviewSynchronization = z.object({
  financialSnapshot: z.object({
    legacySnapshot: z.object({
      accounts: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()),
      categories: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()),
      transactions: z.array(z.object({
        id: z.string().min(1),
        accountId: z.string().min(1),
        payeeName: z.string().nullable(),
        importedPayee: z.string().nullable(),
        categoryId: z.string().nullable(),
        amount: Money,
        date: z.string().optional(),
      }).passthrough()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

type ReviewFinancialSnapshot = z.infer<typeof ReviewSynchronization>['financialSnapshot']['legacySnapshot'];

/** Build review data only from current Actual facts authorized for this exact actor and resource. */
export function projectReviewQueueItem(
  store: WorkflowStore,
  actor: LiquidityActor,
  item: ReviewItem,
  snapshot: ReviewFinancialSnapshot,
): ReviewQueueItem | null {
  if (item.budgetId !== actor.budgetId) return null;
  const transaction = snapshot.transactions.find((row) => row.id === item.transactionId);
  const account = transaction && snapshot.accounts.find((row) => row.id === transaction.accountId);
  const targetCategory = item.categoryId === ''
    ? undefined
    : snapshot.categories.find((row) => row.id === item.categoryId);
  if (!transaction || !account || (item.categoryId !== '' && !targetCategory)) return null;

  const allowed = (resourceKind: 'account' | 'category', resourceId: string, capability: string) =>
    store.liquidity.isAuthorized({
      ...actor,
      resourceKind,
      resourceId,
      capability,
    });
  if (
    !allowed('account', account.id, 'existence') ||
    !allowed('account', account.id, 'history') ||
    (targetCategory !== undefined && !allowed('category', targetCategory.id, 'existence'))
  ) return null;

  const minorUnits = Number(BigInt(transaction.amount.minorUnits));
  if (!Number.isSafeInteger(minorUnits)) return null;

  const categoryNames: Record<string, string> = {};
  const categoryName = (id: string | null): string => {
    if (!id) return 'Uncategorized';
    const category = snapshot.categories.find((row) => row.id === id);
    if (!category || !allowed('category', id, 'existence') || !allowed('category', id, 'name'))
      return 'Restricted category';
    categoryNames[id] = category.name;
    return category.name;
  };
  const currentCategory = categoryName(transaction.categoryId);
  const suggestedCategory = targetCategory ? categoryName(targetCategory.id) : '';
  const projected: ProjectedReviewEvidence = {
    originalImportedName: transaction.importedPayee ?? transaction.payeeName ?? '',
    normalizedMerchant: transaction.payeeName ?? '',
    account: allowed('account', account.id, 'name') ? account.name : 'Restricted account',
    amount: minorUnits / 100,
    currentCategory,
    suggestedCategory,
    categoryNames,
  };
  return buildReviewQueueItem(item, projected);
}
