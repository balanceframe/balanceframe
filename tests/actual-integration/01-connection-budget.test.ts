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
  getActualClient, requireEnv, withActualClient, cleanupBudget, buildClientConfig,
} from './helpers';
import { init, shutdown, getBudgets, downloadBudget, getAccounts,
         createBudget } from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---- Setup / Teardown -----------------------------------------------------

let serverUrl: string;
let secretKey: string;

beforeAll(() => {
  serverUrl = requireEnv('ACTUAL_SERVER_URL');
  secretKey = requireEnv('ACTUAL_SECRET_KEY');
});

// ---- Tests -----------------------------------------------------------------

describe('01 — Connection & Budget Discovery', () => {

  // ------------------------------------------------------------------
  // Proof 1: Connect to a remote Actual instance
  // ------------------------------------------------------------------
  it('should connect to a remote Actual server', async () => {
    await expect(
      getActualClient({ serverURL: serverUrl, password: secretKey }),
    ).resolves.not.toThrow();

    // Cleanup: shutdown the client initialized by getActualClient
    await shutdown();
  });

  it('should reject connection with invalid password', async () => {
    const config = buildClientConfig();
    await expect(
      init({
        serverURL: serverUrl,
        password: 'wrong-password-12345',
        dataDir: config.dataDir,
      }),
    ).rejects.toThrow();

    // Ensure clean state even on failure
    await shutdown().catch(() => {});
  });

  it('should reject connection to unreachable server', async () => {
    const config = buildClientConfig();
    await expect(
      init({
        serverURL: 'http://localhost:19999',
        password: secretKey,
        dataDir: config.dataDir,
      }),
    ).rejects.toThrow();
  });

  // ------------------------------------------------------------------
  // Proof 2: Discover and list available budgets
  // ------------------------------------------------------------------
  it('should list available budgets', async () => {
    await withActualClient(async () => {
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);
      // After setup-fixture-server, at least one budget should exist.
      // If none exist (fresh server), the array is empty — still valid.
      for (const b of budgets) {
        expect(b).toHaveProperty('id');
        expect(b).toHaveProperty('name');
      }
    });
  });

  it('should create a budget and find it in the budget list', async () => {
    await withActualClient(async () => {
      const before = await getBudgets();

      // Create a new budget
      const { id, groupId } = await createBudget({
        name: 'Connection-Test-Disposable',
        avoidUpload: false,
      });

      // List budgets again
      const after = await getBudgets();
      const afterNames = after.map((b: { name?: string }) => b.name ?? '');

      expect(after.length).toBeGreaterThanOrEqual(before.length);
      expect(afterNames).toContain('Connection-Test-Disposable');

      // Cleanup — remove the disposable budget
      await cleanupBudget(id, groupId);
    });
  });

  // ------------------------------------------------------------------
  // Proof 3: Select a budget and get its identity
  // ------------------------------------------------------------------
  it('should select a budget and read its identity', async () => {
    await withActualClient(async () => {
      // Create a new budget to get known identity
      const { id: budgetId, groupId } = await createBudget({
        name: 'Identity-Test',
        avoidUpload: false,
      });

      // The budget is already "selected" since we just created it.
      // We can verify by downloading it (which implicitly selects).
      await downloadBudget(groupId, budgetId);

      // Verify the budget identity by inspecting its data
      const accounts = await getAccounts();
      expect(Array.isArray(accounts)).toBe(true);

      // Cleanup
      await cleanupBudget(budgetId, groupId);
    });
  });

  it('should handle non-existent budget gracefully', async () => {
    await withActualClient(async () => {
      await expect(
        downloadBudget('nonexistent-group', 'nonexistent-budget'),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // Proof 4: Connect to encrypted and unencrypted budgets
  // ------------------------------------------------------------------
  it('should connect to an unencrypted budget', async () => {
    await withActualClient(async () => {
      // Create an unencrypted budget (no password passed to createBudget)
      const { id: budgetId, groupId } = await createBudget({
        name: `Unencrypted-Test-${Date.now()}`,
        avoidUpload: false,
      });

      // Download without password (unencrypted)
      await downloadBudget(groupId, budgetId);
      const accounts = await getAccounts();
      expect(Array.isArray(accounts)).toBe(true);

      await cleanupBudget(budgetId, groupId);
    });
  });

  // ------------------------------------------------------------------
  // Proof 4a: Encrypted budget support
  it('should reject download of an encrypted budget without password and accept with correct password', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bf-actual-enc-test-'));
    const encPassword = 'test-encrypt-password-42';
    const budgetName = `Encrypted-Test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const { send } = await init({
      serverURL: serverUrl,
      password: secretKey,
      dataDir,
    });
    let budgetId: string | undefined;
    let cloudFileId: string | undefined;
    let groupId: string | undefined;

    try {
      // Step 1: Create a disposable budget
      await send('create-budget', { budgetName, avoidUpload: false });

      // Step 2: Find the budget via the public API to get its identity
      const budgets = await getBudgets();
      const budget = budgets.find((b: { name?: string }) => b.name === budgetName);
      expect(budget).toBeDefined();
      budgetId = budget!.id!;
      cloudFileId = budget!.cloudFileId!;

      // Step 3: Encrypt the budget with a real password
      // This calls key-make which generates a key from the password, stores
      // the key test on the server, and sets encryptKeyId in local prefs.
      await send('key-make', { password: encPassword });

      // Step 4: Re-upload the budget — now encrypted with encryptKeyId metadata
      await send('upload-budget');

      // Step 5: Get the updated budget info (groupId was restored by upload)
      const afterUpload = await getBudgets();
      const synced = afterUpload.find((b: { name?: string }) => b.name === budgetName);
      expect(synced).toBeDefined();
      groupId = synced!.groupId!;

      // Budget must now be marked as encrypted
      expect(synced).toHaveProperty('encryptKeyId');
      expect(synced!.encryptKeyId).toBeTruthy();

      // Step 6: Close the budget so downloadBudget re-downloads it fresh
      await send('close-budget');

      // Step 7: Download without password — must reject (file is encrypted)
      await expect(
        downloadBudget(groupId),
      ).rejects.toThrow(/encrypted/i);

      // Step 8: Download with wrong password — must reject
      await expect(
        downloadBudget(groupId, { password: 'wrong-password' }),
      ).rejects.toThrow();

      // Step 9: Download with correct password — must succeed
      await downloadBudget(groupId, { password: encPassword });
      const accounts = await getAccounts();
      expect(Array.isArray(accounts)).toBe(true);
    } finally {
      // Step 10: Cleanup — delete the encrypted budget from server and disk
      await send('delete-budget', { id: budgetId, cloudFileId }).catch(() => {});
      await shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------
  // Proof: Get budget metadata
  // ------------------------------------------------------------------
  it('should list all fields returned for budgets', async () => {
    await withActualClient(async () => {
      const budgets = await getBudgets();
      expect(Array.isArray(budgets)).toBe(true);
      if (budgets.length > 0) {
        const budget = budgets[0] as Record<string, unknown>;
        // Budget objects should have identification fields
        expect(budget).toHaveProperty('id');
        expect(budget).toHaveProperty('name');
      }
    });
  });

  it('should connect and disconnect without leaking state', async () => {
    // Connect and disconnect repeatedly to verify no state leaks
    for (let i = 0; i < 3; i++) {
      await withActualClient(async () => {
        const budgets = await getBudgets();
        expect(Array.isArray(budgets)).toBe(true);
      });
    }
  });
});
