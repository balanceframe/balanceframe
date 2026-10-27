import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ActualConnector,
  NullCredentialStore,
  createDefaultActualClient,
} from '@balanceframe/actual-adapter';
import type { ActualClient, BudgetLedger } from '@balanceframe/actual-adapter';
import { GENERIC_MUTATION_POLICY_VERSION, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { GovernanceResourceRef } from '@balanceframe/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import {
  CategorizationMutationService,
  ConnectionManager,
  createNativeCategorizationMutationProtocol,
} from '../../packages/application/src/index.js';
import { buildCategorizationProposalIntent } from '../../apps/web/server/utils/categorization-proposal.js';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { deleteBudget, getBudgets, sync } from './actual-client.js';
import { assertFixtureProvenance, createTestBudget, withActualClient } from './helpers.js';
import type { ClientConfig, SeededBudget } from './helpers.js';

afterEach(() => vi.useRealTimers());

describe('13 — acknowledged delegated categorization through the real SDK', () => {
  it('keeps two human approvals, charges one exact category write, and preserves caps and stops after reopen', async () => {
    const startedAt = new Date();
    // Pin UTC accounting windows at the current instant; network/timeout timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    const directory = mkdtempSync(join(tmpdir(), 'balanceframe-delegated-category-sdk-'));
    for (const name of ['seed', 'writer', 'cleanup']) mkdirSync(join(directory, name));
    let created: SeededBudget | null = null,
      seedConfig: ClientConfig | null = null;
    let store: SqliteWorkflowStore | null = null,
      manager: ConnectionManager | null = null;
    let sourceClient: ActualClient | null = null;
    const writes: Array<{ id: string; fields: Record<string, unknown> }> = [];
    try {
      const seeded = await withActualClient(
        async (config) => {
          seedConfig = config;
          expect(config.serverURL).toBe(assertFixtureProvenance().serverURL);
          const budget = await createTestBudget(
            `BalanceFrame-Delegated-Category-Only-${randomUUID()}`,
          );
          created = budget;
          const fixture = canonicalProtocolSnapshotSchema.parse(
            JSON.parse(
              readFileSync(
                new URL('../../protocol/fixtures/representative.json', import.meta.url),
                'utf8',
              ),
            ),
          );
          const ids = await populateActualBudget(fixture);
          await sync();
          const source = fixture.transactions.find(
            (transaction) =>
              transaction.subtransactions.length === 0 &&
              transaction.transferAccountId === null &&
              transaction.categoryId !== null &&
              BigInt(transaction.amount.minorUnits) < 0n &&
              fixture.accounts.some(
                (account) =>
                  account.id === transaction.accountId && !account.isClosed && !account.offBudget,
              ),
          );
          if (!source) throw new Error('Canonical fixture needs one ordinary categorized outflow');
          const target = fixture.categories.find(
            (category) =>
              !category.deleted && !category.isIncome && category.id !== source.categoryId,
          );
          if (!target) throw new Error('Canonical fixture needs a different expense category');
          const remote = (await getBudgets()).find(
            (candidate) =>
              candidate.name === budget.budgetName && candidate.groupId === budget.groupId,
          );
          if (!remote) throw new Error('Disposable budget was not uploaded');
          return {
            config,
            budgetId: remote.cloudFileId ?? remote.id!,
            transactionId: ids.transactionIds[source.id]!,
            accountId: ids.accountIds[source.accountId]!,
            previousCategoryId: ids.categoryIds[source.categoryId!]!,
            categoryId: ids.categoryIds[target.id]!,
            magnitude: (-BigInt(source.amount.minorUnits)).toString(),
            currency: source.amount.currency,
          };
        },
        { dataDir: join(directory, 'seed') },
      );
      const databasePath = join(directory, 'workflow.sqlite');
      store = new SqliteWorkflowStore(databasePath);
      const sessionAuthenticatedAt = new Date().toISOString();
      const auth = (actorId: string) => ({
        method: 'human-session' as const,
        actorId,
        sessionId: `session:${actorId}`,
        reauthenticatedAt: sessionAuthenticatedAt,
      });
      const now = () => new Date().toISOString();
      await store.claimBootstrap({
        name: 'Synthetic Pilot Owner',
        email: 'pilot@example.com',
        claimId: 'pilot',
      });
      await store.finalizeBootstrap({ claimId: 'pilot', ownerUserId: 'pilot-owner' });
      const space = store.governance.createSpace({
        actorId: 'pilot-owner',
        name: 'Synthetic Categorization Pilot',
        kind: 'shared',
        now: now(),
        auth: auth('pilot-owner'),
      });
      store.governance.bindBudget({
        spaceId: space.id,
        budgetId: seeded.budgetId,
        now: now(),
        auth: auth('pilot-owner'),
      });
      const initialPolicy = store.governance.getPolicy({ spaceId: space.id })!;
      store.governance.setPolicy({
        spaceId: space.id,
        expectedVersion: initialPolicy.version,
        policy: { minimumApprovers: 2, operationApprovers: { set_category: 2 } },
        now: now(),
        auth: auth('pilot-owner'),
      });
      const memberIds: Record<string, string> = {
        'pilot-owner': store.governance.getCurrentMembership({
          spaceId: space.id,
          actorId: 'pilot-owner',
          now: now(),
        })!.id,
      };
      for (const actorId of ['pilot-approver-a', 'pilot-approver-b']) {
        await store.upsertActorMembership(actorId, 'active', [], 'unscoped');
        memberIds[actorId] = store.governance.addMembership({
          spaceId: space.id,
          actorId,
          validFrom: now(),
          now: now(),
          auth: auth('pilot-owner'),
        }).id;
      }
      const resources: GovernanceResourceRef[] = [
        { resourceKind: 'budget', resourceId: seeded.budgetId },
        { resourceKind: 'account', resourceId: seeded.accountId },
        { resourceKind: 'transaction', resourceId: seeded.transactionId },
        { resourceKind: 'category', resourceId: seeded.previousCategoryId },
        { resourceKind: 'category', resourceId: seeded.categoryId },
      ];
      for (const resource of resources)
        for (const [actorId, capabilities] of [
          ['pilot-owner', ['categorization:propose', 'categorization:execute']],
          ['pilot-approver-a', ['categorization:approve']],
          ['pilot-approver-b', ['categorization:approve']],
        ] as const)
          for (const capability of capabilities)
            store.governance.setResourceGrant({
              spaceId: space.id,
              actorId,
              membershipId: memberIds[actorId]!,
              budgetId: seeded.budgetId,
              ...resource,
              capability,
              granted: true,
              now: now(),
              auth: auth('pilot-owner'),
            });
      const agentId = 'agent:categorization-pilot';
      store.governance.registerAgent({
        spaceId: space.id,
        agentId,
        now: now(),
        auth: auth('pilot-owner'),
      });
      const delegation = store.governance.delegate({
        spaceId: space.id,
        agentId,
        issuerMembershipId: memberIds['pilot-owner']!,
        expectedVersion: null,
        rights: resources.map((resource) => ({
          ...resource,
          capability: 'categorization:execute',
        })),
        validFrom: now(),
        validUntil: new Date(Date.now() + 3600000).toISOString(),
        now: now(),
        auth: auth('pilot-owner'),
      });
      const bindCredential = (credentialId: string) => {
        store!.governance.registerCredentialBinding({
          spaceId: space.id,
          credentialId,
          credentialOwnerId: 'pilot-owner',
          principalType: 'agent',
          principalId: agentId,
          delegationId: delegation.id,
          expectedDelegationVersion: delegation.version,
          now: now(),
          auth: auth('pilot-owner'),
        });
        return {
          method: 'api-key' as const,
          actorId: agentId,
          credentialId,
          credentialOwnerId: 'pilot-owner',
          principalType: 'agent' as const,
          delegationId: delegation.id,
          delegationVersion: delegation.version,
        };
      };
      let agentAuth = bindCredential('key:categorization-pilot:one');
      expect(
        store.governance.resolveCredentialPrincipal({
          credentialId: agentAuth.credentialId,
          referenceId: 'pilot-owner',
          now: now(),
        }),
      ).toMatchObject({
        actorId: agentId,
        principalType: 'agent',
        delegationId: delegation.id,
        delegationVersion: delegation.version,
      });
      const credentials = { serverUrl: seeded.config.serverURL, secretKey: seeded.config.password };
      manager = new ConnectionManager({
        configPath: join(directory, 'connection.json'),
        credentialStore: { load: async () => credentials, store: async () => {} },
        connectorFactory: async () => {
          const client = await createDefaultActualClient(),
            update = client.updateTransaction.bind(client);
          sourceClient = client;
          client.updateTransaction = async (id, fields) => {
            // Count at the real SDK boundary; the financial write is this pilot's subject.
            writes.push({ id, fields: structuredClone(fields) });
            return update(id, fields);
          };
          return new ActualConnector({
            client,
            credentialStore: new NullCredentialStore(),
            mode: 'reviewAndApply',
            cacheDir: join(directory, 'writer'),
          });
        },
      });
      await manager.connect({ budgetId: seeded.budgetId, credentials });
      const native = await createNativeCategorizationMutationProtocol();
      await manager.withConnection(
        async (connected) => {
          const ledger = connected.connector as unknown as BudgetLedger;
          const client = sourceClient as ActualClient | null;
          if (!client) throw new Error('Actual pilot client was not created');
          const raw = async () => {
            const accounts = (await client.getAccounts()).sort((a, b) => a.id.localeCompare(b.id));
            return {
              accounts,
              transactions: (
                await Promise.all(
                  accounts.map((account) =>
                    client.getTransactions(account.id, '0001-01-01', '9999-12-31'),
                  ),
                )
              )
                .flat()
                .sort((a, b) => a.id.localeCompare(b.id)),
              balances: await Promise.all(
                accounts.map(async (account) => ({
                  id: account.id,
                  balance: await client.getAccountBalance(account.id),
                })),
              ),
            };
          };
          const initial = await ledger.synchronize();
          const before = await raw();
          const originalSnapshot = initial.snapshot;
          const createProposal = async (categoryId: string) => {
            const snapshot = (await ledger.synchronize()).snapshot;
            const transaction = snapshot.transactions.find(
              (row) => row.id === seeded.transactionId,
            )!;
            const category = snapshot.categories.find((row) => row.id === categoryId)!;
            const intent = buildCategorizationProposalIntent({
              protocol: native,
              snapshot,
              transaction,
              category,
            });
            return store!.createProposal({
              spaceId: space.id,
              operation: 'set_category',
              budgetId: seeded.budgetId,
              payload: intent.payload,
              preconditions: JSON.stringify(intent.preconditions),
              policyVersion: GENERIC_MUTATION_POLICY_VERSION,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              actorId: 'pilot-owner',
              auth: auth('pilot-owner'),
              provenance: 'manual',
            });
          };
          const proposal = await createProposal(seeded.categoryId);
          const executeInput = {
            requestId: 'acknowledged-pilot',
            actorId: agentId,
            proposalId: proposal.id,
            auth: agentAuth,
            idempotencyKey: `${proposal.id}:execute:${agentId}`,
          };
          const execute = () =>
            new CategorizationMutationService(store!, ledger, native).execute(executeInput);
          const approve = (
            proposalId: string,
            payloadHash: string,
            actorId: string,
            expiresAt: string,
          ) =>
            store!.createApproval({
              proposalId,
              payloadHash,
              actorId,
              expiresAt,
              auth: auth(actorId),
              now: now(),
            });
          const firstApproval = await approve(
            proposal.id,
            proposal.payloadHash,
            'pilot-approver-a',
            proposal.expiresAt,
          );
          expect(await execute()).toMatchObject({
            success: false,
            reasonCodes: ['approval_required'],
          });
          expect(writes).toEqual([]);
          expect(await store!.getIdempotencyRecord(executeInput.idempotencyKey)).toBeNull();
          const secondApproval = await approve(
            proposal.id,
            proposal.payloadHash,
            'pilot-approver-b',
            proposal.expiresAt,
          );
          expect(firstApproval.actorId).not.toBe(secondApproval.actorId);
          const setControls = (agent: string | null, maxOperations: number, stopped = false) => {
            const current = store!.governance
              .listCategorizationControls({ spaceId: space.id, actorId: 'pilot-owner', now: now() })
              .find((value) => value.agentId === agent);
            return store!.governance.setCategorizationControls({
              spaceId: space.id,
              agentId: agent,
              expectedVersion: current?.version ?? null,
              policy: {
                enabled: true,
                stopped,
                cooldownSeconds: 0,
                caps: [
                  {
                    window: 'day',
                    maxOperations,
                    maxMagnitude: [
                      {
                        currency: seeded.currency,
                        minorUnits: (BigInt(seeded.magnitude) * 100n).toString(),
                      },
                    ],
                  },
                ],
              },
              now: now(),
              auth: auth('pilot-owner'),
            });
          };
          expect(await execute()).toMatchObject({
            success: false,
            message: expect.stringMatching(/disabled/i),
          });
          setControls(null, 1);
          expect(await execute()).toMatchObject({
            success: false,
            message: expect.stringMatching(/disabled/i),
          });
          expect(writes).toEqual([]);
          expect((await store!.getApproval(firstApproval.id))?.status).toBe('active');
          expect((await store!.getApproval(secondApproval.id))?.status).toBe('active');
          setControls(agentId, 100);
          const result = await execute();
          expect(result).toMatchObject({
            success: true,
            verified: true,
            transactionId: seeded.transactionId,
            previousCategoryId: seeded.previousCategoryId,
            newCategoryId: seeded.categoryId,
          });
          expect(writes).toEqual([
            { id: seeded.transactionId, fields: { category: seeded.categoryId } },
          ]);
          expect((await store!.getApproval(firstApproval.id))?.status).toBe('consumed');
          expect((await store!.getApproval(secondApproval.id))?.status).toBe('consumed');
          const durable = await store!.getIdempotencyRecord(executeInput.idempotencyKey);
          expect(durable).toMatchObject({ status: 'succeeded', proposalId: proposal.id });
          expect(JSON.parse(durable!.serialisedResult!)).toMatchObject({
            verified: true,
            transactionId: seeded.transactionId,
            newCategoryId: seeded.categoryId,
          });
          const after = await ledger.synchronize();
          const expectedRaw = structuredClone(before);
          expectedRaw.transactions.find(
            (transaction) => transaction.id === seeded.transactionId,
          )!.category = seeded.categoryId;
          expect(await raw()).toEqual(expectedRaw);
          expect(after.snapshot.accounts).toEqual(originalSnapshot.accounts);
          expect(
            after.snapshot.transactions.map((transaction) => ({
              id: transaction.id,
              accountId: transaction.accountId,
              amount: transaction.amount,
            })),
          ).toEqual(
            originalSnapshot.transactions.map((transaction) => ({
              id: transaction.id,
              accountId: transaction.accountId,
              amount: transaction.amount,
            })),
          );
          const plan = JSON.parse(proposal.preconditions).nativePlan;
          expect(native.verifyMutation(plan, after.snapshot).verified).toBe(true);
          const admissions = () =>
            (store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
              .prepare(
                'SELECT proposal_id,payload_hash,idempotency_key,agent_id,currency,magnitude,state FROM categorization_dispatch_admissions',
              )
              .all();
          const admitted = [
            {
              proposal_id: proposal.id,
              payload_hash: proposal.payloadHash,
              idempotency_key: executeInput.idempotencyKey,
              agent_id: agentId,
              currency: seeded.currency,
              magnitude: seeded.magnitude,
              state: 'verified',
            },
          ];
          expect(admissions()).toEqual(admitted);
          store!.close();
          store = new SqliteWorkflowStore(databasePath);
          expect(admissions()).toEqual(admitted);
          expect(
            await new CategorizationMutationService(store!, null, null).execute(executeInput),
          ).toMatchObject({ success: true, verified: true, reasonCodes: ['idempotency_replay'] });
          expect(writes).toHaveLength(1);
          setControls(null, 1);
          setControls(agentId, 100);
          store!.governance.revokeCredentialBinding({
            spaceId: space.id,
            credentialId: agentAuth.credentialId,
            now: now(),
            auth: auth('pilot-owner'),
          });
          agentAuth = bindCredential('key:categorization-pilot:replacement');
          const blockedProposal = await createProposal(seeded.previousCategoryId);
          const approvals = await Promise.all(
            ['pilot-approver-a', 'pilot-approver-b'].map((actorId) =>
              approve(
                blockedProposal.id,
                blockedProposal.payloadHash,
                actorId,
                blockedProposal.expiresAt,
              ),
            ),
          );
          const blockedInput = {
            ...executeInput,
            auth: agentAuth,
            proposalId: blockedProposal.id,
            idempotencyKey: `${blockedProposal.id}:execute:${agentId}`,
          };
          const blocked = () =>
            new CategorizationMutationService(store!, ledger, native).execute(blockedInput);
          expect(await blocked()).toMatchObject({
            success: false,
            message: expect.stringMatching(/limit exceeded/i),
          });
          expect(await store!.getIdempotencyRecord(blockedInput.idempotencyKey)).toBeNull();
          // Raise the explicit cap so this denial proves stop independently of exhaustion.
          setControls(null, 2, true);
          expect(await blocked()).toMatchObject({
            success: false,
            message: expect.stringMatching(/stopped/i),
          });
          for (const approval of approvals)
            expect((await store!.getApproval(approval.id))?.status).toBe('active');
          expect(admissions()).toEqual(admitted);
          expect(writes).toHaveLength(1);
          expect(await raw()).toEqual(expectedRaw);
        },
        { expectedBudgetId: seeded.budgetId, dispose: false },
      );
    } finally {
      try {
        await manager?.disconnect();
      } finally {
        store?.close();
      }
      if (created && seedConfig) {
        const budget: SeededBudget = created,
          config: ClientConfig = seedConfig;
        await withActualClient(
          async () => {
            await deleteBudget(budget.groupId, budget.budgetId);
            expect(
              (await getBudgets()).some((candidate) => candidate.name === budget.budgetName),
            ).toBe(false);
          },
          { ...config, dataDir: join(directory, 'cleanup') },
        );
      }
      // Retain the owned caches if either SDK lifecycle failed to close.
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
