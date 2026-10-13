// Synthetic performance workload only: never adjudicated merchant quality or Actual SDK capture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describeSnapshot, expandSnapshot, parseArgs as baselineArgs, percentile95 } from './baseline.mjs';
import { validateNativeRuleTables } from '../../packages/protocol-generated/src/merchant-validators.ts';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '../..');
const MERCHANT_FIXTURE = path.join(ROOT, 'protocol/fixtures/merchant-intelligence.json');
const MAPPING_VERSION = 'synthetic-canonical-merchant-admission/1';
const RULE_HEAVY_MAPPING_VERSION = 'synthetic-rule-heavy-merchant-admission/1';
const WORKLOADS = Object.freeze({
  admitted: 'Unchanged canonical admission workload; no generated rules.',
  'wide-or-private-and': 'Half account/payee OR rules share the matching account; half selective payee/account AND rules.',
  'broad-account-oneof-and': 'Duplicate-pair account oneOf AND rules with 3:1 category weights; common-account conflicts and private-account single-category matches.',
  'producer-disjoint-or-and': 'Half account/category OR rules; quarter payee/other-account AND and quarter category-only AND rules, logically disjoint from uncategorized common-account rows.',
});
const MEMORY_LIMIT = 512 * 1024 * 1024;
let systemPageSize;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseArgs(args) {
  const extra = { warmups: 2, merchantFixture: MERCHANT_FIXTURE, output: null, workload: 'admitted' };
  const remaining = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--warmups', '--merchant-fixture', '--output', '--workload'].includes(flag)) { remaining.push(flag); continue; }
    const value = args[++index];
    assert(value !== undefined && value.length > 0, `Missing value for ${flag}`);
    if (flag === '--warmups') extra.warmups = baselineArgs(['--iterations', value]).iterations;
    else if (flag === '--workload') {
      assert(Object.hasOwn(WORKLOADS, value), `Unknown workload: ${value}`);
      extra.workload = value;
    }
    else extra[flag === '--output' ? 'output' : 'merchantFixture'] = path.resolve(value);
  }
  return { ...baselineArgs(remaining), ...extra };
}

function text(value) {
  return { state: value == null ? 'absent' : value === '' ? 'empty' : 'present', value: value ?? null };
}

function flatten(snapshot) {
  const transactions = [];
  function visit(source, parentId = null) {
    assert(Array.isArray(source.subtransactions), 'Canonical subtransactions required');
    const children = source.subtransactions;
    assert(!(parentId && children.length), 'Nested split parent/child cannot be mapped unambiguously');
    transactions.push({
      id: source.id, accountId: source.accountId, date: source.date, payeeId: source.payeeId,
      payeeName: source.payeeName, categoryId: source.categoryId, amount: source.amount,
      cleared: source.cleared, reconciled: source.reconciled, importedId: source.importedId,
      importedPayee: text(source.importedPayee), notes: text(source.notes),
      description: { state: 'unsupported', value: null }, verboseTitle: { state: 'unsupported', value: null },
      isSplitParent: children.length > 0, isSplitChild: parentId !== null,
      parentId, occurrenceId: parentId ?? source.id, occurrenceComplete: true,
      // Synthetic fixture has no tombstones/starting-balance flags or independent pending facts.
      // This is NOT the raw Actual capture path; pending capability remains explicitly unsupported.
      startingBalance: false, deleted: false, pending: false, transferAccountId: source.transferAccountId,
    });
    for (const child of children) visit(child, source.id);
  }
  for (const transaction of snapshot.transactions) visit(transaction);
  return transactions;
}

function admit(transactions) {
  const imports = new Map();
  const conflicting = new Set();
  for (const tx of transactions) {
    if (tx.importedId === null) continue;
    const key = JSON.stringify([tx.accountId, tx.importedId]);
    const previous = imports.get(key);
    if (previous === undefined) imports.set(key, tx);
    else {
      // Only duplicate import groups need a same-source comparison. Generated imports are unique.
      const fingerprint = (row) => JSON.stringify(row, (field, value) =>
        ['id', 'occurrenceId', 'importedId'].includes(field) ? undefined : value);
      if (fingerprint(previous) !== fingerprint(tx)) conflicting.add(key);
    }
  }
  const omitted = transactions.filter((tx) => tx.importedId !== null
    && conflicting.has(JSON.stringify([tx.accountId, tx.importedId])));
  const omittedIds = new Set(omitted.map((tx) => tx.id));
  const incomplete = new Set(omitted.map((tx) => tx.occurrenceId));
  return { transactions: transactions.filter((tx) => !omittedIds.has(tx.id)).map((tx) =>
    incomplete.has(tx.occurrenceId) ? { ...tx, occurrenceComplete: false } : tx), omitted };
}

