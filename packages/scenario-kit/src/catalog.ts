import { existsSync, readFileSync } from 'node:fs';

import type {
  Account,
  Category,
  DecisionCardAdjustment,
  DecisionCardCategoryPolicy,
  DecisionCardPriceProvenance,
  Money,
  ProtocolSnapshot,
  Transaction,
} from '@balanceframe/protocol-generated';
import {
  liquidityObservationInputSchema,
  liquidityPolicyInputSchema,
  liquidityPurchaseInputSchema,
  spendSessionInputSchema,
  lookupMerchantCalendar,
} from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type {
  LiquidityPurchaseIntent,
  PublicLiquidityObservationInput,
  PublicLiquidityPolicyInput,
  PublicUserAttestedObservation,
  SpendSessionIntent,
  MerchantCalendarSelection,
} from '@balanceframe/application';
import type { ResourceCapability, ResourceKind } from '@balanceframe/workflow-store';
import { z } from 'zod';

import { isScenarioId, SCENARIO_IDS } from './scenario-manifest.js';
export { SCENARIO_IDS } from './scenario-manifest.js';

const REFERENCE_ANCHOR = new Date('2026-09-06T12:00:00.000Z');
const REFERENCE_DATE = '2026-09-06';
const REFERENCE_MONTH = '2026-09';
const ACTUAL_SAFE_MINOR_UNITS = 9_007_199_254_740_991n;
const SIGNED_I64_MIN = -9_223_372_036_854_775_808n;
const SIGNED_I64_MAX = 9_223_372_036_854_775_807n;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUSEHOLD_BUDGET_ID = 'budget-2026-09';

function resolveFixtureUrl(name: 'household' | 'merchant'): URL {
  const candidates = [
    new URL(`../../../protocol/fixtures/scenarios/${name}.json`, import.meta.url),
    new URL(`../../protocol/fixtures/scenarios/${name}.json`, import.meta.url),
  ];
  const fixture = candidates.find((candidate) => existsSync(candidate));
  if (!fixture) {
    throw new Error(`${name} scenario fixture is not available`);
  }
  return fixture;
}

const FIXTURE_URL = resolveFixtureUrl('household');
const FIXTURE = canonicalProtocolSnapshotSchema.parse(
  JSON.parse(readFileSync(FIXTURE_URL, 'utf8')),
) as ProtocolSnapshot;

if (FIXTURE.snapshotDate !== REFERENCE_ANCHOR.toISOString()) {
  throw new Error('household scenario fixture must use the approved reference anchor');
}

const MERCHANT_FIXTURE = z.object({
  sourceAsOfDate: z.literal('2026-10-04'),
  provenance: z.object({
    kind: z.literal('synthetic'),
    sourceFixture: z.literal('merchant-quality.synthetic.json'),
    generatorVersion: z.literal('merchant-quality-synthetic/1'),
    seed: z.literal(110042),
    limitations: z.array(z.string()),
  }).strict(),
  ledger: canonicalProtocolSnapshotSchema,
}).strict().parse(JSON.parse(readFileSync(resolveFixtureUrl('merchant'), 'utf8')));

if (MERCHANT_FIXTURE.ledger.snapshotDate.slice(0, 10) !== MERCHANT_FIXTURE.sourceAsOfDate)
  throw new Error('Merchant fixture source anchor is inconsistent');

/** Version of the checked scenario catalog and emitted verification records. */
export const SCENARIO_CATALOG_VERSION = '1';


export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type ScenarioFeatureGroup =
  | 'Purchase'
  | 'Funding'
  | 'Payment'
  | 'Evidence'
  | 'Claims'
  | 'Cart'
  | 'Completion'
  | 'Reconciliation'
  | 'Governance'
  | 'Merchant';

/** Presentation metadata shown by the local/demo selector. */
export interface ScenarioSummary {
  readonly id: ScenarioId;
  readonly featureGroup: ScenarioFeatureGroup;
  readonly title: string;
  readonly summary: string;
  readonly suggestedActions: readonly string[];
  readonly supportedEventIds: readonly ScenarioEventId[];
}

export type ScenarioEventId =
  | 'categorize-uncategorized'
  | 'import-match'
  | 'import-ambiguous'
  | 'merchant-source-change'
  | 'merchant-calendar-clear'
  | 'invite-redeem'
  | 'invite-revoke'
  | 'invite-rejoin'
  | 'membership-revoke'
  | 'assistant-probe'
  | 'assistant-revoke'
  | 'scoped-grant-change'
  | 'scoped-grant-revoke'
  | 'research-expire'
  | 'research-hold'
  | 'research-release'
  | 'research-cancel';

export type ScenarioPolicy = Omit<PublicLiquidityPolicyInput, 'expectedVersion'>;
export type ScenarioObservations = Omit<PublicLiquidityObservationInput, 'expectedVersion'>;
type ScenarioAccountPolicy = ScenarioPolicy['accounts'][number];

export interface PersonaGrant {
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly capability: ResourceCapability;
  readonly granted: boolean;
}

export interface ScenarioPersona {
  readonly id: string;
  readonly role: 'owner' | 'coapprover' | 'restricted';
  readonly displayName: string;
  readonly membership: {
    readonly status: 'active';
    readonly capabilities: readonly ResourceCapability[];
  };
  readonly grants: readonly PersonaGrant[];
}

/** Invitation intent is not a provisioned human identity or membership. */
export interface ScenarioPendingInvitation {
  readonly personaId: 'invitee';
  readonly displayName: string;
  readonly capabilities: readonly ResourceCapability[];
  readonly grants: readonly PersonaGrant[];
}

export type ScenarioGovernanceRecipe =
  | {
      readonly kind: 'scoped-access';
      readonly limitedPersonaId: 'limited';
      readonly visibleAccountIds: readonly string[];
      readonly withheldAccountIds: readonly string[];
    }
  | {
      readonly kind: 'invitation-lifecycle';
      readonly pendingInvitations: readonly ScenarioPendingInvitation[];
    }
  | {
      readonly kind: 'delegated-assistant';
      readonly assistant: {
        readonly id: 'assistant';
        readonly displayName: string;
        readonly grants: readonly PersonaGrant[];
      };
    }
  | {
      readonly kind: 'coapproval-audit';
      readonly readerPersonaIds: readonly string[];
    };

export interface ScenarioMerchantRecipe {
  readonly historyTransactionIds: readonly string[];
  readonly targetTransactionIds: readonly string[];
  readonly calendar?: {
    readonly budget: MerchantCalendarSelection | null;
    readonly accounts: readonly { readonly accountId: string; readonly selection: MerchantCalendarSelection | null }[];
  };
}

/** Private runners select a closed fixture provider; no URL, key or analysis is supplied. */
export interface ScenarioResearchRecipe {
  readonly provider: 'fixture';
  readonly mode: 'success' | 'outage' | 'held';
}

export interface ScenarioClaimRecipe {
  readonly kind: 'reservation' | 'commitment';
  readonly sessionKey: string;
  readonly scope: { readonly kind: 'category' | 'account'; readonly id: string };
  readonly mode?: 'inform' | 'block';
}

/** A recipe contains only executable completion intent; runtime IDs and amounts come from the Card/API. */
export interface ScenarioCompletionRecipe {
  readonly sessionKey: string;
  readonly stage: 'proposed' | 'approved' | 'verified';
  readonly approvers: readonly string[];
}

export interface CategorizeUncategorizedEvent {
  readonly kind: 'categorize-uncategorized';
  readonly transactionId: string;
  readonly categoryId: string;
  readonly amount: Money;
}

export interface ImportCandidate {
  readonly importedId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly date: string;
  readonly payeeName: string;
}

export interface ImportMatchEvent {
  readonly kind: 'import-match';
  readonly candidate: ImportCandidate;
}

export interface ImportAmbiguousEvent {
  readonly kind: 'import-ambiguous';
  readonly candidates: readonly [ImportCandidate, ImportCandidate];
}

export interface MerchantSourceChangeEvent {
  readonly kind: 'merchant-source-change';
  readonly payeeId: string;
  readonly transactionId: string;
  readonly payeeName: string;
  readonly importedPayee: string;
  readonly notes: string;
}

export type ScenarioControlEvent =
  | { readonly kind: 'merchant-calendar-clear' }
  | { readonly kind: 'invitation-redeem' | 'invitation-rejoin'; readonly personaId: 'invitee' }
  | { readonly kind: 'membership-revoke'; readonly personaId: 'limited' | 'invitee' }
  | { readonly kind: 'assistant-probe' | 'assistant-revoke' }
  | {
      readonly kind: 'scoped-grant-change' | 'scoped-grant-revoke';
      readonly personaId: 'limited';
      readonly resourceId: string;
      readonly capability: 'name' | 'existence';
      readonly granted: boolean;
    }
  | { readonly kind: 'research-expire'; readonly offsetMs: 3_600_001 }
  | { readonly kind: 'research-hold' | 'research-release' | 'research-cancel' };

export type ScenarioEventRecipe =
  | CategorizeUncategorizedEvent
  | ImportMatchEvent
  | ImportAmbiguousEvent
  | MerchantSourceChangeEvent
  | ScenarioControlEvent;

export type ScenarioEntry =
  | { readonly kind: 'purchase'; readonly input: LiquidityPurchaseIntent }
  | { readonly kind: 'session'; readonly sessionKey: string }
  | { readonly kind: 'completion'; readonly sessionKey: string; readonly completionKey: string }
  | { readonly kind: 'page'; readonly path: '/spaces' | '/review' | '/rules' | '/' };

export interface MaterializedScenario {
  readonly id: ScenarioId;
  readonly anchor: string;
  readonly ledger: ProtocolSnapshot;
  readonly policy: ScenarioPolicy;
  readonly observations: ScenarioObservations;
  readonly personas: readonly ScenarioPersona[];
  readonly sessions: Readonly<Record<string, SpendSessionIntent>>;
  readonly claims: Readonly<Record<string, ScenarioClaimRecipe>>;
  readonly completions: Readonly<Record<string, ScenarioCompletionRecipe>>;
  readonly entry: ScenarioEntry;
  readonly events: Readonly<Record<string, ScenarioEventRecipe>>;
  readonly governance?: ScenarioGovernanceRecipe;
  readonly merchant?: ScenarioMerchantRecipe;
  readonly research?: ScenarioResearchRecipe;
}

type MutableScenario = {
  id: ScenarioId;
  anchor: string;
  ledger: ProtocolSnapshot;
  policy: ScenarioPolicy;
  observations: ScenarioObservations;
  personas: ScenarioPersona[];
  sessions: Record<string, SpendSessionIntent>;
  claims: Record<string, ScenarioClaimRecipe>;
  completions: Record<string, ScenarioCompletionRecipe>;
  entry: ScenarioEntry;
  events: Record<string, ScenarioEventRecipe>;
  governance?: ScenarioGovernanceRecipe;
  merchant?: ScenarioMerchantRecipe;
  research?: ScenarioResearchRecipe;
};

