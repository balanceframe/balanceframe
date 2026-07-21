/**
 * Regression tests for the auth database path resolution.
 *
 * The resolution logic lives in `lib/auth-db-path.ts` (a pure function with
 * no native-module dependencies) and is consumed by `lib/auth.ts`.
 *
 * These tests verify the env var precedence contract:
 *   NUXT_AUTH_DB_PATH > BALANCEFRAME_AUTH_DB_PATH > ./data/auth.db
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveAuthDbPath } from '../../lib/auth-db-path';

describe('resolveAuthDbPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses NUXT_AUTH_DB_PATH when set', () => {
    vi.stubEnv('NUXT_AUTH_DB_PATH', '/custom/nuxt/auth.db');
    vi.stubEnv('BALANCEFRAME_AUTH_DB_PATH', '/legacy/auth.db');

    expect(resolveAuthDbPath()).toBe('/custom/nuxt/auth.db');
  });

  it('uses NUXT_AUTH_DB_PATH even when empty string — explicit env override', () => {
    // An empty NUXT_AUTH_DB_PATH means the user explicitly set it to
    // empty, which is falsy.  The || operator falls through to the next
    // fallback, which is the same behaviour as not being set at all.
    vi.stubEnv('NUXT_AUTH_DB_PATH', '');
    vi.stubEnv('BALANCEFRAME_AUTH_DB_PATH', '/legacy/auth.db');

    expect(resolveAuthDbPath()).toBe('/legacy/auth.db');
  });

  it('falls back to BALANCEFRAME_AUTH_DB_PATH when NUXT_AUTH_DB_PATH is unset', () => {
    vi.stubEnv('NUXT_AUTH_DB_PATH', undefined as unknown as string);
    vi.stubEnv('BALANCEFRAME_AUTH_DB_PATH', '/legacy/auth.db');

    expect(resolveAuthDbPath()).toBe('/legacy/auth.db');
  });

  it('uses default ./data/auth.db when no env vars are set', () => {
    vi.stubEnv('NUXT_AUTH_DB_PATH', undefined as unknown as string);
    vi.stubEnv('BALANCEFRAME_AUTH_DB_PATH', undefined as unknown as string);

    expect(resolveAuthDbPath()).toBe('./data/auth.db');
  });

  it('handles BALANCEFRAME_AUTH_DB_PATH set to :memory: (legacy test config)', () => {
    // This mirrors the vitest.config.ts env setting that the middleware
    // tests rely on.
    vi.stubEnv('NUXT_AUTH_DB_PATH', undefined as unknown as string);
    vi.stubEnv('BALANCEFRAME_AUTH_DB_PATH', ':memory:');

    expect(resolveAuthDbPath()).toBe(':memory:');
  });
});
