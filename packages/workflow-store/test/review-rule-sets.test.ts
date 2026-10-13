import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../../protocol/fixtures/representative.json';
import { SqliteWorkflowStore } from '../src/store.js';
import { createHash } from 'node:crypto';
import { migrateReviewRuleSets, migrateReviewRuleBlocks } from '../src/review-rule-sets.js';
import { canonicalProposalJson } from '../src/proposal.js';

const now = '2026-01-15T12:00:00.000Z';
const scope = { spaceId: 'rule-set-space', budgetId: 'rule-set-budget', connectionId: 'actual-rule-set-fixture' };
const ruleIds = ['rule-a', 'rule-b', 'rule-c'];
const transaction = fixture.transactions[0]!;
const signed = BigInt(transaction.amount.minorUnits);
const sourceTransaction = {
  id: transaction.id, accountId: transaction.accountId, categoryId: transaction.categoryId ?? null,
  direction: signed < 0n ? 'outgoing' as const : 'incoming' as const,
  amount: { minorUnits: (signed < 0n ? -signed : signed).toString(), currency: transaction.amount.currency },
};
function item(transactionId = transaction.id, budgetId = scope.budgetId) {
  return {
    budgetId, transactionId, sourceTransaction: { ...sourceTransaction, id: transactionId },
    categoryId: fixture.categories[0]!.id, classifier: 'rule', ruleSetIndex: 0,
    evidence: { sourceRevision: 'fixture-source-revision', payeeName: 'PRIVATE-PAYEE', money: transaction.amount },
    provenance: 'Actual synchronized snapshot deterministic analysis',
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
let directory: string;
let filename: string;
let store: SqliteWorkflowStore;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'bf-review-rule-sets-')); filename = join(directory, 'workflow.sqlite'); store = new SqliteWorkflowStore(filename); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
async function publish(owner = store, selected = scope, ids = ruleIds) {
  const rows = await owner.createReviewItems({ scope: selected, nativeRuleBlocks: [{ ruleIds: ids }], nativeRuleParts: [{ blockIndexes: [0] }], nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
    items: [item(`${selected.spaceId}/${selected.connectionId}/${ids.join(',')}`, selected.budgetId)], authorize: () => true });
  return { row: rows[0]!, ref: reference(rows[0]!.evidence.ruleSetRef) };
}

