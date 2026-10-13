import { constants, closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { ScenarioProcesses } from './process-runtime.js';

const activeHandles = new WeakMap<ScenarioProcesses, () => void>();
/** Runtime-owned registration keeps the child-side finite registry free of process-runtime imports. */
export function registerScenarioManifestHandle(handle: ScenarioProcesses, assertActive: () => void): void {
  if (activeHandles.has(handle)) throw new Error('Scenario manifest handle is already registered');
  activeHandles.set(handle, assertActive);
}
function assertActiveHandle(handle: ScenarioProcesses): void {
  const assertActive = activeHandles.get(handle);
  if (!assertActive) throw new Error('Scenario manifest handle is not owned');
  assertActive();
}
/** Pure catalog authority shared by the runner and child; importing it never loads seed fixtures. */
export const SCENARIO_IDS = [
  'funded-purchase', 'guilt-free-spending', 'unfunded-category', 'donor-reallocation',
  'protected-category', 'goal-category', 'donor-competition', 'future-assignment',
  'account-transfer', 'transfer-too-late', 'credit-card-purchase', 'missing-account-evidence',
  'expired-account-evidence', 'currency-mismatch', 'pending-debit', 'uncategorized-debit',
  'reservation-block', 'reservation-inform', 'commitment-overlap', 'rich-cart',
  'required-item-overage', 'outside-price', 'expired-session', 'split-completion',
  'cooldown-completion', 'coapproval-completion', 'import-before-completion',
  'import-after-completion', 'ambiguous-completion', 'governance-scoped-access',
  'governance-invitation-lifecycle', 'governance-delegated-assistant', 'merchant-local-sparse',
  'merchant-local-insufficient', 'merchant-alias-conflict', 'merchant-recurrence-calendar',
  'merchant-native-rule-lifecycle', 'merchant-research-success', 'merchant-research-outage',
  'merchant-research-lifecycle',
] as const;
export type ScenarioId = typeof SCENARIO_IDS[number];
export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && SCENARIO_IDS.some((id) => id === value);
}

export interface ScenarioManifest {
  readonly version: 1;
  readonly phase: 'setup' | 'ready';
  readonly generation: number;
  readonly origin: string;
  readonly actualUrl: string;
  readonly root: string;
  readonly authDbPath: string;
  readonly workflowDbPath: string;
  readonly connectionPath: string;
  readonly internalSecret: string;
  readonly budgetId: string | null;
  readonly actorIds: readonly string[];
  readonly scenarioId: ScenarioId | null;
  readonly spaceId: string | null;
  readonly research?: { readonly provider: 'fixture'; readonly controlPath: string };
}
export interface ScenarioResearchControl {
  readonly version: 1;
  readonly generation: number;
  readonly scenarioId: ScenarioId;
  readonly spaceId: string;
  mode: 'success' | 'outage' | 'held';
  clockOffsetMs: number;
  releaseVersion: number;
  cancelVersion: number;
}

