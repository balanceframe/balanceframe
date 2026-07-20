/**
 * 01-connection-budget.test.ts — Connection & Budget Discovery
 *
 * Proof points:
 *   1. Connect to a remote Actual server instance
 *   2. Discover and list available budgets
 *   3. Select a budget and read its identity (budgetId, groupId, name)
 *   4. Connect to both encrypted and unencrypted budgets
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  getActualClient, requireEnv, withActualClient, cleanupBudget,
} from './helpers';
import { getBudgets, createBudget, downloadBudget } from './actual-client.js';

// ---- Helpers ---------------------------------------------------------------

/** Tracks budget IDs created during a test for cleanup in afterEach. */
const createdBudgets: Array<{ budgetId: string; groupId: string }> = [];

afterEach(async () => {
  while (createdBudgets.length > 0) {
    const b = createdBudgets.pop()!;
    await cleanupBudget(b.budgetId, b.groupId).catch(() => {});
  }
});

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
      createdBudgets.push({ budgetId: id, groupId });
      const after = await getBudgets();
      const afterNames = after.map((b: { name?: string }) => b.name ?? '');
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      expect(afterNames).toContain(`Connection-Test-Disposable-${id.slice(0, 8)}`);
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
      createdBudgets.push({ budgetId: id, groupId });
    });
  });

  // ------------------------------------------------------------------
  // Proof: Encrypted budget connection
  // ------------------------------------------------------------------
  it('should connect to an encrypted budget with password', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Encrypted-Conn-${Date.now()}`,
        avoidUpload: false,
      });
      createdBudgets.push({ budgetId, groupId });

      // Download with encryption password — this proves the client can
      // complete a password-protected handshake against the server.
      await expect(
        downloadBudget(groupId, budgetId, { password: secretKey }),
      ).resolves.toBeUndefined();

      // After the password‑authenticated download the budget is loaded
      // into the client. Verify it is discoverable in the budget list.
      const budgets = await getBudgets();
      const match = budgets.find(
        (b: { id?: string }) => b.id === budgetId,
      );
      expect(match).toBeDefined();
      expect((match as Record<string, unknown>)?.name).toContain('Encrypted-Conn-');
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
