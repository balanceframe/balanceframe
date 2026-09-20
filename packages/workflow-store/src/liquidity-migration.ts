import type { Database } from 'better-sqlite3';

/** One migration, retaining row IDs, exact legacy hashes, approvals and audit references. */
export function migrateLiquidityWorkflow(db: Database): void {
  db.exec(`
    ALTER TABLE categorization_proposals RENAME TO action_proposals;
    DROP INDEX idx_proposals_active_target;
    DROP INDEX idx_proposals_payload_unique;
    ALTER TABLE action_proposals ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE action_proposals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE action_proposals ADD COLUMN state TEXT NOT NULL DEFAULT '{"phase":"proposed","sourceObserved":false,"destinationObserved":false,"reconciled":false,"outcome":null}';
    UPDATE action_proposals SET payload = CASE operation
      WHEN 'set_category' THEN json_object('kind', operation, 'transactionId', transaction_id, 'categoryId', category_id)
      ELSE json_object('kind', operation, 'transactionId', CASE WHEN transaction_id = '__rule__' THEN NULL ELSE transaction_id END, 'categoryId', category_id, 'rule', json(CASE WHEN json_valid(preconditions) THEN COALESCE(json_extract(preconditions, '$.nativeRule'), '{}') ELSE '{}' END)) END;
    ALTER TABLE action_proposals DROP COLUMN transaction_id;
    ALTER TABLE action_proposals DROP COLUMN category_id;
    CREATE INDEX idx_proposals_active_target ON action_proposals(budget_id, json_extract(payload, '$.transactionId'), operation) WHERE superseded_at IS NULL;
    CREATE UNIQUE INDEX idx_proposals_payload_unique ON action_proposals(budget_id, operation, COALESCE(json_extract(payload, '$.transactionId'), ''), payload_hash) WHERE superseded_at IS NULL;
    ALTER TABLE proposal_approvals ADD COLUMN proposal_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE idempotency_records ADD COLUMN request_identity TEXT;
    CREATE TABLE resource_grants (actor_id TEXT NOT NULL, budget_id TEXT NOT NULL, capability TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, granted INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id,budget_id,capability,resource_kind,resource_id));
    CREATE TABLE liquidity_policy_versions (budget_id TEXT NOT NULL, version TEXT NOT NULL, policy TEXT NOT NULL, approval_policy TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,version));
    CREATE TABLE liquidity_current_policy (budget_id TEXT PRIMARY KEY, version TEXT NOT NULL);
    CREATE TABLE liquidity_claim_revisions (budget_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE liquidity_claims (budget_id TEXT NOT NULL, id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, bundle TEXT NOT NULL, PRIMARY KEY(budget_id,id), UNIQUE(budget_id,owner_kind,owner_id));
    CREATE TABLE liquidity_allocations (budget_id TEXT NOT NULL, sequence INTEGER NOT NULL, allocation TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,sequence));
    CREATE TABLE liquidity_supplemental_facts (budget_id TEXT NOT NULL, version INTEGER NOT NULL, facts TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,version));
    CREATE TABLE payment_preferences (budget_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(budget_id,id));
    CREATE TABLE spend_sessions (budget_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(budget_id,id));
    CREATE TABLE transfer_evidence (budget_id TEXT NOT NULL, evidence_id TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES action_proposals(id), payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,evidence_id));
  `);
}

/** Server-held immutable preview, deliberately not a proposal or reservation. */
export function migrateTransferPreviews(db: Database): void {
  db.exec(
    'CREATE TABLE transfer_previews (id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, actor_id TEXT NOT NULL, record TEXT NOT NULL)',
  );
}