describe('scoped shared native Review provenance store', () => {
  it('interns a complete group once, storing only IDs and namespace in the shared table', async () => {
    const first = await publish();
    const repeated = await publish();
    expect(repeated.ref).toEqual(first.ref);
    expect(await store.getReviewRuleSet(first.ref)).toEqual(ruleIds);
    const persisted: unknown[] = store['db'].prepare('SELECT * FROM review_rule_sets').all();
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain('PRIVATE-PAYEE');
    expect(JSON.stringify(persisted)).not.toContain('minorUnits');
    expect(JSON.stringify(persisted)).not.toContain(transaction.accountId);
    expect(store['db'].prepare('PRAGMA table_info(review_rule_sets)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'space_id' }), expect.objectContaining({ name: 'budget_id' }),
      expect.objectContaining({ name: 'connection_id' }),
    ]));
    expect(Object.keys(persisted[0] as Record<string, unknown>).sort()).toEqual(['budget_id', 'connection_id', 'expression_json', 'id', 'kind', 'space_id']);
  });

  it.each(['spaceId', 'budgetId', 'connectionId'] as const)('cannot resolve a rule-set reference in another %s namespace', async (field) => {
    const original = await publish();
    const otherScope = { ...scope, [field]: `other-${field}` };
    expect(await store.getReviewRuleSet({ ...original.ref, scope: otherScope })).toBeNull();
    const other = await publish(store, otherScope);
    expect(other.ref.scope).toEqual(otherScope);
    expect(await store.getReviewRuleSet(original.ref)).toEqual(ruleIds);
    expect(await store.getReviewRuleSet(other.ref)).toEqual(ruleIds);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 2 });
  });

  it('binds the durable ID to every matching rule, including the last ID', async () => {
    const first = await publish();
    const changed = await publish(store, scope, ['rule-a', 'rule-b', 'rule-d']);
    expect(changed.ref.id).not.toBe(first.ref.id);
    expect(await store.getReviewRuleSet(first.ref)).toEqual(ruleIds);
    expect(await store.getReviewRuleSet(changed.ref)).toEqual(['rule-a', 'rule-b', 'rule-d']);
  });

  it('resolves and hashes shared IDs independently of candidate count and fences the whole batch a constant number of times', async () => {
    let reads = 0;
    let authorizations = 0;
    const ids = Array.from({ length: 1000 }, (_, index) => `rule-${String(index).padStart(4, '0')}`);
    for (const [index, value] of ids.entries()) Object.defineProperty(ids, index, { get: () => { reads++; return value; } });
    const rows = await store.createReviewItems({
      scope, nativeRuleBlocks: [{ ruleIds: ids }], nativeRuleParts: [{ blockIndexes: [0] }], nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
      items: Array.from({ length: 64 }, (_, index) => item(`batch-${index}`)),
      authorize: () => { authorizations++; return true; },
    });
    expect(rows).toHaveLength(64);
    // A few validation/serialization passes are fine; traversing 1000 IDs for each of 64 rows is not.
    expect(reads).toBeLessThan(16 * ids.length);
    expect(authorizations).toBeGreaterThan(0);
    expect(authorizations).toBeLessThanOrEqual(2);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 1 });
  });

  it('rolls back new groups and every Review row on final callback denial while preserving prior groups', async () => {
    const prior = await publish();
    const priorActions = await store.getReviewActions(prior.row.id);
    let checkedInsideTransaction = false;
    await expect(store.createReviewItems({ scope, nativeRuleBlocks: [{ ruleIds: ['rule-new'] }], nativeRuleParts: [{ blockIndexes: [0] }], nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
      items: [{ ...item(prior.row.transactionId), transactionVersion: 2 }, item('denied-b')], authorize: () => {
        checkedInsideTransaction = store['db'].inTransaction;
        return false;
      },
    })).rejects.toThrow('Review publication authority changed');
    expect(checkedInsideTransaction).toBe(true);
    expect((await store.listReviewItems({ budgetId: scope.budgetId })).map((row) => row.id)).toEqual([prior.row.id]);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 1 });
    expect(await store.getReviewRuleSet(prior.ref)).toEqual(ruleIds);
    expect(await store.getReviewActions(prior.row.id)).toEqual(priorActions);
    expect(await store.getReviewItem(prior.row.id)).toMatchObject({ status: prior.row.status, version: prior.row.version });
  });

  it('does not let an invalid later source row partially publish the first row or shared group', async () => {
    await expect(store.createReviewItems({ scope, nativeRuleBlocks: [{ ruleIds }], nativeRuleParts: [{ blockIndexes: [0] }], nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }], items: [item('valid-first'), {
      ...item('invalid-second'), sourceTransaction: { ...sourceTransaction, id: 'wrong-source-id' },
    }], authorize: () => true })).rejects.toThrow('Invalid canonical review source authority');
    expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 0 });
  });

  it.each([
    ['scoped', null, null],
    ['scoped', scope.spaceId, null],
    ['historical-unattributed', scope.spaceId, null],
    ['historical-unattributed', null, scope.connectionId],
  ])('enforces all-or-none scope columns for %s groups (%s, %s)', (kind, spaceId, connectionId) => {
    expect(() => store['db'].prepare(`INSERT INTO review_rule_sets(kind,space_id,budget_id,connection_id,id,expression_json)
      VALUES (?,?,?,?,?,?)`).run(kind, spaceId, scope.budgetId, connectionId, 'invalid-scope-group', JSON.stringify({ orPartIds: [], andPartIds: [], categoryPartId: 'invalid-scope-part' }))).toThrow();
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 0 });
  });

  it('upgrades a populated pre-rule-set database append-only without inventing legacy native namespace', async () => {
    const legacyPath = join(directory, 'legacy.sqlite');
    const legacy = new Database(legacyPath);
    const migrations = SqliteWorkflowStore['MIGRATIONS'];
    const firstRuleSetMigration = migrations.indexOf(migrateReviewRuleSets);
    if (firstRuleSetMigration < 0) throw new Error('Flat v25 migration is not registered');
    legacy.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    legacy.transaction(() => {
      for (const [index, migration] of migrations.slice(0, firstRuleSetMigration).entries()) {
        migration(legacy);
        legacy.prepare('INSERT INTO schema_version VALUES (?,?)').run(index + 1, now);
      }
      const insert = legacy.prepare(`INSERT INTO review_items(id,budget_id,transaction_id,category_id,classifier,status,evidence,provenance,source_transaction_json,created_at,updated_at,superseded_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const status of ['discovered', 'suggestion_generated', 'pending_review', 'approved', 'correcting', 'applying', 'apply_failed', 'applied', 'rejected', 'skipped', 'superseded']) {
        const id = `legacy-${status}`;
        insert.run(id, scope.budgetId, id, fixture.categories[0]!.id, 'rule', status,
          JSON.stringify({ ruleIds: ['rule-c', 'rule-a', 'rule-b'], sourceRevision: 'legacy-source-revision', money: transaction.amount, payeeName: 'PRIVATE-PAYEE' }),
          'Historical native fixture', JSON.stringify({ ...sourceTransaction, id }), now, now,
          status === 'superseded' ? 'Existing historical supersession' : null);
        legacy.prepare('INSERT INTO review_actions(id,review_item_id,from_status,to_status,actor,reason,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(`action-${id}`, id, 'discovered', status, 'fixture', 'Existing history', now);
      }
    })();
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_rule_sets'").get()).toBeUndefined();
    legacy.close();
    const upgraded = new SqliteWorkflowStore(legacyPath);
    try {
      const rows = await upgraded.listReviewItems({ budgetId: scope.budgetId });
      expect(rows).toHaveLength(11);
      const pending = rows.find((row) => row.id === 'legacy-pending_review')!;
      expect(pending.status).toBe('superseded');
      expect(pending.supersededReason).toMatch(/native|rule|scope|sync/iu);
      expect(rows.find((row) => row.id === 'legacy-applied')!.status).toBe('applied');
      expect(rows.find((row) => row.id === 'legacy-superseded')).toMatchObject({ status: 'superseded', supersededReason: 'Existing historical supersession' });
      for (const status of ['discovered', 'suggestion_generated', 'pending_review', 'approved', 'correcting', 'applying', 'apply_failed'])
        expect(rows.find((row) => row.id === `legacy-${status}`)).toMatchObject({ status: 'superseded' });
      for (const status of ['rejected', 'skipped']) {
        const terminal = rows.find((row) => row.id === `legacy-${status}`)!;
        expect(terminal.status).toBe(status);
        await expect(upgraded.undoInternalReviewTransition(terminal.id, 'fixture', 'Cannot reopen unattributed native evidence', terminal.version)).rejects.toThrow();
        expect((await upgraded.getReviewItem(terminal.id))!.status).toBe(status);
      }
      for (const row of rows) {
        expect(row.evidence.ruleIds).toBeUndefined();
        expect(row.evidence.ruleSetRef).toMatchObject({ kind: 'historical-unattributed', budgetId: scope.budgetId });
        expect(row.evidence.money).toEqual(transaction.amount);
        expect(row.sourceTransaction).toEqual({ ...sourceTransaction, id: row.transactionId });
        expect(await upgraded.getReviewActions(row.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `action-${row.id}`, reason: 'Existing history' }),
        ]));
      }
      expect(upgraded['db'].prepare('SELECT kind,space_id,budget_id,connection_id,rule_ids_json FROM review_rule_blocks').all()).toEqual([
        { kind: 'historical-unattributed', space_id: null, budget_id: scope.budgetId, connection_id: null, rule_ids_json: JSON.stringify(ruleIds) },
      ]);
      const historicalRef = pending.evidence.ruleSetRef as { kind: 'historical-unattributed'; budgetId: string; id: string };
      expect(await upgraded.getReviewRuleSet(historicalRef)).toEqual(ruleIds);
      expect(await upgraded.getReviewRuleSet({ kind: 'scoped', scope, id: historicalRef.id })).toBeNull();
      expect(upgraded['db'].prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: migrations.length });
      const current = await publish(upgraded);
      expect(await upgraded.getReviewRuleSet(current.ref)).toEqual(ruleIds);
      expect(current.row.evidence.sourceRevision).not.toBe('legacy-source-revision');
      const terminal = rows.find((row) => row.id === 'legacy-rejected')!;
      // Even a stale backup/old writer that restores actionable status cannot turn a historical reference into authority.
      upgraded['db'].prepare("UPDATE review_items SET status='pending_review' WHERE id=?").run(terminal.id);
      const preconditions = { reviewId: terminal.id, reviewProvenance: {
        budgetId: terminal.budgetId, transactionId: terminal.transactionId, categoryId: terminal.categoryId,
        status: 'pending_review', version: terminal.version,
      } };
      upgraded['db'].prepare(`INSERT INTO action_proposals(id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at,payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('historical-proposal', 'set_category', scope.budgetId, 'fixture-historical-hash', 'fixture-policy',
          JSON.stringify(preconditions), '2098-01-01T00:00:00.000Z', 'fixture', 'Historical native fixture', now,
          JSON.stringify({ kind: 'set_category', transactionId: terminal.transactionId, categoryId: terminal.categoryId }));
      expect(await upgraded.isProposalReviewProvenanceCurrent('historical-proposal')).toBe(false);
      upgraded['db'].prepare("UPDATE review_items SET status='rejected' WHERE id=?").run(terminal.id);
      upgraded['db'].pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = join(directory, 'historical-backup.sqlite');
      copyFileSync(legacyPath, backupPath);
      const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'historical-restored.sqlite'), now, authorize: () => true });
      try {
        expect(await restored.getReviewRuleSet(historicalRef)).toEqual(ruleIds);
        expect(await restored.getReviewItem(terminal.id)).toMatchObject({ status: 'rejected', evidence: { ruleSetRef: historicalRef } });
        await expect(restored.undoInternalReviewTransition(terminal.id, 'fixture', 'Historical restore cannot reopen', terminal.version)).rejects.toThrow();
      } finally { restored.close(); }
    } finally { upgraded.close(); }
  });

  it('restores complete linked native IDs with financial Review facts without granting source disclosure', async () => {
    const published = await publish();
    store['db'].pragma('wal_checkpoint(TRUNCATE)');
    const backupPath = join(directory, 'backup.sqlite');
    copyFileSync(filename, backupPath);
    const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'restored.sqlite'), now, authorize: () => true });
    try {
      expect(await restored.getReviewRuleSet(published.ref)).toEqual(ruleIds);
      expect(await restored.getReviewItem(published.row.id)).toMatchObject({ sourceTransaction: published.row.sourceTransaction, evidence: { ruleSetRef: published.ref } });
      expect(await restored.getReviewRuleSet({ ...published.ref, scope: { ...scope, connectionId: 'different-actual' } })).toBeNull();
    } finally { restored.close(); }
  });

  it('merchant opt-out and deletion never erase native ledger provenance or financial Review facts', async () => {
    const native = await publish();
    const expectedGeneration = store.merchant.generation(scope);
    store.merchant.purgeBudget({ scope, now, expectedGeneration, authorize: () => true });
    expect(await store.getReviewRuleSet(native.ref)).toEqual(ruleIds);
    expect(await store.getReviewItem(native.row.id)).toMatchObject({ sourceTransaction: native.row.sourceTransaction, evidence: { ruleSetRef: native.ref } });
  });

  it('deletes all selected-budget historical connection groups but preserves other budgets and spaces', async () => {
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'review-rule-set-lifecycle' });
    await store.finalizeBootstrap({ claimId: 'review-rule-set-lifecycle', ownerUserId: 'owner' });
    const auth = { method: 'human-session' as const, actorId: 'owner', sessionId: 'review-rule-set-owner', reauthenticatedAt: now };
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Rule sets', kind: 'shared', now, auth });
    store.governance.bindBudget({ spaceId: space.id, budgetId: scope.budgetId, now, auth });
    const selected = { ...scope, spaceId: space.id };
    const selectedGroup = await publish(store, selected);
    const historical = await publish(store, { ...selected, connectionId: 'historical-actual' });
    const otherBudget = await publish(store, { ...selected, budgetId: 'other-budget' });
    const otherSpace = await publish(store, { ...selected, spaceId: 'other-space' });
    await store.deleteScopeData('workflow', { spaceId: space.id, budgetId: scope.budgetId, actorId: 'owner' });
    expect(await store.getReviewRuleSet(selectedGroup.ref)).toBeNull();
    expect(await store.getReviewRuleSet(historical.ref)).toBeNull();
    expect(await store.getReviewRuleSet(otherBudget.ref)).toEqual(ruleIds);
    expect(await store.getReviewRuleSet(otherSpace.ref)).toEqual(ruleIds);
    expect(await store.getReviewItem(otherSpace.row.id)).not.toBeNull();
    expect(await store.getReviewItem(selectedGroup.row.id)).toBeNull();
  });
});

const commonBlockIds = Array.from({ length: 1000 }, (_, index) => `common-rule-${String(index).padStart(4, '0')}`);
function overlappingInput(selected = scope, count = 32) {
  return {
    scope: selected,
    nativeRuleBlocks: [{ ruleIds: commonBlockIds }, ...Array.from({ length: count }, (_, index) => ({ ruleIds: [`private-rule-${String(index).padStart(3, '0')}`] }))],
    nativeRuleParts: Array.from({ length: count }, (_, index) => ({ blockIndexes: [0, index + 1] })),
    nativeRuleSets: Array.from({ length: count }, (_, index) => ({ orPartIndexes: [index], andPartIndexes: [] as number[][], categoryPartIndex: index })),
    items: Array.from({ length: count }, (_, index) => ({ ...item(`overlap-${String(index).padStart(3, '0')}`, selected.budgetId), ruleSetIndex: index })),
    authorize: () => true,
  };
}

