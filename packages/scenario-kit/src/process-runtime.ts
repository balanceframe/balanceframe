import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const LOOPBACK_HOST = '127.0.0.1';
const ROOT_MODE = 0o700;
const FILE_MODE = 0o600;
const STARTUP_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 1_500;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const RESET_TIMEOUT_MS = 45_000;
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

interface OwnedRoot {
  readonly root: string;
  readonly parent: string;
  readonly device: number;
  readonly inode: number;
}

interface RuntimeDirectories {
  readonly home: string;
  readonly temp: string;
  readonly credentials: string;
  readonly actual: string;
  readonly actualData: string;
  readonly actualServerFiles: string;
  readonly actualUserFiles: string;
  readonly actualConfig: string;
  readonly balanceframeConfigDirectory: string;
}

type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface RuntimeChild {
  readonly process: ManagedChildProcess;
  readonly name: 'web' | 'actual';
}

interface InternalScenarioProcesses {
  readonly publicHandle: ScenarioProcesses;
  readonly ownership: OwnedRoot;
  readonly directories: RuntimeDirectories;
  readonly actualPort: number;
  readonly webPort: number;
  readonly web: RuntimeChild;
  actual: RuntimeChild | undefined;
  stopPromise: Promise<void> | undefined;
}

/**
 * Public process state. Child process objects intentionally remain private so
 * callers cannot substitute a PID or kill a process they do not own.
 */
export interface ScenarioProcesses {
  readonly root: string;
  readonly webUrl: string;
  readonly actualUrl: string;
  readonly actualSecretKey: string;
  readonly seedClientDir: string;
  readonly authDbPath: string;
  readonly workflowDbPath: string;
  readonly connectionPath: string;
  readonly bootstrapSecret: string;
  readonly internalSecret: string;
  readonly manifestPath: string;
  readonly publicOrigin: string;
}

const ownedRoots = new Map<string, OwnedRoot>();
const activeRoots = new Map<string, ScenarioProcesses>();
const internalProcesses = new WeakMap<ScenarioProcesses, InternalScenarioProcesses>();
const stoppedHandles = new WeakSet<ScenarioProcesses>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function makeSecret(): string {
  return randomBytes(32).toString('hex');
}

function childPathEnvironment(): string {
  return process.env.PATH && process.env.PATH.trim().length > 0 ? process.env.PATH : DEFAULT_PATH;
}

function trustedTempDirectory(): string {
  if (process.platform === 'win32') return 'C:\\Windows\\Temp';
  if (process.platform === 'darwin') return '/private/tmp';
  return '/tmp';
}

