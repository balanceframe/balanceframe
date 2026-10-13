import type {
  GovernanceResourceRef,
  LiquidityActor,
  ReviewItem,
  ReviewRuleSetScope,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import type { SelectedSpaceResult } from './space-context';
import { merchantConnectionId } from '@balanceframe/application';
import type { CanonicalReviewSourceTransaction, ConnectionConfig } from '@balanceframe/application';

export function reviewConnectionScope(spaceId: string, config: Pick<ConnectionConfig, 'budgetId' | 'serverUrl'>): ReviewRuleSetScope {
  return { spaceId, budgetId: config.budgetId, connectionId: merchantConnectionId(config) };
}

/** Native attribution is immutable metadata, not a reason to expand all matching IDs. */
export function hasCurrentReviewNamespace(
  store: WorkflowStore,
  item: ReviewItem,
  scope: Pick<ReviewRuleSetScope, 'spaceId' | 'budgetId'> & { connectionId?: string },
): boolean {
  if (item.budgetId !== scope.budgetId || store.governance.getSpace({ spaceId: scope.spaceId })?.budgetId !== scope.budgetId) return false;
  const classifier = item.evidence.classifier;
  const native = item.classifier === 'rule' ||
    (typeof classifier === 'object' && classifier !== null && 'type' in classifier && classifier.type === 'rule');
  if (!native) return true;
  const ref = item.evidence.ruleSetRef;
  if (typeof ref !== 'object' || ref === null || !('kind' in ref) || ref.kind !== 'scoped' ||
      !('id' in ref) || typeof ref.id !== 'string' || !/^[a-f0-9]{64}$/.test(ref.id) ||
      !('scope' in ref) || typeof ref.scope !== 'object' || ref.scope === null ||
      !('spaceId' in ref.scope) || ref.scope.spaceId !== scope.spaceId ||
      !('budgetId' in ref.scope) || ref.scope.budgetId !== scope.budgetId ||
      !('connectionId' in ref.scope) || typeof ref.scope.connectionId !== 'string' || !ref.scope.connectionId.trim() ||
      (scope.connectionId !== undefined && ref.scope.connectionId !== scope.connectionId) ||
      typeof item.evidence.sourceRevision !== 'string' || !item.evidence.sourceRevision) return false;
  const metadata = store.getReviewRuleSetMetadata(ref.id);
  return metadata?.kind === 'scoped' && metadata.scope.spaceId === ref.scope.spaceId &&
    metadata.scope.budgetId === ref.scope.budgetId && metadata.scope.connectionId === ref.scope.connectionId;
}

export function matchesReviewTransaction(
  item: ReviewItem,
  transaction: Pick<CanonicalReviewSourceTransaction, 'id' | 'accountId' | 'categoryId' | 'amount'>,
): boolean {
  const source = item.sourceTransaction;
  if (!source) return false;
  const signed = BigInt(transaction.amount.minorUnits);
  return source.id === transaction.id && source.accountId === transaction.accountId &&
    source.categoryId === (transaction.categoryId ?? null) &&
    source.direction === (signed < 0n ? 'outgoing' : 'incoming') &&
    source.amount.currency === transaction.amount.currency &&
    source.amount.minorUnits === (signed < 0n ? -signed : signed).toString();
}

/** Rebind disclosure to the same immutable Review generation after source awaits. */
export async function refreshReviewItems(store: WorkflowStore, items: readonly ReviewItem[]): Promise<ReviewItem[]> {
  const current = await Promise.all(items.map((item) => store.getReviewItem(item.id)));
  return items.flatMap((item, index) => {
    const latest = current[index];
    return latest && latest.version === item.version && latest.evidence.sourceRevision === item.evidence.sourceRevision
      ? [latest] : [];
  });
}

type SelectedSpace = Extract<SelectedSpaceResult, { readonly ok: true }>;
type ReviewOperation = 'set_category' | 'create_rule' | 'reject_review' | 'skip_review' | 'undo_review';

/** Checks exact persisted review facts before any config or ledger access. */
export function hasReviewScopeAdmission(input: {
  readonly store: WorkflowStore;
  readonly selected: SelectedSpace;
  readonly item: ReviewItem;
  readonly capability: 'categorization:execute' | 'categorization:propose' | 'rule:propose';
  readonly phase: 'read' | 'propose';
  readonly operation: ReviewOperation;
  readonly policyVersion: string;
  readonly targetCategoryId?: string;
  readonly connectionId?: string;
  readonly now?: string;
}): boolean {
  const { store, selected, item, capability, phase, operation, policyVersion } = input;
  const source = item.sourceTransaction;
  const targetCategoryId = input.targetCategoryId ?? item.categoryId;
  const budgetId = selected.space.budgetId;
  if (!budgetId || !hasCurrentReviewNamespace(store, item, {
    spaceId: selected.space.id, budgetId, ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
  })) return false;
  if (
    !budgetId || item.budgetId !== budgetId || !source ||
    source.id !== item.transactionId || !source.accountId.trim() ||
    (source.categoryId !== null && !source.categoryId.trim()) ||
    (item.categoryId !== '' && !item.categoryId.trim()) ||
    (targetCategoryId !== '' && !targetCategoryId.trim()) ||
    ((operation === 'set_category' || operation === 'create_rule') && !targetCategoryId) ||
    !/^(0|[1-9]\d*)$/.test(source.amount.minorUnits) ||
    !source.amount.currency.trim()
  ) return false;

  const refs: GovernanceResourceRef[] = [
    { resourceKind: 'budget', resourceId: budgetId },
    { resourceKind: 'transaction', resourceId: source.id },
    { resourceKind: 'account', resourceId: source.accountId },
  ];
  if (source.categoryId)
    refs.push({ resourceKind: 'category', resourceId: source.categoryId });
  if (item.categoryId && item.categoryId !== source.categoryId)
    refs.push({ resourceKind: 'category', resourceId: item.categoryId });
  if (
    targetCategoryId &&
    targetCategoryId !== source.categoryId &&
    targetCategoryId !== item.categoryId
  )
    refs.push({ resourceKind: 'category', resourceId: targetCategoryId });

  const auth = selected.auth;
  const operations = operation === 'create_rule'
    ? [{ operation, accountScope: { kind: 'global' as const } }]
    : [{
        operation,
        transactionId: source.id,
        accountId: source.accountId,
        ...(targetCategoryId ? { categoryId: targetCategoryId } : {}),
        direction: source.direction,
        amount: source.amount,
      }];
  try {
    return store.governance.authorize({
      actorId: auth.actorId,
      auth,
      spaceId: selected.space.id,
      membershipId: selected.membership.id,
      expectedPolicyVersion: policyVersion,
      phase,
      operation,
      required: refs.map((ref) => ({ ...ref, capability, visibility: 'resource' as const })),
      payload: {
        operations,
        resources: refs,
        ...(operation === 'create_rule' ? {} : { currentTransaction: { categoryId: source.categoryId } }),
      },
      now: input.now ?? new Date().toISOString(),
      ...(auth.method === 'api-key' && auth.principalType === 'agent' ? {
        agentId: auth.actorId,
        delegationId: auth.delegationId,
        delegationVersion: auth.delegationVersion,
      } : {}),
    }).allowed;
  } catch {
    return false;
  }
}

/** Preserves review projection field privacy before opening a private ledger. */
export function hasReviewProjectionAdmission(input: {
  readonly store: WorkflowStore;
  readonly actor: LiquidityActor;
  readonly item: ReviewItem;
  readonly targetCategoryId?: string;
}): boolean {
  const { store, actor, item } = input;
  if (!actor.spaceId || !hasCurrentReviewNamespace(store, item, { spaceId: actor.spaceId, budgetId: actor.budgetId })) return false;
  const source = item.sourceTransaction;
  if (
    !source || item.budgetId !== actor.budgetId ||
    source.id !== item.transactionId || !source.accountId.trim() ||
    (source.categoryId !== null && !source.categoryId.trim()) ||
    (item.categoryId !== '' && !item.categoryId.trim())
  ) return false;

  const currentActor = { ...actor, now: new Date().toISOString() };
  const allowed = (resourceKind: 'account' | 'category', resourceId: string, capability: string) =>
    store.liquidity.isAuthorized({ ...currentActor, resourceKind, resourceId, capability });
  if (
    !allowed('account', source.accountId, 'existence') ||
    !allowed('account', source.accountId, 'history') ||
    (item.categoryId !== '' && !allowed('category', item.categoryId, 'existence')) ||
    (input.targetCategoryId !== undefined &&
      !allowed('category', input.targetCategoryId, 'existence'))
  ) return false;
  return true;
}
