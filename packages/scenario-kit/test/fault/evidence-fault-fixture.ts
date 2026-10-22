import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { ActualConnector, NullCredentialStore } from '../../../actual-adapter/src/index.js';
import type { ActualClient } from '../../../actual-adapter/src/connector.js';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { GovernanceResourceKind, LiquidityActor } from '../../../workflow-store/src/index.js';
import {
  deriveProposalSourceReadFacts,
  consequentialActionPhaseRequirements,
} from '../../../workflow-store/src/proposal.js';
import {
  ConnectionManager,
  createTransactionEvidenceService,
  createLiquidityService,
  createConsequentialActionService,
} from '../../../application/src/index.js';
import type {
  ReceiptItemInferenceProvider,
  ReceiptInferencePayload,
} from '../../../inference/src/receipt-item.js';
import {
  DeriveEvidenceAllocationPlanRequestSchema,
  TransactionEvidenceRequestSchema,
} from '@balanceframe/protocol-generated/validators';

type TransactionEntity = Awaited<ReturnType<ActualClient['getTransactions']>>[number];
type APIAccountEntity = Awaited<ReturnType<ActualClient['getAccounts']>>[number];

const NOW = '2026-10-21T12:00:00.000Z';
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const load = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../protocol/fixtures/${name}`, import.meta.url), 'utf8'),
  );

/** Test-only SDK transport. Domain normalization, native proof, governance and journals remain real. */
export async function createEvidenceFaultFixture(options: { inference?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const directory = mkdtempSync(join(tmpdir(), 'evidence-service-fault-'));
  const database = join(directory, 'workflow.sqlite');
  let store = new SqliteWorkflowStore(database);
  let clockNow = NOW;
  const clock = () => new Date(clockNow);
  const auth = (actorId: string) => ({
    method: 'human-session' as const,
    actorId,
    sessionId: `synthetic:${actorId}`,
    reauthenticatedAt: clockNow,
  });
  await store.claimBootstrap({
    name: 'Synthetic owner',
    email: 'evidence-fault@example.invalid',
    claimId: 'synthetic',
  });
  await store.finalizeBootstrap({ claimId: 'synthetic', ownerUserId: 'owner' });
  await store.upsertActorMembership('owner', 'active', ['observe'], 'budget:budget');
  const space = store.governance.createSpace({
    actorId: 'owner',
    name: 'Synthetic evidence faults',
    kind: 'personal',
    now: clockNow,
    auth: auth('owner'),
  });
  store.governance.bindBudget({
    spaceId: space.id,
    budgetId: 'budget',
    now: clockNow,
    auth: auth('owner'),
  });
  store.governance.setPolicy({
    spaceId: space.id,
    expectedVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
    policy: { minimumApprovers: 1, assistanceMaximum: 'execute_approved_actions' },
    now: clockNow,
    auth: auth('owner'),
  });
  const actor = {
    actorId: 'owner',
    budgetId: 'budget',
    spaceId: space.id,
    membershipId: store.governance.getCurrentMembership({
      spaceId: space.id,
      actorId: 'owner',
      now: clockNow,
    })!.id,
    governancePolicyVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
    auth: auth('owner'),
  };
  const grant = (
    target: LiquidityActor,
    resourceKind: GovernanceResourceKind,
    resourceId: string,
    capability: string,
    granted = true,
  ) => {
    store.governance.setResourceGrant({
      ...target,
      spaceId: space.id,
      membershipId: target.membershipId!,
      resourceKind,
      resourceId,
      capability,
      granted,
      now: clockNow,
      auth: auth('owner'),
    });
  };
  const rights = [
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
    'item-rule:read',
    'category',
    'transaction',
    'transaction.view',
    'rule:view',
    'evidence',
    'normalized-evidence',
    'raw-document',
    'proposal',
    'ledger_projection:propose',
    'ledger_projection:execute',
    'wallet_materialization:propose',
    'wallet_materialization:execute',
    'ingest',
    'resolve',
    'receipt-inference:local',
    'receipt-inference:external',
    'receipt-inference:policy:manage',
  ];
  for (const [kind, id] of [
    ['budget', 'budget'],
    ['account', 'checking'],
    ['category', 'food'],
    ['category', 'reserve'],
    ['transaction', 'actual-bank-1'],
    ['transaction', 'actual-bank-2'],
    ['ledger_effect', 'actual-bank-1'],
    ['ledger_effect', 'actual-bank-2'],
  ] as const)
    for (const right of rights) grant(actor, kind, id, right);
  grant(actor, 'space', space.id, 'receipt-inference:policy:manage');
  const grantEvidence = (id: string) => {
    for (const right of rights) grant(actor, 'evidence', id, right);
  };
  const accounts: APIAccountEntity[] = [
    { id: 'checking', name: 'Checking', offbudget: false, closed: false, balance_current: 13000 },
  ];
  const categories = ['food', 'reserve'].map((id) => ({
    id,
    name: id === 'food' ? 'Groceries' : 'Reserve',
    group_id: 'expenses',
    is_income: false,
    hidden: false,
  }));
  const group = { id: 'expenses', name: 'Expenses', is_income: false, hidden: false };
  const rows: TransactionEntity[] = [];
  let changedReadback = false;
  let dispatchedPayload: ReceiptInferencePayload | null = null;
  const writes: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let loseSecond = false,
    loseOpening = false;
  let walletInput: {
    walletId: string;
    accountName: string;
    currency: string;
    opening: { amount: number; date: string };
  } | null = null;
  const unsupported = async (): Promise<never> => {
    throw new Error('Unrequested SDK mutation');
  };
  const client: ActualClient = {
    init: async () => ({
      getDataDir: () => directory,
      sendMessage: () => {},
      send: async () => undefined,
      amountToInteger: (v) => Math.round(v * 100),
      integerToAmount: (v) => v / 100,
    }),
    shutdown: async () => {},
    getBudgets: async () => [
      {
        id: 'budget',
        groupId: 'budget',
        name: 'Synthetic',
        cloudFileId: 'budget',
        encrypted: false,
        state: 'remote',
        owner: 'synthetic',
        encryptKeyId: '',
        hasKey: true,
        usersWithAccess: [],
      },
    ],
    downloadBudget: async () => {},
    loadBudget: async () => {},
    sync: async () => {},
    getServerVersion: async () => ({ version: '26.10.0' }),
    getAccounts: async () => structuredClone(accounts),
    getAccountBalance: async (id) => accounts.find((a) => a.id === id)?.balance_current ?? 0,
    getTransactions: async (id, start, end) =>
      structuredClone(
        rows
          .filter((r) => r.account === id && r.date >= start && r.date <= end)
          .map((row) =>
            changedReadback && row.id === 'actual-bank-2'
              ? { ...row, notes: 'Synthetic external edit after acknowledgement loss' }
              : row,
          ),
      ),
    getPayees: async () => [
      { id: 'person-1', name: 'person-1' },
      { id: 'starting-balance', name: 'Starting Balance' },
      ...accounts
        .filter((a) => a.id !== 'checking')
        .map((a) => ({ id: `transfer:${a.id}`, name: a.name, transfer_acct: a.id })),
    ],
    getCategories: async () => structuredClone(categories),
    getCategoryGroups: async () => [group],
    getBudgetMonths: async () => ['2026-10'],
    getBudgetMonth: async (month) => ({
      month,
      incomeAvailable: 0,
      lastMonthOverspent: 0,
      forNextMonth: 0,
      totalBudgeted: 20000,
      toBudget: 0,
      fromLastMonth: 0,
      totalIncome: 0,
      totalSpent: -1200,
      totalBalance: 18800,
      categoryGroups: [
        {
          ...group,
          categories: categories.map((c) => {
            const spent = rows
              .flatMap((row) => (row.subtransactions?.length ? row.subtransactions : [row]))
              .filter((row) => row.category === c.id)
              .reduce((sum, row) => sum + row.amount, 0);
            return { ...c, budgeted: 10000, spent, balance: 10000 + spent };
          }),
        },
      ],
    }),
    getRules: async () => [],
    getSchedules: async () => [],
    getTags: async () => [],
    runBankSync: async () => {},
    addTransactions: unsupported,
    createAccount: async (account, initialBalance) => {
      const id = 'synthetic-wallet-account';
      writes.push({ id, fields: { ...account, initialBalance } });
      accounts.push({ ...account, id, balance_current: initialBalance ?? 0 });
      rows.push({
        id: 'synthetic-opening-equity',
        account: id,
        date: clockNow.slice(0, 10),
        amount: initialBalance ?? 0,
        payee: 'starting-balance',
        cleared: true,
        reconciled: false,
        starting_balance_flag: true,
        is_parent: false,
        is_child: false,
      } as TransactionEntity);
      return id;
    },
    createRule: unsupported,
    deleteRule: unsupported,
    setBudgetAmount: unsupported,
    updateTransaction: async (id, fields) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index < 0) throw new Error('Missing synthetic SDK row');
      writes.push({ id, fields: structuredClone(fields) });
      rows[index] = { ...rows[index]!, ...structuredClone(fields) } as TransactionEntity;
      if (loseOpening && id === 'synthetic-opening-equity') {
        loseOpening = false;
        throw new Error('Synthetic lost equity date acknowledgement');
      }
      if (loseSecond && writes.length === 2) {
        loseSecond = false;
        throw new Error('Synthetic lost acknowledgement after committed second amendment');
      }
    },
  };
  const config = {
    version: 1,
    serverUrl: 'http://synthetic.invalid',
    budgetId: 'budget',
    groupId: 'budget',
    budgetName: 'Synthetic',
  };
  const manager = new ConnectionManager({
    readFile: async () => JSON.stringify(config),
    writeFile: async () => {},
    credentialStore: {
      load: async () => ({ serverUrl: config.serverUrl, secretKey: 'synthetic-only' }),
      store: async () => {},
    },
    connectorFactory: async () =>
      new ActualConnector({
        client,
        credentialStore: new NullCredentialStore(),
        mode: 'disposableSandbox',
        cacheDir: join(directory, 'sdk-cache'),
      }),
  });
  let inferenceSourceId = '';
  let localCalls = 0,
    networkCalls = 0;
  let held: { ready: () => void; wait: Promise<void> } | null = null;
  const provider: ReceiptItemInferenceProvider = {
    info: {
      id: 'synthetic-local',
      version: '1',
      model: 'synthetic',
      locality: 'local',
      configRevision: '1',
    },
    infer: async (payload, context) => {
      await context.dispatchGuard();
      localCalls += 1;
      dispatchedPayload = structuredClone(payload);
      const active = held;
      if (active) {
        active.ready();
        await active.wait;
      }
      return { categoryAlias: payload.categories[0]!.alias };
    },
  };
  const external: ReceiptItemInferenceProvider = {
    info: { ...provider.info, id: 'synthetic-external', locality: 'external' },
    infer: async () => {
      networkCalls += 1;
      throw new Error('Network provider dispatch forbidden');
    },
  };
  const policy = {
    local: { enabled: true, providerIds: [provider.info.id] },
    external: { enabled: true, providerIds: [external.info.id] },
    maxCallsPerDay: 10,
    cacheTtlSeconds: 60,
  };
  const installation = { installationId: 'synthetic-installation', revision: '1', policy };
  const makeServices = async () => {
    const evidence = await createTransactionEvidenceService({
      store,
      connectionManager: manager,
      rawEncryptionKey: Buffer.alloc(32, 7),
      clock,
      ...(options.inference
        ? {
            receiptInference: { installation: () => installation, providers: [provider, external] },
          }
        : {}),
    });
    const liquidity = await createLiquidityService({
      store,
      connectionManager: manager,
      mutationConnectionManager: manager,
      transactionEvidence: evidence,
      clock,
    });
    const consequential = await createConsequentialActionService({ store, liquidity, clock });
    return { evidence, liquidity, consequential };
  };
  let services = await makeServices();
  await services.liquidity.savePolicy(actor, {
    expectedVersion: null,
    expiresAt: '2026-10-22T12:00:00.000Z',
    accounts: [
      {
        accountId: 'checking',
        role: 'daily_spending',
        protectedBuffer: money('0'),
        paymentEligible: true,
        sourceEligible: true,
        backingEligible: true,
        eligibleCategoryIds: [],
        restrictedCashBucketIds: [],
        automationAllowed: false,
      },
    ],
    transferRoutes: [],
    approvalPolicy: { minimumApprovers: 1 },
  });
  actor.governancePolicyVersion = store.governance.getPolicy({ spaceId: space.id })!.version;
  await services.liquidity.saveObservations(actor, {
    expectedVersion: 0,
    expiresAt: '2026-10-22T12:00:00.000Z',
    observations: [
      {
        accountId: 'checking',
        currentLedgerConfirmed: true,
        kind: 'cash',
        currency: 'USD',
        owned: true,
        holds: money('0'),
      },
    ],
  });
  return {
    actor,
    writes,
    grantEvidence,
    now: () => clockNow,
    get store() {
      return store;
    },
    get evidence() {
      return services.evidence;
    },
    get consequential() {
      return services.consequential;
    },
    providerCalls: () => localCalls,
    dispatchedPayload: () => dispatchedPayload,
    changeReadback: (changed: boolean) => {
      changedReadback = changed;
    },
    externalCalls: () => networkCalls,
    accountCount: () => accounts.length,
    loseOpeningAcknowledgement: () => {
      loseOpening = true;
    },
    captureOpening: async () =>
      manager.withConnection(async ({ connector }) =>
        (connector as ActualConnector).readWalletOpeningEquity(
          walletInput!,
          'synthetic-wallet-account',
        ),
      ),
    async prepareWallet() {
      const imported = await services.evidence.ingest(actor, {
        connectorId: 'wallet',
        sourceId: 'synthetic-opening-statement',
        sourceTimestamp: clockNow,
        sourceKind: 'wallet',
        mediaType: 'application/pdf',
        content: '%PDF-1.4\nSynthetic local statement: opening USD12, no activity, closing USD12',
      });
      grantEvidence(imported.document.id);
      const selector = {
        statementDocumentId: imported.document.id,
        wallet: { kind: 'new', label: 'Synthetic wallet', currency: 'USD' },
        startDate: '2026-10-01',
        endDate: '2026-10-20',
        openingBalance: money('1200'),
        closingBalance: money('1200'),
      };
      const preview = await services.evidence.previewWalletStatement(actor, selector);
      const admitted = await services.evidence.attestWalletStatement(actor, {
        ...selector,
        previewHash: preview.previewHash,
        expectedProofFoldHash: preview.proofFoldHash,
        originalAcknowledged: true,
        completeActivityAcknowledged: true,
      });
      for (const right of rights) grant(actor, 'wallet', admitted.proof.walletId, right);
      const context = await services.evidence.walletStatementContext(actor);
      const anchor = context.resolution.wallets[0]!.balanceAnchors!.find(
        (a) => a.boundary === 'before_day_activity',
      )!;
      const action = await services.evidence.prepareWalletMaterialization(actor, {
        resolutionHash: context.resolution.resolutionHash,
        walletId: anchor.walletId,
        proofSetHash: anchor.proofSetHash,
        activityManifestHash: anchor.activityManifestHash,
        asOfDate: anchor.asOfDate,
        accountName: 'Synthetic wallet account',
      });
      if (action.kind !== 'wallet_materialization' || !action.opening)
        throw new Error('Native wallet opening required');
      walletInput = {
        walletId: action.walletId,
        accountName: action.accountName,
        currency: action.currency,
        opening: { amount: Number(action.opening!.amount.minorUnits), date: action.opening!.date },
      };
      return action;
    },
    loseAmendmentAcknowledgement: () => {
      loseSecond = true;
    },
    captureParents: async () =>
      manager.withConnection(async ({ connector }) =>
        Promise.all(
          ['actual-bank-1', 'actual-bank-2'].map((transactionId) =>
            (connector as ActualConnector).captureEvidenceTransaction({
              budgetId: 'budget',
              accountId: 'checking',
              transactionId,
            }),
          ),
        ),
      ),
    async prepareMatrix() {
      rows.push(
        ...[700, 500].map(
          (amount, i) =>
            ({
              id: `actual-bank-${i + 1}`,
              account: 'checking',
              date: '2026-10-16',
              amount: -amount,
              payee: 'person-1',
              category: 'food',
              notes: `Synthetic imported note ${i}`,
              imported_id: `synthetic-import-${i}`,
              imported_payee: 'Synthetic retailer',
              cleared: true,
              reconciled: false,
              is_parent: false,
              is_child: false,
            }) as TransactionEntity,
        ),
      );
      await services.liquidity.saveObservations(actor, {
        expectedVersion: 1,
        expiresAt: '2026-10-22T12:00:00.000Z',
        observations: [
          {
            accountId: 'checking',
            currentLedgerConfirmed: true,
            kind: 'cash',
            currency: 'USD',
            owned: true,
            holds: money('0'),
          },
        ],
      });
      const allocation = DeriveEvidenceAllocationPlanRequestSchema.parse(
        load('evidence-allocation-plan.json'),
      );
      const receipt = structuredClone(allocation.evidence.receipts[0]!);
      const { provenance: _provenance, ...observation } = structuredClone(
        allocation.evidence.observations.find((o) => o.kind === 'receipt')!,
      );
      observation.fundingInstrumentId = 'checking';
      receipt.lines = [0, 1].map((i) => ({
        ...structuredClone(receipt.lines[0]!),
        id: `line-${i + 1}`,
        sku: `synthetic-sku-${i}`,
        rawDescription: `Synthetic reviewed item ${i}`,
        unitGross: money('600'),
        gross: money('600'),
        net: money('600'),
      }));
      for (const tender of receipt.tenders) tender.observationId = null;
      const imported = await services.evidence.ingest(actor, {
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
      grantEvidence(imported.document.id);
      const unreviewed = await services.evidence.resolve(actor, {
        policyVersion: actor.governancePolicyVersion,
      });
      const selector = {
        resolutionHash: unreviewed.resolutionHash,
        targetTransactionIds: ['actual-bank-1', 'actual-bank-2'],
        receiptIds: [receipt.id],
        lineCategories: receipt.lines.map((line, i) => ({
          receiptId: receipt.id,
          lineId: line.id,
          accountId: 'checking',
          categoryId: i ? 'reserve' : 'food',
        })),
        cells: [
          ['line-1', 'actual-bank-1', '400'],
          ['line-1', 'actual-bank-2', '200'],
          ['line-2', 'actual-bank-1', '300'],
          ['line-2', 'actual-bank-2', '300'],
        ].map(([lineId, targetTransactionId, amount]) => ({
          receiptId: receipt.id,
          lineId,
          targetTransactionId,
          amount: money(amount!),
        })),
      };
      const preview = await services.evidence.previewAllocation(actor, selector);
      const reviewed = await services.evidence.saveAllocation(actor, {
        ...selector,
        allocationSetHash: preview.allocationSetHash,
      });
      const event = reviewed.events.find(
        (e) => e.projectionObservation || e.projectionObservations?.length,
      )!;
      const action = await services.evidence.prepareLedgerAction(actor, {
        resolutionHash: reviewed.resolutionHash,
        eventId: event.id,
        allocationSetHash: preview.allocationSetHash,
      });
      return { action, preview };
    },
    async approve(proposalId: string) {
      const stored = await store.getProposal(proposalId);
      if (!stored || stored.operation !== 'consequential_action')
        throw new Error('Exact stored consequential proposal required');
      const id = 'independent-approver';
      await store.upsertActorMembership(id, 'active', ['observe'], 'budget:budget');
      const member = store.governance.addMembership({
        spaceId: space.id,
        actorId: id,
        validFrom: clockNow,
        now: clockNow,
        auth: auth('owner'),
      });
      const approver = { ...actor, actorId: id, membershipId: member.id, auth: auth(id) };
      const reads = deriveProposalSourceReadFacts(
        stored.operation,
        stored.payload,
        JSON.parse(stored.preconditions),
        actor.budgetId,
      )!;
      for (const requirement of [
        ...reads.required,
        ...consequentialActionPhaseRequirements(stored.payload.plan, actor.budgetId, 'approve'),
      ])
        grant(approver, requirement.resourceKind, requirement.resourceId, requirement.capability);
      await store.createApproval({
        proposalId,
        payloadHash: stored.payloadHash,
        actorId: id,
        expiresAt: stored.expiresAt,
        auth: approver.auth,
        now: clockNow,
      });
    },
    async reopenAfterExpiry(proposalId: string) {
      const stored = await store.getProposal(proposalId);
      if (!stored) throw new Error('Stored proposal required');
      clockNow = new Date(Date.parse(stored.expiresAt) + 1000).toISOString();
      vi.setSystemTime(new Date(clockNow));
      store.close();
      store = new SqliteWorkflowStore(database);
      services = await makeServices();
    },
    async prepareInference() {
      const source = TransactionEvidenceRequestSchema.parse(
        (load('transaction-evidence-rule.json') as { evidence: unknown }).evidence,
      );
      const observations = source.observations
        .filter((o) => o.kind !== 'ledger_transaction')
        .map(({ provenance: _p, ...row }) => ({
          ...row,
          ...(row.id === 'wallet-1' ? { kind: 'receipt', eventType: 'purchase' } : {}),
        }));
      const receipts = source.receipts.map((receipt) => ({
        ...receipt,
        tenders: receipt.tenders.map((t) => ({ ...t, observationId: null })),
      }));
      const saved = await services.evidence.ingest(actor, {
        connectorId: 'retail',
        sourceId: 'receipt-1',
        sourceTimestamp: clockNow,
        sourceKind: 'retail',
        mediaType: 'application/json',
        content: JSON.stringify({ templateVersion: 'retail-v1', observations, receipts }),
      });
      grantEvidence(saved.document.id);
      inferenceSourceId = saved.document.id;
      return {
        accountId: 'checking',
        receiptId: 'receipt-1',
        lineId: 'line-1',
        locality: 'local' as const,
      };
    },
    async enableInference() {
      for (const layer of ['space', 'budget'] as const) {
        const current = await services.evidence.receiptInferencePolicy(actor, { layer });
        await services.evidence.updateReceiptInferencePolicy(actor, {
          layer,
          expectedRevision: current.revision,
          policy,
        });
      }
    },
    holdInference() {
      let ready!: () => void, release!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { ready, wait };
      return { dispatched, release };
    },
    async revokeInference(
      kind: 'consent' | 'source' | 'policy' | 'grant',
      preview: { previewId: string; payloadHash: string },
    ) {
      if (kind === 'consent')
        await services.evidence.receiptInferenceWithdraw(actor, {
          previewId: preview.previewId,
          payloadHash: preview.payloadHash,
          action: 'revoked',
        });
      if (kind === 'source')
        grant(actor, 'evidence', inferenceSourceId, 'normalized-evidence', false);
      if (kind === 'policy') {
        const current = await services.evidence.receiptInferencePolicy(actor, { layer: 'budget' });
        await services.evidence.updateReceiptInferencePolicy(actor, {
          layer: 'budget',
          expectedRevision: current.revision,
          policy: { ...policy, local: { ...policy.local, enabled: false } },
        });
      }
      if (kind === 'grant') grant(actor, 'budget', 'budget', 'receipt-inference:local', false);
    },
    async close() {
      try {
        await manager.disconnect();
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
  };
}
