import { z } from 'zod';
import type { GovernanceAuthorizationInput, GovernanceOperation, LiquidityActor, ReviewItem, ReviewRuleSetScope, WorkflowStore } from '@balanceframe/workflow-store';
import { buildReviewQueueItem } from './workflow-store';
import type { ProjectedReviewEvidence, ReviewQueueItem } from './workflow-store';
import { indexCanonicalTransactions, moneyToDisplayAmount, merchantPublicSuggestionSchema, merchantReviewProofSchema, sameMerchantReviewBinding } from '@balanceframe/application';
import type { CanonicalReviewSourceTransaction, MerchantAnalysisView, CanonicalReviewSource } from '@balanceframe/application';
import { hasCurrentReviewNamespace } from './review-scope-admission';

const Money = z.object({
  minorUnits: z.string().regex(/^-?(0|[1-9]\d*)$/),
  currency: z.string().min(1),
}).passthrough();

interface ReviewFinancialTransaction extends Pick<CanonicalReviewSourceTransaction, 'id' | 'accountId' | 'categoryId' | 'payeeName' | 'amount'> {
  importedPayee?: string | null;
  payeeId?: string | null;
  date?: string;
  subtransactions?: ReviewFinancialTransaction[];
}
const ReviewTransaction: z.ZodType<ReviewFinancialTransaction> = z.lazy(() => z.object({
  id: z.string().min(1), accountId: z.string().min(1), payeeName: z.string().nullable(),
  importedPayee: z.string().nullable().optional(), payeeId: z.string().nullable().optional(),
  categoryId: z.string().nullable(), amount: Money, date: z.string().optional(),
  subtransactions: z.array(ReviewTransaction).optional(),
}).passthrough());

