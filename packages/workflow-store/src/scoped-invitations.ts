import type { Database } from 'better-sqlite3';

/** Captures immutable scoped invitation consent; legacy global invitations remain inert. */
export function migrateScopedInvitations(db: Database): void {
  db.exec(`
    ALTER TABLE invitations ADD COLUMN space_id TEXT;
    ALTER TABLE invitations ADD COLUMN issuer_membership_id TEXT;
    ALTER TABLE invitations ADD COLUMN governance_policy_version TEXT;
    CREATE INDEX invitations_by_space ON invitations(space_id, created_at);
  `);
}
