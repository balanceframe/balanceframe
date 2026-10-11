import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appendActualAccountRows } from './review.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../protocol/fixtures/scenarios/merchant.json', import.meta.url), 'utf8'));
const template = fixture.ledger.transactions[0];

test('collects a complete 250k account history without stack expansion or losing money/account identity', () => {
  const values = Array.from({ length: 250000 }, (_, index) => ({
    id: `sdk-${String(index).padStart(6, '0')}`,
    date: template.date,
    amount: Number(template.amount.minorUnits),
    account_id: template.accountId,
  }));
  const prior = { id: 'prior-account-row', accountId: 'prior-account', amount: 0, parentId: null };
  const rows = [prior];
  appendActualAccountRows(rows, values, 'wrong-fallback-account');
  assert.equal(rows.length, 250001);
  assert.equal(new Set(rows.map((row) => row.id)).size, 250001);
  assert.equal(rows[0], prior);
  assert.equal(rows[1].id, 'sdk-000000');
  assert.equal(rows.at(-1).id, 'sdk-249999');
  assert(rows.slice(1).every((row) => row.accountId === template.accountId && row.parentId === null));
  assert.equal(rows.reduce((sum, row) => sum + BigInt(row.amount), 0n),
    BigInt(template.amount.minorUnits) * 250000n);
});

test('collects split children under their native parent and rejects malformed or repeated native IDs', () => {
  const rows = [];
  appendActualAccountRows(rows, [{ id: 'split-parent', account: 'sdk-account', amount: 0,
    subtransactions: [{ id: 'split-child', amount: Number(template.amount.minorUnits) }] }], 'fallback-account');
  assert.deepEqual(rows.map(({ id, parentId, accountId }) => ({ id, parentId, accountId })), [
    { id: 'split-parent', parentId: null, accountId: 'sdk-account' },
    { id: 'split-child', parentId: 'split-parent', accountId: 'fallback-account' },
  ]);
  assert.throws(() => appendActualAccountRows([], null, 'fallback-account'), /actual_transactions_unavailable/);
  assert.throws(() => appendActualAccountRows([], [{ amount: 0 }], 'fallback-account'), /actual_transaction_id_unavailable/);
  assert.throws(() => appendActualAccountRows([], [{ id: 'same' }, { id: 'same' }], 'fallback-account'), /actual_transaction_id_duplicate/);
});
