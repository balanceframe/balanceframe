import { describe, expect, it } from 'vitest';

import { listScenarios, materializeScenario } from '../src/catalog.js';

const REFERENCE_ANCHOR = new Date('2026-09-06T12:00:00.000Z');
const SAFE_ACTUAL_MINOR_UNITS = 9_007_199_254_740_991n;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const APPROVED_SCENARIO_IDS = [
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

type Dict = Record<string, unknown>;

type Summary = Dict & {
  id: string;
  featureGroup: string;
  title: string;
  summary: string;
  suggestedActions: readonly string[];
  supportedEventIds: readonly string[];
};

type Materialized = Dict & {
  id: string;
  ledger: Dict;
  policy: Dict;
  observations: Dict;
  personas: readonly unknown[];
  sessions: Dict;
  claims: Dict;
  completions: Dict;
  entry: Dict;
  events: Dict;
};

function asObject(value: unknown, label: string): Dict {
  expect(value, label).toBeTypeOf('object');
  expect(value, label).not.toBeNull();
  return value as Dict;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as readonly unknown[];
}

function asString(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf('string');
  return value as string;
}

function asMoney(value: unknown, label: string): Dict {
  const money = asObject(value, label);
  expect(money).toHaveProperty('minorUnits');
  expect(money).toHaveProperty('currency');
  return money;
}

function minorUnits(value: unknown, label: string): string {
  return asString(asMoney(value, label).minorUnits, `${label}.minorUnits`);
}

function collection(value: Dict, key: string, label = key): readonly Dict[] {
  return asArray(value[key], label).map((item, index) => asObject(item, `${label}[${index}]`));
}

function materialize(id: string, anchor = REFERENCE_ANCHOR): Materialized {
  return materializeScenario(id, anchor) as unknown as Materialized;
}

function ledgerOf(scenario: Materialized): Dict {
  return asObject(scenario.ledger, `${scenario.id}.ledger`);
}

function findByText(records: readonly Dict[], expression: RegExp, label: string): Dict {
  const match = records.find((record) => {
    const text = [record.id, record.name, record.title]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
    return expression.test(text);
  });
  expect(match, label).toBeDefined();
  return match as Dict;
}

function account(scenario: Materialized, expression: RegExp): Dict {
  return findByText(
    collection(ledgerOf(scenario), 'accounts', `${scenario.id}.ledger.accounts`),
    expression,
    `${scenario.id} account ${expression}`,
  );
}

function category(scenario: Materialized, expression: RegExp): Dict {
  return findByText(
    collection(ledgerOf(scenario), 'categories', `${scenario.id}.ledger.categories`),
    expression,
    `${scenario.id} category ${expression}`,
  );
}

function accountId(scenario: Materialized, expression: RegExp): string {
  return asString(account(scenario, expression).id, `${scenario.id} account id`);
}

function categoryId(scenario: Materialized, expression: RegExp): string {
  return asString(category(scenario, expression).id, `${scenario.id} category id`);
}

function budgetCategories(scenario: Materialized): Dict[] {
  const months = collection(ledgerOf(scenario), 'budgets', `${scenario.id}.ledger.budgets`);
  return months.flatMap((month, monthIndex) => {
    const categories = asObject(
      month.categories,
      `${scenario.id}.ledger.budgets[${monthIndex}].categories`,
    );
    return Object.entries(categories).map(([key, value]) => {
      const budgetCategory = asObject(
        value,
        `${scenario.id}.ledger.budgets[${monthIndex}].categories.${key}`,
      );
      return { ...budgetCategory, __key: key };
    });
  });
}

function budgetAmountFor(scenario: Materialized, wantedCategoryId: string): string {
  const budget = budgetCategories(scenario).find(
    (entry) => entry.categoryId === wantedCategoryId || entry.__key === wantedCategoryId,
  );
  expect(budget, `${scenario.id} budget for ${wantedCategoryId}`).toBeDefined();
  return minorUnits((budget as Dict).amount, `${scenario.id} budget ${wantedCategoryId}`);
}

function sessionValues(scenario: Materialized): Dict[] {
  return Object.entries(scenario.sessions).map(([key, value]) =>
    asObject(value, `${scenario.id}.sessions.${key}`),
  );
}

function allSessionItems(scenario: Materialized): Dict[] {
  return sessionValues(scenario).flatMap((session, index) =>
    asArray(session.items, `${scenario.id}.sessions[${index}].items`).map((item, itemIndex) =>
      asObject(item, `${scenario.id}.sessions[${index}].items[${itemIndex}]`),
    ),
  );
}

function allValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => allValues(item));
  if (value !== null && typeof value === 'object') {
    return [value, ...Object.values(value as Dict).flatMap((item) => allValues(item))];
  }
  return [];
}

