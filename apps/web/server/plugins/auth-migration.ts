/**
 * Nitro server plugin that runs Better Auth database schema migrations.
 *
 * Runs once during server startup, before accepting requests.  The
 * migration is idempotent — Better Auth's `getMigrations` only creates
 * tables that do not exist yet.
 *
 * Uses Better Auth's built-in Kysely adapter for SQLite.
 */

import { getMigrations } from 'better-auth/db/migration';
import { auth } from '../../lib/auth';

export default defineNitroPlugin(async () => {
  try {
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    console.log('[auth] Database migrations complete');
  } catch (e: unknown) {
    console.error('[auth] Failed to run database migrations:', e);
    // Do not block server startup — the server may still function for
    // read-only / health operations without auth tables.
  }
});
