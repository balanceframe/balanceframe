import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { merchantAnalysisRequestSchema } from '../../packages/protocol-generated/src/merchant-validators.ts';

const canonical = JSON.parse(readFileSync(new URL('../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8')).request;
const SEED = 110042;
const AS_OF = '2026-10-04';
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const field = (state, value = null) => ({ state, value });
const present = (value) => field('present', value);
const variants = ['stable-id', 'stable-id-secondary', 'case', 'unicode-punctuation', 'bank-wrapper', 'notes-only', 'multi-field', 'cross-context', 'empty', 'unsupported', 'conflicting', 'collision'];

export function generateSyntheticCorpus() {
  // Scenario truth and proportions are frozen independently of any classifier output.
  let state = SEED;
  const nextUnits = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return String(-(100 + state % 200000));
  };
  const adjectives = ['Aster', 'Beryl', 'Cinder', 'Dapple', 'Élan', 'Fable', 'Glimmer', 'Hesper', 'Ilex', 'Jasper', 'Kestrel', 'Lumen', 'Morrow', 'Nacre', 'Opal', 'Pollen', 'Quill', 'Rill', 'Sable', 'Tansy'];
  const nouns = ['Atelier', 'Depot', 'Grove', 'Studio', 'Workshop'];
  const merchantCatalog = Array.from({ length: 100 }, (_, index) => ({
    id: `synthetic-merchant-${String(index).padStart(3, '0')}`,
    name: index === 78 ? 'Quorin—Depot' : index === 79 ? 'QUORIN DEPOT' : `${adjectives[Math.floor(index / 5)]} ${nouns[index % 5]}`,
  }));
  const payees = merchantCatalog.map((merchant) => ({ ...merchant, transferAccountId: null, mtid: null }));
  const categories = structuredClone(canonical.categories);
  // Categories are assigned by synthetic scenario identity, never by generated names or engine predictions.
  const categoryFor = (index) => categories[index % categories.length].id;
  const secondary = (index) => ({
    accountId: 'synthetic-account-B', currency: index >= 60 && index < 80 ? 'CAD' : 'USD',
    incoming: index >= 40 && index < 60,
  });
  const transaction = (id, date, merchant = null, options = {}) => ({
    id, accountId: 'synthetic-account-A', date, payeeId: merchant?.id ?? null,
    payeeName: merchant?.name ?? null, categoryId: null,
    amount: { minorUnits: nextUnits(), currency: 'USD' }, cleared: true, reconciled: false,
    importedId: `synthetic-import-${id}`, importedPayee: field('absent'),
    description: field('unsupported'), verboseTitle: field('unsupported'), notes: field('absent'),
    isSplitParent: false, isSplitChild: false, parentId: null, occurrenceId: id,
    occurrenceComplete: true, startingBalance: false, transferAccountId: null, deleted: false, pending: false,
    ...options,
  });
  const history = (prefix, index) => Array.from({ length: 6 }, (_, sample) => {
    const context = sample < 3 ? { accountId: 'synthetic-account-A', currency: 'USD', incoming: false } : secondary(index);
    const units = nextUnits();
    return transaction(`${prefix}-history-${index}-${sample}`, `2025-${String(4 + sample).padStart(2, '0')}-15`, merchantCatalog[index], {
      accountId: context.accountId, categoryId: categoryFor(index),
      amount: { minorUnits: context.incoming ? units.slice(1) : units, currency: context.currency },
      importedPayee: present(merchantCatalog[index].name),
    });
  });
  const requestFor = (id, transactions, changes = {}) => {
    const sourceAccountIds = [...new Set(transactions.map((row) => row.accountId))].sort();
    const sourceCategoryIds = categories.map((category) => category.id);
    const sourceAdmission = {
      capturedAt: `${AS_OF}T12:00:00Z`, factsHash: `sha256:${hash({ transactions, payees, categories, ...changes })}`,
      expiresAt: '2026-10-05T12:00:00Z',
      collections: { transactions: 'complete', payees: 'complete', categories: 'complete', rules: 'complete', schedules: 'complete' },
      accountCoverage: sourceAccountIds.map((accountId) => ({ accountId, state: 'complete', startDate: '2020-01-01', endDate: AS_OF, currencyState: 'known' })),
      pendingState: transactions.some((row) => row.pending) ? 'included' : 'excluded',
      originalTransactionCount: transactions.length, truncatedCount: 0,
      visibilityHash: `sha256:${hash({ sourceAccountIds, sourceCategoryIds })}`, sourceAccountIds, sourceCategoryIds,
    };
    return merchantAnalysisRequestSchema.parse({
      schemaVersion: '1', scope: { spaceId: 'synthetic-space', budgetId: 'synthetic-budget', connectionId: 'synthetic-connection' },
      snapshotId: `synthetic-${id}`, asOfDate: AS_OF, normalizationVersion: 'merchant/2', sourceAdmission,
      transactions, payees: structuredClone(payees), categories: structuredClone(categories), rules: [], aliases: [], corrections: [],
      schedules: [], patternDecisions: [], calendars: [], horizonYears: 5, maxEvidence: 20, ...changes,
    });
  };
  const requests = [];
  const training = merchantCatalog.slice(0, 80).flatMap((_, index) => history('categorization', index));
  const holdouts = [];
  const labels = [];
  for (let index = 0; index < 100; index += 1) {
    for (let variant = 0; variant < variants.length; variant += 1) {
      const merchant = merchantCatalog[index];
      const id = `synthetic-holdout-${String(index).padStart(3, '0')}-${String(variant).padStart(2, '0')}`;
      const date = variant % 2 === 0 ? `2026-01-${String(2 + index % 27).padStart(2, '0')}` : `2026-09-${String(1 + index % 28).padStart(2, '0')}`;
      const row = transaction(id, date, variant < 2 ? merchant : null);
      if (variant === 1 || variant === 7) {
        const context = secondary(index);
        row.accountId = context.accountId;
        row.amount.currency = context.currency;
        if (context.incoming) row.amount.minorUnits = row.amount.minorUnits.slice(1);
      }
      if (variant === 2) row.importedPayee = present(merchant.name.toLowerCase());
      if (variant === 3) row.importedPayee = present(`  ${merchant.name.replaceAll(' ', '—')}  `);
      if (variant === 4) row.importedPayee = present(`POS ${merchant.name}`);
      if (variant === 5) row.notes = present(merchant.name);
      if (variant === 6) {
        row.importedPayee = present(merchant.name.toLowerCase());
        row.notes = present(merchant.name.toUpperCase());
      }
      if (variant === 7) row.importedPayee = present(merchant.name);
      if (variant === 8) {
        row.importedPayee = field('empty', '');
        row.notes = field('empty', '');
      }
      if (variant === 9) {
        for (const key of ['importedPayee', 'description', 'verboseTitle', 'notes']) row[key] = field('unsupported');
      }
      if (variant === 10) {
        row.importedPayee = present(merchant.name);
        row.notes = present(merchantCatalog[(index + 17) % 78].name);
      }
      if (variant === 11) row.importedPayee = present('quorin depot');
      const ambiguous = variant >= 10;
      const suggest = index < 80 && variant < 8 && !(index >= 78 && variant >= 2);
      labels.push({
        transactionId: id, merchantId: ambiguous ? null : merchant.id,
        categoryId: suggest ? categoryFor(index) : null, expected: suggest ? 'suggest' : 'abstain',
        tags: [variants[variant], index < 80 ? 'history-present' : 'heldout-merchant', variant % 2 === 0 ? 'temporal-early' : 'temporal-late', ...(variant >= 2 ? ['sparse'] : [])],
        overrideCategoryId: null,
      });
      holdouts.push(row);
    }
  }
  requests.push({ id: 'categorization-holdout', kind: 'categorization', request: requestFor('categorization-holdout', [...training, ...holdouts]), trainingIds: training.map((row) => row.id), labels, recurrenceLabels: [] });

  const addRecurrence = (name, dates, frequency, established, options = {}) => {
    const id = `recurrence-${name}`;
    const rows = dates.map((date, index) => transaction(`${id}-${index}`, date, merchantCatalog[0], { amount: { minorUnits: '-1200', currency: 'USD' }, ...options }));
    const recurrenceLabels = [{ accountId: 'synthetic-account-A', payeeId: merchantCatalog[0].id, currency: 'USD', direction: 'outgoing', frequency, established }];
    const entry = { id, kind: 'recurrence', request: null, trainingIds: [], labels: [], recurrenceLabels };
    const finish = () => { entry.request = requestFor(id, rows); requests.push(entry); };
    return { rows, recurrenceLabels, finish };
  };
  addRecurrence('weekly', ['2026-01-04', '2026-01-11', '2026-01-18', '2026-01-25', '2026-02-01'], 'weekly', true).finish();
  addRecurrence('monthly', ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'], 'monthly', true).finish();
  addRecurrence('end-month', ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30'], 'monthly', true).finish();
  addRecurrence('annual-provisional', ['2025-05-12', '2026-05-12'], 'annual', false).finish();
  addRecurrence('annual-established', ['2024-05-12', '2025-05-12', '2026-05-12'], 'annual', true).finish();
  addRecurrence('irregular', ['2026-01-03', '2026-01-22', '2026-03-04', '2026-06-19'], null, false).finish();
  addRecurrence('same-day', ['2026-03-10', '2026-03-10', '2026-03-10', '2026-03-10'], null, false).finish();
  const refund = addRecurrence('refund', ['2026-01-15', '2026-02-15', '2026-03-15'], 'monthly', true);
  refund.rows.push(...refund.rows.map((row, index) => transaction(`recurrence-refund-incoming-${index}`, row.date, merchantCatalog[0], { amount: { minorUnits: '1200', currency: 'USD' } })));
  refund.recurrenceLabels.push({ ...refund.recurrenceLabels[0], direction: 'incoming' });
  refund.finish();
  const currencies = addRecurrence('currency-separated', ['2026-01-15', '2026-02-15'], 'monthly', false);
  currencies.rows.push(...currencies.rows.map((row, index) => transaction(`recurrence-currency-separated-CAD-${index}`, row.date, merchantCatalog[0], { amount: { minorUnits: '-1200', currency: 'CAD' } })));
  currencies.recurrenceLabels.push({ ...currencies.recurrenceLabels[0], currency: 'CAD' });
  currencies.finish();
  const split = addRecurrence('split', ['2026-01-15', '2026-02-15', '2026-03-15'], 'monthly', true, { isSplitParent: true });
  split.rows.push(...split.rows.flatMap((parent) => [0, 1].map((child) => transaction(`${parent.id}-child-${child}`, parent.date, merchantCatalog[0], {
    amount: { minorUnits: '-600', currency: 'USD' }, isSplitChild: true, parentId: parent.id, occurrenceId: parent.id,
  }))));
  split.finish();
  for (const [name, options] of [
    ['transfer', { transferAccountId: 'synthetic-transfer-target' }], ['opening', { startingBalance: true }],
    ['deleted', { deleted: true }], ['pending', { pending: true }], ['uncleared', { cleared: false }],
    ['incomplete-occurrence', { occurrenceComplete: false }],
  ]) addRecurrence(name, ['2026-01-15', '2026-02-15', '2026-03-15'], null, false, options).finish();
  addRecurrence('leap', ['2024-02-29', '2025-02-28', '2026-02-28'], 'annual', true).finish();
  addRecurrence('dst', ['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22'], 'weekly', true).finish();
  addRecurrence('zero', ['2026-01-15', '2026-02-15', '2026-03-15'], null, false, { amount: { minorUnits: '0', currency: 'USD' } }).finish();

  const boundaryNames = ['ledger-override', 'confirmed-correction', 'native-rule-override', 'accepted-alias', 'rejected-alias', 'revoked-correction', 'money-zero', 'money-min', 'money-max', 'outside-horizon'];
  for (const [index, name] of boundaryNames.entries()) {
    const id = `boundary-${name}`;
    const txId = `${id}-holdout`;
    const histories = index < 6 ? history(id, 0) : [];
    const row = transaction(txId, name === 'outside-horizon' ? '2020-10-03' : '2026-09-15', index < 6 ? merchantCatalog[0] : null);
    const changes = {};
    const overrideCategoryId = index < 3 ? categories[1].id : null;
    let categoryId = index < 3 ? categories[1].id : index === 3 || index === 5 ? categoryFor(0) : null;
    if (name === 'ledger-override') row.categoryId = overrideCategoryId;
    if (name === 'confirmed-correction' || name === 'revoked-correction') changes.corrections = [{
      transactionId: txId, payeeId: merchantCatalog[0].id, accountId: row.accountId, categoryId: categories[1].id,
      state: name === 'confirmed-correction' ? 'confirmed' : 'revoked', verified: true, actorId: 'synthetic-actor', version: 1,
    }];
    if (name === 'native-rule-override') changes.rules = [{
      id: 'synthetic-boundary-rule', name: 'Synthetic explicit category rule', order: 1, inactive: false,
      trigger: { stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: merchantCatalog[0].id, type: 'id' }] },
      actions: [{ field: 'category', op: 'set', value: categories[1].id, type: 'id' }],
    }];
    if (name === 'accepted-alias' || name === 'rejected-alias') {
      row.payeeId = null;
      row.payeeName = null;
      row.importedPayee = present('Synthetic checkout descriptor');
      changes.aliases = [{
        id: `synthetic-alias-${name}`, sourceText: row.importedPayee.value, sourceField: 'importedPayee', targetPayeeId: merchantCatalog[0].id,
        accountId: row.accountId, state: name === 'accepted-alias' ? 'accepted' : 'rejected', actorId: 'synthetic-actor', version: 1,
        updatedAt: '2026-09-16T12:00:00Z', sourceTransactionIds: [txId],
      }];
    }
    const exactMoney = { 'money-zero': '0', 'money-min': '-9223372036854775808', 'money-max': '9223372036854775807' };
    if (name in exactMoney) row.amount.minorUnits = exactMoney[name];
    requests.push({
      id, kind: 'boundary', request: requestFor(id, [row, ...histories], changes), trainingIds: histories.map((sample) => sample.id),
      labels: [{ transactionId: txId, merchantId: index < 6 ? merchantCatalog[0].id : null, categoryId, expected: categoryId === null ? 'abstain' : 'suggest', tags: [name, 'boundary'], overrideCategoryId }],
      recurrenceLabels: [],
    });
  }
  return {
    schemaVersion: '1',
    provenance: {
      kind: 'synthetic', generatorVersion: 'merchant-quality-synthetic/1', seed: SEED,
      trainingCutoff: '2026-01-01', holdoutStart: '2026-01-02', asOfDate: AS_OF,
      limitations: [
        'Synthetic scenario evidence only; does not establish population or real-world accuracy or natural case prevalence.',
        'Authorization, privacy, governance and browser disclosure are not measured by this engine corpus.',
        'No configured calendar or national holidays; Gregorian civil dates are known, business-calendar effects remain uncertain.',
        'Names and identities are invented combinations; categories and recurrence expectations are independent scenario truth, not classifier-derived labels.',
      ],
    },
    merchantCatalog, requests,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output' || !process.argv[3]) {
    throw new Error('Usage: node scripts/merchant-intelligence/synthetic-corpus.mjs --output protocol/fixtures/merchant-quality.synthetic.json');
  }
  const corpus = generateSyntheticCorpus();
  const serialized = `${JSON.stringify(corpus, null, 2)}\n`;
  // Exclusive creation prevents accidental replacement of a corpus frozen before evaluation.
  writeFileSync(process.argv[3], serialized, { flag: 'wx' });
  console.log(JSON.stringify({
    kind: corpus.provenance.kind, seed: SEED, merchants: corpus.merchantCatalog.length,
    heldout: corpus.requests.filter((entry) => entry.kind === 'categorization').reduce((sum, entry) => sum + entry.labels.length, 0),
    requests: corpus.requests.length, sha256: hash(serialized), output: process.argv[3],
  }));
}
