import { spawn } from 'node:child_process';

import { listScenarios } from './catalog.js';
import { startDemoServer, stopDemoServer } from './demo-server.js';

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

async function runVitest(path: string, selector?: string): Promise<number> {
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
    '--minWorkers',
    '1',
  ];
  if (selector) args.push('--testNamePattern', selector);
  const child = spawn('pnpm', args, { stdio: 'inherit' });
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function verify(selector: string): Promise<void> {
  const selected =
    selector === '--all' || selector === '--faults' ? null : requireScenario(selector);
  if (selector !== '--faults') {
    console.log(`Live Actual scenarios: ${selected ?? 'all 29'}`);
    const status = await runVitest('test/acceptance', selected ?? undefined);
    if (status !== 0) process.exitCode = status;
  }
  if (selector === '--all' || selector === '--faults') {
    console.log('Native/service fault contracts: four named cases (five tested variants)');
    const status = await runVitest('test/fault/fault-contract.test.ts');
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
