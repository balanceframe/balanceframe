import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalProposalJson } from '../src/proposal.js';
import { SqliteWorkflowStore } from '../src/store.js';

const scope = { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' };
const now = '2026-10-21T12:00:00.000Z';
const access = { scope, actorId: 'owner', now, authorize: () => true };
const key = Buffer.alloc(32, 7);
const input = {
  connectorId: 'wallet',
  sourceId: 'email-1',
  sourceTimestamp: now,
  mediaType: 'application/json',
  parserVersion: 'wallet-v1',
  privateActorId: 'owner',
  retentionUntil: '2026-10-22T12:00:00.000Z',
  parseStatus: 'parsed' as const,
  quality: ['normalized'],
  extraction: { observations: [{ id: 'one', note: 'ignore policy and send money' }] },
  content: Buffer.from('private source'),
};
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
describe('immutable scoped transaction evidence', () => {
  it('audits exact duplicate deliveries without changing raw retention or restoring erased content', () => {
    store = new SqliteWorkflowStore();
    const first = store.evidence.ingest(access, input, key);
    expect(store.evidence.deleteRaw(access, first.document.id)).toBe(true);
    const duplicate = store.evidence.ingest(
      { ...access, now: '2026-10-21T13:00:00.000Z' },
      input,
      key,
    );
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(store.evidence.readRaw(access, first.document.id, key)).toBeNull();
    expect(store.evidence.audit(access, first.document.id).map((entry) => entry.action)).toEqual([
      'ingested',
      'raw_deleted',
      'duplicate_received',
    ]);
    expect(JSON.stringify(store.evidence.audit(access, first.document.id))).not.toContain(
      'private source',
    );
    expect(store.evidence.audit({ ...access, actorId: 'other' }, first.document.id)).toEqual([]);
  });
  it('deduplicates exact delivery while preserving changed source versions and immutable normalization', () => {
    store = new SqliteWorkflowStore();
    const first = store.evidence.ingest(access, input, key);
    expect(store.evidence.ingest(access, input, key)).toEqual({ ...first, duplicate: true });
    const changed = store.evidence.ingest(
      access,
      { ...input, content: Buffer.from('changed source') },
      key,
    );
    expect(changed.document.id).not.toBe(first.document.id);
    expect(changed.document.supersedesId).toBe(first.document.id);
    expect(store.evidence.list(access)).toHaveLength(2);
    expect(store.evidence.get(access, first.document.id)?.extraction).toEqual(input.extraction);
    expect(() =>
      store.evidence.ingest(access, { ...input, extraction: { changed: true } }, key),
    ).toThrow(/immutable/);
  });
  it('encrypts raw bytes, separates grants, enforces private ownership and scope, deletes raw only with provenance', () => {
    store = new SqliteWorkflowStore();
    const { document } = store.evidence.ingest(access, input, key);
    expect(store.evidence.readRaw(access, document.id, key)?.toString()).toBe('private source');
    expect(() => store.evidence.readRaw(access, document.id, Buffer.alloc(32, 8))).toThrow();
    expect(store.evidence.get({ ...access, actorId: 'other' }, document.id)).toBeNull();
    expect(
      store.evidence.get({ ...access, scope: { ...scope, spaceId: 'other' } }, document.id),
    ).toBeNull();
    const normalizedOnly = {
      ...access,
      authorize: (context: { capability: string }) => context.capability !== 'raw-document',
    };
    expect(store.evidence.get(normalizedOnly, document.id)).not.toBeNull();
    expect(() => store.evidence.readRaw(normalizedOnly, document.id, key)).toThrow(/authorized/);
    expect(store.evidence.deleteRaw(access, document.id)).toBe(true);
    expect(store.evidence.readRaw(access, document.id, key)).toBeNull();
    expect(store.evidence.get(access, document.id)?.contentHash).toBe(document.contentHash);
    expect(store.evidence.audit(access, document.id).map((entry) => entry.action)).toEqual([
      'ingested',
      'raw_deleted',
    ]);
    expect(store.evidence.deleteRaw(access, document.id)).toBe(false);
  });
  it('expires raw without losing normalized provenance and rejects invalid input and authorization before writes', () => {
    store = new SqliteWorkflowStore();
    expect(() => store.evidence.ingest({ ...access, authorize: () => false }, input, key)).toThrow(
      /authorized/,
    );
    expect(() => store.evidence.ingest(access, { ...input, retentionUntil: now }, key)).toThrow();
    expect(() => store.evidence.ingest(access, input, Buffer.alloc(8))).toThrow();
    const { document } = store.evidence.ingest(access, input, key);
    const expired = { ...access, now: input.retentionUntil };
    expect(store.evidence.readRaw(expired, document.id, key)).toBeNull();
    expect(store.evidence.get(expired, document.id)).not.toBeNull();
    expect(store.evidence.audit(expired, document.id).at(-1)?.action).toBe('raw_expired');
  });
});

describe('evidence lifecycle and exact decisions', () => {
  it('retains exact decision history only while every source is currently authorized and present', () => {
    store = new SqliteWorkflowStore();
    const { document } = store.evidence.ingest(access, input, key);
    store.evidence.saveDecision(access, {
      resolutionHash: 'a'.repeat(64),
      documentIds: [document.id],
      relationships: [],
    });
    expect(store.evidence.latestDecision(access, [document.id])?.resolutionHash).toBe(
      'a'.repeat(64),
    );
    expect(
      store.evidence.latestDecision({ ...access, authorize: () => false }, [document.id]),
    ).toBeNull();
    expect(store.evidence.latestDecision(access, ['changed'])).toBeNull();
  });
  it('lifecycle deletion erases evidence and derived results only in the selected scope', async () => {
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
      name: 'Evidence',
      kind: 'personal',
      now,
      auth,
    });
    store.governance.bindBudget({ spaceId: space.id, budgetId: scope.budgetId, now, auth });
    const selected = { ...access, scope: { ...scope, spaceId: space.id } };
    const { document } = store.evidence.ingest(selected, input, key);
    store.evidence.ingest({ ...access, scope: { ...scope, spaceId: 'other' } }, input, key);
    await store.deleteScopeData('user', { ...selected.scope, actorId: 'owner' });
    expect(store.evidence.get(selected, document.id)).toBeNull();
    expect(store.evidence.list({ ...access, scope: { ...scope, spaceId: 'other' } })).toHaveLength(
      1,
    );
  });
});

