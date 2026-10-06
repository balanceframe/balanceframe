import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { seedActualBudget, type SeededActualBudget } from './actual-seed.js';
import { materializeScenario, type MaterializedScenario } from './catalog.js';
import {
  assertScenarioProcessesActive,
  discardOwnedScenarioRoot,
  startScenarioActual,
  startScenarioShell,
  stopScenarioProcesses,
  updateScenarioPersonas,
  type ScenarioProcesses,
} from './process-runtime.js';
import { initializeScenarioWorkflow, type ScenarioInitialized } from './workflow-setup.js';
import { initializeScenarioResearch, readScenarioManifest, writeScenarioManifest } from './scenario-manifest.js';

export interface LoadScenarioOptions {
  readonly scenarioId: string;
  readonly root: string;
  readonly anchor: Date;
  readonly publicOrigin: string;
}

export interface LoadedScenario {
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
  readonly processes: ScenarioProcesses;
  readonly initialized: ScenarioInitialized;
}

export function builtWebEntry(): string {
  const candidates = [
    new URL('../../../apps/web/.output/server/index.mjs', import.meta.url),
    new URL('../../../../../apps/web/.output/server/index.mjs', import.meta.url),
    new URL('../../../../../web-output/server/index.mjs', import.meta.url),
  ];
  const built = candidates.find((candidate) => existsSync(candidate));
  if (!built) throw new Error('The normal production Nuxt bundle must be built before loading a scenario');
  return fileURLToPath(built);
}

/** Initializes an unpublished owned shell through the same Actual and authenticated HTTP path as local loading. */
export async function initializeScenarioShell(
  processes: ScenarioProcesses,
  scenario: MaterializedScenario,
): Promise<LoadedScenario> {
  assertScenarioProcessesActive(processes);
  const manifest = readScenarioManifest(processes);
  if (manifest.phase !== 'setup' || (manifest.scenarioId !== null && manifest.scenarioId !== scenario.id))
    throw new Error('Scenario shell selection is unavailable');
  writeScenarioManifest(processes, { ...manifest, scenarioId: scenario.id });
  await startScenarioActual(processes);
  const seeded = await seedActualBudget({
    serverUrl: processes.actualUrl,
    secretKey: processes.actualSecretKey,
    clientDir: processes.seedClientDir,
    budgetName: `BalanceFrame ${scenario.id} ${scenario.anchor}`,
    ledger: scenario.ledger,
  });
  const initialized = await initializeScenarioWorkflow({
    scenario,
    seeded,
    processes,
  });
  await updateScenarioPersonas(processes, initialized);
  if (scenario.research) {
    assertScenarioProcessesActive(processes);
    const ready = initializeScenarioResearch(processes, readScenarioManifest(processes), scenario.research.mode);
    writeScenarioManifest(processes, ready);
  }
  return { scenario, seeded, processes, initialized };
}
/** Loads one checked fictional scenario into its owned Actual and authenticated web workspace. */
export async function loadScenario(options: LoadScenarioOptions): Promise<LoadedScenario> {
  let scenario: MaterializedScenario;
  let webEntry: string;
  try {
    scenario = materializeScenario(options.scenarioId, options.anchor);
    webEntry = builtWebEntry();
  } catch (error) {
    await discardOwnedScenarioRoot(options.root);
    throw error;
  }

  let processes: ScenarioProcesses;
  try {
    processes = await startScenarioShell({
      root: options.root,
      publicOrigin: options.publicOrigin,
      webEntry,
    });
  } catch (error) {
    await discardOwnedScenarioRoot(options.root);
    throw error;
  }
  try {
    return await initializeScenarioShell(processes, scenario);
  } catch (error) {
    await stopScenarioProcesses(processes);
    throw error;
  }
}

/** Stops both owned child processes and deletes only this loader's registered workspace. */
export async function stopScenario(handle: LoadedScenario): Promise<void> {
  await stopScenarioProcesses(handle.processes);
}