interface BuildContext {
  readonly anchor: Date;
  readonly anchorIso: string;
  readonly dayDelta: number;
  readonly monthDelta: number;
  instant(offsetMs?: number): string;
  date(offsetDays?: number): string;
  month(offsetMonths?: number): string;
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${label}`);
  }
}

function utcDayNumber(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid canonical UTC date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid canonical UTC date: ${value}`);
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function monthNumber(value: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid canonical UTC month: ${value}`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid canonical UTC month: ${value}`);
  return Number(match[1]) * 12 + month - 1;
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonths(value: string, months: number): string {
  const index = monthNumber(value) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function makeContext(anchor: Date): BuildContext {
  assertDate(anchor, 'anchor');
  const anchorIso = anchor.toISOString();
  const dayDelta = utcDayNumber(anchorIso.slice(0, 10)) - utcDayNumber(REFERENCE_DATE);
  const monthDelta = monthNumber(anchorIso.slice(0, 7)) - monthNumber(REFERENCE_MONTH);
  const deltaMs = anchor.getTime() - REFERENCE_ANCHOR.getTime();
  return {
    anchor,
    anchorIso,
    dayDelta,
    monthDelta,
    instant(offsetMs = 0) {
      return new Date(anchor.getTime() + offsetMs).toISOString();
    },
    date(offsetDays = 0) {
      return addUtcDays(anchorIso.slice(0, 10), offsetDays);
    },
    month(offsetMonths = 0) {
      return addMonths(anchorIso.slice(0, 7), offsetMonths);
    },
  };
}

function isCanonicalMoney(value: string): boolean {
  return /^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value);
}

function safeMinorUnits(value: string, label: string, allowNegative = true): string {
  if (!isCanonicalMoney(value)) throw new Error(`Invalid ${label} minorUnits`);
  const parsed = BigInt(value);
  if (parsed < SIGNED_I64_MIN || parsed > SIGNED_I64_MAX) {
    throw new Error(`${label} exceeds signed i64 range`);
  }
  if (parsed < -ACTUAL_SAFE_MINOR_UNITS || parsed > ACTUAL_SAFE_MINOR_UNITS) {
    throw new Error(`${label} exceeds Actual safe integer range`);
  }
  if (!allowNegative && parsed < 0n) throw new Error(`${label} must be nonnegative`);
  return value;
}

