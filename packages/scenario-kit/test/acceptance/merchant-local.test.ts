import { downloadBudget, getAccounts, getPayees, getRules, getTransactions, init, shutdown } from '@actual-app/api';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { moneySchema } from '@balanceframe/protocol-generated/validators';
import { merchantCalendarSchema, merchantRecurrenceSchema, merchantSuggestionSchema, merchantTextFieldSchema } from '../../../protocol-generated/src/merchant-validators.js';
import { merchantPolicyViewSchema } from '../../../application/src/merchant-public.js';
import type { LoadedScenario } from '../../src/loader.js';
import { cacheRows, journal, noPrivateValues, resultOf, testTimeout } from './merchant-research-support.js';
import type { Envelope } from './merchant-research-support.js';
import { scenarioRequest, withScenario } from './support.js';

const decisionSchema = z.object({ id: z.string(), state: z.enum(['accepted', 'rejected', 'revoked']), version: z.number().int().positive() }).passthrough();
const sourceSchema = z.object({
  id: z.string(), accountId: z.string(), date: z.string(), payeeId: z.string().nullable(), payeeName: z.string().nullable(),
  categoryId: z.string().nullable(), amount: moneySchema, importedPayee: merchantTextFieldSchema,
  description: merchantTextFieldSchema, verboseTitle: merchantTextFieldSchema, notes: merchantTextFieldSchema,
});
const suggestionSchema = merchantSuggestionSchema.extend({
  sourceTransaction: sourceSchema, evidenceKey: z.string(), aliasDecisions: z.array(decisionSchema), reviewContext: z.unknown(),
});
const recurrenceSchema = z.object({ evidenceKey: z.string(), patternDecisions: z.array(decisionSchema) }).passthrough().transform((row) => {
  const { evidenceKey, patternDecisions, ...native } = row;
  return { ...merchantRecurrenceSchema.parse(native), evidenceKey, patternDecisions };
});
const viewSchema = z.object({
  scope: z.object({ spaceId: z.string(), budgetId: z.string(), connectionId: z.string() }),
  suggestions: z.array(suggestionSchema), recurrences: z.array(recurrenceSchema), scheduledExpectations: z.array(z.unknown()),
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
}).passthrough();
const rowSchema = z.object({
  id: z.string(), account: z.string(), date: z.string(), amount: z.number().int(),
  payee: z.string().nullish(), category: z.string().nullish(), imported_id: z.string().nullish(),
  imported_payee: z.string().nullish(), notes: z.string().nullish(), cleared: z.boolean(), reconciled: z.boolean(),
});
const queueSchema = z.object({ items: z.array(z.object({
  reviewItem: z.object({ id: z.string(), transactionId: z.string(), categoryId: z.string() }).passthrough(),
  evidence: z.object({ money: moneySchema.optional(), suggestedCategory: z.string().nullable().optional(), merchantEvidence: suggestionSchema.optional(), merchantProof: z.unknown().optional() }).passthrough(),
}).passthrough()) });

async function nativeState(handle: LoadedScenario) {
  const dataDir = mkdtempSync(join(handle.processes.root, 'merchant-local-client-'));
  try {
    await init({ serverURL: handle.processes.actualUrl, password: handle.processes.actualSecretKey, dataDir });
    await downloadBudget(handle.seeded.groupId);
    const rows: z.infer<typeof rowSchema>[] = [];
    for (const account of await getAccounts()) rows.push(...z.array(rowSchema).parse(await getTransactions(account.id, '1900-01-01', '2999-12-31')));
    return { rows: rows.sort((a, b) => a.id.localeCompare(b.id)), rules: await getRules(), payees: await getPayees() };
  } finally { try { await shutdown(); } finally { rmSync(dataDir, { recursive: true, force: true }); } }
}

async function sync(handle: LoadedScenario): Promise<void> {
  const value = z.object({ synchronized: z.literal(true), failed: z.number().int() }).parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/review/sync', { method: 'POST', body: {} })));
  expect(value).toEqual({ synchronized: true, failed: 0 });
}

