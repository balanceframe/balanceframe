import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { ResourceCapability } from '@balanceframe/workflow-store';
import type * as Workflow from '../../server/utils/workflow-store';
import type * as H3 from 'h3';
import patchHandler from '../../server/api/rule/[id].patch';
import removeHandler from '../../server/api/rule/[id].delete';

const { withConnection, loadConfig } = vi.hoisted(() => ({
  withConnection: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig, withConnection }),
}));
vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: () => ({ loadConfig, withConnection }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
interface RequestEvent extends EventWithContext {
  body: unknown;
  node: { req: { headers: Record<string, string> }; res: TestResponse };
  context: EventWithContext['context'] & {
    params: { id: string };
    auth: NonNullable<EventWithContext['context']['auth']>;
    runtimeConfig: { workflowDbPath: string; devBypassAuth: false };
  };
}
type Handler = (event: RequestEvent) => Promise<Workflow.ApiEnvelope<Record<string, unknown>>>;
const patch = patchHandler as unknown as Handler;
const remove = removeHandler as unknown as Handler;

const actorId = 'rule-editor';
const ownerId = 'rule-space-owner';
let budgetId = '';
const now = '2098-01-01T12:00:00.000Z';
let fixtureSequence = 0;
let bootstrapped = false;
let actualVersion = '';
const controlAuth = {
  method: 'human-session' as const,
  actorId: ownerId,
  sessionId: `session:${ownerId}`,
  reauthenticatedAt: now,
};
const normalizedRule = {
  id: 'rule-one',
  name: 'Merchant category',
  order: 1,
  trigger: [{ field: 'category_group', op: 'is', value: 'food-group' }],
  actions: [{ op: 'set', field: 'category', value: 'food' }],
  inactive: false,
  stage: null,
  conditionsOp: 'and' as const,
};
const BASE_COMPOSITE = {
  operations: [],
  reallocations: [],
  transferRecommendations: [],
  ledgerProjections: [],
  evidenceReferences: [],
};

type TestRule = Omit<typeof normalizedRule, 'trigger'> & { trigger: unknown[] };

let store: SqliteWorkflowStore;
let spaceId: string;
let membershipId: string;
let rules: TestRule[];
const ledger = {
  listRules: vi.fn(async () => rules.map((rule) => structuredClone(rule))),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  getRuleCategoryGroupMembers: vi.fn(async () => ({ 'food-group': ['food'] })),
};

function event(body: unknown = undefined, id = 'rule-one'): RequestEvent {
  const responseHeaders = new Map<string, string | string[]>();
  const response: TestResponse = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return responseHeaders.get(name.toLowerCase());
    },
    removeHeader(name) {
      responseHeaders.delete(name.toLowerCase());
    },
  };
  return {
    body,
    node: {
      req: {
        headers: {
          origin: 'https://balanceframe.example.test',
          'x-balanceframe-space': spaceId,
        },
      },
      res: response,
    },
    context: {
      params: { id },
      auth: {
        authenticated: true,
        actorId,
        principalType: 'human',
        method: 'session',
        sessionId: `session:${actorId}`,
        user: { id: actorId },
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  } as RequestEvent;
}

function provisionGrant(
  capability: ResourceCapability,
  resourceKind: 'budget' | 'rule' | 'category' | 'account',
  resourceId: string,
) {
  return store.governance.provisionResourceGrant({
    spaceId,
    actorId,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now,
    auth: controlAuth,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  spaceId = '';
  budgetId = `rule-space-budget-${++fixtureSequence}`;
  actualVersion = `actual-rule-version-${fixtureSequence}`;
  const provider = getWorkflowStore(event() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'rule-route-fixture' });
    await store.finalizeBootstrap({ claimId: 'rule-route-fixture', ownerUserId: ownerId });
    bootstrapped = true;
  }
  await store.upsertActorMembership(actorId, 'active', [], '');
  const space = store.governance.createSpace({
    actorId: ownerId,
    name: `Rule route selected space ${fixtureSequence}`,
    kind: 'shared',
    now,
    auth: controlAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now, auth: controlAuth });
  if (!store.governance.getPolicy({ spaceId })) {
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now,
      auth: controlAuth,
    });
  }
  const membership = store.governance.addMembership({
    spaceId,
    actorId,
    validFrom: now,
    now,
    auth: controlAuth,
  });
  membershipId = membership.id;
  for (const [kind, id] of [
    ['budget', budgetId],
    ['rule', normalizedRule.id],
    ['category', 'food'],
  ] as const) {
    await provisionGrant('rule:propose', kind, id);
  }
  for (const capability of ['observe', 'full-read'] as const)
    await provisionGrant(capability, 'budget', budgetId);

  rules = [structuredClone(normalizedRule)];
  loadConfig.mockResolvedValue({ budgetId });
  withConnection.mockImplementation(async (operation) => operation({
    config: { budgetId },
    budget: { id: budgetId },
    connector: ledger,
    synchronization: {
      snapshot: {
        schemaVersion: '1',
        actualVersion,
        snapshotDate: now,
        actualDownloadedAt: now,
        bankSyncedAt: null,
        encrypted: false,
        unlocked: true,
      },
      financialSnapshot: {
        legacySnapshot: {
          accounts: [{ id: 'rule-account', name: 'Checking' }],
          categories: [{ id: 'food', name: 'Food' }],
          transactions: [],
        },
      },
    },
  }));
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(() => store.close());

