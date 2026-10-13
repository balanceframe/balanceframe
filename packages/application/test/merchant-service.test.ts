import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type { MerchantActor, MerchantDecisionInput, MerchantPublicSuggestion } from '../src/merchant-service.js';
import type { MerchantFixture } from './merchant-service.fixture.js';
import { createMerchantIntelligenceService, MerchantIntelligenceService, merchantConnectionId, merchantPendingReview } from '../src/merchant-service.js';
import { merchantFixture, native, now, humanAuth, transaction, accountId, privateAccountId, candidateId, payeeId, categoryId, evidenceKey } from './merchant-service.fixture.js';
import { persistPendingReviewResult } from '../src/review-persistence.js';

const localPolicy = { mode: 'local-only' as const, allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720 };
let fixture: MerchantFixture;
async function suggestion(): Promise<MerchantPublicSuggestion> {
  const result = await fixture.service.analyze(fixture.actor);
  const value = result.suggestions.find((candidate) => candidate.transactionId === candidateId);
  if (!value) throw new Error('Admitted canonical candidate must have typed merchant evidence');
  return value;
}
function alias(value: MerchantPublicSuggestion, fields: Partial<Pick<MerchantDecisionInput, 'id' | 'expectedVersion' | 'visibility'>> & { accountId?: string | null } = {}): MerchantDecisionInput {
  return { id: 'alias-candidate', kind: 'alias', evidenceKey: value.evidenceKey, evidenceRevision: value.evidenceRevision,
    expectedVersion: 0, visibility: 'private', transactionId: candidateId, sourceField: 'importedPayee', targetPayeeId: payeeId, accountId, ...fields };
}
async function resolve(key: string | null, actor = fixture.actor) {
  return fixture.manager.withConnection(async (connected) => {
    const result = await connected.connector.synchronize({refresh:false});
    if (typeof result !== 'object' || result === null || !('snapshot' in result)) throw new Error('Authoritative SDK rule snapshot unavailable');
    const snapshot:ProtocolSnapshot = canonicalProtocolSnapshotSchema.parse(result.snapshot);
    return fixture.service.getCurrentRuleReviewContext(actor,{evidenceKey:key,connected,snapshot,
      sourceAvailability:'rulePlanningSourceAvailability' in result ? result.rulePlanningSourceAvailability : undefined});
  },{expectedBudgetId:actor.budgetId,synchronize:false});
}

beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); fixture = await merchantFixture(); });
afterEach(async () => { if (fixture) await fixture.cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('trusted connection identity', () => {
  it('hashes selected normalized origin/path/budget, excluding all secret/userinfo/query/fragment inputs', () => {
    const first = merchantConnectionId({ serverUrl: 'https://user:pass@actual.fixture.test:443/base?password=one#fragment', budgetId: 'budget-merchant' });
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).toBe(merchantConnectionId({ serverUrl: 'https://actual.fixture.test/base?token=two', budgetId: 'budget-merchant' }));
    expect(first).not.toBe(merchantConnectionId({ serverUrl: 'https://replacement.fixture.test/base', budgetId: 'budget-merchant' }));
    expect(first).not.toBe(merchantConnectionId({ serverUrl: 'https://actual.fixture.test/other', budgetId: 'budget-merchant' }));
    expect(first).not.toBe(merchantConnectionId({ serverUrl: 'https://actual.fixture.test/base', budgetId: 'other-budget' }));
  });
  it.each(['not a URL', 'file:///tmp/budget', 'javascript:alert(1)'])('rejects invalid Actual origin %s', (serverUrl) => {
    expect(() => merchantConnectionId({ serverUrl, budgetId: 'budget-merchant' })).toThrow();
  });
});

describe('verified selected-space operation admission', () => {
  it('preserves unequal complete native outcomes through one shared block table without inline Review fanout', async () => {
    const secondPayee = 'native-second-payee';
    const payees = await fixture.client.getPayees();
    vi.mocked(fixture.client.getPayees).mockResolvedValue([...payees, { id: secondPayee, name: 'Second native fixture payee' }]);
    fixture.setRows([
      transaction({ id: 'native-one', payee: payeeId, category: null, amount: -100 }),
      transaction({ id: 'native-two', payee: secondPayee, category: null, amount: -100 }),
    ]);
    for (const id of ['native-one', 'native-two']) {
      fixture.grant('transaction', id, 'transaction.view');
      fixture.grant('transaction', id, 'source');
    }
    const commonIds = Array.from({ length: 32 }, (_, i) => `native-rule-common-${String(i).padStart(2, '0')}`);
    const common = commonIds.map((id) => ({ id, stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'account', op: 'is', value: accountId }],
      actions: [{ field: 'category', op: 'set', value: categoryId }] }));
    fixture.setRules([...common, ...[payeeId, secondPayee].map((payee, i) => ({
      id: `native-rule-private-${i}`, stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: payee }],
      actions: [{ field: 'category', op: 'set', value: categoryId }],
    }))]);
    for (const id of [...commonIds, 'native-rule-private-0', 'native-rule-private-1']) fixture.grant('rule', id, 'rule:view');
    const review = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
      const pending = merchantPendingReview(view);
      await persistPendingReviewResult(fixture.store, fixture.actor.budgetId, pending, source, { scope: view.scope, authorize });
      return pending;
    });
    expect(review.nativeRuleBlocks.reduce((count, block) => count + block.ruleIds.length, 0)).toBe(34);
    expect(review.nativeRuleSets).toHaveLength(2);
    expect(review.candidates.map((row) => [row.transactionId, row.source, row.proposedCategoryId]))
      .toEqual([['native-one', 'native-rule', categoryId], ['native-two', 'native-rule', categoryId]]);
    const items = await fixture.store.listReviewItems({ budgetId: fixture.actor.budgetId, limit: 1000 });
    for (const [i, row] of review.candidates.entries()) {
      expect(row).not.toHaveProperty('ruleIds');
      const reference = items.find((item) => item.transactionId === row.transactionId)!.evidence.ruleSetRef;
      if (typeof reference !== 'object' || reference === null || !('id' in reference) || typeof reference.id !== 'string')
        throw new Error('Persisted native rule-set reference is required');
      const metadata = fixture.store.getReviewRuleSetMetadata(reference.id);
      if (!metadata) throw new Error('Persisted native rule-set metadata is required');
      expect(fixture.store.getReviewRuleSet(metadata)).toEqual([...commonIds, `native-rule-private-${i}`].sort());
    }
  });
  it.each(['unchanged', 'normalized-evidence', 'source', 'policy', 'deleted', 'expired'] as const)(
    'fences retained native replay disclosure without querying Actual: %s', async (change) => {
      for (const capability of ['existence', 'history', 'name', 'source'])
        fixture.grant('account', privateAccountId, capability);
      const key = evidenceKey(candidateId);
      const context = await resolve(key);
      const queries = {
        rules: vi.mocked(fixture.client.getRules).mock.calls.length,
        transactions: vi.mocked(fixture.client.getTransactions).mock.calls.length,
      };
      const authorize = await fixture.service.getRuleReplayPublicationAuthority(fixture.actor, context);
      expect(authorize()).toBe(true);
      if (change === 'normalized-evidence') fixture.grant('evidence', key, 'normalized-evidence', false);
      if (change === 'source') fixture.grant('transaction', candidateId, 'source', false);
      if (change === 'policy') {
        const policy = await fixture.service.policy(fixture.actor);
        await fixture.service.setPolicy(fixture.actor, { expectedVersion: policy.version, value: { ...policy.value, mode: 'disabled' } });
      }
      if (change === 'deleted') await fixture.service.delete(fixture.actor);
      if (change === 'expired') {
        fixture.setClock('2026-10-06T12:00:00.000Z');
        vi.setSystemTime(fixture.clock());
      }
      expect(authorize()).toBe(change === 'unchanged');
      expect(vi.mocked(fixture.client.getRules).mock.calls.length).toBe(queries.rules);
      expect(vi.mocked(fixture.client.getTransactions).mock.calls.length).toBe(queries.transactions);
    },
  );
  it.each(['evidence', 'transaction', 'budget'] as const)(
    'retains the validated full derivation when monetary restrictions change on %s', async (kind) => {
      for (const capability of ['existence', 'history', 'name', 'source'])
        fixture.grant('account', privateAccountId, capability);
      const key = evidenceKey(candidateId);
      const targets: Record<typeof kind, readonly ['evidence'|'transaction'|'budget', string, string]> = {
        evidence: ['evidence', key, 'normalized-evidence'],
        transaction: ['transaction', candidateId, 'source'],
        budget: ['budget', fixture.actor.budgetId, 'merchant:analyze'],
      };
      const target = targets[kind];
      fixture.grant(...target, true, fixture.actor, { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '1000000' }] });
      const context = await resolve(key);
      const authorize = await fixture.service.getRuleReplayPublicationAuthority(fixture.actor, context);
      expect(authorize()).toBe(true);
      fixture.grant(...target, true, fixture.actor, { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }] });
      expect(authorize()).toBe(false);
    },
  );
  it('does not publish a captured low-ceiling authority under a temporarily loosened subject ceiling', async () => {
    for (const capability of ['existence', 'history', 'name', 'source'])
      fixture.grant('account', privateAccountId, capability);
    const key = evidenceKey(candidateId);
    fixture.grant('evidence', key, 'normalized-evidence', true, fixture.actor, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '100' }],
    });
    let reads = 0;
    vi.mocked(fixture.client.getRules).mockImplementation(async () => {
      if (++reads === 2) fixture.grant('evidence', key, 'normalized-evidence', true, fixture.actor, {
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '1000' }],
      });
      return [];
    });
    await expect(resolve(key)).rejects.toThrow();
  });
  it('consumes exact admitted canonical Review source under the source lock and supplies a fresh write fence', async () => {
    const result = await fixture.service.withAnalysis(fixture.actor,{},async (view,source,authorize) => {
      expect(authorize()).toBe(true);
      expect(source.transactions.find((item) => item.id === candidateId)).toEqual({
        id:candidateId,accountId,payeeId,payeeName:expect.any(String),categoryId:null,date:'2026-09-04',
        amount:{minorUnits:'-100',currency:'USD'},subtransactions:[],
      });
      expect(JSON.stringify(source)).not.toMatch(/PRIVATE-NOTE|importedPayee|importedId|cleared|account-private/);
      return view.localReview.uncategorizedCount;
    });
    expect(result).toBe(1);
    expect(fixture.client.sync).not.toHaveBeenCalled();
  });
  it('refuses consumer result publication and disables its write fence after current membership revocation', async () => {
    await expect(fixture.service.withAnalysis(fixture.actor,{},async (_view,_source,authorize) => {
      fixture.store.governance.revokeMembership({spaceId:fixture.actor.spaceId,membershipId:fixture.actor.membershipId!,now,auth:humanAuth('holder')});
      expect(authorize()).toBe(false);
      return 'must-not-publish';
    })).rejects.toThrow('Merchant operation is not authorized');
  });
  it('refuses capped analysis when a nonsampled payee contributor loses current transaction authority', async () => {
    fixture.grant('budget',fixture.actor.budgetId,'source',false);
    const payees = await fixture.client.getPayees();
    vi.mocked(fixture.client.getPayees).mockResolvedValue([...payees,{id:'payee-private-contributor',name:'PRIVATE-PRECAP-PAYEE'}]);
    fixture.setRows(fixture.rows().map((row) => row.id === 'tx-history-3' ? {...row,payee:'payee-private-contributor'} : row));
    const service = new MerchantIntelligenceService({
      store:fixture.store,connectionManager:fixture.manager,clock:()=>new Date(now),maxTransactions:1,
      native:{analyzeMerchantIntelligence:(input) => {
        const request = JSON.parse(input) as {transactions:Array<{id:string}>};
        expect(request.transactions.some((row) => row.id === 'tx-history-3')).toBe(false);
        fixture.grant('transaction','tx-history-3','transaction.view',false);
        return native.analyzeMerchantIntelligence(input);
      }},
    });
    await expect(service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });
  it('does not turn schedule display rights or a ledger payee into raw schedule authority', async () => {
    fixture.grant('budget',fixture.actor.budgetId,'source',false);
    fixture.setRules([{id:'rule-schedule',stage:'post',conditionsOp:'and',conditions:[],actions:[]}]);
    fixture.grant('rule','rule-schedule','rule:view');
    fixture.grant('evidence','merchant:schedule:schedule-market','normalized-evidence');
    vi.spyOn(fixture.client,'getSchedules').mockResolvedValue([{
      id:'schedule-market',name:'PRIVATE-SCHEDULE-SOURCE',posts_transaction:false,completed:false,
      payee:payeeId,account:accountId,rule:'rule-schedule',amountOp:'is',amount:-100,
      date:'2026-10-05',next_date:'2026-10-05',
    }]);
    const result = await fixture.service.analyze(fixture.actor);
    expect(result.scheduledExpectations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SCHEDULE-SOURCE');
  });
  it.each([
    { amountOp: 'is', amount: -100000 },
    { amountOp: 'isbetween', amount: { num1: -200000, num2: -100000 } },
  ] as const)('admits complete schedule Money against current financial ceilings: %j', async (amount) => {
    fixture.setRows([]);
    fixture.grant('evidence', 'merchant:schedule:schedule-money', 'normalized-evidence');
    vi.spyOn(fixture.client, 'getSchedules').mockResolvedValue([{
      id: 'schedule-money', name: 'Scheduled outgoing obligation', posts_transaction: false, completed: false,
      payee: payeeId, account: accountId, ...amount, date: '2026-10-05', next_date: '2026-10-05',
    }]);
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }],
    });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });
  it('counts every disclosed schedule even when its ledger account has no transactions', async () => {
    fixture.setRows([]);
    vi.spyOn(fixture.client, 'getSchedules').mockResolvedValue(['schedule-count-a', 'schedule-count-b'].map((id) => ({
      id, name: id, posts_transaction: false, completed: false, payee: payeeId, account: accountId,
      amountOp: 'is', amount: -100, date: '2026-10-05', next_date: '2026-10-05',
    })));
    for (const id of ['schedule-count-a', 'schedule-count-b']) fixture.grant('evidence', `merchant:schedule:${id}`, 'normalized-evidence');
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, { maxOperationCount: 1 });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });
  it.each([
    { amount: { num1: -200000, num2: -100000 }, cap: '199999', allowed: false },
    { amount: { num1: -200000, num2: -100000 }, cap: '200000', allowed: true },
    { amount: { num1: -1000, num2: 100000 }, cap: '999', allowed: false },
    { amount: { num1: -1000, num2: 100000 }, cap: '1000', allowed: true },
    { amount: null, cap: '0', allowed: true },
    { amount: 0, cap: '0', allowed: true },
  ])('bounds admitted schedule source by its largest possible outgoing amount without disclosing Money: %j', async ({ amount, cap, allowed }) => {
    fixture.setRows([]);
    fixture.grant('evidence', 'merchant:schedule:schedule-bound', 'normalized-evidence');
    vi.spyOn(fixture.client, 'getSchedules').mockResolvedValue([{
      id: 'schedule-bound', name: 'Bounded schedule', posts_transaction: false, completed: false,
      payee: payeeId, account: accountId, amountOp: typeof amount === 'object' && amount !== null ? 'isbetween' : 'is',
      amount, date: '2026-10-05', next_date: '2026-10-05',
    }]);
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxOperationCount: 2, maxGrossOutgoing: [{ currency: 'USD', minorUnits: cap }],
    });
    const result = fixture.service.withAnalysis(fixture.actor, {}, (view, _source, authorize) => {
      if (!authorize([])) throw new Error('Merchant operation is not authorized');
      return view.scheduledExpectations.map((row) => row.id);
    });
    if (allowed) expect(await result).toEqual(['schedule-bound']);
    else await expect(result).rejects.toThrow('Merchant operation is not authorized');
  });
  it.each([
    { cap: '299999', count: 3, allowed: false },
    { cap: '300000', count: 2, allowed: false },
    { cap: '300000', count: 3, allowed: true },
  ])('independently fences the complete returned schedule Money manifest: %j', async ({ cap, count, allowed }) => {
    fixture.setRows([]);
    fixture.grant('evidence', 'merchant:schedule:schedule-bound', 'normalized-evidence');
    vi.spyOn(fixture.client, 'getSchedules').mockResolvedValue([{
      id: 'schedule-bound', name: 'Bounded schedule', posts_transaction: false, completed: false,
      payee: payeeId, account: accountId, amountOp: 'isbetween',
      amount: { num1: -200000, num2: -100000 }, date: '2026-10-05', next_date: '2026-10-05',
    }]);
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxOperationCount: count, maxGrossOutgoing: [{ currency: 'USD', minorUnits: cap }],
    });
    const result = fixture.service.analyze(fixture.actor);
    if (allowed) expect((await result).scheduledExpectations.map((row) => row.id)).toEqual(['schedule-bound']);
    else await expect(result).rejects.toThrow('Merchant operation is not authorized');
  });
  it.each([250000, 1])('counts complete split economic leaves once under Money and operation caps at source cap %s', async (maxTransactions) => {
    const children = [
      transaction({ id: 'tx-split-sixty', amount: -60, is_child: true, parent_id: 'tx-split-parent' }),
      transaction({ id: 'tx-split-forty', amount: -40, is_child: true, parent_id: 'tx-split-parent' }),
    ];
    fixture.setRows([transaction({ id: 'tx-split-parent', amount: -100, is_parent: true, subtransactions: children }), ...children]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ minorUnits: '100', currency: 'USD' }], maxOperationCount: 3,
    });
    const service = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native,
      clock: () => new Date(now), maxTransactions });
    const output = await service.analyze(fixture.actor);
    expect(output.localReview.uncategorizedCount).toBe(maxTransactions === 1 ? 0 : 2);
    expect(output.localReview.totalUncategorizedAmount).toEqual({ minorUnits: maxTransactions === 1 ? '0' : '100', currency: 'USD' });
    expect(output.sourceAdmission).toMatchObject({ originalTransactionCount: 3, truncatedCount: maxTransactions === 1 ? 3 : 0 });
    await expect(service.withAnalysis(fixture.actor, {}, async (view, _source, authorize) => {
      await Promise.resolve();
      fixture.grant('transaction', 'tx-split-parent', 'transaction.view', false);
      expect(authorize()).toBe(false);
      return view.localReview;
    })).rejects.toThrow('Merchant operation is not authorized');
  });

  it('does not use incomplete split metadata to undercount the authorized source Money envelope', async () => {
    fixture.setRows([
      transaction({ id: 'tx-incomplete-parent', amount: -100, is_parent: true }),
      transaction({ id: 'tx-incomplete-child', amount: -60, is_child: true, parent_id: 'tx-incomplete-parent' }),
    ]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ minorUnits: '100', currency: 'USD' }],
    });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ minorUnits: '160', currency: 'USD' }],
    });
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.localReview.candidates.map((item) => item.transactionId)).toEqual(['tx-incomplete-child']);
    expect(output.sourceAdmission.originalTransactionCount).toBe(2);
  });
  it('projects current exact scoped alias decisions per subject without exposing private decisions or revoked source records', async () => {
    const value = await suggestion();
    const accepted = await fixture.service.confirm(fixture.actor,alias(value));
    expect((await fixture.service.analyze(fixture.actor)).suggestions.find((item) => item.transactionId === candidateId)).toMatchObject({
      aliasDecisions:[{ id:accepted.id,sourceField:'importedPayee',targetPayeeId:payeeId,accountId,
        state:'accepted',version:1,updatedAt:now,visibility:'private' }],
    });
    const other = await fixture.addMember('decision-observer');
    fixture.grantSources(other);
    expect((await fixture.service.analyze(other)).suggestions.find((item) => item.transactionId === candidateId)).toMatchObject({ aliasDecisions:[] });
    fixture.grant('transaction',candidateId,'source',false);
    expect((await fixture.service.analyze(fixture.actor)).suggestions.find((item) => item.transactionId === candidateId)).toMatchObject({ aliasDecisions:[] });
  });
  it('projects current exact scoped pattern decisions alongside their observed recurrence only', async () => {
    const observed = fixture.admitPatternGrants().recurrences[0]!;
    const current = (await fixture.service.analyze(fixture.actor)).recurrences.find((item) => item.id === observed.id)!;
    const rejected = await fixture.service.reject(fixture.actor,{ id:'pattern-projection',kind:'pattern',patternId:current.id,
      evidenceKey:current.evidenceKey,evidenceRevision:current.evidenceRevision,expectedVersion:0,visibility:'private' });
    expect((await fixture.service.analyze(fixture.actor)).recurrences.find((item) => item.id === observed.id)).toMatchObject({
      patternDecisions:[{ id:rejected.id,patternId:observed.id,state:'rejected',version:1,updatedAt:now,visibility:'private' }],
    });
  });
  it('projects authoritative source availability, exact signed Money and stable native payee IDs without SDK-only fields', async () => {
    const result = await fixture.service.analyze(fixture.actor);
    const selected = result.suggestions.find((value) => value.transactionId === candidateId);
    expect(selected).toMatchObject({ sourceTransaction: {
      id:candidateId,accountId,payeeId,categoryId:null,date:'2026-09-04',
      amount:{ minorUnits:'-100',currency:'USD' },
      importedPayee:{ state:'present',value:transaction().imported_payee },
      notes:{ state:'present',value:'PRIVATE-NOTE-DO-NOT-PUBLISH' },
      description:{ state:'unsupported',value:null },verboseTitle:{ state:'unsupported',value:null },
    } });
    expect(result).toMatchObject({ normalizationVersion:'merchant/2',asOfDate:'2026-10-04',
      payees:expect.arrayContaining([expect.objectContaining({ id:payeeId,name:expect.any(String) })]) });
    expect(JSON.stringify(selected)).not.toContain(transaction().imported_id!);
    expect(JSON.stringify(selected)).not.toContain('"sourceRefs"');
  });
  it('distinguishes unavailable raw source from supported empty and absent values in authorized public projection', async () => {
    fixture.setRows(fixture.rows().map((row) => row.id === candidateId ? transaction({ imported_payee:'',notes:null }) : row));
    const available = await fixture.service.analyze(fixture.actor);
    expect(available.suggestions.find((value) => value.transactionId === candidateId)).toMatchObject({
      sourceTransaction:{ importedPayee:{ state:'empty',value:'' },notes:{ state:'absent',value:null } },
    });
    fixture.grant('account',accountId,'source',false);
    const denied = await fixture.service.analyze(fixture.actor);
    expect(denied.suggestions.find((value) => value.transactionId === candidateId)).toMatchObject({
      sourceTransaction:{ importedPayee:{ state:'unavailable',value:null },notes:{ state:'unavailable',value:null } },
    });
    expect(JSON.stringify(denied)).not.toContain('PRIVATE-NOTE-DO-NOT-PUBLISH');
  });
  it('composes real lazy native analysis over the caller-owned source admission and SQLite store', async () => {
    const service = await createMerchantIntelligenceService({ store:fixture.store,connectionManager:fixture.manager,clock:()=>new Date(now) });
    const result = await service.analyze(fixture.actor);
    expect(result.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId:candidateId,categoryId,tier:'inferred' })]));
    expect(result.sourceAdmission.sourceAccountIds).toEqual([accountId]);
    expect(fixture.client.sync).not.toHaveBeenCalled();
    expect(fixture.client.getTransactions).not.toHaveBeenCalledWith(privateAccountId,expect.anything(),expect.anything());
  });
  it('keeps configured ledger currency independent of policy billing currency, including an empty admitted source', async () => {
    await fixture.cleanup();
    fixture = await merchantFixture({ currency: 'JPY' });
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: { ...localPolicy, billingCurrency: 'KWD' } });
    const source = await fixture.service.analyze(fixture.actor);
    expect(source.localReview.totalUncategorizedAmount).toEqual({ minorUnits:'100',currency:'JPY' });
    expect(source.localReview.candidates.every((candidate) => candidate.amount.currency === 'JPY')).toBe(true);
    fixture.setRows([]);
    expect((await fixture.service.analyze(fixture.actor)).localReview.totalUncategorizedAmount).toEqual({ minorUnits:'0',currency:'JPY' });
  });
  it('uses real native history inference over admitted Actual source and a bounded typed page', async () => {
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.scope).toEqual({ spaceId: fixture.actor.spaceId, budgetId: fixture.actor.budgetId, connectionId: merchantConnectionId({ serverUrl: 'https://actual.fixture.test/base', budgetId: fixture.actor.budgetId }) });
    expect(output.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ transactionId: candidateId, categoryId, tier: 'inferred', supportCount: 3, evidenceKey: evidenceKey(candidateId) })]));
    expect(output.sourceAdmission.sourceAccountIds).toEqual([accountId]);
    expect(output.suggestionPage).toEqual({ eligibleCandidates: 1, returned: 1, nextCursor: null });
    expect(fixture.client.getTransactions).not.toHaveBeenCalledWith(privateAccountId, expect.anything(), expect.anything());
  });
  it.each(['auth', 'spaceId', 'budgetId', 'connectionId', 'sourceRefs', 'visibilityHash', 'actorId'])('never admits body-controlled authority field %s', async (key) => {
    await expect(fixture.service.analyze(fixture.actor, { [key]: 'forged' })).rejects.toThrow();
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('requires operational authentication before SDK reads, including when legacy grants exist', async () => {
    const { auth: ignored, ...legacy } = fixture.actor;
    void ignored;
    await expect(fixture.service.analyze(legacy as MerchantActor)).rejects.toThrow();
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('rejects mismatched verified principal and actor before capture', async () => {
    await expect(fixture.service.analyze({ ...fixture.actor, auth: humanAuth('other') })).rejects.toThrow();
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it.each(['é'.repeat(129),'a'.repeat(257)])('rejects oversized native decision identifiers before source I/O', async (id) => {
    await expect(fixture.service.confirm(fixture.actor, {
      id,kind:'alias',evidenceKey:evidenceKey(candidateId),evidenceRevision:'revision',expectedVersion:0,
      visibility:'private',transactionId:candidateId,sourceField:'payeeName',targetPayeeId:payeeId,accountId,
    })).rejects.toThrow('Invalid merchant request');
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('rejects revoked membership despite unchanged actor and broad legacy observe right', async () => {
    fixture.store.governance.revokeMembership({ spaceId: fixture.actor.spaceId, membershipId: fixture.actor.membershipId!, now, auth: humanAuth('holder') });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow();
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('rejects a stale selected governance-policy version rather than silently upgrading actor authority', async () => {
    fixture.store.governance.setPolicy({ spaceId: fixture.actor.spaceId, expectedVersion: fixture.actor.governancePolicyVersion!,
      policy: { minimumApprovers: 2 }, now, auth: humanAuth('holder') });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow();
    expect(fixture.client.getTransactions).not.toHaveBeenCalled();
  });
  it('rechecks revoked membership inside final SQLite publication after source I/O', async () => {
    fixture.onRead(() => {
      fixture.onRead(null);
      fixture.store.governance.revokeMembership({ spaceId: fixture.actor.spaceId, membershipId: fixture.actor.membershipId!, now, auth: humanAuth('holder') });
    });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow();
  });
  it('refreshes server clock instead of accepting stale client actor.now for human control', async () => {
    const value = await suggestion();
    fixture.setClock('2026-10-04T12:20:00.000Z');
    await expect(fixture.service.confirm(fixture.actor, alias(value))).rejects.toThrow();
  });
  it('locks expected selected budget and refuses a queued configuration replacement', async () => {
    const spy = vi.spyOn(fixture.manager, 'withConnection');
    await fixture.service.analyze(fixture.actor);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ expectedBudgetId: fixture.actor.budgetId }));
    fixture.setConfig('https://actual.fixture.test/base', 'replacement-budget');
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow();
  });
  it('sends one complete typed resource closure and payload operations, not per-row limit evasions', async () => {
    const authorization = vi.spyOn(fixture.store.governance, 'authorize');
    await fixture.service.analyze(fixture.actor);
    const complete = authorization.mock.calls.map(([request]) => request).find((request) => request.required.some((resource) => resource.resourceKind === 'transaction' && resource.resourceId === 'tx-history-3') && request.required.some((resource) => resource.resourceKind === 'transaction' && resource.resourceId === candidateId));
    expect(complete).toBeDefined();
    expect(complete!.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceKind: 'budget', resourceId: fixture.actor.budgetId, capability: 'merchant:analyze', visibility: 'resource' }),
      expect.objectContaining({ resourceKind: 'account', resourceId: accountId, capability: 'history', visibility: 'resource' }),
      expect.objectContaining({ resourceKind: 'transaction', resourceId: candidateId, capability: 'transaction.view', visibility: 'resource' }),
      expect.objectContaining({ resourceKind: 'category', resourceId: categoryId, capability: 'name', visibility: 'resource' }),
    ]));
    expect(complete!.payload.operations.length).toBeGreaterThanOrEqual(4);
    expect(complete!.verifiedHumanApproval).toBeUndefined();
  });
  it('cannot evade a whole-operation maxOperationCount restriction by checking observations independently', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, { maxOperationCount: 1 });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow();
  });
});

