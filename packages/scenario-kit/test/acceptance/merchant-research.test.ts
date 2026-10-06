import { describe, expect, it, vi } from 'vitest';
import type { MerchantAnalysisView, MerchantPolicyView, MerchantResearchOutcome, MerchantResearchPolicyView, MerchantResearchPreview, MerchantResearchQuery } from '@balanceframe/application';
import type { LoadedScenario } from '../../src/loader.js';
import type { DemoServer } from '../../src/demo-server.js';
import { startDemoServer, stopDemoServer } from '../../src/demo-server.js';
import { controlScenarioResearch, readScenarioManifest, writeScenarioManifest } from '../../src/scenario-manifest.js';
import { scenarioRequest, withScenario } from './support.js';
import { advanceResearchClock, cacheRows, cachedResearch, fixturePolicy, fixtureSource, journal, localTarget, noPrivateValues, prepareResearch, previewResearch, recordResearchDemoVerification, resultOf, sendResearch, setResearchGrant, syncLocal, telemetry, testTimeout, waitHeld } from './merchant-research-support.js';
import type { Envelope } from './merchant-research-support.js';

async function settled(handle: LoadedScenario, calls: number): Promise<void> {
  await vi.waitFor(() => expect(telemetry(handle)).toMatchObject({ calls, held: 0 }), { timeout: 15_000, interval: 50 });
}
async function replacePolicy(handle: LoadedScenario, layer: 'space' | 'budget', value: MerchantPolicyView['value']): Promise<void> {
  const path = layer === 'space' ? '/api/merchant/space-policy' : '/api/merchant/policy';
  const prior = resultOf(await scenarioRequest<Envelope<MerchantPolicyView>>(handle, path));
  const saved = resultOf(await scenarioRequest<Envelope<MerchantPolicyView>>(handle, path, { method: 'PUT', body: { expectedVersion: prior.version, value } }));
  expect(saved).toMatchObject({ version: prior.version + 1, generation: prior.generation + 1, value });
}
async function deniedNewResearch(handle: LoadedScenario, query: MerchantResearchQuery): Promise<void> {
  const preview = resultOf(await scenarioRequest<Envelope<MerchantResearchPreview>>(handle, '/api/merchant/research/preview', { method: 'POST', body: query }));
  expect(preview.status).toBe('denied');
  expect(await cachedResearch(handle, query)).toEqual({ enrichment: null });
}

