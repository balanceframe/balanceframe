import { describe, expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/spend-session-receipt.json';
import resultFixture from '../../../protocol/fixtures/spend-session-receipt-result.json';
import {
  CompareSpendSessionReceiptRequestSchema,
  CompareSpendSessionReceiptResultSchema,
} from '../src/spend-session-receipt';

describe('pure saved session receipt comparison contract', () => {
  it('preserves exact saved metadata and explicit review without authenticating its issuer', () => {
    expect(CompareSpendSessionReceiptRequestSchema.parse(fixture)).toEqual(fixture);
    expect(
      CompareSpendSessionReceiptRequestSchema.safeParse({ ...fixture, authenticated: true })
        .success,
    ).toBe(false);
    expect(
      CompareSpendSessionReceiptRequestSchema.safeParse({
        ...fixture,
        sessionSnapshot: { ...fixture.sessionSnapshot, authenticated: true },
      }).success,
    ).toBe(false);
  });
  it('requires all review fields and rejects unknown kinds, quantities and amount representations', () => {
    for (const review of [
      { ...fixture.review, coverage: 'all' },
      { ...fixture.review, pairs: [{ ...fixture.review.pairs[0], kind: 'automatic' }] },
    ])
      expect(
        CompareSpendSessionReceiptRequestSchema.safeParse({ ...fixture, review }).success,
      ).toBe(false);
    const missing = structuredClone(fixture) as Record<string, unknown>;
    delete missing.review;
    expect(CompareSpendSessionReceiptRequestSchema.safeParse(missing).success).toBe(false);
    for (const quantity of [0, -1, 1.1, 4294967296]) {
      const value = structuredClone(fixture);
      value.sessionSnapshot.intent.items[0]!.quantity = quantity;
      expect(CompareSpendSessionReceiptRequestSchema.safeParse(value).success).toBe(false);
    }
    const amount = structuredClone(fixture);
    amount.sessionSnapshot.intent.items[0]!.amount.minorUnits = '9223372036854775808';
    expect(CompareSpendSessionReceiptRequestSchema.safeParse(amount).success).toBe(false);
  });
});

it('preserves existing saved adjustment and warning metadata without treating it as receipt money', () => {
  const input = CompareSpendSessionReceiptRequestSchema.parse(fixture);
  input.sessionSnapshot.intent.adjustments = [
    { kind: 'fee', categoryId: 'cat', amount: { minorUnits: '10', currency: 'USD' } },
  ];
  input.sessionSnapshot.intent.warningThresholds = [
    {
      id: 'warning',
      basis: 'category_charge',
      categoryId: 'cat',
      maximum: { minorUnits: '9999', currency: 'USD' },
    },
  ];
  input.sessionSnapshot.intent.items[0]!.priceProvenance!.source = null;
  input.sessionSnapshot.intent.items[0]!.priceProvenance!.store = null;
  expect(CompareSpendSessionReceiptRequestSchema.parse(input)).toEqual(input);
  input.sessionSnapshot.intent.warningThresholds[0]!.maximum.minorUnits = '0';
  expect(CompareSpendSessionReceiptRequestSchema.safeParse(input).success).toBe(false);
});

it('accepts only comparison results and refuses financial action or authority fields', () => {
  expect(CompareSpendSessionReceiptResultSchema.parse(resultFixture)).toEqual(resultFixture);
  for (const invalid of [
    { ...resultFixture, authority: 'financial_action' },
    { ...resultFixture, ledgerEffect: {} },
    { ...resultFixture, comparisonHash: 'invalid' },
  ])
    expect(CompareSpendSessionReceiptResultSchema.safeParse(invalid).success).toBe(false);
});

it('bounds archived category allocations before invoking the native comparator', () => {
  const input = CompareSpendSessionReceiptRequestSchema.parse(fixture);
  input.sessionSnapshot.intent.items[0]!.categoryAllocations = Array.from({ length: 101 }, () => ({
    categoryId: 'cat',
    amount: { minorUnits: '1', currency: 'USD' },
  }));
  expect(CompareSpendSessionReceiptRequestSchema.safeParse(input).success).toBe(false);
});