describe('complete source closure and view isolation', () => {
  it('fences supported empty or absent raw availability after source revocation, not only present raw text', async () => {
    fixture.setRows(fixture.rows().map((row)=>({...row,imported_id:null,imported_payee:'',notes:null})));
    fixture.onRead(()=>{fixture.onRead(null);fixture.grant('account',accountId,'source',false);});
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });
  it('does not expose unrelated SDK payee identity or resolve matching bank text without an unrestricted payee namespace grant', async () => {
    const catalog=await fixture.client.getPayees();
    const hidden={id:'payee-private-catalog',name:'Private Catalog Merchant',transfer_acct:null};
    vi.mocked(fixture.client.getPayees).mockResolvedValue([...catalog,hidden]);
    fixture.setRows(fixture.rows().map((row)=>row.id===candidateId?transaction({payee:null,imported_payee:hidden.name}):row));
    fixture.grant('budget',fixture.actor.budgetId,'source',false);
    const restricted=await fixture.service.analyze(fixture.actor);
    expect(restricted.suggestions.find((item)=>item.transactionId===candidateId)?.payeeId).toBeNull();
    expect(restricted.payees.some((item)=>item.id===hidden.id)).toBe(false);
    expect(restricted.sourceAdmission.collections.payees).not.toBe('complete');
    fixture.grant('budget',fixture.actor.budgetId,'source');
    const unrestricted=await fixture.service.analyze(fixture.actor);
    expect(unrestricted.suggestions.find((item)=>item.transactionId===candidateId)?.payeeId).toBe(hidden.id);
    expect(unrestricted.payees).toContainEqual({id:hidden.id,name:hidden.name});
  });
  it('abstains without unrestricted full rule-namespace visibility and restores inference only after an explicit grant', async () => {
    fixture.grant('budget', fixture.actor.budgetId, 'rule:view', false);
    const denied = await fixture.service.analyze(fixture.actor);
    expect(denied.sourceAdmission.collections.rules).not.toBe('complete');
    expect(denied.suggestions.every((value) => value.categoryId === null)).toBe(true);
    fixture.grant('budget', fixture.actor.budgetId, 'rule:view', true, fixture.actor, { accountIds: [accountId] });
    const narrow = await fixture.service.analyze(fixture.actor);
    expect(narrow.sourceAdmission.collections.rules).not.toBe('complete');
    expect(narrow.suggestions.every((value) => value.categoryId === null)).toBe(true);
    fixture.grant('budget', fixture.actor.budgetId, 'rule:view');
    const admitted = await fixture.service.analyze(fixture.actor);
    expect(admitted.sourceAdmission.collections.rules).toBe('complete');
    expect(admitted.suggestions.find((value) => value.transactionId === candidateId)?.categoryId).toBe(categoryId);
  });
  it('recomputes from permitted history after a nonsampled contributor loses transaction.view', async () => {
    expect((await suggestion()).categoryId).toBe(categoryId);
    fixture.grant('transaction', 'tx-history-3', 'transaction.view', false);
    const output = await fixture.service.analyze(fixture.actor);
    const next = output.suggestions.find((value) => value.transactionId === candidateId);
    expect(next?.categoryId ?? null).toBeNull();
    expect(next?.supportCount ?? 0).toBeLessThan(3);
    expect(JSON.stringify(output)).not.toContain('tx-history-3');
  });
  it('does not derive, disclose, or persist inaccessible account histories', async () => {
    fixture.setRows([...fixture.rows(), transaction({ id: 'PRIVATE-TRANSACTION', account: privateAccountId, notes: 'PRIVATE-DEPENDENCY' })]);
    const output = await fixture.service.analyze(fixture.actor);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE-TRANSACTION|PRIVATE-DEPENDENCY|PRIVATE-ACCOUNT|account-private/);
    expect(output.coverage.inputCount).toBe(4);
  });
  it('hides raw text and notes without source grants while preserving ordinary native localReview', async () => {
    fixture.grant('account', accountId, 'source', false);
    for (const row of fixture.rows()) fixture.grant('transaction', row.id, 'source', false);
    const output = await fixture.service.analyze(fixture.actor);
    expect(JSON.stringify(output)).not.toContain('PRIVATE-NOTE-DO-NOT-PUBLISH');
    expect(output.suggestions.flatMap((value) => [...value.evidence, ...value.contradictions]).filter((value) => value.field !== 'payeeName').every((value) => value.rawText === null)).toBe(true);
    expect(output.localReview.candidates.some((value) => value.transactionId === candidateId)).toBe(true);
  });
  it('keeps native Review when account source alone is revoked despite transaction source grants', async () => {
    fixture.grant('account', accountId, 'source', false);
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.localReview.candidates.some((value) => value.transactionId === candidateId)).toBe(true);
    expect(JSON.stringify(output)).not.toContain('PRIVATE-NOTE-DO-NOT-PUBLISH');
    expect(output.suggestions.flatMap((value) => value.evidence).filter((value) => value.field !== 'payeeName').every((value) => value.rawText === null)).toBe(true);
  });
  it('withholds a complete dependent suggestion when the evidence subject itself is revoked', async () => {
    await suggestion();
    fixture.grant('evidence', evidenceKey(candidateId), 'normalized-evidence', false);
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.suggestions.some((value) => value.transactionId === candidateId)).toBe(false);
    expect(output.localReview.candidates.some((value) => value.transactionId === candidateId)).toBe(true);
  });
  it('never lets another actor inherit a private alias even with all the same ledger source rights', async () => {
    const value = await suggestion();
    await fixture.service.confirm(fixture.actor, alias(value));
    const peer = await fixture.addMember('second-human');
    fixture.grantSources(peer);
    const output = await fixture.service.analyze(peer);
    expect(JSON.stringify(output)).not.toContain('alias-candidate');
    expect(output.suggestions.flatMap((candidate) => candidate.evidence).some((evidence) => evidence.kind === 'confirmed_decision')).toBe(false);
  });
  it('rejects shared alias promotion with account-restricted budget decision authority', async () => {
    const value = await suggestion();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:confirm', true, fixture.actor, { accountIds: [accountId] });
    await expect(fixture.service.confirm(fixture.actor, alias(value, { visibility: 'shared', accountId: null }))).rejects.toThrow();
    expect(fixture.client.createRule).not.toHaveBeenCalled();
  });
  it('does not treat a private source confirmation as public or shared source evidence', async () => {
    const value = await suggestion();
    const privateDecision = await fixture.service.confirm(fixture.actor, alias(value));
    expect(privateDecision.visibility.privateActorId).toBe(fixture.actor.actorId);
    expect(privateDecision.sourceRefs.transactionIds).toContain(candidateId);
    fixture.grant('transaction', candidateId, 'source', false);
    await expect(fixture.service.confirm(fixture.actor, alias(value, { expectedVersion: privateDecision.version, visibility: 'shared', accountId: null }))).rejects.toThrow();
  });
  it.each(['payees', 'categories', 'rules'] as const)('never treats unavailable %s as complete empty authoritative source', async (collection) => {
    const error = new Error('synthetic unavailable collection');
    if (collection === 'payees') vi.mocked(fixture.client.getPayees).mockRejectedValue(error);
    else if (collection === 'categories') vi.mocked(fixture.client.getCategories).mockRejectedValue(error);
    else vi.mocked(fixture.client.getRules).mockRejectedValue(error);
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.sourceAdmission.collections[collection]).toBe('unavailable');
    expect(output.suggestions.every((value) => value.categoryId === null)).toBe(true);
  });
  it('distinguishes empty available history from unavailable source collections', async () => {
    fixture.setRows([]);
    const empty = await fixture.service.analyze(fixture.actor);
    expect(empty.sourceAdmission.collections.transactions).toBe('complete');
    expect(empty.coverage.inputCount).toBe(0);
    vi.mocked(fixture.client.getTransactions).mockRejectedValue(new Error('synthetic source unavailable'));
    const unavailable = await fixture.service.analyze(fixture.actor);
    expect(unavailable.sourceAdmission.collections.transactions).toBe('unavailable');
    expect(unavailable.suggestions).toEqual([]);
    expect(unavailable.recurrences).toEqual([]);
  });
  it('reports clipped admission as limited rather than asserting complete confidence', async () => {
    const limited = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native, clock: () => new Date(now), maxTransactions: 2 });
    const output = await limited.analyze(fixture.actor);
    expect(output.sourceAdmission).toMatchObject({ originalTransactionCount: 4, truncatedCount: 2 });
    expect(output.coverage.limited).toBe(true);
    expect(output.suggestions.every((value) => value.categoryId === null)).toBe(true);
  });
});

