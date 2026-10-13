import type { MerchantServiceOptions, MerchantResearchConfiguration, MerchantResearchSettings } from '@balanceframe/application';
import type { MerchantEnrichmentProvider, MerchantResearchRequest, MerchantResearchResult, MerchantResearchFailureCode, ProviderInfo } from '@balanceframe/inference';
import type { H3Event } from 'h3';
import type { ScenarioFixtureContext } from './demo-boundary';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { merchantResearchRequestSchema } from '@balanceframe/inference';
import { z } from 'zod';
import { getScenarioFixtureContext } from './demo-boundary';

const version = 'scenario-fixture/1';
const researchStories = ['merchant-research-success', 'merchant-research-outage', 'merchant-research-lifecycle'] as const;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const controlSchema = z.object({
  version: z.literal(1), generation: integer, scenarioId: z.enum(researchStories), spaceId: z.string().min(1).max(512),
  mode: z.enum(['success', 'outage', 'held']), clockOffsetMs: integer.max(7200000), releaseVersion: integer, cancelVersion: integer,
}).strict();
const telemetrySchema = z.object({ version: z.literal(1), generation: integer, calls: integer.max(1000), held: integer.max(16) }).strict();
const requestSchema = z.object({ merchant: z.unknown(), locale: z.unknown().optional(), signal: z.instanceof(AbortSignal).optional() }).strict();
interface ResearchBinding { root: string; generation: number; scenarioId: string; spaceId: string; controlPath: string }
interface ResearchControl { version: 1; generation: number; scenarioId: string; spaceId: string; mode: 'success' | 'outage' | 'held'; clockOffsetMs: number; releaseVersion: number; cancelVersion: number }
interface ResearchTelemetry { version: 1; generation: number; calls: number; held: number }
interface ResearchFiles { control: ResearchControl; telemetry: ResearchTelemetry }
const policy = { mode: 'external-allowed' as const, allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 1 };
const localSettings: MerchantResearchSettings = { installation: { version, value: { ...policy, mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0 } }, configuration: null };
const localResearch: MerchantServiceOptions['research'] = { settings: () => localSettings };
const source = { url: 'https://merchant.example.invalid/about', title: 'Scenario fixture merchant evidence', snippet: 'Synthetic scenario fixture evidence; not live search or financial advice.' };

/** Only private runner-owned regular files beneath the already validated root. */
function privateFile(root: string, pathname: string): unknown {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname) throw new Error('Invalid fixture path');
  const child = relative(root, pathname);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Invalid fixture root');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) throw new Error('Invalid fixture root');
  let component = root;
  for (const segment of child.split(sep)) {
    component = join(component, segment);
    if (lstatSync(component).isSymbolicLink()) throw new Error('Invalid fixture link');
  }
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid fixture file');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}

function readFiles(binding: ResearchBinding): ResearchFiles {
  const control = controlSchema.parse(privateFile(binding.root, binding.controlPath));
  const telemetry = telemetrySchema.parse(privateFile(binding.root, `${binding.controlPath}.status`));
  if (control.generation !== binding.generation || telemetry.generation !== binding.generation || control.scenarioId !== binding.scenarioId || control.spaceId !== binding.spaceId) throw new Error('Fixture binding changed');
  return { control, telemetry };
}

