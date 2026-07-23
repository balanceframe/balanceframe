/**
 * Nitro server plugin that runs Better Auth database schema migrations.
 *
 * Runs once during server startup, before accepting requests.  The
 * migration is idempotent — Better Auth's `getMigrations` only creates
 * tables that do not exist yet.
 *
 * If the migration fails, the plugin sets a global flag that causes
 * auth middleware to reject non-health requests with a service-unavailable
 * response, ensuring the server does not silently serve degraded state.
 *
 * Uses Better Auth's built-in Kysely adapter for SQLite.
 */

import { getMigrations } from 'better-auth/db/migration';
import { auth } from '../../lib/auth';
import { setAuthMigrationFailed, authMigrationMessage } from '../utils/auth-migration-status';

export default defineNitroPlugin(async () => {
  try {
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    console.log('[auth] Database migrations complete');
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    setAuthMigrationFailed(message);
    console.error('[auth] Failed to run database migrations:', message);
  }
});
