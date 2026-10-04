/**
 * Production-bundle regression for the Actual API runtime dependency.
 *
 * Rollup must leave `@actual-app/api` as a Node runtime dependency and Nitro
 * must trace it into the production artifact. Bundling its CommonJS server
 * filesystem module into an ESM chunk removes `__dirname` and makes every
 * configured ledger request fail before connecting to Actual.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(import.meta.dirname, '../..');

async function expectTracedActualRuntime(serverNodeModules: string): Promise<void> {
  await Promise.all([
    access(resolve(serverNodeModules, '@actual-app/api/package.json')),
    access(resolve(serverNodeModules, '@actual-app/api/dist/index.js')),
    access(resolve(serverNodeModules, '@actual-app/api/dist/default-db.sqlite')),
    access(
      resolve(
        serverNodeModules,
        '@actual-app/api/dist/migrations/1548957970627_remove-db-version.sql',
      ),
    ),
    access(
      resolve(serverNodeModules, '@actual-app/api/dist/migrations/1632571489012_remove_cache.js'),
    ),
    access(resolve(serverNodeModules, 'better-sqlite3/package.json')),
    access(resolve(serverNodeModules, 'better-sqlite3/build/Release/better_sqlite3.node')),
  ]);
}

let activeChild: ChildProcessWithoutNullStreams | null = null;
let activeDataDir: string | null = null;

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

afterEach(async () => {
  if (activeChild) await stopChild(activeChild);
  if (activeDataDir) await rm(activeDataDir, { recursive: true, force: true });
  activeChild = null;
  activeDataDir = null;
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate a production smoke-test port.');
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

interface JsonResponse {
  statusCode: number;
  body: unknown;
  cookies: string[];
}

async function requestJson(url: string, options: {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}): Promise<JsonResponse> {
  const payload = options.body ? JSON.stringify(options.body) : undefined;
  return await new Promise<JsonResponse>((resolveResponse, reject) => {
    const requestHandle = request(
      url,
      {
        method: options.method ?? 'GET',
        headers: {
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.once('end', () => {
          try {
            resolveResponse({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(body),
              cookies: response.headers['set-cookie'] ?? [],
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    requestHandle.once('error', reject);
    requestHandle.end(payload);
  });
}

async function waitUntilListening(child: ChildProcessWithoutNullStreams): Promise<() => string> {
  return await new Promise<() => string>((resolveReady, reject) => {
    let output = '';
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Listening on')) resolveReady(() => output);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      reject(new Error(`Production server exited with code ${String(code)}. Output: ${output}`));
    });
  });
}

describe('production Actual API bundle', () => {
  it(
    'loads the Actual client without CommonJS or module-resolution failures',
    { timeout: 180_000 },
    async () => {
      const dataDir = await mkdtemp(resolve(tmpdir(), 'balanceframe-prod-bundle-'));
      activeDataDir = dataDir;
      const outputDir = resolve(dataDir, '.output');
      // Scenario tests use the workspace bundle concurrently; never rebuild their artifact.
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
          import { build, loadNuxt } from 'nuxt';
          import { resolve } from 'node:path';
          const root = process.argv[1];
          const nuxt = await loadNuxt({
            cwd: process.cwd(),
            overrides: {
              dev: false,
              buildDir: resolve(root, '.nuxt'),
              nitro: { output: { dir: resolve(root, '.output') } },
            },
          });
          try { await build(nuxt); } finally { await nuxt.close(); }
        `,
          dataDir,
        ],
        {
          cwd: WEB_ROOT,
          env: { ...process.env, NODE_ENV: 'production' },
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
      await expectTracedActualRuntime(resolve(outputDir, 'server/node_modules'));
      const port = await availablePort();
      const child = spawn(process.execPath, [resolve(outputDir, 'server/index.mjs')], {
        cwd: WEB_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          HOST: '127.0.0.1',
          NITRO_PORT: String(port),
          NITRO_HOST: '127.0.0.1',
          BALANCEFRAME_DEV_BYPASS_AUTH: 'false',
          NUXT_DEV_BYPASS_AUTH: 'false',
          ACTUAL_SERVER_URL: 'http://127.0.0.1:9',
          ACTUAL_SECRET_KEY: 'production-bundle-test-secret',
          BALANCEFRAME_CONFIG_PATH: resolve(dataDir, 'config.json'),
          BALANCEFRAME_WORKFLOW_DB_PATH: resolve(dataDir, 'workflow.db'),
          NUXT_WORKFLOW_DB_PATH: resolve(dataDir, 'workflow.db'),
          NUXT_AUTH_DB_PATH: resolve(dataDir, 'auth.db'),
          BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
          BETTER_AUTH_SECRET: 'production-bundle-test-better-auth-secret',
          BALANCEFRAME_BOOTSTRAP_SECRET: 'production-bundle-test-bootstrap-secret',
        },
        stdio: 'pipe',
      });
      activeChild = child;

      try {
        const readServerOutput = await waitUntilListening(child);
        const baseUrl = `http://127.0.0.1:${port}`;
        const cookies = new Map<string, string>();
        const password = 'production-bundle-owner-password';
        const call = async (path: string, body?: Record<string, unknown>, spaceId?: string) => {
          const response = await requestJson(`${baseUrl}${path}`, {
            method: body ? 'POST' : 'GET',
            body,
            headers: {
              origin: baseUrl,
              cookie: [...cookies.values()].join('; '),
              ...(spaceId ? { 'x-balanceframe-space': spaceId } : {}),
            },
          });
          for (const value of response.cookies) {
            const pair = value.split(';', 1)[0]!;
            cookies.set(pair.split('=', 1)[0]!, pair);
          }
          return response;
        };
        const registered = await call('/api/registration/bootstrap', {
          name: 'Bundle owner',
          email: 'bundle-owner@example.test',
          password,
          bootstrapSecret: 'production-bundle-test-bootstrap-secret',
        });
        expect(registered.statusCode).toBe(200);
        const signedIn = await call('/api/auth/sign-in/email', {
          email: 'bundle-owner@example.test', password,
        });
        expect(signedIn.statusCode).toBe(200);
        const reauthenticated = await call('/api/reauth', { password });
        expect(reauthenticated.statusCode).toBe(200);
        const created = await call('/api/spaces', { name: 'Bundle loading', kind: 'personal' });
        expect(created.statusCode).toBe(200);
        const spaceBody = created.body as { result?: { space?: { id?: unknown } } };
        const spaceId = spaceBody.result?.space?.id;
        if (typeof spaceId !== 'string') throw new Error('Production owner space unavailable');
        const response = await call('/api/connection/budgets', undefined, spaceId);
        const body = response.body as {
          status?: unknown;
          error?: { code?: unknown; message?: unknown } | null;
        };
        const message = typeof body.error?.message === 'string' ? body.error.message : '';
        await stopChild(child);
        activeChild = null;

        // A real reauthenticated owner reaches the SDK through current space control.
        // This Actual-specific 503 proves the production client was loaded.
        expect(response.statusCode).toBe(503);
        expect(body.status).toBe('error');
        expect(body.error?.code).toBe('ACTUAL_BUDGET_LIST_FAILED');
        expect(`${message}\n${readServerOutput()}`).not.toMatch(
          /__dirname|module scope|cannot find (?:package|module)|failed to resolve module|ERR_MODULE_NOT_FOUND/i,
        );
      } finally {
        await stopChild(child);
        activeChild = null;
        await rm(dataDir, { recursive: true, force: true });
        activeDataDir = null;
      }
    },
  );
});
