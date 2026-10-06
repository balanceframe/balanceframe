import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/representative.json';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { persistPendingReviewResult } from '../src/review-persistence.js';

const scope = { spaceId: 'rule-set-space', budgetId: 'rule-set-budget', connectionId: 'actual-rule-set-fixture' };
const ruleIds = Array.from({ length: 1000 }, (_, index) => `rule-${String(index).padStart(4, '0')}`);
const canonical = canonicalProtocolSnapshotSchema.parse(fixture);
const category = canonical.categories.find((row) => !row.deleted)!;
function source(count = 32) {
  return { transactions: Array.from({ length: count }, (_, index) => ({
    ...canonical.transactions[0]!, id: `rule-set-transaction-${String(index).padStart(3, '0')}`,
    categoryId: null, categoryName: null, payeeName: 'PRIVATE-FINANCIAL-FIXTURE',
    date: '2026-01-15', amount: { minorUnits: '-100', currency: 'USD' }, subtransactions: [],
  })) };
}
function result(snapshot = source(), ids = ruleIds) {
  return {
    nativeRuleBlocks: [{ ruleIds: ids }],
    nativeRuleParts: [{ blockIndexes: [0] }],
    nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
    candidates: snapshot.transactions.map((transaction) => ({
      source: 'native-rule' as const, transactionId: transaction.id,
      amount: { minorUnits: '100', currency: 'USD' }, payeeName: transaction.payeeName,
      date: transaction.date, reasons: [{ kind: 'uncategorized', details: 'Requires category review' }],
      proposedCategoryId: category.id, proposedCategoryName: category.name, ruleSetIndex: 0,
    })),
    uncategorizedCount: snapshot.transactions.length,
    totalUncategorizedAmount: { minorUnits: String(snapshot.transactions.length * 100), currency: 'USD' },
    oldestUncategorizedDate: '2026-01-15', healthState: 'healthy', blockers: [],
  };
}
function reference(value: unknown) {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'scoped' || !('id' in value) || typeof value.id !== 'string' ||
      !('scope' in value) || typeof value.scope !== 'object' || value.scope === null ||
      !('spaceId' in value.scope) || typeof value.scope.spaceId !== 'string' ||
      !('budgetId' in value.scope) || typeof value.scope.budgetId !== 'string' ||
      !('connectionId' in value.scope) || typeof value.scope.connectionId !== 'string')
    throw new Error('Missing scoped durable native rule-set reference');
  return { kind: 'scoped' as const, id: value.id, scope: { spaceId: value.scope.spaceId, budgetId: value.scope.budgetId, connectionId: value.scope.connectionId } };
}

let store: SqliteWorkflowStore;
beforeEach(() => { store = new SqliteWorkflowStore(':memory:'); });
afterEach(() => { store.close(); });

