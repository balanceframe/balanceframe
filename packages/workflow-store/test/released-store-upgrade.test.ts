import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '../src/store.js';
import { migrateScopedProspectiveEffects, migrateSessionCompletion } from '../src/liquidity-migration.js';

const now = '2026-10-03T12:00:00.000Z';
const budgetId = 'synthetic-upgrade-budget';

function schemaStructure(db: Database.Database) {
  const sorted = <T>(rows: T[]) => rows.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = db.prepare("SELECT name,type,wr,strict FROM pragma_table_list WHERE schema='main' AND type!='view' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; type: string; wr: number; strict: number }[];
  return tables.map((table) => {
    const foreignKeys = db.pragma(`foreign_key_list(${quote(table.name)})`) as Array<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>;
    const groups = new Map<number, Omit<(typeof foreignKeys)[number], 'id'>[]>();
    for (const { id, ...key } of foreignKeys) groups.set(id, [...(groups.get(id) ?? []), key]);
    const indexes = db.pragma(`index_list(${quote(table.name)})`) as { name: string; unique: number; origin: string; partial: number }[];
    return {
      ...table,
      columns: db.pragma(`table_xinfo(${quote(table.name)})`),
      indexes: sorted(indexes.map(({ name, unique, origin, partial }) => ({
        name: origin === 'c' ? name : null,
        unique, origin, partial,
        columns: db.pragma(`index_xinfo(${quote(name)})`),
        sql: (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { sql: string | null }).sql,
      }))),
      foreignKeys: sorted([...groups.values()].map((group) => group.sort((a, b) => a.seq - b.seq))),
    };
  });
}

function loadReleasedFixture(db: Database.Database, release: 'v0.4.0' | 'v0.8.0'): void {
  // A SQL dump can define referencing tables before their parents.
  db.pragma('foreign_keys = OFF');
  db.exec(readFileSync(new URL(`./fixtures/${release}-workflow.sql`, import.meta.url), 'utf8'));
  db.pragma('foreign_keys = ON');
}

describe('released persisted-store upgrades', () => {
  let directory: string | undefined;
  let store: SqliteWorkflowStore | undefined;

  afterEach(() => {
    store?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    store = undefined;
    directory = undefined;
    vi.useRealTimers();
  });

  it('migrates the released schema without changing historical data or reviving authority', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    directory = mkdtempSync(join(tmpdir(), 'released-workflow-upgrade-'));
    const filename = join(directory, 'workflow.db');
    const legacy = new Database(filename);
    let history: Array<{ name: string; rows: unknown[] }>;
    let originalVersions: unknown[];
    try {
      loadReleasedFixture(legacy, 'v0.8.0');
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 27 });
      originalVersions = legacy.prepare('SELECT * FROM schema_version ORDER BY version').all();
      const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_version' ORDER BY name").all() as { name: string }[];
      history = tables.map(({ name }) => ({ name, rows: legacy.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
      expect(legacy.prepare("SELECT COUNT(*) AS count FROM proposal_approvals WHERE status='expired'").get()).toEqual({ count: 1 });
      expect(legacy.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='transaction_evidence_documents'").get()).toEqual({ count: 0 });
    } finally {
      legacy.close();
    }
    const fresh = new SqliteWorkflowStore(':memory:');
    let expectedSchema: ReturnType<typeof schemaStructure>;
    try {
      expectedSchema = schemaStructure(fresh['db']);
    } finally {
      fresh.close();
    }

    const assertPreserved = async () => {
      const db = store!['db'];
      expect(schemaStructure(db)).toEqual(expectedSchema);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      for (const table of history) {
        expect(db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}" ORDER BY rowid`).all(), table.name).toEqual(table.rows);
      }
      expect(db.prepare('SELECT * FROM schema_version WHERE version<=27 ORDER BY version').all()).toEqual(originalVersions);
      expect(db.prepare('SELECT version FROM schema_version WHERE version>27 ORDER BY version').all()).toEqual(
        Array.from({ length: SqliteWorkflowStore['MIGRATIONS'].length - 27 }, (_, index) => ({ version: 28 + index })),
      );
      for (const table of ['transaction_evidence_documents', 'transaction_evidence_ledger_provenance', 'transaction_evidence_item_rules', 'transaction_evidence_session_associations']) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      const suggestion = await store!.getActiveSuggestion(budgetId, 'tx_000', 'synthetic-upgrade', 'v0.8.0');
      expect(suggestion).toMatchObject({ transactionId: 'tx_000', categoryId: 'cat_2', payload: { synthetic: true } });
      const reviews = await store!.listReviewItems({ budgetId });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ suggestionId: suggestion!.id, transactionId: 'tx_000' });
      expect(await store!.getActorMembership('synthetic-former-approver')).toMatchObject({ status: 'inactive', capabilities: [], scope: '' });
      const proposal = (await store!.listProposals({ budgetId }))[0];
      expect(proposal).toBeDefined();
      const approval = db.prepare('SELECT id FROM proposal_approvals WHERE proposal_id=?').get(proposal.id) as { id: string };
      expect(await store!.getApproval(approval.id)).toMatchObject({ status: 'expired', actorId: 'synthetic-former-approver', payloadHash: proposal.payloadHash });
      expect(await store!.findActiveApprovals(proposal.id)).toEqual([]);
      expect(store!.governance.getCurrentMembership({ actorId: 'synthetic-former-approver', spaceId: proposal.spaceId!, now })).toBeNull();
      expect(store!.governance.authorize({ actorId: 'synthetic-former-approver', spaceId: proposal.spaceId!, expectedPolicyVersion: '1', phase: 'approve', operation: 'set_category', required: [{ capability: 'categorization:approve', resourceKind: 'budget', resourceId: budgetId }], payload: { operations: [] }, now, auth: { method: 'session', actorId: 'synthetic-former-approver', sessionId: 'synthetic-current-session' } }).allowed).toBe(false);
      const view = db.prepare('SELECT view_id, membership_id FROM saved_views').get() as { view_id: string; membership_id: string };
      expect(await store!.getSavedView(view.view_id, { actorId: 'synthetic-owner', spaceId: proposal.spaceId!, budgetId, membershipId: view.membership_id })).toMatchObject({ name: 'Synthetic Upgrade View', scope: { categoryId: 'cat_2' } });
      const execution = await store!.getIdempotencyRecord('synthetic-completed-execution');
      expect(execution).toMatchObject({ status: 'succeeded', completed: true, serialisedResult: '{"synthetic":true,"verified":true}' });
      expect(await store!.createIdempotencyRecord({ idempotencyKey: execution!.idempotencyKey, proposalId: execution!.proposalId, operation: execution!.operation, serialisedEffect: execution!.serialisedEffect })).toEqual({ isOwner: false, record: execution });
    };

    store = new SqliteWorkflowStore(filename);
    await assertPreserved();
    const versions = store['db'].prepare('SELECT * FROM schema_version ORDER BY version').all();
    store.close();
    store = undefined;
    store = new SqliteWorkflowStore(filename);
    await assertPreserved();
    expect(store['db'].prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(versions);
  });

  function prepareV040(startingVersion: 11 | 12): string {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    directory = mkdtempSync(join(tmpdir(), 'released-v040-upgrade-'));
    const filename = join(directory, 'workflow.db');
    const legacy = new Database(filename);
    try {
      loadReleasedFixture(legacy, 'v0.4.0');
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 11 });
      if (startingVersion === 12) {
        // Reproduce a beta startup interrupted after committing migration 12.
        legacy.transaction(() => {
          migrateSessionCompletion(legacy);
          legacy.prepare('INSERT INTO schema_version VALUES (12,?)').run(now);
        })();
      }
      expect(legacy.prepare("SELECT name FROM sqlite_master WHERE name='liquidity_claim_metadata'").all()).toEqual([]);
    } finally {
      legacy.close();
    }
    return filename;
  }

  it.each([11, 12] as const)('upgrades populated v0.4.0 data at schema %s without inventing claim metadata or authority', async (startingVersion) => {
    const filename = prepareV040(startingVersion);
    const legacy = new Database(filename);
    const claims = legacy.prepare('SELECT * FROM liquidity_claims ORDER BY id').all();
    const revisions = legacy.prepare('SELECT * FROM liquidity_claim_revisions ORDER BY budget_id').all();
    const grants = legacy.prepare('SELECT actor_id,budget_id,capability,resource_kind,resource_id,granted FROM resource_grants ORDER BY capability').all();
    const originalVersions = legacy.prepare('SELECT * FROM schema_version ORDER BY version').all();
    legacy.close();
    expect(claims).toHaveLength(1);
    expect(revisions).toEqual([{ budget_id: budgetId, revision: 1 }]);
    expect(grants).toHaveLength(4);

    store = new SqliteWorkflowStore(filename);
    const fresh = new SqliteWorkflowStore(':memory:');
    try {
      const repairedSchema = (db: Database.Database) => db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('liquidity_claim_metadata','liquidity_claim_consumption_evidence_unique') ORDER BY name").all();
      const assertPreserved = async () => {
        const db = store!['db'];
        expect(schemaStructure(db)).toEqual(schemaStructure(fresh['db']));
        expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        expect(db.pragma('foreign_key_check')).toEqual([]);
        expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: SqliteWorkflowStore['MIGRATIONS'].length });
        expect(db.prepare('SELECT * FROM schema_version WHERE version<=? ORDER BY version').all(startingVersion)).toEqual(originalVersions);
        expect(db.prepare('SELECT * FROM liquidity_claims ORDER BY id').all()).toEqual(claims);
        expect(db.prepare('SELECT * FROM liquidity_claim_revisions ORDER BY budget_id').all()).toEqual(revisions);
        expect(db.prepare('SELECT * FROM liquidity_claim_metadata').all()).toEqual([]);
        expect(repairedSchema(db)).toEqual(repairedSchema(fresh['db']));
        expect(repairedSchema(db)).toHaveLength(2);
        expect(db.prepare('SELECT actor_id,budget_id,capability,resource_kind,resource_id,granted FROM resource_grants ORDER BY capability').all()).toEqual(grants);
        expect(db.prepare('SELECT space_id,membership_id FROM resource_grants').all()).toEqual(grants.map(() => ({ space_id: null, membership_id: null })));
        expect(db.prepare('SELECT * FROM spaces').all()).toEqual([]);
        expect(store!.liquidity.isAuthorized({ actorId: 'synthetic-owner', budgetId, capability: 'liquidity', resourceKind: 'account', resourceId: 'a_1', now })).toBe(false);
        expect(await store!.getActiveSuggestion(budgetId, 'tx_000', 'synthetic-upgrade', 'v0.4.0')).toMatchObject({ categoryId: 'cat_2', payload: { synthetic: true } });
      };
      await assertPreserved();
      const versions = store['db'].prepare('SELECT * FROM schema_version ORDER BY version').all();
      store.close();
      store = undefined;
      store = new SqliteWorkflowStore(filename);
      await assertPreserved();
      expect(store['db'].prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(versions);
    } finally {
      fresh.close();
    }
  });

  it('preserves existing metadata and its index while retaining migration 13 scope conversion', () => {
    store = new SqliteWorkflowStore(':memory:');
    const db = store['db'];
    const sourceId = 'synthetic-existing-source';
    const amount = { minorUnits: '1500', currency: 'USD' };
    const bundle = { id: 'synthetic-existing-claim', creationSnapshotId: 'synthetic-snapshot', creationPolicyVersion: '1', state: 'settled', expiresAt: '2027-01-01T12:00:00.000Z', initiated: false, effects: [{ kind: 'category', resourceId: 'cat_2', amount, economicObligationId: sourceId, categoryId: 'cat_2', includedInBalance: false, matchedTransactionIds: [] }] };
    const claim = { claimId: bundle.id, kind: 'reservation', sourceId, scope: { kind: 'category', id: 'cat_2' }, amount, status: 'consumed', effectiveFrom: now, expiresAt: bundle.expiresAt, visibility: 'visible', policyVersion: '1', snapshotId: bundle.creationSnapshotId };
    db.prepare('INSERT INTO liquidity_claims VALUES (?,?,?,?,?)').run(budgetId, bundle.id, 'prospective', bundle.id, JSON.stringify(bundle));
    db.prepare('INSERT INTO liquidity_claim_metadata (budget_id,claim_id,actor_id,mode,lifecycle_state,source_id,policy_version,snapshot_id,claim,created_at,updated_at,consumption_evidence_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(budgetId, bundle.id, 'synthetic-owner', 'block', 'consumed', sourceId, '1', bundle.creationSnapshotId, JSON.stringify(claim), now, now, 'synthetic-consumption-evidence');
    db.prepare('INSERT INTO liquidity_claim_revisions VALUES (?,?)').run(budgetId, 7);
    const metadata = db.prepare('SELECT * FROM liquidity_claim_metadata').all();
    const structure = schemaStructure(db);
    const migrate = db.transaction(() => migrateScopedProspectiveEffects(db));
    migrate();
    expect(db.prepare('SELECT * FROM liquidity_claim_metadata').all()).toEqual(metadata);
    expect(schemaStructure(db)).toEqual(structure);
    expect(JSON.parse((db.prepare('SELECT bundle FROM liquidity_claims').get() as { bundle: string }).bundle)).toEqual({ ...bundle, effects: [{ ...bundle.effects[0], economicObligationId: `${sourceId}:category:cat_2`, sourceEconomicObligationId: sourceId }] });
    expect(db.prepare('SELECT revision FROM liquidity_claim_revisions').get()).toEqual({ revision: 8 });
    const converted = db.prepare('SELECT * FROM liquidity_claims').all();
    migrate();
    expect(db.prepare('SELECT * FROM liquidity_claims').all()).toEqual(converted);
    expect(db.prepare('SELECT * FROM liquidity_claim_metadata').all()).toEqual(metadata);
    expect(db.prepare('SELECT revision FROM liquidity_claim_revisions').get()).toEqual({ revision: 8 });
    expect(schemaStructure(db)).toEqual(structure);
  });

  it('rolls back the prerequisite and version marker if migration 13 fails afterward', () => {
    const filename = prepareV040(12);
    const malformed = new Database(filename);
    malformed.exec('ALTER TABLE liquidity_claims RENAME COLUMN bundle TO broken_bundle');
    const claims = malformed.prepare('SELECT * FROM liquidity_claims').all();
    malformed.close();
    expect(() => new SqliteWorkflowStore(filename)).toThrow(/no such column: c\.bundle/);
    const failed = new Database(filename);
    try {
      expect(failed.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 12 });
      expect(failed.prepare("SELECT name FROM sqlite_master WHERE name IN ('liquidity_claim_metadata','liquidity_claim_consumption_evidence_unique')").all()).toEqual([]);
      expect(failed.prepare('SELECT * FROM liquidity_claims').all()).toEqual(claims);
      failed.exec('ALTER TABLE liquidity_claims RENAME COLUMN broken_bundle TO bundle');
    } finally {
      failed.close();
    }
    store = new SqliteWorkflowStore(filename);
    expect(store['db'].prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: SqliteWorkflowStore['MIGRATIONS'].length });
    expect(store['db'].prepare('SELECT * FROM liquidity_claim_metadata').all()).toEqual([]);
  });
});
