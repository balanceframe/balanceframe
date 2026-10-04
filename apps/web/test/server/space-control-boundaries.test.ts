import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStore } from '@balanceframe/workflow-store';
import type * as WorkflowUtils from '../../server/utils/workflow-store';
import type * as LegacyRead from '../../server/utils/legacy-financial-read';
import type * as Reauthentication from '../../server/utils/reauthentication';

const mocks = vi.hoisted(() => ({
  workflowStore: { value: null as unknown },
  requireAuthorization: vi.fn(),
  requireSelectedSpace: vi.fn(),
  getHumanControlAuth: vi.fn(),
  readBody: vi.fn(),
  getRouterParam: vi.fn(),
  getQuery: vi.fn(),
  setResponseStatus: vi.fn(),
  setHeader: vi.fn(),

  connectionManager: {
    loadConfig: vi.fn(),
    connect: vi.fn(),
  },
  connectedBudgets: [] as string[],
  notificationPolicySpaces: [] as string[],
  createLiquidityService: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),

  listInvitations: vi.fn(),
  saveNotificationPolicy: vi.fn(),
  getNotificationPolicy: vi.fn(),

  saveLiquidityGrants: vi.fn(),
  saveLiquidityPolicy: vi.fn(),
  updateReviewCategoryCatalog: vi.fn(),
}));

interface TestEvent {
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  context: {
    auth?: {
      authenticated: boolean;
      actorId?: string;
      method?: 'session' | 'api-key' | 'legacy-token' | 'development';
      principalType?: 'human' | 'agent';
      sessionId?: string;
      user?: { id?: string };
      impersonatedBy?: string | null;
    };
    params?: Record<string, string>;
    testIsInstanceOwner?: boolean;
    proof?: 'fresh' | 'stale';
    boundary?: {
      selectedSpaceId: string;
      selectedBudgetId: string;
      scopes: string[];
      capabilities: string[];
      membershipCurrent?: boolean;
    };
  };
  node?: { req?: { headers?: Record<string, string> } };
}

function eventAs(value: unknown): TestEvent {
  return value as TestEvent;
}

function denial() {
  return {
    ok: false as const,
    response: {
      status: 'error',
      result: null,
      error: { code: 'FORBIDDEN', message: 'Unavailable', retryable: false },
    },
  };
}

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mocks.readBody,
  getRouterParam: mocks.getRouterParam,
  getQuery: mocks.getQuery,
  getHeader: (event: unknown, name: string) =>
    eventAs(event).headers?.[name.toLowerCase()] ??
    eventAs(event).node?.req?.headers?.[name.toLowerCase()],
  getCookie: () => undefined,
  setResponseStatus: mocks.setResponseStatus,
  setHeader: mocks.setHeader,
}));

vi.mock('@balanceframe/application', () => ({
  createDefaultConnectionManager: () => mocks.connectionManager,
  createLiquidityService: mocks.createLiquidityService,
  LiquidityProjector: { canReadFinding: vi.fn() },
}));

vi.mock('../../server/utils/workflow-store', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowUtils>();
  return {
    ...actual,
    getWorkflowStore: () =>
      mocks.workflowStore.value
        ? { store: mocks.workflowStore.value as WorkflowStore }
        : { error: 'Workflow store unavailable' },
    requireAuthorization: mocks.requireAuthorization,
  };
});

vi.mock('../../server/utils/space-context', () => ({
  requireSelectedSpace: mocks.requireSelectedSpace,
}));

vi.mock('../../server/utils/reauthentication', async (importOriginal) => ({
  ...(await importOriginal<typeof Reauthentication>()),
  getHumanControlAuth: mocks.getHumanControlAuth,
}));

vi.mock('../../server/utils/legacy-financial-read', async (importOriginal) => {
  const actual = await importOriginal<typeof LegacyRead>();
  return {
    ...actual,
    requireRegisteredOwner: async (event: TestEvent) =>
      event.context.testIsInstanceOwner
        ? {
            ok: true as const,
            info: { actorId: 'instance-owner', capability: 'connection:manage', allowed: true },
          }
        : denial(),
  };
});

vi.mock('../../server/utils/registration', () => ({
  requireOwner: (event: unknown, ownerId: string) =>
    eventAs(event).context.auth?.user?.id === ownerId
      ? { ok: true, info: { actorId: ownerId } }
      : denial(),
}));

