import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ValueSerpProvider, type MerchantEnrichmentProvider, type ProviderInfo } from '@balanceframe/inference';
import { SqliteWorkflowStore, type GovernanceOperation, type MerchantCacheKey, type MerchantEvidence, type MerchantPolicyValue, type MerchantQuotaBucket, type MerchantScope, type MerchantViewAccess } from '@balanceframe/workflow-store';
import { MerchantResearchCoordinator, resolveMerchantResearchPolicy, type MerchantResearchCapture, type MerchantResearchConfiguration, type MerchantResearchHost, type MerchantResearchOutcome, type MerchantResearchPolicyLayer, type MerchantResearchPreview, type MerchantResearchQuery, type MerchantResearchRequest, type MerchantResearchTarget } from '../src/merchant-research.js';
import type { MerchantActor, MerchantPolicyView } from '../src/merchant-service.js';
import { merchantFixture, now, humanAuth, accountId, candidateId, evidenceKey, type MerchantFixture } from './merchant-service.fixture.js';

const POLICY: MerchantPolicyValue = { mode: 'external-allowed', allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 720 };
const CONFIG: MerchantResearchConfiguration = {
  installationId: 'installation-owned', installationVersion: 'installation/1', installationPolicy: POLICY,
  credentialId: 'credential-owned', credentialVersion: 'credential/1', credentialLimits: { maxSearchesPerDay: 100, maxSpendMinorUnitsPerMonth: 1000 },
  tariff: { version: 'actual-account-tariff/1', billingCurrency: 'USD', costAtoms: '250000' }, apiKey: 'SERVER-KEY-NEVER-PERSIST',
};
const PROVIDER: ProviderInfo = { id: 'valueserp', name: 'ValueSerp', locality: 'external', supportedCapabilities: ['merchantResearch'], endpoint: 'https://api.valueserp.com/search', authType: 'api-key', model: null };
const SOURCES = [{ url: 'https://merchant.example/about', title: 'Independent public retailer', snippet: 'Historical untrusted observation, not an account or transaction identity.' }];
type ReadyPreview = Extract<MerchantResearchPreview, { status: 'ready' }>;
interface InspectionDatabase { prepare(sql: string): { all(): unknown[] }; close(): void }
interface PausedNetwork { entered: Promise<void>; release: () => void }
interface JournalRow { id: string; phase: string; reserved_atoms: string; settled_atoms: string | null; claim_token: string | null; dispatched_at: string | null; content_deleted: number; buckets: string; day_window: string; month_window: string }
const Database = createRequire(createRequire(import.meta.url).resolve('@balanceframe/workflow-store'))('better-sqlite3') as new (filename: string, options: { readonly: boolean }) => InspectionDatabase;

let fixture: MerchantFixture;
let configuration: MerchantResearchConfiguration | null;
let coordinator: MerchantResearchCoordinator;
let query: MerchantResearchQuery;
let sourceScope: MerchantScope;
let spaceScope: MerchantScope;
let captureDepth: number;
let calls: Array<{ url: URL; signal: AbortSignal | null | undefined; captureDepth: number }>;
let response: () => Promise<Response>;
let providerIgnoresAbort: boolean;
let providerStartsAborted: boolean;
let peers: SqliteWorkflowStore[];
let afterCaptureReturn: (() => void | Promise<void>) | null;

