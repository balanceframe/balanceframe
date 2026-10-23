import { createRequire } from 'node:module';
import receiptFixture from '../../../../protocol/fixtures/transaction-evidence-receipt.json';
import { parseManualReceiptPhoto } from '../../../../packages/application/src/receipt-photo';
import { TransactionEvidenceRequestSchema } from '@balanceframe/protocol-generated/validators';
import { describe, expect, it } from 'vitest';
import {
  receiptPhotoSummary,
  receiptPhotoExtraction,
  type ReceiptPhotoItemsForm,
} from '../../app/utils/receipt-photo-client';
const summary = {
  kind: 'purchase' as const,
  date: '2026-10-15',
  total: '12.34',
  currency: 'USD',
  merchant: 'Fixture Store',
  fundingInstrumentId: '',
};
describe('exact receipt summary formatting', () => {
  it.each([
    ['USD', '12.34', '1234'],
    ['JPY', '1200', '1200'],
    ['KWD', '1.234', '1234'],
    ['USD', '0001.2', '120'],
    ['JPY', '9223372036854775807', '9223372036854775807'],
  ])(
    'formats %s without floating point or changing the entered amount',
    (currency, total, minorUnits) => {
      expect(receiptPhotoSummary({ ...summary, currency, total })).toEqual({
        kind: 'purchase',
        date: summary.date,
        total: { currency, minorUnits },
        merchant: summary.merchant,
        fundingInstrumentId: null,
      });
    },
  );
  it.each([
    ['USD', '1.234'],
    ['JPY', '1.2'],
    ['USD', '1e3'],
    ['USD', '-1'],
    ['USD', '0'],
    ['USD', '1,200'],
    ['XYZ', '1'],
    ['JPY', '9223372036854775808'],
  ])('refuses ambiguous or unrepresentable %s input %s', (currency, total) => {
    expect(receiptPhotoSummary({ ...summary, currency, total })).toBeNull();
  });
  it('validates dates and preserves an explicitly selected refund without income inference', () => {
    expect(receiptPhotoSummary({ ...summary, merchant: 'Store\nInstruction' })).toBeNull();
    expect(receiptPhotoSummary({ ...summary, date: '2026-02-30' })).toBeNull();
    expect(
      receiptPhotoSummary({
        ...summary,
        kind: 'refund',
        merchant: '',
        fundingInstrumentId: 'card',
      }),
    ).toMatchObject({ kind: 'refund', merchant: null, fundingInstrumentId: 'card' });
  });
});

