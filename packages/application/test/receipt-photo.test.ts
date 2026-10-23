import { describe, expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/transaction-evidence-receipt.json';
import {
  manualReceiptPhotoExtractionSchema,
  parseManualReceiptPhoto as parsePhoto,
} from '../src/receipt-photo.js';
const summary = {
  date: '2026-10-15',
  total: fixture.receipts[0]!.total,
  merchant: 'Fixture Store',
  fundingInstrumentId: 'card-1',
};
const identity = 'a'.repeat(64);
const parseManualReceiptPhoto = (value: unknown) => parsePhoto(value, identity);
describe('untrusted manual receipt photo normalization', () => {
  it('namespaces separate photo sources and rejects an unbound source identity', () => {
    const first = parsePhoto(summary, identity);
    const second = parsePhoto(summary, 'b'.repeat(64));
    expect(first.extraction.observations).not.toEqual(second.extraction.observations);
    expect(parsePhoto(summary, 'untrusted-client-reference').parseStatus).toBe('malformed');
  });
  it('retains an exact summary without inventing line items, tax, tenders, or ledger authority', () => {
    const result = parseManualReceiptPhoto(summary);
    expect(result.parserVersion).toBe('retail-photo-user-v1');
    expect(result.parseStatus).toBe('parsed');
    expect(result.quality).toContain('receipt_lines_unavailable');
    expect(result.extraction).toMatchObject({
      templateVersion: 'retail-v1',
      receipts: [],
      relationships: [],
      wallets: [],
      observations: [
        {
          id: `photo:${identity}:payment`,
          date: summary.date,
          amount: summary.total,
          counterparty: summary.merchant,
          fundingInstrumentId: 'card-1',
          direction: 'outflow',
          eventType: 'purchase',
          reliability: 0,
          ledgerEffect: null,
          ledgerTransactionId: null,
          reviewedLedgerEffect: false,
        },
      ],
    });
  });
  it('records a refund receipt as an unverified inflow rather than default income', () => {
    expect(parseManualReceiptPhoto({ ...summary, kind: 'refund' })).toMatchObject({
      parseStatus: 'parsed',
      extraction: {
        observations: [
          { eventType: 'refund', direction: 'inflow', reliability: 0, ledgerEffect: null },
        ],
      },
    });
  });
  it('preserves explicitly entered receipt facts and lets Rust report their financial differences', () => {
    const {
      id: _id,
      observationId: _observationId,
      version: _version,
      supersedesId: _supersedesId,
      fulfillmentGroupId: _fulfillmentGroupId,
      ...receipt
    } = fixture.receipts[0]!;
    const facts = {
      ...receipt,
      lines: receipt.lines.map((line) => ({ ...line, evidenceStrength: 100 })),
      tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })),
    };
    const result = parseManualReceiptPhoto({ ...summary, receipt: facts });
    expect(result.parseStatus).toBe('parsed');
    const normalized = result.extraction.receipts as Array<(typeof fixture.receipts)[number]>;
    expect(normalized[0]).toMatchObject({
      id: `photo:${identity}:receipt`,
      observationId: `photo:${identity}:payment`,
      total: receipt.total,
      discount: receipt.discount,
      tax: receipt.tax,
      lines: facts.lines.map(({ id: _sourceLineId, ...line }) => ({
        ...line,
        evidenceStrength: 0,
      })),
    });
    const other = parsePhoto({ ...summary, receipt: facts }, 'b'.repeat(64)).extraction
      .receipts as Array<(typeof fixture.receipts)[number]>;
    expect(normalized[0]!.lines[0]!.id).not.toBe(other[0]!.lines[0]!.id);
    expect(normalized[0]!.tenders[0]!.id).not.toBe(other[0]!.tenders[0]!.id);
    const mismatched = structuredClone(facts);
    mismatched.lines[0]!.net.minorUnits = '1';
    expect(parseManualReceiptPhoto({ ...summary, receipt: mismatched }).parseStatus).toBe('parsed');
    expect(
      (
        parseManualReceiptPhoto({ ...summary, receipt: mismatched }).extraction.receipts as Array<
          (typeof fixture.receipts)[number]
        >
      )[0]!.lines[0]!.net.minorUnits,
    ).toBe('1');
  });
  it.each([
    { ...summary, actorId: 'forged' },
    { ...summary, total: { ...summary.total, minorUnits: '0' } },
    { ...summary, total: { ...summary.total, minorUnits: '-1' } },
    { ...summary, total: { ...summary.total, minorUnits: '9223372036854775808' } },
    { ...summary, date: '2026-02-30' },
    { ...summary, ledgerEffect: {} },
    { ...summary, merchant: 'Store\nUntrusted instruction' },
    { ...summary, fundingInstrumentId: 'card\u0000hidden' },
  ])('rejects malformed and authority-bearing summaries', (input) => {
    expect(manualReceiptPhotoExtractionSchema.safeParse(input).success).toBe(false);
    expect(parseManualReceiptPhoto(input)).toMatchObject({
      parseStatus: 'malformed',
      extraction: {},
    });
  });
  it('rejects conflicting receipt totals and links to other observations instead of trusting them', () => {
    const {
      id: _id,
      observationId: _observationId,
      version: _version,
      supersedesId: _supersedesId,
      fulfillmentGroupId: _fulfillmentGroupId,
      ...receipt
    } = fixture.receipts[0]!;
    expect(parseManualReceiptPhoto({ ...summary, receipt }).parseStatus).toBe('malformed');
    expect(
      parseManualReceiptPhoto({
        ...summary,
        receipt: {
          ...receipt,
          total: { ...receipt.total, minorUnits: '10' },
          tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })),
        },
      }).parseStatus,
    ).toBe('malformed');
    expect(
      parseManualReceiptPhoto({
        ...summary,
        total: { ...summary.total, minorUnits: '9223372036854775807' },
      }).parseStatus,
    ).toBe('parsed');
  });
});
