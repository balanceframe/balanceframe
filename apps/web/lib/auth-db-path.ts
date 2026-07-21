/**
 * Resolve the path to the Better Auth SQLite database.
 *
 * Priority:
 *  1. `NUXT_AUTH_DB_PATH` — Nuxt runtimeConfig.authDbPath env override
 *  2. `BALANCEFRAME_AUTH_DB_PATH` — legacy env var
 *  3. `./data/auth.db` — default
 *
 * Pure function with no side effects — safe to import in tests without
 * triggering native module loading (better-sqlite3).
 */
export function resolveAuthDbPath(): string {
  return (
    process.env.NUXT_AUTH_DB_PATH ||
    process.env.BALANCEFRAME_AUTH_DB_PATH ||
    './data/auth.db'
  );
}