// Every branch owns a fresh real Actual/Better Auth workspace. No preceding branch supplies its evidence or quota state.
describe('real closed-fixture merchant research success and outage', () => {
  it('merchant-research-success requires exact public-business consent before one attributed real research attempt', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-success', async (handle) => {
      const { query, view } = await prepareResearch(handle);
      const effective = resultOf(await scenarioRequest<Envelope<MerchantResearchPolicyView>>(handle, '/api/merchant/research/policy'));
      expect(effective.installation.value).toEqual(fixturePolicy);
      expect(effective.space.value).toEqual(fixturePolicy);
      expect(effective.budget.value).toEqual(fixturePolicy);
      const preview = await previewResearch(handle, query);
      expect(telemetry(handle)).toMatchObject({ calls: 0, held: 0 });
      expect(journal(handle)).toEqual([]);
      for (const body of [
        { ...query, previewToken: preview.previewToken, consent: false, idempotencyKey: 'no-consent' },
        { ...query, previewToken: 'a'.repeat(64), consent: true, idempotencyKey: 'no-preview' },
        { ...query, merchant: 'Another Public Merchant', previewToken: preview.previewToken, consent: true, idempotencyKey: 'changed-public-text' },
      ]) {
        const result = resultOf(await scenarioRequest<Envelope<MerchantResearchOutcome>>(handle, '/api/merchant/research', { method: 'POST', body }));
        expect(result).toMatchObject({ status: 'denied', billing: 'not_dispatched' });
      }
      expect(telemetry(handle).calls).toBe(0); expect(journal(handle)).toEqual([]);
      const result = resultOf(await scenarioRequest<Envelope<MerchantResearchOutcome>>(handle, '/api/merchant/research', { method: 'POST', body: { ...query, previewToken: preview.previewToken, consent: true, idempotencyKey: 'approved-public-business' } }));
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') throw new Error('Expected real coordinator fixture success');
      expect(result.enrichment).toMatchObject({ key: { scope: view.scope, providerId: 'valueserp', providerVersion: 'scenario-fixture/1' }, sources: [fixtureSource], fieldsSent: ['merchant', 'locale'], confidence: 'uncalibrated', evidenceRevision: query.evidenceRevision });
      expect(Date.parse(result.enrichment.expiresAt) - Date.parse(result.enrichment.retrievedAt)).toBe(3_600_000);
      expect(telemetry(handle)).toMatchObject({ calls: 1, held: 0 });
      expect(journal(handle)).toEqual([{ phase: 'succeeded', reserved_atoms: '250000', settled_atoms: '250000', billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 }]);
      expect(cacheRows(handle)).toHaveLength(1);
      noPrivateValues(handle, result);
    }, { branches: ['research-consent'] });
  });

  it('merchant-research-success reuses the durable cache for a freshly consented identical query without another dispatch or charge', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-success', async (handle) => {
      const { query } = await prepareResearch(handle);
      const first = await sendResearch(handle, query, 'cache-first');
      if (first.status !== 'succeeded') throw new Error('Expected first real fixture result');
      const repeated = await sendResearch(handle, query, 'cache-second');
      expect(repeated).toEqual({ status: 'cached', enrichment: first.enrichment });
      expect(await cachedResearch(handle, query)).toEqual({ enrichment: first.enrichment });
      expect(telemetry(handle)).toMatchObject({ calls: 1, held: 0 });
      expect(journal(handle)).toEqual([{ phase: 'succeeded', reserved_atoms: '250000', settled_atoms: '250000', billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 }]);
      expect(cacheRows(handle)).toHaveLength(1);
      noPrivateValues(handle, repeated);
    }, { branches: ['research-cache'] });
  });

  it('merchant-research-success expires research cache with bounded private time while the real source and same human session remain current', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-success', async (handle) => {
      const prepared = await prepareResearch(handle);
      const session = await scenarioRequest<{ user: { id: string }; session: { id: string } }>(handle, '/api/auth/get-session');
      expect(session.status).toBe(200); expect(session.body.user.id).toBe(handle.initialized.personas.owner!.actorId);
      const first = await sendResearch(handle, prepared.query, 'expiry-first');
      if (first.status !== 'succeeded') throw new Error('Expected actual cache admission');
      controlScenarioResearch(handle.processes, 'research-expire');
      expect(await cachedResearch(handle, prepared.query)).toEqual({ enrichment: null });
      const second = await sendResearch(handle, prepared.query, 'expiry-second');
      expect(second.status).toBe('succeeded');
      if (second.status !== 'succeeded') throw new Error('Expected new actual attempt after cache expiry');
      expect(Date.parse(second.enrichment.retrievedAt) - Date.parse(first.enrichment.retrievedAt)).toBeGreaterThan(3_600_000);
      expect(Date.parse(second.enrichment.expiresAt) - Date.parse(second.enrichment.retrievedAt)).toBe(3_600_000);
      expect(second.enrichment.sources).toEqual([fixtureSource]);
      expect(telemetry(handle)).toMatchObject({ calls: 2, held: 0 });
      expect(journal(handle).map((entry) => [entry.phase, entry.reserved_atoms, entry.settled_atoms])).toEqual([['succeeded', '250000', '250000'], ['succeeded', '250000', '250000']]);
      const currentSession = await scenarioRequest<{ user: { id: string }; session: { id: string } }>(handle, '/api/auth/get-session');
      expect(currentSession.status).toBe(200);
      expect(currentSession.body.user.id === session.body.user.id).toBe(true);
      expect(currentSession.body.session.id === session.body.session.id).toBe(true);
      const current = await localTarget(handle);
      expect(current.view.asOfDate).toBe(prepared.view.asOfDate);
      expect(current.target.sourceTransaction).toEqual(prepared.target.sourceTransaction);
      const policy = resultOf(await scenarioRequest<Envelope<MerchantPolicyView>>(handle, '/api/merchant/space-policy', { freshProof: true }));
      expect(policy.value).toEqual(fixturePolicy);
      expect(telemetry(handle).calls).toBe(2);
      noPrivateValues(handle, second);
    }, { branches: ['research-expiry'] });
  });

  it('merchant-research-outage settles a closed fixture outage as uncertain without breaking native Sync or Review', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-outage', async (handle) => {
      const { query } = await prepareResearch(handle);
      const result = await sendResearch(handle, query, 'fixture-outage');
      expect(result).toEqual({ status: 'failed', code: 'unavailable', billing: 'uncertain' });
      expect(await cachedResearch(handle, query)).toEqual({ enrichment: null });
      expect(cacheRows(handle)).toEqual([]);
      expect(journal(handle)).toEqual([{ phase: 'uncertain', reserved_atoms: '250000', settled_atoms: null, billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 }]);
      await syncLocal(handle); await localTarget(handle);
      expect(telemetry(handle)).toMatchObject({ calls: 1, held: 0 });
      noPrivateValues(handle, result);
    }, { branches: ['research-outage'] });
  });
});

