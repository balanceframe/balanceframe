import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SqliteWorkflowStore } from '../../workflow-store/src/store.js';
import {
  TransactionEvidenceService,
  type TransactionEvidenceNative,
} from '../src/transaction-evidence.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
const now = '2026-10-21T12:00:00.000Z';
const bundle = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-rule.json', import.meta.url),
    'utf8',
  ),
);
const native = createRequire(import.meta.url)('@balanceframe/native') as TransactionEvidenceNative;
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
async function setup(configured = false, importedCategory: string | null = null) {
  store = new SqliteWorkflowStore();
  await store.claimBootstrap({
    name: 'Owner',
    email: 'owner@example.com',
    claimId: 'receipt-inference',
  });
  await store.finalizeBootstrap({ claimId: 'receipt-inference', ownerUserId: 'owner' });
  const auth = {
    method: 'human-session' as const,
    actorId: 'owner',
    sessionId: 'session',
    reauthenticatedAt: now,
  };
  const space = store.governance.createSpace({
    actorId: 'owner',
    name: 'Items',
    kind: 'personal',
    now,
    auth,
  });
  store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget', now, auth });
  const member = store.governance.getCurrentMembership({
    spaceId: space.id,
    actorId: 'owner',
    now,
  })!;
  const actor = {
    actorId: 'owner',
    spaceId: space.id,
    budgetId: 'budget',
    membershipId: member.id,
    governancePolicyVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
    auth,
  };
  const grant = (
    resourceKind: 'space' | 'budget' | 'evidence' | 'account' | 'category' | 'rule',
    resourceId: string,
    capability: string,
    granted = true,
  ) =>
    store.governance.setResourceGrant({
      spaceId: space.id,
      budgetId: actor.budgetId,
      actorId: actor.actorId,
      membershipId: member.id,
      resourceKind,
      resourceId,
      capability,
      granted,
      now,
      auth,
    });
  for (const capability of [
    'observe',
    'ingest',
    'normalized-evidence',
    'resolve',
    'source',
    'rule:view',
    'item-rule:read',
    'item-rule:propose',
    'item-rule:approve',
    'receipt-inference:local',
    'receipt-inference:external',
    'receipt-inference:policy:manage',
  ])
    grant('budget', 'budget', capability);
  grant('space', space.id, 'receipt-inference:policy:manage');
  for (const capability of ['existence', 'name', 'transaction'])
    grant('account', 'checking', capability);
  for (const capability of ['category', 'name']) grant('category', 'food', capability);
  const snapshot = actualLiquidityRequest(false).financialSnapshot;
  snapshot.legacySnapshot.rules = [];
  snapshot.legacySnapshot.accounts = [
    { ...snapshot.legacySnapshot.accounts[0]!, id: 'checking', isClosed: false },
  ];
  snapshot.legacySnapshot.categories = [
    { ...snapshot.legacySnapshot.categories[0]!, id: 'food', name: 'Groceries', deleted: false },
  ];
  const config = { serverUrl: 'https://actual.fixture.test', budgetId: 'budget' };
  const manager = {
    loadConfig: async () => config,
    withConnection: vi.fn(async (consume: (connected: unknown) => unknown) =>
      consume({ config, synchronization: { financialSnapshot: snapshot } }),
    ),
  };
  const infer = vi.fn(
    async (
      payload: { categories: { alias: string }[] },
      context: { dispatchGuard: () => Promise<void> },
    ): Promise<unknown> => {
      await context.dispatchGuard();
      return { categoryAlias: payload.categories[0]!.alias };
    },
  );
  const provider = {
    info: {
      id: 'synthetic-local',
      version: '1',
      model: 'test',
      locality: 'local' as const,
      configRevision: '1',
    },
    infer,
  };
  const external = {
    info: { ...provider.info, id: 'synthetic-external', locality: 'external' as const },
    infer: vi.fn(
      async (
        payload: { categories: { alias: string }[] },
        context: { dispatchGuard: () => Promise<void> },
      ): Promise<unknown> => {
        await context.dispatchGuard();
        return { categoryAlias: payload.categories[0]!.alias };
      },
    ),
  };
  const policy = {
    local: { enabled: true, providerIds: [provider.info.id] },
    external: { enabled: true, providerIds: [external.info.id] },
    maxCallsPerDay: 10,
    cacheTtlSeconds: 60,
  };
  const installation = { installationId: 'synthetic-installation', revision: '1', policy };
  const service = new TransactionEvidenceService({
    store,
    native,
    rawEncryptionKey: Buffer.alloc(32),
    connectionManager: manager as never,
    clock: () => new Date(now),
    ...(configured
      ? { receiptInference: { installation: () => installation, providers: [provider, external] } }
      : {}),
  });
  const content = {
    templateVersion: 'retail-v1',
    observations: bundle.evidence.observations
      .filter((row: { kind: string }) => row.kind !== 'ledger_transaction')
      .map(({ provenance: _p, ...row }: { provenance: unknown; id: string }) => ({
        ...row,
        ...(row.id === 'wallet-1' ? { kind: 'receipt', eventType: 'purchase' } : {}),
      })),
    receipts: bundle.evidence.receipts.map(
      (receipt: { tenders: Array<Record<string, unknown>> }) => ({
        ...receipt,
        tenders: receipt.tenders.map((t) => ({ ...t, observationId: null })),
      }),
    ),
  };
  if (importedCategory) content.receipts[0].lines[0].categoryId = importedCategory;
  const saved = await service.ingest(actor, {
    connectorId: 'retail',
    sourceId: 'receipt-1',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'retail',
    content: JSON.stringify(content),
  });
  for (const capability of [
    'evidence',
    'normalized-evidence',
    'receipt-inference:local',
    'receipt-inference:external',
  ])
    grant('evidence', saved.document.id, capability);
  const selection = {
    accountId: 'checking',
    receiptId: 'receipt-1',
    lineId: 'line-1',
    locality: 'local' as const,
  };
  async function enable() {
    for (const layer of ['space', 'budget'] as const) {
      const current = await service.receiptInferencePolicy(actor, { layer });
      await service.updateReceiptInferencePolicy(actor, {
        layer,
        expectedRevision: current.revision,
        policy,
      });
    }
  }
  return {
    service,
    actor,
    selection,
    infer,
    external,
    enable,
    policy,
    installation,
    grant,
    snapshot,
    content,
    sourceId: saved.document.id,
  };
}
describe('optional receipt inference application', () => {
  it('keeps the core manual path available with no configured providers', async () => {
    const { service, actor, selection } = await setup();
    expect(await service.receiptInferencePreview(actor, selection)).toMatchObject({
      state: 'manual',
      reasonCode: 'inference_unavailable',
    });
  });
  it('requires all independent opt-ins and then previews only minimized labels before explicit execution', async () => {
    const { service, actor, selection, infer, enable } = await setup(true);
    expect(await service.receiptInferencePreview(actor, selection)).toMatchObject({
      state: 'manual',
    });
    expect(infer).not.toHaveBeenCalled();
    await enable();
    const preview = await service.receiptInferencePreview(actor, selection);
    expect(preview.state).toBe('preview');
    if (preview.state !== 'preview') throw new Error('preview missing');
    expect(JSON.stringify(preview.payload)).not.toMatch(
      /checking|receipt-1|line-1|card-1|person-1|minorUnits|amount|rawDescription|food/,
    );
    expect(infer).not.toHaveBeenCalled();
    const result = await service.receiptInferenceRun(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
    });
    expect(result).toMatchObject({
      state: 'suggested',
      categoryId: 'food',
      receiptId: 'receipt-1',
      lineId: 'line-1',
      provenance: { locality: 'local' },
    });
    expect(infer).toHaveBeenCalledTimes(1);
    await expect(
      service.receiptInferenceRun(actor, {
        previewId: preview.previewId,
        payloadHash: preview.payloadHash,
      }),
    ).rejects.toThrow();
  });
  it('checks approved deterministic rules before any optional model or missing installation', async () => {
    const { service, actor, selection, infer } = await setup();
    const rule = await service.proposeItemRule(actor, {
      connectorId: 'retail',
      accountId: 'checking',
      fundingInstrumentId: 'card-1',
      counterparty: 'person-1',
      sku: 'sku-1',
      normalizedDescription: null,
      categoryId: 'food',
    });
    await service.approveItemRule(actor, { proposalId: rule.id, payloadHash: rule.payloadHash });
    expect(await service.receiptInferencePreview(actor, selection)).toMatchObject({
      state: 'deterministic',
      categoryId: 'food',
    });
    expect(infer).not.toHaveBeenCalled();
  });
  it('never cascades to external inference and requires explicit rejection of a usable local result', async () => {
    const { service, actor, selection, external, enable } = await setup(true);
    await enable();
    expect(
      await service.receiptInferencePreview(actor, { ...selection, locality: 'external' }),
    ).toMatchObject({ state: 'manual', reasonCode: 'local_first' });
    const preview = await service.receiptInferencePreview(actor, selection);
    if (preview.state !== 'preview') throw new Error('preview missing');
    await service.receiptInferenceRun(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
    });
    expect(external.infer).not.toHaveBeenCalled();
    expect(
      await service.receiptInferencePreview(actor, { ...selection, locality: 'external' }),
    ).toMatchObject({ reasonCode: 'local_first' });
    await service.receiptInferenceWithdraw(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      action: 'rejected',
    });
    expect(
      await service.receiptInferencePreview(actor, { ...selection, locality: 'external' }),
    ).toMatchObject({ state: 'preview' });
    expect(external.infer).not.toHaveBeenCalled();
  });
});
describe('receipt inference asynchronous fences', () => {
  for (const mutation of [
    'source-grant',
    'category-label',
    'category-grant',
    'installation',
    'consent',
    'restore',
    'new-rule',
  ] as const) {
    it(`withholds results when ${mutation} changes while a provider is awaited`, async () => {
      const ctx = await setup(true);
      await ctx.enable();
      const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
      if (preview.state !== 'preview') throw new Error('preview missing');
      let mutated = false;
      ctx.infer.mockImplementationOnce(async (payload, providerContext) => {
        await providerContext.dispatchGuard();
        if (mutation === 'source-grant')
          ctx.grant('evidence', ctx.sourceId, 'normalized-evidence', false);
        if (mutation === 'category-label')
          ctx.snapshot.legacySnapshot.categories[0]!.name = 'Changed';
        if (mutation === 'category-grant') ctx.grant('category', 'food', 'name', false);
        if (mutation === 'installation') ctx.installation.revision = '2';
        if (mutation === 'consent')
          await ctx.service.receiptInferenceWithdraw(ctx.actor, {
            previewId: preview.previewId,
            payloadHash: preview.payloadHash,
            action: 'revoked',
          });
        if (mutation === 'restore') store.evidence.quarantineRestore(now);
        if (mutation === 'new-rule')
          ctx.snapshot.legacySnapshot.rules = [
            {
              id: 'changed-rule',
              name: 'new',
              order: 0,
              trigger: { conditionsOp: 'and', conditions: [] },
              actions: [],
              inactive: false,
            },
          ];
        mutated = true;
        return { categoryAlias: payload.categories[0]!.alias };
      });
      expect(
        await ctx.service.receiptInferenceRun(ctx.actor, {
          previewId: preview.previewId,
          payloadHash: preview.payloadHash,
        }),
      ).toMatchObject({ state: 'manual' });
      expect(mutated).toBe(true);
      expect(ctx.infer).toHaveBeenCalledTimes(1);
      expect(ctx.external.infer).not.toHaveBeenCalled();
    });
  }
  it('blocks dispatch when preparation changes policy and allows no automatic external fallback', async () => {
    const ctx = await setup(true);
    await ctx.enable();
    const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
    if (preview.state !== 'preview') throw new Error('preview missing');
    let sent = false;
    ctx.infer.mockImplementationOnce(async (payload, context) => {
      ctx.installation.revision = '2';
      await context.dispatchGuard();
      sent = true;
      return { categoryAlias: payload.categories[0]!.alias };
    });
    expect(
      await ctx.service.receiptInferenceRun(ctx.actor, {
        previewId: preview.previewId,
        payloadHash: preview.payloadHash,
      }),
    ).toMatchObject({ state: 'manual' });
    expect(sent).toBe(false);
    expect(ctx.external.infer).not.toHaveBeenCalled();
  });
  it('uses scoped cache only while current authority and payload remain unchanged', async () => {
    const ctx = await setup(true);
    await ctx.enable();
    const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
    if (preview.state !== 'preview') throw new Error('preview missing');
    await ctx.service.receiptInferenceRun(ctx.actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
    });
    expect(await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection)).toMatchObject({
      state: 'suggested',
      categoryId: 'food',
    });
    expect(ctx.infer).toHaveBeenCalledTimes(1);
    ctx.grant('budget', 'budget', 'receipt-inference:local', false);
    expect(await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection)).toMatchObject({
      state: 'manual',
    });
    expect(ctx.infer).toHaveBeenCalledTimes(1);
  });
  it('requires fresh human consent and rejects caller-supplied authority and category payloads', async () => {
    const ctx = await setup(true);
    await ctx.enable();
    const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
    if (preview.state !== 'preview') throw new Error('preview missing');
    await expect(
      ctx.service.receiptInferenceRun(
        { ...ctx.actor, auth: { ...ctx.actor.auth, reauthenticatedAt: '2020-01-01T00:00:00Z' } },
        { previewId: preview.previewId, payloadHash: preview.payloadHash },
      ),
    ).rejects.toThrow(/Fresh/);
    await expect(
      ctx.service.receiptInferencePreview(ctx.actor, { ...ctx.selection, amount: 12 }),
    ).rejects.toThrow();
    expect(ctx.infer).not.toHaveBeenCalled();
  });
});
describe('current local-first dispatch fence', () => {
  for (const phase of ['before-consent', 'during-preparation'] as const) {
    it(`withholds external dispatch when a new local result is usable ${phase}`, async () => {
      const ctx = await setup(true);
      await ctx.enable();
      const local = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
      if (local.state !== 'preview') throw new Error('local missing');
      await ctx.service.receiptInferenceRun(ctx.actor, {
        previewId: local.previewId,
        payloadHash: local.payloadHash,
      });
      await ctx.service.receiptInferenceWithdraw(ctx.actor, {
        previewId: local.previewId,
        payloadHash: local.payloadHash,
        action: 'rejected',
      });
      const external = await ctx.service.receiptInferencePreview(ctx.actor, {
        ...ctx.selection,
        locality: 'external',
      });
      if (external.state !== 'preview') throw new Error('external missing');
      const newLocal = async () => {
        const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
        if (preview.state !== 'preview') throw new Error('new local missing');
        await ctx.service.receiptInferenceRun(ctx.actor, {
          previewId: preview.previewId,
          payloadHash: preview.payloadHash,
        });
      };
      let sent = false;
      ctx.external.infer.mockImplementationOnce(async (payload, context) => {
        if (phase === 'during-preparation') await newLocal();
        await context.dispatchGuard();
        sent = true;
        return { categoryAlias: payload.categories[0]!.alias };
      });
      if (phase === 'before-consent') {
        await newLocal();
        await expect(
          ctx.service.receiptInferenceRun(ctx.actor, {
            previewId: external.previewId,
            payloadHash: external.payloadHash,
          }),
        ).rejects.toThrow();
      } else
        expect(
          await ctx.service.receiptInferenceRun(ctx.actor, {
            previewId: external.previewId,
            payloadHash: external.payloadHash,
          }),
        ).toMatchObject({ state: 'manual' });
      expect(sent).toBe(false);
    });
  }
});
it('exports content-free actor-scoped inference audit under its independent capability', async () => {
  const ctx = await setup(true);
  await ctx.enable();
  const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
  if (preview.state !== 'preview') throw new Error('preview missing');
  await ctx.service.receiptInferenceRun(ctx.actor, {
    previewId: preview.previewId,
    payloadHash: preview.payloadHash,
  });
  const exported = await ctx.service.exportEvidence(ctx.actor, {});
  expect(exported.receiptInferenceAudit.map((event) => event.status)).toEqual([
    'completed',
    'dispatched',
    'preview',
  ]);
  expect(JSON.stringify(exported.receiptInferenceAudit)).not.toMatch(
    /Groceries|checking|itemLabel|categoryAlias|nonce/,
  );
  ctx.grant('budget', 'budget', 'receipt-inference:local', false);
  expect((await ctx.service.exportEvidence(ctx.actor, {})).receiptInferenceAudit).toEqual([]);
});

