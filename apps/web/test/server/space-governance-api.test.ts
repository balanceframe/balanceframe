import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as Reauthentication from '../../server/utils/reauthentication';
import { SqliteWorkflowStore } from '../../../../packages/workflow-store/src/store';
import { GENERIC_MUTATION_POLICY_VERSION } from '../../../../packages/workflow-store/src/proposal';
import type { TransferPlan } from '@balanceframe/protocol-generated';

const mocks = vi.hoisted(() => ({ listApiKeys: vi.fn() }));

interface TestEvent {
  node: { req: { headers: Record<string, string> } };
  body?: unknown;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  query?: Record<string, unknown>;
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
    params: Record<string, string>;
    runtimeConfig: { workflowDbPath: string };
    controlProof?: boolean;
  };
  statusCode?: number;
  responseHeaders?: Record<string, string>;
}

type Handler = (event: TestEvent) => Promise<unknown> | unknown;
const RecordValue = z.record(z.string(), z.unknown());
const SuccessEnvelope = z.object({ status: z.literal('ok'), result: RecordValue, error: z.null() });

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getHeader: (event: TestEvent, name: string) => event.headers[name.toLowerCase()],
  getCookie: (event: TestEvent, name: string) => event.cookies[name],
  setCookie: (event: TestEvent, name: string, value: string) => { event.cookies[name] = value; },
  getRouterParam: (event: TestEvent, name: string) => event.context.params[name],
  getQuery: (event: TestEvent) => event.query ?? {},
  getRequestHeaders: (event: TestEvent) => event.headers,
  readBody: async (event: TestEvent) => event.body,
  setHeader: (event: TestEvent, name: string, value: string) => {
    event.responseHeaders ??= {};
    event.responseHeaders[name.toLowerCase()] = value;
  },
  setResponseStatus: (event: TestEvent, status: number) => { event.statusCode = status; },
}));
vi.mock('@balanceframe/workflow-store', () => ({ SqliteWorkflowStore }));
vi.mock('../../lib/auth', () => ({ auth: { api: { listApiKeys: mocks.listApiKeys } } }));
vi.mock('../../server/utils/reauthentication', async (importOriginal) => ({
  ...(await importOriginal<typeof Reauthentication>()),
  getHumanControlAuth: async (event: TestEvent) => {
    const identity = event.context.auth;
    if (!event.context.controlProof || identity?.method !== 'session' || identity.principalType !== 'human')
      return null;
    return {
      method: 'human-session' as const,
      actorId: identity.user?.id ?? '',
      sessionId: identity.sessionId ?? '',
      reauthenticatedAt: now,
    };
  },
}));

const now = '2098-01-01T12:00:00.000Z';
const after = '2098-01-01T13:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function auditTransferPlan(): TransferPlan {
  const sourceAccountId = 'private-source-account';
  const destinationAccountId = 'private-destination-account';
  const snapshotId = 'audit-snapshot';
  const contentHash = 'audit-content';
  const policyVersion = '1';
  const policyHash = 'private-financial-policy';
  const before = (accountId: string) => ({
    accountId,
    recordedBalance: usd('10000'),
    signedHeadroom: usd('10000'),
    backingCapacity: usd('10000'),
    baselineTransactionIds: [],
  });
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId,
    contentHash,
    policyVersion,
    policyHash,
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt,
    minimumAmount: usd('2000'),
    payloadHash: 'a'.repeat(64),
    legs: [{
      id: 'audit-transfer-leg',
      sourceAccountId,
      destinationAccountId,
      amount: usd('2000'),
      requiredBy: expiresAt,
      estimatedArrival: now,
      timingRouteId: 'audit-route',
      sourceBefore: before(sourceAccountId),
      destinationBefore: before(destinationAccountId),
      sourceAfter: usd('8000'),
      destinationAfter: usd('12000'),
    }],
    reservations: [{
      kind: 'account_debit',
      resourceId: sourceAccountId,
      amount: usd('2000'),
      economicObligationId: 'private-obligation-reference',
      categoryId: null,
      includedInBalance: false,
      matchedTransactionIds: [],
    }],
    backingAfter: {
      version: '1',
      snapshotId,
      contentHash,
      policyVersion,
      policyHash,
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}
let spaceId = '';
let store: SqliteWorkflowStore;
let ownerMembershipId: string;
let routes: Record<string, Handler>;

