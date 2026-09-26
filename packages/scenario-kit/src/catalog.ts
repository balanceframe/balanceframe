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
} from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type {
  LiquidityPurchaseIntent,
  PublicLiquidityObservationInput,
  PublicLiquidityPolicyInput,
  PublicUserAttestedObservation,
  SpendSessionIntent,
} from '@balanceframe/application';
import type { ResourceCapability, ResourceKind } from '@balanceframe/workflow-store';

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

function resolveFixtureUrl(): URL {
  const candidates = [
    new URL('../../../protocol/fixtures/scenarios/household.json', import.meta.url),
    new URL('../../protocol/fixtures/scenarios/household.json', import.meta.url),
  ];
  const fixture = candidates.find((candidate) => existsSync(candidate));
  if (!fixture) {
    throw new Error('household scenario fixture is not available');
  }
  return fixture;
}

const FIXTURE_URL = resolveFixtureUrl();
const FIXTURE = canonicalProtocolSnapshotSchema.parse(
  JSON.parse(readFileSync(FIXTURE_URL, 'utf8')),
) as ProtocolSnapshot;

if (FIXTURE.snapshotDate !== REFERENCE_ANCHOR.toISOString()) {
  throw new Error('household scenario fixture must use the approved reference anchor');
}

export const SCENARIO_IDS = [
  'funded-purchase',
  'guilt-free-spending',
  'unfunded-category',
  'donor-reallocation',
  'protected-category',
  'goal-category',
  'donor-competition',
  'future-assignment',
  'account-transfer',
  'transfer-too-late',
  'credit-card-purchase',
  'missing-account-evidence',
  'expired-account-evidence',
  'currency-mismatch',
  'pending-debit',
  'uncategorized-debit',
  'reservation-block',
  'reservation-inform',
  'commitment-overlap',
  'rich-cart',
  'required-item-overage',
  'outside-price',
  'expired-session',
  'split-completion',
  'cooldown-completion',
  'coapproval-completion',
  'import-before-completion',
  'import-after-completion',
  'ambiguous-completion',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type ScenarioFeatureGroup =
  | 'Purchase'
  | 'Funding'
  | 'Payment'
  | 'Evidence'
  | 'Claims'
  | 'Cart'
  | 'Completion'
  | 'Reconciliation';

/** Presentation metadata shown by the local/demo selector. */
export interface ScenarioSummary {
  readonly id: ScenarioId;
  readonly featureGroup: ScenarioFeatureGroup;
  readonly title: string;
  readonly summary: string;
  readonly suggestedActions: readonly string[];
  readonly supportedEventIds: readonly ScenarioEventId[];
}

export type ScenarioEventId = 'categorize-uncategorized' | 'import-match' | 'import-ambiguous';

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

export type ScenarioEventRecipe =
  CategorizeUncategorizedEvent | ImportMatchEvent | ImportAmbiguousEvent;

export type ScenarioEntry =
  | { readonly kind: 'purchase'; readonly input: LiquidityPurchaseIntent }
  | { readonly kind: 'session'; readonly sessionKey: string }
  | { readonly kind: 'completion'; readonly sessionKey: string; readonly completionKey: string };

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
  approvers: readonly string[] = ['owner'],
): ScenarioCompletionRecipe {
  return { sessionKey, stage, approvers };
}

function ownerPersona(): ScenarioPersona {
  return {
    id: 'owner',
    role: 'owner',
    displayName: 'Alex Household',
    membership: {
      status: 'active',
      capabilities: ['full-read', 'policy', 'session', 'proposal', 'approval', 'confirmation'],
    },
    grants: [
      {
        resourceKind: 'budget',
        resourceId: HOUSEHOLD_BUDGET_ID,
        capability: 'full-read',
        granted: true,
      },
    ],
  };
}