describe('governed rule proposal routes', () => {
  it.each(['update', 'delete'] as const)('never releases private %s proposal fields admitted before SDK cleanup revokes only full-read', async (mutation) => {
    const connect = withConnection.getMockImplementation();
    if (!connect) throw new Error('Rule fixture lifecycle unavailable');
    withConnection.mockImplementationOnce(async (operation, options) => {
      const response = await connect(operation, options);
      store.governance.setResourceGrant({
        spaceId, budgetId, actorId, membershipId, capability: 'full-read',
        resourceKind: 'budget', resourceId: budgetId, granted: false, now, auth: controlAuth,
      });
      return response;
    });
    const response = mutation === 'update' ? await patch(event({ inactive: true })) : await remove(event());
    const proposal = response.result?.proposal;
    if (proposal && typeof proposal === 'object')
      expect(proposal).toMatchObject({ payload: null, preconditions: null });
    else expect(response.result).toBeNull();
    expect(store.liquidity.isAuthorized({
      actorId, budgetId, spaceId, membershipId, now,
      governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
      auth: { method: 'session', actorId, sessionId: `session:${actorId}` },
      resourceKind: 'budget', resourceId: budgetId, capability: 'rule:propose',
    })).toBe(true);
    expect(ledger.updateRule).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
  });

  it('requires exact selected-space rule and budget proposal grants before reading rule fields', async () => {
    store.governance.setResourceGrant({
      spaceId,
      actorId,
      membershipId,
      budgetId,
      capability: 'rule:propose',
      resourceKind: 'rule',
      resourceId: normalizedRule.id,
      granted: false,
      now,
      auth: controlAuth,
    });

    const response = await patch(event({ inactive: true }));

    expect(response.status).toBe('error');
    expect(withConnection).not.toHaveBeenCalled();
    expect(ledger.listRules).not.toHaveBeenCalled();
    expect(ledger.updateRule).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it.each(['update_rule', 'delete_rule'] as const)(
    'preserves Native exact account scope for %s proposals',
    async (operation) => {
      const scopedRule = {
        ...normalizedRule,
        trigger: [
          { field: 'account', op: 'is', value: 'rule-account' },
          { field: 'payee_name', op: 'is', value: 'Market' },
        ],
        conditionsOp: 'and' as const,
      };
      rules = [structuredClone(scopedRule)];
      provisionGrant('rule:propose', 'account', 'rule-account');
      for (const [kind, id] of [
        ['budget', budgetId],
        ['rule', normalizedRule.id],
      ] as const)
        store.governance.setResourceGrant({
          spaceId,
          actorId,
          membershipId,
          budgetId,
          capability: 'rule:propose',
          resourceKind: kind,
          resourceId: id,
          granted: true,
          restrictions: {
            accountIds: ['rule-account'],
            operations: [operation],
            proposalOnly: true,
            maxOperationCount: 1,
          },
          now,
          auth: controlAuth,
        });
      store.governance.setResourceGrant({
        spaceId,
        actorId,
        membershipId,
        budgetId,
        capability: 'full-read',
        resourceKind: 'budget',
        resourceId: budgetId,
        granted: false,
        now,
        auth: controlAuth,
      });
      const request = operation === 'update_rule'
        ? event({ inactive: true })
        : event(undefined);
      const response = operation === 'update_rule'
        ? await patch(request)
        : await remove(request);

      expect(response.status).toBe('ok');
      expect(response.error).toBeNull();
      const proposalView = response.result.proposal as Record<string, unknown>;
      expect(proposalView).toMatchObject({
        operation,
        privateEnvelopeVisible: false,
        payload: null,
        preconditions: null,
      });
      const persisted = await store.getProposal(proposalView.id as string);
      expect(JSON.parse(persisted!.preconditions)).toMatchObject({ rule: scopedRule });
      expect(loadConfig).toHaveBeenCalledOnce();
      expect(ledger.listRules).toHaveBeenCalledOnce();
      expect(ledger.updateRule).not.toHaveBeenCalled();
      expect(ledger.deleteRule).not.toHaveBeenCalled();
    },
  );

  it('correlates private rule inspection audit with the trusted response request', async () => {
    const request = event({ inactive: true });
    request.node.req.headers['x-balanceframe-request-id'] = 'untrusted-request-correlation';

    const response = await patch(request);

    expect(response.status).toBe('ok');
    expect(response.requestId).not.toBe('untrusted-request-correlation');
    expect(request.node.res.getHeader('X-BalanceFrame-Request-ID')).toBe(response.requestId);
    const records = await store.queryAuditRecords('authorization_check', 100);
    const inspection = records.find((record) => {
      const result = JSON.parse(record.result) as Record<string, unknown>;
      return record.requestId === response.requestId &&
        record.operation === 'update_rule' &&
        result.resourceKind === 'rule' &&
        result.resourceId === normalizedRule.id;
    });
    expect(inspection).toMatchObject({
      actorId,
      budgetId,
      requestId: response.requestId,
      correlationId: response.requestId,
      policyVersion: store.governance.getPolicy({ spaceId })!.version,
    });
    expect(JSON.parse(inspection!.result)).toMatchObject({
      spaceId,
      membershipId,
      capability: 'rule:propose',
    });
    expect(JSON.stringify(inspection)).not.toContain(normalizedRule.name);
    expect(JSON.stringify(inspection)).not.toContain(`session:${actorId}`);
  });

  it.each([
    ['zero budget operation allowance', 'budget', {
      accountIds: ['rule-account'],
      operations: ['update_rule'],
      proposalOnly: true,
      maxOperationCount: 0,
    }],
    ['wrong budget operation allowance', 'budget', {
      accountIds: ['rule-account'],
      operations: ['delete_rule'],
      proposalOnly: true,
      maxOperationCount: 1,
    }],
    ['zero rule operation allowance', 'rule', {
      accountIds: ['rule-account'],
      operations: ['update_rule'],
      proposalOnly: true,
      maxOperationCount: 0,
    }],
    ['wrong rule operation allowance', 'rule', {
      accountIds: ['rule-account'],
      operations: ['delete_rule'],
      proposalOnly: true,
      maxOperationCount: 1,
    }],
  ] as const)('denies scoped update proposals with %s before proposal output', async (_name, resourceKind, restrictions) => {
    const scopedRule = {
      ...normalizedRule,
      trigger: [
        { field: 'account', op: 'is', value: 'rule-account' },
        { field: 'payee_name', op: 'is', value: 'Market' },
      ],
      conditionsOp: 'and' as const,
    };
    rules = [structuredClone(scopedRule)];
    provisionGrant('rule:propose', 'account', 'rule-account');
    store.governance.setResourceGrant({
      spaceId,
      actorId,
      membershipId,
      budgetId,
      capability: 'rule:propose',
      resourceKind,
      resourceId: resourceKind === 'budget' ? budgetId : normalizedRule.id,
      granted: true,
      restrictions,
      now,
      auth: controlAuth,
    });
    const before = (await store.listProposals()).map(({ id }) => id).sort();

    const response = await patch(event({ inactive: true }));

    expect(response.status).toBe('error');
    expect((await store.listProposals()).map(({ id }) => id).sort()).toEqual(before);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(withConnection).not.toHaveBeenCalled();
    expect(ledger.listRules).not.toHaveBeenCalled();
    expect(ledger.updateRule).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
  });

  it('conceals an inaccessible rule baseline like an unknown rule before private reads', async () => {
    store.governance.setResourceGrant({
      spaceId,
      actorId,
      membershipId,
      budgetId,
      capability: 'rule:propose',
      resourceKind: 'rule',
      resourceId: normalizedRule.id,
      granted: false,
      now,
      auth: controlAuth,
    });
    store.governance.setResourceGrant({
      spaceId,
      actorId,
      membershipId,
      budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now,
      auth: controlAuth,
    });
    const inaccessibleEvent = event({ inactive: true });
    const inaccessible = await patch(inaccessibleEvent);
    const unknownEvent = event({ inactive: true }, 'unknown-rule');
    const unknown = await patch(unknownEvent);

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
      authorization: inaccessible.authorization,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
      authorization: unknown.authorization,
    });
    expect(inaccessibleEvent.node.res.statusCode).toBe(403);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(withConnection).not.toHaveBeenCalled();
    expect(ledger.listRules).not.toHaveBeenCalled();
  });

  it('creates a pending BalanceFrame pause proposal from complete current rule and override facts', async () => {
    const currentOverride = await store.setRuleOverride({
      spaceId,
      budgetId,
      ruleId: normalizedRule.id,
      inactive: false,
      expectedVersion: null,
    });

    const response = await patch(event({ inactive: true }));
    expect(response.error).toBeNull();
    expect(response.status).toBe('ok');
    expect(withConnection).toHaveBeenCalledWith(expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
    });
    const pending = response.result;
    const proposal = pending.proposal as Record<string, unknown>;
    const preconditions = proposal.preconditions as Record<string, unknown>;

    expect(pending).toMatchObject({ state: 'approval_required', applied: false, verified: false });
    expect(proposal).toMatchObject({
      operation: 'update_rule',
      payload: { kind: 'update_rule', ruleId: normalizedRule.id, inactive: true },
    });
    expect(preconditions.rule).toEqual(normalizedRule);
    expect(preconditions.categoryGroupMembers).toEqual({ 'food-group': ['food'] });
    expect(preconditions.override).toEqual(currentOverride);
    expect(preconditions.actualVersion).toBe(actualVersion);
    expect(Object.keys(preconditions.rule as Record<string, unknown>).sort()).toEqual([
      'actions', 'conditionsOp', 'id', 'inactive', 'name', 'order', 'stage', 'trigger',
    ]);
    expect(proposal.payload).toMatchObject({ composite: BASE_COMPOSITE });
    expect(ledger.listRules).toHaveBeenCalledTimes(1);
    expect(ledger.updateRule).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(await store.getRuleOverride({ spaceId, budgetId, ruleId: normalizedRule.id })).toEqual(currentOverride);
  });
  it.each(['oneOf', 'notOneOf'] as const)(
    'captures complete group membership for the Actual category-group %s predicate',
    async (op) => {
      const trigger = [{ field: 'category_group', op, value: ['food-group', 'home-group'] }];
      const members = { 'food-group': ['food'], 'home-group': ['transport'] };
      await provisionGrant('rule:propose', 'category', 'transport');
      rules = [{ ...normalizedRule, trigger }];
      ledger.getRuleCategoryGroupMembers.mockResolvedValueOnce(members);

      const response = await patch(event({ inactive: true }));

      expect(response.status).toBe('ok');
      const proposal = response.result.proposal as Record<string, unknown>;
      const preconditions = proposal.preconditions as Record<string, unknown>;
      expect(preconditions.rule).toMatchObject({ trigger });
      expect(preconditions.categoryGroupMembers).toEqual(members);
      expect(ledger.getRuleCategoryGroupMembers).toHaveBeenCalledTimes(1);
      expect(ledger.updateRule).not.toHaveBeenCalled();
      expect(ledger.deleteRule).not.toHaveBeenCalled();
    },
  );

  it.each(['contains', 'doesNotContain', 'matches'] as const)(
    'does not look up a category-group name pattern for %s',
    async (op) => {
      rules = [{
        ...normalizedRule,
        trigger: [{ field: 'category_group', op, value: 'Household' }],
      }];

      const response = await patch(event({ inactive: true }));

      expect(response.status).toBe('ok');
      const preconditions = response.result.proposal.preconditions as Record<string, unknown>;
      expect(preconditions.categoryGroupMembers).toBeUndefined();
      expect(ledger.getRuleCategoryGroupMembers).not.toHaveBeenCalled();
    },
  );


  it('creates a pending resume proposal without clearing the current override', async () => {
    const currentOverride = await store.setRuleOverride({
      spaceId,
      budgetId,
      ruleId: normalizedRule.id,
      inactive: true,
      expectedVersion: null,
    });

    const response = await patch(event({ inactive: false }));
    expect(response.status).toBe('ok');
    const pending = response.result;
    const proposal = pending.proposal as Record<string, unknown>;
    const preconditions = proposal.preconditions as Record<string, unknown>;

    expect(pending).toMatchObject({ state: 'approval_required', applied: false, verified: false });
    expect(proposal).toMatchObject({
      operation: 'update_rule',
      payload: { kind: 'update_rule', ruleId: normalizedRule.id, inactive: false },
    });
    expect(preconditions.rule).toEqual(normalizedRule);
    expect(preconditions.override).toEqual(currentOverride);
    expect(ledger.updateRule).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(await store.getRuleOverride({ spaceId, budgetId, ruleId: normalizedRule.id })).toEqual(currentOverride);
  });

  it('creates a pending Actual deletion proposal without deleting the rule or clearing its override', async () => {
    const currentOverride = await store.setRuleOverride({
      spaceId,
      budgetId,
      ruleId: normalizedRule.id,
      inactive: true,
      expectedVersion: null,
    });

    const response = await remove(event());
    expect(response.status).toBe('ok');
    const pending = response.result;
    const proposal = pending.proposal as Record<string, unknown>;
    const preconditions = proposal.preconditions as Record<string, unknown>;

    expect(pending).toMatchObject({ state: 'approval_required', applied: false, verified: false });
    expect(proposal).toMatchObject({
      operation: 'delete_rule',
      payload: { kind: 'delete_rule', ruleId: normalizedRule.id },
    });
    expect(preconditions.rule).toEqual(normalizedRule);
    expect(preconditions.categoryGroupMembers).toEqual({ 'food-group': ['food'] });
    expect(preconditions.actualVersion).toBe(actualVersion);
    expect(Object.keys(preconditions.rule as Record<string, unknown>).sort()).toEqual([
      'actions', 'conditionsOp', 'id', 'inactive', 'name', 'order', 'stage', 'trigger',
    ]);
    expect(proposal.payload).toMatchObject({ composite: BASE_COMPOSITE });
    expect(preconditions.override).toEqual(currentOverride);
    expect(ledger.listRules).toHaveBeenCalledTimes(1);
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(await store.getRuleOverride({ spaceId, budgetId, ruleId: normalizedRule.id })).toEqual(currentOverride);
  });
  it('records an explicit null override snapshot when none exists', async () => {
    const response = await remove(event());

    expect(response.status).toBe('ok');
    const proposal = response.result.proposal as Record<string, unknown>;
    const preconditions = proposal.preconditions as Record<string, unknown>;
    expect(preconditions.override).toBeNull();
    expect(await store.getRuleOverride({ spaceId, budgetId, ruleId: normalizedRule.id })).toBeNull();
  });

  it('rejects unresolved category-group members instead of guessing a partial set', async () => {
    ledger.getRuleCategoryGroupMembers.mockResolvedValueOnce({});
    const response = await patch(event({ inactive: true }));

    expect(response.status).toBe('error');
    expect(await store.countProposals({ budgetId, operations: ['update_rule'] })).toBe(0);
  });


  it('rejects non-canonical mutation bodies before opening a ledger connection', async () => {
    const update = await patch(event({ inactive: true, spaceId }));
    const deletion = await remove(event({ ruleId: normalizedRule.id }));

    expect(update.status).toBe('error');
    expect(deletion.status).toBe('error');
    expect(withConnection).not.toHaveBeenCalled();
    expect(ledger.listRules).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('fails closed when the Actual rule lacks its complete stage/operator snapshot', async () => {
    const incomplete = structuredClone(normalizedRule);
    Reflect.deleteProperty(incomplete, 'stage');
    Reflect.deleteProperty(incomplete, 'conditionsOp');
    rules = [incomplete];

    const response = await patch(event({ inactive: false }));

    expect(response.status).toBe('error');
    expect(ledger.updateRule).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(await store.countProposals({ budgetId, operations: ['update_rule'] })).toBe(0);
  });

});
