import type {
  GovernanceResourceRef,
  LiquidityActor,
  ReviewItem,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import type { SelectedSpaceResult } from './space-context';

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
  readonly now?: string;
}): boolean {
  const { store, selected, item, capability, phase, operation, policyVersion } = input;
  const source = item.sourceTransaction;
  const targetCategoryId = input.targetCategoryId ?? item.categoryId;
  const budgetId = selected.space.budgetId;
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
  const source = item.sourceTransaction;
  if (
    !source || item.budgetId !== actor.budgetId ||
    source.id !== item.transactionId || !source.accountId.trim() ||
    (source.categoryId !== null && !source.categoryId.trim()) ||
    (item.categoryId !== '' && !item.categoryId.trim())
  ) return false;

  const allowed = (resourceKind: 'account' | 'category', resourceId: string, capability: string) =>
    store.liquidity.isAuthorized({ ...actor, resourceKind, resourceId, capability });
  if (
    !allowed('account', source.accountId, 'existence') ||
    !allowed('account', source.accountId, 'history') ||
    (item.categoryId !== '' && !allowed('category', item.categoryId, 'existence')) ||
    (input.targetCategoryId !== undefined &&
      !allowed('category', input.targetCategoryId, 'existence'))
  ) return false;
  return true;
}