describe('overlapping unequal native Review rule sets', () => {
  it('persists one common ID block across unequal complete sets without flat durable or Review fanout', async () => {
    const input = overlappingInput();
    const rows = await store.createReviewItems(input);
    expect(rows).toHaveLength(32);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 33 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 32 });
    const blocks = store['db'].prepare('SELECT * FROM review_rule_blocks').all();
    const sets = store['db'].prepare('SELECT * FROM review_rule_sets').all();
    expect(JSON.stringify(blocks).split('common-rule-0999')).toHaveLength(2);
    expect(JSON.stringify(sets)).not.toContain('common-rule-0999');
    expect(JSON.stringify(rows)).not.toContain('common-rule-0999');
    expect(JSON.stringify([blocks, sets, rows.map((row) => row.evidence.ruleSetRef)]).length).toBeLessThan(100_000);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({ classifier: 'rule', transactionId: input.items[index]!.transactionId });
      expect(row.evidence.ruleIds).toBeUndefined();
      expect(await store.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toEqual([...commonBlockIds, `private-rule-${String(index).padStart(3, '0')}`]);
    }
  });

  it('keeps set content identities and source revisions stable when both table enumerations are reordered', async () => {
    const input = overlappingInput();
    const first = await store.createReviewItems(input);
    const blockCount = input.nativeRuleBlocks.length;
    const reordered = {
      ...input,
      nativeRuleBlocks: [...input.nativeRuleBlocks].reverse(),
      nativeRuleParts: [...input.nativeRuleParts].reverse().map((part) => ({
        blockIndexes: part.blockIndexes.map((index) => blockCount - 1 - index).sort((left, right) => left - right),
      })),
      nativeRuleSets: [...input.nativeRuleSets].reverse().map((set) => ({
        orPartIndexes: set.orPartIndexes.map((index) => input.nativeRuleParts.length - 1 - index),
        andPartIndexes: [], categoryPartIndex: input.nativeRuleParts.length - 1 - set.categoryPartIndex,
      })),
      items: [...input.items].reverse().map((row) => ({ ...row, ruleSetIndex: input.nativeRuleSets.length - 1 - row.ruleSetIndex })),
    };
    const refreshed = await store.createReviewItems(reordered);
    const byTransaction = new Map(first.map((row) => [row.transactionId, row]));
    for (const row of refreshed) expect(row).toMatchObject({
      id: byTransaction.get(row.transactionId)!.id,
      transactionVersion: byTransaction.get(row.transactionId)!.transactionVersion,
      evidence: { sourceRevision: byTransaction.get(row.transactionId)!.evidence.sourceRevision, ruleSetRef: byTransaction.get(row.transactionId)!.evidence.ruleSetRef },
    });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 33 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 32 });
    const extended = await store.createReviewItems({ ...input, nativeRuleBlocks: [...input.nativeRuleBlocks, { ruleIds: ['unreferenced-rule'] }] });
    for (const row of extended) expect(row).toMatchObject({
      id: byTransaction.get(row.transactionId)!.id,
      evidence: { sourceRevision: byTransaction.get(row.transactionId)!.evidence.sourceRevision, ruleSetRef: byTransaction.get(row.transactionId)!.evidence.ruleSetRef },
    });
  });

  it('changes only the affected complete set revision when one private block changes', async () => {
    const input = overlappingInput();
    const first = await store.createReviewItems(input);
    const changed = { ...input, nativeRuleBlocks: input.nativeRuleBlocks.map((block, index) => index === 8 ? { ruleIds: ['private-rule-007-new'] } : block) };
    const refreshed = await store.createReviewItems(changed);
    for (const [index, row] of refreshed.entries()) {
      if (index === 7) {
        expect(row.transactionVersion).toBe(first[index]!.transactionVersion + 1);
        expect(row.evidence.sourceRevision).not.toBe(first[index]!.evidence.sourceRevision);
        expect(await store.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toEqual([...commonBlockIds, 'private-rule-007-new']);
      } else {
        expect(row.id).toBe(first[index]!.id);
        expect(row.evidence.sourceRevision).toBe(first[index]!.evidence.sourceRevision);
      }
    }
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 34 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 33 });
  });

  it('rolls back all new block, set, Review, and supersession writes on final authority denial', async () => {
    const input = overlappingInput();
    const first = await store.createReviewItems(input);
    const actions = await store.getReviewActions(first[0]!.id);
    let checkedInTransaction = false;
    const changed = {
      ...input,
      nativeRuleBlocks: input.nativeRuleBlocks.map((block, index) => index === 1 ? { ruleIds: ['private-rule-000-new'] } : block),
      authorize: () => { checkedInTransaction = store['db'].inTransaction; return false; },
    };
    await expect(store.createReviewItems(changed)).rejects.toThrow('Review publication authority changed');
    expect(checkedInTransaction).toBe(true);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 33 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 32 });
    expect(await store.getReviewItem(first[0]!.id)).toEqual(first[0]);
    expect(await store.getReviewActions(first[0]!.id)).toEqual(actions);
  });

  it.each(['missing-block', 'duplicate-block-index', 'overlapping-block-ids', 'inline-rule-ids'] as const)(
    'rejects malformed block provenance without partially publishing: %s', async (failure) => {
      const input = overlappingInput(scope, 2);
      if (failure === 'missing-block') input.nativeRuleParts[0]!.blockIndexes = [0, 99];
      if (failure === 'duplicate-block-index') input.nativeRuleParts[0]!.blockIndexes = [0, 0];
      if (failure === 'overlapping-block-ids') input.nativeRuleBlocks[1]!.ruleIds = [commonBlockIds[0]!];
      const value = failure === 'inline-rule-ids'
        ? { ...input, nativeRuleSets: input.nativeRuleSets.map((set) => ({ ...set, ruleIds: commonBlockIds })) }
        : input;
      await expect(store.createReviewItems(value)).rejects.toThrow();
      expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
      expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 0 });
      expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 0 });
    },
  );

  it('accepts generic legacy provenance beyond the merchant-only 100000-rule bound', async () => {
    const input = overlappingInput(scope, 1);
    input.nativeRuleBlocks = [
      { ruleIds: Array.from({ length: 100_000 }, (_, index) => `rule-${String(index).padStart(6, '0')}`) },
      { ruleIds: ['overflow-rule'] },
    ];
    const rows = await store.createReviewItems(input);
    expect((await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef)))!).toHaveLength(100001);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 2 });
  });

  it('resolves a selected complete set in native scalar order rather than JavaScript UTF-16 order', async () => {
    const bmp = String.fromCodePoint(0xe000), astral = String.fromCodePoint(0x10000);
    const rows = await store.createReviewItems({
      scope, nativeRuleBlocks: [{ ruleIds: [bmp] }, { ruleIds: [astral] }],
      nativeRuleParts: [{ blockIndexes: [0, 1] }],
      nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }], items: [{ ...item('scalar-native'), ruleSetIndex: 0 }], authorize: () => true,
    });
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toEqual([bmp, astral]);
  });

  it.each(['content', 'scope'] as const)('fails closed resolving a selected set whose backing block %s no longer matches its content identity', async (failure) => {
    const rows = await store.createReviewItems(overlappingInput(scope, 1));
    if (failure === 'content') store['db'].prepare('UPDATE review_rule_blocks SET rule_ids_json=? WHERE rule_ids_json=?')
      .run(JSON.stringify([commonBlockIds[0]!]), JSON.stringify(['private-rule-000']));
    else store['db'].prepare('UPDATE review_rule_blocks SET connection_id=? WHERE rule_ids_json=?')
      .run('different-actual', JSON.stringify(['private-rule-000']));
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toBeNull();
  });

  it('permits historical overlap across stored revisions but refuses a selected set with duplicate expanded IDs', async () => {
    const first = await store.createReviewItems(overlappingInput(scope, 1));
    const ids = [...commonBlockIds, 'private-rule-000'];
    const changed = await store.createReviewItems({
      scope, nativeRuleBlocks: [{ ruleIds: ids }], nativeRuleParts: [{ blockIndexes: [0] }], nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
      items: [{ ...item('recompiled-source-block'), ruleSetIndex: 0 }], authorize: () => true,
    });
    expect(await store.getReviewRuleSet(reference(first[0]!.evidence.ruleSetRef))).toEqual(ids);
    expect(await store.getReviewRuleSet(reference(changed[0]!.evidence.ruleSetRef))).toEqual(ids);
    const records = store['db'].prepare('SELECT id,rule_ids_json FROM review_rule_blocks').all() as { id: string; rule_ids_json: string }[];
    const common = records.find((row) => row.rule_ids_json === JSON.stringify(commonBlockIds))!;
    const complete = records.find((row) => row.rule_ids_json === JSON.stringify(ids))!;
    const completePartId = createHash('sha256').update(JSON.stringify(['review-rule-part', 'scoped', scope.spaceId, scope.budgetId, scope.connectionId]))
      .update(JSON.stringify([complete.id])).digest('hex');
    const validJson = JSON.stringify({ orPartIds: [completePartId], andPartIds: [], categoryPartId: completePartId });
    const validSetId = createHash('sha256').update(JSON.stringify(['review-rule-set', 'scoped', scope.spaceId, scope.budgetId, scope.connectionId])).update(validJson).digest('hex');
    expect(reference(changed[0]!.evidence.ruleSetRef).id).toBe(validSetId);
    const blockIds = [common.id, complete.id].sort();
    const partJson = JSON.stringify(blockIds);
    const partId = createHash('sha256').update(JSON.stringify(['review-rule-part', 'scoped', scope.spaceId, scope.budgetId, scope.connectionId])).update(partJson).digest('hex');
    store['db'].prepare(`INSERT INTO review_rule_parts VALUES (?,'scoped',?,?,?,?)`).run(partId, scope.spaceId, scope.budgetId, scope.connectionId, partJson);
    const json = JSON.stringify({ orPartIds: [partId], andPartIds: [], categoryPartId: partId });
    const id = createHash('sha256').update(JSON.stringify(['review-rule-set', 'scoped', scope.spaceId, scope.budgetId, scope.connectionId])).update(json).digest('hex');
    store['db'].prepare(`INSERT INTO review_rule_sets(id,kind,space_id,budget_id,connection_id,expression_json)
      VALUES (?,'scoped',?,?,?,?)`).run(id, scope.spaceId, scope.budgetId, scope.connectionId, json);
    expect(await store.getReviewRuleSet({ kind: 'scoped', scope, id })).toBeNull();
  });

  it('isolates complete block-backed set references by space, budget, and connection and preserves both tables on restore', async () => {
    const rows = await store.createReviewItems(overlappingInput(scope, 2));
    const ref = reference(rows[0]!.evidence.ruleSetRef);
    for (const field of ['spaceId', 'budgetId', 'connectionId'] as const)
      expect(await store.getReviewRuleSet({ ...ref, scope: { ...scope, [field]: `other-${field}` } })).toBeNull();
    store['db'].pragma('wal_checkpoint(TRUNCATE)');
    const backupPath = join(directory, 'block-backup.sqlite');
    copyFileSync(filename, backupPath);
    const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'blocks-restored.sqlite'), now, authorize: () => true });
    try {
      expect(await restored.getReviewRuleSet(ref)).toEqual([...commonBlockIds, 'private-rule-000']);
      expect(await restored.getReviewItem(rows[0]!.id)).toEqual(rows[0]);
      expect(restored['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 3 });
      expect(restored['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 2 });
    } finally { restored.close(); }
  });

  it('deletes selected block-backed provenance independently of merchant state while preserving other namespace rows', async () => {
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'native-block-lifecycle' });
    await store.finalizeBootstrap({ claimId: 'native-block-lifecycle', ownerUserId: 'owner' });
    const auth = { method: 'human-session' as const, actorId: 'owner', sessionId: 'native-block-owner', reauthenticatedAt: now };
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Native blocks', kind: 'shared', now, auth });
    store.governance.bindBudget({ spaceId: space.id, budgetId: scope.budgetId, now, auth });
    const selected = { ...scope, spaceId: space.id };
    const own = await store.createReviewItems(overlappingInput(selected, 2));
    const other = await store.createReviewItems(overlappingInput({ ...selected, spaceId: 'other-space' }, 2));
    await store.deleteScopeData('workflow', { spaceId: space.id, budgetId: scope.budgetId, actorId: 'owner' });
    for (const row of own) {
      expect(await store.getReviewItem(row.id)).toBeNull();
      expect(await store.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toBeNull();
    }
    for (const [index, row] of other.entries()) {
      expect(await store.getReviewItem(row.id)).toEqual(row);
      expect(await store.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toEqual([...commonBlockIds, `private-rule-${String(index).padStart(3, '0')}`]);
    }
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 3 });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 2 });
  });

  it('appends v26 over a populated v25 flat database, preserving known attribution, all IDs, history, and restored/reopened references', async () => {
    const flatPath = join(directory, 'v25-flat.sqlite');
    const flat = new Database(flatPath);
    const migrations = SqliteWorkflowStore['MIGRATIONS'];
    const flatIndex = migrations.indexOf(migrateReviewRuleSets);
    if (flatIndex < 0) throw new Error('Flat v25 migration is not registered');
    flat.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    const legacyRows: Array<{ id: string; status: string; ids: string[]; ref: { kind: 'scoped'; scope: typeof scope; id: string } | { kind: 'historical-unattributed'; budgetId: string; id: string } }> = [];
    flat.transaction(() => {
      for (const [index, migration] of migrations.slice(0, flatIndex + 1).entries()) {
        migration(flat);
        flat.prepare('INSERT INTO schema_version VALUES (?,?)').run(index + 1, now);
      }
      const put = flat.prepare('INSERT INTO review_rule_sets(id,kind,space_id,budget_id,connection_id,rule_ids_json) VALUES (?,?,?,?,?,?)');
      const insert = flat.prepare(`INSERT INTO review_items(id,budget_id,transaction_id,category_id,classifier,status,evidence,provenance,source_transaction_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const [index, status] of ['pending_review', 'applied', 'rejected', 'skipped', 'superseded'].entries()) {
        const ids = [...commonBlockIds, `private-rule-${index}`];
        const historical = status === 'rejected' || status === 'superseded';
        const prefix = historical ? ['historical-unattributed', scope.budgetId] : ['scoped', scope.spaceId, scope.budgetId, scope.connectionId];
        const oldId = createHash('sha256').update(JSON.stringify(prefix)).update(JSON.stringify(ids)).digest('hex');
        const ref = historical ? { kind: 'historical-unattributed' as const, budgetId: scope.budgetId, id: oldId } : { kind: 'scoped' as const, scope, id: oldId };
        put.run(oldId, ref.kind, historical ? null : scope.spaceId, scope.budgetId, historical ? null : scope.connectionId, JSON.stringify(ids));
        const id = `v25-${status}`;
        insert.run(id, scope.budgetId, id, fixture.categories[0]!.id, 'rule', status,
          JSON.stringify({ ruleSetRef: ref, sourceRevision: `v25-source-${status}`, money: transaction.amount, payeeName: 'PRIVATE-PAYEE' }),
          'Actual v25 flat native provenance', JSON.stringify({ ...sourceTransaction, id }), now, now);
        flat.prepare('INSERT INTO review_actions(id,review_item_id,from_status,to_status,actor,reason,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(`action-${id}`, id, 'discovered', status, 'fixture', 'Existing v25 history', now);
        legacyRows.push({ id, status, ids, ref });
      }
    })();
    flat.close();
    const upgraded = new SqliteWorkflowStore(flatPath);
    const refs: Array<{ kind: 'scoped'; scope: typeof scope; id: string } | { kind: 'historical-unattributed'; budgetId: string; id: string }> = [];
    try {
      for (const legacy of legacyRows) {
        const row = (await upgraded.getReviewItem(legacy.id))!;
        expect(row).toMatchObject({ status: legacy.status, sourceTransaction: { ...sourceTransaction, id: legacy.id }, evidence: { money: transaction.amount } });
        const ref = row.evidence.ruleSetRef as typeof legacy.ref;
        expect(ref.kind).toBe(legacy.ref.kind);
        expect(ref.id).not.toBe(legacy.ref.id);
        if (ref.kind === 'scoped') expect(ref.scope).toEqual(scope);
        else expect(ref.budgetId).toBe(scope.budgetId);
        expect(await upgraded.getReviewRuleSet(ref)).toEqual(legacy.ids);
        expect(await upgraded.getReviewRuleSet(legacy.ref)).toBeNull();
        expect(await upgraded.getReviewActions(row.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `action-${row.id}`, reason: 'Existing v25 history' }),
        ]));
        if (ref.kind === 'historical-unattributed' && legacy.status === 'rejected')
          await expect(upgraded.undoInternalReviewTransition(row.id, 'fixture', 'Cannot revive historical matching', row.version)).rejects.toThrow();
        refs.push(ref);
      }
      expect(upgraded['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 5 });
      expect(JSON.stringify(upgraded['db'].prepare('SELECT * FROM review_rule_sets').all())).not.toContain('common-rule-0999');
      expect(upgraded['db'].prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: migrations.length });
      upgraded['db'].pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = join(directory, 'v25-upgraded-backup.sqlite');
      copyFileSync(flatPath, backupPath);
      const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'v25-restored.sqlite'), now, authorize: () => true });
      try {
        for (const [index, legacy] of legacyRows.entries()) {
          expect(await restored.getReviewRuleSet(refs[index]!)).toEqual(legacy.ids);
          expect(await restored.getReviewItem(legacy.id)).toMatchObject({ status: legacy.status, evidence: { ruleSetRef: refs[index] } });
        }
      } finally { restored.close(); }
    } finally { upgraded.close(); }
    const reopened = new SqliteWorkflowStore(flatPath);
    try {
      for (const [index, legacy] of legacyRows.entries()) {
        expect(await reopened.getReviewRuleSet(refs[index]!)).toEqual(legacy.ids);
        expect(await reopened.getReviewItem(legacy.id)).toMatchObject({ status: legacy.status, evidence: { ruleSetRef: refs[index] } });
      }
    } finally { reopened.close(); }
  });
});

describe('v25 captured proposal provenance migration', () => {
  it('invalidates captured native proposal provenance and Review expected versions while preserving approval snapshots across restore', async () => {
    const flatPath = join(directory, 'v25-approved-proposal.sqlite');
    const flat = new Database(flatPath);
    const migrations = SqliteWorkflowStore['MIGRATIONS'];
    const flatIndex = migrations.indexOf(migrateReviewRuleSets);
    if (flatIndex < 0) throw new Error('Flat v25 migration is not registered');
    flat.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    flat.transaction(() => {
      for (const [index, migration] of migrations.slice(0, flatIndex + 1).entries()) {
        migration(flat);
        flat.prepare('INSERT INTO schema_version VALUES (?,?)').run(index + 1, now);
      }
    })();
    const oldId = createHash('sha256').update(JSON.stringify(['scoped', scope.spaceId, scope.budgetId, scope.connectionId]))
      .update(JSON.stringify(ruleIds)).digest('hex');
    flat.prepare('INSERT INTO review_rule_sets VALUES (?,?,?,?,?,?)')
      .run(oldId, 'scoped', scope.spaceId, scope.budgetId, scope.connectionId, JSON.stringify(ruleIds));
    flat.prepare(`INSERT INTO review_items(id,budget_id,transaction_id,category_id,classifier,status,evidence,provenance,source_transaction_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending_review',?,?,?,?,?)`).run('v25-approved-review', scope.budgetId, transaction.id, fixture.categories[0]!.id, 'rule',
        JSON.stringify({ ruleSetRef: { kind: 'scoped', scope, id: oldId }, sourceRevision: 'captured-v25-source-revision', money: transaction.amount }),
        'Actual v25 approved native snapshot', JSON.stringify(sourceTransaction), now, now);
    const captured = flat.prepare('SELECT version FROM review_items WHERE id=?').get('v25-approved-review') as { version: number };
    const preconditions = { reviewId: 'v25-approved-review', reviewSourceRevision: 'captured-v25-source-revision', reviewProvenance: {
      budgetId: scope.budgetId, transactionId: transaction.id, categoryId: fixture.categories[0]!.id, status: 'pending_review', version: captured.version,
    } };
    flat.prepare(`INSERT INTO action_proposals(id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('v25-approved-proposal', 'set_category', scope.budgetId, 'captured-v25-payload-hash', 'captured-v25-policy',
        JSON.stringify(preconditions), '2098-01-01T00:00:00.000Z', 'fixture', 'Immutable approved v25 snapshot', now,
        JSON.stringify({ kind: 'set_category', transactionId: transaction.id, categoryId: fixture.categories[0]!.id }));
    flat.prepare(`INSERT INTO proposal_approvals(id,proposal_id,payload_hash,actor_id,status,expires_at,created_at)
      VALUES (?,?,?,?,'active',?,?)`).run('v25-approval', 'v25-approved-proposal', 'captured-v25-payload-hash', 'fixture-approver', '2098-01-01T00:00:00.000Z', now);
    const immutableProposal = flat.prepare('SELECT * FROM action_proposals WHERE id=?').get('v25-approved-proposal');
    const immutableApproval = flat.prepare('SELECT * FROM proposal_approvals WHERE id=?').get('v25-approval');
    flat.close();
    const upgraded = new SqliteWorkflowStore(flatPath);
    try {
      expect(await upgraded.isProposalReviewProvenanceCurrent('v25-approved-proposal')).toBe(false);
      const row = (await upgraded.getReviewItem('v25-approved-review'))!;
      expect(row).toMatchObject({ status: 'pending_review', version: captured.version + 2, sourceTransaction, evidence: { money: transaction.amount } });
      expect(row.evidence.sourceRevision).not.toBe('captured-v25-source-revision');
      await expect(upgraded.transitionInternalReviewItem(row.id, { toStatus: 'rejected', actor: 'fixture', expectedVersion: captured.version }))
        .rejects.toThrow(/version/i);
      expect(upgraded['db'].prepare('SELECT * FROM action_proposals WHERE id=?').get('v25-approved-proposal')).toEqual(immutableProposal);
      expect(upgraded['db'].prepare('SELECT * FROM proposal_approvals WHERE id=?').get('v25-approval')).toEqual(immutableApproval);
      const recapturedVersion = { ...preconditions, reviewProvenance: { ...preconditions.reviewProvenance, version: row.version } };
      upgraded['db'].prepare(`INSERT INTO action_proposals(id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at,payload)
        SELECT 'v25-recaptured-version',operation,budget_id,'recaptured-version-hash',policy_version,?,expires_at,actor_id,provenance,created_at,payload
        FROM action_proposals WHERE id='v25-approved-proposal'`).run(JSON.stringify(recapturedVersion));
      expect(await upgraded.isProposalReviewProvenanceCurrent('v25-recaptured-version')).toBe(false);
      const sourceLess = { reviewId: preconditions.reviewId, reviewProvenance: recapturedVersion.reviewProvenance };
      upgraded['db'].prepare(`INSERT INTO action_proposals(id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at,payload)
        SELECT 'v25-source-less-contract',operation,budget_id,'source-less-contract-hash',policy_version,?,expires_at,actor_id,provenance,created_at,payload
        FROM action_proposals WHERE id='v25-approved-proposal'`).run(JSON.stringify(sourceLess));
      expect(await upgraded.isProposalReviewProvenanceCurrent('v25-source-less-contract')).toBe(true);
      upgraded['db'].pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = join(directory, 'v25-approved-backup.sqlite');
      copyFileSync(flatPath, backupPath);
      const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'v25-approved-restored.sqlite'), now, authorize: () => true });
      try {
        expect(await restored.isProposalReviewProvenanceCurrent('v25-approved-proposal')).toBe(false);
        expect(await restored.isProposalReviewProvenanceCurrent('v25-recaptured-version')).toBe(false);
        await expect(restored.transitionInternalReviewItem(row.id, { toStatus: 'rejected', actor: 'fixture', expectedVersion: captured.version }))
          .rejects.toThrow(/version/i);
        expect(restored['db'].prepare('SELECT * FROM action_proposals WHERE id=?').get('v25-approved-proposal')).toEqual(immutableProposal);
        expect(restored['db'].prepare('SELECT * FROM proposal_approvals WHERE id=?').get('v25-approval')).toEqual(immutableApproval);
      } finally { restored.close(); }
    } finally { upgraded.close(); }
  });
});

function postingInput(selected = scope, commonCount = 8) {
  const commonIds = Array.from({ length: commonCount }, (_, index) => `posting-common-${String(index).padStart(5, '0')}`);
  return {
    scope: selected,
    nativeRuleBlocks: [...commonIds.map((id) => ({ ruleIds: [id] })), { ruleIds: ['posting-private-000'] }, { ruleIds: ['posting-private-001'] }],
    nativeRuleParts: [
      { blockIndexes: commonIds.map((_, index) => index) },
      { blockIndexes: [0, commonCount] },
      { blockIndexes: [1, commonCount + 1] },
      { blockIndexes: Array.from({ length: commonCount + 2 }, (_, index) => index) },
    ],
    nativeRuleSets: [0, 1].map((index) => ({ orPartIndexes: [0, index + 1], andPartIndexes: [] as number[][], categoryPartIndex: 3 })),
    items: [0, 1].map((index) => ({ ...item(`posting-row-${index}`, selected.budgetId), ruleSetIndex: index })),
    authorize: () => true,
  };
}

describe('fixed literal posting native Review provenance', () => {
  it('stores one shared 50000-member OR posting and constant descriptors for unequal complete outcomes with intentional overlap', async () => {
    const input = postingInput(scope, 50000);
    const rows = await store.createReviewItems(input);
    expect(rows).toHaveLength(2);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_blocks').get()).toEqual({ count: 50002 });
    const parts = store['db'].prepare('SELECT block_ids_json FROM review_rule_parts').all() as { block_ids_json: string }[];
    expect(parts).toHaveLength(4);
    expect(parts.filter((part) => (JSON.parse(part.block_ids_json) as string[]).length === 50000)).toHaveLength(1);
    const sets = store['db'].prepare('SELECT * FROM review_rule_sets').all();
    expect(sets).toHaveLength(2);
    expect(JSON.stringify(sets).length).toBeLessThan(3000);
    expect(JSON.stringify(parts)).not.toContain('posting-common-49999');
    expect(JSON.stringify(sets)).not.toContain('posting-common-49999');
    expect(JSON.stringify(rows)).not.toContain('posting-common-49999');
    const commonIds = input.nativeRuleBlocks.slice(0, 50000).map((block) => block.ruleIds[0]!);
    for (const [index, row] of rows.entries())
      expect(await store.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toEqual([...commonIds, `posting-private-${String(index).padStart(3, '0')}`]);
  });

  it('keeps content identities and source revisions stable after three-table reindexing and unrelated literal additions', async () => {
    const input = postingInput();
    for (const [index, set] of input.nativeRuleSets.entries())
      set.andPartIndexes = [[0, index + 1], [index + 1], [0, index + 1], [0, index + 1]];
    const first = await store.createReviewItems(input);
    const b = input.nativeRuleBlocks.length, p = input.nativeRuleParts.length, s = input.nativeRuleSets.length;
    const partRefs = (refs: number[]) => refs.map((index) => p - 1 - index).sort((left, right) => left - right);
    const reordered = {
      ...input,
      nativeRuleBlocks: [...input.nativeRuleBlocks].reverse(),
      nativeRuleParts: [...input.nativeRuleParts].reverse().map((part) => ({ blockIndexes: part.blockIndexes.map((index) => b - 1 - index).sort((left, right) => left - right) })),
      nativeRuleSets: [...input.nativeRuleSets].reverse().map((set) => ({
        orPartIndexes: partRefs(set.orPartIndexes), andPartIndexes: set.andPartIndexes.map(partRefs), categoryPartIndex: p - 1 - set.categoryPartIndex,
      })),
      items: [...input.items].reverse().map((row) => ({ ...row, ruleSetIndex: s - 1 - row.ruleSetIndex })),
    };
    const byTransaction = new Map(first.map((row) => [row.transactionId, row]));
    for (const row of await store.createReviewItems(reordered)) expect(row).toMatchObject({
      id: byTransaction.get(row.transactionId)!.id,
      evidence: { ruleSetRef: byTransaction.get(row.transactionId)!.evidence.ruleSetRef, sourceRevision: byTransaction.get(row.transactionId)!.evidence.sourceRevision },
    });
    const extended = {
      ...input, nativeRuleBlocks: [...input.nativeRuleBlocks, { ruleIds: ['posting-unreferenced'] }],
      nativeRuleParts: [...input.nativeRuleParts, { blockIndexes: [b] }],
    };
    for (const row of await store.createReviewItems(extended)) expect(row).toMatchObject({
      id: byTransaction.get(row.transactionId)!.id,
      evidence: { ruleSetRef: byTransaction.get(row.transactionId)!.evidence.ruleSetRef, sourceRevision: byTransaction.get(row.transactionId)!.evidence.sourceRevision },
    });
  });

  it('intersects four fixed union operands without turning absent AND into a wildcard', async () => {
    const input = postingInput();
    input.nativeRuleParts[1] = { blockIndexes: [8] };
    input.nativeRuleSets = [{ orPartIndexes: [], andPartIndexes: [[0, 1], [1], [0, 1], [0, 1]], categoryPartIndex: 3 }];
    input.items = [input.items[0]!];
    const rows = await store.createReviewItems(input);
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toEqual(['posting-private-000']);
    const orOnly = postingInput();
    orOnly.nativeRuleSets = [{ orPartIndexes: [1], andPartIndexes: [], categoryPartIndex: 3 }];
    orOnly.items = [{ ...orOnly.items[0]!, transactionId: 'posting-or-only', sourceTransaction: { ...sourceTransaction, id: 'posting-or-only' } }];
    const selected = await store.createReviewItems(orOnly);
    expect(await store.getReviewRuleSet(reference(selected[0]!.evidence.ruleSetRef))).toEqual(['posting-common-00000', 'posting-private-000']);
  });

  it('filters opposite-category matching IDs through the frozen category literal', async () => {
    const input = postingInput(scope, 4);
    input.nativeRuleParts[3] = { blockIndexes: [0, 2, 4] };
    const rows = await store.createReviewItems(input);
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toEqual(['posting-common-00000', 'posting-common-00002', 'posting-private-000']);
    expect(await store.getReviewRuleSet(reference(rows[1]!.evidence.ruleSetRef))).toEqual(['posting-common-00000', 'posting-common-00002']);
  });

  it.each(['missing-part', 'missing-category-part', 'part-missing-block', 'part-duplicate-block', 'and-two-fields', 'duplicate-operand-part', 'empty-filtered-result', 'empty-and-intersection', 'empty-expression', 'unused-set'] as const)(
    'rejects malformed or empty classified posting provenance atomically: %s', async (failure) => {
      const input = postingInput();
      if (failure === 'missing-part') input.nativeRuleSets[0]!.orPartIndexes = [0, 99];
      if (failure === 'missing-category-part') input.nativeRuleSets[0]!.categoryPartIndex = 99;
      if (failure === 'part-missing-block') input.nativeRuleParts[1]!.blockIndexes = [0, 99];
      if (failure === 'part-duplicate-block') input.nativeRuleParts[1]!.blockIndexes = [0, 0];
      if (failure === 'and-two-fields') input.nativeRuleSets[0]!.andPartIndexes = [[0], [1]];
      if (failure === 'duplicate-operand-part') input.nativeRuleSets[0]!.andPartIndexes = [[0, 0], [0], [0], [0]];
      if (failure === 'empty-filtered-result') input.nativeRuleSets[0] = { orPartIndexes: [1], andPartIndexes: [], categoryPartIndex: 2 };
      if (failure === 'empty-and-intersection') input.nativeRuleSets[0] = { orPartIndexes: [], andPartIndexes: [[1], [2], [1], [2]], categoryPartIndex: 3 };
      if (failure === 'empty-expression') input.nativeRuleSets[0] = { orPartIndexes: [], andPartIndexes: [], categoryPartIndex: 3 };
      if (failure === 'unused-set') input.items[1]!.ruleSetIndex = 0;
      await expect(store.createReviewItems(input)).rejects.toThrow();
      expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
      for (const table of ['review_rule_blocks', 'review_rule_parts', 'review_rule_sets'])
        expect(store['db'].prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    },
  );

  it('rejects a part table exceeding the descriptor-derived 13-times-set bound rather than adding a 100000-part limit', async () => {
    const input = postingInput(scope, 27);
    input.nativeRuleParts = Array.from({ length: 27 }, (_, index) => ({ blockIndexes: [index] }));
    input.nativeRuleSets = [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }, { orPartIndexes: [1], andPartIndexes: [], categoryPartIndex: 1 }];
    await expect(store.createReviewItems(input)).rejects.toThrow();
    expect(await store.listReviewItems({ budgetId: scope.budgetId })).toEqual([]);
  });

  it('allows generic admitted native IDs wider and more numerous than merchant-only source limits', async () => {
    const ids = Array.from({ length: 100001 }, (_, index) => `generic-rule-${String(index).padStart(6, '0')}`);
    ids.push(`zz-wide-${'x'.repeat(300)}`);
    const rows = await store.createReviewItems({
      scope, nativeRuleBlocks: [{ ruleIds: ids }], nativeRuleParts: [{ blockIndexes: [0] }],
      nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
      items: [item('generic-admitted-posting')], authorize: () => true,
    });
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toEqual(ids);
  });

  it('rolls back all three provenance tables and source supersession history when final authority changes', async () => {
    const input = postingInput();
    const first = await store.createReviewItems(input);
    const actions = await store.getReviewActions(first[0]!.id);
    const changed = { ...input, nativeRuleBlocks: input.nativeRuleBlocks.map((block, index) => index === 8 ? { ruleIds: ['posting-private-000-new'] } : block),
      authorize: () => { expect(store['db'].inTransaction).toBe(true); return false; } };
    await expect(store.createReviewItems(changed)).rejects.toThrow('Review publication authority changed');
    for (const [table, count] of [['review_rule_blocks', 10], ['review_rule_parts', 4], ['review_rule_sets', 2]] as const)
      expect(store['db'].prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count });
    expect(await store.getReviewItem(first[0]!.id)).toEqual(first[0]);
    expect(await store.getReviewActions(first[0]!.id)).toEqual(actions);
  });

  it.each(['scope', 'content'] as const)('fails selected resolution closed when an intersected or filtered literal part loses %s identity', async (failure) => {
    const input = postingInput();
    const rows = await store.createReviewItems(input);
    if (failure === 'scope') store['db'].prepare('UPDATE review_rule_parts SET connection_id=?').run('different-actual-source');
    else store['db'].prepare('UPDATE review_rule_parts SET block_ids_json=?').run('[]');
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toBeNull();
  });

  it('canonicalizes a syntactically empty AND operand to absent contribution without changing OR identity', async () => {
    const input = postingInput();
    const first = await store.createReviewItems(input);
    const noncanonical = { ...input, nativeRuleSets: input.nativeRuleSets.map((set) => ({
      ...set, andPartIndexes: [[0], [], [0], [0]],
    })) };
    const second = await store.createReviewItems(noncanonical);
    for (const [index, row] of second.entries()) expect(row).toMatchObject({
      id: first[index]!.id, evidence: { ruleSetRef: first[index]!.evidence.ruleSetRef, sourceRevision: first[index]!.evidence.sourceRevision },
    });
  });

  it('resolves intentional overlapping posting unions in native scalar order, including non-BMP IDs', async () => {
    const bmp = String.fromCodePoint(0xe000), astral = String.fromCodePoint(0x10000);
    const rows = await store.createReviewItems({
      scope, nativeRuleBlocks: [{ ruleIds: [bmp] }, { ruleIds: [astral] }],
      nativeRuleParts: [{ blockIndexes: [0] }, { blockIndexes: [0, 1] }],
      nativeRuleSets: [{ orPartIndexes: [0, 1], andPartIndexes: [], categoryPartIndex: 1 }],
      items: [item('posting-scalar-native')], authorize: () => true,
    });
    expect(await store.getReviewRuleSet(reference(rows[0]!.evidence.ruleSetRef))).toEqual([bmp, astral]);
  });
});

describe('fixed posting provenance scope lifecycle and v26 migration', () => {
  it('isolates all three provenance tables through restore and selected workflow deletion independently of merchant state', async () => {
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'posting-lifecycle' });
    await store.finalizeBootstrap({ claimId: 'posting-lifecycle', ownerUserId: 'owner' });
    const auth = { method: 'human-session' as const, actorId: 'owner', sessionId: 'posting-owner', reauthenticatedAt: now };
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Posting rules', kind: 'shared', now, auth });
    store.governance.bindBudget({ spaceId: space.id, budgetId: scope.budgetId, now, auth });
    const selected = { ...scope, spaceId: space.id };
    const first = await store.createReviewItems(postingInput(selected));
    const otherScope = { ...selected, spaceId: 'other-posting-space' };
    const other = await store.createReviewItems(postingInput(otherScope));
    const ref = reference(first[0]!.evidence.ruleSetRef), otherRef = reference(other[0]!.evidence.ruleSetRef);
    const ids = await store.getReviewRuleSet(ref);
    expect(ids).toEqual([...Array.from({ length: 8 }, (_, index) => `posting-common-${String(index).padStart(5, '0')}`), 'posting-private-000']);
    expect(await store.getReviewRuleSet({ ...ref, scope: otherScope })).toBeNull();
    store.merchant.purgeBudget({ scope: selected, now, expectedGeneration: store.merchant.generation(selected), authorize: () => true });
    expect(await store.getReviewRuleSet(ref)).toEqual(ids);
    store['db'].pragma('wal_checkpoint(TRUNCATE)');
    const backupPath = join(directory, 'posting-backup.sqlite');
    copyFileSync(filename, backupPath);
    const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'posting-restored.sqlite'), now, authorize: () => true });
    try {
      expect(await restored.getReviewRuleSet(ref)).toEqual(ids);
      expect(await restored.getReviewRuleSet(otherRef)).toEqual(ids);
      expect(await restored.getReviewItem(first[0]!.id)).toMatchObject({ sourceTransaction: first[0]!.sourceTransaction, evidence: { ruleSetRef: ref } });
      await restored.deleteScopeData('workflow', { spaceId: selected.spaceId, budgetId: selected.budgetId, actorId: 'owner' });
      expect(await restored.getReviewRuleSet(ref)).toBeNull();
      expect(await restored.getReviewRuleSet(otherRef)).toEqual(ids);
      expect(await restored.getReviewItem(other[0]!.id)).not.toBeNull();
      for (const [table, count] of [['review_rule_blocks', 10], ['review_rule_parts', 4], ['review_rule_sets', 2]] as const)
        expect(restored['db'].prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count });
    } finally { restored.close(); }
  });

  it('appends v27 over real v26 literal sets without reinterpreting predicates or mutating approved snapshots, preserving restore and reopen', async () => {
    const oldPath = join(directory, 'populated-v26.sqlite');
    const old = new Database(oldPath);
    const migrations = SqliteWorkflowStore['MIGRATIONS'];
    const v26 = migrations.indexOf(migrateReviewRuleBlocks);
    if (v26 < 0) throw new Error('Block v26 migration is not registered');
    old.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    old.transaction(() => {
      for (const [index, migration] of migrations.slice(0, v26 + 1).entries()) {
        migration(old);
        old.prepare('INSERT INTO schema_version VALUES (?,?)').run(index + 1, now);
      }
    })();
    const legacy: Array<{ id: string; status: string; ids: string[]; ref: { kind: 'scoped'; scope: typeof scope; id: string } | { kind: 'historical-unattributed'; budgetId: string; id: string }; version: number }> = [];
    for (const [index, status] of ['pending_review', 'approved', 'applied', 'rejected', 'superseded'].entries()) {
      const historical = status === 'rejected' || status === 'superseded';
      const kind = historical ? 'historical-unattributed' : 'scoped';
      const namespace = [kind, historical ? null : scope.spaceId, scope.budgetId, historical ? null : scope.connectionId];
      const privateIds = [`private-rule-${index}`];
      const blockIds = [commonBlockIds, privateIds].map((ids) => {
        const json = JSON.stringify(ids);
        const id = createHash('sha256').update(JSON.stringify(['review-rule-block', ...namespace])).update(json).digest('hex');
        old.prepare('INSERT INTO review_rule_blocks VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
          .run(id, ...namespace, json);
        return id;
      }).sort();
      const json = JSON.stringify(blockIds);
      const setId = createHash('sha256').update(JSON.stringify(['review-rule-set', ...namespace])).update(json).digest('hex');
      old.prepare('INSERT INTO review_rule_sets VALUES (?,?,?,?,?,?)').run(setId, ...namespace, json);
      const ref = historical ? { kind: 'historical-unattributed' as const, budgetId: scope.budgetId, id: setId } : { kind: 'scoped' as const, scope, id: setId };
      const id = `v26-${status}`;
      old.prepare(`INSERT INTO review_items(id,budget_id,transaction_id,category_id,classifier,status,evidence,provenance,source_transaction_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope.budgetId, id, fixture.categories[0]!.id, 'rule', status,
          JSON.stringify({ ruleSetRef: ref, sourceRevision: `v26-source-${status}`, money: transaction.amount }), 'Literal v26 native history',
          JSON.stringify({ ...sourceTransaction, id }), now, now);
      old.prepare('INSERT INTO review_actions(id,review_item_id,from_status,to_status,actor,reason,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(`action-${id}`, id, 'discovered', status, 'fixture', 'Immutable v26 history', now);
      const row = old.prepare('SELECT version FROM review_items WHERE id=?').get(id) as { version: number };
      legacy.push({ id, status, ids: [...commonBlockIds, ...privateIds], ref, version: row.version });
    }
    const pending = legacy[0]!;
    const preconditions = { reviewId: pending.id, reviewSourceRevision: 'v26-source-pending_review', reviewProvenance: {
      budgetId: scope.budgetId, transactionId: pending.id, categoryId: fixture.categories[0]!.id, status: 'pending_review', version: pending.version,
    } };
    old.prepare(`INSERT INTO action_proposals(id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('v26-approved-proposal', 'set_category', scope.budgetId, 'v26-payload-hash', 'v26-policy', JSON.stringify(preconditions),
        '2098-01-01T00:00:00.000Z', 'fixture', 'Immutable v26 snapshot', now,
        JSON.stringify({ kind: 'set_category', transactionId: pending.id, categoryId: fixture.categories[0]!.id }));
    old.prepare(`INSERT INTO proposal_approvals(id,proposal_id,payload_hash,actor_id,status,expires_at,created_at)
      VALUES (?,?,?,?,'active',?,?)`).run('v26-approval', 'v26-approved-proposal', 'v26-payload-hash', 'fixture-approver', '2098-01-01T00:00:00.000Z', now);
    const proposal = old.prepare('SELECT * FROM action_proposals WHERE id=?').get('v26-approved-proposal');
    const approval = old.prepare('SELECT * FROM proposal_approvals WHERE id=?').get('v26-approval');
    old.close();
    const upgraded = new SqliteWorkflowStore(oldPath);
    const refs: Array<(typeof legacy)[number]['ref']> = [];
    try {
      for (const prior of legacy) {
        const row = (await upgraded.getReviewItem(prior.id))!;
        expect(row).toMatchObject({ status: prior.status, version: prior.version + 1, sourceTransaction: { ...sourceTransaction, id: prior.id }, evidence: { money: transaction.amount } });
        const ref = row.evidence.ruleSetRef as typeof prior.ref;
        expect(ref.kind).toBe(prior.ref.kind);
        expect(ref.id).not.toBe(prior.ref.id);
        if (ref.kind === 'scoped') {
          expect(ref.scope).toEqual(scope);
          expect(row.evidence.sourceRevision).not.toBe(`v26-source-${prior.status}`);
        } else expect(ref.budgetId).toBe(scope.budgetId);
        expect(await upgraded.getReviewRuleSet(ref)).toEqual(prior.ids);
        expect(await upgraded.getReviewRuleSet(prior.ref)).toBeNull();
        expect(await upgraded.getReviewActions(row.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: `action-${row.id}`, reason: 'Immutable v26 history' })]));
        refs.push(ref);
      }
      expect(await upgraded.isProposalReviewProvenanceCurrent('v26-approved-proposal')).toBe(false);
      await expect(upgraded.transitionInternalReviewItem(pending.id, { toStatus: 'rejected', actor: 'fixture', expectedVersion: pending.version })).rejects.toThrow(/version/i);
      expect(upgraded['db'].prepare('SELECT * FROM action_proposals WHERE id=?').get('v26-approved-proposal')).toEqual(proposal);
      expect(upgraded['db'].prepare('SELECT * FROM proposal_approvals WHERE id=?').get('v26-approval')).toEqual(approval);
      expect(upgraded['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_parts').get()).toEqual({ count: 5 });
      expect(JSON.stringify(upgraded['db'].prepare('SELECT * FROM review_rule_sets').all())).not.toContain('common-rule-0999');
      upgraded['db'].pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = join(directory, 'v26-posting-backup.sqlite');
      copyFileSync(oldPath, backupPath);
      const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'v26-posting-restored.sqlite'), now, authorize: () => true });
      try {
        for (const [index, prior] of legacy.entries()) expect(await restored.getReviewRuleSet(refs[index]!)).toEqual(prior.ids);
        expect(await restored.isProposalReviewProvenanceCurrent('v26-approved-proposal')).toBe(false);
        expect(restored['db'].prepare('SELECT * FROM action_proposals WHERE id=?').get('v26-approved-proposal')).toEqual(proposal);
        expect(restored['db'].prepare('SELECT * FROM proposal_approvals WHERE id=?').get('v26-approval')).toEqual(approval);
      } finally { restored.close(); }
    } finally { upgraded.close(); }
    const reopened = new SqliteWorkflowStore(oldPath);
    try {
      for (const [index, prior] of legacy.entries()) expect(await reopened.getReviewRuleSet(refs[index]!)).toEqual(prior.ids);
      expect(await reopened.isProposalReviewProvenanceCurrent('v26-approved-proposal')).toBe(false);
    } finally { reopened.close(); }
  });
});

describe('compact native rule-set metadata admission', () => {
  it('denies missing references and returns exact stored scope without expanding shared provenance', async () => {
    expect(store.getReviewRuleSetMetadata('f'.repeat(64))).toBeNull();
    const rows = await store.createReviewItems(postingInput());
    const ref = reference(rows[0]!.evidence.ruleSetRef);
    store.getReviewRuleSet = () => { throw new Error('Bulk metadata must not expand complete provenance'); };
    expect(store.getReviewRuleSetMetadata(ref.id)).toEqual(ref);
    for (const key of ['spaceId', 'budgetId', 'connectionId'] as const)
      expect(store.getReviewRuleSetMetadata(ref.id)).not.toEqual({ ...ref, scope: { ...ref.scope, [key]: `wrong-${key}` } });
    expect(store.getReviewRuleSetMetadata('missing-reference')).toBeNull();
  });
});

describe('retained native migration row financial revision binding', () => {
  function savedFinancialRows(version: 25 | 26, priorRevision: string | undefined) {
    const path = join(directory, `financial-v${version}.sqlite`);
    const old = new Database(path);
    const migrations = SqliteWorkflowStore['MIGRATIONS'];
    const last = migrations.indexOf(version === 25 ? migrateReviewRuleSets : migrateReviewRuleBlocks);
    if (last < 0) throw new Error('Retained native migration is not registered');
    old.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    old.transaction(() => {
      for (const [index, migration] of migrations.slice(0, last + 1).entries()) {
        migration(old);
        old.prepare('INSERT INTO schema_version VALUES (?,?)').run(index + 1, now);
      }
    })();
    const namespace = ['scoped', scope.spaceId, scope.budgetId, scope.connectionId];
    const idsJson = JSON.stringify(ruleIds);
    let setJson = idsJson;
    let setId = createHash('sha256').update(JSON.stringify(namespace)).update(setJson).digest('hex');
    if (version === 26) {
      const blockId = createHash('sha256').update(JSON.stringify(['review-rule-block', ...namespace])).update(idsJson).digest('hex');
      old.prepare('INSERT INTO review_rule_blocks VALUES (?,?,?,?,?,?)').run(blockId, ...namespace, idsJson);
      setJson = JSON.stringify([blockId]);
      setId = createHash('sha256').update(JSON.stringify(['review-rule-set', ...namespace])).update(setJson).digest('hex');
    }
    old.prepare('INSERT INTO review_rule_sets VALUES (?,?,?,?,?,?)').run(setId, ...namespace, setJson);
    const ref = { kind: 'scoped' as const, scope, id: setId };
    const rows = ['approved-finance', 'different-money', 'different-target', 'missing-source'].map((suffix, index) => {
      const id = `v${version}-${suffix}`;
      const minorUnits = index === 1 ? '250' : '100';
      const money = { minorUnits: signed < 0n ? `-${minorUnits}` : minorUnits, currency: transaction.amount.currency };
      const source = index === 3 ? null : {
        ...sourceTransaction, id,
        categoryId: index === 2 ? fixture.categories[1]!.id : sourceTransaction.categoryId,
        amount: { minorUnits, currency: money.currency },
      };
      const targetId = index === 2 ? fixture.categories[1]!.id : fixture.categories[0]!.id;
      const evidence = { ruleSetRef: ref, ...(priorRevision === undefined ? {} : { sourceRevision: priorRevision }),
        money, payeeName: 'Retained canonical fixture payee', date: '2026-01-15' };
      const status = index === 0 ? 'approved' : 'pending_review';
      old.prepare(`INSERT INTO review_items(id,budget_id,transaction_id,category_id,classifier,status,evidence,provenance,source_transaction_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope.budgetId, id, targetId, 'rule', status, JSON.stringify(evidence),
          'Retained immutable financial fixture', source === null ? null : canonicalProposalJson(source), now, now);
      old.prepare('INSERT INTO review_actions(id,review_item_id,from_status,to_status,actor,reason,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(`history-${id}`, id, 'pending_review', status, 'fixture', 'Immutable saved financial history', now);
      const { version: capturedVersion } = old.prepare('SELECT version FROM review_items WHERE id=?').get(id) as { version: number };
      return { id, source, targetId, evidence, status, version: capturedVersion };
    });
    const approved = rows[0]!;
    const preconditions = { reviewId: approved.id, ...(priorRevision === undefined ? {} : { reviewSourceRevision: priorRevision }),
      reviewProvenance: { budgetId: scope.budgetId, transactionId: approved.id, categoryId: approved.targetId, status: approved.status, version: approved.version } };
    old.prepare(`INSERT INTO action_proposals(id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('financial-approved-proposal', 'set_category', scope.budgetId, 'saved-financial-payload', 'saved-policy',
        canonicalProposalJson(preconditions), '2098-01-01T00:00:00.000Z', 'fixture', 'Immutable financial proposal', now,
        canonicalProposalJson({ kind: 'set_category', transactionId: approved.id, categoryId: approved.targetId }));
    old.prepare(`INSERT INTO proposal_approvals(id,proposal_id,payload_hash,actor_id,status,expires_at,created_at)
      VALUES (?,?,?,?,'active',?,?)`).run('financial-approval', 'financial-approved-proposal', 'saved-financial-payload', 'fixture-approver', '2098-01-01T00:00:00.000Z', now);
    const proposal = old.prepare('SELECT * FROM action_proposals WHERE id=?').get('financial-approved-proposal');
    const approval = old.prepare('SELECT * FROM proposal_approvals WHERE id=?').get('financial-approval');
    const history = old.prepare('SELECT * FROM review_actions ORDER BY id').all();
    old.close();
    return { path, rows, proposal, approval, history };
  }

  it.each([
    [25, 'shared'], [25, 'absent'], [26, 'shared'], [26, 'absent'],
  ] as const)('binds migrated native revisions to each retained row financial facts (v%s, old %s)', async (version, revision) => {
    const saved = savedFinancialRows(version, revision === 'shared' ? 'identical-old-financial-revision' : undefined);
    const upgraded = new SqliteWorkflowStore(saved.path);
    try {
      const revisions: unknown[] = [];
      for (const prior of saved.rows.filter((row) => row.source !== null)) {
        const row = (await upgraded.getReviewItem(prior.id))!;
        const ref = reference(row.evidence.ruleSetRef);
        const source = prior.source!;
        const expected = createHash('sha256').update(canonicalProposalJson([
          [source.id, source.accountId, source.categoryId, null, prior.evidence.payeeName, prior.evidence.date, prior.evidence.money],
          prior.targetId, scope, ref.id,
        ])).digest('hex');
        expect(row.evidence.sourceRevision).toBe(expected);
        if (prior.id.endsWith('different-money')) {
          expect(source.amount.minorUnits).toBe('250');
          const unchangedMoney = { ...prior.evidence.money, minorUnits: signed < 0n ? '-100' : '100' };
          const sameSourceDifferentMoney = createHash('sha256').update(canonicalProposalJson([
            [source.id, source.accountId, source.categoryId, null, prior.evidence.payeeName, prior.evidence.date, unchangedMoney],
            prior.targetId, scope, ref.id,
          ])).digest('hex');
          expect(row.evidence.sourceRevision).not.toBe(sameSourceDifferentMoney);
        }
        if (prior.id.endsWith('different-target')) {
          expect(row.categoryId).toBe(fixture.categories[1]!.id);
          const sameSourceDifferentTarget = createHash('sha256').update(canonicalProposalJson([
            [source.id, source.accountId, source.categoryId, null, prior.evidence.payeeName, prior.evidence.date, prior.evidence.money],
            fixture.categories[0]!.id, scope, ref.id,
          ])).digest('hex');
          expect(row.evidence.sourceRevision).not.toBe(sameSourceDifferentTarget);
        }
        expect(row).toMatchObject({ status: prior.status, version: prior.version + (version === 25 ? 2 : 1),
          sourceTransaction: prior.source, categoryId: prior.targetId, evidence: { money: prior.evidence.money } });
        expect(await upgraded.getReviewRuleSet(ref)).toEqual(ruleIds);
        revisions.push(row.evidence.sourceRevision);
      }
      expect(new Set(revisions).size).toBe(3);
      expect(new Set(saved.rows.filter((row) => row.source !== null).map((row) => row.source!.id)).size).toBe(3);
      expect(await upgraded.isProposalReviewProvenanceCurrent('financial-approved-proposal')).toBe(false);
      expect(upgraded['db'].prepare('SELECT * FROM action_proposals WHERE id=?').get('financial-approved-proposal')).toEqual(saved.proposal);
      expect(upgraded['db'].prepare('SELECT * FROM proposal_approvals WHERE id=?').get('financial-approval')).toEqual(saved.approval);
      expect(upgraded['db'].prepare('SELECT * FROM review_actions ORDER BY id').all()).toEqual(saved.history);
    } finally { upgraded.close(); }
  });

  it.each([25, 26] as const)('does not manufacture financial revision authority for a retained v%s row without source JSON', async (version) => {
    const saved = savedFinancialRows(version, 'unusable-old-provenance-token');
    const upgraded = new SqliteWorkflowStore(saved.path);
    try {
      const missing = saved.rows.find((row) => row.source === null)!;
      const row = (await upgraded.getReviewItem(missing.id))!;
      expect(row.sourceTransaction).toBeNull();
      expect(row.evidence.sourceRevision).toBeUndefined();
      expect(await upgraded.getReviewRuleSet(reference(row.evidence.ruleSetRef))).toEqual(ruleIds);
      expect(row.evidence.money).toEqual(missing.evidence.money);
      expect(upgraded['db'].prepare('SELECT * FROM action_proposals WHERE id=?').get('financial-approved-proposal')).toEqual(saved.proposal);
      expect(upgraded['db'].prepare('SELECT * FROM proposal_approvals WHERE id=?').get('financial-approval')).toEqual(saved.approval);
    } finally { upgraded.close(); }
  });
});
