import { expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/representative.json';
import type { Transaction } from '@balanceframe/protocol-generated';
import { ledgerEvidenceHash } from '../src/evidence-ledger-source.js';
it('binds financial Actual identity while preserving proof across approved categorization-only changes', () => {
  const row = structuredClone(fixture.transactions[0]) as Transaction;
  expect(ledgerEvidenceHash(row)).toMatch(/^[a-f0-9]{64}$/);
  expect(
    ledgerEvidenceHash({
      ...row,
      notes: 'new note',
      categoryId: 'new-category',
      categoryName: 'New category',
      subtransactions: [],
    }),
  ).toBe(ledgerEvidenceHash(row));
  for (const changed of [
    { id: 'different' },
    { accountId: 'different' },
    { date: '2026-10-20' },
    { amount: { minorUnits: '-1', currency: 'USD' } },
    { transferAccountId: 'another-account' },
  ])
    expect(ledgerEvidenceHash({ ...row, ...changed })).not.toBe(ledgerEvidenceHash(row));
});