async function analysis(handle: LoadedScenario, transactionId?: string) {
  const value = viewSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/merchant${transactionId ? `?transactionId=${encodeURIComponent(transactionId)}` : ''}`)));
  expect(value.scope).toMatchObject({ spaceId: handle.initialized.spaceId, budgetId: handle.initialized.budgetId });
  noPrivateValues(handle, value);
  return value;
}

async function target(handle: LoadedScenario, logicalId: string) {
  const transactionId = handle.seeded.transactionIds[logicalId];
  if (!transactionId) throw new Error(`Missing native target ${logicalId}`);
  const found = (await analysis(handle, transactionId)).suggestions.find((row) => row.transactionId === transactionId);
  expect(found, `Normal native analysis must publish ${logicalId}`).toBeDefined();
  if (!found) throw new Error('Native merchant target was not admitted');
  return found;
}

function noResearch(handle: LoadedScenario): void {
  expect(handle.scenario.research).toBeUndefined();
  expect(journal(handle)).toEqual([]);
  expect(cacheRows(handle)).toEqual([]);
}

async function queue(handle: LoadedScenario) {
  return queueSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/review'))).items;
}

async function exactTargetSource(handle: LoadedScenario, logicalId: string, amount: number, importedPayee: string, notes?: string) {
  const before = await nativeState(handle);
  const nativeId = handle.seeded.transactionIds[logicalId];
  const row = before.rows.find((candidate) => candidate.id === nativeId);
  expect(row).toMatchObject({ id: nativeId, account: handle.seeded.accountIds['acct-checking'], amount, imported_payee: importedPayee, ...(notes === undefined ? {} : { notes }) });
  if (!row) throw new Error('Expected target in real Actual');
  const observed = await target(handle, logicalId);
  expect(observed.sourceTransaction).toMatchObject({
    id: nativeId, accountId: row.account, date: row.date, payeeId: row.payee ?? null, categoryId: null,
    amount: { minorUnits: String(amount), currency: 'USD' },
    importedPayee: { state: importedPayee ? 'present' : 'empty', value: importedPayee },
    ...(notes === undefined ? {} : { notes: { state: notes ? 'present' : 'empty', value: notes } }),
  });
  const canonical = handle.scenario.ledger.transactions.find((candidate) => candidate.id === logicalId);
  expect(row.date).toBe(canonical?.date);
  expect(row.imported_id).toBe(canonical?.importedId);
  return { before, observed };
}

async function pattern(handle: LoadedScenario, logicalPayee: string) {
  const payeeId = handle.seeded.payeeIds[logicalPayee];
  const found = (await analysis(handle)).recurrences.find((candidate) => candidate.payeeId === payeeId);
  expect(found, `Native recurrence missing for ${logicalPayee}`).toBeDefined();
  if (!found) throw new Error('Native recurrence was not admitted');
  return found;
}

async function decidePattern(handle: LoadedScenario, state: 'accepted' | 'rejected') {
  const observed = await pattern(handle, 'pay-recurrence-monthly');
  const id = randomUUID();
  const saved = decisionSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/merchant/${state === 'accepted' ? 'confirm' : 'reject'}`, {
    method: 'POST', body: { id, kind: 'pattern', patternId: observed.id, evidenceKey: observed.evidenceKey, evidenceRevision: observed.evidenceRevision, expectedVersion: 0, visibility: 'shared' },
  })));
  expect(saved).toMatchObject({ id, state, version: 1 });
  const current = await pattern(handle, 'pay-recurrence-monthly');
  expect(current).toMatchObject({ id: observed.id, decisionState: state, patternDecisions: [expect.objectContaining({ id, state, version: 1 })] });
  return current;
}

function completedDates(anchor: string, count: number, day: 'first' | 'end' | 15): string[] {
  const date = new Date(anchor);
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - count + index + (day === 'end' ? 1 : 0), day === 'end' ? 0 : day === 'first' ? 1 : day)).toISOString().slice(0, 10));
}

