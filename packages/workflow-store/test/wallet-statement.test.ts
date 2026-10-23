import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
const now = '2026-10-21T12:00:00.000Z';
const access = {
  scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
  actorId: 'owner',
  now,
  authorize: () => true,
};
const review = { membershipId: 'period', policyVersion: 'policy' };
const key = Buffer.alloc(32, 7);
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
function setup() {
  store = new SqliteWorkflowStore();
  const input = {
    connectorId: 'wallet',
    sourceId: 'statement',
    sourceTimestamp: now,
    mediaType: 'application/pdf',
    parserVersion: 'wallet-v1',
    privateActorId: 'owner',
    retentionUntil: '2026-10-22T12:00:00.000Z',
    parseStatus: 'unsupported_template' as const,
    quality: [],
    extraction: {},
    content: Buffer.from('statement original'),
  };
  const document = store.evidence.ingest(access, input, key).document;
  const proof = {
    proofId: 'proof',
    authorityKind: 'human_attested_statement' as const,
    statement: {
      documentId: document.id,
      contentHash: document.contentHash,
      parserVersion: document.parserVersion,
    },
    walletId: 'wallet',
    currency: 'USD',
    calendarBasis: 'statement_printed_date' as const,
    startDate: '2026-10-01',
    endDate: '2026-10-20',
    openingBalance: { minorUnits: '100', currency: 'USD' },
    closingBalance: { minorUnits: '100', currency: 'USD' },
    activityManifest: [],
    actorId: 'owner',
    ...review,
    reviewedAt: now,
  };
  const state = () => store.evidence.walletStatements.state(access, review);
  const append = (value = proof, expectedFoldHash = state().foldHash) =>
    store.evidence.walletStatements.attest(access, { proof: value, expectedFoldHash }, key);
  return { input, document, proof, state, append };
}
describe('human-attested statement decision lifecycle', () => {
  it('keeps proofs separate from financial decisions, actor scoped and bound to immutable source hashes', () => {
    const { proof, state, append, document } = setup();
    append();
    expect(state().proofs).toEqual([proof]);
    expect(store.evidence.latestDecision(access, [document.id])).toBeNull();
    expect(
      store.evidence.walletStatements.state({ ...access, actorId: 'peer' }, review).proofs,
    ).toEqual([]);
    expect(
      store.evidence.walletStatements.state({ ...access, authorize: () => false }, review).proofs,
    ).toEqual([]);
    expect(
      store.evidence.walletStatements.state(access, { ...review, policyVersion: 'changed' }).proofs,
    ).toEqual([]);
    expect(
      store.evidence.walletStatements.state(access, { ...review, membershipId: 'new-period' })
        .proofs,
    ).toEqual([]);
  });
  it('requires current authorized original bytes for new attestations but retains admitted proofs after ordinary raw retention', () => {
    const { proof, state, append, document } = setup();
    append();
    store.evidence.deleteRaw(access, document.id);
    expect(state().proofs).toEqual([proof]);
    expect(() => append()).toThrow(/original|raw/i);
    store.evidence.walletStatements.revoke(access, {
      proofId: proof.proofId,
      expectedFoldHash: state().foldHash,
      ...review,
    });
    expect(state().proofs).toEqual([]);
    expect(() => append()).toThrow();
    expect(state().proofs).toEqual([]);
  });
  it('rejects stale/forged proofs, protects concurrency and allows tombstones after replacement without reviving older approval', () => {
    const { proof, state, append, input } = setup();
    for (const change of [
      { actorId: 'peer' },
      { reviewedAt: '2026-10-21T11:00:00.000Z' },
      { reviewedAt: '2026-10-22T12:00:00.000Z' },
      { statement: { ...proof.statement, contentHash: 'f'.repeat(64) } },
    ])
      expect(() => append({ ...proof, ...change })).toThrow();
    const old = state().foldHash;
    append();
    expect(() => append(proof, old)).toThrow(/changed/);
    store.evidence.ingest(access, { ...input, content: Buffer.from('replacement') }, key);
    expect(state().proofs).toEqual([]);
    store.evidence.walletStatements.revoke(access, {
      proofId: proof.proofId,
      expectedFoldHash: state().foldHash,
      ...review,
    });
    expect(state().proofs).toEqual([]);
    expect(() =>
      store.evidence.walletStatements.revoke(access, {
        proofId: 'unknown',
        expectedFoldHash: state().foldHash,
        ...review,
      }),
    ).toThrow();
  });
  it('quarantines admitted proof and revocation history on restore', () => {
    const { append, state } = setup();
    append();
    store.evidence.quarantineRestore(now);
    expect(state().proofs).toEqual([]);
  });
});