/** Verify every component before opening a runner-private file, including existing targets. */
function privatePath(root: string, pathname: string): void {
  const inside = relative(root, pathname);
  if (!isAbsolute(root) || resolve(root) !== root || !isAbsolute(pathname) || resolve(pathname) !== pathname ||
    !inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error('Scenario private path is outside its owned root');
  let cursor = parse(pathname).root;
  for (const component of pathname.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink()) throw new Error('Scenario private path contains a symlink');
      if (cursor === root && (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700))
        throw new Error('Scenario root is not private');
      if (cursor === pathname && (!stats.isFile() || (stats.mode & 0o777) !== 0o600))
        throw new Error('Scenario file is not private');
    } catch (error) {
      if (cursor === pathname && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
export function writeScenarioPrivateFile(root: string, pathname: string, value: unknown): void {
  privatePath(root, pathname);
  const temporary = join(dirname(pathname), `.scenario-${randomBytes(12).toString('hex')}`);
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(value));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    closeSync(descriptor);
  }
  try {
    privatePath(root, pathname);
    renameSync(temporary, pathname);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
export function readScenarioManifest(handle: ScenarioProcesses): ScenarioManifest {
  assertActiveHandle(handle);
  privatePath(handle.root, handle.manifestPath);
  const stats = lstatSync(handle.manifestPath);
  if (stats.size > 64 * 1024) throw new Error('Scenario manifest is too large');
  const manifest = JSON.parse(readFileSync(handle.manifestPath, 'utf8')) as ScenarioManifest;
  if (manifest.version !== 1 || manifest.root !== handle.root || manifest.internalSecret !== handle.internalSecret ||
    manifest.origin !== handle.publicOrigin || manifest.actualUrl !== handle.actualUrl ||
    manifest.authDbPath !== handle.authDbPath || manifest.workflowDbPath !== handle.workflowDbPath || manifest.connectionPath !== handle.connectionPath ||
    !['setup', 'ready'].includes(manifest.phase) ||
    !Number.isSafeInteger(manifest.generation) || manifest.generation < 0 ||
    (manifest.scenarioId !== null && !isScenarioId(manifest.scenarioId))) throw new Error('Scenario manifest authority changed');
  return manifest;
}
export function writeScenarioManifest(handle: ScenarioProcesses, manifest: ScenarioManifest): void {
  assertActiveHandle(handle);
  const previous = readScenarioManifest(handle);
  if (manifest.root !== handle.root || manifest.internalSecret !== handle.internalSecret ||
    manifest.origin !== handle.publicOrigin || manifest.actualUrl !== handle.actualUrl ||
    manifest.authDbPath !== handle.authDbPath || manifest.workflowDbPath !== handle.workflowDbPath || manifest.connectionPath !== handle.connectionPath ||
    (manifest.scenarioId !== null && !isScenarioId(manifest.scenarioId)) ||
    manifest.generation !== previous.generation ||
    (previous.scenarioId !== null && manifest.scenarioId !== previous.scenarioId) ||
    (previous.spaceId !== null && manifest.spaceId !== previous.spaceId))
    throw new Error('Scenario manifest publication changed owned authority');
  if (previous.research && (!manifest.research || manifest.research.controlPath !== previous.research.controlPath))
    cancelScenarioResearch(handle);
  writeScenarioPrivateFile(handle.root, handle.manifestPath, manifest);
}
export function initialScenarioManifest(handle: ScenarioProcesses, generation = 1, scenarioId: ScenarioId | null = null): ScenarioManifest {
  if (!Number.isSafeInteger(generation) || generation < 0 || (scenarioId !== null && !isScenarioId(scenarioId)))
    throw new Error('Scenario shell selection is invalid');
  return {
    version: 1, phase: 'setup', generation, scenarioId, spaceId: null,
    origin: handle.publicOrigin, actualUrl: handle.actualUrl, root: handle.root,
    authDbPath: handle.authDbPath, workflowDbPath: handle.workflowDbPath,
    connectionPath: handle.connectionPath, internalSecret: handle.internalSecret,
    budgetId: null, actorIds: [],
  };
}
export function initializeScenarioResearch(handle: ScenarioProcesses, manifest: ScenarioManifest, mode: ScenarioResearchControl['mode']): ScenarioManifest {
  assertActiveHandle(handle);
  const current = readScenarioManifest(handle);
  if (current.phase !== 'ready' || current.spaceId !== manifest.spaceId || current.scenarioId !== manifest.scenarioId ||
    current.generation !== manifest.generation || current.research) throw new Error('Scenario research initialization is stale');
  if (!manifest.scenarioId || !manifest.spaceId) throw new Error('Scenario research requires the selected space');
  const controlPath = join(handle.root, 'research-control.json');
  if (existsSync(controlPath) || existsSync(`${controlPath}.status`)) throw new Error('Scenario research cannot reuse retired control files');
  writeScenarioPrivateFile(handle.root, controlPath, {
    version: 1, generation: manifest.generation, scenarioId: manifest.scenarioId, spaceId: manifest.spaceId,
    mode, clockOffsetMs: 0, releaseVersion: 0, cancelVersion: 0,
  } satisfies ScenarioResearchControl);
  writeScenarioPrivateFile(handle.root, `${controlPath}.status`, { version: 1, generation: manifest.generation, calls: 0, held: 0 });
  return { ...manifest, research: { provider: 'fixture', controlPath } };
}
function updateScenarioResearch(handle: ScenarioProcesses, action: 'research-hold' | 'research-release' | 'research-cancel' | 'research-expire', retiring = false): void {
  const manifest = readScenarioManifest(handle);
  const selector = manifest.research;
  if (!selector || manifest.phase !== 'ready') throw new Error('Scenario research is unavailable');
  privatePath(handle.root, selector.controlPath);
  if (lstatSync(selector.controlPath).size > 16 * 1024) throw new Error('Scenario research control is too large');
  const control = JSON.parse(readFileSync(selector.controlPath, 'utf8')) as ScenarioResearchControl;
  if (control.version !== 1 || control.generation !== manifest.generation || control.scenarioId !== manifest.scenarioId || control.spaceId !== manifest.spaceId ||
    !Number.isSafeInteger(control.releaseVersion) || control.releaseVersion < 0 || control.releaseVersion > 1000 ||
    !Number.isSafeInteger(control.cancelVersion) || control.cancelVersion < 0 || control.cancelVersion > 1000 ||
    !Number.isSafeInteger(control.clockOffsetMs) || control.clockOffsetMs < 0 || control.clockOffsetMs > 7_200_000 ||
    !['success', 'outage', 'held'].includes(control.mode)) throw new Error('Scenario research control authority changed');
  // Reserve the final cancellation increment for reset/shutdown, including after exhausted browser controls.
  if (retiring && control.cancelVersion === 1000) return;
  if ((action === 'research-release' && control.releaseVersion >= 999) ||
    (action === 'research-cancel' && control.cancelVersion >= (retiring ? 1000 : 999)))
    throw new Error('Scenario research control limit reached');
  switch (action) {
    case 'research-hold': control.mode = 'held'; break;
    case 'research-release': control.mode = 'success'; control.releaseVersion += 1; break;
    case 'research-cancel': control.cancelVersion += 1; break;
    case 'research-expire': control.clockOffsetMs = 3_600_001; break;
    default: throw new Error('Unknown scenario research control');
  }
  writeScenarioPrivateFile(handle.root, selector.controlPath, control);
}
export function controlScenarioResearch(handle: ScenarioProcesses, action: 'research-hold' | 'research-release' | 'research-cancel' | 'research-expire'): void {
  updateScenarioResearch(handle, action);
}
export function cancelScenarioResearch(handle: ScenarioProcesses): void {
  if (readScenarioManifest(handle).research) updateScenarioResearch(handle, 'research-cancel', true);
}

/** Exact story mutations; the ordinary handlers retain identity, capabilities, proof and consent checks. */
export function scenarioFeatureWrite(scenarioId: ScenarioId | null, method: string, path: string): boolean {
  if (!scenarioId) return false;
  if (scenarioId === 'governance-scoped-access' || scenarioId === 'governance-invitation-lifecycle')
    return (method === 'PUT' && /^\/api\/spaces\/[^/]+\/grants$/.test(path)) ||
      (method === 'POST' && /^\/api\/spaces\/[^/]+\/memberships\/[^/]+\/revoke$/.test(path));
  if (scenarioId === 'governance-delegated-assistant')
    return method === 'POST' && /^\/api\/spaces\/[^/]+\/delegations\/[^/]+\/revoke$/.test(path);
  if (!scenarioId.startsWith('merchant-')) return false;
  if (method === 'POST' && path === '/api/review/sync') return true;
  if ((scenarioId === 'merchant-alias-conflict' || scenarioId === 'merchant-recurrence-calendar') && method === 'POST' &&
    (path === '/api/merchant/confirm' || path === '/api/merchant/reject')) return true;
  if (scenarioId === 'merchant-alias-conflict' && method === 'POST' &&
    (path === '/api/review/correct' || /^\/api\/proposal\/[^/]+\/(?:approve|execute)$/.test(path))) return true;
  if (scenarioId === 'merchant-recurrence-calendar' && method === 'PUT' && path === '/api/merchant/policy') return true;
  if (scenarioId === 'merchant-native-rule-lifecycle' && method === 'POST' &&
    (path === '/api/review/propose-rule' || path === '/api/proposal' || /^\/api\/proposal\/[^/]+\/(?:approve|execute|discard)$/.test(path))) return true;
  if (scenarioId.startsWith('merchant-research-') && method === 'POST' &&
    (path === '/api/merchant/research' || path === '/api/merchant/research/preview' || path === '/api/merchant/research/cache')) return true;
  return scenarioId === 'merchant-research-lifecycle' && (
    (method === 'DELETE' && path === '/api/merchant') ||
    (method === 'PUT' && (path === '/api/merchant/policy' || path === '/api/merchant/space-policy' || /^\/api\/spaces\/[^/]+\/grants$/.test(path)))
  );
}
