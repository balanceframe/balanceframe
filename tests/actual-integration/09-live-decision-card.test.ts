import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActualConnector,
  NullCredentialStore,
  createDefaultActualClient,
} from '@balanceframe/actual-adapter';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { ConnectionManager, createLiquidityService } from '../../packages/application/src/index.js';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import type {
  LiquidityPurchaseIntent,
  PublicLiquidityObservationInput,
  PublicLiquidityPolicyInput,
  PublicUserAttestedObservation,
} from '../../packages/application/src/index.js';
import type { SeededBudget } from './helpers.js';
import type { SeededEntityIds } from '../../packages/scenario-kit/src/actual-seed.js';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { materializeScenario } from '../../packages/scenario-kit/src/catalog.js';
import { getBudgets } from './actual-client.js';
import { cleanupBudget, createTestBudget, withActualClient } from './helpers.js';

type ActualIdMaps = SeededEntityIds;
type SeededLiveBudget = SeededBudget & SeededEntityIds;

type TestActor = { actorId: string; budgetId: string };

function id(values: Readonly<Record<string, string>>, logicalId: string, resource: string): string {
  const mapped = values[logicalId];
  if (!mapped) throw new Error(`Missing Actual ${resource} mapping for ${logicalId}`);
  return mapped;
}

function mapPolicy(
  policy: Omit<PublicLiquidityPolicyInput, 'expectedVersion'>,
  ids: ActualIdMaps,
): Omit<PublicLiquidityPolicyInput, 'expectedVersion'> {
  return {
    ...policy,
    accounts: policy.accounts.map((account) => ({
      ...account,
      accountId: id(ids.accountIds, account.accountId, 'account'),
      eligibleCategoryIds: account.eligibleCategoryIds.map((categoryId) =>
        id(ids.categoryIds, categoryId, 'category'),
      ),
    })),
    transferRoutes: policy.transferRoutes.map((route) => ({
      ...route,
      sourceAccountId: id(ids.accountIds, route.sourceAccountId, 'account'),
      destinationAccountId: id(ids.accountIds, route.destinationAccountId, 'account'),
    })),
    categoryPolicies: policy.categoryPolicies?.map((categoryPolicy) => ({
      ...categoryPolicy,
      categoryId: id(ids.categoryIds, categoryPolicy.categoryId, 'category'),
    })),
  };
}

function mapObservation(
  observation: PublicUserAttestedObservation,
  ids: ActualIdMaps,
): PublicUserAttestedObservation {
  return {
    ...observation,
    accountId: id(ids.accountIds, observation.accountId, 'account'),
    ...(observation.obligations
      ? {
          obligations: observation.obligations.map((obligation) => ({
            ...obligation,
            categoryId:
              obligation.categoryId === null
                ? null
                : id(ids.categoryIds, obligation.categoryId, 'category'),
            matchedTransactionIds: obligation.matchedTransactionIds.map((transactionId) =>
              id(ids.transactionIds, transactionId, 'transaction'),
            ),
          })),
        }
      : {}),
    ...(observation.unsettledFlows
      ? {
          unsettledFlows: observation.unsettledFlows.map((flow) => ({
            ...flow,
            matchedTransactionIds: flow.matchedTransactionIds.map((transactionId) =>
              id(ids.transactionIds, transactionId, 'transaction'),
            ),
            ...(flow.transferTransactionId === null
              ? {}
              : {
                  transferTransactionId: id(
                    ids.transactionIds,
                    flow.transferTransactionId,
                    'transaction',
                  ),
                }),
          })),
        }
      : {}),
    ...(observation.credit
      ? {
          credit: {
            ...observation.credit,
            paymentAccountId: id(ids.accountIds, observation.credit.paymentAccountId, 'account'),
            paymentCategoryId: id(
              ids.categoryIds,
              observation.credit.paymentCategoryId,
              'category',
            ),
          },
        }
      : {}),
  };
}

function mapObservations(
  observations: Omit<PublicLiquidityObservationInput, 'expectedVersion'>,
  ids: ActualIdMaps,
): Omit<PublicLiquidityObservationInput, 'expectedVersion'> {
  return {
    ...observations,
    observations: observations.observations.map((observation) => mapObservation(observation, ids)),
  };
}

function mapPurchase(input: LiquidityPurchaseIntent, ids: ActualIdMaps): LiquidityPurchaseIntent {
  return {
    ...input,
    categoryId: id(ids.categoryIds, input.categoryId, 'category'),
    ...(input.accountId ? { accountId: id(ids.accountIds, input.accountId, 'account') } : {}),
  };
}