describe('complete scoped native Review rule-set persistence', () => {
  it('shares all matching IDs once across many native Review rows without inline JSON expansion', async () => {
    const snapshot = source();
    const analysis = result(snapshot);
    expect(await persistPendingReviewResult(store, scope.budgetId, analysis, snapshot, { scope, authorize: () => true })).toBe(32);
    const rows = await store.listReviewItems({ budgetId: scope.budgetId, limit: 1000 });
    expect(rows).toHaveLength(32);
    const ref = reference(rows[0]!.evidence.ruleSetRef);
    expect(ref.scope).toEqual(scope);
    expect(await store.getReviewRuleSet(ref)).toEqual(ruleIds);
    for (const row of rows) {
      expect(row.classifier).toBe('rule');
      expect(row.evidence.ruleSetRef).toEqual(ref);
      expect(row.evidence.ruleIds).toBeUndefined();
      expect(row.sourceTransaction).toMatchObject({ amount: { minorUnits: '100', currency: 'USD' } });
    }
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 1 });
    expect(JSON.stringify(rows)).not.toContain('rule-0999');
    expect(JSON.stringify(analysis).split('rule-0999')).toHaveLength(2);
    expect(await persistPendingReviewResult(store, scope.budgetId, analysis, snapshot, { scope, authorize: () => true })).toBe(32);
    expect(await store.listReviewItems({ budgetId: scope.budgetId, limit: 1000 })).toHaveLength(32);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 1 });
  });

  it('binds source revisions to exact Money and the full matching set, not result-local indexes', async () => {
    const snapshot = source(1);
    await persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot, { scope, authorize: () => true });
    const first = (await store.listReviewItems({ budgetId: scope.budgetId }))[0]!;
    const reordered = { ...result(snapshot), nativeRuleBlocks: [{ ruleIds: ['unrelated-rule'] }, { ruleIds }], nativeRuleParts: [{ blockIndexes: [0] }, { blockIndexes: [1] }], nativeRuleSets: [{ orPartIndexes: [1], andPartIndexes: [], categoryPartIndex: 1 }], candidates: result(snapshot).candidates };
    await persistPendingReviewResult(store, scope.budgetId, reordered, snapshot, { scope, authorize: () => true });
    expect((await store.listReviewItems({ budgetId: scope.budgetId }))[0]!.id).toBe(first.id);
    const changed = source(1);
    changed.transactions[0]!.amount.minorUnits = '-101';
    await persistPendingReviewResult(store, scope.budgetId, result(changed), changed, { scope, authorize: () => true });
    const second = (await store.listReviewItems({ budgetId: scope.budgetId })).find((row) => row.status !== 'superseded')!;
    expect(second.transactionVersion).toBe(first.transactionVersion + 1);
    expect(second.evidence.sourceRevision).not.toBe(first.evidence.sourceRevision);
    expect(second.evidence.ruleSetRef).toEqual(first.evidence.ruleSetRef);
    const fullChangedSet = [...ruleIds.slice(0, -1), 'rule-1000'];
    await persistPendingReviewResult(store, scope.budgetId, result(changed, fullChangedSet), changed, { scope, authorize: () => true });
    const third = (await store.listReviewItems({ budgetId: scope.budgetId })).find((row) => row.status !== 'superseded')!;
    expect(third.transactionVersion).toBe(second.transactionVersion + 1);
    expect(third.evidence.sourceRevision).not.toBe(second.evidence.sourceRevision);
    expect(await store.getReviewRuleSet(reference(third.evidence.ruleSetRef))).toEqual(fullChangedSet);
    const changedScope = { ...scope, connectionId: 'new-selected-actual-fixture' };
    await persistPendingReviewResult(store, scope.budgetId, result(changed, fullChangedSet), changed, { scope: changedScope, authorize: () => true });
    const fourth = (await store.listReviewItems({ budgetId: scope.budgetId })).find((row) => reference(row.evidence.ruleSetRef).scope.connectionId === changedScope.connectionId)!;
    expect(fourth.evidence.sourceRevision).not.toBe(third.evidence.sourceRevision);
    expect(reference(fourth.evidence.ruleSetRef).scope).toEqual(changedScope);
  });

  it('rolls back all shared provenance and Review rows when the final synchronous publication callback denies', async () => {
    const snapshot = source();
    let sawWriteTransaction = false;
    await expect(persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot, {
      scope, authorize: () => { sawWriteTransaction = store['db'].inTransaction; return false; },
    })).rejects.toThrow('Review publication authority changed');
    expect(sawWriteTransaction).toBe(true);
    expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 0 });
  });

  it.each([-1, 1, 0.5])('rejects candidate ruleSetIndex %s before writing any provenance', async (ruleSetIndex) => {
    const snapshot = source(1);
    const invalid = { ...result(snapshot), candidates: result(snapshot).candidates.map((row) => ({ ...row, ruleSetIndex })) };
    await expect(persistPendingReviewResult(store, scope.budgetId, invalid, snapshot, { scope, authorize: () => true })).rejects.toThrow();
    expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 0 });
  });

  it('refuses native provenance without a trusted selected connection namespace', async () => {
    const snapshot = source(1);
    await expect(persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot)).rejects.toThrow();
    expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
  });

  it('refuses a selected scope from another budget without persisting canonical facts', async () => {
    const snapshot = source(1);
    await expect(persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot, {
      scope: { ...scope, budgetId: 'other-budget' }, authorize: () => true,
    })).rejects.toThrow();
    expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
  });

  it.each(['applied', 'rejected', 'skipped'] as const)('fresh Sync creates scoped native evidence without reattributing or superseding historical %s history', async (status) => {
    const snapshot = source(1);
    const transaction = snapshot.transactions[0]!;
    const blockJson = JSON.stringify(ruleIds);
    const blockId = createHash('sha256').update(JSON.stringify(['review-rule-block', 'historical-unattributed', null, scope.budgetId, null])).update(blockJson).digest('hex');
    const partJson = JSON.stringify([blockId]);
    const partId = createHash('sha256').update(JSON.stringify(['review-rule-part', 'historical-unattributed', null, scope.budgetId, null])).update(partJson).digest('hex');
    const setJson = JSON.stringify({ orPartIds: [partId], andPartIds: [], categoryPartId: partId });
    const historicalRef = { kind: 'historical-unattributed' as const, budgetId: scope.budgetId,
      id: createHash('sha256').update(JSON.stringify(['review-rule-set', 'historical-unattributed', null, scope.budgetId, null])).update(setJson).digest('hex') };
    store['db'].prepare('INSERT INTO review_rule_blocks VALUES (?,?,?,?,?,?)')
      .run(blockId, 'historical-unattributed', null, scope.budgetId, null, blockJson);
    store['db'].prepare('INSERT INTO review_rule_parts VALUES (?,?,?,?,?,?)')
      .run(partId, 'historical-unattributed', null, scope.budgetId, null, partJson);
    store['db'].prepare(`INSERT INTO review_rule_sets(kind,space_id,budget_id,connection_id,id,expression_json)
      VALUES ('historical-unattributed',NULL,?,NULL,?,?)`).run(scope.budgetId, historicalRef.id, setJson);
    expect(await store.getReviewRuleSet(historicalRef)).toEqual(ruleIds);
    const historical = await store.createReviewItem({
      budgetId: scope.budgetId, transactionId: transaction.id, categoryId: category.id, classifier: 'rule',
      transactionVersion: 1, evidence: { sourceRevision: 'legacy-source-revision', ruleSetRef: historicalRef, money: transaction.amount },
      provenance: 'Preserved unattributed native fixture history',
    });
    store['db'].prepare('UPDATE review_items SET status=? WHERE id=?').run(status, historical.id);
    const before = await store.getReviewItem(historical.id);
    await persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot, { scope, authorize: () => true });
    const rows = await store.listReviewItems({ budgetId: scope.budgetId });
    expect(rows).toHaveLength(2);
    expect(await store.getReviewItem(historical.id)).toEqual(before);
    const current = rows.find((row) => row.id !== historical.id)!;
    expect(current).toMatchObject({ classifier: 'rule', transactionId: transaction.id, categoryId: category.id });
    expect(reference(current.evidence.ruleSetRef).scope).toEqual(scope);
    expect(current.evidence.sourceRevision).not.toBe('legacy-source-revision');
    expect(await store.getReviewRuleSet(reference(current.evidence.ruleSetRef))).toEqual(ruleIds);
  });

  it.each([
    ['applied', 'connectionId'], ['rejected', 'connectionId'], ['skipped', 'connectionId'],
    ['applied', 'spaceId'], ['rejected', 'spaceId'], ['skipped', 'spaceId'],
  ] as const)('preserves native %s history in another %s while creating a current scoped successor for identical IDs', async (status, field) => {
    const snapshot = source(1);
    const previousScope = { ...scope, [field]: `old-${field}` };
    await persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot, { scope: previousScope, authorize: () => true });
    const prior = (await store.listReviewItems({ budgetId: scope.budgetId }))[0]!;
    store['db'].prepare('UPDATE review_items SET status=? WHERE id=?').run(status, prior.id);
    const before = await store.getReviewItem(prior.id);
    await persistPendingReviewResult(store, scope.budgetId, result(snapshot), snapshot, { scope, authorize: () => true });
    const rows = await store.listReviewItems({ budgetId: scope.budgetId });
    expect(rows).toHaveLength(2);
    expect(await store.getReviewItem(prior.id)).toEqual(before);
    const current = rows.find((row) => row.id !== prior.id)!;
    expect(current).toMatchObject({ classifier: 'rule', transactionId: prior.transactionId, categoryId: prior.categoryId });
    expect(reference(current.evidence.ruleSetRef).scope).toEqual(scope);
    expect(current.evidence.sourceRevision).not.toBe(prior.evidence.sourceRevision);
    expect(await store.getReviewRuleSet(reference(current.evidence.ruleSetRef))).toEqual(ruleIds);
  });
});

