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
  'analyzeMerchantIntelligence',
  'findCategorizationCandidates',
  'validateSuggestion',
  'validateProviderSuggestion',
  'planSetCategory',
  'verifyMutation',
  'simulateRule',
  'planCreateRule',
  'simulateCreateRulePlan',
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
  assert.throws(
    () => native[name]('{malformed'),
    name === 'analyzeMerchantIntelligence' ? /merchant_analysis_failed/ : /deserialize:/,
    name,
  );
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
assert.equal(call('verifyMutation', { plan, snapshot }).verified, false);
const changed = { ...snapshot, transactions: [{ ...transaction, categoryId: category.id }] };
assert.equal(call('verifyMutation', { plan, snapshot: changed }).verified, true);

const nestedLeaf = { ...structuredClone(transaction), id: 'runtime-nested-leaf' };
const nestedPlan = call('planSetCategory', { transaction: nestedLeaf, category });
nestedLeaf.categoryId = category.id;
const nestedSnapshot = { ...structuredClone(snapshot), transactions: [{
  ...structuredClone(transaction), id: 'runtime-nested-root', subtransactions: [{
    ...structuredClone(transaction), id: 'runtime-nested-intermediate', subtransactions: [nestedLeaf],
  }],
}] };
assert.equal(call('verifyMutation', { plan: nestedPlan, snapshot: nestedSnapshot }).verified, true);
const duplicateNestedSnapshot = structuredClone(nestedSnapshot);
duplicateNestedSnapshot.transactions.push(structuredClone(nestedLeaf));
assert.equal(call('verifyMutation', { plan: nestedPlan, snapshot: duplicateNestedSnapshot }).verified, false);
duplicateNestedSnapshot.transactions.reverse();
assert.equal(call('verifyMutation', { plan: nestedPlan, snapshot: duplicateNestedSnapshot }).verified, false);
const postcondition = {
  ...plan,
  postconditions: [{ type: 'CategoryExists', categoryId: 'missing' }],
};
assert.ok(
  call('verifyMutation', { plan: postcondition, snapshot: changed }).reasonCodes.includes(
    'postcondition_not_met',
  ),
);

const reviewContext = {
  scope: {
    spaceId: 'space-fixture',
    budgetId: 'budget-fixture',
    connectionId: 'connection-fixture',
  },
  sourceFactsHash: 'facts-1',
  evidenceKey: null,
  evidenceRevision: 'evidence-1',
  merchantPolicyVersion: 'merchant-policy-1',
  visibilityHash: 'visibility-1',
  expiresAt: '2026-10-04T12:30:00Z',
};
const ruleRequest = {
  ruleName: 'Groceries',
  payeeId: transaction.payeeId,
  categoryId: category.id,
  reviewContext,
  snapshot,
};
const rulePlan = call('planCreateRule', ruleRequest);
assert.deepEqual(rulePlan.trigger, {
  stage: 'post',
  conditionsOp: 'and',
  conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
});
assert.deepEqual(rulePlan.actions, [{ op: 'set', field: 'category', value: category.id }]);
assert.equal(rulePlan.hash, call('planCreateRule', ruleRequest).hash);
assert.notEqual(
  rulePlan.hash,
  call('planCreateRule', {
    ...ruleRequest,
    reviewContext: { ...reviewContext, evidenceRevision: 'evidence-2' },
  }).hash,
);
const preview = call('simulateCreateRulePlan', { plan: rulePlan, snapshot });
assert.deepEqual(preview.transactionsAffected, [transaction.id]);
assert.equal(preview.transactionsMatched, 1);
assert.equal(preview.ruleId, '');
assert.equal(preview.examples[0].wouldChange, true);
assert.deepEqual(preview.examples[0].amount, transaction.amount);
assert.equal(call('verifyRuleMutation', { plan: rulePlan, snapshot }).verified, false);
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
  true,
);
assert.deepEqual(call('simulateRule', { rule, transactions: [transaction] }).transactionsAffected, [
  transaction.id,
]);
assert.equal(
  call('simulateRule', { rule: { ...rule, inactive: true }, transactions: [transaction] })
    .transactionsMatched,
  0,
);

const privateMarker = 'private-payload-must-not-appear-in-errors';
const throwsWithoutPayload = (name, input, pattern) =>
  assert.throws(
    () => call(name, input),
    (error) =>
      error instanceof Error &&
      pattern.test(error.message) &&
      !error.message.includes(privateMarker) &&
      !error.message.includes(JSON.stringify(input)),
  );
