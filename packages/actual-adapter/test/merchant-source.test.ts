import { readFileSync } from 'node:fs';
import type { APIScheduleEntity } from '@actual-app/api/models';
import type { TransactionEntity } from '@actual-app/core/types/models';
import { describe, expect, it, vi } from 'vitest';
import { merchantAnalysisRequestSchema } from '@balanceframe/protocol-generated/validators';
import {
  ActualMerchantSourceError,
  normalizeActualMerchantSource,
  type ActualMerchantSourceInput,
} from '../src/merchant-normalizer';
import { normalizeActualScheduleLiquiditySource } from '../src/liquidity-normalizer';
import { ActualConnector, type ActualClient } from '../src/connector';

const fixture = JSON.parse(readFileSync(
  new URL('../../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8',
)) as { request: unknown };
const canonical = merchantAnalysisRequestSchema.parse(fixture.request);
const specimen = canonical.transactions[0]!;
const rawSpecimen: TransactionEntity = {
  id: specimen.id,
  account: specimen.accountId,
  date: specimen.date,
  amount: Number(specimen.amount.minorUnits),
  payee: specimen.payeeId,
  cleared: specimen.cleared,
  reconciled: specimen.reconciled,
  imported_id: specimen.importedId!,
  imported_payee: specimen.importedPayee.value!,
  notes: specimen.notes.value!,
};

function row(fields: Partial<TransactionEntity> = {}): TransactionEntity {
  return { ...rawSpecimen, ...fields };
}

function source(rows: TransactionEntity[] = [row()], overrides: Partial<ActualMerchantSourceInput> = {}): ActualMerchantSourceInput {
  return {
    capturedAt: canonical.sourceAdmission.capturedAt,
    expiresAt: canonical.sourceAdmission.expiresAt,
    currency: specimen.amount.currency,
    accounts: [{ id: specimen.accountId, name: 'Checking', closed: false, offbudget: false }],
    transactions: [{
      accountId: specimen.accountId, startDate: '2020-01-01', endDate: canonical.asOfDate,
      read: { state: 'complete', items: rows },
    }],
    payees: { state: 'complete', items: canonical.payees.map((payee) => ({
      id: payee.id, name: payee.name, transfer_acct: payee.transferAccountId,
    })) },
    categories: { state: 'complete', items: canonical.categories.map((category) => ({
      id: category.id, name: category.name, is_income: category.isIncome,
      hidden: false, group_id: 'group-living',
    })) },
    categoryGroups: [{ id: 'group-living', name: 'Living', is_income: false, hidden: false }],
    rules: { state: 'complete', items: [] },
    schedules: { state: 'complete', items: [] },
    admission: {
      visibilityHash: canonical.sourceAdmission.visibilityHash,
      accountIds: [specimen.accountId], categoryIds: canonical.categories.map((category) => category.id),
      transactionIds: null,
    },
    startDate: '2020-01-01', endDate: canonical.asOfDate, maxTransactions: 250_000,
    ...overrides,
  };
}

function split(): TransactionEntity[] {
  const first = row({ id: 'child-food', is_child: true, parent_id: 'split-parent', amount: -60, category: 'category-food' });
  const second = row({ id: 'child-bills', is_child: true, parent_id: 'split-parent', amount: -40, category: 'category-bills' });
  return [row({ id: 'split-parent', is_parent: true, subtransactions: [first, second] }), first, second];
}

function schedule(fields: Partial<APIScheduleEntity> = {}): APIScheduleEntity {
  return {
    id: 'schedule-market', name: 'Daily market', posts_transaction: true, completed: false,
    payee: specimen.payeeId!, account: specimen.accountId, rule: 'rule-schedule',
    amountOp: 'is', amount: -100, next_date: '2024-04-01',
    date: {
      frequency: 'daily', interval: 2, start: '2024-03-31', endMode: 'after_n_occurrences',
      endOccurrences: 5, skipWeekend: true, weekendSolveMode: 'after',
    },
    ...fields,
  };
}

function expectInvalid(input: ActualMerchantSourceInput, code: ActualMerchantSourceError['code'] = 'invalid_source'): void {
  let caught: unknown;
  try { normalizeActualMerchantSource(input); } catch (error: unknown) { caught = error; }
  expect(caught).toBeInstanceOf(ActualMerchantSourceError);
  expect(caught).toMatchObject({ code });
}

describe('Actual 26.10 merchant source normalization', () => {
  it('reuses the canonical imported-payee specimen without reconstructing a lossy legacy transaction', () => {
    const input = source();
    const before = structuredClone(input);
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions).toEqual([{
      ...specimen, verboseTitle: { state: 'unsupported', value: null },
    }]);
    expect(normalized.payees).toEqual(canonical.payees);
    expect(normalized.categories).toEqual(canonical.categories);
    expect(input).toEqual(before);
    expect(normalized.sourceAdmission).toMatchObject({
      capturedAt: input.capturedAt, expiresAt: input.expiresAt,
      pendingState: 'excluded', originalTransactionCount: 1, truncatedCount: 0,
      sourceAccountIds: [specimen.accountId],
      sourceCategoryIds: canonical.categories.map((category) => category.id).sort(),
      visibilityHash: input.admission.visibilityHash,
    });
    expect(normalized.sourceAdmission.factsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each(['imported_payee', 'notes'] as const)('preserves %s unsupported/absent/empty/present distinction without trimming raw evidence', (field) => {
    const outputField = field === 'notes' ? 'notes' : 'importedPayee';
    const absent = row();
    delete absent[field];
    const values = [
      absent,
      { ...row(), [field]: null } as unknown as TransactionEntity,
      row({ [field]: '' }),
      row({ [field]: '  Café—東京  ' }),
      row({ [field]: '   ' }),
    ];
    expect(values.map((value) => normalizeActualMerchantSource(source([value])).transactions[0]![outputField])).toEqual([
      { state: 'absent', value: null }, { state: 'absent', value: null },
      { state: 'empty', value: '' }, { state: 'present', value: '  Café—東京  ' },
      { state: 'present', value: '   ' },
    ]);
  });

  it('does not derive source hashes or evidence from source-denied transaction fields', () => {
    const input = source([row({ imported_payee: 'PRIVATE MERCHANT', notes: 'PRIVATE PERSON' })]);
    const denied = { ...input, admission: { ...input.admission, sourceTransactionIds: [] } };
    const normalized = normalizeActualMerchantSource(denied);
    expect(normalized.transactions[0]!.importedPayee).toEqual({ state: 'unavailable', value: null });
    expect(normalized.transactions[0]!.notes).toEqual({ state: 'unavailable', value: null });
    expect(normalized.transactions[0]!.importedId).toBeNull();
    const changed = structuredClone(denied);
    for (const read of changed.transactions) {
      for (const transaction of read.read.items) {
        transaction.imported_payee = 'DIFFERENT PRIVATE MERCHANT';
        transaction.notes = 'DIFFERENT PRIVATE PERSON';
        transaction.imported_id = 'DIFFERENT PRIVATE IMPORT';
      }
    }
    expect(normalizeActualMerchantSource(changed).sourceAdmission.factsHash).toBe(normalized.sourceAdmission.factsHash);
    expect(normalized.transactions[0]!.payeeId).toBe(specimen.payeeId);
    expect(normalized.transactions[0]!.amount).toEqual(specimen.amount);
  });

  it('admits raw fields only for exact selected transaction IDs while retaining other ledger facts', () => {
    const input = source([row(), row({ id: `${specimen.id}-other`, amount: -200 })]);
    input.admission.sourceTransactionIds = [specimen.id];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions.find((transaction) => transaction.id === specimen.id)).toMatchObject({
      importedPayee: specimen.importedPayee, notes: specimen.notes, importedId: specimen.importedId,
    });
    expect(normalized.transactions.find((transaction) => transaction.id === `${specimen.id}-other`)).toMatchObject({
      importedPayee: { state: 'unavailable', value: null }, notes: { state: 'unavailable', value: null },
      importedId: null, payeeId: specimen.payeeId, amount: { minorUnits: '-200', currency: specimen.amount.currency },
    });
    const changed = structuredClone(input);
    changed.transactions[0]!.read.items[0]!.notes = 'Admitted source change';
    expect(normalizeActualMerchantSource(changed).sourceAdmission.factsHash).not.toBe(normalized.sourceAdmission.factsHash);
  });

  it('retains privileged full-source compatibility for omitted and null raw-field masks', () => {
    const input = source();
    expect(normalizeActualMerchantSource({
      ...input, admission: { ...input.admission, sourceTransactionIds: null },
    })).toEqual(normalizeActualMerchantSource(input));
  });

  it('deduplicates rows differing only in denied source fields without a conflict or hash side channel', () => {
    const input = source();
    input.admission.sourceTransactionIds = [];
    const normalized = normalizeActualMerchantSource(input);
    input.transactions[0]!.read = { state: 'complete', items: [...input.transactions[0]!.read.items, row({
      imported_payee: 'Different private merchant', notes: 'Different private person', imported_id: 'different-import',
    })] };
    expect(normalizeActualMerchantSource(input)).toEqual(normalized);
    input.admission.sourceTransactionIds = [specimen.id];
    expectInvalid(input, 'conflicting_source_id');
  });

  it.each([
    { imported_payee: 123 }, { notes: {} }, { imported_id: 123 },
    { imported_payee: 'x'.repeat(4097) }, { notes: 'x'.repeat(4097) }, { imported_id: 'x'.repeat(257) },
  ])('does not validate denied raw values or let them influence duplicates: %j', (fields) => {
    const input = source();
    input.admission.sourceTransactionIds = [];
    const normalized = normalizeActualMerchantSource(input);
    input.transactions[0]!.read = { state: 'complete', items: [
      ...input.transactions[0]!.read.items, { ...row(), ...fields } as unknown as TransactionEntity,
    ] };
    expect(normalizeActualMerchantSource(input)).toEqual(normalized);
    input.admission.sourceTransactionIds = [specimen.id];
    expectInvalid(input);
  });

  it('never reads denied raw properties, including on nested split children', () => {
    const rows = split();
    const input = source(rows);
    input.admission.sourceTransactionIds = [];
    const normalized = normalizeActualMerchantSource(input);
    for (const transaction of rows) {
      for (const field of ['imported_payee', 'notes', 'imported_id']) {
        Object.defineProperty(transaction, field, { enumerable: true, get: () => { throw new Error('Denied raw field read'); } });
      }
    }
    expect(normalizeActualMerchantSource(input)).toEqual(normalized);
    expect(normalized.transactions.every((transaction) => transaction.importedPayee.state === 'unavailable'
      && transaction.notes.state === 'unavailable' && transaction.importedId === null)).toBe(true);
  });

  it('never promotes unknown SDK title/description/pending/raw fields into merchant facts', () => {
    const raw = { ...row(), description: 'invented', title: 'invented title', verbose_title: 'invented verbose',
      pending: true, raw_synced_data: '{"private":"bank payload"}' };
    const normalized = normalizeActualMerchantSource(source([raw])).transactions[0]!;
    expect(normalized.description).toEqual({ state: 'unsupported', value: null });
    expect(normalized.verboseTitle).toEqual({ state: 'unsupported', value: null });
    expect(normalized.pending).toBe(false);
    expect(normalized).not.toHaveProperty('raw_synced_data');
    expect(JSON.stringify(normalized)).not.toContain('bank payload');
  });

  it('keeps opaque payee IDs distinct even when display names collide or change', () => {
    const input = source([row(), row({ id: 'same-name-other-id', payee: 'payee-other' })]);
    input.payees.items[1]!.name = input.payees.items[0]!.name;
    const before = normalizeActualMerchantSource(input).transactions;
    expect(before.map((transaction) => transaction.payeeId)).toEqual(['payee-other', specimen.payeeId]);
    input.payees.items[0]!.name = 'User renamed display';
    const after = normalizeActualMerchantSource(input).transactions;
    expect(after.find((transaction) => transaction.id === specimen.id)).toMatchObject({
      payeeId: specimen.payeeId, payeeName: 'User renamed display', importedPayee: specimen.importedPayee,
    });
  });

  it('does not invent a display name or stable payee identity from imported text', () => {
    const normalized = normalizeActualMerchantSource(source([
      row({ id: 'missing-payee-lookup', payee: 'opaque-missing-id' }),
      row({ id: 'no-payee', payee: null }),
    ]));
    expect(normalized.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'missing-payee-lookup', payeeId: 'opaque-missing-id', payeeName: null }),
      expect.objectContaining({ id: 'no-payee', payeeId: null, payeeName: null }),
    ]));
  });

  it('preserves exact signed minor units, zero, and currencies without applying a decimal scale', () => {
    for (const currency of ['USD', 'JPY', 'KWD']) {
      const rows = [0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER].map((amount, index) => row({ id: `amount-${index}`, amount }));
      expect(normalizeActualMerchantSource(source(rows, { currency })).transactions.map((transaction) => transaction.amount)).toEqual(
        rows.map((transaction) => ({ minorUnits: String(transaction.amount), currency })),
      );
    }
  });

  it('retains tombstone, true starting_balance_flag, cleared/reconciled, and native transfer-account facts', () => {
    const input = source([
      row({ id: 'deleted', tombstone: true }),
      row({ id: 'flagged-opening', starting_balance_flag: true, cleared: false, reconciled: true }),
      row({ id: 'ordinary-starting-name', payee: 'payee-other', cleared: false, reconciled: false }),
      row({ id: 'transfer', payee: 'payee-transfer', transfer_id: 'counterpart-transaction-id' }),
    ]);
    input.payees.items[1]!.name = 'Starting Balance';
    input.payees.items.push({ id: 'payee-transfer', name: 'Savings', transfer_acct: 'account-savings' });
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deleted', deleted: true }),
      expect.objectContaining({ id: 'flagged-opening', startingBalance: true, cleared: false, reconciled: true, pending: false }),
      expect.objectContaining({ id: 'ordinary-starting-name', startingBalance: false, pending: false }),
      expect.objectContaining({ id: 'transfer', transferAccountId: 'account-savings' }),
    ]));
    expect(normalized.transactions.find((transaction) => transaction.id === 'transfer')!.transferAccountId).not.toBe('counterpart-transaction-id');
  });

  it('does not infer pending or cleared from missing optional SDK flags', () => {
    const raw = row();
    delete raw.cleared;
    delete raw.reconciled;
    expect(normalizeActualMerchantSource(source([raw])).transactions[0]).toMatchObject({
      startingBalance: false, cleared: false, reconciled: false, pending: false,
    });
  });

  it('distinguishes unavailable/partial reads from an authoritative empty source', () => {
    const empty = normalizeActualMerchantSource(source([]));
    expect(empty.sourceAdmission.collections.transactions).toBe('complete');
    const input = source([]);
    input.transactions[0]!.read = { state: 'unavailable', items: [] };
    input.payees = { state: 'unavailable', items: [] };
    input.rules = { state: 'partial', items: [] };
    input.schedules = { state: 'unavailable', items: [] };
    const unavailable = normalizeActualMerchantSource(input);
    expect(unavailable.sourceAdmission.collections).toMatchObject({
      transactions: 'unavailable', payees: 'unavailable', rules: 'partial', schedules: 'unavailable',
    });
    expect(unavailable.sourceAdmission.accountCoverage).toEqual([{
      accountId: specimen.accountId, state: 'unavailable', startDate: '2020-01-01', endDate: canonical.asOfDate, currencyState: 'known',
    }]);
    const lookupUnavailable = normalizeActualMerchantSource(source([row()], { payees: { state: 'unavailable', items: [] } }));
    expect(lookupUnavailable.transactions[0]).toMatchObject({ payeeId: specimen.payeeId, payeeName: null });
  });

  it('masks native payee identity before validation, matching and hashing', () => {
    const input = source();
    let privateReads = 0;
    const privatePayee = { id: 'payee-private', transfer_acct: null };
    Object.defineProperty(privatePayee, 'name', { enumerable: true, get: () => { privateReads += 1; throw new Error('PRIVATE PAYEE'); } });
    input.payees.items.push(privatePayee as unknown as ActualMerchantSourceInput['payees']['items'][number]);
    const masked = { ...input, admission: { ...input.admission, payeeIds: [specimen.payeeId!] } };
    const normalized = normalizeActualMerchantSource(masked);
    expect(normalized.payees.map((payee) => payee.id)).toEqual([specimen.payeeId]);
    expect(normalized.sourceAdmission.collections.payees).toBe('partial');
    expect(privateReads).toBe(0);
    input.payees.items = input.payees.items.filter((payee) => payee.id !== 'payee-private');
    expect(normalizeActualMerchantSource(masked)).toEqual(normalized);
  });
  it('does not claim a complete native payee namespace merely because all current entries fit a mask', () => {
    const input = source();
    const masked = { ...input, admission: { ...input.admission, payeeIds: input.payees.items.map((payee) => payee.id) } };
    expect(normalizeActualMerchantSource(masked).sourceAdmission.collections.payees).toBe('partial');
    expect(normalizeActualMerchantSource({ ...input, admission: { ...input.admission, payeeIds: null } }))
      .toEqual(normalizeActualMerchantSource(input));
  });
  it('admits referenced ledger payees and explicitly authorized schedule targets without unrelated directory names', () => {
    const input = source();
    input.schedules.items = [schedule({ payee: 'payee-scheduled' })];
    input.payees.items.push(
      { id: 'payee-scheduled', name: 'Scoped schedule merchant', transfer_acct: null },
      { id: 'payee-unrelated', name: 'Private unrelated merchant', transfer_acct: null },
    );
    const normalized = normalizeActualMerchantSource({ ...input, admission: { ...input.admission, payeeIds: ['payee-scheduled'] } });
    expect(normalized.payees.map((payee) => payee.id)).toEqual(['payee-market', 'payee-scheduled']);
    expect(normalized.transactions[0]!.payeeName).toBe(specimen.payeeName);
    expect(normalized.sourceAdmission.collections.payees).toBe('partial');
    expect(JSON.stringify(normalized)).not.toContain('Private unrelated merchant');
  });

  it('admits only selected native rules without exposing denied terms or names in facts hashes', () => {
    const allowed = {
      id: 'rule-admitted', name: 'Admitted merchant', stage: 'pre', conditionsOp: 'and',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Admitted merchant' }],
      actions: [{ field: 'category', op: 'set', value: 'category-food' }],
    };
    const denied = {
      ...allowed, id: 'rule-denied', name: 'Private rule name',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Private merchant terms' }],
    };
    const input = source([], { rules: { state: 'complete', items: [allowed, denied] as unknown as ActualMerchantSourceInput['rules']['items'] } });
    const masked = { ...input, admission: { ...input.admission, ruleIds: ['rule-admitted'] } };
    const normalized = normalizeActualMerchantSource(masked);
    expect(normalized.rules.map((rule) => rule.id)).toEqual(['rule-admitted']);
    expect(normalized.sourceAdmission.collections.rules).toBe('partial');
    expect(JSON.stringify(normalized)).not.toContain('Private');
    const changed = source([], { rules: { state: 'complete', items: [
      allowed, { ...denied, name: 'Different private name', conditions: [{ field: 'payee_name', op: 'is', value: 'Different private terms' }] },
    ] as unknown as ActualMerchantSourceInput['rules']['items'] } });
    expect(normalizeActualMerchantSource({ ...changed, admission: masked.admission })).toEqual(normalized);
    const admittedChange = source([], { rules: { state: 'complete', items: [
      { ...allowed, name: 'Changed admitted name' }, denied,
    ] as unknown as ActualMerchantSourceInput['rules']['items'] } });
    expect(normalizeActualMerchantSource({ ...admittedChange, admission: masked.admission }).sourceAdmission.factsHash)
      .not.toBe(normalized.sourceAdmission.factsHash);
    expect(normalizeActualMerchantSource(input).rules).toHaveLength(2);
    expect(normalizeActualMerchantSource({
      ...input, admission: { ...input.admission, ruleIds: null },
    })).toEqual(normalizeActualMerchantSource(input));
  });

  it('preserves the entire native category-is-null rule with complete coverage and only admitted category grants', () => {
    const rule = {
      id: 'rule-uncategorized', name: 'Categorize uncategorized market', stage: 'pre', conditionsOp: 'and',
      conditions: [
        { field: 'category', op: 'is', value: null, type: 'id' },
        { field: 'payee', op: 'is', value: specimen.payeeId, type: 'id' },
      ],
      actions: [{ field: 'category', op: 'set', value: 'category-food', type: 'id' }],
    };
    const input = source([row()], {
      rules: { state: 'complete', items: [rule] as unknown as ActualMerchantSourceInput['rules']['items'] },
    });
    input.admission.categoryIds = ['category-food'];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions[0]).toMatchObject({ id: specimen.id, categoryId: null });
    expect(normalized.rules).toEqual([{
      id: rule.id, name: rule.name, order: 0, inactive: false,
      trigger: { stage: rule.stage, conditionsOp: rule.conditionsOp, conditions: rule.conditions },
      actions: rule.actions,
    }]);
    expect(normalized.sourceAdmission.collections.rules).toBe('complete');
    expect(normalized.sourceAdmission.sourceCategoryIds).toEqual(['category-food']);
    expect(normalized.dependencies.categoryIds).toEqual(['category-food']);
    expect(normalized.dependencies.ruleIds).toEqual([rule.id]);
    expect(normalized.categories.map((category) => category.id)).toEqual(['category-food']);
    expect(input.rules.items).toEqual([rule]);
  });

  it('admits a native category-is-null predicate without fabricating category namespace authority', () => {
    const rule = {
      id: 'rule-null-no-category-target', name: 'Annotate uncategorized', stage: 'pre', conditionsOp: 'and',
      conditions: [{ field: 'category', op: 'is', value: null, type: 'id' }],
      actions: [{ field: 'notes', op: 'set', value: 'Needs categorization', type: 'string' }],
    };
    const input = source([row()], {
      rules: { state: 'complete', items: [rule] as unknown as ActualMerchantSourceInput['rules']['items'] },
    });
    input.admission.categoryIds = [];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.rules).toEqual([{
      id: rule.id, name: rule.name, order: 0, inactive: false,
      trigger: { stage: rule.stage, conditionsOp: rule.conditionsOp, conditions: rule.conditions },
      actions: rule.actions,
    }]);
    expect(normalized.sourceAdmission.collections.rules).toBe('complete');
    expect(normalized.sourceAdmission.sourceCategoryIds).toEqual([]);
    expect(normalized.dependencies.categoryIds).toEqual([]);
    expect(normalized.dependencies.ruleIds).toEqual([rule.id]);
    expect(normalized.categories).toEqual([]);
  });

  it.each([
    {
      reason: 'hidden category condition',
      conditions: [{ field: 'category', op: 'is', value: null }, { field: 'category', op: 'is', value: 'category-private' }],
      actions: [{ field: 'category', op: 'set', value: 'category-food' }],
    },
    {
      reason: 'hidden category action',
      conditions: [{ field: 'category', op: 'is', value: null }],
      actions: [{ field: 'category', op: 'set', value: 'category-private' }],
    },
    {
      reason: 'null category action',
      conditions: [{ field: 'category', op: 'is', value: null }],
      actions: [{ field: 'category', op: 'set', value: null }],
    },
    {
      reason: 'unsupported null category predicate',
      conditions: [{ field: 'category', op: 'contains', value: null }],
      actions: [{ field: 'category', op: 'set', value: 'category-food' }],
    },
  ])('excludes the entire native rule for $reason rather than broadening its null predicate', ({ conditions, actions }) => {
    const rule = { id: 'rule-denied-category', name: 'Denied category rule', stage: 'pre', conditionsOp: 'and', conditions, actions };
    const input = source([row()], {
      rules: { state: 'complete', items: [rule] as unknown as ActualMerchantSourceInput['rules']['items'] },
    });
    input.admission.categoryIds = ['category-food'];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.rules).toEqual([]);
    expect(normalized.dependencies.ruleIds).toEqual([]);
    expect(normalized.sourceAdmission.collections.rules).toBe('partial');
    expect(normalized.sourceAdmission.sourceCategoryIds).toEqual(['category-food']);
    expect(normalized.dependencies.categoryIds).toEqual(['category-food']);
    expect(JSON.stringify(normalized)).not.toContain('category-private');
  });

  it.each([{ ruleIds: [] }, { ruleIds: ['rule-admitted'] }])('does not disclose hidden rule presence through masked coverage or hashes: $ruleIds', ({ ruleIds }) => {
    const admitted = {
      id: 'rule-admitted', name: 'Admitted merchant', stage: 'pre', conditionsOp: 'and',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Admitted merchant' }],
      actions: [{ field: 'category', op: 'set', value: 'category-food' }],
    };
    const input = source([], { rules: { state: 'complete', items: ruleIds.length > 0
      ? [admitted] as unknown as ActualMerchantSourceInput['rules']['items'] : [] } });
    const masked = { ...input, admission: { ...input.admission, ruleIds } };
    const normalized = normalizeActualMerchantSource(masked);
    expect(normalized.sourceAdmission.collections.rules).not.toBe('complete');
    input.rules = { state: 'complete', items: [
      ...input.rules.items, { ...admitted, id: 'rule-denied', name: 'Private rule presence' },
    ] as unknown as ActualMerchantSourceInput['rules']['items'] };
    expect(normalizeActualMerchantSource({ ...input, admission: masked.admission })).toEqual(normalized);
  });

  it.each([{ sourceAccountIds: [] }, { sourceAccountIds: ['account-other'] }])('requires raw-source account admission even for an explicitly admitted transaction ID: $sourceAccountIds', ({ sourceAccountIds }) => {
    const input = source();
    const masked = {
      ...input, admission: { ...input.admission, sourceTransactionIds: [specimen.id], sourceAccountIds },
    };
    const normalized = normalizeActualMerchantSource(masked);
    expect(normalized.transactions[0]).toMatchObject({
      importedPayee: { state: 'unavailable', value: null }, notes: { state: 'unavailable', value: null },
      importedId: null, payeeId: specimen.payeeId, payeeName: specimen.payeeName, amount: specimen.amount,
    });
    const changed = source([{ ...row(), imported_payee: {}, notes: 123, imported_id: {} } as unknown as TransactionEntity]);
    expect(normalizeActualMerchantSource({ ...changed, admission: masked.admission })).toEqual(normalized);
  });

  it('keeps privileged transaction raw-account mask compatibility without schedule namespace admission', () => {
    const input = source();
    // Isolate transaction-mask compatibility from the independent schedule namespace.
    input.admission.sourceScheduleIds = [];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalizeActualMerchantSource({
      ...input, admission: { ...input.admission, sourceAccountIds: null },
    })).toEqual(normalized);
    expect(normalizeActualMerchantSource({
      ...input, admission: { ...input.admission, sourceAccountIds: [specimen.accountId], sourceTransactionIds: [specimen.id] },
    })).toEqual(normalized);
    expect(normalizeActualMerchantSource({
      ...input, admission: { ...input.admission, sourceAccountIds: [specimen.accountId], sourceTransactionIds: [] },
    }).transactions[0]!.importedPayee).toEqual({ state: 'unavailable', value: null });
  });

  it('does not read, validate, or compare denied duplicate native rule content', () => {
    const input = source([], { rules: { state: 'complete', items: [
      { id: 'rule-denied', name: 123, conditions: {}, actions: null },
      { id: 'rule-denied', name: 'Different private content', conditions: 'malformed' },
    ] as unknown as ActualMerchantSourceInput['rules']['items'] } });
    const masked = { ...input, admission: { ...input.admission, ruleIds: [] } };
    const normalized = normalizeActualMerchantSource(masked);
    expect(normalized.rules).toEqual([]);
    expect(normalized.sourceAdmission.collections.rules).not.toBe('complete');
    for (const rule of input.rules.items) {
      for (const field of ['name', 'conditions', 'actions', 'stage', 'conditionsOp']) {
        Object.defineProperty(rule, field, { enumerable: true, get: () => { throw new Error('Denied rule field read'); } });
      }
    }
    expect(normalizeActualMerchantSource(masked)).toEqual(normalized);
    expectInvalid({ ...input, admission: { ...input.admission, ruleIds: ['rule-denied'] } });
  });

  it('does not validate or compare hidden transaction raw fields even for privileged raw-source masks', () => {
    const input = source([
      row(), row({ id: 'transaction-hidden', imported_payee: 'Private merchant' }),
      { ...row({ id: 'transaction-hidden' }), imported_payee: {}, notes: 123, imported_id: {} } as unknown as TransactionEntity,
    ]);
    input.admission.transactionIds = [specimen.id];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions.map((transaction) => transaction.id)).toEqual([specimen.id]);
    const withoutHidden = source();
    withoutHidden.admission.transactionIds = [specimen.id];
    expect(normalized).toEqual(normalizeActualMerchantSource(withoutHidden));
  });

  it('hashes relevant source facts stably rather than capture timestamp, row order, or legacy display amount', () => {
    const input = source([row(), row({ id: 'second', amount: -200 })]);
    const original = normalizeActualMerchantSource(input);
    const next = structuredClone(input);
    next.capturedAt = '2024-12-31T13:00:00Z';
    next.expiresAt = '2025-01-01T13:00:00Z';
    next.transactions[0]!.read.items.reverse();
    expect(normalizeActualMerchantSource(next).sourceAdmission.factsHash).toBe(original.sourceAdmission.factsHash);
    next.transactions[0]!.read.items[0]!.notes = 'Changed relevant source fact';
    expect(normalizeActualMerchantSource(next).sourceAdmission.factsHash).not.toBe(original.sourceAdmission.factsHash);
  });
});