export function buildRequest(seed, size, canonicalRequest, workload = 'admitted') {
  assert(Number.isSafeInteger(size) && size > 0 && size <= 250000, 'size must be 1..250000');
  assert(Object.hasOwn(WORKLOADS, workload), `Unknown workload: ${workload}`);
  if (workload !== 'admitted') return buildRuleHeavyRequest(seed.snapshotDate, size, canonicalRequest, workload);
  const fullSeed = admit(flatten(seed));
  let topLevelSize;
  if (size >= fullSeed.transactions.length) {
    topLevelSize = seed.transactions.length + size - fullSeed.transactions.length;
  } else {
    // Small correctness/smoke sizes keep a whole top-level occurrence, never truncate split siblings.
    for (let count = 1; count <= seed.transactions.length; count++) {
      if (admit(flatten({ ...seed, transactions: seed.transactions.slice(0, count) })).transactions.length === size) {
        topLevelSize = count; break;
      }
    }
    assert(topLevelSize !== undefined, 'Requested smoke size cannot preserve complete seed occurrences');
  }
  const snapshot = expandSnapshot(seed, topLevelSize);
  const flattened = flatten(snapshot);
  const { transactions, omitted } = admit(flattened);
  assert.equal(transactions.length, size, 'Exact admitted native workload required');
  const asOfDate = snapshot.snapshotDate.slice(0, 10);
  const startDate = `${Number(asOfDate.slice(0, 4)) - 5}${asOfDate.slice(4)}`;
  const sourceAccountIds = [...new Set(transactions.map((tx) => tx.accountId))].sort();
  const sourceCategoryIds = snapshot.categories.map((category) => category.id).sort();
  const omittedAccounts = new Set(omitted.map((tx) => tx.accountId));
  const capturedAt = `${asOfDate}T00:00:00Z`;
  const expiresAt = new Date(Date.parse(capturedAt) + 86400000).toISOString();
  const scope = { spaceId: 'space-perf-only', budgetId: 'budget-perf-only', connectionId: 'connection-perf-only' };
  const facts = { transactions, payees: snapshot.payees, categories: snapshot.categories, rules: snapshot.rules };
  assert.equal(snapshot.schedules.length, 0, 'Legacy schedule mapping is lossy; use a dedicated typed fixture');
  const request = {
    schemaVersion: canonicalRequest.schemaVersion, scope, snapshotId: `current-native-perf-${size}`,
    normalizationVersion: canonicalRequest.normalizationVersion, asOfDate,
    sourceAdmission: {
      capturedAt, expiresAt, factsHash: `sha256:${sha256(JSON.stringify(facts))}`,
      collections: { transactions: omitted.length ? 'partial' : 'complete', payees: 'complete', categories: 'complete', rules: 'complete', schedules: 'complete' },
      accountCoverage: sourceAccountIds.map((accountId) => ({ accountId,
        state: omittedAccounts.has(accountId) ? 'partial' : 'complete', startDate, endDate: asOfDate,
        currencyState: transactions.some((tx) => tx.accountId === accountId && !/^[A-Z]{3}$/.test(tx.amount.currency)) ? 'unknown' : 'known',
      })),
      pendingState: 'unsupported', originalTransactionCount: flattened.length, truncatedCount: omitted.length,
      visibilityHash: `sha256:${sha256(JSON.stringify({ scope, sourceAccountIds, sourceCategoryIds, mapping: MAPPING_VERSION }))}`,
      sourceAccountIds, sourceCategoryIds,
    },
    ...facts, aliases: [], corrections: [], schedules: [], patternDecisions: [], calendars: [],
    horizonYears: 5, maxEvidence: canonicalRequest.maxEvidence,
    suggestionSelection: { transactionIds: transactions.filter((tx) => tx.categoryId === null).map((tx) => tx.id).sort(), cursor: null, limit: 200 },
  };
  const admission = { reason: omitted.length ? 'conflicting_account_import_identity' : null,
    omittedTransactionIds: omitted.map((tx) => tx.id).sort(), invalidSourceOmittedCount: omitted.length,
    nativeCapOmittedCount: 0, originalTransactionCount: flattened.length, admittedTransactionCount: size,
    mappingVersion: MAPPING_VERSION };
  const preserved = transactions.filter((tx) => !tx.id.startsWith('perf-only-')).length;
  const description = { ...describeSnapshot({ ...snapshot, transactions }, preserved),
    preservedSeedTransactions: preserved, generatedTransactions: size - preserved, topLevelExpansionCount: topLevelSize };
  return { request, admission, description };
}

