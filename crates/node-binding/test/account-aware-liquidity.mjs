import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Main emits both files from tests/contract/fixtures/actual-liquidity.ts using
// actualLiquidityRequest(false/true); this smoke never fabricates normalized evidence.
const [plainPath, attestedPath] = process.argv.slice(2);
if (!plainPath || !attestedPath) {
  throw new Error(
    'Usage: node account-aware-liquidity.mjs <plain-actual-request.json> <attested-actual-request.json>',
  );
}
const native = createRequire(import.meta.url)(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'balanceframe.node'),
);
const plain = JSON.parse(readFileSync(plainPath, 'utf8'));
const attested = JSON.parse(readFileSync(attestedPath, 'utf8'));
const evaluate = (request) =>
  JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request)));

const unknown = evaluate(plain);
assert.equal(unknown.paymentLiquidityStatus, 'insufficient_data');
const ready = evaluate(attested);
assert.equal(ready.budgetFundingStatus, 'funded');
assert.equal(ready.paymentLiquidityStatus, 'ready');
assert.equal(ready.accountsBefore[0].adjustedCash.minorUnits, '15000');
assert.equal(ready.accountsBefore[0].safeSpendingCapacity.minorUnits, '5000');
assert.equal(ready.accountsAfter[0].safeSpendingCapacity.minorUnits, '3000');
assert.equal(ready.categories[0].remainingAvailability.minorUnits, '0');
assert.ok(ready.assumptions.includes('explicit_user_attestation_not_bank_sync'));
assert.equal(
  native.evaluateAccountAwareSpendability(JSON.stringify(attested)),
  native.evaluateAccountAwareSpendability(JSON.stringify(attested)),
);

assert.throws(() => native.evaluateAccountAwareSpendability('{invalid-json'));
const missing = structuredClone(attested);
delete missing.claimSet;
assert.throws(() => native.evaluateAccountAwareSpendability(JSON.stringify(missing)));
for (const minorUnits of ['9223372036854775808', '-9223372036854775809', '+2000', '02000']) {
  const invalid = structuredClone(attested);
  invalid.scenario.items[0].amount.minorUnits = minorUnits;
  assert.throws(() => native.evaluateAccountAwareSpendability(JSON.stringify(invalid)), minorUnits);
}
for (const evaluatedAt of [
  '2026-02-30T10:00:00Z',
  '2026-09-06T10:00:00+00:00',
  '2026-09-06T09:59:60Z',
]) {
  const invalid = structuredClone(attested);
  invalid.context.evaluatedAt = evaluatedAt;
  assert.equal(evaluate(invalid).paymentLiquidityStatus, 'insufficient_data');
}
console.log('account-aware liquidity normalized native smoke passed');
