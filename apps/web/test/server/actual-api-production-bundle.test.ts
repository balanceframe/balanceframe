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
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(import.meta.dirname, '../..');

const SERVER_CHUNKS = resolve(WEB_ROOT, '.output/server/chunks');
const SERVER_NODE_MODULES = resolve(WEB_ROOT, '.output/server/node_modules');

async function expectTracedActualRuntime(): Promise<void> {
  const chunkPaths = (await readdir(SERVER_CHUNKS, { recursive: true })).filter((path) =>
    path.endsWith('.mjs'),
  );
  const chunks = await Promise.all(
    chunkPaths.map((path) => readFile(resolve(SERVER_CHUNKS, path), 'utf8')),
  );

  await Promise.all([
    access(resolve(SERVER_NODE_MODULES, '@actual-app/api/package.json')),
    access(resolve(SERVER_NODE_MODULES, '@actual-app/api/dist/index.js')),
    access(resolve(SERVER_NODE_MODULES, '@actual-app/api/dist/default-db.sqlite')),
    access(
      resolve(
        SERVER_NODE_MODULES,
        '@actual-app/api/dist/migrations/1548957970627_remove-db-version.sql',
      ),
    ),
    access(
      resolve(SERVER_NODE_MODULES, '@actual-app/api/dist/migrations/1632571489012_remove_cache.js'),
    ),
    access(resolve(SERVER_NODE_MODULES, 'better-sqlite3/package.json')),
    access(resolve(SERVER_NODE_MODULES, 'better-sqlite3/build/Release/better_sqlite3.node')),
  ]);

  expect(chunks.some((chunk) => /import\(["']@actual-app\/api["']\)/.test(chunk))).toBe(true);
  expect(chunks.join('\n')).not.toMatch(/@actual-app\/core/);
}

const SERVER_ENTRY = resolve(WEB_ROOT, '.output/server/index.mjs');

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
}

async function requestJson(url: string): Promise<JsonResponse> {
  return await new Promise<JsonResponse>((resolveResponse, reject) => {
    const requestHandle = request(
      url,
      {
        method: 'GET',
        // Exercise the route through the legacy-token migration path, not
        // the development bypass or an unauthenticated middleware response.
        headers: { authorization: 'Bearer production-bundle-api-token' },
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
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    requestHandle.once('error', reject);
    requestHandle.end();
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
      execFileSync('pnpm', ['exec', 'nuxt', 'build'], {
        cwd: WEB_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      await expectTracedActualRuntime();

      const dataDir = await mkdtemp(resolve(tmpdir(), 'balanceframe-prod-bundle-'));
      activeDataDir = dataDir;
      const port = await availablePort();
      const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: WEB_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          HOST: '127.0.0.1',
          NITRO_PORT: String(port),
          NITRO_HOST: '127.0.0.1',
          BALANCEFRAME_API_TOKEN: 'production-bundle-api-token',
          BALANCEFRAME_DEV_BYPASS_AUTH: 'false',
          NUXT_DEV_BYPASS_AUTH: 'false',
          ACTUAL_SERVER_URL: 'http://127.0.0.1:9',
          ACTUAL_SECRET_KEY: 'production-bundle-test-secret',
          BALANCEFRAME_CONFIG_PATH: resolve(dataDir, 'config.json'),
          BALANCEFRAME_WORKFLOW_DB_PATH: resolve(dataDir, 'workflow.db'),
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
        const response = await requestJson(`http://127.0.0.1:${port}/api/connection/budgets`);
        const body = response.body as {
          status?: unknown;
          error?: { code?: unknown; message?: unknown } | null;
        };
        const message = typeof body.error?.message === 'string' ? body.error.message : '';
        await stopChild(child);
        activeChild = null;

        // 503 with the route's own error code proves the legacy bearer token
        // passed auth and budget discovery reached the Actual client.
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