function request(options: {
  userId?: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  selected?: string | null;
  cookieSelection?: string;
  proof?: boolean;
} = {}): TestEvent {
  const userId = options.userId ?? 'owner';
  const selected = options.selected === undefined ? spaceId : options.selected;
  return {
    body: options.body,
    query: options.query,
    headers: selected === null ? {} : { 'x-balanceframe-space': selected },
    cookies: options.cookieSelection ? { balanceframe_space: options.cookieSelection } : {},
    node: { req: { headers: selected === null ? {} : { 'x-balanceframe-space': selected } } },
    context: {
      auth: {
        authenticated: true,
        actorId: userId,
        method: 'session',
        principalType: 'human',
        sessionId: `session:${userId}`,
        user: { id: userId },
        impersonatedBy: null,
      },
      params: options.params ?? {},
      runtimeConfig: { workflowDbPath: ':memory:' },
      ...(options.proof ? { controlProof: true } : {}),
    },
  };
}

function resultOf(value: unknown): Record<string, unknown> {
  return SuccessEnvelope.parse(value).result;
}

function records(value: unknown): Record<string, unknown>[] {
  return z.array(RecordValue).parse(value);
}

function expectDenied(value: unknown): void {
  expect(value).toMatchObject({ status: 'error', result: null });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.listApiKeys.mockReset();
  mocks.listApiKeys.mockResolvedValue({
    apiKeys: [{ id: 'key-owner', referenceId: 'owner', enabled: true, expiresAt: null }],
    total: 1,
  });

  // Dynamic imports are required to exercise the resettable workflow-store singleton.
  const utils = await import('../../server/utils/workflow-store');
  const initialized = utils.getWorkflowStore(request({ selected: null }));
  if ('error' in initialized) throw new Error(initialized.error);
  store = initialized.store;
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'space-governance-api-test' });
  await store.finalizeBootstrap({ claimId: 'space-governance-api-test', ownerUserId: 'owner' });
  const space = store.governance.createSpace({
    actorId: 'owner', name: 'Household', kind: 'shared', now, auth: {
      method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now,
    },
  });
  spaceId = space.id;
  const membership = store.governance.getCurrentMembership({ spaceId, actorId: 'owner', now });
  if (!membership) throw new Error('Owner membership was not created');
  ownerMembershipId = membership.id;
  store.governance.bindBudget({
    spaceId, budgetId: 'private-budget-id', now,
    auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
  });

  // Dynamic route imports keep each test bound to the fresh singleton above.
  routes = {
    list: (await import('../../server/api/spaces/index.get')).default as Handler,
    create: (await import('../../server/api/spaces/index.post')).default as Handler,
    select: (await import('../../server/api/spaces/[id]/select.post')).default as Handler,
    show: (await import('../../server/api/spaces/[id].get')).default as Handler,
    memberships: (await import('../../server/api/spaces/[id]/memberships/index.get')).default as Handler,
    addMembership: (await import('../../server/api/spaces/[id]/memberships/index.post')).default as Handler,
    revokeMembership: (await import('../../server/api/spaces/[id]/memberships/[membershipId]/revoke.post')).default as Handler,
    setGrant: (await import('../../server/api/spaces/[id]/grants.put')).default as Handler,
    policy: (await import('../../server/api/spaces/[id]/policy.get')).default as Handler,
    setPolicy: (await import('../../server/api/spaces/[id]/policy.put')).default as Handler,
    agents: (await import('../../server/api/spaces/[id]/agents.get')).default as Handler,
    setAgentStatus: (await import('../../server/api/spaces/[id]/agents/[agentId].put')).default as Handler,
    registerAgent: (await import('../../server/api/spaces/[id]/agents.post')).default as Handler,
    delegate: (await import('../../server/api/spaces/[id]/delegations.post')).default as Handler,
    revokeDelegation: (await import('../../server/api/spaces/[id]/delegations/[delegationId]/revoke.post')).default as Handler,
    credentials: (await import('../../server/api/spaces/[id]/credentials.get')).default as Handler,
    registerCredential: (await import('../../server/api/spaces/[id]/credentials.post')).default as Handler,
    revokeCredential: (await import('../../server/api/spaces/[id]/credentials/[credentialId]/revoke.post')).default as Handler,
    audit: (await import('../../server/api/spaces/[id]/audit.get')).default as Handler,
  };
});