function coapproverPersona(): ScenarioPersona {
  return {
    id: 'coapprover',
    role: 'coapprover',
    displayName: 'Jordan Household',
    membership: {
      status: 'active',
      capabilities: ['existence', 'balance', 'liquidity', 'category', 'conclusion', 'session', 'proposal', 'approval'],
    },
    grants: [
      ...(['session', 'proposal', 'approval', 'conclusion'] as const).map((capability) => ({
        resourceKind: 'budget' as const,
        resourceId: HOUSEHOLD_BUDGET_ID,
        capability,
        granted: true,
      })),
      ...(['existence', 'balance', 'liquidity', 'proposal', 'approval'] as const).map((capability) => ({
        resourceKind: 'account' as const,
        resourceId: 'acct-checking',
        capability,
        granted: true,
      })),
      ...(['cat-groceries', 'cat-entertainment'] as const).flatMap((resourceId) =>
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

function baseScenario(context: BuildContext, id: ScenarioId): MutableScenario {
  return {
    id,
    anchor: context.anchorIso,
    ledger: shiftLedger(context.anchor),
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
  });
  addCategoryPolicy(scenario, 'cat-groceries', 'ordinary', {
    projectedRemainingNeed: money('1000'),
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
  scenario.sessions.accountScoped = makeSession(context, [
    makeSessionItem(context, {
      id: 'account-item',
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
    sessionKey: 'accountScoped',
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

function completionCart(context: BuildContext, id: ScenarioId, split = true): MutableScenario {
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
  const items = richCartItems(context, { splitRequired: split });
  scenario.sessions.cart = makeSession(context, items, {
    adjustments: richCartAdjustments(),
    warningThresholds: richCartWarnings(),
  });
  return scenario;
}

function buildSplitCompletion(context: BuildContext): MutableScenario {
  const scenario = completionCart(context, 'split-completion');
  scenario.completions.purchase = simpleCompletion('cart', 'proposed', ['owner']);
  scenario.entry = { kind: 'completion', sessionKey: 'cart', completionKey: 'purchase' };
  return scenario;
}

function buildCooldownCompletion(context: BuildContext): MutableScenario {
  const scenario = completionCart(context, 'cooldown-completion');
  addCategoryPolicy(scenario, 'cat-groceries', 'discretionary', { cooldownMinutes: 1 });
  scenario.completions.purchase = simpleCompletion('cart', 'proposed', ['owner']);
  scenario.entry = { kind: 'completion', sessionKey: 'cart', completionKey: 'purchase' };
  return scenario;
}

function buildCoapprovalCompletion(context: BuildContext): MutableScenario {
  const scenario = completionCart(context, 'coapproval-completion', false);
  scenario.policy.approvalPolicy.minimumApprovers = 2;
  scenario.personas.push(coapproverPersona(), restrictedPersona());
  scenario.completions.purchase = simpleCompletion('cart', 'proposed', ['owner', 'coapprover']);
  scenario.entry = { kind: 'completion', sessionKey: 'cart', completionKey: 'purchase' };
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
    suggestedActions: ['Switch persona', 'Approve with both fictional approvers'],
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
    } else {
      const candidates = event.kind === 'import-match' ? [event.candidate] : event.candidates;
      for (const candidate of candidates) {
        if (!accountIds.has(candidate.accountId))
          throw new Error('Import event references unknown account');
      }
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

export function listScenarios(): readonly ScenarioSummary[] {
  return SCENARIO_IDS.map((id) => ({
    id,
    ...SUMMARY_DATA[id],
    suggestedActions: [...SUMMARY_DATA[id].suggestedActions],
    supportedEventIds: [...SUMMARY_DATA[id].supportedEventIds],
  }));
}

export function materializeScenario(id: string, anchor: Date): MaterializedScenario {
  if (!SCENARIO_IDS.includes(id as ScenarioId)) throw new Error(`Unknown scenario ID: ${id}`);
  const context = makeContext(anchor);
  return validateScenario(buildScenario(context, id as ScenarioId));
}