vi.mock('../../server/utils/review-category-catalog', () => ({
  updateReviewCategoryCatalog: mocks.updateReviewCategoryCatalog,
}));

import createInvitation from '../../server/api/invitations/index.post';
import revokeInvitation from '../../server/api/invitations/[id]/revoke.post';
import listInvitations from '../../server/api/invitations/index.get';
import selectConnection from '../../server/api/connection/index.post';
import saveNotificationPolicy from '../../server/api/notifications/policy.post';
import getNotificationPolicy from '../../server/api/notifications/policy.get';

import saveLiquidityGrants from '../../server/api/liquidity/grants.put';
import saveLiquidityPolicy from '../../server/api/liquidity/policy.put';

const selectedSpace = 'space-selected';
const selectedBudget = 'budget-selected';
const foreignSpace = 'space-foreign';
const foreignBudget = 'budget-foreign';

function request(options: {
  body?: unknown;
  params?: Record<string, string>;
  userId?: string;
  method?: 'session' | 'api-key' | 'legacy-token' | 'development';
  principalType?: 'human' | 'agent';
  impersonatedBy?: string;
  proof?: 'fresh' | 'stale';
  isInstanceOwner?: boolean;
  selectedSpaceId?: string;
  selectedBudgetId?: string;
  membershipCurrent?: boolean;
  capabilities?: string[];
  scopes?: string[];
} = {}): TestEvent {
  const userId = options.userId ?? 'instance-owner';
  const spaceId = options.selectedSpaceId ?? selectedSpace;
  const budgetId = options.selectedBudgetId ?? selectedBudget;
  return {
    body: options.body,
    context: {
      auth: {
        authenticated: true,
        actorId: userId,
        method: options.method ?? 'session',
        principalType: options.principalType ?? 'human',
        sessionId: `session:${userId}`,
        user: { id: userId },
        impersonatedBy: options.impersonatedBy,
      },
      params: options.params,
      testIsInstanceOwner: options.isInstanceOwner ?? true,
      proof: options.proof,
      boundary: {
        selectedSpaceId: spaceId,
        selectedBudgetId: budgetId,
        membershipCurrent: options.membershipCurrent ?? true,
        scopes: options.scopes ?? [spaceId, `space:${spaceId}`, `budget:${budgetId}`, 'instance'],
        capabilities: options.capabilities ?? [],
      },
    },
    headers: { 'x-balanceframe-space': spaceId },
    node: { req: { headers: { 'x-balanceframe-space': spaceId, origin: 'http://localhost:3000' } } },
  };
}

interface AuthOverrides {
  method?: 'session' | 'api-key' | 'legacy-token' | 'development';
  principalType?: 'human' | 'agent';
  impersonatedBy?: string;
}

function controlEvent(
  capabilities: string[],
  proof?: 'fresh' | 'stale',
  auth: AuthOverrides = {},
): TestEvent {
  return request({ capabilities, proof, ...auth });
}

function notificationPolicy() {
  return {
    policyVersion: 'v1',
    eligibility: [
      { classifications: ['alert'], minSeverity: 'normal', requiredCapability: 'notification:receive' },
    ],
    recipients: [],
    channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
    redaction: { public: { visibleFields: ['title'] } },
    maxRetries: 3,
    defaultRedactionClass: 'public',
  };
}

function controlBody(name: string): unknown {
  if (name === 'notification policy update') return { spaceId: selectedSpace, policy: notificationPolicy() };
  if (name === 'Actual connection binding') return { budgetId: selectedBudget };
  if (name.includes('invitation')) return undefined;
  return { grants: [], policy: { enabled: true } };
}

function controlAuthorization(event: TestEvent, capability: string, scope?: string) {
  const boundary = event.context.boundary;
  const exactScope = scope ?? boundary?.selectedSpaceId ?? '*';
  if (
    !boundary ||
    !boundary.membershipCurrent ||
    !boundary.capabilities.includes(capability) ||
    !boundary.scopes.includes(exactScope)
  )
    return denial();
  return {
    ok: true as const,
    info: { actorId: event.context.auth?.user?.id ?? 'anonymous', capability, allowed: true },
  };
}

