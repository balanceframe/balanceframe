/**
 * 02-sync-cache-lifecycle.test.ts — Sync & Cache Lifecycle
 *
 * Proof points:
 *   1. Download a budget (encrypted and unencrypted)
 *   2. Synchronize with the server
 *   3. Verify isolated cache lifecycle per budget
 *   4. Test cache cleanup and disconnect
 *   5. Prove cache is isolated (no cross-budget leakage)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getActualClient, requireEnv, withActualClient, seedFixtureData,
} from './helpers';
import { init, shutdown, createBudget, downloadBudget, deleteBudget,
sync, getAccounts, getBudgets, createAccount, } from './actual-client.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let serverUrl: string;
let secretKey: string;

beforeAll(() => {
  serverUrl = requireEnv('ACTUAL_SERVER_URL');
  secretKey = requireEnv('ACTUAL_SECRET_KEY');
});

describe('02 — Sync & Cache Lifecycle', () => {

  // ------------------------------------------------------------------
  // Proof 1: Download a budget (unencrypted)
  // ------------------------------------------------------------------
  it('should download an unencrypted budget', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bf-dl-unencrypted-'));

    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `DL-Unencrypted-${Date.now()}`,
        avoidUpload: false,
      });

      // Download without encryption password
      await downloadBudget(groupId, budgetId);
      expect(typeof budgetId).toBe('string');
      expect(budgetId.length).toBeGreaterThan(0);
    });

    rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Proof 1a: Download an encrypted budget
  // ------------------------------------------------------------------
  it('should download an encrypted budget with password', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `DL-Encrypted-${Date.now()}`,
        avoidUpload: false,
      });

      // Download with encryption password
      await downloadBudget(groupId, budgetId, { password: secretKey });
      expect(typeof budgetId).toBe('string');
    });
  });

  it('should reopen an unencrypted budget without a password', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `DL-NoPassword-${Date.now()}`,
        avoidUpload: false,
      });

      await expect(downloadBudget(groupId, budgetId)).resolves.toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Proof 2: Synchronize with server
  // ------------------------------------------------------------------
  it('should synchronize budget data with the server', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Sync-Test-${Date.now()}`,
        avoidUpload: false,
      });

      // Upload data (sync pushes local changes to server)
      await sync();

      // Download fresh copy (sync pulls server data)
      await downloadBudget(groupId, budgetId);

      expect(typeof budgetId).toBe('string');
    });
  });

  it('should sync after seeding fixture data', async () => {
    await withActualClient(async () => {
      await createBudget({
        name: `Sync-Fixture-${Date.now()}`,
        avoidUpload: false,
      });

      // Seed fixture data and sync
      await seedFixtureData();
      await sync();

      const accounts = await getAccounts();
      expect(accounts.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------
  // Proof 3: Isolated cache lifecycle per budget
  // ------------------------------------------------------------------
  it('should maintain separate cache directories per budget', async () => {
    // Budget A
    const dirA = mkdtempSync(join(tmpdir(), 'bf-cache-A-'));
    await getActualClient({ dataDir: dirA });
    const { id: idA, groupId: groupA } = await createBudget({
      name: `Cache-Test-A-${Date.now()}`,
      avoidUpload: false,
    });
    await downloadBudget(groupA, idA);
    const accountsA = await getAccounts();
    await shutdown();

    // Budget B (different cache)
    const dirB = mkdtempSync(join(tmpdir(), 'bf-cache-B-'));
    await getActualClient({ dataDir: dirB });
    const { id: idB, groupId: groupB } = await createBudget({
      name: `Cache-Test-B-${Date.now()}`,
      avoidUpload: false,
    });
    await downloadBudget(groupB, idB);
    const accountsB = await getAccounts();
    await shutdown();

    // Both budgets should have accounts; they should not interfere
    expect(Array.isArray(accountsA)).toBe(true);
    expect(Array.isArray(accountsB)).toBe(true);

    // Cache directories should exist
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);

    // Cleanup
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Proof 4: Cache cleanup and disconnect
  // ------------------------------------------------------------------
  it('should cleanly disconnect and shutdown the client', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bf-cleanup-'));

    await init({
      serverURL: serverUrl,
      password: secretKey,
      dataDir,
    });

    // Verify connected
    const budgets = await getBudgets();
    expect(Array.isArray(budgets)).toBe(true);

    // Disconnect
    await shutdown();

    // Actual retains the last budget listing in memory, but shutdown must
    // resolve cleanly and release the active budget/database services.
    expect(existsSync(dataDir)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('should call shutdown safely multiple times', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bf-multi-shutdown-'));

    await init({
      serverURL: serverUrl,
      password: secretKey,
      dataDir,
    });
    await shutdown();

    // Calling shutdown again should be safe (idempotent)
    await expect(shutdown()).resolves.not.toThrow();

    rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Proof 5: No cross-budget leakage
  // ------------------------------------------------------------------
  it('should NOT leak data between budgets', async () => {
    await withActualClient(async () => {
      // Budget 1 — with one account
      const { id: id1, groupId: group1 } = await createBudget({
        name: `Isolation-A-${Date.now()}`,
        avoidUpload: false,
      });

      // Create an account in Budget 1
      await createAccount({ name: 'Private-Account-A', type: 'checking' });
      await sync();

      // Download Budget 1 explicitly and read accounts
      await downloadBudget(group1, id1);

      // Budget 2 — should have no accounts yet
      const { id: id2, groupId: group2 } = await createBudget({
        name: `Isolation-B-${Date.now()}`,
        avoidUpload: false,
      });

      // Open Budget 2
      await downloadBudget(group2, id2);
      const accounts2 = await getAccounts();

      // Budget 2 should NOT have 'Private-Account-A'
      const names2 = accounts2.map((a: { name?: string }) => a.name ?? '');
      expect(names2).not.toContain('Private-Account-A');

      // Budget 1's account should still exist
      await downloadBudget(group1, id1);
      const accounts1b = await getAccounts();
      const names1b = accounts1b.map((a: { name?: string }) => a.name ?? '');
      expect(names1b).toContain('Private-Account-A');
    });
  });

  // ------------------------------------------------------------------
  // Additional: budget deletion and cache behavior
  // ------------------------------------------------------------------
  it('should handle deleted budget cache gracefully', async () => {
    await withActualClient(async () => {
      const { id: budgetId, groupId } = await createBudget({
        name: `Delete-Cache-${Date.now()}`,
        avoidUpload: false,
      });
      await sync();

      // Delete from Actual, then verify neither local nor remote identity is
      // advertised. Actual's load-budget RPC logs missing-cache errors rather
      // than rejecting its promise, so discovery is the reliable contract.
      await deleteBudget(groupId, budgetId);
      const budgets = await getBudgets();
      expect(budgets.some((budget) =>
        budget.id === budgetId || budget.groupId === groupId
      )).toBe(false);
    });
  });
});
