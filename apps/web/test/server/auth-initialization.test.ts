// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let dbPath: string;
let database: Database.Database | undefined;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'balanceframe-auth-initialization-'));
  dbPath = join(root, 'auth.db');
  vi.stubEnv('NUXT_AUTH_DB_PATH', dbPath);
  vi.stubEnv('BETTER_AUTH_SECRET', 'auth-initialization-test-secret-with-enough-entropy');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
});

afterEach(() => {
  database?.close();
  database = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('initializes a fresh auth database before use and preserves its session across restart', async () => {
  const { auth } = await import('../../lib/auth');
  database = auth.options.database;
  await auth.$context;
  const password = 'auth-initialization-fixture-password';
  const created = await auth.api.createUser({ body: {
    email: 'initialization-owner@example.test', name: 'Initialization owner', password,
  } });
  const signedIn = await auth.api.signInEmail({
    body: { email: created.user.email, password }, returnHeaders: true,
  });
  const headers = new Headers({
    cookie: signedIn.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; '),
  });
  expect((await auth.api.getSession({ headers }))?.user.id).toBe(created.user.id);

  database.close();
  database = undefined;
  vi.resetModules();
  const { auth: restarted } = await import('../../lib/auth');
  database = restarted.options.database;
  await restarted.$context;
  expect((await restarted.api.getSession({ headers }))?.user.id).toBe(created.user.id);
  expect((await import('../../server/utils/auth-migration-status')).authMigrationFailed).toBe(false);
}, 30_000);

it('records a real migration failure instead of admitting authentication against a broken schema', async () => {
  const incompatible = new Database(dbPath);
  incompatible.exec('CREATE VIEW user AS SELECT 1 AS id');
  incompatible.close();
  const { auth } = await import('../../lib/auth');
  database = auth.options.database;
  await auth.$context;
  const status = await import('../../server/utils/auth-migration-status');
  expect(status.authMigrationFailed).toBe(true);
  await expect(auth.api.createUser({ body: {
    email: 'blocked-owner@example.test', name: 'Blocked owner',
    password: 'auth-initialization-fixture-password',
  } })).rejects.toThrow();
}, 30_000);