const legacyRuleRequest = { ...ruleRequest };
delete legacyRuleRequest.payeeId;
throwsWithoutPayload(
  'planCreateRule',
  { ...legacyRuleRequest, payeeName: privateMarker },
  /deserialize:/,
);
throwsWithoutPayload(
  'planCreateRule',
  { ...ruleRequest, extra: privateMarker },
  /deserialize:/,
);
throwsWithoutPayload(
  'planCreateRule',
  { ...ruleRequest, reviewContext: { ...reviewContext, extra: privateMarker } },
  /deserialize:/,
);
throwsWithoutPayload(
  'planCreateRule',
  { ...ruleRequest, payeeId: privateMarker },
  /payee is unavailable/,
);
throwsWithoutPayload(
  'simulateCreateRulePlan',
  { plan: rulePlan, snapshot: { ...snapshot, payees: [] } },
  /payee is unavailable/,
);

// Invoke the real merchant analyzer over the shared wire fixture, not an echo.
const merchant = fixture('merchant-intelligence');
const merchantResult = call('analyzeMerchantIntelligence', merchant.request);
assert.deepEqual(merchantResult.scope, merchant.result.scope);
assert.deepEqual(merchantResult.sourceAdmission, merchant.result.sourceAdmission);
assert.deepEqual(merchantResult.coverage, merchant.result.coverage);
assert.equal(merchantResult.snapshotId, merchant.request.snapshotId);
assert.equal(merchantResult.normalizationVersion, merchant.request.normalizationVersion);
assert.equal(merchantResult.suggestions.length, 1);
const merchantSuggestion = merchantResult.suggestions[0];
assert.equal(merchantSuggestion.transactionId, merchant.request.transactions[0].id);
assert.equal(merchantSuggestion.payeeId, merchant.request.transactions[0].payeeId);
assert.equal(merchantSuggestion.tier, 'deterministic_match');
assert.ok(merchantSuggestion.evidence.some(
  (evidence) =>
    evidence.sourceId === merchant.request.transactions[0].id &&
    evidence.field === 'importedPayee' &&
    evidence.rawText === merchant.request.transactions[0].importedPayee.value,
));
assert.deepEqual(
  call('analyzeMerchantIntelligence', merchant.request),
  merchantResult,
);
assert.ok(!Object.hasOwn(merchantResult, 'transactions'));
assert.deepEqual(merchantSuggestion.categoryHistory, merchant.result.suggestions[0].categoryHistory);
assert.deepEqual(merchantSuggestion.alternatives, []);
assert.deepEqual(merchantSuggestion.ruleCandidates, []);
assert.deepEqual(merchantResult.nativeRuleClassifications, []);
assert.deepEqual(merchantResult.nativeRuleSets, []);
assert.deepEqual(merchantResult.nativeRuleBlocks, []);

// Complete multi-byte bank evidence survives large JSON output and escape boundaries.
const unicodeMerchant = structuredClone(merchant.request);
const unicodeEvidence = 'é😀漢字"\\\n'.repeat(200);
unicodeMerchant.transactions = Array.from({ length: 160 }, (_, index) => ({
  ...structuredClone(merchant.request.transactions[0]),
  id: `utf8-transaction-${index}`, occurrenceId: `utf8-transaction-${index}`,
  importedId: `utf8-import-${index}`,
  importedPayee: { state: 'present', value: unicodeEvidence },
}));
unicodeMerchant.sourceAdmission.originalTransactionCount = unicodeMerchant.transactions.length;
unicodeMerchant.suggestionSelection = {
  transactionIds: unicodeMerchant.transactions.map((item) => item.id).sort(), cursor: null, limit: 200,
};
const unicodeWire = native.analyzeMerchantIntelligence(JSON.stringify(unicodeMerchant));
assert.equal(typeof unicodeWire, 'string');
const unicodeResult = JSON.parse(unicodeWire);
assert.deepEqual(
  new Set(unicodeResult.suggestions.map((item) => item.transactionId)),
  new Set(unicodeMerchant.transactions.map((item) => item.id)),
);
for (const item of unicodeResult.suggestions)
  assert.equal(item.evidence.find((value) => value.field === 'importedPayee').rawText, unicodeEvidence);

