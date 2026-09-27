import { downloadBudget, getAccounts, getTransactions, init, shutdown } from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyScenarioEvent } from '../../src/events.js';
import type { LoadedScenario } from '../../src/loader.js';
import { scenarioRequest, withScenario } from './support.js';

const SCENARIO_TIMEOUT = 180_000;

type Money = {
  minorUnits: string;
  currency: string;
};

type CategoryState = {
  categoryId: string;
  availability: Money;
  [key: string]: unknown;
};

type AccountState = {
  accountId: string;
  safeSpendingCapacity?: Money | null;
  recordedBalance?: Money;
  [key: string]: unknown;
};

type CardState = {
  categories: CategoryState[];
  accounts: AccountState[];
  backing: {
    lines: Array<{
      accountId: string;
      categoryId: string;
      amount: Money;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  goals?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type FundingPath = {
  kind: string;
  [key: string]: unknown;
};

type Card = {
  outcome: string;
  budgetFundingStatus: string;
  paymentLiquidityStatus: string;
  selectedAccountId: string | null;
  before: CardState | null;
  after: CardState | null;
  fundingPaths: FundingPath[];
  evidence: Array<Record<string, unknown>>;
  blockers: string[];
  reasons: string[];
  conflicts?: Array<Record<string, unknown>>;
  cart?: {
    total: Money;
    categoryCharges: Array<{ categoryId: string; amount: Money }>;
    accountCharges: Array<{ accountId: string; amount: Money }>;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

type PurchaseInput = {
  categoryId: string;
  amount: Money;
  accountId?: string | null;
  purchaseAt?: string;
  requiredBy?: string;
};

type SessionItem = PurchaseInput & {
  id: string;
  priority?: 'required' | 'planned' | 'optional';
  quantity?: number;
  categoryAllocations?: Array<{ categoryId: string; amount: Money }>;
  priceProvenance?: Record<string, unknown> | null;
  barcode?: string;
};

type Session = {
  id: string;
  version: number;
  expiresAt: string;
  items: SessionItem[];
  card: Card;
  [key: string]: unknown;
};

type CreditObservation = {
  paymentAccountId: string;
  paymentCategoryId: string;
  [key: string]: unknown;
};

type Observation = {
  accountId: string;
  currency?: string;
  kind?: string;
  owned?: boolean;
  currentLedgerConfirmed?: true;
  holds?: Money;
  credit?: CreditObservation | null;
  [key: string]: unknown;
};

type LiquidityConfiguration = {
  observationVersion: number;
  observations: Observation[];
  observationsExpiresAt: string | null;
  [key: string]: unknown;
};

type Envelope<T> = {
  status: string;
  result?: T;
  error?: Record<string, unknown>;
};

type ActualRow = {
  id?: string;
  amount?: number;
  category?: string | null;
  imported_id?: string | null;
  importedId?: string | null;
  account?: string;
  account_id?: string;
  date?: string;
  cleared?: boolean;
};

function usd(minorUnits: string): Money {
  return { minorUnits, currency: 'USD' };
}

function resultOf<T>(response: { status: number; body: unknown }, label: string): T {
  expect(response.status, `${label} HTTP status`).toBe(200);
  const envelope = response.body as Envelope<T>;
  expect(envelope.status, `${label} envelope status`).toBe('ok');
  expect(envelope.result, `${label} result`).toBeDefined();
  return envelope.result as T;
}

function purchaseEntry(handle: LoadedScenario): PurchaseInput {
  if (handle.initialized.entry.kind !== 'purchase')
    throw new Error('Expected a purchase scenario entry');
  return handle.initialized.entry.input;
}

async function evaluatePurchase(
  handle: LoadedScenario,
  input = purchaseEntry(handle),
): Promise<Card> {
  const query = new URLSearchParams({
    categoryId: input.categoryId,
    amount: input.amount.minorUnits,
    currency: input.amount.currency,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.purchaseAt ? { purchaseAt: input.purchaseAt } : {}),
    ...(input.requiredBy ? { requiredBy: input.requiredBy } : {}),
  });
  const response = await scenarioRequest<Envelope<{ card: Card }>>(
    handle,
    `/api/purchase/evaluate?${query.toString()}`,
  );
  return resultOf<{ card: Card }>(response, 'purchase evaluation').card;
}

async function configuration(handle: LoadedScenario): Promise<LiquidityConfiguration> {
  return resultOf<LiquidityConfiguration>(
    await scenarioRequest<Envelope<LiquidityConfiguration>>(handle, '/api/liquidity/policy'),
    'liquidity configuration',
  );
}

async function saveObservations(
  handle: LoadedScenario,
  current: LiquidityConfiguration,
  expiresAt: string,
  observations = current.observations,
): Promise<LiquidityConfiguration> {
  return resultOf<LiquidityConfiguration>(
    await scenarioRequest<Envelope<LiquidityConfiguration>>(handle, '/api/liquidity/observations', {
      method: 'PUT',
      body: {
        expectedVersion: current.observationVersion,
        expiresAt,
        observations,
      },
    }),
    'save liquidity observations',
  );
}

function scenarioOwnerObservations(handle: LoadedScenario): Observation[] {
  return handle.scenario.observations.observations.map((observation) => {
    const mapped: Observation = {
      ...observation,
      accountId: handle.seeded.accountIds[observation.accountId] ?? observation.accountId,
    };
    if (observation.credit) {
      mapped.credit = {
        ...observation.credit,
        paymentAccountId:
          handle.seeded.accountIds[observation.credit.paymentAccountId] ??
          observation.credit.paymentAccountId,
        paymentCategoryId:
          handle.seeded.categoryIds[observation.credit.paymentCategoryId] ??
          observation.credit.paymentCategoryId,
      };
    }
    return mapped;
  });
}

function state(card: Card, phase: 'before' | 'after'): CardState {
  const value = card[phase];
  expect(value, `${phase} state`).not.toBeNull();
  if (!value) throw new Error(`Missing ${phase} state`);
  return value;
}

function category(card: Card, phase: 'before' | 'after', categoryId: string): CategoryState {
  const value = state(card, phase).categories.find((entry) => entry.categoryId === categoryId);
  expect(value, `${phase} category ${categoryId}`).toBeDefined();
  if (!value) throw new Error(`Missing ${phase} category ${categoryId}`);
  return value;
}

function account(card: Card, phase: 'before' | 'after', accountId: string): AccountState {
  const value = state(card, phase).accounts.find((entry) => entry.accountId === accountId);
  expect(value, `${phase} account ${accountId}`).toBeDefined();
  if (!value) throw new Error(`Missing ${phase} account ${accountId}`);
  return value;
}

function expectMoney(value: Money | null | undefined, minorUnits: string, currency = 'USD'): void {
  expect(value).toEqual({ minorUnits, currency });
}

function expectStatuses(
  card: Card,
  expected: {
    outcome: string;
    budgetFundingStatus: string;
    paymentLiquidityStatus: string;
    selectedAccountId: string | null;
  },
): void {
  expect(card).toMatchObject(expected);
}

function expectReason(reasons: readonly string[], token: string): void {
  expect(reasons.some((reason) => reason === token || reason.includes(token))).toBe(true);
}

function findPath(card: Card, kind: string): FundingPath {
  const path = card.fundingPaths.find((candidate) => candidate.kind === kind);
  expect(path, `funding path ${kind}`).toBeDefined();
  if (!path) throw new Error(`Missing funding path ${kind}`);
  return path;
}

async function withActualClient<T>(
  handle: LoadedScenario,
  operation: () => Promise<T>,
): Promise<T> {
  const dataDir = mkdtempSync(join(handle.processes.root, 'acceptance-actual-'));
  let initialized = false;
  try {
    await init({
      serverURL: handle.processes.actualUrl,
      password: handle.processes.actualSecretKey,
      dataDir,
    });
    initialized = true;
    return await operation();
  } finally {
    try {
      if (initialized) await shutdown();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

async function actualRows(handle: LoadedScenario): Promise<ActualRow[]> {
  return withActualClient(handle, async () => {
    await downloadBudget(handle.seeded.groupId);
    const accounts = (await getAccounts()) as unknown as Array<{ id: string }>;
    const rows: ActualRow[] = [];
    for (const actualAccount of accounts) {
      rows.push(
        ...((await getTransactions(
          actualAccount.id,
          '1900-01-01',
          '2999-12-31',
        )) as unknown as ActualRow[]),
      );
    }
    return rows;
  });
}

function ledgerFingerprint(rows: readonly ActualRow[]): Array<Record<string, unknown>> {
  return rows
    .filter((row): row is ActualRow & { id: string } => typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      amount: row.amount,
      category: row.category ?? null,
      importedId: row.imported_id ?? row.importedId ?? null,
      date: row.date,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function ledgerTotal(rows: readonly ActualRow[]): number {
  return rows.reduce((total, row) => total + (typeof row.amount === 'number' ? row.amount : 0), 0);
}

function mappedSessionItem(handle: LoadedScenario, item: SessionItem): SessionItem {
  const categoryId = handle.seeded.categoryIds[item.categoryId] ?? item.categoryId;
  const accountId = item.accountId
    ? (handle.seeded.accountIds[item.accountId] ?? item.accountId)
    : item.accountId;
  return { ...item, categoryId, ...(accountId === undefined ? {} : { accountId }) };
}

function sessionInput(handle: LoadedScenario, sessionKey: string): SessionItem {
  const intent = handle.scenario.sessions[sessionKey];
  if (!intent || intent.items.length !== 1)
    throw new Error(`Expected one-item session ${sessionKey}`);
  return mappedSessionItem(handle, intent.items[0] as SessionItem);
}

async function session(handle: LoadedScenario, sessionKey: string): Promise<Session> {
  const sessionId = handle.initialized.sessions[sessionKey];
  if (!sessionId) throw new Error(`Missing initialized session ${sessionKey}`);
  return resultOf<Session>(
    await scenarioRequest<Envelope<Session>>(handle, `/api/spend-sessions/${sessionId}`),
    `session ${sessionKey}`,
  );
}

/** Real expiry is part of this acceptance contract; polling crosses the platform clock deliberately. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExpiredCard(
  handle: LoadedScenario,
  input: PurchaseInput,
  expiresAt: string,
): Promise<Card> {
  const expiry = Date.parse(expiresAt);
  const deadline = expiry + 8_000;
  let observedAfterExpiry = false;
  while (Date.now() <= deadline) {
    const card = await evaluatePurchase(handle, input);
    if (Date.now() >= expiry) {
      observedAfterExpiry = true;
      if (card.outcome === 'insufficient_data') return card;
    }
    await delay(100);
  }
  expect(observedAfterExpiry, 'the poll must cross the real evidence expiry').toBe(true);
  throw new Error('Evidence did not become insufficient after its real expiry');
}

describe('live purchase, payment, and evidence scenarios', () => {
  it('funded-purchase', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('funded-purchase', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const beforeLedger = ledgerFingerprint(await actualRows(handle));
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '2000');
      expectMoney(category(card, 'after', categoryId).availability, '0');
      expectMoney(account(card, 'before', accountId).safeSpendingCapacity, '5000');
      expectMoney(account(card, 'after', accountId).safeSpendingCapacity, '3000');
      expect(card.blockers).toEqual([]);
      expect(ledgerFingerprint(await actualRows(handle))).toEqual(beforeLedger);
    });
  });

  it('guilt-free-spending', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('guilt-free-spending', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '2000');
      expectMoney(category(card, 'after', categoryId).availability, '0');
      expectMoney(account(card, 'before', accountId).safeSpendingCapacity, '5000');
      expectMoney(account(card, 'after', accountId).safeSpendingCapacity, '3000');
      expectReason(card.reasons, 'guilt_free_category_funded');
      expect(card.reasons.some((reason) => reason.includes('penalty'))).toBe(false);
    });
  });

  it('unfunded-category', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('unfunded-category', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'cash_available_but_unfunded',
        budgetFundingStatus: 'unfunded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '0');
      expectMoney(category(card, 'after', categoryId).availability, '-2000');
      expectMoney(account(card, 'before', accountId).safeSpendingCapacity, '5000');
      expectMoney(account(card, 'after', accountId).safeSpendingCapacity, '3000');
      expectReason(card.reasons, 'cash_available_but_unfunded');
    });
  });

  it('donor-reallocation', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('donor-reallocation', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
      const donorId = handle.seeded.categoryIds['cat-donor']!;
      const beforeLedger = ledgerFingerprint(await actualRows(handle));
      const card = await evaluatePurchase(handle);
      const path = findPath(card, 'category_reallocation');

      expectStatuses(card, {
        outcome: 'safe_with_reallocation',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expect(path).toMatchObject({
        sourceCategoryId: donorId,
        destinationCategoryId: groceriesId,
        amount: usd('2000'),
      });
      expectMoney(category(card, 'before', donorId).availability, '4000');
      expectMoney(category(card, 'after', donorId).availability, '2000');
      expectMoney(category(card, 'before', groceriesId).availability, '0');
      expectMoney(category(card, 'after', groceriesId).availability, '0');
      expect(ledgerFingerprint(await actualRows(handle))).toEqual(beforeLedger);
    });
  });

  it('protected-category', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('protected-category', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'plan_breaking',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '2000');
      expectMoney(category(card, 'after', categoryId).availability, '500');
      expectReason(card.reasons, 'protected');
    });
  });

  it('goal-category', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('goal-category', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'plan_breaking',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '2000');
      expectMoney(category(card, 'after', categoryId).availability, '500');
      expectReason(card.reasons, 'goal');
    });
  });

  it('donor-competition', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('donor-competition', async (handle) => {
      const donorId = handle.seeded.categoryIds['cat-donor']!;
      const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const first = await session(handle, 'first');
      const second = await session(handle, 'second');

      for (const value of [first, second]) {
        const path = findPath(value.card, 'category_reallocation');
        expectStatuses(value.card, {
          outcome: 'safe_with_reallocation',
          budgetFundingStatus: 'funded',
          paymentLiquidityStatus: 'ready',
          selectedAccountId: accountId,
        });
        expect(path).toMatchObject({
          sourceCategoryId: donorId,
          destinationCategoryId: groceriesId,
          amount: usd('1500'),
        });
        expectMoney(category(value.card, 'before', donorId).availability, '2000');
        expectMoney(category(value.card, 'after', donorId).availability, '500');
      }

      const firstItem = sessionInput(handle, 'first');
      const secondItem = sessionInput(handle, 'second');
      const combined = resultOf<Session>(
        await scenarioRequest<Envelope<Session>>(handle, '/api/spend-sessions', {
          method: 'POST',
          body: {
            accountId,
            expiresAt: first.expiresAt,
            items: [firstItem, secondItem],
          },
        }),
        'combined donor-competition session',
      );
      expectStatuses(combined.card, {
        outcome: 'cash_available_but_unfunded',
        budgetFundingStatus: 'unfunded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expect(combined.card.fundingPaths).toEqual([]);
      expectReason(combined.card.reasons, 'cash_available_but_unfunded');
    });
  });

  it('future-assignment', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('future-assignment', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'cash_available_but_unfunded',
        budgetFundingStatus: 'unfunded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '0');
      expectMoney(category(card, 'after', categoryId).availability, '-2000');
      expect(card.fundingPaths).toEqual([]);
      expectReason(card.reasons, 'cash_available_but_unfunded');
    });
  });

  it('account-transfer', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('account-transfer', async (handle) => {
      const input = purchaseEntry(handle);
      const checkingId = handle.seeded.accountIds['acct-checking']!;
      const savingsId = handle.seeded.accountIds['acct-savings']!;
      const beforeLedger = ledgerFingerprint(await actualRows(handle));
      const card = await evaluatePurchase(handle, input);
      const path = findPath(card, 'account_transfer');
      const legs = path.legs as Array<Record<string, unknown>>;

      expectStatuses(card, {
        outcome: 'safe_after_date',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'transfer_required',
        selectedAccountId: checkingId,
      });
      expect(path.minimumAmount).toEqual(usd('3000'));
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({
        sourceAccountId: savingsId,
        destinationAccountId: checkingId,
        amount: usd('3000'),
        requiredBy: input.requiredBy,
        sourceAfter: usd('17000'),
        destinationAfter: usd('0'),
      });
      expect(Date.parse(String(legs[0]!.estimatedArrival))).toBeLessThan(
        Date.parse(input.requiredBy!),
      );
      expect(ledgerFingerprint(await actualRows(handle))).toEqual(beforeLedger);
    });
  });

  it('transfer-too-late', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('transfer-too-late', async (handle) => {
      const input = purchaseEntry(handle);
      const checkingId = handle.seeded.accountIds['acct-checking']!;
      const beforeLedger = ledgerFingerprint(await actualRows(handle));
      const card = await evaluatePurchase(handle, input);

      expectStatuses(card, {
        outcome: 'not_safe',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'transfer_too_late',
        selectedAccountId: checkingId,
      });
      const lateRoute = findPath(card, 'account_transfer');
      expect(lateRoute.minimumAmount).toEqual(usd('3000'));
      const lateLeg = (
        lateRoute.legs as Array<{ estimatedArrival: string; requiredBy: string }>
      )[0];
      expect(lateLeg).toBeDefined();
      expect(Date.parse(lateLeg!.estimatedArrival)).toBeGreaterThan(
        Date.parse(lateLeg!.requiredBy),
      );
      expectReason(card.reasons, 'payment_liquidity_not_ready');
      expect(ledgerFingerprint(await actualRows(handle))).toEqual(beforeLedger);
    });
  });

  it('credit-card-purchase', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('credit-card-purchase', async (handle) => {
      const creditId = handle.seeded.accountIds['acct-credit']!;
      const checkingId = handle.seeded.accountIds['acct-checking']!;
      const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
      const paymentCategoryId = handle.seeded.categoryIds['cat-card-payment']!;
      const config = await configuration(handle);
      const creditObservation = config.observations.find(
        (observation) => observation.accountId === creditId,
      );
      expect(creditObservation?.credit).toMatchObject({
        authorizationAvailable: usd('5000'),
        pendingIncludedInAuthorization: true,
        paymentAccountId: checkingId,
        paymentCategoryId,
        reservedCash: usd('0'),
      });

      const card = await evaluatePurchase(handle);
      expectStatuses(card, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: creditId,
      });
      expectMoney(category(card, 'before', groceriesId).availability, '2000');
      expectMoney(category(card, 'after', groceriesId).availability, '0');
      expectMoney(account(card, 'before', creditId).safeSpendingCapacity, '5000');
      expectMoney(account(card, 'after', creditId).safeSpendingCapacity, '3000');
      expectMoney(account(card, 'before', checkingId).safeSpendingCapacity, '5000');
      expectMoney(account(card, 'after', checkingId).safeSpendingCapacity, '3000');
      expect(card.after?.backing.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: checkingId,
            categoryId: paymentCategoryId,
            amount: usd('2000'),
          }),
        ]),
      );
      expect(card.cart?.accountCharges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: creditId, amount: usd('2000') }),
        ]),
      );

      const withoutDeclaration = config.observations.filter(
        (observation) => observation.accountId !== creditId,
      );
      const refreshed = await configuration(handle);
      await saveObservations(
        handle,
        refreshed,
        new Date(Date.now() + 300_000).toISOString(),
        withoutDeclaration,
      );
      const undeclaredCard = await evaluatePurchase(handle);
      expect(undeclaredCard.outcome).toBe('insufficient_data');
      expect(undeclaredCard.paymentLiquidityStatus).not.toBe('ready');
    });
  });

  it('missing-account-evidence', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('missing-account-evidence', async (handle) => {
      const beforeLedger = ledgerFingerprint(await actualRows(handle));
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'insufficient_data',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'insufficient_data',
        selectedAccountId: handle.seeded.accountIds['acct-checking']!,
      });
      expect(card.before).not.toBeNull();
      expect(card.after).toBeNull();
      expect(card.fundingPaths).toEqual([]);
      expect(card.blockers.some((blocker) => blocker.includes('account_'))).toBe(true);
      expect(ledgerFingerprint(await actualRows(handle))).toEqual(beforeLedger);
    });
  });

  it('expired-account-evidence', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('expired-account-evidence', async (handle) => {
      const input = purchaseEntry(handle);
      const initial = await configuration(handle);
      const firstExpiry = initial.observationsExpiresAt;
      expect(firstExpiry).toBeTruthy();
      expect(Date.parse(firstExpiry!) - Date.now()).toBeGreaterThan(0);
      expect(Date.parse(firstExpiry!) - Date.now()).toBeLessThanOrEqual(2_000);
      const beforeExpiry = await evaluatePurchase(handle, input);

      expectStatuses(beforeExpiry, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: handle.seeded.accountIds['acct-checking']!,
      });
      const expired = await waitForExpiredCard(handle, input, firstExpiry!);
      expect(expired.outcome).toBe('insufficient_data');
      expect(expired.paymentLiquidityStatus).toBe('insufficient_data');
      expect(expired.blockers.some((blocker) => blocker.includes('freshness'))).toBe(true);

      const resetConfiguration = await configuration(handle);
      const resetExpiry = new Date(Date.now() + 2_000).toISOString();
      const updated = await saveObservations(
        handle,
        resetConfiguration,
        resetExpiry,
        initial.observations.length ? initial.observations : scenarioOwnerObservations(handle),
      );
      expect(updated.observationsExpiresAt).toBe(resetExpiry);
      const resetReady = await evaluatePurchase(handle, input);
      expectStatuses(resetReady, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: handle.seeded.accountIds['acct-checking']!,
      });
      const resetExpired = await waitForExpiredCard(handle, input, updated.observationsExpiresAt!);
      expect(resetExpired.outcome).toBe('insufficient_data');
      expect(resetExpired.paymentLiquidityStatus).toBe('insufficient_data');
    });
  });

  it('currency-mismatch', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('currency-mismatch', async (handle) => {
      const beforeLedger = ledgerFingerprint(await actualRows(handle));
      const card = await evaluatePurchase(handle);

      expectStatuses(card, {
        outcome: 'insufficient_data',
        budgetFundingStatus: 'insufficient_data',
        paymentLiquidityStatus: 'insufficient_data',
        selectedAccountId: null,
      });
      expect(card.before).toBeNull();
      expect(card.after).toBeNull();
      expect(card.fundingPaths).toEqual([]);
      expect(card.blockers).toContain('currency_mismatch');
      expect(ledgerFingerprint(await actualRows(handle))).toEqual(beforeLedger);
    });
  });

  it('pending-debit', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('pending-debit', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const pendingRows = (await actualRows(handle)).filter(
        (row) => row.amount === -1000 && row.cleared === false,
      );
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]).toMatchObject({ category: categoryId });
      const card = await evaluatePurchase(handle);
      const checkingBefore = account(card, 'before', accountId);
      const checkingAfter = account(card, 'after', accountId);

      expectStatuses(card, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(card, 'before', categoryId).availability, '2000');
      expectMoney(category(card, 'after', categoryId).availability, '0');
      expectMoney(checkingBefore.recordedBalance, '14000');
      expectMoney(checkingBefore.safeSpendingCapacity, '4000');
      expectMoney(checkingAfter.safeSpendingCapacity, '2000');
      expectReason(card.reasons, 'pending');
      expect(card.reasons.filter((reason) => reason.includes('pending'))).toHaveLength(1);
    });
  });

  it('uncategorized-debit', { timeout: SCENARIO_TIMEOUT }, async () => {
    await withScenario('uncategorized-debit', async (handle) => {
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categoryId = handle.seeded.categoryIds['cat-groceries']!;
      const event = handle.scenario.events['categorize-uncategorized'];
      if (!event || event.kind !== 'categorize-uncategorized')
        throw new Error('Expected categorization event');
      const transactionId = handle.seeded.transactionIds[event.transactionId]!;
      const before = await actualRows(handle);
      const source = before.find((row) => row.id === transactionId);
      expect(source).toMatchObject({ id: transactionId, amount: -1000, category: null });
      const beforeTotal = ledgerTotal(before);

      const initialConfiguration = await configuration(handle);
      const blocked = await evaluatePurchase(handle);
      expect(blocked.outcome).toBe('insufficient_data');
      expect(blocked.paymentLiquidityStatus).toBe('ready');
      expectReason(blocked.blockers, 'uncategorized_transaction_activity');

      const eventResult = await applyScenarioEvent({
        scenario: handle.scenario,
        seeded: handle.seeded,
        root: handle.processes.root,
        actualServerUrl: handle.processes.actualUrl,
        actualSecretKey: handle.processes.actualSecretKey,
        eventId: 'categorize-uncategorized',
      });
      const after = await actualRows(handle);
      const updated = after.find((row) => row.id === transactionId);
      expect(updated).toMatchObject({
        id: transactionId,
        amount: -1000,
        category: categoryId,
      });
      expect(after).toHaveLength(before.length);
      expect(ledgerTotal(after)).toBe(beforeTotal);
      expect(eventResult).toMatchObject({
        eventId: 'categorize-uncategorized',
        kind: 'categorize-uncategorized',
        transactionId,
        categoryId,
        amount: -1000,
      });

      const reattestationConfiguration = await configuration(handle);
      await saveObservations(
        handle,
        reattestationConfiguration,
        new Date(Date.now() + 300_000).toISOString(),
        initialConfiguration.observations.length
          ? initialConfiguration.observations
          : scenarioOwnerObservations(handle),
      );
      const funded = await evaluatePurchase(handle);
      expectStatuses(funded, {
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expectMoney(category(funded, 'before', categoryId).availability, '2000');
      expectMoney(category(funded, 'after', categoryId).availability, '0');
      expectMoney(account(funded, 'after', accountId).safeSpendingCapacity, '2000');
    });
  });
});
