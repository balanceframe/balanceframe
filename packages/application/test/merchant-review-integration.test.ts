import type { RuleEntity, TransactionEntity } from '@actual-app/core/types/models';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import type { MerchantVisibility } from '@balanceframe/workflow-store';
import type { MerchantActor } from '../src/merchant-service.js';
import type { CanonicalReviewSource } from '../src/review-persistence.js';
import type { MerchantFixture } from './merchant-service.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { createNativeAnalysisProtocol } from '../src/composition.js';
import { persistPendingReviewResult, moneyToDisplayAmount } from '../src/review-persistence.js';
import { merchantPendingReview } from '../src/merchant-service.js';
import { merchantFixture, native, now, accountId, candidateId, payeeId, categoryId, transaction } from './merchant-service.fixture.js';

let fixture: MerchantFixture;
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); fixture = await merchantFixture(); });
afterEach(async () => { if (fixture) await fixture.cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function snapshot(): Promise<ProtocolSnapshot & CanonicalReviewSource> {
  const merchantDerivation = await fixture.service.withAnalysis(fixture.actor, {}, (_view, source) => source.merchantDerivation);
  return fixture.manager.withConnection(async ({ connector }) => {
    const synchronized = await connector.synchronize({ refresh: false });
    if (typeof synchronized !== 'object' || synchronized === null || !('snapshot' in synchronized)) throw new Error('Actual fixture must produce authoritative canonical snapshot');
    return { ...canonicalProtocolSnapshotSchema.parse(synchronized.snapshot) as ProtocolSnapshot, merchantDerivation };
  }, { expectedBudgetId: fixture.actor.budgetId });
}
function protocol() {
  return createNativeAnalysisProtocol(async () => native, { merchantService: fixture.service, merchantActor: fixture.actor });
}
async function syncReview() {
  return fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
    const admitted = merchantPendingReview(view);
    await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, admitted, source, { scope: view.scope, authorize });
    return { result: admitted, source, rows: await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId, limit: 1000 }) };
  });
}
const nativeRule: RuleEntity = {
  id: 'rule-market-food', stage: 'post', conditionsOp: 'and',
  conditions: [{ field: 'payee', op: 'is', value: payeeId, type: 'id' }],
  actions: [{ op: 'set', field: 'category', value: categoryId, type: 'id' }],
};

