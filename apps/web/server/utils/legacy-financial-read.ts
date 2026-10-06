import { createDefaultConnectionManager, indexCanonicalTransactions } from '@balanceframe/application';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { moneySchema } from '@balanceframe/protocol-generated/validators';
import type { GovernanceOperation, LiquidityActor, WorkflowStore } from '@balanceframe/workflow-store';
import { setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import { errorEnvelope, getActorId, getWorkflowStore, recordReadAdmission } from './workflow-store';
import type { ApiEnvelope, AuthorizationInfo, EventWithContext } from './workflow-store';
import { requireSelectedSpace } from './space-context';

export type LegacyFinancialReadGuard =
  | { ok: true; info: AuthorizationInfo; budgetId: string; spaceId: string; actor: LiquidityActor }
  | { ok: false; response: ApiEnvelope<null> };


/** Rechecks live whole-budget rights and complete disclosure caps synchronously for atomic publication. */
export function hasLegacyFullRead(
  store: WorkflowStore,
  actor: LiquidityActor,
  operations?: readonly GovernanceOperation[],
): boolean {
  if (!actor.spaceId || !actor.auth || !actor.governancePolicyVersion) return false;
  const { governance } = store;
  if (governance.getSpace({ spaceId: actor.spaceId })?.budgetId !== actor.budgetId) return false;
  const auth = actor.auth;
  const delegation = auth.method === 'api-key' && auth.principalType === 'agent'
    ? governance.listDelegations({ spaceId: actor.spaceId, agentId: actor.actorId }).find((entry) =>
        entry.id === auth.delegationId && entry.version === auth.delegationVersion && !entry.revokedAt)
    : undefined;
  const grantActorId = delegation?.issuerActorId ?? actor.actorId;
  const membershipId = delegation?.issuerMembershipId ?? actor.membershipId;
  const grants = governance.listResourceGrants({ spaceId: actor.spaceId, actorId: grantActorId });
  const capabilities = ['observe', 'full-read'];
  if (!capabilities.every((capability) => {
    const grant = grants.find((entry) => entry.granted && !entry.revokedAt &&
      entry.membershipId === membershipId && entry.budgetId === actor.budgetId &&
      entry.resourceKind === 'budget' && entry.resourceId === actor.budgetId && entry.capability === capability);
    const restrictions = grant?.restrictions;
    if (!grant || restrictions?.aggregateOnly || restrictions?.accountIds || restrictions?.categoryIds) return false;
    const delegated = delegation?.rights.find((right) => right.capability === capability &&
      right.resourceKind === 'budget' && right.resourceId === actor.budgetId)?.restrictions;
    return !delegated?.aggregateOnly && !delegated?.accountIds && !delegated?.categoryIds;
  })) return false;
  const result = governance.authorize({
    actorId: actor.actorId, spaceId: actor.spaceId, membershipId: actor.membershipId,
    expectedPolicyVersion: actor.governancePolicyVersion, auth, phase: 'read', operation: 'full-read',
    required: capabilities.map((capability) => ({
      capability, resourceKind: 'budget' as const, resourceId: actor.budgetId, visibility: 'resource' as const,
    })),
    payload: { operations: operations ?? [] }, now: new Date().toISOString(),
    ...(auth.method === 'api-key' && auth.principalType === 'agent'
      ? { agentId: actor.actorId, delegationId: auth.delegationId, delegationVersion: auth.delegationVersion }
      : {}),
  });
  return result.allowed && result.disposition.kind === 'authorized_without_approval';
}

const FinancialReadMoney = moneySchema.strict();

/** A checked numeric slot; balances count but only actual outflows consume gross-outgoing limits. */
export function financialReadMoneyOperation(
  value: unknown,
  role: 'balance' | 'directional' | 'outgoing',
  identity: Pick<GovernanceOperation, 'accountId' | 'categoryId' | 'transactionId'> = {},
): GovernanceOperation {
  const money = FinancialReadMoney.parse(value);
  if (role === 'balance') return { operation: 'full-read', ...identity };
  const signed = BigInt(money.minorUnits);
  if (role === 'outgoing' && signed < 0n) throw new Error('Negative outgoing financial disclosure');
  const amount = moneySchema.parse({ ...money, minorUnits: (signed < 0n ? -signed : signed).toString() });
  return {
    operation: 'full-read', ...identity, amount,
    direction: role === 'outgoing' || signed < 0n ? 'outgoing' : 'incoming',
  };
}

/** Admit every Money occurrence in the captured source, without charging split parents as extra outflows. */
export function financialSourceReadOperations(source: ProtocolSnapshot): GovernanceOperation[] {
  const operations: GovernanceOperation[] = [];
  for (const account of source.accounts) {
    for (const money of [account.clearedBalance, account.importedBalance])
      operations.push(financialReadMoneyOperation(money, 'balance', { accountId: account.id }));
  }
  for (const transaction of indexCanonicalTransactions(source.transactions).values()) {
    const children = transaction.subtransactions;
    if (children.length > 0 && (children.some((child) => child.accountId !== transaction.accountId ||
        child.amount.currency !== transaction.amount.currency) ||
        children.reduce((sum, child) => sum + BigInt(child.amount.minorUnits), 0n) !== BigInt(transaction.amount.minorUnits)))
      throw new Error('Incomplete financial split source');
    operations.push(financialReadMoneyOperation(transaction.amount, children.length > 0 ? 'balance' : 'directional', {
      transactionId: transaction.id, accountId: transaction.accountId,
      ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}),
    }));
  }
  for (const month of source.budgets) {
    for (const category of Object.values(month.categories)) {
      for (const money of [category.amount, category.carryover, category.carryoverFromPrevious])
        operations.push(financialReadMoneyOperation(money, 'balance', { categoryId: category.categoryId }));
    }
  }
  for (const schedule of source.schedules)
    operations.push(financialReadMoneyOperation(schedule.amount, 'directional', { accountId: schedule.accountId }));
  const inspectRule = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) inspectRule(child);
    } else if (value !== null && typeof value === 'object') {
      if ('minorUnits' in value || 'currency' in value) throw new Error('Unknown financial rule Money role');
      for (const child of Object.values(value)) inspectRule(child);
    }
  };
  for (const rule of source.rules) {
    inspectRule(rule.trigger);
    inspectRule(rule.actions);
  }
  return operations;
}

