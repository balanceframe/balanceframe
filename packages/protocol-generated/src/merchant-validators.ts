import { z } from 'zod';
import type { Money } from './index.js';
import type {
  MerchantAnalysisRequest, MerchantNativeRuleBlock, MerchantNativeRulePart, MerchantNativeRuleSet,
} from './merchant-intelligence.js';

// These schemas mirror the Rust merchant boundary. Importing validators.ts here would
// create an initialization cycle through its merchant reexports; Money stays the same
// canonical decimal-string representation, with stricter merchant object admission.
const utf8 = new TextEncoder();
const boundedText = (maximum: number, nonempty = false) => z.string().max(maximum)
  .refine((value) => (!nonempty || value.length > 0) && utf8.encode(value).length <= maximum);
const id = boundedText(256, true);
const text = boundedText(4096);
const unsigned = z.number().int().min(0).max(4294967295);
const positiveCount = unsigned.refine((value) => value > 0);
const reasons = z.array(id).max(100);
const currency = z.string().regex(/^[A-Z]{3}$/);
const unsignedPattern = /^(?:0|[1-9][0-9]*)$/;
const i128Max = BigInt('170141183460469231731687303715884105727');
const decimal = (positive: boolean) => z.string().max(39).regex(unsignedPattern).refine((value) => {
  if (value.length > 39 || !unsignedPattern.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= (positive ? 1n : 0n) && parsed <= i128Max;
});
const signedPattern = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const money: z.ZodType<Money> = z.object({
  minorUnits: z.string().max(20).regex(signedPattern).refine((value) => {
    if (value.length > 20 || !signedPattern.test(value)) return false;
    const parsed = BigInt(value);
    return parsed >= -9223372036854775808n && parsed <= 9223372036854775807n;
  }),
  currency,
}).strict();

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
const civilDate = z.string().refine(validDate);
const timestamp = z.string().max(64).refine((value) => {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.[0-9]{1,9})?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  return match !== null && validDate(match[1]!) && Number(match[2]) <= 23
    && Number(match[3]) <= 59 && Number(match[4]) <= 59
    && (match[6] === undefined || (Number(match[6]) <= 23 && Number(match[7]) <= 59));
});

function instantNanoseconds(value: string): bigint | null {
  const whole = Date.parse(value.replace(/\.[0-9]+(?=[Zz]|[+-])/, ''));
  if (!Number.isFinite(whole)) return null;
  const fraction = /\.([0-9]{1,9})(?=[Zz]|[+-])/.exec(value)?.[1] ?? '';
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(9, '0'));
}
const zone = id.refine((value) => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
});
const collectionState = z.enum(['complete', 'partial', 'unavailable']);
const decisionState = z.enum(['unreviewed', 'accepted', 'rejected']);
const tier = z.enum(['confirmed', 'deterministic_match', 'inferred', 'insufficient_data', 'conflicting']);

/** Strict canonical namespace, without client-supplied authority assertions. */
export const merchantScopeSchema = z.object({ spaceId: id, budgetId: id, connectionId: id }).strict();

/** Exact availability/value combinations; no defaults or normalization erase source evidence. */
export const merchantTextFieldSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable'), value: z.null() }).strict(),
  z.object({ state: z.literal('unsupported'), value: z.null() }).strict(),
  z.object({ state: z.literal('absent'), value: z.null() }).strict(),
  z.object({ state: z.literal('empty'), value: z.literal('') }).strict(),
  z.object({ state: z.literal('present'), value: boundedText(4096, true) }).strict(),
]);

/** Explicit completeness for every required collection. */
export const merchantCollectionsSchema = z.object({
  transactions: collectionState, payees: collectionState, categories: collectionState,
  rules: collectionState, schedules: collectionState,
}).strict();

