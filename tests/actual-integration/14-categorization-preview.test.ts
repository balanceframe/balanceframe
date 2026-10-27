import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import {
  CategorizationPreviewService,
  ConnectionManager,
  createNativeCategorizationMutationProtocol,
} from '../../packages/application/src/index.js';
import { buildCategorizationProposalIntent } from '../../apps/web/server/utils/categorization-proposal.js';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { createSchedule, deleteBudget, getBudgets, sync } from './actual-client.js';
import {
  assertFixtureProvenance,
  createTestBudget,
  loadFixtureData,
  withActualClient,
} from './helpers.js';
import type { ClientConfig, SeededBudget } from './helpers.js';

describe('14 — synchronized categorization preview through the real SDK', () => {
  it('keeps proposals and workflow accounting untouched while normal synchronization persists pending schedule metadata', async () => {
    expect(process.env.NODE_ENV).toBe('production');
    assertFixtureProvenance();
    const directory = mkdtempSync(join(tmpdir(), 'balanceframe-category-preview-sdk-'));
    for (const name of ['seed', 'preview', 'cleanup']) mkdirSync(join(directory, name));
    let created: SeededBudget | null = null,
      seedConfig: ClientConfig | null = null,
      store: SqliteWorkflowStore | null = null,
      manager: ConnectionManager | null = null;
    let sourceClient: ActualClient | null = null;
    const explicitMutations: string[] = [];
    const sourceMetadata: Array<Pick<FinancialSnapshot, 'coverage' | 'observations'>> = [];
    try {
      // Keep the regression red before any fixture mutation when the service is absent.
      expect(CategorizationPreviewService).toBeTypeOf('function');
      const seeded = await withActualClient(
        async (config) => {
          seedConfig = config;
          const budget = await createTestBudget(`BalanceFrame-Category-Preview-${randomUUID()}`);
          created = budget;
          const fixture = canonicalProtocolSnapshotSchema.parse(loadFixtureData());
          const ids = await populateActualBudget(fixture);
          await sync();
          const transaction = fixture.transactions.find(
            (row) =>
              row.subtransactions.length === 0 &&
              row.transferAccountId === null &&
              row.categoryId !== null &&
              BigInt(row.amount.minorUnits) < 0n &&
              fixture.accounts.some(
                (account) =>
                  account.id === row.accountId && !account.isClosed && !account.offBudget,
              ),
          );
          if (!transaction)
            throw new Error('Canonical fixture needs an ordinary categorized outflow');
          const category = fixture.categories.find(
            (row) => !row.deleted && !row.isIncome && row.id !== transaction.categoryId,
          );
          if (!category) throw new Error('Canonical fixture needs a different expense category');
          const remote = (await getBudgets()).find(
            (row) => row.name === budget.budgetName && row.groupId === budget.groupId,
          );
          if (!remote) throw new Error('Disposable preview budget was not uploaded');
          return {
            config,
            budgetId: remote.cloudFileId ?? remote.id!,
            groupId: budget.groupId,
            transactionId: ids.transactionIds[transaction.id]!,
            accountId: ids.accountIds[transaction.accountId]!,
            previousCategoryId: ids.categoryIds[transaction.categoryId!]!,
            categoryId: ids.categoryIds[category.id]!,
            currency: transaction.amount.currency,
            magnitude: (-BigInt(transaction.amount.minorUnits)).toString(),
          };
        },
        { dataDir: join(directory, 'seed') },
      );
      const databasePath = join(directory, 'workflow.sqlite');
      store = new SqliteWorkflowStore(databasePath);
      const now = () => new Date().toISOString();
      const auth = (actorId: string) => ({
        method: 'human-session' as const,
        actorId,
        sessionId: `session:${actorId}`,
        reauthenticatedAt: now(),
      });
      await store.claimBootstrap({
        name: 'Synthetic Preview Owner',
        email: 'preview@example.com',
        claimId: 'preview',
      });
      await store.finalizeBootstrap({ claimId: 'preview', ownerUserId: 'preview-owner' });
      const space = store.governance.createSpace({
        actorId: 'preview-owner',
        name: 'Synthetic Categorization Preview',
        kind: 'shared',
        now: now(),
        auth: auth('preview-owner'),
      });
      store.governance.bindBudget({
        spaceId: space.id,
        budgetId: seeded.budgetId,
        now: now(),
        auth: auth('preview-owner'),
      });
      const policy = store.governance.getPolicy({ spaceId: space.id })!;
      store.governance.setPolicy({
        spaceId: space.id,
        expectedVersion: policy.version,
        policy: { minimumApprovers: 2, operationApprovers: { set_category: 2 } },
        now: now(),
        auth: auth('preview-owner'),
      });
      const memberIds: Record<string, string> = {
        'preview-owner': store.governance.getCurrentMembership({
          spaceId: space.id,
          actorId: 'preview-owner',
          now: now(),
        })!.id,
      };
      for (const actorId of ['preview-approver-a', 'preview-approver-b']) {
        await store.upsertActorMembership(actorId, 'active', [], 'unscoped');
        memberIds[actorId] = store.governance.addMembership({
          spaceId: space.id,
          actorId,
          validFrom: now(),
          now: now(),
          auth: auth('preview-owner'),
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
          ['preview-owner', ['categorization:propose', 'categorization:execute', 'full-read']],
          ['preview-approver-a', ['categorization:approve']],
          ['preview-approver-b', ['categorization:approve']],
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
              auth: auth('preview-owner'),
            });
      const credentials = { serverUrl: seeded.config.serverURL, secretKey: seeded.config.password };
      manager = new ConnectionManager({
        configPath: join(directory, 'connection.json'),
        credentialStore: { load: async () => credentials, store: async () => {} },
        connectorFactory: async () => {
          const actual = await createDefaultActualClient();
          // These forwards exclude SDK-internal sync, archive, migration and schedule effects.
          const mutations = new Set([
            'updateTransaction',
            'addTransactions',
            'createAccount',
            'createRule',
            'deleteRule',
            'setBudgetAmount',
          ]);
          const client = new Proxy(actual, {
            get(target, key, receiver) {
              const forward: unknown = Reflect.get(target, key, receiver);
              if (typeof key !== 'string' || !mutations.has(key) || typeof forward !== 'function')
                return forward;
              return (...args: unknown[]) => {
                explicitMutations.push(key);
                return Reflect.apply(forward, target, args);
              };
            },
          });
          sourceClient = client;
          const connector = new ActualConnector({
            client,
            credentialStore: new NullCredentialStore(),
            mode: 'reviewAndApply',
            cacheDir: join(directory, 'preview'),
          });
          const synchronize = connector.synchronize.bind(connector);
          connector.synchronize = async (options) => {
            const result = await synchronize(options);
            sourceMetadata.push({
              coverage: result.financialSnapshot.coverage,
              observations: result.financialSnapshot.observations,
            });
            return result;
          };
          return connector;
        },
      });
      await manager.connect({ budgetId: seeded.budgetId, credentials });
      const native = await createNativeCategorizationMutationProtocol();
      const captured = await manager.withConnection(
        async ({ connector }) => {
          const snapshot = (await (connector as unknown as BudgetLedger).synchronize()).snapshot;
          const transaction = snapshot.transactions.find((row) => row.id === seeded.transactionId)!;
          const category = snapshot.categories.find((row) => row.id === seeded.categoryId)!;
          return {
            transaction,
            schedules: snapshot.schedules,
            intent: buildCategorizationProposalIntent({
              protocol: native,
              snapshot,
              transaction,
              category,
            }),
          };
        },
        { expectedBudgetId: seeded.budgetId, dispose: false },
      );
      const proposal = await store.createProposal({
        spaceId: space.id,
        operation: 'set_category',
        budgetId: seeded.budgetId,
        payload: captured.intent.payload,
        preconditions: JSON.stringify(captured.intent.preconditions),
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        actorId: 'preview-owner',
        auth: auth('preview-owner'),
        provenance: 'manual',
      });
      const client = sourceClient as ActualClient | null;
      if (!client) throw new Error('Preview SDK client was not created');
      const readTransaction = async () =>
        (await client.getTransactions(seeded.accountId, '0001-01-01', '9999-12-31')).find(
          (row) => row.id === seeded.transactionId,
        );
      const original = structuredClone(await readTransaction());
      expect(captured.schedules).toEqual([]);
      const balanceBefore = await client.getAccountBalance(seeded.accountId);
      const scheduleId = await createSchedule({
        name: 'Disposable preview due schedule',
        account: seeded.accountId,
        amount: -123,
        amountOp: 'is',
        date: now().slice(0, 10),
        posts_transaction: true,
      });
      expect(
        (await client.getTransactions(seeded.accountId, '0001-01-01', '9999-12-31')).filter(
          (row) => row.schedule === scheduleId,
        ),
      ).toEqual([]);
      const input = {
        proposalId: proposal.id,
        actorId: 'preview-owner',
        auth: auth('preview-owner'),
        spaceId: space.id,
        budgetId: seeded.budgetId,
        requestId: 'sdk-preview',
      };
      const service = new CategorizationPreviewService({
        store,
        connectionManager: manager,
        protocol: native,
      });
      const approve = (actorId: string) =>
        store!.createApproval({
          proposalId: proposal.id,
          payloadHash: proposal.payloadHash,
          actorId,
          auth: auth(actorId),
          expiresAt: proposal.expiresAt,
          now: now(),
        });
      let db = (
        store as unknown as { db: { prepare(sql: string): { all(): unknown[]; get(): unknown } } }
      ).db;
      const workflow = () => ({
        // Disclosure fences append read-admission audits; financial workflow writes remain forbidden.
        changes: db
          .prepare(
            "SELECT total_changes() - (SELECT COUNT(*) FROM audit_records WHERE classification='authorization_check' AND json_extract(result,'$.kind')='proposal_read_admission') AS non_read_audit_changes",
          )
          .get(),
        otherAudits: db
          .prepare(
            "SELECT * FROM audit_records WHERE NOT (classification='authorization_check' AND json_extract(result,'$.kind')='proposal_read_admission') ORDER BY id",
          )
          .all(),
        approvals: db.prepare('SELECT * FROM proposal_approvals ORDER BY id').all(),
        claims: db
          .prepare('SELECT * FROM proposal_execution_acquisitions ORDER BY proposal_id')
          .all(),
        idempotency: db.prepare('SELECT * FROM idempotency_records ORDER BY idempotency_key').all(),
        admissions: db
          .prepare('SELECT * FROM categorization_dispatch_admissions ORDER BY proposal_id')
          .all(),
        controls: db
          .prepare('SELECT * FROM categorization_control_versions ORDER BY version')
          .all(),
      });
      const first = await approve('preview-approver-a');
      const beforePending = workflow();
      const pending = await service.preview(input);
      expect(
        pending.reasonCodes,
        JSON.stringify(sourceMetadata.map((source) => source.coverage)),
      ).toEqual(['approval_required']);
      expect(pending).toMatchObject({
        simulationOnly: true,
        status: 'approval_required',
        requiredApprovers: 2,
      });
      expect(workflow()).toEqual(beforePending);
      // Initial fixture sync already ran today's schedule service; do not reset its internal clock.
      const posted = (
        await client.getTransactions(seeded.accountId, '0001-01-01', '9999-12-31')
      ).filter((row) => row.schedule === scheduleId);
      expect(posted).toEqual([]);
      expect(await client.getAccountBalance(seeded.accountId)).toBe(balanceBefore);
      const second = await approve('preview-approver-b');
      expect(first.actorId).not.toBe(second.actorId);
      const beforeReady = workflow();
      const ready = await service.preview({ ...input, requestId: 'sdk-preview-ready' });
      expect(ready).toMatchObject({
        simulationOnly: true,
        status: 'eligible_on_captured_inputs',
        requiredApprovers: 2,
        source: {
          kind: 'locally_observed',
          atomic: false,
          serverConfirmed: false,
          maySynchronize: true,
        },
        plan: {
          transactionId: seeded.transactionId,
          currentCategoryId: seeded.previousCategoryId,
          proposedCategoryId: seeded.categoryId,
        },
      });
      expect(Number.isFinite(Date.parse(ready.source.startedAt))).toBe(true);
      expect(Date.parse(ready.source.completedAt)).toBeGreaterThanOrEqual(
        Date.parse(ready.source.startedAt),
      );
      expect(workflow()).toEqual(beforeReady);
      expect(sourceMetadata.at(-1)?.coverage.accounts).toBe('partial');
      expect(sourceMetadata.at(-1)?.observations).toContainEqual(
        expect.objectContaining({
          kind: 'account_type',
          state: 'unknown',
          scope: { kind: 'account', id: seeded.accountId },
        }),
      );
      expect(await readTransaction()).toEqual(original);
      expect(explicitMutations).toEqual([]);
      for (const approval of [first, second])
        expect((await store.getApproval(approval.id))?.status).toBe('active');
      const failSync = vi
        .spyOn(client, 'sync')
        .mockRejectedValueOnce(new Error('Disposable preview sync failure'));
      try {
        expect(
          await service.preview({ ...input, requestId: 'sdk-preview-failed-source' }),
        ).toMatchObject({ status: 'blocked', plan: null });
        expect(failSync).toHaveBeenCalledOnce();
      } finally {
        failSync.mockRestore();
      }
      expect(workflow()).toEqual(beforeReady);
      expect(explicitMutations).toEqual([]);
      // Public acquisition and its final authority fence create conservative uncertainty without SDK dispatch.
      const agentId = 'agent:preview-held-dispatch';
      store.governance.registerAgent({ spaceId: space.id, agentId, now: now(), auth: input.auth });
      const delegation = store.governance.delegate({
        spaceId: space.id,
        agentId,
        issuerMembershipId: memberIds['preview-owner']!,
        expectedVersion: null,
        rights: resources.map((resource) => ({
          ...resource,
          capability: 'categorization:execute',
        })),
        validFrom: now(),
        validUntil: proposal.expiresAt,
        now: now(),
        auth: input.auth,
      });
      const credentialId = 'key:preview-held-dispatch';
      store.governance.registerCredentialBinding({
        spaceId: space.id,
        credentialId,
        credentialOwnerId: input.actorId,
        principalType: 'agent',
        principalId: agentId,
        delegationId: delegation.id,
        expectedDelegationVersion: delegation.version,
        now: now(),
        auth: input.auth,
      });
      for (const controlledAgent of [null, agentId])
        store.governance.setCategorizationControls({
          spaceId: space.id,
          agentId: controlledAgent,
          expectedVersion: null,
          policy: {
            enabled: true,
            stopped: false,
            cooldownSeconds: 0,
            caps: [
              {
                window: 'day',
                maxOperations: 1,
                maxMagnitude: [{ currency: seeded.currency, minorUnits: seeded.magnitude }],
              },
            ],
          },
          now: now(),
          auth: input.auth,
        });
      const acquisitionInput = {
        actorId: agentId,
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        governancePolicyVersion: proposal.governancePolicyVersion!,
        idempotencyKey: 'sdk-existing-hold',
        serialisedEffect: JSON.stringify({
          operation: proposal.operation,
          payload: proposal.payload,
          preconditions: JSON.parse(proposal.preconditions),
        }),
        auth: {
          method: 'api-key' as const,
          actorId: agentId,
          credentialId,
          credentialOwnerId: input.actorId,
          principalType: 'agent' as const,
          delegationId: delegation.id,
          delegationVersion: delegation.version,
        },
        now: now(),
      };
      const acquired = await store.acquireProposalExecution(acquisitionInput);
      expect(acquired.auditRecord).not.toBeNull();
      store.validateAcquiredProposalExecution({
        ...acquisitionInput,
        acquisitionAuditId: acquired.auditRecord!.id,
      });
      const held = workflow();
      expect(held.claims).toHaveLength(1);
      expect(held.idempotency).toHaveLength(1);
      expect(held.admissions).toEqual([
        expect.objectContaining({
          agent_id: agentId,
          proposal_id: proposal.id,
          state: 'uncertain',
          magnitude: seeded.magnitude,
        }),
      ]);
      expect(await service.preview({ ...input, requestId: 'sdk-preview-held' })).toMatchObject({
        status: 'blocked',
        plan: null,
        reasonCodes: ['idempotency_in_progress'],
      });
      expect(workflow()).toEqual(held);
      await manager.disconnect();
      // Reopen through a fresh real SDK cache: target stayed original; pending schedule was uploaded.
      await withActualClient(
        async () => {
          const { downloadBudget, getTransactions, getSchedules } = await import('@actual-app/api');
          await downloadBudget(seeded.groupId);
          const remoteTransactions = await getTransactions(
            seeded.accountId,
            '0001-01-01',
            '9999-12-31',
          );
          expect(remoteTransactions.find((row) => row.id === seeded.transactionId)).toEqual(
            original,
          );
          expect(remoteTransactions.filter((row) => row.schedule === scheduleId)).toEqual([]);
          expect((await getSchedules()).find((row) => row.id === scheduleId)).toMatchObject({
            name: 'Disposable preview due schedule',
            account: seeded.accountId,
            amount: -123,
            amountOp: 'is',
            date: now().slice(0, 10),
            posts_transaction: true,
          });
        },
        { ...seeded.config, dataDir: join(directory, 'cleanup') },
      );
      expect(explicitMutations).toEqual([]);
      expect(workflow()).toEqual(held);
      store.close();
      store = new SqliteWorkflowStore(databasePath);
      db = (store as unknown as { db: typeof db }).db;
      const reopened = workflow();
      expect(reopened).toEqual({ ...held, changes: reopened.changes });
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
            expect((await getBudgets()).some((row) => row.name === budget.budgetName)).toBe(false);
          },
          { ...config, dataDir: join(directory, 'cleanup') },
        );
      }
      // Preserve owned data if a preceding SDK close or budget deletion throws.
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
