import type { APIAccountEntity, APICategoryEntity, APICategoryGroupEntity, APIPayeeEntity, APIScheduleEntity } from '@actual-app/api/models';
import type { RuleEntity, TransactionEntity } from '@actual-app/core/types/models';
import type { MerchantAnalysisRequest } from '@balanceframe/protocol-generated';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeCategories, normalizePayees, normalizeRule } from './normalizer.js';
import { normalizeActualScheduleLiquiditySource } from './liquidity-normalizer.js';

export type ActualMerchantCollection<T> =
  | { state: 'complete' | 'partial'; items: T[] }
  | { state: 'unavailable'; items: [] };
export interface ActualMerchantSourceInput {
  capturedAt: string;
  expiresAt: string;
  currency: string;
  accounts: APIAccountEntity[];
  transactions: Array<{ accountId: string; startDate: string; endDate: string; read: ActualMerchantCollection<TransactionEntity> }>;
  payees: ActualMerchantCollection<APIPayeeEntity>;
  categories: ActualMerchantCollection<APICategoryEntity>;
  categoryGroups: APICategoryGroupEntity[];
  rules: ActualMerchantCollection<RuleEntity>;
  schedules: ActualMerchantCollection<APIScheduleEntity>;
  admission: {
    visibilityHash: string;
    accountIds: string[];
    categoryIds: string[];
    transactionIds: string[] | null;
    /** Exact raw-field admission; omitted/null is reserved for privileged full-source callers. */
    sourceTransactionIds?: string[] | null;
    /** Raw fields also require their actual account ID in this exact source-view mask. */
    sourceAccountIds?: string[] | null;
    /** Exact native-rule read admission; omitted/null is reserved for privileged callers. */
    ruleIds?: string[] | null;
    /** Additional authorized target IDs; admitted ledger payees are included, null/omitted permits the full namespace. */
    payeeIds?: string[] | null;
    /** Exact raw schedule-source admission; null/omitted requires privileged namespace authority. */
    sourceScheduleIds?: string[] | null;
    /** Independent schedule reference authority; ledger-inferred payees never confer this right. */
    schedulePayeeIds?: string[] | null;
  };
  startDate: string;
  endDate: string;
  maxTransactions: number;
}
/** Internal complete source closure, never serialized into canonical native requests or public DTOs. */
export interface ActualMerchantSourceDependencies {
  transactions: Array<Pick<MerchantAnalysisRequest['transactions'][number], 'id' | 'accountId' | 'categoryId' | 'payeeId' | 'amount'> & { rawSource: boolean; isCompleteSplitParent: boolean }>;
  accountIds: string[];
  categoryIds: string[];
  ruleIds: string[];
  payeeIds: string[];
  schedules: Array<{ id: string; accountId: string | null; ruleId: string | null; payeeId: string | null }>;
  payeeNamespace: boolean;
  scheduleNamespace: boolean;
}
export type ActualMerchantSource = Pick<MerchantAnalysisRequest, 'transactions' | 'payees' | 'categories' | 'rules' | 'schedules' | 'sourceAdmission'> & {
  dependencies: ActualMerchantSourceDependencies;
};
export class ActualMerchantSourceError extends Error {
  constructor(readonly code: 'invalid_source' | 'conflicting_source_id', message: string) {
    super(message);
    this.name = 'ActualMerchantSourceError';
  }
}