// Explicit generated stress sources, not mutations of the admitted canonical fixture or SDK captures.
function buildRuleHeavyRequest(snapshotDate, size, canonicalRequest, workload) {
  const ruleCount = Math.min(100000, 4 * size);
  const half = ruleCount / 2;
  const quarter = ruleCount / 4;
  const commonAccount = 'stress-account-common';
  const otherAccount = 'stress-account-other';
  const targetCategory = 'stress-category-target-0';
  const mixed = workload === 'broad-account-oneof-and';
  const producer = workload === 'producer-disjoint-or-and';
  const payeeCount = mixed ? Math.min(32, size) : producer ? quarter : half;
  const payees = Array.from({ length: payeeCount }, (_, index) => ({
    id: `stress-payee-${String(index).padStart(6, '0')}`, name: `Stress merchant ${String(index).padStart(6, '0')}`,
    transferAccountId: null, mtid: null,
  }));
  const sourceAccountIds = [commonAccount];
  if (producer) sourceAccountIds.push(otherAccount);
  if (mixed) for (let index = 0; index < half; index++) sourceAccountIds.push(`stress-account-private-${String(index).padStart(6, '0')}`);
  sourceAccountIds.sort();
  const categories = [{ id: targetCategory, name: 'Stress target 0', groupName: null, isIncome: false, mtid: null, deleted: false }];
  if (mixed) categories.push({ ...categories[0], id: 'stress-category-target-1', name: 'Stress target 1' });
  if (producer) {
    for (const [kind, count] of [['or', half], ['and', quarter]]) {
      for (let index = 0; index < count; index++) categories.push({ ...categories[0],
        id: `stress-category-${kind}-${String(index).padStart(6, '0')}`, name: `Stress ${kind} category ${index}` });
    }
  }
  const rules = Array.from({ length: ruleCount }, (_, index) => {
    let conditionsOp = 'and';
    let conditions;
    let categoryId = targetCategory;
    if (mixed) {
      const pair = Math.floor(index / 2);
      conditions = [{ field: 'account', op: 'oneOf',
        value: [commonAccount, `stress-account-private-${String(pair).padStart(6, '0')}`], type: 'id' }];
      if (pair % 4 === 3) categoryId = categories[1].id;
    } else if (index < half) {
      conditionsOp = 'or';
      conditions = [{ field: 'account', op: 'is', value: commonAccount, type: 'id' },
        { field: producer ? 'category' : 'payee', op: 'is',
          value: producer ? categories[index + 1].id : payees[index].id, type: 'id' }];
    } else if (producer && index >= half + quarter) {
      conditions = [{ field: 'category', op: 'is', value: categories[1 + index - quarter].id, type: 'id' }];
    } else {
      conditions = [{ field: 'payee', op: 'is', value: payees[index - half].id, type: 'id' },
        { field: 'account', op: 'is', value: producer ? otherAccount : commonAccount, type: 'id' }];
    }
    return { id: `stress-rule-${String(index).padStart(6, '0')}`, name: `Stress rule ${index}`,
      order: index, inactive: false, trigger: { stage: null, conditionsOp, conditions },
      actions: [{ field: 'category', op: 'set', value: categoryId, type: 'id' }] };
  });
  const asOfDate = snapshotDate.slice(0, 10);
  const startDate = `${Number(asOfDate.slice(0, 4)) - 5}${asOfDate.slice(4)}`;
  const commonCount = Math.ceil(size / 2);
  const transactions = Array.from({ length: size }, (_, index) => {
    const id = `stress-tx-${String(index).padStart(6, '0')}`;
    const payee = payees[index % payeeCount];
    return { id, occurrenceId: id,
      accountId: mixed && index >= commonCount ? `stress-account-private-${String((index - commonCount) % half).padStart(6, '0')}` : commonAccount,
      date: new Date(Date.parse(`${asOfDate}T00:00:00Z`) - (index % 1825) * 86400000).toISOString().slice(0, 10),
      payeeId: payee.id, payeeName: payee.name, categoryId: null,
      amount: { minorUnits: String(-index - 1), currency: 'USD' },
      cleared: true, reconciled: false, importedId: `stress-import-${String(index).padStart(6, '0')}`,
      importedPayee: text(null), notes: text(null), description: { state: 'unsupported', value: null },
      verboseTitle: { state: 'unsupported', value: null },
      isSplitParent: false, isSplitChild: false, parentId: null, occurrenceComplete: true,
      startingBalance: false, deleted: false, pending: false, transferAccountId: null };
  });
  const sourceCategoryIds = categories.map((category) => category.id).sort();
  const scope = { spaceId: 'space-perf-only', budgetId: 'budget-perf-only', connectionId: 'connection-perf-only' };
  const facts = { transactions, payees, categories, rules };
  const capturedAt = `${asOfDate}T00:00:00Z`;
  const request = { schemaVersion: canonicalRequest.schemaVersion, scope, snapshotId: `current-native-${workload}-${size}`,
    normalizationVersion: canonicalRequest.normalizationVersion, asOfDate,
    sourceAdmission: { capturedAt, expiresAt: new Date(Date.parse(capturedAt) + 86400000).toISOString(),
      factsHash: `sha256:${sha256(JSON.stringify(facts))}`,
      collections: { transactions: 'complete', payees: 'complete', categories: 'complete', rules: 'complete', schedules: 'complete' },
      accountCoverage: sourceAccountIds.map((accountId) => ({ accountId, state: 'complete', startDate, endDate: asOfDate, currencyState: 'known' })),
      pendingState: 'unsupported', originalTransactionCount: size, truncatedCount: 0,
      visibilityHash: `sha256:${sha256(JSON.stringify({ scope, sourceAccountIds, sourceCategoryIds, mapping: RULE_HEAVY_MAPPING_VERSION, workload }))}`,
      sourceAccountIds, sourceCategoryIds },
    ...facts, aliases: [], corrections: [], schedules: [], patternDecisions: [], calendars: [],
    horizonYears: 5, maxEvidence: canonicalRequest.maxEvidence,
    suggestionSelection: { transactionIds: transactions.map((tx) => tx.id).sort(), cursor: null, limit: 200 } };
  const admission = { reason: null, omittedTransactionIds: [], invalidSourceOmittedCount: 0, nativeCapOmittedCount: 0,
    originalTransactionCount: size, admittedTransactionCount: size, mappingVersion: RULE_HEAVY_MAPPING_VERSION };
  const description = { ...describeSnapshot({ ...facts, accounts: sourceAccountIds.map((id) => ({ id })), schedules: [] }, 0),
    workload, sourceRuleCount: ruleCount, shape: WORKLOADS[workload],
    provenance: 'Explicit generated synthetic performance source; not Actual SDK capture, not adjudicated merchant quality.',
    preservedSeedTransactions: 0, generatedTransactions: size };
  return { request, admission, description };
}

function eligibleRows(request) {
  const start = `${Number(request.asOfDate.slice(0, 4)) - request.horizonYears}${request.asOfDate.slice(4)}`;
  const payees = new Map(request.payees.map((payee) => [payee.id, payee]));
  const seenIds = new Set();
  const seenImports = new Set();
  return [...request.transactions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).filter((tx) => {
    const key = JSON.stringify([tx.accountId, tx.importedId]);
    if (seenIds.has(tx.id) || (tx.importedId !== null && seenImports.has(key))) return false;
    seenIds.add(tx.id);
    if (tx.importedId !== null) seenImports.add(key);
    return !tx.deleted && !tx.pending && tx.cleared && !tx.isSplitParent && !tx.startingBalance
      && tx.transferAccountId === null && !payees.get(tx.payeeId)?.transferAccountId
      && tx.date >= start && tx.date <= request.asOfDate;
  });
}

