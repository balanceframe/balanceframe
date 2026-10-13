// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createEvent } from 'h3';
import type * as Application from '@balanceframe/application';
import type { H3Event } from 'h3';
import type * as Inference from '@balanceframe/inference';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerchantResearchSettings } from '../../../../packages/application/src/merchant-settings';
import type { MerchantResearchConfiguration, MerchantResearchOutcome, MerchantResearchQuery } from '../../../../packages/application/src/merchant-research';
import { MerchantIntelligenceService } from '../../../../packages/application/src/merchant-service';
import { accountId, candidateId, merchantFixture, native, now, type MerchantFixture } from '../../../../packages/application/test/merchant-service.fixture';

const production = vi.hoisted(() => ({ settings: vi.fn<() => MerchantResearchSettings>(), provider: vi.fn() }));
vi.mock('../../../../packages/application/src/merchant-settings', async (original) => ({
  ...(await original<Record<string, unknown>>()), loadMerchantResearchSettings: production.settings,
}));
vi.mock('@balanceframe/inference', async (original) => {
  const actual = await original<typeof Inference>();
  return { ...actual, ValueSerpProvider: Object.assign(production.provider, { providerInfo: actual.ValueSerpProvider.providerInfo }) };
});
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<typeof Application>()),
  createDefaultConnectionManager: () => fixture.manager,
}));
import syncReview from '../../server/api/review/sync.post';
import { composeScenarioResearch } from '../../server/utils/scenario-research';
import { getScenarioFixtureContext } from '../../server/utils/demo-boundary';

interface Control {
  version: 1; generation: number; scenarioId: string; spaceId: string; mode: 'success' | 'outage' | 'held'; clockOffsetMs: number;
  releaseVersion: number; cancelVersion: number;
}
interface Telemetry { version: 1; generation: number; calls: number; held: number }
type FixtureEvent = H3Event & { context: { runtimeConfig: Record<string, unknown> } };
const policy = { mode: 'external-allowed' as const, allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 1 };
const source = { url: 'https://merchant.example.invalid/about', title: 'Scenario fixture merchant evidence', snippet: 'Synthetic scenario fixture evidence; not live search or financial advice.' };
const origin = 'https://balanceframe.test';
const actualUrl = 'http://127.0.0.1:49231';
let fixture: MerchantFixture;
let service: MerchantIntelligenceService;
let root: string;
let manifestPath: string;
let controlPath: string;
let event: FixtureEvent;
let query: MerchantResearchQuery;
let fetchSpy: MockInstance<typeof fetch>;

