import { spawnSync, type SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

const output = vi.hoisted(() => ({
  stdout: '',
  stderr: '',
  children: [] as Promise<void>[],
  childStatuses: [] as (number | null)[],
  omittedRecords: [] as string[],
  acceptanceSelector: undefined as string | undefined,
  omitScenarioRecords: false,
}));

// Keep real children and statuses; selected coverage tests narrow actual work or omit its records.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const capture = options.stdio === 'inherit';
      const acceptance = args.some((arg) => arg === 'test/acceptance' || arg === 'test/acceptance/');
      const childArgs = acceptance
        ? [...args, '--exclude', 'test/acceptance-contract.test.ts',
          ...(output.acceptanceSelector ? ['--testNamePattern', output.acceptanceSelector] : [])]
        : args;
      const child = actual.spawn(command, childArgs, capture ? { ...options, stdio: 'pipe' } : options);
      const rawStdout = child.stdout;
      if (acceptance && output.omitScenarioRecords && rawStdout) {
        const filtered = new PassThrough();
        let pending = '';
        const forward = (line: string) => {
          if (line.startsWith('{"type":"scenario-verification",')) output.omittedRecords.push(line.trimEnd());
          else filtered.write(line);
        };
        rawStdout.setEncoding('utf8').on('data', (text: string) => {
          pending += text;
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            forward(pending.slice(0, newline + 1));
            pending = pending.slice(newline + 1);
          }
        });
        rawStdout.once('end', () => {
          if (pending) forward(pending);
          filtered.end();
        });
        child.stdout = filtered;
      }
      child.stdout?.setEncoding('utf8').on('data', (text: string) => { output.stdout += text; });
      child.stderr?.setEncoding('utf8').on('data', (text: string) => { output.stderr += text; });
      child.once('exit', (code) => { output.childStatuses.push(code); });
      output.children.push(new Promise<void>((resolve) => { child.once('close', () => resolve()); }));
      return child;
    },
  };
});

async function runSourceCli(
  args: string[],
  coverage: { acceptanceSelector?: string; omitScenarioRecords?: boolean } = {},
) {
  const argv = process.argv;
  const exitCode = process.exitCode;
  output.stdout = '';
  output.stderr = '';
  output.children = [];
  output.childStatuses = [];
  output.omittedRecords = [];
  output.acceptanceSelector = coverage.acceptanceSelector;
  output.omitScenarioRecords = coverage.omitScenarioRecords ?? false;
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    output.stdout += `${format(...values)}\n`;
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    output.stderr += `${format(...values)}\n`;
  });
  process.argv = [process.execPath, 'scenario-cli', ...args];
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import('../src/cli.js');
    const finished = Promise.all(output.children);
    if (args[0] !== 'run') await finished;
    return {
      status: process.exitCode ?? 0,
      stdout: output.stdout,
      stderr: output.stderr,
      childStatuses: output.childStatuses,
      omittedRecords: output.omittedRecords,
      finished,
    };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    log.mockRestore();
    error.mockRestore();
    output.acceptanceSelector = undefined;
    output.omitScenarioRecords = false;
  }
}