/** Derives selected-budget metadata before restoring a connection or reading private financial records. */
export async function requireFullRead(event: EventWithContext): Promise<LegacyFinancialReadGuard> {
  const selected = await requireSelectedSpace(event);
  if (!selected.ok) return selected;
  const workflow = getWorkflowStore(event);
  if ('error' in workflow) {
    setResponseStatus(event as H3Event, 503);
    return { ok: false, response: errorEnvelope('STORE_UNAVAILABLE', 'Financial data is unavailable.', null, true) };
  }
  const budgetId = selected.space.budgetId;
  const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
  const actor: LiquidityActor = {
    actorId: selected.auth.actorId, budgetId: budgetId ?? '', spaceId: selected.space.id,
    membershipId: selected.membership.id, governancePolicyVersion: policy?.version,
    auth: selected.auth, now: new Date().toISOString(),
  };
  if (!budgetId || !hasLegacyFullRead(workflow.store, actor)) {
    setResponseStatus(event as H3Event, 403);
    return { ok: false, response: errorEnvelope('FORBIDDEN', 'Full financial read is not authorized.', null) };
  }
  try {
    const manager = createDefaultConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
    const config = await manager.loadConfig();
    if (config?.budgetId !== budgetId) throw new Error('Selected space connection mismatch');
    await recordReadAdmission(event, workflow.store, {
      actorId: actor.actorId, spaceId: selected.space.id, membershipId: selected.membership.id,
      budgetId, policyVersion: policy!.version, capability: 'full-read', resourceKind: 'budget',
      resourceId: budgetId, operation: 'full-read', phase: 'read', auth: selected.auth,
    });
    return {
      ok: true,
      info: { actorId: actor.actorId, capability: 'full-read', allowed: true },
      budgetId,
      spaceId: selected.space.id,
      actor,
    };
  } catch {
    setResponseStatus(event as H3Event, 503);
    return {
      ok: false,
      response: errorEnvelope(
        'FINANCIAL_READ_UNAVAILABLE',
        'Financial data is unavailable.',
        null,
        true,
      ),
    };
  }
}

/** Server-wide budget discovery crosses budgets and is restricted to the actual active registered owner, including first setup. */
export async function requireRegisteredOwner(
  event: EventWithContext,
): Promise<{ ok: true; info: AuthorizationInfo } | { ok: false; response: ApiEnvelope<null> }> {
  const auth = event.context.auth;
  if (
    auth?.authenticated &&
    ((typeof auth.user?.id === 'string' && auth.user.id.length > 0) ||
      (typeof auth.actorId === 'string' && auth.actorId.length > 0))
  ) {
    try {
      const workflow = getWorkflowStore(event);
      if (!('error' in workflow)) {
        const actorId = getActorId(event);
        const [registration, membership] = await Promise.all([
          workflow.store.getRegistrationState(),
          workflow.store.getActorMembership(actorId),
        ]);
        if (registration.ownerUserId === actorId && membership?.status === 'active')
          return {
            ok: true,
            info: { actorId, capability: 'owner:financial-discovery', allowed: true },
          };
      }
    } catch {
      // The same public denial covers absent or unreadable authorization state.
    }
  }
  setResponseStatus(event as H3Event, 403);
  return {
    ok: false,
    response: errorEnvelope('FORBIDDEN', 'Budget discovery is not authorized.', null),
  };
}
