/**
 * Better Auth server instance for BalanceFrame.
 *
 * Authentication is owned by Better Auth (users, sessions, credentials).
 * Authorization (spaces, capabilities, approvals, delegation) is owned by
 * BalanceFrame and enforced independently.
 *
 * Database: SQLite (better-sqlite3), path configurable via environment.
 * Priority: NUXT_AUTH_DB_PATH > BALANCEFRAME_AUTH_DB_PATH > ./data/auth.db.
 * NUXT_AUTH_DB_PATH is the Nuxt runtimeConfig.authDbPath env override
 * convention; BALANCEFRAME_AUTH_DB_PATH is the legacy fallback.
 *
 * Schema migrations finish before Better Auth starts schema validation.
 */

import { admin } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveAuthDbPath } from './auth-db-path';
import { setAuthMigrationFailed } from '../server/utils/auth-migration-status';

const AUTH_DB_PATH = resolveAuthDbPath();

// Ensure the parent directory exists — better-sqlite3 cannot create it.
mkdirSync(dirname(AUTH_DB_PATH), { recursive: true });

const db = new Database(AUTH_DB_PATH);

// Enable WAL mode for better concurrent read performance.
db.pragma('journal_mode = WAL');

const BASE_URL = process.env.BETTER_AUTH_URL || 'http://localhost:3000';

const options = {
  database: db,
  baseURL: BASE_URL,
  secret: process.env.BETTER_AUTH_SECRET || process.env.NUXT_BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    /** Disable public self-registration — accounts must be created by an admin. */
    disableSignUp: true,
  },
  // Fixture setup signs in several fictional actors from one private loopback IP.
  // Browser sign-in is blocked by the demo boundary; retain a finite limit.
  ...(process.env.NUXT_DEMO_MANIFEST_PATH ? {
    rateLimit: { customRules: { '/sign-in/email': { window: 10, max: 20 } } },
  } : {}),

  plugins: [
    admin(),
    apiKey(),
  ],
} satisfies BetterAuthOptions;

try {
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  console.log('[auth] Database migrations complete');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  setAuthMigrationFailed(message);
  console.error('[auth] Failed to run database migrations:', message);
}

/** Authentication instance, constructed only after the schema migration attempt. */
export const auth = betterAuth(options);