export function summarizeResponse(response, request) {
  assert.equal(response.schemaVersion, request.schemaVersion);
  assert.equal(response.snapshotId, request.snapshotId);
  assert.equal(response.normalizationVersion, request.normalizationVersion);
  assert.deepEqual(response.scope, request.scope);
  assert.deepEqual(response.sourceAdmission, request.sourceAdmission);
  const eligible = eligibleRows(request);
  const byId = new Map(eligible.map((tx) => [tx.id, tx]));
  const dates = eligible.map((tx) => tx.date).sort();
  assert.equal(response.coverage.inputCount, request.sourceAdmission.originalTransactionCount);
  assert.equal(response.coverage.eligibleCount, eligible.length);
  assert.equal(response.coverage.excludedCount, request.sourceAdmission.originalTransactionCount - eligible.length);
  assert.equal(response.coverage.startDate, dates[0] ?? null);
  assert.equal(response.coverage.endDate, dates.at(-1) ?? null);
  assert.equal(response.coverage.limited, request.sourceAdmission.truncatedCount > 0 || request.sourceAdmission.collections.transactions !== 'complete');
  if (request.sourceAdmission.truncatedCount) assert(response.coverage.reasonCodes.includes('input_truncated'));
  const resultCounts = Object.fromEntries(['suggestions', 'recurrences', 'scheduledExpectations', 'nativeRuleBlocks', 'nativeRuleParts', 'nativeRuleSets', 'nativeRuleClassifications'].map((field) => {
    assert(Array.isArray(response[field]), `Missing native collection: ${field}`);
    return [field, response[field].length];
  }));
  const selection = request.suggestionSelection;
  const selectedIds = new Set(selection.transactionIds);
  const candidates = eligible.filter((tx) => selectedIds.has(tx.id));
  const afterCursor = candidates.filter((tx) => selection.cursor === null || tx.id > selection.cursor);
  const expected = afterCursor.slice(0, selection.limit).map((tx) => tx.id);
  assert.deepEqual(response.suggestions.map((row) => row.transactionId), expected);
  assert.deepEqual(response.suggestionPage, { eligibleCandidates: candidates.length, returned: expected.length,
    nextCursor: afterCursor.length > selection.limit ? expected.at(-1) : null });
  for (const suggestion of response.suggestions) assert.equal(suggestion.accountId, byId.get(suggestion.transactionId).accountId);
  const categoryIds = new Set(request.categories.filter((category) => !category.deleted).map((category) => category.id));
  const ruleIds = new Set(request.rules.filter((rule) => !rule.inactive).map((rule) => rule.id));
  assert(response.nativeRuleBlocks.length <= 100000 && response.nativeRuleSets.length <= 250000);
  const provenanceIds = new Set();
  for (const block of response.nativeRuleBlocks) {
    assert(Array.isArray(block.ruleIds) && block.ruleIds.length > 0
      && provenanceIds.size + block.ruleIds.length <= 100000, 'Invalid native rule block/source bound');
    let previous = null;
    for (const id of block.ruleIds) {
      assert(ruleIds.has(id) && !provenanceIds.has(id), 'Native blocks require disjoint admitted rule IDs');
      const encoded = Buffer.from(id);
      assert(encoded.length <= 256 && (previous === null || Buffer.compare(previous, encoded) < 0), 'Native rule IDs must be canonical');
      provenanceIds.add(id); previous = encoded;
    }
  }
  validateNativeRuleTables(response.nativeRuleBlocks, response.nativeRuleParts, response.nativeRuleSets,
    response.nativeRuleClassifications.map((row) => row.ruleSetIndex));
  const classified = new Set();
  for (const row of response.nativeRuleClassifications) {
    const source = byId.get(row.transactionId);
    assert(source && source.categoryId === null && source.accountId === row.accountId, 'Invalid native classification source');
    assert(!classified.has(row.transactionId), 'Duplicate native classification');
    classified.add(row.transactionId);
    assert(categoryIds.has(row.categoryId) && Number.isInteger(row.ruleSetIndex) && row.ruleSetIndex >= 0
      && row.ruleSetIndex < response.nativeRuleSets.length && !Object.hasOwn(row, 'ruleIds'), 'Invalid native rule/category reference');
  }
  if (ruleIds.size === 0) assert.equal(response.nativeRuleClassifications.length, 0);
  const currencyPartitions = new Map();
  for (const tx of eligible) {
    const key = JSON.stringify([tx.accountId, tx.amount.currency]);
    currencyPartitions.set(key, (currencyPartitions.get(key) ?? 0) + 1);
  }
  for (const recurrence of response.recurrences) {
    assert(currencyPartitions.has(JSON.stringify([recurrence.accountId, recurrence.currency])), 'Recurrence crosses source currency');
    assert.equal(recurrence.minimumAmount.currency, recurrence.currency);
    assert.equal(recurrence.maximumAmount.currency, recurrence.currency);
    assert(recurrence.transactionIds.length <= request.maxEvidence && recurrence.dates.length <= request.maxEvidence);
    for (const id of recurrence.transactionIds) {
      const source = byId.get(id);
      assert(source && source.accountId === recurrence.accountId && source.amount.currency === recurrence.currency, 'Invalid recurrence source');
    }
  }
  const partCount = response.nativeRuleParts.length;
  const setEdgeCount = response.nativeRuleSets.reduce((sum, set) =>
    sum + set.orPartIndexes.length + set.andPartIndexes.reduce((count, operand) => count + operand.length, 0) + 1, 0);
  const nativeRuleMetrics = { sourceRuleCount: request.rules.length,
    emittedSourceRuleCount: provenanceIds.size,
    rawMembershipCount: response.nativeRuleParts.reduce((sum, part) => sum + part.blockIndexes.length, 0),
    partCount, setEdgeCount, partAndEdgeCount: partCount + setEdgeCount };
  return { coverage: response.coverage, suggestionPage: response.suggestionPage, resultCounts, nativeRuleMetrics,
    // Every compact classification is preserved; explanations alone are native-selected/bounded.
    nativeRuleBlocks: response.nativeRuleBlocks,
    nativeRuleParts: response.nativeRuleParts,
    nativeRuleSets: response.nativeRuleSets,
    nativeRuleClassifications: response.nativeRuleClassifications,
    nativeClassificationsSha256: sha256(JSON.stringify([response.nativeRuleBlocks, response.nativeRuleParts, response.nativeRuleSets, response.nativeRuleClassifications])),
    eligibleCurrencyCounts: Object.fromEntries([...currencyPartitions].sort(([a], [b]) => a.localeCompare(b))) };
}

