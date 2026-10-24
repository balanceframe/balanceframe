-- Synthetic persisted store produced by BalanceFrame v0.8.0 (59743bc1b5aa35310f98a2d148eda12a49231c88).
-- Do not regenerate from current migrations; see README.md.
BEGIN TRANSACTION;
CREATE TABLE "action_proposals" (
          id               TEXT PRIMARY KEY,
          operation        TEXT NOT NULL,
          budget_id        TEXT NOT NULL,
          payload_hash     TEXT NOT NULL,
          policy_version   TEXT NOT NULL,
          preconditions    TEXT NOT NULL,
          expires_at       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          provenance       TEXT NOT NULL,
          provider_model   TEXT,
          correlation_id   TEXT,
          superseded_at    TEXT,
          created_at       TEXT NOT NULL
        , payload TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT '{"phase":"proposed","sourceObserved":false,"destinationObserved":false,"reconciled":false,"outcome":null}', space_id TEXT, requester_membership_id TEXT, governance_policy_version TEXT, requester_delegation_id TEXT, requester_delegation_version TEXT);
INSERT INTO "action_proposals" VALUES('00000000-0000-4000-8000-000000000035','set_category','synthetic-upgrade-budget','bdbbb9a5950ca047f4b65da9f1a29bffaec199e06321c141151d9f1f82f5758b','1.0','{"accountId":"a_1","actualVersion":"25.1.0","amount":{"currency":"USD","minorUnits":"1500"},"currentCategoryId":"cat_1","direction":"outgoing","transactionId":"tx_000"}','2026-10-02T12:00:00.000Z','synthetic-owner','synthetic-upgrade-fixture',NULL,NULL,NULL,'2026-10-01T12:00:00.000Z','{"categoryId":"cat_2","kind":"set_category","transactionId":"tx_000"}',1,'{"phase":"proposed","sourceObserved":false,"destinationObserved":false,"reconciled":false,"outcome":null}','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','1',NULL,NULL);
CREATE TABLE actor_memberships (
          actor_id     TEXT PRIMARY KEY,
          status       TEXT NOT NULL DEFAULT 'active',
          capabilities TEXT NOT NULL DEFAULT '[]',
          scope        TEXT NOT NULL DEFAULT '*'
        );
INSERT INTO "actor_memberships" VALUES('synthetic-owner','active','["observe","finding:transition","notification:receive","notification:admin","categorization:execute","rule:execute"]','*');
INSERT INTO "actor_memberships" VALUES('synthetic-former-approver','inactive','[]','');
CREATE TABLE agent_delegations (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      agent_id TEXT NOT NULL REFERENCES governance_agents(agent_id),
      issuer_actor_id TEXT NOT NULL,
      issuer_membership_id TEXT NOT NULL REFERENCES space_memberships(id),
      rights TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(id,version),
      CHECK (valid_until IS NULL OR valid_until > valid_from)
    );
CREATE TABLE audit_records (
          id                       TEXT PRIMARY KEY,
          classification           TEXT NOT NULL,
          timestamp                TEXT NOT NULL,
          actor_id                 TEXT NOT NULL,
          operation                TEXT,
          proposal_id              TEXT,
          payload_hash             TEXT,
          budget_id                TEXT,
          backend_ids              TEXT NOT NULL DEFAULT '[]',
          policy_version           TEXT,
          authorization_disposition TEXT,
          idempotency_key          TEXT,
          expected_prior_state     TEXT,
          observed_result_state    TEXT,
          provider_model           TEXT,
          correlation_id           TEXT,
          request_id               TEXT,
          result                   TEXT NOT NULL,
          is_error                 INTEGER NOT NULL DEFAULT 0
        );
