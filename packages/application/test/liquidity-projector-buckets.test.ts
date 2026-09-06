import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { accountAwareSpendabilityResultSchema } from '@balanceframe/protocol-generated/validators';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { withLiquidityFacts } from '../../actual-adapter/src/normalizer.js';
import { LiquidityProjector } from '../src/liquidity-projector.js';

const native = createRequire(import.meta.url)('@balanceframe/native');
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });

describe('account-aware liquidity projection', () => {
  it('keeps current availability separate from future backing and honors current account grants', async () => {
    const request = actualLiquidityRequest(true);
    const now = request.context.evaluatedAt;
    const facts = structuredClone(request.financialSnapshot.liquidity!);
    const food = facts.categories.find((category) => category.categoryId === 'food')!;
    facts.categories.push({
      ...food,
      cashBucketId: '000-future-food',
      asOfMonth: '2026-10',
      periodKind: 'future',
      availability: money('1000'),
    });
    request.financialSnapshot = withLiquidityFacts(request.financialSnapshot, facts);
    request.context.snapshotId = request.financialSnapshot.snapshotId;
    request.context.contentHash = request.financialSnapshot.contentHash;
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    request.scenario.items[0]!.amount = money('1000');
    const result = accountAwareSpendabilityResultSchema.parse(
      JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
    );
    expect(result.budgetFundingStatus).toBe('funded');
    const directory = mkdtempSync(join(tmpdir(), 'liquidity-bucket-projection-'));
    const store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    const actor = { actorId: 'reader', budgetId: request.financialSnapshot.source.budgetId };
    try {
      await store.upsertActorMembership(
        actor.actorId,
        'active',
        [
          'observe',
          ...['existence', 'name', 'balance', 'liquidity', 'conclusion'].map(
            (capability) => `liquidity:${capability}`,
          ),
        ],
        `budget:${actor.budgetId}`,
      );
      for (const [resourceKind, resourceId] of [
        ['budget', actor.budgetId],
        ['category', 'food'],
        ['account', 'cash'],
      ] as const) {
        for (const capability of [
          'existence',
          'name',
          'balance',
          'liquidity',
          'conclusion',
        ] as const)
          store.liquidity.setResourceGrant({
            ...actor,
            resourceKind,
            resourceId,
            capability,
            granted: true,
            now,
          });
      }
      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      const category = projector
        .view(request, result, now, request.scenario.items)
        .categories.find((value) => value.id === 'food')!;
      expect(category.availabilityBefore).toEqual(money('2000'));
      expect(category.availabilityAfter).toEqual(money('1000'));
      expect(category.backing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: 'cash',
            asOfMonth: '2026-09',
            periodKind: 'current',
            amount: money('1000'),
          }),
          expect.objectContaining({
            accountId: 'cash',
            asOfMonth: '2026-10',
            periodKind: 'future',
            amount: money('1000'),
          }),
        ]),
      );
      expect(category.backing).toHaveLength(2);
      store.liquidity.setResourceGrant({
        ...actor,
        resourceKind: 'account',
        resourceId: 'cash',
        capability: 'balance',
        granted: false,
        now,
      });
      expect(
        projector.view(request, result, now).categories.find((value) => value.id === 'food')!
          .backing,
      ).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('shows the immutable card payment transfer deadline even when the source is redacted', async () => {
    const request = actualLiquidityRequest(true, true);
    const facts = structuredClone(request.financialSnapshot.liquidity!);
    const cash = facts.accounts.find((account) => account.accountId === 'cash')!;
    facts.accounts.push({ ...structuredClone(cash), accountId: 'savings' });
    request.liquidityPolicy.accounts[0]!.protectedBuffer = money('15000');
    request.liquidityPolicy.accounts.push({
      ...request.liquidityPolicy.accounts[0]!,
      accountId: 'savings',
      resourceScope: 'savings',
      role: 'savings',
      paymentEligible: false,
      protectedBuffer: money('0'),
    });
    request.liquidityPolicy.transferRoutes.push({
      id: 'savings-cash',
      sourceAccountId: 'savings',
      destinationAccountId: 'cash',
      providerArrivalAt: '2026-09-06T17:00:00Z',
      calendarMode: null,
      delayDays: 0,
      utcOffsetMinutes: null,
      cutoffMinute: null,
      weekendsAvailable: null,
      holidaysComplete: false,
      holidays: [],
      evidence: cash.balanceEvidence,
    });
    request.financialSnapshot = withLiquidityFacts(request.financialSnapshot, facts);
    request.context.snapshotId = request.financialSnapshot.snapshotId;
    request.context.contentHash = request.financialSnapshot.contentHash;
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    const result = accountAwareSpendabilityResultSchema.parse(
      JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
    );
    expect(result.paymentLiquidityStatus).toBe('transfer_required');
    const store = new SqliteWorkflowStore(':memory:');
    const actor = {
      actorId: 'conclusion-reader',
      budgetId: request.financialSnapshot.source.budgetId,
    };
    const now = request.context.evaluatedAt;
    try {
      await store.upsertActorMembership(
        actor.actorId,
        'active',
        ['observe', 'liquidity:existence', 'liquidity:conclusion'],
        `budget:${actor.budgetId}`,
      );
      store.liquidity.setResourceGrant({
        ...actor,
        resourceKind: 'category',
        resourceId: 'food',
        capability: 'existence',
        granted: true,
        now,
      });
      store.liquidity.setResourceGrant({
        ...actor,
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'conclusion',
        granted: true,
        now,
      });
      const projection = new LiquidityProjector(store, actor, request.financialSnapshot).view(
        request,
        result,
        now,
        request.scenario.items,
      );
      expect(projection.purchases[0]!.transfer).toEqual({
        minimumAmount: money('2000'),
        requiredBy: '2026-09-06T18:00:00Z',
        authorizedHolderRequired: true,
      });
      expect(projection.accounts).toEqual([]);
    } finally {
      store.close();
    }
  });
});
