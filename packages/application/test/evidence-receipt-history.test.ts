import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EvidenceDocument } from '@balanceframe/workflow-store';
import { receiptHistoryDocuments } from '../src/evidence-receipt-history.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
    'utf8',
  ),
);
function documents() {
  const base: EvidenceDocument = {
    id: 'doc-old',
    scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
    connectorId: 'retail',
    sourceId: 'order-one',
    sourceTimestamp: '2026-10-15T12:00:00Z',
    receivedAt: '2026-10-15T12:01:00Z',
    mediaType: 'application/json',
    parserVersion: 'retail-v1',
    privateActorId: 'owner',
    retentionUntil: '2026-10-22T00:00:00Z',
    contentHash: 'a'.repeat(64),
    supersedesId: null,
    parseStatus: 'parsed',
    quality: [],
    extraction: {
      templateVersion: 'retail-v1',
      observations: fixture.observations
        .filter((observation: { kind: string }) => observation.kind !== 'ledger_transaction')
        .map(({ provenance: _p, ...observation }: { provenance: unknown }) => observation),
      receipts: fixture.receipts,
      relationships: [],
      wallets: [],
    },
  };
  const current = structuredClone(base);
  current.id = 'doc-current';
  current.contentHash = 'b'.repeat(64);
  current.supersedesId = base.id;
  const extraction = current.extraction as typeof fixture;
  extraction.observations[0].id = 'updated-observation';
  extraction.receipts[0].id = 'updated-receipt';
  extraction.receipts[0].version = 2;
  extraction.receipts[0].supersedesId = 'receipt-1';
  extraction.receipts[0].observationId = 'updated-observation';
  extraction.receipts[0].lines[0].id = 'updated-line';
  return { base, current };
}
describe('authorized history-only receipt ancestry', () => {
  it('loads only explicitly required same-family predecessors and never revives financial activity', () => {
    const { base, current } = documents();
    const other = structuredClone(base);
    other.id = 'unrelated';
    other.sourceId = 'other-order';
    const history = receiptHistoryDocuments([current], [base, current, other]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: base.id,
      contentHash: base.contentHash,
      extraction: {
        relationships: [],
        wallets: [],
        observations: [{ id: 'wallet-1', status: 'superseded' }],
      },
    });
    expect(
      (history[0]!.extraction.receipts as Array<{ id: string }>).map((receipt) => receipt.id),
    ).toEqual(['receipt-1']);
    expect((base.extraction.observations as Array<{ status: string }>)[0]!.status).toBe(
      'completed',
    );
    expect(receiptHistoryDocuments([base], [base, current])).toEqual([]);
  });
  it('refuses missing or unauthorized history and cross-source, owner, scope or parser-family lineage', () => {
    const { base, current } = documents();
    expect(() => receiptHistoryDocuments([current], [current])).toThrow(/history/i);
    for (const change of [
      { sourceId: 'other-order' },
      { connectorId: 'other-connector' },
      { privateActorId: 'other-owner' },
      { scope: { ...base.scope, spaceId: 'other-space' } },
      { parseStatus: 'malformed' as const },
    ]) {
      expect(() => receiptHistoryDocuments([current], [{ ...base, ...change }, current])).toThrow(
        /history|lineage/i,
      );
    }
    const cyclic = structuredClone(base);
    cyclic.supersedesId = cyclic.id;
    (cyclic.extraction.receipts as typeof fixture.receipts)[0].id = 'irrelevant';
    expect(() => receiptHistoryDocuments([current], [cyclic, current])).toThrow(/history|lineage/i);
  });
  it('leaves same-document receipt ancestry for native validation and drops unrelated history rows', () => {
    const { base, current } = documents();
    const both = structuredClone(current);
    (both.extraction.receipts as unknown[]).push(...(base.extraction.receipts as unknown[]));
    expect(receiptHistoryDocuments([both], [both])).toEqual([]);
    const extra = structuredClone((base.extraction.receipts as typeof fixture.receipts)[0]);
    extra.id = 'unrelated-receipt';
    extra.observationId = 'unrelated-observation';
    extra.lines[0].id = 'unrelated-line';
    (base.extraction.receipts as unknown[]).push(extra);
    expect(
      receiptHistoryDocuments([current], [base, current])[0]!.extraction.receipts as unknown[],
    ).toHaveLength(1);
  });
});


it('retains in-document predecessors when a cross-document ancestor is trimmed', () => {
  const { base, current } = documents();
  (base.extraction.receipts as unknown[]).push(...structuredClone(current.extraction.receipts as unknown[]));
  (base.extraction.observations as unknown[]).push(...structuredClone(current.extraction.observations as unknown[]));
  const receipt = (current.extraction.receipts as typeof fixture.receipts)[0];
  receipt.id = 'latest-receipt'; receipt.version = 3; receipt.supersedesId = 'updated-receipt';
  receipt.observationId = 'latest-observation'; receipt.lines[0].id = 'latest-line';
  (current.extraction.observations as typeof fixture.observations)[0].id = 'latest-observation';
  const history = receiptHistoryDocuments([current], [base, current]);
  expect((history[0]!.extraction.receipts as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['receipt-1', 'updated-receipt']);
  expect(history[0]!.extraction.observations).toHaveLength(2);
});