INSERT INTO "audit_records" VALUES('00000000-0000-4000-8000-000000000001','bootstrap_claimed','2026-10-01T12:00:00.000Z','owner@example.test','claim_bootstrap',NULL,NULL,NULL,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'Bootstrap claimed for owner@example.test',0);
INSERT INTO "audit_records" VALUES('00000000-0000-4000-8000-000000000002','bootstrap_completed','2026-10-01T12:00:00.000Z','synthetic-owner','bootstrap',NULL,NULL,NULL,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'Owner created',0);
INSERT INTO "audit_records" VALUES('00000000-0000-4000-8000-000000000037','approval_granted','2026-10-01T12:00:00.000Z','synthetic-former-approver','set_category','00000000-0000-4000-8000-000000000035','bdbbb9a5950ca047f4b65da9f1a29bffaec199e06321c141151d9f1f82f5758b','synthetic-upgrade-budget','[]','1.0','{"kind":"authorized_without_approval"}',NULL,NULL,'active',NULL,NULL,NULL,'{"approvalId":"00000000-0000-4000-8000-000000000036","spaceId":"00000000-0000-4000-8000-000000000003","issuerMembershipId":"00000000-0000-4000-8000-000000000017","governancePolicyVersion":"1"}',0);
CREATE TABLE candidate_jobs (
          id               TEXT PRIMARY KEY,
          job_type         TEXT NOT NULL,
          candidate_id     TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          claim_token      TEXT,
          claimed_at       TEXT,
          claim_expires_at TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL, space_id TEXT, budget_id TEXT, actor_id TEXT,
          UNIQUE(job_type, candidate_id)
        );
CREATE TABLE credential_bindings (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      credential_id TEXT NOT NULL UNIQUE,
      credential_owner_id TEXT NOT NULL,
      principal_type TEXT NOT NULL CHECK(principal_type IN ('human','agent')),
      principal_id TEXT NOT NULL,
      delegation_id TEXT,
      delegation_version TEXT,
      issuer_membership_id TEXT NOT NULL REFERENCES space_memberships(id),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
CREATE TABLE delivery_attempts (
          id              TEXT PRIMARY KEY,
          outbox_id       TEXT NOT NULL REFERENCES notification_outbox(id),
          attempt_number  INTEGER NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('success','failed')),
          response_code   TEXT,
          response_body   TEXT,
          error_message   TEXT,
          attempted_at    TEXT NOT NULL
        );
CREATE TABLE export_records (
          id               TEXT PRIMARY KEY,
          budget_name      TEXT NOT NULL,
          export_path      TEXT NOT NULL,
          account_count    INTEGER NOT NULL DEFAULT 0,
          transaction_count INTEGER NOT NULL DEFAULT 0,
          exported_at      TEXT NOT NULL
        , space_id TEXT, budget_id TEXT, actor_id TEXT, sha256_hash TEXT, byte_size INTEGER);