function money(minorUnits: string, currency = 'USD'): Money {
  safeMinorUnits(minorUnits, 'money');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid money currency: ${currency}`);
  return { minorUnits, currency };
}

function positiveMoney(minorUnits: string, currency = 'USD'): Money {
  const value = money(minorUnits, currency);
  if (BigInt(value.minorUnits) <= 0n) throw new Error('Money amount must be positive');
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function shiftTransaction(transaction: Transaction, dayDelta: number): Transaction {
  return {
    ...clone(transaction),
    date: addUtcDays(transaction.date, dayDelta),
    subtransactions: transaction.subtransactions.map((child) => shiftTransaction(child, dayDelta)),
  };
}

function shiftLedger(anchor: Date): ProtocolSnapshot {
  const context = makeContext(anchor);
  const ledger = clone(FIXTURE);
  ledger.snapshotDate = context.anchorIso;
  ledger.transactions = ledger.transactions.map((transaction) =>
    shiftTransaction(transaction, context.dayDelta),
  );
  ledger.budgets = ledger.budgets.map((budget) => {
    const month = addMonths(budget.month, context.monthDelta);
    return { ...budget, month };
  });
  return canonicalProtocolSnapshotSchema.parse(ledger) as ProtocolSnapshot;
}

function accountPolicy(
  accountId: string,
  protectedBuffer: string,
  options: Partial<Omit<ScenarioAccountPolicy, 'accountId' | 'protectedBuffer'>> = {},
): ScenarioAccountPolicy {
  return {
    accountId,
    role: options.role ?? 'daily_spending',
    protectedBuffer: money(protectedBuffer),
    paymentEligible: options.paymentEligible ?? true,
    sourceEligible: options.sourceEligible ?? true,
    backingEligible: options.backingEligible ?? true,
    eligibleCategoryIds: options.eligibleCategoryIds ?? ['cat-groceries'],
    restrictedCashBucketIds: options.restrictedCashBucketIds ?? [],
    automationAllowed: options.automationAllowed ?? false,
  };
}

function categoryPolicy(
  categoryId: string,
  kind: string,
  options: Partial<
    Pick<DecisionCardCategoryPolicy, 'donorEligible' | 'minimumRetained' | 'projectedRemainingNeed'>
  > & {
    cooldownMinutes?: number;
  } = {},
): DecisionCardCategoryPolicy & { cooldownMinutes?: number } {
  return {
    categoryId,
    kind,
    donorEligible: options.donorEligible ?? false,
    minimumRetained: options.minimumRetained ?? money('0'),
    projectedRemainingNeed: options.projectedRemainingNeed ?? money('0'),
    ...(options.cooldownMinutes === undefined ? {} : { cooldownMinutes: options.cooldownMinutes }),
  };
}

function basePolicy(context: BuildContext): ScenarioPolicy {
  const parsed = liquidityPolicyInputSchema.parse({
    expectedVersion: null,
    expiresAt: context.instant(24 * HOUR_MS),
    accounts: [accountPolicy('acct-checking', '10000')],
    transferRoutes: [],
    approvalPolicy: { minimumApprovers: 1 },
    categoryPolicies: [],
  });
  const { expectedVersion: _expectedVersion, ...policy } = parsed;
  return policy as ScenarioPolicy;
}

function observation(
  accountId: string,
  options: Partial<PublicUserAttestedObservation> = {},
): PublicUserAttestedObservation {
  return {
    accountId,
    currency: 'USD',
    kind: 'cash',
    owned: true,
    currentLedgerConfirmed: true,
    holds: money('0'),
    ...options,
  };
}

function baseObservations(
  context: BuildContext,
  accounts = ['acct-checking'],
): ScenarioObservations {
  const parsed = liquidityObservationInputSchema.parse({
    expectedVersion: 0,
    expiresAt: context.instant(10 * MINUTE_MS),
    observations: accounts.map((accountId) => observation(accountId)),
  });
  const { expectedVersion: _expectedVersion, ...input } = parsed;
  return input as ScenarioObservations;
}

function addAccount(
  scenario: MutableScenario,
  account: Pick<
    Account,
    'id' | 'name' | 'accountType' | 'offBudget' | 'clearedBalance' | 'importedBalance'
  >,
): void {
  if (scenario.ledger.accounts.some((candidate) => candidate.id === account.id)) return;
  scenario.ledger.accounts.push({
    ...account,
    isClosed: false,
    mtid: null,
  });
}

function addCategory(
  scenario: MutableScenario,
  category: Pick<Category, 'id' | 'name' | 'groupName' | 'isIncome'>,
): void {
  if (scenario.ledger.categories.some((candidate) => candidate.id === category.id)) return;
  scenario.ledger.categories.push({ ...category, mtid: null, deleted: false });
}

function addBudgetCategory(
  scenario: MutableScenario,
  month: string,
  categoryId: string,
  amount: string,
  budgetId = `budget-${month}`,
): void {
  let budget = scenario.ledger.budgets.find((candidate) => candidate.month === month);
  if (!budget) {
    budget = { id: budgetId, month, categories: {} };
    scenario.ledger.budgets.push(budget);
  }
  budget.categories[categoryId] = {
    categoryId,
    amount: money(amount),
    carryover: money('0'),
    carryoverFromPrevious: money('0'),
    carriesOver: false,
  };
}

function setAccountBalance(scenario: MutableScenario, accountId: string, amount: string): void {
  const account = scenario.ledger.accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`Unknown account ${accountId}`);
  account.clearedBalance = money(amount);
  account.importedBalance = money(amount);
}

function addTransaction(
  scenario: MutableScenario,
  transaction: Omit<Transaction, 'subtransactions'> & { subtransactions?: Transaction[] },
): void {
  scenario.ledger.transactions.push({
    ...transaction,
    subtransactions: transaction.subtransactions ?? [],
  });
}

function addPolicyAccount(
  scenario: MutableScenario,
  accountId: string,
  protectedBuffer: string,
  options: Partial<Omit<ScenarioAccountPolicy, 'accountId' | 'protectedBuffer'>> = {},
): void {
  const existing = scenario.policy.accounts.find((account) => account.accountId === accountId);
  const next = accountPolicy(accountId, protectedBuffer, options);
  if (existing) {
    Object.assign(existing, next);
    return;
  }
  scenario.policy.accounts.push(next);
}

function addObservation(
  scenario: MutableScenario,
  accountId: string,
  options: Partial<PublicUserAttestedObservation> = {},
): void {
  scenario.observations.observations.push(observation(accountId, options));
}

function removeObservations(scenario: MutableScenario): void {
  scenario.observations.observations = [];
}

function addCategoryPolicy(
  scenario: MutableScenario,
  categoryId: string,
  kind: string,
  options: Partial<
    Pick<DecisionCardCategoryPolicy, 'donorEligible' | 'minimumRetained' | 'projectedRemainingNeed'>
  > & {
    cooldownMinutes?: number;
  } = {},
): void {
  scenario.policy.categoryPolicies ??= [];
  scenario.policy.categoryPolicies.push(categoryPolicy(categoryId, kind, options));
}

function addTransferRoute(
  scenario: MutableScenario,
  sourceAccountId: string,
  destinationAccountId: string,
  providerArrivalAt: string,
): void {
  scenario.policy.transferRoutes.push({
    id: `route-${sourceAccountId}-${destinationAccountId}`,
    sourceAccountId,
    destinationAccountId,
    providerArrivalAt,
    calendarMode: 'instant',
    delayDays: 0,
    utcOffsetMinutes: 0,
    cutoffMinute: null,
    weekendsAvailable: true,
    holidaysComplete: true,
    holidays: [],
  });
}

function makePurchase(
  context: BuildContext,
  categoryId: string,
  amount: string,
  options: {
    accountId?: string;
    currency?: string;
    purchaseOffsetMs?: number;
    requiredByOffsetMs?: number;
  } = {},
): LiquidityPurchaseIntent {
  const input = liquidityPurchaseInputSchema.parse({
    kind: 'purchase',
    categoryId,
    amount: positiveMoney(amount, options.currency ?? 'USD'),
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    ...(options.purchaseOffsetMs === undefined
      ? {}
      : { purchaseAt: context.instant(options.purchaseOffsetMs) }),
    ...(options.requiredByOffsetMs === undefined
      ? {}
      : { requiredBy: context.instant(options.requiredByOffsetMs) }),
  });
  return input;
}

function makeSessionItem(
  context: BuildContext,
  options: {
    id: string;
    categoryId: string;
    amount: string;
    accountId?: string | null;
    priority?: 'required' | 'planned' | 'optional';
    quantity?: number;
    categoryAllocations?: { categoryId: string; amount: Money }[];
    priceProvenance?: DecisionCardPriceProvenance;
    barcode?: string;
  },
): SpendSessionIntent['items'][number] {
  const input = spendSessionInputSchema.parse({
    accountId: options.accountId === undefined ? 'acct-checking' : options.accountId,
    expiresAt: context.instant(HOUR_MS),
    items: [
      {
        id: options.id,
        categoryId: options.categoryId,
        accountId: options.accountId === undefined ? 'acct-checking' : options.accountId,
        amount: positiveMoney(options.amount),
        purchaseAt: context.instant(),
        requiredBy: context.instant(),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.quantity === undefined ? {} : { quantity: options.quantity }),
        ...(options.categoryAllocations === undefined
          ? {}
          : { categoryAllocations: options.categoryAllocations }),
        ...(options.priceProvenance === undefined
          ? {}
          : { priceProvenance: options.priceProvenance }),
        ...(options.barcode === undefined ? {} : { barcode: options.barcode }),
      },
    ],
  });
  return input.items[0]!;
}

function makeSession(
  context: BuildContext,
  items: SpendSessionIntent['items'],
  options: {
    accountId?: string | null;
    expiresOffsetMs?: number;
    adjustments?: DecisionCardAdjustment[];
    warningThresholds?: SpendSessionIntent['warningThresholds'];
  } = {},
): SpendSessionIntent {
  return spendSessionInputSchema.parse({
    accountId: options.accountId === undefined ? 'acct-checking' : options.accountId,
    expiresAt: context.instant(options.expiresOffsetMs ?? HOUR_MS),
    items,
    ...(options.adjustments === undefined ? {} : { adjustments: options.adjustments }),
    ...(options.warningThresholds === undefined
      ? {}
      : { warningThresholds: options.warningThresholds }),
  }) as SpendSessionIntent;
}

function richCartSessions(context: BuildContext, scenario: MutableScenario): void {
  addCategory(scenario, {
    id: 'cat-entertainment',
    name: 'Entertainment',
    groupName: 'Lifestyle',
    isIncome: false,
  });
  addBudgetCategory(scenario, context.month(), 'cat-groceries', '10000');
  addBudgetCategory(scenario, context.month(), 'cat-entertainment', '5000');
  setAccountBalance(scenario, 'acct-checking', '50000');
  addPolicyAccount(scenario, 'acct-checking', '10000', {
    eligibleCategoryIds: ['cat-groceries', 'cat-entertainment'],
  });
}

function richCartItems(
  context: BuildContext,
  options: { splitRequired?: boolean; outsidePrice?: boolean } = {},
): SpendSessionIntent['items'] {
  const requiredAllocations = options.splitRequired
    ? [
        { categoryId: 'cat-groceries', amount: money('1200') },
        { categoryId: 'cat-household', amount: money('800') },
      ]
    : [{ categoryId: 'cat-groceries', amount: money('2000') }];
  const requiredProvenance: DecisionCardPriceProvenance = options.outsidePrice
    ? {
        kind: 'outside_price',
        source: 'fixture-price',
        store: 'Market Basket',
        observedAt: context.instant(),
        estimate: true,
      }
    : {
        kind: 'current_session_manual',
        source: 'demo-receipt',
        store: 'Market Basket',
        observedAt: context.instant(),
        estimate: false,
      };
  return [
    makeSessionItem(context, {
      id: 'required-groceries',
      categoryId: 'cat-groceries',
      amount: '1000',
      quantity: 2,
      priority: 'required',
      categoryAllocations: requiredAllocations,
      priceProvenance: requiredProvenance,
    }),
    makeSessionItem(context, {
      id: 'optional-entertainment',
      categoryId: 'cat-entertainment',
      amount: '500',
      priority: 'optional',
      priceProvenance: {
        kind: 'current_session_manual',
        source: 'demo-receipt',
        store: 'Market Basket',
        observedAt: context.instant(),
        estimate: false,
      },
    }),
  ];
}

function richCartAdjustments(): DecisionCardAdjustment[] {
  return [
    { kind: 'tax', categoryId: 'cat-groceries', amount: money('100') },
    { kind: 'fee', categoryId: 'cat-groceries', amount: money('50') },
    { kind: 'discount', categoryId: 'cat-groceries', amount: money('50') },
  ];
}

function richCartWarnings() {
  return [{ id: 'cart-threshold', basis: 'cart_total' as const, maximum: money('2500') }];
}

function simpleCompletion(
  sessionKey: string,
  stage: ScenarioCompletionRecipe['stage'],
  approvers: readonly string[] = ['approver'],
): ScenarioCompletionRecipe {
  return { sessionKey, stage, approvers };
}

function ownerPersona(ledger?: ProtocolSnapshot): ScenarioPersona {
  const capabilities: ResourceCapability[] = [
    'conclusion', 'existence', 'name', 'balance', 'history', 'liquidity', 'source', 'category',
    'policy', 'session', 'proposal', 'approval', 'initiation-report', 'confirmation', 'audit',
  ];
  const routeCapabilities = [
    'affordability:evaluate', 'ingest', 'reservation:resolve',
    'session:propose', 'session:approve', 'session:execute', 'session:reconcile',
    'transfer:propose', 'transfer:approve', 'transfer:initiation-report', 'transfer:confirm',
  ] as const;
  const resources: { resourceKind: 'budget' | 'account' | 'category'; resourceId: string }[] = [
    { resourceKind: 'budget', resourceId: HOUSEHOLD_BUDGET_ID },
    ...(ledger?.accounts ?? []).map(({ id }) => ({ resourceKind: 'account' as const, resourceId: id })),
    ...(ledger?.categories ?? []).map(({ id }) => ({ resourceKind: 'category' as const, resourceId: id })),
  ];
  return {
    id: 'owner',
    role: 'owner',
    displayName: 'Alex Household',
    membership: {
      status: 'active',
      capabilities: [...capabilities, 'full-read', ...routeCapabilities],
    },
    grants: [
      {
        resourceKind: 'budget',
        resourceId: HOUSEHOLD_BUDGET_ID,
        capability: 'full-read',
        granted: true,
      },
      ...resources.flatMap((resource) => capabilities.map((capability) => ({
        ...resource, capability, granted: true,
      }))),
      ...routeCapabilities.map((capability) => ({
        resourceKind: 'budget' as const, resourceId: HOUSEHOLD_BUDGET_ID, capability, granted: true,
      })),
    ],
  };
}

function coapproverPersona(
  id = 'coapprover',
  categoryIds: readonly string[] = ['cat-groceries', 'cat-household', 'cat-entertainment'],
  accountIds: readonly string[] = ['acct-checking'],
): ScenarioPersona {
  return {
    id,
    role: 'coapprover',
    displayName: id === 'coapprover' ? 'Jordan Household' : 'Taylor Reviewer',
    membership: {
      status: 'active',
      capabilities: ['existence', 'balance', 'liquidity', 'category', 'conclusion', 'session', 'proposal', 'approval', 'session:approve'],
    },
    grants: [
      ...(['session', 'proposal', 'approval', 'conclusion', 'liquidity', 'session:approve'] as const).map((capability) => ({
        resourceKind: 'budget' as const,
        resourceId: HOUSEHOLD_BUDGET_ID,
        capability,
        granted: true,
      })),
      ...accountIds.flatMap((resourceId) =>
        (['existence', 'balance', 'liquidity', 'proposal', 'approval'] as const).map((capability) => ({
          resourceKind: 'account' as const, resourceId, capability, granted: true,
        }))),
      ...categoryIds.flatMap((resourceId) =>
        (['existence', 'category', 'liquidity', 'proposal', 'approval'] as const).map((capability) => ({
          resourceKind: 'category' as const,
          resourceId,
          capability,
          granted: true,
        }))),
    ],
  };
}

function restrictedPersona(): ScenarioPersona {
  return {
    id: 'restricted',
    role: 'restricted',
    displayName: 'Sam Household',
    membership: { status: 'active', capabilities: ['existence', 'name'] },
    grants: [
      {
        resourceKind: 'category',
        resourceId: 'cat-groceries',
        capability: 'existence',
        granted: true,
      },
    ],
  };
}

function baseScenario(context: BuildContext, id: ScenarioId, ledger = shiftLedger(context.anchor)): MutableScenario {
  return {
    id,
    anchor: context.anchorIso,
    ledger,
    policy: basePolicy(context),
    observations: baseObservations(context),
    personas: [ownerPersona()],
    sessions: {},
    claims: {},
    completions: {},
    entry: {
      kind: 'purchase',
      input: makePurchase(context, 'cat-groceries', '2000', { accountId: 'acct-checking' }),
    },
    events: {},
  };
}

function basePurchase(context: BuildContext, scenario: MutableScenario, amount = '2000'): void {
  scenario.entry = {
    kind: 'purchase',
    input: makePurchase(context, 'cat-groceries', amount, { accountId: 'acct-checking' }),
  };
}

function buildFundedPurchase(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'funded-purchase');
  basePurchase(context, scenario);
  return scenario;
}

function buildGuiltFreeSpending(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'guilt-free-spending');
  addCategoryPolicy(scenario, 'cat-groceries', 'guilt_free');
  basePurchase(context, scenario);
  return scenario;
}

function buildUnfundedCategory(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'unfunded-category');
  addBudgetCategory(scenario, context.month(), 'cat-groceries', '0');
  basePurchase(context, scenario);
  return scenario;
}

function buildDonorReallocation(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'donor-reallocation');
  addCategory(scenario, {
    id: 'cat-donor',
    name: 'Dining Reserve',
    groupName: 'Food',
    isIncome: false,
  });
  addBudgetCategory(scenario, context.month(), 'cat-groceries', '0');
  addBudgetCategory(scenario, context.month(), 'cat-donor', '4000');
  addCategoryPolicy(scenario, 'cat-donor', 'ordinary', {
    donorEligible: true,
    minimumRetained: money('1000'),
    projectedRemainingNeed: money('1000'),
  });
  addPolicyAccount(scenario, 'acct-checking', '10000', {
    eligibleCategoryIds: ['cat-groceries', 'cat-donor'],
  });
  basePurchase(context, scenario);
  return scenario;
}

function buildProtectedCategory(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'protected-category');
  addCategoryPolicy(scenario, 'cat-groceries', 'protected', {
    minimumRetained: money('1000'),
    projectedRemainingNeed: money('1500'),
  });
  scenario.entry = {
    kind: 'purchase',
    input: makePurchase(context, 'cat-groceries', '1500', { accountId: 'acct-checking' }),
  };
  return scenario;
}

function buildGoalCategory(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'goal-category');
  addCategoryPolicy(scenario, 'cat-groceries', 'goal', {
    minimumRetained: money('1000'),
    projectedRemainingNeed: money('1500'),
  });
  scenario.entry = {
    kind: 'purchase',
    input: makePurchase(context, 'cat-groceries', '1500', { accountId: 'acct-checking' }),
  };
  return scenario;
}

function buildDonorCompetition(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'donor-competition');
  addCategory(scenario, {
    id: 'cat-donor',
    name: 'Dining Reserve',
    groupName: 'Food',
    isIncome: false,
  });
  addBudgetCategory(scenario, context.month(), 'cat-groceries', '0');
  addBudgetCategory(scenario, context.month(), 'cat-donor', '2000');
  addCategoryPolicy(scenario, 'cat-donor', 'ordinary', {
    donorEligible: true,
    minimumRetained: money('0'),
  });
  addPolicyAccount(scenario, 'acct-checking', '10000', {
    eligibleCategoryIds: ['cat-groceries', 'cat-donor'],
  });
  const item = (id: string) =>
    makeSessionItem(context, {
      id,
      categoryId: 'cat-groceries',
      amount: '1500',
      accountId: 'acct-checking',
      priority: 'required',
    });
  scenario.sessions.first = makeSession(context, [item('first-item')]);
  scenario.sessions.second = makeSession(context, [item('second-item')]);
  scenario.entry = { kind: 'session', sessionKey: 'first' };
  return scenario;
}

function buildFutureAssignment(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'future-assignment');
  addBudgetCategory(scenario, context.month(), 'cat-groceries', '0');
  addBudgetCategory(scenario, context.month(1), 'cat-groceries', '2000', 'budget-next-month');
  basePurchase(context, scenario);
  return scenario;
}

function buildAccountTransfer(context: BuildContext, late: boolean): MutableScenario {
  const id = late ? 'transfer-too-late' : 'account-transfer';
  const scenario = baseScenario(context, id);
  addAccount(scenario, {
    id: 'acct-savings',
    name: 'Household Savings',
    accountType: 'savings',
    offBudget: false,
    clearedBalance: money('20000'),
    importedBalance: money('20000'),
  });
  setAccountBalance(scenario, 'acct-checking', '9000');
  addPolicyAccount(scenario, 'acct-savings', '0', {
    role: 'savings',
    paymentEligible: false,
    sourceEligible: true,
    backingEligible: true,
  });
  addObservation(scenario, 'acct-savings');
  addTransferRoute(
    scenario,
    'acct-savings',
    'acct-checking',
    context.instant((late ? 3 : 1) * HOUR_MS),
  );
  scenario.entry = {
    kind: 'purchase',
    input: makePurchase(context, 'cat-groceries', '2000', {
      accountId: 'acct-checking',
      purchaseOffsetMs: 2 * HOUR_MS,
      requiredByOffsetMs: 2 * HOUR_MS,
    }),
  };
  return scenario;
}

function buildCreditCardPurchase(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'credit-card-purchase');
  addAccount(scenario, {
    id: 'acct-credit',
    name: 'Household Credit Card',
    accountType: 'creditCard',
    offBudget: false,
    clearedBalance: money('0'),
    importedBalance: money('0'),
  });
  addCategory(scenario, {
    id: 'cat-card-payment',
    name: 'Card Payment',
    groupName: 'Debt',
    isIncome: false,
  });
  addBudgetCategory(scenario, context.month(), 'cat-card-payment', '0');
  addPolicyAccount(scenario, 'acct-checking', '10000', {
    eligibleCategoryIds: ['cat-groceries', 'cat-card-payment'],
  });
  addPolicyAccount(scenario, 'acct-credit', '0', {
    role: 'credit_payment',
    paymentEligible: true,
    sourceEligible: false,
    backingEligible: false,
    eligibleCategoryIds: ['cat-groceries'],
  });
  addObservation(scenario, 'acct-credit', {
    kind: 'credit',
    credit: {
      authorizationAvailable: money('5000'),
      pendingIncludedInAuthorization: true,
      paymentAccountId: 'acct-checking',
      paymentCategoryId: 'cat-card-payment',
      dueAt: context.instant(6 * HOUR_MS),
      reservedCash: money('0'),
      economicObligationId: 'credit-cycle',
    },
  });
  scenario.entry = {
    kind: 'purchase',
    input: makePurchase(context, 'cat-groceries', '2000', { accountId: 'acct-credit' }),
  };
  return scenario;
}

function buildMissingAccountEvidence(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'missing-account-evidence');
  removeObservations(scenario);
  basePurchase(context, scenario);
  return scenario;
}

function buildExpiredAccountEvidence(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'expired-account-evidence');
  const parsed = liquidityObservationInputSchema.parse({
    expectedVersion: 0,
    expiresAt: context.instant(2_000),
    observations: [observation('acct-checking')],
  });
  const { expectedVersion: _expectedVersion, ...input } = parsed;
  scenario.observations = input as ScenarioObservations;
  basePurchase(context, scenario);
  return scenario;
}

function buildCurrencyMismatch(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'currency-mismatch');
  scenario.entry = {
    kind: 'purchase',
    input: makePurchase(context, 'cat-groceries', '2000', {
      accountId: 'acct-checking',
      currency: 'EUR',
    }),
  };
  return scenario;
}

function buildPendingDebit(context: BuildContext, uncategorized: boolean): MutableScenario {
  const id = uncategorized ? 'uncategorized-debit' : 'pending-debit';
  const scenario = baseScenario(context, id);
  setAccountBalance(scenario, 'acct-checking', '14000');
  addBudgetCategory(scenario, context.month(), 'cat-groceries', '3000');
  addTransaction(scenario, {
    id: uncategorized ? 'tx-uncategorized-debit' : 'tx-pending-debit',
    accountId: 'acct-checking',
    date: context.date(-1),
    payeeId: 'pay-market',
    payeeName: 'Market Basket',
    categoryId: uncategorized ? null : 'cat-groceries',
    categoryName: uncategorized ? null : 'Groceries',
    amount: money('-1000'),
    cleared: false,
    reconciled: false,
    importedId: null,
    importedPayee: null,
    notes: null,
    tags: [],
    transferAccountId: null,
  });
  basePurchase(context, scenario);
  if (uncategorized) {
    scenario.events['categorize-uncategorized'] = {
      kind: 'categorize-uncategorized',
      transactionId: 'tx-uncategorized-debit',
      categoryId: 'cat-groceries',
      amount: money('-1000'),
    };
  }
  return scenario;
}

function claimScenario(
  context: BuildContext,
  id: 'reservation-block' | 'reservation-inform',
  mode: 'block' | 'inform',
): MutableScenario {
  const scenario = baseScenario(context, id);
  scenario.policy.reservationMode = mode;
  scenario.sessions.cart = makeSession(context, [
    makeSessionItem(context, {
      id: 'reserved-item',
      categoryId: 'cat-groceries',
      amount: '1500',
      accountId: 'acct-checking',
      priority: 'required',
    }),
  ]);
  scenario.claims.reserve = {
    kind: 'reservation',
    sessionKey: 'cart',
    scope: { kind: 'category', id: 'cat-groceries' },
    mode,
  };
  scenario.entry = { kind: 'session', sessionKey: 'cart' };
  return scenario;
}

function buildCommitmentOverlap(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'commitment-overlap');
  scenario.sessions.origin = makeSession(context, [
    makeSessionItem(context, {
      id: 'origin-item',
      categoryId: 'cat-groceries',
      amount: '1500',
      accountId: 'acct-checking',
      priority: 'required',
    }),
  ]);
  scenario.claims.categoryCommitment = {
    kind: 'commitment',
    sessionKey: 'origin',
    scope: { kind: 'category', id: 'cat-groceries' },
    mode: 'block',
  };
  scenario.claims.accountCommitment = {
    kind: 'commitment',
    sessionKey: 'origin',
    scope: { kind: 'account', id: 'acct-checking' },
    mode: 'block',
  };
  scenario.completions.originCompletion = simpleCompletion('origin', 'proposed');
  scenario.entry = { kind: 'completion', sessionKey: 'origin', completionKey: 'originCompletion' };
  return scenario;
}

function buildRichCart(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'rich-cart');
  richCartSessions(context, scenario);
  scenario.sessions.cart = makeSession(context, richCartItems(context), {
    adjustments: richCartAdjustments(),
    warningThresholds: richCartWarnings(),
  });
  scenario.entry = { kind: 'session', sessionKey: 'cart' };
  return scenario;
}

function buildRequiredItemOverage(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'required-item-overage');
  richCartSessions(context, scenario);
  scenario.sessions.requiredOnly = makeSession(
    context,
    [
      makeSessionItem(context, {
        id: 'required-groceries',
        categoryId: 'cat-groceries',
        amount: '1000',
        quantity: 2,
        priority: 'required',
      }),
    ],
    {
      adjustments: [{ kind: 'tax', categoryId: 'cat-groceries', amount: money('100') }],
      warningThresholds: [
        { id: 'required-threshold', basis: 'cart_total', maximum: money('2000') },
      ],
    },
  );
  scenario.entry = { kind: 'session', sessionKey: 'requiredOnly' };
  return scenario;
}

function buildOutsidePrice(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'outside-price');
  richCartSessions(context, scenario);
  scenario.sessions.outside = makeSession(context, [
    makeSessionItem(context, {
      id: 'outside-groceries',
      categoryId: 'cat-groceries',
      amount: '2000',
      priority: 'required',
      priceProvenance: {
        kind: 'outside_price',
        source: 'fixture-price',
        store: 'Market Basket',
        observedAt: context.instant(),
        estimate: true,
      },
    }),
  ]);
  scenario.entry = { kind: 'session', sessionKey: 'outside' };
  return scenario;
}

function buildExpiredSession(context: BuildContext): MutableScenario {
  const scenario = baseScenario(context, 'expired-session');
  scenario.sessions.expired = makeSession(
    context,
    [
      makeSessionItem(context, {
        id: 'expiring-item',
        categoryId: 'cat-groceries',
        amount: '2000',
        priority: 'required',
      }),
    ],
    { expiresOffsetMs: 2_000 },
  );
  scenario.entry = { kind: 'session', sessionKey: 'expired' };
  return scenario;
}

function completionCart(context: BuildContext, id: ScenarioId): MutableScenario {
  const scenario = baseScenario(context, id);
  richCartSessions(context, scenario);
  addCategory(scenario, {
    id: 'cat-household',
    name: 'Household',
    groupName: 'Home',
    isIncome: false,
  });
  addBudgetCategory(scenario, context.month(), 'cat-household', '10000');
  addPolicyAccount(scenario, 'acct-checking', '10000', {
    eligibleCategoryIds: ['cat-groceries', 'cat-entertainment', 'cat-household'],
  });
  const items = richCartItems(context, { splitRequired: true });
  scenario.sessions.cart = makeSession(context, items, {
    adjustments: richCartAdjustments(),
    warningThresholds: richCartWarnings(),
  });
  return scenario;
}

function buildSplitCompletion(context: BuildContext): MutableScenario {
  const scenario = completionCart(context, 'split-completion');
  scenario.completions.purchase = simpleCompletion('cart', 'proposed');
  scenario.entry = { kind: 'completion', sessionKey: 'cart', completionKey: 'purchase' };
  return scenario;
}

function buildCooldownCompletion(context: BuildContext): MutableScenario {
  const scenario = completionCart(context, 'cooldown-completion');
  addCategoryPolicy(scenario, 'cat-groceries', 'discretionary', { cooldownMinutes: 1 });
  scenario.completions.purchase = simpleCompletion('cart', 'proposed');
  scenario.entry = { kind: 'completion', sessionKey: 'cart', completionKey: 'purchase' };
  return scenario;
}

function buildCoapprovalCompletion(context: BuildContext): MutableScenario {
  const scenario = completionCart(context, 'coapproval-completion');
  scenario.policy.approvalPolicy.minimumApprovers = 2;
  scenario.personas.push(coapproverPersona(), restrictedPersona());
  scenario.completions.purchase = simpleCompletion('cart', 'proposed', ['approver', 'coapprover']);
  scenario.entry = { kind: 'completion', sessionKey: 'cart', completionKey: 'purchase' };
  scenario.governance = { kind: 'coapproval-audit', readerPersonaIds: ['owner', 'coapprover', 'approver'] };
  return scenario;
}

function importCandidate(context: BuildContext, suffix: string): ImportCandidate {
  return {
    importedId: `fixture-import-${suffix}`,
    accountId: 'acct-checking',
    amount: money('-2000'),
    date: context.date(),
    payeeName: 'Market Basket',
  };
}

function buildImportScenario(
  context: BuildContext,
  id: 'import-before-completion' | 'import-after-completion' | 'ambiguous-completion',
): MutableScenario {
  const scenario = baseScenario(context, id);
  scenario.sessions.purchase = makeSession(context, [
    makeSessionItem(context, {
      id: 'purchase-item',
      categoryId: 'cat-groceries',
      amount: '2000',
      priority: 'required',
    }),
  ]);
  const stage = id === 'import-before-completion' ? 'approved' : 'verified';
  scenario.completions.purchase = simpleCompletion('purchase', stage);
  scenario.entry = { kind: 'completion', sessionKey: 'purchase', completionKey: 'purchase' };
  if (id === 'ambiguous-completion') {
    scenario.events['import-ambiguous'] = {
      kind: 'import-ambiguous',
      candidates: [importCandidate(context, 'a'), importCandidate(context, 'b')],
    };
  } else {
    scenario.events['import-match'] = {
      kind: 'import-match',
      candidate: importCandidate(context, id === 'import-before-completion' ? 'before' : 'after'),
    };
  }
  return scenario;
}

function buildGovernanceScenario(
  context: BuildContext,
  id: 'governance-scoped-access' | 'governance-invitation-lifecycle' | 'governance-delegated-assistant',
): MutableScenario {
  const scenario = baseScenario(context, id);
  scenario.entry = { kind: 'page', path: '/spaces' };
  addAccount(scenario, {
    id: 'acct-savings', name: 'Household Savings', accountType: 'savings', offBudget: false,
    clearedBalance: money('20000'), importedBalance: money('20000'),
  });
  const limitedGrants: PersonaGrant[] = [
    { resourceKind: 'account', resourceId: 'acct-checking', capability: 'name', granted: true },
    { resourceKind: 'account', resourceId: 'acct-checking', capability: 'existence', granted: true },
  ];
  if (id === 'governance-scoped-access') {
    scenario.personas.push({
      id: 'limited', role: 'restricted', displayName: 'Limited Member',
      membership: { status: 'active', capabilities: ['name', 'existence'] }, grants: limitedGrants,
    });
    scenario.governance = {
      kind: 'scoped-access', limitedPersonaId: 'limited',
      visibleAccountIds: ['acct-checking'], withheldAccountIds: ['acct-savings'],
    };
    scenario.events['scoped-grant-change'] = {
      kind: 'scoped-grant-change', personaId: 'limited', resourceId: 'acct-checking',
      capability: 'name', granted: false,
    };
    scenario.events['scoped-grant-revoke'] = {
      kind: 'scoped-grant-revoke', personaId: 'limited', resourceId: 'acct-checking',
      capability: 'existence', granted: false,
    };
    scenario.events['membership-revoke'] = { kind: 'membership-revoke', personaId: 'limited' };
  } else if (id === 'governance-invitation-lifecycle') {
    scenario.governance = {
      kind: 'invitation-lifecycle',
      pendingInvitations: [{ personaId: 'invitee', displayName: 'Invited Member', capabilities: ['existence'], grants: [] }],
    };
    scenario.events['invite-redeem'] = { kind: 'invitation-redeem', personaId: 'invitee' };
    scenario.events['invite-revoke'] = { kind: 'membership-revoke', personaId: 'invitee' };
    scenario.events['invite-rejoin'] = { kind: 'invitation-rejoin', personaId: 'invitee' };
  } else {
    scenario.governance = {
      kind: 'delegated-assistant',
      assistant: { id: 'assistant', displayName: 'Budget Assistant', grants: limitedGrants },
    };
    scenario.events['assistant-probe'] = { kind: 'assistant-probe' };
    scenario.events['assistant-revoke'] = { kind: 'assistant-revoke' };
  }
  return scenario;
}

function merchantPersona(scenario: MutableScenario, id: 'owner' | 'coapprover' | 'approver'): ScenarioPersona {
  const isOwner = id === 'owner';
  const persona = isOwner ? ownerPersona(scenario.ledger) : {
    id, role: 'coapprover' as const,
    displayName: id === 'coapprover' ? 'Jordan Merchant Reviewer' : 'Taylor Merchant Reviewer',
    membership: { status: 'active' as const, capabilities: [] as ResourceCapability[] },
    grants: [] as PersonaGrant[],
  };
  const mutationRights: ResourceCapability[] = scenario.id === 'merchant-native-rule-lifecycle'
    ? isOwner ? ['rule:propose', 'rule:execute'] : ['rule:approve']
    : scenario.id === 'merchant-alias-conflict'
      ? isOwner ? ['categorization:propose', 'categorization:execute'] : ['categorization:approve']
      : [];
  const capabilities: ResourceCapability[] = ['observe', 'merchant:analyze', 'rule:view', ...mutationRights];
  if (isOwner) {
    capabilities.push('policy:manage');
    if (scenario.id === 'merchant-alias-conflict' || scenario.id === 'merchant-recurrence-calendar')
      capabilities.push('merchant:confirm');
    if (scenario.research) capabilities.push('merchant:research');
    if (scenario.id === 'merchant-research-lifecycle') capabilities.push('merchant:delete', 'lifecycle:delete');
  } else {
    capabilities.push('source');
  }
  const grants: PersonaGrant[] = [...persona.grants];
  const budgetId = scenario.ledger.budgets[0]!.id;
  for (const capability of capabilities)
    grants.push({ resourceKind: 'budget', resourceId: budgetId, capability, granted: true });
  const accountRights: ResourceCapability[] = isOwner ? [...mutationRights] : [
    'existence', 'name', 'history', 'source', 'merchant:analyze', ...mutationRights,
  ];
  if (isOwner && capabilities.includes('merchant:confirm')) accountRights.push('merchant:confirm');
  for (const account of scenario.ledger.accounts)
    for (const capability of accountRights)
      grants.push({ resourceKind: 'account', resourceId: account.id, capability, granted: true });
  const categoryRights: ResourceCapability[] = isOwner ? mutationRights : ['existence', 'name', 'category', ...mutationRights];
  for (const category of scenario.ledger.categories)
    for (const capability of categoryRights)
      grants.push({ resourceKind: 'category', resourceId: category.id, capability, granted: true });
  const transactionRights: ResourceCapability[] = ['transaction.view', 'source', ...mutationRights];
  for (const transaction of scenario.ledger.transactions)
    for (const capability of transactionRights)
      grants.push({ resourceKind: 'transaction', resourceId: transaction.id, capability, granted: true });
  for (const rule of scenario.ledger.rules)
    grants.push({ resourceKind: 'rule', resourceId: rule.id, capability: 'rule:view', granted: true });
  return {
    ...persona,
    membership: { status: 'active', capabilities: [...persona.membership.capabilities, ...capabilities] },
    grants,
  };
}

function adjustBusinessDate(date: Date, holidays: ReadonlySet<string>, direction: -1 | 1): void {
  let adjustments = 0;
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || holidays.has(date.toISOString().slice(0, 10))) {
    if (adjustments === 10) throw new Error('Offline calendar business-date adjustment exceeds its bound');
    date.setUTCDate(date.getUTCDate() + direction);
    adjustments += 1;
  }
}

function buildRecurrenceHistory(scenario: MutableScenario, context: BuildContext): void {
  const selection: MerchantCalendarSelection = { jurisdiction: 'US', subdivision: null, timeZone: 'America/New_York' };
  scenario.merchant = { historyTransactionIds: [], targetTransactionIds: [], calendar: { budget: selection, accounts: [] } };
  const monthly = MERCHANT_FIXTURE.ledger.transactions.filter(({ id }) => id.startsWith('recurrence-monthly-'));
  const monthEnds = MERCHANT_FIXTURE.ledger.transactions.filter(({ id }) => id.startsWith('recurrence-end-month-'));
  const variableAmounts = ['-1000', '-1200', '-900', '-1100'] as const;
  const calendar = lookupMerchantCalendar({
    accountId: 'acct-checking', year: context.anchor.getUTCFullYear(), budget: selection, accounts: [],
  });
  const holidays = calendar.state === 'known' ? new Set(calendar.calendar.holidays.map(({ date }) => date)) : null;
  scenario.ledger.payees.push(
    { id: 'pay-recurrence-business-day', name: 'Aster Business End', transferAccountId: null, mtid: null },
    { id: 'pay-recurrence-variable', name: 'Aster Variable', transferAccountId: null, mtid: null },
    { id: 'pay-recurrence-business-first', name: 'Aster Business First', transferAccountId: null, mtid: null },
  );
  for (let index = 0; index < 4; index += 1) {
    const month = new Date(Date.UTC(context.anchor.getUTCFullYear(), context.anchor.getUTCMonth() - 4 + index, 1));
    const year = month.getUTCFullYear();
    const monthIndex = month.getUTCMonth();
    const monthlyDate = new Date(Date.UTC(year, monthIndex, 15)).toISOString().slice(0, 10);
    const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0));
    const endDate = monthEnd.toISOString().slice(0, 10);
    if (calendar.state === 'known' && holidays &&
      endDate >= calendar.calendar.coverageStart && endDate <= calendar.calendar.coverageEnd) {
      adjustBusinessDate(monthEnd, holidays, -1);
    }
    const template = monthly[index];
    const endTemplate = monthEnds[index];
    if (!template || !endTemplate) throw new Error('Compact recurrence fixture is incomplete');
    scenario.ledger.transactions.push(
      { ...clone(template), date: monthlyDate },
      { ...clone(endTemplate), date: endDate },
      {
        ...clone(template), id: `recurrence-business-day-${index}`, date: monthEnd.toISOString().slice(0, 10),
        importedId: `scenario-import-recurrence-business-day-${index}`,
        payeeId: 'pay-recurrence-business-day', payeeName: 'Aster Business End',
      },
      {
        ...clone(template), id: `recurrence-variable-${index}`, date: monthlyDate,
        importedId: `scenario-import-recurrence-variable-${index}`,
        payeeId: 'pay-recurrence-variable', payeeName: 'Aster Variable', amount: money(variableAmounts[index]!),
      },
    );
  }
  for (let index = 0; index < 12; index += 1) {
    const first = new Date(Date.UTC(context.anchor.getUTCFullYear(), context.anchor.getUTCMonth() - 12 + index, 1));
    const civilDate = first.toISOString().slice(0, 10);
    const known = calendar.state === 'known' && holidays !== null &&
      civilDate >= calendar.calendar.coverageStart && civilDate <= calendar.calendar.coverageEnd;
    if (known && holidays) adjustBusinessDate(first, holidays, 1);
    scenario.ledger.transactions.push({
      ...clone(monthly[0]!), id: `recurrence-business-first-${index}`, date: first.toISOString().slice(0, 10),
      importedId: `scenario-import-recurrence-business-first-${index}`,
      payeeId: 'pay-recurrence-business-first', payeeName: 'Aster Business First',
      notes: `Synthetic civil-first observation ${civilDate}; ${known ? 'selected US offline public calendar' : 'calendar unknown; ordinary day-one cadence'}`,
    });
  }
  scenario.merchant = {
    ...scenario.merchant,
    historyTransactionIds: scenario.ledger.transactions.map(({ id }) => id),
  };
  scenario.events['merchant-calendar-clear'] = { kind: 'merchant-calendar-clear' };
}

function buildMerchantScenario(context: BuildContext, id: Extract<ScenarioId, `merchant-${string}`>): MutableScenario {
  const source = MERCHANT_FIXTURE.ledger;
  const dayDelta = utcDayNumber(context.anchorIso.slice(0, 10)) - utcDayNumber(MERCHANT_FIXTURE.sourceAsOfDate);
  const historyIds = id === 'merchant-local-insufficient'
    ? ['categorization-history-0-0']
    : ['categorization-history-0-0', 'categorization-history-0-1', 'categorization-history-0-2'];
  const targetIds = id === 'merchant-local-insufficient'
    ? ['synthetic-holdout-000-02', 'synthetic-holdout-000-08']
    : id === 'merchant-alias-conflict'
      ? ['synthetic-holdout-000-03', 'synthetic-holdout-000-10']
      : id === 'merchant-native-rule-lifecycle'
        ? ['synthetic-holdout-000-00', 'synthetic-holdout-000-02']
        : ['synthetic-holdout-000-02'];
  if (id === 'merchant-alias-conflict')
    historyIds.push('categorization-history-17-0', 'categorization-history-17-1', 'categorization-history-17-2');
  const selectedIds = new Set(id === 'merchant-recurrence-calendar'
    ? source.transactions.filter(({ id }) => id.startsWith('recurrence-irregular-')).map(({ id }) => id)
    : [...historyIds, ...targetIds]);
  const transactions = source.transactions.filter(({ id }) => selectedIds.has(id))
    .map((row) => shiftTransaction(row, dayDelta));
  const usedPayees = new Set(transactions.map(({ payeeId }) => payeeId));
  if (id === 'merchant-recurrence-calendar') {
    usedPayees.add('pay-recurrence-monthly');
    usedPayees.add('pay-recurrence-end-month');
  }
  const ledger = clone({ ...source, transactions: [], payees: source.payees.filter(({ id }) => usedPayees.has(id)) }) as ProtocolSnapshot;
  ledger.snapshotDate = context.anchorIso;
  ledger.transactions = transactions;
  ledger.budgets[0]!.id = HOUSEHOLD_BUDGET_ID;
  ledger.budgets[0]!.month = context.month();
  const scenario = baseScenario(context, id, ledger);
  scenario.entry = { kind: 'page', path: id === 'merchant-native-rule-lifecycle' ? '/rules' : '/review' };
  scenario.merchant = { historyTransactionIds: historyIds, targetTransactionIds: targetIds };
  if (id === 'merchant-recurrence-calendar') buildRecurrenceHistory(scenario, context);
  if (id === 'merchant-native-rule-lifecycle') {
    scenario.policy.approvalPolicy.minimumApprovers = 2;
    scenario.events['import-match'] = {
      kind: 'import-match',
      candidate: {
        importedId: 'scenario-native-future-import', accountId: 'acct-savings', amount: money('-34607'),
        date: context.date(1), payeeName: 'aster atelier',
      },
    };
    scenario.events['merchant-source-change'] = {
      kind: 'merchant-source-change', payeeId: 'pay-market', transactionId: 'synthetic-holdout-000-02',
      payeeName: 'Aster Atelier Revised', importedPayee: 'Aster Atelier Revised', notes: 'Source changed for stale proposal',
    };
    scenario.personas.push(merchantPersona(scenario, 'coapprover'), merchantPersona(scenario, 'approver'));
  }
  if (id === 'merchant-alias-conflict') scenario.personas.push(merchantPersona(scenario, 'approver'));
  if (id === 'merchant-research-success' || id === 'merchant-research-outage' || id === 'merchant-research-lifecycle') {
    scenario.research = { provider: 'fixture', mode: id === 'merchant-research-success' ? 'success' : id === 'merchant-research-outage' ? 'outage' : 'held' };
    scenario.events['research-expire'] = { kind: 'research-expire', offsetMs: 3_600_001 };
    if (id === 'merchant-research-lifecycle') {
      scenario.events['research-hold'] = { kind: 'research-hold' };
      scenario.events['research-release'] = { kind: 'research-release' };
      scenario.events['research-cancel'] = { kind: 'research-cancel' };
    }
  }
  return scenario;
}

function buildScenario(context: BuildContext, id: ScenarioId): MutableScenario {
  switch (id) {
    case 'funded-purchase':
      return buildFundedPurchase(context);
    case 'guilt-free-spending':
      return buildGuiltFreeSpending(context);
    case 'unfunded-category':
      return buildUnfundedCategory(context);
    case 'donor-reallocation':
      return buildDonorReallocation(context);
    case 'protected-category':
      return buildProtectedCategory(context);
    case 'goal-category':
      return buildGoalCategory(context);
    case 'donor-competition':
      return buildDonorCompetition(context);
    case 'future-assignment':
      return buildFutureAssignment(context);
    case 'account-transfer':
      return buildAccountTransfer(context, false);
    case 'transfer-too-late':
      return buildAccountTransfer(context, true);
    case 'credit-card-purchase':
      return buildCreditCardPurchase(context);
    case 'missing-account-evidence':
      return buildMissingAccountEvidence(context);
    case 'expired-account-evidence':
      return buildExpiredAccountEvidence(context);
    case 'currency-mismatch':
      return buildCurrencyMismatch(context);
    case 'pending-debit':
      return buildPendingDebit(context, false);
    case 'uncategorized-debit':
      return buildPendingDebit(context, true);
    case 'reservation-block':
      return claimScenario(context, 'reservation-block', 'block');
    case 'reservation-inform':
      return claimScenario(context, 'reservation-inform', 'inform');
    case 'commitment-overlap':
      return buildCommitmentOverlap(context);
    case 'rich-cart':
      return buildRichCart(context);
    case 'required-item-overage':
      return buildRequiredItemOverage(context);
    case 'outside-price':
      return buildOutsidePrice(context);
    case 'expired-session':
      return buildExpiredSession(context);
    case 'split-completion':
      return buildSplitCompletion(context);
    case 'cooldown-completion':
      return buildCooldownCompletion(context);
    case 'coapproval-completion':
      return buildCoapprovalCompletion(context);
    case 'import-before-completion':
      return buildImportScenario(context, 'import-before-completion');
    case 'import-after-completion':
      return buildImportScenario(context, 'import-after-completion');
    case 'ambiguous-completion':
      return buildImportScenario(context, 'ambiguous-completion');
    case 'governance-scoped-access':
    case 'governance-invitation-lifecycle':
    case 'governance-delegated-assistant':
      return buildGovernanceScenario(context, id);
    case 'merchant-local-sparse':
    case 'merchant-local-insufficient':
    case 'merchant-alias-conflict':
    case 'merchant-recurrence-calendar':
    case 'merchant-native-rule-lifecycle':
    case 'merchant-research-success':
    case 'merchant-research-outage':
    case 'merchant-research-lifecycle':
      return buildMerchantScenario(context, id);
  }
}

const SUMMARY_DATA: Readonly<Record<ScenarioId, Omit<ScenarioSummary, 'id'>>> = {
  'funded-purchase': {
    featureGroup: 'Purchase',
    title: 'Funded purchase',
    summary: 'A groceries purchase is funded now and ready on protected cash.',
    suggestedActions: ['Evaluate the purchase', 'Inspect the before and after cash'],
    supportedEventIds: [],
  },
  'guilt-free-spending': {
    featureGroup: 'Purchase',
    title: 'Guilt-free spending',
    summary: 'The same funded purchase uses an affirming guilt-free category policy.',
    suggestedActions: ['Evaluate the purchase', 'Review the guilt-free policy'],
    supportedEventIds: [],
  },
  'unfunded-category': {
    featureGroup: 'Funding',
    title: 'Unfunded category',
    summary: 'Cash exists, but the groceries category has no current availability.',
    suggestedActions: ['Evaluate the purchase', 'Inspect the funding blocker'],
    supportedEventIds: [],
  },
  'donor-reallocation': {
    featureGroup: 'Funding',
    title: 'Donor reallocation',
    summary: 'A safe donor category can cover the groceries shortfall without breaking its floor.',
    suggestedActions: ['Preview the reallocation', 'Review the donor tradeoff'],
    supportedEventIds: [],
  },
  'protected-category': {
    featureGroup: 'Funding',
    title: 'Protected category',
    summary: 'Using protected groceries money would break the retained floor.',
    suggestedActions: ['Evaluate the purchase', 'Inspect the protection impact'],
    supportedEventIds: [],
  },
  'goal-category': {
    featureGroup: 'Funding',
    title: 'Goal category',
    summary: 'The purchase puts a groceries goal at risk.',
    suggestedActions: ['Evaluate the purchase', 'Review the goal shortfall'],
    supportedEventIds: [],
  },
  'donor-competition': {
    featureGroup: 'Funding',
    title: 'Donor competition',
    summary: 'Two proposed purchases compete for one shared donor surplus.',
    suggestedActions: ['Evaluate each item', 'Compare the cumulative donor plan'],
    supportedEventIds: [],
  },
  'future-assignment': {
    featureGroup: 'Funding',
    title: 'Future assignment',
    summary: 'Next month money cannot fund an immediate purchase.',
    suggestedActions: ['Evaluate the purchase', 'Inspect current versus future buckets'],
    supportedEventIds: [],
  },
  'account-transfer': {
    featureGroup: 'Payment',
    title: 'On-time account transfer',
    summary: 'A savings-to-checking transfer arrives before the purchase deadline.',
    suggestedActions: ['Evaluate the purchase', 'Inspect the transfer route'],
    supportedEventIds: [],
  },
  'transfer-too-late': {
    featureGroup: 'Payment',
    title: 'Transfer arrives too late',
    summary: 'The same transfer route misses the purchase deadline.',
    suggestedActions: ['Evaluate the purchase', 'Review the payment timing blocker'],
    supportedEventIds: [],
  },
  'credit-card-purchase': {
    featureGroup: 'Payment',
    title: 'Credit-card purchase',
    summary: 'Available credit is backed by a declared checking payment account.',
    suggestedActions: ['Evaluate the card purchase', 'Inspect card-payment backing'],
    supportedEventIds: [],
  },
  'missing-account-evidence': {
    featureGroup: 'Evidence',
    title: 'Missing account evidence',
    summary: 'Without explicit account attestations, a funded category remains insufficient.',
    suggestedActions: ['Evaluate the purchase', 'Add account evidence and reset'],
    supportedEventIds: [],
  },
  'expired-account-evidence': {
    featureGroup: 'Evidence',
    title: 'Expired account evidence',
    summary: 'Fresh attestations expire quickly and must be renewed before evaluation.',
    suggestedActions: ['Evaluate before expiry', 'Wait for expiry and reset'],
    supportedEventIds: [],
  },
  'currency-mismatch': {
    featureGroup: 'Evidence',
    title: 'Currency mismatch',
    summary: 'A EUR intent cannot be funded by the USD household ledger.',
    suggestedActions: ['Evaluate the purchase', 'Inspect the currency blocker'],
    supportedEventIds: [],
  },
  'pending-debit': {
    featureGroup: 'Evidence',
    title: 'Pending debit',
    summary: 'An uncleared debit is counted once in the available cash calculation.',
    suggestedActions: ['Evaluate the purchase', 'Inspect pending activity'],
    supportedEventIds: [],
  },
  'uncategorized-debit': {
    featureGroup: 'Evidence',
    title: 'Uncategorized debit',
    summary: 'An uncleared uncategorized debit blocks a confident decision until corrected.',
    suggestedActions: ['Inspect the debit', 'Simulate fixture categorization'],
    supportedEventIds: ['categorize-uncategorized'],
  },
  'reservation-block': {
    featureGroup: 'Claims',
    title: 'Blocking reservation',
    summary: 'An active reservation prevents another purchase from reusing the same funds.',
    suggestedActions: ['Inspect the reservation', 'Release it and re-evaluate'],
    supportedEventIds: [],
  },
  'reservation-inform': {
    featureGroup: 'Claims',
    title: 'Informing reservation',
    summary: 'An informing reservation remains visible without reducing decision capacity.',
    suggestedActions: ['Inspect the reservation', 'Change policy to blocking'],
    supportedEventIds: [],
  },
  'commitment-overlap': {
    featureGroup: 'Claims',
    title: 'Commitment overlap',
    summary: 'Category and account commitments coordinate one prospective hold.',
    suggestedActions: ['Inspect both scopes', 'Complete the originating session'],
    supportedEventIds: [],
  },
  'rich-cart': {
    featureGroup: 'Cart',
    title: 'Rich cart',
    summary:
      'Quantity, category allocations, adjustments and a threshold warning are evaluated together.',
    suggestedActions: ['Edit quantities and categories', 'Review the USD 26 total'],
    supportedEventIds: [],
  },
  'required-item-overage': {
    featureGroup: 'Cart',
    title: 'Required-item overage',
    summary: 'A threshold warning must not recommend removing a required item.',
    suggestedActions: ['Review the warning', 'Inspect required-item alternatives'],
    supportedEventIds: [],
  },
  'outside-price': {
    featureGroup: 'Cart',
    title: 'Outside price provenance',
    summary: 'An estimated outside price carries explicit source and store provenance.',
    suggestedActions: ['Inspect price provenance', 'Remove provenance and observe rejection'],
    supportedEventIds: [],
  },
  'expired-session': {
    featureGroup: 'Cart',
    title: 'Expired session',
    summary: 'An editable saved cart expires and cannot continue as active.',
    suggestedActions: ['Observe session expiry', 'Reset to create a fresh session'],
    supportedEventIds: [],
  },
  'split-completion': {
    featureGroup: 'Completion',
    title: 'Split completion',
    summary: 'A USD 26 cart completes through a verified Actual split transaction.',
    suggestedActions: ['Propose and approve completion', 'Inspect Actual split children'],
    supportedEventIds: [],
  },
  'cooldown-completion': {
    featureGroup: 'Completion',
    title: 'Cooldown completion',
    summary: 'A discretionary completion waits for its one-minute cooldown before approval.',
    suggestedActions: ['Observe the cooldown', 'Approve after the deadline'],
    supportedEventIds: [],
  },
  'coapproval-completion': {
    featureGroup: 'Completion',
    title: 'Co-approval completion',
    summary: 'Two scoped approvers can approve a completion without sharing private session data.',
    suggestedActions: [
      'Open the normal approval detail and inspect exact split scope',
      'Approve as both independent fictional reviewers; neither can execute',
      'Inspect attributed space audit events and actor filters; financial details remain private',
    ],
    supportedEventIds: [],
  },
  'import-before-completion': {
    featureGroup: 'Reconciliation',
    title: 'Import before completion',
    summary: 'A matching Actual import is observed before a proposed completion executes.',
    suggestedActions: ['Simulate the matching import', 'Review the completion outcome'],
    supportedEventIds: ['import-match'],
  },
  'import-after-completion': {
    featureGroup: 'Reconciliation',
    title: 'Import after completion',
    summary: 'A later matching import reconciles to the already verified manual debit.',
    suggestedActions: ['Complete the purchase', 'Simulate the matching import'],
    supportedEventIds: ['import-match'],
  },
  'ambiguous-completion': {
    featureGroup: 'Reconciliation',
    title: 'Ambiguous completion import',
    summary: 'Two matching imported candidates require review instead of fabricated linkage.',
    suggestedActions: ['Complete the purchase', 'Simulate ambiguous import candidates'],
    supportedEventIds: ['import-ambiguous'],
  },
  'governance-scoped-access': {
    featureGroup: 'Governance',
    title: 'Scoped household access',
    summary: 'A separate limited human can identify Checking, but cannot read private amounts, history or Savings.',
    suggestedActions: ['Switch to the limited member', 'Inspect allowed Checking metadata and withheld Savings', 'Change the exact grant, then revoke the membership'],
    supportedEventIds: ['scoped-grant-change', 'scoped-grant-revoke', 'membership-revoke'],
  },
  'governance-invitation-lifecycle': {
    featureGroup: 'Governance',
    title: 'Invitation and membership periods',
    summary: 'A pending invitation is not an actor or session; explicit real redemption creates an independently authenticated human.',
    suggestedActions: ['Inspect the pending invitation', 'Accept as the invited fictional human', 'Revoke and rejoin with a new membership and no inherited grants'],
    supportedEventIds: ['invite-redeem', 'invite-revoke', 'invite-rejoin'],
  },
  'governance-delegated-assistant': {
    featureGroup: 'Governance',
    title: 'Bounded delegated assistant',
    summary: 'A real governed assistant credential can read Checking name and existence only; revocation invalidates the same credential.',
    suggestedActions: ['Inspect the registered agent and bounded delegation', 'Probe allowed metadata and denied private operations', 'Revoke the delegation and reuse the same credential'],
    supportedEventIds: ['assistant-probe', 'assistant-revoke'],
  },
  'merchant-local-sparse': {
    featureGroup: 'Merchant',
    title: 'Local sparse merchant history',
    summary: 'Three canonical synthetic Aster observations and an unclassified holdout flow through Actual and normal local merchant analysis.',
    suggestedActions: ['Sync the real fixture ledger', 'Inspect native merchant identity, category support and source fields', 'Confirm no research provider was dispatched'],
    supportedEventIds: [],
  },
  'merchant-local-insufficient': {
    featureGroup: 'Merchant',
    title: 'Insufficient local merchant evidence',
    summary: 'One canonical training observation and two distinct holdouts expose insufficient support and missing identity without confident category writes.',
    suggestedActions: ['Sync the real fixture ledger', 'Inspect support-one and empty-identity abstentions', 'Keep local Review usable without external research'],
    supportedEventIds: [],
  },
  'merchant-alias-conflict': {
    featureGroup: 'Merchant',
    title: 'Account-scoped alias and source conflict',
    summary: 'Aster imported text and competing Dapple notes preserve exact native identities while conflicting evidence requires abstention.',
    suggestedActions: ['Inspect exact raw-field availability and native payee IDs', 'Confirm or reject an account-scoped alias with its real version', 'Apply an explicit correction and inspect precedence without a native rule write'],
    supportedEventIds: [],
  },
  'merchant-recurrence-calendar': {
    featureGroup: 'Merchant',
    title: 'Recurrence with an explicit offline calendar',
    summary: 'Distinct monthly, civil month-end, backward US business-end, variable and irregular histories retain their real native observations.',
    suggestedActions: ['Compare exact dates and amount ranges with the selected US calendar', 'Confirm or reject a pattern and inspect the normal Dashboard', 'Clear the calendar and retain ordinary cadence with calendar uncertainty'],
    supportedEventIds: ['merchant-calendar-clear'],
  },
  'merchant-native-rule-lifecycle': {
    featureGroup: 'Merchant',
    title: 'Reviewed native rule lifecycle',
    summary: 'Two independent limited reviewers approve exact native impact before owner execution; future Savings imports use Actual’s rule engine alone.',
    suggestedActions: ['Review the native payload and approve as both independent reviewers', 'Execute as owner and inspect native rule readback and replay', 'Import into Savings through Actual alone', 'On a fresh unexecuted proposal, change real source fields and verify stale refusal'],
    supportedEventIds: ['import-match', 'merchant-source-change'],
  },
  'merchant-research-success': {
    featureGroup: 'Merchant',
    title: 'Fixture research consent and cache',
    summary: 'A closed no-network fixture provider exercises real preview, consent, attempts, cache hits and bounded expiry; sources are explicitly fictional.',
    suggestedActions: ['Inspect the exact public-business preview and explicitly consent', 'Inspect fixture provenance and .invalid sources', 'Repeat with fresh consent, then expire only the research cache clock'],
    supportedEventIds: ['research-expire'],
  },
  'merchant-research-outage': {
    featureGroup: 'Merchant',
    title: 'Fixture research outage',
    summary: 'A closed unavailable fixture records a real failed coordinator attempt without upstream traffic; local Sync remains usable.',
    suggestedActions: ['Explicitly consent to the fixture preview', 'Inspect the failed attempt and billing classification', 'Use local Sync and Review despite the fixture outage'],
    supportedEventIds: ['research-expire'],
  },
  'merchant-research-lifecycle': {
    featureGroup: 'Merchant',
    title: 'Fixture research revocation and deletion',
    summary: 'Held fixture research exercises real policy and grant revocation, quota limits, deletion fences and generation reset without network I/O.',
    suggestedActions: ['Inspect real policy and grant boundaries in independent branches', 'Exercise exact daily and monthly fixture quotas', 'Delete merchant data while a result is held, then release without late publication', 'Reset a held generation and reject its old controls and cookies'],
    supportedEventIds: ['research-expire', 'research-hold', 'research-release', 'research-cancel'],
  },
};

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function allLedgerIds(
  ledger: ProtocolSnapshot,
  key: 'accounts' | 'categories' | 'payees' | 'transactions' | 'budgets',
): Set<string> {
  const records = ledger[key] as Array<{ id: string }>;
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate logical ${key} ID: ${record.id}`);
    ids.add(record.id);
  }
  return ids;
}

