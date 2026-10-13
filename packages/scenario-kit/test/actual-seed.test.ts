import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { downloadBudget, getAccounts as freshAccounts, getTransactions as freshTransactions, init, shutdown } from '@actual-app/api';
import * as actualSdk from '@actual-app/api';
import type { APIRuleEntity } from '@actual-app/api/models';
import { z } from 'zod';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema, merchantAnalysisRequestSchema } from '@balanceframe/protocol-generated/validators';
import { populateActualBudget, seedActualBudget } from '../src/actual-seed.js';
import { materializeScenario } from '../src/catalog.js';
import { createOwnedScenarioRoot, discardOwnedScenarioRoot, startScenarioActual, startScenarioShell, stopScenarioProcesses, type ScenarioProcesses } from '../src/process-runtime.js';
import {
  createBudget,
  getAccountBalance,
  getAccounts,
  getBudgetMonth,
  getCategories,
  getPayees,
  getTransactions,
  sync,
} from '../../../tests/actual-integration/actual-client.js';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof actualSdk>();
  return {
    ...actual,
    get internal() { return actual.internal; },
    getTransactions: vi.fn(actual.getTransactions),
  };
});

const REPRESENTATIVE_FIXTURE = new URL(
  '../../../protocol/fixtures/representative.json',
  import.meta.url,
);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'balanceframe-scenario-seed-contract-'));
let fixtureRuntime: ScenarioProcesses | undefined;
let budgetSequence = 0;

type ActualRow = Record<string, unknown>;

type SeedLedgerDraft = ProtocolSnapshot & {
  transactions: Array<ProtocolSnapshot['transactions'][number]>;
};

function representativeFixture(): ProtocolSnapshot {
  return canonicalProtocolSnapshotSchema.parse(
    JSON.parse(readFileSync(REPRESENTATIVE_FIXTURE, 'utf8')),
  );
}

/**
 * Keep the live contract small while retaining canonical split/import records.
 * All selected transactions are cleared, so the expected starting and ending
 * account balances are unambiguous in Actual's balance_current field.
 */
function seedLedger(): ProtocolSnapshot {
  const source = representativeFixture();
  const transactions = source.transactions.filter((transaction) =>
    ['tx_000', 'tx_084'].includes(transaction.id),
  );
  const accountIds = new Set(['a_1', 'a_4']);
  const categoryIds = new Set(['cat_1', 'cat_2']);
  const payeeIds = new Set(['pay_1']);

  return canonicalProtocolSnapshotSchema.parse({
    ...source,
    accounts: source.accounts.filter((account) => accountIds.has(account.id)),
    transactions,
    categories: source.categories.filter((category) => categoryIds.has(category.id)),
    payees: source.payees.filter((payee) => payeeIds.has(payee.id)),
    rules: [],
    schedules: [],
    budgets: [
      {
        id: 'budget-2026-07',
        month: '2026-07',
        categories: {
          cat_2: {
            categoryId: 'cat_2',
            amount: { minorUnits: '2000', currency: 'USD' },
            carryover: { minorUnits: '0', currency: 'USD' },
            carryoverFromPrevious: { minorUnits: '0', currency: 'USD' },
            carriesOver: false,
          },
        },
      },
    ],
    tags: [],
  });
}

function merchantMetadataLedger(): ProtocolSnapshot {
  const ledger = seedLedger();
  const imported = ledger.transactions[0]!;
  imported.notes = 'Synthetic merchant source note';
  imported.reconciled = true;
  const split = ledger.transactions[1]!;
  for (const child of split.subtransactions) {
    child.notes = `Synthetic split source ${child.id}`;
  }
  ledger.transactions.push({
    ...imported,
    id: 'tx-manual-uncleared',
    amount: { minorUnits: '-500', currency: 'USD' },
    importedId: null,
    importedPayee: 'BANK MANUAL SOURCE',
    notes: '',
    cleared: false,
    reconciled: false,
  });
  return canonicalProtocolSnapshotSchema.parse(ledger);
}