const workflow = {
  createInvitation: mocks.createInvitation,
  revokeInvitation: mocks.revokeInvitation,
  listInvitations: mocks.listInvitations,
  getNotificationPolicy: mocks.getNotificationPolicy,
  saveNotificationPolicy: mocks.saveNotificationPolicy,
  governance: { getPolicy: vi.fn(() => ({ version: '1' })) },
};

const controls = [
  {
    name: 'invitation creation',
    capability: 'membership:manage',
    formerCapabilities: ['observe'],
    mutate: mocks.createInvitation,
    invoke: (event: TestEvent) => createInvitation(event),
  },
  {
    name: 'invitation revocation',
    capability: 'membership:manage',
    formerCapabilities: ['observe'],
    mutate: mocks.revokeInvitation,
    invoke: (event: TestEvent) => revokeInvitation(event),
  },
  {
    name: 'Actual connection binding',
    capability: 'connection:manage',
    formerCapabilities: ['connection:discover'],
    mutate: mocks.connectionManager.connect,
    invoke: (event: TestEvent) => selectConnection(event),
  },
  {
    name: 'notification policy update',
    capability: 'policy:manage',
    formerCapabilities: ['notification:admin'],
    mutate: mocks.saveNotificationPolicy,
    invoke: (event: TestEvent) => saveNotificationPolicy(event),
  },
  {
    name: 'liquidity grant update',
    capability: 'grant:manage',
    formerCapabilities: ['observe', 'liquidity:grant'],
    mutate: mocks.saveLiquidityGrants,
    invoke: (event: TestEvent) => saveLiquidityGrants(event),
  },
  {
    name: 'liquidity policy update',
    capability: 'policy:manage',
    formerCapabilities: ['observe', 'liquidity:policy'],
    mutate: mocks.saveLiquidityPolicy,
    invoke: (event: TestEvent) => saveLiquidityPolicy(event),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
  mocks.getRouterParam.mockImplementation((event: unknown, name: string) =>
    eventAs(event).context.params?.[name],
  );
  mocks.getQuery.mockReturnValue({});
  mocks.connectedBudgets.length = 0;
  mocks.notificationPolicySpaces.length = 0;
  mocks.workflowStore.value = workflow;
  mocks.connectionManager.loadConfig.mockResolvedValue({ budgetId: selectedBudget });
  mocks.requireAuthorization.mockImplementation(
    async (event: TestEvent, capability: string, scope?: string) =>
      controlAuthorization(event, capability, scope),
  );
  mocks.requireSelectedSpace.mockImplementation(async (event: TestEvent) => {
    const boundary = event.context.boundary;
    if (!boundary || !boundary.membershipCurrent) return denial();
    const actorId = event.context.auth?.user?.id ?? 'anonymous';
    return {
      ok: true as const,
      space: { id: boundary.selectedSpaceId, kind: 'shared', budgetId: boundary.selectedBudgetId },
      membership: {
        id: `membership:${actorId}:${boundary.selectedSpaceId}`,
        spaceId: boundary.selectedSpaceId,
        actorId,
        validFrom: '2000-01-01T00:00:00.000Z',
        validUntil: null,
        capabilities: boundary.capabilities,
      },
      auth: {
        method: event.context.auth?.method === 'api-key' ? 'api-key' : 'session',
        actorId,
        sessionId: event.context.auth?.sessionId ?? `session:${actorId}`,
      },
    };
  });
  mocks.getHumanControlAuth.mockImplementation(async (event: TestEvent) => {
    const auth = event.context.auth;
    if (
      event.context.proof !== 'fresh' ||
      !auth?.authenticated ||
      auth.method !== 'session' ||
      auth.principalType !== 'human' ||
      auth.impersonatedBy ||
      !auth.sessionId
    )
      return null;
    return {
      method: 'human-session',
      actorId: auth.user?.id ?? 'anonymous',
      sessionId: auth.sessionId,
      reauthenticatedAt: new Date().toISOString(),
    };
  });
  mocks.readBody.mockImplementation(async (event: TestEvent) => event.body);
  mocks.connectionManager.connect.mockImplementation(async (input: { budgetId: string }) => {
    mocks.connectedBudgets.push(input.budgetId);
    return {
      budget: {
        id: input.budgetId,
        groupId: 'group-1',
        name: 'Budget',
        encrypted: false,
      },
      config: { budgetId: input.budgetId },
      synchronization: {},
    };
  });
  mocks.createInvitation.mockResolvedValue({
    invitation: { id: 'invitation-1', expiresAt: '2099-01-01T00:00:00.000Z' },
    inviteUrl: 'https://balanceframe.invalid/invite#secret',
  });
  mocks.revokeInvitation.mockResolvedValue(undefined);
  mocks.listInvitations.mockResolvedValue([
    {
      id: 'invitation-1',
      status: 'active',
      createdByUserId: 'space-member',
      spaceId: selectedSpace,
      issuerMembershipId: 'membership:space-member:space-selected',
      governancePolicyVersion: '1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      claimedEmail: null,
      redeemedUserId: null,
      createdAt: '2098-01-01T00:00:00.000Z',
      claimedAt: null,
      redeemedAt: null,
    },
  ]);
  mocks.saveNotificationPolicy.mockImplementation(async (input: { spaceId?: string }) => {
    if (input.spaceId) mocks.notificationPolicySpaces.push(input.spaceId);
    return { id: 'policy-1', input };
  });
  mocks.saveLiquidityGrants.mockResolvedValue({ grants: [] });
  mocks.saveLiquidityPolicy.mockResolvedValue({ policy: {} });
  mocks.createLiquidityService.mockReturnValue({
    saveGrants: mocks.saveLiquidityGrants,
    savePolicy: mocks.saveLiquidityPolicy,
  });
});
afterEach(() => vi.unstubAllEnvs());

