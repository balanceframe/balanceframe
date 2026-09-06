import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const native = createRequire(import.meta.url)('../balanceframe.node');
const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`../../../protocol/fixtures/${name}.json`, import.meta.url), 'utf8'),
  );
const representative = fixture('representative');
const money = (amount) => ({ minorUnits: String(amount), currency: 'USD' });
const snapshot = {
  ...representative,
  accounts: [representative.accounts[0]],
  transactions: [],
  categories: [representative.categories[0]],
  schedules: [],
  budgets: [],
  rules: [],
};
const transaction = {
  ...representative.transactions[0],
  categoryId: null,
  amount: money(-100),
  importedId: null,
};
const call = (name, input) => JSON.parse(native[name](JSON.stringify(input)));

// Invalid wire input must throw a JavaScript error, never return a success envelope.
for (const name of [
  'analyzeSnapshot',
  'analyzeDeterministic',
  'findCategorizationCandidates',
  'validateSuggestion',
  'validateProviderSuggestion',
  'planSetCategory',
  'verifyMutation',
  'simulateRule',
  'planCreateRule',
  'verifyRuleMutation',
  'analyzeRuleCandidates',
  'evaluatePurchase',
  'evaluateProspectivePurchase',
  'evaluateAccountAwareSpendability',
  'verifyTransferSettlement',
  'verifyTransferPreconditions',
  'projectCashFlow',
  'evaluateTargetHealth',
  'evaluateFinancialState',
  'computeDataQuality',
  'computeLiquidityCoverage',
  'computeBillCalendar',
  'computeBudgetVariance',
  'detectIrregularObligations',
  'assessIncomeReliability',
  'evaluateForecastCalibration',
  'compareScenarios',
  'evaluateMultidimensionalHealth',
]) {
  assert.throws(() => native[name]('{malformed'), /deserialize:/, name);
}

const category = snapshot.categories[0];
snapshot.transactions = [transaction];
const candidates = call('findCategorizationCandidates', [
  transaction,
  { ...transaction, id: 'categorized', categoryId: category.id },
]);
assert.deepEqual(
  candidates.map((candidate) => candidate.transactionId),
  [transaction.id],
);
const suggestion = {
  transactionId: transaction.id,
  proposedCategoryId: category.id,
  categoryName: category.name,
  confidence: 0.9,
  reasonCodes: [],
  evidence: [],
};
assert.equal(call('validateSuggestion', { snapshot, suggestion }).valid, true);
assert.equal(
  call('validateSuggestion', {
    snapshot,
    suggestion: { ...suggestion, proposedCategoryId: 'missing' },
  }).valid,
  false,
);
assert.equal(
  call('validateSuggestion', { snapshot, suggestion: { ...suggestion, proposedCategoryId: '' } })
    .valid,
  true,
);
const denied = call('validateProviderSuggestion', {
  snapshot,
  suggestion,
  candidate: candidates[0],
});
assert.equal(denied.valid, false);
assert.ok(denied.reasonCodes.includes('provider_inference_disabled'));
const stale = call('validateProviderSuggestion', {
  snapshot,
  suggestion: { ...suggestion, transactionVersion: 'stale' },
  candidate: candidates[0],
  effectivePolicy: 'externalAllowed',
});
assert.ok(stale.reasonCodes.includes('stale_transaction_version'));

const plan = call('planSetCategory', { transaction, category });
assert.equal(call('verifyMutation', { plan, snapshot }).verified, true);
const changed = { ...snapshot, transactions: [{ ...transaction, categoryId: category.id }] };
assert.ok(
  call('verifyMutation', { plan, snapshot: changed }).reasonCodes.includes('category_changed'),
);
const postcondition = {
  ...plan,
  postconditions: [{ type: 'CategoryExists', categoryId: 'missing' }],
};
assert.ok(
  call('verifyMutation', { plan: postcondition, snapshot }).reasonCodes.includes(
    'postcondition_not_met',
  ),
);

