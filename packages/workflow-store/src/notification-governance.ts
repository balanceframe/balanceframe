import type { Database as DatabaseType } from 'better-sqlite3';

/** Pins new notifications to their original recipient period; legacy notifications stay inert. */
export function migrateNotificationGovernance(db: DatabaseType): void {
  db.exec(`
    ALTER TABLE notification_events ADD COLUMN space_id TEXT REFERENCES spaces(id);
    ALTER TABLE notification_events ADD COLUMN recipient_membership_id TEXT REFERENCES space_memberships(id);
    DROP INDEX idx_notif_events_dedup_identity;
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
  `);
}