function recordsWithAmount(value: unknown): Dict[] {
  return allValues(value).filter((candidate): candidate is Dict => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    const record = candidate as Dict;
    if (!('amount' in record)) return false;
    const amount = record.amount;
    return (
      typeof amount === 'number' ||
      (typeof amount === 'string' && /^-?\d+$/.test(amount)) ||
      (amount !== null && typeof amount === 'object' && 'minorUnits' in (amount as Dict))
    );
  });
}

function amountMagnitude(value: unknown, label: string): bigint {
  if (typeof value === 'number') {
    expect(Number.isSafeInteger(value), label).toBe(true);
    return BigInt(Math.abs(value));
  }
  if (typeof value === 'string') return BigInt(value.startsWith('-') ? value.slice(1) : value);
  const money = asMoney(value, label);
  const raw = asString(money.minorUnits, `${label}.minorUnits`);
  return BigInt(raw.startsWith('-') ? raw.slice(1) : raw);
}

function addMilliseconds(anchor: Date, milliseconds: number): string {
  return new Date(anchor.getTime() + milliseconds).toISOString();
}

function utcDayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  expect(match, `canonical UTC date ${date}`).not.toBeNull();
  return Math.floor(Date.UTC(Number(match![1]), Number(match![2]) - 1, Number(match![3])) / DAY_MS);
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function monthIndex(month: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  expect(match, `canonical UTC month ${month}`).not.toBeNull();
  return Number(match![1]) * 12 + Number(match![2]) - 1;
}

function addMonths(month: string, months: number): string {
  const index = monthIndex(month) + months;
  const year = Math.floor(index / 12);
  const monthNumber = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const TIMESTAMP_KEYS = new Set([
  'snapshotDate',
  'observedAt',
  'expiresAt',
  'purchaseAt',
  'requiredBy',
  'providerArrivalAt',
  'createdAt',
  'updatedAt',
  'dueAt',
  'occurredAt',
]);

function timestampPaths(value: unknown, path = ''): Map<string, string> {
  const found = new Map<string, string>();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const [key, timestamp] of timestampPaths(item, `${path}[${index}]`))
        found.set(key, timestamp);
    });
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Dict)) {
    const childPath = path ? `${path}.${key}` : key;
    if (TIMESTAMP_KEYS.has(key) && typeof child === 'string' && child.endsWith('Z')) {
      found.set(childPath, child);
    }
    for (const [nestedPath, timestamp] of timestampPaths(child, childPath))
      found.set(nestedPath, timestamp);
  }
  return found;
}

function logicalIds(scenario: Materialized, key: string): string[] {
  return collection(ledgerOf(scenario), key, `${scenario.id}.ledger.${key}`).map((item, index) =>
    asString(item.id, `${scenario.id}.ledger.${key}[${index}].id`),
  );
}

function expectUniqueIds(scenario: Materialized, key: string): void {
  const ids = logicalIds(scenario, key);
  expect(new Set(ids).size, `${scenario.id} ${key} logical IDs`).toBe(ids.length);
}