/** An account's admitted civil-date coverage and currency knowledge. */
export const merchantAccountCoverageSchema = z.object({
  accountId: id, state: collectionState, startDate: civilDate, endDate: civilDate,
  currencyState: z.enum(['known', 'unknown']),
}).strict().refine((value) => value.startDate <= value.endDate);

/** Freshness and full dependency manifest; sampled explanations cannot replace these IDs. */
export const merchantSourceAdmissionSchema = z.object({
  capturedAt: timestamp, factsHash: id, expiresAt: timestamp, collections: merchantCollectionsSchema,
  accountCoverage: z.array(merchantAccountCoverageSchema).max(100000),
  pendingState: z.enum(['unsupported', 'included', 'excluded']),
  originalTransactionCount: unsigned, truncatedCount: unsigned, visibilityHash: id,
  sourceAccountIds: z.array(id).max(100000), sourceCategoryIds: z.array(id).max(100000),
}).strict().refine((value) => {
  const captured = instantNanoseconds(value.capturedAt);
  const expires = instantNanoseconds(value.expiresAt);
  return captured !== null && expires !== null && expires > captured
    && value.truncatedCount <= value.originalTransactionCount
    && new Set(value.accountCoverage.map((coverage) => coverage.accountId)).size === value.accountCoverage.length;
});

/** Flattened source transaction with checked Money and internally established split identity. */
export const merchantTransactionSchema = z.object({
  id, accountId: id, date: civilDate, payeeId: id.nullable(), payeeName: text.nullable(),
  categoryId: id.nullable(), amount: money, cleared: z.boolean(), reconciled: z.boolean(),
  importedId: id.nullable(), importedPayee: merchantTextFieldSchema,
  description: merchantTextFieldSchema, verboseTitle: merchantTextFieldSchema, notes: merchantTextFieldSchema,
  isSplitParent: z.boolean(), isSplitChild: z.boolean(), parentId: id.nullable(), occurrenceId: id,
  occurrenceComplete: z.boolean(), startingBalance: z.boolean(), transferAccountId: id.nullable(),
  deleted: z.boolean(), pending: z.boolean(),
}).strict().refine((value) => !(value.isSplitParent && value.isSplitChild)
  && (value.isSplitChild ? value.parentId === value.occurrenceId
    : value.parentId === null && value.occurrenceId === value.id));

/** Attributed field-scoped alias; native identities are never rewritten here. */
export const merchantAliasSchema = z.object({
  id, sourceText: boundedText(4096, true),
  sourceField: z.enum(['payeeName', 'importedPayee', 'description', 'verboseTitle', 'notes']),
  targetPayeeId: id, accountId: id.nullable(), state: z.enum(['accepted', 'rejected']), actorId: id,
  version: positiveCount, updatedAt: timestamp, sourceTransactionIds: z.array(id).max(1000),
}).strict();

/** Verified category correction or revocation, never an assumed execution result. */
export const merchantCorrectionSchema = z.object({
  transactionId: id, payeeId: id.nullable(), accountId: id, categoryId: id,
  state: z.enum(['confirmed', 'revoked']), verified: z.boolean(), actorId: id, version: positiveCount,
}).strict();

/** Public holiday observation, not proof of bank-specific closure. */
export const merchantHolidaySchema = z.object({ date: civilDate, name: boundedText(4096, true) }).strict();

/** Explicit configured calendar; unknown jurisdictions remain valid uncertainty inputs. */
export const merchantCalendarSchema = z.object({
  accountId: id.nullable(), jurisdiction: id, subdivision: id.nullable(), timeZone: zone, version: id,
  coverageStart: civilDate, coverageEnd: civilDate, holidays: z.array(merchantHolidaySchema).max(36600),
}).strict().refine((value) => value.coverageStart <= value.coverageEnd);

