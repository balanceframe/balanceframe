import type { Database } from 'better-sqlite3';

/** Invalidates legacy generic consent lacking membership and reauthentication provenance. */
export function migrateProposalApprovals(db: Database): void {
  const now = new Date().toISOString();
  db.exec(`
    ALTER TABLE proposal_approvals ADD COLUMN issuer_membership_id TEXT;
    ALTER TABLE proposal_approvals ADD COLUMN governance_policy_version TEXT;
    ALTER TABLE proposal_approvals ADD COLUMN reauthenticated_session_id TEXT;
    ALTER TABLE proposal_approvals ADD COLUMN reauthenticated_at TEXT;
    CREATE TABLE proposal_execution_acquisitions (
      proposal_id TEXT PRIMARY KEY REFERENCES action_proposals(id),
      idempotency_key TEXT NOT NULL UNIQUE REFERENCES idempotency_records(idempotency_key),
      actor_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    UPDATE action_proposals
       SET superseded_at=COALESCE(superseded_at, @now)
     WHERE operation IN ('set_category','create_rule')
       AND (space_id IS NULL OR requester_membership_id IS NULL OR governance_policy_version IS NULL)
  `).run({ now });
  db.prepare(`
    UPDATE proposal_approvals
       SET status='superseded', superseded_at=COALESCE(superseded_at, @now)
     WHERE status='active'
  `).run({ now });
}

/** Captures exact proposal-origin delegation and invalidates ambiguous legacy agents. */
export function migrateProposalOrigins(db: Database): void {
  const now = new Date().toISOString();
  db.exec(`
    ALTER TABLE action_proposals ADD COLUMN requester_delegation_id TEXT;
    ALTER TABLE action_proposals ADD COLUMN requester_delegation_version TEXT;
  `);
  db.prepare(`
    UPDATE action_proposals
       SET superseded_at=COALESCE(superseded_at, @now)
     WHERE operation IN ('set_category','create_rule','update_rule','delete_rule')
       AND superseded_at IS NULL
       AND (requester_delegation_id IS NULL OR requester_delegation_version IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM space_memberships
          WHERE space_memberships.id=action_proposals.requester_membership_id
            AND space_memberships.space_id=action_proposals.space_id
            AND space_memberships.actor_id=action_proposals.actor_id
       )
  `).run({ now });
}