describe('human evidence decisions remain distinct from ledger mutation', () => {
  it('confirms and rejects optimistic evidence decisions without any Actual write', async () => {
    const value = await suggestion();
    const accepted = await fixture.service.confirm(fixture.actor, alias(value));
    expect(accepted).toMatchObject({ state: 'accepted', actorId: fixture.actor.actorId, version: 1, payload: { kind: 'alias', targetPayeeId: payeeId, normalizationVersion: 'merchant/2' } });
    await expect(fixture.service.reject(fixture.actor, alias(value))).rejects.toThrow();
    const refreshed = await suggestion();
    const rejected = await fixture.service.reject(fixture.actor, alias(refreshed, { expectedVersion: 1 }));
    expect(rejected).toMatchObject({ state: 'rejected', version: 2 });
    for (const write of [fixture.client.updateTransaction, fixture.client.addTransactions, fixture.client.createRule, fixture.client.deleteRule, fixture.client.setBudgetAmount]) expect(write).not.toHaveBeenCalled();
  });
  it('rejects stale evidence even when the optimistic decision version is otherwise current', async () => {
    const value = await suggestion();
    fixture.setRows(fixture.rows().map((row) => row.id === candidateId ? { ...row, notes: 'CHANGED-EVIDENCE' } : row));
    await expect(fixture.service.confirm(fixture.actor, alias(value))).rejects.toThrow();
  });
  it.each(['session', 'stale-human', 'human-api-key', 'agent-api-key'] as const)('does not accept %s for fresh human merchant control', async (kind) => {
    const value = await suggestion();
    const auth: MerchantActor['auth'] = kind === 'session'
      ? { method: 'session', actorId: fixture.actor.actorId, sessionId: 'session:holder' }
      : kind === 'stale-human' ? humanAuth('holder', '2026-10-04T11:00:00.000Z')
      : kind === 'human-api-key' ? { method: 'api-key', actorId: 'holder', credentialId: 'human-key', credentialOwnerId: 'holder', principalType: 'human' }
      : { method: 'api-key', actorId: 'agent', credentialId: 'agent-key', credentialOwnerId: 'holder', principalType: 'agent', delegationId: 'delegation', delegationVersion: '1' };
    await expect(fixture.service.confirm({ ...fixture.actor, actorId: auth.actorId, auth }, alias(value))).rejects.toThrow();
  });
  it('commits a shared alias only with fresh human global authority and then attributes it to the confirming actor', async () => {
    const value = await suggestion();
    const accepted = await fixture.service.confirm(fixture.actor, alias(value, { visibility: 'shared', accountId: null }));
    expect(accepted.visibility.privateActorId).toBeNull();
    expect(accepted.actorId).toBe(fixture.actor.actorId);
    const peer = await fixture.addMember('second-human');
    fixture.grantSources(peer);
    const output = await fixture.service.analyze(peer);
    expect(output.suggestions.flatMap((candidate) => candidate.evidence).some((evidence) => evidence.kind === 'confirmed_decision')).toBe(true);
  });
  it('keeps shared and private aliases with one caller ID independent at equal and unequal native versions', async () => {
    const candidate = fixture.rows().find((row) => row.id === candidateId)!;
    fixture.setRows([...fixture.rows(), { ...candidate, id: 'namespace-other-account', account: privateAccountId, imported_id: 'namespace-import' }]);
    fixture.grantSources();
    await fixture.service.confirm(fixture.actor, alias(await suggestion(), { visibility: 'shared', accountId: null }));
    await fixture.service.confirm(fixture.actor, alias(await suggestion(), { visibility: 'private', accountId }));
    const equal = await suggestion();
    expect(equal.categoryId).toBe(categoryId);
    expect(equal.aliasDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'alias-candidate', visibility: 'shared', version: 1 }),
      expect.objectContaining({ id: 'alias-candidate', visibility: 'private', version: 1 }),
    ]));
    await fixture.service.confirm(fixture.actor, alias(equal, { visibility: 'private', accountId, expectedVersion: 1 }));
    const unequal = await fixture.service.analyze(fixture.actor);
    expect(unequal.suggestions.find((row) => row.transactionId === 'namespace-other-account')).toMatchObject({
      payeeId, aliasDecisions: expect.arrayContaining([expect.objectContaining({ id: 'alias-candidate', visibility: 'shared', version: 1 })]),
    });
    const peer = await fixture.addMember('namespace-peer'); fixture.grantSources(peer);
    const peerValue = (await fixture.service.analyze(peer)).suggestions.find((row) => row.transactionId === candidateId)!;
    expect(peerValue.aliasDecisions).toEqual([expect.objectContaining({ id: 'alias-candidate', visibility: 'shared', version: 1 })]);
    expect(peerValue.evidence.filter((value) => value.kind === 'confirmed_decision').map((value) => value.sourceId)).toContain('alias-candidate');
  });
  it('keeps shared and private pattern decisions with one caller ID independently attributable', async () => {
    fixture.admitPatternGrants();
    const pattern = (await fixture.service.analyze(fixture.actor)).recurrences[0]!;
    await fixture.service.reject(fixture.actor, { id: 'pattern-overlap', kind: 'pattern', patternId: pattern.id,
      evidenceKey: pattern.evidenceKey, evidenceRevision: pattern.evidenceRevision, expectedVersion: 0, visibility: 'shared' });
    const refreshed = (await fixture.service.analyze(fixture.actor)).recurrences.find((row) => row.id === pattern.id)!;
    await fixture.service.confirm(fixture.actor, { id: 'pattern-overlap', kind: 'pattern', patternId: refreshed.id,
      evidenceKey: refreshed.evidenceKey, evidenceRevision: refreshed.evidenceRevision, expectedVersion: 0, visibility: 'private' });
    const result = (await fixture.service.analyze(fixture.actor)).recurrences.find((row) => row.id === pattern.id)!;
    expect(result.patternDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pattern-overlap', visibility: 'shared', state: 'rejected', version: 1 }),
      expect.objectContaining({ id: 'pattern-overlap', visibility: 'private', state: 'accepted', version: 1 }),
    ]));
  });
  it('denies decision publication when a full source dependency is revoked during recapture', async () => {
    const value = await suggestion();
    fixture.onRead(() => { fixture.onRead(null); fixture.grant('transaction', 'tx-history-3', 'transaction.view', false); });
    await expect(fixture.service.confirm(fixture.actor, alias(value))).rejects.toThrow();
    expect(fixture.client.updateTransaction).not.toHaveBeenCalled();
  });
  it('keeps recurrence rejection after new evidence adds a later source occurrence', async () => {
    fixture.admitPatternGrants();
    const output = await fixture.service.analyze(fixture.actor);
    const pattern = output.recurrences[0];
    expect(pattern).toBeDefined();
    await fixture.service.reject(fixture.actor, { id: 'pattern-rejection', kind: 'pattern', patternId: pattern!.id, evidenceKey: pattern!.evidenceKey, evidenceRevision: pattern!.evidenceRevision, expectedVersion: 0, visibility: 'private' });
    const next = transaction({ id: 'tx-history-4', date: '2026-10-04', category: categoryId });
    fixture.setRows([...fixture.rows(), next]); fixture.grantSources();
    const refreshed = await fixture.service.analyze(fixture.actor);
    expect(refreshed.recurrences.find((value) => value.id === pattern!.id)).toMatchObject({ decisionState: 'rejected', reasonCodes: expect.arrayContaining(['pattern_rejected']), patternDecisions:expect.arrayContaining([expect.objectContaining({id:'pattern-rejection',patternId:pattern!.id,state:'rejected',version:1,visibility:'private'})]) });
  });
});