describe('independent real merchant research lifecycle branches', () => {
  it.each(['installation', 'space', 'budget'] as const)('merchant-research-lifecycle withholds held results and new dispatch after %s fixture authority becomes local-only', { timeout: testTimeout }, async (layer) => {
    await withScenario('merchant-research-lifecycle', async (handle) => {
      const { query } = await prepareResearch(handle);
      const manifest = readScenarioManifest(handle.processes);
      const pending = sendResearch(handle, query, `held-policy-${layer}`);
      let outcome: MerchantResearchOutcome | undefined;
      try {
        await waitHeld(handle);
        if (layer === 'installation') {
          const { research, ...disabled } = manifest;
          expect(research?.provider).toBe('fixture');
          // Fixture installation authority off, not a production administrator UI or paid-provider policy.
          writeScenarioManifest(handle.processes, disabled);
        } else await replacePolicy(handle, layer, { ...fixturePolicy, mode: 'local-only' });
        const effective = resultOf(await scenarioRequest<Envelope<MerchantResearchPolicyView>>(handle, '/api/merchant/research/policy'));
        expect(effective.resolved.mode).toBe('local-only');
        expect(layer === 'installation' ? effective.installation.value.mode : effective[layer].value.mode).toBe('local-only');
        await deniedNewResearch(handle, query);
        if (layer !== 'installation') controlScenarioResearch(handle.processes, 'research-release');
        outcome = await pending;
        expect(outcome.status === 'failed' || outcome.status === 'denied').toBe(true);
        expect(JSON.stringify(outcome).includes(fixtureSource.snippet)).toBe(false);
        expect(cacheRows(handle)).toEqual([]);
        expect(outcome).toMatchObject({ billing: 'uncertain' });
        expect(journal(handle)).toMatchObject([{ reserved_atoms: '250000', settled_atoms: null }]);
        noPrivateValues(handle, outcome);
      } finally {
        if (layer !== 'installation') controlScenarioResearch(handle.processes, 'research-release');
        await Promise.allSettled([pending]);
        // Keep installation authority off until the actual held outcome has settled.
        if (layer === 'installation') writeScenarioManifest(handle.processes, manifest);
      }
      await settled(handle, 1);
      expect(await cachedResearch(handle, query)).toEqual({ enrichment: null });
      await syncLocal(handle); await localTarget(handle);
    }, { branches: ['research-policy-revocation', `research-policy-revocation-${layer}`] });
  });

  it('merchant-research-lifecycle removes only the current exact research evidence grant and denies held publication, cache and future research', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-lifecycle', async (handle) => {
      const { query } = await prepareResearch(handle);
      controlScenarioResearch(handle.processes, 'research-release');
      const cached = await sendResearch(handle, query, 'before-grant-revocation');
      if (cached.status !== 'succeeded') throw new Error('Expected an actually published observation before revocation');
      expect(await cachedResearch(handle, query)).toEqual({ enrichment: cached.enrichment });
      advanceResearchClock(handle);
      controlScenarioResearch(handle.processes, 'research-hold');
      const heldQuery = { ...query, merchant: 'Birch Bakery' };
      const pending = sendResearch(handle, heldQuery, 'held-grant-revoke');
      try {
        await waitHeld(handle, 2);
        await setResearchGrant(handle, 'evidence', query.evidenceKey, 'merchant:research', false);
        await deniedNewResearch(handle, query);
        await deniedNewResearch(handle, heldQuery);
      } finally {
        controlScenarioResearch(handle.processes, 'research-release');
        await Promise.allSettled([pending]);
      }
      const result = await pending;
      expect(result.status === 'failed' || result.status === 'denied').toBe(true);
      expect(JSON.stringify(result).includes(fixtureSource.snippet)).toBe(false);
      expect(cacheRows(handle)).toHaveLength(1);
      expect(journal(handle)).toEqual([
        { phase: 'succeeded', reserved_atoms: '250000', settled_atoms: '250000', billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 },
        expect.objectContaining({ reserved_atoms: '250000', settled_atoms: null, billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 }),
      ]);
      await settled(handle, 2);
      await syncLocal(handle); await localTarget(handle);
      noPrivateValues(handle, result);
    }, { branches: ['research-grant-revocation'] });
  });

  it('merchant-research-lifecycle admits one independent query then denies a second at the actual daily quota before provider invocation', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-lifecycle', async (handle) => {
      const { query } = await prepareResearch(handle);
      controlScenarioResearch(handle.processes, 'research-release');
      await replacePolicy(handle, 'space', { ...fixturePolicy, maxSearchesPerDay: 1 });
      expect(await sendResearch(handle, query, 'daily-first')).toMatchObject({ status: 'succeeded', enrichment: { sources: [fixtureSource] } });
      advanceResearchClock(handle);
      expect(await sendResearch(handle, { ...query, merchant: 'Birch Bakery' }, 'daily-second')).toEqual({ status: 'denied', code: 'daily_cap', billing: 'not_dispatched' });
      expect(telemetry(handle)).toMatchObject({ calls: 1, held: 0 });
      expect(journal(handle)).toEqual([{ phase: 'succeeded', reserved_atoms: '250000', settled_atoms: '250000', billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 }]);
    }, { branches: ['research-daily-limit'] });
  });

  it('merchant-research-lifecycle charges exactly four quarter-minor fixture requests against one minor unit then denies the fifth before dispatch', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-lifecycle', async (handle) => {
      const { query } = await prepareResearch(handle);
      controlScenarioResearch(handle.processes, 'research-release');
      await replacePolicy(handle, 'space', { ...fixturePolicy, maxSpendMinorUnitsPerMonth: 1 });
      const names = ['Aster Atelier', 'Birch Bakery', 'Cedar Books', 'Dapple Grove'];
      for (const [index, merchant] of names.entries()) {
        if (index > 0) advanceResearchClock(handle);
        expect(await sendResearch(handle, { ...query, merchant }, `monthly-${index}`)).toMatchObject({ status: 'succeeded', enrichment: { sources: [fixtureSource] } });
      }
      advanceResearchClock(handle);
      expect(await sendResearch(handle, { ...query, merchant: 'Elm Outfitters' }, 'monthly-fifth')).toEqual({ status: 'denied', code: 'monthly_cap', billing: 'not_dispatched' });
      expect(telemetry(handle)).toMatchObject({ calls: 4, held: 0 });
      expect(journal(handle)).toEqual(names.map(() => ({ phase: 'succeeded', reserved_atoms: '250000', settled_atoms: '250000', billing_currency: 'USD', tariff_version: 'scenario-fixture/1', content_deleted: 0 })));
    }, { branches: ['research-monthly-limit'] });
  });

  it('merchant-research-lifecycle purges real merchant data under fresh normal owner proof before a protected non-draining release can publish its held result', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-lifecycle', async (handle) => {
      const { query } = await prepareResearch(handle);
      const policy = resultOf(await scenarioRequest<Envelope<MerchantPolicyView>>(handle, '/api/merchant/policy'));
      const pending = sendResearch(handle, query, 'held-delete');
      try {
        await waitHeld(handle);
        const deleted = resultOf(await scenarioRequest<Envelope<{ generation: number }>>(handle, '/api/merchant', { method: 'DELETE' }));
        expect(deleted).toEqual({ generation: policy.generation + 1 });
        expect(cacheRows(handle)).toEqual([]);
      } finally {
        controlScenarioResearch(handle.processes, 'research-release');
        await Promise.allSettled([pending]);
      }
      const result = await pending;
      expect(result.status === 'failed' || result.status === 'denied').toBe(true);
      expect(JSON.stringify(result).includes(fixtureSource.snippet)).toBe(false);
      expect(await cachedResearch(handle, query)).toEqual({ enrichment: null });
      expect(cacheRows(handle)).toEqual([]);
      expect(journal(handle)).toMatchObject([{ phase: 'uncertain', reserved_atoms: '250000', settled_atoms: null, content_deleted: 1 }]);
      await settled(handle, 1);
      await syncLocal(handle); await localTarget(handle);
      noPrivateValues(handle, result);
    }, { branches: ['research-delete-fence'] });
  });

  it('merchant-research-lifecycle keeps the original real human session eligible for fresh policy and delete controls after bounded research time advances', { timeout: testTimeout }, async () => {
    await withScenario('merchant-research-lifecycle', async (handle) => {
      const prepared = await prepareResearch(handle);
      const before = await scenarioRequest<{ user: { id: string }; session: { id: string } }>(handle, '/api/auth/get-session');
      expect(before.status).toBe(200);
      expect(before.body.user.id).toBe(handle.initialized.personas.owner!.actorId);
      controlScenarioResearch(handle.processes, 'research-release');
      expect((await sendResearch(handle, prepared.query, 'clock-controls')).status).toBe('succeeded');
      controlScenarioResearch(handle.processes, 'research-expire');
      expect(await cachedResearch(handle, prepared.query)).toEqual({ enrichment: null });
      const current = await localTarget(handle);
      expect(current.view.asOfDate).toBe(prepared.view.asOfDate);
      expect(current.target.sourceTransaction).toEqual(prepared.target.sourceTransaction);
      await replacePolicy(handle, 'space', { ...fixturePolicy, mode: 'local-only' });
      await replacePolicy(handle, 'budget', { ...fixturePolicy, mode: 'local-only' });
      const policy = resultOf(await scenarioRequest<Envelope<MerchantPolicyView>>(handle, '/api/merchant/policy'));
      const deleted = resultOf(await scenarioRequest<Envelope<{ generation: number }>>(handle, '/api/merchant', { method: 'DELETE' }));
      expect(deleted).toEqual({ generation: policy.generation + 1 });
      const after = await scenarioRequest<{ user: { id: string }; session: { id: string } }>(handle, '/api/auth/get-session');
      expect(after.status).toBe(200);
      expect(after.body.user.id === before.body.user.id).toBe(true);
      expect(after.body.session.id === before.body.session.id).toBe(true);
      expect(telemetry(handle)).toMatchObject({ calls: 1, held: 0 });
      expect(cacheRows(handle)).toEqual([]);
      await syncLocal(handle); await localTarget(handle);
    }, { branches: ['research-clock-controls'] });
  });
});

