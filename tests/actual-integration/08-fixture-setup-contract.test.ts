import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseEnv } from 'dotenv';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { buildClientConfig } from './helpers';

const integrationDir = dirname(fileURLToPath(import.meta.url));
const setupScript = join(integrationDir, 'setup-fixture-server.sh');
const seedScript = join(integrationDir, 'seed-budget.mjs');
const canonicalFixturePath = join(integrationDir, '../../protocol/fixtures/representative.json');

function canonicalFixture(): ProtocolSnapshot {
  const source = canonicalProtocolSnapshotSchema.parse(
    JSON.parse(readFileSync(canonicalFixturePath, 'utf8')),
  );
  return canonicalProtocolSnapshotSchema.parse({
    ...source,
    accounts: source.accounts.filter((account) => ['a_1', 'a_4'].includes(account.id)),
    transactions: source.transactions.filter((transaction) =>
      ['tx_000', 'tx_084'].includes(transaction.id),
    ),
    categories: source.categories.filter((category) => ['cat_1', 'cat_2'].includes(category.id)),
    payees: source.payees.filter((payee) => payee.id === 'pay_1'),
    rules: [],
    schedules: [],
    budgets: [],
    tags: [],
  });
}

interface SpawnResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
  timeoutMs = 10_000,
): Promise<SpawnResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  // A stuck external process emits no completion signal, so a wall-clock
  // watchdog is the only way for this integration contract to fail finitely.
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, stdout, stderr, timedOut });
  });
  return promise;
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function unusedLocalPort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a local port');
  }
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
  return address.port;
}