CREATE TABLE failure_records (
          id            TEXT PRIMARY KEY,
          job_id        TEXT NOT NULL REFERENCES candidate_jobs(id),
          error_code    TEXT NOT NULL,
          error_message TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
CREATE TABLE findings (
          id                TEXT PRIMARY KEY,
          budget_id         TEXT NOT NULL,
          classification    TEXT NOT NULL,
          description       TEXT NOT NULL,
          evidence          TEXT NOT NULL DEFAULT '{}',
          evidence_refs     TEXT NOT NULL DEFAULT '[]',
          severity          TEXT NOT NULL DEFAULT 'medium'
                              CHECK(severity IN ('low','medium','high','critical')),
          status            TEXT NOT NULL DEFAULT 'open'
                              CHECK(status IN ('open','acknowledged','corrected',
                                               'dismissed','reopened','expired','superseded')),
          actor_id          TEXT,
          acknowledged_at   TEXT,
          acknowledged_by   TEXT,
          corrected_at      TEXT,
          corrected_by      TEXT,
          correction_ref    TEXT,
          dismissed_at      TEXT,
          dismissed_by      TEXT,
          dismissed_reason  TEXT,
          reopened_at       TEXT,
          reopened_by       TEXT,
          superseded_at     TEXT,
          superseded_by     TEXT,
          superseded_reason TEXT,
          expires_at        TEXT,
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
CREATE TABLE governance_agents (
      agent_id TEXT PRIMARY KEY,
      registered_space_id TEXT NOT NULL REFERENCES spaces(id),
      status TEXT NOT NULL CHECK(status IN ('active','disconnected','revoked')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      disconnected_at TEXT,
      revoked_at TEXT
    );
CREATE TABLE governance_policies (
      space_id TEXT NOT NULL REFERENCES spaces(id),
      version TEXT NOT NULL,
      policy TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
      PRIMARY KEY(space_id,version)
    );
INSERT INTO "governance_policies" VALUES('00000000-0000-4000-8000-000000000003','1','{"minimumApprovers":1,"approvalThresholds":[],"operationApprovers":{}}','synthetic-owner','2026-10-01T12:00:00.000Z',1);
CREATE TABLE idempotency_records (
          idempotency_key   TEXT PRIMARY KEY,
          proposal_id       TEXT NOT NULL,
          operation         TEXT NOT NULL,
          executed_at       TEXT NOT NULL,
          completed         INTEGER NOT NULL DEFAULT 0,
          serialised_effect TEXT NOT NULL,
          error_message     TEXT,
          updated_at        TEXT NOT NULL
        , idempotency_status TEXT NOT NULL DEFAULT 'in_progress', lease_expires_at TEXT, request_identity TEXT, serialised_result TEXT);
INSERT INTO "idempotency_records" VALUES('synthetic-completed-execution','00000000-0000-4000-8000-000000000035','set_category','2026-10-01T12:00:00.000Z',1,'{"kind":"set_category","transactionId":"tx_000","categoryId":"cat_2"}',NULL,'2026-10-01T12:00:00.000Z','succeeded','2026-10-01T12:01:00.000Z',NULL,'{"synthetic":true,"verified":true}');
CREATE TABLE invitations (
          id                 TEXT PRIMARY KEY,
          token_digest       TEXT UNIQUE NOT NULL,
          status             TEXT NOT NULL CHECK(status IN ('active','claimed','redeemed','revoked','expired')),
          created_by_user_id TEXT NOT NULL,
          expires_at         TEXT NOT NULL,
          claimed_email      TEXT,
          claim_id           TEXT,
          redeemed_user_id   TEXT,
          created_at         TEXT NOT NULL,
          claimed_at         TEXT,
          redeemed_at        TEXT
        , space_id TEXT, issuer_membership_id TEXT, governance_policy_version TEXT);
CREATE TABLE liquidity_allocations (budget_id TEXT NOT NULL, sequence INTEGER NOT NULL, allocation TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,sequence));
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
      consumption_evidence_id TEXT, space_id TEXT, membership_id TEXT,
      PRIMARY KEY(budget_id,claim_id),
      FOREIGN KEY(budget_id,claim_id) REFERENCES liquidity_claims(budget_id,id)
    );
CREATE TABLE liquidity_claim_revisions (budget_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE liquidity_claims (budget_id TEXT NOT NULL, id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, bundle TEXT NOT NULL, PRIMARY KEY(budget_id,id), UNIQUE(budget_id,owner_kind,owner_id));
CREATE TABLE liquidity_current_policy (budget_id TEXT PRIMARY KEY, version TEXT NOT NULL);
CREATE TABLE liquidity_policy_versions (budget_id TEXT NOT NULL, version TEXT NOT NULL, policy TEXT NOT NULL, approval_policy TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,version));
CREATE TABLE liquidity_supplemental_facts (budget_id TEXT NOT NULL, version INTEGER NOT NULL, facts TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, space_id TEXT, membership_id TEXT, PRIMARY KEY(budget_id,version));
CREATE TABLE merchant_decisions (
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      visibility_hash TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
      updated_at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope_key, visibility_hash, id)
    );
CREATE TABLE merchant_enrichment_cache (
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      key_hash TEXT NOT NULL, attempt_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, retrieved_at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope_key, key_hash)
    );
CREATE TABLE merchant_evidence (
      scope_key TEXT NOT NULL REFERENCES merchant_scope_generations(scope_key),
      visibility_hash TEXT NOT NULL, evidence_key TEXT NOT NULL,
      expires_at TEXT NOT NULL, captured_at TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope_key, visibility_hash, evidence_key)
    );
CREATE TABLE merchant_policies (
      scope_key TEXT PRIMARY KEY REFERENCES merchant_scope_generations(scope_key),
      value TEXT NOT NULL
    );
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
CREATE TABLE merchant_scope_generations (
      scope_key TEXT PRIMARY KEY,
      space_id TEXT NOT NULL, budget_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      restore_pending INTEGER NOT NULL DEFAULT 0,
      billing_hold_until TEXT, billing_unresolved INTEGER NOT NULL DEFAULT 0
    );
CREATE TABLE notification_events (
          id                    TEXT PRIMARY KEY,
          event_version         INTEGER NOT NULL DEFAULT 1,
          budget_id             TEXT NOT NULL,
          classification        TEXT NOT NULL,
          recipient_id          TEXT,
          scope                 TEXT,
          redaction_class       TEXT,
          channel_config_version TEXT,
          policy_version        TEXT NOT NULL,
          correlation_id        TEXT,
          payload               TEXT NOT NULL,
          created_at            TEXT NOT NULL
        , dedup_key TEXT, space_id TEXT REFERENCES spaces(id), recipient_membership_id TEXT REFERENCES space_memberships(id));
