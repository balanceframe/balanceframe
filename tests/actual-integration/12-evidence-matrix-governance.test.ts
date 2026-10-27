import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ActualConnector,
  NullCredentialStore,
  createDefaultActualClient,
} from '@balanceframe/actual-adapter';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { GovernanceResourceKind, LiquidityActor } from '@balanceframe/workflow-store';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import {
  canonicalProtocolSnapshotSchema,
  DeriveEvidenceAllocationPlanRequestSchema,
} from '@balanceframe/protocol-generated/validators';
import {
  ConnectionManager,
  createLiquidityService,
  createConsequentialActionService,
  createTransactionEvidenceService,
} from '../../packages/application/src/index.js';
import {
  deriveProposalSourceReadFacts,
  consequentialActionPhaseRequirements,
} from '../../packages/workflow-store/src/proposal.js';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { addTransactions, deleteBudget, getBudgets, sync } from './actual-client.js';
import { assertFixtureProvenance, createTestBudget, withActualClient } from './helpers.js';
import type { ClientConfig, SeededBudget } from './helpers.js';
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../protocol/fixtures/${name}`, import.meta.url), 'utf8'));
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });

describe('12 — real SDK governed plural evidence allocation', () => {
  it('retains two independent approvals and exact matrix binding across durable reopen, then recovers lost acknowledgement by readonly proof', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balanceframe-matrix-governance-sdk-'));
    mkdirSync(join(directory, 'seed'));
    mkdirSync(join(directory, 'cleanup'));
    let created: SeededBudget | null = null,
      seedConfig: ClientConfig | null = null,
      store: SqliteWorkflowStore | null = null,
      manager: ConnectionManager | null = null,
      mutations: ConnectionManager | null = null;
    const parentIds: string[] = [randomUUID(), randomUUID()],
      marker = randomUUID();
    let clockNow = new Date().toISOString();
    let recoveryClock: string | null = null;
    const clock = () => new Date(recoveryClock ?? Date.now());
    const writes: Array<{ id: string; fields: unknown }> = [];
    let loseSecondAcknowledgement = true;
    try {
      const seeded = await withActualClient(
        async (config) => {
          seedConfig = config;
          expect(config.serverURL).toBe(assertFixtureProvenance().serverURL);
          const budget = await createTestBudget(
            `BalanceFrame-Matrix-Governance-Only-${randomUUID()}`,
          );
          created = budget;
          const source = canonicalProtocolSnapshotSchema.parse(load('representative.json')),
            ids = await populateActualBudget(source),
            account = source.accounts.find((a) => !a.isClosed && !a.offBudget)!;
          const categories = source.categories.filter((c) => !c.deleted && !c.isIncome),
            payee = source.payees.find((p) => p.transferAccountId === null)!;
          const accountId = ids.accountIds[account.id]!,
            categoryIds = [
              ids.categoryIds[categories[0]!.id]!,
              ids.categoryIds[categories[1]!.id]!,
            ],
            payeeId = ids.payeeIds[payee.id]!;
          await addTransactions(
            accountId,
            parentIds.map((id, i) => ({
              id,
              account: accountId,
              date: '2026-10-16',
              amount: i ? -500 : -700,
              category: categoryIds[0],
              payee: payeeId,
              notes: `Synthetic matrix note ${i}`,
              imported_id: `${marker}-${i}`,
              imported_payee: 'Synthetic imported retailer',
              cleared: true,
              reconciled: false,
            })),
            { runTransfers: false, learnCategories: false },
          );
          await sync();
          const remote = (await getBudgets()).find(
            (b) => b.name === budget.budgetName && b.groupId === budget.groupId,
          )!;
          return {
            config,
            budgetId: remote.cloudFileId ?? remote.id!,
            accountId,
            categoryIds,
            payeeName: payee.name,
          };
        },
        { dataDir: join(directory, 'seed') },
      );
      store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
      let workflow = store;
      const auth = (actorId: string) => ({
        method: 'human-session' as const,
        actorId,
        sessionId: `session:${actorId}`,
        reauthenticatedAt: clockNow,
      });
      await workflow.claimBootstrap({
        name: 'Synthetic Matrix Owner',
        email: 'matrix@example.com',
        claimId: 'matrix',
      });
      await workflow.finalizeBootstrap({ claimId: 'matrix', ownerUserId: 'matrix-owner' });
      const ownerAuth = auth('matrix-owner'),
        space = workflow.governance.createSpace({
          actorId: 'matrix-owner',
          name: 'Synthetic Matrix',
          kind: 'personal',
          now: clockNow,
          auth: ownerAuth,
        });
      workflow.governance.bindBudget({
        spaceId: space.id,
        budgetId: seeded.budgetId,
        now: clockNow,
        auth: ownerAuth,
      });
      const policy = workflow.governance.getPolicy({ spaceId: space.id })!;
      workflow.governance.setPolicy({
        spaceId: space.id,
        expectedVersion: policy.version,
        policy: { minimumApprovers: 2, assistanceMaximum: 'execute_approved_actions' },
        now: clockNow,
        auth: ownerAuth,
      });
      const membership = workflow.governance.getCurrentMembership({
        spaceId: space.id,
        actorId: 'matrix-owner',
        now: clockNow,
      })!;
      let actor: LiquidityActor & {
        spaceId: string;
        membershipId: string;
        auth: ReturnType<typeof auth>;
      } = {
        actorId: 'matrix-owner',
        budgetId: seeded.budgetId,
        spaceId: space.id,
        membershipId: membership.id,
        governancePolicyVersion: workflow.governance.getPolicy({ spaceId: space.id })!.version,
        auth: ownerAuth,
      };
      const grant = (
        target: LiquidityActor,
        resourceKind: GovernanceResourceKind,
        resourceId: string,
        capability: string,
      ) =>
        workflow.governance.setResourceGrant({
          ...target,
          spaceId: space.id,
          membershipId: target.membershipId!,
          resourceKind,
          resourceId,
          capability,
          granted: true,
          now: clockNow,
          auth: ownerAuth,
        });
      const configPath = join(directory, 'connection.json'),
        credentialStore = new NullCredentialStore(),
        credentials = { serverUrl: seeded.config.serverURL, secretKey: seeded.config.password };
      const makeManager = (mode: 'observe' | 'disposableSandbox') =>
        new ConnectionManager({
          configPath,
          credentialStore: { load: async () => credentials, store: async () => {} },
          connectorFactory: async () => {
            const client = await createDefaultActualClient();
            if (mode === 'disposableSandbox') {
              const update = client.updateTransaction.bind(client);
              client.updateTransaction = async (id, fields) => {
                writes.push({ id, fields });
                await update(id, fields);
                if (
                  loseSecondAcknowledgement &&
                  parentIds.includes(id) &&
                  writes.filter((w) => parentIds.includes(w.id)).length === 2
                ) {
                  loseSecondAcknowledgement = false;
                  throw new Error('Synthetic lost acknowledgement after second exact amendment');
                }
              };
            }
            return new ActualConnector({
              client,
              credentialStore,
              mode,
              cacheDir: join(directory, mode),
            });
          },
        });
      manager = makeManager('observe');
      mutations = makeManager('disposableSandbox');
      await manager.connect({ budgetId: seeded.budgetId, credentials });
      await mutations.connect({ budgetId: seeded.budgetId, credentials });
      const source = await manager.withConnection(
        async (connected) =>
          (connected.synchronization as { financialSnapshot: FinancialSnapshot }).financialSnapshot,
        { expectedBudgetId: seeded.budgetId },
      );
      const readRights = [
        'observe',
        'conclusion',
        'existence',
        'name',
        'balance',
        'history',
        'source',
        'liquidity',
        'policy',
        'full-read',
        'category',
        'transaction',
        'transaction.view',
        'rule:view',
        'evidence',
        'normalized-evidence',
        'proposal',
        'ledger_projection:propose',
        'ledger_projection:execute',
      ];
      const resources: Array<[GovernanceResourceKind, string]> = [
        ['budget', seeded.budgetId],
        ...source.legacySnapshot.accounts.map(
          (a) => ['account', a.id] as [GovernanceResourceKind, string],
        ),
        ...source.legacySnapshot.categories.map(
          (c) => ['category', c.id] as [GovernanceResourceKind, string],
        ),
        ...source.legacySnapshot.transactions.map(
          (t) => ['transaction', t.id] as [GovernanceResourceKind, string],
        ),
        ...source.legacySnapshot.rules.map(
          (r) => ['rule', r.id] as [GovernanceResourceKind, string],
        ),
      ];
      for (const [kind, id] of resources)
        for (const right of readRights) grant(actor, kind, id, right);
      for (const id of parentIds)
        for (const right of ['ledger_projection:propose', 'ledger_projection:execute', 'source'])
          grant(actor, 'ledger_effect', id, right);
      for (const right of ['ingest', 'resolve']) grant(actor, 'budget', seeded.budgetId, right);
      const rawEncryptionKey = randomBytes(32);
      let evidence = await createTransactionEvidenceService({
        store: workflow,
        connectionManager: manager,
        rawEncryptionKey,
        clock,
      });
      let liquidity = await createLiquidityService({
        store: workflow,
        connectionManager: manager,
        mutationConnectionManager: mutations,
        transactionEvidence: evidence,
        clock,
      });
      const expiresAt = new Date(Date.parse(clockNow) + 86400000).toISOString();
      await liquidity.savePolicy(actor, {
        expectedVersion: null,
        expiresAt,
        accounts: source.legacySnapshot.accounts.map((a) => ({
          accountId: a.id,
          role: 'daily_spending',
          protectedBuffer: money('0'),
          paymentEligible: !a.isClosed && !a.offBudget,
          sourceEligible: true,
          backingEligible: true,
          eligibleCategoryIds: [],
          restrictedCashBucketIds: [],
          automationAllowed: false,
        })),
        transferRoutes: [],
        approvalPolicy: { minimumApprovers: 2 },
      });
      actor = {
        ...actor,
        governancePolicyVersion: workflow.governance.getPolicy({ spaceId: space.id })!.version,
      };
      await liquidity.saveObservations(actor, {
        expectedVersion: 0,
        expiresAt,
        observations: source.legacySnapshot.accounts.map((a) => ({
          accountId: a.id,
          currentLedgerConfirmed: true,
          kind: 'cash',
          currency: 'USD',
          owned: true,
          holds: money('0'),
        })),
      });
      const allocation = DeriveEvidenceAllocationPlanRequestSchema.parse(
          load('evidence-allocation-plan.json'),
        ),
        receipt = structuredClone(allocation.evidence.receipts[0]!);
      const { provenance: _provenance, ...observation } = structuredClone(
        allocation.evidence.observations.find((o) => o.kind === 'receipt')!,
      );
      observation.counterparty = seeded.payeeName;
      observation.fundingInstrumentId = seeded.accountId;
      receipt.lines = [0, 1].map((i) => ({
        ...structuredClone(receipt.lines[0]),
        id: `line-${i + 1}`,
        sku: `synthetic-sku-${i}`,
        rawDescription: `Synthetic reviewed item ${i}`,
        unitGross: money('600'),
        gross: money('600'),
        net: money('600'),
      }));
      for (const tender of receipt.tenders) tender.observationId = null;
      const imported = await evidence.ingest(actor, {
        connectorId: 'retail',
        sourceId: 'matrix-receipt',
        sourceTimestamp: clockNow,
        sourceKind: 'retail',
        mediaType: 'application/json',
        content: JSON.stringify({
          templateVersion: 'retail-v1',
          observations: [observation],
          receipts: [receipt],
        }),
      });
      for (const right of readRights) grant(actor, 'evidence', imported.document.id, right);
      const readRaw = () =>
        manager!.withConnection(
          async (connected) => {
            const connector = connected.connector as ActualConnector,
              snapshot = (connected.synchronization as { financialSnapshot: FinancialSnapshot })
                .financialSnapshot;
            return {
              raw: await Promise.all(
                parentIds.map((transactionId) =>
                  connector.captureEvidenceTransaction({
                    budgetId: seeded.budgetId,
                    accountId: seeded.accountId,
                    transactionId,
                  }),
                ),
              ),
              count: snapshot.legacySnapshot.transactions.length,
              balance: snapshot.liquidity!.accounts.find((a) => a.accountId === seeded.accountId)!
                .recordedBalance,
            };
          },
          { expectedBudgetId: seeded.budgetId },
        );
      const before = await readRaw(),
        unreviewed = await evidence.resolve(actor, {
          policyVersion: actor.governancePolicyVersion,
        });
      const selector = {
        resolutionHash: unreviewed.resolutionHash,
        targetTransactionIds: parentIds,
        receiptIds: [receipt.id],
        lineCategories: receipt.lines.map((line: { id: string }, i: number) => ({
          receiptId: receipt.id,
          lineId: line.id,
          accountId: seeded.accountId,
          categoryId: seeded.categoryIds[i],
        })),
        cells: [
          {
            receiptId: receipt.id,
            lineId: 'line-1',
            targetTransactionId: parentIds[0],
            amount: money('400'),
          },
          {
            receiptId: receipt.id,
            lineId: 'line-1',
            targetTransactionId: parentIds[1],
            amount: money('200'),
          },
          {
            receiptId: receipt.id,
            lineId: 'line-2',
            targetTransactionId: parentIds[0],
            amount: money('300'),
          },
          {
            receiptId: receipt.id,
            lineId: 'line-2',
            targetTransactionId: parentIds[1],
            amount: money('300'),
          },
        ],
      };
      const preview = await evidence.previewAllocation(actor, selector);
      expect(preview.projections).toHaveLength(2);
      expect(preview.review.cells).toHaveLength(4);
      expect(
        new Set(
          preview.review.cells.map((cell) =>
            JSON.stringify([cell.receiptId, cell.lineId, cell.targetObservationId]),
          ),
        ).size,
      ).toBe(4);
      expect(writes).toEqual([]);
      const reviewed = await evidence.saveAllocation(actor, {
          ...selector,
          allocationSetHash: preview.allocationSetHash,
        }),
        event = reviewed.events.find(
          (e) => e.projectionObservation || e.projectionObservations?.length,
        )!;
      const action = await evidence.prepareLedgerAction(actor, {
        resolutionHash: reviewed.resolutionHash,
        eventId: event.id,
        allocationSetHash: preview.allocationSetHash,
      });
      expect(action.kind).toBe('composite');
      if (action.kind !== 'composite') throw new Error('Native matrix composite required');
      expect(action.actions).toHaveLength(2);
      expect(action.actions.every((a) => a.kind === 'evidence_amendment')).toBe(true);
      let consequential = await createConsequentialActionService({
        liquidity,
        store: workflow,
        clock,
      });
      const proposed = await consequential.propose(actor, { action });
      expect(writes).toEqual([]);
      await expect(consequential.execute(actor, proposed.id)).rejects.toThrow();
      expect(writes).toEqual([]);
      const stored = await workflow.getProposal(proposed.id);
      if (!stored || stored.operation !== 'consequential_action')
        throw new Error('Stored governed action required');
      expect(
        stored.payload.plan.evidenceReferences
          .filter((reference) => reference.evidenceId === imported.document.id)
          .map((reference) => reference.subjectId)
          .sort(),
      ).toEqual([...parentIds].sort());
      await expect(
        workflow.createApproval({
          proposalId: stored.id,
          payloadHash: stored.payloadHash,
          actorId: actor.actorId,
          expiresAt: stored.expiresAt,
          auth: actor.auth,
          now: clockNow,
        }),
      ).rejects.toThrow();
      const reads = deriveProposalSourceReadFacts(
        'consequential_action',
        stored.payload,
        JSON.parse(stored.preconditions),
        actor.budgetId,
      )!;
      expect(proposed.requiredApprovers).toBe(2);
      const approvals = [];
      for (const actorId of ['matrix-approver-one', 'matrix-approver-two']) {
        await workflow.upsertActorMembership(
          actorId,
          'active',
          ['observe'],
          `budget:${actor.budgetId}`,
        );
        const member = workflow.governance.addMembership({
          spaceId: space.id,
          actorId,
          validFrom: clockNow,
          now: clockNow,
          auth: ownerAuth,
        });
        const approver = { ...actor, actorId, membershipId: member.id, auth: auth(actorId) };
        for (const requirement of [
          ...reads.required,
          ...consequentialActionPhaseRequirements(stored.payload.plan, actor.budgetId, 'approve'),
        ])
          grant(approver, requirement.resourceKind, requirement.resourceId, requirement.capability);
        approvals.push(
          await workflow.createApproval({
            proposalId: stored.id,
            payloadHash: stored.payloadHash,
            actorId,
            expiresAt: stored.expiresAt,
            auth: approver.auth,
            now: clockNow,
          }),
        );
        if (approvals.length === 1) {
          await expect(consequential.execute(actor, stored.id)).rejects.toThrow();
          expect(writes).toEqual([]);
        }
      }
      expect(new Set(approvals.map((approval) => approval.actorId)).size).toBe(2);
      expect(approvals.every((approval) => approval.actorId !== actor.actorId)).toBe(true);
      expect(writes).toEqual([]);
      expect((await consequential.execute(actor, stored.id)).phase).toBe('review_required');
      expect(writes.filter((w) => parentIds.includes(w.id))).toHaveLength(2);
      const after = await readRaw();
      expect(after.count).toBe(before.count);
      expect(after.balance).toEqual(before.balance);
      for (const [i, raw] of after.raw.entries()) {
        const {
          category: _category,
          is_parent: _isParent,
          subtransactions: _subtransactions,
          ...immutableBefore
        } = before.raw[i]!.parent;
        const {
          category,
          is_parent,
          subtransactions: _newSubtransactions,
          ...immutableAfter
        } = raw.parent;
        expect(immutableAfter).toEqual(immutableBefore);
        expect({ category, is_parent }).toEqual({ category: null, is_parent: true });
        for (const child of raw.children)
          expect(child).toMatchObject({
            parent_id: parentIds[i],
            account: seeded.accountId,
            date: '2026-10-16',
            is_child: true,
            is_parent: false,
            cleared: true,
            reconciled: false,
            notes: null,
            imported_id: null,
            imported_payee: null,
          });
        expect(
          raw.children
            .map((child) => {
              if (typeof child.category !== 'string')
                throw new Error('Actual split category missing');
              return { amount: child.amount, category: child.category };
            })
            .sort((a, b) => a.category!.localeCompare(b.category!)),
        ).toEqual(
          [
            { amount: i ? -200 : -400, category: seeded.categoryIds[0] },
            { amount: -300, category: seeded.categoryIds[1] },
          ].sort((a, b) => a.category!.localeCompare(b.category!)),
        );
      }
      expect((await consequential.reconcile(actor, stored.id)).phase).toBe('review_required');
      expect(writes.filter((write) => parentIds.includes(write.id))).toHaveLength(2);
      const childIds = after.raw.map((raw) => raw.children.map((c) => c.id));
      const persisted = await workflow.getProposal(stored.id);
      const persistedApprovals = await Promise.all(
        approvals.map((approval) => workflow.getApproval(approval.id)),
      );
      workflow.close();
      store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
      workflow = store;
      evidence = await createTransactionEvidenceService({
        store: workflow,
        connectionManager: manager,
        rawEncryptionKey,
        clock,
      });
      liquidity = await createLiquidityService({
        store: workflow,
        connectionManager: manager,
        mutationConnectionManager: mutations,
        transactionEvidence: evidence,
        clock,
      });
      consequential = await createConsequentialActionService({ liquidity, store: workflow, clock });
      expect(await workflow.getProposal(stored.id)).toEqual(persisted);
      expect(
        await Promise.all(approvals.map((approval) => workflow.getApproval(approval.id))),
      ).toEqual(persistedApprovals);
      expect((await workflow.getProposal(stored.id))?.payload).toEqual(stored.payload);
      expect((await workflow.getProposal(stored.id))?.payloadHash).toBe(stored.payloadHash);
      expect((await workflow.getProposal(stored.id))?.preconditions).toBe(stored.preconditions);
      expect((await consequential.reconcile(actor, stored.id)).phase).toBe('review_required');
      expect(writes.filter((write) => parentIds.includes(write.id))).toHaveLength(2);
      clockNow = new Date(Date.parse(stored.expiresAt) + 1000).toISOString();
      recoveryClock = clockNow;
      expect((await consequential.reconcile(actor, stored.id)).phase).toBe('verified');
      expect(writes.filter((w) => parentIds.includes(w.id))).toHaveLength(2);
      expect((await consequential.reconcile(actor, stored.id)).phase).toBe('verified');
      const rechecked = await readRaw();
      expect(rechecked.raw.map((raw) => raw.children.map((c) => c.id))).toEqual(childIds);
      expect(rechecked.raw.map(({ parent, children }) => ({ parent, children }))).toEqual(
        after.raw.map(({ parent, children }) => ({ parent, children })),
      );
      expect(rechecked.count).toBe(after.count);
      expect(rechecked.balance).toEqual(after.balance);
      expect(writes.filter((w) => parentIds.includes(w.id))).toHaveLength(2);
    } finally {
      try {
        try {
          await manager?.disconnect();
        } finally {
          await mutations?.disconnect();
        }
      } finally {
        store?.close();
        try {
          if (created && seedConfig) {
            const budget: SeededBudget = created,
              config: ClientConfig = seedConfig;
            await withActualClient(
              async () => {
                await deleteBudget(budget.groupId, budget.budgetId);
                expect((await getBudgets()).some((b) => b.name === budget.budgetName)).toBe(false);
              },
              { ...config, dataDir: join(directory, 'cleanup') },
            );
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }, 240000);
});