function rows(table: 'merchant_research_attempts' | 'merchant_enrichment_cache' | 'merchant_evidence' | 'merchant_policies'): unknown[] {
  const database = new Database(fixture.databasePath, { readonly: true });
  try { return database.prepare(`SELECT * FROM ${table}`).all(); } finally { database.close(); }
}
function journal(): JournalRow[] {
  return rows('merchant_research_attempts') as JournalRow[];
}
function setTime(value: string, refreshAuthentication = true): void {
  fixture.setClock(value); vi.setSystemTime(value);
  if (refreshAuthentication) fixture.actor.auth = humanAuth(fixture.actor.actorId, value);
}
function advance(seconds: number, refreshAuthentication = true): void { setTime(new Date(Date.parse(fixture.clock()) + seconds * 1000).toISOString(), refreshAuthentication); }
function successResponse(): Response {
  return Response.json({ request_info: { success: true }, organic_results: SOURCES.map((source) => ({ link: source.url, title: source.title, snippet: source.snippet })),
    search_metadata: { api_url: `https://api.valueserp.com/search?api_key=${CONFIG.apiKey}&q=Northstar%20Market`, private_fields: 'PRIVATE-NOTE-DO-NOT-PUBLISH' } });
}
const fetchFn: typeof fetch = async (input, init) => {
  calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), signal: init?.signal, captureDepth });
  return response();
};
function providerFor(config: MerchantResearchConfiguration): MerchantEnrichmentProvider {
  const provider = new ValueSerpProvider({ apiKey: config.apiKey, fetchFn, now: () => new Date(fixture.clock()) });
  if (providerStartsAborted) return { providerId: provider.providerId, providerVersion: provider.providerVersion, providerInfo: provider.providerInfo,
    research: (request) => { const cancelled = new AbortController(); cancelled.abort(); return provider.research({ ...request, signal: cancelled.signal }); } };
  // Exercise a real validated provider response arriving after a trusted provider ignores cancellation.
  return providerIgnoresAbort ? { providerId: provider.providerId, providerVersion: provider.providerVersion, providerInfo: provider.providerInfo,
    research: (request) => provider.research({ merchant: request.merchant, locale: request.locale }) } : provider;
}
function grantResearch(actor = fixture.actor): void {
  fixture.grant('budget', actor.budgetId, 'merchant:research', true, actor);
  fixture.grant('account', accountId, 'merchant:research', true, actor);
  fixture.grant('evidence', evidenceKey(candidateId), 'merchant:research', true, actor);
}
function governance(actor: MerchantActor, required: MerchantEvidence['sourceRefs']['required'], operations: GovernanceOperation[], operation = 'merchant:research'): boolean {
  const decision = fixture.store.governance.authorize({ actorId: actor.actorId, spaceId: actor.spaceId, membershipId: actor.membershipId,
    expectedPolicyVersion: actor.governancePolicyVersion!, operation, phase: 'read', required: required.map((item) => ({ ...item, visibility: 'resource' as const })),
    payload: { operations }, auth: actor.auth, now: fixture.clock() });
  return decision.allowed && decision.disposition.kind === 'authorized_without_approval';
}
function policyAccess(scope: MerchantScope, owner = fixture.store): MerchantViewAccess {
  const expectedGeneration = owner.merchant.generation(scope);
  return { scope, now: fixture.clock(), expectedGeneration, actorId: fixture.actor.actorId, visibility: { hash: 'a'.repeat(64), privateActorId: fixture.actor.actorId },
    authorize: (context) => JSON.stringify(context.scope) === JSON.stringify(scope) && context.generation === expectedGeneration
      && governance(fixture.actor, [...context.sourceRefs.required,
        { resourceKind: 'budget', resourceId: scope.budgetId, capability: 'observe', version: null },
        { resourceKind: 'space', resourceId: scope.spaceId, capability: 'policy:manage', version: null }], [{ operation: 'policy:update', resourceKind: 'space', resourceId: scope.spaceId }], 'policy:update') };
}
function spacePolicy(owner = fixture.store): MerchantPolicyView {
  const stored = owner.merchant.policy(policyAccess(spaceScope, owner));
  return { scope: spaceScope, version: stored?.version ?? 0, generation: owner.merchant.generation(spaceScope),
    value: stored ? { mode: stored.mode, allowedProviderIds: stored.allowedProviderIds, maxSearchesPerDay: stored.maxSearchesPerDay, maxSpendMinorUnitsPerMonth: stored.maxSpendMinorUnitsPerMonth, billingCurrency: stored.billingCurrency, cacheTtlHours: stored.cacheTtlHours }
      : { ...POLICY, mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0 } };
}
function setSpacePolicy(value: MerchantPolicyValue): void {
  const previous = spacePolicy();
  const saved = fixture.store.merchant.setPolicy({ ...policyAccess(spaceScope), expectedVersion: previous.version, value });
  if (!saved) throw new Error('Real space policy admission refused');
}
async function setBudgetPolicy(value: MerchantPolicyValue): Promise<void> {
  const previous = await fixture.service.policy(fixture.actor);
  await fixture.service.setPolicy(fixture.actor, { expectedVersion: previous.version, value });
  const current = await fixture.service.analyze(fixture.actor);
  const target = current.suggestions.find((candidate) => candidate.transactionId === candidateId);
  if (target) query = { ...query, evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision };
}
function host(owner = fixture.store): MerchantResearchHost {
  return { store: owner, clock: () => new Date(fixture.clock()), configuration: () => configuration, providerFor,
    withCapture: async <T>(actor: MerchantActor, target: MerchantResearchTarget, consume: (capture: MerchantResearchCapture) => T | Promise<T>): Promise<T> => {
      const value = await fixture.service['withResearchCapture'](actor, target, async (capture) => {
        captureDepth++;
        try { return await consume(capture); }
        finally { captureDepth--; }
      });
      const after = afterCaptureReturn;
      afterCaptureReturn = null;
      await after?.();
      return value;
    } };
}
async function ready(value = query, owner = coordinator, actor = fixture.actor): Promise<ReadyPreview> {
  const preview = await owner.preview(actor, value);
  expect(preview.status).toBe('ready');
  if (preview.status !== 'ready') throw new Error('Expected authorized exact egress preview');
  return preview;
}
function request(preview: ReadyPreview, idempotencyKey: string, value = query): MerchantResearchRequest { return { ...value, previewToken: preview.previewToken, consent: true, idempotencyKey }; }
async function research(idempotencyKey: string, value = query) { return coordinator.research(fixture.actor, request(await ready(value), idempotencyKey, value)); }
function pauseNetwork(): PausedNetwork {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  response = async () => { entered(); await gate; return successResponse(); };
  return { entered: started, release };
}
function noProviderContent(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(SOURCES[0]!.snippet);
  expect(rows('merchant_enrichment_cache')).toHaveLength(0);
}
function layers(overrides: Partial<Record<MerchantResearchPolicyLayer['kind'], MerchantPolicyValue | null>> = {}): MerchantResearchPolicyLayer[] {
  return (['installation', 'space', 'budget'] as const).map((kind) => ({ kind, version: `${kind}/1`, value: kind in overrides ? overrides[kind]! : POLICY }));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  configuration = structuredClone(CONFIG);
  fixture = await merchantFixture({ research: { settings: () => ({
    installation: { version: configuration?.installationVersion ?? CONFIG.installationVersion, value: configuration?.installationPolicy ?? CONFIG.installationPolicy },
    configuration,
  }), providerFor } });
  peers = []; calls = []; captureDepth = 0; providerIgnoresAbort = false; providerStartsAborted = false; response = async () => successResponse();
  afterCaptureReturn = null;
  grantResearch();
  const budget = await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: POLICY });
  sourceScope = budget.scope; spaceScope = { ...sourceScope, connectionId: 'merchant:space-policy' }; setSpacePolicy(POLICY);
  const view = await fixture.service.analyze(fixture.actor);
  const target = view.suggestions.find((candidate) => candidate.transactionId === candidateId);
  if (!target) throw new Error('Canonical native merchant fixture requires admitted target');
  query = { evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision, merchant: 'Northstar Market', locale: 'US', publicBusiness: true };
  coordinator = new MerchantResearchCoordinator(host());
});
afterEach(async () => { for (const peer of peers ?? []) peer.close(); if (fixture) await fixture.cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('independent merchant research policy intersection', () => {
  it('preserves all independently versioned provenance and uses the shortest TTL/provider intersection', () => {
    const resolved = resolveMerchantResearchPolicy(layers({ installation: { ...POLICY, allowedProviderIds: ['valueserp', 'installation-only'], cacheTtlHours: 48 }, space: { ...POLICY, allowedProviderIds: ['valueserp', 'space-only'], cacheTtlHours: 12 } }), PROVIDER);
    expect(resolved).toMatchObject({ mode: 'external-allowed', allowedProviderIds: ['valueserp'], cacheTtlHours: 12, billingCurrency: 'USD',
      layers: [{ kind: 'installation', version: 'installation/1' }, { kind: 'space', version: 'space/1' }, { kind: 'budget', version: 'budget/1' }] });
  });
  it('exposes conservative numeric per-request ceilings without replacing independent journal buckets', () => {
    const resolved = resolveMerchantResearchPolicy(layers({ installation: { ...POLICY, maxSearchesPerDay: 100 }, space: { ...POLICY, maxSearchesPerDay: 3, maxSpendMinorUnitsPerMonth: 2 } }), PROVIDER);
    expect(resolved).toMatchObject({ maxSearchesPerDay: 3, maxSpendMinorUnitsPerMonth: 2 });
  });
  it.each(['installation', 'space', 'budget'] as const)('does not allow a permissive child to override disabled %s', (kind) => {
    expect(resolveMerchantResearchPolicy(layers({ [kind]: { ...POLICY, mode: 'disabled' } }), PROVIDER).mode).toBe('disabled');
  });
  it.each(['installation', 'space', 'budget'] as const)('missing %s has no external opt-in', (kind) => {
    const resolved = resolveMerchantResearchPolicy(layers({ [kind]: null }), PROVIDER);
    expect(resolved.mode).toBe('local-only'); expect(resolved.allowedProviderIds).toEqual([]);
  });
  it('intersects instead of feeding hierarchical allowlists to inference union semantics', () => {
    expect(resolveMerchantResearchPolicy(layers({ installation: { ...POLICY, allowedProviderIds: ['different-provider'] } }), PROVIDER).allowedProviderIds).toEqual([]);
  });
  it('denies invalid layers, ambiguous layer topology, and incompatible billing currencies', () => {
    const invalid = { ...POLICY, maxSearchesPerDay: -1 };
    expect(resolveMerchantResearchPolicy(layers({ space: invalid }), PROVIDER).allowedProviderIds).toEqual([]);
    expect(resolveMerchantResearchPolicy([layers()[0]!, layers()[0]!, layers()[2]!], PROVIDER).allowedProviderIds).toEqual([]);
    expect(resolveMerchantResearchPolicy(layers({ space: { ...POLICY, billingCurrency: 'CAD' } }), PROVIDER)).toMatchObject({ allowedProviderIds: [], billingCurrency: null });
  });
  it('reuses existing inference external-auth/provider-capability validation', () => {
    expect(resolveMerchantResearchPolicy(layers(), { ...PROVIDER, authType: null }).allowedProviderIds).toEqual([]);
    expect(resolveMerchantResearchPolicy(layers(), { ...PROVIDER, supportedCapabilities: ['classification'] }).allowedProviderIds).toEqual([]);
  });
});

describe('exact independent egress preview and consent', () => {
  it('shows the actual normalized standalone query, exact fractional maximum cost and irreversible disclosure', async () => {
    const preview = await ready({ ...query, merchant: '  Northstar Market  ' });
    expect(preview).toMatchObject({ merchant: 'Northstar Market', locale: 'US', evidenceKey: query.evidenceKey, evidenceRevision: query.evidenceRevision,
      providerId: 'valueserp', providerVersion: 'valueserp-search/1', fieldsSent: ['merchant', 'locale'], maxCostAtoms: '250000', billingCurrency: 'USD' });
    expect(preview.previewToken).toMatch(/^[a-f0-9]{32,128}$/);
    expect(Date.parse(preview.expiresAt) - Date.parse(fixture.clock())).toBeGreaterThan(0);
    expect(Date.parse(preview.expiresAt) - Date.parse(fixture.clock())).toBeLessThanOrEqual(300000);
    expect(preview.disclosure).toMatch(/IP/i); expect(preview.disclosure).toMatch(/retention/i); expect(preview.disclosure).toMatch(/cannot.*recall/i); expect(preview.disclosure).toMatch(/app.*dispatch/i);
    expect(calls).toHaveLength(0); expect(journal()).toHaveLength(0);
    const persisted = JSON.stringify(rows('merchant_evidence'));
    expect(persisted).toContain(`research-preview:${preview.previewToken}`); expect(persisted).not.toContain(query.merchant); expect(persisted).not.toContain(CONFIG.apiKey);
  });
  it.each([
    { publicBusiness: false }, { merchant: 'person@example.test' }, { merchant: 'ACCT 12345678' }, { merchant: 'USD 10.50' },
    { merchant: 'site:private.example' }, { merchant: 'Northstar\u0000Market' }, { merchant: '' }, { merchant: 'x'.repeat(121) },
    { actorId: 'forged-holder' }, { providerId: 'client-selected' }, { apiKey: 'client-key' }, { locale: 'Toronto' }, { endpoint: 'http://127.0.0.1/' },
  ])('rejects unknown/context/unsafe query input without provider I/O: %j', async (changes) => {
    expect(await coordinator.preview(fixture.actor, { ...query, ...changes })).toMatchObject({ status: 'denied' }); expect(calls).toHaveLength(0); expect(journal()).toHaveLength(0);
  });
  it('does not infer locale from currency or browser/IP; null remains null on egress', async () => {
    const result = await research('locale-null', { ...query, locale: null });
    expect(result.status).toBe('succeeded'); expect(calls).toHaveLength(1); expect(calls[0]!.url.searchParams.has('gl')).toBe(false);
  });
  it.each([{ consent: false }, { previewToken: 'f'.repeat(64) }, { merchant: 'Different Public Shop' }, { locale: 'CA' }, { evidenceRevision: 'f'.repeat(64) }, { publicBusiness: false }, { installationId: 'client-reset' }])('binds separate consent to exact preview, source and query: %j', async (changes) => {
    const preview = await ready();
    expect(await coordinator.research(fixture.actor, { ...request(preview, 'tampered'), ...changes })).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
    expect(calls).toHaveLength(0); expect(journal()).toHaveLength(0);
  });
  it('requires explicit consent even when current local alias evidence exists', async () => {
    await fixture.service.confirm(fixture.actor, { id: 'alias-local-consent', kind: 'alias', evidenceKey: query.evidenceKey, evidenceRevision: query.evidenceRevision,
      expectedVersion: 0, visibility: 'private', transactionId: candidateId, sourceField: 'importedPayee', targetPayeeId: 'payee-market', accountId });
    const current = await fixture.service.analyze(fixture.actor); const target = current.suggestions.find((candidate) => candidate.transactionId === candidateId)!;
    query = { ...query, evidenceRevision: target.evidenceRevision };
    expect(await coordinator.research(fixture.actor, { ...query, consent: true, idempotencyKey: 'alias-is-not-egress' })).toMatchObject({ status: 'denied', billing: 'not_dispatched' }); expect(calls).toHaveLength(0);
  });
  it('expires preview consent at exactly five minutes and never allows another actor to borrow it', async () => {
    const preview = await ready(); advance(300);
    expect(await coordinator.research(fixture.actor, request(preview, 'expired'))).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
    setTime(now); const member = await fixture.addMember('second-holder'); fixture.grantSources(member); grantResearch(member);
    expect(await coordinator.research(member, request(preview, 'borrowed'))).toMatchObject({ status: 'denied', billing: 'not_dispatched' }); expect(calls).toHaveLength(0);
  });
  it.each(['budget', 'account', 'evidence'] as const)('requires independent current %s research authority, not analysis rights', async (kind) => {
    fixture.grant(kind, kind === 'budget' ? fixture.actor.budgetId : kind === 'account' ? accountId : query.evidenceKey, 'merchant:research', false);
    expect(await coordinator.preview(fixture.actor, query)).toMatchObject({ status: 'denied' }); expect(calls).toHaveLength(0);
    expect((await fixture.service.analyze(fixture.actor)).localReview.uncategorizedCount).toBe(1);
  });
});

describe('server configuration and every policy/quota layer', () => {
  it.each(['absent', 'unknown-tariff', 'zero-cost', 'bad-currency', 'missing-version', 'invalid-key'] as const)('fails closed for %s account configuration', async (kind) => {
    if (kind === 'absent') configuration = null;
    else if (kind === 'unknown-tariff') configuration = { ...CONFIG, tariff: null } as unknown as MerchantResearchConfiguration;
    else if (kind === 'zero-cost') configuration = { ...CONFIG, tariff: { ...CONFIG.tariff, costAtoms: '0' } };
    else if (kind === 'bad-currency') configuration = { ...CONFIG, tariff: { ...CONFIG.tariff, billingCurrency: 'CAD' } };
    else if (kind === 'missing-version') configuration = { ...CONFIG, credentialVersion: '' };
    else configuration = { ...CONFIG, apiKey: 'key\nunsafe' };
    expect(await coordinator.preview(fixture.actor, query)).toMatchObject({ status: 'denied' }); expect(calls).toHaveLength(0); expect(journal()).toHaveLength(0);
  });
  it.each(['installation', 'space', 'budget'] as const)('honors less-permissive %s independently for dispatch and cache', async (kind) => {
    expect((await research('before-policy')).status).toBe('succeeded');
    if (kind === 'installation') configuration = { ...CONFIG, installationPolicy: { ...POLICY, mode: 'local-only' } };
    else if (kind === 'space') setSpacePolicy({ ...POLICY, mode: 'local-only' });
    else await setBudgetPolicy({ ...POLICY, mode: 'local-only' });
    expect(await coordinator.cached(fixture.actor, query)).toBeNull(); expect(await coordinator.preview(fixture.actor, query)).toMatchObject({ status: 'denied' }); expect(calls).toHaveLength(1);
  });
  it.each(['installation', 'space', 'budget', 'credential'] as const)('cannot override the zero search/spend cap on %s', async (kind) => {
    const zero = { ...POLICY, maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0 };
    if (kind === 'installation') configuration = { ...CONFIG, installationPolicy: zero };
    else if (kind === 'credential') configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0 } };
    else if (kind === 'space') setSpacePolicy(zero);
    else await setBudgetPolicy(zero);
    expect(await coordinator.preview(fixture.actor, query)).toMatchObject({ status: 'denied' }); expect(calls).toHaveLength(0); expect(journal()).toHaveLength(0);
  });
  it('enforces exact fractional charges: four quarter-cent requests exhaust one cent, not zero', async () => {
    configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 100, maxSpendMinorUnitsPerMonth: 1 } };
    for (let index = 0; index < 4; index++) { expect((await research(`fraction-${index}`, { ...query, merchant: `Northstar Market ${index}` })).status).toBe('succeeded'); advance(1); }
    const fifth = await research('fraction-fifth', { ...query, merchant: 'Another Public Market' });
    expect(fifth).toMatchObject({ status: 'denied', billing: 'not_dispatched' }); expect(calls).toHaveLength(4);
    expect(journal().map((attempt) => attempt.settled_atoms)).toEqual(['250000', '250000', '250000', '250000']);
  });
  it('uses stable server-owned global credential identity across independent coordinator connections', async () => {
    configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 100 } };
    expect((await research('global-first')).status).toBe('succeeded'); advance(1);
    const peer = new SqliteWorkflowStore(fixture.databasePath); peers.push(peer); const other = new MerchantResearchCoordinator(host(peer));
    const different = { ...query, merchant: 'Another Public Market' };
    const outcome = await other.research(fixture.actor, request(await ready(different, other), 'global-second', different));
    expect(outcome).toMatchObject({ status: 'denied', billing: 'not_dispatched' }); expect(calls).toHaveLength(1);
    expect(JSON.parse(journal()[0]!.buckets)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'credential', id: CONFIG.credentialId }), expect.objectContaining({ kind: 'installation', id: CONFIG.installationId })]));
  });
  it.each(['installation', 'space', 'budget', 'credential'] as const)('applies the nonzero %s daily cap, not merely the budget policy cap', async (kind) => {
    const one = { ...POLICY, maxSearchesPerDay: 1 };
    if (kind === 'installation') configuration = { ...CONFIG, installationPolicy: one };
    else if (kind === 'credential') configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 100 } };
    else if (kind === 'space') setSpacePolicy(one);
    else await setBudgetPolicy(one);
    expect((await research('cap-first')).status).toBe('succeeded'); advance(1);
    expect(await research('cap-second', { ...query, merchant: 'Different Public Shop' })).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
    expect(calls).toHaveLength(1); expect(journal()).toHaveLength(1);
  });
  it('cannot reset global quota through an Actual connection replacement', async () => {
    configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 100 } };
    expect((await research('connection-first')).status).toBe('succeeded'); advance(1);
    fixture.setConfig('https://replacement.actual.fixture.test/base');
    await setBudgetPolicy(POLICY);
    expect(await research('connection-second', { ...query, merchant: 'Different Public Shop' })).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
    expect(calls).toHaveLength(1); expect(journal()).toHaveLength(1);
  });
});