/** The child is the sole telemetry writer; synchronous atomic replacement cannot lose sibling dispatch increments. */
function writeTelemetry(binding: ResearchBinding, value: ResearchTelemetry): void {
  telemetrySchema.parse(value);
  const pathname = `${binding.controlPath}.status`;
  privateFile(binding.root, pathname);
  const temporary = join(dirname(pathname), `.research-status-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value), 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, pathname);
  } finally { rmSync(temporary, { force: true }); }
}

class ScenarioResearchProvider implements MerchantEnrichmentProvider {
  readonly providerId = 'valueserp';
  readonly providerVersion = version;
  // Logical metadata satisfies the existing coordinator; this implementation never constructs a transport or reads credentials.
  readonly providerInfo: ProviderInfo = { id: 'valueserp', name: 'Scenario fixture (closed, no network)', locality: 'external', supportedCapabilities: ['merchantResearch'], endpoint: 'https://api.valueserp.com/search', authType: 'api-key', model: null };
  constructor(readonly binding: ResearchBinding, private readonly read: () => ResearchFiles | null) {}

  private failure(code: MerchantResearchFailureCode, billing: 'not_dispatched' | 'uncertain', retrievedAt: string): MerchantResearchResult {
    return { status: 'failed', providerId: this.providerId, providerVersion: this.providerVersion, code, billing, retrievedAt };
  }

  async research(request: MerchantResearchRequest): Promise<MerchantResearchResult> {
    const initial = this.read();
    let retrievedAt = new Date(Date.now() + (initial?.control.clockOffsetMs ?? 0)).toISOString();
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success || !merchantResearchRequestSchema.safeParse({ merchant: parsed.data.merchant, locale: parsed.data.locale }).success) return this.failure('invalid_request', 'not_dispatched', retrievedAt);
    if (!initial || request.signal?.aborted) return this.failure('cancelled', 'not_dispatched', retrievedAt);
    const held = initial.control.mode === 'held';
    if (initial.telemetry.calls >= 1000 || held && initial.telemetry.held >= 16) return this.failure('unavailable', 'not_dispatched', retrievedAt);
    writeTelemetry(this.binding, { ...initial.telemetry, calls: initial.telemetry.calls + 1, held: initial.telemetry.held + (held ? 1 : 0) });
    try {
      if (held) {
        const deadline = performance.now() + 120000;
        // Deliberately ignore AbortSignal after dispatch: the real coordinator/store must fence late results after deletion.
        while (true) {
          const current = this.read();
          if (!current) return this.failure('cancelled', 'uncertain', retrievedAt);
          retrievedAt = new Date(Date.now() + current.control.clockOffsetMs).toISOString();
          if (current.control.cancelVersion !== initial.control.cancelVersion) return this.failure('cancelled', 'uncertain', retrievedAt);
          if (current.control.releaseVersion !== initial.control.releaseVersion) break;
          if (performance.now() >= deadline) return this.failure('timeout', 'uncertain', retrievedAt);
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
        }
      }
      const current = this.read();
      if (!current) return this.failure('cancelled', 'uncertain', retrievedAt);
      retrievedAt = new Date(Date.now() + current.control.clockOffsetMs).toISOString();
      if (initial.control.mode === 'outage') return this.failure('unavailable', 'uncertain', retrievedAt);
      return { status: 'ok', providerId: this.providerId, providerVersion: this.providerVersion, retrievedAt, confidence: 'uncalibrated', sources: [{ ...source }] };
    } finally {
      if (held) {
        try {
          const current = readFiles(this.binding);
          if (current.telemetry.held > 0) writeTelemetry(this.binding, { ...current.telemetry, held: current.telemetry.held - 1 });
        } catch { /* Retired or replaced private files must not override cancellation or mutate a successor. */ }
      }
    }
  }
}

const providers = new Map<string, ScenarioResearchProvider>();

/** Trusted private-manifest composition only; an absent deployment manifest preserves ordinary production settings. */
export function composeScenarioResearch(event: H3Event, selectedSpaceId: string): MerchantServiceOptions['research'] {
  let context: ScenarioFixtureContext;
  try { context = getScenarioFixtureContext(event); }
  catch { return localResearch; }
  if (!context.active) return undefined;
  if (!context.valid || context.spaceId !== selectedSpaceId || !context.research || !researchStories.some((story) => story === context.scenarioId)) return localResearch;
  const binding: ResearchBinding = { root: context.root, generation: context.generation, scenarioId: context.scenarioId, spaceId: context.spaceId, controlPath: context.research.controlPath };
  const read = (): ResearchFiles | null => {
    try {
      const current = getScenarioFixtureContext(event);
      if (!current.active || !current.valid || current.root !== binding.root || current.generation !== binding.generation || current.scenarioId !== binding.scenarioId || current.spaceId !== binding.spaceId || current.research?.controlPath !== binding.controlPath) return null;
      return readFiles(binding);
    } catch { return null; }
  };
  if (!read()) return localResearch;
  const identity = `scenario-fixture:${createHash('sha256').update(JSON.stringify([binding.root, binding.controlPath, binding.generation])).digest('hex')}`;
  const configuration: MerchantResearchConfiguration = {
    installationId: identity, installationVersion: version, installationPolicy: policy,
    credentialId: identity, credentialVersion: version, credentialLimits: { maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100 },
    tariff: { version, billingCurrency: 'USD', costAtoms: '250000' }, apiKey: 'scenario-fixture-no-credential',
  };
  return {
    settings: () => read() ? { installation: { version, value: policy }, configuration } : localSettings,
    clock: () => {
      const files = read();
      if (!files) throw new Error('Fixture authority unavailable');
      return new Date(Date.now() + files.control.clockOffsetMs);
    },
    providerFor: () => {
      if (!read()) throw new Error('Fixture authority unavailable');
      let provider = providers.get(binding.controlPath);
      if (provider && provider.binding.generation === binding.generation && (provider.binding.spaceId !== binding.spaceId || provider.binding.scenarioId !== binding.scenarioId || provider.binding.root !== binding.root)) throw new Error('Fixture binding changed');
      if (!provider || provider.binding.generation !== binding.generation) {
        provider = new ScenarioResearchProvider(binding, read);
        providers.set(binding.controlPath, provider);
      }
      return provider;
    },
  };
}
