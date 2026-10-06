// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { merchantFixture, canonical, transaction, categoryId, now, humanAuth, accountId, privateAccountId, candidateId, payeeId, type MerchantFixture } from '../../../../packages/application/test/merchant-service.fixture';
import type { MerchantPublicSuggestion } from '@balanceframe/application';
import { ValueSerpProvider } from '../../../../packages/inference/src/providers/valueserp';
import type { MerchantResearchConfiguration } from '../../../../packages/application/src/merchant-research';
import type { ConnectedBudget, ConnectionUseOptions } from '../../../../packages/application/src/connection-manager';
import type { AuditRecord, GenericActionProposal } from '@balanceframe/workflow-store';
import { merchantConnectionId } from '../../../../packages/application/src/merchant-service';
import { merchantPendingReview, persistPendingReviewResult } from '@balanceframe/application';
import { nativeReviewFixture } from './native-review.fixture';

const deps = vi.hoisted(() => ({ store: vi.fn(), manager: vi.fn(), service: vi.fn(), human: vi.fn() }));
vi.mock('h3', async (original) => ({ ...(await original<typeof H3>()), getQuery: (event: { query: unknown }) => event.query, readBody: async (event: { body: unknown }) => event.body }));
vi.mock('@balanceframe/application', async (original) => ({ ...(await original<Record<string, unknown>>()), createDefaultConnectionManager: deps.manager, createMerchantIntelligenceService: deps.service }));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<Record<string, unknown>>()), getWorkflowStore: deps.store,
  requireAuthorization: async (_event: unknown, capability: string, scope: string) => {
    const store = deps.store().store as MerchantFixture['store'];
    const [resourceKind, resourceId] = scope.split(':');
    const actor = store.governance.getCurrentMembership({ actorId: 'holder', spaceId: store.governance.getSpaceForBudget({ budgetId: 'budget-merchant' })!.id, now })!;
    const decision = store.governance.authorize({ actorId: 'holder', spaceId: actor.spaceId, membershipId: actor.id, expectedPolicyVersion: store.governance.getPolicy({ spaceId: actor.spaceId })!.version, phase: 'read', operation: capability, required: [{ resourceKind: resourceKind === 'space' ? 'space' : 'budget', resourceId: resourceId!, capability, visibility: 'resource' }], payload: { operations: [] }, now, auth: humanAuth('holder') });
    return decision.allowed && decision.disposition.kind === 'authorized_without_approval'
      ? { ok: true, info: { actorId: 'holder', capability, allowed: true } }
      : { ok: false, response: { status: 'error', result: null, error: { code: 'FORBIDDEN' } } };
  },
  requireProposalAuthorization: async (event: { context: { auth: { actorId: string } } }, capability: string, scope: string, operation: string) => {
    const store = deps.store().store as MerchantFixture['store'];
    const actorId = event.context.auth.actorId;
    const space = store.governance.getSpaceForBudget({ budgetId: fixture.actor.budgetId })!;
    const membership = store.governance.getCurrentMembership({ actorId, spaceId: space.id, now });
    const [kind, resourceId] = scope.split(':');
    if (!membership || !resourceId || !['space', 'budget', 'category'].includes(kind!))
      return { ok: false, response: { status: 'error', result: null, error: { code: 'FORBIDDEN' } } };
    const decision = store.governance.authorize({
      actorId, spaceId: space.id, membershipId: membership.id,
      expectedPolicyVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
      phase: 'propose', operation, required: [{ resourceKind: kind === 'space' ? 'space' : kind === 'category' ? 'category' : 'budget',
        resourceId, capability, visibility: 'resource' }], payload: { operations: [] }, now, auth: humanAuth(actorId),
    });
    return decision.allowed ? { ok: true, info: { actorId, capability, allowed: true } }
      : { ok: false, response: { status: 'error', result: null, error: { code: 'FORBIDDEN' } } };
  },
}));
vi.mock('../../server/utils/reauthentication', async (original) => ({ ...(await original<Record<string, unknown>>()), getHumanControlAuth: deps.human }));
import analyze from '../../server/api/merchant/index.get';
import confirm from '../../server/api/merchant/confirm.post';
import reject from '../../server/api/merchant/reject.post';
import policy from '../../server/api/merchant/policy.get';
import setPolicy from '../../server/api/merchant/policy.put';
import calendar from '../../server/api/merchant/calendar.get';
import exportData from '../../server/api/merchant/export.get';
import deleteData from '../../server/api/merchant/index.delete';
import researchPreview from '../../server/api/merchant/research/preview.post';
import researchSend from '../../server/api/merchant/research/index.post';
import researchCache from '../../server/api/merchant/research/cache.post';
import researchPolicy from '../../server/api/merchant/research/policy.get';
import spacePolicy from '../../server/api/merchant/space-policy.get';
import setSpacePolicy from '../../server/api/merchant/space-policy.put';
import { projectReviewQueueItem } from '../../server/utils/review-projection';
import reviewList from '../../server/api/review/index.get';
import reviewDetail from '../../server/api/review/[id].get';
import proposeReviewRule from '../../server/api/review/propose-rule.post';
import attentionHome from '../../server/api/home/attention.get';
let fixture: MerchantFixture;
function request(body: unknown = undefined, query: Record<string, string> = {}, origin = 'https://balanceframe.test') {
  return { body, query, node: { req: { headers: { origin, 'x-balanceframe-space': fixture.actor.spaceId } }, res: { statusCode: 200, statusMessage: '', setHeader: vi.fn(), getHeader: vi.fn() } }, context: { auth: { authenticated: true, actorId: 'holder', method: 'session' as const, principalType: 'human' as const, sessionId: 'session:holder', user: { id: 'holder' } } } };
}
function alias(value: MerchantPublicSuggestion) {
  return { id: 'web-alias', kind: 'alias', evidenceKey: value.evidenceKey, evidenceRevision: value.evidenceRevision, expectedVersion: 0, visibility: 'private', transactionId: candidateId, sourceField: 'importedPayee', targetPayeeId: payeeId, accountId };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.test');
  fixture = await merchantFixture({ currency: 'JPY' }); deps.store.mockReturnValue({ store: fixture.store }); deps.manager.mockReturnValue(fixture.manager); deps.service.mockResolvedValue(fixture.service); deps.human.mockResolvedValue(humanAuth('holder'));
});
afterEach(async () => { await fixture.cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('governed merchant endpoints', () => {
  it('returns real native scoped evidence and exact source Money, private no-store', async () => {
    const event = request(undefined, { transactionId: candidateId, limit: '1' });
    const result = await analyze(event);
    expect(result.status).toBe('ok'); expect(result.result?.localReview.totalUncategorizedAmount).toEqual({ minorUnits: '100', currency: 'JPY' });
    expect(result.result?.suggestions[0]?.evidenceKey).toBe(`merchant:transaction:${candidateId}`);
    expect(result.result?.categories).toEqual(canonical.categories.map(({ id, name }) => ({ id, name })));
    expect(event.node.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
  it('projects confirmed and rejected merchant intent in the real native Attention route', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'full-read');
    fixture.admitPatternGrants();
    const pattern = (await fixture.service.analyze(fixture.actor)).recurrences[0]!;
    const intent = { id: 'web-attention-pattern', kind: 'pattern', patternId: pattern.id,
      evidenceKey: pattern.evidenceKey, evidenceRevision: pattern.evidenceRevision,
      expectedVersion: 0, visibility: 'private' };
    expect((await confirm(request(intent))).status).toBe('ok');
    const accepted = await attentionHome(request(undefined, { detailed: 'true', month: '2026-10' }));
    expect(accepted.status).toBe('ok');
    expect(accepted.result!.recurrences).toContainEqual(expect.objectContaining({
      payeeName: pattern.normalizedMerchant, frequency: 'monthly', occurrences: 4,
      amount: { minorUnits: '-100', currency: 'JPY' }, isEstimated: false,
    }));
    const refreshed = (await fixture.service.analyze(fixture.actor)).recurrences[0]!;
    expect((await reject(request({ ...intent, evidenceRevision: refreshed.evidenceRevision,
      expectedVersion: 1 }))).status).toBe('ok');
    const rejected = await attentionHome(request(undefined, { detailed: 'true', month: '2026-10' }));
    expect(rejected.status).toBe('ok');
    expect(rejected.result!.recurrences).toEqual([]);
    expect((await fixture.service.analyze(fixture.actor)).recurrences[0]).toMatchObject({
      decisionState: 'rejected', occurrences: 4,
    });
  });
  it('withholds merchant Attention after analysis authority is revoked during final connection reload', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'full-read');
    fixture.admitPatternGrants();
    let analyzed = false;
    const withAnalysis = fixture.service.withAnalysis.bind(fixture.service);
    vi.spyOn(fixture.service, 'withAnalysis').mockImplementation(async (...args) => {
      const result = await withAnalysis(...args);
      analyzed = true;
      return result;
    });
    const loadConfig = fixture.manager.loadConfig.bind(fixture.manager);
    vi.spyOn(fixture.manager, 'loadConfig').mockImplementation(async () => {
      const config = await loadConfig();
      if (analyzed) fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', false);
      return config;
    });
    const result = await attentionHome(request(undefined, { detailed: 'true', month: '2026-10' }));
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.result).toBeNull();
    expect(JSON.stringify(result)).not.toContain('corner market');
  });
  it.each(['actorId', 'budgetId', 'sourceRefs', 'visibilityHash', 'auth'])('refuses query authority %s before source reads', async (field) => {
    const result = await analyze(request(undefined, { [field]: 'forged' }));
    expect(result.status).toBe('error'); expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('denies missing selected membership and revoked analysis grant before SDK reads', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', false);
    expect((await analyze(request())).status).toBe('error'); expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('returns a no-store safe envelope when the authorization backend fails before service construction', async () => {
    vi.spyOn(fixture.store.governance, 'authorize').mockImplementationOnce(() => { throw new Error('PRIVATE-GOVERNANCE-PATH'); });
    const event = request();
    const result = await analyze(event);
    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(JSON.stringify(result)).not.toContain('PRIVATE-GOVERNANCE-PATH');
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
    expect(event.node.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
  it('confirms and rejects with exact evidence revision and optimistic decision version', async () => {
    const value = (await fixture.service.analyze(fixture.actor)).suggestions[0]!;
    const first = await confirm(request(alias(value))); expect(first.result?.state).toBe('accepted');
    const stale = await reject(request(alias(value))); expect(stale.status).toBe('error');
    const refreshed = (await fixture.service.analyze(fixture.actor)).suggestions[0]!;
    const next = await reject(request({ ...alias(refreshed), expectedVersion: first.result!.version })); expect(next.result?.state).toBe('rejected');
  });
  it('retains verified session lifetime when fresh human proof promotes merchant control auth', async () => {
    const value = (await fixture.service.analyze(fixture.actor)).suggestions[0]!;
    const event = request(alias(value));
    const isCredentialValid = vi.fn(() => true);
    const credentialExpiresAt = '2026-10-04T12:01:00.000Z';
    Object.assign(event.context.auth, { credentialExpiresAt, isCredentialValid });
    const control = vi.spyOn(fixture.service, 'confirm');
    expect((await confirm(event)).status).toBe('ok');
    expect(control).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ method: 'human-session', credentialExpiresAt, isCredentialValid }),
    }), expect.anything());
  });
  it('refuses forged source authority, missing fresh proof and foreign mutation origin', async () => {
    const value = (await fixture.service.analyze(fixture.actor)).suggestions[0]!;
    expect((await confirm(request({ ...alias(value), verifiedHuman: true }))).status).toBe('error');
    deps.human.mockResolvedValue(null); expect((await confirm(request(alias(value)))).status).toBe('error');
    deps.human.mockResolvedValue(humanAuth('holder')); expect((await confirm(request(alias(value), {}, 'https://evil.test'))).status).toBe('error');
  });
  it('writes explicit stored calendar selection and does not accept lookup overrides', async () => {
    const prior = await policy(request()); const value = { ...prior.result!.value, calendar: { budget: { jurisdiction: 'JP', subdivision: null, timeZone: 'Asia/Tokyo' }, accounts: [] } };
    expect((await setPolicy(request({ expectedVersion: 0, value }))).status).toBe('ok');
    const found = await calendar(request(undefined, { accountId, year: '2026' })); expect(found.status).toBe('ok'); expect(found.result?.state).toBe('unknown');
    expect((await calendar(request(undefined, { accountId, year: '2026', jurisdiction: 'US' }))).status).toBe('error');
  });
  it('denies full policy replacement after old hidden account policy grant is revoked', async () => {
    const prior = (await fixture.service.policy(fixture.actor)).value;
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: { ...prior, calendar: { budget: null, accounts: [{ accountId, selection: null }] } } });
    fixture.grant('account', accountId, 'policy', false);
    expect((await setPolicy(request({ expectedVersion: 1, value: prior }))).status).toBe('error');
  });
  it('guards calendar/export/delete independently and purges only after fresh human lifecycle authority', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:export', false); expect((await exportData(request())).status).toBe('error');
    fixture.grant('account', accountId, 'policy', false); expect((await calendar(request(undefined, { accountId, year: '2026' }))).status).toBe('error');
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:delete', false); expect((await deleteData(request())).status).toBe('error');
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:delete'); expect((await deleteData(request())).result).toEqual({ generation: 1 });
  });
  it('never promotes mismatched human proof or a different selected space to control authority', async () => {
    const value = (await fixture.service.analyze(fixture.actor)).suggestions[0]!;
    deps.human.mockResolvedValue(humanAuth('different-person'));
    expect((await confirm(request(alias(value)))).status).toBe('error');
    const event = request();
    event.node.req.headers['x-balanceframe-space'] = 'unavailable-space';
    expect((await analyze(event)).status).toBe('error');
  });
  it('projects fresh authorized canonical merchant evidence with source Money, never an old snapshot amount', async () => {
    const item = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
      await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source,
        { scope: view.scope, authorize });
      const saved = (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId }))[0]!;
      return { ...saved, evidence: { ...saved.evidence, merchantEvidence: { rawText: 'PRIVATE-STALE' } } };
    });
    const catalog = { accounts: [{ id: accountId, name: 'Checking' }], categories: canonical.categories.map((category) => ({ ...category, name: `STALE-CATALOG-${category.id}` })), transactions: [] };
    const projected = await fixture.service.withAnalysis(fixture.actor, { transactionIds: [candidateId] }, (view, source) =>
      projectReviewQueueItem(fixture.store, fixture.actor, item, catalog, view, source));
    expect(projected?.evidence.money).toEqual({ minorUnits: '-100', currency: 'JPY' });
    expect(projected?.evidence.merchantEvidence).toMatchObject({ transactionId: candidateId, tier: 'inferred', supportCount: 3 });
    expect(projected?.evidence.source).toBe('merchant-inferred');
    expect(projected?.evidence.merchantAsOfDate).toBe(now.slice(0, 10));
    expect(projected?.evidence.merchantNormalizationVersion).toBe('merchant/2');
    expect(projected?.evidence.merchantExpiresAt).toBe(projected?.evidence.merchantEvidence?.reviewContext.expiresAt);
    expect(projected?.evidence.history).toEqual([{ categoryId, count: 3, lastClassified: '2026-08-04', firstDate: '2026-06-04', lastDate: '2026-08-04', ledgerCount: 3, correctionCount: 0 }]);
    expect(projected?.evidence.ruleCandidates).toEqual([{ merchant: canonical.payees.find((payee) => payee.id === payeeId)!.name, currentCategory: canonical.categories.find((category) => category.id === categoryId)!.name, matchCount: 3, payeeId, categoryId, supportCount: 3, consistencyNumerator: 3, consistencyDenominator: 3 }]);
    expect(projected?.evidence.suggestedCategory).toBe(canonical.categories.find((category) => category.id === categoryId)!.name);
    expect(projected?.evidence.categoryNames?.[categoryId]).toBe(canonical.categories.find((category) => category.id === categoryId)!.name);
    expect(JSON.stringify(projected)).not.toContain('STALE-CATALOG');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-STALE');
    fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'evidence', false);
    const revoked = await fixture.service.withAnalysis(fixture.actor, { transactionIds: [candidateId] }, (view, source) =>
      projectReviewQueueItem(fixture.store, fixture.actor, item, catalog, view, source));
    expect(revoked?.evidence.merchantEvidence).toBeUndefined();
  });

  it.each(['list', 'detail'] as const)('caps every returned Review DTO Money slot independently of complete admitted source Money for %s', async (route) => {
    fixture.setRows(fixture.rows().map((row) => row.id === candidateId ? row : { ...row, amount: -10 }));
    fixture.grantSources();
    const captured = await fixture.service.withAnalysis(fixture.actor, { transactionIds: [candidateId] }, (view, source) => ({
      suggestion: view.suggestions.find((row) => row.transactionId === candidateId),
      proof: view.localReview.candidates.find((row) => row.transactionId === candidateId)?.merchantProof,
      transaction: source.transactions.find((row) => row.id === candidateId),
      derivation: source.merchantDerivation,
    }));
    if (!captured.suggestion || !captured.proof || !captured.transaction) throw new Error('Canonical merchant Review source unavailable');
    let item = await fixture.store.createReviewItem({
      budgetId: fixture.actor.budgetId, transactionId: candidateId, categoryId, classifier: 'merchant', provenance: 'Local merchant/2',
      sourceTransaction: { id: candidateId, accountId, categoryId: captured.transaction.categoryId, direction: 'outgoing',
        amount: { currency: 'JPY', minorUnits: '100' } },
      evidence: { merchantProof: captured.proof, merchantEvidence: captured.suggestion, merchantDerivation: captured.derivation },
    });
    for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
      item = await fixture.store.transitionInternalReviewItem(item.id, { toStatus, actor: 'trusted-fixture', expectedVersion: item.version });
    // Source: 100 + 10 + 10 + 10. DTO: its 100 Money plus sourceTransaction.amount 100, before recurrence slots.
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor,
      { maxGrossOutgoing: [{ currency: 'JPY', minorUnits: '130' }] });
    expect(await fixture.service.withAnalysis(fixture.actor, { transactionIds: [candidateId] },
      (_view, _source, authorize) => authorize([]))).toBe(true);
    const result = route === 'list'
      ? await reviewList(request())
      : await reviewDetail({ ...request(), context: { ...request().context, params: { id: item.id } } });
    expect(JSON.stringify(result.result)).not.toContain(item.id);
    expect(JSON.stringify(result.result)).not.toContain('"minorUnits":"-100"');
    expect(await fixture.store.getReviewItem(item.id)).toEqual(item);
  });

  it.each(['list', 'detail'] as const)('never combines baseline connection A with merchant connection B for native Review %s', async (route) => {
    const connectionA = 'https://actual.baseline-a.test';
    const connectionB = 'https://actual.merchant-b.test';
    fixture.setConfig(connectionB);
    const sourceTransaction = await fixture.service.withAnalysis(fixture.actor, { transactionIds: [candidateId] }, (_view, source) =>
      source.transactions.find((row) => row.id === candidateId));
    if (!sourceTransaction) throw new Error('Canonical native Review fixture source unavailable');
    const item = await nativeReviewFixture(fixture.store, {
      scope: { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId,
        connectionId: merchantConnectionId({ budgetId: fixture.actor.budgetId, serverUrl: connectionB }) },
      transaction: sourceTransaction, categoryId,
    });
    fixture.setConfig(connectionA);
    const namespaces: string[] = [];
    const withConnection = fixture.manager.withConnection.bind(fixture.manager);
    const capture = vi.spyOn(fixture.manager, 'withConnection').mockImplementation(
      async <T>(operation: (connected: ConnectedBudget) => Promise<T>, options?: ConnectionUseOptions): Promise<T> => {
        const result = await withConnection(async (connected) => {
          namespaces.push(connected.config.serverUrl);
          return operation(connected);
        }, options);
        if (namespaces.length === 1) fixture.setConfig(connectionB);
        return result;
      },
    );
    try {
      if (route === 'list') {
        const result = await reviewList(request());
        expect(result.result?.items.some((row) => row.reviewItem.id === item.id) ?? false).toBe(false);
        expect(result.result?.total ?? 0).toBe(0);
      } else {
        const result = await reviewDetail({ ...request(), context: { ...request().context, params: { id: item.id } } });
        expect(result.result).toBeNull();
      }
      expect(namespaces[0]).toBe(connectionA);
      expect(namespaces.slice(1).every((namespace) => namespace === connectionB)).toBe(true);
      expect(await fixture.store.getReviewItem(item.id)).toEqual(item);
    } finally {
      capture.mockRestore();
    }
  });

  it('projects an independently admitted off-page target without requiring its optional explanation', async () => {
    const targets = Array.from({ length: 211 }, (_, index) =>
      transaction({ id: `web-off-page-${String(index).padStart(3, '0')}` }));
    fixture.setRows([...fixture.rows().filter((row) => row.category !== null), ...targets]);
    fixture.grantSources();
    let item = await fixture.service.withAnalysis(fixture.actor, { limit: 1 }, async (view, source, authorize) => {
      await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source,
        { scope: view.scope, authorize });
      return (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId, limit: 1000 }))
        .find((row) => row.transactionId === targets.at(-1)!.id)!;
    });
    for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
      item = await fixture.store.transitionInternalReviewItem(item.id, { toStatus, actor: 'trusted-fixture', expectedVersion: item.version });
    expect(item.evidence.merchantEvidence).toBeUndefined();
    const catalog = { accounts: [{ id: accountId, name: 'Checking' }], categories: canonical.categories, transactions: [] };
    const projected = await fixture.service.withAnalysis(fixture.actor, { limit: 1 }, (view, source) =>
      projectReviewQueueItem(fixture.store, fixture.actor, item, catalog, view, source));
    expect(projected).toMatchObject({
      actionable: true, reviewItem: { categoryId },
      evidence: { source: 'merchant-inferred', money: { minorUnits: '-100', currency: 'JPY' }, suggestedCategory: 'Food' },
    });
    expect(projected?.evidence.merchantEvidence).toBeUndefined();
    expect(await fixture.store.getReviewItem(item.id)).toEqual(item);
  });

  it.each([
    ['unchanged', 'context-config'],
    ...(['revoke-subject', 'disable-policy'] as const).flatMap((change) =>
      (['context-config', 'helper-review', 'post-commit', 'published-review', 'published-config'] as const)
        .map((stage) => [change, stage] as const)),
    ['revoke-subject', 'cleanup-failure'],
  ] as const)('requires current bound authority for an off-page target with no retained explanation (%s, %s)', async (change, stage) => {
    for (const capability of ['full-read', 'rule:propose', 'rule:view'])
      fixture.grant('budget', fixture.actor.budgetId, capability);
    for (const capability of ['existence', 'name', 'history', 'source'])
      fixture.grant('account', privateAccountId, capability);
    const targets = Array.from({ length: 211 }, (_, index) =>
      transaction({ id: `web-off-page-rule-${String(index).padStart(3, '0')}` }));
    fixture.setRows([...fixture.rows().filter((row) => row.category !== null), ...targets]);
    fixture.grantSources();
    for (const capability of ['rule:propose', 'full-read']) {
      for (const id of [accountId, privateAccountId]) fixture.grant('account', id, capability);
      for (const category of canonical.categories) fixture.grant('category', category.id, capability);
      for (const row of fixture.rows()) fixture.grant('transaction', row.id, capability);
      fixture.grant('evidence', `merchant:transaction:${targets.at(-1)!.id}`, capability);
    }
    let item = await fixture.service.withAnalysis(fixture.actor, { limit: 1 }, async (view, source, authorize) => {
      await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source,
        { scope: view.scope, authorize });
      return (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId, limit: 1000 }))
        .find((row) => row.transactionId === targets.at(-1)!.id)!;
    });
    for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
      item = await fixture.store.transitionInternalReviewItem(item.id, { toStatus, actor: 'trusted-fixture', expectedVersion: item.version });
    expect(item.evidence.merchantEvidence).toBeUndefined();
    let committed: GenericActionProposal | undefined;
    let committedAudit: AuditRecord[] = [];
    const createProposal = fixture.store.createProposal.bind(fixture.store);
    const policy = await fixture.service.policy(fixture.actor);
    const revoke = async () => {
      if (change === 'revoke-subject')
        fixture.grant('evidence', `merchant:transaction:${item.transactionId}`, 'normalized-evidence', false);
      else if (change === 'disable-policy') await fixture.service.setPolicy(fixture.actor,
        { expectedVersion: policy.version, value: { ...policy.value, mode: 'disabled' } });
    };
    vi.spyOn(fixture.store, 'createProposal').mockImplementation(async (input) => {
      const proposal = await createProposal(input);
      if (proposal.operation !== 'create_rule') throw new Error('Expected exact native rule intent');
      committed = proposal;
      committedAudit = await fixture.store.queryAuditRecordsByProposal(proposal.id);
      if (stage === 'post-commit' || stage === 'cleanup-failure') await revoke();
      return proposal;
    });
    if (change !== 'unchanged') {
      const resolveContext = fixture.service.getCurrentRuleReviewContext.bind(fixture.service);
      const loadConfig = fixture.manager.loadConfig.bind(fixture.manager);
      const getReviewItem = fixture.store.getReviewItem.bind(fixture.store);
      let armed = false;
      let reviewReads = 0;
      vi.spyOn(fixture.service, 'getCurrentRuleReviewContext').mockImplementation(async (...args) => {
        const context = await resolveContext(...args);
        armed = true;
        return context;
      });
      vi.spyOn(fixture.store, 'getReviewItem').mockImplementation(async (id) => {
        const current = await getReviewItem(id);
        if (armed && !committed && ++reviewReads === 2 && stage === 'helper-review') {
          armed = false;
          await revoke();
        } else if (armed && committed && stage === 'published-review') {
          armed = false;
          await revoke();
        }
        return current;
      });
      vi.spyOn(fixture.manager, 'loadConfig').mockImplementation(async () => {
        const config = await loadConfig();
        if (armed && (stage === 'context-config' || committed && stage === 'published-config')) {
          armed = false;
          await revoke();
        }
        return config;
      });
      if (stage === 'cleanup-failure')
        vi.spyOn(fixture.store, 'supersedeProposal').mockRejectedValue(new Error('PRIVATE-CLEANUP-FAILURE'));
    }
    const response = await proposeReviewRule(request({ reviewId: item.id, categoryId }));
    if (change === 'unchanged') {
      expect(response.status, response.error?.code).toBe('ok');
      expect(response.result?.proposal).toMatchObject({ operation: 'create_rule' });
    } else {
      expect(response.status).toBe('error');
      expect(response.result).toBeNull();
      if (stage === 'context-config' || stage === 'helper-review') {
        expect(committed).toBeUndefined();
        expect(await fixture.store.listProposals()).toEqual([]);
      } else {
        if (!committed) throw new Error('Post-commit revocation must retain its exact committed intent');
        const retained = await fixture.store.getProposal(committed.id);
        expect(retained).toEqual({ ...committed,
          supersededAt: stage === 'cleanup-failure' ? null : now });
        expect(await fixture.store.queryAuditRecordsByProposal(committed.id)).toEqual(committedAudit);
        expect(JSON.stringify(response)).not.toContain(committed.id);
        expect(JSON.stringify(response)).not.toContain(committed.payloadHash);
        expect(JSON.stringify(response)).not.toContain('PRIVATE-CLEANUP-FAILURE');
        if (stage !== 'cleanup-failure') {
          await expect(fixture.store.createApproval({
            proposalId: committed.id, payloadHash: committed.payloadHash, actorId: fixture.actor.actorId,
            expiresAt: committed.expiresAt, auth: humanAuth(fixture.actor.actorId), now,
          })).rejects.toThrow();
          await expect(fixture.store.acquireProposalExecution({
            proposalId: committed.id, payloadHash: committed.payloadHash, actorId: fixture.actor.actorId,
            governancePolicyVersion: committed.governancePolicyVersion, idempotencyKey: `revoked:${stage}`,
            serialisedEffect: JSON.stringify({ operation: committed.operation, payload: committed.payload,
              preconditions: JSON.parse(committed.preconditions) }),
            auth: humanAuth(fixture.actor.actorId), now,
          })).rejects.toThrow();
        }
      }
    }
    expect(await fixture.store.getReviewItem(item.id)).toEqual(item);
    expect(fixture.client.createRule).not.toHaveBeenCalled();
  });

  it('does not expose a stale private history target to B who can read the candidate and category', async () => {
    const prior = (await fixture.service.analyze(fixture.actor)).suggestions.find((value) => value.transactionId === candidateId)!;
    await fixture.service.confirm(fixture.actor, alias(prior));
    const inferred = (await fixture.service.analyze(fixture.actor)).suggestions.find((value) => value.transactionId === candidateId)!;
    expect(inferred.categoryId).toBe(categoryId);
    const item = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
      await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source,
        { scope: view.scope, authorize });
      return (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId }))[0]!;
    });
    fixture.setRows(fixture.rows().map((row) => row.id === candidateId ? row : { ...row, account: privateAccountId }));
    fixture.grantSources();
    const peer = await fixture.addMember('private-history-observer');
    fixture.grantSources(peer, fixture.rows().filter((row) => row.id === candidateId));
    const catalog = { accounts: [{ id: accountId, name: 'Checking' }], categories: canonical.categories, transactions: [] };
    const projected = await fixture.service.withAnalysis(peer, { transactionIds: [candidateId] }, (view, source) => {
      expect(view.localReview.candidates.find((value) => value.transactionId === candidateId)?.source).toBe('uncategorized');
      return projectReviewQueueItem(fixture.store, peer, item, catalog, view, source);
    });
    expect(projected).toMatchObject({ reviewItem: { categoryId: '' }, actionable: false, evidence: { source: 'uncategorized', suggestedCategory: '', changePreview: { affectsEnvelope: false } } });
    expect(JSON.stringify(projected)).not.toContain(categoryId);
    expect(await fixture.store.getReviewItem(item.id)).toEqual(item);
  });

  it.each(['revoked', 'deleted', 'transaction-deleted', 'unavailable', 'disabled', 'optional-analysis-absent'] as const)(
    'withholds a persisted merchant target in list/detail when current evidence is %s', async (state) => {
      const captured = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
        await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source,
          { scope: view.scope, authorize });
        return { item: (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId }))[0]!,
          prior: view.suggestions.find((value) => value.transactionId === candidateId)! };
      });
      let item = captured.item;
      const prior = captured.prior;
      for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
        item = await fixture.store.transitionInternalReviewItem(item.id, { toStatus, actor: 'trusted-fixture', expectedVersion: item.version });
      if (state === 'revoked') fixture.grant('evidence', prior.evidenceKey, 'evidence', false);
      if (state === 'deleted') fixture.setRows(fixture.rows().filter((row) => row.id === candidateId));
      if (state === 'transaction-deleted') fixture.setRows(fixture.rows().filter((row) => row.id !== candidateId));
      if (state === 'unavailable') vi.mocked(fixture.client.getPayees).mockRejectedValue(new Error('Fixture payee source unavailable'));
      if (state === 'disabled') {
        const policy = await fixture.service.policy(fixture.actor);
        await fixture.service.setPolicy(fixture.actor, { expectedVersion: policy.version, value: { ...policy.value, mode: 'disabled' } });
      }
      if (state === 'optional-analysis-absent') fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', false);
      const listing = await reviewList(request());
      const detail = await reviewDetail({ ...request(), context: { ...request().context, params: { id: item.id } } });
      const listed = listing.result?.items.find((value) => value.reviewItem.id === item.id);
      if (state === 'transaction-deleted' || (state === 'unavailable' && !listed)) {
        expect(listed).toBeUndefined();
        expect(detail.result).toBeNull();
      } else {
        expect(listed).toMatchObject({ reviewItem: { categoryId: '' }, actionable: false, evidence: { source: 'uncategorized', suggestedCategory: '', changePreview: { affectsEnvelope: false } } });
        expect(detail.result).toEqual(listed);
      }
      expect(JSON.stringify(listing)).not.toContain(categoryId);
      expect(JSON.stringify(detail)).not.toContain(categoryId);
    },
  );

  it('projects full scoped competing categories without inventing inference confidence', async () => {
    fixture.setRows([...fixture.rows(), transaction({ id: 'tx-alternative', date: '2026-05-04', category: 'category-other' })]);
    fixture.grantSources();
    const item = await fixture.store.createReviewItem({ budgetId: fixture.actor.budgetId, transactionId: candidateId, categoryId: '', classifier: 'deterministic', provenance: 'test' });
    const catalog = { accounts: [{ id: accountId, name: 'Checking' }], categories: canonical.categories, transactions: [] };
    const projected = await fixture.service.withAnalysis(fixture.actor, { transactionIds: [candidateId] }, (view, source) =>
      projectReviewQueueItem(fixture.store, fixture.actor, item, catalog, view, source));
    expect(projected?.evidence.history.map((entry) => [entry.categoryId, entry.count])).toEqual([[categoryId, 3], ['category-other', 1]]);
    expect(projected?.evidence.alternatives).toEqual([categoryId, 'category-other']);
    expect(projected?.evidence.merchantEvidence?.alternatives.every((alternative) => alternative.tier === 'insufficient_data')).toBe(true);
    expect(projected?.evidence.ruleCandidates).toEqual([]);
  });
});