CREATE TABLE notification_outbox (
          id                    TEXT PRIMARY KEY,
          event_id              TEXT NOT NULL REFERENCES notification_events(id),
          delivery_key          TEXT NOT NULL,
          channel_type          TEXT NOT NULL,
          channel_config_version TEXT,
          status                TEXT NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','delivering','delivered','failed','suppressed')),
          attempt_count         INTEGER NOT NULL DEFAULT 0,
          max_attempts          INTEGER NOT NULL DEFAULT 3,
          claim_token           TEXT,
          claim_expires_at      TEXT,
          last_attempted_at     TEXT,
          next_attempt_at       TEXT,
          acknowledged_at       TEXT,
          failed_at             TEXT,
          failure_reason        TEXT,
          suppressed_at         TEXT,
          suppressed_reason     TEXT,
          correlation_id        TEXT,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          UNIQUE(event_id, channel_type, delivery_key)
        );
CREATE TABLE notification_policies (
          id             TEXT PRIMARY KEY,
          space_id       TEXT NOT NULL,
          policy_key     TEXT NOT NULL,
          policy_version TEXT NOT NULL,
          policy         TEXT NOT NULL,
          is_active      INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          UNIQUE(space_id, policy_key)
        );
CREATE TABLE payment_preferences (budget_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, space_id TEXT, membership_id TEXT, PRIMARY KEY(budget_id,id));
CREATE TABLE policy_versions (
          id            TEXT PRIMARY KEY,
          policy_key    TEXT NOT NULL,
          version       INTEGER NOT NULL,
          policy_hash   TEXT NOT NULL,
          description   TEXT NOT NULL,
          is_active     INTEGER NOT NULL DEFAULT 1,
          superseded_at TEXT,
          created_at    TEXT NOT NULL,
          UNIQUE(policy_key, version)
        );
CREATE TABLE proposal_approvals (
          id            TEXT PRIMARY KEY,
          proposal_id   TEXT NOT NULL REFERENCES "action_proposals"(id),
          payload_hash  TEXT NOT NULL,
          actor_id      TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'active',
          expires_at    TEXT NOT NULL,
          consumed_at   TEXT,
          superseded_at TEXT,
          created_at    TEXT NOT NULL
        , proposal_version INTEGER NOT NULL DEFAULT 1, issuer_membership_id TEXT, governance_policy_version TEXT, reauthenticated_session_id TEXT, reauthenticated_at TEXT);
INSERT INTO "proposal_approvals" VALUES('00000000-0000-4000-8000-000000000036','00000000-0000-4000-8000-000000000035','bdbbb9a5950ca047f4b65da9f1a29bffaec199e06321c141151d9f1f82f5758b','synthetic-former-approver','expired','2026-10-02T12:00:00.000Z',NULL,NULL,'2026-10-01T12:00:00.000Z',1,'00000000-0000-4000-8000-000000000017','1','synthetic-session:synthetic-former-approver','2026-10-01T12:00:00.000Z');
CREATE TABLE proposal_execution_acquisitions (
      proposal_id TEXT PRIMARY KEY REFERENCES action_proposals(id),
      idempotency_key TEXT NOT NULL UNIQUE REFERENCES idempotency_records(idempotency_key),
      actor_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );
CREATE TABLE registration_state (
          singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_user_id   TEXT UNIQUE,
          bootstrapped_at TEXT,
          claim_id        TEXT,
          claimed_email   TEXT,
          claimed_name    TEXT,
          claimed_at      TEXT
        );
INSERT INTO "registration_state" VALUES(1,'synthetic-owner','2026-10-01T12:00:00.000Z','synthetic-bootstrap','owner@example.test','Synthetic Owner','2026-10-01T12:00:00.000Z');
CREATE TABLE report_records (
          id              TEXT PRIMARY KEY,
          report_type     TEXT NOT NULL,
          budget_id       TEXT,
          filter_id       TEXT REFERENCES saved_filters(id),
          config          TEXT NOT NULL,
          policy_version  TEXT NOT NULL,
          generated_at    TEXT NOT NULL,
          expires_at      TEXT,
          data_ref        TEXT
        );