const rulePlan = call('planCreateRule', {
  ruleName: 'Groceries',
  payeeName: ' Whole Foods ',
  categoryId: category.id,
  snapshot,
});
assert.equal(call('verifyRuleMutation', { plan: rulePlan, snapshot }).verified, true);
const rule = {
  id: 'rule',
  name: 'Groceries',
  order: 0,
  trigger: rulePlan.trigger,
  actions: rulePlan.actions,
  inactive: false,
};
assert.equal(
  call('verifyRuleMutation', { plan: rulePlan, snapshot: { ...snapshot, rules: [rule] } }).verified,
  false,
);
assert.deepEqual(call('simulateRule', { rule, transactions: [transaction] }).transactionsAffected, [
  transaction.id,
]);
assert.equal(
  call('simulateRule', { rule: { ...rule, inactive: true }, transactions: [transaction] })
    .transactionsMatched,
  0,
);
const history = {
  ...snapshot,
  transactions: [0, 1, 2].map((index) => ({
    ...transaction,
    id: `history-${index}`,
    categoryId: category.id,
  })),
};
assert.equal(
  call('analyzeRuleCandidates', { snapshot: history, minConsistentCount: 3 })[0].proposedCategoryId,
  category.id,
);
assert.deepEqual(call('analyzeRuleCandidates', { snapshot: history, minConsistentCount: 4 }), []);
const analysis = call('analyzeSnapshot', {
  snapshot,
  options: { includePending: true, includeCleared: true, maxResults: null },
});
assert.ok(analysis.findings.some((finding) => finding.findingType === 'uncategorized'));

// Projection rolls across a year and keeps income separate from obligations.
const schedule = (id, amount, frequency) => ({
  id,
  amount: money(amount),
  frequency,
  accountId: snapshot.accounts[0].id,
  payeeName: id,
  nextExpected: '2026-12-15',
});
const scheduled = {
  ...snapshot,
  snapshotDate: '2026-12-01',
  schedules: [
    schedule('income', 1000, 'monthly'),
    schedule('weekly', -100, 'weekly'),
    schedule('once', -200, '2026-12'),
    schedule('other', -999, '2027-06'),
  ],
};
const projection = call('projectCashFlow', { snapshot: scheduled, projectionMonths: 2 });
assert.deepEqual(
  projection.monthlyProjections.map((month) => [month.month, month.netChange.minorUnits]),
  [
    ['2026-12', '700'],
    ['2027-01', '900'],
  ],
);
assert.equal(projection.monthlyProjections[1].endingBalance.minorUnits, '544810');
assert.equal(
  call('projectCashFlow', { snapshot: { ...snapshot, snapshotDate: '' }, projectionMonths: 0 })
    .projectionMonths,
  1,
);

const budgetCategory = (id, amount) => ({
  categoryId: id,
  amount: money(amount),
  carryover: money(0),
  carryoverFromPrevious: money(0),
  carriesOver: false,
});
const budgeted = {
  ...snapshot,
  budgets: [
    {
      id: 'budget',
      month: '2026-07',
      categories: { [category.id]: budgetCategory(category.id, 1000) },
    },
  ],
};
assert.equal(
  call('evaluateTargetHealth', { snapshot: budgeted }).categoryHealth[0].healthLabel,
  'healthy',
);
const atRisk = {
  ...budgeted,
  transactions: [{ ...transaction, categoryId: category.id, amount: money(-950) }],
};
assert.equal(call('evaluateTargetHealth', { snapshot: atRisk }).overallLabel, 'caution');
const missingName = {
  ...budgeted,
  categories: [],
  budgets: [
    { id: 'budget', month: '2026-07', categories: { missing: budgetCategory('missing', 0) } },
  ],
};
assert.equal(
  call('evaluateTargetHealth', { snapshot: missingName }).categoryHealth[0].healthLabel,
  'underfunded',
);
for (const [health, positive, coverage, overspent, expected] of [
  ['at_risk', false, 0.7, 3, 'at_risk'],
  ['at_risk', true, 0.9, 3, 'at_risk'],
  ['healthy', true, 0.5, 0, 'at_risk'],
  ['healthy', false, 0.7, 1, 'stable'],
]) {
  assert.equal(
    call('evaluateFinancialState', {
      overallHealthLabel: health,
      positiveCashFlow: positive,
      budgetCoverageRatio: coverage,
      overspentCategoryCount: overspent,
      month: '2026-07',
    }).label,
    expected,
  );
}