describe('block-backed native Review application persistence', () => {
  it('carries common plus private matching IDs through unequal native outcomes without expanding durable sets', async () => {
    const snapshot = source();
    const analysis = {
      ...result(snapshot),
      nativeRuleBlocks: [{ ruleIds }, ...snapshot.transactions.map((_, index) => ({ ruleIds: [`unique-rule-${String(index).padStart(3, '0')}`] }))],
      nativeRuleParts: snapshot.transactions.map((_, index) => ({ blockIndexes: [0, index + 1] })),
      nativeRuleSets: snapshot.transactions.map((_, index) => ({ orPartIndexes: [index], andPartIndexes: [], categoryPartIndex: index })),
      candidates: result(snapshot).candidates.map((candidate, index) => ({ ...candidate, ruleSetIndex: index })),
    };
    expect(await persistPendingReviewResult(store, scope.budgetId, analysis, snapshot, { scope, authorize: () => true })).toBe(32);
    const rows = await store.listReviewItems({ budgetId: scope.budgetId, limit: 1000 });
    expect(rows).toHaveLength(32);
    expect(rows.every((row) => row.classifier === 'rule' && row.categoryId === category.id && row.evidence.ruleIds === undefined)).toBe(true);
    expect(JSON.stringify(analysis).split('rule-0999')).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('rule-0999');
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 33 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 32 });
    expect(JSON.stringify(store['db'].prepare('SELECT * FROM review_rule_sets').all())).not.toContain('rule-0999');
    const first = rows.find((row) => row.transactionId === snapshot.transactions[0]!.id)!;
    const last = rows.find((row) => row.transactionId === snapshot.transactions[31]!.id)!;
    expect(await store.getReviewRuleSet(reference(first.evidence.ruleSetRef))).toEqual([...ruleIds, 'unique-rule-000']);
    expect(await store.getReviewRuleSet(reference(last.evidence.ruleSetRef))).toEqual([...ruleIds, 'unique-rule-031']);
  });
});