const enteredItems = (): ReceiptPhotoItemsForm => ({
  discount: '1.00',
  tax: '1.00',
  lines: [
    {
      description: 'two items',
      sku: 'sku-1',
      quantity: '2',
      unitGross: '6.00',
      gross: '12.00',
      discount: '1.00',
      tax: '1.00',
      net: '12.00',
    },
  ],
  tenders: [
    { kind: 'card', amount: '10.00' },
    { kind: 'gift_card', amount: '2.00' },
  ],
});
describe('explicit receipt photo item and tender formatting', () => {
  it('copies every entered claim without calculating totals or granting source authority', () => {
    const result = receiptPhotoExtraction({ ...summary, total: '12.00' }, enteredItems());
    expect(result?.receipt).toMatchObject({
      total: { minorUnits: '1200', currency: 'USD' },
      discount: { minorUnits: '100', currency: 'USD' },
      tax: { minorUnits: '100', currency: 'USD' },
      lines: [
        {
          rawDescription: 'two items',
          normalizedDescription: 'two items',
          sku: 'sku-1',
          quantityMicros: 2000000,
          unitGross: { minorUnits: '600', currency: 'USD' },
          gross: { minorUnits: '1200', currency: 'USD' },
          discount: { minorUnits: '100', currency: 'USD' },
          tax: { minorUnits: '100', currency: 'USD' },
          net: { minorUnits: '1200', currency: 'USD' },
          categoryId: null,
          memberId: null,
          department: null,
          productFamily: null,
          evidenceStrength: 0,
          reasonCodes: [],
          returnOfLineId: null,
        },
      ],
      tenders: [
        { kind: 'card', amount: { minorUnits: '1000', currency: 'USD' }, observationId: null },
        { kind: 'gift_card', amount: { minorUnits: '200', currency: 'USD' }, observationId: null },
      ],
    });
    const mismatched = enteredItems();
    mismatched.lines[0]!.net = '0.01';
    expect(
      receiptPhotoExtraction({ ...summary, total: '12.00' }, mismatched)?.receipt?.lines[0]!.net
        .minorUnits,
    ).toBe('1');
    expect(receiptPhotoExtraction(summary)).not.toHaveProperty('receipt');
  });
  it.each([
    ['JPY', '1200', '600', '1200', '600'],
    ['KWD', '1.234', '0.617', '1234', '617'],
  ])(
    'preserves refund %s precision and decimal quantity',
    (currency, total, unitGross, totalMinor, unitMinor) => {
      const items = enteredItems();
      items.discount = '0';
      items.tax = '0';
      items.lines[0] = {
        ...items.lines[0]!,
        quantity: '2.000001',
        unitGross,
        gross: total,
        discount: '0',
        tax: '0',
        net: total,
        sku: '',
      };
      items.tenders = [{ kind: 'cash', amount: total }];
      expect(
        receiptPhotoExtraction({ ...summary, kind: 'refund', currency, total }, items),
      ).toMatchObject({
        kind: 'refund',
        receipt: {
          total: { currency, minorUnits: totalMinor },
          lines: [
            {
              quantityMicros: 2000001,
              sku: null,
              unitGross: { currency, minorUnits: unitMinor },
              net: { currency, minorUnits: totalMinor },
            },
          ],
          tenders: [
            { kind: 'cash', amount: { currency, minorUnits: totalMinor }, observationId: null },
          ],
        },
      });
    },
  );
  it('requires all explicit amounts, quantity, description and tender kind, with exact integer boundaries', () => {
    for (const key of [
      'description',
      'quantity',
      'unitGross',
      'gross',
      'discount',
      'tax',
      'net',
    ] as const) {
      const items = enteredItems();
      items.lines[0]![key] = '';
      expect(receiptPhotoExtraction(summary, items), key).toBeNull();
    }
    for (const key of ['tax', 'discount'] as const) {
      const items = enteredItems();
      items[key] = '';
      expect(receiptPhotoExtraction(summary, items)).toBeNull();
    }
    for (const quantity of ['0', '1.0000001', '1e3', '4294.967296', '-1']) {
      const items = enteredItems();
      items.lines[0]!.quantity = quantity;
      expect(receiptPhotoExtraction(summary, items)).toBeNull();
    }
    const maximum = enteredItems();
    maximum.lines[0]!.quantity = '4294.967295';
    expect(receiptPhotoExtraction(summary, maximum)?.receipt?.lines[0]!.quantityMicros).toBe(
      4294967295,
    );
    maximum.lines[0]!.net = '92233720368547758.08';
    expect(receiptPhotoExtraction(summary, maximum)).toBeNull();
    const noLines = enteredItems();
    noLines.lines = [];
    expect(receiptPhotoExtraction(summary, noLines)).toBeNull();
    const noTenders = enteredItems();
    noTenders.tenders = [];
    expect(receiptPhotoExtraction(summary, noTenders)).toBeNull();
    const incomplete = enteredItems();
    incomplete.tenders[0]!.kind = '';
    expect(receiptPhotoExtraction(summary, incomplete)).toBeNull();
    incomplete.tenders[0]!.kind = 'card';
    incomplete.tenders[0]!.amount = '';
    expect(receiptPhotoExtraction(summary, incomplete)).toBeNull();
  });
});

it('retains a mismatch through application normalization and native receipt validation without repairing claims', () => {
  const items = enteredItems();
  items.lines[0]!.net = '0.01';
  const extraction = receiptPhotoExtraction({ ...summary, total: '12.00' }, items);
  const normalized = parseManualReceiptPhoto(extraction, 'a'.repeat(64));
  expect(normalized.parseStatus).toBe('parsed');
  const request = TransactionEvidenceRequestSchema.parse({
    ...receiptFixture,
    observations: (normalized.extraction.observations as Record<string, unknown>[]).map((row) => ({
      ...row,
      provenance: {
        ...receiptFixture.observations[0]!.provenance,
        contentHash: 'a'.repeat(64),
        parserVersion: normalized.parserVersion,
      },
    })),
    relationships: [],
    wallets: [],
    receipts: normalized.extraction.receipts,
  });
  expect(request.receipts[0]!.lines[0]!.net.minorUnits).toBe('1');
  expect(request.receipts[0]!.lines[0]!.id).not.toBe(extraction!.receipt!.lines[0]!.id);
  expect(request.receipts[0]!.lines[0]!.evidenceStrength).toBe(0);
  const native = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence: (request: string) => string;
  };
  const result = JSON.parse(native.resolveTransactionEvidence(JSON.stringify(request)));
  expect(result.receipts[0]).toMatchObject({
    valid: false,
    reasonCodes: ['receipt_total_mismatch'],
  });
  expect(request.receipts[0]!.lines[0]!.net.minorUnits).toBe('1');
});
