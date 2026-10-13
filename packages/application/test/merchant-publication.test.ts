import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GovernanceAuthorizationInput, MerchantDecision, MerchantEvidence, ResourceGrantRestrictions } from '@balanceframe/workflow-store';
import { accountId, candidateId, categoryId, evidenceKey, history, merchantFixture, native, now, payeeId, transaction } from './merchant-service.fixture.js';
import type { MerchantFixture } from './merchant-service.fixture.js';
import { MerchantIntelligenceService } from '../src/merchant-service.js';
import type { ConnectedBudget, ConnectionUseOptions } from '../src/connection-manager.js';

interface InspectionDatabase { prepare(sql: string): { all(): unknown[] }; close(): void }
const Database = createRequire(createRequire(import.meta.url).resolve('@balanceframe/workflow-store'))('better-sqlite3') as new (filename: string, options: { readonly: boolean }) => InspectionDatabase;
const targetIds = [candidateId, ...Array.from({ length: 39 }, (_, index) => `tx-publication-${index + 1}`)];
let fixture: MerchantFixture;

function rows(table: 'merchant_evidence' | 'merchant_decisions'): Array<{ value: string }> {
  const database = new Database(fixture.databasePath, { readonly: true });
  try { return database.prepare(`SELECT value FROM ${table}`).all() as Array<{ value: string }>; }
  finally { database.close(); }
}

function duringCompletedConnectionShutdown(change: () => void): void {
  let completed = false;
  const withConnection = fixture.manager.withConnection.bind(fixture.manager);
  vi.spyOn(fixture.manager, 'withConnection').mockImplementation(<T>(
    consume: (connected: ConnectedBudget) => Promise<T>, options: ConnectionUseOptions = {},
  ) => withConnection(async (connected) => {
    const result = await consume(connected);
    completed = true;
    return result;
  }, { ...options, dispose: true }));
  vi.mocked(fixture.client.shutdown).mockImplementation(async () => { if (completed) change(); });
}

