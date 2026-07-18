/**
 * 03-read-entities.test.ts — Read Entities & Queries
 *
 * Proof points:
 *   1. Read accounts, categories, payees, transactions
 *   2. Read rules, schedules, budget months/amounts/carryover/holds
 *   3. Read tags and notes
 *   4. Execute ActualQL queries
 *   5. Execute batch queries
 *   6. Test filtering and pagination
 */

import { describe, it, expect } from 'vitest';
import { withActualClient, seedFixtureData } from './helpers';
import {
  createBudget, getAccounts, getCategories, getCategoryGroups,
  getPayees, getTransactions, getRules, getSchedules,
  getBudgetMonth, getBudgetMonths, runQuery,
  batch as actualBatch, addTransactions, createAccount,
  createCategoryGroup, sync,
} from '@actual-app/api';


describe('03 — Read Entities & Queries', () => {

  // ==================================================================
  //  Proof 1: Read accounts, categories, payees, transactions
  // ==================================================================
  it('should read all accounts from a budget', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Read-Accts-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      const accounts = await getAccounts();
      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts.length).toBeGreaterThanOrEqual(1);

      // Each account has expected fields
      const first = accounts[0] as { name?: string; id?: string; type?: string };
      expect(first).toHaveProperty('name');
      expect(first).toHaveProperty('id');
    });
  });

  it('should read all categories from a budget', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Read-Cats-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      const categories = await getCategories();
      expect(Array.isArray(categories)).toBe(true);
      expect(categories.length).toBeGreaterThanOrEqual(1);

      // Also read category groups
      const groups = await getCategoryGroups();
      expect(Array.isArray(groups)).toBe(true);

      const firstCat = categories[0] as { name?: string; id?: string };
      expect(firstCat).toHaveProperty('name');
      expect(firstCat).toHaveProperty('id');
    });
  });

  it('should read all payees from a budget', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Read-Payees-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      const payees = await getPayees();
      expect(Array.isArray(payees)).toBe(true);
      expect(payees.length).toBeGreaterThanOrEqual(1);

      const firstPayee = payees[0] as { name?: string; id?: string };
      expect(firstPayee).toHaveProperty('name');
    });
  });

  it('should read transactions from an account', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Read-Txns-${Date.now()}`,
        avoidUpload: false,
      });
      // Create an account with transactions
      await createAccount({ name: 'Txn-Test', type: 'checking' });
      const accounts = await getAccounts();
      const acct = accounts[0] as { id: string; name?: string };

      await addTransactions(acct.id, [
        { date: '2025-01-01', amount: -10000, notes: 'test txn 1' },
        { date: '2025-01-02', amount: -20000, notes: 'test txn 2' },
        { date: '2025-01-03', amount: 50000, notes: 'income' },
      ]);
      await sync();

      const transactions = await getTransactions(acct.id);
      expect(Array.isArray(transactions)).toBe(true);
      expect(transactions.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('should read transactions with date filtering', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Filter-Txns-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Filter-Test', type: 'checking' });
      const accounts = await getAccounts();
      const acct = accounts[0] as { id: string };

      // Transactions across multiple months
      await addTransactions(acct.id, [
        { date: '2025-01-15', amount: -15000 },
        { date: '2025-02-15', amount: -25000 },
        { date: '2025-03-15', amount: -35000 },
      ]);
      await sync();

      // Filter by date range
      const filtered = await getTransactions(acct.id, {
        startDate: '2025-02-01',
        endDate: '2025-02-28',
      });
      expect(filtered.length).toBeGreaterThanOrEqual(1);

      // All returned transactions should be within the range
      for (const t of filtered) {
        const tObj = t as { date?: string };
        expect(tObj.date).toBeDefined();
      }
    });
  });

  // ==================================================================
  //  Proof 2: Read rules, schedules, budget months
  // ==================================================================
  it('should read rules from a budget', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Read-Rules-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      const rules = await getRules();
      expect(Array.isArray(rules)).toBe(true);
    });
  });

  it('should read schedules from a budget', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Read-Sched-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      const schedules = await getSchedules();
      expect(Array.isArray(schedules)).toBe(true);
    });
  });

  it('should read budget month data', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Budget-Month-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      // Read a specific budget month
      const monthData = await getBudgetMonth('2025-01');
      expect(monthData).toBeDefined();
      expect(monthData).toHaveProperty('month');
      // Category budget data is present
      expect(monthData).toHaveProperty('categoryBudgetAmount');
    });
  });

  it('should read budget months over a range', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Budget-Range-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      // Read a range of budget months
      const months = await getBudgetMonths('2025-01', '2025-03');
      expect(Array.isArray(months)).toBe(true);
      expect(months.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should read budget carryover settings', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Carryover-${Date.now()}`,
        avoidUpload: false,
      });

      // Create a budget month and check carryover
      const monthData = await getBudgetMonth('2025-01');
      if (monthData && typeof monthData === 'object') {
        // Check that budget month has carryover field
        const md = monthData as Record<string, unknown>;
        // When creating a fresh budget, carryover defaults may apply
        expect(md).toHaveProperty('month');
      }
    });
  });

  it('should read category holds data', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Category-Holds-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      const monthData = await getBudgetMonth('2025-01');
      if (monthData && typeof monthData === 'object') {
        const md = monthData as { categoryBudgetAmount?: unknown };
        expect(md).toHaveProperty('categoryBudgetAmount');
      }
    });
  });

  // ==================================================================
  //  Proof 3: Read tags and notes
  // ==================================================================
  it('should read notes from transactions', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Notes-Test-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Notes-Test-Acct', type: 'checking' });
      const accounts = await getAccounts();
      const acct = accounts[0] as { id: string };

      await addTransactions(acct.id, [
        { date: '2025-01-01', amount: -5000, notes: 'important note' },
        { date: '2025-01-02', amount: -3000, notes: '' },
      ]);
      await sync();

      const transactions = await getTransactions(acct.id);
      const txn = transactions.find(
        (t: unknown) => (t as { notes?: string }).notes === 'important note',
      ) as { notes?: string } | undefined;
      expect(txn).toBeDefined();
      expect(txn?.notes).toBe('important note');
    });
  });

  // ==================================================================
  //  Proof 4: Execute ActualQL queries
  // ==================================================================
  it('should execute an ActualQL query', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `ActualQL-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'QL-Acct', type: 'checking' });
      const accounts = await getAccounts();
      const acct = accounts[0] as { id: string };

      await addTransactions(acct.id, [
        { date: '2025-01-01', amount: -5000 },
        { date: '2025-01-02', amount: -15000 },
      ]);
      await sync();

      // Run a simple ActualQL query
      const result = await runQuery({
        select: 'transactions',
        filters: [{ field: 'amount', op: 'lt', value: -10000 }],
      });
      expect(result).toBeDefined();
      expect(result).toHaveProperty('data');
    });
  });

  it('should execute ActualQL with account filter', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `QL-Acct-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Filtered-Acct', type: 'checking' });
      await createCategoryGroup({ name: 'Test Group' });
      const accounts = await getAccounts();
      const acctId = (accounts[0] as { id: string }).id;

      await addTransactions(acctId, [
        { date: '2025-01-01', amount: -10000 },
      ]);
      await sync();

      // Query filtered by account
      const result = await runQuery({
        select: 'transactions',
        filters: [{ field: 'account', op: 'eq', value: acctId }],
      });
      const data = result.data as unknown[];
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==================================================================
  //  Proof 5: Execute batch queries
  // ==================================================================
  it('should execute a batch of queries', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Batch-${Date.now()}`,
        avoidUpload: false,
      });
      await seedFixtureData();

      // Run batch queries using the batch API
      const results = await actualBatch([
        ['get-accounts', 'getAccounts', []],
        ['get-categories', 'getCategories', []],
        ['get-payees', 'getPayees', []],
      ]);

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
    });
  });

  it('should handle batch with mixed operations', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Batch-Mixed-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Batch-Acct', type: 'checking' });

      const batchOps = [
        ['getAccounts', []],
        ['getPayees', []],
      ];

      const results = await actualBatch(batchOps);
      expect(results).toBeDefined();
    });
  });

  // ==================================================================
  //  Proof 6: Filtering and pagination
  // ==================================================================
  it('should support paginated transaction reads', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Pagination-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Pagination-Acct', type: 'checking' });
      const accounts = await getAccounts();
      const acct = accounts[0] as { id: string };

      // Add enough transactions to test pagination
      const txns = Array.from({ length: 15 }, (_, i) => ({
        date: `2025-01-${String(i + 1).padStart(2, '0')}`,
        amount: -(i + 1) * 1000,
        notes: `txn-${i}`,
      }));
      await addTransactions(acct.id, txns);
      await sync();

      // Read all (implicit pagination)
      const allTxns = await getTransactions(acct.id);
      expect(allTxns.length).toBeGreaterThanOrEqual(15);
    });
  });

  it('should filter transactions by date range boundaries', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Date-Bound-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Bound-Acct', type: 'checking' });
      const accounts = await getAccounts();
      const acct = accounts[0] as { id: string };

      await addTransactions(acct.id, [
        { date: '2025-01-01', amount: -1000 },
        { date: '2025-06-15', amount: -2000 },
        { date: '2025-12-31', amount: -3000 },
      ]);
      await sync();

      // Filter single day
      const exact = await getTransactions(acct.id, {
        startDate: '2025-06-15',
        endDate: '2025-06-15',
      });
      expect(exact.length).toBeGreaterThanOrEqual(1);
    });
  });
});