export function parseProcStatus(status) {
  const get = (name) => {
    const match = new RegExp(`^${name}:\\s*(\\d+) kB$`, 'm').exec(status);
    assert(match && Number.isSafeInteger(Number(match[1]) * 1024), `Cannot read ${name}`);
    return Number(match[1]) * 1024;
  };
  return { rssBytes: get('VmRSS'), hwmBytes: get('VmHWM') };
}
function readKernelCounters(io) {
  assert(Number.isSafeInteger(io.pageSize) && io.pageSize > 0, 'Actual page size required');
  const status = parseProcStatus(io.read());
  const raw = io.readStat();
  const delimiter = raw.lastIndexOf(') ');
  assert(delimiter > 0 && /^\d+ \(/.test(raw), 'Cannot parse owned child stat');
  const fields = raw.slice(delimiter + 2).trim().split(/\s+/);
  assert([fields[17], fields[19], fields[21]].every((value) => /^\d+$/.test(value)), 'Missing stat counters');
  const statPid = Number(raw.slice(0, raw.indexOf(' ')));
  const statThreadCount = Number(fields[17]);
  const statStartTime = fields[19];
  const fastRssBytes = Number(fields[21]) * io.pageSize;
  assert(Number.isSafeInteger(statPid) && statPid > 0 && Number.isSafeInteger(statThreadCount) &&
    statThreadCount > 0 && Number.isSafeInteger(fastRssBytes), 'Invalid stat counters');
  return { ...status, statPid, statThreadCount, statStartTime, fastRssBytes,
    identity: JSON.stringify([statPid, statStartTime, statThreadCount, fastRssBytes, status.rssBytes]) };
}

/** Verifies the exported fast/full RSS reset model; this is not an exact physical-allocation measurement. */
export function beginPeakWindow(io) {
  if (io.platform !== 'linux') return { proven: false, reason: 'unsupported_platform' };
  try {
    const before = readKernelCounters(io);
    io.write(io.clearRefsPath, '5');
    const after = readKernelCounters(io);
    const stable = before.identity === after.identity;
    const expected = Math.max(before.fastRssBytes, before.rssBytes);
    const proven = stable && after.hwmBytes === expected;
    return { proven, reason: proven ? null : stable ? 'high_water_reset_not_verified' : 'stopped_child_counters_changed',
      rssBeforeBytes: before.rssBytes, fastRssBeforeBytes: before.fastRssBytes,
      pageSizeBytes: io.pageSize,
      expectedResetHwmBytes: expected, initialFastCounterExcessBytes: Math.max(0, before.fastRssBytes - before.rssBytes),
      hwmBeforeResetBytes: before.hwmBytes, hwmBeforeBytes: after.hwmBytes,
      statPid: after.statPid, statStartTime: after.statStartTime, statThreadCount: after.statThreadCount };
  } catch { return { proven: false, reason: 'high_water_reset_unavailable' }; }
}

/** Measures the approximate exported-kernel high-water increment without removing initial fast-counter excess. */
export function finishPeakWindow(before, io) {
  if (io.platform !== 'linux') return { ...before, incrementalPeakRssBytes: null };
  try {
    const first = readKernelCounters(io);
    const after = readKernelCounters(io);
    const proven = before.proven && first.identity === after.identity &&
      before.statPid === after.statPid && before.statStartTime === after.statStartTime &&
      after.hwmBytes >= before.hwmBeforeBytes && after.hwmBytes >= after.rssBytes;
    return { ...before, proven, reason: proven ? null : before.reason ?? 'high_water_read_not_verified',
      rssAfterBytes: after.rssBytes, fastRssAfterBytes: after.fastRssBytes, hwmAfterBytes: after.hwmBytes,
      statThreadCount: after.statThreadCount,
      endpointRssDeltaBytes: before.rssBeforeBytes === undefined ? null : after.rssBytes - before.rssBeforeBytes,
      incrementalPeakRssBytes: proven ? after.hwmBytes - before.rssBeforeBytes : null };
  } catch { return { ...before, proven: false, reason: 'high_water_read_unavailable', incrementalPeakRssBytes: null }; }
}
function childProcIO(pid) {
  const root = `/proc/${pid}`;
  if (process.platform === 'linux') systemPageSize ??= Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }));
  return { platform: process.platform, pageSize: systemPageSize,
    read: () => readFileSync(`${root}/status`, 'utf8'), readStat: () => readFileSync(`${root}/stat`, 'utf8'),
    write: (file, value) => writeFileSync(file, value),
    threadStates: () => readdirSync(`${root}/task`).map((tid) => {
      const status = readFileSync(`${root}/task/${tid}/status`, 'utf8');
      const state = /^State:\s*([A-Za-z])/m.exec(status)?.[1];
      assert(state, 'Cannot inspect owned child thread state');
      return { tid: Number(tid), state };
    }),
    pause: () => new Promise((resolve) => setTimeout(resolve, 5)) };
}

