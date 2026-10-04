import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from 'h3';
import type { H3Event } from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { readFile, rm, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ConnectionManager } from '@balanceframe/application';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getHumanControlAuth, issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';
import type { HumanControlAuth, ReauthenticationEvent } from '../../server/utils/reauthentication';

const mocks = vi.hoisted(() => {
  const state = { manager: null as unknown, configBudgetId: '', connected: null as unknown };
  const withConnection = vi.fn(async (
    operation: (connected: unknown) => Promise<unknown>,
    options?: { expectedBudgetId?: string },
  ) => {
    if (options?.expectedBudgetId && options.expectedBudgetId !== state.configBudgetId)
      throw new Error('Selected budget changed');
    return operation(state.connected);
  });
  return {
    state,
    getSession: vi.fn(),
    verifyPassword: vi.fn(),
    withConnection,
    disconnect: vi.fn(async (expectedBudgetId?: string) => {
      if (expectedBudgetId && expectedBudgetId !== state.configBudgetId)
        throw new Error('Selected budget changed');
      return { cacheRemoved: true, credentialsRemoved: true };
    }),
    removeConnection: vi.fn(async (expectedBudgetId?: string) => {
      if (expectedBudgetId && expectedBudgetId !== state.configBudgetId)
        throw new Error('Selected budget changed');
      return { cacheRemoved: true, credentialsRemoved: true };
    }),
  };
});

vi.mock('h3', async (original) => ({
  ...(await original<typeof import('h3')>()),
  readBody: async (event: { body?: unknown }) => event.body,
}));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => mocks.state.manager as ConnectionManager,
}));

import exportHandler from '../../server/api/lifecycle/export.post';
import disconnectHandler from '../../server/api/lifecycle/disconnect.post';
import removeConnectionHandler from '../../server/api/lifecycle/remove-connection.post';
import deleteDataHandler from '../../server/api/lifecycle/delete-data.post';

const ACTOR = 'lifecycle-source-human';
const SESSION = 'lifecycle-source-session';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-20T10:00:00.000Z';
let directory = '';
let store: SqliteWorkflowStore;
let proofCookie = '';
let controlAuth: HumanControlAuth;
let exportPaths: string[] = [];
let sequence = 0;

type SpaceFixture = {
  readonly id: string;
  readonly budgetId: string;
  readonly membershipId: string;
  readonly name: string;
};

function request(path: string, spaceId = '', options: {
  readonly body?: unknown;
  readonly proof?: boolean;
  readonly origin?: string;
  readonly auth?: NonNullable<EventWithContext['context']['auth']>;
} = {}) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'POST';
  const cookies = ['better-auth.session_token=lifecycle-fixture'];
  if (options.proof !== false && proofCookie) cookies.push(proofCookie);
  req.headers = {
    origin: options.origin ?? ORIGIN,
    'x-balanceframe-space': spaceId,
    cookie: cookies.join('; '),
    'content-type': 'application/json',
  };
  if (options.auth?.method === 'api-key') req.headers.authorization = 'Bearer lifecycle-agent-key';
  if (options.body !== undefined) {
    const body = JSON.stringify(options.body);
    req.headers['content-length'] = String(Buffer.byteLength(body));
    req.push(Buffer.from(body));
  }
  req.push(null);
  const event = createEvent(req, new ServerResponse(req)) as H3Event & EventWithContext & { body?: unknown };
  event.body = options.body;
  event.context.auth = options.auth ?? {
    authenticated: true,
    actorId: ACTOR,
    user: { id: ACTOR },
    method: 'session',
    principalType: 'human',
    sessionId: SESSION,
    impersonatedBy: null,
  };
  event.context.runtimeConfig = { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false };
  return event;
}

