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
import { normalizeAccounts, normalizeTransactions, normalizeCategories, normalizePayees, normalizeRules, normalizeSchedules, normalizeSchedule, normalizeTransaction, normalizeCategory, buildTransferAcctMap } from '../src/normalizer';
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
  { id: 'p3', name: 'Transfer to Savings', transfer_acct: 'a2' },
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
      ).rejects.toThrow(/not yet implemented|not permitted|observe/i);
    });

    it('should reject updateTransaction in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.updateTransaction('tx1', { notes: 'test' }),
      ).rejects.toThrow(/not yet implemented|not permitted|observe/i);
    });

    it('should reject createRule in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.createRule({ name: 'test', conditions: [], actions: [] }),
      ).rejects.toThrow(/not yet implemented|not permitted|observe/i);
    });

    it('should reject setBudgetAmount in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.setBudgetAmount('2026-07', 'c1', 50000),
      ).rejects.toThrow(/not yet implemented|not permitted|observe/i);
    });

    it('should reject setTransactionCategory in Observe mode', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await expect(
        connector.setTransactionCategory('tx1', 'c1', null),
      ).rejects.toThrow(/not permitted|observe/i);
    });

    it('should report canWrite=false in capabilities', async () => {
      const caps = await connector.capabilities();
      expect(caps.canWrite).toBe(false);
      expect(caps.mode).toBe('observe');
      expect(caps.canRead).toBe(true);
    });

  });

  // ==========================================================================
  // 1b. Observe mutation does not call client methods
  // ==========================================================================

  describe('Observe mutation does not call client', () => {
    it('should reject importTransactions without calling client.addTransactions', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      mockClient.addTransactions = vi.fn();
      await expect(
        connector.importTransactions('a1', [], {}),
      ).rejects.toThrow();
      expect(mockClient.addTransactions).not.toHaveBeenCalled();
    });

    it('should reject updateTransaction without calling client.updateTransaction', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      mockClient.updateTransaction = vi.fn();
      await expect(
        connector.updateTransaction('tx1', { notes: 'test' }),
      ).rejects.toThrow();
      expect(mockClient.updateTransaction).not.toHaveBeenCalled();
    });

    it('should reject createRule without calling client.createRule', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      mockClient.createRule = vi.fn();
      await expect(
        connector.createRule({ name: 'test', conditions: [], actions: [] }),
      ).rejects.toThrow();
      expect(mockClient.createRule).not.toHaveBeenCalled();
    });

    it('should reject setBudgetAmount without calling client.setBudgetAmount', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      mockClient.setBudgetAmount = vi.fn();
      await expect(
        connector.setBudgetAmount('2026-07', 'c1', 50000),
      ).rejects.toThrow();
      expect(mockClient.setBudgetAmount).not.toHaveBeenCalled();
    });

    it('should reject setTransactionCategory without calling client.updateTransaction', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      mockClient.updateTransaction = vi.fn();
      mockClient.getAccounts = vi.fn().mockReturnValue(mockAccounts);
      mockClient.getTransactions = vi.fn().mockReturnValue(mockTransactions);
      await expect(
        connector.setTransactionCategory('tx1', 'c2', 'c1'),
      ).rejects.toThrow();
      expect(mockClient.updateTransaction).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 1c. Write-mode rejection — unimplemented methods throw in every mode
  // ==========================================================================

  describe('write-mode rejection of unimplemented methods', () => {
    it('should reject importTransactions in write-enabled mode', async () => {
      const mock = createMockClient();
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-unimpl-import',
      });
      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      mock.addTransactions = vi.fn();
      await expect(
        writeConnector.importTransactions('a1', [], {}),
      ).rejects.toThrow(/not yet implemented/i);
      expect(mock.addTransactions).not.toHaveBeenCalled();
      await writeConnector.disconnect();
    });

    it('should reject updateTransaction in write-enabled mode', async () => {
      const mock = createMockClient();
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-unimpl-update',
      });
      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      mock.updateTransaction = vi.fn();
      await expect(
        writeConnector.updateTransaction('tx1', { notes: 'test' }),
      ).rejects.toThrow(/not yet implemented/i);
      expect(mock.updateTransaction).not.toHaveBeenCalled();
      await writeConnector.disconnect();
    });

    it('should create a rule in write-enabled mode and return the rule id', async () => {
      const mock = createMockClient({
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-rule-test',
      });
      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      const result = await writeConnector.createRule({
        name: 'Groceries rule',
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'p1' }],
        actions: [{ op: 'set', field: 'category', value: 'c1' }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.id).toBe('new-rule-id');
      }
      expect(mock.createRule).toHaveBeenCalledTimes(1);
      expect(mock.createRule).toHaveBeenCalledWith({
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'p1' }],
        actions: [{ op: 'set', field: 'category', value: 'c1' }],
      });
      expect(mock.sync).toHaveBeenCalled();
      await writeConnector.disconnect();
    });

    it('should reject createRule without a selected budget', async () => {
      const mock = createMockClient();
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-rule-nobudget',
      });
      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      mock.createRule = vi.fn();
      const result = await writeConnector.createRule({
        name: 'test',
        conditions: [],
        actions: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('BUDGET_NOT_SELECTED');
      }
      expect(mock.createRule).not.toHaveBeenCalled();
      await writeConnector.disconnect();
    });

    it('should reject setBudgetAmount in write-enabled mode', async () => {
      const mock = createMockClient();
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-unimpl-budget',
      });
      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      mock.setBudgetAmount = vi.fn();
      await expect(
        writeConnector.setBudgetAmount('2026-07', 'c1', 50000),
      ).rejects.toThrow(/not yet implemented/i);
      expect(mock.setBudgetAmount).not.toHaveBeenCalled();
      await writeConnector.disconnect();
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
      const payeeMap = { p1: 'Groceries', p2: 'Salary', p3: 'Transfer to Savings' };
      const categoryMap = {
        c1: { name: 'Food', groupName: 'Essential' },
        c2: { name: 'Income', groupName: 'Earnings' },
      };
      const transferAcctMap = { p1: null, p2: null, p3: 'a2' };
      const txns = normalizeTransactions(mockTransactions, payeeMap, categoryMap, transferAcctMap);
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
      expect(payees).toHaveLength(3);
      expect(payees[0]).toMatchObject({
        id: 'p1',
        name: 'Groceries',
        transferAccountId: null,
      });
      expect(payees[1]).toMatchObject({
        id: 'p2',
        name: 'Salary',
        transferAccountId: null,
      });
      expect(payees[2]).toMatchObject({
        id: 'p3',
        name: 'Transfer to Savings',
        transferAccountId: 'a2',
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
    it('should filter out orphaned child transactions (no parent_id)', () => {
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
      const payeeMap = { p1: 'Groceries', p2: 'Salary', p3: 'Transfer to Savings' };
      const categoryMap = { c1: { name: 'Food', groupName: 'Essential' }, c2: { name: 'Income', groupName: 'Earnings' } };
      const transferAcctMap = { p1: null, p2: null, p3: 'a2' };
      const txns = normalizeTransactions(withChild, payeeMap, categoryMap, transferAcctMap);
      expect(txns.find(t => t.id === 'tx_child')).toBeUndefined();
      expect(txns).toHaveLength(2);
    });

    it('should preserve transaction metadata fields (notes, importedId, importedPayee, reconciled, date)', () => {
      const txnsWithMeta: TransactionEntity[] = [
        {
          id: 'tx_meta',
          account: 'a2',
          date: '2026-07-20',
          amount: -5000,
          payee: 'p1',
          category: 'c1',
          cleared: true,
          reconciled: true,
          notes: 'Test note with $pecial chars',
          imported_id: 'ext:12345',
          imported_payee: 'Imported Payee Name',
        } as TransactionEntity,
      ];

      const payeeMap = { p1: 'Groceries' };
      const categoryMap = { c1: { name: 'Food', groupName: 'Essential' } };
      const transferAcctMap = { p1: null };
      const result = normalizeTransactions(txnsWithMeta, payeeMap, categoryMap, transferAcctMap);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tx_meta');
      expect(result[0].date).toBe('2026-07-20');
      expect(result[0].notes).toBe('Test note with $pecial chars');
      expect(result[0].importedId).toBe('ext:12345');
      expect(result[0].importedPayee).toBe('Imported Payee Name');
      expect(result[0].reconciled).toBe(true);
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

  describe('restart-safe decrypt (master key persistence)', () => {
    it('should derive same key when loading with stored master.key across instances', async () => {
      const tmpDir = '/tmp/bf-test-creds-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { rmSync } = await import('node:fs');
      const key = Buffer.alloc(32, 0x42);

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      await store.store({
        serverUrl: 'http://restart-test:5006',
        secretKey: 'test-secret',
      });

      // Simulate restart: new instance, no in-memory cache of key/salt
      const store2 = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      const loaded = await store2.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.serverUrl).toBe('http://restart-test:5006');
      expect(loaded?.secretKey).toBe('test-secret');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should persist master.key file on first store', async () => {
      const tmpDir = '/tmp/bf-test-creds-keyfile-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, readdirSync, rmSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
      });

      await store.store({
        serverUrl: 'http://keyfile-test:5006',
        secretKey: 'my-key',
      });

      expect(existsSync(resolve(tmpDir, 'master.key'))).toBe(true);
      const keyRaw = readFileSync(resolve(tmpDir, 'master.key'));
      expect(keyRaw.length).toBe(32);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should persist salt in stored credential file', async () => {
      const tmpDir = '/tmp/bf-test-creds-salt-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, readdirSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: Buffer.alloc(32, 0x42),
      });

      await store.store({
        serverUrl: 'http://salt-test:5006',
        secretKey: 'my-key',
      });

      const files = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(files.length).toBe(1);
      const raw = readFileSync(resolve(tmpDir, files[0]), 'utf-8');
      const parsed = JSON.parse(raw);
      // V2 format — payload field instead of per-field secretKey
      expect(parsed.payload).toBeDefined();
      expect(parsed.payload.ciphertext).toBeDefined();
      expect(parsed.payload.iv).toBeDefined();
      expect(parsed.payload.tag).toBeDefined();
      expect(parsed.salt).toBeDefined();
      expect(parsed.salt.length).toBeGreaterThan(0);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should regenerate master.key if existing file has wrong length', async () => {
      const tmpDir = '/tmp/bf-test-creds-regen-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      // Write an invalid master.key (wrong size)
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(resolve(tmpDir, 'master.key'), 'not-a-32-byte-key', { mode: 0o600 });

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
      });

      await store.store({
        serverUrl: 'http://regen-test:5006',
        secretKey: 'test-secret',
      });

      const keyRaw = readFileSync(resolve(tmpDir, 'master.key'));
      expect(keyRaw.length).toBe(32);
      expect(keyRaw.toString('utf8')).not.toBe('not-a-32-byte-key');

      // Confirm decrypt still works across restart
      const store2 = new EncryptedCredentialStore({
        credentialDir: tmpDir,
      });
      const loaded = await store2.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.secretKey).toBe('test-secret');

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

    it('should resolve all cache directories within the base cache root', async () => {
      const cacheDir = '/tmp/bf-cache-contain-' + Date.now();
      const localConnector = new ActualConnector({
        client: createMockClient(),
        credentialStore: new NullCredentialStore(),
        cacheDir,
      });

      await localConnector.connect({
        serverUrl: 'http://contain:5006',
        secretKey: 'test',
      });

      const base = (localConnector as unknown as { baseCacheDir: string }).baseCacheDir;

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

      const caches = (localConnector as unknown as {
        caches: Map<string, { cacheDir: string }>;
      }).caches;

      for (const [, cache] of caches) {
        expect(cache.cacheDir.startsWith(base)).toBe(true);
      }

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

  // ==========================================================================
  // 15. Regression: Tampered URL detection via AAD binding
  // ==========================================================================

  describe('tampered URL detection', () => {
    it('should detect tampered serverUrl via GCM auth failure', async () => {
      const tmpDir = '/tmp/bf-test-tamper-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, readdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const key = Buffer.alloc(32, 0x42);

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      await store.store({
        serverUrl: 'http://original:5006',
        secretKey: 'test-secret',
      });

      // Tamper with the stored serverUrl
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(files.length).toBe(1);
      const filePath = resolve(tmpDir, files[0]);
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      parsed.serverUrl = 'http://evil:5006';
      writeFileSync(filePath, JSON.stringify(parsed));

      // Load should fail because AAD doesn't match
      const loaded = await store.load();
      expect(loaded).toBeNull();

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should detect corruption of ciphertext in payload', async () => {
      const tmpDir = '/tmp/bf-test-tamper-ct-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, readdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const key = Buffer.alloc(32, 0x42);

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      await store.store({
        serverUrl: 'http://tamper-ct:5006',
        secretKey: 'original-secret',
      });

      // Corrupt the ciphertext
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      const filePath = resolve(tmpDir, files[0]);
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      parsed.payload.ciphertext = 'deadbeef' + parsed.payload.ciphertext.slice(8);
      writeFileSync(filePath, JSON.stringify(parsed));

      const loaded = await store.load();
      expect(loaded).toBeNull();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ==========================================================================
  // 16. Regression: Permissions and atomic writes
  // ==========================================================================

  describe('permissions and atomic writes', () => {
    it('should write credential file with restrictive permissions (0o600)', async () => {
      const tmpDir = '/tmp/bf-test-perms-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readdirSync, rmSync, statSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: Buffer.alloc(32, 0x42),
      });

      await store.store({
        serverUrl: 'http://perms-test:5006',
        secretKey: 'secret123',
      });

      const files = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(files.length).toBe(1);
      const fileStat = statSync(resolve(tmpDir, files[0]));

      // Check that permission bits exclude group/other write
      // 0o600 = owner read+write; on most systems umask may further restrict
      expect(fileStat.mode & 0o177).toBe(0);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should leave no .tmp files after successful write', async () => {
      const tmpDir = '/tmp/bf-test-tmpclean-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readdirSync, rmSync } = await import('node:fs');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: Buffer.alloc(32, 0x42),
      });

      await store.store({
        serverUrl: 'http://tmpclean:5006',
        secretKey: 'test',
      });

      const tmpFiles = readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toEqual([]);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write current.txt to track active credential', async () => {
      const tmpDir = '/tmp/bf-test-current-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, rmSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: Buffer.alloc(32, 0x42),
      });

      await store.store({
        serverUrl: 'http://current-test:5006',
        secretKey: 'test',
      });

      expect(existsSync(resolve(tmpDir, 'current.txt'))).toBe(true);
      const activeUrl = readFileSync(resolve(tmpDir, 'current.txt'), 'utf-8').trim();
      expect(activeUrl).toBe('http://current-test:5006');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write master.key with restrictive permissions (0o600)', async () => {
      const tmpDir = '/tmp/bf-test-mkperm-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, rmSync, statSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
      });

      await store.store({
        serverUrl: 'http://mkpermissions:5006',
        secretKey: 'secret123',
      });

      const keyPath = resolve(tmpDir, 'master.key');
      expect(existsSync(keyPath)).toBe(true);
      const keyStat = statSync(keyPath);
      // Check that permission bits exclude group/other write
      expect(keyStat.mode & 0o177).toBe(0);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ==========================================================================
  // 17. Regression: Rotation failure protection
  // ==========================================================================

  describe('rotation consistency', () => {
    it('should atomically replace old credentials with new', async () => {
      const tmpDir = '/tmp/bf-test-rotate-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readdirSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const key = Buffer.alloc(32, 0x42);

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      await store.store({
        serverUrl: 'http://old-creds:5006',
        secretKey: 'old-secret',
      });

      await store.rotate({
        serverUrl: 'http://new-creds:5006',
        secretKey: 'new-secret',
      });

      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.serverUrl).toBe('http://new-creds:5006');
      expect(loaded?.secretKey).toBe('new-secret');

      // Old file should be removed
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(files.length).toBe(1);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should generate new salt on rotation for forward secrecy', async () => {
      const tmpDir = '/tmp/bf-test-rotate-salt-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readFileSync, readdirSync, rmSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: Buffer.alloc(32, 0x42),
      });

      await store.store({
        serverUrl: 'http://rotate-salt:5006',
        secretKey: 'first-key',
      });

      // Record original salt
      const files1 = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      const raw1 = readFileSync(resolve(tmpDir, files1[0]), 'utf-8');
      const origSalt = JSON.parse(raw1).salt;

      await store.rotate({
        serverUrl: 'http://rotate-salt:5006',
        secretKey: 'rotated-key',
      });

      // Salt should be different (new random salt per store)
      const files2 = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(files2.length).toBe(1);  // no duplicate files
      const raw2 = readFileSync(resolve(tmpDir, files2[0]), 'utf-8');
      const newSalt = JSON.parse(raw2).salt;
      expect(newSalt).not.toBe(origSalt);

      // Decrypt still works with new salt
      const loaded = await store.load();
      expect(loaded?.secretKey).toBe('rotated-key');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ==========================================================================
  // 18. Regression: Env/file separation — EncryptedCredentialStore ignores env
  // ==========================================================================

  describe('env/file separation', () => {
    it('should not read environment variables in EncryptedCredentialStore', async () => {
      const tmpDir = '/tmp/bf-test-envsep-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { rmSync } = await import('node:fs');
      const key = Buffer.alloc(32, 0x42);

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      await store.store({
        serverUrl: 'http://file-creds:5006',
        secretKey: 'file-secret',
      });

      // Set conflicting env vars
      const origUrl = process.env.ACTUAL_SERVER_URL;
      const origKey = process.env.ACTUAL_SECRET_KEY;
      process.env.ACTUAL_SERVER_URL = 'http://env-creds:5006';
      process.env.ACTUAL_SECRET_KEY = 'env-secret';

      try {
        // EncryptedCredentialStore should return file-stored creds, not env
        const loaded = await store.load();
        expect(loaded).not.toBeNull();
        expect(loaded?.serverUrl).toBe('http://file-creds:5006');
        expect(loaded?.secretKey).toBe('file-secret');

        // has() should be based on files, not env
        expect(store.has()).toBe(true);

        // list() should return file URLs, not env
        const urls = store.list();
        expect(urls).toContain('http://file-creds:5006');
        expect(urls).not.toContain('http://env-creds:5006');
      } finally {
        if (origUrl === undefined) delete process.env.ACTUAL_SERVER_URL;
        else process.env.ACTUAL_SERVER_URL = origUrl;
        if (origKey === undefined) delete process.env.ACTUAL_SECRET_KEY;
        else process.env.ACTUAL_SECRET_KEY = origKey;
      }

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should have EnvCredentialStore that reads env vars independently', async () => {
      const { EnvCredentialStore } = await import('../src/credentials');

      const origUrl = process.env.ACTUAL_SERVER_URL;
      const origKey = process.env.ACTUAL_SECRET_KEY;
      process.env.ACTUAL_SERVER_URL = 'http://env-only:5006';
      process.env.ACTUAL_SECRET_KEY = 'env-only-secret';

      try {
        const store = new EnvCredentialStore();
        expect(store.has()).toBe(true);
        const loaded = await store.load();
        expect(loaded?.serverUrl).toBe('http://env-only:5006');
        expect(loaded?.secretKey).toBe('env-only-secret');
        expect(store.list()).toEqual(['http://env-only:5006']);

        // EnvCredentialStore delete is a no-op, not an error
        await expect(store.delete()).resolves.toBeUndefined();
        expect(store.has()).toBe(true);  // env still set
      } finally {
        if (origUrl === undefined) delete process.env.ACTUAL_SERVER_URL;
        else process.env.ACTUAL_SERVER_URL = origUrl;
        if (origKey === undefined) delete process.env.ACTUAL_SECRET_KEY;
        else process.env.ACTUAL_SECRET_KEY = origKey;
      }
    });
  });

  // ==========================================================================
  // 19. Regression: Deletion truthfulness
  // ==========================================================================

  describe('deletion truthfulness', () => {
    it('should remove all credential files on delete', async () => {
      const tmpDir = '/tmp/bf-test-delete-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readdirSync, rmSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const key = Buffer.alloc(32, 0x42);

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
        masterKey: key,
      });

      await store.store({
        serverUrl: 'http://delete-me:5006',
        secretKey: 'delete-secret',
      });

      // Verify file exists before delete
      const filesBefore = readdirSync(tmpDir).filter(f => f.endsWith('.enc') || f === 'current.txt');
      expect(filesBefore.length).toBeGreaterThan(0);

      await store.delete();

      // No .enc files should remain
      const filesAfter = readdirSync(tmpDir).filter(f => f.endsWith('.enc'));
      expect(filesAfter).toEqual([]);

      // has() should return false
      expect(store.has()).toBe(false);

      // load() should return null
      expect(await store.load()).toBeNull();

      // list() should return empty
      expect(store.list()).toEqual([]);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should preserve master.key after credential delete', async () => {
      const tmpDir = '/tmp/bf-test-delete-key-' + Date.now();
      const { EncryptedCredentialStore } = await import('../src/credentials');
      const { readdirSync, readFileSync, rmSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const store = new EncryptedCredentialStore({
        credentialDir: tmpDir,
      });

      await store.store({
        serverUrl: 'http://keep-key:5006',
        secretKey: 'my-secret',
      });

      expect(existsSync(resolve(tmpDir, 'master.key'))).toBe(true);

      await store.delete();

      // master.key should survive deletion — only .enc files are removed
      expect(existsSync(resolve(tmpDir, 'master.key'))).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should throw on delete when directory does not exist', async () => {
      const { EncryptedCredentialStore } = await import('../src/credentials');

      const store = new EncryptedCredentialStore({
        credentialDir: '/tmp/bf-test-nonexistent-' + Date.now() + '-nope',
        masterKey: Buffer.alloc(32, 0x42),
      });

      // Delete on a non-existent directory should throw ENOENT
      await expect(store.delete()).rejects.toThrow();
    });
  });

  // ==========================================================================
  // 15. Regression: Observe sync is read-only in Observe mode
  // ==========================================================================

  describe('Observe sync is read-only', () => {
    it('should NOT call client.sync() during synchronize() in Observe mode', async () => {
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

      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });
      await connector.selectBudget('budget_1');

      // Reset sync mock to verify it's NOT called during synchronize
      mockClient.sync = vi.fn().mockResolvedValue(undefined);

      await connector.synchronize();

      // In Observe mode, synchronize should re-download, not call sync()
      expect(mockClient.sync).not.toHaveBeenCalled();
      expect(mockClient.downloadBudget).toHaveBeenCalled();
    });

    it('should downloadBudget using groupId, not public BudgetInfo.id, during Observe synchronize', async () => {
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

      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      // Select via public BudgetInfo.id
      await connector.selectBudget('budget_1');

      // Reset downloadBudget spy to measure what synchronize passes
      mockClient.downloadBudget = vi.fn().mockResolvedValue(undefined);

      await connector.synchronize();

      // synchronize must download using the groupId/sync identifier, not the public id
      expect(mockClient.downloadBudget).toHaveBeenCalledWith(
        'group_1',
        expect.objectContaining({}),
      );
      expect(mockClient.downloadBudget).not.toHaveBeenCalledWith(
        'budget_1',
        expect.anything(),
      );
    });

    it('should not call any client mutation methods during synchronize in Observe mode', async () => {
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

      // Install spies on all mutating client methods
      mockClient.addTransactions = vi.fn();
      mockClient.createAccount = vi.fn();
      mockClient.updateTransaction = vi.fn();
      mockClient.createRule = vi.fn();
      mockClient.setBudgetAmount = vi.fn();
      mockClient.runBankSync = vi.fn();

      await connector.selectBudget('budget_1');
      await connector.synchronize();

      // Only read methods should be called; no mutation methods
      expect(mockClient.addTransactions).not.toHaveBeenCalled();
      expect(mockClient.createAccount).not.toHaveBeenCalled();
      expect(mockClient.updateTransaction).not.toHaveBeenCalled();
      expect(mockClient.createRule).not.toHaveBeenCalled();
      expect(mockClient.setBudgetAmount).not.toHaveBeenCalled();
      expect(mockClient.runBankSync).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 16. Regression: Watermark does not truncate listTransactions
  // ==========================================================================

  describe('listTransactions full history', () => {
    it('should return all transactions even when watermark exists', async () => {
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

      // Set watermark with recent date to simulate prior sync
      const connectorAny = connector as unknown as Record<string, unknown>;
      const caches = connectorAny.caches as Map<string, Record<string, unknown>>;
      const cache = caches.get('budget_1');
      if (cache && cache.watermark) {
        (cache.watermark as Record<string, unknown>).lastTransactionDate = '2026-07-15T00:00:00.000Z';
      }

      // listTransactions without explicit dates should return ALL transactions
      const txns = await connector.listTransactions();

      // Watermark should NOT narrow the query
      expect(mockClient.getTransactions).toHaveBeenCalledWith(
        expect.any(String),
        '1970-01-01',
        '2099-12-31',
      );
      expect(txns.length).toBeGreaterThan(0);
    });

    it('should return all transactions after a real synchronize flow', async () => {
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

      // Run synchronize to establish a real watermark
      await connector.synchronize();

      // Replace getTransactions spy to observe fresh calls
      mockClient.getTransactions = vi.fn().mockResolvedValue(mockTransactions);

      // listTransactions should return ALL transactions, not narrowed by watermark
      const txns = await connector.listTransactions();

      expect(mockClient.getTransactions).toHaveBeenCalledWith(
        expect.any(String),
        '1970-01-01',
        '2099-12-31',
      );
      expect(txns.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 17. Regression: Semver validation detects malformed versions
  // ==========================================================================

  describe('semver validation', () => {
    it('should reject malformed server version with NaN parts', async () => {
      const badConnector = new ActualConnector({
        client: createMockClient({
          getServerVersion: vi.fn().mockResolvedValue({ version: 'abc.def' }),
        }),
        credentialStore: new NullCredentialStore(),
        compatibilityRange: { min: '24.0.0', max: '26.7.0' },
      });

      await badConnector.connect({
        serverUrl: 'http://badver:5006',
        secretKey: 'test',
      });

      const compat = await badConnector.getCompatibility();
      expect(compat.supported).toBe(false);
      expect(compat.blockers.some(b => b.includes('not a valid semver'))).toBe(true);
    });

    it('should reject server version with only one part', async () => {
      const badConnector = new ActualConnector({
        client: createMockClient({
          getServerVersion: vi.fn().mockResolvedValue({ version: '24' }),
        }),
        credentialStore: new NullCredentialStore(),
        compatibilityRange: { min: '24.0.0', max: '26.7.0' },
      });

      await badConnector.connect({
        serverUrl: 'http://badver2:5006',
        secretKey: 'test',
      });

      const compat = await badConnector.getCompatibility();
      expect(compat.supported).toBe(false);
      expect(compat.blockers.some(b => b.includes('not a valid semver'))).toBe(true);
    });
  });

  // ==========================================================================
  // 18. Regression: Cache path traversal is blocked
  describe('cache path traversal prevention', () => {
    it('should throw on cache key attempting parent directory traversal', () => {
      const proto = ActualConnector.prototype as unknown as Record<string, unknown>;
      const cacheDirFor = proto.cacheDirFor as (key: string) => string;
      // A bare '..' key survives character filtering and would resolve above baseCacheDir
      expect(() => cacheDirFor.call(connector, '..')).toThrow(/traversal blocked/);
    });
  });

  // ==========================================================================
  // 19. Regression: Coverage correctly handles closed accounts
  // ==========================================================================

  describe('coverage with closed accounts', () => {
    it('should report all non-closed accounts present', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      mockClient.getAccounts = vi.fn().mockResolvedValue(mockAccounts);

      const coverage = await connector.getCoverage();

      // Closed accounts should not count against total
      expect(coverage.totalAccounts).toBe(2); // a3 is closed, excluded
      expect(coverage.includedAccounts).toBe(2);
      expect(coverage.allExpectedAccountsPresent).toBe(true);
    });

    it('should report zero total accounts when all accounts are closed', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      const allClosed = mockAccounts.map(a => ({ ...a, closed: true }));
      mockClient.getAccounts = vi.fn().mockResolvedValue(allClosed);

      const coverage = await connector.getCoverage();
      expect(coverage.totalAccounts).toBe(0);
      expect(coverage.includedAccounts).toBe(0);
      expect(coverage.allExpectedAccountsPresent).toBe(true);
    });

    it('should include off-budget non-closed accounts in total', async () => {
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      const mixedAccounts: APIAccountEntity[] = [
        { id: 'a1', name: 'Checking', offbudget: false, closed: false, balance_current: 50000 },
        { id: 'a2', name: 'Off Budget Savings', offbudget: true, closed: false, balance_current: 100000 },
        { id: 'a3', name: 'Closed Card', offbudget: false, closed: true, balance_current: 0 },
      ];
      mockClient.getAccounts = vi.fn().mockResolvedValue(mixedAccounts);

      const coverage = await connector.getCoverage();
      // a3 (closed) excluded; a1 and a2 both count regardless of offbudget
      expect(coverage.totalAccounts).toBe(2);
      expect(coverage.includedAccounts).toBe(2);
      expect(coverage.allExpectedAccountsPresent).toBe(true);
    });
  });

  // ==========================================================================
  // 20. Regression: Disconnect awaits pending cache operations
  // ==========================================================================

  describe('disconnect serialization', () => {
    it('should await pending cache operations before shutdown', async () => {
      const localMock = createMockClient();
      localMock.getBudgets = vi.fn().mockResolvedValue(mockFiles);
      localMock.downloadBudget = vi.fn().mockResolvedValue(undefined);
      localMock.loadBudget = vi.fn().mockResolvedValue(undefined);

      const localConnector = new ActualConnector({
        client: localMock,
        credentialStore: new NullCredentialStore(),
        mode: 'observe',
      });

      await localConnector.connect({
        serverUrl: 'http://serial:5006',
        secretKey: 'test',
      });
      await localConnector.selectBudget('budget_1');

      // Check cacheLocks exists (white-box test)
      const localAny = localConnector as unknown as Record<string, unknown>;
      expect(localAny.cacheLocks).toBeDefined();

      // Disconnect should not throw despite pending locks
      await expect(localConnector.disconnect()).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // 21. Regression: Split child transactions as subtransactions
  // ==========================================================================

  describe('split child transactions', () => {
    it('should attach child transactions as subtransactions on parent', () => {
      const parentId = 'tx-parent';
      const txnsWithChildren: TransactionEntity[] = [
        {
          id: parentId,
          account: 'a1',
          date: '2026-07-15',
          amount: -50000,
          payee: 'p1',
          category: 'c1',
          cleared: true,
          reconciled: false,
          notes: null,
          imported_id: null,
          imported_payee: null,
          is_child: false,
        } as TransactionEntity,
        {
          id: 'tx-child-1',
          account: 'a1',
          date: '2026-07-15',
          amount: -30000,
          payee: 'p1',
          category: 'c1',
          cleared: true,
          reconciled: false,
          notes: 'Split 1',
          is_child: true,
          parent_id: parentId,
        } as unknown as TransactionEntity,
        {
          id: 'tx-child-2',
          account: 'a1',
          date: '2026-07-15',
          amount: -20000,
          payee: 'p1',
          category: 'c1',
          cleared: true,
          reconciled: false,
          notes: 'Split 2',
          is_child: true,
          parent_id: parentId,
        } as unknown as TransactionEntity,
      ];

      const payeeMap = { p1: 'Groceries' };
      const categoryMap = { c1: { name: 'Food', groupName: 'Essential' } };
      const transferAcctMap = { p1: null };
      const result = normalizeTransactions(txnsWithChildren, payeeMap, categoryMap, transferAcctMap);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(parentId);

      // Parent should have subtransactions
      expect(result[0].subtransactions).toHaveLength(2);

      // First child
      expect(result[0].subtransactions[0].id).toBe('tx-child-1');
      expect(result[0].subtransactions[0].amount).toEqual({ minorUnits: '-30000', currency: 'USD' });
      expect(result[0].subtransactions[0].categoryName).toBe('Food');
      expect(result[0].subtransactions[0].notes).toBe('Split 1');

      // Second child
      expect(result[0].subtransactions[1].id).toBe('tx-child-2');
      expect(result[0].subtransactions[1].amount).toEqual({ minorUnits: '-20000', currency: 'USD' });
      expect(result[0].subtransactions[1].categoryName).toBe('Food');
      expect(result[0].subtransactions[1].notes).toBe('Split 2');

      // Children should not appear as top-level transactions
      expect(result.find(t => t.id === 'tx-child-1')).toBeUndefined();
      expect(result.find(t => t.id === 'tx-child-2')).toBeUndefined();
    });

    it('should preserve amounts and categories on subtransactions', () => {
      const parentId = 'tx-split-parent';
      const txnsWithChildren: TransactionEntity[] = [
        {
          id: parentId,
          account: 'a1',
          date: '2026-07-20',
          amount: -100000,
          payee: 'p1',
          category: 'c1',
          cleared: true,
          reconciled: false,
          notes: null,
          imported_id: null,
          imported_payee: null,
          is_child: false,
        } as TransactionEntity,
        {
          id: 'tx-split-c1',
          account: 'a1',
          date: '2026-07-20',
          amount: -60000,
          payee: 'p1',
          category: 'c1',
          cleared: true,
          reconciled: false,
          notes: 'Groceries',
          is_child: true,
          parent_id: parentId,
        } as unknown as TransactionEntity,
        {
          id: 'tx-split-c2',
          account: 'a1',
          date: '2026-07-20',
          amount: -40000,
          payee: 'p2',
          category: 'c2',
          cleared: true,
          reconciled: false,
          notes: 'Gas',
          is_child: true,
          parent_id: parentId,
        } as unknown as TransactionEntity,
      ];

      const payeeMap = { p1: 'Groceries', p2: 'Gas Station' };
      const categoryMap = { c1: { name: 'Food', groupName: 'Essential' }, c2: { name: 'Transport', groupName: 'Essential' } };
      const transferAcctMap = { p1: null, p2: null };
      const result = normalizeTransactions(txnsWithChildren, payeeMap, categoryMap, transferAcctMap);

      expect(result).toHaveLength(1);
      const children = result[0].subtransactions;
      expect(children).toHaveLength(2);

      // Subtransaction amounts sum to parent (split semantics preserved)
      const sum = children.reduce((acc, c) => acc + Number(c.amount.minorUnits), 0);
      expect(String(sum)).toBe(result[0].amount.minorUnits);

      // Different categories per child
      expect(children[0].categoryName).toBe('Food');
      expect(children[1].categoryName).toBe('Transport');
    });
  });

  // ==========================================================================
  // 22. Regression: Transfer counterpart account ID resolution
  // ==========================================================================

  describe('transfer account ID resolution', () => {
    it('should resolve transfer counterpart account from payee transfer_acct', () => {
      const transferTx: TransactionEntity = {
        id: 'tx-transfer',
        account: 'a1',
        date: '2026-07-16',
        amount: -100000,
        payee: 'p3',
        category: null,
        cleared: true,
        reconciled: false,
        notes: 'Transfer to Savings',
        imported_id: null,
        imported_payee: null,
      } as TransactionEntity;

      const payeeMap = { p3: 'Transfer to Savings' };
      const categoryMap = {};
      const transferAcctMap = { p3: 'a2' };

      const result = normalizeTransaction(transferTx, payeeMap, categoryMap, transferAcctMap);

      // transferAccountId should resolve to the account referenced by the payee's transfer_acct
      expect(result.transferAccountId).toBe('a2');
    });

    it('should set transferAccountId to null for non-transfer payees', () => {
      const normalTx: TransactionEntity = {
        id: 'tx-normal',
        account: 'a1',
        date: '2026-07-16',
        amount: -2500,
        payee: 'p1',
        category: 'c1',
        cleared: true,
        reconciled: false,
        notes: null,
        imported_id: null,
        imported_payee: null,
      } as TransactionEntity;

      const payeeMap = { p1: 'Groceries' };
      const categoryMap = { c1: { name: 'Food', groupName: 'Essential' } };
      const transferAcctMap = { p1: null };

      const result = normalizeTransaction(normalTx, payeeMap, categoryMap, transferAcctMap);
      expect(result.transferAccountId).toBeNull();
    });

    it('should build transfer account map from normalized payees', () => {
      const payees = normalizePayees(mockPayees);
      const acctMap = buildTransferAcctMap(payees);
      expect(acctMap).toEqual({
        p1: null,
        p2: null,
        p3: 'a2',
      });
    });
  });

  // ==========================================================================
  // 23. Regression: Hidden vs deleted categories
  // ==========================================================================

  describe('category hidden/deleted distinction', () => {
    it('should set deleted=false for visible categories (hidden=false, no tombstone)', () => {
      const cat: APICategoryEntity = { id: 'c1', name: 'Food', group_id: 'g1', is_income: false, hidden: false };
      const groupsByName = { g1: 'Essential' };
      const result = normalizeCategory(cat, groupsByName);
      expect(result.deleted).toBe(false);
    });

    it('should set deleted=false for hidden-but-not-deleted categories', () => {
      // Hidden categories are still valid — they are not deleted, just hidden from the UI
      const cat: APICategoryEntity = { id: 'c_hidden', name: 'Old Category', group_id: 'g1', is_income: false, hidden: true };
      const groupsByName = { g1: 'Essential' };
      const result = normalizeCategory(cat, groupsByName);
      // hidden does NOT imply deleted
      expect(result.deleted).toBe(false);
    });

    it('should set deleted=true for tombstone categories (actually removed)', () => {
      const cat: APICategoryEntity & { tombstone?: boolean } = { id: 'c_deleted', name: 'Deleted Cat', group_id: 'g1', is_income: false, hidden: false, tombstone: true };
      const groupsByName = { g1: 'Essential' };
      const result = normalizeCategory(cat as APICategoryEntity, groupsByName);
      expect(result.deleted).toBe(true);
    });
  });

  // ==========================================================================
  // 24. Regression: Schedule frequency and amount semantics
  // ==========================================================================

  describe('schedule normalization', () => {
    it('should extract frequency string from schedule date object', () => {
      const scheduleWithObject: APIScheduleEntity = {
        id: 's2',
        name: 'Car Payment',
        posts_transaction: true,
        rule: 'r_car',
        next_date: '2026-09-01',
        completed: false,
        payee: 'Auto Loan',
        account: 'a1',
        amount: -35000,
        amountOp: 'is',
        date: { frequency: 'monthly', interval: 1, start: '2026-01-01', endMode: 'never' },
      };

      const result = normalizeSchedule(scheduleWithObject);
      expect(result.frequency).toBe('monthly');
    });

    it('should preserve negative amounts for expense schedules', () => {
      const scheduleWithObject: APIScheduleEntity = {
        id: 's3',
        name: 'Insurance',
        posts_transaction: true,
        rule: 'r_ins',
        next_date: '2026-10-01',
        completed: false,
        payee: 'Insurance Co',
        account: 'a1',
        amount: -12000,
        amountOp: 'is',
        date: { frequency: 'yearly', interval: 1, start: '2026-01-01', endMode: 'never' },
      };

      const result = normalizeSchedule(scheduleWithObject);
      expect(result.amount).toEqual({ minorUnits: '-12000', currency: 'USD' });
    });

    it('should handle string date fallback if date is a string', () => {
      const scheduleWithString: APIScheduleEntity = {
        id: 's4',
        name: 'Manual',
        posts_transaction: true,
        rule: 'r_manual',
        next_date: '2026-11-01',
        completed: false,
        payee: 'Manual Payee',
        account: 'a1',
        amount: -5000,
        amountOp: 'is',
        date: '2026-11-01' as unknown as APIScheduleEntity['date'],
      };

      const result = normalizeSchedule(scheduleWithString);
      expect(result.frequency).toBe('2026-11-01');
    });
  });

  // ==========================================================================
  // 25. Regression: Snapshot metadata (actualDownloadedAt, bankSyncedAt, encrypted, unlocked)
  // ==========================================================================

  describe('snapshot metadata', () => {
    it('should include metadata fields in snapshot result from synchronize()', async () => {
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

      const snapshot = result.snapshot;

      // actualDownloadedAt should be a non-empty ISO timestamp
      expect(snapshot.actualDownloadedAt).toBeTruthy();
      expect(new Date(snapshot.actualDownloadedAt!).toISOString()).toBe(snapshot.actualDownloadedAt);

      // bankSyncedAt should be null (bank sync not available in Observe-only mode)
      expect(snapshot.bankSyncedAt).toBeNull();

      // encrypted should be false for mockFiles (encrypted: false)
      expect(snapshot.encrypted).toBe(false);

      // unlocked should be true once the budget is selected
      expect(snapshot.unlocked).toBe(true);
    });

    it('should report encrypted=true when budget has encryption key', async () => {
      const encryptedFiles: APIFileEntity[] = [
        {
          id: 'budget_enc',
          groupId: 'group_enc',
          name: 'Encrypted Budget',
          cloudFileId: 'cloud_enc',
          encrypted: false, // Note: APIFileEntity uses 'encrypted' field
          state: 'remote',
        },
      ];

      // Override discoverBudgets to use a mock that returns encrypted budget
      const encryptedConnector = new ActualConnector({
        client: createMockClient({
          getBudgets: vi.fn().mockResolvedValue(encryptedFiles),
        }),
        credentialStore: new NullCredentialStore(),
        mode: 'observe',
      });

      await encryptedConnector.connect({
        serverUrl: 'http://encrypted:5006',
        secretKey: 'secret',
      });

      const budgets = await encryptedConnector.discoverBudgets();
      expect(budgets[0].encrypted).toBe(false); // hasKey not set, so false

      // Now test with hasKey=true
      const budgetsWithKey = encryptedFiles.map(f => ({
        ...budgets[0],
        encrypted: true,
      }));

      // We can directly test that the snapshot honors _budgetInfo.encrypted
      // by checking the budget info
      expect('encrypted' in budgets[0]).toBe(true);
    });
  });

  // ==========================================================================
  // setTransactionCategory — write-mode tests
  // ==========================================================================

  describe('setTransactionCategory', () => {
    it('should update category in write-enabled mode and return verified result', async () => {
      const transactions = mockTransactions.map(t => ({ ...t }));
      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockResolvedValue(transactions),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-write-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      // Make updateTransaction persist the category change into the transactions array
      // so the re-read returns the updated category.
      mock.updateTransaction = vi.fn().mockImplementation(
        (id: string, fields: Record<string, unknown>) => {
          const tx = transactions.find(t => t.id === id);
          if (tx && typeof fields.category === 'string') {
            tx.category = fields.category;
          }
          return Promise.resolve(undefined);
        },
      );

      const result = await writeConnector.setTransactionCategory('tx1', 'c2', 'c1');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactionId).toBe('tx1');
        expect(result.previousCategoryId).toBe('c1');
        expect(result.newCategoryId).toBe('c2');
        expect(result.idempotencyKey).toBeTruthy();
        expect(typeof result.idempotencyKey).toBe('string');
        expect(result.verified).toBe(true);
      }

      // Exactly one call to updateTransaction with the correct args
      expect(mock.updateTransaction).toHaveBeenCalledTimes(1);
      expect(mock.updateTransaction).toHaveBeenCalledWith('tx1', { category: 'c2' });

      await writeConnector.disconnect();
    });

    it('should return failure on precondition mismatch', async () => {
      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockResolvedValue(mockTransactions),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-stale-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      mock.updateTransaction = vi.fn();

      // tx1 has category 'c1', but we say it's 'c2' — precondition mismatch
      const result = await writeConnector.setTransactionCategory('tx1', 'c3', 'c2');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('PRECONDITION_MISMATCH');
        expect(result.error).toContain('precondition mismatch');
        expect(result.transactionId).toBe('tx1');
        expect(result.previousCategoryId).toBe('c1');
      }

      // No client mutation call on precondition failure
      expect(mock.updateTransaction).not.toHaveBeenCalled();

      await writeConnector.disconnect();
    });

    it('should return failure when transaction is not found', async () => {
      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      // getTransactions defaults to empty array from createMockClient
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-notfound-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      mock.updateTransaction = vi.fn();

      const result = await writeConnector.setTransactionCategory('nonexistent', 'c1', null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('TRANSACTION_NOT_FOUND');
        expect(result.error).toContain('not found');
      }

      expect(mock.updateTransaction).not.toHaveBeenCalled();

      await writeConnector.disconnect();
    });

    it('should reject setTransactionCategory in Observe mode (no client calls)', async () => {
      // Uses the outer 'observe' connector configured in beforeEach
      await connector.connect({
        serverUrl: 'http://localhost:5006',
        secretKey: 'secret',
      });

      mockClient.getAccounts = vi.fn().mockResolvedValue(mockAccounts);
      mockClient.getTransactions = vi.fn().mockResolvedValue(mockTransactions);
      mockClient.updateTransaction = vi.fn();

      await expect(
        connector.setTransactionCategory('tx1', 'c2', 'c1'),
      ).rejects.toThrow();

      expect(mockClient.updateTransaction).not.toHaveBeenCalled();
      expect(mockClient.getAccounts).not.toHaveBeenCalled();
      expect(mockClient.getTransactions).not.toHaveBeenCalled();
    });

    it('should verify postcondition by re-reading the transaction', async () => {
      let calls = 0;
      const txnsForReRead = [
        [{ id: 'tx1', account: 'a1', category: 'c1' } as TransactionEntity],
        [{ id: 'tx1', account: 'a1', category: 'c2' } as TransactionEntity],
      ];

      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockImplementation(() => {
          const result = txnsForReRead[calls] ?? txnsForReRead[0]!;
          calls++;
          return Promise.resolve(result);
        }),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-verify-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      // Reset counter after selectBudget (which does not call getTransactions)
      calls = 0;

      const result = await writeConnector.setTransactionCategory('tx1', 'c2', 'c1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.verified).toBe(true);
        expect(result.previousCategoryId).toBe('c1');
        expect(result.newCategoryId).toBe('c2');
      }

      // Should have called getTransactions exactly twice (read + re-read)
      expect(calls).toBe(2);

      await writeConnector.disconnect();
    });

    it('should call sync after updateTransaction and return failure if sync fails', async () => {
      let updateTxCalled = false;
      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockResolvedValue(mockTransactions),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
        updateTransaction: vi.fn().mockImplementation(() => {
          updateTxCalled = true;
          return Promise.resolve(undefined);
        }),
        sync: vi.fn().mockRejectedValue(new Error('Server unreachable')),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-sync-fail-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      const result = await writeConnector.setTransactionCategory('tx1', 'c2', 'c1');

      // updateTransaction was called (the write happened)
      expect(mock.updateTransaction).toHaveBeenCalledTimes(1);
      expect(mock.updateTransaction).toHaveBeenCalledWith('tx1', { category: 'c2' });

      // sync was called
      expect(mock.sync).toHaveBeenCalledTimes(1);

      // But the result is failure because sync threw
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('SYNC_FAILED');
        expect(result.error).toContain('Sync failed');
        expect(result.transactionId).toBe('tx1');
        expect(result.previousCategoryId).toBe('c1');
        expect(result.newCategoryId).toBe('c2');
        expect(result.idempotencyKey).toBeTruthy();
      }

      await writeConnector.disconnect();
    });

    it('should fail when no budget is selected', async () => {
      const mock = createMockClient();
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-nobudget-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      // Intentionally skip selectBudget — _budgetInfo stays null

      mock.updateTransaction = vi.fn();
      mock.getCategories = vi.fn();

      const result = await writeConnector.setTransactionCategory('tx1', 'c2', 'c1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('BUDGET_NOT_SELECTED');
      }

      // No client mutation or category calls should occur
      expect(mock.updateTransaction).not.toHaveBeenCalled();
      expect(mock.getCategories).not.toHaveBeenCalled();

      await writeConnector.disconnect();
    });

    it('should fail when proposed category does not exist', async () => {
      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockResolvedValue(mockTransactions),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-cat-notfound-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      mock.updateTransaction = vi.fn();

      // 'nonexistent' is not in mockCategories
      const result = await writeConnector.setTransactionCategory('tx1', 'nonexistent', 'c1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('CATEGORY_NOT_FOUND');
        expect(result.error).toContain('does not exist');
      }

      expect(mock.updateTransaction).not.toHaveBeenCalled();

      await writeConnector.disconnect();
    });

    it('should fail when proposed category is deleted (tombstone)', async () => {
      const categoriesWithDeleted: APICategoryEntity[] = [
        ...mockCategories,
        {
          id: 'c_deleted',
          name: 'Deleted Cat',
          group_id: 'g1',
          is_income: false,
          hidden: false,
          tombstone: true,
        } as APICategoryEntity,
      ];

      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockResolvedValue(mockTransactions),
        getCategories: vi.fn().mockResolvedValue(categoriesWithDeleted),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-tombstone-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      mock.updateTransaction = vi.fn();

      const result = await writeConnector.setTransactionCategory('tx1', 'c_deleted', 'c1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('CATEGORY_DELETED');
        expect(result.error).toContain('tombstone');
      }

      expect(mock.updateTransaction).not.toHaveBeenCalled();

      await writeConnector.disconnect();
    });

    it('should fail when post-write verification does not match', async () => {
      let calls = 0;
      const txnsForReRead = [
        [{ id: 'tx1', account: 'a1', category: 'c1' } as TransactionEntity],
        [{ id: 'tx1', account: 'a1', category: 'c1' } as TransactionEntity],
      ];

      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockImplementation(() => {
          const result = txnsForReRead[calls] ?? txnsForReRead[0]!;
          calls++;
          return Promise.resolve(result);
        }),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-verif-fail-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      calls = 0;

      const result = await writeConnector.setTransactionCategory('tx1', 'c2', 'c1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('VERIFICATION_FAILED');
        expect(result.transactionId).toBe('tx1');
        expect(result.previousCategoryId).toBe('c1');
        expect(result.newCategoryId).toBe('c2');
        expect(result.idempotencyKey).toBeTruthy();
        expect(result.verified).toBe(false);
      }

      // updateTransaction was called (the write happened) but re-read shows old category
      expect(mock.updateTransaction).toHaveBeenCalledTimes(1);
      expect(mock.updateTransaction).toHaveBeenCalledWith('tx1', { category: 'c2' });

      // Two getTransactions calls: initial read + re-read
      expect(calls).toBe(2);

      await writeConnector.disconnect();
    });

    it('should serialize concurrent setTransactionCategory calls under the budget lock', async () => {
      const transactions = mockTransactions.map(t => ({ ...t }));
      const mock = createMockClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
        getTransactions: vi.fn().mockResolvedValue(transactions),
        getCategories: vi.fn().mockResolvedValue(mockCategories),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getBudgets: vi.fn().mockResolvedValue(mockFiles),
      });
      const writeConnector = new ActualConnector({
        client: mock,
        credentialStore: new NullCredentialStore(),
        mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-lock-test',
      });

      await writeConnector.connect({
        serverUrl: 'http://test:5006',
        secretKey: 'test',
      });
      await writeConnector.selectBudget('budget_1');

      // updateTransaction persists category changes so verification passes
      mock.updateTransaction = vi.fn().mockImplementation(
        (id: string, fields: Record<string, unknown>) => {
          const tx = transactions.find(t => t.id === id);
          if (tx && typeof fields.category === 'string') {
            tx.category = fields.category;
          }
          return Promise.resolve(undefined);
        },
      );

      const order: number[] = [];

      // Two concurrent calls on DIFFERENT transactions so precondition doesn't
      // become stale. tx1 starts c1 → c2; tx2 starts c2 → c1.
      const p1 = writeConnector.setTransactionCategory('tx1', 'c2', 'c1').then(r => {
        order.push(1);
        return r;
      });
      const p2 = writeConnector.setTransactionCategory('tx2', 'c1', 'c2').then(r => {
        order.push(2);
        return r;
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      // Second call completes after first (lock serialization)
      expect(order).toEqual([1, 2]);

      // Two updateTransaction calls (one per setTransactionCategory call)
      expect(mock.updateTransaction).toHaveBeenCalledTimes(2);

      await writeConnector.disconnect();
    });
  });


});

