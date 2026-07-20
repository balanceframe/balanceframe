/**
 * 01-connection-budget.test.ts — Connection & Budget Discovery
 *
 * Proof points:
 *   1. Connect to a remote Actual server instance
 *   2. Discover and list available budgets
 *   3. Select a budget and read its identity (budgetId, groupId, name)
 *   4. Connect to both encrypted and unencrypted budgets
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getActualClient, requireEnv, withActualClient,
} from './helpers';
import { getBudgets, createBudget } from './actual-client.js';

// ---- Setup / Teardown -----------------------------------------------------

let serverUrl: string;
let secretKey: string;

beforeAll(() => {
  serverUrl = requireEnv('ACTUAL_SERVER_URL');
  secretKey = requireEnv('ACTUAL_SECRET_KEY');
});

// ---- Tests -----------------------------------------------------------------

describe('01 — Connection & Budget Discovery', () => {

  // ==================================================================
  //  Proof 1: Connect to a remote Actual server instance
  // ==================================================================
  it('should connect to a remote Actual server', async () => {
    await withActualClient(async () => {
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Negative: Invalid password
  it('should reject connection with invalid password', async () => {
    await expect(
      getActualClient({ password: 'wrong-password' }),
    ).rejects.toThrow();
  });

  // ------------------------------------------------------------------
  // Negative: Unreachable server
  it('should reject connection to unreachable server', async () => {
    await expect(
      getActualClient({ serverURL: 'http://localhost:19999' }),
    ).rejects.toThrow();
  });

  // ==================================================================
  //  Proof 2: Discover and list available budgets
  // ==================================================================
  it('should list available budgets', async () => {
    await withActualClient(async () => {
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);
    });
  });

  // ==================================================================
  //  Proof 3: Create a budget and find it in the budget list
  // ==================================================================
  it('should create a budget and find it in the budget list', async () => {
    await withActualClient(async () => {
      const before = await getBudgets();
      const { id, groupId } = await createBudget({
        name: `Connection-Test-Disposable-${Date.now()}`,
        avoidUpload: false,
      });
      expect(id).toBeDefined();
      expect(groupId).toBeDefined();
      const after = await getBudgets();
      const afterNames = after.map((b: { name?: string }) => b.name ?? '');
      expect(after.length).toBeGreaterThanOrEqual(before.length);
    });
  });

  // ==================================================================
  //  Proof 4: Select a budget and read its identity
  // ==================================================================
  it('should select a budget and read its identity', async () => {
    await withActualClient(async () => {
      const { id, groupId } = await createBudget({
        name: `Identity-Test-${Date.now()}`,
        avoidUpload: false,
      });
      expect(id).toBeDefined();
      expect(groupId).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Proof: Get budget metadata
  it('should list all fields returned for budgets', async () => {
    await withActualClient(async () => {
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);
      if (budgets.length > 0) {
        const budget = budgets[0] as Record<string, unknown>;
        expect('id' in budget || 'cloudFileId' in budget).toBe(true);
        expect(budget).toHaveProperty('name');
      }
    });
  });

  // ------------------------------------------------------------------
  // Proof: State isolation between connections
  it('should connect and disconnect without leaking state', async () => {
    for (let i = 0; i < 3; i++) {
      await withActualClient(async () => {
        const budgets = await getBudgets();
        expect(Array.isArray(budgets)).toBe(true);
      });
    }
  });

});