const empty = { ...snapshot, accounts: [], transactions: [], categories: [] };
assert.equal(call('computeDataQuality', { snapshot: empty }).availability, 'noConfiguration');
const duplicate = {
  ...snapshot,
  transactions: [
    transaction,
    { ...transaction, id: 'duplicate', importedId: 'same' },
    { ...transaction, id: 'duplicate2', importedId: 'same' },
  ],
};
assert.equal(
  call('computeDataQuality', { snapshot: duplicate }).dimensions.find(
    (dimension) => dimension.dimension === 'consistency',
  ).score,
  1 - 1 / 3,
);
assert.equal(
  call('computeLiquidityCoverage', { snapshot, currentMonth: '2026-07' }).totalLiquid.minorUnits,
  '543210',
);
assert.equal(
  call('computeBillCalendar', { snapshot: scheduled, referenceDate: '2026-12-01' }).unpaidCount,
  3,
);
assert.equal(
  call('computeBudgetVariance', { snapshot: budgeted, referenceDate: '2026-07-15' }).totalBudgeted
    .minorUnits,
  '1000',
);
assert.equal(
  call('detectIrregularObligations', { snapshot: empty }).availability,
  'noConfiguration',
);
assert.equal(call('assessIncomeReliability', { snapshot: empty }).availability, 'noConfiguration');
assert.equal(
  call('evaluateForecastCalibration', { snapshot: budgeted }).availability,
  'insufficientData',
);
assert.equal(
  call('evaluateMultidimensionalHealth', { snapshot: empty, currentMonth: '2026-07' }).availability,
  'noConfiguration',
);
const scenario = (id, amount) => ({
  id: { id, name: id },
  version: { sourceVersion: '1', resultVersion: '1' },
  assumptions: [],
  expiresAt: '2026-12-31',
  createdAt: '2026-07-15',
  payload: { cash: amount },
});
const compared = call('compareScenarios', {
  snapshot,
  baseline: scenario('base', 100),
  comparison: scenario('new', 80),
});
assert.equal(compared.deltas[0].baselineValue, 100);
assert.equal(compared.deltas[0].comparisonValue, 80);
for (const [baseline, comparison] of [
  [{}, scenario('new', 80)],
  [scenario('base', 100), {}],
]) {
  const result = call('compareScenarios', { snapshot, baseline, comparison });
  assert.equal(result.availability, 'unavailable');
  assert.deepEqual(result.deltas, []);
}

// Canonical fixtures carry a genuine transfer-required scenario through Node/N-API.
const domain = fixture('account-aware-liquidity');
const foundation = fixture('financial-decision-foundation');
const financialSnapshot = {
  ...foundation.full,
  snapshotId: domain.snapshotId,
  contentHash: domain.contentHash,
  liquidity: domain.facts,
  coverage: { ...foundation.full.coverage, categories: 'complete' },
};
const context = {
  ...foundation.claims.context,
  snapshotId: domain.snapshotId,
  contentHash: domain.contentHash,
  evaluatedAt: domain.evaluatedAt,
  horizon: domain.horizon,
  policyVersion: domain.liquidityPolicy.version,
  policyHash: domain.liquidityPolicy.policyHash,
};
const request = {
  financialSnapshot,
  context,
  liquidityPolicy: domain.liquidityPolicy,
  claimSet: domain.claimSet,
  priorAllocation: null,
  scenario: domain.scenario,
  validUntil: domain.validUntil,
};
const transfer = call('evaluateAccountAwareSpendability', request);
assert.equal(transfer.paymentLiquidityStatus, 'transfer_required');
const transferPlan = transfer.purchases[0].transferPlan;
assert.equal(transferPlan.minimumAmount.minorUnits, '3000');
assert.equal(
  call('verifyTransferPreconditions', {
    plan: transferPlan,
    currentInput: request,
    ownClaimId: null,
  }).valid,
  true,
);
for (const [field, reason] of [
  ['contentHash', 'snapshot_identity_mismatch'],
  ['policyHash', 'policy_identity_mismatch'],
]) {
  const wrong = { ...request, context: { ...context, [field]: 'wrong' } };
  assert.deepEqual(call('evaluateAccountAwareSpendability', wrong).reasons, [reason]);
  assert.deepEqual(
    call('verifyTransferPreconditions', {
      plan: transferPlan,
      currentInput: wrong,
      ownClaimId: null,
    }),
    { valid: false, reasons: [reason] },
  );
}
const unsettled = call('verifyTransferSettlement', {
  plan: transferPlan,
  evaluatedAt: domain.evaluatedAt,
  records: [],
  consumedEvidenceIds: [],
});
assert.equal(unsettled.confirmed, false);
assert.deepEqual(unsettled.evidenceIds, []);
// Missing bank evidence must retain the source reservation, not release cash.
assert.deepEqual(
  unsettled.claimEffects.map(({ kind, resourceId, amount, includedInBalance }) => ({
    kind,
    resourceId,
    amount,
    includedInBalance,
  })),
  [
    {
      kind: 'account_debit',
      resourceId: 'savings',
      amount: { minorUnits: '3000', currency: 'USD' },
      includedInBalance: false,
    },
  ],
);
console.log('native public JSON boundary contracts passed');
