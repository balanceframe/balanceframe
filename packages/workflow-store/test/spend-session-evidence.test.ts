import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalProposalJson } from '../src/proposal.js';
import { SqliteWorkflowStore } from '../src/store.js';
import type {
  CompareSpendSessionReceiptResult,
  SessionReceiptReview,
  SessionReceiptSnapshot,
} from '@balanceframe/protocol-generated';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/spend-session-receipt.json', import.meta.url),
    'utf8',
  ),
) as { sessionSnapshot: SessionReceiptSnapshot; review: SessionReceiptReview };
const resultFixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/spend-session-receipt-result.json', import.meta.url),
    'utf8',
  ),
) as CompareSpendSessionReceiptResult;
const scope = { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' };
const access = { scope, actorId: 'owner', now: '2026-10-21T12:00:00.000Z', authorize: () => true };
const key = Buffer.alloc(32, 7);
function source(intent = fixture.sessionSnapshot.intent) {
  return {
    connectorId: 'spend-session',
    sourceId: `session:${intent.id}`,
    sourceTimestamp: access.now,
    mediaType: 'application/json',
    parserVersion: 'spend-session-snapshot-v1',
    privateActorId: access.actorId,
    retentionUntil: '2026-10-22T12:00:00.000Z',
    parseStatus: 'parsed' as const,
    quality: ['planned_only'],
    extraction: {
      templateVersion: 'retail-v1',
      observations: [],
      relationships: [],
      wallets: [],
      receipts: [],
    },
    content: Buffer.from(canonicalProposalJson(intent)),
  };
}
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
describe('server-origin saved Spend Session snapshots', () => {
  it('keeps generic imports untrusted and records exact metadata only through the internal archive path', () => {
    store = new SqliteWorkflowStore();
    const imported = store.evidence.ingest(access, source(), key);
    expect(store.evidence.sessionSnapshots.get(access, imported.document.id)).toBeNull();
    const archived = store.evidence.archiveSpendSession(
      access,
      source(),
      fixture.sessionSnapshot.intent,
      key,
    );
    const snapshot = store.evidence.sessionSnapshots.get(access, archived.document.id);
    expect(snapshot).toEqual({
      documentId: archived.document.id,
      contentHash: archived.document.contentHash,
      parserVersion: 'spend-session-snapshot-v1',
      intentHash: createHash('sha256').update(source().content).digest('hex'),
      intent: fixture.sessionSnapshot.intent,
    });
    expect(snapshot?.intent.items[0]).toMatchObject({
      quantity: 2,
      barcode: 'sku-1',
      priceProvenance: { kind: 'current_session_manual' },
    });
    expect(
      store.evidence.archiveSpendSession(access, source(), fixture.sessionSnapshot.intent, key),
    ).toMatchObject({ duplicate: true });
    expect(store.evidence.sessionSnapshots.get(access, archived.document.id)).toEqual(snapshot);
  });
  it('admits authorized server snapshots without granting normalization read access to their new source', () => {
    store = new SqliteWorkflowStore();
    const ingestOnly = {
      ...access,
      authorize: (context: { capability: string }) => context.capability === 'ingest',
    };
    const archived = store.evidence.archiveSpendSession(
      ingestOnly,
      source(),
      fixture.sessionSnapshot.intent,
      key,
    );
    expect(store.evidence.sessionSnapshots.get(ingestOnly, archived.document.id)).toBeNull();
    expect(store.evidence.sessionSnapshots.get(access, archived.document.id)?.intent).toEqual(
      fixture.sessionSnapshot.intent,
    );
  });
  it('rejects forged bytes, parser identity and owner or denied admission without leaving evidence behind', () => {
    store = new SqliteWorkflowStore();
    for (const input of [
      { ...source(), content: Buffer.from('different bytes') },
      { ...source(), parserVersion: 'retail-v1' },
      { ...source(), privateActorId: 'other' },
    ])
      expect(() =>
        store.evidence.archiveSpendSession(access, input, fixture.sessionSnapshot.intent, key),
      ).toThrow();
    expect(() =>
      store.evidence.archiveSpendSession(
        { ...access, authorize: () => false },
        source(),
        fixture.sessionSnapshot.intent,
        key,
      ),
    ).toThrow();
    expect(store.evidence.list(access)).toEqual([]);
  });
  it('records exact reviewed comparisons idempotently and refuses another session for the same receipt', () => {
    store = new SqliteWorkflowStore();
    const archived = store.evidence.archiveSpendSession(
      access,
      source(),
      fixture.sessionSnapshot.intent,
      key,
    );
    const receipt = store.evidence.ingest(
      access,
      {
        ...source(),
        connectorId: 'retail',
        sourceId: 'receipt-one',
        parserVersion: 'retail-v1',
        content: Buffer.from('synthetic receipt'),
      },
      key,
    );
    const result = {
      ...resultFixture,
      sessionDocumentId: archived.document.id,
      receiptDocumentId: receipt.document.id,
    };
    const input = {
      result,
      review: fixture.review,
      policyVersion: 'policy-1',
      membershipId: 'member-1',
    };
    const saved = store.evidence.sessionSnapshots.saveAssociation(access, input, () => true);
    expect(saved).toMatchObject({
      actorId: access.actorId,
      at: access.now,
      result,
      review: fixture.review,
    });
    expect(store.evidence.sessionSnapshots.saveAssociation(access, input, () => true)).toEqual(
      saved,
    );
    expect(
      store.evidence.sessionSnapshots.associations(access, archived.document.id, input, () => true),
    ).toEqual([saved]);
    const otherIntent = { ...fixture.sessionSnapshot.intent, id: 'session-two' };
    const other = store.evidence.archiveSpendSession(access, source(otherIntent), otherIntent, key);
    expect(() =>
      store.evidence.sessionSnapshots.saveAssociation(
        access,
        {
          ...input,
          result: {
            ...result,
            comparisonHash: 'b'.repeat(64),
            sessionDocumentId: other.document.id,
            sessionId: otherIntent.id,
            intentHash: other.document.contentHash,
          },
        },
        () => true,
      ),
    ).toThrow(/already|another/);
    expect(
      store.evidence.sessionSnapshots.associations(access, other.document.id, input, () => true),
    ).toEqual([]);
  });
  it('fails closed on changed versions, policy, membership, grants and sources before storing or publishing associations', () => {
    store = new SqliteWorkflowStore();
    const archived = store.evidence.archiveSpendSession(
      access,
      source(),
      fixture.sessionSnapshot.intent,
      key,
    );
    const receipt = store.evidence.ingest(
      access,
      {
        ...source(),
        connectorId: 'retail',
        sourceId: 'receipt-one',
        parserVersion: 'retail-v1',
        content: Buffer.from('synthetic receipt'),
      },
      key,
    );
    const input = {
      result: {
        ...resultFixture,
        sessionDocumentId: archived.document.id,
        receiptDocumentId: receipt.document.id,
      },
      review: fixture.review,
      policyVersion: 'policy-1',
      membershipId: 'member-1',
    };
    expect(() =>
      store.evidence.sessionSnapshots.saveAssociation(access, input, () => false),
    ).toThrow(/changed/);
    store.evidence.sessionSnapshots.saveAssociation(access, input, () => true);
    expect(
      store.evidence.sessionSnapshots.associations(
        access,
        archived.document.id,
        input,
        () => false,
      ),
    ).toEqual([]);
    expect(
      store.evidence.sessionSnapshots.associations(
        access,
        archived.document.id,
        { ...input, policyVersion: 'policy-2' },
        () => true,
      ),
    ).toEqual([]);
    expect(
      store.evidence.sessionSnapshots.associations(
        access,
        archived.document.id,
        { ...input, membershipId: 'member-2' },
        () => true,
      ),
    ).toEqual([]);
    expect(
      store.evidence.sessionSnapshots.associations(
        { ...access, authorize: () => false },
        archived.document.id,
        input,
        () => true,
      ),
    ).toEqual([]);
    store.evidence.ingest(
      access,
      {
        ...source(),
        connectorId: 'retail',
        sourceId: 'receipt-one',
        parserVersion: 'retail-v1',
        content: Buffer.from('changed receipt'),
      },
      key,
    );
    expect(
      store.evidence.sessionSnapshots.associations(access, archived.document.id, input, () => true),
    ).toEqual([]);
    expect(() =>
      store.evidence.sessionSnapshots.saveAssociation(access, input, () => true),
    ).toThrow(/changed|authorized/);
  });
  it('withholds archives after ownership, source grants, supersession or restore authority changes', () => {
    store = new SqliteWorkflowStore();
    const archived = store.evidence.archiveSpendSession(
      access,
      source(),
      fixture.sessionSnapshot.intent,
      key,
    );
    expect(
      store.evidence.sessionSnapshots.get({ ...access, actorId: 'peer' }, archived.document.id),
    ).toBeNull();
    expect(
      store.evidence.sessionSnapshots.get(
        { ...access, scope: { ...scope, spaceId: 'other' } },
        archived.document.id,
      ),
    ).toBeNull();
    expect(
      store.evidence.sessionSnapshots.get(
        { ...access, authorize: () => false },
        archived.document.id,
      ),
    ).toBeNull();
    const newer = {
      ...fixture.sessionSnapshot.intent,
      version: fixture.sessionSnapshot.intent.version + 1,
    };
    store.evidence.ingest(access, source(newer), key);
    expect(store.evidence.sessionSnapshots.get(access, archived.document.id)).toBeNull();
    const next = store.evidence.archiveSpendSession(access, source(newer), newer, key);
    expect(store.evidence.sessionSnapshots.get(access, next.document.id)).not.toBeNull();
    store.evidence.quarantineRestore(access.now);
    expect(store.evidence.sessionSnapshots.get(access, next.document.id)).toBeNull();
  });
});