function businessDates(dates: string[], holidays: Set<string>, direction: -1 | 1): string[] {
  return dates.map((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    for (let adjustment = 0; adjustment <= 10; adjustment++) {
      const civil = date.toISOString().slice(0, 10);
      if (![0, 6].includes(date.getUTCDay()) && !holidays.has(civil)) return civil;
      date.setUTCDate(date.getUTCDate() + direction);
    }
    throw new Error('Supported US business-day adjustment exceeded the bounded contract');
  });
}

const dashboardSchema = z.object({ recurrences: z.array(z.object({ payeeName: z.string(), amount: moneySchema, frequency: z.string(), occurrences: z.number(), lastOccurrence: z.string(), isEstimated: z.boolean() })) }).passthrough();

async function dashboard(handle: LoadedScenario) {
  return dashboardSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/home/attention'))).recurrences;
}

describe('real local merchant scenario acceptance', () => {
  it('merchant-local-sparse publishes native Groceries evidence without research or ledger changes', async () => {
    await withScenario('merchant-local-sparse', async (handle) => {
      const { before, observed } = await exactTargetSource(handle, 'synthetic-holdout-000-02', -34607, 'aster atelier');
      await sync(handle);
      expect(observed).toMatchObject({ transactionId: handle.seeded.transactionIds['synthetic-holdout-000-02'], accountId: handle.seeded.accountIds['acct-checking'], payeeId: handle.seeded.payeeIds['pay-market'], categoryId: handle.seeded.categoryIds['cat-groceries'], tier: 'inferred', supportCount: 3 });
      expect(observed.categoryHistory).toMatchObject({ totalCount: 3, entries: [expect.objectContaining({ categoryId: handle.seeded.categoryIds['cat-groceries'], count: 3, ledgerCount: 3, correctionCount: 0 })], truncated: false });
      const item = (await queue(handle)).find((candidate) => candidate.reviewItem.transactionId === observed.transactionId);
      expect(item?.evidence).toMatchObject({ money: { minorUnits: '-34607', currency: 'USD' }, suggestedCategory: 'Groceries', merchantEvidence: { transactionId: observed.transactionId, categoryId: observed.categoryId, supportCount: 3 } });
      expect(await nativeState(handle)).toEqual(before);
      noResearch(handle);
    }, { branches: ['sparse-inference'] });
  }, testTimeout);

  it('merchant-local-insufficient abstains independently on support one and empty identity without native writes', async () => {
    await withScenario('merchant-local-insufficient', async (handle) => {
      const { before, observed: sparse } = await exactTargetSource(handle, 'synthetic-holdout-000-02', -34607, 'aster atelier');
      const { observed: empty } = await exactTargetSource(handle, 'synthetic-holdout-000-08', -32989, '', '');
      await sync(handle);
      expect(sparse).toMatchObject({ categoryId: null, supportCount: 1, ruleCandidates: [], categoryHistory: { totalCount: 1, entries: [expect.objectContaining({ count: 1, ledgerCount: 1, correctionCount: 0 })] } });
      expect(sparse.reasonCodes).toContain('category_insufficient_data');
      expect(empty).toMatchObject({ payeeId: null, categoryId: null, tier: 'insufficient_data', supportCount: 0, ruleCandidates: [] });
      for (const observed of [sparse, empty]) {
        const item = (await queue(handle)).find((candidate) => candidate.reviewItem.transactionId === observed.transactionId);
        expect(item, 'Abstention must remain an ordinary usable Review item').toBeDefined();
        expect(item?.reviewItem.categoryId).toBe('');
        expect(item?.evidence.merchantProof).toBeUndefined();
      }
      expect(await nativeState(handle)).toEqual(before);
      noResearch(handle);
    }, { branches: ['insufficient-evidence'] });
  }, testTimeout);

  it('merchant-alias-conflict admits conflicting imported and notes sources and abstains', async () => {
    await withScenario('merchant-alias-conflict', async (handle) => {
      const { before, observed } = await exactTargetSource(handle, 'synthetic-holdout-000-10', -77239, 'Aster Atelier', 'Dapple Grove');
      await sync(handle);
      expect(observed).toMatchObject({ categoryId: null, tier: 'conflicting', ruleCandidates: [] });
      expect(observed.reasonCodes).toContain('identity_conflict');
      expect(observed.contradictions).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'importedPayee', rawText: 'Aster Atelier', reasonCode: 'identity_conflict' }),
        expect.objectContaining({ field: 'notes', rawText: 'Dapple Grove', reasonCode: 'identity_conflict' }),
      ]));
      expect(await nativeState(handle)).toEqual(before);
      noResearch(handle);
    }, { branches: ['conflicting-source'] });
  }, testTimeout);

  for (const state of ['accepted', 'rejected'] as const) {
    it(`merchant-alias-conflict persists a fresh account-scoped alias ${state} decision without editing Actual`, async () => {
      await withScenario('merchant-alias-conflict', async (handle) => {
        const before = await nativeState(handle);
        const observed = await target(handle, 'synthetic-holdout-000-03');
        const id = randomUUID();
        const accountId = handle.seeded.accountIds['acct-checking'];
        const targetPayeeId = handle.seeded.payeeIds['pay-market'];
        const saved = decisionSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/merchant/${state === 'accepted' ? 'confirm' : 'reject'}`, {
          method: 'POST', body: { id, kind: 'alias', transactionId: observed.transactionId, sourceField: 'importedPayee', targetPayeeId, accountId, evidenceKey: observed.evidenceKey, evidenceRevision: observed.evidenceRevision, expectedVersion: 0, visibility: 'shared' },
        })));
        expect(saved).toMatchObject({ id, state, version: 1 });
        const current = await target(handle, 'synthetic-holdout-000-03');
        expect(current.aliasDecisions).toContainEqual(expect.objectContaining({ id, state, version: 1, accountId, targetPayeeId, sourceField: 'importedPayee', visibility: 'shared' }));
        if (state === 'accepted') expect(current).toMatchObject({ payeeId: targetPayeeId, categoryId: handle.seeded.categoryIds['cat-groceries'], tier: 'inferred', supportCount: 3 });
        else {
          expect(current.categoryId).toBeNull();
          expect(current.contradictions.map((item) => item.reasonCode)).toContain('rejected_alias');
        }
        await sync(handle);
        expect(await nativeState(handle)).toEqual(before);
        noResearch(handle);
      }, { branches: [state === 'accepted' ? 'alias-confirm' : 'alias-reject'] });
    }, testTimeout);
  }

  it('merchant-alias-conflict executes an independently approved explicit correction and makes it win later inference', async () => {
    await withScenario('merchant-alias-conflict', async (handle) => {
      const before = await nativeState(handle);
      await sync(handle);
      const observed = await target(handle, 'synthetic-holdout-000-03');
      const item = (await queue(handle)).find((candidate) => candidate.reviewItem.transactionId === observed.transactionId);
      if (!item) throw new Error('Expected real Review target for correction');
      const categoryId = handle.seeded.categoryIds['cat-other'];
      const proposed = z.object({ applied: z.literal(false), verified: z.literal(false), approvalRequired: z.literal(true), proposal: z.object({ id: z.string(), payloadHash: z.string(), requiredApprovers: z.number() }).passthrough() }).parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/review/correct', { method: 'POST', body: { reviewId: item.reviewItem.id, categoryId } })));
      expect(proposed.proposal.requiredApprovers).toBe(1);
      expect(await nativeState(handle)).toEqual(before);
      const detail = z.object({ proposal: z.object({ payloadHash: z.string(), requesterActorId: z.string(), canApprove: z.boolean() }) }).parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposed.proposal.id)}`, { personaId: 'approver', freshProof: true })));
      expect(detail.proposal).toMatchObject({ payloadHash: proposed.proposal.payloadHash, requesterActorId: handle.initialized.personas.owner?.actorId, canApprove: true });
      expect(handle.initialized.personas.approver?.actorId).not.toBe(detail.proposal.requesterActorId);
      resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposed.proposal.id)}/approve`, { method: 'POST', personaId: 'approver', body: { payloadHash: detail.proposal.payloadHash } }));
      const executed = resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposed.proposal.id)}/execute`, { method: 'POST', body: {} }));
      expect(executed).toEqual({ proposalId: proposed.proposal.id, transactionId: observed.transactionId, categoryId, verified: true });
      const after = await nativeState(handle);
      expect(after.rules).toEqual(before.rules);
      expect(after.payees).toEqual(before.payees);
      expect(after.rows).toEqual(before.rows.map((row) => row.id === observed.transactionId ? { ...row, category: categoryId } : row));
      const corrected = await target(handle, 'synthetic-holdout-000-03');
      expect(corrected.categoryId).toBe(categoryId);
      expect(corrected.sourceTransaction.categoryId).toBe(categoryId);
      noResearch(handle);
    }, { branches: ['correction-precedence'] });
  }, testTimeout);

  it('merchant-recurrence-calendar observes civil, business, variable and irregular native series using the real US calendar', async () => {
    await withScenario('merchant-recurrence-calendar', async (handle) => {
      const before = await nativeState(handle);
      await sync(handle);
      const accountId = handle.seeded.accountIds['acct-checking'];
      const known = z.object({ state: z.literal('known'), calendar: merchantCalendarSchema, reasonCodes: z.tuple([]) }).parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/merchant/calendar?accountId=${encodeURIComponent(accountId!)}&year=${new Date(handle.scenario.anchor).getUTCFullYear()}`)));
      expect(known.calendar).toMatchObject({ jurisdiction: 'US', subdivision: null, timeZone: 'America/New_York', version: 'python-holidays/0.105:public:observed:2020-2035', coverageStart: '2020-01-01', coverageEnd: '2035-12-31' });
      const holidays = new Set(known.calendar.holidays.map((holiday) => holiday.date));
      const series = [
        ['pay-recurrence-monthly', 'recurrence-monthly', completedDates(handle.scenario.anchor, 4, 15)],
        ['pay-recurrence-end-month', 'recurrence-end-month', completedDates(handle.scenario.anchor, 4, 'end')],
        ['pay-recurrence-business-day', 'recurrence-business-day', businessDates(completedDates(handle.scenario.anchor, 4, 'end'), holidays, -1)],
        ['pay-recurrence-business-first', 'recurrence-business-first', businessDates(completedDates(handle.scenario.anchor, 12, 'first'), holidays, 1)],
      ] as const;
      for (const [payee, prefix, dates] of series) {
        const observed = await pattern(handle, payee);
        const transactionIds = dates.map((_, index) => handle.seeded.transactionIds[`${prefix}-${index}`]);
        expect(observed).toMatchObject({ accountId, payeeId: handle.seeded.payeeIds[payee], kind: 'observed', frequency: 'monthly', occurrences: dates.length, dates, firstDate: dates[0], lastDate: dates.at(-1), minimumAmount: { minorUnits: '-1200', currency: 'USD' }, maximumAmount: { minorUnits: '-1200', currency: 'USD' }, calendarVersion: known.calendar.version });
        expect([...observed.transactionIds].sort()).toEqual([...transactionIds].sort());
        for (const date of dates) expect(date < handle.scenario.anchor.slice(0, 10)).toBe(true);
        for (const [index, nativeId] of transactionIds.entries()) expect(before.rows.find((row) => row.id === nativeId)).toMatchObject({ account: accountId, payee: handle.seeded.payeeIds[payee], date: dates[index], amount: -1200 });
      }
      expect((await pattern(handle, 'pay-recurrence-end-month')).reasonCodes).toContain('month_end');
      const first = await pattern(handle, 'pay-recurrence-business-first');
      expect(first.reasonCodes).toEqual(expect.arrayContaining(['first_business_day', 'possible_holiday_shift']));
      const nominalFirst = completedDates(handle.scenario.anchor, 12, 'first');
      expect(nominalFirst.filter((date) => date.endsWith('-01-01'))).toEqual([expect.stringMatching(/^\d{4}-01-01$/)]);
      expect(holidays.has(nominalFirst.find((date) => date.endsWith('-01-01'))!)).toBe(true);
      const variable = await pattern(handle, 'pay-recurrence-variable');
      expect(variable).toMatchObject({ frequency: 'monthly', occurrences: 4, minimumAmount: { minorUnits: '-1200', currency: 'USD' }, maximumAmount: { minorUnits: '-900', currency: 'USD' } });
      expect((await pattern(handle, 'pay-recurrence-irregular')).frequency).toBe('irregular');
      expect((await analysis(handle)).scheduledExpectations).toEqual([]);
      expect(await nativeState(handle)).toEqual(before);
      noResearch(handle);
    }, { branches: ['recurrence-calendar'] });
  }, testTimeout);

  for (const state of ['accepted', 'rejected'] as const) {
    it(`merchant-recurrence-calendar keeps a fresh ${state} pattern decision separate from Dashboard and ledger facts`, async () => {
      await withScenario('merchant-recurrence-calendar', async (handle) => {
        const before = await nativeState(handle);
        const observed = await decidePattern(handle, state);
        const projected = (await dashboard(handle)).filter((item) => item.payeeName === observed.normalizedMerchant);
        if (state === 'accepted') expect(projected).toEqual([{ payeeName: observed.normalizedMerchant, amount: observed.maximumAmount, frequency: 'monthly', occurrences: 4, lastOccurrence: observed.lastDate, isEstimated: false }]);
        else expect(projected).toEqual([]);
        expect((await analysis(handle)).scheduledExpectations).toEqual([]);
        expect(await nativeState(handle)).toEqual(before);
        noResearch(handle);
      }, { branches: [state === 'accepted' ? 'pattern-confirm' : 'pattern-reject'] });
    }, testTimeout);
  }

  for (const selection of [null, { jurisdiction: 'ZZ', subdivision: null, timeZone: 'America/New_York' }] as const) {
    it(`merchant-recurrence-calendar retains ordinary cadence with calendar uncertainty after ${selection === null ? 'clearing selection' : 'selecting an unsupported jurisdiction'}`, async () => {
      await withScenario('merchant-recurrence-calendar', async (handle) => {
        const before = await nativeState(handle);
        const baseline = await pattern(handle, 'pay-recurrence-monthly');
        const current = merchantPolicyViewSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/merchant/policy')));
        const updated = merchantPolicyViewSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/merchant/policy', { method: 'PUT', body: { expectedVersion: current.version, value: { ...current.value, calendar: { budget: selection, accounts: [] } } } })));
        expect(updated.value.calendar).toEqual({ budget: selection, accounts: [] });
        const accountId = handle.seeded.accountIds['acct-checking'];
        const unknown = resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/merchant/calendar?accountId=${encodeURIComponent(accountId!)}&year=${new Date(handle.scenario.anchor).getUTCFullYear()}`));
        expect(unknown).toEqual({ state: 'unknown', calendar: null, reasonCodes: ['calendar_unknown'] });
        expect(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/merchant/calendar?accountId=${encodeURIComponent(accountId!)}&year=2019`))).toEqual({ state: 'unknown', calendar: null, reasonCodes: ['calendar_unknown'] });
        const observed = await pattern(handle, 'pay-recurrence-monthly');
        expect(observed).toMatchObject({ frequency: 'monthly', dates: baseline.dates, transactionIds: baseline.transactionIds, minimumAmount: baseline.minimumAmount, maximumAmount: baseline.maximumAmount, calendarVersion: null });
        expect(observed.reasonCodes).toContain('calendar_unknown');
        expect(await nativeState(handle)).toEqual(before);
        noResearch(handle);
      }, { branches: ['calendar-unknown'] });
    }, testTimeout);
  }
});
