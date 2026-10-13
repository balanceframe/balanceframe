import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { merchantAnalysisRequestSchema } from '../../packages/protocol-generated/src/merchant-validators.ts';
import { generateSyntheticCorpus } from './synthetic-corpus.mjs';

const canonical = JSON.parse(readFileSync(new URL('../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8')).request;
const variants = ['stable-id', 'stable-id-secondary', 'case', 'unicode-punctuation', 'bank-wrapper', 'notes-only', 'multi-field', 'cross-context', 'empty', 'unsupported', 'conflicting', 'collision'];
const recurrenceCases = ['weekly', 'monthly', 'end-month', 'annual-provisional', 'annual-established', 'irregular', 'same-day', 'refund', 'currency-separated', 'split', 'transfer', 'opening', 'deleted', 'pending', 'uncleared', 'incomplete-occurrence', 'leap', 'dst', 'zero'];
const boundaryCases = ['ledger-override', 'confirmed-correction', 'native-rule-override', 'accepted-alias', 'rejected-alias', 'revoked-correction', 'money-zero', 'money-min', 'money-max', 'outside-horizon'];
const categoryFor = (index) => canonical.categories[index % canonical.categories.length].id;
const entries = (corpus, kind) => corpus.requests.filter((entry) => entry.kind === kind);
const labels = (corpus, kind) => entries(corpus, kind).flatMap((entry) => entry.labels);
const rowFor = (entry, id) => entry.request.transactions.find((row) => row.id === id);

// Frozen challenge distribution, not an estimate of natural transaction prevalence.
test('fixed synthetic provenance and independently authored category truth are reproducible', () => {
  const first = generateSyntheticCorpus();
  assert.deepEqual(first, generateSyntheticCorpus());
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.schemaVersion, '1');
  assert.equal(first.provenance.kind, 'synthetic');
  assert.equal(first.provenance.generatorVersion, 'merchant-quality-synthetic/1');
  assert.equal(first.provenance.seed, 110042);
  assert.equal(first.provenance.trainingCutoff, '2026-01-01');
  assert.equal(first.provenance.holdoutStart, '2026-01-02');
  assert.equal(first.provenance.asOfDate, '2026-10-04');
  assert(first.provenance.limitations.some((text) => /real.world/i.test(text)));
  assert(first.provenance.limitations.some((text) => /authorization|privacy/i.test(text)));
  assert(first.provenance.limitations.some((text) => /calendar/i.test(text)));
  assert.equal(first.merchantCatalog.length, 100);
  assert.equal(new Set(first.merchantCatalog.map((merchant) => merchant.id)).size, 100);
  for (const label of labels(first, 'categorization').filter((label) => label.expected === 'suggest')) {
    const index = first.merchantCatalog.findIndex((merchant) => merchant.id === label.merchantId);
    assert.equal(label.categoryId, categoryFor(index));
  }
});

test('frozen population includes 1200 unique holdouts, 480 training rows and exact challenge strata', () => {
  const corpus = generateSyntheticCorpus();
  const heldout = labels(corpus, 'categorization');
  assert.equal(heldout.length, 1200);
  assert.equal(new Set(heldout.map((label) => label.transactionId)).size, 1200);
  assert.equal(new Set(heldout.flatMap((label) => label.merchantId === null ? [] : [label.merchantId])).size, 100);
  assert.equal(entries(corpus, 'categorization').flatMap((entry) => entry.trainingIds).length, 480);
  for (const variant of variants) assert.equal(heldout.filter((label) => label.tags.includes(variant)).length, 100, variant);
  for (const [tag, count] of [['sparse', 1000], ['history-present', 960], ['heldout-merchant', 240], ['temporal-early', 600], ['temporal-late', 600]]) {
    assert.equal(heldout.filter((label) => label.tags.includes(tag)).length, count, tag);
  }
  assert.equal(heldout.filter((label) => label.expected === 'suggest').length, 628);
  assert.equal(heldout.filter((label) => label.expected === 'abstain').length, 572);
  assert.equal(heldout.filter((label) => label.tags.includes('collision') || label.tags.includes('conflicting')).filter((label) => label.merchantId === null).length, 200);
  assert.equal(new Set(corpus.requests.map((entry) => entry.id)).size, corpus.requests.length);
  const allRows = corpus.requests.flatMap((entry) => entry.request.transactions);
  assert.equal(new Set(allRows.map((row) => row.id)).size, allRows.length);
  assert.equal(new Set(allRows.map((row) => `${row.accountId}:${row.importedId}`)).size, allRows.length);
  const crossContext = entries(corpus, 'categorization').flatMap((entry) => entry.labels
    .filter((label) => label.tags.includes('cross-context') && label.tags.includes('history-present'))
    .map((label) => rowFor(entry, label.transactionId)));
  assert.equal(crossContext.filter((row) => row.amount.currency === 'USD' && BigInt(row.amount.minorUnits) < 0n).length, 40);
  assert.equal(crossContext.filter((row) => row.amount.currency === 'USD' && BigInt(row.amount.minorUnits) > 0n).length, 20);
  assert.equal(crossContext.filter((row) => row.amount.currency === 'CAD' && BigInt(row.amount.minorUnits) < 0n).length, 20);
});

