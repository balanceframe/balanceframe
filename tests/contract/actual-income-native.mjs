import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const native = require('../../crates/node-binding/balanceframe.node');
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert(
  request.financialSnapshot.legacySnapshot.categories.some(
    (category) => category.id === 'income' && category.isIncome,
  ),
);
const expense = JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request)));
assert.equal(expense.budgetFundingStatus, 'funded');
assert.equal(expense.paymentLiquidityStatus, 'ready');

const incomePurchase = structuredClone(request);
incomePurchase.scenario.items[0].categoryId = 'income';
const rejected = JSON.parse(
  native.evaluateAccountAwareSpendability(JSON.stringify(incomePurchase)),
);
assert.notEqual(rejected.budgetFundingStatus, 'funded');
assert.notEqual(rejected.paymentLiquidityStatus, 'ready');
console.log(
  'Actual income source category retained; expense funded/ready; income is not a spendable cash envelope.',
);
