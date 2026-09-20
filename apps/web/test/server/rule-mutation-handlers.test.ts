import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type * as Workflow from '../../server/utils/workflow-store';
import type * as H3 from 'h3';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: () => ({ withConnection: connect }),
}));
interface RequestEvent {
  body: unknown;
  node: { res: { statusCode: number; statusMessage: string } };
  context: {
    params: { id: string };
    auth: { authenticated: boolean; actorId: string };
    runtimeConfig: { workflowDbPath: string };
  };
}
type Handler = (event: RequestEvent) => Promise<Workflow.ApiEnvelope<Record<string, unknown>>>;
let workflow: typeof Workflow;
let store: SqliteWorkflowStore;
let patch: Handler;
let remove: Handler;
let rules: Array<{ id: string; inactive: boolean }>;
const ledger = {
  listRules: vi.fn(async () => rules.map((rule) => ({ ...rule }))),
  updateRule: vi.fn(async (id: string, fields: { inactive: boolean }) => {
    const rule = rules.find((entry) => entry.id === id);
    if (!rule) return { success: false };
    rule.inactive = fields.inactive;
    return { success: true };
  }),
  deleteRule: vi.fn(async (id: string) => {
    rules = rules.filter((rule) => rule.id !== id);
    return { success: true };
  }),
  synchronize: vi.fn(async () => {}),
};
function event(body: unknown = { inactive: true }, id = 'rule-one'): RequestEvent {
  return {
    body,
    node: { res: { statusCode: 200, statusMessage: '' } },
    context: {
      params: { id },
      auth: { authenticated: true, actorId: 'rule-editor' },
      runtimeConfig: { workflowDbPath: ':memory:' },
    },
  };
}
beforeEach(async () => {
  // These routes share a module-owned database; reloading isolates that singleton.
  vi.resetModules();
  vi.resetAllMocks();
  workflow = await import('../../server/utils/workflow-store');
  const result = workflow.getWorkflowStore(event());
  if ('error' in result) throw new Error(result.error);
  store = result.store;
  await store.upsertActorMembership('rule-editor', 'active', ['rule:execute'], '*');
  await store.setRuleOverride('rule-one', false);
  await store.setRuleOverride('unrelated-rule', true);
  patch = (await import('../../server/api/rule/[id].patch')).default as unknown as Handler;
  remove = (await import('../../server/api/rule/[id].delete')).default as unknown as Handler;
  rules = [
    { id: 'rule-one', inactive: false },
    { id: 'unrelated-rule', inactive: false },
  ];
  ledger.listRules.mockImplementation(async () => rules.map((rule) => ({ ...rule })));
  ledger.updateRule.mockImplementation(async (id, fields) => {
    const rule = rules.find((entry) => entry.id === id);
    if (!rule) return { success: false };
    rule.inactive = fields.inactive;
    return { success: true };
  });
  ledger.deleteRule.mockImplementation(async (id) => {
    rules = rules.filter((rule) => rule.id !== id);
    return { success: true };
  });
  ledger.synchronize.mockResolvedValue(undefined);
  connect.mockImplementation(async (operation) => operation({ connector: ledger }));
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe.each(['patch', 'delete'] as const)('rule %s boundary', (operation) => {
  const invoke = (request: RequestEvent) =>
    operation === 'patch' ? patch(request) : remove(request);
  it.each([
    { status: 'active', capabilities: ['observe'], scope: '*' },
    { status: 'revoked', capabilities: ['rule:execute'], scope: '*' },
    { status: 'active', capabilities: ['rule:execute'], scope: 'budget:another' },
  ] as const)(
    'denies $status membership with $capabilities in $scope before ledger access',
    async ({ status, capabilities, scope }) => {
      await store.upsertActorMembership('rule-editor', status, [...capabilities], scope);
      const request = event();
      expect((await invoke(request)).error?.code).toBe('FORBIDDEN');
      expect(request.node.res.statusCode).toBe(403);
      expect(connect).not.toHaveBeenCalled();
      expect(await store.getRuleOverrides()).toEqual(
        new Map([
          ['rule-one', false],
          ['unrelated-rule', true],
        ]),
      );
    },
  );
  it('rejects missing route identifiers without touching the ledger', async () => {
    const request = event({ inactive: true }, '');
    expect((await invoke(request)).error?.code).toBe('MISSING_RULE_ID');
    expect(request.node.res.statusCode).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });
  it('fails closed when the store disappears after authorization', async () => {
    vi.spyOn(workflow, 'getWorkflowStore').mockReturnValue({ error: 'Store unavailable' });
    const request = event();
    expect((await invoke(request)).error?.code).toBe('STORE_UNAVAILABLE');
    expect(request.node.res.statusCode).toBe(503);
    expect(connect).not.toHaveBeenCalled();
  });
  it('returns a recoverable missing connection failure without clearing local state', async () => {
    connect.mockRejectedValue(Object.assign(new Error('not selected'), { code: 'not_connected' }));
    const request = event();
    expect((await invoke(request)).error).toMatchObject({ code: 'not_connected', retryable: true });
    expect(request.node.res.statusCode).toBe(503);
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('does not clear the override after failed post-write synchronization', async () => {
    ledger.synchronize.mockRejectedValue(new Error('sync conflict'));
    const request = event();
    expect((await invoke(request)).error).toMatchObject({ code: 'SYNC_FAILED', retryable: true });
    expect(request.node.res.statusCode).toBe(500);
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('does not clear the override when post-write verification cannot read the ledger', async () => {
    if (operation === 'patch') ledger.listRules.mockResolvedValueOnce(rules);
    ledger.listRules.mockRejectedValue(new Error('read failed'));
    const request = event();
    expect((await invoke(request)).error?.code).toBe('VERIFICATION_FAILED');
    expect(request.node.res.statusCode).toBe(500);
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('returns verified success even if cleanup of an obsolete override fails', async () => {
    vi.spyOn(store, 'removeRuleOverride').mockRejectedValue(new Error('store busy'));
    const response = await invoke(event());
    expect(response.status).toBe('ok');
    expect(rules.find((rule) => rule.id === 'rule-one')).toEqual(
      operation === 'patch' ? { id: 'rule-one', inactive: true } : undefined,
    );
    expect((await store.getRuleOverrides()).get('unrelated-rule')).toBe(true);
  });
  it('accepts the canonical rule:execute grant and clears only the verified rule override', async () => {
    const response = await invoke(event());
    expect(response.status).toBe('ok');
    expect(rules.find((rule) => rule.id === 'rule-one')).toEqual(
      operation === 'patch' ? { id: 'rule-one', inactive: true } : undefined,
    );
    expect(await store.getRuleOverrides()).toEqual(new Map([['unrelated-rule', true]]));
  });
  it('reports thrown ledger writes without removing the local override', async () => {
    (operation === 'patch' ? ledger.updateRule : ledger.deleteRule).mockRejectedValue(
      new Error('write failed'),
    );
    const request = event();
    expect((await invoke(request)).error?.code).toBe(
      operation === 'patch' ? 'RULE_UPDATE_FAILED' : 'RULE_DELETE_FAILED',
    );
    expect(request.node.res.statusCode).toBe(500);
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
});

describe('PATCH verified inactive state', () => {
  it('rejects JSON null with 400 before any ledger mutation', async () => {
    const request = event(null);
    expect((await patch(request)).error?.code).toBe('INVALID_BODY');
    expect(request.node.res.statusCode).toBe(400);
    expect(connect).not.toHaveBeenCalled();
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it.each([
    { body: new SyntaxError('invalid JSON'), status: 400, code: 'INVALID_BODY' },
    { body: {}, status: 422, code: 'INVALID_FIELD' },
    { body: { inactive: 'true' }, status: 422, code: 'INVALID_FIELD' },
  ])('rejects invalid input with $status before reading rules', async ({ body, status, code }) => {
    const request = event(body);
    expect((await patch(request)).error?.code).toBe(code);
    expect(request.node.res.statusCode).toBe(status);
    expect(connect).not.toHaveBeenCalled();
  });
  it('cannot update an absent rule', async () => {
    const request = event({ inactive: true }, 'missing');
    expect((await patch(request)).error?.code).toBe('RULE_NOT_FOUND');
    expect(request.node.res.statusCode).toBe(404);
    expect(ledger.updateRule).not.toHaveBeenCalled();
  });
  it('fails before mutation when the initial ledger read fails', async () => {
    ledger.listRules.mockRejectedValue(new Error('read unavailable'));
    const request = event();
    expect((await patch(request)).error?.code).toBe('LEDGER_READ_FAILED');
    expect(request.node.res.statusCode).toBe(503);
    expect(ledger.updateRule).not.toHaveBeenCalled();
  });
  it('rejects an explicit failed connector result', async () => {
    ledger.updateRule.mockResolvedValue({ success: false });
    expect((await patch(event())).error?.code).toBe('RULE_UPDATE_FAILED');
    expect(rules[0]?.inactive).toBe(false);
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('detects a connector that reports success without persisting the requested value', async () => {
    ledger.updateRule.mockResolvedValue({ success: true });
    expect((await patch(event())).error).toMatchObject({
      code: 'RULE_UPDATE_FAILED',
      retryable: true,
    });
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('reports concurrent deletion during update verification as nonretryable', async () => {
    ledger.synchronize.mockImplementation(async () => {
      rules = [];
    });
    expect((await patch(event())).error).toMatchObject({
      code: 'VERIFICATION_FAILED',
      retryable: false,
    });
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
});

describe('DELETE verified absence', () => {
  it('preserves the override when a schedule prevents deletion', async () => {
    ledger.deleteRule.mockResolvedValue({
      success: false,
      code: 'RULE_HAS_SCHEDULE',
      error: 'Scheduled rule',
    });
    expect((await remove(event())).error).toMatchObject({
      code: 'RULE_HAS_SCHEDULE',
      retryable: false,
    });
    expect(rules.find((rule) => rule.id === 'rule-one')).toBeDefined();
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('does not confuse a successful connector response with verified absence', async () => {
    ledger.deleteRule.mockResolvedValue({ success: true });
    expect((await remove(event())).error).toMatchObject({
      code: 'VERIFICATION_FAILED',
      retryable: true,
    });
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
  it('provides the retryable deletion failure when the connector supplies no error code', async () => {
    ledger.deleteRule.mockResolvedValue({ success: false });
    expect((await remove(event())).error).toMatchObject({
      code: 'RULE_DELETE_FAILED',
      retryable: true,
    });
    expect((await store.getRuleOverrides()).has('rule-one')).toBe(true);
  });
});