export async function captureChildPeak(child, before = null, io = childProcIO(child.pid)) {
  const context = { ...before, observer: 'parent-stopped-child', observedPid: child.pid,
    allThreadsStopped: false, proven: false, incrementalPeakRssBytes: null };
  if (io.platform !== 'linux') return { ...context, reason: 'unsupported_platform' };
  let result = context;
  try {
    assert(Number.isSafeInteger(child.pid) && child.pid > 0, 'Owned child PID required');
    assert(before === null || before.observedPid === child.pid, 'Peak windows must belong to the same child');
    assert(child.kill('SIGSTOP'), 'Cannot stop owned child');
    let states = io.threadStates();
    assert(states.length > 0, 'Owned child has no observable threads');
    while (!states.every(({ state }) => state === 'T')) {
      // Existing per-call deadline remains armed and kills the owned child if stop never completes.
      await io.pause();
      states = io.threadStates();
      assert(states.length > 0, 'Owned child threads disappeared');
    }
    context.allThreadsStopped = true;
    const stoppedTids = states.map(({ tid }) => tid).sort((a, b) => a - b);
    const stoppedIO = { ...io, clearRefsPath: `/proc/${child.pid}/clear_refs`, read: () => {
      const status = io.read();
      assert(/^State:\s*T(?:\s|$)/m.test(status), 'Owned child leader is not stopped');
      return status;
    } };
    if (before === null) {
      result = { ...context, ...beginPeakWindow(stoppedIO) };
    } else {
      result = { ...context, ...finishPeakWindow(before, stoppedIO) };
    }
    const afterStates = io.threadStates();
    assert(afterStates.length > 0 && afterStates.every(({ state }) => state === 'T'), 'Owned child resumed during observation');
    assert.deepEqual(afterStates.map(({ tid }) => tid).sort((a, b) => a - b), stoppedTids, 'Owned child TID membership changed');
    if (result.statPid !== undefined) assert.equal(result.statPid, child.pid, 'Foreign stat process');
    if (result.statThreadCount !== undefined) assert.equal(result.statThreadCount, afterStates.length, 'Incomplete child thread observation');
    result.allThreadsStopped = true;
  } catch {
    result = { ...context, allThreadsStopped: false, reason: 'stopped_child_observation_failed' };
  } finally {
    try {
      if (!child.kill('SIGCONT')) result = { ...result, proven: false, reason: 'child_resume_failed', incrementalPeakRssBytes: null };
    } catch {
      result = { ...result, proven: false, reason: 'child_resume_failed', incrementalPeakRssBytes: null };
    }
  }
  return result;
}

export function aggregate(samples, requestedIterations, size, completedWarmups) {
  const completed = samples.filter((sample) => sample.status === 'completed' && !sample.censored);
  const censored = samples.filter((sample) => sample.censored).length;
  const complete = completed.length === requestedIterations && samples.length === requestedIterations && censored === 0;
  const reference = size === 50000 || size === 250000;
  const gateReady = complete && requestedIterations === 20 && completedWarmups >= 2;
  const p95 = (field) => percentile95(completed.map((sample) => sample[field]));
  const peaks = completed.map((sample) => sample.memory.incrementalPeakRssBytes);
  const memoryProven = gateReady && completed.every((sample) => sample.memory.proven && Number.isFinite(sample.memory.incrementalPeakRssBytes));
  const maximum = memoryProven ? Math.max(...peaks) : null;
  const latencyLimitMs = size === 50000 ? 2000 : size === 250000 ? 5000 : null;
  return { requestedIterations, attemptedIterations: samples.length, completedIterations: completed.length,
    censoredIterations: censored, unattemptedIterations: requestedIterations - samples.length,
    completedWarmups, terminationReason: censored ? 'deadline_exceeded_stop_dataset' : 'completed',
    p95ElapsedMs: complete ? p95('elapsedMs') : null,
    p95JsSerializationMs: complete ? p95('jsSerializationMs') : null,
    p95NativeElapsedMs: complete ? p95('nativeElapsedMs') : null,
    p95JsResponseParseMs: complete ? p95('jsResponseParseMs') : null,
    completedOnlyP95ElapsedMs: p95('elapsedMs'), maximumIncrementalPeakRssBytes: maximum,
    gates: { latencyLimitMs, memoryLimitBytes: MEMORY_LIMIT,
      latency: !reference ? 'not_applicable' : !gateReady ? 'unproven' : p95('elapsedMs') <= latencyLimitMs ? 'passed' : 'failed',
      memory: !reference ? 'not_applicable' : !memoryProven ? 'unproven' : maximum <= MEMORY_LIMIT ? 'passed' : 'failed' }, samples };
}