describe('existing Review producer → SQLite inbox integration', () => {
  it('public merchant deletion removes retained Review projections durably without changing financial facts', async () => {
    const { rows } = await syncReview();
    const original = rows.find((row) => row.transactionId === candidateId)!;
    expect(original.evidence.merchantEvidence).toMatchObject({ categoryHistory: { totalCount: 3 } });
    await fixture.service.delete(fixture.actor);
    const deleted = await fixture.store.getReviewItem(original.id);
    expect(deleted?.evidence.merchantEvidence).toBeUndefined();
    expect(deleted).toMatchObject({ categoryId: '', status: 'superseded' });
    expect(deleted?.evidence.money).toEqual(original.evidence.money);
    expect(deleted?.sourceTransaction).toEqual(original.sourceTransaction);
    fixture.store.close();
    const reopened = new SqliteWorkflowStore(fixture.databasePath);
    try {
      const persisted = await reopened.getReviewItem(original.id);
      expect(persisted?.evidence.merchantEvidence).toBeUndefined();
      expect(persisted?.evidence.merchantProof).toBeUndefined();
      expect(persisted).toMatchObject({ categoryId: '', status: 'superseded' });
      expect(persisted?.sourceTransaction).toEqual(original.sourceTransaction);
    } finally { reopened.close(); }
  });
  it.each(['requester', 'other-owner', 'shared'] as const)(
    'publishes an unassigned Review with trusted %s capture ownership and deletes only that owner',
    async (visibility) => {
      const peer = await fixture.addMember('capture-owner');
      fixture.grantSources(peer);
      const privateActorId = visibility === 'shared' ? null : visibility === 'other-owner' ? peer.actorId : fixture.actor.actorId;
      // Keep real source admission, native analysis and fences; only select the trusted capture visibility.
      const trustedCapture = fixture.service as unknown as {
        capture(actor: MerchantActor, consume: (capture: { admission: { evidence: MerchantVisibility } }) => unknown,
          connected?: unknown, sharedSource?: boolean): Promise<unknown>;
      };
      const capture = trustedCapture.capture.bind(fixture.service);
      vi.spyOn(trustedCapture, 'capture').mockImplementation((actor, consume, connected) =>
        capture(actor, (captured) => {
          captured.admission.evidence.privateActorId = privateActorId;
          return consume(captured);
        }, connected, visibility === 'shared'));

      const published = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
        const marker = { scope: view.scope, privateActorId, capturedAt: now, expiresAt: '2026-10-05T12:00:00.000Z' };
        expect(source.merchantDerivation).toEqual(marker);
        expect(view.sourceAdmission).toMatchObject({ capturedAt: marker.capturedAt, expiresAt: marker.expiresAt });
        await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source,
          { scope: view.scope, authorize });
        const row = (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId }))[0]!;
        expect(row).toMatchObject({ assignedReviewerId: null, categoryId, classifier: 'merchant' });
        expect(row.evidence.merchantDerivation).toEqual(marker);
        return row;
      });
      await fixture.store.deleteScopeData('user',
        { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, actorId: fixture.actor.actorId });
      const afterRequesterDeletion = await fixture.store.getReviewItem(published.id);
      expect(afterRequesterDeletion?.sourceTransaction).toEqual(published.sourceTransaction);
      expect(afterRequesterDeletion?.evidence.money).toEqual(published.evidence.money);
      if (visibility !== 'requester') {
        expect(afterRequesterDeletion?.evidence.merchantDerivation).toEqual(published.evidence.merchantDerivation);
        expect(afterRequesterDeletion?.evidence.merchantProof).toEqual(published.evidence.merchantProof);
        expect(afterRequesterDeletion?.categoryId).toBe(categoryId);
        await fixture.store.deleteScopeData('user',
          { spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, actorId: peer.actorId });
      }
      const afterOwnerDeletion = await fixture.store.getReviewItem(published.id);
      if (visibility === 'shared') {
        expect(afterOwnerDeletion?.evidence.merchantDerivation).toEqual(published.evidence.merchantDerivation);
        expect(afterOwnerDeletion?.categoryId).toBe(categoryId);
        expect(afterOwnerDeletion?.evidence.merchantProof).toEqual(published.evidence.merchantProof);
        expect(afterOwnerDeletion?.evidence.sourceRevision).toEqual(published.evidence.sourceRevision);
      } else {
        expect(afterOwnerDeletion).toMatchObject({ categoryId: '', status: 'superseded' });
        expect(afterOwnerDeletion?.evidence.merchantDerivation).toBeUndefined();
        expect(afterOwnerDeletion?.evidence.merchantProof).toBeUndefined();
        expect(afterOwnerDeletion?.evidence.merchantEvidence).toBeUndefined();
        expect(afterOwnerDeletion?.evidence.sourceRevision).toBeUndefined();
      }
      expect(afterOwnerDeletion?.sourceTransaction).toEqual(published.sourceTransaction);
      expect(afterOwnerDeletion?.evidence.money).toEqual(published.evidence.money);
      expect(fixture.client.updateTransaction).not.toHaveBeenCalled();
    },
  );

  it('refuses valid proof-only merchant Review publication without a trusted derivation marker', async () => {
    await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
      const result = merchantPendingReview(view);
      for (const candidate of result.candidates) delete candidate.merchantEvidence;
      expect(result.candidates[0]).toMatchObject({ source: 'merchant-inferred', merchantProof: { transactionId: candidateId } });
      await expect(persistPendingReviewResult(fixture.store, fixture.actor.budgetId, result,
        { transactions: source.transactions }, { scope: view.scope, authorize })).rejects.toThrow();
      expect(await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId })).toEqual([]);
    });
  });

  it.each(['spaceId', 'budgetId', 'connectionId', 'privateActorId', 'capturedAt', 'expiresAt', 'inverted-lifetime'] as const)(
    'refuses proof-only merchant Review publication with invalid trusted derivation %s',
    async (field) => {
      await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
        const result = merchantPendingReview(view);
        for (const candidate of result.candidates) delete candidate.merchantEvidence;
        expect(result.candidates[0]).toMatchObject({ source: 'merchant-inferred', merchantProof: { transactionId: candidateId } });
        const marker = {
          scope: { ...view.scope }, privateActorId: fixture.actor.actorId,
          capturedAt: now, expiresAt: '2026-10-05T12:00:00.000Z',
        };
        if (field === 'spaceId' || field === 'budgetId' || field === 'connectionId') marker.scope[field] = `other-${field}`;
        else if (field === 'inverted-lifetime') marker.expiresAt = '2026-10-03T12:00:00.000Z';
        else marker[field] = '';
        await expect(persistPendingReviewResult(fixture.store, fixture.actor.budgetId, result,
          { ...source, merchantDerivation: marker }, { scope: view.scope, authorize })).rejects.toThrow();
        expect(await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId })).toEqual([]);
      });
    },
  );
  it('persists every authorized inferred target beyond the explanation page without freshness-clock issue churn', async () => {
    const targets = Array.from({ length: 301 }, (_, index) =>
      transaction({ id: `tx-inferred-review-${String(index).padStart(3, '0')}` }));
    fixture.setRows([...fixture.rows().filter((row) => row.category !== null), ...targets]);
    fixture.grantSources();
    const view = await fixture.service.analyze(fixture.actor, { limit: 1 });
    expect(view.suggestions).toHaveLength(1);
    expect(new Set(view.localReview.candidates.filter((candidate) =>
      candidate.source === 'merchant-inferred' && candidate.proposedCategoryId === categoryId)
      .map((candidate) => candidate.transactionId))).toEqual(new Set(targets.map((row) => row.id)));

    const first = await syncReview();
    const offPageId = targets.at(-1)!.id;
    const offPage = first.rows.find((row) => row.transactionId === offPageId)!;
    expect(offPage).toMatchObject({
      categoryId, classifier: 'merchant',
      evidence: { merchantProof: { transactionId: offPageId, accountId, payeeId, categoryId, tier: 'inferred' } },
    });
    expect(offPage.evidence.merchantEvidence).toBeUndefined();
    fixture.setClock('2026-10-04T12:01:00.000Z');
    vi.setSystemTime(fixture.clock());
    const refreshed = await syncReview();
    const sameIssue = refreshed.rows.find((row) => row.transactionId === offPageId)!;
    expect(sameIssue.id).toBe(offPage.id);
    expect(sameIssue.transactionVersion).toBe(offPage.transactionVersion);
    expect(sameIssue.evidence.sourceRevision).toBe(offPage.evidence.sourceRevision);
    expect(new Set(refreshed.rows.filter((row) => row.status !== 'superseded').map((row) => row.transactionId)))
      .toEqual(new Set(targets.map((row) => row.id)));
  });

  it('admits every off-page inferred subject independently and does not gate ordinary native targets on merchant evidence rights', async () => {
    const targets = Array.from({ length: 211 }, (_, index) =>
      transaction({ id: `tx-subject-review-${String(index).padStart(3, '0')}` }));
    fixture.setRows([...fixture.rows().filter((row) => row.category !== null), ...targets]);
    fixture.grantSources();
    const deniedId = targets.at(-1)!.id;
    fixture.grant('evidence', `merchant:transaction:${deniedId}`, 'normalized-evidence', false);
    const inferred = await fixture.service.analyze(fixture.actor, { limit: 1 });
    expect(new Set(inferred.localReview.candidates.filter((candidate) => candidate.source === 'merchant-inferred')
      .map((candidate) => candidate.transactionId)))
      .toEqual(new Set(targets.filter((row) => row.id !== deniedId).map((row) => row.id)));
    expect(inferred.localReview.candidates.find((candidate) => candidate.transactionId === deniedId))
      .toMatchObject({ source: 'uncategorized' });

    fixture.setRules([nativeRule]);
    fixture.grant('rule', nativeRule.id, 'rule:view');
    const ordinary = await fixture.service.analyze(fixture.actor, { limit: 1 });
    expect(ordinary.localReview.candidates.find((candidate) => candidate.transactionId === deniedId))
      .toMatchObject({ source: 'native-rule', proposedCategoryId: categoryId });
  });
  it('abstains under partial rule coverage while retaining complete applicable native tables outside Pending Review', async () => {
    fixture.setRows([transaction()]);
    fixture.setRules([nativeRule]);
    fixture.grant('rule', nativeRule.id, 'rule:view');
    const complete = await fixture.service.analyze(fixture.actor);
    expect(complete.sourceAdmission.collections.rules).toBe('complete');
    expect(complete.localReview.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ transactionId: candidateId, source: 'native-rule', proposedCategoryId: categoryId }),
    ]));

    const hiddenCategoryId = 'category-denied-native-conflict';
    const categories = await fixture.client.getCategories();
    vi.mocked(fixture.client.getCategories).mockResolvedValue([
      ...categories, { ...categories[0]!, id: hiddenCategoryId, name: 'PRIVATE-DENIED-NATIVE-CATEGORY' },
    ]);
    const hiddenRule: RuleEntity = { ...nativeRule, id: 'rule-denied-category-conflict',
      actions: [{ op: 'set', field: 'category', value: hiddenCategoryId, type: 'id' }] };
    fixture.setRules([nativeRule, hiddenRule]);
    fixture.grant('rule', hiddenRule.id, 'rule:view');
    fixture.grant('category', hiddenCategoryId, 'existence', false);
    fixture.grant('category', hiddenCategoryId, 'name', false);
    const partial = await fixture.service.analyze(fixture.actor);
    expect(partial.sourceAdmission.collections.rules).toBe('partial');
    for (const table of ['nativeRuleBlocks', 'nativeRuleParts', 'nativeRuleSets', 'nativeRuleClassifications'] as const)
      expect(partial[table]).toEqual(complete[table]);
    expect(JSON.stringify(partial)).not.toContain('PRIVATE-DENIED-NATIVE-CATEGORY');
    const pending = merchantPendingReview(partial);
    expect(pending.nativeRuleBlocks).toEqual([]);
    expect(pending.nativeRuleParts).toEqual([]);
    expect(pending.nativeRuleSets).toEqual([]);
    expect(pending.candidates).toEqual([expect.objectContaining({ transactionId: candidateId, source: 'uncategorized' })]);
    expect(pending.candidates[0]).not.toHaveProperty('ruleSetIndex');
    expect(pending.candidates[0]).not.toHaveProperty('merchantProof');
    const { rows } = await syncReview();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categoryId).toBe('');
    expect(rows[0]?.evidence.ruleSetRef).toBeUndefined();
    expect(rows[0]?.evidence.merchantProof).toBeUndefined();
  });
  it('preserves all native-rule Review targets beyond the bounded explanation page', async () => {
    const rows=Array.from({length:250},(_,index)=>transaction({id:`tx-review-${String(index).padStart(3,'0')}`}));
    fixture.setRows(rows);
    fixture.grantSources();
    fixture.setRules([nativeRule]);
    fixture.grant('rule',nativeRule.id,'rule:view');
    const view=await fixture.service.analyze(fixture.actor,{limit:1});
    expect(view.suggestions).toHaveLength(1);
    expect(view.suggestionPage.eligibleCandidates).toBe(250);
    expect(view.localReview.candidates).toHaveLength(250);
    expect(view.nativeRuleBlocks).toEqual([{ ruleIds: [nativeRule.id] }]);
    expect(view.nativeRuleSets).toHaveLength(1);
    expect(view.localReview.candidates.every((candidate)=>candidate.source==='native-rule'&&candidate.proposedCategoryId===categoryId&&candidate.ruleSetIndex===0)).toBe(true);
  });
  it.each([
    ['0', 'USD', 0], ['-1', 'USD', -0.01],
    ['100', 'JPY', 100], ['100', 'KWD', 0.1],
    ['9007199254740991', 'JPY', Number.MAX_SAFE_INTEGER],
  ] as const)('converts only safely representable canonical %s %s for display', (minorUnits, currency, expected) => {
    expect(moneyToDisplayAmount({ minorUnits, currency })).toBe(expected);
  });
  it.each([
    ['9223372036854775807', 'JPY'], ['-9223372036854775808', 'USD'],
    ['100.0', 'USD'], ['100', 'BTC'], ['100', 'usd'],
  ] as const)('refuses a misleading numeric display for %s %s', (minorUnits, currency) => {
    expect(() => moneyToDisplayAmount({ minorUnits, currency })).toThrow(RangeError);
  });
  it('keeps exact unsafe source Money without inventing a numeric zero', async () => {
    const source = await snapshot();
    source.transactions.find((row) => row.id === candidateId)!.amount = { minorUnits: '-9223372036854775807', currency: 'JPY' };
    const result = await (await protocol()).pendingReview(fixture.connector(), null);
    await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, result, source);
    const row = (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId, limit: 1000 }))[0]!;
    expect(row.evidence.money).toEqual({ minorUnits: '-9223372036854775807', currency: 'JPY' });
    expect(row.evidence.amount).toBeUndefined();
    expect(row.sourceTransaction?.amount).toEqual({ minorUnits: '9223372036854775807', currency: 'JPY' });
  });
  it('refuses an unrepresentable signed-minimum action authority without publishing a partial inbox', async () => {
    const safeId = 'tx-action-safe-before-minimum';
    fixture.setRows([
      ...fixture.rows().filter((row) => row.category !== null),
      transaction({ id: safeId }),
      transaction({ id: candidateId }),
    ]);
    fixture.grantSources();
    const source = await snapshot();
    source.transactions.find((row) => row.id === candidateId)!.amount = { minorUnits: '-9223372036854775808', currency: 'JPY' };
    const result = await (await protocol()).pendingReview(fixture.connector(), null);
    expect(result.candidates.map((candidate) => candidate.transactionId)).toEqual([safeId, candidateId]);
    await expect(persistPendingReviewResult(fixture.store, fixture.actor.budgetId, result, source))
      .rejects.toThrow('Invalid canonical review source authority');
    expect(await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId })).toEqual([]);
  });
  it('refuses a queue publication after its source authority is revoked', async () => {
    const source = await snapshot();
    const result = await (await protocol()).pendingReview(fixture.connector(), null);
    await expect(persistPendingReviewResult(fixture.store, fixture.actor.budgetId, result, source, { authorize: () => false }))
      .rejects.toThrow('Review publication authority changed');
    expect(await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId })).toEqual([]);
  });
  it('does not admit the outgoing signed-minimum magnitude as an incoming source amount', async () => {
    const source = await snapshot();
    source.transactions.find((row) => row.id === candidateId)!.amount = { minorUnits: '9223372036854775808', currency: 'JPY' };
    const result = await (await protocol()).pendingReview(fixture.connector(), null);
    await expect(persistPendingReviewResult(fixture.store, fixture.actor.budgetId, result, source))
      .rejects.toThrow('Invalid canonical review source authority');
    expect(await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId })).toEqual([]);
  });
  it.each([['JPY',100],['KWD',0.1]] as const)('renders %s queue amounts from exact canonical source Money, not classifier floats or billing currency', async (currency, amount) => {
    await fixture.cleanup();
    fixture = await merchantFixture({ currency });
    const source = await snapshot();
    const result = await (await protocol()).pendingReview(fixture.connector(),null);
    for (const candidate of result.candidates) candidate.amount = { minorUnits:'999',currency:'USD' };
    await persistPendingReviewResult(fixture.store,fixture.actor.budgetId,result,source);
    const row = (await fixture.store.listReviewItems({ budgetId:fixture.actor.budgetId,limit:1000 }))[0]!;
    expect(row.sourceTransaction?.amount).toEqual({ minorUnits:'100',currency });
    expect(row.evidence.amount).toBe(amount);
  });
  it('persists inferred categories with an explicit discriminant, never pretending they are native rule IDs', async () => {
    const { result, rows } = await syncReview();
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId: candidateId, source: 'merchant-inferred', proposedCategoryId: categoryId })]));
    const candidate = result.candidates.find((value) => value.transactionId === candidateId)!;
    expect(candidate.ruleSetIndex).toBeUndefined();
    expect(candidate.merchantEvidence).toMatchObject({ transactionId: candidateId, tier: 'inferred', supportCount: 3 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transactionId: candidateId, categoryId, classifier: 'merchant', evidence: { merchantEvidence: { transactionId: candidateId, categoryId, tier: 'inferred' } } });
    expect(rows[0]!.sourceTransaction).toEqual({ id: candidateId, accountId, categoryId: null, direction: 'outgoing', amount: { minorUnits: '100', currency: 'USD' } });
  });

  it('keeps durable explanation provenance without retaining transient bank text or mutable decision catalogs', async () => {
    const { result, rows } = await syncReview();
    const current = result.candidates.find((value) => value.transactionId === candidateId)!.merchantEvidence!;
    expect(current.sourceTransaction.notes).toEqual({ state: 'present', value: 'PRIVATE-NOTE-DO-NOT-PUBLISH' });
    const stored = rows[0]!.evidence.merchantEvidence as Record<string, unknown>;
    expect(stored.sourceTransaction).toBeUndefined();
    expect(stored.aliasDecisions).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-NOTE-DO-NOT-PUBLISH');
    expect(stored).toMatchObject({
      evidenceKey: current.evidenceKey, evidenceRevision: current.evidenceRevision,
      categoryHistory: current.categoryHistory, ruleCandidates: current.ruleCandidates,
      transactionId: candidateId, categoryId, tier: 'inferred',
    });
    expect(rows[0]!.evidence.sourcePayeeId).toBe(payeeId);
    expect(rows[0]!.sourceTransaction?.amount).toEqual({ minorUnits: '100', currency: 'USD' });
  });

  it('leaves exactly one active issue for timestamp-only refresh without revision/version churn', async () => {
    const first = await syncReview();
    fixture.setClock('2026-10-04T12:01:00.000Z'); vi.setSystemTime(fixture.clock());
    const refreshed = await syncReview();
    expect(refreshed.rows).toHaveLength(1);
    expect(refreshed.rows[0]!.id).toBe(first.rows[0]!.id);
    expect(refreshed.rows[0]!.transactionVersion).toBe(first.rows[0]!.transactionVersion);
    expect(refreshed.rows[0]!.evidence.merchantEvidence).toMatchObject({ evidenceRevision: first.result.candidates[0]!.merchantEvidence!.evidenceRevision });
    expect(first.rows[0]!.evidence.merchantDerivation).toEqual({
      scope: first.result.candidates[0]!.merchantProof!.reviewContext.scope,
      privateActorId: fixture.actor.actorId, capturedAt: now, expiresAt: '2026-10-05T12:00:00.000Z',
    });
    expect(refreshed.source.merchantDerivation).toMatchObject({
      capturedAt: '2026-10-04T12:01:00.000Z', expiresAt: '2026-10-05T12:01:00.000Z',
    });
    expect(refreshed.rows[0]!.evidence.merchantDerivation).toEqual(first.rows[0]!.evidence.merchantDerivation);
    fixture.setClock('2026-10-05T12:00:00.000Z'); vi.setSystemTime(fixture.clock());
    fixture.store.merchant.prune({ now: fixture.clock() });
    const expired = await fixture.store.getReviewItem(first.rows[0]!.id);
    expect(expired).toMatchObject({ categoryId: '', status: 'superseded' });
    expect(expired?.evidence.merchantDerivation).toBeUndefined();
    expect(expired?.evidence.merchantProof).toBeUndefined();
    expect(expired?.evidence.merchantEvidence).toBeUndefined();
    expect(expired?.evidence.sourceRevision).toBeUndefined();
    expect(expired?.evidence.money).toEqual(first.rows[0]!.evidence.money);
    expect(expired?.sourceTransaction).toEqual(first.rows[0]!.sourceTransaction);
  });

  it('refreshes evidence with a newer transactionVersion despite unchanged transaction/category IDs', async () => {
    const first = await syncReview();
    fixture.setRows(fixture.rows().map((row) => row.id === 'tx-history-3' ? { ...row, amount: -125 } : row));
    const refreshed = await syncReview();
    const active = refreshed.rows.filter((row) => row.status !== 'superseded');
    expect(active).toHaveLength(1);
    expect(active[0]!.transactionId).toBe(candidateId);
    expect(active[0]!.categoryId).toBe(categoryId);
    expect(active[0]!.transactionVersion).toBeGreaterThan(first.rows[0]!.transactionVersion);
    expect(active[0]!.evidence.merchantEvidence).not.toEqual(first.rows[0]!.evidence.merchantEvidence);
    expect(first.result.candidates[0]!.merchantEvidence!.evidenceRevision).not.toBe(refreshed.result.candidates[0]!.merchantEvidence!.evidenceRevision);
    expect(refreshed.rows.filter((row) => row.status === 'superseded')).toHaveLength(1);
  });

  it('refreshes canonical review authorization separately from explanation/display money', async () => {
    await syncReview();
    fixture.setRows(fixture.rows().map((row) => row.id === candidateId ? { ...row, amount: -321 } : row));
    const refreshed = await syncReview();
    expect(refreshed.rows.find((row) => row.status !== 'superseded')!.sourceTransaction)
      .toEqual({ id: candidateId, accountId, categoryId: null, direction: 'outgoing', amount: { minorUnits: '321', currency: 'USD' } });
    expect(fixture.client.updateTransaction).not.toHaveBeenCalled();
  });

  it('retains exact actual native-rule identity and native category behavior', async () => {
    fixture.setRules([nativeRule]);
    for (const capability of ['rule:view', 'existence', 'name', 'source', 'evidence']) fixture.grant('rule', nativeRule.id, capability);
    const { result, rows } = await syncReview();
    expect(result.nativeRuleBlocks).toEqual([{ ruleIds: [nativeRule.id] }]);
    expect(result.nativeRuleParts.length).toBeGreaterThan(0);
    expect(result.nativeRuleSets).toHaveLength(1);
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId: candidateId, source: 'native-rule', proposedCategoryId: categoryId, ruleSetIndex: 0 })]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ classifier: 'rule', evidence: { ruleSetRef: { kind: 'scoped' } } });
    expect(rows[0]!.evidence.ruleIds).toBeUndefined();
  });
  it('keeps complete native rule Review targets and shared provenance when merchant inference is disabled or deleted', async () => {
    fixture.setRules([nativeRule]);
    fixture.grant('rule', nativeRule.id, 'rule:view');
    const policy = await fixture.service.policy(fixture.actor);
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: policy.version, value: { ...policy.value, mode: 'disabled' } });
    const published = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
      expect(view.suggestions).toEqual([]);
      expect(view.nativeRuleBlocks).toEqual([{ ruleIds: [nativeRule.id] }]);
      expect(view.nativeRuleSets).toHaveLength(1);
      expect(view.localReview.candidates.find((candidate) => candidate.transactionId === candidateId)).toMatchObject({
        source: 'native-rule', proposedCategoryId: categoryId, ruleSetIndex: 0,
      });
      await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, merchantPendingReview(view), source, { scope: view.scope, authorize });
      return (await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId }))[0]!;
    });
    expect(published).toMatchObject({ classifier: 'rule', categoryId, evidence: { ruleSetRef: { kind: 'scoped' } } });
    expect(published.evidence.ruleIds).toBeUndefined();
    await fixture.service.delete(fixture.actor);
    expect(await fixture.store.getReviewItem(published.id)).toMatchObject({
      categoryId, classifier: 'rule', sourceTransaction: published.sourceTransaction,
      evidence: { ruleSetRef: published.evidence.ruleSetRef },
    });
    expect(fixture.store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 1 });
  });
  it('honors selected-space native rule pauses without changing Actual rule state', async () => {
    fixture.setRules([nativeRule]);
    fixture.grant('rule', nativeRule.id, 'rule:view');
    const before = await fixture.service.analyze(fixture.actor);
    expect(before.localReview.candidates.find((candidate) => candidate.transactionId === candidateId)?.source).toBe('native-rule');
    const paused = await fixture.store.setRuleOverride({ spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, ruleId: nativeRule.id, inactive: true, expectedVersion: null });
    const after = await fixture.service.analyze(fixture.actor);
    expect(after.localReview.candidates.find((candidate) => candidate.transactionId === candidateId)?.source).not.toBe('native-rule');
    expect(after.sourceAdmission.factsHash).not.toBe(before.sourceAdmission.factsHash);
    await fixture.store.setRuleOverride({ spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, ruleId: nativeRule.id, inactive: false, expectedVersion: paused.version });
    expect((await fixture.service.analyze(fixture.actor)).localReview.candidates.find((candidate) => candidate.transactionId === candidateId)?.source).toBe('native-rule');
    expect(await fixture.client.getRules()).toEqual([nativeRule]);
  });

  it('keeps ordinary admitted native Review when merchant evidence is not visible', async () => {
    fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'normalized-evidence', false);
    const { result, rows } = await syncReview();
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId: candidateId, source: 'uncategorized' })]));
    expect(result.candidates.find((value) => value.transactionId === candidateId)!.merchantEvidence).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidence.merchantEvidence).toBeUndefined();
  });

  it('supersedes cross-classifier refreshes in the same inbox without resurrecting human rejection', async () => {
    const first = await syncReview();
    fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'normalized-evidence', false);
    const ordinary = await syncReview();
    expect(ordinary.rows.filter((row) => row.status !== 'superseded')).toHaveLength(1);
    expect(ordinary.rows.find((row) => row.id === first.rows[0]!.id)!.status).toBe('superseded');
    const active = ordinary.rows.find((row) => row.status !== 'superseded')!;
    const pending = await fixture.store.transitionInternalReviewItem(active.id, { toStatus: 'pending_review', actor: 'system', expectedVersion: active.version });
    for (const [kind, id] of [['budget', fixture.actor.budgetId], ['transaction', candidateId], ['account', accountId]] as const)
      fixture.grant(kind, id, 'categorization:execute');
    if (!pending.sourceTransaction) throw new Error('Canonical review authority is required');
    await fixture.store.transitionReviewItem(pending.id, {
      toStatus: 'rejected', actor: fixture.actor.actorId, expectedVersion: pending.version,
      authorization: { spaceId: fixture.actor.spaceId, policyVersion: fixture.actor.governancePolicyVersion!, auth: fixture.actor.auth, transaction: pending.sourceTransaction },
    });
    fixture.grant('evidence', `merchant:transaction:${candidateId}`, 'normalized-evidence');
    fixture.setRows(fixture.rows().map((row) => row.id === 'tx-history-3' ? { ...row, amount: -222 } : row));
    const refreshed = await syncReview();
    expect(refreshed.rows.filter((row) => row.status !== 'superseded')).toHaveLength(1);
    expect(refreshed.rows.find((row) => row.id === pending.id)!.status).toBe('rejected');
  });

  it('does not import rejected suggestions or raw notes as executed categorization history', async () => {
    const before = await syncReview();
    const source = before.result.candidates[0]!.merchantEvidence!;
    await fixture.service.reject(fixture.actor, { id: 'reject-alias', kind: 'alias', evidenceKey: source.evidenceKey, evidenceRevision: source.evidenceRevision,
      expectedVersion: 0, visibility: 'private', transactionId: candidateId, sourceField: 'importedPayee', targetPayeeId: payeeId, accountId });
    const next = await syncReview();
    expect(next.result.candidates.find((value) => value.transactionId === candidateId)!.merchantEvidence!.evidence.some((value) => value.kind === 'confirmed_decision')).toBe(false);
    expect(next.result.candidates.find((value) => value.transactionId === candidateId)!.merchantEvidence!.supportCount).toBe(3);
    for (const write of [fixture.client.updateTransaction, fixture.client.createRule, fixture.client.addTransactions]) expect(write).not.toHaveBeenCalled();
  });

  it('binds paging to current facts and never reuses an untrusted selection as source authorization', async () => {
    const extra = transaction({ id: 'tx-candidate-2', date: '2026-09-05' });
    fixture.setRows([...fixture.rows(), extra]); fixture.grantSources();
    const first = await fixture.service.analyze(fixture.actor, { transactionIds: [candidateId, extra.id], limit: 1 });
    expect(first.suggestionPage).toEqual({ eligibleCandidates: 2, returned: 1, nextCursor: candidateId });
    const second = await fixture.service.analyze(fixture.actor, { transactionIds: [candidateId, extra.id], limit: 1, cursor: first.suggestionPage.nextCursor, factsHash: first.sourceAdmission.factsHash });
    expect(second.suggestions.map((value) => value.transactionId)).toEqual([extra.id]);
    fixture.setRows(fixture.rows().map((row) => row.id === extra.id ? { ...row, notes: 'new source fact' } : row));
    await expect(fixture.service.analyze(fixture.actor, { transactionIds: [candidateId, extra.id], limit: 1, cursor: first.suggestionPage.nextCursor, factsHash: first.sourceAdmission.factsHash })).rejects.toThrow();
    fixture.grant('transaction', extra.id, 'transaction.view', false);
    const denied = await fixture.service.analyze(fixture.actor, { transactionIds: [extra.id] });
    expect(denied.suggestions).toEqual([]);
    expect(denied.suggestionPage.eligibleCandidates).toBe(0);
  });

  it('finds a recursively canonical split child instead of losing its review source', async () => {
    const child = transaction({ id: 'child-candidate', amount: -40, is_child: true, parent_id: 'split-parent' });
    const other = transaction({ id: 'child-other', amount: -60, is_child: true, parent_id: 'split-parent', category: categoryId });
    const parent = transaction({ id: 'split-parent', is_parent: true, subtransactions: [child, other] });
    fixture.setRows([...fixture.rows().filter((row) => row.id !== candidateId), parent]);
    fixture.grantSources(fixture.actor, [...fixture.rows(), child, other]);
    const { result, rows } = await syncReview();
    expect(result.candidates.some((value) => value.transactionId === child.id)).toBe(true);
    expect(rows.find((row) => row.transactionId === child.id)!.sourceTransaction)
      .toEqual({ id: child.id, accountId, categoryId: null, direction: 'outgoing', amount: { minorUnits: '40', currency: 'USD' } });
    expect(rows.some((row) => row.transactionId === parent.id)).toBe(false);
  });
});