describe('fixed posting native Review persistence', () => {
  it('forwards frozen OR/AND/category parts without inline or durable full-outcome expansion', async () => {
    const snapshot = source(2);
    const analysis = {
      ...result(snapshot),
      nativeRuleBlocks: [{ ruleIds }, { ruleIds: ['unique-rule-000'] }, { ruleIds: ['unique-rule-001'] }],
      nativeRuleParts: [{ blockIndexes: [0] }, { blockIndexes: [0, 1] }, { blockIndexes: [0, 2] }, { blockIndexes: [0, 1, 2] }],
      nativeRuleSets: [0, 1].map((index) => ({ orPartIndexes: [0, index + 1], andPartIndexes: [], categoryPartIndex: 3 })),
      candidates: result(snapshot).candidates.map((candidate, index) => ({ ...candidate, ruleSetIndex: index })),
    };
    expect(await persistPendingReviewResult(store, scope.budgetId, analysis, snapshot, { scope, authorize: () => true })).toBe(2);
    const rows = await store.listReviewItems({ budgetId: scope.budgetId });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.classifier === 'rule' && row.categoryId === category.id && row.evidence.ruleIds === undefined)).toBe(true);
    expect(JSON.stringify(analysis).split('rule-0999')).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('rule-0999');
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 3 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_parts').get()).toEqual({ count: 4 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 2 });
    for (const [index, transaction] of snapshot.transactions.entries()) {
      const row = rows.find((candidate) => candidate.transactionId === transaction.id)!;
      expect(await store.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toEqual([...ruleIds, `unique-rule-${String(index).padStart(3, '0')}`]);
    }
  });
});
