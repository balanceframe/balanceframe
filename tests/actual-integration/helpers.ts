/**
 * helpers.ts — Test Utilities for Actual API Integration Tests
 *
 * Provides factory functions for creating disposable test budgets, seeding
 * fixture data, cleanup, and obtaining an initialized Actual API client.
 *
 * All functions assume ACTUAL_SERVER_URL and ACTUAL_SECRET_KEY are set in
 * environment variables (or process.env by vitest config).
 */

import {
  init,
  shutdown,
  createBudget,
  deleteBudget,
  downloadBudget,
  sync as actualSync,
} from './actual-client.js';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---- Types ----------------------------------------------------------------

export interface ClientConfig {
  serverURL: string;
  password: string;
  dataDir: string;
}

export interface SeededBudget {
  budgetId: string;
  groupId: string;
  budgetName: string;
}
export interface FixtureProvenance {
  serverURL: string;
  secretKey: string;
  budgetId: string;
  groupId: string;
  budgetName: string;
  seedDataDir: string;
}

// ---- Environment -----------------------------------------------------------

/**
 * Read required environment variables, throwing if missing.
 */
export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Set it directly or run setup-fixture-server.sh first.`,
    );
  }
  return val;
}
function assertLoopbackServerURL(serverURL: string): void {
  let parsed: URL;
  try {
    parsed = new URL(serverURL);
  } catch {
    throw new Error('ACTUAL_SERVER_URL must be a valid HTTP(S) loopback URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ACTUAL_SERVER_URL must use HTTP(S) on a loopback host.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
    throw new Error('ACTUAL_SERVER_URL must use a loopback host: localhost, 127.0.0.1, or ::1.');
  }
}

/**
 * Fail closed unless the environment identifies one exact disposable fixture.
 */
export function assertFixtureProvenance(): FixtureProvenance {
  if (process.env.BALANCEFRAME_ACTUAL_FIXTURE !== '1') {
    throw new Error(
      'BALANCEFRAME_ACTUAL_FIXTURE must be exactly "1" before using the Actual fixture.',
    );
  }

  const serverURL = requireEnv('ACTUAL_SERVER_URL');
  assertLoopbackServerURL(serverURL);

  const required = (key: string): string => {
    const value = requireEnv(key);
    if (value.trim().length === 0) {
      throw new Error(`Missing required fixture provenance: ${key}.`);
    }
    return value;
  };

  return {
    serverURL,
    secretKey: required('ACTUAL_SECRET_KEY'),
    budgetId: required('ACTUAL_BUDGET_ID'),
    groupId: required('ACTUAL_GROUP_ID'),
    budgetName: required('ACTUAL_BUDGET_NAME'),
    seedDataDir: required('ACTUAL_SEED_DATA_DIR'),
  };
}

/**
 * Build a guarded client configuration from exact fixture provenance.
 */
export function buildClientConfig(dataDir?: string): ClientConfig {
  const fixture = assertFixtureProvenance();
  return {
    serverURL: fixture.serverURL,
    password: fixture.secretKey,
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'bf-actual-test-')),
  };
}

// ---- Client Lifecycle -----------------------------------------------------

/**
 * Initialize the Actual API client and return the config used.
 * Caller MUST call `shutdown()` (or use `withActualClient`).
 */
export async function getActualClient(config?: Partial<ClientConfig>): Promise<ClientConfig> {
  const base = buildClientConfig();
  const merged: ClientConfig = {
    serverURL: config?.serverURL ?? base.serverURL,
    password: config?.password ?? base.password,
    dataDir: config?.dataDir ?? base.dataDir,
  };
  assertLoopbackServerURL(merged.serverURL);

  await init({
    serverURL: merged.serverURL,
    password: merged.password,
    dataDir: merged.dataDir,
  });

  return merged;
}

/**
 * Wrapper that initializes a client, runs `fn`, and always shuts down.
 */
export async function withActualClient<T>(
  fn: (..._args: [ClientConfig]) => Promise<T>,
  config?: Partial<ClientConfig>,
): Promise<T> {
  const cfg = await getActualClient(config);
  try {
    return await fn(cfg);
  } finally {
    await shutdown();
  }
}

// ---- Budget Lifecycle -----------------------------------------------------

/**
 * Create a disposable test budget, returning its id and group id.
 */
export async function createTestBudget(name?: string): Promise<SeededBudget> {
  const budgetName = name ?? `BalanceFrame-Test-${Date.now()}`;
  const result = await createBudget({
    name: budgetName,
    avoidUpload: false,
  });

  return {
    budgetId: result.id,
    groupId: result.groupId,
    budgetName,
  };
}

/**
 * Delete a budget and clean up its data directory.
 */
export async function cleanupBudget(
  budgetId: string,
  groupId: string,
  dataDir?: string,
): Promise<void> {
  try {
    await deleteBudget(groupId, budgetId);
  } catch {
    // Budget may already be gone; ignore.
  }

  if (dataDir && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Wrapper that creates a disposable budget, runs `fn`, and cleans up.
 */
export async function withTestBudget<T>(
  fn: (..._args: [SeededBudget]) => Promise<T>,
  name?: string,
): Promise<T> {
  const budget = await createTestBudget(name);
  try {
    return await fn(budget);
  } finally {
    await cleanupBudget(budget.budgetId, budget.groupId).catch(() => {});
  }
}

// ---- Fixture Data ---------------------------------------------------------

/**
 * Locate the fixture data JSON file.
 * Searches relative to the test directory and the monorepo root.
 */
function findFixtureFile(): string {
  const candidates = [
    // Relative to tests/actual-integration/
    '../../protocol/fixtures/representative.json',
    './representative.json',
    // Absolute fallback from env
    process.env.FIXTURE_DATA_PATH ?? '',
  ];

  for (const p of candidates) {
    if (!p) continue;
    try {
      // Resolve relative to the test directory using the module URL
      const dirUrl = new URL('.', import.meta.url);
      const dirPath = fileURLToPath(dirUrl);
      const resolved = join(dirPath, p);
      if (existsSync(resolved)) return resolved;
    } catch {
      // resolve failure — try next
    }
  }

  throw new Error(
    'Fixture data file not found. Run setup-fixture-server.sh first, ' +
      'or set FIXTURE_DATA_PATH environment variable.',
  );
}

/**
 * Read and parse the representative fixture data.
 */
export function loadFixtureData(): Record<string, unknown> {
  const filePath = findFixtureFile();
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Seed a selected, initialized budget with the canonical protocol fixture.
 *
 * The scenario-kit seeder owns all Actual entity mapping, checked money
 * conversion, split/import handling, and read-back. This helper preserves the
 * integration suite's existing optional fixture argument and sync behavior.
 */
export async function seedFixtureData(fixture?: Record<string, unknown>): Promise<void> {
  const ledger: ProtocolSnapshot = canonicalProtocolSnapshotSchema.parse(
    fixture ?? loadFixtureData(),
  );
  await populateActualBudget(ledger);
  await actualSync();
}

// ---- Sync Helpers ---------------------------------------------------------

/**
 * Download a budget (encrypted or unencrypted).
 */
export async function downloadBudgetWithOpts(
  groupId: string,
  budgetId: string,
  options?: { password?: string },
): Promise<void> {
  await downloadBudget(groupId, budgetId, options);
}

/**
 * Sync with the server.
 */
export async function syncWithServer(): Promise<void> {
  await actualSync();
}

// ---- Assertion Helpers ----------------------------------------------------

/**
 * Assert that an API call rejects with an error matching a predicate.
 */
export async function expectRejection(
  fn: () => Promise<unknown>,
  predicate?: (..._args: [Error]) => boolean | void,
): Promise<void> {
  let thrown = false;
  try {
    await fn();
  } catch (err: unknown) {
    thrown = true;
    if (predicate) {
      const errObj = err as Error;
      const result = predicate(errObj);
      // If predicate returns false explicitly, fail.
      if (result === false) {
        throw new Error(`Expected rejection matching predicate, but got: ${errObj.message}`);
      }
    }
  }
  if (!thrown) {
    throw new Error('Expected function to reject, but it resolved successfully.');
  }
}