describe('durable historical cache and network lock boundary', () => {
  it('dispatches only merchant/coarse locale, retains attributed untrusted observations, and reuses cache without another charge', async () => {
    const preview = await ready(); const input = request(preview, 'successful'); const outcome = await coordinator.research(fixture.actor, input);
    expect(outcome.status).toBe('succeeded'); if (outcome.status !== 'succeeded') throw new Error('Expected provider success');
    expect(outcome.enrichment).toMatchObject({ sources: SOURCES, confidence: 'uncalibrated', evidenceRevision: query.evidenceRevision, fieldsSent: ['merchant', 'locale'], retrievedAt: now });
    expect(calls).toHaveLength(1); expect(calls[0]!.captureDepth).toBe(0); expect(calls[0]!.url.origin).toBe('https://api.valueserp.com');
    expect([...calls[0]!.url.searchParams.keys()].sort()).toEqual(['api_key', 'gl', 'num', 'output', 'q']); expect(calls[0]!.url.searchParams.get('q')).toBe(query.merchant);
    const cached = await coordinator.cached(fixture.actor, query); expect(cached).toEqual(outcome.enrichment);
    expect(await coordinator.research(fixture.actor, { ...input, idempotencyKey: 'same-cache-no-charge' })).toEqual({ status: 'cached', enrichment: outcome.enrichment });
    expect(calls).toHaveLength(1); expect(journal()).toHaveLength(1); expect(journal()[0]).toMatchObject({ phase: 'succeeded', reserved_atoms: '250000', settled_atoms: '250000' });
    const persisted = JSON.stringify([rows('merchant_evidence'), rows('merchant_enrichment_cache'), journal()]); const delivered = JSON.stringify(outcome);
    for (const value of [persisted, delivered]) { expect(value).not.toContain(CONFIG.apiKey); expect(value).not.toContain(query.merchant); expect(value).not.toContain('PRIVATE-NOTE-DO-NOT-PUBLISH'); expect(value).not.toContain('api.valueserp.com/search'); }
    expect(JSON.stringify(await fixture.service.export(fixture.actor))).not.toContain(SOURCES[0]!.snippet);
  });
  it('keeps ordinary native local analysis usable and SQLite writable while the provider is paused', async () => {
    const paused = pauseNetwork(); const input = request(await ready(), 'outside-locks'); const work = coordinator.research(fixture.actor, input); await paused.entered;
    try {
      expect(calls[0]!.captureDepth).toBe(0);
      const local = await fixture.service.analyze(fixture.actor); expect(local.localReview.uncategorizedCount).toBe(1);
      const peer = new SqliteWorkflowStore(fixture.databasePath); peers.push(peer); setSpacePolicy({ ...POLICY, cacheTtlHours: 48 });
      expect(peer.merchant.generation(spaceScope)).toBe(fixture.store.merchant.generation(spaceScope));
    } finally { paused.release(); }
    const outcome = await work; noProviderContent(outcome); expect(calls).toHaveLength(1);
  });
  it('coalesces identical pending work across real independent SQLite connections', async () => {
    const peer = new SqliteWorkflowStore(fixture.databasePath); peers.push(peer); const other = new MerchantResearchCoordinator(host(peer));
    const preview = await ready(); const paused = pauseNetwork(); const work = coordinator.research(fixture.actor, request(preview, 'pending-first')); await paused.entered;
    try {
      const second = await other.research(fixture.actor, request(preview, 'pending-second'));
      expect(second).toMatchObject({ status: 'pending', attemptId: expect.any(String) }); expect(journal()).toHaveLength(1); expect(calls).toHaveLength(1);
    } finally { paused.release(); }
    expect((await work).status).toBe('succeeded');
  });
  it('releases launch-rate refusal immediately and replays honest not-dispatched failure without retries', async () => {
    const peer = new SqliteWorkflowStore(fixture.databasePath); peers.push(peer); const other = new MerchantResearchCoordinator(host(peer));
    const different = { ...query, merchant: 'Different Public Shop' };
    const refusedInput = request(await ready(different, other), 'rate-second', different);
    const paused = pauseNetwork(); const first = coordinator.research(fixture.actor, request(await ready(), 'rate-first')); await paused.entered;
    let refused: MerchantResearchOutcome;
    let during: JournalRow[];
    try {
      refused = await other.research(fixture.actor, refusedInput);
      during = journal();
      expect(calls).toHaveLength(1);
    } finally { paused.release(); }
    expect((await first).status).toBe('succeeded');
    expect(refused).toEqual({ status: 'failed', code: 'unavailable', billing: 'not_dispatched' });
    expect(during.filter((attempt) => attempt.phase === 'reserved')).toHaveLength(0);
    expect(during.filter((attempt) => attempt.phase === 'dispatched')).toHaveLength(1);
    const released = during.find((attempt) => attempt.phase === 'known_failed');
    expect(released).toMatchObject({ reserved_atoms: '250000', settled_atoms: '0', claim_token: null, dispatched_at: null });
    advance(31);
    expect(await other.research(fixture.actor, refusedInput)).toEqual(refused);
    expect(journal()).toHaveLength(2); expect(calls).toHaveLength(1);
    const charged = journal().filter((attempt) => attempt.phase !== 'known_failed');
    expect(charged).toHaveLength(1);
    expect(charged.reduce((total, attempt) => total + BigInt(attempt.settled_atoms ?? attempt.reserved_atoms), 0n)).toBe(250000n);
    expect(journal().find((attempt) => attempt.id === released!.id)).toMatchObject({ phase: 'known_failed', settled_atoms: '0', dispatched_at: null });
  });
  it('releases third-concurrency refusal and never relaunches its exact idempotent request', async () => {
    const firstPaused = pauseNetwork(); const first = coordinator.research(fixture.actor, request(await ready(), 'parallel-first')); await firstPaused.entered;
    let second: Promise<MerchantResearchOutcome> | undefined;
    let secondPaused: PausedNetwork | undefined;
    let refusedInput!: MerchantResearchRequest;
    let refused!: MerchantResearchOutcome;
    let during!: JournalRow[];
    try {
      advance(1); const secondQuery = { ...query, merchant: 'Different Public Shop' }; const secondPreview = await ready(secondQuery);
      secondPaused = pauseNetwork(); second = coordinator.research(fixture.actor, request(secondPreview, 'parallel-second', secondQuery)); await secondPaused.entered;
      advance(1); const thirdQuery = { ...query, merchant: 'Third Public Shop' };
      refusedInput = request(await ready(thirdQuery), 'parallel-third', thirdQuery);
      refused = await coordinator.research(fixture.actor, refusedInput);
      during = journal(); expect(calls).toHaveLength(2);
    } finally { firstPaused.release(); secondPaused?.release(); }
    expect((await first).status).toBe('succeeded'); expect((await second!).status).toBe('succeeded');
    expect(refused).toEqual({ status: 'failed', code: 'unavailable', billing: 'not_dispatched' });
    expect(during.filter((attempt) => attempt.phase === 'reserved')).toHaveLength(0);
    expect(during.filter((attempt) => attempt.phase === 'dispatched')).toHaveLength(2);
    const released = during.find((attempt) => attempt.phase === 'known_failed');
    expect(released).toMatchObject({ reserved_atoms: '250000', settled_atoms: '0', claim_token: null, dispatched_at: null });
    advance(31);
    expect(await coordinator.research(fixture.actor, refusedInput)).toEqual(refused);
    expect(journal()).toHaveLength(3); expect(calls).toHaveLength(2);
    const charged = journal().filter((attempt) => attempt.phase !== 'known_failed');
    expect(charged).toHaveLength(2);
    expect(charged.reduce((total, attempt) => total + BigInt(attempt.settled_atoms ?? attempt.reserved_atoms), 0n)).toBe(500000n);
    expect(journal().find((attempt) => attempt.id === released!.id)).toMatchObject({ phase: 'known_failed', settled_atoms: '0', dispatched_at: null });
  });
  it('limits cached lifetime to the least-permissive policy TTL and invalidates changed current source', async () => {
    setSpacePolicy({ ...POLICY, cacheTtlHours: 1 }); const result = await research('ttl'); expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error('Expected provider success');
    expect(Date.parse(result.enrichment.expiresAt)).toBeLessThanOrEqual(Date.parse(now) + 3600000);
    advance(3600); expect(await coordinator.cached(fixture.actor, query)).toBeNull();
    setTime(now); fixture.setRows(fixture.rows().map((transaction) => transaction.id === candidateId ? { ...transaction, amount: -101 } : transaction));
    expect(await coordinator.cached(fixture.actor, query)).toBeNull(); expect(calls).toHaveLength(1);
  });
  it('does not deliver one actor private cache to another admitted member', async () => {
    expect((await research('private-cache')).status).toBe('succeeded');
    const member = await fixture.addMember('private-reader'); fixture.grantSources(member); grantResearch(member);
    expect(await coordinator.cached(member, query)).toBeNull(); expect(calls).toHaveLength(1);
  });
});