const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
function peakCheckpoint(kind, phase, iteration) {
  return new Promise((resolve, reject) => {
    const receive = (message) => {
      process.removeListener('message', receive);
      try {
        assert(message.kind === 'peak_continue' && message.checkpoint === kind
          && message.phase === phase && message.iteration === iteration, 'Mismatched peak checkpoint');
        resolve();
      } catch (error) { reject(error); }
    };
    process.on('message', receive);
    process.send({ kind, phase, iteration }, (error) => {
      if (error) { process.removeListener('message', receive); reject(error); }
    });
  });
}
async function worker(options) {
  assert(process.send && options.sizes.length === 1, '--worker is reserved for the subprocess harness');
  assert(typeof global.gc === 'function', 'Native peak window requires --expose-gc');
  const native = createRequire(import.meta.url)(options.native);
  assert(typeof native.analyzeMerchantIntelligence === 'function', 'Compiled analyzeMerchantIntelligence export required');
  const start = performance.now();
  const seed = JSON.parse(readFileSync(options.fixture, 'utf8'));
  const canonical = JSON.parse(readFileSync(options.merchantFixture, 'utf8')).request;
  const { request, admission, description } = buildRequest(seed, options.sizes[0], canonical, options.workload);
  await send({ kind: 'prepared', prepared: { ...admission, description, preparationElapsedMs: performance.now() - start,
    sourceAvailability: { importedPayee: options.workload === 'admitted' ? 'canonical string/null' : 'explicit generated absent/null',
      notes: options.workload === 'admitted' ? 'canonical string/null' : 'explicit generated absent/null', description: 'unsupported',
      verboseTitle: 'unsupported', pending: 'unsupported', startingBalanceAndDeleted: options.workload === 'admitted'
        ? 'synthetic fixture rows have no flags; not SDK capture' : 'explicit generated nonstarting/nondeleted rows; not SDK capture',
      calendars: 'unknown; no selected calendar', currencies: 'synthetic canonical Money currencies; not inferred from merchant',
      horizon: 'five civil years ending at canonical snapshotDate' } } });
  const publishedProofs = new Set();
  for (let iteration = 0; iteration < options.warmups + options.iterations; iteration++) {
    const phase = iteration < options.warmups ? 'warmup' : 'sample';
    const phaseIteration = iteration < options.warmups ? iteration + 1 : iteration - options.warmups + 1;
    await send({ kind: 'started', phase, iteration: phaseIteration });
    const measurement = await measureCall(native, request, phase, phaseIteration);
    const { nativeRuleBlocks, nativeRuleParts, nativeRuleSets, nativeRuleClassifications, ...summary } = measurement.summary;
    measurement.summary = summary;
    if (!publishedProofs.has(summary.nativeClassificationsSha256)) {
      measurement.nativeRuleProof = { nativeRuleBlocks, nativeRuleParts, nativeRuleSets, nativeRuleClassifications };
      publishedProofs.add(summary.nativeClassificationsSha256);
    }
    await send({ kind: 'completed', phase, iteration: phaseIteration, measurement });
  }
  process.disconnect();
}
async function measureCall(native, request, phase, iteration) {
  const serializationStart = performance.now();
  const input = JSON.stringify(request);
  const jsSerializationMs = performance.now() - serializationStart;
  const inputSha256 = sha256(input);
  const requestBytes = Buffer.byteLength(input);
  global.gc();
  await peakCheckpoint('peak_ready', phase, iteration);
  const start = performance.now();
  const raw = native.analyzeMerchantIntelligence(input);
  const nativeElapsedMs = performance.now() - start;
  // Retain complete raw output; parent observes stopped child before permitting response parsing.
  await peakCheckpoint('peak_finished', phase, iteration);
  assert.equal(typeof raw, 'string', 'Native response must be JSON text');
  const parseStart = performance.now();
  const response = JSON.parse(raw);
  const jsResponseParseMs = performance.now() - parseStart;
  return { jsSerializationMs, nativeElapsedMs, jsResponseParseMs, elapsedMs: jsSerializationMs + nativeElapsedMs,
    inputSha256, requestBytes, responseBytes: Buffer.byteLength(raw), responseSha256: sha256(raw),
    summary: summarizeResponse(response, request) };
}