async function makeSpace(name: string): Promise<SpaceFixture> {
  const serial = ++sequence;
  const budgetId = `lifecycle-budget-${serial}`;
  const space = store.governance.createSpace({ actorId: ACTOR, name, kind: 'shared', now: NOW, auth: controlAuth });
  const bound = store.governance.bindBudget({ spaceId: space.id, budgetId, now: NOW, auth: controlAuth });
  const membership = store.governance.getCurrentMembership({ spaceId: bound.id, actorId: ACTOR, now: NOW });
  if (!membership) throw new Error('Lifecycle fixture membership unavailable');
  for (const capability of ['observe', 'full-read'])
    store.governance.provisionResourceGrant({
      spaceId: bound.id,
      actorId: ACTOR,
      membershipId: membership.id,
      budgetId,
      capability,
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      now: NOW,
    });
  return { id: bound.id, budgetId, membershipId: membership.id, name };
}

function selectBudget(space: SpaceFixture) {
  mocks.state.configBudgetId = space.budgetId;
  const snapshot = {
    accounts: [{ id: `account-${space.budgetId}`, name: 'Checking' }],
    transactions: [{ id: `transaction-${space.budgetId}`, accountId: `account-${space.budgetId}`, amount: 1250 }],
    categories: [],
    payees: [],
  };
  const synchronization = { snapshot };
  mocks.state.connected = {
    config: { budgetId: space.budgetId },
    budget: { id: space.budgetId, name: space.name },
    connector: { synchronize: vi.fn(async () => synchronization) },
    synchronization,
  };
}

async function seedNotification(budgetId: string) {
  return store.createNotificationEvent({
    budgetId,
    classification: 'security_alert',
    payload: { status: 'fixture' },
    policyVersion: '1',
    now: NOW,
  });
}

async function seedReview(budgetId: string, suffix: string) {
  return store.createReviewItem({
    budgetId,
    transactionId: `transaction-${suffix}`,
    categoryId: 'fixture-category',
    classifier: 'fixture',
    provenance: 'lifecycle-route-regression',
  });
}
async function seedJob(space: SpaceFixture, suffix: string) {
  return store.enqueueJob({
    jobType: 'lifecycle-fixture',
    candidateId: `${space.budgetId}:${suffix}`,
    spaceId: space.id,
    budgetId: space.budgetId,
    actorId: ACTOR,
  });
}

async function issueAgent(space: SpaceFixture) {
  const agentId = `agent:lifecycle-${sequence}`;
  store.governance.registerAgent({ spaceId: space.id, agentId, now: NOW, auth: controlAuth });
  const delegation = store.governance.delegate({
    spaceId: space.id,
    agentId,
    issuerMembershipId: space.membershipId,
    expectedVersion: null,
    rights: [
      { capability: 'observe', resourceKind: 'budget', resourceId: space.budgetId },
      { capability: 'full-read', resourceKind: 'budget', resourceId: space.budgetId },
    ],
    validFrom: NOW,
    now: NOW,
    auth: controlAuth,
  });
  const credentialId = `credential:lifecycle-${sequence}`;
  store.governance.registerCredentialBinding({
    spaceId: space.id,
    credentialId,
    credentialOwnerId: ACTOR,
    principalType: 'agent',
    principalId: agentId,
    delegationId: delegation.id,
    expectedDelegationVersion: delegation.version,
    now: NOW,
    auth: controlAuth,
  });
  return {
    authenticated: true,
    actorId: agentId,
    user: { id: ACTOR },
    method: 'api-key' as const,
    principalType: 'agent' as const,
    credentialId,
    credentialOwnerId: ACTOR,
    delegationId: delegation.id,
    delegationVersion: delegation.version,
    impersonatedBy: null,
  };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_SECRET', 'lifecycle-source-fixture-secret');
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  directory = mkdtempSync(join(tmpdir(), 'lifecycle-source-native-'));
  mocks.getSession.mockResolvedValue({ user: { id: ACTOR }, session: { id: SESSION, userId: ACTOR } });
  mocks.verifyPassword.mockResolvedValue({ status: true });
  const opened = getWorkflowStore(request('/api/lifecycle/export') as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Lifecycle source owner', email: 'lifecycle-source@example.test', claimId: 'lifecycle-source-fixture' });
  await store.finalizeBootstrap({ claimId: 'lifecycle-source-fixture', ownerUserId: ACTOR });
  await store.upsertActorMembership(ACTOR, 'active', [], '*');

  const unproved = request('/api/lifecycle/export');
  if (!(await issueReauthentication(unproved as ReauthenticationEvent, 'fixture-password')))
    throw new Error('Lifecycle fixture could not issue a fresh human proof');
  const setCookie = unproved.node.res.getHeader('set-cookie');
  const values = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  proofCookie = values.map((value) => value.split(';', 1)[0]!)
    .find((value) => value.startsWith(`${REAUTH_COOKIE_NAME}=`)) ?? '';
  if (!proofCookie) throw new Error('Lifecycle fixture proof cookie was not issued');
  const proof = await getHumanControlAuth(request('/api/lifecycle/export') as ReauthenticationEvent);
  if (!proof) throw new Error('Lifecycle fixture proof could not be verified');
  controlAuth = proof;
});