describe('policy, calendar, export and lifecycle authority', () => {
  it('defaults to local-only and never needs a provider to complete local analysis', async () => {
    expect(await fixture.service.policy(fixture.actor)).toMatchObject({ value: localPolicy, version: 0 });
    expect((await fixture.service.analyze(fixture.actor)).localReview.candidates).not.toHaveLength(0);
  });
  it('persists policy with optimistic version and fresh human authority', async () => {
    const current = await fixture.service.policy(fixture.actor);
    const saved = await fixture.service.setPolicy(fixture.actor, { expectedVersion: current.version, value: { ...localPolicy, mode: 'disabled' } });
    expect(saved).toMatchObject({ version: 1, generation: current.generation + 1, value: { mode: 'disabled' } });
    await expect(fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: localPolicy })).rejects.toThrow();
    expect((await fixture.service.analyze(fixture.actor)).localReview.candidates.some((value) => value.transactionId === candidateId)).toBe(true);
  });
  it('does not infer policy management from merchant observe authority', async () => {
    fixture.grant('space', fixture.actor.spaceId, 'policy:manage', false);
    await expect(fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: localPolicy })).rejects.toThrow();
  });
  it('reads calendars only from persisted authorized policy, never lookup body selections', async () => {
    expect(await fixture.service.calendar(fixture.actor, { accountId, year: 2026 }))
      .toEqual({ state: 'unknown', calendar: null, reasonCodes: ['calendar_unknown'] });
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: { ...localPolicy,
      calendar: { budget: { jurisdiction: 'US', subdivision: null, timeZone: 'America/New_York' }, accounts: [] } } });
    expect(await fixture.service.calendar(fixture.actor, { accountId, year: 2026 }))
      .toMatchObject({ state: 'known', calendar: { jurisdiction: 'US', accountId: null } });
    await expect(fixture.service.calendar(fixture.actor, { accountId, year: 2026, budget: null, accounts: [] })).rejects.toThrow();
    expect(await fixture.service.calendar(fixture.actor, { accountId, year: 2036 }))
      .toEqual({ state: 'unknown', calendar: null, reasonCodes: ['calendar_unknown'] });
    fixture.grant('account', accountId, 'policy', false);
    await expect(fixture.service.calendar(fixture.actor, { accountId, year: 2026 })).rejects.toThrow();
  });
  it.each([null, { jurisdiction: 'JP', subdivision: null, timeZone: 'Asia/Tokyo' }])('keeps an unknown account calendar override out of inherited holiday evidence: %j', async (selection) => {
    const rows = [accountId, privateAccountId].flatMap((account) =>
      ['2026-06-01', '2026-07-01', '2026-08-03'].map((date, index) =>
        transaction({ id: `${account}-calendar-${index}`, account, date, category: categoryId })));
    fixture.setRows(rows);
    fixture.grantSources();
    fixture.admitPatternGrants();
    fixture.grant('account', privateAccountId, 'policy');
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: { ...localPolicy,
      calendar: { budget: { jurisdiction: 'US', subdivision: null, timeZone: 'America/New_York' },
        accounts: [{ accountId: privateAccountId, selection }] } } });
    const result = await fixture.service.analyze(fixture.actor);
    expect(result.recurrences.find((row) => row.accountId === accountId)?.calendarVersion)
      .toBe('python-holidays/0.105:public:observed:2020-2035');
    expect(result.recurrences.find((row) => row.accountId === privateAccountId))
      .toMatchObject({ calendarVersion: null, reasonCodes: expect.arrayContaining(['calendar_unknown']) });
  });
  it('requires full account configuration authority and does not overwrite hidden overrides', async () => {
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: { ...localPolicy,
      calendar: { budget: null, accounts: [{ accountId, selection: { jurisdiction: 'CA', subdivision: 'ON', timeZone: 'America/Toronto' } }] } } });
    fixture.grant('account', accountId, 'policy', false);
    await expect(fixture.service.setPolicy(fixture.actor, { expectedVersion: 1, value: localPolicy })).rejects.toThrow();
    fixture.grant('account', accountId, 'policy');
    expect((await fixture.service.policy(fixture.actor)).value.calendar?.accounts).toHaveLength(1);
  });
  it('denies export of persisted calendar overrides hidden by revoked account policy visibility', async () => {
    fixture.grant('account',privateAccountId,'existence');
    fixture.grant('account',privateAccountId,'policy');
    await fixture.service.setPolicy(fixture.actor,{ expectedVersion:0,value:{ ...localPolicy,
      calendar:{ budget:null,accounts:[{ accountId:privateAccountId,selection:{ jurisdiction:'CA',subdivision:'ON',timeZone:'America/Toronto' } }] },
    } });
    fixture.grant('account',privateAccountId,'policy',false);
    await expect(fixture.service.export(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });
  it('export requires its own named capability and reprojects revoked contributing sources', async () => {
    const value = await suggestion();
    await fixture.service.confirm(fixture.actor, alias(value));
    const exported = await fixture.service.export(fixture.actor);
    expect(exported.decisions).toHaveLength(1);
    fixture.grant('transaction', candidateId, 'source', false);
    expect((await fixture.service.export(fixture.actor)).decisions).toEqual([]);
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:export', false);
    await expect(fixture.service.export(fixture.actor)).rejects.toThrow();
  });
  it('deletion needs fresh lifecycle authority, advances generation, and cannot restore old decisions', async () => {
    const value = await suggestion();
    await fixture.service.confirm(fixture.actor, alias(value));
    fixture.grant('budget', fixture.actor.budgetId, 'lifecycle:delete', false);
    await expect(fixture.service.delete(fixture.actor)).rejects.toThrow();
    fixture.grant('budget', fixture.actor.budgetId, 'lifecycle:delete');
    const old = await fixture.service.policy(fixture.actor);
    const deleted = await fixture.service.delete(fixture.actor);
    expect(deleted.generation).toBeGreaterThan(old.generation);
    expect((await fixture.service.export(fixture.actor)).decisions).toEqual([]);
  });
  it('deletes historical connection namespaces for the selected budget, not only its current origin', async () => {
    const first = await suggestion();
    await fixture.service.confirm(fixture.actor, alias(first));
    expect((await fixture.service.export(fixture.actor)).decisions).toHaveLength(1);
    fixture.setConfig('https://replacement.fixture.test/base');
    const replacement = await suggestion();
    await fixture.service.confirm(fixture.actor, alias(replacement));
    await fixture.service.delete(fixture.actor);
    fixture.setConfig('https://actual.fixture.test/base');
    expect((await fixture.service.export(fixture.actor)).decisions).toEqual([]);
  });
  it.each([
    ['merchant:delete', { accountIds: [accountId] }],
    ['lifecycle:delete', { categoryIds: [categoryId] }],
    ['merchant:delete', { aggregateOnly: true }],
    ['merchant:delete', { maxOperationCount: 0 }],
    ['lifecycle:delete', { maxOperationCount: 0 }],
  ] as const)('does not expand a restricted %s grant into whole-budget deletion', async (capability, restrictions) => {
    const value = await suggestion();
    await fixture.service.confirm(fixture.actor, alias(value));
    fixture.grant('budget', fixture.actor.budgetId, capability, true, fixture.actor, { ...restrictions,
      ...('accountIds' in restrictions ? { accountIds: [...restrictions.accountIds] } : {}),
      ...('categoryIds' in restrictions ? { categoryIds: [...restrictions.categoryIds] } : {}),
    });
    await expect(fixture.service.delete(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
    expect((await fixture.service.export(fixture.actor)).decisions).toHaveLength(1);
  });
  it('admits one explicit whole-budget deletion under count-one control grants', async () => {
    await fixture.service.confirm(fixture.actor, alias(await suggestion()));
    for (const capability of ['merchant:delete', 'lifecycle:delete']) fixture.grant('budget', fixture.actor.budgetId, capability, true, fixture.actor, { maxOperationCount: 1 });
    await fixture.service.delete(fixture.actor);
    expect((await fixture.service.export(fixture.actor)).decisions).toEqual([]);
  });
});

describe('trusted current rule review context under execution lock', () => {
  beforeEach(() => {
    for (const capability of ['existence','history','name','source']) fixture.grant('account',privateAccountId,capability);
  });
  it('rejects unavailable native-rule reads instead of simulating an authoritative empty rule set', async () => {
    vi.mocked(fixture.client.getRules).mockRejectedValue(new Error('offline SDK rule read'));
    await expect(resolve(null)).rejects.toThrow('Current rule planning source is incomplete');
    expect(fixture.client.createRule).not.toHaveBeenCalled();
  });
  it('rejects unavailable closed-account history instead of omitting its future rule effects', async () => {
    const accounts = await fixture.client.getAccounts();
    vi.mocked(fixture.client.getAccounts).mockResolvedValue(accounts.map((account) => account.id === privateAccountId ? {...account,closed:true} : account));
    vi.mocked(fixture.client.getTransactions).mockImplementation(async (id) => {
      if (id === privateAccountId) throw new Error('offline closed-account history');
      return fixture.rows().filter((row) => row.account === id);
    });
    await expect(resolve(null)).rejects.toThrow('Current rule planning source is incomplete');
    expect(fixture.client.createRule).not.toHaveBeenCalled();
  });
  it('rejects a direct context when the full trusted SDK snapshot contains an unauthorized transaction outside the merchant horizon', async () => {
    const older = transaction({id:'tx-before-horizon',date:'2020-01-01',category:categoryId});
    fixture.setRows([...fixture.rows(),older]);
    fixture.grantSources();
    fixture.grant('transaction',older.id,'transaction.view',false);
    await expect(resolve(null)).rejects.toThrow('Merchant operation is not authorized');
  });
  it('binds direct settings to actor-neutral complete authorized source so an equivalent different human obtains the same context', async () => {
    const other = await fixture.addMember('coapprover');
    fixture.grantSources(other);
    for (const capability of ['existence','history','name','source']) fixture.grant('account',privateAccountId,capability,true,other);
    const first = await resolve(null);
    const second = await resolve(null,other);
    expect(second).toEqual(first);
    expect(first.evidenceKey).toBeNull();
  });
  it('returns current scoped evidence/policy/facts/visibility rather than caller context', async () => {
    const value = await suggestion();
    expect(await resolve(value.evidenceKey)).toEqual(value.reviewContext);
    expect(await resolve(null)).toMatchObject({scope:value.reviewContext.scope,evidenceKey:null});
  });
  it('rejects unavailable evidence keys', async () => {
    await expect(resolve('merchant:transaction:missing')).rejects.toThrow();
  });
  it('invalidates evidence on merchant policy generation replacement', async () => {
    const value = await suggestion();
    await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: { ...localPolicy, mode: 'disabled' } });
    await expect(resolve(value.evidenceKey)).rejects.toThrow();
  });
  it('rechecks full source closure, including nonsampled contributors', async () => {
    const value = await suggestion();
    fixture.grant('transaction', 'tx-history-3', 'transaction.view', false);
    await expect(resolve(value.evidenceKey)).rejects.toThrow();
  });
});

