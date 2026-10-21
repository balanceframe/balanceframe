// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import type { MerchantActor, TransactionEvidenceService } from '@balanceframe/application';
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
const deps = vi.hoisted(() => ({
  service: {
    list: vi.fn(),
    ingest: vi.fn(),
    resolve: vi.fn(),
    saveResolutionDecision: vi.fn(),
    ledgerTargets: vi.fn(),
    health: vi.fn(),
    exportEvidence: vi.fn(),
    detail: vi.fn(),
    raw: vi.fn(),
    deleteRaw: vi.fn(),
    ingestSpendSession: vi.fn(),
  },
  actor: { actorId: 'server-selected-human', governancePolicyVersion: 'server-policy' },
  options: new Map<unknown, unknown>(),
}));
vi.mock('h3', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readBody: async (event: { body: unknown }) => event.body,
  getRouterParam: (event: { id?: string }) => event.id,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (
    operation: (
      event: H3Event,
      service: TransactionEvidenceService,
      actor: MerchantActor,
    ) => Promise<unknown>,
    options = {},
  ) => {
    const handler = (event: H3Event) =>
      operation(
        event,
        deps.service as unknown as TransactionEvidenceService,
        deps.actor as unknown as MerchantActor,
      );
    deps.options.set(handler, options);
    return handler;
  },
}));
import list from '../../server/api/evidence/index.get';
import ingest from '../../server/api/evidence/index.post';
import resolve from '../../server/api/evidence/resolve.post';
import decision from '../../server/api/evidence/decision.post';
import targets from '../../server/api/evidence/targets.get';
import health from '../../server/api/evidence/health.get';
import exportEvidence from '../../server/api/evidence/export.get';
import detail from '../../server/api/evidence/[id].get';
import raw from '../../server/api/evidence/[id]/raw.get';
import deleteRaw from '../../server/api/evidence/[id]/raw.delete';
import spendSession from '../../server/api/evidence/spend-session.post';
const event = (body: unknown = {}, id = 'source') => ({ body, id }) as unknown as H3Event;
beforeEach(() => {
  for (const method of Object.values(deps.service)) method.mockReset();
});
describe('evidence HTTP operation contracts', () => {
  it('preserves selected identity on reads and exports normalization without raw bytes', async () => {
    deps.service.list.mockResolvedValue(['document']);
    deps.service.health.mockResolvedValue(['connector']);
    expect(await list(event())).toEqual({ documents: ['document'] });
    expect(await health(event())).toEqual({ connectors: ['connector'] });
    await targets(event());
    await exportEvidence(event());
    await detail(event());
    expect(deps.service.list).toHaveBeenCalledWith(deps.actor);
    expect(deps.service.health).toHaveBeenCalledWith(deps.actor);
    expect(deps.service.ledgerTargets).toHaveBeenCalledWith(deps.actor);
    expect(deps.service.exportEvidence).toHaveBeenCalledWith(deps.actor, { includeRaw: false });
    expect(deps.service.detail).toHaveBeenCalledWith(deps.actor, 'source');
    await expect(detail(event({}, ''))).rejects.toThrow();
  });
  it('hands untrusted import claims to the validating service under ingest authority', async () => {
    const claims = { actorId: 'untrusted-claim', content: 'private source' };
    await ingest(event(claims));
    await spendSession(event({ sessionId: 'saved-session', expectedVersion: 3 }));
    expect(deps.service.ingest).toHaveBeenCalledWith(deps.actor, claims);
    expect(deps.service.ingestSpendSession).toHaveBeenCalledWith(deps.actor, {
      sessionId: 'saved-session',
      expectedVersion: 3,
    });
    expect(deps.options.get(ingest)).toEqual({ write: true, capability: 'ingest' });
    expect(deps.options.get(spendSession)).toEqual({ write: true, capability: 'ingest' });
  });
  it('uses current server policy for resolution and rejects caller-assigned policy or identity', async () => {
    await resolve(event());
    expect(deps.service.resolve).toHaveBeenCalledWith(deps.actor, {
      policyVersion: 'server-policy',
    });
    await expect(resolve(event({ policyVersion: 'forged' }))).rejects.toThrow();
    const body = {
      resolutionHash: 'a'.repeat(64),
      relationships: [],
      ledgerEffects: [],
      purposeDecisions: [],
    };
    await decision(event(body));
    expect(deps.service.saveResolutionDecision).toHaveBeenCalledWith(deps.actor, {
      ...body,
      policyVersion: 'server-policy',
    });
    await expect(decision(event({ ...body, actorId: 'forged' }))).rejects.toThrow();
    expect(deps.options.get(decision)).toEqual({ write: true, human: true, capability: 'resolve' });
    expect(deps.options.get(resolve)).toEqual({ write: true, capability: 'resolve' });
  });
  it('keeps raw reads inert and deletion behind fresh human control', async () => {
    deps.service.raw
      .mockResolvedValueOnce(Buffer.from('<script>untrusted</script>'))
      .mockResolvedValueOnce(null);
    expect(await raw(event())).toEqual({
      contentBase64: Buffer.from('<script>untrusted</script>').toString('base64'),
    });
    expect(await raw(event())).toEqual({ contentBase64: null });
    deps.service.deleteRaw.mockResolvedValue(true);
    expect(await deleteRaw(event())).toEqual({ deleted: true });
    expect(deps.service.raw).toHaveBeenCalledWith(deps.actor, 'source');
    expect(deps.service.deleteRaw).toHaveBeenCalledWith(deps.actor, 'source');
    expect(deps.options.get(deleteRaw)).toEqual({ write: true, human: true });
  });
  it('admits normal panel reviews and explicit item choices without accepting supplied review provenance', async () => {
    const body = {
      resolutionHash: 'a'.repeat(64),
      relationships: [],
      purposeDecisions: [],
      ledgerEffects: [],
      itemCategoryDecisions: [],
    };
    await decision(event(body));
    expect(deps.service.saveResolutionDecision).toHaveBeenLastCalledWith(deps.actor, {
      ...body,
      policyVersion: 'server-policy',
    });
    const choice = {
      receiptId: 'receipt',
      lineId: 'line',
      accountId: 'account',
      categoryId: 'category',
    };
    for (const categoryId of ['category', null]) {
      const reviewed = { ...body, itemCategoryDecisions: [{ ...choice, categoryId }] };
      await decision(event(reviewed));
      expect(deps.service.saveResolutionDecision).toHaveBeenLastCalledWith(deps.actor, {
        ...reviewed,
        policyVersion: 'server-policy',
      });
    }
    deps.service.saveResolutionDecision.mockClear();
    for (const forged of [
      { actorId: 'other' },
      { policyVersion: 'other' },
      { contentHash: 'a'.repeat(64) },
      { reviewedAt: '2026-01-01T00:00:00Z' },
    ]) {
      await expect(
        decision(event({ ...body, itemCategoryDecisions: [{ ...choice, ...forged }] })),
      ).rejects.toThrow();
    }
    await expect(
      decision(event({ ...body, itemCategoryDecisions: Array(10001).fill(choice) })),
    ).rejects.toThrow();
    expect(deps.service.saveResolutionDecision).not.toHaveBeenCalled();
  });
});