function canonicalRuleFixture(): ProtocolSnapshot['rules'][number] {
  const envelope = z.object({ request: z.unknown() }).parse(
    JSON.parse(readFileSync(new URL('../../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8')),
  );
  const fixture = merchantAnalysisRequestSchema.parse(envelope.request);
  const rule = fixture.rules[0];
  if (!rule) throw new Error('Canonical native rule specimen is missing');
  return structuredClone(rule);
}

function nativeRuleLedger(): ProtocolSnapshot {
  const ledger = seedLedger();
  const canonicalRule = canonicalRuleFixture();
  // Actual orders pre/default/post stages, then condition specificity, not
  // creation order. Deliberately store the fixture array in the reverse order.
  ledger.rules = [
    {
      ...canonicalRule,
      id: 'logical-native-post',
      order: 1,
      inactive: false,
      trigger: {
        stage: 'post',
        conditionsOp: 'and',
        conditions: [
          { field: 'payee', op: 'is', value: 'pay_1', type: 'id' },
          { field: 'account', op: 'is', value: 'a_4', type: 'id' },
        ],
      },
      actions: [
        { field: 'category', op: 'set', value: 'cat_2', type: 'id' },
        { op: 'append-notes', value: ' synthetic post fixture' },
      ],
    },
    {
      ...canonicalRule,
      id: 'logical-native-pre',
      order: 0,
      inactive: false,
      trigger: {
        stage: 'pre',
        conditionsOp: 'or',
        conditions: [
          { field: 'account', op: 'is', value: 'a_4', type: 'id' },
          { field: 'payee', op: 'is', value: 'pay_1', type: 'id' },
        ],
      },
      actions: [
        { field: 'category', op: 'set', value: 'cat_1', type: 'id' },
        { op: 'prepend-notes', value: 'synthetic pre fixture ' },
      ],
    },
  ];
  return canonicalProtocolSnapshotSchema.parse(ledger);
}

function draftLedger(mutate: (draft: SeedLedgerDraft) => void): ProtocolSnapshot {
  const draft = structuredClone(seedLedger()) as SeedLedgerDraft;
  mutate(draft);
  // Invalid cases deliberately bypass the canonical parser so the seeder's
  // own validation is what rejects them before any Actual write.
  return draft;
}

async function readAllTransactions(): Promise<ActualRow[]> {
  const accounts = (await getAccounts()) as ActualRow[];
  const rows: ActualRow[] = [];
  for (const account of accounts) {
    if (typeof account.id !== 'string') continue;
    rows.push(...((await getTransactions(account.id)) as ActualRow[]));
  }
  return rows;
}

async function readActualState(): Promise<{
  accounts: ActualRow[];
  categories: ActualRow[];
  payees: ActualRow[];
  transactions: ActualRow[];
}> {
  const actualAccounts = (await getAccounts()) as ActualRow[];
  const accounts = await Promise.all(
    actualAccounts.map(async (account) => {
      const accountId = account.id;
      if (typeof accountId !== 'string') {
        return { id: accountId, name: account.name, balance_current: undefined };
      }
      return {
        id: accountId,
        name: account.name,
        balance_current: await getAccountBalance(accountId),
      };
    }),
  );
  return {
    accounts,
    categories: (await getCategories()).map((category) => {
      const row = category as ActualRow;
      return { id: row.id, name: row.name, group_id: row.group_id };
    }),
    payees: (await getPayees()).map((payee) => {
      const row = payee as ActualRow;
      return { id: row.id, name: row.name, transfer_acct: row.transfer_acct };
    }),
    transactions: (await readAllTransactions()).map((transaction) => ({
      id: transaction.id,
      account: transaction.account,
      amount: transaction.amount,
      imported_id: transaction.imported_id,
      parent_id: transaction.parent_id,
      is_child: transaction.is_child,
      is_parent: transaction.is_parent,
      subtransactions: transaction.subtransactions,
    })),
  };
}

async function withFreshActualBudget<T>(callback: () => Promise<T>): Promise<T> {
  if (!fixtureRuntime) throw new Error('Disposable Actual server is not running');
  const dataDir = mkdtempSync(join(fixtureRuntime.root, 'seed-contract-client-'));
  await init({
    serverURL: fixtureRuntime.actualUrl,
    password: fixtureRuntime.actualSecretKey,
    dataDir,
  });
  try {
    await createBudget({ name: `Scenario Seeder Contract ${++budgetSequence}` });
    return await callback();
  } finally {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('shared ProtocolSnapshot Actual seeder', () => {
  beforeAll(async () => {
    const root = createOwnedScenarioRoot();
    try {
      fixtureRuntime = await startScenarioShell({
        root,
        publicOrigin: 'http://127.0.0.1:43125',
        webEntry: fileURLToPath(new URL('../../../apps/web/.output/server/index.mjs', import.meta.url)),
      });
      await startScenarioActual(fixtureRuntime);
    } catch (error) {
      if (fixtureRuntime) await stopScenarioProcesses(fixtureRuntime);
      else await discardOwnedScenarioRoot(root);
      fixtureRuntime = undefined;
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    if (fixtureRuntime) await stopScenarioProcesses(fixtureRuntime);
    fixtureRuntime = undefined;
  }, 120_000);

  it('reads back exact starting/final balances, budget assignments, split identities, and import identities', async () => {
    await withFreshActualBudget(async () => {
      const ledger = seedLedger();
      const ids = await populateActualBudget(ledger);
      await sync();

      expect(ids.accountIds).toMatchObject({
        a_1: expect.any(String),
        a_4: expect.any(String),
      });
      expect(ids.categoryIds).toMatchObject({
        cat_1: expect.any(String),
        cat_2: expect.any(String),
      });
      expect(ids.payeeIds).toMatchObject({ pay_1: expect.any(String) });
      expect(ids.transactionIds).toMatchObject({
        tx_000: expect.any(String),
        tx_084: expect.any(String),
        'tx_084-sub-1': expect.any(String),
        'tx_084-sub-2': expect.any(String),
      });

      const { accounts } = await readActualState();
      const accountByName = new Map(accounts.map((account) => [String(account.name), account]));
      // The fixture's checked balances are final balances. The seeder must
      // derive the starting amounts (544710 and 58000) before adding -1500
      // and -8000, rather than treating checked balances as starting amounts.
      expect(accountByName.get('Checking Account')).toMatchObject({ balance_current: 543210 });
      expect(accountByName.get('Cash Wallet')).toMatchObject({ balance_current: 50000 });

      const month = (await getBudgetMonth('2026-07')) as {
        categoryGroups?: Array<{ categories?: ActualRow[] }>;
      };
      const budgetedCategory = (month.categoryGroups ?? [])
        .flatMap((group) => group.categories ?? [])
        .find((category) => category.id === ids.categoryIds.cat_2);
      expect(budgetedCategory).toMatchObject({ budgeted: 2000 });

      const actualTransactions = await readAllTransactions();
      const byId = new Map<string, ActualRow>();
      for (const transaction of actualTransactions) {
        if (typeof transaction.id === 'string') byId.set(transaction.id, transaction);
        for (const child of (transaction.subtransactions as ActualRow[] | undefined) ?? []) {
          if (typeof child.id === 'string') byId.set(child.id, child);
        }
      }

      const imported = byId.get(ids.transactionIds.tx_000);
      expect(imported).toMatchObject({
        amount: -1500,
        imported_id: 'EXT-0',
        imported_payee: 'BANK Whole Foods',
      });

      const splitParent = byId.get(ids.transactionIds.tx_084);
      expect(splitParent).toMatchObject({ amount: -8000, is_parent: true });
      const splitChildren = [
        ...((splitParent?.subtransactions as ActualRow[] | undefined) ?? []),
        ...actualTransactions.filter((transaction) => transaction.parent_id === splitParent?.id),
      ];
      expect(splitChildren).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: ids.transactionIds['tx_084-sub-1'],
            amount: -5000,
            category: ids.categoryIds.cat_2,
            is_child: true,
          }),
          expect.objectContaining({
            id: ids.transactionIds['tx_084-sub-2'],
            amount: -3000,
            category: ids.categoryIds.cat_2,
            is_child: true,
          }),
        ]),
      );
    });
  });

  it('admits exact native merchant metadata on imported, manual, and split rows', async () => {
    await withFreshActualBudget(async () => {
      const ledger = merchantMetadataLedger();
      const ids = await populateActualBudget(ledger);
      const rows = await readAllTransactions();
      const byId = new Map(
        rows.flatMap((row) => [row, ...((row.subtransactions as ActualRow[] | undefined) ?? [])])
          .map((row) => [row.id, row]),
      );
      for (const transaction of ledger.transactions.flatMap((row) => [row, ...row.subtransactions])) {
        expect(byId.get(ids.transactionIds[transaction.id])).toMatchObject({
          notes: transaction.notes ?? '',
          cleared: transaction.cleared,
          reconciled: transaction.reconciled,
          ...(transaction.importedPayee === null ? {} : { imported_payee: transaction.importedPayee }),
        });
      }
    });
  });

  it.each([
    { logicalId: 'tx_000', field: 'notes', value: 'LOST SOURCE NOTE', diagnostic: /notes/i },
    { logicalId: 'tx_000', field: 'imported_payee', value: 'WRONG BANK SOURCE', diagnostic: /imported.?payee/i },
    { logicalId: 'tx_000', field: 'cleared', value: false, diagnostic: /cleared/i },
    { logicalId: 'tx_000', field: 'reconciled', value: false, diagnostic: /reconcil/i },
    { logicalId: 'tx-manual-uncleared', field: 'cleared', value: true, diagnostic: /cleared/i },
    { logicalId: 'tx-manual-uncleared', field: 'reconciled', value: true, diagnostic: /reconcil/i },
    { logicalId: 'tx_084-sub-1', field: 'notes', value: 'LOST SPLIT NOTE', diagnostic: /notes/i },
    { logicalId: 'tx_084-sub-1', field: 'cleared', value: false, diagnostic: /cleared/i },
    { logicalId: 'tx_084-sub-1', field: 'reconciled', value: true, diagnostic: /reconcil/i },
  ])('refuses admission when native $logicalId $field differs despite unchanged money and references', async ({ logicalId, field, value, diagnostic }) => {
    await withFreshActualBudget(async () => {
      const ledger = merchantMetadataLedger();
      const source = ledger.transactions.flatMap((row) => [row, ...row.subtransactions])
        .find((row) => row.id === logicalId)!;
      const readSpy = vi.mocked(actualSdk.getTransactions);
      const realGetTransactions = readSpy.getMockImplementation();
      if (!realGetTransactions) throw new Error('Real SDK read-through implementation is missing');
      let corruptedRows = 0;
      // Fault only the consumer's field admission, never fabricate an Actual
      // response, identity, amount, category, payee, account, or analysis.
      readSpy.mockImplementation(async (...args) => {
        const rows = await realGetTransactions(...args);
        const corrupt = (row: typeof rows[number]): typeof rows[number] => {
          const subtransactions = row.subtransactions?.map(corrupt);
          const matches = row.amount === Number(BigInt(source.amount.minorUnits)) &&
            (source.importedId === null || row.imported_id === source.importedId);
          if (matches) corruptedRows++;
          return {
            ...row,
            ...(subtransactions ? { subtransactions } : {}),
            ...(matches ? { [field]: value } : {}),
          };
        };
        return rows.map(corrupt);
      });
      try {
        await expect(populateActualBudget(ledger)).rejects.toThrow(diagnostic);
        expect(corruptedRows).toBeGreaterThan(0);
      } finally {
        readSpy.mockImplementation(realGetTransactions);
      }
    });
  });

  it('preserves native split economics and IDs when admitting a reconciled split', async () => {
    await withFreshActualBudget(async () => {
      const ledger = seedLedger();
      const split = ledger.transactions.find((row) => row.id === 'tx_084')!;
      split.reconciled = true;
      for (const child of split.subtransactions) child.reconciled = true;
      // Inspect the real SDK rows even when the seeder refuses admission:
      // RED must expose destroyed child amounts, not just its balance error.
      const admission = await populateActualBudget(ledger).then(
        (ids) => ({ ids, error: undefined }),
        (error: unknown) => ({ ids: undefined, error }),
      );
      const account = (await actualSdk.getAccounts()).find((row) => row.name === 'Cash Wallet');
      if (!account) throw new Error('Native split account is missing');
      const parent = (await readAllTransactions()).find((row) => row.account === account.id && row.is_parent === true);
      const children = (parent?.subtransactions as ActualRow[] | undefined) ?? [];
      expect(children).toHaveLength(2);
      expect(children).toEqual(expect.arrayContaining([
        expect.objectContaining({ amount: -5000, cleared: true, reconciled: true }),
        expect.objectContaining({ amount: -3000, cleared: true, reconciled: true }),
      ]));
      expect(parent).toMatchObject({ amount: -8000, cleared: true, reconciled: true, is_parent: true });
      expect(await getAccountBalance(account.id)).toBe(50000);
      expect(admission.error).toBeUndefined();
      if (!admission.ids) throw new Error('Reconciled split must be admitted after exact native readback');
      expect(parent?.id).toBe(admission.ids.transactionIds[split.id]);
      expect(children.map((row) => row.id).sort()).toEqual(
        split.subtransactions.map((child) => admission.ids!.transactionIds[child.id]).sort(),
      );
    });
  });

  it('seeds canonical native rules with observed IDs, remapped references, and native stage/operand/action order', async () => {
    await withFreshActualBudget(async () => {
      const ids = await populateActualBudget(nativeRuleLedger());
      expect(ids).toHaveProperty('ruleIds');
      if (!('ruleIds' in ids)) throw new Error('Seeder must publish logical-to-native rule IDs');
      const ruleIds = z.record(z.string().min(1)).parse(ids.ruleIds);
      expect(Object.keys(ruleIds).sort()).toEqual(['logical-native-post', 'logical-native-pre']);
      const pre: Omit<APIRuleEntity, 'id'> = {
        stage: 'pre',
        conditionsOp: 'or',
        conditions: [
          { field: 'account', op: 'is', value: ids.accountIds.a_4!, type: 'id' },
          { field: 'payee', op: 'is', value: ids.payeeIds.pay_1!, type: 'id' },
        ],
        actions: [
          { field: 'category', op: 'set', value: ids.categoryIds.cat_1!, type: 'id' },
          { op: 'prepend-notes', value: 'synthetic pre fixture ' },
        ],
      };
      const post: Omit<APIRuleEntity, 'id'> = {
        stage: 'post',
        conditionsOp: 'and',
        conditions: [
          { field: 'payee', op: 'is', value: ids.payeeIds.pay_1!, type: 'id' },
          { field: 'account', op: 'is', value: ids.accountIds.a_4!, type: 'id' },
        ],
        actions: [
          { field: 'category', op: 'set', value: ids.categoryIds.cat_2!, type: 'id' },
          { op: 'append-notes', value: ' synthetic post fixture' },
        ],
      };
      const rules = (await actualSdk.getRules()).filter((rule) => Object.values(ruleIds).includes(rule.id));
      expect(rules.map((rule) => rule.id)).toEqual([
        ruleIds['logical-native-pre'], ruleIds['logical-native-post'],
      ]);
      expect(rules).toEqual([
        expect.objectContaining({
          id: ruleIds['logical-native-pre'], ...pre,
          actions: pre.actions.map((action) => expect.objectContaining(action)),
        }),
        expect.objectContaining({
          id: ruleIds['logical-native-post'], ...post,
          actions: post.actions.map((action) => expect.objectContaining(action)),
        }),
      ]);
      expect(Object.values(ruleIds)).not.toContain('logical-native-pre');
      expect(Object.values(ruleIds)).not.toContain('logical-native-post');
    });
  });

  it.each([
    { field: 'account', missingId: 'missing-native-account', action: false },
    { field: 'payee', missingId: 'missing-native-payee', action: false },
    { field: 'category', missingId: 'missing-native-category', action: true },
  ])('rejects unresolved native rule $field before any entity is written', async ({ field, missingId, action }) => {
    await withFreshActualBudget(async () => {
      const ledger = nativeRuleLedger();
      if (action) {
        ledger.rules[0]!.actions = [{ field, op: 'set', value: missingId, type: 'id' }];
      } else {
        ledger.rules[0]!.trigger = {
          stage: 'post', conditionsOp: 'and',
          conditions: [{ field, op: 'is', value: missingId, type: 'id' }],
        };
      }
      const before = await readActualState();
      const beforeRules = await actualSdk.getRules();
      await expect(populateActualBudget(ledger)).rejects.toThrow(/unresolved|reference|unknown/i);
      expect(await readActualState()).toEqual(before);
      expect(await actualSdk.getRules()).toEqual(beforeRules);
    });
  });

  it.each([
    {
      label: 'malformed money',
      ledger: draftLedger((draft) => {
        draft.transactions[0]!.amount = {
          minorUnits: '1.5',
          currency: 'USD',
        };
      }),
      diagnostic: /money|minorUnits|integer|malformed/i,
    },
    {
      label: 'integer outside JavaScript-safe money bounds',
      ledger: draftLedger((draft) => {
        draft.transactions[0]!.amount.minorUnits = '9007199254740992';
      }),
      diagnostic: /safe|precision|range|integer/i,
    },
    {
      label: 'unresolved account reference',
      ledger: draftLedger((draft) => {
        draft.transactions[0]!.accountId = 'missing-account';
      }),
      diagnostic: /account|reference|unresolved/i,
    },
    {
      label: 'duplicate logical transaction id',
      ledger: draftLedger((draft) => {
        draft.transactions.push({ ...draft.transactions[0]! });
      }),
      diagnostic: /duplicate|transaction|id/i,
    },
    {
      label: 'mixed currency',
      ledger: draftLedger((draft) => {
        draft.transactions[0]!.amount.currency = 'EUR';
      }),
      diagnostic: /currency|USD|EUR/i,
    },
    {
      label: 'split amount mismatch',
      ledger: draftLedger((draft) => {
        draft.transactions.find(
          (transaction) => transaction.id === 'tx_084',
        )!.subtransactions[1]!.amount.minorUnits = '-2000';
      }),
      diagnostic: /split|sum|amount|conservation/i,
    },
  ])('rejects $label before any Actual entity is written', async ({ ledger, diagnostic }) => {
    await withFreshActualBudget(async () => {
      const before = await readActualState();
      await expect(populateActualBudget(ledger)).rejects.toThrow(diagnostic);
      const after = await readActualState();
      expect(after).toEqual(before);
    });
  });
});