describe('raw complete split groups before merchant admission/horizon/cap', () => {
  it('flattens SDK subtransactions once when the same children also appear in the flat collection', () => {
    const normalized = normalizeActualMerchantSource(source(split()));
    expect(normalized.transactions).toHaveLength(3);
    expect(normalized.sourceAdmission.originalTransactionCount).toBe(3);
    expect(normalized.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'split-parent', isSplitParent: true, parentId: null, occurrenceId: 'split-parent', occurrenceComplete: true }),
      expect.objectContaining({ id: 'child-food', isSplitChild: true, parentId: 'split-parent', occurrenceId: 'split-parent', occurrenceComplete: true }),
      expect.objectContaining({ id: 'child-bills', isSplitChild: true, parentId: 'split-parent', occurrenceId: 'split-parent', occurrenceComplete: true }),
    ]));
    expect(normalized.transactions.map((transaction) => transaction.id)).toEqual(['child-bills', 'child-food', 'split-parent']);
  });

  it.each([
    { representation: 'nested and flat', maxTransactions: 4 },
    { representation: 'nested and flat', maxTransactions: 1 },
    { representation: 'flat only', maxTransactions: 4 },
    { representation: 'flat only', maxTransactions: 1 },
  ])('retains complete pre-cap split source authority for $representation at cap $maxTransactions', ({ representation, maxTransactions }) => {
    const rows = split();
    if (representation === 'flat only') delete rows[0]!.subtransactions;
    rows.push(row({ id: 'a-ordinary', amount: -25 }));
    const input = source(rows, { maxTransactions });
    input.admission.sourceTransactionIds = ['child-food'];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.dependencies.transactions).toEqual([
      {
        id: 'a-ordinary', accountId: specimen.accountId, categoryId: null, payeeId: specimen.payeeId,
        amount: { minorUnits: '-25', currency: specimen.amount.currency }, rawSource: false, isCompleteSplitParent: false,
      },
      {
        id: 'child-bills', accountId: specimen.accountId, categoryId: 'category-bills', payeeId: specimen.payeeId,
        amount: { minorUnits: '-40', currency: specimen.amount.currency }, rawSource: false, isCompleteSplitParent: false,
      },
      {
        id: 'child-food', accountId: specimen.accountId, categoryId: 'category-food', payeeId: specimen.payeeId,
        amount: { minorUnits: '-60', currency: specimen.amount.currency }, rawSource: true, isCompleteSplitParent: false,
      },
      {
        id: 'split-parent', accountId: specimen.accountId, categoryId: null, payeeId: specimen.payeeId,
        amount: specimen.amount, rawSource: false, isCompleteSplitParent: true,
      },
    ]);
    expect(normalized.transactions.map((transaction) => transaction.id)).toEqual(maxTransactions === 1
      ? ['a-ordinary'] : ['a-ordinary', 'child-bills', 'child-food', 'split-parent']);
    expect(normalized.sourceAdmission).toMatchObject({ originalTransactionCount: 4, truncatedCount: maxTransactions === 1 ? 3 : 0 });
    expect(normalized.dependencies.accountIds).toEqual([specimen.accountId]);
    expect(normalized.dependencies.categoryIds).toEqual(input.admission.categoryIds.slice().sort());
    for (const transaction of normalized.transactions) expect(transaction).not.toHaveProperty('isCompleteSplitParent');
  });

  it.each([
    { reason: 'partial read', ids: ['child-bills', 'child-food', 'split-parent'] },
    { reason: 'childless parent', ids: ['split-parent'] },
    { reason: 'missing child', ids: ['child-food', 'split-parent'] },
    { reason: 'hidden sibling', ids: ['child-food', 'split-parent'] },
    { reason: 'hidden parent', ids: ['child-bills', 'child-food'] },
    { reason: 'hidden category', ids: ['child-food', 'split-parent'] },
    { reason: 'out-of-horizon sibling', ids: ['child-food', 'split-parent'] },
    { reason: 'orphan children', ids: ['child-bills', 'child-food'] },
    { reason: 'mismatched amount', ids: ['child-bills', 'child-food', 'split-parent'] },
    { reason: 'mismatched sign', ids: ['child-bills', 'child-food', 'split-parent'] },
    { reason: 'source split error', ids: ['child-bills', 'child-food', 'split-parent'] },
  ])('retains conservative source dependency authority for $reason split groups', ({ reason, ids }) => {
    const rows = split();
    delete rows[0]!.subtransactions;
    const input = source(rows);
    switch (reason) {
      case 'partial read': input.transactions[0]!.read.state = 'partial'; break;
      case 'childless parent': rows.splice(1); break;
      case 'missing child': rows.pop(); break;
      case 'hidden sibling': input.admission.transactionIds = ['child-food', 'split-parent']; break;
      case 'hidden parent': input.admission.transactionIds = ['child-bills', 'child-food']; break;
      case 'hidden category': input.admission.categoryIds = ['category-food']; break;
      case 'out-of-horizon sibling': rows[2]!.date = '2019-12-31'; break;
      case 'orphan children': rows.splice(0, 1); break;
      case 'mismatched amount': rows[0]!.amount = -101; break;
      case 'mismatched sign': rows[1]!.amount = -140; rows[2]!.amount = 40; break;
      case 'source split error': rows[0]!.error = { type: 'SplitTransactionError', version: 1, difference: 1 }; break;
    }
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.dependencies.transactions).toEqual(ids.map((transactionId) => {
      const raw = rows.find((transaction) => transaction.id === transactionId)!;
      return {
        id: transactionId, accountId: raw.account, categoryId: raw.category ?? null, payeeId: raw.payee ?? null,
        amount: { minorUnits: String(raw.amount), currency: specimen.amount.currency },
        rawSource: true, isCompleteSplitParent: false,
      };
    }));
    expect(normalized.transactions.map((transaction) => transaction.id)).toEqual(ids);
    expect(normalized.transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
    expect(normalized.dependencies.accountIds).toEqual([specimen.accountId]);
    expect(normalized.dependencies.categoryIds).toEqual(input.admission.categoryIds.slice().sort());
    if (reason === 'hidden sibling' || reason === 'hidden category' || reason === 'out-of-horizon sibling') {
      expect(JSON.stringify(normalized)).not.toContain('child-bills');
    }
    if (reason === 'hidden parent') expect(normalized.dependencies.transactions.map((transaction) => transaction.id)).not.toContain('split-parent');
  });

  it('retains an admitted child for categorization but cannot establish an occurrence after hiding its sibling', () => {
    const input = source(split());
    input.admission.transactionIds = ['child-food'];
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions).toHaveLength(1);
    expect(normalized.transactions[0]).toMatchObject({ id: 'child-food', occurrenceId: 'split-parent', occurrenceComplete: false });
    expect(normalized.sourceAdmission.originalTransactionCount).toBe(1);
    expect(JSON.stringify(normalized)).not.toContain('child-bills');
  });

  it('does not leak hidden category/account dependencies or mark a category-projected split complete', () => {
    const input = source(split());
    input.admission.categoryIds = ['category-food'];
    input.accounts.push({ id: 'account-private', name: 'Private', closed: false, offbudget: false });
    input.transactions.push({ accountId: 'account-private', startDate: '2020-01-01', endDate: canonical.asOfDate,
      read: { state: 'complete', items: [row({ id: 'secret-sibling', account: 'account-private' })] } });
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
    expect(normalized.sourceAdmission.sourceAccountIds).toEqual([specimen.accountId]);
    expect(normalized.sourceAdmission.sourceCategoryIds).toEqual(['category-food']);
    expect(JSON.stringify(normalized)).not.toContain('secret-sibling');
    expect(JSON.stringify(normalized)).not.toContain('account-private');
    expect(normalized.categories.map((category) => category.id)).toEqual(['category-food']);
  });

  it('cannot prove a complete recurrence group from a partial raw read or orphan child', () => {
    const partial = source(split());
    partial.transactions[0]!.read.state = 'partial';
    expect(normalizeActualMerchantSource(partial).transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
    const orphan = normalizeActualMerchantSource(source([row({ id: 'orphan', is_child: true, parent_id: 'missing-parent' })]));
    expect(orphan.transactions[0]).toMatchObject({ occurrenceId: 'missing-parent', occurrenceComplete: false });
  });

  it('proves flat-only parent/child groups from the complete raw collection, not only nested copies', () => {
    const rows = split();
    delete rows[0]!.subtransactions;
    const normalized = normalizeActualMerchantSource(source(rows));
    expect(normalized.transactions).toHaveLength(3);
    expect(normalized.transactions.every((transaction) => transaction.occurrenceComplete)).toBe(true);
  });

  it('cannot mark a childless or financially incomplete parent occurrence complete', () => {
    const childless = normalizeActualMerchantSource(source([row({ id: 'childless', is_parent: true, subtransactions: [] })]));
    expect(childless.transactions[0]!.occurrenceComplete).toBe(false);
    const rows = split();
    rows[0]!.subtransactions!.pop();
    rows.pop();
    expect(normalizeActualMerchantSource(source(rows)).transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
  });

  it('cannot mark a source-reported split error complete', () => {
    const rows = split();
    rows[0]!.error = { type: 'SplitTransactionError', version: 1, difference: 1 };
    expect(normalizeActualMerchantSource(source(rows)).transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
  });

  it.each([
    { tombstone: true }, { starting_balance_flag: true }, { payee: 'payee-transfer' },
  ] satisfies Partial<TransactionEntity>[])('marks a group incomplete when a raw sibling is ineligible: %j', (fields) => {
    const rows = split();
    Object.assign(rows[0]!.subtransactions![1]!, fields);
    Object.assign(rows[2]!, fields);
    const input = source(rows);
    input.payees.items.push({ id: 'payee-transfer', name: 'Savings', transfer_acct: 'account-savings' });
    expect(normalizeActualMerchantSource(input).transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
  });

  it('checks raw completeness before horizon projection', () => {
    const rows = split();
    rows[0]!.subtransactions![1]!.date = '2019-12-31';
    rows[2]!.date = '2019-12-31';
    const normalized = normalizeActualMerchantSource(source(rows));
    expect(normalized.transactions.map((transaction) => transaction.id)).toEqual(['child-food', 'split-parent']);
    expect(normalized.transactions.every((transaction) => !transaction.occurrenceComplete)).toBe(true);
    expect(normalized.sourceAdmission.originalTransactionCount).toBe(2);
  });

  it('caps whole occurrence groups atomically, including the parent, rather than silently dropping siblings', () => {
    const input = source(split(), { maxTransactions: 2 });
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions).toEqual([]);
    expect(normalized.sourceAdmission).toMatchObject({ originalTransactionCount: 3, truncatedCount: 3 });
    input.maxTransactions = 3;
    expect(normalizeActualMerchantSource(input).transactions).toHaveLength(3);
  });

  it('rejects conflicting flat/nested duplicate IDs instead of choosing the first copy', () => {
    const rows = split();
    rows[2] = { ...rows[2]!, amount: -41 };
    expectInvalid(source(rows), 'conflicting_source_id');
    expectInvalid(source([row(), row({ amount: -101 })]), 'conflicting_source_id');
    expect(normalizeActualMerchantSource(source([row(), row()])).transactions).toHaveLength(1);
  });

  it('rejects contradictory parent linkage across accounts', () => {
    const rows = split();
    rows[0]!.subtransactions![0]!.account = 'another-account';
    rows[1]!.account = 'another-account';
    expectInvalid(source(rows));
  });
});

describe('merchant source schedules retain canonical liquidity evidence', () => {
  it.each([
    { amountOp: 'is', amount: -100, certainty: 'exact' },
    { amountOp: 'isapprox', amount: -100, certainty: 'approximate' },
    { amountOp: 'isbetween', amount: { num1: -80, num2: -120 }, certainty: 'range' },
    { amountOp: 'is', amount: undefined, certainty: 'unknown' },
  ] as const)('preserves $certainty signed amount without inventing observed recurrence', ({ amountOp, amount, certainty }) => {
    const raw = schedule({ amountOp, amount });
    const input = source([], { schedules: { state: 'complete', items: [raw] } });
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.schedules).toEqual([{ payeeId: specimen.payeeId, source: normalizeActualScheduleLiquiditySource(raw, input.currency) }]);
    expect(normalized.schedules[0]!.source.certainty).toBe(certainty);
    expect(normalized.schedules[0]!.source.recurrence).toEqual({
      frequency: 'daily', interval: 2, patterns: null, start: '2024-03-31',
      endMode: 'after_n_occurrences', endOccurrences: 5, endDate: null,
      skipWeekend: true, weekendSolveMode: 'after',
    });
    expect(normalized.schedules[0]!.source).not.toHaveProperty('varianceNumerator');
    if (certainty === 'range') {
      expect(normalized.schedules[0]!.source.minimum).toEqual({ minorUnits: '-120', currency: 'USD' });
      expect(normalized.schedules[0]!.source.maximum).toEqual({ minorUnits: '-80', currency: 'USD' });
    }
    if (certainty === 'unknown') expect(normalized.schedules[0]!.source.amount).toBeNull();
  });

  it('keeps missing schedule payee unknown and preserves one-off date and zero amount', () => {
    const raw = schedule({ payee: undefined, date: '2024-02-29', amount: 0 });
    expect(normalizeActualMerchantSource(source([], { schedules: { state: 'complete', items: [raw] } })).schedules).toEqual([
      { payeeId: null, source: normalizeActualScheduleLiquiditySource(raw, 'USD') },
    ]);
  });

  it('preserves source recurrence selectors and end date rather than substituting monthly assumptions', () => {
    const raw = schedule({ date: {
      frequency: 'weekly', interval: 2, patterns: [{ type: 'MO', value: 1 }], start: '2024-03-31',
      endMode: 'on_date', endDate: '2024-12-31', skipWeekend: false, weekendSolveMode: 'before',
    } });
    const normalized = normalizeActualMerchantSource(source([], { schedules: { state: 'complete', items: [raw] } }));
    expect(normalized.schedules[0]!.source.recurrence).toMatchObject({
      frequency: 'weekly', interval: 2, patterns: [{ kind: 'mo', value: 1 }],
      endMode: 'on_date', endDate: '2024-12-31', skipWeekend: false, weekendSolveMode: 'before',
    });
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects malformed schedule integer %s rather than making up zero or unknown certainty', (amount) => {
    expectInvalid(source([], { schedules: { state: 'complete', items: [schedule({ amount })] } }));
    expectInvalid(source([], { schedules: { state: 'complete', items: [schedule({ amountOp: 'isbetween', amount: { num1: -100, num2: amount } })] } }));
  });

  it.each([
    { date: '2024-02-30' },
    { next_date: '2024-02-30' },
    { date: { frequency: 'daily', interval: 0, start: '2024-01-01' } },
    { date: { frequency: 'daily', interval: 1.5, start: '2024-01-01' } },
    { date: { frequency: 'daily', start: '2023-02-29' } },
    { date: { frequency: 'daily', start: '2024-01-01', endMode: 'after_n_occurrences', endOccurrences: -1 } },
  ])('rejects malformed schedule civil dates or recurrence boundaries: %j', (fields) => {
    const raw = { ...schedule(), ...fields } as unknown as APIScheduleEntity;
    expectInvalid(source([], { schedules: { state: 'complete', items: [raw] } }));
  });

  it.each(['category', 'group'] as const)('admits %s identity before validating oversized or conflicting denied fields', (kind) => {
    const input = source();
    const baseline = normalizeActualMerchantSource(input);
    if (kind === 'category') {
      input.categories.items.push(
        { ...input.categories.items[0]!, id: 'private-category', name: 'x'.repeat(4097), group_id: 'private-group' },
        { ...input.categories.items[0]!, id: 'private-category', name: 'Conflicting private name', group_id: 'private-group' },
      );
    } else {
      input.categoryGroups.push(
        { id: 'private-group', name: 'x'.repeat(4097), is_income: false, hidden: false },
        { id: 'private-group', name: 'Conflicting private name', is_income: false, hidden: false },
      );
    }
    expect(normalizeActualMerchantSource(input)).toEqual(baseline);
    if (kind === 'category') input.admission.categoryIds.push('private-category');
    else input.categories.items[0]!.group_id = 'private-group';
    expectInvalid(input);
  });

  it.each(['category', 'group'] as const)('does not access denied %s fields or compare hidden duplicates', (kind) => {
    const input = source();
    const baseline = normalizeActualMerchantSource(input);
    const candidates = [{ id: 'private-id' }, { id: 'private-id' }];
    let accesses = 0;
    for (const candidate of candidates) {
      for (const field of ['name', 'group_id', 'is_income', 'hidden', 'tombstone']) {
        Object.defineProperty(candidate, field, { enumerable: true, get: () => {
          accesses += 1;
          throw new Error('Denied source field access');
        } });
      }
    }
    if (kind === 'category') input.categories.items.push(...candidates as ActualMerchantSourceInput['categories']['items']);
    else input.categoryGroups.push(...candidates as ActualMerchantSourceInput['categoryGroups']);
    expect(normalizeActualMerchantSource(input)).toEqual(baseline);
    expect(accesses).toBe(0);
    if (kind === 'category') input.admission.categoryIds.push('private-id');
    else input.categories.items[0]!.group_id = 'private-id';
    expectInvalid(input);
    expect(accesses).toBeGreaterThan(0);
  });

  it.each(['category', 'group'] as const)('rejects conflicting admitted %s duplicates', (kind) => {
    const input = source();
    if (kind === 'category') input.categories.items.push({ ...input.categories.items[0]!, name: 'Conflicting admitted name' });
    else input.categoryGroups.push({ ...input.categoryGroups[0]!, name: 'Conflicting admitted name' });
    expectInvalid(input, 'conflicting_source_id');
  });

  it('admits exact schedule source identity before touching any denied fields or hashes', () => {
    const input = source([], { schedules: { state: 'complete', items: [] } });
    input.admission.sourceScheduleIds = [];
    const baseline = normalizeActualMerchantSource(input);
    const hidden = [{ id: 'schedule-private' }, { id: 'schedule-private' }];
    let accesses = 0;
    for (const candidate of hidden) {
      for (const field of ['account', 'payee', 'rule', 'completed', 'amount', 'amountOp', 'date', 'next_date', 'name']) {
        Object.defineProperty(candidate, field, { enumerable: true, get: () => {
          accesses += 1;
          throw new Error('Denied schedule access');
        } });
      }
    }
    input.schedules.items = hidden as APIScheduleEntity[];
    expect(normalizeActualMerchantSource(input)).toEqual(baseline);
    expect(accesses).toBe(0);
    expect(baseline.schedules).toEqual([]);
    expect(baseline.sourceAdmission.collections.schedules).toBe('unavailable');
    input.admission.sourceScheduleIds = ['schedule-private'];
    expectInvalid(input);
  });

  it.each([
    { sourceAccountIds: [] },
    { ruleIds: [] },
    { schedulePayeeIds: [] },
    { accountIds: [] },
  ])('withholds schedule Money, IDs and raw hashes without exact dependency rights: %j', (denial) => {
    const input = source([], { schedules: { state: 'complete', items: [] } });
    input.admission = {
      ...input.admission, sourceScheduleIds: ['schedule-market'], sourceAccountIds: [specimen.accountId],
      ruleIds: ['rule-schedule'], schedulePayeeIds: [specimen.payeeId!], ...denial,
    };
    const baseline = normalizeActualMerchantSource(input);
    const raw = schedule();
    for (const field of ['amount', 'amountOp', 'date', 'next_date', 'name', 'completed']) {
      Object.defineProperty(raw, field, { enumerable: true, get: () => { throw new Error('Denied schedule content'); } });
    }
    input.schedules.items = [raw];
    expect(normalizeActualMerchantSource(input)).toEqual(baseline);
    expect(baseline.schedules).toEqual([]);
  });

  it('requires namespace source authority for account-less schedules even with an exact schedule source grant', () => {
    const raw = schedule({ account: undefined });
    const input = source([], { schedules: { state: 'complete', items: [raw] } });
    input.admission = { ...input.admission, sourceScheduleIds: ['schedule-market'], ruleIds: ['rule-schedule'], schedulePayeeIds: [specimen.payeeId!] };
    const baseline = normalizeActualMerchantSource({ ...input, schedules: { state: 'complete', items: [] } });
    expect(normalizeActualMerchantSource(input)).toEqual(baseline);
    input.admission.sourceScheduleIds = null;
    expect(normalizeActualMerchantSource(input).schedules).toHaveLength(1);
  });

  it('retains exact admitted schedule dependency closure and strict monetary validation', () => {
    const input = source([], { schedules: { state: 'complete', items: [schedule()] } });
    input.admission = {
      ...input.admission, sourceScheduleIds: ['schedule-market'], sourceAccountIds: [specimen.accountId],
      ruleIds: ['rule-schedule'], schedulePayeeIds: [specimen.payeeId!],
    };
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.schedules).toHaveLength(1);
    expect(normalized.dependencies.schedules).toEqual([{
      id: 'schedule-market', accountId: specimen.accountId, ruleId: 'rule-schedule', payeeId: specimen.payeeId,
    }]);
    expect(normalized.dependencies.scheduleNamespace).toBe(false);
    input.schedules.items[0]!.amount = 1.5;
    expectInvalid(input);
  });

  it('retains every pre-cap count, hash and payee contributor independently of the native transaction cap', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => row({ id, payee: id === 'd' ? 'payee-omitted' : specimen.payeeId }));
    const input = source(rows, { maxTransactions: 2 });
    input.admission.payeeIds = [];
    input.admission.sourceTransactionIds = ['a', 'd'];
    input.admission.sourceAccountIds = [specimen.accountId];
    input.payees.items.push({ id: 'payee-omitted', name: 'Pre-cap payee contributor', transfer_acct: null });
    const normalized = normalizeActualMerchantSource(input);
    expect(normalized.transactions.map((transaction) => transaction.id)).toEqual(['a', 'b']);
    expect(normalized.sourceAdmission).toMatchObject({ originalTransactionCount: 4, truncatedCount: 2 });
    expect(normalized.dependencies.transactions).toMatchObject(rows.map((transaction) => ({
      id: transaction.id, accountId: transaction.account, categoryId: transaction.category ?? null,
      payeeId: transaction.payee ?? null,
      amount: { minorUnits: String(transaction.amount), currency: input.currency },
      rawSource: transaction.id === 'a' || transaction.id === 'd',
    })));
    expect(normalized.dependencies.payeeIds).toEqual(['payee-market', 'payee-omitted']);
    expect(normalized.dependencies.payeeNamespace).toBe(false);
    const larger = normalizeActualMerchantSource({ ...input, maxTransactions: 4 });
    expect(larger.dependencies).toEqual(normalized.dependencies);
    rows[3]!.notes = 'Changed omitted admitted raw source';
    expect(normalizeActualMerchantSource(input).sourceAdmission.factsHash).not.toBe(normalized.sourceAdmission.factsHash);
  });
});