const scheduleRecurrence = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']), interval: unsigned.nullable(),
  patterns: z.array(z.object({ kind: z.enum(['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa', 'day']),
    value: z.number().int().min(-2147483648).max(2147483647),
  }).strict()).max(100).nullable(),
  start: civilDate, endMode: z.enum(['never', 'after_n_occurrences', 'on_date']).nullable(),
  endOccurrences: unsigned.nullable(), endDate: civilDate.nullable(), skipWeekend: z.boolean().nullable(),
  weekendSolveMode: z.enum(['before', 'after']).nullable(),
}).strict();
const scheduleSource = z.object({
  id, accountId: id.nullable(), categoryId: id.nullable(), ruleId: id.nullable(), dueDate: civilDate.nullable(),
  certainty: z.enum(['exact', 'approximate', 'range', 'unknown']), amount: money.nullable(),
  minimum: money.nullable(), maximum: money.nullable(), recurrence: scheduleRecurrence.nullable(),
}).strict();

/** Canonical ScheduleLiquidityFact source, retaining nullable/unknown precision and cadence options. */
export const merchantScheduleSchema = z.object({ payeeId: id.nullable(), source: scheduleSource }).strict();

/** Attributed pattern user intent; revocation restores ordinary current analysis. */
export const merchantPatternDecisionSchema = z.object({
  id, patternId: id, state: z.enum(['accepted', 'rejected', 'revoked']), actorId: id,
  version: positiveCount, updatedAt: timestamp,
}).strict();

/** Exclusive actual-ID cursor over the admitted candidate selection. */
export const merchantSuggestionSelectionSchema = z.object({
  transactionIds: z.array(id).max(250000), cursor: id.nullable(), limit: z.number().int().min(1).max(1000),
}).strict();

const payee = z.object({ id, name: text, transferAccountId: id.nullable(), mtid: text.nullable() }).strict();
const category = z.object({ id, name: text, groupName: text.nullable(), isIncome: z.boolean(),
  mtid: text.nullable(), deleted: z.boolean(),
}).strict();
// Native rule payloads are intentionally opaque canonical JSON. Unsupported rule shapes
// are an engine abstention, not an excuse to strip them or invent narrower source facts.
const requiredJson = z.custom<NonNullable<unknown> | null>((input: unknown) => {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 10000 || depth > 32) return false;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
    } else if (typeof value === 'string') {
      if (value.length > 4096 || utf8.encode(value).length > 4096) return false;
    } else if (Array.isArray(value)) {
      if (value.length > 10000 - nodes - stack.length) return false;
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else if (typeof value === 'object') {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) return false;
      const keys = Object.keys(value);
      if (keys.length > 10000 - nodes - stack.length) return false;
      for (const key of keys) {
        if (key.length > 4096 || utf8.encode(key).length > 4096) return false;
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
      }
    } else return false;
  }
  return true;
}, { message: 'Invalid or oversized native rule JSON' });
const rule = z.object({ id, name: text, order: unsigned, trigger: requiredJson,
  actions: requiredJson, inactive: z.boolean(),
}).strict();

function conflictingTransactions(transactions: MerchantAnalysisRequest['transactions']): boolean {
  const ids = new Map<string, MerchantAnalysisRequest['transactions'][number]>();
  const imports = new Map<string, MerchantAnalysisRequest['transactions'][number]>();
  for (const transaction of transactions) {
    const previous = ids.get(transaction.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(transaction)) return true;
    ids.set(transaction.id, transaction);
    if (transaction.importedId !== null) {
      const key = JSON.stringify([transaction.accountId, transaction.importedId]);
      const priorImport = imports.get(key);
      if (priorImport) {
        // Observation IDs are not part of imported-source fact equivalence.
        for (const field of Object.keys(transaction) as (keyof typeof transaction)[]) {
          if (field !== 'id' && field !== 'occurrenceId' && field !== 'importedId'
            && JSON.stringify(priorImport[field]) !== JSON.stringify(transaction[field])) return true;
        }
      }
      imports.set(key, transaction);
    }
  }
  return false;
}