it('does not promote imported category hints into approved deterministic suggestions', async () => {
  const ctx = await setup(true, 'food');
  await ctx.enable();
  expect(await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection)).toMatchObject({
    state: 'preview',
  });
  expect(ctx.infer).not.toHaveBeenCalled();
});
it('offers external inference only through its own minimized consent after a local abstention', async () => {
  const ctx = await setup(true);
  await ctx.enable();
  ctx.infer.mockImplementationOnce(async (_payload, context) => {
    await context.dispatchGuard();
    return { categoryAlias: null };
  });
  const local = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
  if (local.state !== 'preview') throw new Error('local missing');
  expect(
    await ctx.service.receiptInferenceRun(ctx.actor, {
      previewId: local.previewId,
      payloadHash: local.payloadHash,
    }),
  ).toMatchObject({ state: 'manual' });
  expect(ctx.external.infer).not.toHaveBeenCalled();
  const external = await ctx.service.receiptInferencePreview(ctx.actor, {
    ...ctx.selection,
    locality: 'external',
  });
  if (external.state !== 'preview') throw new Error('external missing');
  expect(ctx.external.infer).not.toHaveBeenCalled();
  expect(
    await ctx.service.receiptInferenceRun(ctx.actor, {
      previewId: external.previewId,
      payloadHash: external.payloadHash,
    }),
  ).toMatchObject({ state: 'suggested', categoryId: 'food', provenance: { locality: 'external' } });
  expect(ctx.external.infer).toHaveBeenCalledTimes(1);
});
it('keeps the manual path after invalid provider output without leaking model text', async () => {
  const ctx = await setup(true);
  await ctx.enable();
  ctx.infer.mockImplementationOnce(async (_payload, context) => {
    await context.dispatchGuard();
    return { categoryAlias: 'invented', rationale: 'private provider text' };
  });
  const preview = await ctx.service.receiptInferencePreview(ctx.actor, ctx.selection);
  if (preview.state !== 'preview') throw new Error('preview missing');
  const result = await ctx.service.receiptInferenceRun(ctx.actor, {
    previewId: preview.previewId,
    payloadHash: preview.payloadHash,
  });
  expect(result).toMatchObject({ state: 'manual' });
  expect(JSON.stringify(await ctx.service.exportEvidence(ctx.actor, {}))).not.toContain(
    'private provider text',
  );
  expect(ctx.external.infer).not.toHaveBeenCalled();
});
