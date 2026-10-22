import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/store.js';
import { receiptInferencePolicySchema } from '../src/receipt-inference.js';
import type { EvidenceAccess } from '../src/transaction-evidence.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
    'utf8',
  ),
);
const now = '2026-10-21T12:00:00.000Z';
const access: EvidenceAccess = {
  scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
  actorId: 'owner',
  now,
  authorize: () => true,
};
const policy = {
  local: { enabled: true, providerIds: ['fixture'] },
  external: { enabled: true, providerIds: ['fixture'] },
  maxCallsPerDay: 1,
  cacheTtlSeconds: 60,
};
const installation = { installationId: 'installation', revision: '1', policy };
let store: SqliteWorkflowStore;
afterEach(() => {
  store?.close();
  access.scope.spaceId = 'space';
});
function setup(existing?: SqliteWorkflowStore) {
  store = existing ?? new SqliteWorkflowStore();
  const document = store.evidence.ingest(
    access,
    {
      connectorId: 'camera',
      sourceId: 'receipt',
      mediaType: 'image/jpeg',
      sourceTimestamp: now,
      parserVersion: 'v1',
      privateActorId: null,
      retentionUntil: '2026-10-23T00:00:00.000Z',
      parseStatus: 'parsed',
      quality: [],
      content: Buffer.from('synthetic'),
      extraction: {
        receipts: fixture.receipts,
        observations: fixture.observations.map(
          ({ provenance: _p, ...v }: Record<string, unknown>) => ({
            ...v,
            kind: 'receipt',
            eventType: 'purchase',
          }),
        ),
      },
    },
    Buffer.alloc(32, 1),
  ).document;
  const workflow = store.evidence.receiptInference;
  for (const layer of ['space', 'budget'] as const) {
    const state = workflow.policyState(access, layer);
    workflow.updatePolicy(access, {
      layer,
      expectedRevision: state.revision,
      policy,
      review: { membershipId: 'member', policyVersion: 'policy' },
    });
  }
  const binding = {
    subject: {
      kind: 'receipt-item' as const,
      accountId: 'account',
      documentId: document.id,
      contentHash: document.contentHash,
      parserVersion: 'v1',
      receiptId: fixture.receipts[0].id,
      lineId: fixture.receipts[0].lines[0].id,
    },
    subjectHash: 'a'.repeat(64),
    bindingHash: 'b'.repeat(64),
    payloadHash: 'c'.repeat(64),
    nonce: 'd'.repeat(32),
    aliasMapping: { c1234567890abcdef: 'category' },
    provider: {
      id: 'fixture',
      version: '1',
      model: 'synthetic',
      locality: 'local' as const,
      configRevision: '1',
    },
  };
  const preview = () => workflow.createPreview(access, binding, installation);
  const ref = (p: ReturnType<typeof preview>) => ({
    previewId: p.id,
    payloadHash: p.payloadHash,
    bindingHash: p.bindingHash,
    nonce: p.nonce,
  });
  return { document, workflow, binding, preview, ref };
}
describe('purpose-specific receipt inference journal', () => {
  it('is disabled by default and requires CAS system layer policy', () => {
    const { workflow, binding } = setup();
    expect(() => workflow.createPreview(access, binding, null)).toThrow();
    const state = workflow.policyState(access, 'space');
    expect(() =>
      workflow.updatePolicy(access, {
        layer: 'space',
        expectedRevision: 'stale',
        policy,
        review: { membershipId: 'member', policyVersion: 'policy' },
      }),
    ).toThrow();
    workflow.updatePolicy(access, {
      layer: 'space',
      expectedRevision: state.revision,
      policy: null,
      review: { membershipId: 'member', policyVersion: 'policy' },
    });
    expect(() => workflow.createPreview(access, binding, installation)).toThrow();
    expect(() => receiptInferencePolicySchema.parse({ ...policy, extra: true })).toThrow();
  });
  it('persists only exact content-free preview and one live dispatch, completion and cache', () => {
    const { workflow, preview, ref, document } = setup();
    const p = preview();
    expect(store.evidence.latestDecision(access, [document.id])).toBeNull();
    expect(() =>
      workflow.finishDispatch(
        access,
        { ...ref(p), result: { categoryAlias: 'c1234567890abcdef' } },
        installation,
      ),
    ).toThrow();
    workflow.consumePreview(access, ref(p), installation);
    expect(() => workflow.consumePreview(access, ref(p), installation)).toThrow();
    const done = workflow.finishDispatch(
      access,
      { ...ref(p), result: { categoryAlias: 'c1234567890abcdef', confidence: 0.8 } },
      installation,
    );
    expect(done.status).toBe('completed');
    expect(workflow.lookup(access, { bindingHash: p.bindingHash }, installation)?.id).toBe(p.id);
    expect(() =>
      workflow.finishDispatch(access, { ...ref(p), result: { categoryAlias: null } }, installation),
    ).toThrow();
    expect(
      workflow.getPreview(
        { ...access, actorId: 'peer' },
        { previewId: p.id, payloadHash: p.payloadHash },
      ),
    ).toBeNull();
    workflow.withdraw(access, { previewId: p.id, payloadHash: p.payloadHash }, 'rejected');
    expect(workflow.lookup(access, { bindingHash: p.bindingHash }, installation)).toBeNull();
    expect(workflow.latestLocal(access, { subjectHash: p.subjectHash }, installation)?.status).toBe(
      'rejected',
    );
  });
  it('atomically reserves aggregate quotas across actors and never refunds failed I/O', () => {
    const { workflow, preview, ref, binding } = setup();
    const first = preview();
    const peer = { ...access, actorId: 'peer' };
    const second = workflow.createPreview(peer, binding, installation);
    workflow.consumePreview(access, ref(first), installation);
    expect(() => workflow.consumePreview(peer, ref(second), installation)).toThrow(/quota/i);
    workflow.failDispatch(
      access,
      { previewId: first.id, payloadHash: first.payloadHash },
      'failed',
    );
    expect(() => workflow.consumePreview(peer, ref(second), installation)).toThrow(/quota/i);
  });
  it('expires consent and fences changed policy, source deletion and restored journal', () => {
    const { workflow, preview, ref, document } = setup();
    const p = preview();
    expect(() =>
      workflow.consumePreview({ ...access, now: '2026-10-21T12:05:00.000Z' }, ref(p), installation),
    ).toThrow();
    workflow.consumePreview(access, ref(p), installation);
    store.evidence.deleteRaw(access, document.id);
    expect(() =>
      workflow.finishDispatch(access, { ...ref(p), result: { categoryAlias: null } }, installation),
    ).toThrow();
    store.evidence.quarantineRestore(now);
    expect(() =>
      workflow.finishDispatch(access, { ...ref(p), result: { categoryAlias: null } }, installation),
    ).toThrow();
  });
  it('actor lifecycle purge removes journal for shared-only documents', async () => {
    store = new SqliteWorkflowStore();
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'lifecycle' });
    await store.finalizeBootstrap({ claimId: 'lifecycle', ownerUserId: 'owner' });
    const auth = {
      method: 'human-session' as const,
      actorId: 'owner',
      sessionId: 'session',
      reauthenticatedAt: now,
    };
    const space = store.governance.createSpace({
      actorId: 'owner',
      name: 'Inference',
      kind: 'personal',
      now,
      auth,
    });
    store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget', now, auth });
    access.scope.spaceId = space.id;
    const { workflow, preview, ref } = setup(store);
    const p = preview();
    workflow.consumePreview(access, ref(p), installation);
    const beforePolicy = workflow.policyState(access, 'space');
    const result = await store.deleteScopeData('user', {
      ...access.scope,
      actorId: access.actorId,
    });
    expect(result.retained.reasons).toContain(
      '2 receipt inference policy record(s) retained with administrator attribution',
    );
    expect(result.retained.reasons).toContain(
      '1 receipt inference quota reservation(s) retained to preserve shared daily limits',
    );
    expect(result.retained.count).toBeGreaterThanOrEqual(3);
    expect(workflow.policyState(access, 'space')).toEqual(beforePolicy);
    expect(workflow.getPreview(access, { previewId: p.id, payloadHash: p.payloadHash })).toBeNull();
    const scopeResult = await store.deleteScopeData('workflow', {
      ...access.scope,
      actorId: access.actorId,
    });
    expect(scopeResult.retained.reasons).toContain(
      '1 receipt inference policy record(s) retained with administrator attribution',
    );
    expect(scopeResult.retained.reasons).toContain(
      '1 receipt inference quota reservation(s) retained to preserve shared daily limits',
    );
    expect(workflow.policyState(access, 'space')).toEqual(beforePolicy);
  });
  it('requires the original preview before I/O even if a dispatch row survives partial deletion', () => {
    const { workflow, preview, ref } = setup();
    const p = preview();
    workflow.consumePreview(access, ref(p), installation);
    expect(
      workflow.readLiveDispatch(
        access,
        { previewId: p.id, payloadHash: p.payloadHash, bindingHash: p.bindingHash },
        installation,
      )?.status,
    ).toBe('dispatched');
    const db = (store as unknown as { db: Database }).db;
    db.prepare(
      "DELETE FROM transaction_evidence_decisions WHERE source_hash='receipt-item-inference:1' AND json_extract(value,'$.status')='preview'",
    ).run();
    expect(
      workflow.readLiveDispatch(
        access,
        { previewId: p.id, payloadHash: p.payloadHash, bindingHash: p.bindingHash },
        installation,
      ),
    ).toBeNull();
  });
  it('uses the newest malformed or revoked policy without falling back to earlier opt-in', () => {
    const { workflow, preview } = setup();
    const p = preview();
    const state = workflow.policyState(access, 'space');
    const db = (store as unknown as { db: Database }).db;
    const row = db
      .prepare(
        "SELECT scope_key FROM transaction_evidence_decisions WHERE source_hash='receipt-item-inference-policy:1' AND json_extract(value,'$.layer')='space' ORDER BY sequence DESC LIMIT 1",
      )
      .get() as { scope_key: string };
    db.prepare(
      'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
    ).run(row.scope_key, 'system:receipt-inference', 'receipt-item-inference-policy:1', '{broken');
    expect(workflow.policyState(access, 'space').policy).toBeNull();
    expect(workflow.policyState(access, 'space').revision).not.toBe(state.revision);
    expect(
      workflow.readLivePreview(
        access,
        { previewId: p.id, payloadHash: p.payloadHash, bindingHash: p.bindingHash },
        installation,
      ),
    ).toBeNull();
    expect(() => preview()).toThrow();
  });
  it('shares space policy across budgets and budget policy across connections with independent revisions', () => {
    const { workflow } = setup();
    expect(
      workflow.policyState({ ...access, scope: { ...access.scope, budgetId: 'other' } }, 'space'),
    ).toEqual(workflow.policyState(access, 'space'));
    expect(
      workflow.policyState(
        { ...access, scope: { ...access.scope, connectionId: 'other' } },
        'budget',
      ),
    ).toEqual(workflow.policyState(access, 'budget'));
    expect(
      workflow.policyState({ ...access, scope: { ...access.scope, budgetId: 'other' } }, 'budget')
        .policy,
    ).toBeNull();
  });
  it('revalidates policies, authorization, payload and aliases at every transition', () => {
    const { workflow, preview, ref } = setup();
    const p = preview();
    for (const change of [
      { payloadHash: 'f'.repeat(64) },
      { bindingHash: 'f'.repeat(64) },
      { nonce: 'f'.repeat(32) },
    ])
      expect(() =>
        workflow.consumePreview(access, { ...ref(p), ...change }, installation),
      ).toThrow();
    expect(
      workflow.readLivePreview(
        { ...access, authorize: () => false },
        { previewId: p.id, payloadHash: p.payloadHash, bindingHash: p.bindingHash },
        installation,
      ),
    ).toBeNull();
    workflow.consumePreview(access, ref(p), installation);
    expect(() =>
      workflow.finishDispatch(
        access,
        { ...ref(p), result: { categoryAlias: 'c0000000000000000' } },
        installation,
      ),
    ).toThrow();
    expect(() =>
      workflow.finishDispatch(
        access,
        { ...ref(p), result: { categoryAlias: null, extra: true } as never },
        installation,
      ),
    ).toThrow();
    expect(
      workflow.readLiveDispatch(
        access,
        { previewId: p.id, payloadHash: p.payloadHash, bindingHash: p.bindingHash },
        { ...installation, revision: '2' },
      ),
    ).toBeNull();
    const state = workflow.policyState(access, 'budget');
    workflow.updatePolicy(access, {
      layer: 'budget',
      expectedRevision: state.revision,
      policy,
      review: { membershipId: 'member', policyVersion: 'new' },
    });
    expect(() =>
      workflow.finishDispatch(access, { ...ref(p), result: { categoryAlias: null } }, installation),
    ).toThrow();
  });
  it('serializes quota reservations through separate SQLite handles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-quota-'));
    const filename = join(dir, 'workflow.sqlite');
    let peerStore: SqliteWorkflowStore | undefined;
    try {
      const { workflow, preview, ref, binding } = setup(new SqliteWorkflowStore(filename));
      peerStore = new SqliteWorkflowStore(filename);
      const peer = { ...access, actorId: 'peer' };
      const first = preview();
      const second = peerStore.evidence.receiptInference.createPreview(peer, binding, installation);
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => workflow.consumePreview(access, ref(first), installation)),
        Promise.resolve().then(() =>
          peerStore!.evidence.receiptInference.consumePreview(peer, ref(second), installation),
        ),
      ]);
      expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    } finally {
      peerStore?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects forged subject shapes and missing sources and expires cache without extending consent', () => {
    const { workflow, binding, preview, ref } = setup();
    for (const subject of [
      { ...binding.subject, kind: 'actual-transaction' },
      { ...binding.subject, lineId: 'absent' },
      { ...binding.subject, contentHash: 'f'.repeat(64) },
    ])
      expect(() =>
        workflow.createPreview(access, { ...binding, subject } as never, installation),
      ).toThrow();
    const p = preview();
    workflow.consumePreview(access, ref(p), installation);
    workflow.finishDispatch(access, { ...ref(p), result: { categoryAlias: null } }, installation);
    expect(
      workflow.latestForSubject(
        access,
        { subjectHash: p.subjectHash, bindingHash: p.bindingHash },
        installation,
      )?.id,
    ).toBe(p.id);
    expect(
      workflow.lookup(
        { ...access, now: '2026-10-21T12:01:00.000Z' },
        { bindingHash: p.bindingHash },
        installation,
      ),
    ).toBeNull();
    workflow.withdraw(access, { previewId: p.id, payloadHash: p.payloadHash }, 'revoked');
    expect(workflow.latestLocal(access, { subjectHash: p.subjectHash }, installation)?.status).toBe(
      'revoked',
    );
    expect(() =>
      workflow.withdraw(access, { previewId: p.id, payloadHash: p.payloadHash }, 'rejected'),
    ).toThrow();
  });
  it('exports only content-free actor-scoped audit under current locality grants after source deletion', () => {
    const { workflow, preview, ref, document } = setup();
    const p = preview();
    workflow.consumePreview(access, ref(p), installation);
    workflow.failDispatch(access, { previewId: p.id, payloadHash: p.payloadHash }, 'failed');
    store.evidence.deleteRaw(access, document.id);
    const audit = workflow.audit(access);
    expect(audit.map((e) => e.status)).toEqual(['failed', 'dispatched', 'preview']);
    expect(Object.keys(audit[0]).sort()).toEqual(
      [
        'previewId',
        'at',
        'status',
        'subjectHash',
        'bindingHash',
        'payloadHash',
        'provider',
        'failureCode',
      ].sort(),
    );
    expect(JSON.stringify(audit)).not.toContain('category');
    expect(JSON.stringify(audit)).not.toContain('aliasMapping');
    expect(JSON.stringify(audit)).not.toContain('nonce');
    expect(JSON.stringify(audit)).not.toContain('account');
    expect(workflow.audit({ ...access, actorId: 'peer' })).toEqual([]);
    expect(workflow.audit({ ...access, authorize: () => false })).toEqual([]);
  });
  it('keeps dispatch proof, revocation and complete audit usable beyond ten thousand journal events', () => {
    const { workflow, preview, ref, binding } = setup();
    const first = preview();
    workflow.consumePreview(access, ref(first), installation);
    const db = (store as unknown as { db: Database }).db;
    db.prepare(
      `WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<10001)
      INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value)
      SELECT ?,?,'receipt-item-inference:1',json_set(?,'$.id','bulk-'||n,'$.subjectHash',?,'$.bindingHash',?) FROM entries`,
    ).run(
      JSON.stringify([access.scope.spaceId, access.scope.budgetId, access.scope.connectionId]),
      access.actorId,
      JSON.stringify(first),
      'f'.repeat(64),
      'e'.repeat(64),
    );
    const liveRef = {
      previewId: first.id,
      payloadHash: first.payloadHash,
      bindingHash: first.bindingHash,
    };
    expect(workflow.readLiveDispatch(access, liveRef, installation)?.id).toBe(first.id);
    workflow.finishDispatch(
      access,
      { ...ref(first), result: { categoryAlias: 'c1234567890abcdef' } },
      installation,
    );
    expect(workflow.lookup(access, { bindingHash: first.bindingHash }, installation)?.id).toBe(
      first.id,
    );
    workflow.withdraw(access, { previewId: first.id, payloadHash: first.payloadHash }, 'revoked');
    expect(workflow.lookup(access, { bindingHash: first.bindingHash }, installation)).toBeNull();
    expect(
      workflow.latestForSubject(access, { subjectHash: first.subjectHash }, installation),
    ).toBeNull();
    expect(
      workflow.latestLocal(access, { subjectHash: first.subjectHash }, installation)?.status,
    ).toBe('revoked');
    const otherInstallation = { ...installation, installationId: 'independent-installation' };
    const fresh = workflow.createPreview(access, binding, otherInstallation);
    expect(workflow.consumePreview(access, ref(fresh), otherInstallation).status).toBe(
      'dispatched',
    );
    const audit = workflow.audit(access);
    expect(audit).toHaveLength(10007);
    expect(
      audit.filter((event) => event.previewId === first.id).map((event) => event.status),
    ).toEqual(['revoked', 'completed', 'dispatched', 'preview']);
  });
});
