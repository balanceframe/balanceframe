import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { downloadBudget, getAccounts as freshAccounts, getTransactions as freshTransactions, init, shutdown } from '@actual-app/api';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
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