for (const control of controls) {
  it(`${control.name} does not accept a non-control capability, even with fresh human proof`, async () => {
    const event = controlEvent([...control.formerCapabilities], 'fresh');
    event.body = controlBody(control.name);
    if (control.name === 'invitation revocation') event.context.params = { id: 'invitation-1' };

    await control.invoke(event);

    expect(control.mutate).not.toHaveBeenCalled();
  });

  it(`${control.name} requires recent human-session proof after the exact control grant`, async () => {
    const event = controlEvent([...control.formerCapabilities, control.capability]);
    event.body = controlBody(control.name);
    if (control.name === 'invitation revocation') event.context.params = { id: 'invitation-1' };

    await control.invoke(event);

    expect(control.mutate).not.toHaveBeenCalled();
  });

  for (const principal of [
    { label: 'API keys', auth: { method: 'api-key' as const } },
    { label: 'agents', auth: { method: 'api-key' as const, principalType: 'agent' as const } },
    { label: 'legacy tokens', auth: { method: 'legacy-token' as const } },
    { label: 'development bypass', auth: { method: 'development' as const } },
    { label: 'impersonated sessions', auth: { impersonatedBy: 'administrator' } },
    { label: 'stale human proof', auth: {}, proof: 'stale' as const },
  ]) {
    it(`${control.name} rejects ${principal.label} despite the exact grant`, async () => {
      const event = controlEvent(
        [...control.formerCapabilities, control.capability],
        principal.proof ?? 'fresh',
        principal.auth,
      );
      event.body = controlBody(control.name);
      if (control.name === 'invitation revocation') event.context.params = { id: 'invitation-1' };

      await control.invoke(event);

      expect(control.mutate).not.toHaveBeenCalled();
    });
  }
}

for (const control of controls.filter((item) => item.name.startsWith('invitation'))) {
  it(`allows a scoped member with ${control.capability} to perform ${control.name}`, async () => {
    const event = request({
      userId: 'space-member',
      capabilities: [control.capability],
      proof: 'fresh',
    });
    event.body = controlBody(control.name);
    if (control.name === 'invitation revocation') event.context.params = { id: 'invitation-1' };

    await control.invoke(event);

    if (control.name === 'invitation creation' || control.name === 'invitation revocation') {
      expect(control.mutate).toHaveBeenCalledWith(expect.objectContaining({
        spaceId: selectedSpace,
        auth: expect.objectContaining({
          method: 'human-session',
          actorId: 'space-member',
        }),
      }));
    }

    expect(control.mutate).toHaveBeenCalled();
  });
}
describe('GET /api/invitations', () => {
  it('lists only token-free invitation metadata for the reauthenticated selected-space custodian', async () => {
    const response = await listInvitations(controlEvent(['membership:manage'], 'fresh'));

    expect(response.status).toBe('ok');
    expect(response.result.items).toEqual([
      expect.objectContaining({
        id: 'invitation-1',
        spaceId: selectedSpace,
        status: 'active',
      }),
    ]);
    expect(JSON.stringify(response)).not.toContain('tokenDigest');
    expect(mocks.listInvitations).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: selectedSpace,
      auth: expect.objectContaining({
        method: 'human-session',
        actorId: 'instance-owner',
      }),
    }));
  });
});