CREATE TABLE resource_grants (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      membership_id TEXT,
      actor_id TEXT NOT NULL,
      budget_id TEXT,
      capability TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      granted INTEGER NOT NULL CHECK (granted IN (0,1)),
      restrictions TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'space:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'identity:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'membership:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'connection:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'policy:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'grant:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'agent:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'delegation:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'credential:manage','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner',NULL,'audit:read','space','00000000-0000-4000-8000-000000000003',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000019','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner','synthetic-upgrade-budget','categorization:propose','budget','synthetic-upgrade-budget',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000017','synthetic-former-approver','synthetic-upgrade-budget','categorization:approve','budget','synthetic-upgrade-budget',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner','synthetic-upgrade-budget','categorization:propose','transaction','tx_000',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000017','synthetic-former-approver','synthetic-upgrade-budget','categorization:approve','transaction','tx_000',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000027','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner','synthetic-upgrade-budget','categorization:propose','category','cat_2',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000029','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000017','synthetic-former-approver','synthetic-upgrade-budget','categorization:approve','category','cat_2',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','synthetic-owner','synthetic-upgrade-budget','categorization:propose','account','a_1',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
INSERT INTO "resource_grants" VALUES('00000000-0000-4000-8000-000000000033','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000017','synthetic-former-approver','synthetic-upgrade-budget','categorization:approve','account','a_1',1,'{}','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
CREATE TABLE review_actions (
          id               TEXT PRIMARY KEY,
          review_item_id   TEXT NOT NULL REFERENCES review_items(id),
          from_status      TEXT NOT NULL,
          to_status        TEXT NOT NULL,
          actor            TEXT NOT NULL,
          reason           TEXT,
          metadata         TEXT NOT NULL DEFAULT '{}',
          created_at       TEXT NOT NULL
        );
CREATE TABLE review_corrections (
          id                  TEXT PRIMARY KEY,
          review_item_id      TEXT NOT NULL REFERENCES review_items(id),
          transaction_id      TEXT NOT NULL,
          transaction_version INTEGER NOT NULL DEFAULT 0,
          merchant            TEXT,
          imported_payee      TEXT,
          account_id          TEXT,
          direction           TEXT,
          amount              INTEGER,
          date                TEXT,
          category_id         TEXT NOT NULL,
          category_name       TEXT,
          actor               TEXT NOT NULL,
          from_status         TEXT NOT NULL,
          to_status           TEXT NOT NULL,
          source_review_id    TEXT NOT NULL,
          created_at          TEXT NOT NULL
        , previous_category_id TEXT, proposal_id TEXT, proposal_actor_id TEXT, payload_hash TEXT, idempotency_key TEXT, verified INTEGER NOT NULL DEFAULT 0
          CHECK (verified IN (0, 1)));
CREATE TABLE review_items (
          id                   TEXT PRIMARY KEY,
          suggestion_id        TEXT,
          budget_id            TEXT NOT NULL,
          transaction_id       TEXT NOT NULL,
          category_id          TEXT NOT NULL,
          classifier           TEXT NOT NULL,
          prompt_version       TEXT NOT NULL DEFAULT '',
          transaction_version  INTEGER NOT NULL DEFAULT 0,
          status               TEXT NOT NULL DEFAULT 'discovered',
          correlation_id       TEXT,
          assigned_reviewer_id TEXT,
          approved_by          TEXT NOT NULL DEFAULT '[]',
          reviewers_required   INTEGER NOT NULL DEFAULT 1,
          priority             INTEGER NOT NULL DEFAULT 0,
          evidence             TEXT NOT NULL DEFAULT '{}',
          provenance           TEXT NOT NULL,
          superseded_by        TEXT,
          superseded_reason    TEXT,
          freshness_expires_at TEXT,
          version              INTEGER NOT NULL DEFAULT 1,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        , source_transaction_json TEXT);
INSERT INTO "review_items" VALUES('00000000-0000-4000-8000-000000000039','00000000-0000-4000-8000-000000000038','synthetic-upgrade-budget','tx_000','cat_2','synthetic-upgrade','',1,'discovered',NULL,NULL,'[]',1,0,'{}','synthetic-upgrade-fixture',NULL,NULL,NULL,1,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z',NULL);
CREATE TABLE review_rule_blocks (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      rule_ids_json TEXT NOT NULL CHECK(json_valid(rule_ids_json) AND json_type(rule_ids_json)='array'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
CREATE TABLE review_rule_parts (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      block_ids_json TEXT NOT NULL CHECK(json_valid(block_ids_json) AND json_type(block_ids_json)='array'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
CREATE TABLE review_rule_sets (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      expression_json TEXT NOT NULL CHECK(json_valid(expression_json) AND json_type(expression_json)='object'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
CREATE TABLE rule_overrides (
          space_id   TEXT NOT NULL,
          budget_id  TEXT NOT NULL,
          rule_id    TEXT NOT NULL,
          inactive   INTEGER CHECK (inactive IS NULL OR inactive IN (0, 1)),
          version    INTEGER NOT NULL CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_id, budget_id, rule_id)
        );
CREATE TABLE saved_filters (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          budget_id       TEXT,
          filter_config   TEXT NOT NULL,
          view_config     TEXT,
          scope           TEXT NOT NULL,
          policy_version  TEXT NOT NULL,
          is_default      INTEGER NOT NULL DEFAULT 0,
          actor_id        TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
CREATE TABLE saved_views (
          view_id     TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          view_type   TEXT NOT NULL,
          scope       TEXT NOT NULL,
          sort        TEXT,
          actor_id    TEXT NOT NULL,
          created_at  TEXT NOT NULL
        , last_used_at TEXT, space_id TEXT, budget_id TEXT, membership_id TEXT);
INSERT INTO "saved_views" VALUES('00000000-0000-4000-8000-000000000040','Synthetic Upgrade View','pending_review','{"categoryId":"cat_2"}',NULL,'synthetic-owner','2026-10-01T12:00:00.000Z',NULL,'00000000-0000-4000-8000-000000000003','synthetic-upgrade-budget','00000000-0000-4000-8000-000000000004');
CREATE TABLE schema_version (
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
INSERT INTO "schema_version" VALUES(1,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(2,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(3,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(4,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(5,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(6,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(7,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(8,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(9,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(10,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(11,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(12,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(13,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(14,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(15,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(16,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(17,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(18,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(19,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(20,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(21,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(22,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(23,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(24,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(25,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(26,'2026-10-01T12:00:00.000Z');
INSERT INTO "schema_version" VALUES(27,'2026-10-01T12:00:00.000Z');
CREATE TABLE session_completion_evidence (
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
CREATE TABLE session_completion_writes (
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
      authorization_hash TEXT NOT NULL DEFAULT '',
      claim_set_revision TEXT NOT NULL DEFAULT '',
      approval_ids TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(budget_id,proposal_id),
      UNIQUE(budget_id,parent_id)
    );
CREATE TABLE space_governance_audit (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      subject_id TEXT,
      timestamp TEXT NOT NULL,
      details TEXT NOT NULL
    );
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-000000000003','synthetic-owner','space_created','00000000-0000-4000-8000-000000000003','2026-10-01T12:00:00.000Z','{"kind":"shared"}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000016','00000000-0000-4000-8000-000000000003','synthetic-owner','budget_bound','synthetic-upgrade-budget','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000018','00000000-0000-4000-8000-000000000003','synthetic-owner','membership_added','00000000-0000-4000-8000-000000000017','2026-10-01T12:00:00.000Z','{"actorId":"synthetic-former-approver"}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000019','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000021','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000023','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000026','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000025','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000028','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000027','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000029','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000031','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000034','00000000-0000-4000-8000-000000000003','synthetic-owner','resource_grant_created','00000000-0000-4000-8000-000000000033','2026-10-01T12:00:00.000Z','{}');
INSERT INTO "space_governance_audit" VALUES('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000003','synthetic-owner','membership_revoked','00000000-0000-4000-8000-000000000017','2026-10-01T12:00:00.000Z','{}');
CREATE TABLE space_memberships (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      actor_id TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('created','managed','migration')),
      CHECK (valid_until IS NULL OR valid_until > valid_from)
    );
INSERT INTO "space_memberships" VALUES('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','synthetic-owner','synthetic-owner','2026-10-01T12:00:00.000Z',NULL,NULL,'2026-10-01T12:00:00.000Z','created');
INSERT INTO "space_memberships" VALUES('00000000-0000-4000-8000-000000000017','00000000-0000-4000-8000-000000000003','synthetic-former-approver','synthetic-owner','2026-10-01T12:00:00.000Z',NULL,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z','managed');
CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal','shared')),
      budget_id TEXT UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
INSERT INTO "spaces" VALUES('00000000-0000-4000-8000-000000000003','Synthetic Upgrade Space','shared','synthetic-upgrade-budget','synthetic-owner','2026-10-01T12:00:00.000Z',NULL);
CREATE TABLE spend_sessions (budget_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, space_id TEXT, membership_id TEXT, PRIMARY KEY(budget_id,id));
CREATE TABLE suggestions (
          id                  TEXT PRIMARY KEY,
          budget_id           TEXT NOT NULL,
          transaction_id      TEXT NOT NULL,
          category_id         TEXT NOT NULL,
          classifier          TEXT NOT NULL,
          prompt_version      TEXT NOT NULL,
          payload             TEXT NOT NULL,
          transaction_version INTEGER NOT NULL,
          superseded_at       TEXT,
          created_at          TEXT NOT NULL
        );
INSERT INTO "suggestions" VALUES('00000000-0000-4000-8000-000000000038','synthetic-upgrade-budget','tx_000','cat_2','synthetic-upgrade','v0.8.0','{"synthetic":true}',1,NULL,'2026-10-01T12:00:00.000Z');
CREATE TABLE transfer_evidence (budget_id TEXT NOT NULL, evidence_id TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES action_proposals(id), payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,evidence_id));
CREATE TABLE transfer_previews (id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, actor_id TEXT NOT NULL, record TEXT NOT NULL, space_id TEXT, membership_id TEXT);
CREATE TABLE "unscoped_rule_overrides" (
          rule_id   TEXT PRIMARY KEY,
          inactive  INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE UNIQUE INDEX idx_suggestions_active
          ON suggestions(budget_id, transaction_id, classifier, prompt_version)
          WHERE superseded_at IS NULL;
CREATE INDEX idx_suggestions_transaction
          ON suggestions(transaction_id);
CREATE INDEX idx_jobs_status
          ON candidate_jobs(status);
CREATE INDEX idx_failures_job
          ON failure_records(job_id);
CREATE INDEX idx_review_items_status
          ON review_items(status);
CREATE INDEX idx_review_items_correlation
          ON review_items(correlation_id);
CREATE INDEX idx_review_actions_item
          ON review_actions(review_item_id);
CREATE INDEX idx_approvals_proposal
          ON proposal_approvals(proposal_id);
CREATE UNIQUE INDEX idx_approvals_active_actor
          ON proposal_approvals(proposal_id, actor_id)
          WHERE status = 'active';
CREATE INDEX idx_corrections_review
          ON review_corrections(review_item_id);
CREATE INDEX idx_corrections_merchant
          ON review_corrections(merchant);
CREATE INDEX idx_corrections_transaction
          ON review_corrections(transaction_id);
CREATE INDEX idx_corrections_actor
          ON review_corrections(actor);
CREATE INDEX idx_audit_classification
          ON audit_records(classification);
CREATE INDEX idx_audit_proposal
          ON audit_records(proposal_id);
CREATE INDEX idx_idempotency_status
          ON idempotency_records(idempotency_status);
CREATE INDEX idx_invitations_status
          ON invitations(status);
CREATE INDEX idx_invitations_claim_id
          ON invitations(claim_id);
CREATE INDEX idx_notif_events_budget
          ON notification_events(budget_id);
CREATE INDEX idx_notif_events_classification
          ON notification_events(classification);
CREATE INDEX idx_outbox_status
          ON notification_outbox(status);
CREATE INDEX idx_outbox_channel
          ON notification_outbox(channel_type);
CREATE INDEX idx_outbox_next_attempt
          ON notification_outbox(next_attempt_at)
          WHERE next_attempt_at IS NOT NULL;
CREATE INDEX idx_delivery_attempts_outbox
          ON delivery_attempts(outbox_id);
CREATE INDEX idx_policy_active
          ON policy_versions(policy_key)
          WHERE is_active = 1;
CREATE INDEX idx_saved_filters_budget
          ON saved_filters(budget_id);
CREATE INDEX idx_saved_filters_scope
          ON saved_filters(scope);
CREATE INDEX idx_saved_filters_actor
          ON saved_filters(actor_id);
CREATE INDEX idx_report_records_budget
          ON report_records(budget_id);
CREATE INDEX idx_report_records_type
          ON report_records(report_type);
CREATE INDEX idx_saved_views_actor
          ON saved_views(actor_id);
CREATE INDEX idx_findings_budget
          ON findings(budget_id);
CREATE INDEX idx_findings_status
          ON findings(status);
CREATE INDEX idx_findings_classification
          ON findings(classification);
CREATE INDEX idx_findings_severity
          ON findings(severity);
CREATE INDEX idx_notif_policies_space
          ON notification_policies(space_id);
CREATE INDEX idx_notif_policies_active
          ON notification_policies(is_active);
CREATE INDEX idx_proposals_active_target ON action_proposals(budget_id, json_extract(payload, '$.transactionId'), operation) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX idx_proposals_payload_unique ON action_proposals(budget_id, operation, COALESCE(json_extract(payload, '$.transactionId'), ''), payload_hash) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX liquidity_claim_consumption_evidence_unique
      ON liquidity_claim_metadata (budget_id, consumption_evidence_id)
      WHERE consumption_evidence_id IS NOT NULL;
CREATE INDEX space_membership_history ON space_memberships(space_id,actor_id,valid_from);
CREATE INDEX space_membership_current ON space_memberships(space_id,actor_id,revoked_at,valid_from,valid_until);
CREATE UNIQUE INDEX governance_policy_current ON governance_policies(space_id) WHERE is_current=1;
CREATE UNIQUE INDEX resource_grants_current
      ON resource_grants(membership_id,capability,resource_kind,resource_id)
      WHERE membership_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX resource_grants_scope ON resource_grants(space_id,budget_id,actor_id,membership_id);
CREATE UNIQUE INDEX agent_delegation_current ON agent_delegations(id) WHERE revoked_at IS NULL;
CREATE INDEX agent_delegation_scope ON agent_delegations(space_id,agent_id,revoked_at);
CREATE INDEX space_governance_audit_space ON space_governance_audit(space_id,timestamp,id);
CREATE INDEX invitations_by_space ON invitations(space_id, created_at);
CREATE UNIQUE INDEX idx_notif_events_dedup_identity
      ON notification_events(
        budget_id, dedup_key,
        recipient_id IS NULL, COALESCE(recipient_id, ''),
        scope IS NULL, COALESCE(scope, ''),
        space_id IS NULL, COALESCE(space_id, ''),
        recipient_membership_id IS NULL, COALESCE(recipient_membership_id, '')
      ) WHERE dedup_key IS NOT NULL;
CREATE INDEX notification_events_space_recipient_epoch
      ON notification_events(space_id, recipient_id, recipient_membership_id);
CREATE INDEX idx_saved_views_scope
          ON saved_views(space_id, budget_id, actor_id, membership_id);
CREATE UNIQUE INDEX idx_review_corrections_idempotency
          ON review_corrections(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_lifecycle_scope
          ON candidate_jobs(space_id, budget_id, status);
CREATE INDEX idx_exports_lifecycle_scope
          ON export_records(actor_id, space_id, budget_id, exported_at);
CREATE INDEX merchant_scope_budget ON merchant_scope_generations(space_id, budget_id);
CREATE INDEX merchant_decision_page ON merchant_decisions(scope_key, visibility_hash, kind, id);
CREATE INDEX merchant_evidence_expiry ON merchant_evidence(expires_at);
CREATE INDEX merchant_cache_expiry ON merchant_enrichment_cache(expires_at);
CREATE INDEX merchant_attempt_active ON merchant_research_attempts(scope_key, key_hash, generation, phase, lease_expires_at);
CREATE INDEX merchant_attempt_day ON merchant_research_attempts(day_window);
CREATE INDEX merchant_attempt_month ON merchant_research_attempts(month_window);
CREATE INDEX merchant_attempt_expiry ON merchant_research_attempts(phase, lease_expires_at);
CREATE UNIQUE INDEX idx_review_items_active_issue ON review_items(budget_id,transaction_id,category_id,classifier)
      WHERE status!='superseded' AND (classifier!='rule' OR json_extract(evidence,'$.ruleSetRef.kind') IS NULL);
CREATE UNIQUE INDEX idx_review_items_native_issue ON review_items(budget_id,transaction_id,category_id,classifier,
      json_extract(evidence,'$.ruleSetRef.scope.spaceId'),json_extract(evidence,'$.ruleSetRef.scope.connectionId'))
      WHERE status!='superseded' AND classifier='rule' AND json_extract(evidence,'$.ruleSetRef.kind')='scoped';
CREATE INDEX idx_review_rule_blocks_scope ON review_rule_blocks(budget_id,space_id,connection_id);
CREATE INDEX idx_review_rule_parts_scope ON review_rule_parts(budget_id,space_id,connection_id);
CREATE INDEX idx_review_rule_sets_scope ON review_rule_sets(budget_id,space_id,connection_id);
COMMIT;