test('training, merchant holdout and temporal holdout remain disjoint with truth outside native inputs', () => {
  const corpus = generateSyntheticCorpus();
  const catalogIds = new Set(corpus.merchantCatalog.map((merchant) => merchant.id));
  const seen = new Set();
  const withheld = new Set(corpus.merchantCatalog.slice(80).map((merchant) => merchant.id));
  for (const entry of entries(corpus, 'categorization')) {
    const trainingIds = new Set(entry.trainingIds);
    assert.equal(entry.request.rules.length, 0);
    assert.equal(entry.request.aliases.length, 0);
    assert.equal(entry.request.corrections.length, 0);
    for (const id of trainingIds) {
      const row = rowFor(entry, id);
      assert(row && row.categoryId !== null);
      assert(row.date < corpus.provenance.trainingCutoff);
      assert(!withheld.has(row.payeeId));
      seen.add(row.payeeId);
    }
    for (const label of entry.labels) {
      assert(!trainingIds.has(label.transactionId));
      assert(label.merchantId === null || catalogIds.has(label.merchantId));
      const row = rowFor(entry, label.transactionId);
      assert(row);
      assert.equal(row.categoryId, null);
      assert.equal(label.overrideCategoryId, null);
      assert(row.date >= corpus.provenance.holdoutStart && row.date <= corpus.provenance.asOfDate);
      assert(row.date >= '2021-10-04');
      if (label.expected === 'suggest') {
        const support = entry.request.transactions.filter((sample) => trainingIds.has(sample.id)
          && sample.payeeId === label.merchantId && sample.accountId === row.accountId
          && sample.amount.currency === row.amount.currency
          && (BigInt(sample.amount.minorUnits) > 0n) === (BigInt(row.amount.minorUnits) > 0n)
          && sample.categoryId === label.categoryId);
        assert.equal(support.length, 3, `${label.transactionId}: independent history context`);
      }
      if (label.tags.includes('heldout-merchant')) assert.equal(label.expected, 'abstain');
      for (const key of ['merchantId', 'expected', 'tags', 'overrideCategoryId', 'truth', 'label']) assert(!(key in row));
    }
    // Relabeling cannot alter a serialized native input or inject target categories.
    const before = JSON.stringify(entry.request);
    for (const label of entry.labels) label.categoryId = 'independent-test-relabel';
    assert.equal(JSON.stringify(entry.request), before);
  }
  assert.equal(seen.size, 80);
  assert.deepEqual([...seen].sort(), corpus.merchantCatalog.slice(0, 80).map((merchant) => merchant.id).sort());
  for (const entry of corpus.requests) {
    for (const row of entry.request.transactions.filter((row) => row.categoryId !== null)) assert(!withheld.has(row.payeeId));
  }
});