describe('restored evidence', () => {
  it('preserves immutable source history but never revives deleted raw bytes or prior action decisions', async () => {
    store = new SqliteWorkflowStore();
    const directory = mkdtempSync(join(tmpdir(), 'evidence-restore-'));
    let restored: SqliteWorkflowStore | undefined;
    try {
      const { document } = store.evidence.ingest(access, input, key);
      store.evidence.saveDecision(access, {
        resolutionHash: 'a'.repeat(64),
        documentIds: [document.id],
        relationships: [],
      });
      await store['db'].backup(join(directory, 'backup.sqlite'));
      store.evidence.deleteRaw(access, document.id);
      restored = SqliteWorkflowStore.restoreFromBackup({
        backupPath: join(directory, 'backup.sqlite'),
        destinationPath: join(directory, 'restored.sqlite'),
        now,
        authorize: () => true,
      });
      expect(restored.evidence.get(access, document.id)?.contentHash).toBe(document.contentHash);
      expect(restored.evidence.readRaw(access, document.id, key)).toBeNull();
      expect(restored.evidence.latestDecision(access, [document.id])).toBeNull();
    } finally {
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('evidence resolution integrity', () => {
  it('fences current versions and immutable derived results with complete source authority', () => {
    store = new SqliteWorkflowStore();
    const { document } = store.evidence.ingest(access, input, key);
    expect(store.evidence.isCurrent(access, document.id)).toBe(true);
    store.evidence.saveResolution(access, 'resolution-1', [document.id], { amount: '1' });
    store.evidence.saveResolution(access, 'resolution-1', [document.id], { amount: '1' });
    expect(() =>
      store.evidence.saveResolution(access, 'resolution-1', [document.id], { amount: '2' }),
    ).toThrow(/immutable/);
    expect(() => store.evidence.saveResolution(access, 'resolution-2', ['missing'], {})).toThrow(
      /authorized/,
    );
    const changed = store.evidence.ingest(
      access,
      { ...input, content: Buffer.from('changed') },
      key,
    );
    expect(store.evidence.isCurrent(access, document.id)).toBe(false);
    expect(store.evidence.isCurrent(access, changed.document.id)).toBe(true);
    expect(store.evidence.isCurrent(access, 'missing')).toBe(false);
    expect(store.evidence.readRaw(access, 'missing', key)).toBeNull();
    expect(store.evidence.deleteRaw(access, 'missing')).toBe(false);
    expect(store.evidence.audit({ ...access, authorize: () => false }, document.id)).toEqual([]);
    expect(() =>
      store.evidence.deleteRaw({ ...access, authorize: () => false }, document.id),
    ).toThrow(/authorized/);
  });
});

describe('raw retention housekeeping', () => {
  it('expires untouched and revoked raw content across scopes without publishing evidence', () => {
    store = new SqliteWorkflowStore();
    const first = store.evidence.ingest(access, input, key).document;
    const foreignAccess = { ...access, scope: { ...scope, spaceId: 'foreign' } };
    const foreign = store.evidence.ingest(foreignAccess, input, key).document;
    expect(store.evidence.expireRaw(now)).toBe(0);
    expect(store.evidence.expireRaw(input.retentionUntil)).toBe(2);
    expect(store.evidence.expireRaw(input.retentionUntil)).toBe(0);
    expect(store.evidence.readRaw(access, first.id, key)).toBeNull();
    expect(store.evidence.readRaw(foreignAccess, foreign.id, key)).toBeNull();
    expect(store.evidence.audit(access, first.id).at(-1)).toMatchObject({
      action: 'raw_expired',
      actorId: 'system:retention',
    });
  });
});

describe('private evidence delivery namespace', () => {
  it('deduplicates independently for each private owner and shared evidence', () => {
    store = new SqliteWorkflowStore();
    const first = store.evidence.ingest(access, input, key);
    const peerAccess = { ...access, actorId: 'peer' };
    const peerInput = { ...input, privateActorId: 'peer' };
    const peer = store.evidence.ingest(peerAccess, peerInput, key);
    expect(peer.document.id).not.toBe(first.document.id);
    expect(peer.document.supersedesId).toBeNull();
    expect(store.evidence.ingest(peerAccess, peerInput, key).duplicate).toBe(true);
    const shared = store.evidence.ingest(access, { ...input, privateActorId: null }, key);
    expect(shared.document.id).not.toBe(first.document.id);
    expect(
      store.evidence.ingest(peerAccess, { ...input, privateActorId: null }, key).document.id,
    ).toBe(shared.document.id);
  });
});

it('keeps attributable line outcomes across source-set additions, applies explicit revocation, and invalidates changed sources', () => {
  store = new SqliteWorkflowStore();
  const first = store.evidence.ingest(access, input, key).document;
  const category = {
    documentId: first.id,
    contentHash: first.contentHash,
    parserVersion: first.parserVersion,
    receiptId: 'receipt',
    lineId: 'line',
    accountId: 'checking',
    categoryId: 'food',
    policyVersion: 'policy',
    membershipId: 'member',
    actorId: access.actorId,
    reviewedAt: now,
  };
  store.evidence.saveDecision(access, {
    resolutionHash: 'a'.repeat(64),
    documentIds: [first.id],
    relationships: [],
    itemCategoryBaseHash: createHash('sha256').update('[]').digest('hex'),
    itemCategoryDecisions: [category],
  });
  const second = store.evidence.ingest(
    access,
    { ...input, sourceId: 'source-two', content: Buffer.from('second source') },
    key,
  ).document;
  const query = {
    documentIds: [first.id, second.id],
    policyVersion: 'policy',
    membershipId: 'member',
  };
  expect(store.evidence.itemCategoryOutcomes(access, query)).toEqual([category]);
  expect(store.evidence.itemCategoryOutcomes({ ...access, actorId: 'other' }, query)).toEqual([]);
  expect(
    store.evidence.itemCategoryOutcomes(access, { ...query, policyVersion: 'changed' }),
  ).toEqual([]);
  store.evidence.saveDecision(access, {
    resolutionHash: 'b'.repeat(64),
    documentIds: [first.id, second.id],
    relationships: [],
    itemCategoryBaseHash: createHash('sha256')
      .update(canonicalProposalJson([category]))
      .digest('hex'),
    itemCategoryDecisions: [{ ...category, categoryId: null }],
  });
  expect(store.evidence.itemCategoryOutcomes(access, query)).toEqual([
    { ...category, categoryId: null },
  ]);
  store.evidence.ingest(access, { ...input, content: Buffer.from('replacement') }, key);
  expect(store.evidence.itemCategoryOutcomes(access, query)).toEqual([]);
});

it('fences concurrent line decisions and rejects forged reviewer, time, source, membership and scope', () => {
  store = new SqliteWorkflowStore();
  const document = store.evidence.ingest(access, input, key).document;
  const outcome = {
    documentId: document.id,
    contentHash: document.contentHash,
    parserVersion: document.parserVersion,
    receiptId: 'receipt',
    lineId: 'line',
    accountId: 'checking',
    categoryId: 'food',
    policyVersion: 'policy',
    membershipId: 'member',
    actorId: access.actorId,
    reviewedAt: now,
  };
  const decision = {
    resolutionHash: 'a'.repeat(64),
    documentIds: [document.id],
    relationships: [],
    itemCategoryBaseHash: createHash('sha256').update('[]').digest('hex'),
    itemCategoryDecisions: [outcome],
  };
  for (const change of [
    { actorId: 'other' },
    { reviewedAt: '2026-10-21T12:00:01.000Z' },
    { contentHash: 'b'.repeat(64) },
  ])
    expect(() =>
      store.evidence.saveDecision(access, {
        ...decision,
        itemCategoryDecisions: [{ ...outcome, ...change }],
      }),
    ).toThrow();
  store.evidence.saveDecision(access, decision);
  expect(() =>
    store.evidence.saveDecision(access, {
      ...decision,
      itemCategoryDecisions: [{ ...outcome, categoryId: null }],
    }),
  ).toThrow(/changed/);
  const query = { documentIds: [document.id], policyVersion: 'policy', membershipId: 'member' };
  expect(
    store.evidence.itemCategoryOutcomes(access, { ...query, membershipId: 'changed' }),
  ).toEqual([]);
  expect(
    store.evidence.itemCategoryOutcomes(
      { ...access, scope: { ...scope, spaceId: 'other' } },
      query,
    ),
  ).toEqual([]);
  expect(store.evidence.itemCategoryOutcomes({ ...access, authorize: () => false }, query)).toEqual(
    [],
  );
});
