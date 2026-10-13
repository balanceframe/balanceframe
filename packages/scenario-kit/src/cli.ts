/// <reference lib="es2024.promise" />

import { spawn } from 'node:child_process';

import { listScenarios } from './catalog.js';
import { startDemoServer, stopDemoServer } from './demo-server.js';
import {
  SCENARIO_ACCEPTANCE_CONTRACT,
  createScenarioRecordCollector,
  verifyScenarioCoverage,
} from './acceptance-contract.js';

function validScenario(id: string): boolean {
  return listScenarios().some((scenario) => scenario.id === id);
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  args.splice(index, 2);
  return value;
}

function requireScenario(id: string): string {
  if (!validScenario(id)) throw new Error(`Unknown scenario ID: ${id}`);
  return id;
}

async function runVitest(path: string, selector?: string): Promise<{ status: number; records: readonly unknown[] }> {
  const args = [
    '--filter',
    '@balanceframe/scenario-kit',
    'exec',
    'vitest',
    'run',
    path,
    '--pool',
    'forks',
    '--maxWorkers',
    '1',
    // Keep verification JSON visible and undecorated, including with FORCE_COLOR.
    '--disableConsoleIntercept',
  ];
  if (selector) args.push('--testNamePattern', selector);
  const collector = createScenarioRecordCollector();
  let collectionFailure: unknown;
  const child = spawn('pnpm', args, { stdio: ['inherit', 'pipe', 'inherit'] });
  child.stdout?.setEncoding('utf8');
  child.stdout?.pipe(process.stdout, { end: false });
  child.stdout?.on('data', (chunk: string) => {
    if (collectionFailure !== undefined) return;
    try {
      collector.write(chunk);
    } catch (failure) {
      collectionFailure = failure;
    }
  });
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; records: readonly unknown[] }>();
  child.once('error', reject);
  child.stdout?.once('error', reject);
  // close follows stdout exhaustion; exit alone can precede the final verification record.
  child.once('close', (code) => {
    const status = code ?? 1;
    if (status !== 0) {
      resolve({ status, records: [] });
      return;
    }
    if (collectionFailure !== undefined) {
      reject(collectionFailure);
      return;
    }
    try {
      resolve({ status, records: collector.finish() });
    } catch (failure) {
      reject(failure);
    }
  });
  return promise;
}

async function verify(selector: string): Promise<void> {
  const selected =
    selector === '--all' || selector === '--faults' ? null : requireScenario(selector);
  if (selector !== '--faults') {
    const scenarios = listScenarios();
    const requiredIds = Object.keys(SCENARIO_ACCEPTANCE_CONTRACT);
    if (scenarios.length !== requiredIds.length
      || scenarios.some(({ id }) => !Object.hasOwn(SCENARIO_ACCEPTANCE_CONTRACT, id))
      || requiredIds.some((id) => !scenarios.some((scenario) => scenario.id === id))) {
      throw new Error('Scenario catalog and approved acceptance contract do not match');
    }
    console.log(`Live Actual scenarios: ${selected ?? `all ${scenarios.length}`}`);
    const testName = selected ? `(?:^|\\s)${selected}(?:\\s|$)` : undefined;
    const { status, records } = await runVitest('test/acceptance/', testName);
    if (status !== 0) {
      process.exitCode = status;
      return;
    }
    const expected = selected
      ? { [selected]: SCENARIO_ACCEPTANCE_CONTRACT[selected]! }
      : SCENARIO_ACCEPTANCE_CONTRACT;
    verifyScenarioCoverage(records, expected);
  }
  if (selector === '--all' || selector === '--faults') {
    console.log('Native/service fault contracts: four named cases (five tested variants)');
    const { status } = await runVitest('test/fault/fault-contract.test.ts');
    if (status !== 0) process.exitCode = status;
  }
}

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'list' && args.length === 0) {
    for (const { id, featureGroup, title } of listScenarios())
      console.log(`${id}\t${featureGroup}\t${title}`);
    return;
  }
  if (command === 'verify' && args.length <= 1) {
    await verify(args[0] ?? '--all');
    return;
  }
  if (command === 'run') {
    const requested = option(args, '--scenario');
    const rawPort = option(args, '--port');
    const host = option(args, '--host');
    const origin = option(args, '--origin');
    const id = requireScenario(requested ?? args.shift() ?? 'funded-purchase');
    if (args.length !== 0) throw new Error('Unexpected demo arguments');
    const port = rawPort === undefined ? undefined : Number(rawPort);
    const handle = await startDemoServer({
      scenarioId: id,
      ...(port === undefined ? {} : { port }),
      ...(host ? { host } : {}),
      ...(origin ? { origin } : {}),
    });
    console.log(`${handle.url}/demo\t${id}`);
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void stopDemoServer(handle).catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  throw new Error(
    'Usage: pnpm scenarios list | verify [<id>|--all|--faults] | run [<id>|--scenario <id>] [--host <host>] [--port <port>] [--origin <https-origin>]',
  );
}

try {
  await run();
} catch (failure) {
  console.error(failure instanceof Error ? failure.message : 'Scenario command failed');
  process.exitCode = 1;
}
