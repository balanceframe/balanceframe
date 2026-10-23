import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { EvidenceReceiptAnnotation } from '../src/transaction-evidence.js';
import { canonicalProposalJson } from '../src/proposal.js';
const now = '2026-10-21T12:00:00.000Z';
const access = {
  scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
  actorId: 'owner',
  now,
  authorize: () => true,
};
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
function setup() {
  store = new SqliteWorkflowStore();
  const document = store.evidence.ingest(
    access,
    {
      connectorId: 'retail',
      sourceId: 'receipt',
      sourceTimestamp: now,
      mediaType: 'application/json',
      parserVersion: 'retail-v1',
      privateActorId: 'owner',
      retentionUntil: '2026-10-22T12:00:00.000Z',
      parseStatus: 'parsed',
      quality: [],
      extraction: {},
      content: Buffer.from('source'),
    },
    Buffer.alloc(32),
  ).document;
  const annotation = {
    documentId: document.id,
    contentHash: document.contentHash,
    parserVersion: document.parserVersion,
    receiptId: 'receipt',
    actorId: 'owner',
    membershipId: 'membership',
    policyVersion: 'policy',
    reviewedAt: now,
    change: {
      kind: 'member' as const,
      lineId: 'line',
      member: { actorId: 'subject', membershipId: 'subject-period' },
    },
  };
  const query = { documentIds: [document.id], policyVersion: 'policy', membershipId: 'membership' };
  const save = (entries: EvidenceReceiptAnnotation[] = [annotation]) =>
    store.evidence.saveDecision(access, {
      resolutionHash: 'a'.repeat(64),
      documentIds: [document.id],
      relationships: [],
      receiptAnnotations: entries,
      receiptAnnotationBaseHash: createHash('sha256')
        .update(canonicalProposalJson(store.evidence.receiptAnnotations(access, query)))
        .digest('hex'),
    });
  return { document, annotation, query, save };
}
describe('immutable human receipt annotations', () => {
  it('folds latest explicit changes without renewing old provenance when the source set changes', () => {
    const { annotation, query, save } = setup();
    save();
    expect(store.evidence.receiptAnnotations(access, query)).toEqual([annotation]);
    save([{ ...annotation, change: { ...annotation.change, member: null } }]);
    expect(store.evidence.receiptAnnotations(access, query)[0]?.change).toEqual({
      kind: 'member',
      lineId: 'line',
      member: null,
    });
    expect(store.evidence.receiptAnnotations({ ...access, actorId: 'other' }, query)).toEqual([]);
    expect(store.evidence.receiptAnnotations({ ...access, authorize: () => false }, query)).toEqual(
      [],
    );
    expect(
      store.evidence.receiptAnnotations(access, { ...query, membershipId: 'new-period' }),
    ).toEqual([]);
    expect(
      store.evidence.receiptAnnotations(access, { ...query, policyVersion: 'new-policy' }),
    ).toEqual([]);
  });
  it('rejects stale review proof, concurrent overwrites, source replacement and forged provenance', () => {
    const { annotation, query, save, document } = setup();
    for (const change of [
      { actorId: 'other' },
      { contentHash: 'f'.repeat(64) },
      { parserVersion: 'wrong' },
      { reviewedAt: '2026-10-21T11:00:00.000Z' },
      { reviewedAt: '2026-10-22T12:00:00.000Z' },
    ])
      expect(() => save([{ ...annotation, ...change }])).toThrow();
    save();
    expect(() =>
      store.evidence.saveDecision(access, {
        resolutionHash: 'a'.repeat(64),
        documentIds: query.documentIds,
        relationships: [],
        receiptAnnotations: [annotation],
        receiptAnnotationBaseHash: 'f'.repeat(64),
      }),
    ).toThrow(/changed/);
    const {
      id: _id,
      scope: _scope,
      receivedAt: _received,
      contentHash: _hash,
      supersedesId: _prior,
      ...input
    } = document;
    store.evidence.ingest(
      access,
      { ...input, content: Buffer.from('replacement') },
      Buffer.alloc(32),
    );
    expect(store.evidence.receiptAnnotations(access, query)).toEqual([]);
  });
});