function saveControl(overrides: Partial<Control> = {}): void {
  const previous = JSON.parse(readFileSync(controlPath, 'utf8')) as Control;
  writeFileSync(controlPath, JSON.stringify({ ...previous, ...overrides }), { mode: 0o600 });
  chmodSync(controlPath, 0o600);
}
function control(): Control { return JSON.parse(readFileSync(controlPath, 'utf8')) as Control; }
function telemetry(): Telemetry { return JSON.parse(readFileSync(`${controlPath}.status`, 'utf8')) as Telemetry; }
function saveManifest(overrides: Record<string, unknown> = {}): void {
  writeFileSync(manifestPath, JSON.stringify({
    version: 1, phase: 'ready', generation: 3, origin, actualUrl, root,
    authDbPath: join(root, 'auth.sqlite'), workflowDbPath: fixture.databasePath, connectionPath: join(root, 'config.json'),
    internalSecret: 'runner-private-secret-012345678901234567890', budgetId: fixture.actor.budgetId,
    actorIds: [fixture.actor.actorId], scenarioId: 'merchant-research-success', spaceId: fixture.actor.spaceId,
    research: { provider: 'fixture', controlPath }, ...overrides,
  }), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
}
async function compose(): Promise<void> {
  const research = await composeScenarioResearch(event, fixture.actor.spaceId);
  expect(research).toBeDefined();
  service = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native, clock: () => new Date(fixture.clock()), research });
}
async function enable(): Promise<void> {
  const space = await service.spacePolicy(fixture.actor);
  await service.setSpacePolicy(fixture.actor, { expectedVersion: space.version, value: policy });
  const budget = await service.policy(fixture.actor);
  await service.setPolicy(fixture.actor, { expectedVersion: budget.version, value: policy });
  const target = (await service.analyze(fixture.actor)).suggestions.find((row) => row.transactionId === candidateId);
  if (!target) throw new Error('Compiled native fixture must admit the research target');
  query = { evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision, merchant: 'Aster Public Atelier', locale: null, publicBusiness: true };
}
async function send(key: string, merchant = query.merchant) {
  const value = { ...query, merchant };
  const preview = await service.previewResearch(fixture.actor, value);
  expect(preview.status).toBe('ready');
  if (preview.status !== 'ready') throw new Error('Expected real authorized preview');
  expect(preview).toMatchObject({ merchant, locale: null, providerId: 'valueserp', providerVersion: 'scenario-fixture/1', fieldsSent: ['merchant', 'locale'], maxCostAtoms: '250000', billingCurrency: 'USD' });
  return service.research(fixture.actor, { ...value, previewToken: preview.previewToken, consent: true, idempotencyKey: key });
}
function noProduction(): void {
  expect(production.settings).not.toHaveBeenCalled();
  expect(production.provider).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  fixture = await merchantFixture();
  fixture.setConfig(actualUrl);
  root = dirname(fixture.databasePath); chmodSync(root, 0o700);
  manifestPath = join(root, 'manifest.json'); controlPath = join(root, 'research.json');
  mkdirSync(join(root, 'credentials'), { mode: 0o700 });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, serverUrl: actualUrl, budgetId: fixture.actor.budgetId, budgetName: 'Merchant', groupId: fixture.actor.budgetId }), { mode: 0o600 });
  writeFileSync(controlPath, JSON.stringify({ version: 1, generation: 3, scenarioId: 'merchant-research-success', spaceId: fixture.actor.spaceId, mode: 'success', clockOffsetMs: 0, releaseVersion: 0, cancelVersion: 0 } satisfies Control), { mode: 0o600 });
  writeFileSync(`${controlPath}.status`, JSON.stringify({ version: 1, generation: 3, calls: 0, held: 0 } satisfies Telemetry), { mode: 0o600 });
  saveManifest();
  event = {
    context: { runtimeConfig: { demoMode: false, public: { demoMode: false }, demoManifestPath: manifestPath, authDbPath: join(root, 'auth.sqlite'), workflowDbPath: fixture.databasePath, connectionPath: join(root, 'config.json'), credentialDir: join(root, 'credentials'), actualServerUrl: actualUrl, reviewAndApply: true } },
    node: { req: { method: 'POST', url: '/api/merchant/research/preview', headers: { host: 'balanceframe.test', origin, 'x-balanceframe-space': fixture.actor.spaceId }, socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' } } },
  } as unknown as FixtureEvent;
  const configured: MerchantResearchConfiguration = { installationId: 'production', installationVersion: 'production/1', installationPolicy: policy, credentialId: 'paid', credentialVersion: 'paid/1', credentialLimits: { maxSearchesPerDay: 100, maxSpendMinorUnitsPerMonth: 100 }, tariff: { version: 'paid/1', billingCurrency: 'USD', costAtoms: '250000' }, apiKey: 'REAL-PRODUCTION-KEY-MUST-NOT-BE-READ' };
  production.settings.mockReset().mockReturnValue({ installation: { version: 'production/1', value: policy }, configuration: configured });
  production.provider.mockReset().mockImplementation(() => { throw new Error('Paid provider must never be constructed for fixture composition'); });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture provider must not fetch'));
  vi.stubEnv('VALUESERP_API_KEY', configured.apiKey);
  fixture.grant('budget', fixture.actor.budgetId, 'merchant:research');
  fixture.grant('account', accountId, 'merchant:research');
  fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'merchant:research');
});
afterEach(async () => { await fixture.cleanup(); vi.useRealTimers(); fetchSpy.mockRestore(); vi.unstubAllEnvs(); });

