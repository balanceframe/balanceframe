-- Synthetic persisted store produced by BalanceFrame v0.4.0 (7b26e44c6df9de3d5beedb59d888e43f19381860).
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
        , payload TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT '{"phase":"proposed","sourceObserved":false,"destinationObserved":false,"reconciled":false,"outcome":null}');
CREATE TABLE actor_memberships (
          actor_id     TEXT PRIMARY KEY,
          status       TEXT NOT NULL DEFAULT 'active',
          capabilities TEXT NOT NULL DEFAULT '[]',
          scope        TEXT NOT NULL DEFAULT '*'
        );
INSERT INTO "actor_memberships" VALUES('synthetic-owner','active','["liquidity:policy","liquidity:session","liquidity:category","liquidity:liquidity"]','budget:synthetic-upgrade-budget');
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
INSERT INTO "audit_records" VALUES('00000000-0000-4000-8000-000000000001','workflow_transition','2026-10-01T12:00:00.000Z','synthetic-owner','transfer',NULL,NULL,'synthetic-upgrade-budget','[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'liquidity_policy_changed',0);
INSERT INTO "audit_records" VALUES('00000000-0000-4000-8000-000000000002','workflow_transition','2026-10-01T12:00:00.000Z','synthetic-owner','transfer','synthetic-legacy-session',NULL,'synthetic-upgrade-budget','[]',NULL,NULL,'synthetic-legacy-session-save',NULL,NULL,NULL,NULL,NULL,'session:save',0);
CREATE TABLE candidate_jobs (
          id               TEXT PRIMARY KEY,
          job_type         TEXT NOT NULL,
          candidate_id     TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          claim_token      TEXT,
          claimed_at       TEXT,
          claim_expires_at TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          UNIQUE(job_type, candidate_id)
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
        );
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
CREATE TABLE idempotency_records (
          idempotency_key   TEXT PRIMARY KEY,
          proposal_id       TEXT NOT NULL,
          operation         TEXT NOT NULL,
          executed_at       TEXT NOT NULL,
          completed         INTEGER NOT NULL DEFAULT 0,
          serialised_effect TEXT NOT NULL,
          error_message     TEXT,
          updated_at        TEXT NOT NULL
        , idempotency_status TEXT NOT NULL DEFAULT 'in_progress', lease_expires_at TEXT, request_identity TEXT);
INSERT INTO "idempotency_records" VALUES('synthetic-legacy-session-save','synthetic-legacy-session','session:save','2026-10-01T12:00:00.000Z',1,'{"actorId":"synthetic-owner","budgetId":"synthetic-upgrade-budget","id":"synthetic-legacy-session","version":1,"items":[{"id":"synthetic-item","categoryId":"cat_2","amount":{"minorUnits":"1500","currency":"USD"},"purchaseAt":"2026-10-01T12:00:00.000Z","requiredBy":"2027-01-01T12:00:00.000Z","routeSelection":{"explicitAccountId":null,"sessionAccountId":"a_1","approvedPreference":null,"historicalRoute":null}}],"accountId":"a_1","expiresAt":"2027-01-01T12:00:00.000Z","createdAt":"2026-10-01T12:00:00.000Z","updatedAt":"2026-10-01T12:00:00.000Z"}',NULL,'2026-10-01T12:00:00.000Z','succeeded',NULL,'f4b182c802436ed8b512f7680a14e866bef1bbe0a42598f0efd6d2cb75c79e4e');
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
        );
