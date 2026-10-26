import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import {
  budgetMonthSchema, canonicalProtocolSnapshotSchema, canonicalTransactionSchema,
  cashFlowProjectionResponseSchema, decisionDataPolicySchema, financialStateLabelSchema,
  inclusionScopeSchema, ruleSchema, snapshotCoverageSchema, suggestionSchema,
} from '@balanceframe/protocol-generated/validators';

const fixture = JSON.parse(readFileSync(new URL('../../protocol/fixtures/representative.json', import.meta.url), 'utf8'));
const jsonSchema = JSON.parse(readFileSync(new URL('../../protocol/json-schema/protocol-v1.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: false }).compile(jsonSchema);

describe('Zod migration preserves the canonical financial contract', () => {
  it('preserves the pre-migration fixture output and recursively validates child transactions and record values', () => {
    const snapshot = canonicalProtocolSnapshotSchema.parse(fixture);
    // Captured from the Zod 3 parser; optional adapter metadata was already stripped.
    expect(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')).toBe('595fad961c945abed90b623769fa1b40c0d0859af542411672a95253f6c48a56');
    expect(canonicalProtocolSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const transaction = { ...fixture.transactions[0], subtransactions: [fixture.transactions[0]] };
    expect(canonicalTransactionSchema.parse(transaction)).toEqual(transaction);
    expect(canonicalTransactionSchema.safeParse({ ...transaction, subtransactions: [{ ...fixture.transactions[0], amount: { minorUnits: '9223372036854775808', currency: 'USD' } }] }).success).toBe(false);
    const budget = { id: 'month', month: '2026-10', categories: {
      arbitrary: { categoryId: 'arbitrary', amount: { minorUnits: '-9223372036854775808', currency: 'USD' }, carryover: { minorUnits: '9223372036854775807', currency: 'USD' }, carryoverFromPrevious: { minorUnits: '0', currency: 'USD' }, carriesOver: false },
    } };
    expect(budgetMonthSchema.parse(budget)).toEqual(budget);
    expect(budgetMonthSchema.safeParse({ ...budget, categories: { arbitrary: {} } }).success).toBe(false);
  });

  it('keeps required opaque rule values, nulls, nested JSON and canonical AJV agreement', () => {
    const rule = { id: 'rule', name: 'Rule', order: 0, inactive: false, trigger: null, actions: { nested: [null, { x: 1 }] } };
    expect(ruleSchema.parse(rule)).toEqual(rule);
    for (const field of ['trigger', 'actions']) {
      const missing: Record<string, unknown> = { ...rule };
      delete missing[field];
      for (const value of [missing, { ...rule, [field]: undefined }]) {
        expect(ruleSchema.safeParse(value).success).toBe(false);
        expect(validate({ ...fixture, rules: [value] })).toBe(false);
      }
    }
    expect(validate({ ...fixture, rules: [rule] })).toBe(true);
  });

  it('keeps unbounded integer fields aligned with the existing JSON Schema rather than implicitly adding safe-integer limits', () => {
    const rule = { id: 'rule', name: 'Rule', order: 2 ** 53, trigger: {}, actions: {}, inactive: false };
    expect(validate({ ...fixture, rules: [rule] })).toBe(true);
    expect(ruleSchema.parse(rule)).toEqual(rule);
    expect(cashFlowProjectionResponseSchema.parse({ projectionMonths: -(2 ** 53), monthlyProjections: [] })).toEqual({ projectionMonths: -(2 ** 53), monthlyProjections: [] });
    const policy = { pendingMode: 'include', uncategorizedMode: 'block', unclearedMode: 'include', maxBankSyncAgeMinutes: 2 ** 53, maxBudgetSnapshotAgeMinutes: null, accountOverrides: { includeOnly: null, exclude: [] } };
    expect(decisionDataPolicySchema.parse(policy)).toEqual(policy);
    for (const order of [-1, 1.5, Infinity, NaN, '1']) expect(ruleSchema.safeParse({ ...rule, order }).success).toBe(false);
  });

  it('preserves in-memory unbounded number behavior, while rejecting NaN and retaining strict/strip policies', () => {
    const suggestion = { transactionId: 'tx', proposedCategoryId: 'cat', categoryName: 'Category', confidence: Infinity, reasonCodes: [], evidence: [], deterministicEvidence: { nested: [null, { value: true }] } };
    expect(suggestionSchema.parse(suggestion)).toEqual(suggestion);
    expect(suggestionSchema.safeParse({ ...suggestion, confidence: NaN }).success).toBe(false);
    expect(suggestionSchema.safeParse({ ...suggestion, extra: true }).success).toBe(false);
    for (const score of [Infinity, -Infinity]) expect(financialStateLabelSchema.parse({ label: 'healthy', score, reasonCodes: [] }).score).toBe(score);
    expect(ruleSchema.parse({ id: 'rule', name: 'Rule', order: 0, trigger: {}, actions: {}, inactive: false, extra: true })).not.toHaveProperty('extra');
  });

  it('exposes the approved native issue structure for fractional integers and malformed unbounded numbers', () => {
    const fractional = ruleSchema.safeParse({ id: 'rule', name: 'Rule', order: 1.5, trigger: {}, actions: {}, inactive: false });
    expect(fractional.success).toBe(false);
    if (fractional.success) throw new Error('Fractional order must be rejected');
    expect(fractional.error.issues).toEqual([{ code: 'custom', path: ['order'], message: 'Expected integer' }]);
    const malformed = suggestionSchema.safeParse({ transactionId: 'tx', proposedCategoryId: 'cat', categoryName: 'Category', confidence: 'bad', reasonCodes: [], evidence: [] });
    expect(malformed.success).toBe(false);
    if (malformed.success) throw new Error('Malformed confidence must be rejected');
    expect(malformed.error.issues[0]).toMatchObject({ code: 'invalid_union', path: ['confidence'], errors: [
      [{ code: 'invalid_type', expected: 'number' }], [{ code: 'invalid_value', values: [Infinity] }], [{ code: 'invalid_value', values: [-Infinity] }],
    ] });
  });

  it('uses own record entries and rejects symbol keys while preserving ordinary JSON records', () => {
    const budget = JSON.parse(readFileSync(new URL('../../protocol/fixtures/data-quality.json', import.meta.url), 'utf8')).budgets[0];
    const category = Object.values(budget.categories)[0];
    const inherited = Object.create({ inherited: category }) as Record<string, unknown>;
    expect(budgetMonthSchema.parse({ ...budget, categories: inherited }).categories).toEqual({});
    const symbol = Symbol('untrusted-category');
    const result = budgetMonthSchema.safeParse({ ...budget, categories: { [symbol]: category } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Symbol record keys must be rejected');
    expect(result.error.issues[0]).toMatchObject({ code: 'invalid_key', origin: 'record', path: ['categories', symbol], issues: [{ code: 'invalid_type', expected: 'string' }] });
    expect(budgetMonthSchema.parse(budget)).toEqual(budget);
  });

  it('keeps explicit coverage defaults and rejects null instead of manufacturing evidence', () => {
    expect(snapshotCoverageSchema.parse({})).toEqual(Object.fromEntries(['accounts', 'transactions', 'categories', 'payees', 'rules', 'schedules', 'budgets', 'tags'].map((key) => [key, 'unknown'])));
    expect(inclusionScopeSchema.parse({})).toEqual({ pendingActivity: 'unknown', unclearedActivity: 'unknown' });
    expect(snapshotCoverageSchema.safeParse({ accounts: null }).success).toBe(false);
    expect(inclusionScopeSchema.safeParse({ pendingActivity: null }).success).toBe(false);
  });
});
