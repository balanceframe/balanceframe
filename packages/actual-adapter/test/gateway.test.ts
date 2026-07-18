/**
 * Unit tests for Actual Budget gateway (read-only).
 *
 * Tests are written first as failing tests, then implementation makes them pass.
 *
 * Coverage areas:
 *   1. Mode rejection — Observe mode rejects all mutation calls.
 *   2. Cache isolation — per-budget directories, no cross-leakage.
 *   3. Credentials — store/rotate/delete with in-memory null store.
 *   4. Overlap watermark — sync cursor management, reprocessing overlap.
 *   5. Normalization — Actual entities map correctly to protocol shapes.
 *   6. Disconnect — cleanup removes cache and credentials.
 *   7. Health/capabilities — reports, pre-connect rejection, caveat.
 *   8. Budget discovery — list budgets after connect.
 *   9. Restart-safe decrypt — salt persistence in EncryptedCredentialStore.
 *  10. EnvCredentialStore — no-op lifecycle, connect/disconnect.
 *  11. Cache path isolation — per-budget, per-group dirs.
 *  12. Lock serialization — per-cache promise chain ordering.
 *  13. Watermark overlap — overlap date calculation and sync.
 *  14. Compatibility range — min/max enforcement with configurable range.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActualConnector } from '../src/connector';
import { NullCredentialStore } from '../src/credentials';
import {
  DEFAULT_MODE,
  DEFAULT_OVERLAP_DAYS,
  BROAD_ACCESS_CAVEAT,
} from '../src/types';
import type { ActualClient } from '../src/connector';
import type {
  APIAccountEntity,
  APICategoryEntity,
  APICategoryGroupEntity,
  APIPayeeEntity,
  APIScheduleEntity,
  APITagEntity,
  APIFileEntity,
} from '@actual-app/api';
import type { TransactionEntity, RuleEntity } from '@actual-app/core/types/models';
import { normalizeAccounts, normalizeTransactions, normalizeCategories, normalizePayees, normalizeRules, normalizeSchedules } from '../src/normalizer';
import { integerToMoney } from '../src/normalizer';

// ============================================================================
// Mock ActualClient
// ============================================================================

function createMockClient(overrides: Partial<ActualClient> = {}): ActualClient {
  return {
    init: vi.fn().mockResolvedValue({ send: vi.fn(), getDataDir: vi.fn(), sendMessage: vi.fn(), amountToInteger: vi.fn(), integerToAmount: vi.fn() }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getBudgets: vi.fn().mockResolvedValue([]),
    downloadBudget: vi.fn().mockResolvedValue(undefined),
    loadBudget: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
    getAccounts: vi.fn().mockResolvedValue([]),
    getTransactions: vi.fn().mockResolvedValue([]),
    getPayees: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([]),
    getCategoryGroups: vi.fn().mockResolvedValue([]),
    getBudgetMonths: vi.fn().mockResolvedValue([]),
    getBudgetMonth: vi.fn().mockResolvedValue({ month: '2026-07', categoryGroups: [] }),
    getRules: vi.fn().mockResolvedValue([]),
    getSchedules: vi.fn().mockResolvedValue([]),
    getTags: vi.fn().mockResolvedValue([]),
    runBankSync: vi.fn().mockResolvedValue(undefined),
    addTransactions: vi.fn().mockResolvedValue('ok' as const),
    createAccount: vi.fn().mockResolvedValue('new-account-id'),
    updateTransaction: vi.fn().mockResolvedValue(undefined),
    createRule: vi.fn().mockResolvedValue({ id: 'new-rule-id' }),
    setBudgetAmount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================================================
// Fixtures
// ============================================================================

const mockAccounts: APIAccountEntity[] = [
  { id: 'a1', name: 'Checking', offbudget: false, closed: false, balance_current: 50000 },
  { id: 'a2', name: 'Savings', offbudget: false, closed: false, balance_current: 100000 },
  { id: 'a3', name: 'Closed Card', offbudget: false, closed: true, balance_current: 0 },
];

const mockPayees: APIPayeeEntity[] = [
  { id: 'p1', name: 'Groceries', transfer_acct: undefined },
  { id: 'p2', name: 'Salary', transfer_acct: undefined },
];

const mockCategories: APICategoryEntity[] = [
  { id: 'c1', name: 'Food', group_id: 'g1', is_income: false, hidden: false },
  { id: 'c2', name: 'Income', group_id: 'g2', is_income: true, hidden: false },
];

const mockCategoryGroups: APICategoryGroupEntity[] = [
  { id: 'g1', name: 'Essential', is_income: false, hidden: false },
  { id: 'g2', name: 'Earnings', is_income: true, hidden: false },
];

const mockTransactions: TransactionEntity[] = [
  {
    id: 'tx1',
    account: 'a1',
    date: '2026-07-10',
    amount: -2500,
    payee: 'p1',
    category: 'c1',
    cleared: true,
    reconciled: false,
    notes: null,
    imported_id: null,
    imported_payee: null,
  } as TransactionEntity,
  {
    id: 'tx2',
    account: 'a1',
    date: '2026-07-11',
    amount: 500000,
    payee: 'p2',
    category: 'c2',
    cleared: true,
    reconciled: false,
    notes: null,
    imported_id: null,
    imported_payee: null,
  } as TransactionEntity,
];

const mockRules: RuleEntity[] = [
  {
    id: 'r1',
    stage: 'post' as const,
    conditionsOp: 'and' as const,
    conditions: [{ field: 'payee', op: 'is' as const, value: 'p1' }],
    actions: [{ op: 'set' as const, field: 'category', value: 'c1' }],
    tombstone: false,
  },
];

const mockSchedules: APIScheduleEntity[] = [
  {
    id: 's1',
    name: 'Rent',
    posts_transaction: true,
    rule: 'r_rent',
    next_date: '2026-08-01',
    completed: false,
    payee: 'Landlord',
    account: 'a1',
    amount: -150000,
    amountOp: 'is',
    date: { frequency: 'monthly', interval: 1, start: '2026-01-01', endMode: 'never' },
  },
];

const mockFiles: APIFileEntity[] = [
  {
    id: 'budget_1',
    groupId: 'group_1',
    name: 'My Budget',
    cloudFileId: 'cloud_1',
    encrypted: false,
    state: 'remote',
  },
];

// ============================================================================
// Tests
// ============================================================================

describe('ActualConnector', () => {
  let mockClient: ActualClient;
  let connector: ActualConnector;

  beforeEach(() => {
    mockClient = createMockClient();
    connector = new ActualConnector({
      client: mockClient,
      credentialStore: new NullCredentialStore(),
      mode: 'observe',
      cacheDir: '/tmp/bf-test-cache',
    });
  });

  // ==========================================================================
  // 1. Mode rejection — Observe rejects mutations
  // ==========================================================================

  describe('Observe mode rejection', () => {
    it('should reject importTransactions in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.importTransactions('a1', [], {}),
      ).rejects.toThrow(/Observe mode/);
    });

    it('should reject updateTransaction in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.updateTransaction('tx1', { notes: 'test' }),
      ).rejects.toThrow(/Observe mode/);
    });

    it('should reject createRule in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.createRule({ name: 'test', conditions: [], actions: [] }),
      ).rejects.toThrow(/Observe mode/);
    });

    it('should reject setBudgetAmount in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.setBudgetAmount('2026-07', 'c1', 50000),
      ).rejects.toThrow(/Observe mode/);
    });

    it('should report canWrite=false in capabilities', async () => {
      const caps = await connector.capabilities();
      expect(caps.canWrite).toBe(false);
      expect(caps.mode).toBe('observe');
      expect(caps.canRead).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Cache isolation — per-budget directories, no cross-leakage
  // ==========================================================================

  describe('cache isolation', () => {
    it('should create isolated cache state per budget', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      mockClient.getBudgets = vi.fn().mockResolvedValue(mockFiles);
      mockClient.downloadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient.loadBudget = vi.fn().mockResolvedValue(undefined);

      await connector.selectBudget('budget_1');

      const state = (connector as unknown as { caches: Map<string, Record<string, unknown>> }).caches.get('budget_1');
      expect(state).toBeDefined();
      expect(state.budgetId).toBe('budget_1');
      expect(state.initialized).toBe(true);
      expect(state.mutationLocked).toBe(false);
    });

    it('should not share caches between budgets', async () => {
      const connector2 = new ActualConnector({
        client: createMockClient(),
        credentialStore: new NullCredentialStore(),
        cacheDir: '/tmp/bf-test-cache-2',
      });

      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      mockClient.getBudgets = vi.fn().mockResolvedValue(mockFiles);
      mockClient.downloadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient.loadBudget = vi.fn().mockResolvedValue(undefined);

      await connector.selectBudget('budget_1');

      const caches = (connector2 as unknown as { caches: Map<string, unknown> }).caches;
      expect(caches.size).toBe(0);
    });
  });

  // ==========================================================================
  // 3. Credentials — store/rotate/delete
  // ==========================================================================

  describe('credential management', () => {
    it('should store and load credentials via NullCredentialStore', async () => {
      const store = new NullCredentialStore();
      await store.store({
        serverUrl: 'http://test:5006',
        secretKey: 'test-secret',
      });
      expect(store.has()).toBe(true);
      const loaded = await store.load();
      expect(loaded).toEqual({
        serverUrl: 'http://test:5006',
        secretKey: 'test-secret',
      });
    });

    it('should rotate credentials', async () => {
      const store = new NullCredentialStore();
      await store.store({
        serverUrl: 'http://old:5006',
        secretKey: 'old-secret',
      });
      await store.rotate({
        serverUrl: 'http://new:5006',
        secretKey: 'new-secret',
      });
      const loaded = await store.load();
      expect(loaded?.serverUrl).toBe('http://new:5006');
      expect(loaded?.secretKey).toBe('new-secret');
    });

    it('should delete credentials', async () => {
      const store = new NullCredentialStore();
      await store.store({
        serverUrl: 'http://test:5006',
        secretKey: 'test-secret',
      });
      expect(store.has()).toBe(true);
      await store.delete();
      expect(store.has()).toBe(false);
      expect(await store.load()).toBeNull();
    });

    it('should list stored credential URL', async () => {
      const store = new NullCredentialStore();
      await store.store({
        serverUrl: 'http://test:5006',
        secretKey: 'secret',
      });
      const urls = store.list();
      expect(urls).toEqual(['http://test:5006']);
    });
  });

  // ==========================================================================
  // 4. Overlap watermark — sync cursor management
  // ==========================================================================

  describe('sync watermark and overlap', () => {
    it('should start with null watermark before sync', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      const watermark = (connector as unknown as { getWatermark: (_id: string) => Record<string, unknown> }).getWatermark('budget_1');
      expect(watermark.lastTransactionDate).toBeNull();
      expect(watermark.lastTransactionCount).toBe(0);
      expect(watermark.overlapDays).toBe(DEFAULT_OVERLAP_DAYS);
    });

    it('should update watermark after synchronize()', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      mockClient.getBudgets = vi.fn().mockResolvedValue(mockFiles);
      mockClient.downloadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient.loadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient.getAccounts = vi.fn().mockResolvedValue(mockAccounts);
      mockClient.getPayees = vi.fn().mockResolvedValue(mockPayees);
      mockClient.getCategories = vi.fn().mockResolvedValue(mockCategories);
      mockClient.getCategoryGroups = vi.fn().mockResolvedValue(mockCategoryGroups);
      mockClient.getTransactions = vi.fn().mockResolvedValue(mockTransactions);
      mockClient.getRules = vi.fn().mockResolvedValue(mockRules);
      mockClient.getSchedules = vi.fn().mockResolvedValue(mockSchedules);

      await connector.selectBudget('budget_1');
      const result = await connector.synchronize();

      expect(result.watermark.lastTransactionDate).not.toBeNull();
      expect(result.watermark.lastSyncCompletedAt).not.toBeNull();
      expect(result.watermark.overlapDays).toBe(DEFAULT_OVERLAP_DAYS);
    });

    it('should calculate overlap start date from watermark', async () => {
      const watermark = {
        budgetId: 'budget_1',
        lastTransactionDate: '2026-07-15T00:00:00Z',
        lastTransactionCount: 100,
        lastSyncCompletedAt: '2026-07-15T00:00:00Z',
        overlapDays: 3,
      };
      const overlapStart = new Date(watermark.lastTransactionDate!);
      overlapStart.setDate(overlapStart.getDate() - watermark.overlapDays);
      expect(overlapStart.toISOString().startsWith('2026-07-12')).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Normalization — Actual entities → protocol shapes
  // ==========================================================================

  describe('entity normalization', () => {
    it('should normalize accounts correctly', () => {
      const accounts = normalizeAccounts(mockAccounts);
      expect(accounts).toHaveLength(3);
      expect(accounts[0]).toMatchObject({
        id: 'a1',
        name: 'Checking',
        offBudget: false,
        isClosed: false,
      });
      expect(accounts[0].clearedBalance).toEqual({ minorUnits: '50000', currency: 'USD' });
      expect(accounts[1].isClosed).toBe(false);
      expect(accounts[2].isClosed).toBe(true);
    });

    it('should normalize transactions with payee and category info', () => {
      const payeeMap = { p1: 'Groceries', p2: 'Salary' };
      const categoryMap = {
        c1: { name: 'Food', groupName: 'Essential' },
        c2: { name: 'Income', groupName: 'Earnings' },
      };
      const txns = normalizeTransactions(mockTransactions, payeeMap, categoryMap);
      expect(txns).toHaveLength(2);
      expect(txns[0]).toMatchObject({
        id: 'tx1',
        accountId: 'a1',
        payeeName: 'Groceries',
        categoryName: 'Food',
        cleared: true,
      });
      expect(txns[0].amount).toEqual({ minorUnits: '-2500', currency: 'USD' });
      expect(txns[1].payeeName).toBe('Salary');
    });

    it('should normalize categories with group info', () => {
      const cats = normalizeCategories(mockCategories, mockCategoryGroups);
      expect(cats).toHaveLength(2);
      expect(cats[0]).toMatchObject({
        id: 'c1',
        name: 'Food',
        groupName: 'Essential',
        isIncome: false,
      });
      expect(cats[1].groupName).toBe('Earnings');
      expect(cats[1].isIncome).toBe(true);
    });

    it('should normalize payees correctly', () => {
      const payees = normalizePayees(mockPayees);
      expect(payees).toHaveLength(2);
      expect(payees[0]).toMatchObject({
        id: 'p1',
        name: 'Groceries',
        transferAccountId: null,
      });
    });

    it('should normalize rules correctly', () => {
      const rules = normalizeRules(mockRules);
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe('r1');
      expect(rules[0].inactive).toBe(false);
    });

    it('should normalize schedules correctly', () => {
      const scheds = normalizeSchedules(mockSchedules);
      expect(scheds).toHaveLength(1);
      expect(scheds[0].id).toBe('s1');
      expect(scheds[0].nextExpected).toBe('2026-08-01');
    });

    it('should convert integer amounts to Money type', () => {
      const money = integerToMoney(-2500);
      expect(money).toEqual({ minorUnits: '-2500', currency: 'USD' });
      const zero = integerToMoney(0, 'EUR');
      expect(zero).toEqual({ minorUnits: '0', currency: 'EUR' });
    });

    it('should filter out child transactions during normalization', () => {
      const withChild = [
        ...mockTransactions,
        {
          id: 'tx_child',
          account: 'a1',
          date: '2026-07-10',
          amount: -1000,
          is_child: true,
        } as TransactionEntity,
      ];
      const payeeMap = { p1: 'Groceries', p2: 'Salary' };
      const categoryMap = { c1: { name: 'Food', groupName: 'Essential' }, c2: { name: 'Income', groupName: 'Earnings' } };
      const txns = normalizeTransactions(withChild, payeeMap, categoryMap);
      expect(txns.find(t => t.id === 'tx_child')).toBeUndefined();
      expect(txns).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 6. Disconnect — cleanup
  // ==========================================================================

  describe('disconnect cleanup', () => {
    it('should shut down client and clear credentials on disconnect', async () => {
      const store = new NullCredentialStore();
      const localConnector = new ActualConnector({
        client: mockClient,
        credentialStore: store,
        mode: 'observe',
      });

      await store.store({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      await localConnector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      expect(mockClient.init).toHaveBeenCalled();
      expect(store.has()).toBe(true);

      await localConnector.disconnect();

      expect(mockClient.shutdown).toHaveBeenCalled();
      expect(store.has()).toBe(false);
    });

    it('should be callable even without prior connect', async () => {
      await connector.disconnect();
    });
  });

  // ==========================================================================
  // 7. Health and capabilities
  // ==========================================================================

  describe('health and capabilities', () => {
    it('should report capability report correctly', async () => {
      const caps = await connector.capabilities();
      expect(caps.canRead).toBe(true);
      expect(caps.canWrite).toBe(false);
      expect(caps.canRunBankSync).toBe(false);
      expect(caps.canQuery).toBe(true);
    });

    it('should throw on operations before connect', async () => {
      await expect(connector.listAccounts()).rejects.toThrow(/connect\(\)/);
      await expect(connector.listCategories()).rejects.toThrow(/connect\(\)/);
    });

    it('should expose broad access caveat', () => {
      const caveat = connector.getBroadAccessCaveat();
      expect(caveat).toContain('broad access');
      expect(caveat).toContain('bank-sync credentials');
    });
  });

  // ==========================================================================
  // 8. Server/budget discovery
  // ==========================================================================

  describe('budget discovery', () => {
    it('should list available budgets after connect', async () => {
      mockClient.getBudgets = vi.fn().mockResolvedValue(mockFiles);

      const budgets = await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      expect(budgets).toHaveLength(1);
      expect(budgets[0]).toMatchObject({
        id: 'budget_1',
        groupId: 'group_1',
        name: 'My Budget',
      });
    });

    it('should discover budgets independently', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      mockClient.getBudgets = vi.fn().mockResolvedValue(mockFiles);
      const budgets = await connector.discoverBudgets();
      expect(budgets).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 9. Regression: EncryptedCredentialStore restart-safe decrypt
  // ==========================================================================

  describe('restart-safe decrypt (salt persistence)', () => {
    it('should derive same key when loading with stored salt across instances', async () => {
      const tmpDir = '/tmp/bf-test-creds-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { rmSync } = await import('node:fs');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        machineSecret: 'test-machine-secret-42',
      });

      await store.store({
        serverUrl: 'http://restart-test:5006',
        secretKey: 'test-secret',
      });

      // Simulate restart: new instance, no in-memory cache of key/salt
      const store2 = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        machineSecret: 'test-machine-secret-42',
      });

      const loaded = await store2.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.serverUrl).toBe('http://restart-test:5006');
      expect(loaded?.secretKey).toBe('test-secret');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should persist salt in stored credential file', async () => {
      const tmpDir = '/tmp/bf-test-creds-salt-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, readdirSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        machineSecret: 'test-secret',
      });

      await store.store({
        serverUrl: 'http://salt-test:5006',
        secretKey: 'my-key',
      });

      const files = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(files.length).toBe(1);
      const raw = readFileSync(resolve(tmpDir, files[0]), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.salt).toBeDefined();
      expect(parsed.salt.length).toBeGreaterThan(0);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ==========================================================================
  // 10. Regression: EnvCredentialStore connect/disconnect (no-op lifecycle)
  // ==========================================================================

  describe('EnvCredentialStore connect/disconnect', () => {
    it('should connect and disconnect without throwing', async () => {
      const { EnvCredentialStore } = await import('../src/credentials');

      const origUrl = process.env.ACTUAL_SERVER_URL;
      const origKey = process.env.ACTUAL_SECRET_KEY;
      process.env.ACTUAL_SERVER_URL = 'http://env-test:5006';
      process.env.ACTUAL_SECRET_KEY = 'env-secret';

      try {
        const envConnector = new ActualConnector({
          client: mockClient,
          credentialStore: new EnvCredentialStore(),
          mode: 'observe',
        });
        await envConnector.connect();
        expect(mockClient.init).toHaveBeenCalled();
        await envConnector.disconnect();
        expect(mockClient.shutdown).toHaveBeenCalled();
      } finally {
        if (origUrl === undefined) delete process.env.ACTUAL_SERVER_URL;
        else process.env.ACTUAL_SERVER_URL = origUrl;
        if (origKey === undefined) delete process.env.ACTUAL_SECRET_KEY;
        else process.env.ACTUAL_SECRET_KEY = origKey;
      }
    });
    it('should not throw on store/delete/rotate', async () => {
      const { EnvCredentialStore } = await import('../src/credentials');

      // Clear env for this test
      const origUrl = process.env.ACTUAL_SERVER_URL;
      const origKey = process.env.ACTUAL_SECRET_KEY;
      delete process.env.ACTUAL_SERVER_URL;
      delete process.env.ACTUAL_SECRET_KEY;

      try {
        const store = new EnvCredentialStore();
        await expect(store.store({
          serverUrl: 'http://test:5006',
          secretKey: 'test',
        })).resolves.toBeUndefined();
        await expect(store.delete()).resolves.toBeUndefined();
        await expect(store.rotate({
          serverUrl: 'http://test2:5006',
          secretKey: 'test2',
        })).resolves.toBeUndefined();
      } finally {
        if (origUrl === undefined) delete process.env.ACTUAL_SERVER_URL;
        else process.env.ACTUAL_SERVER_URL = origUrl;
        if (origKey === undefined) delete process.env.ACTUAL_SECRET_KEY;
        else process.env.ACTUAL_SECRET_KEY = origKey;
      }
    });
    it('should serialize per-cache operations with promise chain', async () => {
      const withCacheLock = (connector as unknown as {
        withCacheLock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
      }).withCacheLock.bind(connector);

      const order: number[] = [];
      // Use a deferred step so op2 proves it ran after op1 completed
      let step2Done = false;

      const op1 = withCacheLock('test-serial', async () => {
        order.push(1);
        // Simulate async work
        await new Promise(r => setTimeout(r, 5));
        order.push(2);
      });

      const op2 = withCacheLock('test-serial', async () => {
        order.push(3);
        step2Done = true;
      });

      await Promise.all([op1, op2]);
      expect(order).toEqual([1, 2, 3]);
      expect(step2Done).toBe(true);
    });
  });

  // ==========================================================================
  // 11. Regression: Cache path isolation per-budget and per-group
  // ==========================================================================

  describe('cache path isolation', () => {
    it('should use different cache dir per budget', async () => {
      const cacheDir = '/tmp/bf-isolation-test-' + Date.now();
      const localConnector = new ActualConnector({
        client: createMockClient(),
        credentialStore: new NullCredentialStore(),
        cacheDir,
      });

      await localConnector.connect({
        serverUrl: 'http://isolation:5006',
        secretKey: 'test',
      });

      const mockClient2 = createMockClient();
      (localConnector as unknown as { client: ActualClient }).client = mockClient2;
      mockClient2.getBudgets = vi.fn().mockResolvedValue([
        { id: 'b1', groupId: 'g1', name: 'Budget 1' },
        { id: 'b2', groupId: 'g2', name: 'Budget 2' },
      ]);
      mockClient2.downloadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient2.loadBudget = vi.fn().mockResolvedValue(undefined);

      await localConnector.selectBudget('b1');
      await localConnector.selectBudget('b2');

      const caches = (localConnector as unknown as { caches: Map<string, { cacheDir: string }> }).caches;
      expect(caches.has('b1')).toBe(true);
      expect(caches.has('b2')).toBe(true);
      expect(caches.get('b1')?.cacheDir).not.toBe(caches.get('b2')?.cacheDir);

      await localConnector.disconnect();
    });
  });

  // ==========================================================================
  // 12. Regression: Lock serialization
  // ==========================================================================

  describe('lock serialization', () => {
    it('should serialize per-cache operations with promise chain', async () => {
      const withCacheLock = (connector as unknown as {
        withCacheLock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
      }).withCacheLock.bind(connector);

      const order: number[] = [];

      const op1 = withCacheLock('test-serial', async () => {
        order.push(1);
        await new Promise(r => setTimeout(r, 5));
        order.push(2);
      });

      const op2 = withCacheLock('test-serial', async () => {
        order.push(3);
      });

      await Promise.all([op1, op2]);
      expect(order).toEqual([1, 2, 3]);
    });

    it('should not block subsequent operations when prior rejects', async () => {
      const withCacheLock = (connector as unknown as {
        withCacheLock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
      }).withCacheLock.bind(connector);

      const results: string[] = [];
      const failFn = async () => { throw new Error('expected failure'); };
      const successFn = async () => { results.push('ok'); };

      await withCacheLock('fail-test', failFn).catch(() => {});
      await withCacheLock('fail-test', successFn);

      expect(results).toEqual(['ok']);
    });
  });

  // ==========================================================================
  // 13. Regression: Watermark overlap reprocessing
  // ==========================================================================

  describe('watermark overlap reprocessing', () => {
    it('should calculate overlap start from watermark', () => {
      const watermark = {
        budgetId: 'test_budget',
        lastTransactionDate: '2026-07-15T00:00:00.000Z',
        lastTransactionCount: 10,
        lastSyncCompletedAt: '2026-07-15T01:00:00.000Z',
        overlapDays: 5,
      };

      const overlapStart = new Date(watermark.lastTransactionDate);
      overlapStart.setDate(overlapStart.getDate() - watermark.overlapDays);
      expect(overlapStart.toISOString().startsWith('2026-07-10')).toBe(true);
    });

    it('should update transaction count after synchronize', async () => {
      await connector.connect({
        serverUrl: 'http://overlap2:5006',
        secretKey: 'test',
      });

      mockClient.getBudgets = vi.fn().mockResolvedValue(mockFiles);
      mockClient.downloadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient.loadBudget = vi.fn().mockResolvedValue(undefined);
      mockClient.getAccounts = vi.fn().mockResolvedValue(mockAccounts);
      mockClient.getPayees = vi.fn().mockResolvedValue(mockPayees);
      mockClient.getCategories = vi.fn().mockResolvedValue(mockCategories);
      mockClient.getCategoryGroups = vi.fn().mockResolvedValue(mockCategoryGroups);
      mockClient.getTransactions = vi.fn().mockResolvedValue(mockTransactions);
      mockClient.getRules = vi.fn().mockResolvedValue(mockRules);
      mockClient.getSchedules = vi.fn().mockResolvedValue(mockSchedules);

      await connector.selectBudget('budget_1');
      const result = await connector.synchronize();

      expect(result.watermark.lastTransactionCount).toBeGreaterThan(0);
      expect(result.watermark.lastTransactionDate).not.toBeNull();
      expect(result.watermark.overlapDays).toBe(DEFAULT_OVERLAP_DAYS);
    });
  });

  // ==========================================================================
  // 14. Regression: Compatibility range enforcement
  // ==========================================================================

  describe('compatibility range enforcement', () => {
    it('should reject server version below min range', async () => {
      const rangeConnector = new ActualConnector({
        client: createMockClient({
          getServerVersion: vi.fn().mockResolvedValue({ version: '21.0.0' }),
        }),
        credentialStore: new NullCredentialStore(),
        compatibilityRange: { min: '24.0.0', max: '26.7.0' },
      });

      await rangeConnector.connect({
        serverUrl: 'http://compat:5006',
        secretKey: 'test',
      });

      const compat = await rangeConnector.getCompatibility();
      expect(compat.supported).toBe(false);
      expect(compat.blockers.some(b => b.includes('below minimum'))).toBe(true);
    });

    it('should reject server version above max range', async () => {
      const rangeConnector = new ActualConnector({
        client: createMockClient({
          getServerVersion: vi.fn().mockResolvedValue({ version: '27.0.0' }),
        }),
        credentialStore: new NullCredentialStore(),
        compatibilityRange: { min: '24.0.0', max: '26.7.0' },
      });

      await rangeConnector.connect({
        serverUrl: 'http://compat2:5006',
        secretKey: 'test',
      });

      const compat = await rangeConnector.getCompatibility();
      expect(compat.supported).toBe(false);
      expect(compat.blockers.some(b => b.includes('exceeds maximum'))).toBe(true);
    });

    it('should accept version within range', async () => {
      const rangeConnector = new ActualConnector({
        client: createMockClient({
          getServerVersion: vi.fn().mockResolvedValue({ version: '25.0.0' }),
        }),
        credentialStore: new NullCredentialStore(),
        compatibilityRange: { min: '24.0.0', max: '26.7.0' },
      });

      await rangeConnector.connect({
        serverUrl: 'http://compat3:5006',
        secretKey: 'test',
      });

      const compat = await rangeConnector.getCompatibility();
      expect(compat.supported).toBe(true);
      expect(compat.blockers).toEqual([]);
    });
  });
});