const utf8 = new TextEncoder();
const id = z.string().min(1).max(256).refine((value) => utf8.encode(value).length <= 256);
const sourceText = z.string().max(4096).refine((value) => utf8.encode(value).length <= 4096);
const integer = z.number().refine(Number.isSafeInteger, 'Expected an exact safe integer');
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return value.slice(0, 4) !== '0000' && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid civil date');
const nullableId = id.nullish();
const transactionFields = z.object({
  id, account: id, date: civilDate, amount: integer,
  payee: nullableId, category: nullableId, parent_id: nullableId,
  imported_id: nullableId, imported_payee: sourceText.nullish(), notes: sourceText.nullish(),
  cleared: z.boolean().optional(), reconciled: z.boolean().optional(),
  starting_balance_flag: z.boolean().optional(), tombstone: z.boolean().optional(),
  is_parent: z.boolean().optional(), is_child: z.boolean().optional(),
  error: z.object({ type: z.literal('SplitTransactionError'), version: z.literal(1), difference: integer }).nullish(),
});
type RawTransaction = z.infer<typeof transactionFields>;
const ledgerTransactionFields = transactionFields.omit({ imported_id: true, imported_payee: true, notes: true });
const rawSourceFields = transactionFields.pick({ imported_id: true, imported_payee: true, notes: true });
const payeeFields = z.object({ id, name: sourceText, transfer_acct: nullableId });
const categoryFields = z.object({ id, name: sourceText, group_id: nullableId, is_income: z.boolean().optional(), hidden: z.boolean().optional(), tombstone: z.boolean().optional() });
const groupFields = z.object({ id, name: sourceText, is_income: z.boolean().optional(), hidden: z.boolean().optional() });
const conditionFields = z.object({ field: id, op: id, value: z.unknown() }).passthrough();
const actionFields = z.object({ field: id.optional(), op: id, value: z.unknown() }).passthrough();
const ruleFields = z.object({ id, stage: z.enum(['pre', 'post']).nullable(), conditionsOp: z.enum(['and', 'or']), conditions: z.array(conditionFields), actions: z.array(actionFields), tombstone: z.boolean().optional(), name: sourceText.optional() }).passthrough();
const scheduleFields = z.object({
  id, account: nullableId, payee: nullableId, rule: nullableId, completed: z.boolean().optional(),
  amountOp: z.enum(['is', 'isapprox', 'isbetween']).optional(),
  amount: z.union([integer, z.object({ num1: integer, num2: integer }).strict()]).nullish(),
  next_date: civilDate.nullish(),
  date: z.union([civilDate, z.object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: integer.refine((value) => value > 0).nullish(), start: civilDate,
    patterns: z.array(z.object({ type: id, value: integer }).strict()).nullish(),
    endMode: z.enum(['never', 'on_date', 'after_n_occurrences']).nullish(),
    endOccurrences: integer.refine((value) => value >= 0).nullish(), endDate: civilDate.nullish(),
    skipWeekend: z.boolean().nullish(), weekendSolveMode: z.enum(['before', 'after']).nullish(),
  }).strict()]).nullish(),
}).passthrough();
const collection = <T extends z.ZodTypeAny>(items: T) => z.union([
  z.object({ state: z.enum(['complete', 'partial']), items: z.array(items) }).strict(),
  z.object({ state: z.literal('unavailable'), items: z.tuple([]) }).strict(),
]);
const inputFields = z.object({
  capturedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  currency: z.string().regex(/^[A-Z]{3}$/),
  accounts: z.array(z.object({ id, name: z.string(), closed: z.boolean().optional(), offbudget: z.boolean().optional() }).passthrough()),
  transactions: z.array(z.object({ accountId: id, startDate: civilDate, endDate: civilDate, read: collection(z.unknown()) }).strict()),
  payees: collection(z.unknown()), categories: collection(z.unknown()), categoryGroups: z.array(z.unknown()),
  rules: collection(z.unknown()), schedules: collection(z.unknown()),
  admission: z.object({
    visibilityHash: id, accountIds: z.array(id), categoryIds: z.array(id), transactionIds: z.array(id).nullable(),
    sourceTransactionIds: z.array(id).nullish(),
    sourceAccountIds: z.array(id).nullish(),
    ruleIds: z.array(id).nullish(),
    payeeIds: z.array(id).nullish(),
    sourceScheduleIds: z.array(id).nullish(),
    schedulePayeeIds: z.array(id).nullish(),
  }).strict(),
  startDate: civilDate, endDate: civilDate, maxTransactions: z.number().int().min(1).max(250_000),
}).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function selectIdentities(rows: unknown[], allowed: Set<string> | null): unknown[] {
  return allowed === null ? rows : rows.filter((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return false;
    const candidateId = (candidate as Record<string, unknown>).id;
    return typeof candidateId === 'string' && allowed.has(candidateId);
  });
}
function unique<T extends { id: string }>(rows: T[]): T[] {
  const result = new Map<string, T>();
  for (const row of rows) {
    const existing = result.get(row.id);
    if (existing && canonical(existing) !== canonical(row)) throw new ActualMerchantSourceError('conflicting_source_id', 'Conflicting source identity');
    result.set(row.id, row);
  }
  return [...result.values()];
}
function text(value: string | null | undefined): MerchantAnalysisRequest['transactions'][number]['notes'] {
  if (value == null) return { state: 'absent', value: null };
  if (value === '') return { state: 'empty', value: '' };
  return { state: 'present', value };
}
function aggregate(states: Array<'complete' | 'partial' | 'unavailable'>): 'complete' | 'partial' | 'unavailable' {
  if (states.every((state) => state === 'unavailable') && states.length > 0) return 'unavailable';
  return states.some((state) => state !== 'complete') ? 'partial' : 'complete';
}

