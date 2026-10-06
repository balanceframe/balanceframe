import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { merchantAnalysisRequestSchema, merchantSuggestionSchema, merchantRecurrenceSchema } from '../../packages/protocol-generated/src/merchant-validators.ts';
import { evaluatePredictions, evaluateNativeCorpus } from './quality.mjs';

const specimen = JSON.parse(readFileSync(new URL('../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
function corpus(labels = [
  { transactionId: 'correct', merchantId: 'payee-market', categoryId: 'category-food', expected: 'suggest', tags: ['sparse', 'temporal-late'], overrideCategoryId: null },
  { transactionId: 'wrong', merchantId: 'payee-market', categoryId: 'category-food', expected: 'suggest', tags: ['sparse', 'heldout-merchant'], overrideCategoryId: null },
  { transactionId: 'negative', merchantId: null, categoryId: null, expected: 'abstain', tags: ['sparse', 'unsupported'], overrideCategoryId: null },
  { transactionId: 'override', merchantId: 'payee-market', categoryId: 'category-bills', expected: 'suggest', tags: ['explicit-override'], overrideCategoryId: 'category-bills' },
]) {
  const request = clone(specimen.request);
  request.rules = [];
  request.transactions = labels.map((label) => ({ ...clone(request.transactions[0]), id: label.transactionId,
    importedId: `import-${label.transactionId}`, occurrenceId: label.transactionId, categoryId: label.overrideCategoryId }));
  request.sourceAdmission.originalTransactionCount = labels.length;
  return { schemaVersion: '1', provenance: { kind: 'synthetic', generatorVersion: 'merchant-quality-synthetic/1', seed: 110042,
    trainingCutoff: '2026-01-01', holdoutStart: '2026-01-02', asOfDate: '2026-10-04', limitations: ['Synthetic challenge distribution, not population accuracy.'] },
  merchantCatalog: request.payees.map(({ id, name }) => ({ id, name })),
  requests: [{ id: 'score', kind: 'boundary', request: merchantAnalysisRequestSchema.parse(request), trainingIds: [], labels, recurrenceLabels: [] }] };
}
function prediction(transactionId, categoryId, patch = {}) {
  return merchantSuggestionSchema.parse({ ...clone(specimen.result.suggestions[0]), transactionId, categoryId, tier: 'inferred', ...patch });
}
function outputs() {
  return [prediction('correct', 'category-food'), prediction('wrong', 'category-bills', { payeeId: 'payee-other' }),
    prediction('negative', null, { payeeId: null, tier: 'insufficient_data' }), prediction('override', 'category-bills', { tier: 'confirmed' })];
}

test('scores category precision, merchant aliases, abstentions and fixed sparse coverage independently', () => {
  const current = outputs();
  const baseline = current.map((row) => ({ ...row, categoryId: row.transactionId === 'override' ? 'category-bills' : null }));
  const result = evaluatePredictions(corpus(), current, baseline);
  assert.deepEqual(result.current.inferredPrecision, { numerator: 1, denominator: 2, percent: 50 });
  assert.deepEqual(result.current.allTierPrecision, { numerator: 2, denominator: 3, percent: 200 / 3 });
  assert.deepEqual(result.current.sparseCoverage, { numerator: 1, denominator: 3, percent: 100 / 3 });
  assert.deepEqual(result.current.falseAlias, { numerator: 1, denominator: 3, percent: 100 / 3 });
  assert.deepEqual(result.current.abstention, { numerator: 1, denominator: 4, percent: 25 });
  assert.equal(result.sparseCoverageDeltaPp, 100 / 3);
  assert.equal(result.strata['heldout-merchant'].current.inferredPrecision.numerator, 0);
  assert.equal(result.strata['heldout-merchant'].current.inferredPrecision.denominator, 1);
  assert.equal(result.gates.inferredPrecision, 'FAIL');
  assert.equal(result.gates.noPrecisionRegression, 'FAIL');
  assert.equal(result.evidenceKind, 'synthetic');
  assert.equal(result.realWorldAccuracyEstablished, false);
});

test('required-abstention suggestions count as precision errors even when the category exists', () => {
  const rows = outputs();
  rows[1] = prediction('wrong', 'category-food');
  rows[2] = prediction('negative', 'category-food');
  const result = evaluatePredictions(corpus(), rows, outputs());
  assert.deepEqual(result.current.inferredPrecision, { numerator: 2, denominator: 3, percent: 200 / 3 });
  assert.equal(result.current.requiredAbstentionViolations, 1);
});

test('a matching category with a wrong merchant is not a correct suggestion', () => {
  const rows = outputs();
  rows[0] = prediction('correct', 'category-food', { payeeId: 'payee-other' });
  const result = evaluatePredictions(corpus(), rows, outputs());
  assert.equal(result.current.inferredPrecision.numerator, 0);
  assert.equal(result.current.sparseCoverage.numerator, 0);
  assert.equal(result.current.falseAlias.numerator, 2);
});

test('zero precision or sparse denominators remain UNPROVEN rather than perfect', () => {
  const input = corpus([corpus().requests[0].labels[2]]);
  input.requests[0].labels[0].tags = ['unsupported'];
  const rows = [prediction('negative', null, { payeeId: null, tier: 'insufficient_data' })];
  const result = evaluatePredictions(input, rows, rows);
  assert.deepEqual(result.current.inferredPrecision, { numerator: 0, denominator: 0, percent: null });
  assert.equal(result.current.sparseCoverage.percent, null);
  assert.equal(result.sparseCoverageDeltaPp, null);
  assert.equal(result.gates.inferredPrecision, 'UNPROVEN');
  assert.equal(result.gates.sparseCoverageImprovement, 'UNPROVEN');
  assert.equal(result.status, 'UNPROVEN');
});

test('approved comparable-output precision preserves unavailable legacy inference without a fabricated score', () => {
  const baseline = outputs().map((row) => ({ ...row, categoryId: null, tier: 'insufficient_data' }));
  baseline[0] = prediction('correct', 'category-food', { tier: 'deterministic_match' });
  const current = baseline.map((row) => ({ ...row }));
  current[0] = prediction('correct', 'category-food');
  current[3] = prediction('override', 'category-bills', { tier: 'confirmed' });
  const result = evaluatePredictions(corpus(), current, baseline);
  assert.deepEqual(result.baseline.inferredPrecision, { numerator: 0, denominator: 0, percent: null });
  assert.deepEqual(result.baseline.allTierPrecision, { numerator: 1, denominator: 1, percent: 100 });
  assert.equal(result.precisionRegressionMetric, 'all_structured_category_suggestions');
  assert.equal(result.gates.noPrecisionRegression, 'PASS');
  current[3] = prediction('override', 'category-food', { tier: 'confirmed' });
  const regression = evaluatePredictions(corpus(), current, baseline);
  assert.equal(regression.current.inferredPrecision.percent, 100);
  assert.equal(regression.gates.noPrecisionRegression, 'FAIL');
});

test('frozen 95-percent precision and ten-point coverage gates pass exactly at thresholds, not below', () => {
  const labels = Array.from({ length: 20 }, (_, index) => ({ transactionId: `threshold-${index}`, merchantId: 'payee-market',
    categoryId: 'category-food', expected: 'suggest', tags: ['sparse'], overrideCategoryId: null }));
  labels.push(corpus().requests[0].labels[3]);
  const input = corpus(labels);
  const current = labels.map((label, index) => prediction(label.transactionId, index < 19 ? 'category-food' : index === 19 ? 'category-bills' : 'category-bills',
    { tier: index === 20 ? 'confirmed' : 'inferred' }));
  const baseline = current.map((row, index) => ({ ...row, categoryId: index < 17 ? 'category-food' : 'category-bills' }));
  const exact = evaluatePredictions(input, current, baseline);
  assert.equal(exact.current.inferredPrecision.percent, 95);
  assert.equal(exact.sparseCoverageDeltaPp, 10);
  assert.equal(exact.status, 'PASS');
  const lowerPrecision = current.map((row, index) => ({ ...row, categoryId: index === 18 ? 'category-bills' : row.categoryId }));
  assert.equal(evaluatePredictions(input, lowerPrecision, baseline).gates.inferredPrecision, 'FAIL');
  const higherBaseline = baseline.map((row, index) => ({ ...row, categoryId: index === 17 ? 'category-food' : row.categoryId }));
  assert.equal(evaluatePredictions(input, current, higherBaseline).gates.sparseCoverageImprovement, 'FAIL');
});

test('explicit overrides cannot be hidden in inferred precision or silently omitted', () => {
  const rows = outputs();
  rows[3] = prediction('override', 'category-food', { tier: 'confirmed' });
  const result = evaluatePredictions(corpus(), rows, outputs());
  assert.equal(result.current.inferredPrecision.denominator, 2);
  assert.equal(result.current.overrideViolations, 1);
  assert.equal(result.current.overrideDenominator, 1);
  assert.equal(result.gates.explicitOverrides, 'FAIL');
  assert.throws(() => evaluatePredictions(corpus(), rows.slice(0, 3), outputs()), /missing|complete/i);
});

test('refuses partial, duplicate, unknown and missing output collections', () => {
  const input = corpus();
  for (const rows of [outputs().slice(1), [...outputs(), outputs()[0]], [...outputs(), prediction('unknown', null)]]) {
    assert.throws(() => evaluatePredictions(input, rows, outputs()), /missing|duplicate|unknown|complete/i);
    assert.throws(() => evaluatePredictions(input, outputs(), rows), /missing|duplicate|unknown|complete/i);
  }
  assert.throws(() => evaluatePredictions(input, undefined, outputs()), /collection|array|prediction/i);
  assert.throws(() => evaluatePredictions(input, outputs(), undefined), /collection|array|prediction/i);
});

test('capped or censored source rows are refused, while incomplete source admission is UNPROVEN', () => {
  for (const patch of [{ truncatedCount: 1 }, { originalTransactionCount: 5 }]) {
    const input = corpus(); Object.assign(input.requests[0].request.sourceAdmission, patch);
    assert.throws(() => evaluatePredictions(input, outputs(), outputs()), /capped|source|censored/i);
  }
  const input = corpus();
  input.requests[0].request.sourceAdmission.collections.payees = 'partial';
  const result = evaluatePredictions(input, outputs(), outputs());
  assert.equal(result.gates.sourceCompleteness, 'UNPROVEN');
  assert.equal(result.source.complete, false);
});

test('refuses malformed truth, duplicate labels, unknown references and training leakage', () => {
  for (const mutate of [
    (value) => value.requests[0].labels.push(clone(value.requests[0].labels[0])),
    (value) => { value.requests[0].labels[0].merchantId = 'not-in-catalog'; },
    (value) => { value.requests[0].labels[0].categoryId = 'not-in-categories'; },
    (value) => { value.requests[0].labels[0].expected = 'perhaps'; },
    (value) => { value.requests[0].labels[0].overrideCategoryId = 'category-bills'; },
    (value) => { value.requests[0].trainingIds = ['correct']; },
    (value) => { value.requests[0].labels[0].transactionId = 'no-source-row'; },
  ]) {
    const input = corpus(); mutate(input);
    assert.throws(() => evaluatePredictions(input, outputs(), outputs()), /label|catalog|category|source|training|override|duplicate/i);
  }
});

test('ineligible sparse rows are not the eligible coverage denominator', () => {
  const input = corpus();
  input.requests[0].request.transactions[2].pending = true;
  const rows = outputs().filter((row) => row.transactionId !== 'negative');
  const result = evaluatePredictions(input, rows, rows);
  assert.equal(result.current.sparseCoverage.denominator, 2);
  assert.equal(result.source.heldoutCount, 4);
  assert.equal(result.source.eligibleHeldoutCount, 3);
  assert.equal(result.source.ineligibleHeldoutCount, 1);
  assert.throws(() => evaluatePredictions(input, outputs(), rows), /ineligible|excluded/i);
});

function recurrenceCorpus() {
  const input = corpus();
  const request = input.requests[0];
  request.recurrenceLabels = [
    { accountId: 'account-checking', payeeId: 'payee-market', currency: 'USD', direction: 'outgoing', frequency: 'monthly', established: true },
    { accountId: 'account-checking', payeeId: 'payee-other', currency: 'USD', direction: 'outgoing', frequency: 'weekly', established: false },
    { accountId: 'account-checking', payeeId: 'payee-market', currency: 'EUR', direction: 'incoming', frequency: null, established: false },
  ];
  return input;
}
function recurrence(payeeId, patch = {}) {
  return { requestId: 'score', ...merchantRecurrenceSchema.parse({ ...clone(specimen.recurrenceResult.recurrences[0]), payeeId, ...patch }) };
}

test('recurrence measures established misses, false positives and provisional tiers separately', () => {
  const input = recurrenceCorpus();
  const provisional = recurrence('payee-other', { frequency: 'weekly', occurrences: 2, tier: 'insufficient_data' });
  const descriptive = recurrence('payee-market', { currency: 'EUR', direction: 'inflow', frequency: 'irregular', tier: 'insufficient_data',
    minimumAmount: { minorUnits: '100', currency: 'EUR' }, maximumAmount: { minorUnits: '300', currency: 'EUR' } });
  const good = evaluatePredictions(input, outputs(), outputs(), [recurrence('payee-market'), provisional, descriptive]);
  assert.equal(good.recurrence.establishedCorrect, 1);
  assert.equal(good.recurrence.establishedDenominator, 1);
  assert.equal(good.recurrence.falsePositives, 0);
  assert.equal(good.recurrence.negativeDenominator, 2);
  assert.equal(good.recurrence.provisionalCorrect, 1);
  assert.equal(good.recurrence.provisionalDenominator, 1);
  const bad = evaluatePredictions(input, outputs(), outputs(), [{ ...provisional, tier: 'inferred', occurrences: 3 }]);
  assert.equal(bad.recurrence.falsePositives, 1);
  assert.equal(bad.recurrence.establishedMisses, 1);
  assert.equal(bad.recurrence.provisionalMisses, 1);
  assert.throws(() => evaluatePredictions(input, outputs(), outputs(), [provisional, provisional]), /duplicate/i);
  assert.throws(() => evaluatePredictions(input, outputs(), outputs(), [{ ...provisional, requestId: 'unknown' }]), /unknown/i);
});

test('native evaluator requires both actual native entry points rather than substituting current baseline', async () => {
  await assert.rejects(async () => evaluateNativeCorpus(corpus(), { currentNative: {}, baselineNative: {} }), /native|analyzeMerchantIntelligence/i);
});