// Compact native classifications cover the whole admitted ledger, not just page 200.
const pagedMerchant = structuredClone(merchant.request);
const merchantRow = (id, date, categoryId = null) => ({
  ...merchant.request.transactions[0], id, occurrenceId: id, importedId: `import-${id}`, date, categoryId,
});
pagedMerchant.transactions = [
  ...Array.from({ length: 210 }, (_, index) => merchantRow(`runtime-candidate-${String(index).padStart(3, '0')}`, '2024-03-31')),
  ...Array.from({ length: 10 }, (_, index) => merchantRow(`runtime-history-${index}`, `2024-01-${String(index + 1).padStart(2, '0')}`, 'category-food')),
];
pagedMerchant.sourceAdmission.originalTransactionCount = pagedMerchant.transactions.length;
pagedMerchant.maxEvidence = 2;
pagedMerchant.rules = [{
  id: 'runtime-rule', name: 'Runtime native ID', order: 1, inactive: false,
  trigger: { stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'payee-market', type: 'id' }] },
  actions: [{ field: 'category', op: 'set', value: 'category-bills', type: 'id' }],
}];
pagedMerchant.suggestionSelection = {
  transactionIds: pagedMerchant.transactions.slice(0, 210).map((row) => row.id), cursor: null, limit: 200,
};
const pagedResult = call('analyzeMerchantIntelligence', pagedMerchant);
assert.equal(pagedResult.suggestions.length, 200);
assert.equal(pagedResult.nativeRuleClassifications.length, 210);
assert.deepEqual(pagedResult.nativeRuleBlocks, [{ ruleIds: ['runtime-rule'] }]);
assert.deepEqual(pagedResult.nativeRuleParts, [{ blockIndexes: [0] }]);
assert.deepEqual(pagedResult.nativeRuleSets, [{ orPartIndexes: [], andPartIndexes: [[0], [0], [0], [0]], categoryPartIndex: 0 }]);
assert.ok(pagedResult.nativeRuleClassifications.every((row) =>
  row.categoryId === 'category-bills' && row.ruleSetIndex === 0 && !Object.hasOwn(row, 'ruleIds')));
assert.deepEqual(pagedResult.suggestions[0].categoryHistory, {
  totalCount: 10, categoryCount: 1, truncated: false, entries: [{
    categoryId: 'category-food', count: 10, ledgerCount: 10, correctionCount: 0,
    firstDate: '2024-01-01', lastDate: '2024-01-10',
  }],
});
pagedMerchant.suggestionSelection.cursor = pagedResult.suggestionPage.nextCursor;
const nextPagedResult = call('analyzeMerchantIntelligence', pagedMerchant);
assert.deepEqual(nextPagedResult.nativeRuleClassifications, pagedResult.nativeRuleClassifications);
assert.deepEqual(nextPagedResult.nativeRuleSets, pagedResult.nativeRuleSets);
assert.deepEqual(nextPagedResult.nativeRuleBlocks, pagedResult.nativeRuleBlocks);
assert.deepEqual(nextPagedResult.nativeRuleParts, pagedResult.nativeRuleParts);
const reversedMerchant = structuredClone(pagedMerchant);
reversedMerchant.transactions.reverse();
reversedMerchant.rules.reverse();
const reversedResult = call('analyzeMerchantIntelligence', reversedMerchant);
assert.deepEqual(reversedResult.nativeRuleClassifications, pagedResult.nativeRuleClassifications);
assert.deepEqual(reversedResult.nativeRuleSets, pagedResult.nativeRuleSets);
assert.deepEqual(reversedResult.nativeRuleBlocks, pagedResult.nativeRuleBlocks);
assert.deepEqual(reversedResult.nativeRuleParts, pagedResult.nativeRuleParts);

