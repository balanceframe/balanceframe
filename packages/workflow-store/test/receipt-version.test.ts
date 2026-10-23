import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SqliteWorkflowStore } from '../src/store.js';
import type { EvidenceAccess } from '../src/transaction-evidence.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
    'utf8',
  ),
);
const now = '2026-10-21T12:00:00.000Z';
const review = { membershipId: 'member', policyVersion: 'policy' };
const key = Buffer.alloc(32, 7);
const access: EvidenceAccess = {
  scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
  actorId: 'owner',
  now,
  authorize: () => true,
};
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
function setup() {
  store = new SqliteWorkflowStore();
  const ingest = (name: string, change: Record<string, unknown> = {}) => {
    const receipt = structuredClone(fixture.receipts[0]);
    receipt.id = `${name}:receipt`;
    receipt.observationId = `${name}:observation`;
    receipt.lines = receipt.lines.map((l: { id: string }) => ({ ...l, id: `${name}:${l.id}` }));
    const { provenance: _provenance, ...source } = fixture.observations[0];
    return store.evidence.ingest(
      access,
      {
        connectorId: 'camera',
        sourceId: `${name}.jpg`,
        mediaType: 'image/jpeg',
        sourceTimestamp: now,
        parserVersion: 'retail-photo-user-v1',
        privateActorId: 'owner',
        retentionUntil: '2026-10-22T00:00:00.000Z',
        parseStatus: 'parsed',
        quality: ['user_photo_entry'],
        content: Buffer.from(name),
        extraction: {
          templateVersion: 'retail-v1',
          observations: [
            {
              ...source,
              id: receipt.observationId,
              kind: 'receipt',
              eventType: 'purchase',
              counterparty: 'Retailer',
              externalEventId: null,
            },
          ],
          receipts: [receipt],
          relationships: [],
          wallets: [],
        },
        ...change,
      },
      key,
    ).document;
  };
  const parent = ingest('parent'),
    child = ingest('child');
  const ref = (d: typeof parent) => ({
    documentId: d.id,
    contentHash: d.contentHash,
    parserVersion: d.parserVersion,
    receiptId: `${d.sourceId.replace('.jpg', '')}:receipt`,
  });
  const link = {
    child: ref(child),
    predecessor: ref(parent),
    predecessorVersion: 1,
    version: 2,
    predecessorLineageHash: 'a'.repeat(64),
    identityBasis: 'human_attested_same_receipt' as const,
    actorId: access.actorId,
    ...review,
    reviewedAt: now,
  };
  const state = () => store.evidence.receiptVersions.state(access, review);
  const append = (value = link, expectedFoldHash = state().foldHash) =>
    store.evidence.receiptVersions.link(access, { link: value, expectedFoldHash });
  return { ingest, parent, child, ref, link, state, append };
}
describe('reviewed immutable receipt versions', () => {
  it('keeps human version claims independent of source bytes and financial decisions', () => {
    const { parent, child, link, state, append } = setup();
    append();
    expect(state().links).toEqual([link]);
    expect(store.evidence.get(access, child.id)?.extraction).toEqual(child.extraction);
    expect(store.evidence.get(access, child.id)?.supersedesId).toBeNull();
    expect(store.evidence.latestDecision(access, [parent.id, child.id])).toBeNull();
    expect(
      store.evidence.receiptVersions.state({ ...access, actorId: 'peer' }, review).links,
    ).toEqual([]);
  });
  it('requires fresh exact source/current-child/fold scope and refuses forged version or family', () => {
    const { link, append, state, ingest } = setup();
    for (const change of [
      { actorId: 'peer' },
      { reviewedAt: '2026-10-21T11:00:00.000Z' },
      { reviewedAt: '2026-10-22T00:00:00.000Z' },
      { child: { ...link.child, contentHash: 'f'.repeat(64) } },
      { version: 3 },
      { predecessor: link.child },
    ])
      expect(() => append({ ...link, ...change })).toThrow();
    const old = state().foldHash;
    append();
    expect(() => append(link, old)).toThrow(/changed/i);
    ingest('child', { content: Buffer.from('new child') });
    expect(() => append()).toThrow(/current|source/i);
  });
  it('revokes without retained predecessor access and never resurrects older approval', () => {
    const { parent, child, state, append } = setup();
    append();
    store.evidence.deleteRaw(access, parent.id);
    const revoked = {
      ...access,
      authorize: (r: Parameters<EvidenceAccess['authorize']>[0]) => r.document?.id !== parent.id,
    };
    const current = store.evidence.receiptVersions.state(revoked, review);
    expect(current.links).toEqual([]);
    expect(current.blockedChildren).toHaveLength(1);
    store.evidence.receiptVersions.revoke(revoked, {
      childDocumentId: child.id,
      childReceiptId: 'child:receipt',
      expectedFoldHash: current.foldHash,
      ...review,
    });
    expect(state().links).toEqual([]);
    expect(state().blockedChildren).toEqual([]);
  });
  it('preserves admitted history only as metadata and rejects cycles or forks', () => {
    const { ingest, parent, child, ref, link, append, state } = setup();
    append();
    const next = ingest('next');
    expect(() => append({ ...link, child: ref(next) })).toThrow(/fork/i);
    expect(() => append({ ...link, child: ref(parent), predecessor: ref(child) })).toThrow(
      /cycle/i,
    );
    expect(
      store.evidence.receiptVersions.state(access, { ...review, membershipId: 'other' }).links,
    ).toEqual([]);
    store.evidence.quarantineRestore(now);
    expect(state().links).toEqual([]);
  });
  it('requires matching source owner, connector, retailer, currency and direction', () => {
    const { ingest, parent, ref, link, append } = setup();
    for (const change of [{ connectorId: 'other' }, { privateActorId: null }]) {
      const other = ingest(`other-${String(Object.keys(change)[0])}`, change);
      expect(() => append({ ...link, child: ref(other), predecessor: ref(parent) })).toThrow(
        /family|source/i,
      );
    }
    const denied = { ...access, authorize: () => false };
    expect(() =>
      store.evidence.receiptVersions.link(denied, { link, expectedFoldHash: 'a'.repeat(64) }),
    ).toThrow();
  });
});
