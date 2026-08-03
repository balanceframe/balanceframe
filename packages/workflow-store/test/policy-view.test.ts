/**
 * Failing tests for Phase 8 policy versions, saved filters/views, and
 * report records.
 *
 * TDD: these tests establish the expected contract before implementation.
 * Run with: pnpm --filter @balanceframe/workflow-store test
 *
 * Categories:
 * - Policy version recording and activation
 * - Supersession of older policy versions
 * - Active policy version query
 * - Saved filter creation, update, and deletion
 * - Policy-aware saved filter scope
 * - Default filter demotion
 * - Report record creation and listing
 * - Report record expiry
 * - Policy/view round-trip (round-trip persistence and retrieval)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type {
  RecordPolicyVersionInput,
  CreateSavedFilterInput,
  UpdateSavedFilterInput,
  CreateReportRecordInput,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tickSync(): void {
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY_INPUT: RecordPolicyVersionInput = {
  policyKey: 'authorization',
  policyHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  description: 'Initial authorization policy v1',
};

const FILTER_INPUT: CreateSavedFilterInput = {
  name: 'High-value transactions',
  filterConfig: { amountMin: 10000, amountMax: null },
  scope: 'role:admin',
  policyVersion: '1.0.0',
  budgetId: 'budget-alpha',
  viewConfig: { sortBy: 'amount', descending: true },
  isDefault: false,
  actorId: 'alice@example.com',
};

const REPORT_INPUT: CreateReportRecordInput = {
  reportType: 'budget_summary',
  config: { period: '2026-07', groupBy: 'category' },
  policyVersion: '1.0.0',
  budgetId: 'budget-alpha',
  filterId: null,
  expiresAt: null,
  dataRef: 's3://reports/2026-07-summary.json',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Policy versions', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  // =======================================================================
  // Record policy version
  // =======================================================================

  describe('recordPolicyVersion', () => {
    it('persists a policy version with all fields', async () => {
      const pv = await store.recordPolicyVersion(POLICY_INPUT);

      expect(pv.id).toBeTypeOf('string');
      expect(pv.policyKey).toBe(POLICY_INPUT.policyKey);
      expect(pv.policyHash).toBe(POLICY_INPUT.policyHash);
      expect(pv.description).toBe(POLICY_INPUT.description);
      expect(pv.version).toBe(1);
      expect(pv.isActive).toBe(true);
      expect(pv.supersededAt).toBeNull();
      expect(pv.createdAt).toBeTypeOf('string');
    });

    it('auto-activates and supersedes the previous active version', async () => {
      const v1 = await store.recordPolicyVersion(POLICY_INPUT);
      tickSync();

      const v2Input: RecordPolicyVersionInput = {
        policyKey: 'authorization',
        policyHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        description: 'Updated authorization policy v2',
      };
      const v2 = await store.recordPolicyVersion(v2Input);

      expect(v2.version).toBe(2);
      expect(v2.isActive).toBe(true);

      // v1 should now be superseded
      const reloadedV1 = await store.getPolicyVersion(v1.id);
      expect(reloadedV1!.isActive).toBe(false);
      expect(reloadedV1!.supersededAt).not.toBeNull();
    });

    it('records sequential versions for the same policyKey', async () => {
      const v1 = await store.recordPolicyVersion(POLICY_INPUT);
      // Only one recordPolicyVersion call — version starts at 1
      expect(v1.version).toBe(1);

      const v2 = await store.recordPolicyVersion({
        ...POLICY_INPUT,
        policyHash: 'cccc',
        description: 'v2',
      });
      expect(v2.version).toBe(2);
    });

    it('allows independent version sequences per policyKey', async () => {
      const authV1 = await store.recordPolicyVersion({ policyKey: 'authorization', policyHash: 'aaa', description: 'auth v1' });
      const notifV1 = await store.recordPolicyVersion({ policyKey: 'notification', policyHash: 'bbb', description: 'notif v1' });

      expect(authV1.version).toBe(1);
      expect(authV1.policyKey).toBe('authorization');
      expect(notifV1.version).toBe(1);
      expect(notifV1.policyKey).toBe('notification');
    });
  });

  // =======================================================================
  // Get policy version
  // =======================================================================

  describe('getPolicyVersion', () => {
    it('retrieves a policy version by ID', async () => {
      const pv = await store.recordPolicyVersion(POLICY_INPUT);
      const fetched = await store.getPolicyVersion(pv.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(pv.id);
      expect(fetched!.description).toBe(POLICY_INPUT.description);
    });

    it('returns null for unknown ID', async () => {
      const fetched = await store.getPolicyVersion('nonexistent');
      expect(fetched).toBeNull();
    });
  });

  // =======================================================================
  // Get active policy version
  // =======================================================================

  describe('getActivePolicyVersion', () => {
    it('returns the active version for a given policyKey', async () => {
      const v1 = await store.recordPolicyVersion(POLICY_INPUT);
      const active = await store.getActivePolicyVersion('authorization');
      expect(active).not.toBeNull();
      expect(active!.id).toBe(v1.id);
      expect(active!.isActive).toBe(true);
    });

    it('returns the most recent active version', async () => {
      await store.recordPolicyVersion(POLICY_INPUT);
      tickSync();
      const v2 = await store.recordPolicyVersion({
        policyKey: 'authorization',
        policyHash: 'dddd',
        description: 'v2',
      });

      const active = await store.getActivePolicyVersion('authorization');
      expect(active!.id).toBe(v2.id);
    });

    it('returns null when no version exists for the key', async () => {
      const active = await store.getActivePolicyVersion('nonexistent');
      expect(active).toBeNull();
    });
  });

  // =======================================================================
  // List policy versions
  // =======================================================================

  describe('listPolicyVersions', () => {
    it('lists all versions for a policy key, newest first', async () => {
      await store.recordPolicyVersion(POLICY_INPUT);
      tickSync();
      await store.recordPolicyVersion({ ...POLICY_INPUT, policyHash: 'eeee', description: 'v2' });

      const versions = await store.listPolicyVersions('authorization');
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);
      expect(versions[1].version).toBe(1);
    });

    it('respects limit and offset', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.recordPolicyVersion({ policyKey: 'test', policyHash: `h${i}`, description: `v${i}` });
        tickSync();
      }

      const page = await store.listPolicyVersions('test', 2, 1);
      expect(page).toHaveLength(2);
      expect(page[0].version).toBe(4);
      expect(page[1].version).toBe(3);
    });
  });
});

// =======================================================================
// Saved filters / views
// =======================================================================

describe('Saved filters', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  describe('createSavedFilter', () => {
    it('persists a saved filter with all fields', async () => {
      const filter = await store.createSavedFilter(FILTER_INPUT);

      expect(filter.id).toBeTypeOf('string');
      expect(filter.name).toBe(FILTER_INPUT.name);
      expect(filter.budgetId).toBe(FILTER_INPUT.budgetId);
      expect(JSON.parse(filter.filterConfig)).toEqual(FILTER_INPUT.filterConfig);
      expect(JSON.parse(filter.viewConfig!)).toEqual(FILTER_INPUT.viewConfig);
      expect(filter.scope).toBe(FILTER_INPUT.scope);
      expect(filter.policyVersion).toBe(FILTER_INPUT.policyVersion);
      expect(filter.isDefault).toBe(false);
      expect(filter.actorId).toBe(FILTER_INPUT.actorId);
      expect(filter.createdAt).toBeTypeOf('string');
      expect(filter.updatedAt).toBeTypeOf('string');
    });

    it('accepts null budgetId and null viewConfig for global filters', async () => {
      const filter = await store.createSavedFilter({
        name: 'Global filter',
        filterConfig: { allTransactions: true },
        scope: 'public',
        policyVersion: '1.0.0',
        actorId: 'system',
      });

      expect(filter.budgetId).toBeNull();
      expect(filter.viewConfig).toBeNull();
    });

    it('demotes existing default when creating a new default for same (budgetId, scope)', async () => {
      const f1 = await store.createSavedFilter({
        ...FILTER_INPUT,
        name: 'Original default',
        isDefault: true,
      });
      tickSync();

      const f2 = await store.createSavedFilter({
        ...FILTER_INPUT,
        name: 'New default',
        isDefault: true,
      });

      const reloadedF1 = await store.getSavedFilter(f1.id);
      expect(reloadedF1!.isDefault).toBe(false);

      const reloadedF2 = await store.getSavedFilter(f2.id);
      expect(reloadedF2!.isDefault).toBe(true);
    });

    it('allows multiple non-default filters', async () => {
      const f1 = await store.createSavedFilter(FILTER_INPUT);
      const f2 = await store.createSavedFilter({
        ...FILTER_INPUT,
        name: 'Another filter',
      });

      expect(f1.id).not.toBe(f2.id);
    });
  });

  // =======================================================================
  // Get saved filter
  // =======================================================================

  describe('getSavedFilter', () => {
    it('retrieves a saved filter by ID', async () => {
      const filter = await store.createSavedFilter(FILTER_INPUT);
      const fetched = await store.getSavedFilter(filter.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(filter.id);
      expect(fetched!.name).toBe(FILTER_INPUT.name);
    });

    it('returns null for unknown ID', async () => {
      const fetched = await store.getSavedFilter('nonexistent');
      expect(fetched).toBeNull();
    });
  });

  // =======================================================================
  // Update saved filter
  // =======================================================================

  describe('updateSavedFilter', () => {
    it('updates selected fields', async () => {
      const filter = await store.createSavedFilter(FILTER_INPUT);

      const updated = await store.updateSavedFilter(filter.id, {
        name: 'Updated name',
        scope: 'role:viewer',
      });

      expect(updated.name).toBe('Updated name');
      expect(updated.scope).toBe('role:viewer');
      // Other fields unchanged
      expect(updated.budgetId).toBe(FILTER_INPUT.budgetId);
      expect(updated.actorId).toBe(FILTER_INPUT.actorId);
    });

    it('demotes existing default when setting isDefault=true', async () => {
      const f1 = await store.createSavedFilter({ ...FILTER_INPUT, name: 'Default', isDefault: true });
      tickSync();
      const f2 = await store.createSavedFilter({ ...FILTER_INPUT, name: 'Other' });

      await store.updateSavedFilter(f2.id, { isDefault: true });

      const reloadedF1 = await store.getSavedFilter(f1.id);
      expect(reloadedF1!.isDefault).toBe(false);

      const reloadedF2 = await store.getSavedFilter(f2.id);
      expect(reloadedF2!.isDefault).toBe(true);
    });

    it('throws when updating a nonexistent filter', async () => {
      await expect(
        store.updateSavedFilter('no-such', { name: 'Ghost' }),
      ).rejects.toThrow();
    });
  });

  // =======================================================================
  // List saved filters
  // =======================================================================

  describe('listSavedFilters', () => {
    it('returns all saved filters ordered by creation time descending', async () => {
      const f1 = await store.createSavedFilter(FILTER_INPUT);
      tickSync();
      const f2 = await store.createSavedFilter({ ...FILTER_INPUT, name: 'Second' });

      const list = await store.listSavedFilters();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(f2.id);
      expect(list[1].id).toBe(f1.id);
    });

    it('filters by budgetId', async () => {
      await store.createSavedFilter({ ...FILTER_INPUT, name: 'Alpha', budgetId: 'budget-alpha' });
      await store.createSavedFilter({ ...FILTER_INPUT, name: 'Beta', budgetId: 'budget-beta' });

      const alphaFilters = await store.listSavedFilters({ budgetId: 'budget-alpha' });
      expect(alphaFilters).toHaveLength(1);
      expect(alphaFilters[0].name).toBe('Alpha');
    });

    it('filters by scope', async () => {
      await store.createSavedFilter({ ...FILTER_INPUT, name: 'Admin', scope: 'role:admin' });
      await store.createSavedFilter({ ...FILTER_INPUT, name: 'User', scope: 'role:user' });

      const adminFilters = await store.listSavedFilters({ scope: 'role:admin' });
      expect(adminFilters).toHaveLength(1);
      expect(adminFilters[0].name).toBe('Admin');
    });

    it('filters by actorId', async () => {
      await store.createSavedFilter({ ...FILTER_INPUT, name: 'Alice filter', actorId: 'alice' });
      await store.createSavedFilter({ ...FILTER_INPUT, name: 'Bob filter', actorId: 'bob' });

      const bobFilters = await store.listSavedFilters({ actorId: 'bob' });
      expect(bobFilters).toHaveLength(1);
      expect(bobFilters[0].name).toBe('Bob filter');
    });

    it('respects limit and offset', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.createSavedFilter({ ...FILTER_INPUT, name: `Filter ${i}` });
        tickSync();
      }

      const page = await store.listSavedFilters({ limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
    });
  });

  // =======================================================================
  // Delete saved filter
  // =======================================================================

  describe('deleteSavedFilter', () => {
    it('deletes a saved filter by ID', async () => {
      const filter = await store.createSavedFilter(FILTER_INPUT);
      await store.deleteSavedFilter(filter.id);

      const fetched = await store.getSavedFilter(filter.id);
      expect(fetched).toBeNull();
    });

    it('is idempotent when deleting a non-existent filter', async () => {
      // Should not throw
      await store.deleteSavedFilter('no-such');
    });
  });
});

// =======================================================================
// Report records
// =======================================================================

describe('Report records', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  describe('createReportRecord', () => {
    it('persists a report record with all fields', async () => {
      const report = await store.createReportRecord(REPORT_INPUT);

      expect(report.id).toBeTypeOf('string');
      expect(report.reportType).toBe(REPORT_INPUT.reportType);
      expect(report.budgetId).toBe(REPORT_INPUT.budgetId);
      expect(report.filterId).toBeNull();
      expect(JSON.parse(report.config)).toEqual(REPORT_INPUT.config);
      expect(report.policyVersion).toBe(REPORT_INPUT.policyVersion);
      expect(report.generatedAt).toBeTypeOf('string');
      expect(report.expiresAt).toBeNull();
      expect(report.dataRef).toBe(REPORT_INPUT.dataRef);
    });

    it('accepts minimal input', async () => {
      const report = await store.createReportRecord({
        reportType: 'simple',
        config: { hello: 'world' },
        policyVersion: '2.0.0',
      });

      expect(report.budgetId).toBeNull();
      expect(report.filterId).toBeNull();
      expect(report.expiresAt).toBeNull();
      expect(report.dataRef).toBeNull();
    });
  });

  // =======================================================================
  // Get report record
  // =======================================================================

  describe('getReportRecord', () => {
    it('retrieves a report record by ID', async () => {
      const report = await store.createReportRecord(REPORT_INPUT);
      const fetched = await store.getReportRecord(report.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(report.id);
      expect(fetched!.reportType).toBe(REPORT_INPUT.reportType);
    });

    it('returns null for unknown ID', async () => {
      const fetched = await store.getReportRecord('nonexistent');
      expect(fetched).toBeNull();
    });
  });

  // =======================================================================
  // List report records
  // =======================================================================

  describe('listReportRecords', () => {
    it('returns all report records ordered by generation time descending', async () => {
      const r1 = await store.createReportRecord(REPORT_INPUT);
      tickSync();
      const r2 = await store.createReportRecord(REPORT_INPUT);

      const list = await store.listReportRecords();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(r2.id);
    });

    it('filters by budgetId', async () => {
      await store.createReportRecord({ ...REPORT_INPUT, reportType: 'alpha', budgetId: 'budget-alpha' });
      await store.createReportRecord({ ...REPORT_INPUT, reportType: 'beta', budgetId: 'budget-beta' });

      const alphaReports = await store.listReportRecords({ budgetId: 'budget-alpha' });
      expect(alphaReports).toHaveLength(1);
      expect(alphaReports[0].reportType).toBe('alpha');
    });

    it('filters by reportType', async () => {
      await store.createReportRecord(REPORT_INPUT);
      await store.createReportRecord({ ...REPORT_INPUT, reportType: 'transaction_audit' });

      const summaries = await store.listReportRecords({ reportType: 'budget_summary' });
      expect(summaries).toHaveLength(1);
    });
  });

  // =======================================================================
  // Expire report record
  // =======================================================================

  describe('expireReportRecord', () => {
    it('sets expiresAt to now', async () => {
      const report = await store.createReportRecord(REPORT_INPUT);
      expect(report.expiresAt).toBeNull();

      const expired = await store.expireReportRecord(report.id);
      expect(expired.expiresAt).toBeTypeOf('string');
    });

    it('is idempotent on already-expired records', async () => {
      const report = await store.createReportRecord(REPORT_INPUT);
      await store.expireReportRecord(report.id);

      // Second expire should not throw
      const expiredAgain = await store.expireReportRecord(report.id);
      expect(expiredAgain.expiresAt).toBeTypeOf('string');
    });

    it('throws for unknown report IDs', async () => {
      await expect(
        store.expireReportRecord('nonexistent'),
      ).rejects.toThrow();
    });
  });
});
