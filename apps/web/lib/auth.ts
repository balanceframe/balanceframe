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
 * Schema migrations are handled by `server/plugins/auth-migration.ts`.
 */

import { betterAuth } from 'better-auth';
import Database from 'better-sqlite3';
import { apiKey } from '@better-auth/api-key';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveAuthDbPath } from './auth-db-path';

const AUTH_DB_PATH = resolveAuthDbPath();

// Ensure the parent directory exists — better-sqlite3 cannot create it.
mkdirSync(dirname(AUTH_DB_PATH), { recursive: true });

const db = new Database(AUTH_DB_PATH);

// Enable WAL mode for better concurrent read performance.
db.pragma('journal_mode = WAL');

const BASE_URL = process.env.BETTER_AUTH_URL || 'http://localhost:3000';

export const auth = betterAuth({
  database: db,
  baseURL: BASE_URL,

  emailAndPassword: {
    enabled: true,
    /** Disable public self-registration — accounts must be created by an admin. */
    disableSignUp: true,
  },

  plugins: [apiKey()],
});