function assertNoSymlinkPath(pathname: string): void {
  const absolute = resolve(pathname);
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let stats;
    try {
      stats = lstatSync(cursor);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) break;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Scenario process path contains a symlink: ${cursor}`);
    }
  }
}

function assertAbsolutePath(pathname: string, label: string): string {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(pathname);
}

function assertPublicOrigin(publicOrigin: string): string {
  if (typeof publicOrigin !== 'string' || publicOrigin.length === 0) {
    throw new Error('Scenario publicOrigin must be a non-empty origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new Error('Scenario publicOrigin must be a valid HTTP(S) origin');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Scenario publicOrigin must use HTTP(S)');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Scenario publicOrigin must not contain credentials, paths, queries, or fragments');
  }
  if (parsed.origin !== publicOrigin && `${parsed.origin}/` !== publicOrigin) {
    throw new Error('Scenario publicOrigin must be an exact origin');
  }
  return publicOrigin;
}

function canonicalPath(pathname: string): string {
  try {
    return realpathSync.native(pathname);
  } catch {
    return realpathSync(pathname);
  }
}

function validateOwnedRoot(rootInput: string): OwnedRoot {
  const root = assertAbsolutePath(rootInput, 'Scenario root');
  assertNoSymlinkPath(root);
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error('Scenario root is not an allocated owned root');
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Scenario root must be an owned directory');
  }
  const canonical = canonicalPath(root);
  const ownership = ownedRoots.get(canonical);
  if (!ownership || ownership.root !== canonical) {
    throw new Error('Scenario root is not an allocated owned root');
  }
  if (stats.dev !== ownership.device || stats.ino !== ownership.inode) {
    throw new Error('Scenario root inode no longer matches its allocation');
  }
  const parent = dirname(canonical);
  if (canonicalPath(parent) !== ownership.parent) {
    throw new Error('Scenario root ownership parent changed');
  }
  return ownership;
}

function assertEmptyDirectory(pathname: string): void {
  if (readdirSync(pathname).length !== 0) {
    throw new Error('Scenario root must be empty before child startup');
  }
}

function ensureDirectory(pathname: string): void {
  assertNoSymlinkPath(dirname(pathname));
  mkdirSync(pathname, { recursive: true, mode: ROOT_MODE });
  chmodSync(pathname, ROOT_MODE);
}

function ensurePrivateFile(pathname: string, contents: string): void {
  assertNoSymlinkPath(dirname(pathname));
  const descriptor = openSync(pathname, 'wx', FILE_MODE);
  try {
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
  } finally {
    closeSync(descriptor);
  }
  chmodSync(pathname, FILE_MODE);
}

function createDirectories(root: string): RuntimeDirectories {
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const credentials = join(root, 'credentials');
  const actual = join(root, 'actual');
  const actualData = join(actual, 'data');
  const actualServerFiles = join(actual, 'server-files');
  const actualUserFiles = join(actual, 'user-files');
  const actualConfig = join(actual, 'config.json');
  const balanceframeConfigDirectory = join(home, '.balanceframe');

  for (const directory of [
    home,
    temp,
    credentials,
    actual,
    actualData,
    actualServerFiles,
    actualUserFiles,
    balanceframeConfigDirectory,
  ]) {
    ensureDirectory(directory);
  }
  ensurePrivateFile(actualConfig, '{}\n');
  return {
    home,
    temp,
    credentials,
    actual,
    actualData,
    actualServerFiles,
    actualUserFiles,
    actualConfig,
    balanceframeConfigDirectory,
  };
}

function buildChildEnvironment(
  directories: RuntimeDirectories,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    PATH: childPathEnvironment(),
    HOME: directories.home,
    TMPDIR: directories.temp,
    TMP: directories.temp,
    TEMP: directories.temp,
    BALANCEFRAME_CREDENTIAL_DIR: directories.credentials,
    ACTUAL_CONFIG_PATH: directories.actualConfig,
    ACTUAL_DATA_DIR: directories.actualData,
    ACTUAL_SERVER_FILES: directories.actualServerFiles,
    ACTUAL_USER_FILES: directories.actualUserFiles,
    ACTUAL_HOSTNAME: LOOPBACK_HOST,
    ACTUAL_LOGIN_METHOD: 'password',
    ACTUAL_ALLOWED_LOGIN_METHODS: 'password',
    ...values,
  };
}

function createActualEnvironment(
  state: Pick<InternalScenarioProcesses, 'directories' | 'actualPort' | 'publicHandle'>,
): Record<string, string> {
  return buildChildEnvironment(state.directories, {
    ACTUAL_PORT: String(state.actualPort),
    ACTUAL_SECRET_KEY: state.publicHandle.actualSecretKey,
  });
}

function createWebEnvironment(
  state: Pick<InternalScenarioProcesses, 'directories' | 'actualPort' | 'webPort' | 'publicHandle'>,
): Record<string, string> {
  const handle = state.publicHandle;
  return buildChildEnvironment(state.directories, {
    NODE_ENV: 'production',
    HOST: LOOPBACK_HOST,
    PORT: String(state.webPort),
    NITRO_HOST: LOOPBACK_HOST,
    NITRO_PORT: String(state.webPort),
    BALANCEFRAME_CREDENTIAL_DIR: state.directories.credentials,
    NUXT_AUTH_DB_PATH: handle.authDbPath,
    BALANCEFRAME_AUTH_DB_PATH: handle.authDbPath,
    NUXT_WORKFLOW_DB_PATH: handle.workflowDbPath,
    BALANCEFRAME_WORKFLOW_DB_PATH: handle.workflowDbPath,
    BALANCEFRAME_CONFIG_PATH: handle.connectionPath,
    NUXT_DEMO_MANIFEST_PATH: handle.manifestPath,
    BETTER_AUTH_URL: handle.publicOrigin,
    BETTER_AUTH_SECRET: handle.internalSecret,
    NUXT_BETTER_AUTH_SECRET: handle.internalSecret,
    BALANCEFRAME_BOOTSTRAP_SECRET: handle.bootstrapSecret,
    ACTUAL_SERVER_URL: handle.actualUrl,
    ACTUAL_SECRET_KEY: handle.actualSecretKey,
    NUXT_DEV_BYPASS_AUTH: 'false',
    BALANCEFRAME_DEV_BYPASS_AUTH: 'false',
    NUXT_PUBLIC_DEMO_MODE: 'true',
    NUXT_REVIEW_AND_APPLY: 'true',
  });
}

function drainChildOutput(child: ManagedChildProcess): void {
  child.stdout.resume();
  child.stderr.resume();
}

function spawnChild(
  name: RuntimeChild['name'],
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): RuntimeChild {
  const child = spawn(executable, [...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  drainChildOutput(child);
  return { process: child, name };
}

function childExitError(child: ChildProcess, name: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`${name} child failed to start: ${error.message}`));
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      const status = signal ? `signal ${signal}` : `code ${String(code)}`;
      reject(new Error(`${name} child exited before readiness (${status})`));
    };
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function probeHttp(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status >= 100 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttp(
  child: ChildProcess,
  url: string,
  name: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  const exited = childExitError(child, name);
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    const probe = probeHttp(url);
    const ready = await Promise.race([
      probe,
      exited.then(() => false as const),
      new Promise<false>((resolveReady) => setTimeout(() => resolveReady(false), Math.min(remaining, PROBE_TIMEOUT_MS))),
    ]);
    if (ready) return;
  }
  throw new Error(`${name} child did not become ready over HTTP`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    const done = () => {
      child.off('close', done);
      child.off('error', done);
      resolveExit();
    };
    child.once('close', done);
    child.once('error', done);
  });
  child.kill('SIGTERM');
  let resolveTimeout = () => {};
  const timeoutPromise = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeout = setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS);
  try {
    await Promise.race([exited, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function expectScript(): string {
  return `
set timeout 30
log_user 0
spawn actual-server --reset-password
expect -re "Enter a password, then press enter:" {
  send -- "$env(ACTUAL_SECRET_KEY)"
  after 500
  send -- "\\r"
}
expect -re "Enter the password again, then press enter:" {
  send -- "$env(ACTUAL_SECRET_KEY)"
  after 500
  send -- "\\r"
}
expect {
  -re "Password (set|changed)!" {
    expect eof
    exit 0
  }
  -re "Passwords do not match." { exit 1 }
  eof { exit 1 }
}
`;
}

async function resetActualPassword(
  state: Pick<InternalScenarioProcesses, 'directories' | 'actualPort' | 'publicHandle'>,
): Promise<void> {
  const env = createActualEnvironment(state);
  const child = spawn('expect', [], {
    cwd: state.publicHandle.root,
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  const completion = new Promise<{ code: number | null; signal: string | null }>(
    (resolveCompletion, rejectCompletion) => {
      child.once('error', rejectCompletion);
      child.once('close', (code, signal) => resolveCompletion({ code, signal }));
    },
  );
  if (!child.stdin) throw new Error('Actual password reset could not open stdin');
  child.stdin.write(expectScript());
  child.stdin.end();
  let resolveTimeout = () => {};
  const timeoutPromise = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeout = setTimeout(resolveTimeout, RESET_TIMEOUT_MS);
  try {
    const result = await Promise.race([completion, timeoutPromise]);
    if (result === undefined) throw new Error('Actual password reset timed out');
    if (result.code !== 0 || result.signal !== null) {
      throw new Error('Actual password reset failed');
    }
  } finally {
    clearTimeout(timeout);
    await stopChild(child);
  }
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, LOOPBACK_HOST, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a loopback process port');
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

function assertWebEntry(webEntryInput: string): string {
  const webEntry = assertAbsolutePath(webEntryInput, 'Scenario webEntry');
  assertNoSymlinkPath(webEntry);
  let stats;
  try {
    stats = lstatSync(webEntry);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error('Scenario webEntry does not exist');
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Scenario webEntry must be a regular file');
  }
  return webEntry;
}

function safeCleanup(ownership: OwnedRoot): void {
  const root = ownership.root;
  assertNoSymlinkPath(root);
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      ownedRoots.delete(root);
      return;
    }
    throw error;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== ownership.device ||
    stats.ino !== ownership.inode ||
    canonicalPath(root) !== root
  ) {
    throw new Error('Refusing to clean a changed or symlinked scenario root');
  }
  rmSync(root, { recursive: true, force: false });
  ownedRoots.delete(root);
  try {
    if (canonicalPath(dirname(root)) !== ownership.parent) return;
    if (readdirSync(dirname(root)).length === 0) rmdirSync(dirname(root));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/**
 * Discard an allocated root before any child handle is returned. This is the
 * only pre-start cleanup path; it still relies on the in-memory allocation
 * registry and never treats a marker or PID file as authority.
 */
export function discardOwnedScenarioRoot(rootInput: string): void {
  const ownership = validateOwnedRoot(rootInput);
  if (activeRoots.has(ownership.root)) {
    throw new Error('Cannot discard a scenario root while a child is active');
  }
  safeCleanup(ownership);
}

/** Allocate an owned 0700 workspace beneath a private 0700 temporary parent. */
export function createOwnedScenarioRoot(): string {
  const parent = mkdtempSync(join(trustedTempDirectory(), 'balanceframe-scenario-parent-'));
  try {
    chmodSync(parent, ROOT_MODE);
    const root = mkdtempSync(join(parent, 'workspace-'));
    chmodSync(root, ROOT_MODE);
    assertNoSymlinkPath(parent);
    assertNoSymlinkPath(root);
    const canonicalRoot = canonicalPath(root);
    const canonicalParent = canonicalPath(parent);
    if (canonicalRoot !== root || canonicalParent !== parent) {
      throw new Error('Scenario workspace allocation resolved through a symlink');
    }
    const rootStats = lstatSync(canonicalRoot);
    ownedRoots.set(canonicalRoot, {
      root: canonicalRoot,
      parent: canonicalParent,
      device: rootStats.dev,
      inode: rootStats.ino,
    });
    return root;
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

export async function startScenarioShell(options: {
  readonly root: string;
  readonly publicOrigin: string;
  readonly webEntry: string;
}): Promise<ScenarioProcesses> {
  const ownership = validateOwnedRoot(options.root);
  const publicOrigin = assertPublicOrigin(options.publicOrigin);
  const webEntry = assertWebEntry(options.webEntry);
  const root = ownership.root;
  assertEmptyDirectory(root);
  const directories = createDirectories(root);
  const webPort = await allocatePort();
  const actualPort = await allocatePort();
  const publicHandle: ScenarioProcesses = Object.freeze({
    root,
    webUrl: `http://${LOOPBACK_HOST}:${webPort}`,
    actualUrl: `http://${LOOPBACK_HOST}:${actualPort}`,
    actualSecretKey: makeSecret(),
    seedClientDir: join(root, 'seed-client'),
    authDbPath: join(root, 'auth.sqlite'),
    workflowDbPath: join(root, 'workflow.sqlite'),
    connectionPath: join(directories.balanceframeConfigDirectory, 'config.json'),
    bootstrapSecret: makeSecret(),
    internalSecret: makeSecret(),
    manifestPath: join(root, 'manifest.json'),
    publicOrigin,
  });
  const stateWithoutWeb = {
    publicHandle,
    ownership,
    directories,
    actualPort,
    webPort,
  };
  const web = spawnChild(
    'web',
    process.execPath,
    [webEntry],
    root,
    createWebEnvironment(stateWithoutWeb),
  );
  const state: InternalScenarioProcesses = {
    ...stateWithoutWeb,
    web,
    actual: undefined,
    stopPromise: undefined,
  };
  internalProcesses.set(publicHandle, state);
  activeRoots.set(root, publicHandle);
  try {
    await waitForHttp(web.process, publicHandle.webUrl, 'Nuxt shell');
  } catch (error) {
    await stopChild(web.process);
    activeRoots.delete(root);
    internalProcesses.delete(publicHandle);
    throw error;
  }
  return publicHandle;
}