/** Strict merchant/2 input; omission of selection stays omitted in parse/roundtrip. */
export const merchantAnalysisRequestSchema = z.object({
  schemaVersion: z.literal('1'), scope: merchantScopeSchema, snapshotId: id, asOfDate: civilDate,
  normalizationVersion: z.literal('merchant/2'), sourceAdmission: merchantSourceAdmissionSchema,
  transactions: z.array(merchantTransactionSchema).max(250000), payees: z.array(payee).max(100000),
  categories: z.array(category).max(100000), rules: z.array(rule).max(100000),
  aliases: z.array(merchantAliasSchema).max(100000), corrections: z.array(merchantCorrectionSchema).max(250000),
  schedules: z.array(merchantScheduleSchema).max(100000), patternDecisions: z.array(merchantPatternDecisionSchema).max(100000),
  calendars: z.array(merchantCalendarSchema).max(1000), horizonYears: z.number().int().min(1).max(10),
  maxEvidence: z.number().int().min(1).max(100), suggestionSelection: merchantSuggestionSelectionSchema.optional(),
}).strict().refine((value) => !conflictingTransactions(value.transactions), { message: 'Conflicting source identity' });

/** Bounded evidence provenance with civil date or RFC3339 source time. */
export const merchantEvidenceSchema = z.object({
  kind: z.enum(['source_observation', 'normalized_evidence', 'confirmed_decision', 'native_rule', 'semantic_suggestion']),
  sourceId: id, field: text.nullable(), rawText: text.nullable(), normalizedText: text.nullable(),
  sourceTime: z.union([civilDate, timestamp]).nullable(), version: id, reasonCode: id,
}).strict();

/** Exact full group outcomes, with corrections replacing rather than adding ledger rows. */
export const merchantCategoryHistoryEntrySchema = z.object({
  categoryId: id, count: positiveCount.refine((value) => value <= 250000),
  firstDate: civilDate, lastDate: civilDate, ledgerCount: unsigned, correctionCount: unsigned,
}).strict().refine((value) => value.ledgerCount + value.correctionCount === value.count && value.firstDate <= value.lastDate);

/** Full totals and bounded unique entries; truncation is never inferred from samples. */
export const merchantCategoryHistorySchema = z.object({
  totalCount: unsigned.refine((value) => value <= 250000), categoryCount: unsigned,
  entries: z.array(merchantCategoryHistoryEntrySchema).max(100), truncated: z.boolean(),
}).strict().refine((value) => {
  const sum = value.entries.reduce((sum, entry) => sum + entry.count, 0);
  return value.categoryCount <= value.totalCount && value.entries.length <= value.categoryCount
    && value.truncated === (value.entries.length < value.categoryCount)
    && new Set(value.entries.map((entry) => entry.categoryId)).size === value.entries.length
    && (value.truncated ? sum < value.totalCount : sum === value.totalCount);
});

/** Competing evidence with exact support, not invented numerical confidence. */
export const merchantAlternativeSchema = z.object({
  categoryId: id, supportCount: positiveCount, tier, reasonCodes: reasons,
}).strict();

/** Advice from an unchanged min-three/ninety-percent native history winner. */
export const merchantRuleCandidateSchema = z.object({
  payeeId: id, categoryId: id, supportCount: unsigned,
  consistencyNumerator: unsigned, consistencyDenominator: unsigned.refine((value) => value <= 250000),
}).strict().refine((value) => value.supportCount >= 3 && value.supportCount === value.consistencyNumerator
  && value.consistencyNumerator <= value.consistencyDenominator
  && value.consistencyNumerator * 100 >= value.consistencyDenominator * 90);

// Rust's lexical UTF-8 ordering compares Unicode scalar values, not UTF-16 units.
function nativeIdBefore(left: string, right: string): boolean {
  let a = 0; let b = 0;
  while (a < left.length && b < right.length) {
    const x = left.codePointAt(a)!; const y = right.codePointAt(b)!;
    if (x !== y) return x < y;
    a += x > 65535 ? 2 : 1; b += y > 65535 ? 2 : 1;
  }
  return a === left.length && b < right.length;
}

