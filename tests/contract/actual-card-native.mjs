import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const native = require('../../crates/node-binding/balanceframe.node');
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request)));
assert.equal(result.budgetFundingStatus, 'funded');
assert.equal(result.paymentLiquidityStatus, 'ready');
const purchase = result.purchases.find((item) => item.itemId === 'buy-food');
assert.equal(purchase.credit.authorizationAvailable.minorUnits, '5000');
assert.equal(purchase.credit.authorizationAfter.minorUnits, '3000');
assert.equal(purchase.credit.additionalPaymentCash.minorUnits, '2000');
assert.equal(purchase.credit.paymentCashReady, true);
assert.equal(
  result.accountsBefore.find((account) => account.accountId === 'cash').safeSpendingCapacity
    .minorUnits,
  '5000',
);
assert.equal(
  result.accountsAfter.find((account) => account.accountId === 'cash').safeSpendingCapacity
    .minorUnits,
  '3000',
);
assert.equal(
  result.backingAfter.lines.find((line) => line.categoryId === 'card-payment').amount.minorUnits,
  '2000',
);

const selfReserve = structuredClone(request);
selfReserve.scenario.items[0].categoryId = 'card-payment';
const rejected = JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(selfReserve)));
assert.notEqual(rejected.paymentLiquidityStatus, 'ready');
console.log(
  'Normalized Actual card funded/ready; authorization and payment cash decrease once; payment reserve is not ordinary spending.',
);