CREATE TABLE liquidity_allocations (budget_id TEXT NOT NULL, sequence INTEGER NOT NULL, allocation TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,sequence));
CREATE TABLE liquidity_claim_revisions (budget_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO "liquidity_claim_revisions" VALUES('synthetic-upgrade-budget',1);
CREATE TABLE liquidity_claims (budget_id TEXT NOT NULL, id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, bundle TEXT NOT NULL, PRIMARY KEY(budget_id,id), UNIQUE(budget_id,owner_kind,owner_id));
INSERT INTO "liquidity_claims" VALUES('synthetic-upgrade-budget','synthetic-legacy-claim','session','synthetic-legacy-session','{"id":"synthetic-legacy-claim","creationSnapshotId":"synthetic-release-snapshot","creationPolicyVersion":"1","state":"active","expiresAt":"2027-01-01T12:00:00.000Z","initiated":false,"effects":[{"kind":"category","resourceId":"cat_2","amount":{"minorUnits":"1500","currency":"USD"},"economicObligationId":"synthetic-legacy-obligation","categoryId":"cat_2","includedInBalance":false,"matchedTransactionIds":[]}]}');
CREATE TABLE liquidity_current_policy (budget_id TEXT PRIMARY KEY, version TEXT NOT NULL);
INSERT INTO "liquidity_current_policy" VALUES('synthetic-upgrade-budget','1');
CREATE TABLE liquidity_policy_versions (budget_id TEXT NOT NULL, version TEXT NOT NULL, policy TEXT NOT NULL, approval_policy TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,version));
INSERT INTO "liquidity_policy_versions" VALUES('synthetic-upgrade-budget','1','{"version":"1","policyHash":"synthetic-policy","expiresAt":"2027-01-01T12:00:00.000Z","accounts":[],"transferRoutes":[]}','{"minimumApprovers":1}','synthetic-owner','2026-10-01T12:00:00.000Z');
CREATE TABLE liquidity_supplemental_facts (budget_id TEXT NOT NULL, version INTEGER NOT NULL, facts TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,version));
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
        , dedup_key TEXT);
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
CREATE TABLE payment_preferences (budget_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(budget_id,id));
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
        , proposal_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE registration_state (
          singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_user_id   TEXT UNIQUE,
          bootstrapped_at TEXT,
          claim_id        TEXT,
          claimed_email   TEXT,
          claimed_name    TEXT,
          claimed_at      TEXT
        );
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
CREATE TABLE resource_grants (actor_id TEXT NOT NULL, budget_id TEXT NOT NULL, capability TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, granted INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id,budget_id,capability,resource_kind,resource_id));
INSERT INTO "resource_grants" VALUES('synthetic-owner','synthetic-upgrade-budget','policy','budget','synthetic-upgrade-budget',1,'2026-10-01T12:00:00.000Z');
INSERT INTO "resource_grants" VALUES('synthetic-owner','synthetic-upgrade-budget','session','budget','synthetic-upgrade-budget',1,'2026-10-01T12:00:00.000Z');
INSERT INTO "resource_grants" VALUES('synthetic-owner','synthetic-upgrade-budget','category','category','cat_2',1,'2026-10-01T12:00:00.000Z');
INSERT INTO "resource_grants" VALUES('synthetic-owner','synthetic-upgrade-budget','liquidity','account','a_1',1,'2026-10-01T12:00:00.000Z');
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
        );
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
        );
CREATE TABLE rule_overrides (
          rule_id   TEXT PRIMARY KEY,
          inactive  INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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
        , last_used_at TEXT);
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
CREATE TABLE spend_sessions (budget_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(budget_id,id));
INSERT INTO "spend_sessions" VALUES('synthetic-upgrade-budget','synthetic-legacy-session','{"actorId":"synthetic-owner","budgetId":"synthetic-upgrade-budget","id":"synthetic-legacy-session","version":1,"items":[{"id":"synthetic-item","categoryId":"cat_2","amount":{"minorUnits":"1500","currency":"USD"},"purchaseAt":"2026-10-01T12:00:00.000Z","requiredBy":"2027-01-01T12:00:00.000Z","routeSelection":{"explicitAccountId":null,"sessionAccountId":"a_1","approvedPreference":null,"historicalRoute":null}}],"accountId":"a_1","expiresAt":"2027-01-01T12:00:00.000Z","createdAt":"2026-10-01T12:00:00.000Z","updatedAt":"2026-10-01T12:00:00.000Z"}');
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
INSERT INTO "suggestions" VALUES('00000000-0000-4000-8000-000000000003','synthetic-upgrade-budget','tx_000','cat_2','synthetic-upgrade','v0.4.0','{"synthetic":true}',1,NULL,'2026-10-01T12:00:00.000Z');
CREATE TABLE transfer_evidence (budget_id TEXT NOT NULL, evidence_id TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES action_proposals(id), payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(budget_id,evidence_id));
CREATE TABLE transfer_previews (id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, actor_id TEXT NOT NULL, record TEXT NOT NULL);
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
CREATE UNIQUE INDEX idx_review_items_active_issue
          ON review_items(budget_id, transaction_id, category_id, classifier)
          WHERE status != 'superseded';
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
CREATE UNIQUE INDEX idx_notif_events_dedup_identity
          ON notification_events(
            dedup_key,
            recipient_id IS NULL,
            COALESCE(recipient_id, ''),
            scope IS NULL,
            COALESCE(scope, '')
          )
          WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_proposals_active_target ON action_proposals(budget_id, json_extract(payload, '$.transactionId'), operation) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX idx_proposals_payload_unique ON action_proposals(budget_id, operation, COALESCE(json_extract(payload, '$.transactionId'), ''), payload_hash) WHERE superseded_at IS NULL;
COMMIT;