// Complete equivalent-many IDs serialize once even with no requested explanations.
const compactMerchant = structuredClone(pagedMerchant);
const completeRuntimeRuleIds = Array.from({ length: 128 }, (_, index) => `runtime-shared-rule-${String(index).padStart(3, '0')}`);
compactMerchant.transactions = compactMerchant.transactions.map((row, index) => ({
  ...row, payeeId: `runtime-distinct-payee-${index}`, payeeName: `Distinct runtime merchant ${index}`,
}));
compactMerchant.payees = compactMerchant.transactions.map((row) => ({
  id: row.payeeId, name: row.payeeName, transferAccountId: null, mtid: null,
}));
compactMerchant.rules = completeRuntimeRuleIds.map((id) => ({
  ...pagedMerchant.rules[0], id,
  trigger: { stage: null, conditionsOp: 'and', conditions: [
    { field: 'account', op: 'is', value: 'account-checking' },
    { field: 'category', op: 'is', value: null },
  ] },
}));
compactMerchant.suggestionSelection = { transactionIds: [], cursor: null, limit: 1 };
const compactWire = native.analyzeMerchantIntelligence(JSON.stringify(compactMerchant));
const compactResult = JSON.parse(compactWire);
assert.deepEqual(compactResult.nativeRuleBlocks, [{ ruleIds: completeRuntimeRuleIds }]);
assert.deepEqual(compactResult.nativeRuleParts, [{ blockIndexes: [0] }]);
assert.deepEqual(compactResult.nativeRuleSets, [{ orPartIndexes: [], andPartIndexes: [[0], [0], [0], [0]], categoryPartIndex: 0 }]);
assert.equal(compactResult.nativeRuleClassifications.length, 210);
assert.ok(compactResult.nativeRuleClassifications.every((row) => row.ruleSetIndex === 0 && !Object.hasOwn(row, 'ruleIds')));
for (const id of completeRuntimeRuleIds) assert.equal(compactWire.split(JSON.stringify(id)).length - 1, 1);
assert.ok(Buffer.byteLength(compactWire) < 60000);

// Legacy pendingReview consumers receive the same table without maxResults censoring native outcomes.
const legacySharedSnapshot = structuredClone(snapshot);
legacySharedSnapshot.transactions = Array.from({ length: 210 }, (_, index) => ({
  ...transaction, id: `legacy-shared-${String(index).padStart(3, '0')}`, importedId: null, cleared: true,
  payeeId: `legacy-distinct-payee-${index}`, payeeName: `Distinct legacy merchant ${index}`,
}));
legacySharedSnapshot.payees = legacySharedSnapshot.transactions.map((row) => ({
  id: row.payeeId, name: row.payeeName, transferAccountId: null, mtid: null,
}));
legacySharedSnapshot.rules = completeRuntimeRuleIds.map((id) => ({
  id, name: id, order: 1, inactive: false,
  trigger: { stage: null, conditionsOp: 'and', conditions: [
    { field: 'account', op: 'is', value: transaction.accountId },
    { field: 'category', op: 'is', value: null },
  ] },
  actions: [{ field: 'category', op: 'set', value: category.id }],
}));
const legacySharedResult = call('analyzeDeterministic', {
  snapshot: legacySharedSnapshot, options: { includePending: false, includeCleared: true, maxResults: 1 },
});
assert.deepEqual(legacySharedResult.analysis.nativeRuleBlocks, [{ ruleIds: completeRuntimeRuleIds }]);
assert.deepEqual(legacySharedResult.analysis.nativeRuleParts, [{ blockIndexes: [0] }]);
assert.deepEqual(legacySharedResult.analysis.nativeRuleSets, [{ orPartIndexes: [], andPartIndexes: [[0], [0], [0], [0]], categoryPartIndex: 0 }]);
assert.equal(legacySharedResult.analysis.deterministicClassifications.length, 210);
assert.ok(legacySharedResult.analysis.deterministicClassifications.every((row) =>
  row.proposedCategoryId === category.id && row.proposedCategoryName === category.name &&
  row.ruleSetIndex === 0 && !Object.hasOwn(row, 'ruleIds')));
