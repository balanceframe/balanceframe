import { afterEach, describe, expect, it } from 'vitest';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  createOwnedScenarioRoot,
  discardOwnedScenarioRoot,
  startScenarioActual,
  startScenarioShell,
  stopScenarioProcesses,
  type ScenarioProcesses,
} from '../src/process-runtime.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_ENTRY = resolve(REPOSITORY_ROOT, 'apps/web/.output/server/index.mjs');
const TEST_TIMEOUT = 120_000;

const activeProcesses = new Set<ScenarioProcesses>();

afterEach(async () => {
  for (const handle of [...activeProcesses].reverse()) {
    activeProcesses.delete(handle);
    await stopScenarioProcesses(handle);
  }
});

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function assertExists(pathname: string): Promise<void> {
  await expect(access(pathname)).resolves.toBeUndefined();
}

async function assertMissing(pathname: string): Promise<void> {
  await expect(access(pathname)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function assertMode(pathname: string, mode: number): Promise<void> {
  const stats = await lstat(pathname);
  expect(stats.mode & 0o777).toBe(mode);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a loopback port for process-runtime tests.');
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function occupiedPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a loopback port for process-runtime tests.');
  }
  return {
    port: address.port,
    close: async () =>
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function startShell(publicOrigin?: string): Promise<ScenarioProcesses> {
  await assertExists(WEB_ENTRY);
  const root = createOwnedScenarioRoot();
  const origin = publicOrigin ?? `http://127.0.0.1:${await availablePort()}`;
  try {
    const handle = await startScenarioShell({ root, publicOrigin: origin, webEntry: WEB_ENTRY });
    activeProcesses.add(handle);
    return handle;
  } catch (error) {
    // The runtime owns this allocated root once createOwnedScenarioRoot returns.
    // Discard through the ownership registry rather than deleting an owned path directly.
    discardOwnedScenarioRoot(root);
    throw error;
  }
}

async function requestHealth(url: string): Promise<Response> {
  return await fetch(new URL('/api/health', url), {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
}

async function listTree(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const pathname = join(current, entry.name);
      result.push(pathname);
      if (entry.isDirectory()) await visit(pathname);
    }
  }
  await visit(root);
  return result.sort();
}

async function withHostileEnvironment<T>(callback: () => Promise<T>): Promise<T> {
  const sentinel = await temporaryDirectory('balanceframe-process-hostile-');
  const sentinelPaths = {
    home: join(sentinel, 'home'),
    tmp: join(sentinel, 'tmp'),
    actualConfig: join(sentinel, 'actual-config.json'),
    actualData: join(sentinel, 'actual-data'),
    actualServerFiles: join(sentinel, 'actual-server-files'),
    actualUserFiles: join(sentinel, 'actual-user-files'),
    authDb: join(sentinel, 'auth.sqlite'),
    workflowDb: join(sentinel, 'workflow.sqlite'),
    credentials: join(sentinel, 'credentials'),
    balanceframeConfig: join(sentinel, 'balanceframe-config.json'),
  };
  await mkdir(sentinelPaths.home, { recursive: true });
  await mkdir(sentinelPaths.tmp, { recursive: true });
  await mkdir(sentinelPaths.actualData, { recursive: true });
  await mkdir(sentinelPaths.actualServerFiles, { recursive: true });
  await mkdir(sentinelPaths.actualUserFiles, { recursive: true });
  await mkdir(sentinelPaths.credentials, { recursive: true });
  const marker = join(sentinel, 'do-not-touch.txt');
  await writeFile(marker, 'sentinel-before');
  const before = await listTree(sentinel);
  const beforeMarker = await readFile(marker, 'utf8');

  const keys = {
    HOME: sentinelPaths.home,
    TMPDIR: sentinelPaths.tmp,
    TMP: sentinelPaths.tmp,
    TEMP: sentinelPaths.tmp,
    ACTUAL_CONFIG_PATH: sentinelPaths.actualConfig,
    ACTUAL_DATA_DIR: sentinelPaths.actualData,
    ACTUAL_SERVER_FILES: sentinelPaths.actualServerFiles,
    ACTUAL_USER_FILES: sentinelPaths.actualUserFiles,
    ACTUAL_LOGIN_METHOD: 'header',
    ACTUAL_ALLOWED_LOGIN_METHODS: 'header',
    ACTUAL_TLS_CERT: join(sentinel, 'tls-cert.pem'),
    ACTUAL_TLS_KEY: join(sentinel, 'tls-key.pem'),
    NUXT_AUTH_DB_PATH: sentinelPaths.authDb,
    BALANCEFRAME_AUTH_DB_PATH: sentinelPaths.authDb,
    NUXT_WORKFLOW_DB_PATH: sentinelPaths.workflowDb,
    BALANCEFRAME_WORKFLOW_DB_PATH: sentinelPaths.workflowDb,
    BALANCEFRAME_CONFIG_PATH: sentinelPaths.balanceframeConfig,
    BALANCEFRAME_CREDENTIAL_DIR: sentinelPaths.credentials,
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(keys)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    expect(await readFile(marker, 'utf8')).toBe(beforeMarker);
    expect(await listTree(sentinel)).toEqual(before);
    await rm(sentinel, { recursive: true, force: true });
  }
}

async function assertOwnedPath(root: string, pathname: string): Promise<void> {
  expect(isAbsolute(pathname)).toBe(true);
  const relativePath = relative(root, pathname);
  expect(relativePath).not.toMatch(/^\.\.(?:[\\/]|$)/);
  expect(relativePath).not.toBe('');
}

async function textFilesUnder(root: string): Promise<string[]> {
  const paths = await listTree(root);
  const contents: string[] = [];
  for (const pathname of paths) {
    try {
      const stats = await lstat(pathname);
      if (!stats.isFile() || !pathname.endsWith('.log')) continue;
      contents.push(await readFile(pathname, 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return contents;
}

describe('scenario process runtime ownership and lifecycle', () => {
  it('allocates a private 0700 root beneath a private 0700 parent', () => {
    const root = createOwnedScenarioRoot();
    return (async () => {
      await assertMode(root, 0o700);
      await assertMode(dirname(root), 0o700);
      discardOwnedScenarioRoot(root);
    })();
  });

  it('rejects an unowned root before writing anything into it', async () => {
    const parent = await temporaryDirectory('balanceframe-process-unowned-');
    const root = join(parent, 'candidate');
    await mkdir(root);
    const marker = join(root, 'sentinel.txt');
    await writeFile(marker, 'untouched');
    const before = await listTree(parent);

    await expect(
      startScenarioShell({
        root,
        publicOrigin: 'http://127.0.0.1:39001',
        webEntry: WEB_ENTRY,
      }),
    ).rejects.toThrow(/owned|allocated|registry/i);

    expect(await listTree(parent)).toEqual(before);
    expect(await readFile(marker, 'utf8')).toBe('untouched');
    await rm(parent, { recursive: true, force: true });
  });

  it('rejects a symlink root before writing through it', async () => {
    const parent = await temporaryDirectory('balanceframe-process-symlink-');
    const target = join(parent, 'target');
    const root = join(parent, 'root-link');
    await mkdir(target);
    const marker = join(target, 'sentinel.txt');
    await writeFile(marker, 'untouched');
    await symlink(target, root, 'dir');
    const before = await listTree(parent);

    await expect(
      startScenarioShell({
        root,
        publicOrigin: 'http://127.0.0.1:39002',
        webEntry: WEB_ENTRY,
      }),
    ).rejects.toThrow(/symlink|owned|allocated/i);

    expect(await listTree(parent)).toEqual(before);
    expect(await readFile(marker, 'utf8')).toBe('untouched');
    await rm(parent, { recursive: true, force: true });
  });


  it('refuses cleanup after an allocated root is replaced by another inode', async () => {
    const root = createOwnedScenarioRoot();
    const parent = dirname(root);
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    const marker = join(root, 'sentinel.txt');
    await writeFile(marker, 'replacement');

    await expect(
      startScenarioShell({
        root,
        publicOrigin: 'http://127.0.0.1:39002',
        webEntry: WEB_ENTRY,
      }),
    ).rejects.toThrow(/inode|allocated|owned/i);
    await expect(() => discardOwnedScenarioRoot(root)).toThrow(/inode|allocated|owned/i);
    expect(await readFile(marker, 'utf8')).toBe('replacement');
    await rm(parent, { recursive: true, force: true });
  });
  it('discards an allocated root after a pre-start validation rejection', async () => {
    const root = createOwnedScenarioRoot();
    const parent = dirname(root);
    await expect(
      startScenarioShell({
        root,
        publicOrigin: 'not-an-origin',
        webEntry: WEB_ENTRY,
      }),
    ).rejects.toThrow(/origin/i);

    discardOwnedScenarioRoot(root);
    await assertMissing(root);
    await assertMissing(parent);
  });

  it('rejects a nonempty allocated root before creating child state', async () => {
    const root = createOwnedScenarioRoot();
    const marker = join(root, 'sentinel.txt');
    await writeFile(marker, 'untouched');

    await expect(
      startScenarioShell({
        root,
        publicOrigin: 'http://127.0.0.1:39003',
        webEntry: WEB_ENTRY,
      }),
    ).rejects.toThrow(/empty|nonempty/i);

    expect(await readFile(marker, 'utf8')).toBe('untouched');
    discardOwnedScenarioRoot(root);
  });

  it(
    'starts the real production Nuxt shell and removes only its owned root on stop',
    { timeout: TEST_TIMEOUT },
    async () => {
      const sentinelParent = await temporaryDirectory('balanceframe-process-sentinel-');
      const sentinel = join(sentinelParent, 'keep.txt');
      await writeFile(sentinel, 'never-delete');
      const handle = await startShell();
      try {
        expect(handle.publicOrigin).toMatch(/^http:\/\//);
        expect(handle.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(new URL(handle.webUrl).port).not.toBe('');
        expect((await requestHealth(handle.webUrl)).status).toBe(200);
      } finally {
        activeProcesses.delete(handle);
        await stopScenarioProcesses(handle);
      }
      await assertMissing(handle.root);
      expect(await readFile(sentinel, 'utf8')).toBe('never-delete');
      await rm(sentinelParent, { recursive: true, force: true });
    },
  );

  it(
    'keeps private shell allocation independent from an occupied public-origin port',
    { timeout: TEST_TIMEOUT },
    async () => {
      const occupied = await occupiedPort();
      try {
        const handle = await startShell(`http://127.0.0.1:${occupied.port}`);
        expect(new URL(handle.webUrl).port).not.toBe(String(occupied.port));
        expect((await requestHealth(handle.webUrl)).status).toBe(200);
        activeProcesses.delete(handle);
        await stopScenarioProcesses(handle);
      } finally {
        await occupied.close();
      }
    },
  );

  it(
    'starts a password-only Actual child and ignores hostile inherited state paths',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withHostileEnvironment(async () => {
        const handle = await startShell('http://127.0.0.1:39003');
        activeProcesses.add(handle);
        try {
          await startScenarioActual(handle);
          const response = await fetch(new URL('/health', handle.actualUrl), {
            signal: AbortSignal.timeout(10_000),
          });
          expect(response.status).toBe(200);
          expect(handle.actualUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
          expect(handle.actualSecretKey).toHaveLength(64);

          for (const pathname of [
            handle.seedClientDir,
            handle.authDbPath,
            handle.workflowDbPath,
            handle.connectionPath,
            handle.manifestPath,
          ]) {
            await assertOwnedPath(handle.root, pathname);
          }
          expect(await textFilesUnder(handle.root)).not.toEqual(
            expect.arrayContaining([
              expect.stringContaining(handle.actualSecretKey),
              expect.stringContaining(handle.bootstrapSecret),
              expect.stringContaining(handle.internalSecret),
            ]),
          );
        } finally {
          activeProcesses.delete(handle);
          await stopScenarioProcesses(handle);
        }
      });
    },
  );

  it(
    'reports an early child exit without leaking child output or leaving an active handle',
    { timeout: TEST_TIMEOUT },
    async () => {
      const root = createOwnedScenarioRoot();
      const entryParent = await temporaryDirectory('balanceframe-process-exit-');
      const entry = join(entryParent, 'exits-before-ready.mjs');
      try {
        await writeFile(
          entry,
          "process.stderr.write('child exited before readiness\\n'); process.exit(17);\n",
          { mode: 0o600 },
        );
        await expect(
          startScenarioShell({
            root,
            publicOrigin: 'http://127.0.0.1:39004',
            webEntry: entry,
          }),
        ).rejects.toThrow(/exit|listen|readiness|shell/i);
        await assertExists(root);
      } finally {
        discardOwnedScenarioRoot(root);
        await rm(entryParent, { recursive: true, force: true });
      }
    },
  );

  it('refuses to clean an unowned root even when given a forged process handle', async () => {
    const parent = await temporaryDirectory('balanceframe-process-forged-');
    const root = join(parent, 'foreign-root');
    await mkdir(root);
    const marker = join(root, 'sentinel.txt');
    await writeFile(marker, 'untouched');

    const forged = {
      root,
      publicOrigin: 'http://127.0.0.1:39005',
      webUrl: 'http://127.0.0.1:39006',
      actualUrl: 'http://127.0.0.1:39007',
      actualSecretKey: randomBytes(32).toString('hex'),
      seedClientDir: join(root, 'seed-client'),
      authDbPath: join(root, 'auth.sqlite'),
      workflowDbPath: join(root, 'workflow.sqlite'),
      connectionPath: join(root, 'connection.json'),
      bootstrapSecret: randomBytes(32).toString('hex'),
      internalSecret: randomBytes(32).toString('hex'),
      manifestPath: join(root, 'manifest.json'),
    } as ScenarioProcesses;

    await expect(stopScenarioProcesses(forged)).rejects.toThrow(/owned|allocated|registry/i);
    await assertExists(root);
    expect(await readFile(marker, 'utf8')).toBe('untouched');
    await rm(parent, { recursive: true, force: true });
  });
});
