import type { Database } from 'better-sqlite3';

/** Append-only merchant content and content-free research accounting. */
export function migrateMerchant(db: Database): void {
  db.exec(`
    CREATE TABLE merchant_scope_generations (
      scope_key TEXT PRIMARY KEY,
      space_id TEXT NOT NULL, budget_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      restore_pending INTEGER NOT NULL DEFAULT 0,
      billing_hold_until TEXT, billing_unresolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX merchant_scope_budget ON merchant_scope_generations(space_id, budget_id);
    CREATE TABLE merchant_policies (
      scope_key TEXT PRIMARY KEY REFERENCES merchant_scope_generations(scope_key),
      value TEXT NOT NULL
    );
    CREATE TABLE merchant_decisions (
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      visibility_hash TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
      updated_at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope_key, visibility_hash, id)
    );
    CREATE INDEX merchant_decision_page ON merchant_decisions(scope_key, visibility_hash, kind, id);
    CREATE TABLE merchant_evidence (
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      visibility_hash TEXT NOT NULL, evidence_key TEXT NOT NULL,
      expires_at TEXT NOT NULL, captured_at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope_key, visibility_hash, evidence_key)
    );
    CREATE INDEX merchant_evidence_expiry ON merchant_evidence(expires_at);
    CREATE TABLE merchant_enrichment_cache (
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      key_hash TEXT NOT NULL, attempt_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, retrieved_at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope_key, key_hash)
    );
    CREATE INDEX merchant_cache_expiry ON merchant_enrichment_cache(expires_at);
    CREATE TABLE merchant_research_attempts (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      idempotency_hash TEXT NOT NULL, intent_hash TEXT NOT NULL, key_hash TEXT NOT NULL,
      generation INTEGER NOT NULL, policy_version INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('reserved','dispatched','succeeded','known_failed','uncertain')),
      reserved_atoms TEXT NOT NULL, settled_atoms TEXT,
      billing_currency TEXT NOT NULL, tariff_version TEXT NOT NULL,
      created_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      dispatched_at TEXT, claim_token TEXT, outcome TEXT,
      visibility TEXT NOT NULL, source_refs TEXT NOT NULL,
      buckets TEXT NOT NULL, day_window TEXT NOT NULL, month_window TEXT NOT NULL,
      content_deleted INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope_key, idempotency_hash)
    );
    CREATE INDEX merchant_attempt_active ON merchant_research_attempts(scope_key, key_hash, generation, phase, lease_expires_at);
    CREATE INDEX merchant_attempt_day ON merchant_research_attempts(day_window);
    CREATE INDEX merchant_attempt_month ON merchant_research_attempts(month_window);
    CREATE INDEX merchant_attempt_expiry ON merchant_research_attempts(phase, lease_expires_at);
  `);
}