const reversedLegacySnapshot = structuredClone(legacySharedSnapshot);
reversedLegacySnapshot.transactions.reverse();
reversedLegacySnapshot.payees.reverse();
reversedLegacySnapshot.rules.reverse();
const reversedLegacyResult = call('analyzeDeterministic', {
  snapshot: reversedLegacySnapshot, options: { includePending: false, includeCleared: true, maxResults: 1 },
});
assert.deepEqual(reversedLegacyResult.analysis.nativeRuleSets, legacySharedResult.analysis.nativeRuleSets);
assert.deepEqual(reversedLegacyResult.analysis.nativeRuleBlocks, legacySharedResult.analysis.nativeRuleBlocks);
assert.deepEqual(reversedLegacyResult.analysis.nativeRuleParts, legacySharedResult.analysis.nativeRuleParts);
assert.deepEqual(reversedLegacyResult.analysis.deterministicClassifications, legacySharedResult.analysis.deterministicClassifications);
const legacyWire = JSON.stringify(legacySharedResult.analysis);
for (const id of completeRuntimeRuleIds) assert.equal(legacyWire.split(JSON.stringify(id)).length - 1, 1);
compactMerchant.rules.push({
  ...pagedMerchant.rules[0], id: 'runtime-unmatched-payee-rule',
});
const equalContentMerchant = call('analyzeMerchantIntelligence', compactMerchant);
assert.equal(equalContentMerchant.nativeRuleSets.length, 1);
assert.deepEqual(nativeSetIds(equalContentMerchant, equalContentMerchant.nativeRuleSets[0]), completeRuntimeRuleIds);
assert.deepEqual(equalContentMerchant.nativeRuleClassifications, compactResult.nativeRuleClassifications);
legacySharedSnapshot.rules.push({
  ...legacySharedSnapshot.rules[0], id: 'legacy-unmatched-payee-rule',
  trigger: { stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'not-a-matching-payee' }] },
});
const equalContentLegacy = call('analyzeDeterministic', {
  snapshot: legacySharedSnapshot, options: { includePending: false, includeCleared: true, maxResults: 1 },
});
assert.equal(equalContentLegacy.analysis.nativeRuleSets.length, 1);
assert.deepEqual(nativeSetIds(equalContentLegacy.analysis, equalContentLegacy.analysis.nativeRuleSets[0]), completeRuntimeRuleIds);
assert.deepEqual(equalContentLegacy.analysis.deterministicClassifications, legacySharedResult.analysis.deterministicClassifications);
pagedMerchant.rules = [];
const historyAdvice = call('analyzeMerchantIntelligence', pagedMerchant);
assert.deepEqual(historyAdvice.suggestions[0].ruleCandidates, [{
  payeeId: 'payee-market', categoryId: 'category-food', supportCount: 10,
  consistencyNumerator: 10, consistencyDenominator: 10,
}]);
throwsWithoutPayload(
  'analyzeMerchantIntelligence',
  {
    ...merchant.request,
    sourceAdmission: {
      ...merchant.request.sourceAdmission,
      collections: { ...merchant.request.sourceAdmission.collections, transactions: privateMarker },
    },
  },
  /merchant_analysis_failed/,
);
throwsWithoutPayload(
  'analyzeMerchantIntelligence',
  { ...merchant.request, extra: privateMarker },
  /merchant_analysis_failed/,
);
throwsWithoutPayload(
  'analyzeMerchantIntelligence',
  {
    ...merchant.request,
    transactions: merchant.request.transactions.map((source) => ({
      ...source,
      importedPayee: { state: 'unsupported', value: privateMarker },
    })),
  },
  /merchant_analysis_failed/,
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

// Real wire results factor unequal overlapping sets in both native producers.
const overlapCommonIds = Array.from({ length: 64 }, (_, index) => `runtime-overlap-common-${String(index).padStart(3, '0')}`);
const overlapRules = [
  ...overlapCommonIds.map((id) => ({
    id, name: id, order: 1, inactive: false,
    trigger: { stage: null, conditionsOp: 'and', conditions: [
      { field: 'account', op: 'is', value: 'account-checking' },
      { field: 'category', op: 'is', value: null },
    ] },
    actions: [{ field: 'category', op: 'set', value: 'category-bills' }],
  })),
  ...Array.from({ length: 48 }, (_, index) => ({
    id: `runtime-overlap-private-${String(index).padStart(3, '0')}`, name: 'Private payee rule', order: 1, inactive: false,
    trigger: { stage: null, conditionsOp: 'and', conditions: [
      { field: 'payee', op: 'is', value: `runtime-overlap-payee-${index}` },
    ] },
    actions: [{ field: 'category', op: 'set', value: 'category-bills' }],
  })),
];
const overlapMerchant = structuredClone(merchant.request);
overlapMerchant.rules = structuredClone(overlapRules);
overlapMerchant.maxEvidence = 1;
overlapMerchant.transactions = Array.from({ length: 240 }, (_, index) => ({
  ...merchantRow(`runtime-overlap-tx-${String(index).padStart(3, '0')}`, '2024-03-31'),
  payeeId: `runtime-overlap-payee-${index % 48}`, payeeName: `Overlap merchant ${index % 48}`,
}));
overlapMerchant.payees = Array.from({ length: 48 }, (_, index) => ({
  id: `runtime-overlap-payee-${index}`, name: `Overlap merchant ${index}`, transferAccountId: null, mtid: null,
}));
overlapMerchant.sourceAdmission.originalTransactionCount = 240;
overlapMerchant.suggestionSelection = { transactionIds: [], cursor: null, limit: 1 };
const overlapWire = native.analyzeMerchantIntelligence(JSON.stringify(overlapMerchant));
const overlapResult = JSON.parse(overlapWire);
function nativeSetIds(result, set) {
  const union = (references) => new Set(references.flatMap((index) => result.nativeRuleParts[index].blockIndexes));
  const matched = union(set.orPartIndexes);
  if (set.andPartIndexes.length) {
    assert.equal(set.andPartIndexes.length, 4);
    const operands = set.andPartIndexes.map(union);
    for (const block of operands[0]) if (operands.every((operand) => operand.has(block))) matched.add(block);
  }
  const category = union([set.categoryPartIndex]);
  return [...matched].filter((block) => category.has(block))
    .flatMap((block) => result.nativeRuleBlocks[block].ruleIds).sort();
}
function assertCompleteOverlap(result, rows, targetCategory) {
  assert.equal(result.nativeRuleBlocks.length, 49);
  assert.equal(result.nativeRuleSets.length, 48);
  assert.equal(result.nativeRuleBlocks.reduce((count, block) => count + block.ruleIds.length, 0), 112);
  assert.equal(new Set(result.nativeRuleBlocks.flatMap((block) => block.ruleIds)).size, 112);
  assert.equal(result.nativeRuleBlocks.filter((block) => JSON.stringify(block.ruleIds) === JSON.stringify(overlapCommonIds)).length, 1);
  assert.equal(rows.length, 240);
  for (const row of rows) {
    assert.equal(row.categoryId ?? row.proposedCategoryId, targetCategory);
    assert.ok(!Object.hasOwn(row, 'ruleIds'));
    const set = result.nativeRuleSets[row.ruleSetIndex];
    assert.ok(!Object.hasOwn(set, 'ruleIds'));
    assert.ok(set.orPartIndexes.length + set.andPartIndexes.flat().length + 1 <= 13);
    const complete = nativeSetIds(result, set);
    const transactionIndex = Number(row.transactionId.slice(-3));
    assert.deepEqual(complete, [...overlapCommonIds, `runtime-overlap-private-${String(transactionIndex % 48).padStart(3, '0')}`]);
  }
}
assertCompleteOverlap(overlapResult, overlapResult.nativeRuleClassifications, 'category-bills');
for (const id of overlapResult.nativeRuleBlocks.flatMap((block) => block.ruleIds))
  assert.equal(overlapWire.split(JSON.stringify(id)).length - 1, 1);
overlapMerchant.suggestionSelection = {
  transactionIds: overlapMerchant.transactions.map((row) => row.id), cursor: null, limit: 200,
};
const overlapFirstPage = call('analyzeMerchantIntelligence', overlapMerchant);
assert.equal(overlapFirstPage.suggestions.length, 200);
overlapMerchant.suggestionSelection.cursor = overlapFirstPage.suggestionPage.nextCursor;
const overlapNextPage = call('analyzeMerchantIntelligence', overlapMerchant);
assert.equal(overlapNextPage.suggestions.length, 40);
overlapMerchant.transactions.reverse(); overlapMerchant.payees.reverse(); overlapMerchant.rules.reverse();
const overlapReordered = call('analyzeMerchantIntelligence', overlapMerchant);
for (const page of [overlapFirstPage, overlapNextPage, overlapReordered]) {
  for (const field of ['nativeRuleBlocks', 'nativeRuleParts', 'nativeRuleSets', 'nativeRuleClassifications'])
    assert.deepEqual(page[field], overlapResult[field]);
}
const overlapLegacySnapshot = structuredClone(snapshot);
overlapLegacySnapshot.payees = structuredClone(overlapMerchant.payees);
overlapLegacySnapshot.transactions = Array.from({ length: 240 }, (_, index) => ({
  ...structuredClone(transaction), id: `legacy-overlap-tx-${String(index).padStart(3, '0')}`,
  importedId: null, cleared: true, payeeId: `runtime-overlap-payee-${index % 48}`, payeeName: `Overlap merchant ${index % 48}`,
}));
overlapLegacySnapshot.rules = overlapRules.map((rule) => ({
  ...structuredClone(rule),
  trigger: {
    ...rule.trigger,
    conditions: rule.trigger.conditions.map((condition) =>
      condition.field === 'account' ? { ...condition, value: transaction.accountId } : { ...condition }),
  },
  actions: [{ field: 'category', op: 'set', value: category.id }],
}));
const overlapLegacy = call('analyzeDeterministic', {
  snapshot: overlapLegacySnapshot, options: { includePending: false, includeCleared: true, maxResults: 1 },
});
assertCompleteOverlap(overlapLegacy.analysis, overlapLegacy.analysis.deterministicClassifications, category.id);
const overlapLegacyWire = JSON.stringify(overlapLegacy.analysis);
for (const id of overlapLegacy.analysis.nativeRuleBlocks.flatMap((block) => block.ruleIds))
  assert.equal(overlapLegacyWire.split(JSON.stringify(id)).length - 1, 1);
overlapLegacySnapshot.transactions.reverse(); overlapLegacySnapshot.payees.reverse(); overlapLegacySnapshot.rules.reverse();
const overlapLegacyReordered = call('analyzeDeterministic', {
  snapshot: overlapLegacySnapshot, options: { includePending: false, includeCleared: true, maxResults: 1 },
});
for (const field of ['nativeRuleBlocks', 'nativeRuleParts', 'nativeRuleSets', 'deterministicClassifications'])
  assert.deepEqual(overlapLegacyReordered.analysis[field], overlapLegacy.analysis[field]);
// Distinct OR predicates sharing an account route retain literal source parts,
// rather than one expanded common-plus-private list for every result.
const postingMerchant = structuredClone(overlapMerchant);
const postingCommonIds = overlapCommonIds.slice(0, 32);
postingMerchant.rules = [
  ...postingCommonIds.map((id, index) => ({
    ...overlapRules[0], id,
    trigger: { stage: null, conditionsOp: 'or', conditions: [
      { field: 'account', op: 'is', value: 'account-checking' },
      { field: 'payee', op: 'is', value: `runtime-overlap-payee-${index}` },
    ] },
  })),
  ...overlapRules.slice(64),
];
postingMerchant.suggestionSelection = { transactionIds: [], cursor: null, limit: 1 };
const postingWire = native.analyzeMerchantIntelligence(JSON.stringify(postingMerchant));
const postingResult = JSON.parse(postingWire);
assert.equal(postingResult.nativeRuleBlocks.length, 80);
assert.equal(postingResult.nativeRuleSets.length, 48);
assert.ok(postingResult.nativeRuleParts.length <= 13 * postingResult.nativeRuleSets.length);
assert.ok(postingResult.nativeRuleParts.reduce((count, part) => count + part.blockIndexes.length, 0) <= 4 * 80);
assert.equal(postingResult.nativeRuleParts.filter((part) =>
  JSON.stringify(part.blockIndexes.flatMap((index) => postingResult.nativeRuleBlocks[index].ruleIds).sort())
    === JSON.stringify(postingCommonIds)).length, 1);
for (const row of postingResult.nativeRuleClassifications) {
  const index = Number(row.transactionId.slice(-3));
  assert.deepEqual(nativeSetIds(postingResult, postingResult.nativeRuleSets[row.ruleSetIndex]),
    [...postingCommonIds, `runtime-overlap-private-${String(index % 48).padStart(3, '0')}`]);
}
for (const id of postingResult.nativeRuleBlocks.flatMap((block) => block.ruleIds))
  assert.equal(postingWire.split(JSON.stringify(id)).length - 1, 1);
const longLegacy = structuredClone(legacySharedSnapshot);
longLegacy.rules = [{ ...legacySharedSnapshot.rules[0], id: 'x'.repeat(300) }];
const longLegacyResult = call('analyzeDeterministic', {
  snapshot: longLegacy, options: { includePending: false, includeCleared: true, maxResults: 1 },
});
assert.equal(longLegacyResult.analysis.deterministicClassifications.length, 210);
assert.deepEqual(nativeSetIds(longLegacyResult.analysis, longLegacyResult.analysis.nativeRuleSets[0]), ['x'.repeat(300)]);
console.log('native public JSON boundary contracts passed');