test('every native request actually roundtrips the canonical validator and preserves source admission', () => {
  const corpus = generateSyntheticCorpus();
  for (const entry of corpus.requests) {
    const request = entry.request;
    assert.deepEqual(merchantAnalysisRequestSchema.parse(JSON.parse(JSON.stringify(request))), request, entry.id);
    assert.equal(request.sourceAdmission.originalTransactionCount, request.transactions.length);
    assert.equal(request.sourceAdmission.truncatedCount, 0);
    assert.equal(request.sourceAdmission.collections.transactions, 'complete');
    assert.match(request.sourceAdmission.factsHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(request.sourceAdmission.visibilityHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(request.sourceAdmission.sourceCategoryIds, request.categories.map((category) => category.id));
    assert.deepEqual([...new Set(request.transactions.map((row) => row.accountId))].sort(), [...request.sourceAdmission.sourceAccountIds].sort());
    assert.equal(request.calendars.length, 0); // No invented holiday data.
    assert.deepEqual(request.categories, canonical.categories);
    for (const row of request.transactions) {
      assert.equal(typeof row.amount.minorUnits, 'string');
      assert.match(row.amount.minorUnits, /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/);
      const units = BigInt(row.amount.minorUnits);
      assert(units >= -9223372036854775808n && units <= 9223372036854775807n);
      for (const field of ['importedPayee', 'description', 'verboseTitle', 'notes']) {
        const { state, value } = row[field];
        if (state === 'present') assert(typeof value === 'string' && value.length > 0);
        else assert.equal(value, state === 'empty' ? '' : null);
      }
    }
  }
  const request = entries(corpus, 'categorization')[0].request;
  assert(new Set(request.transactions.map((row) => row.amount.minorUnits)).size > 100);
  assert.deepEqual([...new Set(request.transactions.map((row) => row.amount.currency))].sort(), ['CAD', 'USD']);
});

test('sparse text uses distinct real source fields and includes unsupported, empty and ambiguous evidence', () => {
  const corpus = generateSyntheticCorpus();
  for (const entry of entries(corpus, 'categorization')) {
    for (const label of entry.labels) {
      const row = rowFor(entry, label.transactionId);
      assert.equal(row.payeeId === null, label.tags.includes('sparse'));
      if (label.tags.includes('notes-only')) {
        assert.equal(row.importedPayee.state, 'absent');
        assert.equal(row.notes.state, 'present');
      }
      if (label.tags.includes('multi-field')) {
        assert.equal(row.importedPayee.state, 'present');
        assert.equal(row.notes.state, 'present');
        assert.notEqual(row.importedPayee.value, row.notes.value);
      }
      if (label.tags.includes('unsupported')) {
        for (const field of ['importedPayee', 'description', 'verboseTitle', 'notes']) assert.equal(row[field].state, 'unsupported');
        assert.equal(row.payeeName, null);
      }
      if (label.tags.includes('empty')) {
        assert.equal(row.importedPayee.state, 'empty');
        assert.equal(row.notes.state, 'empty');
        assert.equal(row.payeeName, null);
      }
      if (label.tags.includes('conflicting')) {
        assert.equal(row.importedPayee.state, 'present');
        assert.equal(row.notes.state, 'present');
        assert.notEqual(row.importedPayee.value.toLowerCase(), row.notes.value.toLowerCase());
        assert.equal(label.expected, 'abstain');
      }
    }
  }
  const pair = corpus.merchantCatalog.slice(78, 80);
  const normalize = (name) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  assert.notEqual(pair[0].name, pair[1].name);
  assert.equal(normalize(pair[0].name), normalize(pair[1].name));
  assert.notEqual(categoryFor(78), categoryFor(79));
});

test('separate frozen cadence scenarios cover positives, provisional annuals and concrete false-positive traps', () => {
  const corpus = generateSyntheticCorpus();
  const recurrence = entries(corpus, 'recurrence');
  assert.deepEqual(recurrence.map((entry) => entry.id), recurrenceCases.map((name) => `recurrence-${name}`));
  for (const entry of recurrence) {
    assert.equal(entry.labels.length, 0);
    assert.equal(entry.trainingIds.length, 0);
    assert(entry.recurrenceLabels.length > 0);
  }
  const byName = (name) => recurrence.find((entry) => entry.id === `recurrence-${name}`);
  for (const [name, frequency] of [['weekly', 'weekly'], ['monthly', 'monthly'], ['end-month', 'monthly'], ['annual-established', 'annual'], ['leap', 'annual'], ['dst', 'weekly'], ['split', 'monthly']]) {
    assert.equal(byName(name).recurrenceLabels[0].frequency, frequency);
    assert.equal(byName(name).recurrenceLabels[0].established, true);
  }
  assert.equal(byName('annual-provisional').request.transactions.length, 2);
  assert.deepEqual(byName('annual-provisional').recurrenceLabels.map((label) => [label.frequency, label.established]), [['annual', false]]);
  for (const name of ['irregular', 'same-day', 'transfer', 'opening', 'deleted', 'pending', 'uncleared', 'incomplete-occurrence', 'zero']) {
    assert(byName(name).recurrenceLabels.every((label) => label.frequency === null && label.established === false), name);
  }
  assert.deepEqual(byName('refund').recurrenceLabels.map((label) => label.direction).sort(), ['incoming', 'outgoing']);
  assert.deepEqual(byName('currency-separated').recurrenceLabels.map((label) => [label.currency, label.established]).sort(), [['CAD', false], ['USD', false]]);
  const splitRows = byName('split').request.transactions;
  assert.equal(splitRows.filter((row) => row.isSplitParent).length, 3);
  assert.equal(splitRows.filter((row) => row.isSplitChild).length, 6);
  for (const row of splitRows.filter((row) => row.isSplitChild)) {
    assert.equal(row.parentId, row.occurrenceId);
    assert(splitRows.some((parent) => parent.id === row.parentId && parent.isSplitParent));
  }
  assert(byName('leap').request.transactions.some((row) => row.date === '2024-02-29'));
  assert(byName('dst').request.transactions.some((row) => row.date === '2026-03-08'));
  for (const [name, field, value] of [['transfer', 'transferAccountId', 'synthetic-transfer-target'], ['opening', 'startingBalance', true], ['deleted', 'deleted', true], ['pending', 'pending', true], ['uncleared', 'cleared', false], ['incomplete-occurrence', 'occurrenceComplete', false]]) {
    assert(byName(name).request.transactions.every((row) => row[field] === value), name);
  }
});

test('boundary evidence includes independent confirmed overrides, revoked decisions and exact Money extrema', () => {
  const corpus = generateSyntheticCorpus();
  const boundary = entries(corpus, 'boundary');
  assert.deepEqual(boundary.map((entry) => entry.id), boundaryCases.map((name) => `boundary-${name}`));
  const byName = (name) => boundary.find((entry) => entry.id === `boundary-${name}`);
  for (const name of ['ledger-override', 'confirmed-correction', 'native-rule-override']) {
    const entry = byName(name);
    assert.equal(entry.labels.length, 1);
    assert.equal(entry.labels[0].overrideCategoryId, canonical.categories[1].id);
    assert.equal(entry.labels[0].categoryId, canonical.categories[1].id);
    assert(!entry.trainingIds.includes(entry.labels[0].transactionId));
  }
  assert.equal(rowFor(byName('ledger-override'), byName('ledger-override').labels[0].transactionId).categoryId, canonical.categories[1].id);
  assert.equal(byName('confirmed-correction').request.corrections[0].verified, true);
  assert.equal(byName('confirmed-correction').request.corrections[0].state, 'confirmed');
  assert.equal(byName('native-rule-override').request.rules[0].inactive, false);
  assert.equal(byName('accepted-alias').request.aliases[0].state, 'accepted');
  assert.equal(byName('rejected-alias').request.aliases[0].state, 'rejected');
  assert.equal(byName('rejected-alias').labels[0].expected, 'abstain');
  assert.equal(byName('revoked-correction').request.corrections[0].state, 'revoked');
  assert.equal(byName('revoked-correction').labels[0].overrideCategoryId, null);
  for (const [name, units] of [['money-zero', '0'], ['money-min', '-9223372036854775808'], ['money-max', '9223372036854775807']]) {
    assert.equal(byName(name).request.transactions[0].amount.minorUnits, units);
  }
  assert(byName('outside-horizon').request.transactions[0].date < '2021-10-04');
  assert.equal(byName('outside-horizon').labels[0].expected, 'abstain');
});