describe('GET /api/notifications/policy', () => {
  it('reads the policy only for the authorized selected space', async () => {
    const record = {
      id: 'policy-1',
      spaceId: selectedSpace,
      policyKey: 'notification',
      policyVersion: 'v1',
      policy: '{}',
      isActive: true,
      createdAt: '2098-01-01T00:00:00.000Z',
      updatedAt: '2098-01-01T00:00:00.000Z',
    };
    mocks.getNotificationPolicy.mockResolvedValue(record);
    mocks.getQuery.mockReturnValue({ spaceId: selectedSpace, policyKey: 'notification' });
    const event = request({ capabilities: ['policy:manage'] });

    const response = await getNotificationPolicy(event);

    expect(response.status).toBe('ok');
    expect(response.result).toEqual(record);
    expect(mocks.requireAuthorization).toHaveBeenCalledWith(
      event,
      'policy:manage',
      `space:${selectedSpace}`,
    );
    expect(mocks.getNotificationPolicy).toHaveBeenCalledWith(selectedSpace, 'notification');
  });

  it('does not read a policy from another space named by the query', async () => {
    mocks.getQuery.mockReturnValue({ spaceId: foreignSpace, policyKey: 'notification' });

    const response = await getNotificationPolicy(request({ capabilities: ['policy:manage'] }));

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(mocks.getNotificationPolicy).not.toHaveBeenCalled();
  });
});

describe('server-selected control scope', () => {
  it('does not let instance ownership bypass an ended current membership', async () => {
    await createInvitation(
      request({
        userId: 'instance-owner',
        membershipCurrent: false,
        capabilities: ['membership:manage'],
        proof: 'fresh',
      }),
    );

    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects notification-policy body fields that name another selected space', async () => {
    await saveNotificationPolicy(
      request({
        body: { spaceId: foreignSpace, policy: notificationPolicy() },
        capabilities: ['policy:manage'],
        proof: 'fresh',
      }),
    );

    expect(mocks.saveNotificationPolicy).not.toHaveBeenCalled();
    expect(mocks.notificationPolicySpaces).toEqual([]);
  });
  it('accepts the space policy capability instead of the legacy notification alias', async () => {
    const response = await saveNotificationPolicy(
      request({
        body: { spaceId: selectedSpace, policy: notificationPolicy() },
        capabilities: ['policy:manage'],
        proof: 'fresh',
      }),
    );

    expect(mocks.saveNotificationPolicy).toHaveBeenCalled();
    expect(response.status).toBe('ok');
  });


  it('does not let a connection body replace the selected space budget binding', async () => {
    await selectConnection(
      request({
        body: { budgetId: foreignBudget, actorId: 'another-human' },
        capabilities: ['connection:manage'],
        proof: 'fresh',
        isInstanceOwner: true,
      }),
    );

    expect(mocks.connectedBudgets).toEqual([]);
    expect(mocks.connectionManager.connect).not.toHaveBeenCalled();
  });
  it('does not accept a body actor as proof of registered instance ownership', async () => {
    await selectConnection(
      request({
        userId: 'ordinary-member',
        body: { budgetId: foreignBudget, actorId: 'instance-owner' },
        capabilities: ['connection:manage'],
        proof: 'fresh',
        isInstanceOwner: false,
      }),
    );

    expect(mocks.connectedBudgets).not.toContain(foreignBudget);
  });
});

describe('control grants do not imply financial observation', () => {
  it('allows a reauthenticated grant manager to update scoped grants without observe access', async () => {
    const event = controlEvent(['grant:manage'], 'fresh');
    event.body = { grants: [] };

    await saveLiquidityGrants(event);

    expect(mocks.saveLiquidityGrants).toHaveBeenCalled();
  });

  it('allows a reauthenticated policy manager to update policy without observe access', async () => {
    const event = controlEvent(['policy:manage'], 'fresh');
    event.body = { policy: { enabled: true } };

    await saveLiquidityPolicy(event);

    expect(mocks.saveLiquidityPolicy).toHaveBeenCalled();
  });
});
