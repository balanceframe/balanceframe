// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as H3 from 'h3';
import { SqliteWorkflowStore } from '../../../../packages/workflow-store/src/store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type * as AuthModule from '../../lib/auth';
import type * as SpaceContext from '../../server/utils/space-context';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import fixture from '../../../../protocol/fixtures/representative.json';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { projectReviewQueueItem } from '../../server/utils/review-projection';
import { selectedLiquidityActor } from '../../server/utils/liquidity-service';

interface Request extends EventWithContext {
  headers: Record<string, string>;
  cookies: Record<string, string>;
  node: { req: { headers: Record<string, string> } };
  body?: unknown;
}
const deps = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  defineEventHandler: <T>(handler: T) => handler,
  getRequestPath: () => '/api/merchant',
  getHeader: (event: Request, name: string) => event.headers[name.toLowerCase()],
  getRequestHeaders: (event: Request) => event.headers,
  getCookie: (event: Request, name: string) => event.cookies[name],
  setCookie: (event: Request, name: string, value: string) => { event.cookies[name] = value; },
  setResponseStatus: vi.fn(), setHeader: vi.fn(),
}));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<Record<string, unknown>>()), getWorkflowStore: deps.store,
}));

let directory: string;
let auth: typeof AuthModule.auth;
let store: SqliteWorkflowStore;
let userId: string;
let spaceId: string;
let headers: Record<string, string>;
let middleware: (event: Request) => Promise<unknown>;
let select: typeof SpaceContext.requireSelectedSpace;
beforeEach(async () => {
  vi.resetModules();
  // One clock for both real auth rows and workflow membership admission.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-05T12:00:00.000Z');
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  directory = mkdtempSync(join(tmpdir(), 'credential-lifetime-'));
  // Reloading the module is intentional: each test owns a newly configured auth DB.
  vi.stubEnv('NUXT_AUTH_DB_PATH', join(directory, 'auth.sqlite'));
  vi.stubEnv('BETTER_AUTH_SECRET', 'credential-lifetime-fixture-secret-with-enough-entropy');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
  auth = (await import('../../lib/auth')).auth;
  await auth.$context;
  const created = await auth.api.createUser({ body: { email: 'lifetime@example.test', name: 'Lifetime', password: 'credential-lifetime-fixture-password' } });
  userId = created.user.id;
  const signedIn = await auth.api.signInEmail({ body: { email: created.user.email, password: 'credential-lifetime-fixture-password' }, returnHeaders: true });
  headers = { cookie: signedIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ') };
  store = new SqliteWorkflowStore(':memory:');
  await store.claimBootstrap({ name: 'Lifetime', email: created.user.email, claimId: 'lifetime' });
  await store.finalizeBootstrap({ claimId: 'lifetime', ownerUserId: userId });
  const now = new Date().toISOString();
  const human = { method: 'human-session' as const, actorId: userId, sessionId: 'trusted-bootstrap', reauthenticatedAt: now };
  spaceId = store.governance.createSpace({ actorId: userId, name: 'Lifetime', kind: 'shared', now, auth: human }).id;
  store.governance.bindBudget({ spaceId, budgetId: 'budget-lifetime', now, auth: human });
  deps.store.mockReturnValue({ store });
  middleware = (await import('../../server/middleware/auth')).default as unknown as typeof middleware;
  select = (await import('../../server/utils/space-context')).requireSelectedSpace;
});
afterEach(() => {
  store?.close();
  auth?.options.database.close();
  vi.useRealTimers(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function admitted(credentialHeaders: Record<string, string>) {
  const requestHeaders = { ...credentialHeaders, 'x-balanceframe-space': spaceId };
  const event: Request = { headers: requestHeaders, cookies: {}, node: { req: { headers: requestHeaders } }, body: { credentialExpiresAt: '2999-01-01T00:00:00.000Z', isCredentialValid: true }, context: {} };
  expect(await middleware(event)).toBeUndefined();
  const selected = await select(event);
  expect(selected).toMatchObject({ ok: true });
  if (!selected.ok) throw new Error('Actual credential must be admitted before expiry');
  return { event, selected };
}

describe('server verified Better Auth credential lifetime', () => {
  it.each(['session', 'api-key'] as const)('withholds baseline Review Money when the actual %s expires during deferred source capture', async (method) => {
    let credentialHeaders = headers;
    let expiry: Date;
    if (method === 'session') {
      const source = await auth.api.getSession({ headers: new Headers(headers) });
      if (!source) throw new Error('Actual session unavailable');
      expiry = source.session.expiresAt;
    } else {
      const key = await auth.api.createApiKey({ body: { userId, expiresIn: 86400, rateLimitEnabled: false } });
      const now = new Date().toISOString();
      store.governance.registerCredentialBinding({
        spaceId, credentialId: key.id, credentialOwnerId: userId, principalType: 'human', principalId: userId,
        now, auth: { method: 'human-session', actorId: userId, sessionId: 'trusted-binding', reauthenticatedAt: now },
      });
      credentialHeaders = { authorization: `Bearer ${key.key}` };
      expiry = key.expiresAt!;
    }
    const { selected } = await admitted(credentialHeaders);
    const actor = selectedLiquidityActor(store, selected);
    if (!actor) throw new Error('Baseline Review actor unavailable');
    const snapshot = canonicalProtocolSnapshotSchema.parse(fixture);
    const transaction = snapshot.transactions[0]!;
    const target = snapshot.transactions[1]!.categoryId!;
    const now = new Date().toISOString();
    const control = { method: 'human-session' as const, actorId: userId, sessionId: 'trusted-projection-grants', reauthenticatedAt: now };
    for (const capability of ['existence', 'history', 'name'])
      store.governance.setResourceGrant({ spaceId, actorId: userId, membershipId: selected.membership.id, budgetId: 'budget-lifetime', resourceKind: 'account', resourceId: transaction.accountId, capability, granted: true, now, auth: control });
    for (const resourceId of new Set([transaction.categoryId!, target]))
      for (const capability of ['existence', 'name'])
        store.governance.setResourceGrant({ spaceId, actorId: userId, membershipId: selected.membership.id, budgetId: 'budget-lifetime', resourceKind: 'category', resourceId, capability, granted: true, now, auth: control });
    const item = await store.createReviewItem({ budgetId: 'budget-lifetime', transactionId: transaction.id, categoryId: target, classifier: 'baseline', provenance: 'canonical-fixture' });
    expect(projectReviewQueueItem(store, actor, item, snapshot)?.evidence.money).toEqual(transaction.amount);
    let resume!: () => void;
    const sourceWait = new Promise<void>((resolve) => { resume = resolve; });
    const disclose = async () => {
      await sourceWait;
      return projectReviewQueueItem(store, actor, item, snapshot);
    };
    const projection = disclose();
    vi.setSystemTime(expiry);
    expect(selected.auth.isCredentialValid!(new Date().toISOString())).toBe(false);
    expect(store.governance.getCurrentMembership({ spaceId, actorId: userId, now: new Date().toISOString() })?.id).toBe(selected.membership.id);
    resume();
    expect(await projection).toBeNull();
  });

  it('retains the actual session expiry and synchronous current row validity after entry', async () => {
    const source = await auth.api.getSession({ headers: new Headers(headers) });
    expect(source).not.toBeNull();
    const { event, selected } = await admitted(headers);
    expect(selected.auth).toMatchObject({ credentialExpiresAt: source!.session.expiresAt.toISOString(), isCredentialValid: expect.any(Function) });
    expect(selected.auth.isCredentialValid!(new Date().toISOString())).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(source!.session.expiresAt);
    expect(selected.auth.isCredentialValid!(new Date().toISOString())).toBe(false);
    expect(await select(event)).toMatchObject({ ok: false });
    expect(store.governance.getCurrentMembership({ spaceId, actorId: userId, now: new Date().toISOString() })).not.toBeNull();
  });
  it('denies a revoked authoritative session even though its entry identity and workflow membership remain unchanged', async () => {
    const source = await auth.api.getSession({ headers: new Headers(headers) });
    const { event, selected } = await admitted(headers);
    expect(selected.auth.isCredentialValid).toEqual(expect.any(Function));
    await auth.api.revokeSession({ headers: new Headers(headers), body: { token: source!.session.token } });
    expect(selected.auth.isCredentialValid!(new Date().toISOString())).toBe(false);
    expect(await select(event)).toMatchObject({ ok: false });
    expect(store.governance.getCurrentMembership({ spaceId, actorId: userId, now: new Date().toISOString() })).not.toBeNull();
  });
  it('does not replace the actual session lifetime with fresh human reauthentication proof', async () => {
    const { event, selected } = await admitted(headers);
    const reauthentication = await import('../../server/utils/reauthentication');
    expect(await reauthentication.issueReauthentication(event as unknown as ReauthenticationEvent, 'credential-lifetime-fixture-password')).toBe(true);
    const proof = await reauthentication.getHumanControlAuth(event as unknown as ReauthenticationEvent);
    expect(proof).toMatchObject({
      method: 'human-session', credentialExpiresAt: selected.auth.credentialExpiresAt,
      isCredentialValid: selected.auth.isCredentialValid,
    });
    expect(proof?.credentialExpiresAt).toEqual(expect.any(String));
    expect(proof?.isCredentialValid).toEqual(expect.any(Function));
    await auth.api.revokeSessions({ headers: new Headers(headers) });
    expect(proof!.isCredentialValid!(new Date().toISOString())).toBe(false);
  });
  it.each(['expiry', 'disabled', 'deleted'] as const)('rechecks current API key %s without consuming a second request or changing workflow rights', async (state) => {
    const key = await auth.api.createApiKey({ body: { userId, expiresIn: 86400, rateLimitEnabled: false } });
    const now = new Date().toISOString();
    store.governance.registerCredentialBinding({ spaceId, credentialId: key.id, credentialOwnerId: userId, principalType: 'human', principalId: userId, now, auth: { method: 'human-session', actorId: userId, sessionId: 'trusted-binding', reauthenticatedAt: now } });
    const { event, selected } = await admitted({ authorization: `Bearer ${key.key}` });
    expect(selected.auth).toMatchObject({ credentialExpiresAt: key.expiresAt!.toISOString(), isCredentialValid: expect.any(Function) });
    expect(selected.auth.isCredentialValid!(now)).toBe(true);
    if (state === 'expiry') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(key.expiresAt!); }
    if (state === 'disabled') await auth.api.updateApiKey({ body: { keyId: key.id, userId, enabled: false } });
    if (state === 'deleted') await auth.api.deleteApiKey({ body: { keyId: key.id }, headers: new Headers(headers) });
    expect(selected.auth.isCredentialValid!(new Date().toISOString())).toBe(false);
    expect(await select(event)).toMatchObject({ ok: false });
    expect(store.governance.resolveCredentialPrincipal({ credentialId: key.id, referenceId: userId, spaceId, now: new Date().toISOString() })).not.toBeNull();
  });
  it('uses null only for an actual nonexpiring key, still with live revocation authority', async () => {
    const key = await auth.api.createApiKey({ body: { userId, rateLimitEnabled: false } });
    expect(key.expiresAt).toBeNull();
    const now = new Date().toISOString();
    store.governance.registerCredentialBinding({ spaceId, credentialId: key.id, credentialOwnerId: userId, principalType: 'human', principalId: userId, now, auth: { method: 'human-session', actorId: userId, sessionId: 'trusted-binding', reauthenticatedAt: now } });
    const { selected } = await admitted({ authorization: `Bearer ${key.key}` });
    expect(selected.auth).toMatchObject({ credentialExpiresAt: null, isCredentialValid: expect.any(Function) });
    await auth.api.updateApiKey({ body: { keyId: key.id, userId, enabled: false } });
    expect(selected.auth.isCredentialValid!(new Date().toISOString())).toBe(false);
  });
});