/** Structural shared provenance: legacy sources keep their existing ID/count contract. */
export const nativeRuleBlockSchema = z.object({
  ruleIds: z.array(z.string().min(1).regex(/^[^\uD800-\uDFFF]+$/u)).min(1)
    .refine((ids) => ids.every((value, index) => index === 0 || nativeIdBefore(ids[index - 1], value))),
}).strict();
const partReferences = z.array(unsigned)
  .refine((indexes) => indexes.every((value, index) => index === 0 || indexes[index - 1] < value));
export const nativeRulePartSchema = z.object({ blockIndexes: partReferences.refine((values) => values.length > 0) }).strict();
export const nativeRuleSetSchema = z.object({
  orPartIndexes: partReferences.refine((values) => values.length <= 4),
  andPartIndexes: z.array(partReferences.refine((values) => values.length <= 2))
    .refine((operands) => operands.length === 0 || operands.length === 4),
  categoryPartIndex: unsigned,
}).strict();

function containsIndex(values: readonly number[], index: number): boolean {
  let start = 0; let end = values.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (values[middle] < index) start = middle + 1; else end = middle;
  }
  return values[start] === index;
}

// Literal witnesses only: no source predicate evaluation or expanded union per set.
interface NativeWitnessDomain {
  sources: [readonly number[], readonly number[]]; positions: [number, number];
  other: readonly number[]; kind: number; cost: number;
}

function nativeRuleSetHasWitness(set: MerchantNativeRuleSet, parts: readonly MerchantNativeRulePart[]): boolean {
  const category = parts[set.categoryPartIndex].blockIndexes;
  const empty: readonly number[] = [];
  const domains = set.orPartIndexes.map<NativeWitnessDomain>((reference, kind) => {
    const operand = parts[reference].blockIndexes;
    const candidates = operand.length < category.length ? operand : category;
    return { sources: [candidates, empty], positions: [0, 0],
      other: candidates === operand ? category : operand, kind, cost: candidates.length };
  });
  if (set.andPartIndexes.length !== 0 && set.andPartIndexes.every((operand) => operand.length !== 0)) {
    let shortest = -1; let cost = category.length;
    for (let field = 0; field < 4; field++) {
      const size = set.andPartIndexes[field].reduce((sum, reference) => sum + parts[reference].blockIndexes.length, 0);
      if (size < cost) { shortest = field; cost = size; }
    }
    const operand = shortest === -1 ? [] : set.andPartIndexes[shortest];
    domains.push({ sources: shortest === -1 ? [category, empty]
      : [parts[operand[0]].blockIndexes, parts[operand[1]]?.blockIndexes ?? empty],
      positions: [0, 0], other: empty, kind: 4, cost });
  }
  domains.sort((left, right) => left.cost - right.cost || left.kind - right.kind);
  while (true) {
    let advanced = false;
    for (const domain of domains) {
      const first = domain.sources[0].at(domain.positions[0]);
      const second = domain.sources[1].at(domain.positions[1]);
      if (first === undefined && second === undefined) continue;
      const index = first === undefined ? second! : second === undefined ? first : Math.min(first, second);
      if (first === index) domain.positions[0]++;
      if (second === index) domain.positions[1]++;
      advanced = true;
      const matches = domain.kind < 4 ? containsIndex(domain.other, index)
        : containsIndex(category, index) && set.andPartIndexes.every((operand) =>
          operand.some((reference) => containsIndex(parts[reference].blockIndexes, index)));
      if (matches) return true;
    }
    if (!advanced) return false;
  }
}

