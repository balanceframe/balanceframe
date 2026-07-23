/** Shared Better Auth migration status for startup readiness and middleware. */

/** Set to true when Better Auth schema migrations fail. */
export let authMigrationFailed = false;
/** Human-readable error message when migrations fail. */
export let authMigrationMessage: string | null = null;

/** Record a migration failure so authenticated requests fail closed. */
export function setAuthMigrationFailed(message: string): void {
  authMigrationFailed = true;
  authMigrationMessage = message;
}

/** Reset migration status for deterministic tests. */
export function resetAuthMigrationStatus(): void {
  authMigrationFailed = false;
  authMigrationMessage = null;
}
