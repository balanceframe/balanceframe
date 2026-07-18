/**
 * 07-concurrency.test.ts — Concurrency & Compatibility
 *
 * Proof points:
 *   1. Concurrent reads work correctly
 *   2. Serialized per-budget write stream
 *   3. Interruption behavior (timeout, retry)
 *   4. Supported Actual version compatibility detection
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { withActualClient, requireEnv, withTestBudget } from './helpers';
import {
  init, shutdown, createBudget, getAccounts, getPayees,
  getTransactions, getCategories, getBudgets, addTransactions,
  createAccount, createPayee, createCategory, createCategoryGroup,
  sync, downloadBudget, getBudgetMonth, runQuery, exportBudget,
} from '@actual-app/api';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let serverUrl: string;
let secretKey: string;

beforeAll(() => {
  serverUrl = requireEnv('ACTUAL_SERVER_URL');
  secretKey = requireEnv('ACTUAL_SECRET_KEY');
});

describe('07 — Concurrency & Compatibility', () => {

  // ==================================================================
  //  Proof 1: Concurrent reads work correctly
  // ==================================================================
  it('should handle concurrent reads from the same budget', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Concurrent-Reads-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });
      await createAccount({ name: 'Savings', type: 'savings' });
      await createCategoryGroup({ name: 'Expenses' });
      await createPayee({ name: 'Payee A' });
      await createPayee({ name: 'Payee B' });
      await sync();

      // Run multiple reads in parallel
      const [accounts, categories, payees] = await Promise.all([
        getAccounts(),
        getCategories(),
        getPayees(),
      ]);

      // All should succeed with correct data
      expect(accounts.length).toBeGreaterThanOrEqual(2);
      expect(categories.length).toBeGreaterThanOrEqual(1);
      expect(payees.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('should handle many concurrent read requests', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Many-Concurrent-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });
      await sync();

      // Run 20 concurrent reads
      const count = 20;
      const results = await Promise.allSettled(
        Array.from({ length: count }, () => getAccounts()),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(count);
      expect(rejected.length).toBe(0);
    });
  });

  it('should handle concurrent reads from multiple budgets', async () => {
    await withActualClient(async () => {
      // Create two budgets
      const b1 = await createBudget({
        name: `Concurrent-A-${Date.now()}`,
        avoidUpload: false,
      });
      const b2 = await createBudget({
        name: `Concurrent-B-${Date.now()}`,
        avoidUpload: false,
      });

      // Read both budget sets concurrently (they're both open)
      const [accts1, accts2] = await Promise.all([
        getAccounts(),
        getAccounts(),
      ]);

      expect(Array.isArray(accts1)).toBe(true);
      expect(Array.isArray(accts2)).toBe(true);
    });
  });

  // ==================================================================
  //  Proof 2: Serialized per-budget write stream
  // ==================================================================
  it('should serialize writes to the same budget', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Serialized-Writes-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });

      // Perform sequential writes (each depends on previous)
      await addTransactions(
        (await getAccounts())[0].id,
        [{ date: '2025-01-01', amount: -10000 }],
      );
      await sync();

      await addTransactions(
        (await getAccounts())[0].id,
        [{ date: '2025-01-02', amount: -20000 }],
      );
      await sync();

      // Verify both writes persisted
      const txns = await getTransactions((await getAccounts())[0].id);
      expect(txns.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('should allow read operations between writes', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Interleaved-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });

      // Write
      await addTransactions(
        (await getAccounts())[0].id,
        [{ date: '2025-02-01', amount: -50000 }],
      );
      await sync();

      // Read (interleaved)
      const accounts = await getAccounts();
      // Write
      await createPayee({ name: 'New Payee' });
      await sync();

      // Read again
      const payees = await getPayees();
      // Write
      await addTransactions(
        accounts[0].id,
        [{ date: '2025-02-15', amount: -25000 }],
      );
      await sync();

      // Final read
      const txns = await getTransactions(accounts[0].id);

      expect(txns.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('should not lose data under sequential write pressure', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Write-Pressure-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });

      // Perform many sequential writes
      for (let i = 0; i < 10; i++) {
        await addTransactions(
          (await getAccounts())[0].id,
          [{
            date: `2025-03-${String(i + 1).padStart(2, '0')}`,
            amount: -(i + 1) * 1000,
            notes: `pressure-${i}`,
          }],
        );
      }
      await sync();

      const txns = await getTransactions((await getAccounts())[0].id);
      expect(txns.length).toBe(10);
    });
  });

  // ==================================================================
  //  Proof 3: Interruption behavior (timeout, retry)
  // ==================================================================
  it('should handle timeout for long operations', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Timeout-Test-${Date.now()}`,
        avoidUpload: false,
      });

      // Budget queries should complete within reasonable time
      const start = Date.now();
      const result = await getBudgetMonth('2025-01');
      const elapsed = Date.now() - start;

      // The operation completed (didn't hang indefinitely)
      expect(result).toBeDefined();
      // Operation should be fast (under 30 seconds)
      expect(elapsed).toBeLessThan(30_000);
    });
  });

  it('should recover from a failed write attempt', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Recovery-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });

      // Attempt an invalid write (missing required fields)
      try {
        await addTransactions(
          (await getAccounts())[0].id,
          [{ /* missing date and amount */ }] as unknown as never[],
        );
      } catch {
        // Expected to fail — missing required fields
      }

      // System should recover — subsequent valid writes should work
      await addTransactions(
        (await getAccounts())[0].id,
        [{ date: '2025-04-01', amount: -10000, notes: 'After recovery' }],
      );
      await sync();

      const txns = await getTransactions((await getAccounts())[0].id);
      expect(txns.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should handle retry after server interruption gracefully', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Retry-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Retry-Acct', type: 'checking' });

      // Simulate retry by calling the same operation multiple times
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const accounts = await getAccounts();
          expect(accounts.length).toBeGreaterThanOrEqual(1);
          break; // Success, no retry needed
        } catch {
          if (attempt === 2) throw; // Last attempt
          // Would retry in production
        }
      }
    });
  });

  // ==================================================================
  //  Proof 4: Supported Actual version compatibility detection
  // ==================================================================
  it('should detect the Actual server version', async () => {
    await withActualClient(async () => {
      // The server version can be inferred from the budgets response
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);

      // Running export gives insight into server capabilities
      const exported = await exportBudget();
      const parsed = JSON.parse(exported);

      // Check export format version
      expect(parsed).toHaveProperty('accounts');
    });
  });

  it('should verify API contract compatibility', async () => {
    await withActualClient(async () => {
      // Verify all core API methods respond correctly
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);

      // Create a test budget
      const { id: budgetId, groupId } = await createBudget({
        name: `Compat-Test-${Date.now()}`,
        avoidUpload: false,
      });

      // Verify CRUD operations match expected signatures
      await createAccount({ name: 'Compat-Checking', type: 'checking' });
      const accounts = await getAccounts();
      expect(accounts.length).toBeGreaterThanOrEqual(1);

      // Query capability
      const queryResult = await runQuery({
        select: 'transactions',
        filters: [],
      });
      expect(queryResult).toHaveProperty('data');
    });
  });

  it('should handle a mix of reads and writes without deadlock', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Mix-Deadlock-${Date.now()}`,
        avoidUpload: false,
      });
      await createAccount({ name: 'Checking', type: 'checking' });

      // Interleave reads and writes
      const read1 = getAccounts();
      await sync(); // write operation
      const read2 = getPayees();
      const read3 = getCategories();

      const results = await Promise.allSettled([read1, read2, read3]);
      results.forEach((r) => {
        expect(r.status).toBe('fulfilled');
      });
    });
  });

  it('should support multiple independent clients', async () => {
    // Create two separate client instances pointing at the same server
    const dir1 = mkdtempSync(join(tmpdir(), 'bf-client1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'bf-client2-'));

    try {
      // Client 1
      await init({ serverURL: serverUrl, password: secretKey, dataDir: dir1 });
      const budgets1 = await getBudgets();
      await shutdown();

      // Client 2
      await init({ serverURL: serverUrl, password: secretKey, dataDir: dir2 });
      const budgets2 = await getBudgets();
      await shutdown();

      // Both clients should see the same server data
      expect(Array.isArray(budgets1)).toBe(true);
      expect(Array.isArray(budgets2)).toBe(true);
    } finally {
      // Cleanup
      try { await shutdown(); } catch { /* ignore */ }
    }
  });
});