function checkLedgerMoney(ledger: ProtocolSnapshot): void {
  const currencies = new Set<string>();
  const inspect = (value: unknown, label: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${label}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.minorUnits === 'string' &&
      typeof record.currency === 'string' &&
      Object.keys(record).every((key) => key === 'minorUnits' || key === 'currency')
    ) {
      safeMinorUnits(record.minorUnits, label);
      currencies.add(record.currency);
      if (!/^[A-Z]{3}$/.test(record.currency))
        throw new Error(`Invalid ledger currency at ${label}`);
    }
    for (const [key, child] of Object.entries(record)) inspect(child, `${label}.${key}`);
  };
  inspect(ledger, 'ledger');
  if (currencies.size !== 1 || !currencies.has('USD')) {
    throw new Error('Household ledger must contain exactly one USD currency');
  }
}

function checkReferences(scenario: MutableScenario): void {
  const accountIds = allLedgerIds(scenario.ledger, 'accounts');
  const categoryIds = allLedgerIds(scenario.ledger, 'categories');
  const payeeIds = allLedgerIds(scenario.ledger, 'payees');
  allLedgerIds(scenario.ledger, 'transactions');
  const budgetIds = allLedgerIds(scenario.ledger, 'budgets');
  const transactionIds = new Set<string>();
  const inspectTransaction = (transaction: Transaction): void => {
    if (transactionIds.has(transaction.id))
      throw new Error(`Duplicate transaction ID: ${transaction.id}`);
    transactionIds.add(transaction.id);
    if (!accountIds.has(transaction.accountId))
      throw new Error(`Transaction references unknown account ${transaction.accountId}`);
    if (transaction.payeeId !== null && !payeeIds.has(transaction.payeeId))
      throw new Error(`Transaction references unknown payee ${transaction.payeeId}`);
    if (transaction.categoryId !== null && !categoryIds.has(transaction.categoryId))
      throw new Error(`Transaction references unknown category ${transaction.categoryId}`);
    if (transaction.transferAccountId !== null && !accountIds.has(transaction.transferAccountId))
      throw new Error(
        `Transaction references unknown transfer account ${transaction.transferAccountId}`,
      );
    transaction.subtransactions.forEach(inspectTransaction);
  };
  scenario.ledger.transactions.forEach(inspectTransaction);
  for (const budget of scenario.ledger.budgets) {
    for (const [key, category] of Object.entries(budget.categories)) {
      if (!categoryIds.has(key) || category.categoryId !== key)
        throw new Error(`Budget references unknown category ${key}`);
    }
  }
  for (const account of scenario.policy.accounts) {
    if (!accountIds.has(account.accountId))
      throw new Error(`Policy references unknown account ${account.accountId}`);
    for (const categoryId of account.eligibleCategoryIds) {
      if (!categoryIds.has(categoryId))
        throw new Error(`Policy references unknown category ${categoryId}`);
    }
  }
  for (const route of scenario.policy.transferRoutes) {
    if (!accountIds.has(route.sourceAccountId) || !accountIds.has(route.destinationAccountId)) {
      throw new Error('Transfer route references an unknown account');
    }
  }
  for (const categoryPolicy of scenario.policy.categoryPolicies ?? []) {
    if (!categoryIds.has(categoryPolicy.categoryId))
      throw new Error(`Category policy references unknown category ${categoryPolicy.categoryId}`);
  }
  for (const observation of scenario.observations.observations) {
    if (!accountIds.has(observation.accountId))
      throw new Error(`Observation references unknown account ${observation.accountId}`);
  }
  for (const [sessionKey, session] of Object.entries(scenario.sessions)) {
    for (const item of session.items) {
      if (!categoryIds.has(item.categoryId))
        throw new Error(`Session ${sessionKey} references unknown category ${item.categoryId}`);
      if (item.accountId !== null && !accountIds.has(item.accountId))
        throw new Error(`Session ${sessionKey} references unknown account ${item.accountId}`);
      for (const allocation of item.categoryAllocations ?? []) {
        if (!categoryIds.has(allocation.categoryId))
          throw new Error(
            `Session ${sessionKey} allocation references unknown category ${allocation.categoryId}`,
          );
      }
    }
  }
  for (const [claimKey, claim] of Object.entries(scenario.claims)) {
    if (!hasOwn(scenario.sessions, claim.sessionKey))
      throw new Error(`Claim ${claimKey} references unknown session ${claim.sessionKey}`);
    if (claim.scope.kind === 'account' && !accountIds.has(claim.scope.id))
      throw new Error(`Claim ${claimKey} references unknown account`);
    if (claim.scope.kind === 'category' && !categoryIds.has(claim.scope.id))
      throw new Error(`Claim ${claimKey} references unknown category`);
  }
  for (const [completionKey, completion] of Object.entries(scenario.completions)) {
    if (!hasOwn(scenario.sessions, completion.sessionKey))
      throw new Error(`Completion ${completionKey} references unknown session`);
  }
  if (scenario.entry.kind === 'purchase') {
    if (!categoryIds.has(scenario.entry.input.categoryId))
      throw new Error('Entry references unknown category');
    if (
      scenario.entry.input.accountId !== undefined &&
      !accountIds.has(scenario.entry.input.accountId)
    )
      throw new Error('Entry references unknown account');
  } else if (scenario.entry.kind === 'page') {
    if (!['/spaces', '/review', '/rules', '/'].includes(scenario.entry.path))
      throw new Error('Page entry must use a registered normal-screen path');
  } else {
    if (!hasOwn(scenario.sessions, scenario.entry.sessionKey))
      throw new Error('Entry references unknown session');
    if (
      scenario.entry.kind === 'completion' &&
      !hasOwn(scenario.completions, scenario.entry.completionKey)
    ) {
      throw new Error('Entry references unknown completion');
    }
  }
  for (const event of Object.values(scenario.events)) {
    if (event.kind === 'categorize-uncategorized') {
      if (!transactionIds.has(event.transactionId) || !categoryIds.has(event.categoryId))
        throw new Error('Categorization event references unknown resource');
    } else if (event.kind === 'import-match' || event.kind === 'import-ambiguous') {
      const candidates = event.kind === 'import-match' ? [event.candidate] : event.candidates;
      for (const candidate of candidates) {
        if (!accountIds.has(candidate.accountId))
          throw new Error('Import event references unknown account');
      }
    }
    if (event.kind === 'merchant-source-change') {
      if (!transactionIds.has(event.transactionId) || !payeeIds.has(event.payeeId))
        throw new Error('Merchant source event references unknown native resource');
      for (const value of [event.payeeName, event.importedPayee, event.notes])
        if (value.length === 0 || value.length > 4096)
          throw new Error('Merchant source event replacement must be bounded nonempty text');
    }
    if (event.kind === 'scoped-grant-change' || event.kind === 'scoped-grant-revoke') {
      if (!accountIds.has(event.resourceId) || !scenario.personas.some(({ id }) => id === event.personaId))
        throw new Error('Scoped grant event references unknown persona or account');
    }
  }
  for (const persona of scenario.personas) {
    for (const grant of persona.grants) {
      if (grant.resourceKind === 'budget' && !budgetIds.has(grant.resourceId))
        throw new Error('Persona grant references unknown budget');
      if (grant.resourceKind === 'account' && !accountIds.has(grant.resourceId))
        throw new Error('Persona grant references unknown account');
      if (grant.resourceKind === 'category' && !categoryIds.has(grant.resourceId))
        throw new Error('Persona grant references unknown category');
      if (grant.resourceKind === 'transaction' && !transactionIds.has(grant.resourceId))
        throw new Error('Persona grant references unknown transaction');
      if (grant.resourceKind === 'rule' && !scenario.ledger.rules.some(({ id }) => id === grant.resourceId))
        throw new Error('Persona grant references unknown rule');
      if (grant.resourceKind === 'session' && !hasOwn(scenario.sessions, grant.resourceId))
        throw new Error('Persona grant references unknown session');
    }
  }
  for (const completion of Object.values(scenario.completions)) {
    for (const approver of completion.approvers) {
      if (!scenario.personas.some((persona) => persona.id === approver))
        throw new Error(`Completion approver is not a scenario persona: ${approver}`);
    }
  }
  if (scenario.merchant) {
    for (const id of [...scenario.merchant.historyTransactionIds, ...scenario.merchant.targetTransactionIds])
      if (!transactionIds.has(id)) throw new Error('Merchant recipe references unknown transaction');
    for (const account of scenario.merchant.calendar?.accounts ?? [])
      if (!accountIds.has(account.accountId)) throw new Error('Calendar recipe references unknown account');
  }
  if (scenario.governance?.kind === 'invitation-lifecycle') {
    for (const invitation of scenario.governance.pendingInvitations)
      if (scenario.personas.some(({ id }) => id === invitation.personaId))
        throw new Error('Pending invitation must not be a provisioned persona');
  }
}

