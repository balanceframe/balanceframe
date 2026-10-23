import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const native = require('../balanceframe.node');
const fixture=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/transaction-evidence.json',import.meta.url),'utf8'));
assert.equal(typeof native.resolveTransactionEvidence, 'function');
const result=JSON.parse(native.resolveTransactionEvidence(JSON.stringify(fixture)));
assert.equal(result.events[0].state, 'resolved');
assert.equal(result.events[0].projectionObservation, null);
assert.deepEqual(result.events[0].reasonCodes, ['existing_ledger_transaction']);
assert.equal(result.resolutionHash.length, 64);
for(const invalid of ['{','{}',JSON.stringify({...fixture,contractVersion:'2'})]) assert.throws(()=>native.resolveTransactionEvidence(invalid));
if(process.argv.includes('--save-fixture')) writeFileSync(new URL('../../../protocol/fixtures/transaction-evidence-result.json',import.meta.url),`${JSON.stringify(result,null,2)}\n`);
console.log('Native transaction evidence contract passed');
const ruleFixture=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/transaction-evidence-rule.json',import.meta.url),'utf8'));
assert.equal(typeof native.simulateTransactionEvidenceRule, 'function');
const simulation=JSON.parse(native.simulateTransactionEvidenceRule(JSON.stringify(ruleFixture)));
assert.equal(simulation.matches.length, 1);
assert.equal(simulation.requiresApproval, true);
assert.throws(() => native.simulateTransactionEvidenceRule('{}'));

for (const counterparty of [undefined, null, '', '   ', 'Store\nA']) {
  const invalid = structuredClone(ruleFixture);
  if (counterparty === undefined) delete invalid.rule.counterparty;
  else invalid.rule.counterparty = counterparty;
  assert.throws(() => native.simulateTransactionEvidenceRule(JSON.stringify(invalid)));
}
for (const counterparty of ['Store B', null, 'PERSON-1']) {
  const unrelated = structuredClone(ruleFixture);
  unrelated.evidence.observations[0].counterparty = counterparty;
  assert.equal(
    JSON.parse(native.simulateTransactionEvidenceRule(JSON.stringify(unrelated))).matches.length,
    0,
  );
}

assert.equal(typeof native.learnTransactionEvidenceItemRules, 'function');
const learningInput={contractVersion:'1',policyVersion:'policy-v1',accountId:'account-1',evidence:ruleFixture.evidence,outcomes:[]};
const learned=JSON.parse(native.learnTransactionEvidenceItemRules(JSON.stringify(learningInput)));
assert.deepEqual(learned.candidates,[]);
assert.deepEqual(learned.conflicts,[]);
assert.equal(learned.resolutionHash.length,64);
for(const invalid of ['{','{}',JSON.stringify({...learningInput,contractVersion:'2'}),JSON.stringify({...learningInput,authenticated:true})]) assert.throws(()=>native.learnTransactionEvidenceItemRules(invalid));

const comparisonFixture=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/spend-session-receipt.json',import.meta.url),'utf8'));
assert.equal(typeof native.compareSpendSessionReceipt,'function');
assert.deepEqual(JSON.parse(native.compareSpendSessionReceipt(JSON.stringify(comparisonFixture))),JSON.parse(readFileSync(new URL('../../../protocol/fixtures/spend-session-receipt-result.json',import.meta.url),'utf8')));
for(const invalid of ['{','{}',JSON.stringify({...comparisonFixture,contractVersion:'2'})]) assert.throws(()=>native.compareSpendSessionReceipt(invalid));

assert.equal(typeof native.deriveEvidenceSettlementPlan, 'function');
const settlementInput=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/evidence-settlement-plan.json',import.meta.url),'utf8'));
const settlementPlan=JSON.parse(native.deriveEvidenceSettlementPlan(JSON.stringify(settlementInput)));
assert.equal(settlementPlan.ledgerTransactionId,'actual-bank-1');
assert.equal(settlementPlan.ledgerEffect.amount.minorUnits,'-1200');
assert.equal(settlementPlan.allocationHash.length,64);
assert.deepEqual(settlementPlan.ledgerEffect.splits.map(split=>split.amount.minorUnits),['-400','-800']);
for(const invalid of ['{','{}',JSON.stringify({...settlementInput,lineCategories:[]}),JSON.stringify({...settlementInput,ledgerEffect:{}})]) assert.throws(()=>native.deriveEvidenceSettlementPlan(invalid));

assert.equal(typeof native.deriveEvidenceAllocationPlan,'function');
const allocationInput=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/evidence-allocation-plan.json',import.meta.url),'utf8'));
const allocationPlan=JSON.parse(native.deriveEvidenceAllocationPlan(JSON.stringify(allocationInput)));
assert.equal(allocationPlan.projections.length,2);
assert.equal(allocationPlan.allocationSetHash.length,64);
assert.deepEqual(allocationPlan.remainders,[]);
assert.throws(()=>native.deriveEvidenceAllocationPlan('{}'));