describe('root scenario commands', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('lists every checked feature without launching a workspace', () => {
    const result = spawnSync('pnpm', ['scenarios', 'list'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('funded-purchase');
    expect(result.stdout).toContain('coapproval-completion');
    expect(result.stdout).toContain('ambiguous-completion');
    expect(result.stdout).not.toContain('secret');
  }, 65_000);

  it('rejects unlisted scenario IDs before opening the demo listener', () => {
    const result = spawnSync('pnpm', ['scenarios', 'run', '../../unexpected'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('/demo');
    expect(result.stderr).toContain('Unknown scenario ID');
  }, 65_000);

  it('executes the selected live scenario instead of reporting a skipped suite as success', async () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const result = await runSourceCli(['verify', 'funded-purchase']);
    expect(result.status).toBe(0);
    const reportLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('{"type":"scenario-verification",'));
    expect(reportLine).toBeDefined();
    const report = JSON.parse(reportLine!) as Record<string, unknown>;
    expect(report).toMatchObject({
      type: 'scenario-verification',
      catalogVersion: '1',
      scenarioId: 'funded-purchase',
      status: 'passed',
      evidence: { backend: 'disposable-actual', auth: 'better-auth' },
    });
    expect(report.anchor).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(report.assertions).toEqual(
      expect.objectContaining({
        name: expect.stringContaining('funded-purchase'),
        count: expect.any(Number),
      }),
    );
    expect((report.assertions as { count: number }).count).toBeGreaterThan(0);
  }, 185_000);

  it('rejects selected verification when its real successful child does not deliver the named assertion record', async () => {
    const result = await runSourceCli(['verify', 'funded-purchase'], { omitScenarioRecords: true });
    expect(result.childStatuses).toEqual([0]);
    expect(result.omittedRecords.length).toBeGreaterThan(0);
    expect(JSON.parse(result.omittedRecords[0]!) as unknown).toMatchObject({
      scenarioId: 'funded-purchase',
      status: 'passed',
      evidence: { backend: 'disposable-actual', auth: 'better-auth' },
      assertions: { count: expect.any(Number), name: expect.stringContaining('funded-purchase') },
    });
    expect(result.stdout).not.toContain('{"type":"scenario-verification",');
    expect(result.status).not.toBe(0);
  }, 185_000);

  it('rejects verify --all when real Vitest exits zero but only one approved scenario actually ran', async () => {
    const result = await runSourceCli(['verify', '--all'], { acceptanceSelector: 'funded-purchase' });
    expect(result.childStatuses.length).toBeGreaterThan(0);
    expect(result.childStatuses.every((status) => status === 0)).toBe(true);
    const records = result.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith('{"type":"scenario-verification",'))
      .map((line) => JSON.parse(line) as { scenarioId: string; assertions: { count: number } });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.scenarioId === 'funded-purchase' && record.assertions.count > 0)).toBe(true);
    expect(result.status).not.toBe(0);
  }, 185_000);
  it('reports all named native/service fault variants without launching Actual', async () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const result = await runSourceCli(['verify', '--faults']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('[Breadcrumb] Loading budget');
    const reports = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"type":"fault-verification",'))
      .map(
        (line) =>
          JSON.parse(line) as {
            faultId: string;
            status: string;
            catalogVersion: string;
            anchor: string;
            assertions: { count: number };
            evidence: { backend: string };
          },
      );
    expect(reports.map((report) => report.faultId).sort()).toEqual([
      'ambiguous-transfer',
      'authoritative-schedule-claim-overlap',
      'completion-crash-retry',
      'source-coverage-receipt-integrity:duplicate',
      'source-coverage-receipt-integrity:missing',
    ]);
    for (const report of reports) {
      expect(report).toMatchObject({
        status: 'passed',
        catalogVersion: '1',
        anchor: '2026-09-06T12:00:00.000Z',
        evidence: { backend: 'native-service-fault' },
      });
      expect(report.assertions.count).toBeGreaterThan(0);
    }
  }, 65_000);

  it.each([
    [],
    ['unknown-command'],
    ['run', '--port'],
    ['run', '--host', '--origin'],
    ['run', 'funded-purchase', 'unexpected'],
    ['verify', '../../unexpected'],
  ].map((args) => ({ args })))('rejects invalid arguments $args before launching a workspace', async ({ args }) => {
    const result = await runSourceCli(args);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('/demo');
    expect(result.stderr).toMatch(/Usage:|Missing value|Unexpected demo arguments|Unknown scenario/);
  });

  it('runs the selected disposable demo and closes its listener on shutdown', async () => {
    const previous = process.listeners('SIGTERM');
    let shutdown: (() => void) | undefined;
    let finished: Promise<unknown> | undefined;
    try {
      const result = await runSourceCli([
        'run', '--scenario', 'funded-purchase', '--port', '0', '--host', '127.0.0.1',
      ]);
      finished = result.finished;
      shutdown = process.listeners('SIGTERM').find((listener) => !previous.includes(listener));
      expect(result.status).toBe(0);
      const address = result.stdout.match(/^(http:\/\/127\.0\.0\.1:\d+)\/demo\tfunded-purchase$/m)?.[1];
      expect(address).toBeDefined();
      const response = await fetch(`${address}/__demo/state`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ready', scenarioId: 'funded-purchase' });
      if (!shutdown) throw new Error('CLI did not install its shutdown handler');
      shutdown();
      shutdown();
      await vi.waitFor(async () => {
        await expect(fetch(`${address}/__demo/state`)).rejects.toThrow();
      }, { timeout: 10_000 });
    } finally {
      if (shutdown) {
        shutdown();
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
      }
      await finished;
    }
  }, 180_000);
});