describe('real governed API principals', () => {
  it('allows verified human API reads, then catches credential revocation without accepting a fabricated auth body', async () => {
    fixture.grant('space', fixture.actor.spaceId, 'credential:manage');
    fixture.store.governance.registerCredentialBinding({
      spaceId: fixture.actor.spaceId, credentialId: 'human-key', credentialOwnerId: 'holder',
      principalType: 'human', principalId: 'holder', now, auth: humanAuth('holder'),
    });
    const actor: MerchantActor = { ...fixture.actor, auth: { method: 'api-key', actorId: 'holder', credentialId: 'human-key', credentialOwnerId: 'holder', principalType: 'human' } };
    expect((await fixture.service.analyze(actor)).suggestions.some((value) => value.transactionId === candidateId)).toBe(true);
    fixture.store.governance.revokeCredentialBinding({ spaceId: actor.spaceId, credentialId: 'human-key', now, auth: humanAuth('holder') });
    await expect(fixture.service.analyze(actor)).rejects.toThrow();
  });

  it('admits only exact delegated source rights even when the issuer has a larger current source grant set', async () => {
    const privateRow = transaction({ id:'tx-private-delegation',account:privateAccountId,notes:'PRIVATE-DELEGATION' });
    const rows = [...fixture.rows(),privateRow];
    fixture.setRows(rows);
    fixture.grantSources(fixture.actor,rows);
    for (const capability of ['agent:manage','delegation:manage','credential:manage']) fixture.grant('space',fixture.actor.spaceId,capability);
    fixture.store.governance.registerAgent({ spaceId:fixture.actor.spaceId,agentId:'agent-scoped',now,auth:humanAuth('holder') });
    const readCapabilities = ['observe','merchant:analyze','existence','name','history','source','transaction.view','evidence','normalized-evidence','rule:view'];
    const rights = fixture.store.governance.listResourceGrants({ spaceId:fixture.actor.spaceId,actorId:'holder' })
      .filter((grant) => grant.granted && readCapabilities.includes(grant.capability) &&
        grant.resourceId !== privateAccountId && grant.resourceId !== privateRow.id && grant.resourceId !== evidenceKey(privateRow.id))
      .map(({ resourceKind,resourceId,capability }) => ({ resourceKind,resourceId,capability }));
    const delegation = fixture.store.governance.delegate({ spaceId:fixture.actor.spaceId,agentId:'agent-scoped',
      issuerMembershipId:fixture.actor.membershipId!,expectedVersion:null,rights,validFrom:now,validUntil:'2026-10-04T13:00:00.000Z',now,auth:humanAuth('holder') });
    fixture.store.governance.registerCredentialBinding({ spaceId:fixture.actor.spaceId,credentialId:'agent-scoped-key',
      credentialOwnerId:'holder',principalType:'agent',principalId:'agent-scoped',delegationId:delegation.id,
      expectedDelegationVersion:delegation.version,now,auth:humanAuth('holder') });
    const actor: MerchantActor = { ...fixture.actor,actorId:'agent-scoped',auth:{ method:'api-key',actorId:'agent-scoped',
      credentialId:'agent-scoped-key',credentialOwnerId:'holder',principalType:'agent',delegationId:delegation.id,delegationVersion:delegation.version } };
    const result = await fixture.service.analyze(actor);
    expect(result.sourceAdmission.sourceAccountIds).toEqual([accountId]);
    expect(result.coverage.inputCount).toBe(4);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-DELEGATION|account-private|tx-private-delegation/);
    expect(fixture.client.getTransactions).not.toHaveBeenCalledWith(privateAccountId,expect.anything(),expect.anything());
  });
  it('admits a live exact delegated agent read and denies it immediately after delegation revocation', async () => {
    for (const capability of ['agent:manage', 'delegation:manage', 'credential:manage']) fixture.grant('space', fixture.actor.spaceId, capability);
    fixture.store.governance.registerAgent({ spaceId: fixture.actor.spaceId, agentId: 'agent', now, auth: humanAuth('holder') });
    const readCapabilities = ['observe', 'merchant:analyze', 'existence', 'name', 'history', 'source', 'transaction.view', 'evidence', 'normalized-evidence', 'rule:view'];
    const rights = fixture.store.governance.listResourceGrants({ spaceId: fixture.actor.spaceId, actorId: 'holder' })
      .filter((grant) => grant.granted && readCapabilities.includes(grant.capability))
      .map(({ resourceKind, resourceId, capability }) => ({ resourceKind, resourceId, capability }));
    const delegation = fixture.store.governance.delegate({
      spaceId: fixture.actor.spaceId, agentId: 'agent', issuerMembershipId: fixture.actor.membershipId!,
      expectedVersion: null, rights, validFrom: now, validUntil: '2026-10-04T13:00:00.000Z', now, auth: humanAuth('holder'),
    });
    fixture.store.governance.registerCredentialBinding({
      spaceId: fixture.actor.spaceId, credentialId: 'agent-key', credentialOwnerId: 'holder',
      principalType: 'agent', principalId: 'agent', delegationId: delegation.id,
      expectedDelegationVersion: delegation.version, now, auth: humanAuth('holder'),
    });
    const actor: MerchantActor = { ...fixture.actor, actorId: 'agent', auth: {
      method: 'api-key', actorId: 'agent', credentialId: 'agent-key', credentialOwnerId: 'holder',
      principalType: 'agent', delegationId: delegation.id, delegationVersion: delegation.version,
    } };
    const output = await fixture.service.analyze(actor);
    expect(output.suggestions.some((value) => value.transactionId === candidateId)).toBe(true);
    fixture.store.governance.revokeDelegation({ spaceId: actor.spaceId, delegationId: delegation.id, expectedVersion: delegation.version, now, auth: humanAuth('holder') });
    await expect(fixture.service.analyze(actor)).rejects.toThrow();
  });
});