describe('merchant raw financial trust boundary', () => {
  it.each([
    { amount: 1.5 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { amount: Number.NaN },
    { amount: Number.POSITIVE_INFINITY }, { date: '2024-02-30' }, { date: '2023-02-29' },
    { date: '2024-03-31T00:00:00Z' }, { id: '' }, { account: '' },
    { imported_payee: 123 }, { notes: {} }, { cleared: 'true' }, { starting_balance_flag: 1 },
  ])('rejects malformed SDK fields without coercion: %j', (fields) => {
    expectInvalid(source([{ ...row(), ...fields } as unknown as TransactionEntity]));
  });

  it.each([0, -1, 1.5, 250_001])('rejects invalid transaction cap %s', (maxTransactions) => {
    expectInvalid(source([], { maxTransactions }));
  });

  it('rejects invalid currency, reversed civil horizon, and stale admission interval', () => {
    expectInvalid(source([], { currency: 'usd' }));
    expectInvalid(source([], { startDate: '2024-12-31', endDate: '2024-01-01' }));
    expectInvalid(source([], { expiresAt: canonical.sourceAdmission.capturedAt }));
  });
});

describe('trusted connector merchant capture', () => {
  it('uses configured ledger currency for omitted merchant capture currency and empty-source Money', async () => {
    const input = source();
    const client: ActualClient = {
      init: vi.fn(), shutdown: vi.fn(), sync: vi.fn(), loadBudget: vi.fn(), downloadBudget: vi.fn(),
      getBudgets: async () => [{ id: 'budget-merchant', groupId: 'group-merchant', name: 'Merchant', state: 'remote', encrypted: false }],
      getServerVersion: async () => ({ version: '26.10.0' }),
      getAccounts: async () => input.accounts, getAccountBalance: vi.fn(),
      getTransactions: async () => input.transactions[0]!.read.items,
      getPayees: async () => input.payees.items,
      getCategories: vi.fn(async (options?: { hidden?: boolean }) => options?.hidden === true ? [] : input.categories.items),
      getCategoryGroups: vi.fn(async (options?: { hidden?: boolean }) => options?.hidden === true ? [] : input.categoryGroups),
      getRules: async () => input.rules.items,
      getSchedules: async () => input.schedules.items,
      getBudgetMonths: vi.fn(), getBudgetMonth: vi.fn(), getTags: vi.fn(), runBankSync: vi.fn(),
      addTransactions: vi.fn(), createAccount: vi.fn(), updateTransaction: vi.fn(),
      createRule: vi.fn(), deleteRule: vi.fn(), setBudgetAmount: vi.fn(),
    };
    const connector = new ActualConnector({ client, currency: 'GBP' });
    try {
      await connector.connect({ serverUrl: 'http://actual.test:5006', secretKey: 'synthetic-test-only' });
      await connector.selectBudget('budget-merchant');
      const options = {
        admission: input.admission, startDate: input.startDate, endDate: input.endDate,
        maxTransactions: input.maxTransactions, expiresAt: '9999-12-31T23:59:59Z',
      };
      const captured = await connector.captureMerchantSource(options, (captured) => captured);
      expect(captured.categories).toEqual(canonical.categories);
      expect(client.getCategories).toHaveBeenCalledWith();
      expect(client.getCategoryGroups).toHaveBeenCalledWith();
      expect(captured.transactions[0]!.amount).toEqual({ minorUnits: specimen.amount.minorUnits, currency: 'GBP' });
      expect(connector.sourceCurrency).toBe('GBP');
      const overridden = await connector.captureMerchantSource({ ...options, currency: 'CAD' }, (captured) => captured);
      expect(overridden.transactions[0]!.amount.currency).toBe('CAD');
      input.transactions[0]!.read = { state: 'complete', items: [] };
      const empty = await connector.captureMerchantSource(options, (captured) => captured);
      expect(empty.transactions).toEqual([]);
      expect({ minorUnits: '0', currency: connector.sourceCurrency }).toEqual({ minorUnits: '0', currency: 'GBP' });
    } finally {
      await connector.disconnect();
    }
  });

  it('captures full raw groups sequentially under the Actual lock and publishes before releasing it', async () => {
    const input = source(split());
    const calls: string[] = [];
    let activeReads = 0;
    const read = <T>(name: string, value: T) => async (): Promise<T> => {
      expect(activeReads).toBe(0);
      activeReads += 1;
      calls.push(name);
      await Promise.resolve();
      activeReads -= 1;
      return value;
    };
    const client: ActualClient = {
      init: vi.fn(), shutdown: vi.fn(), sync: vi.fn(), loadBudget: vi.fn(), downloadBudget: vi.fn(),
      getBudgets: async () => [{ id: 'budget-merchant', groupId: 'group-merchant', name: 'Merchant', state: 'remote', encrypted: false }],
      getServerVersion: async () => ({ version: '26.10.0' }),
      getAccounts: read('accounts', input.accounts),
      getAccountBalance: vi.fn(),
      getTransactions: async (_accountId, startDate, endDate) => {
        expect([startDate, endDate]).toEqual(['0001-01-01', '9999-12-31']);
        return read('transactions', input.transactions[0]!.read.items)();
      },
      getPayees: read('payees', input.payees.items),
      getCategories: read('categories', input.categories.items),
      getCategoryGroups: read('groups', input.categoryGroups),
      getRules: read('rules', input.rules.items), getSchedules: read('schedules', input.schedules.items),
      getBudgetMonths: vi.fn(), getBudgetMonth: vi.fn(), getTags: vi.fn(), runBankSync: vi.fn(),
      addTransactions: vi.fn(), createAccount: vi.fn(), updateTransaction: vi.fn(),
      createRule: vi.fn(), deleteRule: vi.fn(), setBudgetAmount: vi.fn(),
    };
    const connector = new ActualConnector({ client });
    try {
      await connector.connect({ serverUrl: 'http://actual.test:5006', secretKey: 'synthetic-test-only' });
      await connector.selectBudget('budget-merchant');
      const options = {
        currency: input.currency, admission: input.admission, startDate: input.startDate,
        endDate: input.endDate, maxTransactions: input.maxTransactions,
        expiresAt: '9999-12-31T23:59:59Z',
      };
      const first = connector.captureMerchantSource(options, async (captured) => {
        expect(captured.transactions).toHaveLength(3);
        expect(captured.transactions.every((transaction) => transaction.occurrenceComplete)).toBe(true);
        expect(captured.transactions.find((transaction) => transaction.id === 'child-food')!.importedPayee)
          .toEqual(specimen.importedPayee);
        calls.push('publish-start');
        await Promise.resolve();
        calls.push('publish-end');
        return captured.sourceAdmission.factsHash;
      });
      const second = connector.captureMerchantSource(options, (captured) => captured.sourceAdmission.factsHash);
      expect(await first).toBe(await second);
      const secondAccountRead = calls.indexOf('accounts', calls.indexOf('accounts') + 1);
      expect(secondAccountRead).toBeGreaterThan(calls.indexOf('publish-end'));
      const projected = await connector.captureMerchantSource({
        ...options, admission: { ...options.admission, transactionIds: ['child-food'] }, maxTransactions: 1,
      }, (captured) => captured);
      expect(projected.transactions).toHaveLength(1);
      expect(projected.transactions[0]).toMatchObject({ id: 'child-food', occurrenceComplete: false });
      expect(JSON.stringify(projected)).not.toContain('child-bills');
      client.getPayees = async () => { throw new Error('synthetic unreadable source'); };
      const unavailable = await connector.captureMerchantSource(options, (captured) => captured);
      expect(unavailable.sourceAdmission.collections.payees).toBe('unavailable');
      expect(unavailable.transactions.every((transaction) => transaction.payeeName === null)).toBe(true);
    } finally {
      await connector.disconnect();
    }
  });

  it('keeps synchronize source reads inside the same budget lock as merchant capture', async () => {
    const input = source();
    let releasePayees: () => void = () => {};
    let markPayeesEntered: () => void = () => {};
    const blockedPayees = new Promise<void>((resolve) => { releasePayees = resolve; });
    const payeesEntered = new Promise<void>((resolve) => { markPayeesEntered = resolve; });
    let accountReads = 0;
    let payeeReads = 0;
    const client: ActualClient = {
      init: vi.fn(), shutdown: vi.fn(), sync: vi.fn(), loadBudget: vi.fn(), downloadBudget: vi.fn(),
      getBudgets: async () => [{ id: 'budget-merchant', groupId: 'group-merchant', name: 'Merchant', state: 'remote', encrypted: false }],
      getServerVersion: async () => ({ version: '26.10.0' }),
      getAccounts: async () => { accountReads += 1; return input.accounts.map((account) => ({ ...account, balance_current: 0 })); },
      getAccountBalance: async () => 0,
      getTransactions: async () => input.transactions[0]!.read.items,
      getPayees: async () => {
        payeeReads += 1;
        if (payeeReads === 1) { markPayeesEntered(); await blockedPayees; }
        return input.payees.items;
      },
      getCategories: async () => input.categories.items,
      getCategoryGroups: async () => input.categoryGroups,
      getRules: async () => [], getSchedules: async () => [],
      getBudgetMonths: async () => [], getBudgetMonth: vi.fn(), getTags: async () => [], runBankSync: vi.fn(),
      addTransactions: vi.fn(), createAccount: vi.fn(), updateTransaction: vi.fn(),
      createRule: vi.fn(), deleteRule: vi.fn(), setBudgetAmount: vi.fn(),
    };
    const connector = new ActualConnector({ client });
    try {
      await connector.connect({ serverUrl: 'http://actual.test:5006', secretKey: 'synthetic-test-only' });
      await connector.selectBudget('budget-merchant');
      const synchronization = connector.synchronize({ refresh: false });
      await payeesEntered;
      const capture = connector.captureMerchantSource({
        currency: input.currency, admission: input.admission, startDate: input.startDate,
        endDate: input.endDate, maxTransactions: input.maxTransactions, expiresAt: '9999-12-31T23:59:59Z',
      }, (captured) => captured);
      // Drain runnable microtasks without releasing the deliberately blocked SDK read.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const readsWhileSynchronizationBlocked = accountReads;
      releasePayees();
      const [, captured] = await Promise.all([synchronization, capture]);
      expect(readsWhileSynchronizationBlocked).toBe(1);
      expect(captured.transactions[0]!.importedPayee).toEqual(specimen.importedPayee);
      expect(accountReads).toBe(2);
    } finally {
      releasePayees();
      await connector.disconnect();
    }
  });
});