export const ReviewSynchronization = z.object({
  financialSnapshot: z.object({
    legacySnapshot: z.object({
      accounts: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()),
      categories: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()),
      transactions: z.array(ReviewTransaction),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

type ReviewFinancialSnapshot = z.infer<typeof ReviewSynchronization>['financialSnapshot']['legacySnapshot'];

export function findReviewTransaction(
  rows: ReviewFinancialSnapshot['transactions'] | CanonicalReviewSource['transactions'],
  id: string,
): ReviewFinancialSnapshot['transactions'][number] | CanonicalReviewSource['transactions'][number] | undefined {
  return indexCanonicalTransactions<ReviewFinancialTransaction>(rows).get(id);
}

/**
 * Ordinary Review reads use account history, not merchant:analyze or enriched
 * capture's explicit transaction grants. Exact source IDs identify leaf operations;
 * all relevant root/leaf account/category scopes and whole-response Money/count
 * limits are admitted together. Request-entry actor.now is never a disclosure clock.
 * Source leaves and actual disclosed rows each satisfy the bounds independently:
 * repeated/overlapping disclosures count, without charging source plus output.
 * HTTP readers also supply their existing budget observe capability; trusted
 * proposal consumers retain their separately enforced budget/source admission.
 * That distinction never bypasses the account/category financial manifest.
 * Native rows require a trusted immutable reference in the exact captured namespace;
 * bulk readers inspect only compact metadata. All canonical IDs, including split
 * children outside the selected row, are globally unique. Returned Money includes
 * embedded merchant source and recurrence ranges, never a deduplicated row estimate.
 */
export function projectReviewQueueItems(
  store: WorkflowStore,
  actor: LiquidityActor,
  items: readonly ReviewItem[],
  snapshot: ReviewFinancialSnapshot,
  merchant?: MerchantAnalysisView,
  source?: CanonicalReviewSource,
  budgetCapability?: 'observe',
  scope?: ReviewRuleSetScope,
  outbound?: readonly GovernanceOperation[],
): ReviewQueueItem[] {
  const space = actor.spaceId
    ? store.governance.getSpace({ spaceId: actor.spaceId })
    : store.governance.getSpaceForBudget({ budgetId: actor.budgetId });
  const policy = space && store.governance.getPolicy({ spaceId: space.id });
  if (!space || space.budgetId !== actor.budgetId || !policy ||
      (actor.governancePolicyVersion !== undefined && actor.governancePolicyVersion !== policy.version)) return [];
  if (scope && (scope.spaceId !== space.id || scope.budgetId !== actor.budgetId ||
      (merchant && (merchant.scope.spaceId !== scope.spaceId || merchant.scope.budgetId !== scope.budgetId ||
        merchant.scope.connectionId !== scope.connectionId)))) return [];
  const currentItems = items.filter((item) => hasCurrentReviewNamespace(store, item, {
    spaceId: space.id, budgetId: actor.budgetId, connectionId: scope?.connectionId ?? '',
  }));
  if (currentItems.length === 0) return [];
  const transactions = source?.transactions ?? snapshot.transactions;
  const transactionsById = indexCanonicalTransactions<ReviewFinancialTransaction>(transactions);
  const requested = new Set(currentItems.map((item) => item.transactionId));
  const operations: (GovernanceOperation & { readonly id: string })[] = [];
  const required: GovernanceAuthorizationInput['required'][number][] = budgetCapability
    ? [{ resourceKind: 'budget', resourceId: actor.budgetId, capability: budgetCapability, visibility: 'resource' }]
    : [];
  const refs = new Set<string>();
  const containsRequested = (row: ReviewFinancialSnapshot['transactions'][number]): boolean => {
    if (requested.has(row.id)) return true;
    return row.subtransactions?.some(containsRequested) ?? false;
  };
  const include = (row: ReviewFinancialSnapshot['transactions'][number]): boolean => {
    if (!snapshot.accounts.some((account) => account.id === row.accountId)) return false;
    for (const capability of ['existence', 'history']) {
      const key = `account:${row.accountId}:${capability}`;
      if (!refs.has(key)) {
        refs.add(key);
        required.push({ resourceKind: 'account', resourceId: row.accountId, capability, visibility: 'resource' });
      }
    }
    if (row.categoryId && !refs.has(`category:${row.categoryId}`)) {
      refs.add(`category:${row.categoryId}`);
      required.push({ resourceKind: 'category', resourceId: row.categoryId, capability: 'existence', visibility: 'resource' });
    }
    if (row.subtransactions && row.subtransactions.length > 0) return row.subtransactions.every(include);
    if (!Money.safeParse(row.amount).success) return false;
    try {
      const signed = BigInt(row.amount.minorUnits);
      // Account history is the baseline authority for these exact transaction facts.
      // Keep the source ID without inventing a separate transaction capability.
      operations.push({
        id: row.id, operation: 'history', accountId: row.accountId,
        ...(row.categoryId ? { categoryId: row.categoryId } : {}),
        direction: signed < 0n ? 'outgoing' : 'incoming',
        amount: { minorUnits: (signed < 0n ? -signed : signed).toString(), currency: row.amount.currency },
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const root of transactions) {
    if (containsRequested(root) && !include(root)) return [];
  }
  if (operations.length === 0) return [];
  const request: GovernanceAuthorizationInput = {
    actorId: actor.actorId, spaceId: space.id, membershipId: actor.membershipId,
    expectedPolicyVersion: actor.governancePolicyVersion ?? policy.version,
    phase: 'read', operation: 'history', required,
    payload: { operations, resources: required }, now: new Date().toISOString(),
    ...(actor.auth ? { auth: actor.auth } : {}),
    ...(actor.auth?.method === 'api-key' && actor.auth.principalType === 'agent' ? {
      agentId: actor.auth.actorId, delegationId: actor.auth.delegationId, delegationVersion: actor.auth.delegationVersion,
    } : {}),
  };
  if (!store.governance.authorize(request).allowed) return [];
  const admitted = new Map(required.map((ref) => [`${ref.resourceKind}:${ref.resourceId}:${ref.capability}`, true]));
  const allowed = (resourceKind: 'account' | 'category', resourceId: string, capability: string): boolean => {
    const key = `${resourceKind}:${resourceId}:${capability}`;
    const cached = admitted.get(key);
    if (cached !== undefined) return cached;
    const ref = { resourceKind, resourceId, capability, visibility: 'resource' as const };
    const fullRequired = [...required, ref];
    const result = store.governance.authorize({
      ...request, now: new Date().toISOString(), required: fullRequired,
      payload: { operations, resources: fullRequired },
    }).allowed;
    admitted.set(key, result);
    if (result) required.push(ref);
    return result;
  };
  const projected = currentItems.flatMap((item) => {
    const value = projectAdmittedReviewItem(actor, item, snapshot, allowed, transactionsById.get(item.transactionId), source ? merchant : undefined);
    return value ? [value] : [];
  });
  // Source leaves and disclosed rows are independent envelopes: neither may
  // exceed a bound, but adding them would charge an ordinary read twice.
  const disclosedOperations = outbound ?? reviewDisclosureOperations(projected, transactionsById);
  if (!store.governance.authorize({
    ...request, now: new Date().toISOString(), payload: { operations, resources: required },
  }).allowed) return [];
  return store.governance.authorize({
    ...request, now: new Date().toISOString(),
    payload: { operations: disclosedOperations, resources: required },
  }).allowed ? projected : [];
}

/** Build review data only from current Actual facts authorized for this exact actor and resource. */
export function projectReviewQueueItem(
  store: WorkflowStore,
  actor: LiquidityActor,
  item: ReviewItem,
  snapshot: ReviewFinancialSnapshot,
  merchant?: MerchantAnalysisView,
  source?: CanonicalReviewSource,
  budgetCapability?: 'observe',
  scope?: ReviewRuleSetScope,
): ReviewQueueItem | null {
  return projectReviewQueueItems(store, actor, [item], snapshot, merchant, source, budgetCapability, scope)[0] ?? null;
}

/** Each serialized Money slot counts, including repeated evidence and recurrence ranges. */
export function reviewDisclosureOperations(
  items: readonly ReviewQueueItem[],
  transactions: ReadonlyMap<string, Pick<CanonicalReviewSourceTransaction, 'id' | 'accountId' | 'categoryId' | 'amount'>>,
): GovernanceOperation[] {
  const operations: GovernanceOperation[] = [];
  const add = (
    amount: CanonicalReviewSourceTransaction['amount'],
    identity: { id?: string; accountId: string; categoryId?: string },
    direction?: GovernanceOperation['direction'],
  ): void => {
    const signed = BigInt(amount.minorUnits);
    operations.push({ operation: 'history', ...identity, direction: direction ?? (signed < 0n ? 'outgoing' : 'incoming'),
      amount: { currency: amount.currency, minorUnits: (signed < 0n ? -signed : signed).toString() } });
  };
  for (const item of items) {
    const transaction = transactions.get(item.reviewItem.transactionId);
    if (!transaction) throw new Error('Review disclosure source is unavailable');
    const identity = { id: transaction.id, accountId: transaction.accountId,
      ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}) };
    if (item.evidence.money) add(item.evidence.money, identity);
    const evidence = item.evidence.merchantEvidence?.sourceTransaction;
    if (evidence) add(evidence.amount, { id: evidence.id, accountId: evidence.accountId,
      ...(evidence.categoryId ? { categoryId: evidence.categoryId } : {}) });
    for (const recurrence of item.evidence.merchantRecurrences ?? []) {
      const direction = recurrence.direction === 'outflow' ? 'outgoing' : 'incoming';
      add(recurrence.minimumAmount, { accountId: recurrence.accountId }, direction);
      add(recurrence.maximumAmount, { accountId: recurrence.accountId }, direction);
    }
  }
  return operations;
}

function projectAdmittedReviewItem(
  actor: LiquidityActor,
  item: ReviewItem,
  snapshot: ReviewFinancialSnapshot,
  allowed: (resourceKind: 'account' | 'category', resourceId: string, capability: string) => boolean,
  transaction: ReviewFinancialTransaction | undefined,
  merchant?: MerchantAnalysisView,
): ReviewQueueItem | null {
  if (item.budgetId !== actor.budgetId) return null;
  const categories = merchant ? merchant.categories : snapshot.categories;
  const account = transaction && snapshot.accounts.find((row) => row.id === transaction.accountId);
  if (!transaction || !account) return null;
  if (
    !allowed('account', account.id, 'existence') ||
    !allowed('account', account.id, 'history')
  ) return null;

  let displayAmount: number | undefined;
  try { displayAmount = moneyToDisplayAmount(transaction.amount); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }

  const categoryNames: Record<string, string> = {};
  const categoryName = (id: string | null): string => {
    if (!id) return 'Uncategorized';
    const category = categories.find((row) => row.id === id);
    if (!category || !allowed('category', id, 'existence') || !allowed('category', id, 'name'))
      return 'Restricted category';
    categoryNames[id] = category.name;
    return category.name;
  };
  const currentCategory = categoryName(transaction.categoryId);
  const candidate = merchant?.localReview.candidates.find((value) => value.transactionId === transaction.id);
  const currentProof = merchantReviewProofSchema.safeParse(candidate?.merchantProof);
  const retainedProof = merchantReviewProofSchema.safeParse(item.evidence.merchantProof);
  const inferredTargetAdmitted = candidate?.source === 'merchant-inferred' &&
    candidate.proposedCategoryId === item.categoryId && currentProof.success && retainedProof.success &&
    sameMerchantReviewBinding(currentProof.data, retainedProof.data) &&
    currentProof.data.transactionId === transaction.id && currentProof.data.accountId === transaction.accountId &&
    currentProof.data.categoryId === item.categoryId &&
    currentProof.data.evidenceKey === `merchant:transaction:${transaction.id}` &&
    currentProof.data.reviewContext.scope.spaceId === actor.spaceId &&
    currentProof.data.reviewContext.scope.budgetId === actor.budgetId &&
    currentProof.data.reviewContext.scope.connectionId === merchant?.scope.connectionId &&
    currentProof.data.reviewContext.sourceFactsHash === merchant?.sourceAdmission.factsHash &&
    currentProof.data.reviewContext.visibilityHash === merchant?.sourceAdmission.visibilityHash &&
    Date.parse(currentProof.data.reviewContext.expiresAt) > Date.now() &&
    Date.parse(merchant?.sourceAdmission.expiresAt ?? '') > Date.now();
  const current = merchant?.suggestions.find((suggestion) => suggestion.transactionId === item.transactionId);
  const parsed = current && merchantPublicSuggestionSchema.safeParse(current);
  const matchingMerchantEvidence = parsed?.success &&
    parsed.data.accountId === transaction.accountId &&
    parsed.data.sourceTransaction.id === transaction.id &&
    parsed.data.sourceTransaction.payeeId === transaction.payeeId &&
    parsed.data.sourceTransaction.categoryId === transaction.categoryId &&
    parsed.data.sourceTransaction.date === transaction.date &&
    parsed.data.sourceTransaction.amount.minorUnits === transaction.amount.minorUnits &&
    parsed.data.sourceTransaction.amount.currency === transaction.amount.currency &&
    (parsed.data.categoryId ?? '') === item.categoryId &&
    parsed.data.reviewContext.scope.spaceId === actor.spaceId &&
    parsed.data.reviewContext.scope.budgetId === actor.budgetId &&
    parsed.data.reviewContext.scope.connectionId === merchant?.scope.connectionId &&
    parsed.data.reviewContext.sourceFactsHash === merchant?.sourceAdmission.factsHash &&
    parsed.data.reviewContext.visibilityHash === merchant?.sourceAdmission.visibilityHash &&
    Date.parse(parsed.data.reviewContext.expiresAt) > Date.now() &&
    Date.parse(merchant?.sourceAdmission.expiresAt ?? '') > Date.now() &&
    (candidate?.source !== 'merchant-inferred' || (currentProof.success &&
      sameMerchantReviewBinding(currentProof.data, parsed.data)))
    ? parsed.data : undefined;
  const withheldTarget = item.classifier === 'merchant' && item.categoryId !== '' && !inferredTargetAdmitted;
  if (withheldTarget && (transaction.categoryId !== null || (candidate && candidate.source !== 'uncategorized')))
    return null;
  const projectedItem = withheldTarget ? { ...item, categoryId: '' } : item;
  const targetCategory = projectedItem.categoryId === '' ? undefined : categories.find((row) => row.id === projectedItem.categoryId);
  if (projectedItem.categoryId !== '' && (!targetCategory || !allowed('category', targetCategory.id, 'existence')))
    return null;
  const suggestedCategory = targetCategory ? categoryName(targetCategory.id) : '';
  const merchantProof = !withheldTarget && inferredTargetAdmitted && currentProof.success ? currentProof.data : undefined;
  const merchantEvidence = withheldTarget ? undefined : matchingMerchantEvidence;
  const merchantProvenance = merchantProof ?? merchantEvidence;
  const merchantRecurrences = merchant?.recurrences.filter((recurrence) =>
    recurrence.accountId === transaction.accountId &&
    recurrence.payeeId !== null && recurrence.payeeId === transaction.payeeId,
  );
  const imported = merchantEvidence?.sourceTransaction.importedPayee;
  const history = merchantEvidence?.categoryHistory.entries.map((entry) => {
    categoryName(entry.categoryId);
    return { ...entry, lastClassified: entry.lastDate };
  });
  const alternatives = merchantEvidence?.alternatives.map((alternative) => {
    categoryName(alternative.categoryId);
    return alternative.categoryId;
  });
  const ruleCandidates = merchantEvidence?.ruleCandidates.map((candidate) => ({
    ...candidate,
    merchant: merchant?.payees.find((payee) => payee.id === candidate.payeeId)?.name ?? 'Unavailable payee',
    currentCategory: categoryName(candidate.categoryId),
    matchCount: candidate.supportCount,
  }));
  const reviewSource = withheldTarget ? 'uncategorized' : candidate?.source;
  const projected: ProjectedReviewEvidence = {
    ...(withheldTarget ? { actionable: false } : {}),
    originalImportedName: imported?.state === 'present' ? imported.value : transaction.payeeName ?? '',
    normalizedMerchant: transaction.payeeName ?? '',
    account: allowed('account', account.id, 'name') ? account.name : 'Restricted account',
    ...(displayAmount !== undefined ? { amount: displayAmount } : {}),
    money: transaction.amount,
    currency: transaction.amount.currency,
    ...(merchantProof ? { merchantProof } : {}),
    ...(merchantEvidence ? { merchantEvidence } : {}),
    ...(merchantRecurrences ? { merchantRecurrences } : {}),
    ...(reviewSource ? { source: reviewSource } : {}),
    ...(merchant ? {
      merchantAsOfDate: merchant.asOfDate,
      merchantNormalizationVersion: merchant.normalizationVersion,
      merchantExpiresAt: merchant.sourceAdmission.expiresAt,
    } : {}),
    ...(history ? { history } : {}),
    ...(alternatives ? { alternatives } : {}),
    ...(ruleCandidates ? { ruleCandidates } : {}),
    provenance: merchantProvenance
      ? `Local merchant/2 · ${merchantProvenance.tier} · ${merchantProvenance.evidenceRevision}`
      : 'Current authorized Actual transaction',
    currentCategory,
    suggestedCategory,
    categoryNames,
  };
  return buildReviewQueueItem(projectedItem, projected);
}
