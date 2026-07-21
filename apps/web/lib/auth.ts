/**
 * Better Auth server instance for BalanceFrame.
 *
 * Authentication is owned by Better Auth (users, sessions, credentials).
 * Authorization (spaces, capabilities, approvals, delegation) is owned by
 * BalanceFrame and enforced independently.
 *
 * Database: SQLite (better-sqlite3), path configurable via
 * `BALANCEFRAME_AUTH_DB_PATH` env var (default `./data/auth.db`).
 *
 * Schema migrations are handled by `server/plugins/auth-migration.ts`.
 */

import { betterAuth } from 'better-auth';
import Database from 'better-sqlite3';
import { apiKey } from '@better-auth/api-key';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const AUTH_DB_PATH =
  process.env.BALANCEFRAME_AUTH_DB_PATH || './data/auth.db';

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
  },

  plugins: [apiKey()],
});