describe('fresh final source/authority/config/lifetime fences', () => {
  it.each(['source-grant', 'budget-policy', 'deletion', 'actor-deletion', 'abort', 'capture-rejected'] as const)('releases proven-unsent marked work after %s before provider invocation without resurrecting content', async (change) => {
    configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 1 },
      tariff: { ...CONFIG.tariff, costAtoms: '1000000' } };
    const input = request(await ready(), `marked-unsent-${change}`);
    afterCaptureReturn = async () => {
      expect(captureDepth).toBe(0); expect(calls).toHaveLength(0);
      expect(journal()).toMatchObject([{ phase: 'dispatched', reserved_atoms: '1000000', settled_atoms: null }]);
      if (change === 'source-grant') fixture.grant('transaction', candidateId, 'source', false);
      else if (change === 'budget-policy') await setBudgetPolicy({ ...POLICY, mode: 'disabled' });
      else if (change === 'deletion') await fixture.service.delete(fixture.actor);
      else if (change === 'actor-deletion') {
        const ownerToken = journal()[0]!.claim_token;
        expect(ownerToken).toBeTypeOf('string');
        await fixture.store.deleteScopeData('user', { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, actorId: fixture.actor.actorId });
        expect(journal()).toMatchObject([{ phase: 'uncertain', settled_atoms: null, claim_token: ownerToken, content_deleted: 1 }]);
        expect(rows('merchant_evidence')).toHaveLength(0);
      }
      else if (change === 'abort') coordinator.abortBudget({ spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId });
      else throw new Error('Capture failed after its callback completed');
    };
    const outcome = await coordinator.research(fixture.actor, input);
    expect(outcome).toMatchObject({ billing: 'not_dispatched' });
    expect(outcome.status === 'failed' || outcome.status === 'denied').toBe(true);
    expect(calls).toHaveLength(0); noProviderContent(outcome);
    expect(journal()).toMatchObject([{ phase: 'known_failed', reserved_atoms: '1000000', settled_atoms: '0', claim_token: null }]);
    expect(journal().filter((attempt) => attempt.phase !== 'known_failed')).toHaveLength(0);
    if (change === 'actor-deletion') expect(journal()[0]).toMatchObject({ content_deleted: 1 });
    advance(31);
    const replay = await coordinator.research(fixture.actor, input);
    expect(replay).toMatchObject({ billing: 'not_dispatched' });
    expect(replay.status === 'failed' || replay.status === 'denied').toBe(true);
    expect(calls).toHaveLength(0); noProviderContent(replay);
    expect(journal()).toMatchObject([{ phase: 'known_failed', settled_atoms: '0' }]);
    if (change === 'source-grant') fixture.grant('transaction', candidateId, 'source', true);
    else if (change === 'budget-policy' || change === 'deletion' || change === 'actor-deletion') await setBudgetPolicy(POLICY);
    expect((await research(`explicit-after-marked-${change}`, { ...query, merchant: 'Another Public Market' })).status).toBe('succeeded');
    expect(calls).toHaveLength(1); expect(journal()).toHaveLength(2);
    expect(journal()[0]).toMatchObject({ phase: 'known_failed', settled_atoms: '0' });
  });
  it.each(['source', 'source-grant', 'research-grant', 'membership', 'space-policy', 'budget-policy', 'installation-policy', 'credential-version', 'key-without-version', 'configuration-removed', 'deletion', 'actor-deletion', 'lease-expired'] as const)('discards paused provider content after %s changes, retaining possibly billed reservation', async (change) => {
    const paused = pauseNetwork(); const work = coordinator.research(fixture.actor, request(await ready(), `fence-${change}`)); await paused.entered;
    try {
      if (change === 'source') fixture.setRows(fixture.rows().map((transaction) => transaction.id === candidateId ? { ...transaction, amount: -101 } : transaction));
      else if (change === 'source-grant') fixture.grant('transaction', candidateId, 'source', false);
      else if (change === 'research-grant') fixture.grant('budget', fixture.actor.budgetId, 'merchant:research', false);
      else if (change === 'membership') fixture.store.governance.revokeMembership({ spaceId: fixture.actor.spaceId, membershipId: fixture.actor.membershipId!, now: fixture.clock(), auth: humanAuth('holder', fixture.clock()) });
      else if (change === 'space-policy') setSpacePolicy({ ...POLICY, mode: 'disabled' });
      else if (change === 'budget-policy') await setBudgetPolicy({ ...POLICY, mode: 'disabled' });
      else if (change === 'installation-policy') configuration = { ...CONFIG, installationVersion: 'installation/2', installationPolicy: { ...POLICY, mode: 'disabled' } };
      else if (change === 'credential-version') configuration = { ...CONFIG, credentialVersion: 'credential/2' };
      else if (change === 'key-without-version') configuration = { ...CONFIG, apiKey: 'ROTATED-KEY-SAME-VERSION' };
      else if (change === 'configuration-removed') configuration = null;
      else if (change === 'deletion') await fixture.service.delete(fixture.actor);
      else if (change === 'actor-deletion') await fixture.store.deleteScopeData('user', { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, actorId: fixture.actor.actorId });
      else advance(30);
    } finally { paused.release(); }
    const outcome = await work; expect(outcome.status === 'failed' || outcome.status === 'denied').toBe(true); noProviderContent(outcome);
    expect(journal()).toHaveLength(1); expect(journal()[0]!.reserved_atoms).toBe('250000'); expect(journal()[0]!.settled_atoms).not.toBe('0'); expect(calls).toHaveLength(1);
  });
  it('cannot resurrect deleted content after provider ignores abort and returns validated success late', async () => {
    providerIgnoresAbort = true; const paused = pauseNetwork(); const work = coordinator.research(fixture.actor, request(await ready(), 'ignored-abort')); await paused.entered;
    await fixture.service.delete(fixture.actor); coordinator.abortBudget({ spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId }); paused.release();
    const outcome = await work; noProviderContent(outcome); expect(outcome.status === 'failed' || outcome.status === 'denied').toBe(true);
    expect(journal()[0]).toMatchObject({ phase: 'uncertain', reserved_atoms: '250000', settled_atoms: null });
  });
  it('abortBudget cancels only matching scope; no paid capacity is released after possible dispatch', async () => {
    const paused = pauseNetwork(); const work = coordinator.research(fixture.actor, request(await ready(), 'abort-current')); await paused.entered;
    coordinator.abortBudget({ spaceId: 'other-space', budgetId: fixture.actor.budgetId }); expect(calls[0]!.signal?.aborted).toBe(false);
    coordinator.abortBudget({ spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId }); expect(calls[0]!.signal?.aborted).toBe(true); paused.release();
    expect(await work).toMatchObject({ status: 'failed', billing: 'uncertain' }); expect(journal()[0]!.settled_atoms).toBeNull(); noProviderContent(await coordinator.cached(fixture.actor, query));
  });
  it.each(['outage', 'malformed', 'http', 'credential-in-source'] as const)('returns bounded safe %s failure, preserves uncertain charge, never retries, and leaves local Review available', async (failure) => {
    if (failure === 'outage') response = async () => { throw new Error(`https://api.valueserp.com/search?api_key=${CONFIG.apiKey}&q=${query.merchant}`); };
    else if (failure === 'malformed') response = async () => new Response('{', { status: 200 });
    else if (failure === 'http') response = async () => new Response('secret upstream detail', { status: 503 });
    else response = async () => Response.json({ request_info: { success: true }, organic_results: [{ link: `https://merchant.example/?api_key=${CONFIG.apiKey}`, title: 'Retailer', snippet: 'Private credential' }] });
    const outcome = await research(`failure-${failure}`); expect(outcome).toMatchObject({ status: 'failed', billing: 'uncertain' }); expect(calls).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain(CONFIG.apiKey); expect(JSON.stringify(outcome)).not.toContain(query.merchant); expect(JSON.stringify(outcome)).not.toContain('api.valueserp.com/search');
    expect(journal()[0]).toMatchObject({ phase: 'uncertain', reserved_atoms: '250000', settled_atoms: null }); noProviderContent(outcome);
    expect((await fixture.service.analyze(fixture.actor)).localReview.uncategorizedCount).toBe(1);
  });
  it('releases exact reserved money only when the real provider evidences no request was dispatched', async () => {
    providerStartsAborted = true;
    expect(await research('known-not-dispatched')).toMatchObject({ status: 'failed', billing: 'not_dispatched' });
    expect(calls).toHaveLength(0); expect(journal()[0]).toMatchObject({ phase: 'known_failed', reserved_atoms: '250000', settled_atoms: '0' });
    providerStartsAborted = false; advance(1);
    expect((await research('explicit-fresh-after-zero-charge')).status).toBe('succeeded'); expect(calls).toHaveLength(1);
  });
  it('rollback restore retains ambiguous billing and cannot opt back into external dispatch', async () => {
    response = async () => { throw new Error('offline synthetic outage'); }; expect((await research('pre-backup-charge')).status).toBe('failed');
    const backupPath = join(dirname(fixture.databasePath), 'merchant-backup.sqlite');
    const checkpoint = new Database(fixture.databasePath, { readonly: false });
    try { checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); } finally { checkpoint.close(); }
    copyFileSync(fixture.databasePath, backupPath);
    const destinationPath = join(dirname(fixture.databasePath), 'restored.sqlite');
    const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath, now: fixture.clock(), authorize: () => governance(fixture.actor,
      [{ resourceKind: 'space', resourceId: fixture.actor.spaceId, capability: 'space:manage', version: null }], [{ operation: 'restore', resourceKind: 'space', resourceId: fixture.actor.spaceId }], 'restore') });
    peers.push(restored);
    const access = { ...policyAccess(sourceScope, restored), expectedGeneration: restored.merchant.generation(sourceScope) };
    expect(restored.merchant.acknowledgeRestore(access)).toBe(true);
    const existing = restored.merchant.policy(access)!;
    expect(restored.merchant.setPolicy({ ...access, expectedVersion: existing.version, value: POLICY })).not.toBeNull();
    const denied = restored.merchant.reserveAttempt({ ...policyAccess(sourceScope, restored), idempotencyKey: 'restored-capacity', key: quotaKey(), sourceRefs: emptyRefs(), policyVersion: existing.version + 1,
      tariff: CONFIG.tariff, buckets: quotaBuckets() });
    expect(denied).toMatchObject({ status: 'denied', reason: 'restore_billing_hold' }); expect(calls).toHaveLength(1);
  });
});