interface NativeRuleTables {
  nativeRuleBlocks: MerchantNativeRuleBlock[];
  nativeRuleParts: MerchantNativeRulePart[];
  nativeRuleSets: MerchantNativeRuleSet[];
}
function checkNativeRuleTables(value: NativeRuleTables, used: readonly number[], context: z.RefinementCtx): void {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const ids = new Set<string>();
  for (const block of value.nativeRuleBlocks) for (const id of block.ruleIds) {
    if (ids.has(id)) fail('Native blocks must have disjoint IDs');
    ids.add(id);
  }
  if (value.nativeRuleParts.length > 13 * value.nativeRuleSets.length) fail('Native parts exceed referenced expression edges');
  let valid = true;
  for (const part of value.nativeRuleParts) {
    if (part.blockIndexes.length === 0 || part.blockIndexes.length > value.nativeRuleBlocks.length
      || part.blockIndexes.some((index, position) => !Number.isInteger(index) || index < 0 || index >= value.nativeRuleBlocks.length
        || (position > 0 && part.blockIndexes[position - 1] >= index))) {
      fail('Native part references a missing block'); valid = false;
    }
  }
  const usedSets = new Set<number>();
  for (const index of used) {
    if (!Number.isInteger(index) || index < 0 || index >= value.nativeRuleSets.length) fail('Native outcome references a missing set');
    else usedSets.add(index);
  }
  if (usedSets.size !== value.nativeRuleSets.length) fail('Native sets must be used by outcomes');
  for (const set of value.nativeRuleSets) {
    if (set.orPartIndexes.length > 4 || (set.andPartIndexes.length !== 0 && set.andPartIndexes.length !== 4)
      || set.andPartIndexes.some((operand) => operand.length > 2)) {
      fail('Native expression has noncanonical operands'); continue;
    }
    const present = (index: number) => Number.isInteger(index) && index >= 0 && index < value.nativeRuleParts.length;
    if (!present(set.categoryPartIndex) || !set.orPartIndexes.every(present)
      || !set.andPartIndexes.every((operand) => operand.every(present))) fail('Native expression references a missing part');
    else if (valid && !nativeRuleSetHasWitness(set, value.nativeRuleParts)) fail('Native classified expression is empty');
  }
}
function canonicalNativeRuleTables<T extends NativeRuleTables>(value: T): T {
  for (const set of value.nativeRuleSets) {
    if (set.andPartIndexes.some((operand) => operand.length === 0)) set.andPartIndexes = [];
  }
  return value;
}
const nativeRuleTablesSchema = z.object({
  nativeRuleBlocks: z.array(nativeRuleBlockSchema), nativeRuleParts: z.array(nativeRulePartSchema),
  nativeRuleSets: z.array(nativeRuleSetSchema), usedSetIndexes: z.array(unsigned),
}).superRefine((value, context) => checkNativeRuleTables(value, value.usedSetIndexes, context))
  .transform(canonicalNativeRuleTables);

/** Validates generic captured-source tables once; merchant caps belong to merchant owners. */
export function validateNativeRuleTables(blocks: unknown, parts: unknown, sets: unknown, usedSetIndexes: readonly number[]): NativeRuleTables {
  const { usedSetIndexes: _used, ...tables } = nativeRuleTablesSchema.parse({
    nativeRuleBlocks: blocks, nativeRuleParts: parts, nativeRuleSets: sets, usedSetIndexes,
  });
  return tables;
}

/** Full uncategorized native matches referencing the result's shared table. */
export const merchantNativeRuleClassificationSchema = z.object({
  transactionId: id, accountId: id, categoryId: id, ruleSetIndex: unsigned,
}).strict();

/** Complete actionable non-native category targets with conservative evidence tiers. */
export const merchantCategoryClassificationSchema = z.object({
  transactionId: id, accountId: id, payeeId: id.nullable(), categoryId: id,
  tier: z.enum(['confirmed', 'inferred']), evidenceRevision: id,
}).strict();