function targetOnlyAuthorization(): GovernanceAuthorizationInput {
  const actor = fixture.actor;
  return {
    actorId: actor.actorId, spaceId: actor.spaceId, membershipId: actor.membershipId,
    expectedPolicyVersion: actor.governancePolicyVersion!, phase: 'read', operation: 'merchant:analyze', now, auth: actor.auth,
    required: [
      { resourceKind: 'budget', resourceId: actor.budgetId, capability: 'observe', visibility: 'resource' },
      { resourceKind: 'budget', resourceId: actor.budgetId, capability: 'merchant:analyze', visibility: 'resource' },
      { resourceKind: 'budget', resourceId: actor.budgetId, capability: 'source', visibility: 'resource' },
      { resourceKind: 'budget', resourceId: actor.budgetId, capability: 'rule:view', visibility: 'resource' },
      { resourceKind: 'account', resourceId: accountId, capability: 'existence', visibility: 'resource' },
      { resourceKind: 'account', resourceId: accountId, capability: 'history', visibility: 'resource' },
      { resourceKind: 'account', resourceId: accountId, capability: 'source', visibility: 'resource' },
      { resourceKind: 'transaction', resourceId: candidateId, capability: 'transaction.view', visibility: 'resource' },
      { resourceKind: 'transaction', resourceId: candidateId, capability: 'source', visibility: 'resource' },
      { resourceKind: 'evidence', resourceId: evidenceKey(candidateId), capability: 'evidence', visibility: 'resource' },
      { resourceKind: 'evidence', resourceId: evidenceKey(candidateId), capability: 'normalized-evidence', visibility: 'resource' },
    ],
    payload: { operations: [
      { operation: 'merchant:analyze', transactionId: candidateId, accountId, direction: 'outgoing', amount: { minorUnits: '100', currency: 'USD' } },
      { operation: 'rule:view', accountScope: { kind: 'global' } },
      { operation: 'merchant:analyze', evidenceId: evidenceKey(candidateId) },
    ] },
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  fixture = await merchantFixture();
  fixture.setRows([...history().filter((row) => row.category !== null), ...targetIds.map((id) => transaction({ id }))]);
  fixture.grantSources();
});
afterEach(async () => {
  if (fixture) await fixture.cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded readonly merchant publication', () => {
  it('analyzes forty authorized canonical targets with meaningful category evidence without durable evidence rows', async () => {
    expect(rows('merchant_evidence')).toEqual([]);
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.coverage.inputCount).toBe(43);
    expect(output.sourceAdmission.collections.transactions).toBe('complete');
    expect(output.suggestionPage).toEqual({ eligibleCandidates: 40, returned: 40, nextCursor: null });
    expect(output.suggestions.map((item) => item.transactionId).sort()).toEqual([...targetIds].sort());
    for (const value of output.suggestions) {
      expect(value).toMatchObject({ categoryId, tier: 'inferred', supportCount: 3, evidenceKey: evidenceKey(value.transactionId),
        categoryHistory: { totalCount: 3, categoryCount: 1, truncated: false } });
      expect(value.categoryHistory.entries).toEqual([{ categoryId, count: 3, ledgerCount: 3, correctionCount: 0, firstDate: '2026-06-04', lastDate: '2026-08-04' }]);
      expect(value.evidenceRevision).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(output.localReview.uncategorizedCount).toBe(40);
    expect(output.localReview.totalUncategorizedAmount).toEqual({ minorUnits: '4000', currency: 'USD' });
    expect(output.localReview.candidates.every((item) => item.source === 'merchant-inferred' && item.proposedCategoryId === categoryId)).toBe(true);
    expect(rows('merchant_evidence')).toEqual([]);
    expect(rows('merchant_decisions')).toEqual([]);
  });

  it.each([
    { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '199' }] },
    { maxOperationCount: 4 },
  ])('refuses a complete outbound collection exceeding current ceilings even when its source passes: %j', async (restriction) => {
    fixture.setRows([transaction({ amount: -100 }), ...('maxOperationCount' in restriction
      ? [transaction({ id: 'tx-outbound-second', amount: -100 })] : [])]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, restriction);
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });

  it('allows the exact repeated outgoing disclosure boundary and counts the absolute derived total without inventing a ledger direction', async () => {
    fixture.setRows([transaction({ amount: -100 })]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '200' }], maxOperationCount: 3,
    });
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.suggestions[0]!.sourceTransaction.amount).toEqual({ minorUnits: '-100', currency: 'USD' });
    expect(output.localReview.candidates[0]!.amount).toEqual({ minorUnits: '100', currency: 'USD' });
    expect(output.localReview.totalUncategorizedAmount).toEqual({ minorUnits: '100', currency: 'USD' });
  });

  it('does not promote repeated incoming Money or an unsigned derived total into outgoing ledger facts', async () => {
    fixture.setRows([transaction({ amount: 100 })]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }], maxOperationCount: 3,
    });
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.suggestions[0]!.sourceTransaction.amount).toEqual({ minorUnits: '100', currency: 'USD' });
    expect(output.localReview.candidates[0]!.amount).toEqual({ minorUnits: '100', currency: 'USD' });
    expect(output.localReview.totalUncategorizedAmount).toEqual({ minorUnits: '100', currency: 'USD' });
  });

  it('counts an inferred source suggestion, its Review Money, and its embedded evidence independently without incoming netting', async () => {
    fixture.setRows([...history().filter((row) => row.category !== null).map((row) => ({ ...row, amount: -1200 })),
      transaction({ amount: -10000 })]);
    fixture.grantSources();
    const admitted = await fixture.service.analyze(fixture.actor);
    expect(admitted.suggestions[0]!.tier).toBe('inferred');
    expect(admitted.localReview.candidates[0]!.merchantEvidence?.sourceTransaction.amount)
      .toEqual({ minorUnits: '-10000', currency: 'USD' });
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '13600' }],
    });
    await expect(fixture.service.analyze(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });

  it('retains the authorized outbound manifest through an awaited consumer and rejects a later smaller ceiling', async () => {
    fixture.setRows([transaction({ amount: -100 })]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '200' }],
    });
    await expect(fixture.service.withAnalysis(fixture.actor, {}, async (view, _source, authorize) => {
      const amount = { minorUnits: '100', currency: 'USD' };
      expect(authorize([1, 2].map(() => ({ operation: 'merchant:analyze', transactionId: candidateId,
        accountId, direction: 'outgoing', amount })))).toBe(true);
      await Promise.resolve();
      fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '150' }],
      });
      return { first: view.suggestions[0]!.sourceTransaction.amount, second: view.suggestions[0]!.sourceTransaction.amount };
    })).rejects.toThrow('Merchant operation is not authorized');
  });

  it.each(['normalized-evidence', 'outbound-ceiling', 'selected-connection'] as const)(
    'refuses final disclosure when %s changes during Actual shutdown after the consumer completed', async (change) => {
      fixture.setRows([transaction({ amount: -100 })]);
      fixture.grantSources();
      fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '200' }],
      });
      let consumerCompleted = false;
      const withConnection = fixture.manager.withConnection.bind(fixture.manager);
      vi.spyOn(fixture.manager, 'withConnection').mockImplementation(<T>(
        consume: (connected: ConnectedBudget) => Promise<T>, options: ConnectionUseOptions = {},
      ) => withConnection(consume, { ...options, dispose: true }));
      vi.mocked(fixture.client.shutdown).mockImplementation(async () => {
        if (!consumerCompleted) return;
        if (change === 'normalized-evidence') fixture.grant('evidence', evidenceKey(candidateId), 'normalized-evidence', false);
        else if (change === 'outbound-ceiling') fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor, {
          maxGrossOutgoing: [{ currency: 'USD', minorUnits: '150' }],
        });
        else fixture.setConfig('https://different-actual.fixture.test/base');
      });
      await expect(fixture.service.withAnalysis(fixture.actor, {}, (view, _source, authorize) => {
        const outgoing = { operation: 'merchant:analyze', transactionId: candidateId, accountId,
          direction: 'outgoing' as const, amount: view.localReview.candidates[0]!.amount };
        expect(view.suggestions[0]!.sourceTransaction.amount).toEqual({ minorUnits: '-100', currency: 'USD' });
        expect(authorize([outgoing, outgoing])).toBe(true);
        consumerCompleted = true;
        return { source: view.suggestions[0]!.sourceTransaction.amount, review: outgoing.amount };
      })).rejects.toThrow(
        change === 'selected-connection' ? 'Merchant selected connection changed' : 'Merchant operation is not authorized');
    });

  it.each(['merchant:analyze', 'merchant:export'] as const)(
    'independently bounds the complete exported Money collection under %s', async (capability) => {
      fixture.setRows([transaction({ amount: -100 })]);
      fixture.grantSources();
      fixture.grant('budget', fixture.actor.budgetId, capability, true, fixture.actor, {
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '199' }],
      });
      await expect(fixture.service.export(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
    });

  it('counts every exported Money slot independently from source operation count', async () => {
    fixture.setRows([transaction({ amount: -100 })]);
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:export', true, fixture.actor, { maxOperationCount: 2 });
    await expect(fixture.service.export(fixture.actor)).rejects.toThrow('Merchant operation is not authorized');
  });

  it.each(['normalized-evidence', 'outbound-ceiling', 'selected-connection'] as const)(
    'refuses the complete export when %s changes after capture during Actual shutdown', async (change) => {
      fixture.setRows([transaction({ amount: -100 })]);
      fixture.grantSources();
      fixture.grant('budget', fixture.actor.budgetId, 'merchant:export', true, fixture.actor, {
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '200' }],
      });
      duringCompletedConnectionShutdown(() => {
        if (change === 'normalized-evidence') fixture.grant('evidence', evidenceKey(candidateId), 'normalized-evidence', false);
        else if (change === 'outbound-ceiling') fixture.grant('budget', fixture.actor.budgetId, 'merchant:export', true, fixture.actor, {
          maxGrossOutgoing: [{ currency: 'USD', minorUnits: '150' }],
        });
        else fixture.setConfig('https://different-export.fixture.test/base');
      });
      await expect(fixture.service.export(fixture.actor)).rejects.toThrow(
        change === 'selected-connection' ? 'Merchant selected connection changed' : 'Merchant operation is not authorized');
    });

  it('keeps trusted withAnalysis consumers readonly while providing complete canonical source and a current fence', async () => {
    const output = await fixture.service.withAnalysis(fixture.actor, {}, async (view, source, authorize) => {
      expect(authorize()).toBe(true);
      expect(source.transactions.map((item) => item.id).sort()).toEqual(fixture.rows().map((item) => item.id).sort());
      expect(view.suggestions).toHaveLength(40);
      expect(view.suggestions.every((item) => item.categoryId === categoryId && item.supportCount === 3)).toBe(true);
      expect(rows('merchant_evidence')).toEqual([]);
      return view;
    });
    expect(output.localReview.uncategorizedCount).toBe(40);
    expect(rows('merchant_evidence')).toEqual([]);
  });

  it('confirmation publishes only the selected target with complete source refs and actor attribution, and later analysis stays readonly', async () => {
    const output = await fixture.service.analyze(fixture.actor);
    const selected = output.suggestions.find((item) => item.transactionId === candidateId);
    if (!selected) throw new Error('Canonical selected target must have authorized evidence');
    const accepted = await fixture.service.confirm(fixture.actor, {
      id: 'selected-publication-alias', kind: 'alias', evidenceKey: selected.evidenceKey, evidenceRevision: selected.evidenceRevision,
      expectedVersion: 0, visibility: 'private', transactionId: candidateId, sourceField: 'importedPayee', targetPayeeId: payeeId, accountId,
    });
    expect(accepted).toMatchObject({ id: 'selected-publication-alias', actorId: fixture.actor.actorId, state: 'accepted', version: 1,
      updatedAt: now, scope: output.scope, visibility: { privateActorId: fixture.actor.actorId },
      payload: { kind: 'alias', sourceTransactionIds: [candidateId], targetPayeeId: payeeId, accountId, normalizationVersion: 'merchant/2' } });
    const persisted = rows('merchant_evidence').map((row) => JSON.parse(row.value) as MerchantEvidence);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ key: selected.evidenceKey, revision: selected.evidenceRevision, scope: output.scope,
      policyVersion: 0, capturedAt: now, visibility: { privateActorId: fixture.actor.actorId } });
    const sourceIds = fixture.rows().map((row) => row.id).sort();
    expect(persisted[0]!.sourceRefs.transactionIds.slice().sort()).toEqual(sourceIds);
    expect(accepted.sourceRefs).toEqual(persisted[0]!.sourceRefs);
    expect(accepted.sourceRefs.required).toEqual(expect.arrayContaining([
      ...sourceIds.flatMap((id) => [
        expect.objectContaining({ resourceKind: 'transaction', resourceId: id, capability: 'transaction.view' }),
        expect.objectContaining({ resourceKind: 'transaction', resourceId: id, capability: 'source' }),
      ]),
      expect.objectContaining({ resourceKind: 'account', resourceId: accountId, capability: 'history' }),
      expect.objectContaining({ resourceKind: 'account', resourceId: accountId, capability: 'source' }),
      expect.objectContaining({ resourceKind: 'category', resourceId: categoryId, capability: 'name' }),
      expect.objectContaining({ resourceKind: 'evidence', resourceId: selected.evidenceKey, capability: 'evidence' }),
      expect.objectContaining({ resourceKind: 'evidence', resourceId: selected.evidenceKey, capability: 'normalized-evidence' }),
    ]));
    const decisions = rows('merchant_decisions').map((row) => JSON.parse(row.value) as MerchantDecision);
    expect(decisions).toEqual([accepted]);
    const later = await fixture.service.analyze(fixture.actor);
    expect(later.suggestions).toHaveLength(40);
    expect(later.suggestions.find((item) => item.transactionId === candidateId)?.aliasDecisions).toEqual([
      expect.objectContaining({ id: accepted.id, state: 'accepted', version: 1, visibility: 'private' }),
    ]);
    expect(rows('merchant_evidence').map((row) => JSON.parse(row.value) as MerchantEvidence)).toEqual(persisted);
    expect(rows('merchant_decisions').map((row) => JSON.parse(row.value) as MerchantDecision)).toEqual([accepted]);
    for (const write of [fixture.client.updateTransaction, fixture.client.addTransactions, fixture.client.createRule, fixture.client.deleteRule, fixture.client.setBudgetAmount]) expect(write).not.toHaveBeenCalled();
  });
  it('does not renew an expired displayed decision merely by recapturing unchanged ledger facts', async () => {
    let current = new Date(now);
    const service = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native, clock: () => current });
    const selected = (await service.analyze(fixture.actor)).suggestions.find((row) => row.transactionId === candidateId)!;
    current = new Date(selected.reviewContext.expiresAt);
    const actor = { ...fixture.actor, auth: { ...fixture.actor.auth, reauthenticatedAt: current.toISOString() } };
    await expect(service.confirm(actor, { id: 'expired-readonly-alias', kind: 'alias',
      evidenceKey: selected.evidenceKey, evidenceRevision: selected.evidenceRevision, expectedVersion: 0, visibility: 'private',
      transactionId: candidateId, sourceField: 'importedPayee', targetPayeeId: payeeId, accountId,
    })).rejects.toThrow('Merchant evidence is no longer current');
    expect(rows('merchant_decisions')).toEqual([]);
  });

  it('withholds one ungranted evidence subject without denying authorized peers or ordinary uncategorized Review', async () => {
    fixture.grant('evidence', evidenceKey(candidateId), 'normalized-evidence', false);
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.suggestions.map((item) => item.transactionId).sort()).toEqual(targetIds.filter((id) => id !== candidateId).sort());
    expect(output.suggestions.every((item) => item.categoryId === categoryId && item.supportCount === 3)).toBe(true);
    expect(output.localReview.candidates.find((item) => item.transactionId === candidateId)).toMatchObject({ source: 'uncategorized', amount: { minorUnits: '100', currency: 'USD' } });
    expect(output.localReview.candidates.find((item) => item.transactionId === candidateId)?.merchantEvidence).toBeUndefined();
    expect(rows('merchant_evidence')).toEqual([]);
  });

  it.each(['evidence', 'normalized-evidence'] as const)('refuses final disclosure when an admitted subject loses %s during an awaited consumer', async (capability) => {
    await expect(fixture.service.withAnalysis(fixture.actor, {}, async (view, _source, authorize) => {
      expect(view.suggestions.find((item) => item.transactionId === candidateId)?.categoryId).toBe(categoryId);
      await Promise.resolve();
      fixture.grant('evidence', evidenceKey(candidateId), capability, false);
      expect(authorize()).toBe(false);
      return view;
    })).rejects.toThrow('Merchant operation is not authorized');
    expect(rows('merchant_evidence')).toEqual([]);
  });

  it('refuses final disclosure when one admitted subject restriction no longer covers complete derivation', async () => {
    await expect(fixture.service.withAnalysis(fixture.actor, {}, async (view, _source, authorize) => {
      expect(view.suggestions.find((item) => item.transactionId === candidateId)?.categoryId).toBe(categoryId);
      await Promise.resolve();
      fixture.grant('evidence', evidenceKey(candidateId), 'normalized-evidence', true, fixture.actor,
        { maxGrossOutgoing: [{ minorUnits: '100', currency: 'USD' }] });
      expect(authorize()).toBe(false);
      return view;
    })).rejects.toThrow('Merchant operation is not authorized');
  });

  it('refuses final disclosure when only the independently stored space policy becomes disabled', async () => {
    await expect(fixture.service.withAnalysis(fixture.actor, {}, async (view, _source, authorize) => {
      expect(view.suggestions.find((item) => item.transactionId === candidateId)?.categoryId).toBe(categoryId);
      await fixture.service.setSpacePolicy(fixture.actor, { expectedVersion: 0, value: {
        mode: 'disabled', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0,
        billingCurrency: 'USD', cacheTtlHours: 720,
      } });
      expect(authorize()).toBe(false);
      return view;
    })).rejects.toThrow('Merchant operation is not authorized');
    const current = await fixture.service.analyze(fixture.actor);
    expect(current.suggestions).toEqual([]);
    expect(current.localReview.uncategorizedCount).toBe(40);
    expect(current.localReview.totalUncategorizedAmount).toEqual({ minorUnits: '4000', currency: 'USD' });
  });

  it('refuses final disclosure when installation policy becomes disabled after initial subject admission', async () => {
    let mode: 'local-only' | 'disabled' = 'local-only';
    const service = new MerchantIntelligenceService({ store: fixture.store, connectionManager: fixture.manager, native,
      clock: () => new Date(now), research: { settings: () => ({ installation: { version: mode, value: {
        mode, allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0,
        billingCurrency: 'USD', cacheTtlHours: 720,
      } }, configuration: null }) } });
    await expect(service.withAnalysis(fixture.actor, {}, async (view, _source, authorize) => {
      expect(view.suggestions.find((item) => item.transactionId === candidateId)?.categoryId).toBe(categoryId);
      await Promise.resolve();
      mode = 'disabled';
      expect(authorize()).toBe(false);
      return view;
    })).rejects.toThrow('Merchant operation is not authorized');
    const current = await service.analyze(fixture.actor);
    expect(current.suggestions).toEqual([]);
    expect(current.localReview.uncategorizedCount).toBe(40);
  });

  it('rejects an incoming-only uncategorized aggregate outside the canonical signed Money range', async () => {
    fixture.setRows(Array.from({ length: 1025 }, (_, index) => transaction({
      id: `tx-incoming-overflow-${index}`, amount: Number.MAX_SAFE_INTEGER,
    })));
    fixture.grantSources();
    fixture.grant('budget', fixture.actor.budgetId, 'merchant:analyze', true, fixture.actor,
      { maxGrossOutgoing: [{ minorUnits: '0', currency: 'USD' }] });
    const result = fixture.service.analyze(fixture.actor);
    await expect(result).rejects.toThrow('Merchant uncategorized amount exceeds Money range');
    await expect(result).rejects.toMatchObject({ code: 'analysis_failed', reasonCodes: ['amount_overflow'], retryable: false });
    expect(rows('merchant_evidence')).toEqual([]);
  });

  it.each([
    ['maxGrossOutgoing', { maxGrossOutgoing: [{ minorUnits: '100', currency: 'USD' }] }],
    ['maxOperationCount', { maxOperationCount: 3 }],
  ] satisfies Array<[string, ResourceGrantRestrictions]>)('normalized-evidence %s admits the target-only payload but denies derivation from the complete source closure', async (_name, restrictions) => {
    fixture.grant('evidence', evidenceKey(candidateId), 'normalized-evidence', true, fixture.actor, restrictions);
    expect(fixture.store.governance.authorize(targetOnlyAuthorization())).toMatchObject({ allowed: true, disposition: { kind: 'authorized_without_approval' } });
    const output = await fixture.service.analyze(fixture.actor);
    expect(output.coverage.inputCount).toBe(43);
    expect(output.sourceAdmission.collections.transactions).toBe('complete');
    expect(output.suggestions.map((item) => item.transactionId).sort()).toEqual(targetIds.filter((id) => id !== candidateId).sort());
    expect(output.suggestions.every((item) => item.categoryId === categoryId && item.supportCount === 3)).toBe(true);
    expect(output.localReview.uncategorizedCount).toBe(40);
    expect(output.localReview.candidates.find((item) => item.transactionId === candidateId)).toMatchObject({ source: 'uncategorized', amount: { minorUnits: '100', currency: 'USD' } });
    expect(output.localReview.candidates.find((item) => item.transactionId === candidateId)?.proposedCategoryId).toBeUndefined();
    expect(output.localReview.candidates.find((item) => item.transactionId === candidateId)?.merchantEvidence).toBeUndefined();
    expect(rows('merchant_evidence')).toEqual([]);
  });
});