describe('separately governed merchant research routes', () => {
  const publicQuery = async () => {
    const target = (await fixture.service.analyze(fixture.actor)).suggestions.find((value) => value.transactionId === candidateId)!;
    return { evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision, merchant: 'Northstar Public Bakery', locale: null, publicBusiness: true };
  };
  const grantResearch = () => {
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:research');
    fixture.grant('account', accountId, 'merchant:research');
    fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'merchant:research');
  };

  const enableExternal = async (fetchFn: typeof fetch) => {
    await fixture.cleanup();
    const value = { mode: 'external-allowed' as const, allowedProviderIds: ['valueserp'], maxSearchesPerDay: 10, maxSpendMinorUnitsPerMonth: 1, billingCurrency: 'USD', cacheTtlHours: 24 };
    const configuration: MerchantResearchConfiguration = {
      installationId: 'server-installation', installationVersion: 'installation-v1', installationPolicy: value,
      credentialId: 'server-credential', credentialVersion: 'credential-v1',
      credentialLimits: { maxSearchesPerDay: 10, maxSpendMinorUnitsPerMonth: 1 },
      tariff: { version: 'account-confirmed-test-v1', billingCurrency: 'USD', costAtoms: '125000' }, apiKey: 'SERVER-ONLY-SYNTHETIC-KEY',
    };
    fixture = await merchantFixture({
      currency: 'JPY',
      research: {
        settings: () => ({ installation: { version: configuration.installationVersion, value }, configuration }),
        providerFor: () => new ValueSerpProvider({ apiKey: configuration.apiKey, fetchFn, now: () => new Date(fixture.clock()) }),
      },
    });
    deps.store.mockReturnValue({ store: fixture.store }); deps.manager.mockReturnValue(fixture.manager); deps.service.mockResolvedValue(fixture.service);
    grantResearch();
    await fixture.service.setSpacePolicy(fixture.actor, { expectedVersion: 0, value });
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value });
    return publicQuery();
  };
  const organicResponse = () => new Response(JSON.stringify({ request_info: { success: true, credits_used_this_request: 1 }, organic_results: [{ title: 'Northstar Public Bakery', link: 'https://public.example.test/bakery', snippet: 'Public business observation, not financial identity.' }] }));

  it('previews then sends exactly once through the real provider and returns authorized historical provenance and cache', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => organicResponse());
    const query = await enableExternal(fetchFn);
    const preview = await researchPreview(request(query));
    expect(preview.status).toBe('ok');
    expect(preview.result).toMatchObject({ status: 'ready', merchant: query.merchant, locale: null, evidenceKey: query.evidenceKey, evidenceRevision: query.evidenceRevision, providerId: 'valueserp', providerVersion: 'valueserp-search/1', fieldsSent: ['merchant', 'locale'], maxCostAtoms: '125000', billingCurrency: 'USD' });
    expect(fetchFn).not.toHaveBeenCalled();
    if (preview.result?.status !== 'ready') throw new Error('Expected an authorized research preview');
    const body = { ...query, previewToken: preview.result.previewToken, consent: true, idempotencyKey: 'http-request-one' };
    const sent = await researchSend(request(body));
    expect(sent.status).toBe('ok');
    expect(sent.result?.status).toBe('succeeded');
    if (sent.result?.status !== 'succeeded') throw new Error('Expected research success');
    expect(sent.result.enrichment).toMatchObject({
      key: { scope: { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId }, providerId: 'valueserp', providerVersion: 'valueserp-search/1' },
      fieldsSent: ['merchant', 'locale'], retrievedAt: now, confidence: 'uncalibrated', evidenceRevision: query.evidenceRevision,
      sources: [{ url: 'https://public.example.test/bakery', title: query.merchant, snippet: 'Public business observation, not financial identity.' }],
    });
    expect(Date.parse(sent.result.enrichment.expiresAt)).toBeGreaterThan(Date.parse(now));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ api_key: 'SERVER-ONLY-SYNTHETIC-KEY', q: query.merchant, output: 'json', num: '10' });
    expect((await researchCache(request(query))).result).toEqual({ enrichment: sent.result.enrichment });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toContain('SERVER-ONLY-SYNTHETIC-KEY');
    expect((await analyze(request())).result?.localReview.totalUncategorizedAmount).toEqual({ minorUnits: '100', currency: 'JPY' });
    fixture.grant('evidence', query.evidenceKey, 'merchant:research', false);
    const revoked = await researchCache(request(query));
    expect(revoked.status === 'error' || revoked.result?.enrichment === null).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain('public.example.test');
  });

  it.each(['evidence', 'account', 'stale', 'lifetime'] as const)('rechecks current %s authority after preview and never dispatches a stale request', async (change) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => organicResponse());
    const query = await enableExternal(fetchFn);
    const preview = await researchPreview(request(query));
    if (preview.result?.status !== 'ready') throw new Error('Expected an authorized research preview');
    const event = request({ ...query, previewToken: preview.result.previewToken, consent: true, idempotencyKey: 'changed-http-request' });
    if (change === 'evidence') fixture.grant('evidence', query.evidenceKey, 'merchant:research', false);
    if (change === 'account') fixture.grant('account', accountId, 'merchant:research', false);
    if (change === 'stale') fixture.setRows(fixture.rows().map((row) => row.id === candidateId ? { ...row, amount: -101 } : row));
    if (change === 'lifetime') Object.assign(event.context.auth, { credentialExpiresAt: now, isCredentialValid: () => false });
    const result = await researchSend(event);
    expect(result.status === 'error' || result.result?.status === 'denied').toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SERVER-ONLY-SYNTHETIC-KEY');
  });

  it('binds consent to the exact public query and strict request body, never client provider or pricing choices', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => organicResponse());
    const query = await enableExternal(fetchFn);
    const preview = await researchPreview(request(query));
    if (preview.result?.status !== 'ready') throw new Error('Expected an authorized research preview');
    const body = { ...query, previewToken: preview.result.previewToken, consent: true, idempotencyKey: 'strict-http-request' };
    for (const tampered of [
      { ...body, merchant: 'Another Public Bakery' }, { ...body, locale: 'US' }, { ...body, consent: false },
      { ...body, providerId: 'unreviewed' }, { ...body, tariff: { costAtoms: '0' } }, { ...body, auth: { actorId: 'holder' } },
    ]) {
      const result = await researchSend(request(tampered));
      expect(result.status === 'error' || result.result?.status === 'denied').toBe(true);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await researchSend(request(body))).result?.status).toBe('succeeded');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns a secret/query-free uncertain failure without retry and leaves local analysis usable', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://api.valueserp.com/search?api_key=SERVER-ONLY-SYNTHETIC-KEY&q=Northstar Public Bakery'));
    const query = await enableExternal(fetchFn);
    const preview = await researchPreview(request(query));
    if (preview.result?.status !== 'ready') throw new Error('Expected an authorized research preview');
    const result = await researchSend(request({ ...query, previewToken: preview.result.previewToken, consent: true, idempotencyKey: 'offline-provider-outage' }));
    expect(result.result).toMatchObject({ status: 'failed', billing: 'uncertain' });
    expect(JSON.stringify(result)).not.toContain('SERVER-ONLY-SYNTHETIC-KEY');
    expect(JSON.stringify(result)).not.toContain(query.merchant);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await analyze(request())).status).toBe('ok');
  });

  it('withholds provider content when the verified session is revoked while the request is in flight', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (response: Response) => void;
    const paused = new Promise<Response>((resolve) => { release = resolve; });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => { entered(); return paused; });
    const query = await enableExternal(fetchFn);
    const preview = await researchPreview(request(query));
    if (preview.result?.status !== 'ready') throw new Error('Expected an authorized research preview');
    let valid = true;
    const event = request({ ...query, previewToken: preview.result.previewToken, consent: true, idempotencyKey: 'revoked-in-flight' });
    Object.assign(event.context.auth, { credentialExpiresAt: '2026-10-04T12:05:00.000Z', isCredentialValid: () => valid });
    const operation = researchSend(event);
    await started;
    valid = false;
    release(organicResponse());
    const result = await operation;
    expect(result.status === 'error' || result.result?.status === 'denied' || result.result?.status === 'failed').toBe(true);
    expect(JSON.stringify(result)).not.toContain('public.example.test');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await researchCache(request(query))).result).toEqual({ enrichment: null });
  });
  it('uses the real local-only host without a provider or spending configuration', async () => {
    grantResearch();
    const query = await publicQuery();
    const event = request(query);
    const preview = await researchPreview(event);
    expect(preview.status).toBe('ok');
    expect(preview.result).toMatchObject({ status: 'denied' });
    expect((await researchCache(request(query))).result).toEqual({ enrichment: null });
    const effective = await researchPolicy(request());
    expect(effective.status).toBe('ok');
    expect(effective.result?.resolved.mode).toBe('local-only');
    expect(event.node.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  it('admits independent policy administrators without an analysis grant or Actual reads', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', false);
    expect((await researchPolicy(request())).status).toBe('ok');
    expect((await policy(request())).status).toBe('ok');
    expect((await spacePolicy(request())).status).toBe('ok');
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
    fixture.grant('budget', fixture.actor.budgetId, 'policy', false);
    expect((await researchPolicy(request())).status).toBe('error');
    fixture.grant('budget', fixture.actor.budgetId, 'policy');
    fixture.grant('space', fixture.actor.spaceId, 'policy:manage', false);
    expect((await researchPolicy(request())).status).toBe('error');
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });

  it.each([researchPreview, researchCache, researchSend])('requires an independent live budget research grant before SDK capture', async (route) => {
    const query = await publicQuery();
    vi.mocked(fixture.client.getTransactions).mockClear();
    const result = await route(request(query));
    expect(result.status).toBe('error');
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
    grantResearch();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:research', false);
    expect((await route(request(query))).status).toBe('error');
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });

  it.each(['https://evil.test', 'null', 'https://balanceframe.test.evil.test', 'https://balanceframe.test/path', ''])('rejects an untrusted or malformed origin %s before service construction', async (origin) => {
    grantResearch();
    for (const route of [researchPreview, researchCache, researchSend, setSpacePolicy]) {
      deps.service.mockClear();
      const event = request({}, {}, origin);
      const result = await route(event);
      expect(result.status).toBe('error');
      expect(deps.service).not.toHaveBeenCalled();
      expect(event.node.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    }
  });

  it('requires an explicit trusted origin even for authenticated non-browser research and policy writes', async () => {
    grantResearch();
    for (const route of [researchPreview, researchCache, researchSend, setSpacePolicy]) {
      const event = request({});
      Reflect.deleteProperty(event.node.req.headers, 'origin');
      deps.service.mockClear();
      expect((await route(event)).status).toBe('error');
      expect(deps.service).not.toHaveBeenCalled();
    }
  });

  it.each(['actorId', 'spaceId', 'budgetId', 'connectionId', 'auth', 'providerId', 'apiKey', 'tariff', 'endpoint', 'sourceRefs'])('does not accept body authority %s or leak private values', async (field) => {
    grantResearch();
    const result = await researchPreview(request({ ...await publicQuery(), [field]: 'PRIVATE-QUERY-OR-KEY' }));
    expect(result.status === 'error' || result.result?.status === 'denied').toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-QUERY-OR-KEY');
  });

  it('retains current verified credential lifetime in research admission and refuses a lost selected namespace', async () => {
    grantResearch();
    const query = await publicQuery();
    const event = request(query);
    const isCredentialValid = vi.fn(() => true);
    const credentialExpiresAt = '2026-10-04T12:01:00.000Z';
    Object.assign(event.context.auth, { credentialExpiresAt, isCredentialValid });
    const preview = vi.spyOn(fixture.service, 'previewResearch');
    expect((await researchPreview(event)).status).toBe('ok');
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ method: 'session', credentialExpiresAt, isCredentialValid }),
    }), query);
    const foreign = request(query);
    foreign.node.req.headers['x-balanceframe-space'] = 'unavailable-space';
    preview.mockClear();
    expect((await researchPreview(foreign)).status).toBe('error');
    expect(preview).not.toHaveBeenCalled();
  });

  it('replaces only the independently versioned space policy under fresh matching human authority', async () => {
    const prior = await spacePolicy(request());
    expect(prior.status).toBe('ok');
    const input = { expectedVersion: prior.result!.version, value: { ...prior.result!.value, mode: 'disabled' } };
    const event = request(input);
    const isCredentialValid = vi.fn(() => true);
    Object.assign(event.context.auth, { credentialExpiresAt: '2026-10-04T12:01:00.000Z', isCredentialValid });
    const save = vi.spyOn(fixture.service, 'setSpacePolicy');
    const saved = await setSpacePolicy(event);
    expect(saved.status).toBe('ok');
    expect(saved.result).toMatchObject({ version: prior.result!.version + 1, value: { mode: 'disabled' } });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ method: 'human-session', isCredentialValid }) }), input);
    expect((await setSpacePolicy(request(input))).status).toBe('error');
    expect((await policy(request())).result?.version).toBe(0);
    const complete = { expectedVersion: saved.result!.version, value: prior.result!.value };
    expect((await setSpacePolicy(request({ ...complete, actorId: 'forged' }))).status).toBe('error');
    expect((await setSpacePolicy(request({ ...complete, value: { ...complete.value, calendar: { budget: null, accounts: [] } } }))).status).toBe('error');
    deps.human.mockResolvedValue(null);
    expect((await setSpacePolicy(request(complete))).status).toBe('error');
    deps.human.mockResolvedValue(humanAuth('other-holder'));
    expect((await setSpacePolicy(request(complete))).status).toBe('error');
    deps.human.mockResolvedValue(humanAuth('holder'));
    fixture.grant('space', fixture.actor.spaceId, 'policy:manage', false);
    expect((await setSpacePolicy(request(complete))).status).toBe('error');
  });
});