function measure(options, size) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const samples = [];
    const warmups = [];
    const nativeRuleProofs = new Map();
    let prepared = null;
    let active = null;
    let timedOut = false;
    let timer;
    const child = fork(SCRIPT, ['--worker', '--sizes', String(size), '--iterations', String(options.iterations),
      '--warmups', String(options.warmups), '--fixture', options.fixture, '--merchant-fixture', options.merchantFixture,
      '--native', options.native, '--workload', options.workload],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: ['--expose-gc'] });
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.deadlineMs); };
    arm(); // Also bounds initial fixture/admission preparation.
    child.on('message', async (message) => {
      if (timedOut) return;
      try {
        if (message.kind === 'prepared') prepared = message.prepared;
        if (message.kind === 'started') { active = { phase: message.phase, iteration: message.iteration }; arm(); }
        if (message.kind === 'peak_ready' || message.kind === 'peak_finished') {
          const call = active;
          assert(call && call.phase === message.phase && call.iteration === message.iteration, 'Peak checkpoint changed call');
          const beginning = message.kind === 'peak_ready';
          assert(beginning ? call.peakBefore === undefined : call.peakBefore !== undefined && call.memory === undefined,
            'Peak checkpoint out of order');
          const memory = await captureChildPeak(child, beginning ? null : call.peakBefore);
          if (timedOut || active !== call) return;
          if (beginning) call.peakBefore = memory;
          else call.memory = { ...memory, responseParseDeferred: true };
          child.send({ kind: 'peak_continue', checkpoint: message.kind, phase: call.phase, iteration: call.iteration },
            (error) => { if (error) child.kill('SIGKILL'); });
        }
        if (message.kind === 'completed') {
          assert(active && active.phase === message.phase && active.iteration === message.iteration && active.memory,
            'Native completion lacks its observed peak window');
          const { nativeRuleProof, ...measurement } = message.measurement;
          const proofHash = measurement.summary.nativeClassificationsSha256;
          if (nativeRuleProof !== undefined) {
            assert(!nativeRuleProofs.has(proofHash), 'Native proof was republished');
            assert.equal(sha256(JSON.stringify([
              nativeRuleProof.nativeRuleBlocks, nativeRuleProof.nativeRuleParts,
              nativeRuleProof.nativeRuleSets, nativeRuleProof.nativeRuleClassifications,
            ])), proofHash, 'Native proof content hash changed');
            nativeRuleProofs.set(proofHash, nativeRuleProof);
          }
          assert(nativeRuleProofs.has(proofHash), 'Native completion lacks its lossless provenance proof');
          (message.phase === 'warmup' ? warmups : samples).push({ iteration: message.iteration,
            status: 'completed', censored: false, ...measurement, memory: active.memory });
          active = null; arm();
        }
      } catch { child.kill('SIGKILL'); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const failedSubprocess = !timedOut && (code !== 0 || samples.length !== options.iterations || warmups.length !== options.warmups);
      if (failedSubprocess && active) (active.phase === 'warmup' ? warmups : samples).push({ ...active,
        status: 'error', censored: false, nativeDurationUnknown: true, exitCode: code, signal });
      if (timedOut && active) (active.phase === 'warmup' ? warmups : samples).push({ ...active,
        status: 'timeout', censored: true, deadlineMs: options.deadlineMs, nativeDurationUnknown: true, signal });
      const completedWarmups = warmups.filter((sample) => sample.status === 'completed').length;
      const summary = aggregate(samples, options.iterations, size, completedWarmups);
      resolve({ requestedTransactions: size, prepared, ...summary, nativeRuleProofs: Object.fromEntries(nativeRuleProofs),
        requestedWarmups: options.warmups, warmups,
        censoredWarmups: warmups.filter((sample) => sample.censored).length,
        failedSubprocess, subprocessExitCode: code, subprocessSignal: signal,
        preparationCensored: timedOut && prepared === null, subprocessElapsedMs: performance.now() - start,
        terminationReason: timedOut ? 'deadline_exceeded_stop_dataset'
          : failedSubprocess ? 'native_subprocess_failed_stop_dataset' : summary.terminationReason });
    });
  });
}
function optionalFile(file) { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } }

async function main(options) {
  if (options.help) {
    process.stdout.write(`Usage: taskset -c 0,1 node scripts/merchant-intelligence/current.mjs [--workload ${Object.keys(WORKLOADS).join('|')}] [--sizes 50000,250000] [--warmups 2] [--iterations 20] [--deadline-ms 30000] [--output NEW-private-report.json]\nNative-only normalized/admitted synthetic workload, NOT Actual SDK capture or end-to-end Review. Default admitted input remains unchanged; named rule-heavy sources are separately generated performance data, never quality labels. Reference failed/unproven gates exit2 after retaining report; smoke sizes are not release gates. --output uses exclusive creation mode0600, never overwrites.\n`);
    return;
  }
  if (options.worker) { await worker(options); return; }
  assert.equal(process.platform, 'linux', 'Reference measurements require Linux and two-core affinity');
  const status = readFileSync('/proc/self/status', 'utf8');
  const affinity = /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1]?.trim();
  assert(affinity, 'Cannot inspect effective CPU affinity');
  const allowedCpuCount = affinity.split(',').reduce((count, range) => {
    const [start, end = start] = range.split('-').map(Number); return count + end - start + 1;
  }, 0);
  assert(allowedCpuCount <= 2, `Use taskset to cap two allowed cores; affinity=${affinity}`);
  const spec = JSON.parse(readFileSync(path.join(path.dirname(SCRIPT), 'benchmark-spec.json'), 'utf8'));
  const identity = (file) => ({ path: file, sha256: sha256(readFileSync(file)) });
  const report = { schemaVersion: '1', benchmark: 'current-analyzeMerchantIntelligence-native', measuredAt: new Date().toISOString(),
    environment: { platform: process.platform, architecture: process.arch, kernel: os.release(), node: process.version,
      versions: process.versions, baselineNode: 'v24.11.1', identicalBaselineRuntime: process.version === 'v24.11.1',
      cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))], availableParallelism: os.availableParallelism(),
      effectiveCpuAffinity: affinity, allowedCpuCount, cpuCapMethod: 'inherited affinity; not dedicated cores or utilization/quota guarantee',
      cgroupMembership: optionalFile('/proc/self/cgroup'), rootCgroupCpuMax: optionalFile('/sys/fs/cgroup/cpu.max') },
    fixture: identity(options.fixture), merchantFixture: identity(options.merchantFixture),
    generatorAndMapping: { version: options.workload === 'admitted' ? MAPPING_VERSION : RULE_HEAVY_MAPPING_VERSION,
      harness: identity(SCRIPT), expansion: identity(path.join(path.dirname(SCRIPT), 'baseline.mjs')) },
    native: { ...identity(options.native), method: 'analyzeMerchantIntelligence', buildProfile: 'not inferable; caller must build release' },
    configuration: { workload: options.workload, sizes: options.sizes, warmups: options.warmups,
      iterations: options.iterations, deadlineMs: options.deadlineMs },
    spec: spec.currentBenchmark, datasets: [] };
  for (const size of options.sizes) report.datasets.push(await measure(options, size));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, json, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(json);
  if (report.datasets.some((dataset) => dataset.failedSubprocess || dataset.completedIterations !== options.iterations
    || ['latency', 'memory'].some((gate) => ['failed', 'unproven'].includes(dataset.gates[gate])))) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  Promise.resolve().then(() => main(parseArgs(process.argv.slice(2)))).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'error', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