function emptyRefs(): MerchantEvidence['sourceRefs'] { return { accountIds: [], categoryIds: [], transactionIds: [], ruleIds: [], factsHash: 'e'.repeat(64), required: [] }; }
function quotaKey(): MerchantCacheKey { return { scope: sourceScope, queryFingerprint: 'b'.repeat(64), locale: null, providerId: 'valueserp', providerVersion: 'valueserp-search/1', parametersHash: 'c'.repeat(64), normalizationVersion: 'merchant/2', egressPolicyVersion: 'egress/1', visibilityHash: 'a'.repeat(64) }; }
function quotaBuckets(): MerchantQuotaBucket[] { return [
  { kind: 'installation', id: CONFIG.installationId, ...CONFIG.credentialLimits }, { kind: 'space', id: sourceScope.spaceId, ...CONFIG.credentialLimits },
  { kind: 'budget', id: `${sourceScope.spaceId}/${sourceScope.budgetId}`, ...CONFIG.credentialLimits }, { kind: 'credential', id: CONFIG.credentialId, ...CONFIG.credentialLimits },
]; }

describe('reservation windows cannot admit delayed work into an uncapped day or month', () => {
  it.each(['2026-10-04T23:59:59.900Z', '2026-10-31T23:59:59.900Z'])('refuses dispatch after reservation at %s crosses UTC boundary within its live lease', (reservedAt) => {
    setTime(reservedAt); const policy = fixture.store.merchant.policy(policyAccess(sourceScope))!;
    const admission = fixture.store.merchant.reserveAttempt({ ...policyAccess(sourceScope), idempotencyKey: 'window-boundary', key: quotaKey(), sourceRefs: emptyRefs(), policyVersion: policy.version, tariff: CONFIG.tariff, buckets: quotaBuckets() });
    expect(admission.status).toBe('admitted'); if (admission.status !== 'admitted') throw new Error('Expected real atomic quota reservation');
    const claimed = fixture.store.merchant.claimAttempt({ ...policyAccess(sourceScope), id: admission.attempt.id }); expect(claimed?.claimToken).toEqual(expect.any(String));
    advance(0.2);
    expect(fixture.store.merchant.dispatchAttempt({ ...policyAccess(sourceScope), id: admission.attempt.id, claimToken: claimed!.claimToken! })).toBe(false);
    expect(journal()[0]).toMatchObject({ phase: 'reserved', day_window: reservedAt.slice(0, 10), month_window: reservedAt.slice(0, 7) }); expect(calls).toHaveLength(0);
  });

  it.each(['2026-10-04T23:59:59.900Z', '2026-10-31T23:59:59.900Z'])('refuses provider invocation when the marked capture at %s returns across its UTC accounting window', async (reservedAt) => {
    setTime(reservedAt);
    configuration = { ...CONFIG, credentialLimits: { maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 1 },
      tariff: { ...CONFIG.tariff, costAtoms: '1000000' } };
    const current = await fixture.service.analyze(fixture.actor);
    const selected = current.suggestions.find((candidate) => candidate.transactionId === candidateId)!;
    const boundaryQuery = { ...query, evidenceKey: selected.evidenceKey, evidenceRevision: selected.evidenceRevision };
    const input = request(await ready(boundaryQuery), 'marked-window-boundary', boundaryQuery);
    afterCaptureReturn = () => {
      expect(journal()).toMatchObject([{ phase: 'dispatched', day_window: reservedAt.slice(0, 10), month_window: reservedAt.slice(0, 7) }]);
      expect(captureDepth).toBe(0); expect(calls).toHaveLength(0);
      advance(0.2);
    };
    const outcome = await coordinator.research(fixture.actor, input);
    expect(outcome).toMatchObject({ status: 'failed', billing: 'not_dispatched' });
    expect(calls).toHaveLength(0); noProviderContent(outcome);
    expect(journal()).toMatchObject([{ phase: 'known_failed', settled_atoms: '0', claim_token: null,
      day_window: reservedAt.slice(0, 10), month_window: reservedAt.slice(0, 7) }]);
    advance(31);
    const replay = await coordinator.research(fixture.actor, input);
    expect(replay).toMatchObject({ billing: 'not_dispatched' });
    expect(replay.status === 'failed' || replay.status === 'denied').toBe(true);
    expect(calls).toHaveLength(0); noProviderContent(replay);
    const refreshed = await fixture.service.analyze(fixture.actor);
    const freshTarget = refreshed.suggestions.find((candidate) => candidate.transactionId === candidateId)!;
    expect((await research('explicit-new-window', { ...boundaryQuery, evidenceKey: freshTarget.evidenceKey,
      evidenceRevision: freshTarget.evidenceRevision, merchant: 'Another Public Market' })).status).toBe('succeeded');
    expect(calls).toHaveLength(1); expect(journal()).toHaveLength(2);
    expect(journal()[0]).toMatchObject({ phase: 'known_failed', settled_atoms: '0' });
    expect(journal()[1]).toMatchObject({ phase: 'succeeded', day_window: fixture.clock().slice(0, 10), month_window: fixture.clock().slice(0, 7), settled_atoms: '1000000' });
  });
});