function expectAccountReferences(scenario: Materialized): void {
  const ledger = ledgerOf(scenario);
  const accountIds = new Set(logicalIds(scenario, 'accounts'));
  const categoryIds = new Set(logicalIds(scenario, 'categories'));
  const payeeIds = new Set(logicalIds(scenario, 'payees'));

  const checkTransaction = (transaction: Dict, label: string): void => {
    expect(
      accountIds.has(asString(transaction.accountId, `${label}.accountId`)),
      `${label}.accountId`,
    ).toBe(true);
    for (const key of ['categoryId', 'payeeId', 'transferAccountId'] as const) {
      const value = transaction[key];
      if (value !== null && value !== undefined) {
        const ids = key === 'categoryId' ? categoryIds : key === 'payeeId' ? payeeIds : accountIds;
        expect(ids.has(asString(value, `${label}.${key}`)), `${label}.${key}`).toBe(true);
      }
    }
    asArray(transaction.subtransactions ?? [], `${label}.subtransactions`).forEach((child, index) =>
      checkTransaction(
        asObject(child, `${label}.subtransactions[${index}]`),
        `${label}.subtransactions[${index}]`,
      ),
    );
  };

  collection(ledger, 'transactions', `${scenario.id}.ledger.transactions`).forEach(
    (transaction, index) =>
      checkTransaction(transaction, `${scenario.id}.ledger.transactions[${index}]`),
  );
  collection(ledger, 'schedules', `${scenario.id}.ledger.schedules`).forEach((schedule, index) =>
    expect(
      accountIds.has(
        asString(schedule.accountId, `${scenario.id}.ledger.schedules[${index}].accountId`),
      ),
    ).toBe(true),
  );

  for (const budget of budgetCategories(scenario)) {
    expect(
      categoryIds.has(
        asString(budget.categoryId ?? budget.__key, `${scenario.id}.budget.categoryId`),
      ),
    ).toBe(true);
  }

  const policy = scenario.policy;
  for (const [index, accountPolicy] of asArray(
    policy.accounts,
    `${scenario.id}.policy.accounts`,
  ).entries()) {
    expect(
      accountIds.has(
        asString(
          asObject(accountPolicy, `${scenario.id}.policy.accounts[${index}]`).accountId,
          'policy accountId',
        ),
      ),
    ).toBe(true);
  }
  for (const [index, route] of asArray(
    policy.transferRoutes,
    `${scenario.id}.policy.transferRoutes`,
  ).entries()) {
    const transferRoute = asObject(route, `${scenario.id}.policy.transferRoutes[${index}]`);
    expect(accountIds.has(asString(transferRoute.sourceAccountId, 'route sourceAccountId'))).toBe(
      true,
    );
    expect(
      accountIds.has(asString(transferRoute.destinationAccountId, 'route destinationAccountId')),
    ).toBe(true);
  }
  for (const [index, categoryPolicy] of asArray(
    policy.categoryPolicies ?? [],
    `${scenario.id}.policy.categoryPolicies`,
  ).entries()) {
    expect(
      categoryIds.has(
        asString(
          asObject(categoryPolicy, `${scenario.id}.policy.categoryPolicies[${index}]`).categoryId,
          'category policy categoryId',
        ),
      ),
    ).toBe(true);
  }

  const observations = asArray(
    scenario.observations.observations,
    `${scenario.id}.observations.observations`,
  );
  for (const [index, observation] of observations.entries()) {
    expect(
      accountIds.has(
        asString(
          asObject(observation, `${scenario.id}.observations[${index}]`).accountId,
          'observation accountId',
        ),
      ),
    ).toBe(true);
  }

  for (const [key, sessionValue] of Object.entries(scenario.sessions)) {
    const session = asObject(sessionValue, `${scenario.id}.sessions.${key}`);
    const sessionAccountId = session.accountId;
    if (sessionAccountId !== null && sessionAccountId !== undefined) {
      expect(
        accountIds.has(asString(sessionAccountId, `${scenario.id}.sessions.${key}.accountId`)),
      ).toBe(true);
    }
    for (const [index, itemValue] of asArray(
      session.items,
      `${scenario.id}.sessions.${key}.items`,
    ).entries()) {
      const item = asObject(itemValue, `${scenario.id}.sessions.${key}.items[${index}]`);
      expect(categoryIds.has(asString(item.categoryId, 'session item categoryId'))).toBe(true);
      if (item.accountId !== null && item.accountId !== undefined) {
        expect(accountIds.has(asString(item.accountId, 'session item accountId'))).toBe(true);
      }
    }
  }

  for (const [key, claimValue] of Object.entries(scenario.claims)) {
    const claim = asObject(claimValue, `${scenario.id}.claims.${key}`);
    expect(
      Object.hasOwn(
        scenario.sessions,
        asString(claim.sessionKey, `${scenario.id}.claims.${key}.sessionKey`),
      ),
    ).toBe(true);
    const scope =
      claim.scope === undefined
        ? null
        : asObject(claim.scope, `${scenario.id}.claims.${key}.scope`);
    if (scope !== null) {
      const scopeId = scope.id;
      if (scope.kind === 'account')
        expect(accountIds.has(asString(scopeId, 'claim account scope id'))).toBe(true);
      if (scope.kind === 'category')
        expect(categoryIds.has(asString(scopeId, 'claim category scope id'))).toBe(true);
    }
  }

  for (const [key, completionValue] of Object.entries(scenario.completions)) {
    const completion = asObject(completionValue, `${scenario.id}.completions.${key}`);
    expect(
      Object.hasOwn(
        scenario.sessions,
        asString(completion.sessionKey, `${scenario.id}.completions.${key}.sessionKey`),
      ),
    ).toBe(true);
  }

  const entry = scenario.entry;
  expect(['purchase', 'session', 'completion']).toContain(entry.kind);
  if (entry.kind === 'purchase') {
    const input = asObject(entry.input, `${scenario.id}.entry.input`);
    expect(
      categoryIds.has(asString(input.categoryId, `${scenario.id}.entry.input.categoryId`)),
    ).toBe(true);
    if (input.accountId !== undefined && input.accountId !== null) {
      expect(
        accountIds.has(asString(input.accountId, `${scenario.id}.entry.input.accountId`)),
      ).toBe(true);
    }
  } else {
    expect(
      Object.hasOwn(
        scenario.sessions,
        asString(entry.sessionKey, `${scenario.id}.entry.sessionKey`),
      ),
    ).toBe(true);
    if (entry.kind === 'completion') {
      expect(
        Object.hasOwn(
          scenario.completions,
          asString(entry.completionKey, `${scenario.id}.entry.completionKey`),
        ),
      ).toBe(true);
    }
  }
}

