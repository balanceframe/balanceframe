import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { merchantAnalysisRequestSchema, merchantAnalysisResultSchema } from '../../packages/protocol-generated/src/merchant-validators.ts';

const TIERS = new Set(['confirmed', 'deterministic_match', 'inferred', 'insufficient_data', 'conflicting']);
const FREQUENCIES = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'multiple', 'irregular']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const ratio = (numerator, denominator) => ({ numerator, denominator, percent: denominator ? numerator * 100 / denominator : null });
const id = (value) => typeof value === 'string' && value.length > 0;
const nullableId = (value) => value === null || id(value);
const recurrenceKey = (requestId, row) => JSON.stringify([requestId, row.accountId, row.payeeId, row.currency,
  row.direction === 'outflow' ? 'outgoing' : row.direction === 'inflow' ? 'incoming' : row.direction]);

function exclusionReason(tx, request) {
  const year = Number(request.asOfDate.slice(0, 4)) - request.horizonYears;
  const month = Number(request.asOfDate.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = `${String(year).padStart(4, '0')}-${request.asOfDate.slice(5, 7)}-${String(Math.min(Number(request.asOfDate.slice(8)), lastDay)).padStart(2, '0')}`;
  if (tx.deleted) return 'deleted';
  if (tx.pending) return 'pending';
  if (!tx.cleared) return 'uncleared';
  if (tx.isSplitParent) return 'split_parent';
  if (tx.startingBalance) return 'starting_balance';
  if (tx.date < start) return 'outside_horizon';
  if (tx.date > request.asOfDate) return 'future_transaction';
  if (tx.transferAccountId !== null || request.payees.some((payee) => payee.id === tx.payeeId && payee.transferAccountId !== null)) return 'transfer';
  return null;
}

function validateCorpus(corpus) {
  assert(corpus?.schemaVersion === '1' && corpus.provenance?.kind === 'synthetic', 'Synthetic corpus provenance required');
  assert(Number.isSafeInteger(corpus.provenance.seed) && Array.isArray(corpus.provenance.limitations), 'Invalid corpus provenance');
  assert(Array.isArray(corpus.merchantCatalog) && Array.isArray(corpus.requests), 'Corpus collections required');
  const merchants = new Set();
  for (const merchant of corpus.merchantCatalog) {
    assert(id(merchant.id) && id(merchant.name) && !merchants.has(merchant.id), 'Invalid or duplicate merchant catalog');
    merchants.add(merchant.id);
  }
  const requestIds = new Set(), labels = [], recurrenceLabels = new Map(), labelIds = new Set();
  const requests = corpus.requests.map((entry) => {
    assert(id(entry.id) && !requestIds.has(entry.id), 'Invalid or duplicate request ID');
    requestIds.add(entry.id);
    assert(['categorization', 'recurrence', 'boundary'].includes(entry.kind), 'Invalid request kind');
    const request = merchantAnalysisRequestSchema.parse(entry.request);
    assert.equal(request.sourceAdmission.truncatedCount, 0, 'Capped source corpus refuses quality evaluation');
    assert.equal(request.sourceAdmission.originalTransactionCount, request.transactions.length, 'Source rows missing/censored');
    assert(Array.isArray(entry.labels) && Array.isArray(entry.trainingIds) && Array.isArray(entry.recurrenceLabels), 'Label/training collections required');
    const transactions = new Map();
    for (const tx of request.transactions) {
      assert(!transactions.has(tx.id), 'Duplicate source transaction ID');
      transactions.set(tx.id, tx);
    }
    const categories = new Set(request.categories.filter((category) => !category.deleted).map((category) => category.id));
    const training = new Set(entry.trainingIds);
    assert(training.size === entry.trainingIds.length && [...training].every((value) => id(value) && transactions.has(value)), 'Invalid training source IDs');
    for (const label of entry.labels) {
      assert(id(label.transactionId) && !labelIds.has(label.transactionId), 'Invalid or duplicate label transaction ID');
      labelIds.add(label.transactionId);
      const tx = transactions.get(label.transactionId);
      assert(tx && !training.has(label.transactionId), 'Label missing source or training leakage');
      assert(nullableId(label.merchantId) && (label.merchantId === null || merchants.has(label.merchantId)), 'Label merchant absent from catalog');
      assert(nullableId(label.categoryId) && (label.categoryId === null || categories.has(label.categoryId)), 'Invalid label category');
      assert(['suggest', 'abstain'].includes(label.expected) && Array.isArray(label.tags) && label.tags.every(id)
        && new Set(label.tags).size === label.tags.length, 'Invalid label expectation/tags');
      assert(nullableId(label.overrideCategoryId) && (label.overrideCategoryId === null || categories.has(label.overrideCategoryId)), 'Invalid label override');
      assert(label.expected === 'suggest' ? label.categoryId !== null && label.merchantId !== null : label.categoryId === null, 'Invalid label truth');
      assert(label.overrideCategoryId === null || label.overrideCategoryId === label.categoryId && label.expected === 'suggest', 'Invalid override label truth');
      if (label.overrideCategoryId === null) assert(tx.categoryId === null, 'Heldout label has categorized source');
      else {
        const correction = request.corrections.some((row) => row.transactionId === tx.id && row.categoryId === label.overrideCategoryId && row.state === 'confirmed' && row.verified);
        const rule = request.rules.some((row) => !row.inactive && Array.isArray(row.actions)
          && row.actions.some((action) => action.field === 'category' && action.value === label.overrideCategoryId));
        assert(tx.categoryId === label.overrideCategoryId || correction || rule, 'Override label missing authoritative source');
      }
      const excludedReason = exclusionReason(tx, request);
      assert(!excludedReason || label.expected === 'abstain', 'Ineligible source must have abstention label');
      labels.push({ ...label, requestId: entry.id, kind: entry.kind, tx, excludedReason });
    }
    for (const label of entry.recurrenceLabels) {
      assert(id(label.accountId) && id(label.payeeId) && merchants.has(label.payeeId) && /^[A-Z]{3}$/.test(label.currency)
        && ['outgoing', 'incoming'].includes(label.direction) && typeof label.established === 'boolean'
        && (label.frequency === null || FREQUENCIES.has(label.frequency)) && (!label.established || label.frequency !== null && label.frequency !== 'irregular'), 'Invalid recurrence label');
      const key = recurrenceKey(entry.id, label);
      assert(!recurrenceLabels.has(key), 'Duplicate recurrence label');
      recurrenceLabels.set(key, label);
    }
    return { ...entry, request, transactions };
  });
  return { requests, labels, recurrenceLabels, merchants };
}

function indexPredictions(rows, data) {
  assert(Array.isArray(rows), 'Prediction collection must be an array');
  const labels = new Map(data.labels.map((label) => [label.transactionId, label])), indexed = new Map();
  for (const row of rows) {
    const label = labels.get(row?.transactionId);
    assert(label, 'Unknown prediction transaction ID');
    assert(!label.excludedReason, 'Prediction supplied for source-ineligible/excluded label');
    assert(!indexed.has(row.transactionId), 'Duplicate prediction transaction ID');
    assert(nullableId(row.categoryId) && nullableId(row.payeeId) && TIERS.has(row.tier), 'Invalid prediction fields');
    const request = data.requests.find((entry) => entry.id === label.requestId).request;
    assert(row.categoryId === null || request.categories.some((category) => category.id === row.categoryId && !category.deleted), 'Unknown prediction category');
    assert(row.payeeId === null || request.payees.some((payee) => payee.id === row.payeeId), 'Unknown prediction merchant');
    indexed.set(row.transactionId, row);
  }
  assert(indexed.size === data.labels.filter((label) => !label.excludedReason).length, 'Missing predictions; complete eligible output required');
  return indexed;
}

function score(labels, predictions) {
  let inferred = 0, inferredCorrect = 0, all = 0, allCorrect = 0, sparse = 0, sparseCorrect = 0;
  let resolved = 0, falseAliases = 0, abstained = 0, overrideDenominator = 0, overrideViolations = 0, requiredAbstentionViolations = 0;
  const tiers = Object.fromEntries([...TIERS].map((tier) => [tier, { rows: 0, suggested: 0, correct: 0 }]));
  const eligible = labels.filter((label) => !label.excludedReason);
  for (const label of eligible) {
    const row = predictions.get(label.transactionId), suggested = row.categoryId !== null;
    const correct = suggested && label.expected === 'suggest' && row.categoryId === label.categoryId && row.payeeId === label.merchantId;
    tiers[row.tier].rows++;
    if (suggested) { all++; tiers[row.tier].suggested++; if (correct) { allCorrect++; tiers[row.tier].correct++; } }
    else abstained++;
    if (row.payeeId !== null) { resolved++; if (row.payeeId !== label.merchantId) falseAliases++; }
    if (label.expected === 'abstain' && suggested) requiredAbstentionViolations++;
    if (label.overrideCategoryId !== null) {
      overrideDenominator++;
      if (row.categoryId !== label.overrideCategoryId) overrideViolations++;
    } else {
      if (suggested && row.tier === 'inferred') { inferred++; if (correct) inferredCorrect++; }
      if (label.tags.includes('sparse')) { sparse++; if (correct) sparseCorrect++; }
    }
  }
  return { inferredPrecision: ratio(inferredCorrect, inferred), allTierPrecision: ratio(allCorrect, all),
    sparseCoverage: ratio(sparseCorrect, sparse), falseAlias: ratio(falseAliases, resolved),
    abstention: ratio(abstained, eligible.length), overrideDenominator, overrideViolations, requiredAbstentionViolations, tiers };
}

function scoreRecurrences(data, rows) {
  assert(Array.isArray(rows), 'Recurrence output collection required');
  const indexed = new Map();
  for (const row of rows) {
    assert(id(row?.requestId) && ['inflow', 'outflow', 'zero', 'incoming', 'outgoing'].includes(row.direction)
      && TIERS.has(row.tier) && FREQUENCIES.has(row.frequency) && Number.isInteger(row.occurrences) && row.occurrences >= 0, 'Invalid recurrence output');
    let key = recurrenceKey(row.requestId, row);
    // Zero-value observations have no economic direction or established cadence.
    if (row.direction === 'zero') {
      const possible = [...data.recurrenceLabels].filter(([, label]) => label.accountId === row.accountId && label.payeeId === row.payeeId
        && label.currency === row.currency && label.frequency === null).filter(([candidate]) => JSON.parse(candidate)[0] === row.requestId);
      assert(possible.length === 1 && row.tier === 'insufficient_data', 'Unknown or established zero recurrence output');
      key = possible[0][0];
    }
    assert(data.recurrenceLabels.has(key), 'Unknown recurrence output partition');
    assert(!indexed.has(key), 'Duplicate recurrence output partition');
    indexed.set(key, row);
  }
  let establishedDenominator = 0, establishedCorrect = 0, negativeDenominator = 0, falsePositives = 0;
  let provisionalDenominator = 0, provisionalCorrect = 0, establishedClaims = 0;
  for (const [key, label] of data.recurrenceLabels) {
    const row = indexed.get(key);
    const established = row && row.direction !== 'zero' && !['irregular', 'multiple'].includes(row.frequency)
      && ['inferred', 'confirmed'].includes(row.tier);
    if (established) establishedClaims++;
    if (label.established) {
      establishedDenominator++;
      if (established && row.frequency === label.frequency) establishedCorrect++;
    } else {
      negativeDenominator++;
      if (established) falsePositives++;
      if (label.frequency !== null && label.frequency !== 'irregular') {
        provisionalDenominator++;
        if (row && !established && row.tier === 'insufficient_data' && row.frequency === label.frequency) provisionalCorrect++;
      }
    }
  }
  return { labeledPartitions: data.recurrenceLabels.size, returnedProfiles: rows.length, establishedClaims,
    establishedDenominator, establishedCorrect, establishedMisses: establishedDenominator - establishedCorrect,
    negativeDenominator, falsePositives, provisionalDenominator, provisionalCorrect,
    provisionalMisses: provisionalDenominator - provisionalCorrect,
    establishedRecall: ratio(establishedCorrect, establishedDenominator), falsePositiveRate: ratio(falsePositives, negativeDenominator) };
}

export function evaluatePredictions(corpus, currentPredictions, baselinePredictions, currentRecurrences = []) {
  const data = validateCorpus(corpus);
  const currentIndex = indexPredictions(currentPredictions, data), baselineIndex = indexPredictions(baselinePredictions, data);
  const current = score(data.labels, currentIndex), baseline = score(data.labels, baselineIndex);
  const sparseCoverageDeltaPp = current.sparseCoverage.percent === null || baseline.sparseCoverage.percent === null
    ? null : current.sparseCoverage.percent - baseline.sparseCoverage.percent;
  const strata = {};
  for (const tag of [...new Set(data.labels.flatMap((label) => label.tags))].sort()) {
    const labels = data.labels.filter((label) => label.tags.includes(tag));
    strata[tag] = { count: labels.length, current: score(labels, currentIndex), baseline: score(labels, baselineIndex) };
  }
  const gate = (proven, passes) => !proven ? 'UNPROVEN' : passes ? 'PASS' : 'FAIL';
  const sourceComplete = data.requests.every(({ request }) => request.sourceAdmission.truncatedCount === 0
    && request.sourceAdmission.originalTransactionCount === request.transactions.length
    && Object.values(request.sourceAdmission.collections).every((state) => state === 'complete')
    && request.sourceAdmission.accountCoverage.every((account) => account.state === 'complete' && account.currencyState === 'known'));
  const gates = {
    inferredPrecision: gate(current.inferredPrecision.denominator > 0, current.inferredPrecision.percent >= 95),
    noPrecisionRegression: gate(current.allTierPrecision.denominator > 0 && baseline.allTierPrecision.denominator > 0,
      current.allTierPrecision.percent >= baseline.allTierPrecision.percent),
    sparseCoverageImprovement: gate(sparseCoverageDeltaPp !== null, sparseCoverageDeltaPp >= 10),
    explicitOverrides: gate(current.overrideDenominator > 0, current.overrideViolations === 0),
    sourceCompleteness: gate(sourceComplete, true),
  };
  return { evidenceKind: 'synthetic', realWorldAccuracyEstablished: false, authorizationPrivacyMeasured: false,
    provenance: corpus.provenance, thresholds: { inferredPrecisionPercent: 95, sparseCoverageImprovementPp: 10, explicitOverrideViolations: 0 },
    status: Object.values(gates).includes('FAIL') ? 'FAIL' : Object.values(gates).includes('UNPROVEN') ? 'UNPROVEN' : 'PASS',
    precisionRegressionMetric: 'all_structured_category_suggestions',
    gates, current, baseline, sparseCoverageDeltaPp, strata, recurrence: scoreRecurrences(data, currentRecurrences),
    source: { requestCount: data.requests.length, transactionCount: data.requests.reduce((sum, entry) => sum + entry.request.transactions.length, 0),
      heldoutCount: data.labels.length, eligibleHeldoutCount: current.abstention.denominator,
      ineligibleHeldoutCount: data.labels.length - current.abstention.denominator, complete: sourceComplete,
      exclusions: data.labels.filter((label) => label.excludedReason).map((label) => ({ transactionId: label.transactionId, reason: label.excludedReason })) } };
}

const legacySpecimen = JSON.parse(readFileSync(new URL('../../protocol/fixtures/representative.json', import.meta.url), 'utf8'));

function legacySnapshot(request) {
  const categories = new Map(request.categories.map((row) => [row.id, row.name]));
  const omitted = [], rows = new Map();
  for (const tx of request.transactions) {
    // Legacy Transaction has no deleted/pending/opening flags; never reinterpret these as ordinary rows.
    if (tx.deleted || tx.pending || tx.startingBalance) {
      omitted.push({ transactionId: tx.id, deleted: tx.deleted, pending: tx.pending, startingBalance: tx.startingBalance });
      continue;
    }
    rows.set(tx.id, { id: tx.id, accountId: tx.accountId, date: tx.date, payeeId: tx.payeeId, payeeName: tx.payeeName,
      categoryId: tx.categoryId, categoryName: categories.get(tx.categoryId) ?? null, amount: tx.amount,
      cleared: tx.cleared, reconciled: tx.reconciled, importedId: tx.importedId, importedPayee: tx.importedPayee.value,
      notes: tx.notes.value, tags: [], transferAccountId: tx.transferAccountId, subtransactions: [] });
  }
  const transactions = [];
  for (const tx of request.transactions) {
    const row = rows.get(tx.id);
    if (!row) continue;
    if (tx.isSplitChild) {
      const parent = rows.get(tx.parentId);
      assert(parent && !request.transactions.find((candidate) => candidate.id === tx.parentId).isSplitChild, 'Unrepresentable legacy split source');
      parent.subtransactions.push(row);
    } else transactions.push(row);
  }
  const accounts = request.sourceAdmission.sourceAccountIds.map((accountId) => {
    const currency = request.transactions.find((row) => row.accountId === accountId)?.amount.currency ?? 'USD';
    return { id: accountId, name: accountId, accountType: 'checking', offBudget: false, isClosed: false,
      clearedBalance: { minorUnits: '0', currency }, importedBalance: { minorUnits: '0', currency }, mtid: null };
  });
  return { snapshot: { schemaVersion: '1', actualVersion: legacySpecimen.actualVersion, snapshotDate: `${request.asOfDate}T00:00:00Z`,
    accounts, transactions, categories: request.categories, payees: request.payees, rules: request.rules, schedules: [], budgets: [], tags: [] },
  omitted, fieldAvailability: request.transactions.map((tx) => ({ transactionId: tx.id,
    importedPayee: tx.importedPayee.state, notes: tx.notes.state, description: tx.description.state, verboseTitle: tx.verboseTitle.state,
    occurrenceComplete: tx.occurrenceComplete, occurrenceId: tx.occurrenceId })),
  limitations: ['Legacy source excludes deleted/pending/opening rows before engine invocation; this does not prove baseline boundary abstention.',
    'Account catalog metadata and Actual version are synthetic defaults from representative.json, not measured connector facts.',
    'Legacy format cannot represent description/verboseTitle capabilities, occurrence completeness, typed schedules, aliases, corrections or pattern decisions.',
    'Legacy exact/historical reason text is not a structured category suggestion; no category or evidence tier is promoted from prose.'] };
}

function baselineRows(response, entry, mapped) {
  assert(response?.schemaVersion === '1' && response.requestId === `quality:${entry.id}`, 'Unknown baseline response identity');
  assert(response.status === 'ok' && response.error === null
    || response.status === 'error' && response.error?.code === 'analysis_error', 'Unknown baseline native status/error');
  assert(Array.isArray(response.reasonCodes) && !response.reasonCodes.includes('unsupported_schema_version'), 'Unknown baseline protocol/diagnostics');
  for (const field of ['deterministicClassifications', 'repeatedMerchants', 'ruleCandidates', 'duplicateEvidence', 'recurringCharges', 'historicalCorrections', 'blockers']) {
    assert(Array.isArray(response.analysis?.[field]), `Missing baseline ${field} collection`);
  }
  assert(response.coverage && Number.isInteger(response.coverage.totalTransactions), 'Missing baseline source coverage');
  const scoped = mapped.snapshot.transactions.filter((tx) => tx.cleared && tx.transferAccountId === null);
  assert.equal(response.coverage.totalTransactions, scoped.length, 'Baseline source coverage incomplete/censored');
  assert(Array.isArray(response.analysis.uncategorizedBacklog?.transactionIds), 'Missing baseline backlog collection');
  const backlogIds = scoped.filter((tx) => tx.categoryId === null).map((tx) => tx.id).sort();
  assert.deepEqual([...response.analysis.uncategorizedBacklog.transactionIds].sort(), backlogIds, 'Incomplete/duplicate/unknown baseline source backlog');
  assert.equal(response.analysis.uncategorizedBacklog.count, backlogIds.length, 'Baseline backlog denominator mismatch');
  const source = new Map(mapped.snapshot.transactions.flatMap((tx) => [tx, ...tx.subtransactions]).map((tx) => [tx.id, tx]));
  const indexed = new Map();
  for (const row of response.analysis.deterministicClassifications) {
    const tx = source.get(row?.transactionId);
    assert(tx && tx.categoryId === null && !indexed.has(row.transactionId), 'Unknown/duplicate baseline classification');
    assert.deepEqual(row.amount, tx.amount, 'Baseline classification Money changed');
    assert.equal(row.date, tx.date, 'Baseline classification source date changed');
    assert(Array.isArray(row.reasons) && row.reasons.every((reason) => id(reason.kind) && typeof reason.details === 'string'), 'Unknown baseline reason shape');
    if (Object.hasOwn(row, 'proposedCategoryId')) {
      assert(id(row.proposedCategoryId) && Array.isArray(row.ruleIds) && row.ruleIds.length > 0, 'Unknown baseline category result shape');
      assert(entry.request.categories.some((category) => category.id === row.proposedCategoryId && !category.deleted), 'Unknown baseline category target');
    }
    indexed.set(row.transactionId, row);
  }
  // A complete no-model finder returns matches only; recognized absence is an unresolved result, not missing output.
  return entry.labels.filter((label) => !exclusionReason(entry.transactions.get(label.transactionId), entry.request)).map((label) => {
    const row = indexed.get(label.transactionId), tx = entry.transactions.get(label.transactionId);
    return { transactionId: label.transactionId, categoryId: row?.proposedCategoryId ?? null,
      payeeId: tx.payeeId, tier: row?.proposedCategoryId ? 'deterministic_match' : 'insufficient_data',
      reasonCodes: [row ? 'legacy_structured_category_or_unresolved_match' : 'legacy_complete_finder_no_match'],
      baselineClassificationPresent: row !== undefined };
  });
}

export function evaluateNativeCorpus(corpus, { currentNative, baselineNative }) {
  assert(typeof currentNative?.analyzeMerchantIntelligence === 'function', 'Current native analyzeMerchantIntelligence required');
  assert(typeof baselineNative?.analyzeDeterministic === 'function', 'Frozen baseline native analyzeDeterministic required');
  assert(currentNative !== baselineNative, 'Separately loaded frozen baseline addon required');
  const data = validateCorpus(corpus), current = [], baseline = [], recurrences = [], execution = [];
  for (const entry of data.requests) {
    const request = entry.request;
    assert.equal(request.sourceAdmission.truncatedCount, 0, 'Capped source corpus refuses quality evaluation');
    assert.equal(request.sourceAdmission.originalTransactionCount, request.transactions.length, 'Source rows missing/censored');
    const eligible = request.transactions.filter((tx) => !exclusionReason(tx, request));
    const selectedIds = entry.labels.map((label) => label.transactionId).sort();
    const eligibleSelected = eligible.filter((tx) => selectedIds.includes(tx.id)).map((tx) => tx.id).sort();
    const dates = eligible.map((tx) => tx.date).sort();
    let cursor = null, offset = 0, pages = 0, first = null;
    do {
      const input = { ...request, suggestionSelection: { transactionIds: selectedIds, cursor, limit: 200 } };
      const result = merchantAnalysisResultSchema.parse(JSON.parse(currentNative.analyzeMerchantIntelligence(JSON.stringify(input))));
      assert.deepEqual(result.scope, request.scope); assert.deepEqual(result.sourceAdmission, request.sourceAdmission);
      assert.equal(result.snapshotId, request.snapshotId); assert.equal(result.normalizationVersion, request.normalizationVersion);
      assert.equal(result.coverage.inputCount, request.transactions.length);
      assert.equal(result.coverage.eligibleCount, eligible.length);
      assert.equal(result.coverage.excludedCount, request.transactions.length - eligible.length);
      assert.equal(result.coverage.startDate, dates[0] ?? null); assert.equal(result.coverage.endDate, dates.at(-1) ?? null);
      assert(!result.coverage.limited, 'Current output source limited/censored');
      const expected = eligibleSelected.slice(offset, offset + 200);
      assert.deepEqual(result.suggestions.map((row) => row.transactionId), expected, 'Missing/duplicate/unknown current selected output');
      for (const row of result.suggestions) assert.equal(row.accountId, entry.transactions.get(row.transactionId)?.accountId, 'Current prediction source account changed');
      const admittedRuleIds = new Set(request.rules.filter((rule) => !rule.inactive).map((rule) => rule.id));
      const admittedCategoryIds = new Set(request.categories.filter((category) => !category.deleted).map((category) => category.id));
      for (const block of result.nativeRuleBlocks) {
        assert(block.ruleIds.every((id) => admittedRuleIds.has(id)), 'Current native provenance crosses rule namespace');
      }
      for (const row of result.nativeRuleClassifications) {
        const source = entry.transactions.get(row.transactionId);
        assert(source && source.categoryId === null && source.accountId === row.accountId
          && !exclusionReason(source, request) && admittedCategoryIds.has(row.categoryId), 'Invalid current native classification source');
      }
      const nextCursor = offset + expected.length < eligibleSelected.length ? expected.at(-1) : null;
      assert.deepEqual(result.suggestionPage, { eligibleCandidates: eligibleSelected.length, returned: expected.length, nextCursor }, 'Incomplete/capped suggestion page');
      if (first) {
        assert.deepEqual(result.coverage, first.coverage);
        assert.deepEqual(result.recurrences, first.recurrences, 'Recurrence history changed between pages');
        assert.deepEqual(result.nativeRuleClassifications, first.nativeRuleClassifications);
        assert.deepEqual(result.nativeRuleSets, first.nativeRuleSets, 'Native rule provenance changed between pages');
        assert.deepEqual(result.nativeRuleBlocks, first.nativeRuleBlocks, 'Native rule blocks changed between pages');
        assert.deepEqual(result.nativeRuleParts, first.nativeRuleParts, 'Native rule parts changed between pages');
      } else first = result;
      current.push(...result.suggestions); offset += expected.length; cursor = nextCursor; pages++;
    } while (cursor !== null);
    if (entry.recurrenceLabels.length) recurrences.push(...first.recurrences.map((row) => ({ ...row, requestId: entry.id })));
    const mapped = legacySnapshot(request);
    const legacyInput = { snapshot: mapped.snapshot, options: { includePending: false, includeCleared: true, maxResults: null },
      requestId: `quality:${entry.id}`, actorId: null };
    const old = JSON.parse(baselineNative.analyzeDeterministic(JSON.stringify(legacyInput)));
    baseline.push(...baselineRows(old, entry, mapped));
    execution.push({ requestId: entry.id, kind: entry.kind, inputCount: request.transactions.length,
      trainingCount: entry.trainingIds.length, selectedCount: selectedIds.length, eligibleSelectedCount: eligibleSelected.length,
      outputCount: offset, pages, coverage: first.coverage, sourceAdmission: request.sourceAdmission,
      unscoredRecurrenceCount: entry.recurrenceLabels.length ? 0 : first.recurrences.length,
      baselineClassificationCount: old.analysis.deterministicClassifications.length, baselineCoverage: old.coverage,
      baselineStatus: old.status, baselineReasonCodes: old.reasonCodes, baselineBlockers: old.analysis.blockers,
      baselineInputSha256: sha256(JSON.stringify(legacyInput)), baselineMapping: { omitted: mapped.omitted,
        fieldAvailability: mapped.fieldAvailability, limitations: mapped.limitations } });
  }
  const metrics = evaluatePredictions(corpus, current, baseline, recurrences);
  const categoryLabels = data.labels.filter((label) => label.kind === 'categorization');
  const population = { categorizationHoldouts: categoryLabels.length,
    merchantIdentities: new Set(categoryLabels.filter((label) => label.merchantId !== null).map((label) => label.merchantId)).size };
  metrics.gates.corpusPopulation = population.categorizationHoldouts >= 1000 && population.merchantIdentities >= 100 ? 'PASS' : 'UNPROVEN';
  const baselineErrorCount = execution.filter((entry) => entry.baselineStatus !== 'ok').length;
  if (metrics.status === 'PASS' && Object.values(metrics.gates).includes('UNPROVEN')) metrics.status = 'UNPROVEN';
  return { ...metrics, execution, population,
    baselineDiagnostics: { scope: 'legacy_whole_financial_analysis', status: baselineErrorCount ? 'LIMITED' : 'CLEAN',
      requestCount: execution.length, errorCount: baselineErrorCount, classificationCoverageValidated: true },
    limits: { suggestionPageSize: 200, fullSourceHistoryRetained: true, baselineMaxResults: null },
    baselineSemantics: 'Only structured proposedCategoryId counts as a category suggestion; exact/historical narrative evidence remains unresolved.' };
}

function loadNative(filename) {
  const loaded = { exports: {} };
  process.dlopen(loaded, filename);
  return loaded.exports;
}

function cli(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    assert(['--fixture', '--current-native', '--baseline-native', '--output'].includes(flag) && id(value) && !Object.hasOwn(options, flag), 'Invalid/duplicate/missing CLI option');
    options[flag] = path.resolve(value);
  }
  for (const flag of ['--fixture', '--current-native', '--baseline-native', '--output']) assert(options[flag], `Required ${flag}`);
  assert(!['--fixture', '--current-native', '--baseline-native'].some((flag) => options[flag] === options['--output']), 'Output must not overwrite immutable inputs');
  const currentPath = realpathSync(options['--current-native']), baselinePath = realpathSync(options['--baseline-native']);
  const fixtureBytes = readFileSync(options['--fixture']), currentBytes = readFileSync(currentPath), baselineBytes = readFileSync(baselinePath);
  assert(currentPath !== baselinePath && sha256(currentBytes) !== sha256(baselineBytes), 'Current and frozen baseline addon must differ');
  const corpus = JSON.parse(fixtureBytes.toString('utf8'));
  const result = evaluateNativeCorpus(corpus, { currentNative: loadNative(currentPath), baselineNative: loadNative(baselinePath) });
  const report = { ...result, artifacts: { corpus: { path: options['--fixture'], sha256: sha256(fixtureBytes), seed: corpus.provenance.seed },
    currentAddon: { path: currentPath, sha256: sha256(currentBytes) }, baselineAddon: { path: baselinePath, sha256: sha256(baselineBytes),
      requiredRevision: '63d3df17a6f2bebae5522c09fa194657ca86b51b', revisionVerification: 'Requires external build/SHA evidence; binary origin is not verified by this harness.' } },
    environment: { node: process.version, napi: process.versions.napi, platform: process.platform, arch: process.arch, osRelease: os.release() } };
  writeFileSync(options['--output'], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, evidenceKind: report.evidenceKind, gates: report.gates, corpusSha256: report.artifacts.corpus.sha256 }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