interface DemoState { status: 'loading' | 'ready' | 'failed'; scenarioId: string; generation: number; anchor: string | null; csrfToken: string | null; personaId: string | null }
function cookies(response: Response): string { return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; '); }
async function demoState(demo: DemoServer, cookie: string): Promise<DemoState> {
  const response = await fetch(`${demo.url}/__demo/state`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200); return response.json() as Promise<DemoState>;
}
async function demoControl(demo: DemoServer, path: string, cookie: string, state: DemoState, extra: Record<string, unknown> = {}, timeout = 90_000): Promise<Response> {
  return fetch(`${demo.url}${path}`, { method: 'POST', headers: { cookie, origin: demo.url, 'content-type': 'application/json', 'x-balanceframe-demo-csrf': state.csrfToken! }, body: JSON.stringify({ expectedGeneration: state.generation, ...extra }), signal: AbortSignal.timeout(timeout) });
}
async function demoApi(demo: DemoServer, path: string, cookie: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${demo.url}${path}`, { method, headers: { cookie, origin: demo.url, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
}

it('merchant-research-lifecycle cancels the held real shared generation before reset drain and rejects its old control, cookie and source namespace', { timeout: testTimeout }, async () => {
  const demo = await startDemoServer({ scenarioId: 'merchant-research-lifecycle', port: 0 });
  let first: Promise<Response> | undefined;
  let duplicate: Promise<Response> | undefined;
  try {
    const entry = await fetch(`${demo.url}/demo`); expect(entry.status).toBe(200);
    const oldCookie = cookies(entry);
    const state = await demoState(demo, oldCookie);
    expect(state).toMatchObject({ status: 'ready', scenarioId: 'merchant-research-lifecycle', personaId: 'owner' });
    if (!state.anchor) throw new Error('Real shared generation must expose its nonsecret scenario anchor');
    const sync = await demoApi(demo, '/api/review/sync', oldCookie, 'POST', {});
    expect(sync.status).toBe(200); expect(await sync.json()).toMatchObject({ result: { synchronized: true, failed: 0 } });
    const analyzed = await demoApi(demo, '/api/merchant', oldCookie);
    expect(analyzed.status).toBe(200);
    const oldView = resultOf({ status: analyzed.status, body: await analyzed.json() as Envelope<MerchantAnalysisView> });
    const candidates = oldView.suggestions.filter((row) => row.sourceTransaction.importedPayee.value === 'aster atelier' && row.sourceTransaction.amount.minorUnits === '-34607');
    expect(candidates).toHaveLength(1);
    const target = candidates[0]!;
    expect(target).toMatchObject({ tier: 'inferred', supportCount: 3 });
    expect(oldView.categories.find((category) => category.id === target.categoryId)?.name).toBe('Groceries');
    const query = { evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision, merchant: 'Aster Atelier', locale: null, publicBusiness: true };
    const preview = await demoApi(demo, '/api/merchant/research/preview', oldCookie, 'POST', query);
    expect(preview.status).toBe(200);
    const ready = resultOf({ status: preview.status, body: await preview.json() as Envelope<MerchantResearchPreview> });
    expect(ready).toMatchObject({ status: 'ready', providerVersion: 'scenario-fixture/1', fieldsSent: ['merchant', 'locale'], maxCostAtoms: '250000', billingCurrency: 'USD' });
    if (ready.status !== 'ready') throw new Error('Expected shared real fixture preview');
    const request = { ...query, previewToken: ready.previewToken, consent: true, idempotencyKey: 'held-real-reset' };
    first = demoApi(demo, '/api/merchant/research', oldCookie, 'POST', request);
    duplicate = demoApi(demo, '/api/merchant/research', oldCookie, 'POST', request);
    const pending = await Promise.race([first, duplicate]);
    expect(pending.status).toBe(200);
    expect(await pending.clone().json()).toMatchObject({ result: { status: 'pending' } });
    const reset = await demoControl(demo, '/__demo/reset', oldCookie, state);
    expect(reset.status).toBe(200);
    const responses = await Promise.all([first, duplicate]);
    const oldResult = responses.find((response) => response !== pending)!;
    const late = await oldResult.json() as unknown;
    expect(late).toMatchObject({ result: { status: 'failed', code: 'cancelled', billing: 'uncertain' } });
    expect(JSON.stringify(late).includes(fixtureSource.snippet)).toBe(false);
    expect(oldResult.headers.get('set-cookie')).toBeNull();
    const freshCookie = cookies(reset);
    const fresh = await demoState(demo, freshCookie);
    expect(fresh).toMatchObject({ status: 'ready', scenarioId: 'merchant-research-lifecycle', generation: state.generation + 1, personaId: 'owner' });
    const stale = await demoControl(demo, '/__demo/event', oldCookie, state, { eventId: 'research-release' }, 5_000);
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'DEMO_STALE_GENERATION' } });
    expect(stale.headers.get('set-cookie')).toBeNull();
    const oldRead = await demoApi(demo, '/api/merchant', oldCookie);
    expect(oldRead.ok).toBe(false);
    const rejected = await oldRead.json() as unknown;
    expect(rejected).toHaveProperty('error');
    expect(JSON.stringify(rejected)).not.toContain(fixtureSource.snippet);
    expect(JSON.stringify(rejected)).not.toContain(target.transactionId);
    const currentAnalysis = await demoApi(demo, '/api/merchant', freshCookie);
    const freshView = resultOf({ status: currentAnalysis.status, body: await currentAnalysis.json() as Envelope<MerchantAnalysisView> });
    expect(freshView.scope.spaceId === oldView.scope.spaceId).toBe(false);
    expect(freshView.scope.budgetId === oldView.scope.budgetId).toBe(false);
    expect(freshView.suggestions.some((row) => row.transactionId === target.transactionId)).toBe(false);
    const freshCandidates = freshView.suggestions.filter((row) => row.sourceTransaction.importedPayee.value === 'aster atelier' && row.sourceTransaction.amount.minorUnits === '-34607');
    expect(freshCandidates).toHaveLength(1);
    const freshTarget = freshCandidates[0]!;
    expect(freshTarget).toMatchObject({ tier: 'inferred', supportCount: 3 });
    expect(freshView.categories.find((category) => category.id === freshTarget.categoryId)?.name).toBe('Groceries');
    const freshCache = await demoApi(demo, '/api/merchant/research/cache', freshCookie, 'POST', { ...query, evidenceKey: freshTarget.evidenceKey, evidenceRevision: freshTarget.evidenceRevision });
    expect(freshCache.status).toBe(200); expect(await freshCache.json()).toMatchObject({ result: { enrichment: null } });
    const staleCache = await demoApi(demo, '/api/merchant/research/cache', freshCookie, 'POST', query);
    expect(staleCache.status).toBe(200); expect(await staleCache.json()).toMatchObject({ result: { enrichment: null } });
    const stalePreview = await demoApi(demo, '/api/merchant/research/preview', freshCookie, 'POST', query);
    expect(stalePreview.status).toBe(200); expect(await stalePreview.json()).toMatchObject({ result: { status: 'denied' } });
    expect((await demoState(demo, freshCookie)).generation).toBe(fresh.generation);
    recordResearchDemoVerification(state.scenarioId, state.anchor, ['held-reset']);
  } finally {
    await Promise.allSettled([first, duplicate].filter((request): request is Promise<Response> => request !== undefined));
    await stopDemoServer(demo);
  }
});
