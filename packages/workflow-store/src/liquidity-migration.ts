import type { Database } from 'better-sqlite3';
import type { LiquidityClaimBundle } from '@balanceframe/protocol-generated';

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
    CREATE TABLE liquidity_claim_metadata (
      budget_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('inform','block')),
      lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active','released','consumed','expired')),
      source_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      claim TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consumption_evidence_id TEXT,
      PRIMARY KEY(budget_id,claim_id),
      FOREIGN KEY(budget_id,claim_id) REFERENCES liquidity_claims(budget_id,id)
    );
    CREATE UNIQUE INDEX liquidity_claim_consumption_evidence_unique
      ON liquidity_claim_metadata (budget_id, consumption_evidence_id)
      WHERE consumption_evidence_id IS NOT NULL;
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

/** Durable one-shot completion write intent and trusted reconciliation evidence. */
export function migrateSessionCompletion(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_completion_writes (
      budget_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
      intent_id TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('write_intent','verified','review_required')),
      result TEXT,
      evidence_id TEXT,
      initiated_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY(budget_id,proposal_id),
      UNIQUE(budget_id,parent_id)
    );
    CREATE TABLE IF NOT EXISTS session_completion_evidence (
      budget_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
      payload_hash TEXT NOT NULL,
      evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('manual_parent','imported_link','ambiguous')),
      parent_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      transaction_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(budget_id,evidence_id)
    );
  `);
}

/** Upgrades previously persisted prospective scopes to distinct economic identities. */
export function migrateScopedProspectiveEffects(db: Database): void {
  const rows = db.prepare(
    "SELECT c.budget_id,c.id,c.bundle,m.source_id FROM liquidity_claims c JOIN liquidity_claim_metadata m ON m.budget_id=c.budget_id AND m.claim_id=c.id WHERE c.owner_kind='prospective'",
  ).all() as { budget_id: string; id: string; bundle: string; source_id: string }[];
  const changedBudgets = new Set<string>();
  const update = db.prepare('UPDATE liquidity_claims SET bundle=? WHERE budget_id=? AND id=?');
  for (const row of rows) {
    const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
    let changed = false;
    for (const effect of bundle.effects) {
      if (effect.kind !== 'category' && effect.kind !== 'account_debit') {
        if (effect.economicObligationId === row.source_id)
          throw new Error('Invalid historical prospective scope');
        continue;
      }
      const scopeKind = effect.kind === 'category' ? 'category' : 'account';
      const scopedId = `${row.source_id}:${scopeKind}:${effect.resourceId}`;
      if (effect.economicObligationId !== row.source_id
        && effect.economicObligationId !== scopedId) continue;
      if (effect.economicObligationId === row.source_id) {
        effect.economicObligationId = scopedId;
        changed = true;
      }
      if (effect.sourceEconomicObligationId !== row.source_id) {
        effect.sourceEconomicObligationId = row.source_id;
        changed = true;
      }
    }
    if (!changed) continue;
    update.run(JSON.stringify(bundle), row.budget_id, row.id);
    changedBudgets.add(row.budget_id);
  }
  const bump = db.prepare(
    'INSERT INTO liquidity_claim_revisions (budget_id,revision) VALUES (?,1) ON CONFLICT(budget_id) DO UPDATE SET revision=revision+1',
  );
  for (const budgetId of changedBudgets) bump.run(budgetId);
}