/** Explainable nonmutating suggestion with separately retained contradictions. */
export const merchantSuggestionSchema = z.object({
  transactionId: id, accountId: id, payeeId: id.nullable(), categoryId: id.nullable(), tier,
  reasonCodes: reasons, evidence: z.array(merchantEvidenceSchema).max(100),
  contradictions: z.array(merchantEvidenceSchema).max(100), supportCount: unsigned, evidenceRevision: id,
  categoryHistory: merchantCategoryHistorySchema,
  alternatives: z.array(merchantAlternativeSchema).max(100)
    .refine((values) => new Set(values.map((value) => value.categoryId)).size === values.length),
  ruleCandidates: z.array(merchantRuleCandidateSchema).max(100),
}).strict();

const countMap = (key: z.ZodType<string>, allowZero = false) => z.record(key, allowZero ? unsigned : positiveCount);
const countKey = (minimum: number, maximum: number) => z.string().regex(unsignedPattern)
  .refine((value) => Number(value) >= minimum && Number(value) <= maximum);
const yearKey = z.string().regex(/^[0-9]{4}$/).refine((value) => Number(value) >= 1);
const weekKey = z.string().regex(/^[0-9]{4}-W(?:0[1-9]|[1-4][0-9]|5[0-3])$/).refine((value) => {
  const year = Number(value.slice(0, 4));
  const week = Number(value.slice(6));
  // An ISO year has week 53 only when January 1 is Thursday, or Wednesday in a leap year.
  const first = new Date(0);
  first.setUTCFullYear(year, 0, 1);
  const weekday = first.getUTCDay();
  return week < 53 || weekday === 4 || (weekday === 3 && validDate(`${value.slice(0, 4)}-02-29`));
});
const monthKey = z.string().regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])$/);
const occurrenceDistribution = (key: z.ZodType<string>) => z.object({
  periodCounts: countMap(key, true).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 10000),
  countDistribution: countMap(decimal(false)), averageNumerator: decimal(false), averageDenominator: decimal(true),
}).strict();

/** Generic distribution shape; recurrence schemas additionally enforce week/month/year key domains. */
export const merchantOccurrenceDistributionSchema = occurrenceDistribution(z.string());

/** Measured recurrence with exact amount range and paired checked-overflow variance. */
export const merchantRecurrenceSchema = z.object({
  id, accountId: id, payeeId: id.nullable(), normalizedMerchant: text, currency,
  direction: z.enum(['inflow', 'outflow', 'zero']), tier, kind: z.literal('observed'),
  frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'multiple', 'irregular']),
  decisionState, occurrences: unsigned, transactionIds: z.array(id).max(100), dates: z.array(civilDate).max(100),
  firstDate: civilDate, lastDate: civilDate,
  intervalDays: z.array(unsigned).max(100), intervalDistribution: countMap(countKey(0, 36600)),
  dayOfMonth: countMap(countKey(1, 31)), dayOfWeek: countMap(countKey(1, 7)),
  monthOfYear: countMap(countKey(1, 12)), yearDistribution: countMap(yearKey),
  occurrencesPerWeek: occurrenceDistribution(weekKey), occurrencesPerMonth: occurrenceDistribution(monthKey),
  occurrencesPerYear: occurrenceDistribution(z.string().regex(/^[0-9]{4}$/)),
  minimumAmount: money, maximumAmount: money, varianceNumerator: decimal(false).nullable(),
  varianceDenominator: decimal(true).nullable(), reasonCodes: reasons, calendarVersion: id.nullable(), evidenceRevision: id,
}).strict().refine((value) => value.minimumAmount.currency === value.currency && value.maximumAmount.currency === value.currency
  && value.minimumAmount.minorUnits.length <= 20 && value.maximumAmount.minorUnits.length <= 20
  && signedPattern.test(value.minimumAmount.minorUnits) && signedPattern.test(value.maximumAmount.minorUnits)
  && BigInt(value.minimumAmount.minorUnits) <= BigInt(value.maximumAmount.minorUnits))
  .refine((value) => value.firstDate <= value.lastDate
    && value.dates.every((date) => date >= value.firstDate && date <= value.lastDate), 'Invalid full recurrence date range')
  .refine((value) => value.varianceNumerator !== null && value.varianceDenominator !== null
    || value.varianceNumerator === null && value.varianceDenominator === null && value.reasonCodes.includes('amount_statistics_overflow'));