describe('scenario catalog contract', () => {
  it('lists precisely the 29 approved loadable IDs with stable presentation metadata', () => {
    const summaries = listScenarios() as readonly Summary[];
    const ids = summaries.map((summary) => summary.id);

    expect(ids).toEqual([...APPROVED_SCENARIO_IDS]);
    expect(new Set(ids).size).toBe(APPROVED_SCENARIO_IDS.length);

    for (const summary of summaries) {
      expect(summary.featureGroup).toEqual(expect.any(String));
      expect(summary.title).toEqual(expect.any(String));
      expect(summary.summary).toEqual(expect.any(String));
      expect(summary.suggestedActions.length).toBeGreaterThan(0);
      expect(
        summary.suggestedActions.every((action) => typeof action === 'string' && action.length > 0),
      ).toBe(true);
      expect(
        summary.supportedEventIds.every(
          (eventId) => typeof eventId === 'string' && eventId.length > 0,
        ),
      ).toBe(true);
    }
  });

  it('materializes every approved variant independently against the common household fixture', () => {
    const baseline = materialize('funded-purchase');
    const baselineIds = new Map(
      ['accounts', 'categories', 'payees'].map((key) => [key, logicalIds(baseline, key)]),
    );

    for (const id of APPROVED_SCENARIO_IDS) {
      const scenario = materialize(id);
      expect(scenario.id).toBe(id);
      expect(ledgerOf(scenario).schemaVersion).toBe('1');
      expect(ledgerOf(scenario).snapshotDate).toBe(REFERENCE_ANCHOR.toISOString());
      for (const key of ['accounts', 'categories', 'payees'] as const) {
        const actualIds = new Set(logicalIds(scenario, key));
        for (const expectedId of baselineIds.get(key) ?? [])
          expect(actualIds.has(expectedId)).toBe(true);
      }
      for (const key of ['accounts', 'categories', 'payees', 'transactions', 'budgets'] as const) {
        expectUniqueIds(scenario, key);
      }
      expectAccountReferences(scenario);
    }
  });

  it('keeps execution entries discriminated and completion recipes free of runtime IDs, hashes, and versions', () => {
    for (const id of APPROVED_SCENARIO_IDS) {
      const scenario = materialize(id);
      const entry = scenario.entry;
      expect(['purchase', 'session', 'completion']).toContain(entry.kind);
      if (entry.kind === 'purchase') {
        expect(entry.input).toBeDefined();
      } else {
        expect(typeof entry.sessionKey).toBe('string');
        if (entry.kind === 'completion') expect(typeof entry.completionKey).toBe('string');
      }

      for (const [completionKey, completionValue] of Object.entries(scenario.completions)) {
        const completion = asObject(completionValue, `${id}.completions.${completionKey}`);
        expect(completion.stage).toMatch(/^(proposed|approved|verified)$/);
        expect(
          asArray(completion.approvers, `${id}.completions.${completionKey}.approvers`).every(
            (approver) => typeof approver === 'string',
          ),
        ).toBe(true);
        expect(completion).not.toHaveProperty('id');
        expect(completion).not.toHaveProperty('payloadHash');
        expect(completion).not.toHaveProperty('version');
      }
    }
  });

  it('uses the approved event recipes without allowing arbitrary event inputs', () => {
    const expectedEvents: Record<string, readonly string[]> = {
      'uncategorized-debit': ['categorize-uncategorized'],
      'import-before-completion': ['import-match'],
      'import-after-completion': ['import-match'],
      'ambiguous-completion': ['import-ambiguous'],
    };
    const summaries = new Map(
      (listScenarios() as readonly Summary[]).map((summary) => [summary.id, summary]),
    );

    for (const id of APPROVED_SCENARIO_IDS) {
      const scenario = materialize(id);
      const supported = expectedEvents[id] ?? [];
      expect(summaries.get(id)?.supportedEventIds).toEqual(supported);
      expect(Object.keys(scenario.events).sort()).toEqual([...supported].sort());
      for (const eventId of Object.keys(scenario.events)) {
        expect(eventId).toMatch(/^(categorize-uncategorized|import-match|import-ambiguous)$/);
        expect(scenario.events[eventId]).toBeDefined();
      }
    }
  });

  it('materializes funded purchase inputs and the protected cash policy with exact minor units', () => {
    const scenario = materialize('funded-purchase');
    const checkingId = accountId(scenario, /checking/i);
    const groceriesId = categoryId(scenario, /grocer/i);
    expect(
      minorUnits(account(scenario, /checking/i).clearedBalance, 'funded checking balance'),
    ).toBe('15000');
    expect(budgetAmountFor(scenario, groceriesId)).toBe('2000');
    const policyAccount = asArray(scenario.policy.accounts, 'funded policy accounts')
      .map((value) => asObject(value, 'funded policy account'))
      .find((value) => value.accountId === checkingId);
    expect(policyAccount).toBeDefined();
    expect(minorUnits((policyAccount as Dict).protectedBuffer, 'funded protected buffer')).toBe(
      '10000',
    );
    expect(scenario.entry.kind).toBe('purchase');
    const input = asObject(scenario.entry.input, 'funded purchase input');
    expect(input.categoryId).toBe(groceriesId);
    expect(minorUnits(input.amount, 'funded purchase amount')).toBe('2000');
  });

  it('materializes the rich-cart quantity and adjustment inputs without losing minor-unit precision', () => {
    const scenario = materialize('rich-cart');
    expect(
      minorUnits(account(scenario, /checking/i).clearedBalance, 'rich-cart checking balance'),
    ).toBe('50000');
    expect(budgetAmountFor(scenario, categoryId(scenario, /grocer/i))).toBe('10000');
    expect(budgetAmountFor(scenario, categoryId(scenario, /entertain/i))).toBe('5000');

    const items = allSessionItems(scenario).filter((item) => item.priority !== undefined);
    const required = items.filter((item) => item.priority === 'required');
    const optional = items.filter((item) => item.priority === 'optional');
    expect(required).toHaveLength(1);
    expect(optional).toHaveLength(1);
    expect(required[0]).toHaveProperty('quantity', 2);
    expect(minorUnits(required[0]!.amount, 'rich-cart required unit amount')).toBe('1000');
    expect(
      BigInt(minorUnits(required[0]!.amount, 'rich-cart required unit amount')) *
        BigInt(required[0]!.quantity as number),
    ).toBe(2000n);
    expect(minorUnits(optional[0]!.amount, 'rich-cart optional amount')).toBe('500');

    const adjustments = recordsWithAmount(scenario).filter(
      (record) => record.kind === 'tax' || record.kind === 'fee' || record.kind === 'discount',
    );
    const adjustmentAmounts = new Map(
      adjustments.map((adjustment) => [
        asString(adjustment.kind, 'rich-cart adjustment kind'),
        minorUnits(adjustment.amount, 'rich-cart adjustment amount'),
      ]),
    );
    expect(adjustmentAmounts).toEqual(
      new Map([
        ['tax', '100'],
        ['fee', '50'],
        ['discount', '50'],
      ]),
    );
    expect(
      2000n +
        500n +
        BigInt(adjustmentAmounts.get('tax')!) +
        BigInt(adjustmentAmounts.get('fee')!) -
        BigInt(adjustmentAmounts.get('discount')!),
    ).toBe(2600n);
  });

  it('materializes transfer timing and balances for both on-time and too-late variants', () => {
    for (const [id, arrivalHours] of [
      ['account-transfer', 1],
      ['transfer-too-late', 3],
    ] as const) {
      const scenario = materialize(id);
      expect(
        minorUnits(account(scenario, /checking/i).clearedBalance, `${id} checking balance`),
      ).toBe('9000');
      expect(
        minorUnits(account(scenario, /savings/i).clearedBalance, `${id} savings balance`),
      ).toBe('20000');
      const routes = asArray(scenario.policy.transferRoutes, `${id} transfer routes`).map((value) =>
        asObject(value, `${id} route`),
      );
      const route = routes.find((value) =>
        /checking/i.test(`${value.sourceAccountId} ${value.destinationAccountId}`),
      );
      expect(route).toBeDefined();
      expect(route).toHaveProperty(
        'providerArrivalAt',
        addMilliseconds(REFERENCE_ANCHOR, arrivalHours * HOUR_MS),
      );
      expect(scenario.entry.kind).toBe('purchase');
      const input = asObject(scenario.entry.input, `${id} purchase input`);
      expect(minorUnits(input.amount, `${id} purchase amount`)).toBe('2000');
      expect(input.requiredBy).toBe(addMilliseconds(REFERENCE_ANCHOR, 2 * HOUR_MS));
    }
  });

  it('materializes split-completion intent and import reconciliation amounts', () => {
    const split = materialize('split-completion');
    expect(budgetAmountFor(split, categoryId(split, /household/i))).toBe('10000');
    const splitSession = asObject(split.sessions.cart, 'split-completion session');
    const sessionItems = asArray(splitSession.items, 'split-completion items').map((item, index) =>
      asObject(item, `split-completion item ${index}`),
    );
    const requiredItem = findByText(
      sessionItems,
      /required-groceries/i,
      'split-completion required item',
    );
    expect(requiredItem).toHaveProperty('quantity', 2);
    expect(minorUnits(requiredItem.amount, 'split-completion required unit amount')).toBe('1000');
    const allocations = asArray(
      requiredItem.categoryAllocations,
      'split-completion allocations',
    ).map((item, index) => asObject(item, `split-completion allocation ${index}`));
    const allocationAmounts = new Map(
      allocations.map((allocation) => [
        asString(allocation.categoryId, 'split allocation category'),
        minorUnits(allocation.amount, 'split allocation amount'),
      ]),
    );
    expect(allocationAmounts).toEqual(
      new Map([
        ['cat-groceries', '1200'],
        ['cat-household', '800'],
      ]),
    );
    const optionalItem = findByText(
      sessionItems,
      /optional-entertainment/i,
      'split-completion optional item',
    );
    const adjustments = recordsWithAmount(splitSession).filter(
      (record) => record.kind === 'tax' || record.kind === 'fee' || record.kind === 'discount',
    );
    const adjustmentAmounts = new Map(
      adjustments.map((adjustment) => [
        asString(adjustment.kind, 'split adjustment kind'),
        minorUnits(adjustment.amount, 'split adjustment amount'),
      ]),
    );
    const splitAmounts = [
      BigInt(allocationAmounts.get('cat-groceries')!) +
        BigInt(adjustmentAmounts.get('tax')!) +
        BigInt(adjustmentAmounts.get('fee')!) -
        BigInt(adjustmentAmounts.get('discount')!),
      BigInt(allocationAmounts.get('cat-household')!),
      BigInt(minorUnits(optionalItem.amount, 'split optional amount')),
    ];
    expect(splitAmounts.map((amount) => amount.toString())).toEqual(
      expect.arrayContaining(['1300', '800', '500']),
    );
    expect(splitAmounts.reduce((sum, value) => sum + value, 0n)).toBe(2600n);

    for (const [id, expectedStage, eventId] of [
      ['import-before-completion', 'approved', 'import-match'],
      ['import-after-completion', 'verified', 'import-match'],
      ['ambiguous-completion', 'verified', 'import-ambiguous'],
    ] as const) {
      const scenario = materialize(id);
      const completions = Object.values(scenario.completions);
      expect(completions.length).toBeGreaterThan(0);
      expect(completions.map((value) => asObject(value, `${id} completion`).stage)).toContain(
        expectedStage,
      );
      expect(Object.keys(scenario.events)).toContain(eventId);
      const eventAmounts = recordsWithAmount(scenario.events[eventId]).map((record) =>
        amountMagnitude(record.amount, `${id} ${eventId} amount`),
      );
      expect(eventAmounts.some((amount) => amount === 2000n)).toBe(true);
    }
  });

  it('uses UTC timestamp deltas, calendar-day transaction deltas, calendar-month budget deltas, and leap boundaries', () => {
    const transactionBaseline = materialize('pending-debit');
    const transactionBaselineLedger = ledgerOf(transactionBaseline);
    const baselineTransactions = collection(
      transactionBaselineLedger,
      'transactions',
      'pending-debit baseline transactions',
    );
    const baselineById = new Map(
      baselineTransactions.map((transaction) => [
        asString(transaction.id, 'baseline transaction id'),
        transaction,
      ]),
    );
    const baselineBudgets = collection(
      transactionBaselineLedger,
      'budgets',
      'pending-debit baseline budgets',
    );
    const baselineTimestampPaths = timestampPaths(transactionBaseline);

    const boundaryAnchors = [
      new Date('2024-02-29T23:59:59.999Z'),
      new Date('2026-12-31T23:59:59.999Z'),
      new Date('2027-01-01T00:00:00.001Z'),
    ];
    for (const anchor of boundaryAnchors) {
      const shifted = materialize('pending-debit', anchor);
      const shiftedTransactions = collection(
        ledgerOf(shifted),
        'transactions',
        'shifted transactions',
      );
      const shiftedById = new Map(
        shiftedTransactions.map((transaction) => [
          asString(transaction.id, 'shifted transaction id'),
          transaction,
        ]),
      );
      const dayDelta = utcDayNumber(dateOnly(anchor)) - utcDayNumber(dateOnly(REFERENCE_ANCHOR));
      for (const [id, baseline] of baselineById) {
        const shiftedTransaction = shiftedById.get(id);
        expect(shiftedTransaction).toBeDefined();
        expect(asString(shiftedTransaction!.date, `shifted transaction ${id}.date`)).toBe(
          addUtcDays(asString(baseline.date, `baseline transaction ${id}.date`), dayDelta),
        );
      }

      const shiftedBudgets = collection(ledgerOf(shifted), 'budgets', 'shifted budgets');
      const monthDelta =
        monthIndex(dateOnly(anchor).slice(0, 7)) -
        monthIndex(dateOnly(REFERENCE_ANCHOR).slice(0, 7));
      expect(shiftedBudgets).toHaveLength(baselineBudgets.length);
      baselineBudgets.forEach((baselineBudget, index) => {
        expect(shiftedBudgets[index]!.month).toBe(
          addMonths(asString(baselineBudget.month, `baseline budget ${index}.month`), monthDelta),
        );
      });

      const shiftedTimestampPaths = timestampPaths(shifted);
      expect([...shiftedTimestampPaths.keys()].sort()).toEqual(
        [...baselineTimestampPaths.keys()].sort(),
      );
      for (const [path, baselineTimestamp] of baselineTimestampPaths) {
        expect(shiftedTimestampPaths.get(path), `${path} shifted timestamp`).toBe(
          new Date(
            new Date(baselineTimestamp).getTime() + anchor.getTime() - REFERENCE_ANCHOR.getTime(),
          ).toISOString(),
        );
      }
    }
  });

  it('applies default freshness windows and explicit expiry overrides from the anchor', () => {
    const funded = materialize('funded-purchase');
    expect(funded.policy).not.toHaveProperty('expectedVersion');
    expect(funded.observations).not.toHaveProperty('expectedVersion');
    expect(funded.policy.expiresAt).toBe(addMilliseconds(REFERENCE_ANCHOR, DAY_MS));
    expect(funded.observations.expiresAt).toBe(addMilliseconds(REFERENCE_ANCHOR, 10 * 60 * 1000));

    const reserved = materialize('reservation-block');
    for (const [key, value] of Object.entries(reserved.sessions)) {
      expect(asObject(value, `reservation-block session ${key}`).expiresAt).toBe(
        addMilliseconds(REFERENCE_ANCHOR, HOUR_MS),
      );
    }

    const expiredObservation = materialize('expired-account-evidence');
    expect(expiredObservation.observations.expiresAt).toBe(
      addMilliseconds(REFERENCE_ANCHOR, 2_000),
    );
    const expiredSession = materialize('expired-session');
    for (const [key, value] of Object.entries(expiredSession.sessions)) {
      expect(asObject(value, `expired-session session ${key}`).expiresAt).toBe(
        addMilliseconds(REFERENCE_ANCHOR, 2_000),
      );
    }
  });

  it('rejects invalid anchors and non-catalog IDs instead of manufacturing a fixture', () => {
    expect(() => materializeScenario('funded-purchase', new Date(Number.NaN))).toThrow(
      /date|anchor|invalid/i,
    );
    expect(() => materializeScenario('funded-purchase', new Date('not-a-date'))).toThrow(
      /date|anchor|invalid/i,
    );
    expect(() => materializeScenario('not-an-approved-scenario', REFERENCE_ANCHOR)).toThrow(
      /scenario|unknown|id/i,
    );
  });

  it('keeps materialized ledgers single-currency, safe for Actual integers, and reference-complete', () => {
    for (const id of APPROVED_SCENARIO_IDS) {
      const scenario = materialize(id);
      const ledger = ledgerOf(scenario);
      const currencies = new Set<string>();
      for (const accountRecord of collection(ledger, 'accounts', `${id}.accounts`)) {
        for (const key of ['clearedBalance', 'importedBalance'] as const) {
          const money = asMoney(accountRecord[key], `${id}.${key}`);
          currencies.add(asString(money.currency, `${id}.${key}.currency`));
          const value = BigInt(asString(money.minorUnits, `${id}.${key}.minorUnits`));
          expect(value <= SAFE_ACTUAL_MINOR_UNITS && value >= -SAFE_ACTUAL_MINOR_UNITS).toBe(true);
        }
      }
      for (const transaction of collection(ledger, 'transactions', `${id}.transactions`)) {
        const money = asMoney(transaction.amount, `${id}.transaction.amount`);
        currencies.add(asString(money.currency, `${id}.transaction.amount.currency`));
        const value = BigInt(asString(money.minorUnits, `${id}.transaction.amount.minorUnits`));
        expect(value <= SAFE_ACTUAL_MINOR_UNITS && value >= -SAFE_ACTUAL_MINOR_UNITS).toBe(true);
      }
      for (const budget of budgetCategories(scenario)) {
        for (const key of ['amount', 'carryover', 'carryoverFromPrevious'] as const) {
          const money = asMoney(budget[key], `${id}.budget.${key}`);
          currencies.add(asString(money.currency, `${id}.budget.${key}.currency`));
          const value = BigInt(asString(money.minorUnits, `${id}.budget.${key}.minorUnits`));
          expect(value <= SAFE_ACTUAL_MINOR_UNITS && value >= -SAFE_ACTUAL_MINOR_UNITS).toBe(true);
        }
      }
      expect(currencies).toEqual(new Set(['USD']));
      expectAccountReferences(scenario);
    }

    const mismatch = materialize('currency-mismatch');
    expect(mismatch.entry.kind).toBe('purchase');
    expect(
      minorUnits(
        asObject(mismatch.entry.input, 'currency mismatch input').amount,
        'currency mismatch amount',
      ),
    ).toBe('2000');
    expect(
      asMoney(
        asObject(mismatch.entry.input, 'currency mismatch input').amount,
        'currency mismatch input amount',
      ).currency,
    ).toBe('EUR');
  });
});