function validateScenario(scenario: MutableScenario): MaterializedScenario {
  scenario.ledger = canonicalProtocolSnapshotSchema.parse(scenario.ledger) as ProtocolSnapshot;
  checkLedgerMoney(scenario.ledger);
  // Re-parse all normal public inputs at the same boundary used by the HTTP service.
  const policy = liquidityPolicyInputSchema.parse({ expectedVersion: null, ...scenario.policy });
  const observations = liquidityObservationInputSchema.parse({
    expectedVersion: 0,
    ...scenario.observations,
  });
  scenario.policy = (() => {
    const { expectedVersion: _expectedVersion, ...value } = policy;
    return value as ScenarioPolicy;
  })();
  scenario.observations = (() => {
    const { expectedVersion: _expectedVersion, ...value } = observations;
    return value as ScenarioObservations;
  })();
  for (const session of Object.values(scenario.sessions)) spendSessionInputSchema.parse(session);
  if (scenario.entry.kind === 'purchase') liquidityPurchaseInputSchema.parse(scenario.entry.input);
  checkReferences(scenario);
  return clone(scenario) as MaterializedScenario;
}

/** Lists the checked catalog's presentation metadata without runtime authority. */
export function listScenarios(): readonly ScenarioSummary[] {
  return SCENARIO_IDS.map((id) => ({
    id,
    ...SUMMARY_DATA[id],
    suggestedActions: [...SUMMARY_DATA[id].suggestedActions],
    supportedEventIds: [...SUMMARY_DATA[id].supportedEventIds],
  }));
}

/** Materializes the canonical ledger and explicit least-privilege persona grants. */
export function materializeScenario(id: string, anchor: Date): MaterializedScenario {
  if (!isScenarioId(id)) throw new Error(`Unknown scenario ID: ${id}`);
  const context = makeContext(anchor);
  const scenario = buildScenario(context, id);
  scenario.personas = scenario.personas.map((persona) =>
    persona.id === 'owner'
      ? scenario.merchant ? merchantPersona(scenario, 'owner') : ownerPersona(scenario.ledger)
      : persona);
  if (Object.values(scenario.completions).some(({ approvers }) => approvers.includes('approver'))) {
    const sessions = Object.values(scenario.completions).map(({ sessionKey }) => scenario.sessions[sessionKey]!);
    const categories = new Set(sessions.flatMap(({ items }) => items.flatMap((item) =>
      [item.categoryId, ...(item.categoryAllocations ?? []).map(({ categoryId }) => categoryId)])));
    const accounts = new Set(sessions.flatMap(({ accountId, items }) =>
      [accountId, ...items.map((item) => item.accountId)].filter((id): id is string => id !== null)));
    scenario.personas.push(coapproverPersona('approver', [...categories], [...accounts]));
  }
  return validateScenario(scenario);
}
