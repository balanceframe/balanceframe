// @vitest-environment node
// Real handler/service and SQLite governance; authentication and Actual SDK are injected.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createApp, defineEventHandler, toNodeListener, setResponseStatus } from 'h3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { merchantFixture, humanAuth, now, type MerchantFixture } from '../../../../packages/application/test/merchant-service.fixture';

const deps = vi.hoisted(() => ({ fixture: null as MerchantFixture | null, service: null as unknown }));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => deps.fixture!.manager,
  createMerchantIntelligenceService: async () => deps.service,
}));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getWorkflowStore: () => ({ store: deps.fixture!.store }),
  requireAuthorization: async (event: Parameters<typeof setResponseStatus>[0], capability: string, scope: string) => {
    const fixture = deps.fixture!;
    const [resourceKind, resourceId] = scope.split(':');
    const actor = fixture.actor;
    const result = fixture.store.governance.authorize({
      actorId: actor.actorId, spaceId: actor.spaceId, membershipId: actor.membershipId!,
      expectedPolicyVersion: fixture.store.governance.getPolicy({ spaceId: actor.spaceId })!.version,
      phase: 'read', operation: capability,
      required: [{ resourceKind: resourceKind === 'space' ? 'space' : 'budget', resourceId: resourceId!, capability, visibility: 'resource' }],
      payload: { operations: [] }, now, auth: humanAuth(actor.actorId),
    });
    if (result.allowed && result.disposition.kind === 'authorized_without_approval')
      return { ok: true, info: { actorId: actor.actorId, capability, allowed: true } };
    setResponseStatus(event, 403);
    return { ok: false, response: { status: 'error', result: null, error: { code: 'FORBIDDEN' } } };
  },
}));
import analyze from '../../server/api/merchant/index.get';
import policy from '../../server/api/merchant/policy.get';

afterEach(() => { vi.useRealTimers(); });

describe('merchant HTTP validation keeps stored failures separate from caller input', () => {
  it.each(['invalid-enum', 'out-of-range', 'invalid-json'] as const)('withholds %s stored policy failures without changing authorization', async (corruption) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const fixture = await merchantFixture();
    deps.fixture = fixture;
    deps.service = fixture.service;
    const app = createApp();
    app.use(defineEventHandler((event) => {
      event.context.auth = { authenticated: true, actorId: fixture.actor.actorId, method: 'session', principalType: 'human', sessionId: 'session:holder', user: { id: fixture.actor.actorId } };
    }));
    app.use('/api/merchant/policy', policy);
    app.use('/api/merchant', analyze);
    const server = createServer(toNodeListener(app));
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const ownedDb = new Database(fixture.databasePath);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned loopback listener required');
      const origin = `http://127.0.0.1:${address.port}`;
      const get = async (route: string) => {
        const response = await fetch(`${origin}${route}`, { headers: { 'x-balanceframe-space': fixture.actor.spaceId }, signal: AbortSignal.timeout(5_000) });
        const text = await response.text();
        const envelope = JSON.parse(text);
        expect(text).not.toContain('CORRUPT-STORED-POLICY-SENTINEL');
        return { response, envelope };
      };
      const initial = await get('/api/merchant/policy');
      expect(initial.response.status).toBe(200);
      const { scope, value } = initial.envelope.result;
      const key = JSON.stringify([scope.spaceId, scope.budgetId, scope.connectionId]);
      await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value });
      const analyzed = await get('/api/merchant');
      expect(analyzed.response.status).toBe(200);
      const factsHash = analyzed.envelope.result.sourceAdmission.factsHash as string;
      for (const length of [256, 257, 384, 512]) {
        const result = await get(`/api/merchant?${new URLSearchParams({ cursor: 'c'.repeat(length), factsHash })}`);
        expect(result.response.status).toBe(length === 256 ? 200 : 400);
        if (length !== 256) expect(result.envelope.error.code).toBe('INVALID_MERCHANT_REQUEST');
      }
      const stale = await get(`/api/merchant?${new URLSearchParams({ cursor: 'c'.repeat(257), factsHash: 'wrong-current-source' })}`);
      expect(stale.response.status).toBe(409);
      expect(stale.envelope.error.code).toBe('MERCHANT_OPERATION_UNAVAILABLE');
      const reads = vi.mocked(fixture.client.getTransactions).mock.calls.length;
      const badCaller = await get(`/api/merchant?cursor=${'c'.repeat(513)}`);
      expect(badCaller.response.status).toBe(400);
      expect(badCaller.envelope.error.code).toBe('INVALID_MERCHANT_REQUEST');
      expect(vi.mocked(fixture.client.getTransactions).mock.calls.length).toBe(reads);
      const saved = ownedDb.prepare('SELECT value FROM merchant_policies WHERE scope_key=?').get(key).value as string;
      const parsed = JSON.parse(saved);
      const corrupted = corruption === 'invalid-json' ? '{CORRUPT-STORED-POLICY-SENTINEL' : JSON.stringify({ ...parsed,
        ...(corruption === 'invalid-enum' ? { mode: 'CORRUPT-STORED-POLICY-SENTINEL' } : { cacheTtlHours: 721 }),
      });
      ownedDb.prepare('UPDATE merchant_policies SET value=? WHERE scope_key=?').run(corrupted, key);
      for (const route of ['/api/merchant/policy', '/api/merchant']) {
        const result = await get(route);
        expect(result.response.status).toBe(409);
        expect(result.envelope.error).toMatchObject({ code: 'MERCHANT_OPERATION_UNAVAILABLE', retryable: false });
        expect(result.envelope.result).toBeNull();
      }
      expect(ownedDb.prepare('SELECT value FROM merchant_policies WHERE scope_key=?').get(key).value).toBe(corrupted);
      expect(vi.mocked(fixture.client.getTransactions).mock.calls.length).toBe(reads);
      fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', false);
      const denied = await get(`/api/merchant?${new URLSearchParams({ cursor: 'c'.repeat(257), factsHash })}`);
      expect(denied.response.status).toBe(403);
      expect(denied.envelope.error.code).toBe('FORBIDDEN');
      expect(vi.mocked(fixture.client.getTransactions).mock.calls.length).toBe(reads);
      ownedDb.prepare('UPDATE merchant_policies SET value=? WHERE scope_key=?').run(saved, key);
      expect((await get('/api/merchant/policy')).response.status).toBe(200);
      fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true);
      expect((await get('/api/merchant')).response.status).toBe(200);
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally {
        try { ownedDb.close(); } finally {
          try { await fixture.cleanup(); } finally { deps.fixture = null; deps.service = null; }
        }
      }
    }
  });
});