afterEach(() => {
  store?.close();
  vi.useRealTimers();
});

describe('space governance HTTP controls', () => {
  it('lists only a canonical human’s current spaces and withholds bound-budget metadata', async () => {
    const listEvent = request({ selected: null });
    const listResponse = await routes.list(listEvent);
    expect(listResponse).toMatchObject({ status: 'ok' });
    const listed = records(resultOf(listResponse).spaces);
    expect(listEvent.responseHeaders?.['cache-control']).toBe('private, no-store');
    expect(listed[0]).toMatchObject({ id: spaceId, name: 'Household', kind: 'shared' });
    expect(listed[0]).not.toHaveProperty('budgetId');

    const forged = request({ selected: null });
    if (!forged.context.auth) throw new Error('Missing fixture identity');
    forged.context.auth.actorId = 'attacker';
    const canonicalSpaces = records(resultOf(await routes.list(forged)).spaces);
    expect(canonicalSpaces.map((space) => space.id)).toContain(spaceId);

    const otherPrincipal = request({ userId: 'attacker', selected: null });
    expect(records(resultOf(await routes.list(otherPrincipal)).spaces)).toEqual([]);

    const keyList = request({ selected: null });
    if (!keyList.context.auth) throw new Error('Missing fixture identity');
    Object.assign(keyList.context.auth, {
      method: 'api-key',
      credentialOwnerId: 'owner',
    });
    expectDenied(await routes.list(keyList));
  });

  it('persists metadata-only membership read admissions and never admits a revoked reader', async () => {
    const discovery = request({ selected: null });
    const detail = request({ params: { id: spaceId } });
    expect(await routes.list(discovery)).toMatchObject({ status: 'ok' });
    expect(await routes.show(detail)).toMatchObject({ status: 'ok' });
    const admissions = await store.queryAuditRecords('authorization_check');
    for (const operation of ['spaces.list', 'space.read']) {
      const record = admissions.find((entry) => entry.operation === operation);
      expect(record).toMatchObject({
        actorId: 'owner', budgetId: 'private-budget-id', isError: false,
      });
      expect(JSON.parse(record?.result ?? '{}')).toMatchObject({
        spaceId, membershipId: ownerMembershipId,
      });
      expect(record?.requestId).toBe(operation === 'spaces.list'
        ? discovery.responseHeaders?.['x-balanceframe-request-id']
        : detail.responseHeaders?.['x-balanceframe-request-id']);
      expect(record?.correlationId).toBe(record?.requestId);
      expect(JSON.stringify(record)).not.toContain('session:owner');
      expect(JSON.stringify(record)).not.toContain('Household');
    }
    await store.upsertActorMembership('reader', 'active', [], '*');
    const membership = store.governance.addMembership({
      spaceId, actorId: 'reader', validFrom: now, now,
      auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
    });
    store.governance.revokeMembership({
      spaceId, membershipId: membership.id, now,
      auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
    });
    expectDenied(await routes.show(request({ userId: 'reader', params: { id: spaceId } })));
    expect((await store.queryAuditRecords('authorization_check')).some((entry) => entry.actorId === 'reader')).toBe(false);
  });

  it('creates an unbound space only from fresh human proof and rejects body-supplied identity or budget', async () => {
    expectDenied(await routes.create(request({
      selected: null, proof: true,
      body: { name: 'Forged', kind: 'shared', actorId: 'attacker', budgetId: 'private-budget-id' },
    })));
    expectDenied(await routes.create(request({
      selected: null, body: { name: 'No proof', kind: 'personal' },
    })));
    const created = resultOf(await routes.create(request({
      selected: null, proof: true, body: { name: 'Project', kind: 'shared' },
    })));
    expect(created.space).toMatchObject({ name: 'Project', kind: 'shared', budgetId: null, createdBy: 'owner' });
  });

  it('selects by explicit path, writes the selected cookie, and rejects a foreign route scope', async () => {
    const selected = request({ params: { id: spaceId }, body: {} });
    expect(resultOf(await routes.select(selected)).space).toMatchObject({ id: spaceId, name: 'Household' });
    expect(selected.cookies.balanceframe_space).toBe(spaceId);

    expectDenied(await routes.show(request({ params: { id: 'foreign-space' } })));
    const cookieOnly = request({ selected: null, cookieSelection: spaceId, params: { id: spaceId } });
    expect(resultOf(await routes.show(cookieOnly)).space).toMatchObject({ id: spaceId });
  });

  it('allows scoped control reads without finance grants but denies a current non-manager control listing', async () => {
    await store.upsertActorMembership('member', 'active', ['*'], '*');
    store.governance.addMembership({ spaceId, actorId: 'member', validFrom: now, now, auth: {
      method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now,
    } });

    expect(records(resultOf(await routes.memberships(request({ params: { id: spaceId } }))).memberships)).toHaveLength(2);
    expect(resultOf(await routes.policy(request({ params: { id: spaceId } }))).policy).toMatchObject({ version: '1' });
    expectDenied(await routes.memberships(request({ userId: 'member', params: { id: spaceId } })));
  });

  it('registers agents only in the selected space and isolates lists from another space manager', async () => {
    const secondaryNow = '2098-01-01T12:00:01.000Z';
    const target = store.governance.createSpace({
      actorId: 'owner', name: 'Target', kind: 'shared', now: secondaryNow, auth: {
        method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now,
      },
    });
    const otherManagerId = 'manager:other-space';
    await store.upsertActorMembership(otherManagerId, 'active', ['*'], '*');
    const managerA = store.governance.addMembership({
      spaceId, actorId: otherManagerId, validFrom: now, now,
      auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
    });
    const managerB = store.governance.addMembership({
      spaceId: target.id, actorId: otherManagerId, validFrom: now, now: secondaryNow,
      auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
    });
    store.governance.provisionResourceGrant({
      spaceId, actorId: otherManagerId, budgetId: 'private-budget-id', membershipId: managerA.id,
      capability: 'agent:manage', resourceKind: 'space', resourceId: spaceId, granted: true, now,
    });
    vi.setSystemTime(secondaryNow);

    const agentId = 'agent:target-space';
    const created = resultOf(await routes.registerAgent(request({
      selected: target.id, params: { id: target.id }, proof: true, body: { agentId },
    })));
    expect(created.agent).toMatchObject({ agentId, registeredSpaceId: target.id, status: 'active' });
    expect(records(resultOf(await routes.agents(request({
      selected: target.id, params: { id: target.id },
    }))).agents).map((agent) => agent.agentId)).toEqual([agentId]);
    expect(records(resultOf(await routes.agents(request({
      selected: spaceId, params: { id: spaceId },
    }))).agents)).toEqual([]);

    expectDenied(await routes.registerAgent(request({
      userId: otherManagerId, selected: target.id, params: { id: target.id },
      proof: true, body: { agentId: 'agent:forbidden' },
    })));
    store.governance.provisionResourceGrant({
      spaceId: target.id, actorId: otherManagerId, budgetId: null, membershipId: managerB.id,
      capability: 'agent:manage', resourceKind: 'space', resourceId: target.id, granted: true, now: secondaryNow,
    });
    expectDenied(await routes.setAgentStatus(request({
      userId: otherManagerId,
      selected: spaceId,
      params: { id: spaceId, agentId },
      proof: true,
      body: { status: 'revoked' },
    })));
    expect(records(resultOf(await routes.agents(request({
      selected: target.id, params: { id: target.id },
    }))).agents)).toHaveLength(1);
  });
  it('cannot revoke a membership period through another selected-space route', async () => {
    const target = store.governance.createSpace({
      actorId: 'owner', name: 'Membership target', kind: 'shared', now, auth: {
        method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now,
      },
    });
    const member = store.governance.getCurrentMembership({ spaceId: target.id, actorId: 'owner', now });
    if (!member) throw new Error('Target membership was not created');

    expectDenied(await routes.revokeMembership(request({
      selected: spaceId, params: { id: spaceId, membershipId: member.id }, proof: true, body: {},
    })));
    expect(store.governance.getCurrentMembership({ spaceId: target.id, actorId: 'owner', now })?.id).toBe(member.id);
  });

  it('cannot revoke a delegation through another selected-space route', async () => {
    const target = store.governance.createSpace({
      actorId: 'owner', name: 'Delegation target', kind: 'shared', now, auth: {
        method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now,
      },
    });
    const issuer = store.governance.getCurrentMembership({ spaceId: target.id, actorId: 'owner', now });
    if (!issuer) throw new Error('Target membership was not created');
    const agentId = 'agent:delegation-target';
    store.governance.registerAgent({
      spaceId: target.id, agentId, now,
      auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
    });
    store.governance.provisionResourceGrant({
      spaceId: target.id, actorId: 'owner', membershipId: issuer.id, budgetId: null,
      capability: 'observe', resourceKind: 'space', resourceId: target.id, granted: true, now,
    });
    const delegation = store.governance.delegate({
      spaceId: target.id, agentId, issuerMembershipId: issuer.id, expectedVersion: null,
      rights: [{ capability: 'observe', resourceKind: 'space', resourceId: target.id }],
      validFrom: now, now,
      auth: { method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now },
    });

    expectDenied(await routes.revokeDelegation(request({
      selected: spaceId, params: { id: spaceId, delegationId: delegation.id },
      proof: true, body: { expectedVersion: delegation.version },
    })));
    expect(store.governance.listDelegations({ spaceId: target.id }).find((item) => item.id === delegation.id)?.revokedAt)
      .toBeNull();
  });

  it('adds and revokes non-overlapping membership periods without deleting history', async () => {
    await store.upsertActorMembership('member', 'active', ['*'], '*');
    const added = resultOf(await routes.addMembership(request({
      params: { id: spaceId }, proof: true, body: { actorId: 'member', validFrom: now },
    }))).membership;
    expect(added).toMatchObject({ actorId: 'member', origin: 'managed', revokedAt: null });

    expectDenied(await routes.addMembership(request({
      params: { id: spaceId }, proof: true, body: { actorId: 'member', validFrom: now },
    })));
    const membershipId = z.object({ id: z.string() }).parse(added).id;
    expect(resultOf(await routes.revokeMembership(request({
      params: { id: spaceId, membershipId }, proof: true, body: {},
    }))).revoked).toBe(true);
    expect(records(resultOf(await routes.memberships(request({ params: { id: spaceId } }))).memberships)
      .find((period) => period.id === membershipId)).toMatchObject({ revokedAt: now });
  });

  it('writes an exact restricted grant and exposes stale governance-policy CAS conflicts', async () => {
    await store.upsertActorMembership('member', 'active', ['*'], '*');
    const membership = store.governance.addMembership({ spaceId, actorId: 'member', validFrom: now, now, auth: {
      method: 'human-session', actorId: 'owner', sessionId: 'session:owner', reauthenticatedAt: now,
    } });
    const granted = resultOf(await routes.setGrant(request({
      params: { id: spaceId }, proof: true,
      body: {
        membershipId: membership.id, capability: 'read', resourceKind: 'category', resourceId: 'groceries', granted: true,
        restrictions: { aggregateOnly: true, categoryIds: ['groceries'], operations: ['report.read'], maxOperationCount: 1 },
      },
    })));
    expect(granted.grant).toMatchObject({ actorId: 'member', resourceKind: 'category', resourceId: 'groceries', granted: true });
    expectDenied(await routes.setGrant(request({
      params: { id: spaceId }, proof: true,
      body: { membershipId: membership.id, capability: '*', resourceKind: 'space', resourceId: '*', granted: true },
    })));

    expect(resultOf(await routes.setPolicy(request({
      params: { id: spaceId }, proof: true,
      body: { expectedVersion: '1', policy: { minimumApprovers: 2, approvalThresholds: [], operationApprovers: { 'transfer.create': 3 } } },
    }))).policy).toMatchObject({ version: '2', minimumApprovers: 2 });
    expect(await routes.setPolicy(request({
      params: { id: spaceId }, proof: true,
      body: { expectedVersion: '1', policy: { minimumApprovers: 1 } },
    }))).toMatchObject({ status: 'error', error: { code: 'POLICY_VERSION_CONFLICT' } });
    expect(records(resultOf(await routes.policy(request({ params: { id: spaceId } }))).history)).toHaveLength(2);
  });

  it('issues bounded delegations and binds/revokes only a server-verified credential owner', async () => {
    const agentId = 'agent:reporter';
    await routes.registerAgent(request({ params: { id: spaceId }, proof: true, body: { agentId } }));
    store.governance.provisionResourceGrant({
      spaceId, actorId: 'owner', membershipId: ownerMembershipId, budgetId: 'private-budget-id',
      capability: 'observe', resourceKind: 'space', resourceId: spaceId, granted: true, now,
    });
    const delegation = resultOf(await routes.delegate(request({
      params: { id: spaceId }, proof: true,
      body: {
        agentId, issuerMembershipId: ownerMembershipId, expectedVersion: null,
        rights: [{ capability: 'observe', resourceKind: 'space', resourceId: spaceId }], validFrom: now,
      },
    }))).delegation;
    const version = z.object({ id: z.string(), version: z.string() }).parse(delegation);

    expectDenied(await routes.registerCredential(request({
      params: { id: spaceId }, proof: true,
      body: {
        credentialId: 'key-owner', credentialOwnerId: 'victim', principalType: 'agent', principalId: agentId,
        delegationId: version.id, expectedDelegationVersion: version.version,
      },
    })));
    const credential = resultOf(await routes.registerCredential(request({
      params: { id: spaceId }, proof: true,
      body: {
        credentialId: 'key-owner', principalType: 'agent', principalId: agentId,
        delegationId: version.id, expectedDelegationVersion: version.version,
      },
    }))).credential;
    expect(credential).toMatchObject({ credentialId: 'key-owner', credentialOwnerId: 'owner', principalId: agentId });
    expect(resultOf(await routes.revokeCredential(request({
      params: { id: spaceId, credentialId: 'key-owner' }, proof: true, body: {},
    }))).revoked).toBe(true);
    expect(records(resultOf(await routes.credentials(request({ params: { id: spaceId } }))).credentials)[0])
      .toMatchObject({ credentialId: 'key-owner', revokedAt: now });
    expect(resultOf(await routes.revokeDelegation(request({
      params: { id: spaceId, delegationId: version.id }, proof: true, body: { expectedVersion: version.version },
    }))).revoked).toBe(true);
  });

  it('returns attributed audit records without stored private details', async () => {
    const result = resultOf(await routes.audit(request({
      params: { id: spaceId }, query: { action: 'space_created', limit: '10', offset: '0' },
    })));
    const records = z.array(z.object({
      actorId: z.string(), action: z.string(), entityId: z.string().nullable(), timestamp: z.string(),
    }).passthrough()).parse(result.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ actorId: 'owner', action: 'space_created', entityId: spaceId, timestamp: now });
    expect(records[0]).not.toHaveProperty('details');
    expect(JSON.stringify(result)).not.toContain('private-budget-id');
  });
  it('shows scoped Native approvals, invitations, and financial actions without private subjects', async () => {
    const budgetId = 'private-budget-id';
    const humanAuth = (actorId: string, at = now) => ({
      method: 'human-session' as const,
      actorId,
      sessionId: `session:${actorId}`,
      reauthenticatedAt: at,
    });
    const memberships = new Map<string, string>();
    for (const actorId of ['auditor', 'proposer', 'approver', 'executor']) {
      await store.upsertActorMembership(actorId, 'active', [], '');
      const membership = store.governance.addMembership({
        spaceId,
        actorId,
        validFrom: now,
        now,
        auth: humanAuth('owner'),
      });
      memberships.set(actorId, membership.id);
    }
    const auditorMembershipId = memberships.get('auditor');
    if (!auditorMembershipId) throw new Error('Expected current auditor membership');
    store.governance.setResourceGrant({
      spaceId,
      actorId: 'auditor',
      budgetId,
      membershipId: auditorMembershipId,
      capability: 'audit:read',
      resourceKind: 'space',
      resourceId: spaceId,
      granted: true,
      now,
      auth: humanAuth('owner'),
    });

    const proposalResources = [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      { resourceKind: 'transaction' as const, resourceId: 'private-transaction-reference' },
      { resourceKind: 'account' as const, resourceId: 'private-account-reference' },
      { resourceKind: 'category' as const, resourceId: 'private-category-reference' },
    ];
    for (const [actorId, capability] of [
      ['proposer', 'categorization:propose'],
      ['approver', 'categorization:approve'],
      ['executor', 'categorization:execute'],
    ] as const) {
      const membershipId = memberships.get(actorId);
      if (!membershipId) throw new Error('Expected current proposal actor membership');
      for (const resource of proposalResources)
        store.governance.setResourceGrant({
          spaceId,
          actorId,
          budgetId,
          membershipId,
          capability,
          ...resource,
          granted: true,
          now,
          auth: humanAuth('owner'),
        });
    }

    const ownerMembership = store.governance.getCurrentMembership({ spaceId, actorId: 'owner', now });
    const currentPolicy = store.governance.getPolicy({ spaceId });
    if (!ownerMembership || !currentPolicy) throw new Error('Expected current owner policy and membership');
    store.liquidity.savePolicy({
      actorId: 'owner',
      budgetId,
      spaceId,
      membershipId: ownerMembership.id,
      governancePolicyVersion: currentPolicy.version,
      expectedVersion: null,
      expectedGovernancePolicyVersion: currentPolicy.version,
      now,
      auth: humanAuth('owner'),
      policy: {
        version: '1',
        policyHash: 'private-financial-policy',
        expiresAt,
        accounts: [],
        transferRoutes: [],
      },
      approvalPolicy: { minimumApprovers: 1 },
    });
    for (const resource of [
      { capability: 'proposal', resourceKind: 'budget' as const, resourceId: budgetId },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: 'private-source-account' },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: 'private-destination-account' },
      { capability: 'source', resourceKind: 'account' as const, resourceId: 'private-source-account' },
    ])
      store.governance.setResourceGrant({
        spaceId,
        actorId: 'owner',
        budgetId,
        membershipId: ownerMembership.id,
        ...resource,
        granted: true,
        now,
        auth: humanAuth('owner'),
      });
    const currentPolicyAfterLiquidity = store.governance.getPolicy({ spaceId });
    if (!currentPolicyAfterLiquidity) throw new Error('Expected current governance policy');
    store.liquidity.admitTransferProposal({
      actorId: 'owner',
      budgetId,
      spaceId,
      membershipId: ownerMembership.id,
      governancePolicyVersion: currentPolicyAfterLiquidity.version,
      now,
      auth: humanAuth('owner'),
      plan: auditTransferPlan(),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'audit-financial-action',
    }, () => ({ valid: true }));

    const proposal = await store.createProposal({
      spaceId,
      operation: 'set_category',
      budgetId,
      payload: {
        kind: 'set_category',
        transactionId: 'private-transaction-reference',
        categoryId: 'private-category-reference',
      },
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify({
        transactionId: 'private-transaction-reference',
        accountId: 'private-account-reference',
        amount: { minorUnits: '12500', currency: 'USD' },
        direction: 'outgoing',
        currentCategoryId: null,
        actualVersion: 'actual-v1',
      }),
      expiresAt,
      actorId: 'proposer',
      auth: humanAuth('proposer'),
      provenance: 'space-audit-test',
    });
    const approval = await store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'approver',
      expiresAt,
      auth: humanAuth('approver'),
      now,
    });
    await store.acquireProposalExecution({
      actorId: 'executor',
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      governancePolicyVersion: proposal.governancePolicyVersion,
      idempotencyKey: 'audit-generic-execution',
      serialisedEffect: JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions),
      }),
      auth: humanAuth('executor'),
      now,
    });
    const invitation = await store.createInvitation({ spaceId, auth: humanAuth('owner'), now });
    await store.revokeInvitation({
      spaceId,
      invitationId: invitation.invitation.id,
      auth: humanAuth('owner'),
      now,
    });

    const foreignSpace = store.governance.createSpace({
      actorId: 'owner',
      name: 'Foreign audit space',
      kind: 'shared',
      now,
      auth: humanAuth('owner'),
    });
    store.governance.bindBudget({
      spaceId: foreignSpace.id,
      budgetId: 'foreign-audit-budget',
      now,
      auth: humanAuth('owner'),
    });
    const foreignInvitation = await store.createInvitation({
      spaceId: foreignSpace.id,
      auth: humanAuth('owner', after),
      now: after,
    });
    await store.revokeInvitation({
      spaceId: foreignSpace.id,
      invitationId: foreignInvitation.invitation.id,
      auth: humanAuth('owner', after),
      now: after,
    });
    const unboundSpace = store.governance.createSpace({
      actorId: 'owner',
      name: 'Unbound invitation audit space',
      kind: 'shared',
      now,
      auth: humanAuth('owner'),
    });
    const unboundInvitation = await store.createInvitation({
      spaceId: unboundSpace.id,
      auth: humanAuth('owner'),
      now,
    });
    await store.revokeInvitation({
      spaceId: unboundSpace.id,
      invitationId: unboundInvitation.invitation.id,
      auth: humanAuth('owner'),
      now,
    });

    const result = resultOf(await routes.audit(request({
      userId: 'auditor',
      params: { id: spaceId },
      query: { limit: '100' },
    })));
    const auditRecords = records(result.records);
    expect(auditRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorId: 'approver', action: 'approval_granted', entityId: null, timestamp: now,
      }),
      expect.objectContaining({
        actorId: 'executor', action: 'execution_started', entityId: null, timestamp: now,
      }),
      expect.objectContaining({
        actorId: 'owner', action: 'workflow_transition', entityId: null, timestamp: now,
      }),
      expect.objectContaining({
        actorId: 'owner', action: 'invitation_created', entityId: null, timestamp: now,
      }),
      expect.objectContaining({
        actorId: 'owner', action: 'invitation_revoked', entityId: null, timestamp: now,
      }),
    ]));
    expect(auditRecords.some(({ timestamp }) => timestamp === after)).toBe(false);
    expect(auditRecords.every((record) =>
      !('details' in record) && !('payloadHash' in record) && !('backendIds' in record),
    )).toBe(true);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      budgetId,
      proposal.id,
      proposal.payloadHash,
      approval.id,
      invitation.invitation.id,
      invitation.inviteUrl,
      'private-transaction-reference',
      'private-account-reference',
      'private-category-reference',
      'private-source-account',
      'private-destination-account',
      'private-obligation-reference',
    ]) expect(serialized).not.toContain(privateValue);

    const unboundResult = resultOf(await routes.audit(request({
      params: { id: unboundSpace.id },
      selected: unboundSpace.id,
      query: { limit: '100' },
    })));
    expect(records(unboundResult.records)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'owner', action: 'invitation_created', entityId: null }),
      expect.objectContaining({ actorId: 'owner', action: 'invitation_revoked', entityId: null }),
    ]));
  });
});
