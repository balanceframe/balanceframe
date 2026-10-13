import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { aggregate, beginPeakWindow, buildRequest, captureChildPeak, finishPeakWindow, parseArgs, parseProcStatus, summarizeResponse } from './current.mjs';
import { merchantAnalysisRequestSchema } from '../../packages/protocol-generated/src/merchant-validators.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const seed = JSON.parse(readFileSync(path.join(ROOT, 'protocol/fixtures/representative.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'protocol/fixtures/merchant-intelligence.json'), 'utf8'));
const execute = promisify(execFile);
const runner = path.join(ROOT, 'scripts/merchant-intelligence/current.mjs');
const proc = (rss, hwm = rss) => `VmRSS:\t${rss} kB\nVmHWM:\t${hwm} kB\n`;
// Linux stat fields start at field 3 after the final parenthesized comm delimiter.
const procStat = (rssKiB, pageSize = 4096, pid = 4321, threads = 2) => {
  const fields = Array(50).fill('0');
  fields[0] = 'T'; fields[17] = String(threads); fields[19] = '12345';
  fields[21] = String(rssKiB * 1024 / pageSize);
  return `${pid} (worker with ) (spaces) ${fields.join(' ')}\n`;
};

// Parent runs all gates; only the actual compiled addon is used by runtime checks.
test('invalid sample, dataset and deadline controls are rejected', () => {
  for (const args of [['--sizes', '250001'], ['--sizes', '0'], ['--sizes', '96,'],
    ['--warmups', '0'], ['--iterations', 'NaN'], ['--deadline-ms', '0'], ['--unknown', '1']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('canonical workload mapping is deterministic, preserves facts and honestly admits only valid source identities', () => {
  const original = JSON.stringify(seed);
  const first = buildRequest(seed, 120, fixture.request);
  assert.deepEqual(first, buildRequest(seed, 120, fixture.request));
  assert.equal(JSON.stringify(seed), original);
  const { request, admission, description } = first;
  assert.equal(request.transactions.length, 120);
  assert.equal(description.transactionCount, 120);
  assert.equal(request.sourceAdmission.originalTransactionCount, 120 + admission.omittedTransactionIds.length);
  assert.equal(request.sourceAdmission.truncatedCount, admission.omittedTransactionIds.length);
  assert.equal(admission.invalidSourceOmittedCount, 5);
  assert.equal(admission.nativeCapOmittedCount, 0);
  assert.equal(admission.reason, 'conflicting_account_import_identity');
  assert.deepEqual(request.payees, seed.payees);
  assert(admission.omittedTransactionIds.includes('tx_090'));
  assert(admission.omittedTransactionIds.includes('tx_091'));
  assert.equal(request.sourceAdmission.collections.transactions, 'partial');
  assert.equal(request.sourceAdmission.pendingState, 'unsupported');
  assert.equal(request.calendars.length, 0);
  assert.deepEqual(request.rules, seed.rules);
  assert.match(request.sourceAdmission.factsHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(request.suggestionSelection, {
    transactionIds: request.transactions.filter((tx) => tx.categoryId === null).map((tx) => tx.id).sort(), cursor: null, limit: 200,
  });
  for (const tx of request.transactions.filter((tx) => !tx.id.startsWith('perf-only-'))) {
    const source = seed.transactions.flatMap((row) => [row, ...row.subtransactions]).find((row) => row.id === tx.id);
    for (const key of ['id', 'accountId', 'date', 'payeeId', 'payeeName', 'categoryId', 'amount', 'cleared', 'reconciled', 'importedId', 'transferAccountId']) {
      assert.deepEqual(tx[key], source[key]);
    }
    assert.deepEqual(tx.importedPayee, { state: source.importedPayee === null ? 'absent' : source.importedPayee === '' ? 'empty' : 'present', value: source.importedPayee });
    assert.equal(tx.description.state, 'unsupported');
    assert.equal(tx.verboseTitle.state, 'unsupported');
  }
  const child = request.transactions.find((tx) => tx.id === 'tx_084-sub-1');
  assert.equal(child.parentId, 'tx_084');
  assert.equal(child.occurrenceId, 'tx_084');
  const generated = request.transactions.filter((tx) => tx.id.startsWith('perf-only-'));
  for (const tx of generated) {
    assert.equal(tx.amount.currency, tx.accountId.slice('perf-only-account-'.length));
    if (tx.categoryId === null) assert.equal(tx.cleared, false); // Do not manufacture eligible generated candidates.
  }
  assert.deepEqual([...new Set(generated.map((tx) => tx.amount.currency))].sort(), ['CAD', 'GBP', 'USD']);
  assert.equal(buildRequest(seed, 250000, fixture.request).request.transactions.length, 250000);
});

const stressWorkloads = ['wide-or-private-and', 'broad-account-oneof-and', 'producer-disjoint-or-and'];

// Test-only expansion checks the complete literal-table semantics; the timed harness never expands matches.
function matchingRuleIds(response, classification) {
  const set = response.nativeRuleSets[classification.ruleSetIndex];
  const union = (references) => new Set(references.flatMap((reference) => response.nativeRuleParts[reference].blockIndexes));
  const indexes = union(set.orPartIndexes);
  if (set.andPartIndexes.length) {
    const operands = set.andPartIndexes.map(union);
    for (const index of operands[0]) if (operands.every((operand) => operand.has(index))) indexes.add(index);
  }
  const category = new Set(response.nativeRuleParts[set.categoryPartIndex].blockIndexes);
  return [...indexes].filter((index) => category.has(index))
    .flatMap((index) => response.nativeRuleBlocks[index].ruleIds).sort();
}

test('explicit rule-heavy selectors reject unknown or missing workloads', () => {
  assert.throws(() => parseArgs(['--workload', 'imaginary']));
  assert.throws(() => parseArgs(['--workload']));
});

test('rule-heavy builders deterministically admit legal complete sources without changing default fixture facts', () => {
  const unchanged = JSON.stringify(seed);
  for (const workload of stressWorkloads) {
    const built = buildRequest(seed, 240, fixture.request, workload);
    assert.deepEqual(built, buildRequest(seed, 240, fixture.request, workload));
    const { request, admission, description } = built;
    assert.equal(description.workload, workload);
    assert.equal(description.sourceRuleCount, 960);
    assert.equal(description.preservedSeedTransactions, 0);
    assert.match(description.provenance, /synthetic.*not Actual SDK.*not.*quality/i);
    assert.equal(request.transactions.length, 240);
    assert.equal(request.rules.length, 960);
    assert.equal(admission.invalidSourceOmittedCount, 0);
    assert.equal(admission.nativeCapOmittedCount, 0);
    assert.deepEqual(request.sourceAdmission.collections, {
      transactions: 'complete', payees: 'complete', categories: 'complete', rules: 'complete', schedules: 'complete',
    });
    assert.equal(request.sourceAdmission.originalTransactionCount, 240);
    assert.equal(request.sourceAdmission.truncatedCount, 0);
    assert.equal(request.sourceAdmission.accountCoverage.length, request.sourceAdmission.sourceAccountIds.length);
    assert(request.sourceAdmission.accountCoverage.every((row) => row.state === 'complete' && row.currencyState === 'known'));
    assert.equal(new Set(request.rules.map((row) => row.id)).size, 960);
    assert.equal(new Set(request.transactions.map((row) => row.id)).size, 240);
    assert(request.transactions.every((row) => row.cleared && row.categoryId === null
      && row.occurrenceComplete && !row.pending && !row.deleted && !row.isSplitParent && !row.isSplitChild));
    assert.deepEqual(request.suggestionSelection.transactionIds, request.transactions.map((row) => row.id).sort());
    assert.equal(request.suggestionSelection.limit, 200);
    const accounts = new Set(request.sourceAdmission.sourceAccountIds);
    const categories = new Set(request.categories.map((row) => row.id));
    const payees = new Set(request.payees.map((row) => row.id));
    assert.deepEqual([...categories].sort(), request.sourceAdmission.sourceCategoryIds);
    for (const rule of request.rules) {
      assert.equal(rule.inactive, false);
      for (const clause of [...rule.trigger.conditions, ...rule.actions]) {
        const allowed = clause.field === 'account' ? accounts : clause.field === 'category' ? categories : payees;
        for (const id of Array.isArray(clause.value) ? clause.value : [clause.value]) assert(allowed.has(id));
      }
    }
    merchantAnalysisRequestSchema.parse(request);
    for (const mutate of [
      (invalid) => { invalid.transactions[0].amount.minorUnits = '00'; },
      (invalid) => { invalid.transactions[0].description = { state: 'unsupported', value: 'invented source' }; },
      (invalid) => { invalid.rules[0].id = 'x'.repeat(257); },
      (invalid) => { invalid.rules[0].trigger.conditions[0].value = 'x'.repeat(4097); },
      (invalid) => { invalid.sourceAdmission.originalTransactionCount = -1; },
      (invalid) => { invalid.sourceAdmission.sourceAccountIds = Array(100001).fill('stress-account-common'); },
      (invalid) => { invalid.sourceAdmission.sourceCategoryIds = Array(100001).fill(request.categories[0].id); },
    ]) {
      const invalid = structuredClone(request);
      mutate(invalid);
      assert.equal(merchantAnalysisRequestSchema.safeParse(invalid).success, false);
    }
    if (workload === 'wide-or-private-and') {
      assert.equal(request.rules.filter((row) => row.trigger.conditionsOp === 'or').length, 480);
      assert.equal(request.payees.length, 480);
    } else if (workload === 'broad-account-oneof-and') {
      assert(request.rules.every((row) => row.trigger.conditionsOp === 'and'
        && row.trigger.conditions.length === 1 && row.trigger.conditions[0].op === 'oneOf'));
      assert.deepEqual(request.rules[0].trigger, request.rules[1].trigger);
      assert.equal(new Set(request.rules.map((row) => row.actions[0].value)).size, 2);
    } else {
      assert.equal(request.rules.filter((row) => row.trigger.conditionsOp === 'or').length, 480);
      assert.equal(request.rules.filter((row) => row.trigger.conditionsOp === 'and' && row.trigger.conditions.length === 2).length, 240);
      assert.equal(request.rules.filter((row) => row.trigger.conditionsOp === 'and' && row.trigger.conditions.length === 1).length, 240);
      assert.equal(request.categories.length, 721);
    }
  }
  assert.equal(JSON.stringify(seed), unchanged);
  for (const workload of stressWorkloads) {
    for (const size of [50000, 250000]) {
      const { request } = buildRequest(seed, size, fixture.request, workload);
      assert.equal(request.transactions.length, size);
      assert.equal(request.rules.length, 100000);
      assert(request.payees.length <= 100000 && request.categories.length <= 100000
        && request.sourceAdmission.sourceAccountIds.length <= 100000);
    }
  }
  for (const size of [0, 250001]) assert.throws(() => buildRequest(seed, size, fixture.request, stressWorkloads[0]));
  assert.throws(() => buildRequest(seed, 240, fixture.request, 'imaginary'));
});

test('real native rule-heavy workloads retain every classification and complete weighted source IDs across explanation pages', () => {
  const native = createRequire(import.meta.url)(path.join(ROOT, 'crates/node-binding/balanceframe.node'));
  for (const workload of stressWorkloads) {
    const { request } = buildRequest(seed, 240, fixture.request, workload);
    const response = JSON.parse(native.analyzeMerchantIntelligence(JSON.stringify(request)));
    const summary = summarizeResponse(response, request);
    const mixed = workload === 'broad-account-oneof-and';
    const commonAccount = request.sourceAdmission.sourceAccountIds.find((id) => id.endsWith('-common'));
    const classifiedTransactions = request.transactions.filter((tx) => !mixed || tx.accountId !== commonAccount);
    assert.equal(response.nativeRuleClassifications.length, classifiedTransactions.length);
    assert.deepEqual(response.nativeRuleClassifications.map((row) => row.transactionId), classifiedTransactions.map((tx) => tx.id).sort());
    assert.equal(response.suggestions.length, 200);
    assert.equal(response.suggestionPage.eligibleCandidates, 240);
    assert.equal(response.coverage.eligibleCount, 240);
    for (const row of response.nativeRuleClassifications) {
      assert(!Object.hasOwn(row, 'ruleIds') && !Object.hasOwn(row, 'nativeRuleIds'));
      if (!mixed) assert.equal(row.categoryId, request.categories[0].id);
      const tx = request.transactions.find((candidate) => candidate.id === row.transactionId);
      const expectedRules = mixed ? request.rules.filter((rule) => rule.trigger.conditions[0].value.includes(tx.accountId))
        : request.rules.filter((rule) => rule.trigger.conditionsOp === 'or'
          || (workload === 'wide-or-private-and' && rule.trigger.conditions[0].value === tx.payeeId));
      const expected = expectedRules.map((rule) => rule.id);
      assert(expectedRules.every((rule) => rule.actions[0].value === row.categoryId));
      assert.deepEqual(matchingRuleIds(response, row), expected.sort());
    }
    for (const suggestion of response.suggestions) {
      const classification = response.nativeRuleClassifications.find((row) => row.transactionId === suggestion.transactionId);
      if (!classification) {
        assert(mixed);
        assert.equal(suggestion.categoryId, null);
        assert.equal(suggestion.tier, 'conflicting');
        assert(suggestion.reasonCodes.includes('native_rule_conflict'));
        assert.deepEqual(suggestion.alternatives.map((row) => [row.categoryId, row.supportCount]).sort(),
          request.categories.map((category) => [category.id,
            request.rules.filter((rule) => rule.actions[0].value === category.id).length]).sort());
        assert.deepEqual(suggestion.contradictions.filter((row) => row.kind === 'native_rule').map((row) => row.sourceId),
          request.rules.map((rule) => rule.id).sort().slice(0, request.maxEvidence));
        continue;
      }
      const ids = matchingRuleIds(response, classification);
      assert.equal(suggestion.supportCount, ids.length);
      assert.deepEqual(suggestion.evidence.filter((row) => row.kind === 'native_rule').map((row) => row.sourceId),
        ids.slice(0, request.maxEvidence));
    }
    const metrics = summary.nativeRuleMetrics;
    assert.equal(metrics.sourceRuleCount, request.rules.length);
    assert.equal(metrics.emittedSourceRuleCount, response.nativeRuleBlocks.reduce((sum, row) => sum + row.ruleIds.length, 0));
    assert.equal(metrics.rawMembershipCount, response.nativeRuleParts.reduce((sum, row) => sum + row.blockIndexes.length, 0));
    assert.equal(metrics.partCount, response.nativeRuleParts.length);
    assert.equal(metrics.setEdgeCount, response.nativeRuleSets.reduce((sum, row) =>
      sum + row.orPartIndexes.length + row.andPartIndexes.reduce((count, operand) => count + operand.length, 0) + 1, 0));
    assert.equal(metrics.partAndEdgeCount, metrics.partCount + metrics.setEdgeCount);
    assert(metrics.partAndEdgeCount <= 13 * request.transactions.length);
    const next = structuredClone(request);
    next.suggestionSelection.cursor = response.suggestionPage.nextCursor;
    const nextResponse = JSON.parse(native.analyzeMerchantIntelligence(JSON.stringify(next)));
    assert.equal(nextResponse.suggestions.length, 40);
    assert.deepEqual(nextResponse.nativeRuleClassifications, response.nativeRuleClassifications);
    assert.deepEqual(nextResponse.nativeRuleBlocks, response.nativeRuleBlocks);
    assert.deepEqual(nextResponse.nativeRuleParts, response.nativeRuleParts);
    assert.deepEqual(nextResponse.nativeRuleSets, response.nativeRuleSets);
    if (mixed) {
      // Separate single-target broad-route proof: mixed common-account rows above must never acquire a winner.
      const pure = structuredClone(request);
      for (const tx of pure.transactions) tx.accountId = commonAccount;
      for (const rule of pure.rules) rule.actions[0].value = pure.categories[0].id;
      pure.sourceAdmission.factsHash = `sha256:${createHash('sha256').update(JSON.stringify({
        transactions: pure.transactions, payees: pure.payees, categories: pure.categories, rules: pure.rules,
      })).digest('hex')}`;
      const pureResponse = JSON.parse(native.analyzeMerchantIntelligence(JSON.stringify(pure)));
      assert.equal(pureResponse.nativeRuleClassifications.length, 240);
      assert.equal(pureResponse.suggestions.length, 200);
      const allIds = pure.rules.map((rule) => rule.id).sort();
      for (const classification of pureResponse.nativeRuleClassifications) {
        assert.equal(classification.categoryId, pure.categories[0].id);
        assert.deepEqual(matchingRuleIds(pureResponse, classification), allIds);
      }
      for (const suggestion of pureResponse.suggestions) {
        assert.equal(suggestion.supportCount, 960);
        assert.deepEqual(suggestion.evidence.filter((row) => row.kind === 'native_rule').map((row) => row.sourceId),
          allIds.slice(0, pure.maxEvidence));
      }
    }
  }
});

test('real rule-heavy reports share identical lossless provenance across samples instead of duplicating maximum-sized output', async () => {
  const { stdout } = await execute(process.execPath, [runner, '--workload', 'producer-disjoint-or-and',
    '--sizes', '240', '--iterations', '2', '--deadline-ms', '30000'], { cwd: ROOT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.configuration.workload, 'producer-disjoint-or-and');
  const dataset = report.datasets[0];
  assert.equal(dataset.completedIterations, 2);
  assert.equal(dataset.prepared.description.workload, 'producer-disjoint-or-and');
  assert.equal(dataset.prepared.description.sourceRuleCount, 960);
  assert.match(dataset.prepared.description.provenance, /not Actual SDK/);
  const { request } = buildRequest(seed, 240, fixture.request, 'producer-disjoint-or-and');
  assert.equal(Object.keys(dataset.nativeRuleProofs).length, 1);
  for (const sample of [...dataset.warmups, ...dataset.samples]) {
    const proof = dataset.nativeRuleProofs[sample.summary.nativeClassificationsSha256];
    assert.deepEqual(proof.nativeRuleClassifications.map((row) => row.transactionId).sort(),
      request.transactions.map((row) => row.id).sort());
    assert.equal(createHash('sha256').update(JSON.stringify([
      proof.nativeRuleBlocks, proof.nativeRuleParts, proof.nativeRuleSets, proof.nativeRuleClassifications,
    ])).digest('hex'), sample.summary.nativeClassificationsSha256);
    assert(!Object.hasOwn(sample.summary, 'nativeRuleClassifications'));
    assert(!Object.hasOwn(sample.summary, 'nativeRuleBlocks'));
    assert(!Object.hasOwn(sample.summary, 'nativeRuleParts'));
    assert(!Object.hasOwn(sample.summary, 'nativeRuleSets'));
  }
  for (const sample of dataset.samples) {
    assert.equal(sample.summary.resultCounts.nativeRuleClassifications, 240);
    assert.equal(sample.summary.resultCounts.suggestions, 200);
    assert(sample.summary.nativeRuleMetrics.rawMembershipCount > 0);
    assert(sample.summary.nativeRuleMetrics.partAndEdgeCount <= 13 * 240);
    assert(sample.responseBytes > 0 && Number.isFinite(sample.jsResponseParseMs));
  }
});

test('kernel reset and fresh high-water values are required, never substitute endpoint or lifetime RSS', () => {
  assert.deepEqual(parseProcStatus(proc(100, 200)), { rssBytes: 102400, hwmBytes: 204800 });
  assert.throws(() => parseProcStatus('VmRSS: 1 kB'));
  const writes = [];
  let rss = 100; let hwm = 200;
  const io = { platform: 'linux', pageSize: 4096, clearRefsPath: '/proc/1234/clear_refs',
    read: () => proc(rss, hwm), readStat: () => procStat(rss - rss % 4, 4096, 1234, 1),
    write: (file, value) => { writes.push([file, value]); hwm = rss; } };
  const before = beginPeakWindow(io);
  rss = 150; hwm = 240;
  const measured = finishPeakWindow(before, io);
  assert.deepEqual(writes, [['/proc/1234/clear_refs', '5']]);
  assert.equal(measured.proven, true);
  assert.equal(measured.incrementalPeakRssBytes, 140 * 1024);
  assert.equal(measured.rssAfterBytes, 150 * 1024);
  for (const broken of [
    { platform: 'darwin', read: () => proc(100), write: () => assert.fail('unsupported reset') },
    { platform: 'linux', read: () => proc(100), write: () => { throw new Error('EPERM'); } },
    { platform: 'linux', read: () => proc(100, 200), write: () => {} },
  ]) {
    const brokenIO = { pageSize: 4096, readStat: () => procStat(100), ...broken };
    assert.equal(finishPeakWindow(beginPeakWindow(brokenIO), brokenIO).proven, false);
  }
});

test('kernel counter reset uses the exact fast/full model and preserves initial counter excess', () => {
  for (const [fastKiB, fullKiB, pageSize] of [[104, 100, 4096], [96, 100, 8192], [100, 100, 1024]]) {
    let highWaterKiB = 900;
    const io = {
      platform: 'linux', clearRefsPath: '/proc/4321/clear_refs', pageSize,
      read: () => proc(fullKiB, highWaterKiB),
      readStat: () => procStat(fastKiB, pageSize),
      write: () => { highWaterKiB = Math.max(fastKiB, fullKiB); },
    };
    const before = beginPeakWindow(io);
    assert.equal(before.proven, true, `fast=${fastKiB}, full=${fullKiB}`);
    assert.equal(before.fastRssBeforeBytes, fastKiB * 1024);
    assert.equal(before.rssBeforeBytes, fullKiB * 1024);
    assert.equal(before.expectedResetHwmBytes, Math.max(fastKiB, fullKiB) * 1024);
    assert.equal(before.initialFastCounterExcessBytes, Math.max(0, fastKiB - fullKiB) * 1024);
    assert.equal(before.hwmBeforeResetBytes, 900 * 1024);
    const noOp = finishPeakWindow(before, io);
    assert.equal(noOp.proven, true);
    assert.equal(noOp.incrementalPeakRssBytes, Math.max(0, fastKiB - fullKiB) * 1024);
  }
});

test('kernel counter reset rejects incorrect formulas, unstable fast counters and unreadable page units', () => {
  for (const problem of ['wrong_high_water', 'changed_fast', 'missing_stat', 'invalid_stat', 'zero_page_size', 'fractional_page_size']) {
    let reset = false;
    const io = {
      platform: 'linux', clearRefsPath: '/proc/4321/clear_refs',
      pageSize: problem === 'zero_page_size' ? 0 : problem === 'fractional_page_size' ? 4096.5 : 4096,
      read: () => proc(100, reset ? problem === 'wrong_high_water' ? 108 : 104 : 900),
      readStat: () => {
        if (problem === 'missing_stat') throw new Error('ENOENT');
        return problem === 'invalid_stat' ? '4321 (worker) T' : procStat(reset && problem === 'changed_fast' ? 108 : 104);
      },
      write: () => { reset = true; },
    };
    const measured = finishPeakWindow(beginPeakWindow(io), io);
    assert.equal(measured.proven, false, problem);
    assert.equal(measured.incrementalPeakRssBytes, null, problem);
  }
});

test('owned kernel observer verifies stable TID membership rather than only thread count', async () => {
  for (const changed of [false, true]) {
    let reset = false;
    let highWater = 900;
    const signals = [];
    const child = { pid: 4321, kill: (signal) => { signals.push(signal); return true; } };
    const io = {
      platform: 'linux', pageSize: 4096,
      threadStates: () => [{ tid: 4321, state: 'T' }, { tid: reset && changed ? 4323 : 4322, state: 'T' }],
      pause: async () => assert.fail('Already-stopped threads must not wait'),
      read: () => `State:\tT (stopped)\n${proc(100, highWater)}`,
      readStat: () => procStat(100),
      write: () => { reset = true; highWater = 100; },
    };
    const measured = await captureChildPeak(child, null, io);
    assert.equal(measured.proven, !changed);
    assert.equal(measured.incrementalPeakRssBytes, null);
    assert.equal(signals.at(-1), 'SIGCONT');
    if (changed) assert.equal(measured.reason, 'stopped_child_observation_failed');
  }
});
test('parent observes only its owned fully stopped child, resets its high water and resumes on both checkpoints', async () => {
  const events = [];
  let rss = 100;
  let hwm = 900;
  let states = ['T', 'R'];
  const child = { pid: 4321, kill: (signal) => { events.push(signal); return true; } };
  const io = {
    platform: 'linux', pageSize: 4096, readStat: () => procStat(rss),
    threadStates: () => { events.push('threads'); return states.map((state, index) => ({ tid: 4321 + index, state })); },
    pause: async () => { events.push('pause'); states = ['T', 'T']; },
    read: () => { assert(states.every((state) => state === 'T')); events.push('read'); return `State:\tT (stopped)\n${proc(rss, hwm)}`; },
    write: (file, value) => { assert(states.every((state) => state === 'T')); events.push([file, value]); hwm = rss; },
  };
  const before = await captureChildPeak(child, null, io);
  assert.equal(before.proven, true);
  assert.equal(before.observedPid, 4321);
  assert.equal(before.observer, 'parent-stopped-child');
  assert.equal(before.allThreadsStopped, true);
  assert.equal(before.rssBeforeBytes, 100 * 1024);
  assert(events.indexOf('pause') < events.indexOf('read'));
  assert.deepEqual(events.filter(Array.isArray), [['/proc/4321/clear_refs', '5']]);
  assert.equal(events.at(-1), 'SIGCONT');
  rss = 80; hwm = 240; // End RSS falls; actual transient HWM still governs.
  const after = await captureChildPeak(child, before, io);
  assert.equal(after.proven, true);
  assert.equal(after.incrementalPeakRssBytes, 140 * 1024);
  assert.equal(after.endpointRssDeltaBytes, -20 * 1024);
  assert.equal(after.observedPid, 4321);
  assert.deepEqual(events.filter((event) => event === 'SIGSTOP' || event === 'SIGCONT'), ['SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT']);
  assert.equal(events.filter(Array.isArray).length, 1); // Never reset after native call.
});

test('stopped-child reset failures, inconsistent reads and even one-page gaps remain unproven without stranding child', async () => {
  for (const problem of ['denied', 'one_page_gap', 'rss_changed', 'read_failed', 'leader_running', 'empty_threads', 'stop_failed']) {
    const signals = [];
    let reset = false;
    const child = { pid: 5432, kill: (signal) => { signals.push(signal); return problem !== 'stop_failed'; } };
    const io = {
      platform: 'linux', pageSize: 4096,
      threadStates: () => problem === 'empty_threads' ? [] : [{ tid: 5432, state: 'T' }],
      readStat: () => procStat(reset && problem === 'rss_changed' ? 104 : 100, 4096, 5432, 1),
      pause: async () => assert.fail('Unexpected indefinite stop wait'),
      read: () => {
        if (problem === 'read_failed') throw new Error('ENOENT');
        const rss = reset && problem === 'rss_changed' ? 104 : 100;
        const hwm = reset ? rss + (problem === 'one_page_gap' ? 4 : 0) : 900;
        return `State:\t${problem === 'leader_running' ? 'R (running)' : 'T (stopped)'}\n${proc(rss, hwm)}`;
      },
      write: (file, value) => { assert.equal(file, '/proc/5432/clear_refs'); assert.equal(value, '5');
        if (problem === 'denied') throw new Error('EPERM'); reset = true; },
    };
    const before = await captureChildPeak(child, null, io);
    assert.equal(before.proven, false, problem);
    assert.equal(before.incrementalPeakRssBytes, null);
    assert.equal(signals.at(-1), 'SIGCONT', problem);
  }
});


test('latency includes input serialization and native response serialization; gates require complete reference samples and proven peaks', () => {
  const sample = { status: 'completed', censored: false, jsSerializationMs: 500, nativeElapsedMs: 1400,
    jsResponseParseMs: 10, elapsedMs: 1900, memory: { proven: true, incrementalPeakRssBytes: 512 * 1024 * 1024 } };
  const samples = Array.from({ length: 20 }, () => structuredClone(sample));
  const passed = aggregate(samples, 20, 50000, 2);
  assert.equal(passed.p95ElapsedMs, 1900);
  assert.equal(passed.p95JsSerializationMs, 500);
  assert.equal(passed.gates.latency, 'passed');
  assert.equal(passed.gates.memory, 'passed');
  assert.equal(aggregate(samples.map((s) => ({ ...s, elapsedMs: 2001 })), 20, 50000, 2).gates.latency, 'failed');
  assert.equal(aggregate(samples.map((s) => ({ ...s, memory: { proven: true, incrementalPeakRssBytes: 512 * 1024 * 1024 + 1 } })), 20, 250000, 2).gates.memory, 'failed');
  assert.equal(aggregate(samples.map((s) => ({ ...s, memory: { proven: false } })), 20, 50000, 2).gates.memory, 'unproven');
  assert.equal(aggregate(samples, 20, 50000, 1).gates.latency, 'unproven');
  const oneLatencyOutlier = samples.map((s, index) => ({ ...s, elapsedMs: index === 19 ? 9000 : 1900 }));
  assert.equal(aggregate(oneLatencyOutlier, 20, 50000, 2).p95ElapsedMs, 1900);
  const oneMemoryOutlier = samples.map((s, index) => ({ ...s,
    memory: { proven: true, incrementalPeakRssBytes: index === 19 ? 512 * 1024 * 1024 + 1 : 100 } }));
  assert.equal(aggregate(oneMemoryOutlier, 20, 50000, 2).gates.memory, 'failed');
  for (const incomplete of [[sample], [sample, { status: 'timeout', censored: true }]]) {
    const result = aggregate(incomplete, 20, 50000, 2);
    assert.equal(result.p95ElapsedMs, null);
    assert.equal(result.gates.latency, 'unproven');
    assert.equal(result.gates.memory, 'unproven');
  }
  assert.equal(aggregate([sample], 1, 120, 2).gates.latency, 'not_applicable');
});

test('actual native compact classifications survive the 200 explanation page and full source history is aggregated', () => {
  const request = structuredClone(fixture.request);
  const source = request.transactions[0];
  request.calendars = [];
  request.rules[0].inactive = false;
  request.transactions = Array.from({ length: 240 }, (_, index) => ({ ...structuredClone(source),
    id: `target-${String(index).padStart(3, '0')}`, occurrenceId: `target-${String(index).padStart(3, '0')}`,
    importedId: null, categoryId: index < 12 ? 'category-food' : null,
  }));
  request.sourceAdmission.originalTransactionCount = 240;
  request.suggestionSelection = { transactionIds: request.transactions.filter((tx) => tx.categoryId === null).map((tx) => tx.id), cursor: null, limit: 200 };
  const native = createRequire(import.meta.url)(path.join(ROOT, 'crates/node-binding/balanceframe.node'));
  const result = JSON.parse(native.analyzeMerchantIntelligence(JSON.stringify(request)));
  const summary = summarizeResponse(result, request);
  assert.equal(summary.resultCounts.suggestions, 200);
  assert.equal(summary.resultCounts.nativeRuleClassifications, 228);
  assert.deepEqual(result.nativeRuleClassifications.map((row) => row.transactionId), request.suggestionSelection.transactionIds);
  assert.deepEqual(result.nativeRuleBlocks, [{ ruleIds: ['rule-inactive-fixture'] }]);
  assert.deepEqual(result.nativeRuleParts, [{ blockIndexes: [0] }]);
  assert.deepEqual(result.nativeRuleSets, [{ orPartIndexes: [], andPartIndexes: [[0], [0], [0], [0]], categoryPartIndex: 0 }]);
  assert.deepEqual(summary.nativeRuleSets, result.nativeRuleSets);
  assert.deepEqual(summary.nativeRuleBlocks, result.nativeRuleBlocks);
  assert.deepEqual(summary.nativeRuleParts, result.nativeRuleParts);
  assert(result.nativeRuleClassifications.every((row) =>
    row.categoryId === 'category-food' && row.accountId === 'account-checking' &&
    row.ruleSetIndex === 0 && !Object.hasOwn(row, 'ruleIds')));
  assert.equal(result.suggestions[0].categoryHistory.totalCount, 12);
  assert.deepEqual(result.suggestionPage, { eligibleCandidates: 228, returned: 200, nextCursor: 'target-211' });
  assert.equal(result.coverage.inputCount, 240);
  assert.equal(result.coverage.eligibleCount, 240);
  assert.equal(result.recurrences.length, 1);
  assert.equal(result.recurrences[0].occurrences, 240);
  assert.equal(result.recurrences[0].currency, 'USD');
  assert.deepEqual(result.recurrences[0].minimumAmount, { minorUnits: '-100', currency: 'USD' });
  assert.deepEqual(result.recurrences[0].maximumAmount, { minorUnits: '-100', currency: 'USD' });
  const corrupt = structuredClone(result);
  corrupt.suggestions[0].transactionId = 'unknown-target';
  assert.throws(() => summarizeResponse(corrupt, request));
  corrupt.suggestions[0].transactionId = result.suggestions[0].transactionId;
  corrupt.coverage.eligibleCount--;
  assert.throws(() => summarizeResponse(corrupt, request));
  const wrongCurrency = structuredClone(result);
  wrongCurrency.recurrences[0].currency = 'GBP';
  assert.throws(() => summarizeResponse(wrongCurrency, request));
});

test('real current native smoke reports timings, bounded output, source coverage and reference runtime discrepancy', async () => {
  const { stdout } = await execute(process.execPath, [runner, '--sizes', '96,120', '--iterations', '2', '--deadline-ms', '30000'],
    { cwd: ROOT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.native.method, 'analyzeMerchantIntelligence');
  assert.equal(report.environment.node, process.version);
  assert.equal(report.environment.baselineNode, 'v24.11.1');
  assert.equal(report.environment.identicalBaselineRuntime, process.version === 'v24.11.1');
  assert(report.environment.allowedCpuCount <= 2);
  for (const dataset of report.datasets) {
    assert.equal(dataset.completedIterations, 2);
    assert.equal(dataset.completedWarmups, 2);
    assert.equal(dataset.gates.latency, 'not_applicable');
    assert.equal(new Set(dataset.samples.map((sample) => sample.inputSha256)).size, 1);
    for (const sample of dataset.samples) {
      assert.equal(sample.summary.coverage.inputCount, dataset.prepared.originalTransactionCount);
      assert.equal(dataset.prepared.admittedTransactionCount, dataset.requestedTransactions);
      assert.equal(sample.summary.coverage.limited, dataset.prepared.invalidSourceOmittedCount > 0);
      assert.equal(sample.summary.coverage.eligibleCount + sample.summary.coverage.excludedCount, dataset.prepared.originalTransactionCount);
      assert.equal(sample.summary.resultCounts.nativeRuleClassifications, 0); // Seed has no rules; no generated fake rules.
      assert.equal(sample.elapsedMs, sample.jsSerializationMs + sample.nativeElapsedMs);
      assert(sample.summary.resultCounts.suggestions <= 200);
      assert(sample.responseBytes > 0 && sample.requestBytes > 0);
      assert.match(sample.inputSha256, /^[a-f0-9]{64}$/);
      assert(Number.isFinite(sample.jsResponseParseMs));
      assert.equal(typeof sample.memory.proven, 'boolean');
      assert.equal(sample.memory.observer, 'parent-stopped-child');
      assert(Number.isSafeInteger(sample.memory.observedPid) && sample.memory.observedPid > 0);
      assert.equal(sample.memory.allThreadsStopped, true);
      assert.equal(sample.memory.responseParseDeferred, true);
    }
  }
});

test('real deadline is censored and cannot produce release gates', async () => {
  const { stdout, code } = await execute(process.execPath, [runner, '--sizes', '250000', '--iterations', '20', '--deadline-ms', '1'],
    { cwd: ROOT, timeout: 10000, maxBuffer: 1024 * 1024 }).catch((error) => error);
  assert.equal(code, 2); // Report is retained, but an unproven reference run is not a successful gate.
  const dataset = JSON.parse(stdout).datasets[0];
  assert.equal(dataset.completedIterations, 0);
  assert.equal(dataset.p95ElapsedMs, null);
  assert.equal(dataset.gates.latency, 'unproven');
  assert.equal(dataset.gates.memory, 'unproven');
  assert.equal(dataset.terminationReason, 'deadline_exceeded_stop_dataset');
});

test('current correctness summary preserves shared IDs and rejects invalid indexes or source rule namespaces', () => {
  const request = structuredClone(fixture.request);
  request.rules[0].inactive = false;
  request.suggestionSelection = { transactionIds: ['tx-source'], cursor: null, limit: 200 };
  const response = structuredClone(fixture.result);
  response.suggestionPage = { eligibleCandidates: 1, returned: 1, nextCursor: null };
  response.nativeRuleBlocks = [{ ruleIds: ['rule-inactive-fixture'] }];
  response.nativeRuleParts = [{ blockIndexes: [0] }];
  response.nativeRuleSets = [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }];
  response.nativeRuleClassifications = [{
    transactionId: 'tx-source', accountId: 'account-checking', categoryId: 'category-food', ruleSetIndex: 0,
  }];
  const summary = summarizeResponse(response, request);
  assert.deepEqual(summary.nativeRuleSets, response.nativeRuleSets);
  assert.deepEqual(summary.nativeRuleBlocks, response.nativeRuleBlocks);
  assert.deepEqual(summary.nativeRuleParts, response.nativeRuleParts);
  assert.deepEqual(summary.nativeRuleClassifications, response.nativeRuleClassifications);
  for (const mutate of [
    (result) => { delete result.nativeRuleSets; },
    (result) => { result.nativeRuleSets = []; },
    (result) => { delete result.nativeRuleBlocks; },
    (result) => { result.nativeRuleBlocks = []; },
    (result) => { delete result.nativeRuleParts; },
    (result) => { result.nativeRuleParts = []; },
    (result) => { result.nativeRuleParts[0].blockIndexes = []; },
    (result) => { result.nativeRuleParts[0].blockIndexes = [0, 0]; },
    (result) => { result.nativeRuleParts[0].blockIndexes = [1]; },
    (result) => { result.nativeRuleParts[0].blockIndexes = [-1]; },
    (result) => { result.nativeRuleParts[0].blockIndexes = [0.5]; },
    (result) => { result.nativeRuleParts[0].blockIndexes = ['0']; },
    (result) => { result.nativeRuleSets[0].orPartIndexes = []; },
    (result) => { result.nativeRuleSets[0].andPartIndexes = [[0], [0]]; },
    (result) => { result.nativeRuleSets[0].categoryPartIndex = 1; },
    (result) => { result.nativeRuleSets[0].ruleIds = ['rule-inactive-fixture']; },
    (result) => { result.nativeRuleBlocks.push({ ...result.nativeRuleBlocks[0] }); },
    (result) => { result.nativeRuleClassifications[0].ruleSetIndex = 1; },
    (result) => { result.nativeRuleClassifications[0].ruleSetIndex = -1; },
    (result) => { result.nativeRuleClassifications[0].ruleSetIndex = 0.5; },
    (result) => { result.nativeRuleClassifications[0].ruleSetIndex = '0'; },
    (result) => { delete result.nativeRuleClassifications[0].ruleSetIndex; },
    (result) => { result.nativeRuleClassifications[0].ruleIds = ['rule-inactive-fixture']; },
    (result) => { result.nativeRuleBlocks[0].ruleIds = []; },
    (result) => { result.nativeRuleBlocks[0].ruleIds = ['rule-inactive-fixture', 'rule-inactive-fixture']; },
    (result) => { result.nativeRuleBlocks[0].ruleIds = ['not-in-admitted-source']; },
    (result) => { result.nativeRuleClassifications[0].accountId = 'not-in-admitted-source'; },
    (result) => { result.nativeRuleClassifications[0].categoryId = 'not-in-admitted-source'; },
    (result) => { result.nativeRuleClassifications.push({ ...result.nativeRuleClassifications[0] }); },
  ]) {
    const invalid = structuredClone(response);
    mutate(invalid);
    assert.throws(() => summarizeResponse(invalid, request));
  }
});