describe('09 — live Actual decision Card', () => {
  it('uses Actual connector output and dated attestations for a funded, ready purchase', async () => {
    const anchor = new Date();
    const scenario = materializeScenario('funded-purchase', anchor);
    const anchorIso = anchor.toISOString();

    let createdBudget: SeededBudget | null = null;
    let seedConfig: { serverURL: string; password: string; dataDir: string } | null = null;
    let root: string | null = null;
    let store: SqliteWorkflowStore | null = null;
    let manager: ConnectionManager | null = null;

    try {
      const seeded = await withActualClient(async (config) => {
        const budget = await createTestBudget(
          `BalanceFrame-Live-Decision-Card-${anchor.getTime()}`,
        );
        createdBudget = budget;
        seedConfig = config;
        const entityIds = await populateActualBudget(scenario.ledger);
        const remoteBudget = (await getBudgets()).find(
          (candidate) =>
            candidate.name === budget.budgetName && candidate.groupId === budget.groupId,
        );
        if (!remoteBudget) {
          throw new Error(
            `Created budget ${JSON.stringify(budget.budgetName)} was not found remotely`,
          );
        }
        const remoteBudgetId = remoteBudget.cloudFileId ?? remoteBudget.id;
        if (!remoteBudgetId) {
          throw new Error(`Created budget ${JSON.stringify(budget.budgetName)} has no remote id`);
        }
        const loadedBudget: SeededLiveBudget = {
          ...budget,
          budgetId: remoteBudgetId,
          ...entityIds,
        };
        return { budget: loadedBudget, config };
      });
      const budget = seeded.budget;
      const config = seeded.config;
      seedConfig = config;

      root = mkdtempSync(join(tmpdir(), 'balanceframe-live-card-'));
      const workflowPath = join(root, 'workflow.sqlite');
      const configPath = join(root, 'connection.json');
      const cacheDir = join(root, 'actual-cache');
      store = new SqliteWorkflowStore(workflowPath);

      const actor: TestActor = {
        actorId: 'live-card-owner',
        budgetId: budget.budgetId,
      };
      await store.claimBootstrap({
        name: 'Live Card Owner',
        email: 'live-card-owner@example.com',
        claimId: 'live-card-bootstrap',
      });
      await store.finalizeBootstrap({
        claimId: 'live-card-bootstrap',
        ownerUserId: actor.actorId,
      });
      await store.upsertActorMembership(
        actor.actorId,
        'active',
        ['observe'],
        `budget:${actor.budgetId}`,
      );
      store.liquidity.provisionOwnerAccess({
        ...actor,
        now: anchorIso,
        resources: [
          ...Object.values(budget.accountIds).map((resourceId) => ({
            resourceKind: 'account' as const,
            resourceId,
          })),
          ...Object.values(budget.categoryIds).map((resourceId) => ({
            resourceKind: 'category' as const,
            resourceId,
          })),
        ],
      });

      const credentialStore = new NullCredentialStore();
      manager = new ConnectionManager({
        configPath,
        credentialStore,
        connectorFactory: async () =>
          new ActualConnector({
            client: await createDefaultActualClient(),
            credentialStore,
            mode: 'observe',
            cacheDir,
          }),
      });
      await manager.connect({
        budgetId: actor.budgetId,
        credentials: {
          serverUrl: config.serverURL,
          secretKey: config.password,
        },
      });
      const sourceSynchronization = await manager.withConnection(
        async ({ synchronization }) => synchronization as { financialSnapshot: FinancialSnapshot },
      );
      const sourceSnapshot = sourceSynchronization.financialSnapshot;
      const checkingId = id(budget.accountIds, 'acct-checking', 'account');
      expect(sourceSnapshot.legacySnapshot.accounts).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: checkingId })]),
      );
      expect(sourceSnapshot.liquidity?.accounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: checkingId,
            recordedBalance: { minorUnits: '15000', currency: 'USD' },
          }),
        ]),
      );

      const service = await createLiquidityService({
        connectionManager: manager,
        store,
        clock: () => new Date(),
      });
      const ids = budget;
      const mappedPolicy = mapPolicy(scenario.policy, ids);
      const mappedObservations = mapObservations(scenario.observations, ids);
      if (scenario.entry.kind !== 'purchase') {
        throw new Error('funded-purchase scenario must have a purchase entry');
      }
      const purchaseAt = new Date(anchor.getTime() + 60_000).toISOString();
      const purchase = mapPurchase(
        {
          ...scenario.entry.input,
          purchaseAt,
          requiredBy: purchaseAt,
        },
        ids,
      );

      await service.savePolicy(actor, {
        expectedVersion: null,
        ...mappedPolicy,
      });

      const withoutAttestations = await service.evaluatePurchase(actor, purchase);
      expect(withoutAttestations.card.outcome).toBe('insufficient_data');

      await service.saveObservations(actor, {
        expectedVersion: 0,
        ...mappedObservations,
      });

      const evaluated = await service.evaluatePurchase(actor, purchase);
      expect(evaluated.card.blockers).toEqual([]);
      const groceriesId = id(ids.categoryIds, 'cat-groceries', 'category');
      expect(evaluated.card).toMatchObject({
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: checkingId,
        before: {
          categories: expect.arrayContaining([
            expect.objectContaining({
              categoryId: groceriesId,
              availability: { minorUnits: '2000', currency: 'USD' },
            }),
          ]),
          accounts: expect.arrayContaining([
            expect.objectContaining({
              accountId: checkingId,
              safeSpendingCapacity: { minorUnits: '5000', currency: 'USD' },
            }),
          ]),
        },
        after: {
          categories: expect.arrayContaining([
            expect.objectContaining({
              categoryId: groceriesId,
              availability: { minorUnits: '0', currency: 'USD' },
            }),
          ]),
          accounts: expect.arrayContaining([
            expect.objectContaining({
              accountId: checkingId,
              safeSpendingCapacity: { minorUnits: '3000', currency: 'USD' },
            }),
          ]),
        },
      });
    } finally {
      await manager?.disconnect().catch(() => {});
      store?.close();
      if (createdBudget && seedConfig) {
        const budgetToClean = createdBudget;
        const configToClean = seedConfig;
        let cleanupClientDir: string | null = null;
        try {
          await withActualClient(
            async (config) => {
              cleanupClientDir = config.dataDir;
              await cleanupBudget(budgetToClean.budgetId, budgetToClean.groupId);
            },
            {
              serverURL: configToClean.serverURL,
              password: configToClean.password,
            },
          );
        } catch {
          // Cleanup below still removes only the two directories owned by these helpers.
        } finally {
          rmSync(configToClean.dataDir, { recursive: true, force: true });
          if (cleanupClientDir) rmSync(cleanupClientDir, { recursive: true, force: true });
        }
      }
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });
});
