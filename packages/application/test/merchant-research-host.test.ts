import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValueSerpProvider } from '@balanceframe/inference';
import { MerchantIntelligenceService } from '../src/merchant-service.js';
import type { MerchantResearchConfiguration, MerchantResearchPreview, MerchantResearchQuery } from '../src/merchant-research.js';
import type { MerchantResearchSettings } from '../src/merchant-settings.js';
import { merchantFixture, native, now, accountId, candidateId, payeeId, humanAuth, type MerchantFixture } from './merchant-service.fixture.js';

const policy = { mode: 'external-allowed' as const, allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 24 };
const configuration: MerchantResearchConfiguration = { installationId: 'host-installation', installationVersion: 'installation/1', installationPolicy: policy, credentialId: 'host-credential', credentialVersion: 'credential/1', credentialLimits: { maxSearchesPerDay: 30, maxSpendMinorUnitsPerMonth: 200 }, tariff: { version: 'confirmed-test-tariff/1', billingCurrency: 'USD', costAtoms: '250000' }, apiKey: 'test-only-host-key' };
let fixture: MerchantFixture;
let service: MerchantIntelligenceService;
let settings: MerchantResearchSettings;
let query: MerchantResearchQuery;
let response: () => Promise<Response>;
let egress: Array<URL>;
let researchTime: string;
const success = () => Response.json({ request_info: { success: true }, organic_results: [{ link: 'https://public.example/about', title: 'Public business', snippet: 'Untrusted historical public result' }] });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  fixture = await merchantFixture(); settings = { installation: { version: configuration.installationVersion, value: policy }, configuration: structuredClone(configuration) };
  egress = []; response = async () => success(); researchTime = now;
  const research = { settings: () => settings, clock: () => new Date(researchTime),
    providerFor: (config: MerchantResearchConfiguration) => new ValueSerpProvider({ apiKey: config.apiKey, now: () => new Date(researchTime), fetchFn: async (input) => { egress.push(new URL(String(input))); return response(); } }) };
  service = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native, clock: () => new Date(fixture.clock()), research });
  fixture.grant('budget', fixture.actor.budgetId, 'merchant:research'); fixture.grant('account', accountId, 'merchant:research'); fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'merchant:research');
  const view = await service.analyze(fixture.actor); const target = view.suggestions.find((row) => row.transactionId === candidateId)!;
  query = { evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision, merchant: 'Explicit Public Business', locale: null, publicBusiness: true };
});
afterEach(async () => { await fixture.cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function enable(): Promise<void> {
  const space = await service.spacePolicy(fixture.actor); await service.setSpacePolicy(fixture.actor, { expectedVersion: space.version, value: policy });
  const budget = await service.policy(fixture.actor); await service.setPolicy(fixture.actor, { expectedVersion: budget.version, value: policy });
  const target = (await service.analyze(fixture.actor)).suggestions.find((row) => row.transactionId === candidateId)!;
  query = { ...query, evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision };
}
async function preview(): Promise<Extract<MerchantResearchPreview, { status: 'ready' }>> {
  const value = await service.previewResearch(fixture.actor, query); expect(value.status).toBe('ready');
  if (value.status !== 'ready') throw new Error('Expected actual authorized preview'); return value;
}
const send = (token: string) => service.research(fixture.actor, { ...query, previewToken: token, consent: true, idempotencyKey: 'host-request' });
describe('real merchant research application host', () => {
  it('keeps independent missing space opt-in local-only rather than inheriting budget permission', async () => {
    const budget = await service.policy(fixture.actor); await service.setPolicy(fixture.actor, { expectedVersion: budget.version, value: policy });
    const view = await service.researchPolicy(fixture.actor);
    expect(view.space.version).toBe(0); expect(view.budget.version).toBe(1); expect(view.resolved.mode).toBe('local-only');
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied'); expect(egress).toEqual([]);
  });
  it('separately persists complete optimistic space and budget policies and forbids space calendars', async () => {
    const original = await service.policy(fixture.actor); const space = await service.spacePolicy(fixture.actor);
    const saved = await service.setSpacePolicy(fixture.actor, { expectedVersion: space.version, value: policy });
    expect(saved.scope.connectionId).toBe('merchant:space-policy'); expect(saved.version).toBe(1);
    expect(await service.policy(fixture.actor)).toEqual(original);
    await expect(service.setSpacePolicy(fixture.actor, { expectedVersion: 0, value: policy })).rejects.toThrow();
    await expect(service.setSpacePolicy(fixture.actor, { expectedVersion: 1, value: { ...policy, calendar: { budget: null, accounts: [] } } })).rejects.toThrow();
    expect((await service.spacePolicy(fixture.actor)).version).toBe(1);
  });
  it('requires fresh human space policy authority independently of research permission', async () => {
    fixture.actor.auth = { method: 'session', actorId: fixture.actor.actorId, sessionId: 'ordinary-session' };
    await expect(service.setSpacePolicy(fixture.actor, { expectedVersion: 0, value: policy })).rejects.toThrow();
    fixture.actor.auth = humanAuth(fixture.actor.actorId); fixture.grant('space', fixture.actor.spaceId, 'policy:manage', false);
    await expect(service.setSpacePolicy(fixture.actor, { expectedVersion: 0, value: policy })).rejects.toThrow(); expect(egress).toEqual([]);
  });
  it('missing provider configuration preserves local classification and cannot dispatch', async () => {
    settings.configuration = null;
    expect((await service.researchPolicy(fixture.actor)).resolved.mode).toBe('local-only');
    const value = await service.previewResearch(fixture.actor, query); expect(value).toEqual({ status: 'denied', code: 'configuration' });
    expect((await service.analyze(fixture.actor)).localReview.candidates.find((row) => row.transactionId === candidateId)?.proposedCategoryId).toBe('category-food'); expect(egress).toEqual([]);
  });
  it.each(['installation', 'space', 'budget'] as const)('ancestor %s disabled prevents derived suggestions while ordinary Review remains', async (layer) => {
    await enable();
    if (layer === 'installation') settings = { ...settings, installation: { ...settings.installation, value: { ...policy, mode: 'disabled' } }, configuration: { ...configuration, installationPolicy: { ...policy, mode: 'disabled' } } };
    else if (layer === 'space') await service.setSpacePolicy(fixture.actor, { expectedVersion: 1, value: { ...policy, mode: 'disabled' } });
    else await service.setPolicy(fixture.actor, { expectedVersion: 1, value: { ...policy, mode: 'disabled' } });
    const view = await service.analyze(fixture.actor);
    expect(view.suggestions).toEqual([]); expect(view.recurrences).toEqual([]); expect(view.localReview.candidates.find((row) => row.transactionId === candidateId)?.proposedCategoryId).toBeUndefined();
    expect(view.localReview.candidates.some((row) => row.transactionId === candidateId)).toBe(true);
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied'); expect(egress).toEqual([]);
  });
  it.each(['installation', 'space'] as const)('ancestor %s disabled rejects new local suggestion decisions through the API', async (layer) => {
    await enable();
    if (layer === 'installation') settings = { ...settings, installation: { ...settings.installation, value: { ...policy, mode: 'disabled' } } };
    else await service.setSpacePolicy(fixture.actor, { expectedVersion: 1, value: { ...policy, mode: 'disabled' } });
    await expect(service.confirm(fixture.actor, { id: 'disabled-ancestor-alias', kind: 'alias', transactionId: candidateId,
      sourceField: 'importedPayee', targetPayeeId: payeeId, accountId: null, evidenceKey: query.evidenceKey,
      evidenceRevision: query.evidenceRevision, expectedVersion: 0, visibility: 'private' })).rejects.toThrow();
    expect(egress).toEqual([]);
  });
  it.each(['budget', 'account', 'evidence'] as const)('requires exact current %s research authority before provider egress', async (kind) => {
    await enable(); const id = kind === 'budget' ? fixture.actor.budgetId : kind === 'account' ? accountId : query.evidenceKey;
    fixture.grant(kind, id, 'merchant:research', false);
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied'); expect(egress).toEqual([]);
  });
  it('rejects stale target revisions and request authority overrides without provider egress', async () => {
    await enable();
    expect((await service.previewResearch(fixture.actor, { ...query, evidenceRevision: '0'.repeat(64) })).status).toBe('denied');
    expect(await service.previewResearch(fixture.actor, { ...query, actorId: 'forged', providerId: 'other' })).toEqual({ status: 'denied', code: 'invalid_request' }); expect(egress).toEqual([]);
  });
  it('real preview and consent dispatch only explicit public text, then deliver attributed cache without another request', async () => {
    await enable(); const ready = await preview(); expect(ready.merchant).toBe(query.merchant); expect(ready.maxCostAtoms).toBe('250000'); expect(egress).toEqual([]);
    const outcome = await send(ready.previewToken); expect(outcome.status).toBe('succeeded'); expect(egress).toHaveLength(1);
    expect(egress[0]!.searchParams.get('q')).toBe(query.merchant); expect(egress[0]!.searchParams.has('transaction')).toBe(false);
    const cached = await service.cachedResearch(fixture.actor, query); expect(cached.enrichment?.confidence).toBe('uncalibrated'); expect(cached.enrichment?.sources[0]?.url).toBe('https://public.example/about'); expect(egress).toHaveLength(1);
    expect(JSON.stringify(cached)).not.toContain('PRIVATE-NOTE-DO-NOT-PUBLISH'); expect(JSON.stringify(cached)).not.toContain(configuration.apiKey);
  });
  it('expires one-hour research cache without aging the same real human proof or local source clock', async () => {
    await enable();
    const space = await service.spacePolicy(fixture.actor);
    await service.setSpacePolicy(fixture.actor, { expectedVersion: space.version, value: { ...policy, cacheTtlHours: 1 } });
    const proof = fixture.actor.auth;
    const ready = await preview();
    const outcome = await send(ready.previewToken);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('Expected admitted real coordinator result');
    expect(outcome.enrichment.expiresAt).toBe('2026-10-04T13:00:00.000Z');
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: outcome.enrichment });
    researchTime = '2026-10-04T12:59:59.999Z';
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: outcome.enrichment });
    researchTime = '2026-10-04T13:00:00.000Z';
    expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null });
    expect(egress).toHaveLength(1);
    expect(fixture.clock()).toBe(now);
    expect(new Date().toISOString()).toBe(now);
    expect(fixture.actor.auth).toBe(proof);
    const current = await service.policy(fixture.actor);
    expect((await service.setPolicy(fixture.actor, { expectedVersion: current.version, value: { ...policy, mode: 'local-only' } })).version).toBe(current.version + 1);
    expect((await service.delete(fixture.actor)).generation).toBe(current.generation + 2);
    expect(fixture.actor.auth).toBe(proof);
  });
  it('expires exact consent on research time while ordinary controls retain current real-time proof', async () => {
    await enable();
    const proof = fixture.actor.auth;
    const ready = await preview();
    expect(ready.expiresAt).toBe('2026-10-04T12:05:00.000Z');
    researchTime = ready.expiresAt;
    expect(await send(ready.previewToken)).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
    expect(egress).toEqual([]);
    expect(fixture.clock()).toBe(now);
    expect(fixture.actor.auth).toBe(proof);
    const space = await service.spacePolicy(fixture.actor);
    expect((await service.setSpacePolicy(fixture.actor, { expectedVersion: space.version, value: { ...policy, mode: 'local-only' } })).version).toBe(space.version + 1);
  });
  it('does not hold Actual source lock during provider I/O and discards a result after a current research grant is revoked', async () => {
    await enable(); const ready = await preview();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    response = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return success(); };
    const pending = send(ready.previewToken); await started;
    const local = await service.analyze(fixture.actor); expect(local.localReview.candidates.some((row) => row.transactionId === candidateId)).toBe(true);
    fixture.grant('evidence', query.evidenceKey, 'merchant:research', false); release();
    const result = await pending; expect(['denied', 'failed']).toContain(result.status); expect(await service.cachedResearch(fixture.actor, query)).toEqual({ enrichment: null }); expect(egress).toHaveLength(1);
  });
  it('counts the separate potentially billed amount against current delegated financial restrictions', async () => {
    await enable(); fixture.grant('budget', fixture.actor.budgetId, 'merchant:research', true, fixture.actor, { maxGrossOutgoing: [{ minorUnits: '400', currency: 'USD' }] });
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied'); expect(egress).toEqual([]);
  });
  it('recaptures normalized-evidence authority during preview admission, not only the research right', async () => {
    service = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native, clock: () => new Date(fixture.clock()),
      research: { settings: () => settings, providerFor: (config) => {
        fixture.grant('evidence', query.evidenceKey, 'normalized-evidence', false);
        return new ValueSerpProvider({ apiKey: config.apiKey, fetchFn: async () => { egress.push(new URL('https://api.valueserp.com/search')); return success(); } });
      } } });
    await enable();
    expect((await service.previewResearch(fixture.actor, query)).status).toBe('denied');
    expect(egress).toEqual([]);
  });
  it('independent policy and lifecycle controls do not require local analysis authority or SDK reads', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', false);
    const reads = vi.mocked(fixture.client.getTransactions).mock.calls.length;
    const budget = await service.policy(fixture.actor);
    await service.setPolicy(fixture.actor, { expectedVersion: budget.version, value: { ...policy, mode: 'local-only' } });
    const space = await service.spacePolicy(fixture.actor);
    await service.setSpacePolicy(fixture.actor, { expectedVersion: space.version, value: { ...policy, mode: 'local-only' } });
    expect((await service.delete(fixture.actor)).generation).toBe(2);
    expect(vi.mocked(fixture.client.getTransactions).mock.calls.length).toBe(reads);
    expect(egress).toEqual([]);
  });
  it('never manufactures consent from local alias confirmation or sends an expired preview', async () => {
    await enable(); expect((await send('a'.repeat(64))).status).toBe('denied'); const ready = await preview();
    fixture.setClock(new Date(Date.parse(now) + 300001).toISOString()); fixture.actor.auth = humanAuth(fixture.actor.actorId, fixture.clock());
    researchTime = fixture.clock();
    expect((await send(ready.previewToken)).status).toBe('denied'); expect(egress).toEqual([]);
  });
});