export async function startScenarioActual(handle: ScenarioProcesses): Promise<void> {
  const state = internalProcesses.get(handle);
  if (!state || stoppedHandles.has(handle)) throw new Error('Scenario process handle is not owned');
  validateOwnedRoot(handle.root);
  if (state.actual && state.actual.process.exitCode === null && state.actual.process.signalCode === null) {
    return;
  }

  const actualEnvironment = createActualEnvironment(state);
  const first = spawnChild('actual', 'actual-server', [], handle.root, actualEnvironment);
  state.actual = first;
  try {
    await waitForHttp(first.process, `${handle.actualUrl}/health`, 'Actual server');
    await stopChild(first.process);
    state.actual = undefined;
    await resetActualPassword(state);
    const final = spawnChild('actual', 'actual-server', [], handle.root, actualEnvironment);
    state.actual = final;
    await waitForHttp(final.process, `${handle.actualUrl}/health`, 'Actual server');
  } catch (error) {
    if (state.actual) await stopChild(state.actual.process);
    state.actual = undefined;
    throw new Error(`Actual server startup failed: ${errorMessage(error)}`);
  }
}

export async function stopScenarioProcesses(handle: ScenarioProcesses): Promise<void> {
  if (stoppedHandles.has(handle)) return;
  const state = internalProcesses.get(handle);
  if (!state) throw new Error('Scenario process handle is not owned');
  if (state.stopPromise) return await state.stopPromise;
  state.stopPromise = (async () => {
    if (state.actual) await stopChild(state.actual.process);
    await stopChild(state.web.process);
    safeCleanup(state.ownership);
    activeRoots.delete(handle.root);
    internalProcesses.delete(handle);
    stoppedHandles.add(handle);
  })();
  return await state.stopPromise;
}
