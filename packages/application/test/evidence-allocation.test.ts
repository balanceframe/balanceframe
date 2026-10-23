import { expect, it } from 'vitest';
import {
  evidenceAllocationPreviewSchema,
  evidenceAllocationSaveSchema,
} from '../src/evidence-allocation.js';
const selector = {
  resolutionHash: 'a'.repeat(64),
  targetTransactionIds: ['parent'],
  receiptIds: ['receipt'],
  lineCategories: [
    { receiptId: 'receipt', lineId: 'line', accountId: 'checking', categoryId: 'food' },
  ],
  cells: [
    {
      receiptId: 'receipt',
      lineId: 'line',
      targetTransactionId: 'parent',
      amount: { minorUnits: '700', currency: 'USD' },
    },
  ],
};
it('accepts explicit matrix selectors without source proof or caller-defined effects', () => {
  expect(evidenceAllocationPreviewSchema.parse(selector)).toEqual(selector);
  expect(
    evidenceAllocationSaveSchema.parse({ ...selector, allocationSetHash: 'b'.repeat(64) }),
  ).toMatchObject(selector);
  for (const extra of [{ actorId: 'forged' }, { allocationReview: {} }, { ledgerEffects: [] }])
    expect(evidenceAllocationPreviewSchema.safeParse({ ...selector, ...extra }).success).toBe(
      false,
    );
  for (const amount of [
    { minorUnits: '1.5', currency: 'USD' },
    { minorUnits: '9223372036854775808', currency: 'USD' },
  ])
    expect(
      evidenceAllocationPreviewSchema.safeParse({
        ...selector,
        cells: [{ ...selector.cells[0], amount }],
      }).success,
    ).toBe(false);
});