beforeEach(async () => {
  vi.clearAllMocks();
  const manager = {
    loadConfig: vi.fn(async () => ({
      version: 1 as const,
      serverUrl: 'https://actual.example.test',
      budgetId: mocks.state.configBudgetId,
      budgetName: 'Configured Actual budget',
      groupId: 'actual-group',
    })),
    withConnection: mocks.withConnection,
    disconnect: mocks.disconnect,
    removeConnection: mocks.removeConnection,
  };
  mocks.state.manager = manager as unknown as ConnectionManager;
  mocks.state.configBudgetId = '';
  mocks.state.connected = null;
});

afterAll(async () => {
  store.close();
  await Promise.all([...new Set(exportPaths.map(dirname))].map((path) => rm(path, { recursive: true, force: true })));
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('selected-space lifecycle API', () => {
  it('requires fresh human control and unrestricted full read before snapshot access', async () => {
    const space = await makeSpace('Lifecycle export A');
    selectBudget(space);
    const missingSpace = await exportHandler(request('/api/lifecycle/export'));
    expect(missingSpace.status).toBe('error');
    expect(mocks.withConnection).not.toHaveBeenCalled();

    const missingProof = await exportHandler(request('/api/lifecycle/export', space.id, { proof: false }));
    expect(missingProof.status).toBe('error');
    expect(mocks.withConnection).not.toHaveBeenCalled();

    const agent = await issueAgent(space);
    const agentResponse = await exportHandler(request('/api/lifecycle/export', space.id, { auth: agent }));
    expect(agentResponse.status).toBe('error');
    expect(mocks.withConnection).not.toHaveBeenCalled();

    store.governance.provisionResourceGrant({
      spaceId: space.id,
      actorId: ACTOR,
      membershipId: space.membershipId,
      budgetId: space.budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: space.budgetId,
      granted: true,
      restrictions: { aggregateOnly: true },
      now: NOW,
    });
    const restricted = await exportHandler(request('/api/lifecycle/export', space.id));
    expect(restricted.status).toBe('error');
    expect(mocks.withConnection).not.toHaveBeenCalled();
  });

  it('exports the selected synchronized Actual budget with verifiable private provenance', async () => {
    const space = await makeSpace('Actual budget name is not Balanced Budget');
    selectBudget(space);

    const response = await exportHandler(request('/api/lifecycle/export', space.id));

    expect(response.status).toBe('ok');
    exportPaths.push(response.result.exportPath);
    expect(response.authorization).toMatchObject({ capability: 'connection:manage', allowed: true });
    expect(response.result).toMatchObject({
      budgetName: space.name,
      accountCount: 1,
      transactionCount: 1,
    });
    expect(response.result.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.withConnection).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      expectedBudgetId: space.budgetId,
    }));
    const content = await readFile(response.result.exportPath, 'utf8');
    expect(JSON.parse(content)).toMatchObject({
      budgetName: space.name,
      accounts: [{ id: `account-${space.budgetId}` }],
      transactions: [{ id: `transaction-${space.budgetId}` }],
    });
    expect(createHash('sha256').update(content, 'utf8').digest('hex')).toBe(response.result.sha256Hash);
    expect((await stat(response.result.exportPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(response.result.exportPath))).mode & 0o777).toBe(0o700);
    expect(await readFile(`${response.result.exportPath}.bfv`, 'utf8')).toContain(response.result.sha256Hash);
    const saved = await store.getLastExport({ spaceId: space.id, budgetId: space.budgetId, actorId: ACTOR });
    expect(saved).toMatchObject({ budgetName: space.name, exportPath: response.result.exportPath });
    expect(await store.getLastExport({ spaceId: space.id, budgetId: space.budgetId, actorId: 'another-human' })).toBeNull();
  });

  it('requires a same-space verified export and deletes only selected notification data', async () => {
    const selected = await makeSpace('Deletion selected space');
    const foreign = await makeSpace('Deletion foreign space');
    const selectedEvent = await seedNotification(selected.budgetId);
    const foreignEvent = await seedNotification(foreign.budgetId);
    const selectedReview = await seedReview(selected.budgetId, 'selected');
    const foreignReview = await seedReview(foreign.budgetId, 'foreign');
    const selectedJob = await seedJob(selected, 'notification');
    const foreignJob = await seedJob(foreign, 'notification');
    const legacyJob = await store.enqueueJob({
      jobType: 'legacy-lifecycle-fixture',
      candidateId: `unscoped-${sequence}`,
    });

    selectBudget(foreign);
    const foreignExport = await exportHandler(request('/api/lifecycle/export', foreign.id));
    expect(foreignExport.status).toBe('ok');
    exportPaths.push(foreignExport.result.exportPath);
    selectBudget(selected);
    const scope = { scope: 'notification' };
    const withoutSelectedBackup = await deleteDataHandler(request('/api/lifecycle/delete-data', selected.id, { body: scope }));
    expect(withoutSelectedBackup.status).toBe('error');
    expect(await store.getNotificationEvent(selectedEvent.id)).not.toBeNull();
    expect(await store.getNotificationEvent(foreignEvent.id)).not.toBeNull();
    expect((await store.getPendingJobs()).map(({ id }) => id)).toContain(selectedJob.id);
    expect((await store.getPendingJobs()).map(({ id }) => id)).toContain(foreignJob.id);

    const exported = await exportHandler(request('/api/lifecycle/export', selected.id));
    expect(exported.status).toBe('ok');
    exportPaths.push(exported.result.exportPath);
    const membershipBefore = store.governance.listMembershipHistory({ spaceId: selected.id, actorId: ACTOR });
    const auditBefore = store.governance.listAuditRecords({ spaceId: selected.id, actorId: ACTOR, now: NOW });
    const deleted = await deleteDataHandler(request('/api/lifecycle/delete-data', selected.id, { body: scope }));

    expect(deleted.status).toBe('ok');
    expect(deleted.result).toMatchObject({ scope: 'notification', actualNonMutation: true });
    expect(deleted.authorization).toMatchObject({ capability: 'policy:manage', allowed: true });
    expect(deleted.result.recordsDeleted).toBeGreaterThan(0);
    expect(await store.getNotificationEvent(selectedEvent.id)).toBeNull();
    expect(await store.getNotificationEvent(foreignEvent.id)).not.toBeNull();
    const remainingJobs = (await store.getPendingJobs()).map(({ id }) => id);
    expect(remainingJobs).not.toContain(selectedJob.id);
    expect(remainingJobs).toContain(foreignJob.id);
    expect(remainingJobs).toContain(legacyJob.id);
    expect(deleted.result.recordsRetained).toBeGreaterThan(0);
    expect(deleted.result.retentionReasons.join(' ')).toMatch(/unscoped|job.*scope|scope.*job/i);
    expect((await store.listReviewItems({ budgetId: selected.budgetId })).map(({ id }) => id)).toContain(selectedReview.id);
    expect((await store.listReviewItems({ budgetId: foreign.budgetId })).map(({ id }) => id)).toContain(foreignReview.id);
    expect(store.governance.listMembershipHistory({ spaceId: selected.id, actorId: ACTOR })).toEqual(membershipBefore);
    expect(store.governance.listAuditRecords({ spaceId: selected.id, actorId: ACTOR, now: NOW }).length).toBeGreaterThanOrEqual(auditBefore.length);
    expect(await store.getLastExport({ spaceId: foreign.id, budgetId: foreign.budgetId, actorId: ACTOR })).not.toBeNull();
  });

  it('disconnect preserves space identity while remove-connection cleans only its selected project cache', async () => {
    const selected = await makeSpace('Lifecycle connection selected');
    const foreign = await makeSpace('Lifecycle connection foreign');
    const selectedReview = await seedReview(selected.budgetId, 'connection-selected');
    const foreignReview = await seedReview(foreign.budgetId, 'connection-foreign');
    const selectedJob = await seedJob(selected, 'disconnect');
    const foreignJob = await seedJob(foreign, 'disconnect');
    const selectedMemberships = store.governance.listMembershipHistory({ spaceId: selected.id, actorId: ACTOR });
    const actorMembership = await store.getActorMembership(ACTOR);

    selectBudget(selected);
    const disconnected = await disconnectHandler(request('/api/lifecycle/disconnect', selected.id));
    expect(disconnected.status).toBe('ok');
    expect(disconnected.authorization).toMatchObject({ capability: 'connection:manage', allowed: true });
    expect(disconnected.result).toMatchObject({ disconnected: true, cacheRemoved: true });
    expect(mocks.disconnect).toHaveBeenCalledWith(selected.budgetId);
    expect((await store.listReviewItems({ budgetId: selected.budgetId })).map(({ id }) => id)).toContain(selectedReview.id);
    expect(await store.getActorMembership(ACTOR)).toEqual(actorMembership);
    expect(store.governance.listMembershipHistory({ spaceId: selected.id, actorId: ACTOR })).toEqual(selectedMemberships);
    const pendingAfterDisconnect = (await store.getPendingJobs()).map(({ id }) => id);
    expect(pendingAfterDisconnect).not.toContain(selectedJob.id);
    expect(pendingAfterDisconnect).toContain(foreignJob.id);

    const removalJob = await seedJob(selected, 'remove');
    selectBudget(selected);
    const removed = await removeConnectionHandler(request('/api/lifecycle/remove-connection', selected.id));
    expect(removed.status).toBe('ok');
    expect(removed.authorization).toMatchObject({ capability: 'connection:manage', allowed: true });
    expect(mocks.removeConnection).toHaveBeenCalledWith(selected.budgetId);
    expect(removed.result).toMatchObject({ removed: true, cacheRemoved: true });

    expect(await store.listReviewItems({ budgetId: selected.budgetId })).toHaveLength(0);
    expect((await store.listReviewItems({ budgetId: foreign.budgetId })).map(({ id }) => id)).toContain(foreignReview.id);
    expect(await store.getActorMembership(ACTOR)).toEqual(actorMembership);
    expect(store.governance.listMembershipHistory({ spaceId: selected.id, actorId: ACTOR })).toEqual(selectedMemberships);
    const pendingAfterRemoval = (await store.getPendingJobs()).map(({ id }) => id);
    expect(pendingAfterRemoval).not.toContain(removalJob.id);
    expect(pendingAfterRemoval).toContain(foreignJob.id);
  });

  it('rejects foreign browser origins and invalid deletion scopes before changing data', async () => {

    const space = await makeSpace('Lifecycle validation space');
    const event = await seedNotification(space.budgetId);
    selectBudget(space);

    const foreignOrigin = await disconnectHandler(request('/api/lifecycle/disconnect', space.id, {
      origin: 'https://attacker.example.test',
    }));
    expect(foreignOrigin.status).toBe('error');
    expect(mocks.disconnect).not.toHaveBeenCalled();

    const invalidScope = await deleteDataHandler(request('/api/lifecycle/delete-data', space.id, {
      body: { scope: 'everything' },
    }));
    expect(invalidScope.status).toBe('error');
    expect(await store.getNotificationEvent(event.id)).not.toBeNull();
    const missingScope = await deleteDataHandler(request('/api/lifecycle/delete-data', space.id, { body: {} }));
    expect(missingScope.status).toBe('error');
    expect(await store.getNotificationEvent(event.id)).not.toBeNull();
  });
});