/** Trusted server projection only: the caller must authorize the complete dependency closure. */
export function normalizeActualMerchantSource(input: ActualMerchantSourceInput): ActualMerchantSource {
  try {
    return normalize(input);
  } catch (error: unknown) {
    if (error instanceof ActualMerchantSourceError) throw error;
    throw new ActualMerchantSourceError('invalid_source', 'Malformed Actual merchant source');
  }
}
function normalize(unchecked: ActualMerchantSourceInput): ActualMerchantSource {
  const input = inputFields.parse(unchecked);
  if (input.startDate > input.endDate || Date.parse(input.expiresAt) <= Date.parse(input.capturedAt)) throw new Error('Invalid source interval');
  const accounts = new Set(input.admission.accountIds);
  const categoriesAllowed = new Set(input.admission.categoryIds);
  const transactionsAllowed = input.admission.transactionIds === null ? null : new Set(input.admission.transactionIds);
  const sourcesAllowed = input.admission.sourceTransactionIds == null ? null : new Set(input.admission.sourceTransactionIds);
  const sourceAccountsAllowed = input.admission.sourceAccountIds == null ? null : new Set(input.admission.sourceAccountIds);
  const sourceAdmitted = (row: Pick<RawTransaction, 'id' | 'account'>): boolean =>
    (sourcesAllowed === null || sourcesAllowed.has(row.id))
    && (sourceAccountsAllowed === null || sourceAccountsAllowed.has(row.account));
  const rulesAllowed = input.admission.ruleIds == null ? null : new Set(input.admission.ruleIds);
  const payeesAllowed = input.admission.payeeIds == null ? null : new Set(input.admission.payeeIds);
  const schedulesAllowed = input.admission.sourceScheduleIds == null ? null : new Set(input.admission.sourceScheduleIds);
  const schedulePayeesAllowed = input.admission.schedulePayeeIds == null ? null : new Set(input.admission.schedulePayeeIds);
  const admitted = (row: Pick<RawTransaction, 'id' | 'account' | 'category' | 'date'>): boolean => accounts.has(row.account)
    && (row.category == null || categoriesAllowed.has(row.category))
    && (transactionsAllowed === null || transactionsAllowed.has(row.id))
    && row.date >= input.startDate && row.date <= input.endDate;
  const sourceAccountIds = [...accounts].sort();
  const sourceCategoryIds = [...categoriesAllowed].sort();
  const accountMetadata = new Map(unique(input.accounts).map((account) => [account.id, account]));
  const coverage = new Map<string, ActualMerchantSource['sourceAdmission']['accountCoverage'][number]>();
  const flattened: RawTransaction[] = [];
  const visit = (candidate: unknown, accountId: string, parent?: RawTransaction): void => {
    const ledger = ledgerTransactionFields.parse(candidate);
    // Never read denied raw values, including during validation or duplicate comparison.
    const raw: RawTransaction = {
      ...ledger,
      ...(admitted(ledger) && sourceAdmitted(ledger) ? rawSourceFields.parse(candidate) : { imported_id: null, imported_payee: null, notes: null }),
    };
    if (raw.account !== accountId || (parent && (!raw.is_child || raw.parent_id !== parent.id || raw.is_parent))) throw new Error('Invalid split linkage');
    if (raw.is_parent && raw.is_child || raw.is_child && !raw.parent_id || !raw.is_child && raw.parent_id) throw new Error('Invalid parent identity');
    flattened.push({ ...raw, payee: raw.payee ?? null, category: raw.category ?? null, parent_id: raw.parent_id ?? null,
      imported_id: raw.imported_id ?? null, imported_payee: raw.imported_payee ?? null, notes: raw.notes ?? null,
      cleared: raw.cleared ?? false, reconciled: raw.reconciled ?? false, starting_balance_flag: raw.starting_balance_flag ?? false,
      tombstone: raw.tombstone ?? false, is_parent: raw.is_parent ?? false, is_child: raw.is_child ?? false, error: raw.error ?? null });
    const children = (candidate as Record<string, unknown>).subtransactions;
    if (children !== undefined) {
      if (!Array.isArray(children) || children.length > 0 && !raw.is_parent) throw new Error('Invalid nested group');
      for (const child of children) visit(child, accountId, raw);
    }
  };
  for (const read of input.transactions) {
    if (read.startDate > read.endDate) throw new Error('Invalid coverage interval');
    if (!accounts.has(read.accountId)) continue;
    if (coverage.has(read.accountId)) throw new Error('Duplicate account coverage');
    coverage.set(read.accountId, { accountId: read.accountId, state: read.read.state,
      startDate: read.startDate, endDate: read.endDate, currencyState: 'known' });
    for (const row of read.read.items) visit(row, read.accountId);
  }
  for (const accountId of sourceAccountIds) {
    if (!coverage.has(accountId) || !accountMetadata.has(accountId)) coverage.set(accountId, {
      accountId, state: 'unavailable', startDate: input.startDate, endDate: input.endDate, currencyState: 'known',
    });
  }
  const rawRows = unique(flattened);
  const rawById = new Map(rawRows.map((row) => [row.id, row]));
  for (const row of rawRows) {
    const parent = row.parent_id ? rawById.get(row.parent_id) : undefined;
    if (parent && (!parent.is_parent || parent.account !== row.account)) throw new Error('Contradictory parent linkage');
  }
  if (payeesAllowed !== null) {
    for (const row of rawRows) if (admitted(row) && row.payee) payeesAllowed.add(row.payee);
  }
  const selectedPayees = selectIdentities(input.payees.items, payeesAllowed);
  const rawPayees = unique(selectedPayees.map((candidate) => payeeFields.parse(candidate)));
  const payees = normalizePayees(rawPayees as unknown as APIPayeeEntity[]).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const payeeById = new Map(payees.map((payee) => [payee.id, payee]));
  const rawCategories = unique(selectIdentities(input.categories.items, categoriesAllowed).map((candidate) => categoryFields.parse(candidate)));
  const groupIds = new Set(rawCategories.flatMap((category) => category.group_id ? [category.group_id] : []));
  const rawCategoryGroups = unique(selectIdentities(input.categoryGroups, groupIds).map((candidate) => groupFields.parse(candidate)));
  const categories = normalizeCategories(
    rawCategories as unknown as APICategoryEntity[],
    rawCategoryGroups as unknown as APICategoryGroupEntity[],
  );
  const rawGroups = new Map<string, RawTransaction[]>();
  for (const row of rawRows) {
    const occurrenceId = row.parent_id ?? row.id;
    const group = rawGroups.get(occurrenceId) ?? [];
    group.push(row);
    rawGroups.set(occurrenceId, group);
  }
  const eligible = (row: RawTransaction): boolean => !row.tombstone && !row.starting_balance_flag
    && !(row.payee && payeeById.get(row.payee)?.transferAccountId) && !row.error;
  const transactions: ActualMerchantSource['transactions'] = [];
  const admittedBeforeCap: ActualMerchantSource['transactions'] = [];
  let originalTransactionCount = 0;
  for (const occurrenceId of [...rawGroups.keys()].sort()) {
    const group = rawGroups.get(occurrenceId)!;
    const visible = group.filter(admitted);
    originalTransactionCount += visible.length;
    const parent = rawById.get(occurrenceId);
    const children = group.filter((row) => row.is_child);
    const complete = visible.length === group.length && group.every(eligible)
      && coverage.get(group[0]!.account)?.state === 'complete'
      && (children.length === 0 && !parent?.is_parent || Boolean(parent?.is_parent) && children.length > 0
        && children.reduce((sum, row) => sum + BigInt(row.amount), 0n) === BigInt(parent!.amount)
        && children.every((row) => row.account === parent!.account && Math.sign(row.amount) === Math.sign(parent!.amount)));
    const normalized = visible.map((row): ActualMerchantSource['transactions'][number] => ({
      id: row.id, accountId: row.account, date: row.date, payeeId: row.payee ?? null,
      payeeName: row.payee ? payeeById.get(row.payee)?.name ?? null : null, categoryId: row.category ?? null,
      amount: { minorUnits: String(row.amount), currency: input.currency },
      cleared: row.cleared ?? false, reconciled: row.reconciled ?? false, importedId: row.imported_id ?? null,
      importedPayee: sourceAdmitted(row) ? text(row.imported_payee) : { state: 'unavailable', value: null },
      notes: sourceAdmitted(row) ? text(row.notes) : { state: 'unavailable', value: null },
      description: { state: 'unsupported', value: null }, verboseTitle: { state: 'unsupported', value: null },
      isSplitParent: row.is_parent ?? false, isSplitChild: row.is_child ?? false, parentId: row.parent_id ?? null,
      occurrenceId, occurrenceComplete: complete, startingBalance: row.starting_balance_flag ?? false,
      transferAccountId: row.payee ? payeeById.get(row.payee)?.transferAccountId ?? null : null,
      deleted: row.tombstone ?? false, pending: false,
    }));
    admittedBeforeCap.push(...normalized);
    if (transactions.length + visible.length <= input.maxTransactions) transactions.push(...normalized);
  }
  const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // SDK rule array order is execution order, not incidental source enumeration order.
  const selectedRules = selectIdentities(input.rules.items, rulesAllowed);
  const rawRules = unique(selectedRules.map((candidate) => ruleFields.parse(candidate)));
  const admittedReference = (clause: z.infer<typeof actionFields>): boolean => {
    const allowed = clause.field === 'account' ? accounts : clause.field === 'category' ? categoriesAllowed : null;
    if (!allowed) return true;
    return Array.isArray(clause.value)
      ? clause.value.every((value) => typeof value === 'string' && allowed.has(value))
      : typeof clause.value === 'string' && allowed.has(clause.value);
  };
  const rules = rawRules.flatMap((raw, index) => {
    // Actual's category/is/null condition tests uncategorized state, not a category resource.
    const admittedRule = raw.conditions.every((clause) =>
      clause.field === 'category' && clause.op === 'is' && clause.value === null || admittedReference(clause))
      && raw.actions.every(admittedReference);
    return admittedRule ? [normalizeRule(raw as unknown as RuleEntity, index)] : [];
  });
  const rulesCoverage = rulesAllowed === null
    ? input.rules.state === 'complete' && rules.length !== rawRules.length ? 'partial' : input.rules.state
    : rulesAllowed.size === 0 || input.rules.state === 'unavailable' ? 'unavailable' : 'partial';
  const admittedSchedules = selectIdentities(input.schedules.items, schedulesAllowed).filter((candidate) => {
    if (candidate === null || typeof candidate !== 'object') throw new Error('Invalid schedule identity');
    const identity = candidate as Record<string, unknown>;
    const accountId = nullableId.parse(identity.account);
    if (accountId == null ? schedulesAllowed !== null
      : !accounts.has(accountId) || sourceAccountsAllowed !== null && !sourceAccountsAllowed.has(accountId)) return false;
    const ruleId = nullableId.parse(identity.rule);
    if (ruleId != null && rulesAllowed !== null && !rulesAllowed.has(ruleId)) return false;
    const payeeId = nullableId.parse(identity.payee);
    return payeeId == null || schedulePayeesAllowed === null || schedulePayeesAllowed.has(payeeId);
  });
  const rawSchedules = unique(admittedSchedules.map((candidate) => scheduleFields.parse(candidate))).filter((schedule) => !schedule.completed);
  const schedules = rawSchedules
    .map((schedule) => ({ payeeId: schedule.payee ?? null, source: normalizeActualScheduleLiquiditySource(schedule as unknown as APIScheduleEntity, input.currency) }))
    .sort((a, b) => a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0);
  const schedulesCoverage = schedulesAllowed !== null && schedulesAllowed.size === 0 || input.schedules.state === 'unavailable'
    ? 'unavailable' : schedulesAllowed !== null || sourceAccountsAllowed !== null || rulesAllowed !== null || schedulePayeesAllowed !== null
      ? 'partial' : input.schedules.state;
  const accountCoverage = [...coverage.values()].sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
  const sourceAdmission: ActualMerchantSource['sourceAdmission'] = {
    capturedAt: input.capturedAt, expiresAt: input.expiresAt, factsHash: '',
    collections: { transactions: aggregate(accountCoverage.map((account) => account.state)), payees: payeesAllowed === null
      ? input.payees.state : input.payees.state === 'unavailable' ? 'unavailable' : 'partial',
      categories: input.categories.state, rules: rulesCoverage, schedules: schedulesCoverage },
    accountCoverage, pendingState: 'excluded', originalTransactionCount,
    truncatedCount: originalTransactionCount - transactions.length, visibilityHash: input.admission.visibilityHash,
    sourceAccountIds, sourceCategoryIds,
  };
  const result = { transactions: sorted(transactions), payees, categories, rules: sorted(rules), schedules, sourceAdmission };
  const { capturedAt: _capture, expiresAt: _expiry, factsHash: _hash, ...stableAdmission } = sourceAdmission;
  sourceAdmission.factsHash = `sha256:${createHash('sha256').update(canonical({
    ...result, categories: sorted([...categories]), transactions: sorted(admittedBeforeCap), sourceAdmission: stableAdmission,
  })).digest('hex')}`;
  const dependencies: ActualMerchantSourceDependencies = {
    transactions: sorted(admittedBeforeCap).map((transaction) => ({
      id: transaction.id, accountId: transaction.accountId, categoryId: transaction.categoryId,
      payeeId: transaction.payeeId, amount: transaction.amount,
      rawSource: sourceAdmitted({ id: transaction.id, account: transaction.accountId }),
      isCompleteSplitParent: transaction.isSplitParent && transaction.occurrenceComplete,
    })),
    accountIds: sourceAccountIds,
    categoryIds: sourceCategoryIds,
    ruleIds: rules.map((rule) => rule.id),
    payeeIds: payees.map((payee) => payee.id),
    schedules: rawSchedules.map((schedule) => ({
      id: schedule.id, accountId: schedule.account ?? null, ruleId: schedule.rule ?? null, payeeId: schedule.payee ?? null,
    })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    payeeNamespace: input.admission.payeeIds == null,
    scheduleNamespace: schedulesAllowed === null,
  };
  return { ...result, dependencies };
}