describe('owned manifest-bound closed scenario research composition', () => {
  it('leaves genuinely ordinary production composition unchanged without a configured manifest path', async () => {
    delete event.context.runtimeConfig.demoManifestPath;
    expect(getScenarioFixtureContext(event)).toEqual({ active: false });
    expect(await composeScenarioResearch(event, fixture.actor.spaceId)).toBeUndefined();
    noProduction();
  });

  it('normal Review Sync preserves real fixture categorization without consulting ambient paid installation settings', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'full-read');
    vi.stubEnv('BETTER_AUTH_URL', origin);
    production.settings.mockReturnValue({ installation: { version: 'production/disabled', value: { ...policy, mode: 'disabled' } }, configuration: null });
    const socket = new Socket();
    try {
      const incoming = new IncomingMessage(socket);
      incoming.method = 'POST'; incoming.url = '/api/review/sync';
      incoming.headers = { host: 'balanceframe.test', origin, 'x-balanceframe-space': fixture.actor.spaceId };
      const request = createEvent(incoming, new ServerResponse(incoming));
      request.context.runtimeConfig = event.context.runtimeConfig;
      request.context.auth = {
        authenticated: true, actorId: fixture.actor.actorId, principalType: 'human',
        method: 'session', sessionId: fixture.actor.auth.sessionId, user: { id: fixture.actor.actorId },
      };
      const response = await syncReview(request);
      expect(response.status, JSON.stringify(response)).toBe('ok');
      expect(response.result).toMatchObject({ synchronized: true, result: {
        candidates: [expect.objectContaining({ transactionId: candidateId, proposedCategoryId: 'category-food', amount: { minorUnits: '100', currency: 'USD' },
          merchantEvidence: expect.objectContaining({ sourceTransaction: expect.objectContaining({ amount: { minorUnits: '-100', currency: 'USD' } }) }) })],
        totalUncategorizedAmount: { minorUnits: '100', currency: 'USD' },
      } });
      const persisted = await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId, limit: -1 });
      expect(persisted.map((row) => ({ transactionId: row.transactionId, categoryId: row.categoryId })))
        .toEqual([{ transactionId: candidateId, categoryId: 'category-food' }]);
      noProduction();
    } finally { socket.destroy(); }
  });

  it('activates only the validated selected fixture while public demo mode is false', async () => {
    expect(getScenarioFixtureContext(event)).toEqual({ active: true, valid: true, scenarioId: 'merchant-research-success', spaceId: fixture.actor.spaceId, root, generation: 3, research: { provider: 'fixture', controlPath } });
    await compose(); await enable();
    const consent = await service.previewResearch(fixture.actor, query);
    if (consent.status !== 'ready') throw new Error(`Expected explicit fixture preview before consent: ${JSON.stringify(consent)}`);
    expect(await service.research(fixture.actor, { ...query, previewToken: consent.previewToken, consent: false, idempotencyKey: 'fixture-no-consent' })).toMatchObject({ status: 'denied', code: 'invalid_request', billing: 'not_dispatched' });
    expect(await service.research(fixture.actor, { ...query, previewToken: 'a'.repeat(64), consent: true, idempotencyKey: 'fixture-forged-consent' })).toMatchObject({ status: 'denied', code: 'consent_required', billing: 'not_dispatched' });
    const result = await send('fixture-first');
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected actual fixture coordinator success');
    expect(result.enrichment).toMatchObject({ key: { scope: { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId }, providerId: 'valueserp', providerVersion: 'scenario-fixture/1' }, sources: [source], fieldsSent: ['merchant', 'locale'], retrievedAt: now, expiresAt: '2026-10-04T13:00:00.000Z', confidence: 'uncalibrated', evidenceRevision: query.evidenceRevision });
    expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 1, held: 0 });
    expect(statSync(`${controlPath}.status`).mode & 0o777).toBe(0o600);
    expect(statSync(controlPath).mode & 0o777).toBe(0o600);
    expect((await send('fixture-cache')).status).toBe('cached');
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: result.enrichment });
    expect(telemetry().calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('REAL-PRODUCTION-KEY');
    expect(JSON.stringify(result)).not.toContain('runner-private-secret');
    expect((await service.analyze(fixture.actor)).localReview.totalUncategorizedAmount).toEqual({ minorUnits: '100', currency: 'USD' });
    noProduction();
  });

  it.each(['missing-manifest', 'malformed-manifest', 'manifest-mode', 'root', 'selected-space', 'runtime-path', 'actual-url', 'foreign-control', 'symlink-control', 'missing-control', 'missing-status', 'malformed-control', 'oversize-control', 'control-mode', 'control-generation', 'control-space', 'control-story', 'unknown-mode', 'clock-negative', 'clock-excess', 'calls-excess', 'held-excess', 'status-mode', 'status-symlink', 'status-generation', 'status-malformed', 'unregistered-story', 'selector', 'nonresearch'] as const)('keeps %s fixture authority explicitly local-only even when paid configuration is available', async (kind) => {
    if (kind === 'missing-manifest') rmSync(manifestPath);
    else if (kind === 'malformed-manifest') writeFileSync(manifestPath, '{invalid');
    else if (kind === 'manifest-mode') chmodSync(manifestPath, 0o644);
    else if (kind === 'root') saveManifest({ root: dirname(root) });
    else if (kind === 'selected-space') saveManifest({ spaceId: 'foreign-space' });
    else if (kind === 'runtime-path') saveManifest({ authDbPath: join(root, 'foreign-auth.sqlite') });
    else if (kind === 'actual-url') saveManifest({ actualUrl: 'http://127.0.0.1:49232' });
    else if (kind === 'foreign-control') saveManifest({ research: { provider: 'fixture', controlPath: join(dirname(root), 'foreign-control.json') } });
    else if (kind === 'symlink-control') { const target = join(root, 'control-target.json'); writeFileSync(target, readFileSync(controlPath), { mode: 0o600 }); rmSync(controlPath); symlinkSync(target, controlPath); }
    else if (kind === 'missing-control') rmSync(controlPath);
    else if (kind === 'missing-status') rmSync(`${controlPath}.status`);
    else if (kind === 'malformed-control') writeFileSync(controlPath, '{invalid');
    else if (kind === 'oversize-control') writeFileSync(controlPath, ' '.repeat(16385));
    else if (kind === 'control-mode') chmodSync(controlPath, 0o644);
    else if (kind === 'control-generation') saveControl({ generation: 2 });
    else if (kind === 'control-space') saveControl({ spaceId: 'foreign-space' });
    else if (kind === 'control-story') saveControl({ scenarioId: 'merchant-research-outage' });
    else if (kind === 'unknown-mode') writeFileSync(controlPath, JSON.stringify({ ...control(), mode: 'fetch' }));
    else if (kind === 'calls-excess' || kind === 'held-excess') writeFileSync(`${controlPath}.status`, JSON.stringify({ version: 1, generation: 3, calls: kind === 'calls-excess' ? 1001 : 0, held: kind === 'held-excess' ? 17 : 0 }), { mode: 0o600 });
    else if (kind === 'status-mode') chmodSync(`${controlPath}.status`, 0o644);
    else if (kind === 'status-symlink') { const target = join(root, 'status-target.json'); writeFileSync(target, JSON.stringify({ version: 1, generation: 3, calls: 0, held: 0 }), { mode: 0o600 }); rmSync(`${controlPath}.status`); symlinkSync(target, `${controlPath}.status`); }
    else if (kind === 'status-generation') writeFileSync(`${controlPath}.status`, JSON.stringify({ version: 1, generation: 2, calls: 0, held: 0 }), { mode: 0o600 });
    else if (kind === 'status-malformed') writeFileSync(`${controlPath}.status`, '{invalid', { mode: 0o600 });
    else if (kind === 'clock-negative') saveControl({ clockOffsetMs: -1 });
    else if (kind === 'clock-excess') saveControl({ clockOffsetMs: 7200001 });
    else if (kind === 'unregistered-story') saveManifest({ scenarioId: 'merchant-arbitrary-provider' });
    else if (kind === 'selector') saveManifest({ research: { provider: 'valueserp', controlPath, endpoint: 'https://api.valueserp.com/search' } });
    else saveManifest({ scenarioId: 'merchant-local-sparse', research: null });
    await compose(); await enable();
    expect((await service.researchPolicy(fixture.actor)).resolved.mode).toBe('local-only');
    expect(await service.previewResearch(fixture.actor, query)).toMatchObject({ status: 'denied' });
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    expect((await service.analyze(fixture.actor)).localReview.uncategorizedCount).toBe(1);
    noProduction();
  });

  it('never enables a provider from environment or public request selectors', async () => {
    saveManifest({ scenarioId: 'merchant-local-sparse', research: null });
    vi.stubEnv('BALANCEFRAME_SCENARIO_RESEARCH_PROVIDER', 'valueserp');
    event.node.req.url = '/api/merchant/research/preview?provider=fixture&scenario=merchant-research-success';
    event.node.req.headers['x-balanceframe-research-provider'] = 'fixture';
    await compose(); await enable();
    expect((await service.researchPolicy(fixture.actor)).resolved.mode).toBe('local-only');
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied');
    expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 0, held: 0 }); noProduction();
  });

  it('reports a closed outage without fabricated enrichment and preserves native local analysis', async () => {
    saveManifest({ scenarioId: 'merchant-research-outage' }); saveControl({ scenarioId: 'merchant-research-outage', mode: 'outage' });
    await compose(); await enable();
    expect(await send('fixture-outage')).toMatchObject({ status: 'failed', code: 'unavailable', billing: 'uncertain' });
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 1, held: 0 });
    expect((await service.analyze(fixture.actor)).localReview.totalUncategorizedAmount).toEqual({ minorUnits: '100', currency: 'USD' });
    noProduction();
  });

  it.each(['policy', 'grant'] as const)('denies cached fixture observations after current %s revocation without another dispatch', async (kind) => {
    await compose(); await enable(); expect((await send('fixture-before-revoke')).status).toBe('succeeded');
    if (kind === 'grant') fixture.grant('evidence', query.evidenceKey, 'merchant:research', false);
    else { const prior = await service.spacePolicy(fixture.actor); await service.setSpacePolicy(fixture.actor, { expectedVersion: prior.version, value: { ...policy, mode: 'local-only' } }); }
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied');
    expect(telemetry().calls).toBe(1); noProduction();
  });

  it('expires fixture cache after a bounded hour without aging current human controls', async () => {
    await compose(); await enable(); expect((await send('fixture-clock')).status).toBe('succeeded');
    const proof = fixture.actor.auth;
    saveControl({ clockOffsetMs: 3600001 });
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    const renewed = await send('fixture-clock-renewed');
    expect(renewed.status).toBe('succeeded');
    if (renewed.status !== 'succeeded') throw new Error('Expected a real new attempt after fixture cache expiry');
    expect(renewed.enrichment).toMatchObject({ retrievedAt: '2026-10-04T13:00:00.001Z', expiresAt: '2026-10-04T14:00:00.001Z', sources: [source] });
    expect(fixture.clock()).toBe(now); expect(new Date().toISOString()).toBe(now); expect(fixture.actor.auth).toBe(proof);
    const prior = await service.policy(fixture.actor);
    expect((await service.setPolicy(fixture.actor, { expectedVersion: prior.version, value: { ...policy, mode: 'local-only' } })).version).toBe(prior.version + 1);
    expect((await service.delete(fixture.actor)).generation).toBe(prior.generation + 2);
    expect(telemetry().calls).toBe(2); noProduction();
  });

  it.each(['space-policy', 'budget-policy', 'grant'] as const)('withholds a real held fixture result after %s revocation even when it ignores the abort signal', async (kind) => {
    saveManifest({ scenarioId: 'merchant-research-lifecycle' }); saveControl({ scenarioId: 'merchant-research-lifecycle', mode: 'held' });
    await compose(); await enable();
    const pending = send(`fixture-held-${kind}`);
    try {
      await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 1 }));
      if (kind === 'grant') fixture.grant('evidence', query.evidenceKey, 'merchant:research', false);
      else if (kind === 'space-policy') {
        const prior = await service.spacePolicy(fixture.actor);
        await service.setSpacePolicy(fixture.actor, { expectedVersion: prior.version, value: { ...policy, mode: 'local-only' } });
      } else {
        const prior = await service.policy(fixture.actor);
        await service.setPolicy(fixture.actor, { expectedVersion: prior.version, value: { ...policy, mode: 'local-only' } });
      }
    } finally { saveControl({ releaseVersion: control().releaseVersion + 1 }); }
    const result = await pending;
    expect(result.status === 'failed' || result.status === 'denied').toBe(true);
    expect(JSON.stringify(result)).not.toContain(source.snippet);
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied');
    await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 0 }));
    noProduction();
  });

  it('settles a held late fixture result after delete without publishing deleted observations', async () => {
    saveManifest({ scenarioId: 'merchant-research-lifecycle' }); saveControl({ scenarioId: 'merchant-research-lifecycle', mode: 'held' });
    await compose(); await enable();
    const pending = send('fixture-held-delete');
    await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 1 }));
    try {
      expect((await service.analyze(fixture.actor)).localReview.uncategorizedCount).toBe(1);
      expect((await service.delete(fixture.actor)).generation).toBe(2);
    } finally { saveControl({ releaseVersion: control().releaseVersion + 1 }); }
    const result = await pending;
    expect(result.status === 'failed' || result.status === 'denied').toBe(true);
    expect(JSON.stringify(result)).not.toContain(source.snippet);
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 0 }));
    noProduction();
  });

  it('rejects a foreign selected namespace rather than treating the manifest selector as authority', async () => {
    const research = await composeScenarioResearch(event, 'foreign-space');
    expect(research?.settings().configuration).toBeNull();
    expect(research?.settings().installation.value.mode).toBe('local-only');
    expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 0, held: 0 }); noProduction();
  });

  it('rechecks control authority after composition before admission and never falls back to paid configuration', async () => {
    await compose(); await enable();
    const preview = await service.previewResearch(fixture.actor, query);
    if (preview.status !== 'ready') throw new Error('Expected authorized preview');
    rmSync(controlPath);
    expect(await service.research(fixture.actor, { ...query, previewToken: preview.previewToken, consent: true, idempotencyKey: 'removed-control' })).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    noProduction();
  });

  it('keeps concurrent held fixture counts exact and releases both real coordinator results without network I/O', async () => {
    saveManifest({ scenarioId: 'merchant-research-lifecycle' }); saveControl({ scenarioId: 'merchant-research-lifecycle', mode: 'held' });
    await compose(); await enable();
    const first = send('held-concurrent-first', 'Aster Atelier');
    let second: Promise<MerchantResearchOutcome> | undefined;
    try {
      await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 1 }));
      // Respect the real store's credential burst guard; only the trusted research clock advances.
      saveControl({ clockOffsetMs: control().clockOffsetMs + 1001 });
      second = send('held-concurrent-second', 'Birch Bakery');
      await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 2, held: 2 }));
    } finally {
      saveControl({ releaseVersion: control().releaseVersion + 1 });
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    if (!second) throw new Error('Expected a second actual held dispatch');
    const results = await Promise.all([first, second]);
    expect(results).toMatchObject([{ status: 'succeeded' }, { status: 'succeeded' }]);
    for (const result of results) {
      if (result.status !== 'succeeded') throw new Error('Expected released fixture result');
      expect(result.enrichment.sources).toEqual([source]);
    }
    await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 2, held: 0 }));
    noProduction();
  });

  it('settles explicit runner cancellation of a held fixture without publication', async () => {
    saveManifest({ scenarioId: 'merchant-research-lifecycle' }); saveControl({ scenarioId: 'merchant-research-lifecycle', mode: 'held' });
    await compose(); await enable();
    const pending = send('fixture-held-cancel');
    try {
      await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 1 }));
    } finally { saveControl({ cancelVersion: control().cancelVersion + 1 }); }
    expect(await pending).toMatchObject({ status: 'failed', code: 'cancelled', billing: 'uncertain' });
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    await vi.waitFor(() => expect(telemetry()).toMatchObject({ calls: 1, held: 0 }));
    noProduction();
  });

  it('cleans retired held fixture telemetry after authority removal and same-generation restoration', async () => {
    saveManifest({ scenarioId: 'merchant-research-lifecycle' }); saveControl({ scenarioId: 'merchant-research-lifecycle', mode: 'held' });
    await compose(); await enable();
    const pending = send('fixture-held-authority-retired');
    try {
      await vi.waitFor(() => expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 1, held: 1 }));
      saveManifest({ scenarioId: 'merchant-research-lifecycle', research: null });
      const result = await pending;
      // Restore only after cancellation has actually settled, so this cannot revive the held result.
      saveManifest({ scenarioId: 'merchant-research-lifecycle' });
      expect(['denied', 'failed']).toContain(result.status);
      expect(result).toMatchObject({ billing: 'uncertain' });
      expect(JSON.stringify(result)).not.toContain(source.snippet);
      expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 1, held: 0 });
      expect(composeScenarioResearch(event, fixture.actor.spaceId)?.settings().configuration).not.toBeNull();
      expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
      noProduction();
    } finally {
      saveControl({ cancelVersion: control().cancelVersion + 1 });
      saveManifest({ scenarioId: 'merchant-research-lifecycle' });
      await Promise.allSettled([pending]);
    }
  });

  it('leaves replacement-generation counters untouched when an old held fixture retires', async () => {
    saveManifest({ scenarioId: 'merchant-research-lifecycle' }); saveControl({ scenarioId: 'merchant-research-lifecycle', mode: 'held' });
    await compose(); await enable();
    const pending = send('fixture-held-generation-retired');
    const replacement: Telemetry = { version: 1, generation: 4, calls: 7, held: 2 };
    try {
      await vi.waitFor(() => expect(telemetry()).toEqual({ version: 1, generation: 3, calls: 1, held: 1 }));
      saveManifest({ scenarioId: 'merchant-research-lifecycle', generation: 4 });
      saveControl({ generation: 4 });
      // A successor owns these counters; the retiring generation must not decrement its held work.
      writeFileSync(`${controlPath}.status`, JSON.stringify(replacement), { mode: 0o600 });
      const result = await pending;
      expect(['denied', 'failed']).toContain(result.status);
      expect(result).toMatchObject({ billing: 'uncertain' });
      expect(JSON.stringify(result)).not.toContain(source.snippet);
      expect(telemetry()).toEqual(replacement);
      await compose();
      expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
      expect(telemetry()).toEqual(replacement);
      noProduction();
    } finally {
      saveControl({ cancelVersion: control().cancelVersion + 1 });
      await Promise.allSettled([pending]);
    }
  });

  it.each(['daily', 'monthly'] as const)('enforces the real %s quota on fresh fixture branches, not provider counters', async (kind) => {
    await compose(); await enable();
    const research = await composeScenarioResearch(event, fixture.actor.spaceId);
    const tariff = research?.settings().configuration?.tariff;
    expect(tariff).toEqual({ version: 'scenario-fixture/1', billingCurrency: 'USD', costAtoms: '250000' });
    const cap = kind === 'daily' ? { maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 100 }
      : { maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 1 };
    const prior = await service.spacePolicy(fixture.actor);
    await service.setSpacePolicy(fixture.actor, { expectedVersion: prior.version, value: { ...policy, ...cap } });
    const count = kind === 'daily' ? 1 : 4;
    const names = ['Aster Atelier', 'Birch Bakery', 'Cedar Books', 'Dapple Grove'];
    for (let index = 0; index < count; index++) {
      // Distinct queries still obey the native one-launch-per-second credential limit.
      if (index > 0) saveControl({ clockOffsetMs: control().clockOffsetMs + 1001 });
      expect(await send(`fixture-quota-${index}`, names[index]!)).toMatchObject({ status: 'succeeded', enrichment: { sources: [source] } });
    }
    saveControl({ clockOffsetMs: control().clockOffsetMs + 1001 });
    expect(await send('fixture-quota-denied', 'Willow Market')).toEqual({ status: 'denied', code: kind === 'daily' ? 'daily_cap' : 'monthly_cap', billing: 'not_dispatched' });
    expect(telemetry().calls).toBe(count); noProduction();
  });
});