interface SetupSandbox {
  readonly scriptPath: string;
  readonly cwd: string;
  readonly binDir: string;
  readonly dataDir: string;
  readonly envPath: string;
  readonly fixturePath: string;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createLiveSetupSandbox(): SetupSandbox {
  const root = join(tempRoot, `live-${randomUUID()}`);
  const cwd = join(root, 'tests', 'actual-integration');
  const fixtureDir = join(root, 'protocol', 'fixtures');
  const binDir = join(root, 'bin');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(binDir);

  const scriptPath = join(cwd, 'setup-fixture-server.sh');
  const fixturePath = join(fixtureDir, 'representative.json');
  copyFileSync(setupScript, scriptPath);
  writeFileSync(
    join(cwd, 'seed-budget.mjs'),
    `process.stdout.write('{"status":"seeded","budgetId":"fixture-budget-id","groupId":"fixture-group-id"}\\n');\n`,
  );
  copyFileSync(canonicalFixturePath, fixturePath);

  writeExecutable(
    join(binDir, 'actual-server'),
    '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then printf "%s\\n" "test-actual"; exit 0; fi\n(sleep 3; kill "$$" 2>/dev/null) &\nwhile :; do sleep 1; done\n',
  );
  writeExecutable(join(binDir, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "test-pnpm"\n');
  writeExecutable(join(binDir, 'curl'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(binDir, 'expect'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');

  return {
    scriptPath,
    cwd,
    binDir,
    dataDir: join(root, 'actual-data'),
    envPath: join(cwd, '.env.test'),
    fixturePath,
  };
}

async function runLiveSetup(
  secretKey?: string,
  budgetName = `Fixture-${randomUUID()}`,
): Promise<{
  readonly result: SpawnResult;
  readonly sandbox: SetupSandbox;
  readonly serverUrl: string;
  readonly budgetName: string;
}> {
  const sandbox = createLiveSetupSandbox();
  const port = await unusedLocalPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const result = await run('bash', [sandbox.scriptPath], {
    cwd: sandbox.cwd,
    env: {
      ...process.env,
      DRY_RUN: '0',
      BALANCEFRAME_ACTUAL_FIXTURE: undefined,
      PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}`,
      ACTUAL_SERVER_PORT: String(port),
      ACTUAL_SERVER_URL: serverUrl,
      ACTUAL_SERVER_DATA_DIR: sandbox.dataDir,
      ACTUAL_BUDGET_NAME: budgetName,
      ACTUAL_SECRET_KEY: secretKey,
    },
  });
  return { result, sandbox, serverUrl, budgetName };
}

function readEnvValue(path: string, key: string): string {
  const value = parseEnv(readFileSync(path))[key];
  if (value === undefined) throw new Error(`Missing ${key} in ${path}`);
  return value;
}

async function readSourcedEnvValue(path: string, key: string): Promise<string> {
  const result = await run(
    'bash',
    ['-c', 'source "$1"; printf "%s" "${!2}"', 'read-fixture-env', path, key],
    { cwd: dirname(path), env: { ...process.env } },
  );
  if (result.code !== 0) {
    throw new Error(`Could not read ${key} from ${path}: ${result.stderr}`);
  }
  return result.stdout;
}

function withFixtureEnvironment<T>(
  values: Readonly<Record<string, string | undefined>>,
  callback: () => T,
): T {
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]] as const));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fixtureEnvironment(seedDataDir: string): Record<string, string> {
  return {
    BALANCEFRAME_ACTUAL_FIXTURE: '1',
    ACTUAL_SERVER_URL: 'http://127.0.0.1:5006',
    ACTUAL_SECRET_KEY: 'test-only-secret',
    ACTUAL_BUDGET_ID: 'fixture-budget-id',
    ACTUAL_GROUP_ID: 'fixture-group-id',
    ACTUAL_BUDGET_NAME: 'Fixture-Budget',
    ACTUAL_SEED_DATA_DIR: seedDataDir,
  };
}

let tempRoot: string;
let shimBin: string;

interface PreWriteValidationRun {
  result: SpawnResult;
  initPath: string;
}

async function runPreWriteValidationFixture(
  label: string,
  fixture: unknown,
): Promise<PreWriteValidationRun> {
  const caseDir = join(tempRoot, `${label.replace(/[^a-zA-Z0-9_-]/g, '-')}-${randomUUID()}`);
  const fixturePath = join(caseDir, 'fixture.json');
  const initPath = join(caseDir, 'actual-init');
  const stubPath = join(caseDir, 'actual-api-stub.mjs');
  const loaderPath = join(caseDir, 'actual-api-loader.mjs');
  mkdirSync(caseDir);
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(
    stubPath,
    `
import { writeFileSync } from 'node:fs';
export async function init() {
  writeFileSync(process.env.STUB_INIT_PATH, 'initialized');
  return { send: async () => {} };
}
export async function shutdown() {}
`,
  );
  writeFileSync(
    loaderPath,
    `
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@actual-app/api') {
    return { url: pathToFileURL(process.env.ACTUAL_API_STUB_PATH).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`,
  );

  const result = await run(process.execPath, [seedScript], {
    cwd: integrationDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      ACTUAL_API_STUB_PATH: stubPath,
      STUB_INIT_PATH: initPath,
      ACTUAL_SERVER_URL: 'http://127.0.0.1:1',
      ACTUAL_SECRET_KEY: 'unused-stub-secret',
      ACTUAL_BUDGET_NAME: `Pre-write validation ${randomUUID()}`,
      FIXTURE_DATA_PATH: fixturePath,
      SEED_DATA_DIR: join(caseDir, 'seed-data'),
    },
  });

  return { result, initPath };
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'balanceframe-fixture-contract-'));
  shimBin = join(tempRoot, 'bin');
  mkdirSync(shimBin);
  // DRY_RUN still checks these tools. Shims keep this contract test independent
  // of a locally installed Actual server while ensuring no server can be started.
  for (const name of ['actual-server', 'pnpm', 'curl']) {
    const path = join(shimBin, name);
    writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "test shim"\n');
    chmodSync(path, 0o755);
  }
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('fixture client safety guard', () => {
  it.each([
    { label: 'missing', marker: undefined },
    { label: 'set to a non-opt-in value', marker: '0' },
  ])('rejects use when the dedicated-fixture marker is $label', ({ marker }) => {
    const seedDataDir = join(tempRoot, `guard-seed-${randomUUID()}`);
    mkdirSync(seedDataDir);
    const environment: Record<string, string | undefined> = {
      ...fixtureEnvironment(seedDataDir),
      BALANCEFRAME_ACTUAL_FIXTURE: marker,
    };

    withFixtureEnvironment(environment, () => {
      expect(() => buildClientConfig(join(tempRoot, `guard-data-${randomUUID()}`))).toThrow(
        /fixture|marker|BALANCEFRAME_ACTUAL_FIXTURE/i,
      );
    });
  });

  it('rejects a non-loopback Actual server before initializing a client', () => {
    const seedDataDir = join(tempRoot, `remote-seed-${randomUUID()}`);
    mkdirSync(seedDataDir);
    const environment = {
      ...fixtureEnvironment(seedDataDir),
      ACTUAL_SERVER_URL: 'https://actual.example.test',
    };

    withFixtureEnvironment(environment, () => {
      expect(() => buildClientConfig(join(tempRoot, `remote-data-${randomUUID()}`))).toThrow(
        /loopback|localhost|127\.0\.0\.1|server URL/i,
      );
    });
  });

  it.each([
    'ACTUAL_BUDGET_ID',
    'ACTUAL_GROUP_ID',
    'ACTUAL_BUDGET_NAME',
    'ACTUAL_SEED_DATA_DIR',
  ] as const)('rejects missing fixture provenance %s', (missingKey) => {
    const seedDataDir = join(tempRoot, `provenance-seed-${randomUUID()}`);
    mkdirSync(seedDataDir);
    const environment: Record<string, string | undefined> = {
      ...fixtureEnvironment(seedDataDir),
      [missingKey]: undefined,
    };

    withFixtureEnvironment(environment, () => {
      expect(() => buildClientConfig(join(tempRoot, `provenance-data-${randomUUID()}`))).toThrow(
        new RegExp(`${missingKey}|fixture provenance`, 'i'),
      );
    });
  });
});

describe('fixture setup contract', () => {
  it('uses caller-owned server paths without rewriting the checked-in seed module', async () => {
    const dataRoot = join(tempRoot, `actual-data-${randomUUID()}`);
    const port = await unusedLocalPort();
    const budgetName = `Fixture Contract ${randomUUID()}`;
    const seedBefore = readFileSync(seedScript);
    const seedStatBefore = statSync(seedScript, { bigint: true });

    const result = await run('bash', [setupScript], {
      cwd: integrationDir,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        DRY_RUN: '1',
        ACTUAL_SERVER_URL: `http://localhost:${port}`,
        ACTUAL_SERVER_DATA_DIR: dataRoot,
        ACTUAL_SERVER_PORT: String(port),
        ACTUAL_BUDGET_NAME: budgetName,
      },
    });

    const seedAfter = readFileSync(seedScript);
    const seedStatAfter = statSync(seedScript, { bigint: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain(dataRoot);
    expect(result.stdout).toContain(`http://localhost:${port}`);
    expect(result.stdout).toContain(budgetName);
    expect(result.stdout).not.toContain(join(integrationDir, '.actual-server-data'));
    expect(seedAfter.equals(seedBefore)).toBe(true);
    expect(sha256(seedAfter)).toBe(sha256(seedBefore));
    expect(seedStatAfter.mtimeNs).toBe(seedStatBefore.mtimeNs);
  });
  it('never prints a caller-supplied secret, including in DRY_RUN output', async () => {
    const suppliedSecret = `supplied-secret-${randomUUID()}`;
    const port = await unusedLocalPort();
    const dryResult = await run('bash', [setupScript], {
      cwd: integrationDir,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        DRY_RUN: '1',
        ACTUAL_SERVER_URL: `http://127.0.0.1:${port}`,
        ACTUAL_SERVER_DATA_DIR: join(tempRoot, `dry-secret-${randomUUID()}`),
        ACTUAL_SERVER_PORT: String(port),
        ACTUAL_SECRET_KEY: suppliedSecret,
      },
    });
    const live = await runLiveSetup(suppliedSecret);

    expect(dryResult.code, dryResult.stderr).toBe(0);
    expect(live.result.code, live.result.stderr).toBe(0);
    expect(`${dryResult.stdout}\n${dryResult.stderr}`).not.toContain(suppliedSecret);
    expect(`${live.result.stdout}\n${live.result.stderr}`).not.toContain(suppliedSecret);
  });

  it('generates a fresh secret for every setup run when none is supplied', async () => {
    const first = await runLiveSetup();
    const second = await runLiveSetup();

    expect(first.result.code, first.result.stderr).toBe(0);
    expect(second.result.code, second.result.stderr).toBe(0);
    const firstSecret = await readSourcedEnvValue(first.sandbox.envPath, 'ACTUAL_SECRET_KEY');
    const secondSecret = await readSourcedEnvValue(second.sandbox.envPath, 'ACTUAL_SECRET_KEY');
    expect(firstSecret).toBeTruthy();
    expect(secondSecret).toBeTruthy();
    expect(firstSecret).not.toBe(secondSecret);
  });

  it('does not print its generated secret', async () => {
    const { result, sandbox } = await runLiveSetup();

    expect(result.code, result.stderr).toBe(0);
    const generatedSecret = await readSourcedEnvValue(sandbox.envPath, 'ACTUAL_SECRET_KEY');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(generatedSecret);
  });

  it('writes the dedicated marker and exact fixture provenance', async () => {
    const { result, sandbox, serverUrl, budgetName } = await runLiveSetup();

    expect(result.code, result.stderr).toBe(0);
    expect(readEnvValue(sandbox.envPath, 'BALANCEFRAME_ACTUAL_FIXTURE')).toBe('1');
    expect(readEnvValue(sandbox.envPath, 'ACTUAL_SERVER_URL')).toBe(serverUrl);
    expect(readEnvValue(sandbox.envPath, 'ACTUAL_BUDGET_ID')).toBe('fixture-budget-id');
    expect(readEnvValue(sandbox.envPath, 'ACTUAL_GROUP_ID')).toBe('fixture-group-id');
    expect(readEnvValue(sandbox.envPath, 'ACTUAL_BUDGET_NAME')).toBe(budgetName);
    expect(readEnvValue(sandbox.envPath, 'ACTUAL_SEED_DATA_DIR')).toBe(
      join(sandbox.dataDir, 'seed-data'),
    );
  });

  it('writes values that dotenv and shell sourcing decode identically', async () => {
    const budgetName = 'Fixture Budget With Spaces';
    const { result, sandbox } = await runLiveSetup(undefined, budgetName);

    expect(result.code, result.stderr).toBe(0);
    expect(parseEnv(readFileSync(sandbox.envPath)).ACTUAL_BUDGET_NAME).toBe(budgetName);
    expect(await readSourcedEnvValue(sandbox.envPath, 'ACTUAL_BUDGET_NAME')).toBe(budgetName);
  });

  it('writes the generated environment with owner-only permissions', async () => {
    const { result, sandbox } = await runLiveSetup(`mode-secret-${randomUUID()}`);

    expect(result.code, result.stderr).toBe(0);
    expect(statSync(sandbox.envPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    {
      label: 'missing',
      fixtureContents: undefined,
      diagnostic: /ENOENT|not found|missing|unable to read/i,
    },
    {
      label: 'malformed JSON',
      fixtureContents: '{ this is not valid JSON',
      diagnostic: /JSON|parse|syntax|malformed|unexpected token/i,
    },
    {
      label: 'non-canonical',
      fixtureContents: '{}',
      diagnostic: /canonical ProtocolSnapshot|schema|schemaVersion|accounts/i,
    },
  ])(
    'rejects a $label fixture before connecting to Actual',
    async ({ label, fixtureContents, diagnostic }) => {
      const caseDir = join(tempRoot, `${label}-${randomUUID()}`);
      const fixturePath = join(caseDir, 'fixture.json');
      const dataDir = join(caseDir, 'seed-data');
      mkdirSync(caseDir);
      if (fixtureContents !== undefined) writeFileSync(fixturePath, fixtureContents);
      const port = await unusedLocalPort();

      const result = await run(process.execPath, [seedScript], {
        cwd: integrationDir,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ACTUAL_SERVER_URL: `http://127.0.0.1:${port}`,
          ACTUAL_SECRET_KEY: `fixture-secret-${randomUUID()}`,
          ACTUAL_BUDGET_NAME: `Must Not Be Created ${randomUUID()}`,
          FIXTURE_DATA_PATH: fixturePath,
          SEED_DATA_DIR: dataDir,
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.timedOut, output).toBe(false);
      expect(result.code, output).not.toBe(0);
      expect(output).toContain(fixturePath);
      expect(output).toMatch(/fixture/i);
      expect(output).toMatch(diagnostic);
      expect(output).not.toMatch(/ECONNREFUSED|fetch failed|budget_created|create-budget/i);
      expect(existsSync(dataDir)).toBe(false);
    },
  );

  it('rejects a missing checked-in fixture before starting Actual', async () => {
    const sandbox = createLiveSetupSandbox();
    rmSync(sandbox.fixturePath);
    const port = await unusedLocalPort();
    const result = await run('bash', [sandbox.scriptPath], {
      cwd: sandbox.cwd,
      env: {
        ...process.env,
        PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}`,
        DRY_RUN: '0',
        ACTUAL_SERVER_URL: `http://127.0.0.1:${port}`,
        ACTUAL_SERVER_DATA_DIR: sandbox.dataDir,
        ACTUAL_SERVER_PORT: String(port),
        ACTUAL_BUDGET_NAME: `Missing Fixture ${randomUUID()}`,
        ACTUAL_SECRET_KEY: `fixture-secret-${randomUUID()}`,
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code, output).not.toBe(0);
    expect(result.timedOut, output).toBe(false);
    expect(output).toMatch(/canonical fixture data file is required|refusing to generate/i);
    expect(existsSync(sandbox.dataDir)).toBe(false);
  });

  it.each([
    {
      label: 'checked signed 64-bit overflow',
      diagnostic: /overflow|signed 64-bit|safe integer|out of range/i,
      mutate: (draft: ProtocolSnapshot) => {
        draft.accounts[0]!.clearedBalance.minorUnits = '9223372036854775807';
      },
    },
    {
      label: 'malformed money',
      diagnostic: /malformed|minorUnits|integer|invalid/i,
      mutate: (draft: ProtocolSnapshot) => {
        draft.accounts[0]!.clearedBalance.minorUnits = '1.5';
      },
    },
    {
      label: 'currency mismatch',
      diagnostic: /currency|USD|EUR/i,
      mutate: (draft: ProtocolSnapshot) => {
        draft.accounts[0]!.importedBalance.currency = 'EUR';
      },
    },
  ])(
    'rejects $label before any Actual entity is written',
    async ({
      label,
      diagnostic,
      mutate,
    }: {
      label: string;
      diagnostic: RegExp;
      mutate: (draft: ProtocolSnapshot) => void;
    }) => {
      const fixture = structuredClone(canonicalFixture());
      mutate(fixture);
      const { result, initPath } = await runPreWriteValidationFixture(
        `invalid-canonical-${label}`,
        fixture,
      );
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.timedOut, output).toBe(false);
      expect(result.code, output).not.toBe(0);
      expect(output).toMatch(diagnostic);
      expect(existsSync(initPath)).toBe(false);
    },
  );
});