/** Scheduled source facts remain independent of measured recurrence statistics. */
export const merchantScheduledExpectationSchema = z.object({
  id, payeeId: id.nullable(), source: scheduleSource, reasonCodes: reasons, decisionState,
}).strict();

/** Effective coverage includes paired nullable civil-date endpoints for empty captures. */
export const merchantCoverageSchema = z.object({
  startDate: civilDate.nullable(), endDate: civilDate.nullable(), inputCount: unsigned, eligibleCount: unsigned,
  excludedCount: unsigned, limited: z.boolean(), reasonCodes: reasons,
}).strict().refine((value) => (value.startDate === null) === (value.endDate === null));

/** Optional selected suggestion page, separate from full aggregate counts. */
export const merchantSuggestionPageSchema = z.object({
  eligibleCandidates: unsigned, returned: unsigned.refine((value) => value <= 1000), nextCursor: id.nullable(),
}).strict().refine((value) => value.returned <= value.eligibleCandidates);

/** Strict canonical result; an absent suggestion page stays absent without default filling. */
export const merchantAnalysisResultSchema = z.object({
  schemaVersion: z.literal('1'), scope: merchantScopeSchema, snapshotId: id, normalizationVersion: z.literal('merchant/2'),
  sourceAdmission: merchantSourceAdmissionSchema, coverage: merchantCoverageSchema,
  suggestions: z.array(merchantSuggestionSchema), recurrences: z.array(merchantRecurrenceSchema),
  scheduledExpectations: z.array(merchantScheduledExpectationSchema), suggestionPage: merchantSuggestionPageSchema.optional(),
  nativeRuleBlocks: z.array(nativeRuleBlockSchema).max(100000),
  nativeRuleParts: z.array(nativeRulePartSchema).max(3250000),
  nativeRuleSets: z.array(nativeRuleSetSchema).max(250000),
  nativeRuleClassifications: z.array(merchantNativeRuleClassificationSchema).max(250000)
    .refine((values) => new Set(values.map((value) => value.transactionId)).size === values.length),
  categoryClassifications: z.array(merchantCategoryClassificationSchema).max(250000),
}).strict().superRefine((value, context) => {
  checkNativeRuleTables(value, value.nativeRuleClassifications.map((row) => row.ruleSetIndex), context);
  const classifiedIds = new Set(value.nativeRuleClassifications.map((row) => row.transactionId));
  const accounts = new Set(value.sourceAdmission.sourceAccountIds);
  const categories = new Set(value.sourceAdmission.sourceCategoryIds);
  value.categoryClassifications.forEach((row, index) => {
    if (classifiedIds.has(row.transactionId) || !accounts.has(row.accountId) || !categories.has(row.categoryId))
      context.addIssue({ code: 'custom', path: ['categoryClassifications', index],
        message: 'Compact category target has conflicting identity or unadmitted source dependencies' });
    classifiedIds.add(row.transactionId);
  });
  let count = 0;
  for (const block of value.nativeRuleBlocks) {
    count += block.ruleIds.length;
    if (count > 100000 || block.ruleIds.some((value) => utf8.encode(value).length > 256)) {
      context.addIssue({ code: 'custom', message: 'Native rule IDs exceed merchant source bounds' });
      break;
    }
  }
}).refine((value) => value.suggestions.every((suggestion) =>
  suggestion.alternatives.every((alternative) => alternative.categoryId !== suggestion.categoryId)))
  .transform(canonicalNativeRuleTables);