describe('seedActualBudget lifecycle trust boundary', () => {
  it('rejects a non-loopback server URL before initializing Actual', async () => {
    await expect(
      seedActualBudget({
        serverUrl: 'https://actual.example.test',
        secretKey: 'not-used',
        clientDir: join(fixtureRoot, 'nonloopback-client'),
        budgetName: 'Must Not Initialize',
        ledger: seedLedger(),
      }),
    ).rejects.toThrow(/loopback|localhost|127\.0\.0\.1|server url/i);
  });

  it('rejects an existing unowned client directory before initializing Actual', async () => {
    const clientDir = join(fixtureRoot, 'unowned-client');
    mkdirSync(clientDir, { recursive: true });
    const sentinel = join(clientDir, 'sentinel');
    writeFileSync(sentinel, 'must survive trust rejection');

    await expect(
      seedActualBudget({
        serverUrl: 'http://127.0.0.1:1',
        secretKey: 'not-used',
        clientDir,
        budgetName: 'Must Not Initialize',
        ledger: seedLedger(),
      }),
    ).rejects.toThrow(/owned|disposable|private|empty|client|root/i);

    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('must survive trust rejection');
  });
});

describe('seedActualBudget cross-client publication', () => {
  it('publishes seeded ledger transactions to a fresh Actual client before returning', async () => {
    const root = createOwnedScenarioRoot();
    let handle: ScenarioProcesses | undefined;
    let clientOpen = false;
    try {
      handle = await startScenarioShell({
        root,
        publicOrigin: 'http://127.0.0.1:43124',
        webEntry: fileURLToPath(new URL('../../../apps/web/.output/server/index.mjs', import.meta.url)),
      });
      await startScenarioActual(handle);
      const scenario = materializeScenario('uncategorized-debit', new Date());
      const seeded = await seedActualBudget({
        serverUrl: handle.actualUrl,
        secretKey: handle.actualSecretKey,
        clientDir: handle.seedClientDir,
        budgetName: 'Cross-client publication',
        ledger: scenario.ledger,
      });
      const freshDir = mkdtempSync(join(root, 'readback-client-'));
      await init({ serverURL: handle.actualUrl, password: handle.actualSecretKey, dataDir: freshDir });
      clientOpen = true;
      await downloadBudget(seeded.groupId);
      const accountId = seeded.accountIds['acct-checking'];
      const downloadedAccounts = await freshAccounts();
      expect(downloadedAccounts.map((row) => ({ id: row.id, name: row.name }))).toContainEqual({
        id: accountId,
        name: 'Household Checking',
      });
      const rows = await freshTransactions(accountId!, '1900-01-01', '2999-12-31');
      expect(rows.find((row) => row.id === seeded.transactionIds['tx-uncategorized-debit'])).toMatchObject({
        amount: -1000,
      });
    } finally {
      if (clientOpen) await shutdown();
      if (handle) await stopScenarioProcesses(handle);
      else await discardOwnedScenarioRoot(root);
    }
  }, 120_000);
});