describe('attention recurrence uses shared native interval/calendar evidence', () => {
  async function attention(rows: TransactionEntity[]) {
    fixture.setRows(rows); fixture.grantSources(); fixture.admitPatternGrants();
    const source = await snapshot();
    return (await protocol()).attentionHome!(source, { context: { month: '2026-10' } });
  }
  it.each([
    ['2026-06-30', '2026-07-31'],
    ['2026-06-30', '2026-07-31', '2026-08-31'],
  ])('projects the actual compiled recurrence tier without merchant options: %j', async (...dates) => {
    fixture.setRows(dates.map((date, index) => transaction({ id: `native-attention-${index}`, date, category: categoryId })));
    fixture.grantSources();
    const source = await snapshot();
    const ordinary = await createNativeAnalysisProtocol(async () => native);
    const output = await ordinary.attentionHome!(source, { context: { month: '2026-10' } });
    expect(output.recurrences).toEqual([expect.objectContaining({
      occurrences: dates.length, lastOccurrence: dates[dates.length - 1], isEstimated: true,
    })]);
  });
  it('does not label six irregular purchases monthly merely because their count is six', async () => {
    const dates = ['2026-01-03', '2026-01-07', '2026-02-19', '2026-04-02', '2026-04-21', '2026-09-18'];
    const output = await attention(dates.map((date, index) => transaction({ id: `irregular-${index}`, date, category: categoryId })));
    expect(output.recurrences).toHaveLength(1);
    expect(output.recurrences[0]).toMatchObject({ frequency: 'irregular', occurrences: 6, isEstimated: true });
  });
  it('establishes real monthly interval cadence with only the minimum three observations', async () => {
    const output = await attention(['2026-06-30', '2026-07-31', '2026-08-31'].map((date, index) => transaction({ id: `monthly-${index}`, date, category: categoryId })));
    expect(output.recurrences).toHaveLength(1);
    expect(output.recurrences[0]).toMatchObject({ frequency: 'monthly', occurrences: 3, lastOccurrence: '2026-08-31' });
  });
  it('cannot count source-excluded transfers/opening balances/split aggregates as a cadence', async () => {
    const rows = [
      transaction({ id: 'opening', date: '2026-06-04', category: categoryId, starting_balance_flag: true }),
      transaction({ id: 'transfer', date: '2026-07-04', category: categoryId, payee: 'payee-transfer' }),
      transaction({ id: 'single', date: '2026-08-04', category: categoryId }),
    ];
    const payees = await fixture.client.getPayees();
    vi.mocked(fixture.client.getPayees).mockResolvedValue([...payees, { id: 'payee-transfer', name: 'Transfer', transfer_acct: accountId }]);
    const output = await attention(rows);
    expect(output.recurrences.every((value) => value.frequency !== 'monthly')).toBe(true);
  });
  it('hides rejected patterns from attention while preserving their nonactionable measured evidence', async () => {
    fixture.admitPatternGrants();
    const current = await fixture.service.analyze(fixture.actor);
    const pattern = current.recurrences[0]!;
    await fixture.service.reject(fixture.actor, { id: 'attention-pattern-reject', kind: 'pattern', patternId: pattern.id, evidenceKey: pattern.evidenceKey,
      evidenceRevision: pattern.evidenceRevision, expectedVersion: 0, visibility: 'private' });
    const source = await snapshot();
    expect((await (await protocol()).attentionHome!(source, { context: { month: '2026-10' } })).recurrences).toEqual([]);
    expect((await fixture.service.analyze(fixture.actor)).recurrences[0]).toMatchObject({ decisionState: 'rejected', occurrences: 4 });
  });
});
