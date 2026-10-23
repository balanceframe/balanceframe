import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type {
  GovernanceAuthorizationInput,
  GovernanceAuthorizationResult,
  GovernanceReadDisclosureLimits,
  GovernanceResourceKind,
  GovernedLiquidityPolicy,
  LiquidityActor,
  LiquidityPolicyRecord,
  TransferApprovalPolicy,
} from '@balanceframe/workflow-store';
import type {
  FinancialSnapshot,
  Money,
  Payee,
  Transaction,
  TransferSettlementRecord,
  PlanConsequentialActionRequest,
} from '@balanceframe/protocol-generated';
import { sourceObservationSchema } from '@balanceframe/protocol-generated/validators';
import {
  normalizeAccounts,
  normalizeActualLiquidityFacts,
  normalizeBudgetMonth,
  normalizeCategories,
  withLiquidityFacts,
} from '../../actual-adapter/src/normalizer.js';
import type {
  EvidenceTransactionSource,
  ManualTransactionInput,
  ManualTransactionResult,
} from '@balanceframe/actual-adapter';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import {
  deriveProposalAuthorizationFacts,
  deriveProposalDisclosureTotals,
  deriveProposalSourceReadFacts,
} from '../../workflow-store/src/proposal.js';
import { ConnectionManager } from '../src/connection-manager.js';
import type { ConnectionManagerOptions } from '../src/connection-manager.js';
import {
  ConsequentialActionService,
  type ConsequentialActionNative,
} from '../src/consequential-action.js';
import { LiquidityService, type LiquidityNative } from '../src/liquidity-service.js';

const now = '2026-09-06T10:00:00.000Z';
const expiresAt = '2026-09-06T10:15:00.000Z';
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const nativeModule = createRequire(import.meta.url)('@balanceframe/native') as LiquidityNative &
  ConsequentialActionNative;
const actionFixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/consequential-action.json', import.meta.url),
    'utf8',
  ),
) as {
  intent: {
    kind: 'reallocation';
    assignments: Array<{
      sourceCategoryId: string;
      sourceAsOfMonth: string;
      destinationCategoryId: string;
      destinationAsOfMonth: string;
      amount: { minorUnits: string; currency: string };
    }>;
  };
  compositeIntent: { kind: 'composite'; actions: readonly unknown[] };
};
const accountAwarePolicy = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/account-aware-liquidity.json', import.meta.url),
    'utf8',
  ),
) as { liquidityPolicy: GovernedLiquidityPolicy };
const canonicalSource = actualLiquidityRequest(false).financialSnapshot;
const canonicalTransaction = JSON.parse(
  readFileSync(new URL('../../../protocol/fixtures/representative.json', import.meta.url), 'utf8'),
) as { transactions: Transaction[] };

interface EconomicEventLedgerEffect {
  readonly accountId: string;
  readonly amount: Money;
  readonly date: string;
  readonly categoryId: string | null;
  readonly payeeName: string | null;
  readonly notes: string | null;
  readonly splits: readonly { readonly categoryId: string; readonly amount: Money }[];
}
interface EconomicEventResolution {
  readonly subjectId: string;
  readonly evidenceId: string;
  readonly contentHash: string;
  readonly version: string;
  readonly observedAt: string;
  readonly ledgerEffect: EconomicEventLedgerEffect;
  readonly allocationReview?: import('@balanceframe/protocol-generated').EvidenceAllocationReview;
}
interface AccountState {
  name: string;
  balance: number;
  onBudget: boolean;
  closed: boolean;
  currency?: string;
}

interface SourceState {
  accounts: Record<string, AccountState>;
  payees: Payee[];
  assignments: Record<string, number>;
  spent: Record<string, number>;
  transactions: Transaction[];
  transferSettlementRecords: TransferSettlementRecord[];
  evidenceState: 'fresh' | 'stale';
  evidenceObservedAt: string;
  resolution: EconomicEventResolution | null;
  additionalResolutions?: EconomicEventResolution[];
  additionalObservations?: FinancialSnapshot['observations'];
  transactionCoverage: 'complete' | 'empty' | 'partial';
  capturedAt: string;
}
interface AssignmentPrecondition {
  readonly budgetId: string;
  readonly expectedAmount: number;
  readonly currency: string;
  readonly assertExecutionCurrent: () => void;
}
interface WritePrecondition {
  readonly budgetId: string;
  readonly assertExecutionCurrent: () => void;
}
interface WalletIntent {
  readonly walletId: string;
  readonly accountName: string;
  readonly currency: string;
  readonly opening?: { amount: number; date: string };
}
interface WalletResult {
  readonly success: true;
  readonly verified: true;
  readonly walletId: string;
  readonly accountId: string;
  readonly openingEquity?: import('@balanceframe/actual-adapter').WalletOpeningEquity;
}
interface TransferIntent {
  readonly kind: 'transfer';
  readonly transferId: string;
  readonly correlationId: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly amount: { readonly minorUnits: string; readonly currency: string };
  readonly date: string;
}
interface LedgerTransferInput {
  readonly transferId: string;
  readonly correlationId: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly amount: number;
  readonly date: string;
}
interface TransferPrecondition extends WritePrecondition {
  readonly sourceBalance: number;
  readonly destinationBalance: number;
  readonly currency: string;
}
interface TransferResult {
  readonly success: true;
  readonly verified: true;
  readonly transferId: string;
  readonly sourceTransactionId: string;
  readonly destinationTransactionId: string;
}
type WriteRecord =
  | {
      kind: 'assignment';
      month: string;
      categoryId: string;
      amount: number;
      expectedAmount: number;
    }
  | { kind: 'manual'; parentId: string; amount: number; splits: number }
  | { kind: 'wallet'; walletId: string; accountId: string }
  | { kind: 'transfer'; transferId: string; sourceId: string; destinationId: string };

function auth(actorId: string, reauthenticatedAt = now) {
  return {
    method: 'human-session' as const,
    actorId,
    sessionId: `session:${actorId}`,
    reauthenticatedAt,
  };
}
function initialState(): SourceState {
  return {
    accounts: {
      checking: { name: 'Checking', balance: 13000, onBudget: true, closed: false },
      savings: { name: 'Savings', balance: 20000, onBudget: true, closed: false },
    },
    payees: [],
    assignments: { food: 0, reserve: 6000, 'reserve-two': 6000 },
    spent: { food: 0, reserve: 0, 'reserve-two': 0 },
    transactions: [],
    transferSettlementRecords: [],
    evidenceState: 'fresh',
    evidenceObservedAt: now,
    resolution: {
      subjectId: 'bank-event-purchase-1',
      evidenceId: 'economic-event-resolution-purchase-1',
      contentHash: 'sha256:bank-event-purchase-1-content-v1',
      version: 'resolution-v1',
      observedAt: now,
      ledgerEffect: {
        accountId: 'checking',
        amount: money('-500'),
        date: '2026-09-06',
        categoryId: 'food',
        payeeName: 'Local shop',
        notes: 'manual note',
        splits: [],
      },
    },
    transactionCoverage: 'empty',
    capturedAt: now,
  };
}
function snapshot(state: SourceState, capturedAt = now): FinancialSnapshot {
  const rawAccounts = Object.entries(state.accounts).map(([id, account]) => ({
    id,
    name: account.name,
    offbudget: !account.onBudget,
    closed: account.closed,
    balance_current: account.balance,
  }));
  const rawCategories = [
    { id: 'food', name: 'Food', group_id: 'living', is_income: false, hidden: false },
    { id: 'reserve', name: 'Reserve', group_id: 'living', is_income: false, hidden: false },
    { id: 'reserve-two', name: 'Reserve two', group_id: 'living', is_income: false, hidden: false },
    {
      id: 'income',
      name: 'Starting balances',
      group_id: 'income-group',
      is_income: true,
      hidden: false,
    },
  ];
  const rawGroups = [
    { id: 'living', name: 'Living', is_income: false, hidden: false },
    { id: 'income-group', name: 'Income', is_income: true, hidden: false },
  ];
  const monthCategories = ['food', 'reserve', 'reserve-two'].map((id) => ({
    id,
    budgeted: state.assignments[id] ?? 0,
    spent: state.spent[id] ?? 0,
    balance: (state.assignments[id] ?? 0) + (state.spent[id] ?? 0),
  }));
  const legacySnapshot = {
    ...canonicalSource.legacySnapshot,
    snapshotDate: capturedAt,
    actualDownloadedAt: capturedAt,
    accounts: normalizeAccounts(rawAccounts),
    categories: normalizeCategories(rawCategories, rawGroups),
    budgets: [normalizeBudgetMonth('2026-09', state.assignments)],
    transactions: state.transactions,
    payees: state.payees,
  };
  const ledgerHash = `sha256:${createHash('sha256').update(JSON.stringify(legacySnapshot)).digest('hex')}`;
  const observations: FinancialSnapshot['observations'] = [
    {
      kind: 'account_freshness',
      scope: { kind: 'account', id: 'checking' },
      state: state.evidenceState,
      observedAt: state.evidenceObservedAt,
      evidence: [
        {
          evidenceId: 'checking-freshness',
          kind: 'bank_sync',
          authorized: true,
          redaction: 'visible',
        },
      ],
    },
  ];
  observations.push(...(state.additionalObservations ?? []));
  for (const resolution of [state.resolution, ...(state.additionalResolutions ?? [])].filter(
    (item): item is EconomicEventResolution => item !== null,
  )) {
    observations.push({
      kind: 'economic_event_resolution',
      ...(resolution.allocationReview ? { allocationReview: resolution.allocationReview } : {}),
      scope: { kind: 'transaction', id: resolution.subjectId },
      state: 'resolved',
      observedAt: resolution.observedAt,
      contentHash: resolution.contentHash,
      version: resolution.version,
      ledgerEffect: resolution.ledgerEffect,
      evidence: [
        {
          evidenceId: resolution.evidenceId,
          kind: 'economic_event_resolution',
          authorized: true,
          redaction: 'visible',
        },
      ],
    });
  }
  const sourceHash = `sha256:${createHash('sha256').update(JSON.stringify({ ledgerHash, observations })).digest('hex')}`;
  const ledger = {
    ...canonicalSource,
    snapshotId: `actual:fixture:fixture:${sourceHash}`,
    contentHash: sourceHash,
    capturedAt,
    legacySnapshot,
    coverage: {
      ...canonicalSource.coverage,
      accounts: 'complete' as const,
      categories: 'complete' as const,
      budgets: 'complete' as const,
      transactions: state.transactionCoverage,
      payees: state.payees.length ? ('complete' as const) : ('empty' as const),
    },
    observations,
  };
  const rawMonth = {
    month: '2026-09',
    categoryGroups: [{ id: 'living', categories: monthCategories }],
  };
  const liquidityInput = {
    capturedAt,
    ledgerContentHash: ledgerHash,
    currency: 'USD',
    accounts: { available: true, items: rawAccounts },
    categories: { available: true, items: rawCategories },
    budgetMonths: [rawMonth],
    transactions: rawAccounts.map(({ id }) => ({
      accountId: id,
      read: { available: true as const, items: [] },
    })),
    schedules: { available: true as const, items: [] },
  } satisfies Parameters<typeof normalizeActualLiquidityFacts>[0];
  const facts = normalizeActualLiquidityFacts(liquidityInput);
  facts.accounts = facts.accounts.map((fact) => {
    const currency = state.accounts[fact.accountId]?.currency;
    return currency
      ? normalizeActualLiquidityFacts({ ...liquidityInput, currency }).accounts.find(
          (candidate) => candidate.accountId === fact.accountId,
        )!
      : fact;
  });
  return withLiquidityFacts(ledger, facts);
}
function manualRow(input: ManualTransactionInput, id = input.parentId): Transaction {
  const parent = canonicalTransaction.transactions[0];
  if (!parent) throw new Error('Canonical transaction fixture is required');
  return {
    ...parent,
    id,
    accountId: input.accountId,
    date: input.date,
    amount: money(String(input.amount)),
    categoryId: input.splits?.length ? null : (input.categoryId ?? null),
    payeeId: input.payeeName ? `manual-payee-${input.payeeName}` : null,
    payeeName: input.payeeName ?? null,
    notes: input.notes ?? null,
    cleared: false,
    reconciled: false,
    tags: [],
    importedId: null,
    importedPayee: null,
    transferAccountId: null,
    subtransactions: (input.splits ?? []).map((split, index) => ({
      ...parent,
      id: `${input.parentId}:split:${index + 1}`,
      accountId: split.accountId,
      date: split.date,
      amount: money(String(split.amount)),
      categoryId: split.categoryId,
      payeeName: null,
      notes: null,
      cleared: false,
      reconciled: false,
      tags: [],
      importedId: null,
      importedPayee: null,
      transferAccountId: null,
      subtransactions: [],
    })),
  };
}
function transferRow(
  id: string,
  accountId: string,
  counterparty: string | null,
  amount: number,
  date: string,
  marker: string,
): Transaction {
  const parent = canonicalTransaction.transactions[0];
  if (!parent) throw new Error('Canonical transaction fixture is required');
  return {
    ...parent,
    id,
    accountId,
    date,
    amount: money(String(amount)),
    categoryId: null,
    payeeName: 'Transfer',
    notes: marker,
    cleared: false,
    reconciled: false,
    tags: [],
    importedId: null,
    importedPayee: null,
    transferAccountId: counterparty,
    subtransactions: [],
  };
}

interface Fixture {
  actor: LiquidityActor;
  directory: string;
  store: SqliteWorkflowStore;
  service: ConsequentialActionService;
  liquidity: LiquidityService;
  state: SourceState;
  writes: WriteRecord[];
  nativePlans: PlanConsequentialActionRequest[];
  clockNow: string;
  setClock(value: string): void;
  setAssistanceMaximum(
    value:
      | 'analysis_only'
      | 'recommend_actions'
      | 'create_approval_proposal'
      | 'execute_approved_actions',
  ): void;
  saveLiquidityPolicy(
    patch?: Partial<GovernedLiquidityPolicy>,
    approvalPolicy?: TransferApprovalPolicy,
  ): LiquidityPolicyRecord;
  grant(
    target: LiquidityActor,
    kind: GovernanceResourceKind,
    id: string,
    capability: string,
    granted?: boolean,
    restrictions?: {
      readonly maxOperationCount?: number;
      readonly maxGrossOutgoing?: readonly {
        readonly currency: string;
        readonly minorUnits: string;
      }[];
    },
  ): void;
  refreshObservations(expiresAt?: string): Promise<void>;
  approve(proposalId: string, target: LiquidityActor): Promise<void>;
  source(capturedAt?: string): FinancialSnapshot;
  cleanup(): void;
  failManualAfterWrite: boolean;
  failTransferLink: boolean;
  pauseBeforeManualFence: (() => Promise<void>) | null;
  beforeAssignmentFence: (() => Promise<void>) | null;
  beforeAmendmentCapture: (() => Promise<void>) | null;
  amendmentProofValid: boolean;
  amendmentWrites: number;
  failBeforeDispatch: 'manual' | 'wallet' | 'transfer' | null;
}
const financialCapabilities = [
  'conclusion',
  'existence',
  'name',
  'balance',
  'history',
  'liquidity',
  'source',
  'category',
  'proposal',
  'approval',
  'initiation-report',
  'confirmation',
  'audit',
  'policy',
  'session',
  'full-read',
  'evidence',
  'reallocation:propose',
  'reallocation:approve',
  'reallocation:execute',
  'transaction:propose',
  'transaction:approve',
  'transaction:execute',
  'ledger_projection:propose',
  'ledger_projection:approve',
  'ledger_projection:execute',
  'wallet_materialization:propose',
  'wallet_materialization:approve',
  'wallet_materialization:execute',
  'transfer:propose',
  'transfer:approve',
  'transfer:execute',
] as const;

async function createFixture(): Promise<Fixture> {
  let clockNow = now;
  let policyVersionSequence = 0;
  const uniqueNativePolicyVersion = () => `native-policy-${++policyVersionSequence}`;
  const state = initialState();
  const writes: WriteRecord[] = [];
  const nativePlans: PlanConsequentialActionRequest[] = [];
  const traceNative = process.env.PHASE9_TRACE_NATIVE === '1';
  const plannedRequests = new Map<string, unknown>();
  const tracePrivateRead = process.env.PHASE9_TRACE_PRIVATE_READ === '1';
  const privateReadTrace: unknown[] = [];
  const privateReadTracePath = join(tmpdir(), 'balanceframe-phase9-private-read.json');
  const recordPrivateRead = (
    method: string,
    input: GovernanceAuthorizationInput,
    limits: GovernanceReadDisclosureLimits | null,
    result: GovernanceAuthorizationResult,
  ): void => {
    if (
      !tracePrivateRead ||
      input.phase !== 'read' ||
      !input.required.some((required) => required.capability === 'full-read')
    )
      return;
    privateReadTrace.push({
      method,
      operation: input.operation,
      required: input.required,
      resources: input.payload.resources ?? null,
      operations: input.payload.operations,
      limits,
      result: { allowed: result.allowed, reason: result.reason },
    });
    writeFileSync(privateReadTracePath, JSON.stringify(privateReadTrace, null, 2), { mode: 0o600 });
  };
  const fixtureNative: LiquidityNative & ConsequentialActionNative = {
    ...nativeModule,
    planConsequentialAction(input: string): string {
      nativePlans.push(JSON.parse(input) as PlanConsequentialActionRequest);
      const response = nativeModule.planConsequentialAction(input);
      if (traceNative) {
        const plan = JSON.parse(response) as { actionHash?: unknown };
        if (typeof plan.actionHash === 'string')
          plannedRequests.set(plan.actionHash, JSON.parse(input) as unknown);
      }
      return response;
    },
    verifyConsequentialAction(input: string): string {
      const response = nativeModule.verifyConsequentialAction(input);
      if (traceNative) {
        const verifyRequest = JSON.parse(input) as {
          plan: { actionHash: string; idempotencyKey: string };
          phase: string;
        };
        const verification = JSON.parse(response) as { valid?: unknown };
        if (verification.valid === false)
          writeFileSync(
            join(
              tmpdir(),
              `balanceframe-phase9-native-${verifyRequest.plan.idempotencyKey}-${verifyRequest.phase}.json`,
            ),
            JSON.stringify(
              {
                plannedRequest: plannedRequests.get(verifyRequest.plan.actionHash) ?? null,
                verifyRequest,
                verification,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
      }
      return response;
    },
  };
  const directory = mkdtempSync(join(tmpdir(), 'consequential-action-'));
  let cleanup = () => rmSync(directory, { recursive: true, force: true });
  setupCleanup = cleanup;
  const store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
  cleanup = () => {
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  setupCleanup = cleanup;
  if (tracePrivateRead) {
    const authorize = store.governance.authorize.bind(store.governance);
    vi.spyOn(store.governance, 'authorize').mockImplementation((input) => {
      const result = authorize(input);
      recordPrivateRead('authorize', input, null, result);
      return result;
    });
    const authorizeReadDisclosure = store.governance.authorizeReadDisclosure.bind(store.governance);
    vi.spyOn(store.governance, 'authorizeReadDisclosure').mockImplementation((input, limits) => {
      const result = authorizeReadDisclosure(input, limits);
      recordPrivateRead('authorizeReadDisclosure', input, limits, result);
      return result;
    });
  }
  await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
  await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: 'holder' });
  await store.upsertActorMembership('holder', 'active', ['observe'], 'budget:fixture');
  const initialActor = {
    actorId: 'holder',
    budgetId: 'fixture',
    spaceId: '',
    membershipId: '',
    governancePolicyVersion: '',
    now,
    auth: auth('holder'),
  } satisfies LiquidityActor;
  const space = store.governance.createSpace({
    actorId: initialActor.actorId,
    name: 'Consequential action fixture',
    kind: 'personal',
    now,
    auth: initialActor.auth,
  });
  const membership = store.governance.getCurrentMembership({
    spaceId: space.id,
    actorId: 'holder',
    now,
  });
  if (!membership) throw new Error('Fixture owner membership required');
  let actor: LiquidityActor = {
    ...initialActor,
    spaceId: space.id,
    membershipId: membership.id,
  };
  const policy = store.governance.getPolicy({ spaceId: space.id });
  if (!policy) throw new Error('Fixture governance policy required');
  store.governance.setPolicy({
    spaceId: space.id,
    expectedVersion: policy.version,
    policy: { minimumApprovers: 1, assistanceMaximum: 'execute_approved_actions' },
    now,
    auth: actor.auth,
  });
  store.governance.bindBudget({
    spaceId: space.id,
    budgetId: actor.budgetId,
    now,
    auth: actor.auth,
  });
  const currentPolicy = store.governance.getPolicy({ spaceId: space.id });
  if (!currentPolicy) throw new Error('Fixture governance policy required');
  actor = { ...actor, governancePolicyVersion: currentPolicy.version };

  const grant = (
    target: LiquidityActor,
    resourceKind: GovernanceResourceKind,
    resourceId: string,
    capability: string,
    granted = true,
    restrictions?: {
      readonly maxOperationCount?: number;
      readonly maxGrossOutgoing?: readonly {
        readonly currency: string;
        readonly minorUnits: string;
      }[];
    },
  ): void => {
    store.governance.setResourceGrant({
      spaceId: target.spaceId!,
      actorId: target.actorId,
      budgetId: target.budgetId,
      membershipId: target.membershipId!,
      resourceKind,
      resourceId,
      capability,
      granted,
      ...(restrictions === undefined ? {} : { restrictions }),
      now: clockNow,
      auth: auth('holder', clockNow),
    });
  };
  const resources = [
    ['budget', actor.budgetId],
    ['account', 'checking'],
    ['account', 'savings'],
    ['category', 'food'],
    ['category', 'reserve'],
    ['category', 'reserve-two'],
    ['evidence', 'checking-freshness'],
    ['evidence', 'economic-event-resolution-purchase-1'],
    ['evidence', 'checking'],
    ['evidence', 'bank-event-purchase-1'],
    ['wallet', 'wallet-one'],
    ['transfer', 'transfer-one'],
    ['transfer', 'transfer-prefix'],
    ...[
      'settlement',
      'evidence-credit-two',
      'evidence-credit',
      'manual-single',
      'manual-split',
      'evidence-projection',
      'manual-parent-composite-1',
      'manual-current-decision-time',
      'manual-prefix-transfer',
    ].flatMap(
      (id) =>
        [
          ['transaction', id],
          ['ledger_effect', id],
        ] as const,
    ),
  ] as const;
  for (const [kind, id] of resources) {
    for (const capability of financialCapabilities) {
      if (capability === 'full-read') {
        if (kind === 'budget') {
          grant(actor, kind, id, capability, true, {
            maxGrossOutgoing: [{ currency: 'USD', minorUnits: '4000' }],
          });
        } else if (kind !== 'account' && kind !== 'category' && kind !== 'transaction') {
          grant(actor, kind, id, capability);
        }
      } else {
        grant(actor, kind, id, capability);
      }
    }
  }
  grant(actor, 'space', actor.spaceId!, 'existence');
  grant(actor, 'space', actor.spaceId!, 'full-read');
  grant(actor, 'budget', actor.budgetId, 'observe');
  for (const [kind, id] of resources) {
    if (kind === 'transaction') grant(actor, kind, id, 'transaction.view');
    if (kind === 'evidence') grant(actor, kind, id, 'normalized-evidence');
    if (kind === 'transfer') grant(actor, kind, id, 'transfer.view');
  }

  const managerOptions = (): ConnectionManagerOptions => ({
    readFile: async () =>
      JSON.stringify({
        version: 1,
        serverUrl: 'http://actual',
        budgetId: 'fixture',
        budgetName: 'Fixture',
        groupId: 'fixture',
      }),
    writeFile: async () => {},
    credentialStore: {
      load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
      store: async () => {},
    },
    connectorFactory: async () => ({
      connect: async () => [],
      selectBudget: async () => ({
        id: 'fixture',
        groupId: 'fixture',
        name: 'Fixture',
        encrypted: false,
      }),
      synchronize: async () => ({
        financialSnapshot: snapshot(state, state.capturedAt),
        snapshot: snapshot(state, state.capturedAt).legacySnapshot,
        transferSettlementRecords: state.transferSettlementRecords,
      }),
      setBudgetAmount: async (
        month: string,
        categoryId: string,
        amount: number,
        precondition: AssignmentPrecondition,
      ) => {
        if (precondition.budgetId !== 'fixture' || precondition.currency !== 'USD')
          throw new Error('Assignment source changed');
        if (fixture.beforeAssignmentFence) await fixture.beforeAssignmentFence();
        if (precondition.expectedAmount !== state.assignments[categoryId])
          return {
            success: false,
            error: 'Assignment source changed',
            code: 'PRECONDITION_MISMATCH',
          };
        precondition.assertExecutionCurrent();
        writes.push({
          kind: 'assignment',
          month,
          categoryId,
          amount,
          expectedAmount: precondition.expectedAmount,
        });
        state.assignments[categoryId] = amount;
        return { success: true, id: categoryId, verified: true };
      },
      createManualTransaction: async (
        input: ManualTransactionInput,
        precondition: WritePrecondition,
      ): Promise<ManualTransactionResult> => {
        await Promise.resolve(); // model the adapter's awaited source reads before its final fence
        if (precondition.budgetId !== 'fixture') throw new Error('Selected budget changed');
        if (fixture.pauseBeforeManualFence) await fixture.pauseBeforeManualFence();
        if (
          input.splits?.some(
            (split) => split.accountId !== input.accountId || split.date !== input.date,
          )
        )
          throw new Error('Split account/date must match the approved parent transaction');
        if (fixture.failBeforeDispatch === 'manual')
          return {
            success: false,
            parentId: input.parentId,
            correlationId: input.correlationId,
            error: 'Manual pre-dispatch validation failed',
            code: 'PRECONDITION_READ_FAILED',
          };
        precondition.assertExecutionCurrent();
        writes.push({
          kind: 'manual',
          parentId: input.parentId,
          amount: input.amount,
          splits: input.splits?.length ?? 0,
        });
        if (input.payeeName && !state.payees.some((payee) => payee.name === input.payeeName))
          state.payees.push({
            id: `manual-payee-${input.payeeName}`,
            name: input.payeeName,
            transferAccountId: null,
            mtid: null,
          });
        state.transactions = [...state.transactions, manualRow(input)];
        state.accounts[input.accountId]!.balance += input.amount;
        for (const split of input.splits ?? [])
          state.spent[split.categoryId] = (state.spent[split.categoryId] ?? 0) + split.amount;
        if (!input.splits?.length && input.categoryId)
          state.spent[input.categoryId] = (state.spent[input.categoryId] ?? 0) + input.amount;
        state.transactionCoverage = 'complete';
        if (fixture.failManualAfterWrite)
          return {
            success: false,
            parentId: input.parentId,
            correlationId: input.correlationId,
            error: 'Outcome uncertain after SDK dispatch',
            code: 'WRITE_UNCERTAIN',
            reviewRequired: true,
            verified: false,
          };
        return {
          success: true,
          verified: true,
          parentId: input.parentId,
          correlationId: input.correlationId,
          transactionId: input.parentId,
        };
      },
      verifyEvidenceAmendment: async () => fixture.amendmentProofValid,
      captureEvidenceTransaction: async (input: {
        budgetId: string;
        accountId: string;
        transactionId: string;
      }): Promise<EvidenceTransactionSource> => {
        if (fixture.beforeAmendmentCapture) await fixture.beforeAmendmentCapture();
        const transaction = structuredClone(
          state.transactions.find((row) => row.id === input.transactionId)!,
        );
        if (!transaction) throw new Error('Missing fixture settlement');
        return {
          ...input,
          parent: {
            id: transaction.id,
            imported_id: transaction.importedId,
            cleared: transaction.cleared,
          },
          children: [],
          transaction,
          fingerprint: 'a'.repeat(64),
        };
      },
      amendEvidenceTransaction: async (
        input: { expected: EvidenceTransactionSource; transaction: ManualTransactionInput },
        precondition: WritePrecondition,
      ): Promise<ManualTransactionResult> => {
        await Promise.resolve();
        if (fixture.pauseBeforeManualFence) await fixture.pauseBeforeManualFence();
        const index = state.transactions.findIndex(
          (row) => row.id === input.expected.transactionId,
        );
        if (canonicalTest(state.transactions[index]) !== canonicalTest(input.expected.transaction))
          throw new Error('Settlement changed');
        precondition.assertExecutionCurrent();
        fixture.amendmentWrites += 1;
        const original = state.transactions[index]!;
        if (original.categoryId)
          state.spent[original.categoryId] =
            (state.spent[original.categoryId] ?? 0) - Number(original.amount.minorUnits);
        const replacement = manualRow(input.transaction);
        state.transactions[index] = {
          ...original,
          categoryId: input.transaction.categoryId ?? null,
          categoryName:
            input.transaction.categoryId === 'reserve'
              ? 'Reserve'
              : input.transaction.categoryId === 'food'
                ? 'Food'
                : null,
          subtransactions: replacement.subtransactions.map((child) => ({
            ...child,
            payeeId: null,
            categoryName: child.categoryId === 'reserve' ? 'Reserve' : 'Food',
            cleared: original.cleared,
          })),
        };
        if (input.transaction.categoryId)
          state.spent[input.transaction.categoryId] =
            (state.spent[input.transaction.categoryId] ?? 0) + input.transaction.amount;
        for (const split of input.transaction.splits ?? [])
          state.spent[split.categoryId] = (state.spent[split.categoryId] ?? 0) + split.amount;
        return {
          success: true,
          verified: true,
          parentId: original.id,
          transactionId: original.id,
          correlationId: input.transaction.correlationId,
        };
      },
      createEvidenceCredit: async (
        input: ManualTransactionInput,
        precondition: WritePrecondition,
      ): Promise<ManualTransactionResult> => {
        await Promise.resolve();
        if (fixture.pauseBeforeManualFence) await fixture.pauseBeforeManualFence();
        precondition.assertExecutionCurrent();
        writes.push({
          kind: 'manual',
          parentId: input.parentId,
          amount: input.amount,
          splits: input.splits?.length ?? 0,
        });
        if (input.payeeName && !state.payees.some((payee) => payee.name === input.payeeName))
          state.payees.push({
            id: `manual-payee-${input.payeeName}`,
            name: input.payeeName,
            transferAccountId: null,
            mtid: null,
          });
        state.transactions = [...state.transactions, manualRow(input)];
        state.accounts[input.accountId]!.balance += input.amount;
        state.transactionCoverage = 'complete';
        if (input.categoryId)
          state.spent[input.categoryId] = (state.spent[input.categoryId] ?? 0) + input.amount;
        return {
          success: true,
          verified: true,
          parentId: input.parentId,
          transactionId: input.parentId,
          correlationId: input.correlationId,
        };
      },
      createWalletAccount: async (
        input: WalletIntent,
        precondition: WritePrecondition,
      ): Promise<WalletResult> => {
        await Promise.resolve();
        if (precondition.budgetId !== 'fixture') throw new Error('Selected budget changed');
        if (fixture.failBeforeDispatch === 'wallet')
          return {
            success: false,
            error: 'Wallet pre-dispatch validation failed',
            code: 'PRECONDITION_READ_FAILED',
          };
        precondition.assertExecutionCurrent();
        const accountId = `actual-generated-${input.walletId}`;
        writes.push({ kind: 'wallet', walletId: input.walletId, accountId });
        state.accounts[accountId] = {
          name: input.accountName,
          balance: input.opening?.amount ?? 0,
          onBudget: true,
          closed: false,
        };
        state.payees.push({
          id: `actual-generated-payee-${input.walletId}`,
          name: input.accountName,
          transferAccountId: accountId,
          mtid: null,
        });
        if (input.opening) {
          state.payees.push({
            id: 'starting-balance-payee',
            name: 'Starting Balance',
            transferAccountId: null,
            mtid: null,
          });
          state.transactions.push({
            ...canonicalTransaction.transactions[0]!,
            id: `opening-${input.walletId}`,
            accountId,
            date: input.opening.date,
            amount: money(String(input.opening.amount)),
            categoryId: null,
            categoryName: null,
            payeeId: 'starting-balance-payee',
            payeeName: 'Starting Balance',
            notes: null,
            cleared: true,
            reconciled: false,
            importedId: null,
            importedPayee: null,
            transferAccountId: null,
            tags: [],
            subtransactions: [],
          });
          return {
            success: true,
            verified: true,
            walletId: input.walletId,
            accountId,
            openingEquity: {
              walletId: input.walletId,
              accountId,
              transactionId: `opening-${input.walletId}`,
              date: input.opening.date,
              amount: money(String(input.opening.amount)),
              startingBalance: true,
              sdkFingerprint: 'c'.repeat(64),
              payeeId: 'starting-balance-payee',
              categoryId: null,
            },
          };
        }
        return { success: true, verified: true, walletId: input.walletId, accountId };
      },
      readWalletOpeningEquity: async (input: WalletIntent, accountId: string) => ({
        walletId: input.walletId,
        accountId,
        transactionId: `opening-${input.walletId}`,
        date: input.opening!.date,
        amount: money(String(input.opening!.amount)),
        startingBalance: true,
        sdkFingerprint: 'c'.repeat(64),
        payeeId: 'starting-balance-payee',
        categoryId: null,
      }),
      createLedgerTransfer: async (
        input: LedgerTransferInput,
        precondition: TransferPrecondition,
      ): Promise<TransferResult> => {
        if (
          precondition.sourceBalance !== state.accounts[input.sourceAccountId]?.balance ||
          precondition.destinationBalance !== state.accounts[input.destinationAccountId]?.balance
        )
          throw new Error('Transfer account balance changed');
        if (fixture.failBeforeDispatch === 'transfer')
          return {
            success: false,
            error: 'Transfer pre-dispatch validation failed',
            code: 'PRECONDITION_READ_FAILED',
          };
        precondition.assertExecutionCurrent();
        const sourceTransactionId = `actual-transfer-source-${input.transferId}`;
        const destinationTransactionId = `actual-transfer-destination-${input.transferId}`;
        const marker = `balanceframe:transfer:${input.transferId}:${input.correlationId}`;
        writes.push({
          kind: 'transfer',
          transferId: input.transferId,
          sourceId: sourceTransactionId,
          destinationId: destinationTransactionId,
        });
        const minorUnits = input.amount;
        state.accounts[input.sourceAccountId]!.balance -= minorUnits;
        state.accounts[input.destinationAccountId]!.balance += minorUnits;
        state.transactions = [
          ...state.transactions,
          transferRow(
            sourceTransactionId,
            input.sourceAccountId,
            fixture.failTransferLink ? null : input.destinationAccountId,
            -minorUnits,
            input.date,
            marker,
          ),
          transferRow(
            destinationTransactionId,
            input.destinationAccountId,
            fixture.failTransferLink ? null : input.sourceAccountId,
            minorUnits,
            input.date,
            marker,
          ),
        ];
        const pairId = fixture.failTransferLink
          ? `unlinked:${sourceTransactionId}:${destinationTransactionId}`
          : [sourceTransactionId, destinationTransactionId].sort().join(':');
        state.transferSettlementRecords = [
          ...state.transferSettlementRecords,
          {
            id: sourceTransactionId,
            accountId: input.sourceAccountId,
            amount: money(String(-minorUnits)),
            observedAt: state.capturedAt,
            occurredAt: input.date,
            importedId: null,
            providerReference: null,
            pairId,
            reconciled: false,
            reversed: false,
            provenance: 'manual_ledger',
          },
          {
            id: destinationTransactionId,
            accountId: input.destinationAccountId,
            amount: money(String(minorUnits)),
            observedAt: state.capturedAt,
            occurredAt: input.date,
            importedId: null,
            providerReference: null,
            pairId,
            reconciled: false,
            reversed: false,
            provenance: 'manual_ledger',
          },
        ];
        state.transactionCoverage = 'complete';
        return {
          success: true,
          verified: true,
          transferId: input.transferId,
          sourceTransactionId,
          destinationTransactionId,
        };
      },
      disconnect: async () => {},
    }),
  });
  const fixture = {
    actor,
    directory,
    store,
    service: null as unknown as ConsequentialActionService,
    liquidity: null as unknown as LiquidityService,
    state,
    writes,
    nativePlans,
    get clockNow() {
      return clockNow;
    },
    setClock(value: string) {
      clockNow = value;
      vi.setSystemTime(new Date(value));
    },
    setAssistanceMaximum(
      value:
        | 'analysis_only'
        | 'recommend_actions'
        | 'create_approval_proposal'
        | 'execute_approved_actions',
    ) {
      const current = store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
      if (!current) throw new Error('Fixture governance policy required');
      store.governance.setPolicy({
        spaceId: fixture.actor.spaceId!,
        expectedVersion: current.version,
        policy: {
          minimumApprovers: current.minimumApprovers,
          approvalThresholds: current.approvalThresholds,
          operationApprovers: current.operationApprovers,
          assistanceMaximum: value,
        },
        now: clockNow,
        auth: auth('holder', clockNow),
      });
      const refreshed = store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
      if (!refreshed) throw new Error('Fixture governance policy required');
      fixture.actor = {
        ...fixture.actor,
        governancePolicyVersion: refreshed.version,
        now: clockNow,
      };
    },
    saveLiquidityPolicy(
      patch: Partial<GovernedLiquidityPolicy> = {},
      approvalPolicy?: TransferApprovalPolicy,
    ): LiquidityPolicyRecord {
      const old = store.liquidity.getPolicy(fixture.actor);
      const saved = store.liquidity.savePolicy({
        ...fixture.actor,
        expectedVersion: old?.policy.version ?? null,
        expectedGovernancePolicyVersion: fixture.actor.governancePolicyVersion!,
        now: clockNow,
        auth: fixture.actor.auth!,
        policy: {
          ...(old?.policy ?? accountAwarePolicy.liquidityPolicy),
          ...patch,
          version: uniqueNativePolicyVersion(),
        },
        approvalPolicy: approvalPolicy ?? old?.approvalPolicy ?? { minimumApprovers: 1 },
      });
      const refreshed = store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
      if (!refreshed) throw new Error('Fixture governance policy required');
      fixture.actor = {
        ...fixture.actor,
        governancePolicyVersion: refreshed.version,
        now: clockNow,
      };
      return saved;
    },
    grant,
    async addMember(actorId: string): Promise<LiquidityActor> {
      await store.upsertActorMembership(
        actorId,
        'active',
        ['observe'],
        `budget:${fixture.actor.budgetId}`,
      );
      const member = store.governance.addMembership({
        spaceId: fixture.actor.spaceId!,
        actorId,
        validFrom: clockNow,
        now: clockNow,
        auth: auth('holder', clockNow),
      });
      return {
        ...fixture.actor,
        actorId,
        membershipId: member.id,
        auth: auth(actorId, clockNow),
        now: clockNow,
      };
    },
    async refreshObservations(observationExpiry = expiresAt) {
      const version =
        store.liquidity.loadEvaluationState({ ...fixture.actor, now: clockNow }).supplemental
          ?.version ?? 0;
      await fixture.liquidity.saveObservations(fixture.actor, {
        expectedVersion: version,
        expiresAt: observationExpiry,
        observations: Object.keys(state.accounts)
          .filter((id) => id === 'checking' || id === 'savings')
          .map((accountId) => ({
            accountId,
            currentLedgerConfirmed: true,
            kind: 'cash' as const,
            currency: 'USD',
            owned: true,
            holds: money('0'),
          })),
      });
    },
    async approve(proposalId: string, target: LiquidityActor) {
      const proposal = await store.getProposal(proposalId);
      if (!proposal) throw new Error('Fixture action proposal required');
      if (proposal.operation !== 'consequential_action')
        throw new Error('Fixture consequential-action proposal required');
      const sourceReads = deriveProposalSourceReadFacts(
        'consequential_action',
        proposal.payload,
        JSON.parse(proposal.preconditions) as unknown,
        proposal.budgetId,
      );
      if (!sourceReads) throw new Error('Fixture action source-read closure required');
      for (const required of sourceReads.required)
        fixture.grant(target, required.resourceKind, required.resourceId, required.capability);
      await store.createApproval({
        proposalId,
        payloadHash: proposal.payloadHash,
        actorId: target.actorId,
        expiresAt: proposal.expiresAt,
        auth: target.auth!,
        now: clockNow,
      });
    },
    source(capturedAt = state.capturedAt) {
      return snapshot(state, capturedAt);
    },
    cleanup,
    failBeforeDispatch: null as 'manual' | 'wallet' | 'transfer' | null,
    failManualAfterWrite: false,
    failTransferLink: false,
    pauseBeforeManualFence: null as (() => Promise<void>) | null,
    amendmentProofValid: true,
    amendmentWrites: 0,
    beforeAmendmentCapture: null as (() => Promise<void>) | null,
    beforeAssignmentFence: null as (() => Promise<void>) | null,
  } satisfies Fixture;
  const connectionManager = new ConnectionManager(managerOptions());
  const mutationConnectionManager = new ConnectionManager(managerOptions());
  store.liquidity.savePolicy({
    ...actor,
    expectedVersion: null,
    expectedGovernancePolicyVersion: actor.governancePolicyVersion!,
    now,
    auth: actor.auth!,
    policy: {
      ...accountAwarePolicy.liquidityPolicy,
      expiresAt: '2026-09-07T00:00:00.000Z',
      categoryPolicies: [
        {
          categoryId: 'food',
          kind: 'ordinary',
          donorEligible: false,
          minimumRetained: money('0'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'reserve',
          kind: 'ordinary',
          donorEligible: true,
          minimumRetained: money('1000'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'reserve-two',
          kind: 'ordinary',
          donorEligible: true,
          minimumRetained: money('1000'),
          projectedRemainingNeed: money('0'),
        },
      ],
    },
    approvalPolicy: { minimumApprovers: 1 },
  });
  const refreshed = store.governance.getPolicy({ spaceId: actor.spaceId! });
  if (!refreshed) throw new Error('Fixture governance policy required');
  fixture.actor = { ...fixture.actor, governancePolicyVersion: refreshed.version };
  fixture.liquidity = new LiquidityService({
    connectionManager,
    mutationConnectionManager,
    store,
    native: fixtureNative,
    clock: () => new Date(clockNow),
  });
  fixture.service = new ConsequentialActionService({
    liquidity: fixture.liquidity,
    store,
    native: fixtureNative,
    clock: () => new Date(clockNow),
  });
  await fixture.liquidity.saveObservations(fixture.actor, {
    expectedVersion: 0,
    expiresAt,
    observations: ['checking', 'savings'].map((accountId) => ({
      accountId,
      currentLedgerConfirmed: true,
      kind: 'cash' as const,
      currency: 'USD',
      owned: true,
      holds: money('0'),
    })),
  });
  return fixture;
}

function reallocationIntent(overrides: Record<string, unknown> = {}) {
  return {
    action: structuredClone(actionFixture.intent),
    decision: {
      accountId: 'checking',
      items: [
        {
          id: 'purchase-food',
          categoryId: 'food',
          accountId: 'checking',
          amount: money('2000'),
          purchaseAt: now,
          requiredBy: now,
        },
      ],
    },
    ...overrides,
  };
}
function manualIntent(parentId = 'manual-parent-1') {
  return {
    action: {
      kind: 'manual_transaction' as const,
      transaction: {
        parentId,
        correlationId: `corr-${parentId}`,
        accountId: 'checking',
        amount: money('-500'),
        date: '2026-09-06',
        categoryId: 'food',
        payeeName: 'Local shop',
        notes: 'manual note',
        splits: [],
      },
    },
  };
}
async function proposal(fixture: Fixture, intent: unknown = reallocationIntent()) {
  try {
    const result = await fixture.service.propose(fixture.actor, intent);
    if (result.operation !== 'consequential_action')
      throw new Error('Consequential proposal required');
    return result;
  } catch (error) {
    if (process.env.PHASE9_TRACE_PRIVATE_READ === '1') {
      const [stored] = await fixture.store.listProposals({
        budgetId: fixture.actor.budgetId,
        operations: ['consequential_action'],
      });
      if (stored?.operation === 'consequential_action') {
        const preconditions = JSON.parse(stored.preconditions) as unknown;
        let disclosure: unknown;
        try {
          disclosure = deriveProposalDisclosureTotals(
            stored.operation,
            stored.payload,
            preconditions,
            'detail',
          );
        } catch (cause) {
          disclosure = { error: cause instanceof Error ? cause.message : String(cause) };
        }
        const authorizationFacts = deriveProposalAuthorizationFacts(
          stored.operation,
          stored.payload,
          preconditions,
        );
        const sourceReadFacts = deriveProposalSourceReadFacts(
          stored.operation,
          stored.payload,
          preconditions,
          fixture.actor.budgetId,
        );
        writeFileSync(
          join(tmpdir(), 'balanceframe-phase9-private-read-frame.json'),
          JSON.stringify(
            {
              proposalId: stored.id,
              authorizationResources: authorizationFacts.resources,
              sourceReadResources: sourceReadFacts?.resources ?? null,
              sourceReadRequired: sourceReadFacts?.required ?? null,
              disclosure,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
    }
    throw error;
  }
}
async function grantProposalDetail(fixture: Fixture, actor: LiquidityActor, proposalId: string) {
  const stored = await fixture.store.getProposal(proposalId);
  if (!stored || stored.operation !== 'consequential_action')
    throw new Error('Fixture action proposal required');
  const reads = deriveProposalSourceReadFacts(
    stored.operation,
    stored.payload,
    JSON.parse(stored.preconditions) as unknown,
    stored.budgetId,
  );
  if (!reads) throw new Error('Fixture action source-read closure required');
  for (const required of reads.required)
    fixture.grant(actor, required.resourceKind, required.resourceId, required.capability);
  for (const resource of reads.resources)
    if (!['account', 'category', 'transaction', 'rule'].includes(resource.resourceKind))
      fixture.grant(actor, resource.resourceKind, resource.resourceId, 'full-read');
}

async function approveAndExecute(
  fixture: Fixture,
  intent: unknown = reallocationIntent(),
  beforeExecute?: () => void,
) {
  const proposed = await proposal(fixture, intent);
  const approver = await fixture.addMember(`approver-${proposed.id}`);
  const plan = proposed.payload.plan;
  const actionKinds =
    plan.action.kind === 'composite'
      ? plan.action.actions.map((action) => action.kind)
      : [plan.action.kind];
  const capability = actionKinds.includes('reallocation')
    ? 'reallocation:approve'
    : actionKinds.some((kind) =>
          ['evidence_projection', 'evidence_credit', 'evidence_amendment'].includes(kind),
        )
      ? 'ledger_projection:approve'
      : actionKinds.includes('wallet_materialization')
        ? 'wallet_materialization:approve'
        : actionKinds.includes('transfer')
          ? 'transfer:approve'
          : 'transaction:approve';
  const targets: Array<
    [
      (
        | 'budget'
        | 'account'
        | 'category'
        | 'evidence'
        | 'wallet'
        | 'transfer'
        | 'transaction'
        | 'ledger_effect'
      ),
      string,
    ]
  > = [
    ['budget', fixture.actor.budgetId],
    ['account', 'checking'],
    ['account', 'savings'],
    ['category', 'food'],
    ['category', 'reserve'],
    ['category', 'reserve-two'],
    ['evidence', 'checking-freshness'],
    ['evidence', 'economic-event-resolution-purchase-1'],
    ['wallet', 'wallet-one'],
    ['transfer', 'transfer-one'],
  ];
  const actions = plan.action.kind === 'composite' ? plan.action.actions : [plan.action];
  for (const action of actions)
    if (
      action.kind === 'manual_transaction' ||
      action.kind === 'evidence_projection' ||
      action.kind === 'evidence_credit' ||
      action.kind === 'evidence_amendment'
    ) {
      targets.push(
        ['transaction', action.transaction.parentId],
        ['ledger_effect', action.transaction.parentId],
      );
      if (
        action.kind === 'evidence_projection' ||
        action.kind === 'evidence_credit' ||
        action.kind === 'evidence_amendment'
      )
        for (const evidenceId of action.evidenceIds) targets.push(['evidence', evidenceId]);
    }
  for (const [kind, id] of targets) fixture.grant(approver, kind, id, capability);
  for (const action of actions)
    if (
      action.kind === 'evidence_projection' ||
      action.kind === 'evidence_credit' ||
      action.kind === 'evidence_amendment'
    )
      for (const evidenceId of action.evidenceIds)
        fixture.grant(approver, 'evidence', evidenceId, 'source');
  await fixture.approve(proposed.id, approver);
  beforeExecute?.();
  return { proposed, approver, result: await fixture.service.execute(fixture.actor, proposed.id) };
}

function countMoneyOccurrences(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((count, item) => count + countMoneyOccurrences(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  if ('minorUnits' in record || 'currency' in record) return 1;
  return Object.values(record).reduce((count, item) => count + countMoneyOccurrences(item), 0);
}
function storedActionDisclosureCount(preconditions: string, plan: unknown): number {
  const preconditionCount = countMoneyOccurrences(JSON.parse(preconditions) as unknown);
  const planCount = countMoneyOccurrences(plan);
  return preconditionCount + planCount;
}
function canonicalTest(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Canonical test value required');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalTest).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalTest(entry)}`)
    .join(',')}}`;
}

let fixture: Fixture;
let activeFixture: Fixture | undefined;
let setupCleanup: (() => void) | undefined;
beforeEach(async () => {
  activeFixture = undefined;
  setupCleanup = undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  try {
    fixture = await createFixture();
  } catch (error) {
    try {
      setupCleanup?.();
    } catch {
      // Keep the failed setup as the reported error.
    }
    throw error;
  }
  activeFixture = fixture;
});
afterEach(() => {
  try {
    activeFixture?.cleanup();
  } finally {
    activeFixture = undefined;
    setupCleanup = undefined;
    vi.useRealTimers();
  }
});

describe('common governed consequential-action service', () => {
  it.each([
    ['analysis_only', false],
    ['recommend_actions', false],
    ['create_approval_proposal', true],
    ['execute_approved_actions', true],
  ] as const)(
    'applies assistance maximum %s without escalating from the request',
    async (mode, admitsProposal) => {
      fixture.setAssistanceMaximum(mode);
      if (admitsProposal) {
        const created = await proposal(fixture);
        expect(created.payload.kind).toBe('consequential_action');
      } else {
        await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow(
          /assistance|proposal/i,
        );
      }
      expect(
        await fixture.store.listProposals({
          budgetId: fixture.actor.budgetId,
          operations: ['consequential_action'],
        }),
      ).toHaveLength(admitsProposal ? 1 : 0);
      expect(fixture.writes).toEqual([]);
    },
  );
  it('does not treat proposal-only assistance as authority to execute', async () => {
    fixture.setAssistanceMaximum('create_approval_proposal');
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`proposal-only-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
    expect(await fixture.store.getProposal(created.id)).toMatchObject({
      state: { phase: 'approved' },
    });
  });

  it('treats a malformed assistance maximum as analysis-only for this operation', async () => {
    const policy = fixture.store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
    if (!policy) throw new Error('Fixture governance policy required');
    const getPolicy = vi
      .spyOn(fixture.store.governance, 'getPolicy')
      .mockReturnValue({ ...policy, assistanceMaximum: '__proto__' as never });
    try {
      await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow(
        /assistance/i,
      );
      expect(
        await fixture.store.listProposals({
          budgetId: fixture.actor.budgetId,
          operations: ['consequential_action'],
        }),
      ).toHaveLength(0);
    } finally {
      getPolicy.mockRestore();
    }
    expect(() =>
      fixture.store.governance.setPolicy({
        spaceId: fixture.actor.spaceId!,
        expectedVersion: policy.version,
        policy: {
          minimumApprovers: policy.minimumApprovers,
          approvalThresholds: policy.approvalThresholds,
          operationApprovers: policy.operationApprovers,
          assistanceMaximum: 'unbounded',
        },
        now,
        auth: auth('holder'),
      }),
    ).toThrow();
  });

  it('reduces an otherwise sufficient mode when the action-specific propose capability is absent', async () => {
    fixture.setAssistanceMaximum('execute_approved_actions');
    fixture.grant(fixture.actor, 'category', 'reserve', 'reallocation:propose', false);
    await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow();
    expect(
      await fixture.store.listProposals({
        budgetId: fixture.actor.budgetId,
        operations: ['consequential_action'],
      }),
    ).toHaveLength(0);
  });

  it('selects the exact safe native reallocation and persists an immutable generic action proposal', async () => {
    const created = await proposal(fixture);
    const stored = await fixture.store.getProposal(created.id);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Stored action proposal required');
    expect(created.payload).toMatchObject({
      kind: 'consequential_action',
      plan: {
        action: actionFixture.intent,
        reasonCodes: expect.arrayContaining(['safe_reallocation']),
        impacts: expect.arrayContaining([
          expect.objectContaining({
            kind: 'category_reallocation',
            sourceCategoryId: 'reserve',
            destinationCategoryId: 'food',
            sourceProtected: false,
            minimumRetained: money('1000'),
            rationale: 'donor_category_surplus_redirected',
          }),
        ]),
      },
    });
    expect(created).not.toHaveProperty('preconditions');
    expect(created.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created).toMatchObject({
      requesterActorId: fixture.actor.actorId,
      governancePolicyVersion: expect.any(String),
      currentGovernancePolicyVersion: expect.any(String),
      financialPolicyVersion: expect.any(String),
      currentFinancialPolicyVersion: expect.any(String),
      requiredApprovers: expect.any(Number),
      decisionContext: expect.objectContaining({
        validUntil: expect.any(String),
        items: expect.arrayContaining([
          expect.objectContaining({
            id: 'purchase-food',
            categoryId: 'food',
            accountId: 'checking',
            amount: money('2000'),
            purchaseAt: now,
            requiredBy: now,
          }),
        ]),
      }),
    });
    expect(created.payload.plan.source).toMatchObject({
      snapshotReference: expect.any(String),
      policyVersion: expect.any(String),
      financialPolicyVersion: expect.any(String),
      claimSetRevision: expect.any(String),
    });
    expect(created.payload.plan.source).not.toHaveProperty('contentHash');
    expect(created.payload.plan.source).not.toHaveProperty('hashes');
    expect(created.payload.plan).not.toHaveProperty('actionHash');
    expect(created.payload.plan).not.toHaveProperty('idempotencyKey');
    expect(stored).toMatchObject({
      id: created.id,
      operation: 'consequential_action',
      payload: {
        kind: 'consequential_action',
        plan: {
          actionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          source: {
            snapshotId: expect.any(String),
            contentHash: expect.any(String),
            financialPolicyVersion: expect.any(String),
          },
        },
      },
    });
    expect(fixture.writes).toEqual([]);
  });
  it('serves proposal detail through current approval or execution read authority without proposer grants', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`detail-approver-${created.id}`);
    const executor = await fixture.addMember(`detail-executor-${created.id}`);
    for (const capability of ['reallocation:approve', 'reallocation:execute'] as const) {
      const target = capability.endsWith(':approve') ? approver : executor;
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['category', 'reserve'],
        ['category', 'food'],
      ] as const)
        fixture.grant(target, kind, id, capability);
    }
    for (const target of [approver, executor, fixture.actor]) {
      for (const capability of ['conclusion', 'observe', 'source', 'full-read'] as const)
        fixture.grant(target, 'budget', fixture.actor.budgetId, capability);
      for (const id of ['checking', 'savings'])
        for (const capability of [
          'existence',
          'history',
          'name',
          'source',
          'balance',
          'full-read',
        ] as const)
          fixture.grant(target, 'account', id, capability);
      for (const id of ['food', 'reserve', 'reserve-two'])
        for (const capability of ['existence', 'name', 'source', 'liquidity', 'full-read'] as const)
          fixture.grant(target, 'category', id, capability);
      for (const id of ['checking-freshness', 'checking', 'economic-event-resolution-purchase-1'])
        for (const capability of [
          'evidence',
          'normalized-evidence',
          'source',
          'full-read',
        ] as const)
          fixture.grant(target, 'evidence', id, capability);
    }
    for (const target of [approver, executor]) {
      const detail = await fixture.service.getProposal(target, created.id);
      expect(detail).toMatchObject({
        id: created.id,
        operation: 'consequential_action',
        payload: { kind: 'consequential_action', plan: { action: actionFixture.intent } },
      });
      expect(detail).not.toHaveProperty('preconditions');
      expect(detail?.payload.plan).not.toHaveProperty('dispatchPreconditions');
      expect(detail?.payload.plan.source).toHaveProperty('snapshotReference');
      expect(detail?.payload.plan.source).not.toHaveProperty('contentHash');
      await expect(fixture.service.getProposals(target, [created.id])).resolves.toEqual([detail]);
      await expect(fixture.service.propose(target, reallocationIntent())).rejects.toThrow();
    }
    fixture.setAssistanceMaximum('analysis_only');
    await expect(fixture.service.getProposal(fixture.actor, created.id)).resolves.toMatchObject({
      id: created.id,
    });
  });
  it('binds ordinary source evidence to its observed clock without inventing resolution metadata', async () => {
    const ordinary = fixture.source().observations[0];
    if (!ordinary) throw new Error('Ordinary account evidence fixture required');
    expect(ordinary).toMatchObject({
      kind: 'account_freshness',
      scope: { kind: 'account', id: 'checking' },
      state: 'fresh',
      observedAt: now,
      evidence: [
        {
          evidenceId: 'checking-freshness',
          kind: 'bank_sync',
          authorized: true,
          redaction: 'visible',
        },
      ],
    });
    expect(ordinary).not.toHaveProperty('contentHash');
    expect(ordinary).not.toHaveProperty('version');
    expect(sourceObservationSchema.safeParse(ordinary).success).toBe(true);
    expect(
      sourceObservationSchema.safeParse({ ...ordinary, contentHash: 'ordinary-content-v1' })
        .success,
    ).toBe(false);
    expect(sourceObservationSchema.safeParse({ ...ordinary, version: 'ordinary-v1' }).success).toBe(
      false,
    );

    const reference = ordinary.evidence[0];
    if (!reference) throw new Error('Ordinary evidence reference required');
    const expectedContentHash = createHash('sha256')
      .update(
        canonicalTest({
          kind: ordinary.kind,
          scope: ordinary.scope,
          observedAt: ordinary.observedAt,
          state: ordinary.state,
          contentHash: ordinary.contentHash ?? null,
          version: ordinary.version ?? null,
          reference: {
            evidenceId: reference.evidenceId,
            kind: reference.kind,
            authorized: reference.authorized,
            redaction: reference.redaction,
          },
        }),
      )
      .digest('hex');
    const created = await proposal(fixture);
    expect(created.payload.plan.evidenceReferences).toContainEqual({
      evidenceId: 'checking-freshness',
      subjectId: 'checking',
      state: 'resolved',
    });
    const stored = await fixture.store.getProposal(created.id);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Stored action proposal required');
    const evidence = stored.payload.plan.evidenceReferences.find(
      (entry) => entry.evidenceId === 'checking-freshness',
    );
    if (!evidence) throw new Error('Stored ordinary evidence binding required');
    expect(evidence.contentHash).toBe(expectedContentHash);
    expect(evidence).not.toHaveProperty('version');
  });
  it('binds all ordinary Actual facts sharing an account evidence identity and executes normally', async () => {
    fixture.state.assignments.food = 1800;
    fixture.state.additionalObservations = [
      'account_coverage',
      'account_type',
      'account_balance',
    ].map((kind) =>
      sourceObservationSchema.parse({
        kind,
        scope: { kind: 'account', id: 'checking' },
        state: 'complete',
        observedAt: now,
        evidence: [
          { evidenceId: 'checking', kind: 'account', authorized: true, redaction: 'visible' },
        ],
      }),
    );
    const outcome = await approveAndExecute(fixture, manualIntent('manual-single'));
    expect(outcome.result).toMatchObject({ phase: 'verified' });
    const proof = fixture.nativePlans[0]!.resolvedEvidence.filter(
      (entry) => entry.evidenceId === 'checking' && entry.subjectId === 'checking',
    );
    expect(proof).toHaveLength(1);
    expect(proof[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.writes.filter((write) => write.kind === 'manual')).toHaveLength(1);
  });
  it('normalizes ordinary proof ordering, duplicate observations, and generated Actual capture clocks', async () => {
    fixture.state.assignments.food = 1800;
    const facts = ['account_coverage', 'account_type', 'account_balance'].map((kind) =>
      sourceObservationSchema.parse({
        kind,
        scope: { kind: 'account', id: 'checking' },
        state: 'complete',
        observedAt: now,
        evidence: [
          { evidenceId: 'checking', kind: 'account', authorized: true, redaction: 'visible' },
        ],
      }),
    );
    fixture.state.additionalObservations = facts;
    await proposal(fixture, manualIntent('manual-single'));
    const first = fixture.nativePlans.at(-1)!.resolvedEvidence;
    fixture.setClock('2026-09-06T10:00:01.000Z');
    fixture.state.capturedAt = fixture.clockNow;
    fixture.state.additionalObservations = [...facts]
      .reverse()
      .concat(facts[0]!)
      .map((fact) => ({ ...fact, observedAt: '2026-09-06T10:00:01.000Z' }));
    await expect(proposal(fixture, manualIntent('manual-split'))).rejects.toThrow(
      /economic identity.*held/,
    );
    expect(fixture.nativePlans.at(-1)!.resolvedEvidence).toEqual(first);
  });
  it('invalidates an approved action when any secondary ordinary proof changes before dispatch', async () => {
    fixture.state.assignments.food = 1800;
    fixture.state.additionalObservations = [
      'account_coverage',
      'account_type',
      'account_balance',
    ].map((kind) =>
      sourceObservationSchema.parse({
        kind,
        scope: { kind: 'account', id: 'checking' },
        state: 'complete',
        observedAt: now,
        evidence: [
          { evidenceId: 'checking', kind: 'account', authorized: true, redaction: 'visible' },
        ],
      }),
    );
    const created = await proposal(fixture, manualIntent('manual-single'));
    const approver = await fixture.addMember('secondary-proof-approver');
    for (const [kind, identity] of [
      ['budget', fixture.actor.budgetId],
      ['account', 'checking'],
      ['category', 'food'],
      ['transaction', 'manual-single'],
      ['ledger_effect', 'manual-single'],
    ] as const)
      fixture.grant(approver, kind, identity, 'transaction:approve');
    await fixture.approve(created.id, approver);
    fixture.state.additionalObservations[1] = sourceObservationSchema.parse({
      ...fixture.state.additionalObservations[1],
      state: 'unknown',
      observedAt: null,
    });
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect((await fixture.store.getProposal(created.id))?.state).toMatchObject({
      phase: 'invalidated_no_dispatch',
      effects: [],
    });
    expect(fixture.writes).toEqual([]);
  });
  it('rejects different economic proofs for one exact subject even when proposing an unrelated action', async () => {
    const event = fixture.state.resolution!;
    fixture.state.additionalResolutions = [{ ...event, contentHash: 'sha256:conflicting-event' }];
    await expect(proposal(fixture, manualIntent('manual-single'))).rejects.toThrow(
      /conflicting proof/,
    );
    expect(fixture.writes).toEqual([]);
  });
  it('rejects ordinary and economic proofs that collide on the same evidence and subject identity', async () => {
    fixture.state.additionalObservations = [
      sourceObservationSchema.parse({
        kind: 'account_coverage',
        scope: { kind: 'account', id: 'checking' },
        state: 'complete',
        observedAt: now,
        evidence: [
          { evidenceId: 'checking', kind: 'account', authorized: true, redaction: 'visible' },
        ],
      }),
    ];
    fixture.state.resolution = {
      ...fixture.state.resolution!,
      subjectId: 'checking',
      evidenceId: 'checking',
    };
    for (const capability of [...financialCapabilities, 'normalized-evidence'])
      fixture.grant(fixture.actor, 'evidence', 'checking', capability);
    await expect(proposal(fixture, manualIntent('manual-single'))).rejects.toThrow(
      /conflicting proof/,
    );
    expect(fixture.writes).toEqual([]);
  });
  it('invalidates an approved action when the ordinary source observation clock changes before dispatch', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`ordinary-evidence-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);

    fixture.state.evidenceObservedAt = '2026-09-06T09:50:00.000Z';

    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    const stored = await fixture.store.getProposal(created.id);
    expect(stored?.state).toMatchObject({ phase: 'invalidated_no_dispatch', effects: [] });
    expect(fixture.writes).toEqual([]);
  });
  it('persists but withholds a new action when its complete details exceed the creator disclosure cap', async () => {
    fixture.grant(fixture.actor, 'budget', fixture.actor.budgetId, 'full-read', true, {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '1999' }],
    });

    await expect(
      fixture.service.propose(fixture.actor, reallocationIntent()),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CREATED_DETAILS_WITHHELD', retryable: false });
    const [stored] = await fixture.store.listProposals({
      budgetId: fixture.actor.budgetId,
      operations: ['consequential_action'],
    });
    expect(stored).toMatchObject({
      operation: 'consequential_action',
      state: { phase: 'proposed' },
    });
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Persisted action proposal required');
    await expect(fixture.service.getProposal(fixture.actor, stored.id)).resolves.toBeNull();
  });
  it('withholds creation detail when the complete proposal collection exceeds the creator disclosure cap', async () => {
    const first = await proposal(fixture);
    expect(
      fixture.store
        .getProposalApprovalReads({
          proposalIds: [first.id],
          spaceId: fixture.actor.spaceId!,
          actorId: fixture.actor.actorId,
          auth: fixture.actor.auth!,
          now: fixture.clockNow,
          privateProjection: 'detail',
        })
        .map((read) => read.summary.privateEnvelopeVisible),
    ).toEqual([true]);
    const firstStored = await fixture.store.getProposal(first.id);
    if (!firstStored || firstStored.operation !== 'consequential_action')
      throw new Error('First stored action proposal required');
    const operationLimit = storedActionDisclosureCount(
      firstStored.preconditions,
      firstStored.payload.plan,
    );
    fixture.grant(fixture.actor, 'budget', fixture.actor.budgetId, 'full-read', true, {
      maxOperationCount: operationLimit,
    });

    for (const id of ['checking', 'savings'])
      fixture.grant(fixture.actor, 'account', id, 'full-read', true, {
        maxOperationCount: operationLimit,
      });
    const transferId = 'transfer-one';
    await expect(
      fixture.service.propose(fixture.actor, {
        action: {
          kind: 'transfer',
          transferId,
          correlationId: 'transfer-correlation-one',
          sourceAccountId: 'savings',
          destinationAccountId: 'checking',
          amount: money('1000'),
          date: '2026-09-06',
        },
      }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CREATED_DETAILS_WITHHELD', retryable: false });
    const stored = await fixture.store.listProposals({
      budgetId: fixture.actor.budgetId,
      operations: ['consequential_action'],
    });
    expect(stored).toHaveLength(2);
    const second = stored.find(
      (proposal) =>
        proposal.operation === 'consequential_action' &&
        proposal.payload.plan.action.kind === 'transfer' &&
        proposal.payload.plan.action.transferId === transferId,
    );
    expect(second).toMatchObject({
      operation: 'consequential_action',
      state: { phase: 'proposed' },
    });
    if (!second || second.operation !== 'consequential_action')
      throw new Error('Persisted second action proposal required');
    await expect(fixture.service.getProposal(fixture.actor, second.id)).resolves.toBeNull();
  });
  it('binds a composite split debit to the aggregate of its trusted cart lines', async () => {
    const { transaction } = manualIntent('manual-parent-composite-1').action;
    const reallocation = structuredClone(actionFixture.intent);
    for (const assignment of reallocation.assignments) assignment.amount = money('300');
    const action = {
      kind: 'composite' as const,
      actions: [
        reallocation,
        {
          kind: 'manual_transaction' as const,
          transaction: {
            ...transaction,
            amount: money('-500'),
            categoryId: null,
            splits: [
              { categoryId: 'food', amount: money('-300') },
              { categoryId: 'reserve', amount: money('-200') },
            ],
          },
        },
      ],
    };
    const created = await proposal(fixture, {
      action,
      decision: {
        accountId: 'checking',
        items: [
          {
            id: 'purchase-food',
            categoryId: 'food',
            accountId: 'checking',
            amount: money('300'),
            purchaseAt: now,
            requiredBy: now,
          },
          {
            id: 'purchase-reserve',
            categoryId: 'reserve',
            accountId: 'checking',
            amount: money('200'),
            purchaseAt: now,
            requiredBy: now,
          },
        ],
      },
    });
    expect(created.payload.plan.action).toEqual(action);
    expect(created.decisionContext?.items.map(({ id }) => id)).toEqual([
      'purchase-food',
      'purchase-reserve',
    ]);
    expect(created.decisionContext?.items).toMatchObject([
      { id: 'purchase-food', categoryId: 'food', amount: money('300') },
      { id: 'purchase-reserve', categoryId: 'reserve', amount: money('200') },
    ]);
  });
  it.each(['maxOperationCount', 'maxGrossOutgoing'] as const)(
    'withholds consequential-action list and detail when complete %s disclosure exceeds the current grant',
    async (limitKind) => {
      const manual = (parentId: string, categoryId: string) => {
        const { transaction } = manualIntent(parentId).action;
        return {
          action: {
            kind: 'manual_transaction' as const,
            transaction: { ...transaction, categoryId },
          },
        };
      };
      const parentIds = ['bounded-manual-one', 'bounded-manual-two'];
      for (const id of parentIds) {
        for (const kind of ['transaction', 'ledger_effect'] as const)
          fixture.grant(fixture.actor, kind, id, 'transaction:propose');
        for (const capability of ['transaction.view', 'source'] as const)
          fixture.grant(fixture.actor, 'transaction', id, capability);
      }
      const first = await proposal(fixture, manual(parentIds[0]!, 'reserve-two'));
      const second = await proposal(fixture, manual(parentIds[1]!, 'reserve'));
      const firstStored = await fixture.store.getProposal(first.id);
      const secondStored = await fixture.store.getProposal(second.id);
      if (
        !firstStored ||
        firstStored.operation !== 'consequential_action' ||
        !secondStored ||
        secondStored.operation !== 'consequential_action'
      )
        throw new Error('Stored consequential-action proposals required');
      const operationLimit = Math.max(
        storedActionDisclosureCount(firstStored.preconditions, firstStored.payload.plan),
        storedActionDisclosureCount(secondStored.preconditions, secondStored.payload.plan),
      );
      const reader = await fixture.addMember(`bounded-reader-${limitKind}`);
      const collectionLimit =
        limitKind === 'maxOperationCount'
          ? { maxOperationCount: operationLimit }
          : { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '500' }] };
      const grantLimitedRead = (target: LiquidityActor) => {
        for (const capability of ['conclusion', 'observe', 'source', 'full-read'] as const)
          fixture.grant(
            target,
            'budget',
            fixture.actor.budgetId,
            capability,
            true,
            capability === 'full-read' ? collectionLimit : undefined,
          );
        for (const id of ['checking', 'savings'])
          for (const capability of ['existence', 'history', 'name', 'source', 'balance'] as const)
            fixture.grant(target, 'account', id, capability);
        for (const id of ['food', 'reserve', 'reserve-two'])
          for (const capability of ['existence', 'name', 'source', 'liquidity'] as const)
            fixture.grant(target, 'category', id, capability);
        for (const id of ['checking-freshness', 'checking', 'economic-event-resolution-purchase-1'])
          for (const capability of [
            'evidence',
            'normalized-evidence',
            'source',
            'full-read',
          ] as const)
            fixture.grant(
              target,
              'evidence',
              id,
              capability,
              true,
              capability === 'full-read' ? collectionLimit : undefined,
            );
        for (const id of parentIds) {
          for (const capability of ['transaction.view', 'source', 'history'] as const)
            fixture.grant(target, 'transaction', id, capability);
          fixture.grant(target, 'ledger_effect', id, 'source');
          fixture.grant(target, 'ledger_effect', id, 'full-read', true, collectionLimit);
        }
      };
      grantLimitedRead(reader);
      const approver = await fixture.addMember(`bounded-approver-${limitKind}`);
      const executor = await fixture.addMember(`bounded-executor-${limitKind}`);
      grantLimitedRead(approver);
      grantLimitedRead(executor);
      for (const [target, capability] of [
        [approver, 'transaction:approve'],
        [executor, 'transaction:execute'],
      ] as const) {
        for (const [kind, id] of [
          ['budget', fixture.actor.budgetId],
          ['account', 'checking'],
          ['category', 'food'],
          ['category', 'reserve'],
          ['category', 'reserve-two'],
        ] as const)
          fixture.grant(target, kind, id, capability);
        for (const id of parentIds)
          for (const kind of ['transaction', 'ledger_effect'] as const)
            fixture.grant(target, kind, id, capability);
      }
      const admittedReads = fixture.store.getProposalApprovalReads({
        proposalIds: [first.id, second.id],
        spaceId: reader.spaceId!,
        actorId: reader.actorId,
        auth: reader.auth!,
        now: fixture.clockNow,
        privateProjection: 'detail',
      });
      expect(admittedReads.map((read) => read.summary.privateEnvelopeVisible)).toEqual([
        false,
        false,
      ]);
      expect(await fixture.service.getProposal(reader, first.id)).toBeNull();
      expect(await fixture.service.getProposals(reader, [first.id, second.id])).toEqual([]);
      for (const [target, authorized] of [
        [approver, 'approvalAuthorized'],
        [executor, 'executionAuthorized'],
      ] as const) {
        const roleReads = fixture.store.getProposalApprovalReads({
          proposalIds: [first.id, second.id],
          spaceId: target.spaceId!,
          actorId: target.actorId,
          auth: target.auth!,
          now: fixture.clockNow,
          privateProjection: 'detail',
        });
        expect(
          roleReads.map((read) => ({
            privateEnvelopeVisible: read.summary.privateEnvelopeVisible,
            authorized: read.summary[authorized],
          })),
        ).toEqual([
          { privateEnvelopeVisible: false, authorized: true },
          { privateEnvelopeVisible: false, authorized: true },
        ]);
        expect(await fixture.service.getProposal(target, first.id)).toBeNull();
        expect(await fixture.service.getProposals(target, [first.id, second.id])).toEqual([]);
      }
      fixture.grant(
        reader,
        'budget',
        fixture.actor.budgetId,
        'full-read',
        true,
        limitKind === 'maxOperationCount'
          ? { maxOperationCount: 0 }
          : { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '499' }] },
      );
      expect(await fixture.service.getProposal(reader, first.id)).toBeNull();
      expect(fixture.writes).toEqual([]);
    },
  );
  it('reloads a saved-session cart and refuses dispatch after the cart version changes', async () => {
    const session = await fixture.liquidity.saveSession(fixture.actor, null, {
      accountId: 'checking',
      expiresAt,
      items: [
        {
          id: 'saved-food-purchase',
          categoryId: 'food',
          accountId: 'checking',
          amount: money('2000'),
          purchaseAt: now,
          requiredBy: now,
        },
      ],
    });
    fixture.grant(fixture.actor, 'session', session.id, 'session:view');
    fixture.grant(fixture.actor, 'session', session.id, 'full-read');
    const action = structuredClone(actionFixture.intent);
    const origin = { sessionId: session.id, sessionVersion: session.version };
    await expect(
      proposal(fixture, {
        action,
        decision: {
          origin: { sessionId: 'untrusted-session-id', sessionVersion: session.version },
        },
      }),
    ).rejects.toThrow();
    await expect(
      proposal(fixture, {
        action,
        decision: { origin, accountId: 'checking', items: [] },
      }),
    ).rejects.toThrow();
    expect(
      await fixture.store.listProposals({
        budgetId: fixture.actor.budgetId,
        operations: ['consequential_action'],
      }),
    ).toHaveLength(0);
    const created = await proposal(fixture, { action, decision: { origin } });
    const approver = await fixture.addMember(`saved-cart-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['account', 'checking'],
      ['account', 'savings'],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);

    const changed = await fixture.liquidity.saveSession(fixture.actor, session.id, {
      expectedVersion: session.version,
      accountId: 'checking',
      expiresAt,
      items: [
        {
          id: 'saved-food-purchase',
          categoryId: 'food',
          accountId: 'checking',
          amount: money('2500'),
          purchaseAt: now,
          requiredBy: now,
        },
      ],
    });
    expect(changed.version).not.toBe(session.version);
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
    expect(fixture.state.assignments).toEqual({ food: 0, reserve: 6000, 'reserve-two': 6000 });
  });
  it('preserves approved saved-session item timestamps during later funding revalidation', async () => {
    const session = await fixture.liquidity.saveSession(fixture.actor, null, {
      accountId: 'checking',
      expiresAt,
      items: [
        {
          id: 'saved-food-purchase',
          categoryId: 'food',
          accountId: 'checking',
          amount: money('2000'),
          purchaseAt: '2026-09-06T10:02:00.000Z',
          requiredBy: '2026-09-06T10:02:00.000Z',
        },
      ],
    });
    fixture.grant(fixture.actor, 'session', session.id, 'session:view');
    fixture.grant(fixture.actor, 'session', session.id, 'full-read');
    const created = await proposal(fixture, {
      action: structuredClone(actionFixture.intent),
      decision: { origin: { sessionId: session.id, sessionVersion: session.version } },
    });
    expect(created.decisionContext?.items).toMatchObject([
      { purchaseAt: '2026-09-06T10:02:00.000Z', requiredBy: '2026-09-06T10:02:00.000Z' },
    ]);
    const approver = await fixture.addMember(`saved-cart-time-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['account', 'checking'],
      ['account', 'savings'],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);

    fixture.setClock('2026-09-06T10:01:00.000Z');
    await expect(fixture.service.execute(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'verified',
    });
    expect(fixture.writes).toEqual([
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'reserve',
        amount: 4000,
        expectedAmount: 6000,
      },
      { kind: 'assignment', month: '2026-09', categoryId: 'food', amount: 2000, expectedAmount: 0 },
    ]);
  });

  it('binds immutable action/cart identity and rejects caller-supplied trusted source or plan', async () => {
    const body = reallocationIntent();
    await expect(
      fixture.service.propose(fixture.actor, { ...body, plan: { actionHash: 'forged' } }),
    ).rejects.toThrow();
    const created = await proposal(fixture, body);
    const stored = await fixture.store.getProposal(created.id);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Fixture action proposal required');
    body.action.assignments[0]!.amount = money('1');
    body.decision.items[0]!.amount = money('1');
    expect(await fixture.store.getProposal(created.id)).toEqual(stored);
    expect(stored.payload.plan.actionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      'protected donor',
      {
        categoryPolicies: [
          {
            categoryId: 'food',
            kind: 'ordinary',
            donorEligible: false,
            minimumRetained: money('0'),
            projectedRemainingNeed: money('0'),
          },
          {
            categoryId: 'reserve',
            kind: 'protected',
            donorEligible: true,
            minimumRetained: money('1000'),
            projectedRemainingNeed: money('0'),
          },
        ],
      },
    ],
    [
      'retained floor',
      {
        categoryPolicies: [
          {
            categoryId: 'food',
            kind: 'ordinary',
            donorEligible: false,
            minimumRetained: money('0'),
            projectedRemainingNeed: money('0'),
          },
          {
            categoryId: 'reserve',
            kind: 'ordinary',
            donorEligible: true,
            minimumRetained: money('5000'),
            projectedRemainingNeed: money('0'),
          },
        ],
      },
    ],
  ])('refuses a %s in the current native plan', async (_label, policyPatch) => {
    fixture.saveLiquidityPolicy(policyPatch);
    await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow();
    expect(
      await fixture.store.listProposals({
        budgetId: fixture.actor.budgetId,
        operations: ['consequential_action'],
      }),
    ).toHaveLength(0);
  });

  it('refuses stale sources, incomplete transaction coverage, and a current cash-buffer failure', async () => {
    const originalCapture = fixture.state.capturedAt;
    fixture.state.capturedAt = '2026-09-06T08:00:00.000Z';
    await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow();
    fixture.state.capturedAt = originalCapture;

    fixture.state.transactionCoverage = 'partial';
    await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow();
    fixture.state.transactionCoverage = 'empty';

    fixture.state.accounts.checking!.balance = 9000;
    await fixture.refreshObservations();
    await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow();
    expect(
      await fixture.store.listProposals({
        budgetId: fixture.actor.budgetId,
        operations: ['consequential_action'],
      }),
    ).toHaveLength(0);
  });

  it('takes the maximum current governance and financial approval quorum', async () => {
    const financialPolicy = fixture.saveLiquidityPolicy(
      {},
      {
        minimumApprovers: 3,
        thresholds: [{ currency: 'USD', minimumMinorUnits: '1000', minimumApprovers: 4 }],
      },
    );
    expect(financialPolicy.approvalPolicy).toMatchObject({
      minimumApprovers: 3,
      thresholds: [{ currency: 'USD', minimumMinorUnits: '1000', minimumApprovers: 4 }],
    });
    const current = fixture.store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
    if (!current) throw new Error('Fixture governance policy required');
    const governancePolicy = fixture.store.governance.setPolicy({
      spaceId: fixture.actor.spaceId!,
      expectedVersion: current.version,
      policy: {
        minimumApprovers: 1,
        approvalThresholds: [],
        operationApprovers: current.operationApprovers,
        assistanceMaximum: 'create_approval_proposal',
      },
      now,
      auth: auth('holder'),
    });
    fixture.actor = { ...fixture.actor, governancePolicyVersion: governancePolicy.version };
    expect(governancePolicy.minimumApprovers).toBe(1);
    expect(governancePolicy.approvalThresholds).toEqual([]);

    const created = await proposal(fixture);
    const summary = await fixture.store.getProposalApprovalSummary({
      proposalId: created.id,
      spaceId: fixture.actor.spaceId!,
      actorId: fixture.actor.actorId,
      auth: fixture.actor.auth!,
      now,
    });
    expect(summary.requiredApprovers).toBe(4);
    expect(summary.canExecute).toBe(false);
    expect(fixture.writes).toEqual([]);
  });
  it('uses governance quorum when it exceeds the financial approval quorum', async () => {
    const financialPolicy = fixture.saveLiquidityPolicy(
      {},
      { minimumApprovers: 1, thresholds: [] },
    );
    expect(financialPolicy.approvalPolicy).toMatchObject({ minimumApprovers: 1, thresholds: [] });
    const current = fixture.store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
    if (!current) throw new Error('Fixture governance policy required');
    const governancePolicy = fixture.store.governance.setPolicy({
      spaceId: fixture.actor.spaceId!,
      expectedVersion: current.version,
      policy: {
        minimumApprovers: 3,
        approvalThresholds: [],
        operationApprovers: current.operationApprovers,
        assistanceMaximum: 'create_approval_proposal',
      },
      now,
      auth: auth('holder'),
    });
    fixture.actor = { ...fixture.actor, governancePolicyVersion: governancePolicy.version };
    expect(governancePolicy.minimumApprovers).toBe(3);
    expect(governancePolicy.approvalThresholds).toEqual([]);

    const created = await proposal(fixture);
    const summary = await fixture.store.getProposalApprovalSummary({
      proposalId: created.id,
      spaceId: fixture.actor.spaceId!,
      actorId: fixture.actor.actorId,
      auth: fixture.actor.auth!,
      now,
    });
    expect(summary.requiredApprovers).toBe(3);
    expect(summary.canExecute).toBe(false);
    expect(fixture.writes).toEqual([]);
  });

  it('preserves an existing restrictive assistance ceiling when the liquidity policy is saved', async () => {
    fixture.setAssistanceMaximum('recommend_actions');
    fixture.saveLiquidityPolicy({ expiresAt: '2026-09-08T00:00:00.000Z' });
    const policy = fixture.store.governance.getPolicy({ spaceId: fixture.actor.spaceId! });
    expect(policy?.assistanceMaximum).toBe('recommend_actions');
    await expect(fixture.service.propose(fixture.actor, reallocationIntent())).rejects.toThrow();
  });

  it('revalidates changed financial policy after approval and before dispatch', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`policy-${created.id}`);
    fixture.grant(approver, 'budget', fixture.actor.budgetId, 'reallocation:approve');
    fixture.grant(approver, 'category', 'reserve', 'reallocation:approve');
    fixture.grant(approver, 'category', 'food', 'reallocation:approve');
    await fixture.approve(created.id, approver);
    fixture.saveLiquidityPolicy({
      categoryPolicies: [
        {
          categoryId: 'food',
          kind: 'ordinary',
          donorEligible: false,
          minimumRetained: money('0'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'reserve',
          kind: 'protected',
          donorEligible: true,
          minimumRetained: money('1000'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'reserve-two',
          kind: 'ordinary',
          donorEligible: true,
          minimumRetained: money('1000'),
          projectedRemainingNeed: money('0'),
        },
      ],
    });
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });
  it('requires the complete current approval quorum before any dispatch', async () => {
    fixture.saveLiquidityPolicy({}, { minimumApprovers: 2 });
    const created = await proposal(fixture);
    const approvers = await Promise.all([
      fixture.addMember(`quorum-one-${created.id}`),
      fixture.addMember(`quorum-two-${created.id}`),
    ]);
    for (const approver of approvers)
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['category', 'reserve'],
        ['category', 'food'],
      ] as const)
        fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approvers[0]!);
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);

    await fixture.approve(created.id, approvers[1]!);
    await expect(fixture.service.execute(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'verified',
    });
    expect(fixture.writes).toEqual([
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'reserve',
        amount: 4000,
        expectedAmount: 6000,
      },
      { kind: 'assignment', month: '2026-09', categoryId: 'food', amount: 2000, expectedAmount: 0 },
    ]);
  });

  it('executes the exact native assignment set and verifies synchronized Actual readback without replay writes', async () => {
    const { proposed, result } = await approveAndExecute(fixture);
    expect(result).toMatchObject({ phase: 'verified' });
    expect(fixture.writes).toEqual([
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'reserve',
        amount: 4000,
        expectedAmount: 6000,
      },
      { kind: 'assignment', month: '2026-09', categoryId: 'food', amount: 2000, expectedAmount: 0 },
    ]);
    expect(fixture.source().liquidity?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: 'reserve', availability: money('4000') }),
        expect.objectContaining({ categoryId: 'food', availability: money('2000') }),
      ]),
    );
    const stored = await fixture.store.getProposal(proposed.id);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Stored action proposal required');
    expect(
      (await fixture.store.getIdempotencyRecord(stored.payload.plan.idempotencyKey))
        ?.serialisedEffect,
    ).toBe(
      JSON.stringify({
        operation: stored.operation,
        payload: stored.payload,
        preconditions: JSON.parse(stored.preconditions) as unknown,
      }),
    );
    await fixture.service.execute(fixture.actor, proposed.id);
    expect(fixture.writes).toHaveLength(2);
  });
  it('dispatches native per-atom assignment poststates donor-first across a composite', async () => {
    fixture.saveLiquidityPolicy({
      categoryPolicies: [
        {
          categoryId: 'food',
          kind: 'ordinary',
          donorEligible: false,
          minimumRetained: money('0'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'reserve',
          kind: 'ordinary',
          donorEligible: true,
          minimumRetained: money('5000'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'reserve-two',
          kind: 'ordinary',
          donorEligible: true,
          minimumRetained: money('5000'),
          projectedRemainingNeed: money('0'),
        },
      ],
    });
    const action = {
      kind: 'composite' as const,
      actions: [
        {
          kind: 'reallocation' as const,
          assignments: [
            {
              sourceCategoryId: 'reserve',
              sourceAsOfMonth: '2026-09',
              destinationCategoryId: 'food',
              destinationAsOfMonth: '2026-09',
              amount: money('1000'),
            },
          ],
        },
        {
          kind: 'reallocation' as const,
          assignments: [
            {
              sourceCategoryId: 'reserve-two',
              sourceAsOfMonth: '2026-09',
              destinationCategoryId: 'food',
              destinationAsOfMonth: '2026-09',
              amount: money('1000'),
            },
          ],
        },
      ],
    };
    const decision = reallocationIntent().decision;
    const created = await proposal(fixture, { action, decision });
    const stored = await fixture.store.getProposal(created.id);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Stored action proposal required');
    expect(stored.payload.plan.dispatchPreconditions).toContainEqual({
      atomIndex: 0,
      accountBalances: [],
      assignments: [
        { categoryId: 'food', asOfMonth: '2026-09', amount: money('0'), postAmount: money('1000') },
        {
          categoryId: 'reserve',
          asOfMonth: '2026-09',
          amount: money('6000'),
          postAmount: money('5000'),
        },
      ],
    });
    expect(stored.payload.plan.dispatchPreconditions).toContainEqual({
      atomIndex: 1,
      accountBalances: [],
      assignments: [
        {
          categoryId: 'food',
          asOfMonth: '2026-09',
          amount: money('1000'),
          postAmount: money('2000'),
        },
        {
          categoryId: 'reserve-two',
          asOfMonth: '2026-09',
          amount: money('6000'),
          postAmount: money('5000'),
        },
      ],
    });

    const approver = await fixture.addMember(`prefix-assignment-${created.id}`);
    for (const id of ['food', 'reserve', 'reserve-two'])
      fixture.grant(approver, 'category', id, 'reallocation:approve');
    fixture.grant(approver, 'budget', fixture.actor.budgetId, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    await expect(fixture.service.execute(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'verified',
    });
    expect(fixture.writes).toEqual([
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'reserve',
        amount: 5000,
        expectedAmount: 6000,
      },
      { kind: 'assignment', month: '2026-09', categoryId: 'food', amount: 1000, expectedAmount: 0 },
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'reserve-two',
        amount: 5000,
        expectedAmount: 6000,
      },
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'food',
        amount: 2000,
        expectedAmount: 1000,
      },
    ]);
  });
  it('uses native prefix balances for a transfer after an earlier composite debit', async () => {
    fixture.state.assignments.food = 500;
    const manual = manualIntent('manual-prefix-transfer').action;
    const transfer = {
      kind: 'transfer' as const,
      transferId: 'transfer-prefix',
      correlationId: 'transfer-correlation-prefix',
      sourceAccountId: 'checking',
      destinationAccountId: 'savings',
      amount: money('1000'),
      date: '2026-09-06',
    };
    for (const capability of ['transaction.view', 'source'] as const)
      fixture.grant(fixture.actor, 'transaction', 'manual-prefix-transfer', capability);
    fixture.grant(fixture.actor, 'transaction', 'manual-prefix-transfer', 'transaction:propose');
    fixture.grant(fixture.actor, 'ledger_effect', 'manual-prefix-transfer', 'transaction:propose');
    fixture.grant(fixture.actor, 'transfer', transfer.transferId, 'transfer:propose');
    for (const capability of ['transfer.view', 'source'] as const)
      fixture.grant(fixture.actor, 'transfer', transfer.transferId, capability);
    const created = await proposal(fixture, {
      action: { kind: 'composite', actions: [manual, transfer] },
    });
    const stored = await fixture.store.getProposal(created.id);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Stored action proposal required');
    expect(stored.payload.plan.dispatchPreconditions).toContainEqual({
      atomIndex: 1,
      accountBalances: [
        { accountId: 'checking', balance: money('12500') },
        { accountId: 'savings', balance: money('20000') },
      ],
      assignments: [],
    });

    const approver = await fixture.addMember(`prefix-transfer-${created.id}`);
    for (const [kind, id, capability] of [
      ['budget', fixture.actor.budgetId, 'transaction:approve'],
      ['account', 'checking', 'transaction:approve'],
      ['category', 'food', 'transaction:approve'],
      ['transaction', 'manual-prefix-transfer', 'transaction:approve'],
      ['ledger_effect', 'manual-prefix-transfer', 'transaction:approve'],
      ['budget', fixture.actor.budgetId, 'transfer:approve'],
      ['account', 'checking', 'transfer:approve'],
      ['account', 'savings', 'transfer:approve'],
      ['transfer', transfer.transferId, 'transfer:approve'],
    ] as const)
      fixture.grant(approver, kind, id, capability);
    await fixture.approve(created.id, approver);

    await expect(fixture.service.execute(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'verified',
    });
    expect(fixture.writes.some((write) => write.kind === 'transfer')).toBe(true);
    expect(fixture.state.accounts.checking?.balance).toBe(11500);
    expect(fixture.state.accounts.savings?.balance).toBe(21000);
  });

  it('uses the store final-authority callback after an adapter read and prevents dispatch after grant revocation', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`fence-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    let entered!: () => void;
    let release!: () => void;
    const atFence = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.beforeAssignmentFence = async () => {
      entered();
      await wait;
    };
    const pending = fixture.service.execute(fixture.actor, created.id);
    await atFence;
    fixture.grant(fixture.actor, 'category', 'reserve', 'reallocation:execute', false);
    release();
    await expect(pending).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });
  it('does not persist an atom effect when assignment preconditions fail before the execution fence', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`no-dispatch-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    fixture.beforeAssignmentFence = async () => {
      fixture.state.assignments.reserve = 5500;
    };

    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow(
      /assignment source changed/i,
    );
    const stored = await fixture.store.getProposal(created.id);
    expect(stored?.state).toMatchObject({ phase: 'invalidated_no_dispatch', effects: [] });
    await expect(fixture.service.reconcile(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'invalidated_no_dispatch',
    });
    expect(fixture.writes).toEqual([]);
  });
  it('rechecks the manual transaction capability after awaited adapter reads and before SDK dispatch', async () => {
    fixture.state.assignments.food = 500;
    const intent = manualIntent('manual-single');
    const created = await proposal(fixture, intent);
    const approver = await fixture.addMember(`manual-fence-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['account', 'checking'],
      ['category', 'food'],
      ['transaction', 'manual-single'],
      ['ledger_effect', 'manual-single'],
    ] as const)
      fixture.grant(approver, kind, id, 'transaction:approve');
    await fixture.approve(created.id, approver);
    let entered!: () => void;
    let release!: () => void;
    const atFence = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.pauseBeforeManualFence = async () => {
      entered();
      await wait;
    };
    const pending = fixture.service.execute(fixture.actor, created.id);
    await atFence;
    fixture.grant(fixture.actor, 'transaction', 'manual-single', 'transaction:execute', false);
    release();
    await expect(pending).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });
  it.each(['manual', 'wallet', 'transfer'] as const)(
    'invalidates a %s adapter result returned before dispatch without recording an atom effect',
    async (kind) => {
      const parentId = 'manual-no-dispatch';
      const walletId = 'wallet-no-dispatch';
      const transferId = 'transfer-no-dispatch';
      const intent =
        kind === 'manual'
          ? manualIntent(parentId)
          : kind === 'wallet'
            ? {
                action: {
                  kind: 'wallet_materialization' as const,
                  walletId,
                  accountName: 'No-dispatch wallet',
                  currency: 'USD',
                },
              }
            : {
                action: {
                  kind: 'transfer' as const,
                  transferId,
                  correlationId: 'transfer-correlation-no-dispatch',
                  sourceAccountId: 'checking',
                  destinationAccountId: 'savings',
                  amount: money('1000'),
                  date: '2026-09-06',
                },
              };
      fixture.failBeforeDispatch = kind;
      const resourceId = kind === 'manual' ? parentId : kind === 'wallet' ? walletId : transferId;
      if (kind === 'manual') {
        fixture.state.assignments.food = 500;
        for (const [scope, id] of [
          ['budget', fixture.actor.budgetId],
          ['account', 'checking'],
          ['category', 'food'],
          ['transaction', resourceId],
          ['ledger_effect', resourceId],
        ] as const)
          for (const scopedCapability of ['transaction:propose', 'transaction:execute'] as const)
            fixture.grant(fixture.actor, scope, id, scopedCapability);
        for (const scopedCapability of ['transaction.view', 'source'] as const)
          fixture.grant(fixture.actor, 'transaction', resourceId, scopedCapability);
        for (const scopedCapability of ['source', 'full-read'] as const)
          fixture.grant(fixture.actor, 'ledger_effect', resourceId, scopedCapability);
      } else if (kind === 'wallet') {
        for (const [scope, id] of [
          ['budget', fixture.actor.budgetId],
          ['wallet', resourceId],
        ] as const)
          for (const scopedCapability of [
            'wallet_materialization:propose',
            'wallet_materialization:execute',
          ] as const)
            fixture.grant(fixture.actor, scope, id, scopedCapability);
        for (const scopedCapability of ['existence', 'history', 'name', 'full-read'] as const)
          fixture.grant(fixture.actor, 'wallet', resourceId, scopedCapability);
      } else {
        for (const [scope, id] of [
          ['budget', fixture.actor.budgetId],
          ['account', 'checking'],
          ['account', 'savings'],
          ['transfer', resourceId],
        ] as const)
          for (const scopedCapability of ['transfer:propose', 'transfer:execute'] as const)
            fixture.grant(fixture.actor, scope, id, scopedCapability);
        for (const scopedCapability of ['transfer.view', 'source', 'full-read'] as const)
          fixture.grant(fixture.actor, 'transfer', resourceId, scopedCapability);
      }

      const created = await proposal(fixture, intent);
      const approver = await fixture.addMember(`pre-dispatch-${created.id}`);
      const approvalCapability =
        kind === 'manual'
          ? 'transaction:approve'
          : kind === 'wallet'
            ? 'wallet_materialization:approve'
            : 'transfer:approve';
      const approvalResources =
        kind === 'manual'
          ? ([
              ['budget', fixture.actor.budgetId],
              ['account', 'checking'],
              ['category', 'food'],
              ['transaction', parentId],
              ['ledger_effect', parentId],
            ] as const)
          : kind === 'wallet'
            ? ([
                ['budget', fixture.actor.budgetId],
                ['wallet', walletId],
              ] as const)
            : ([
                ['budget', fixture.actor.budgetId],
                ['account', 'checking'],
                ['account', 'savings'],
                ['transfer', transferId],
              ] as const);
      for (const [scope, id] of approvalResources)
        fixture.grant(approver, scope, id, approvalCapability);
      await fixture.approve(created.id, approver);

      await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow(
        /pre-dispatch validation failed/i,
      );
      const stored = await fixture.store.getProposal(created.id);
      expect(stored?.state).toMatchObject({ phase: 'invalidated_no_dispatch', effects: [] });
      expect(fixture.writes).toEqual([]);
    },
  );

  it('marks an ambiguous dispatched action review-required and never redispatches it on replay', async () => {
    fixture.failManualAfterWrite = true;
    const composite = {
      action: structuredClone(actionFixture.compositeIntent),
      decision: {
        accountId: 'checking',
        items: [
          {
            id: 'purchase-food',
            categoryId: 'food',
            accountId: 'checking',
            amount: money('2000'),
            purchaseAt: now,
            requiredBy: now,
          },
        ],
      },
    };
    const compositeProposal = await proposal(fixture, composite);
    const compositeApprover = await fixture.addMember(`composite-${compositeProposal.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
      ['account', 'checking'],
      ['transaction', 'manual-parent-composite-1'],
      ['ledger_effect', 'manual-parent-composite-1'],
    ] as const)
      fixture.grant(compositeApprover, kind, id, 'reallocation:approve');
    fixture.grant(compositeApprover, 'budget', fixture.actor.budgetId, 'transaction:approve');
    fixture.grant(compositeApprover, 'account', 'checking', 'transaction:approve');
    fixture.grant(compositeApprover, 'category', 'food', 'transaction:approve');
    fixture.grant(
      compositeApprover,
      'transaction',
      'manual-parent-composite-1',
      'transaction:approve',
    );
    fixture.grant(
      compositeApprover,
      'ledger_effect',
      'manual-parent-composite-1',
      'transaction:approve',
    );
    await fixture.approve(compositeProposal.id, compositeApprover);
    const first = await fixture.service.execute(fixture.actor, compositeProposal.id);
    const stored = await fixture.store.getProposal(compositeProposal.id);
    expect(stored?.state).toMatchObject({ phase: 'review_required' });
    expect(fixture.writes.filter((write) => write.kind === 'manual')).toHaveLength(1);
    expect(first).toMatchObject({ phase: 'review_required' });
    await fixture.service.execute(fixture.actor, compositeProposal.id);
    expect(fixture.writes.filter((write) => write.kind === 'manual')).toHaveLength(1);
    if (!stored || stored.operation !== 'consequential_action')
      throw new Error('Fixture action proposal required');
    expect(
      await fixture.store.getIdempotencyRecord(stored.payload.plan.idempotencyKey),
    ).toMatchObject({ status: 'in_progress' });
  });

  it('binds server-derived manual decision items to the captured current time', async () => {
    fixture.state.assignments.food = 500;
    const intent = manualIntent('manual-current-decision-time');
    intent.action.transaction.date = '2026-09-05';

    const created = await proposal(fixture, intent);

    expect(created.payload.plan.action).toMatchObject({
      kind: 'manual_transaction',
      transaction: { parentId: 'manual-current-decision-time', date: '2026-09-05' },
    });
    expect(created.decisionContext?.items).toEqual([
      expect.objectContaining({
        id: 'manual-current-decision-time',
        purchaseAt: fixture.clockNow,
        requiredBy: fixture.clockNow,
      }),
    ]);
  });
  it.each(['single', 'split', 'evidence'] as const)(
    'executes an immediate %s debit after the approval clock advances',
    async (kind) => {
      fixture.state.assignments.food = 1800;
      const parentId = kind === 'evidence' ? 'evidence-projection' : `manual-${kind}`;
      const transaction = manualIntent(parentId).action.transaction;
      const event = fixture.state.resolution;
      if (!event) throw new Error('Trusted economic event fixture required');
      const action =
        kind === 'evidence'
          ? { kind: 'evidence_projection' as const, transaction, evidenceIds: [event.evidenceId] }
          : {
              kind: 'manual_transaction' as const,
              transaction:
                kind === 'split'
                  ? {
                      ...transaction,
                      categoryId: null,
                      splits: [
                        { categoryId: 'food', amount: money('-300') },
                        { categoryId: 'reserve', amount: money('-200') },
                      ],
                    }
                  : transaction,
            };
      const { proposed, result } = await approveAndExecute(fixture, { action }, () => {
        fixture.setClock('2026-09-06T10:00:30.000Z');
      });
      expect(proposed.decisionContext?.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ purchaseAt: now, requiredBy: now })]),
      );
      expect(result.phase).toBe('verified');
      expect(fixture.writes).toEqual([
        { kind: 'manual', parentId, amount: -500, splits: kind === 'split' ? 2 : 0 },
      ]);
    },
  );

  it('keeps an explicit cart deadline binding when its shape matches a composite manual debit', async () => {
    const parentId = 'manual-parent-composite-1';
    const reallocation = structuredClone(actionFixture.intent);
    reallocation.assignments[0]!.amount = money('500');
    const created = await proposal(fixture, {
      action: { kind: 'composite', actions: [reallocation, manualIntent(parentId).action] },
      decision: {
        accountId: null,
        items: [
          {
            id: parentId,
            categoryId: 'food',
            accountId: 'checking',
            amount: money('500'),
            purchaseAt: now,
            requiredBy: now,
          },
        ],
      },
    });
    const approver = await fixture.addMember(`deadline-${created.id}`);
    for (const capability of ['reallocation:approve', 'transaction:approve'])
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['category', 'reserve'],
        ['category', 'food'],
        ['account', 'checking'],
        ['transaction', parentId],
        ['ledger_effect', parentId],
      ] as const)
        fixture.grant(approver, kind, id, capability);
    await fixture.approve(created.id, approver);
    fixture.setClock('2026-09-06T10:00:30.000Z');
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow(
      /precondition|expired|source|decision/i,
    );
    expect(fixture.writes).toEqual([]);
  });

  it('keeps saved-session deadlines binding when the cart matches a composite manual debit', async () => {
    const parentId = 'manual-parent-composite-1';
    const session = await fixture.liquidity.saveSession(fixture.actor, null, {
      accountId: null,
      expiresAt,
      items: [
        {
          id: parentId,
          categoryId: 'food',
          accountId: 'checking',
          amount: money('500'),
          purchaseAt: now,
          requiredBy: now,
        },
      ],
    });
    for (const capability of ['session:view', 'full-read'])
      fixture.grant(fixture.actor, 'session', session.id, capability);
    const reallocation = structuredClone(actionFixture.intent);
    reallocation.assignments[0]!.amount = money('500');
    const created = await proposal(fixture, {
      action: { kind: 'composite', actions: [reallocation, manualIntent(parentId).action] },
      decision: { origin: { sessionId: session.id, sessionVersion: session.version } },
    });
    const approver = await fixture.addMember(`saved-deadline-${created.id}`);
    for (const capability of ['reallocation:approve', 'transaction:approve'])
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['category', 'reserve'],
        ['category', 'food'],
        ['account', 'checking'],
        ['transaction', parentId],
        ['ledger_effect', parentId],
      ] as const)
        fixture.grant(approver, kind, id, capability);
    await fixture.approve(created.id, approver);

    fixture.setClock('2026-09-06T10:00:30.000Z');
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow(
      /decision.*expired/i,
    );
    expect(fixture.writes).toEqual([]);
    expect(await fixture.store.getProposal(created.id)).toMatchObject({
      state: { phase: 'invalidated_no_dispatch', effects: [] },
    });
  });

  it('rejects an elapsed requiredBy deadline even when the explicit purchaseAt remains future', async () => {
    const intent = reallocationIntent();
    intent.decision.items[0]!.purchaseAt = '2026-09-06T10:02:00.000Z';
    await expect(
      approveAndExecute(fixture, intent, () => {
        fixture.setClock('2026-09-06T10:00:30.000Z');
      }),
    ).rejects.toThrow(/decision.*expired/i);
    expect(fixture.writes).toEqual([]);
  });

  it('allows an explicit cart deadline exactly at the execution capture time', async () => {
    const intent = reallocationIntent();
    intent.decision.items[0]!.purchaseAt = '2026-09-06T10:00:30.000Z';
    intent.decision.items[0]!.requiredBy = '2026-09-06T10:00:30.000Z';
    const { result } = await approveAndExecute(fixture, intent, () => {
      fixture.setClock('2026-09-06T10:00:30.000Z');
    });
    expect(result.phase).toBe('verified');
    expect(fixture.writes).toHaveLength(2);
  });

  it('executes a future explicit cart with an appended immediate server-generated debit', async () => {
    const parentId = 'manual-parent-composite-1';
    const appendedParentId = 'manual-single';
    const reallocation = structuredClone(actionFixture.intent);
    reallocation.assignments[0]!.amount = money('1000');
    const created = await proposal(fixture, {
      action: {
        kind: 'composite',
        actions: [
          reallocation,
          manualIntent(parentId).action,
          manualIntent(appendedParentId).action,
        ],
      },
      decision: {
        accountId: null,
        items: [
          {
            id: 'future-explicit-purchase',
            categoryId: 'food',
            accountId: 'checking',
            amount: money('500'),
            purchaseAt: '2026-09-06T10:02:00.000Z',
            requiredBy: '2026-09-06T10:02:00.000Z',
          },
        ],
      },
    });
    expect(created.decisionContext?.items).toMatchObject([
      { id: 'future-explicit-purchase', purchaseAt: '2026-09-06T10:02:00.000Z' },
      { id: appendedParentId, purchaseAt: now, requiredBy: now },
    ]);
    const approver = await fixture.addMember(`future-deadline-${created.id}`);
    for (const capability of ['reallocation:approve', 'transaction:approve'])
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['category', 'reserve'],
        ['category', 'food'],
        ['account', 'checking'],
        ['transaction', parentId],
        ['ledger_effect', parentId],
        ['transaction', appendedParentId],
        ['ledger_effect', appendedParentId],
      ] as const)
        fixture.grant(approver, kind, id, capability);
    await fixture.approve(created.id, approver);

    fixture.setClock('2026-09-06T10:00:30.000Z');
    await expect(fixture.service.execute(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'verified',
    });
    expect(fixture.writes).toEqual([
      {
        kind: 'assignment',
        month: '2026-09',
        categoryId: 'reserve',
        amount: 5000,
        expectedAmount: 6000,
      },
      { kind: 'assignment', month: '2026-09', categoryId: 'food', amount: 1000, expectedAmount: 0 },
      { kind: 'manual', parentId, amount: -500, splits: 0 },
      { kind: 'manual', parentId: appendedParentId, amount: -500, splits: 0 },
    ]);
  });

  it.each([false, true])(
    'preserves prior historical routing and detects unrelated source drift (%s)',
    async (drift) => {
      fixture.state.assignments.food = 1800;
      const prior = manualRow({
        parentId: 'prior-purchase',
        correlationId: 'prior-correlation',
        accountId: 'checking',
        amount: -100,
        categoryId: 'food',
        date: '2026-09-05',
      });
      fixture.state.transactions = [prior];
      fixture.state.transactionCoverage = 'complete';
      await fixture.refreshObservations();
      fixture.pauseBeforeManualFence = async () => {
        if (drift) fixture.state.transactions = [{ ...prior, notes: 'unrelated external edit' }];
      };
      const { result } = await approveAndExecute(fixture, manualIntent('manual-single'));
      expect(result.phase).toBe(drift ? 'review_required' : 'verified');
      expect(fixture.writes).toEqual([
        { kind: 'manual', parentId: 'manual-single', amount: -500, splits: 0 },
      ]);
    },
  );

  it('pins the exact native allocation manifest in proposal review without accepting caller supplied proof', async () => {
    fixture.state.assignments.food = 1800;
    const event = fixture.state.resolution!;
    const matrix = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/evidence-allocation-plan-result.json', import.meta.url),
        'utf8',
      ),
    ).review;
    fixture.state.resolution = { ...event, allocationReview: matrix };
    const action = {
      kind: 'evidence_projection',
      transaction: manualIntent('evidence-projection').action.transaction,
      evidenceIds: [event.evidenceId],
    };
    await expect(
      fixture.service.propose(fixture.actor, { action, allocationReviews: [matrix] }),
    ).rejects.toThrow();
    const proposed = await fixture.service.propose(fixture.actor, { action });
    expect(proposed.payload.plan.allocationReviews).toEqual([matrix]);
    const stored = await fixture.store.getProposal(proposed.id);
    expect(stored).not.toBeNull();
    expect(JSON.parse(String(stored!.preconditions)).allocationReviews).toEqual([matrix]);
    fixture.grant(
      fixture.actor,
      'category',
      matrix.lineCategories[0].categoryId,
      'liquidity',
      false,
    );
    const revoked = await fixture.service.getProposal(fixture.actor, proposed.id);
    expect(revoked?.payload.plan.allocationReviews).toBeUndefined();
  });
  it('reuses the manual/split and evidence-projection pipeline, deriving evidence only from current server source', async () => {
    fixture.state.assignments.food = 1800;
    const single = manualIntent('manual-single');
    const singleResult = await approveAndExecute(fixture, single);
    expect(singleResult.result).toMatchObject({ phase: 'verified' });
    expect(fixture.writes).toContainEqual({
      kind: 'manual',
      parentId: 'manual-single',
      amount: -500,
      splits: 0,
    });
    expect(fixture.state.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'manual-single',
          accountId: 'checking',
          categoryId: 'food',
          amount: money('-500'),
          importedId: null,
          transferAccountId: null,
        }),
      ]),
    );
    await fixture.refreshObservations();

    const split = {
      action: {
        kind: 'manual_transaction',
        transaction: {
          ...manualIntent('manual-split').action.transaction,
          amount: money('-500'),
          categoryId: null,
          splits: [
            { categoryId: 'food', amount: money('-300') },
            { categoryId: 'reserve', amount: money('-200') },
          ],
        },
      },
    };
    const splitResult = await approveAndExecute(fixture, split);
    expect(splitResult.result).toMatchObject({ phase: 'verified' });
    expect(fixture.writes).toContainEqual({
      kind: 'manual',
      parentId: 'manual-split',
      amount: -500,
      splits: 2,
    });
    expect(
      fixture.state.transactions.find((row) => row.id === 'manual-split')?.subtransactions,
    ).toHaveLength(2);
    await fixture.refreshObservations();

    const event = fixture.state.resolution;
    if (!event) throw new Error('Trusted economic event fixture required');
    expect(fixture.source().observations).toContainEqual(
      expect.objectContaining({
        kind: 'economic_event_resolution',
        scope: { kind: 'transaction', id: event.subjectId },
        state: 'resolved',
        observedAt: event.observedAt,
        contentHash: event.contentHash,
        version: event.version,
        ledgerEffect: event.ledgerEffect,
        evidence: [
          expect.objectContaining({
            evidenceId: event.evidenceId,
            kind: 'economic_event_resolution',
            authorized: true,
            redaction: 'visible',
          }),
        ],
      }),
    );
    const projection = {
      action: {
        kind: 'evidence_projection',
        transaction: {
          ...manualIntent('evidence-projection').action.transaction,
          parentId: 'evidence-projection',
        },
        evidenceIds: [event.evidenceId],
      },
    };
    await expect(
      fixture.service.propose(fixture.actor, {
        action: { ...projection.action, evidenceIds: ['checking-freshness'] },
      }),
    ).rejects.toThrow();
    await expect(
      fixture.service.propose(fixture.actor, {
        action: {
          ...projection.action,
          transaction: { ...projection.action.transaction, amount: money('-501') },
        },
      }),
    ).rejects.toThrow();
    await expect(
      fixture.service.propose(fixture.actor, {
        action: {
          ...projection.action,
          transaction: { ...projection.action.transaction, categoryId: 'reserve' },
        },
      }),
    ).rejects.toThrow();
    expect(fixture.source().observations).toContainEqual(
      expect.objectContaining({
        scope: { kind: 'transaction', id: event.subjectId },
        ledgerEffect: event.ledgerEffect,
      }),
    );
    const projectionResult = await approveAndExecute(fixture, projection);
    expect(projectionResult.result).toMatchObject({ phase: 'verified' });
    const publicEvidence = projectionResult.proposed.payload.plan.evidenceReferences.find(
      (reference) => reference.evidenceId === event.evidenceId,
    );
    expect(publicEvidence).toEqual({
      evidenceId: event.evidenceId,
      subjectId: event.subjectId,
      state: 'resolved',
    });
    expect(publicEvidence).not.toHaveProperty('contentHash');
    expect(publicEvidence).not.toHaveProperty('version');
    expect(fixture.writes).toContainEqual(
      expect.objectContaining({ kind: 'manual', parentId: 'evidence-projection' }),
    );
    await expect(
      fixture.service.propose(fixture.actor, {
        ...projection,
        resolvedEvidence: [
          {
            evidenceId: event.evidenceId,
            subjectId: event.subjectId,
            state: 'resolved',
            contentHash: event.contentHash,
            version: event.version,
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      fixture.service.propose(fixture.actor, {
        action: {
          ...projection.action,
          transaction: {
            ...projection.action.transaction,
            parentId: 'different-parent',
            correlationId: 'different-correlation',
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('invalidates a projection when its server-resolved event content identity changes', async () => {
    const resolution = fixture.state.resolution;
    if (!resolution) throw new Error('Trusted economic event fixture required');
    const parentId = 'evidence-projection-versioned';
    fixture.state.assignments.food = 500;
    for (const kind of ['transaction', 'ledger_effect'] as const)
      fixture.grant(fixture.actor, kind, parentId, 'ledger_projection:propose');
    for (const capability of ['transaction.view', 'source'] as const)
      fixture.grant(fixture.actor, 'transaction', parentId, capability);
    const intent = {
      action: {
        kind: 'evidence_projection',
        transaction: {
          ...manualIntent(parentId).action.transaction,
          parentId,
        },
        evidenceIds: [resolution.evidenceId],
      },
    };
    const created = await proposal(fixture, intent);
    const approver = await fixture.addMember(`projection-version-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['account', 'checking'],
      ['category', 'food'],
      ['evidence', resolution.evidenceId],
      ['transaction', parentId],
      ['ledger_effect', parentId],
    ] as const)
      fixture.grant(approver, kind, id, 'ledger_projection:approve');
    fixture.grant(approver, 'evidence', resolution.evidenceId, 'source');
    await fixture.approve(created.id, approver);

    fixture.state.resolution = {
      ...resolution,
      contentHash: 'sha256:bank-event-purchase-1-content-v2',
      version: 'resolution-v2',
    };
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
    expect(fixture.state.transactions).toEqual([]);

    fixture.state.resolution = null;
    await expect(
      fixture.service.propose(fixture.actor, {
        ...intent,
        action: {
          ...intent.action,
          transaction: { ...intent.action.transaction, parentId: 'evidence-projection-missing' },
        },
      }),
    ).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });

  it('keeps unrelated governed actions usable with two disconnected real native wallet coverage components', async () => {
    const input = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/wallet-statement.json', import.meta.url),
        'utf8',
      ),
    );
    const second = structuredClone(input.observations[0]);
    second.id = 'wallet-2';
    second.externalEventId = 'payment-2';
    second.date = '2026-10-20';
    input.observations.push(second);
    const native = createRequire(import.meta.url)('@balanceframe/native') as {
      deriveWalletStatementPreview(input: string): string;
      resolveTransactionEvidence(input: string): string;
    };
    const preview = JSON.parse(
      native.deriveWalletStatementPreview(
        JSON.stringify({
          contractVersion: '1',
          evidence: input,
          walletId: 'wallet',
          startDate: '2026-10-20',
          endDate: '2026-10-21',
        }),
      ),
    );
    const proof = structuredClone(input.statementProofs[0]);
    proof.proofId = 'proof-2';
    proof.startDate = '2026-10-20';
    proof.endDate = '2026-10-21';
    proof.activityManifest = preview.activityManifest;
    proof.statement.documentId = 'statement-2';
    input.statementProofs.push(proof);
    const resolved = JSON.parse(
      native.resolveTransactionEvidence(JSON.stringify(input)),
    ) as import('@balanceframe/protocol-generated').TransactionEvidenceResult;
    const anchors = resolved.wallets[0]!.anchorObservations!;
    expect(anchors).toHaveLength(4);
    expect(new Set(anchors.map((o) => o.contentHash)).size).toBe(2);
    fixture.state.additionalObservations = anchors.map((anchor) => ({
      ...anchor,
      observedAt: now,
    }));
    const created = await proposal(fixture, reallocationIntent());
    expect(created.payload.plan.action.kind).toBe('reallocation');
    expect(
      created.payload.plan.evidenceReferences.every(
        (r) => !['statement', 'statement-2'].includes(r.evidenceId),
      ),
    ).toBe(true);
    expect(fixture.writes).toEqual([]);
  });

  it.each(['success', 'source-changed', 'grant-revoked'] as const)(
    'materializes reviewed opening equity or refuses %s under independent approval and exact postconditions',
    async (kind) => {
      const opening = {
        amount: money('1200'),
        date: '2026-09-01',
        proofSetHash: 'a'.repeat(64),
        activityManifestHash: 'b'.repeat(64),
      };
      fixture.state.additionalObservations = [
        {
          kind: 'wallet_statement_anchor',
          scope: { kind: 'claim', id: 'wallet-one' },
          state: 'resolved',
          observedAt: now,
          version: 'wallet-statement-v1',
          contentHash: opening.proofSetHash,
          walletBalanceAnchor: {
            walletId: 'wallet-one',
            amount: opening.amount,
            asOfDate: opening.date,
            boundary: 'before_day_activity',
            proofIds: ['proof'],
            proofSetHash: opening.proofSetHash,
            activityManifestHash: opening.activityManifestHash,
            evidenceIds: ['wallet-statement'],
          },
          evidence: [
            {
              evidenceId: 'wallet-statement',
              kind: 'human_attested_statement',
              authorized: true,
              redaction: 'visible',
            },
          ],
        },
      ];
      for (const capability of [
        'source',
        'evidence',
        'normalized-evidence',
        'full-read',
        'wallet_materialization:propose',
        'wallet_materialization:execute',
      ])
        fixture.grant(fixture.actor, 'evidence', 'wallet-statement', capability);
      const intent = {
        action: {
          kind: 'wallet_materialization',
          walletId: 'wallet-one',
          accountName: 'Trip wallet',
          currency: 'USD',
          opening,
        },
      };
      const created = await proposal(fixture, intent);
      const approver = await fixture.addMember('opening-approver');
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['wallet', 'wallet-one'],
      ] as const)
        fixture.grant(approver, kind, id, 'wallet_materialization:approve');
      for (const capability of [
        'source',
        'evidence',
        'normalized-evidence',
        'wallet_materialization:approve',
      ])
        fixture.grant(approver, 'evidence', 'wallet-statement', capability);
      await fixture.approve(created.id, approver);
      expect(fixture.writes).toEqual([]);
      if (kind !== 'success') {
        if (kind === 'grant-revoked')
          fixture.grant(fixture.actor, 'evidence', 'wallet-statement', 'source', false);
        else
          fixture.state.additionalObservations![0]!.walletBalanceAnchor!.activityManifestHash =
            'd'.repeat(64);
        await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
        expect(fixture.writes).toEqual([]);
        return;
      }

      expect((await fixture.service.execute(fixture.actor, created.id)).phase).toBe('verified');
      expect(fixture.state.accounts['actual-generated-wallet-one']!.balance).toBe(1200);
      expect(fixture.state.transactions).toContainEqual(
        expect.objectContaining({
          id: 'opening-wallet-one',
          amount: money('1200'),
          date: '2026-09-01',
          payeeName: 'Starting Balance',
        }),
      );
      expect(fixture.nativePlans.at(-1)?.intent).toEqual(intent.action);
      await expect(fixture.service.propose(fixture.actor, intent)).rejects.toThrow(
        /invalid_or_existing_wallet/,
      );
    },
  );

  it('binds wallet identity to the Actual-generated account ID and never accepts a caller-selected ID', async () => {
    const intent = {
      action: {
        kind: 'wallet_materialization',
        walletId: 'wallet-one',
        accountName: 'Trip wallet',
        currency: 'USD',
      },
    };
    const result = await approveAndExecute(fixture, intent);
    expect(result.result).toMatchObject({ phase: 'verified' });
    for (const capability of ['conclusion', 'observe', 'source', 'full-read'] as const)
      fixture.grant(result.approver, 'budget', fixture.actor.budgetId, capability);
    fixture.grant(result.approver, 'wallet', 'wallet-one', 'full-read');
    await grantProposalDetail(fixture, result.approver, result.proposed.id);
    const approvalDetail = await fixture.service.getProposal(result.approver, result.proposed.id);
    expect(approvalDetail?.payload.plan.expectedPostconditions).toContainEqual(
      expect.objectContaining({
        kind: 'wallet_mapping',
        walletId: 'wallet-one',
      }),
    );
    const executor = await fixture.addMember('wallet-detail-executor');
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['wallet', 'wallet-one'],
    ] as const)
      fixture.grant(executor, kind, id, 'wallet_materialization:execute');
    for (const capability of ['conclusion', 'observe', 'source', 'full-read'] as const)
      fixture.grant(executor, 'budget', fixture.actor.budgetId, capability);
    fixture.grant(executor, 'wallet', 'wallet-one', 'full-read');
    await grantProposalDetail(fixture, executor, result.proposed.id);
    const executionDetail = await fixture.service.getProposal(executor, result.proposed.id);
    expect(executionDetail?.payload.plan.expectedPostconditions).toContainEqual(
      expect.objectContaining({
        kind: 'wallet_mapping',
        walletId: 'wallet-one',
      }),
    );
    expect(fixture.writes).toContainEqual({
      kind: 'wallet',
      walletId: 'wallet-one',
      accountId: 'actual-generated-wallet-one',
    });
    expect(fixture.state.accounts['actual-generated-wallet-one']).toMatchObject({
      name: 'Trip wallet',
      balance: 0,
      onBudget: true,
      closed: false,
    });
    await expect(
      fixture.service.propose(fixture.actor, {
        ...intent,
        action: { ...intent.action, accountId: 'caller-selected-id' },
      }),
    ).rejects.toThrow();
    await expect(fixture.service.propose(fixture.actor, intent)).rejects.toThrow();
  });

  it.each(['balance', 'rename', 'both'] as const)(
    'retains a verified materialized wallet identity after a legitimate %s change',
    async (kind) => {
      const action = {
        kind: 'wallet_materialization',
        walletId: 'wallet-one',
        accountName: 'Trip wallet',
        currency: 'USD',
      };
      expect((await approveAndExecute(fixture, { action })).result.phase).toBe('verified');
      const walletAccountId = 'actual-generated-wallet-one';
      if (kind !== 'rename') {
        fixture.state.accounts[walletAccountId]!.balance = 1200;
        fixture.state.accounts.checking!.balance -= 1200;
      }
      if (kind !== 'balance') fixture.state.accounts[walletAccountId]!.name = 'Renamed trip wallet';
      for (const capability of financialCapabilities)
        if (capability !== 'full-read')
          fixture.grant(fixture.actor, 'account', walletAccountId, capability);
      const version = fixture.store.liquidity.loadEvaluationState({
        ...fixture.actor,
        now: fixture.clockNow,
      }).supplemental!.version;
      await fixture.liquidity.saveObservations(fixture.actor, {
        expectedVersion: version,
        expiresAt,
        observations: Object.keys(fixture.state.accounts).map((accountId) => ({
          accountId,
          currentLedgerConfirmed: true,
          kind: 'cash',
          currency: 'USD',
          owned: true,
          holds: money('0'),
        })),
      });
      await expect(fixture.service.propose(fixture.actor, { action })).rejects.toThrow(
        /invalid_or_existing_wallet/,
      );
      expect(fixture.writes.filter((write) => write.kind === 'wallet')).toHaveLength(1);
    },
  );

  it.each(['closed', 'off-budget', 'missing', 'currency'] as const)(
    'reserves a verified wallet identity after its account becomes %s without blocking unrelated actions',
    async (kind) => {
      const action = {
        kind: 'wallet_materialization',
        walletId: 'wallet-one',
        accountName: 'Trip wallet',
        currency: 'USD',
      };
      const original = await approveAndExecute(fixture, { action });
      expect(original.result.phase).toBe('verified');
      const accountId = 'actual-generated-wallet-one';
      if (kind === 'closed') fixture.state.accounts[accountId]!.closed = true;
      if (kind === 'off-budget') fixture.state.accounts[accountId]!.onBudget = false;
      if (kind === 'missing') delete fixture.state.accounts[accountId];
      if (kind === 'currency') fixture.state.accounts[accountId]!.currency = 'EUR';
      for (const capability of financialCapabilities)
        if (capability !== 'full-read')
          fixture.grant(fixture.actor, 'account', accountId, capability);
      const version = fixture.store.liquidity.loadEvaluationState({
        ...fixture.actor,
        now: fixture.clockNow,
      }).supplemental!.version;
      await fixture.liquidity.saveObservations(fixture.actor, {
        expectedVersion: version,
        expiresAt,
        observations: Object.entries(fixture.state.accounts).map(([accountId, account]) => ({
          accountId,
          currentLedgerConfirmed: true,
          kind: 'cash',
          currency: account.currency ?? 'USD',
          owned: true,
          holds: { minorUnits: '0', currency: account.currency ?? 'USD' },
        })),
      });
      await expect(
        fixture.service.propose(fixture.actor, {
          action: { ...action, accountName: 'Third wallet name' },
        }),
      ).rejects.toThrow(/invalid_or_existing_wallet/);
      expect((await fixture.service.execute(fixture.actor, original.proposed.id)).phase).toBe(
        'verified',
      );
      expect((await approveAndExecute(fixture)).result.phase).toBe('verified');
      const ledger = fixture.nativePlans.at(-1)!.currentLedger;
      expect(ledger.wallets).toEqual(
        kind === 'missing' ? [] : [{ walletId: action.walletId, accountId }],
      );
      if (kind === 'currency')
        expect(ledger.accounts.find((account) => account.accountId === accountId)?.currency).toBe(
          'EUR',
        );
      expect(fixture.writes.filter((write) => write.kind === 'wallet')).toHaveLength(1);
    },
  );

  it('reserves an explicitly verified wallet atom when a later composite atom fails', async () => {
    const wallet = {
      kind: 'wallet_materialization',
      walletId: 'wallet-one',
      accountName: 'Partial composite wallet',
      currency: 'USD',
    };
    const transfer = {
      kind: 'transfer',
      transferId: 'transfer-one',
      correlationId: 'partial-wallet-transfer',
      sourceAccountId: 'savings',
      destinationAccountId: 'checking',
      amount: money('1000'),
      date: '2026-09-06',
    };
    const created = await proposal(fixture, {
      action: { kind: 'composite', actions: [wallet, transfer] },
    });
    const approver = await fixture.addMember('partial-wallet-approver');
    for (const capability of ['wallet_materialization:approve', 'transfer:approve'])
      for (const [kind, id] of [
        ['budget', fixture.actor.budgetId],
        ['wallet', 'wallet-one'],
        ['transfer', 'transfer-one'],
        ['account', 'checking'],
        ['account', 'savings'],
      ] as const)
        fixture.grant(approver, kind, id, capability);
    await fixture.approve(created.id, approver);
    fixture.failBeforeDispatch = 'transfer';
    expect((await fixture.service.execute(fixture.actor, created.id)).phase).toBe(
      'review_required',
    );
    const stored = await fixture.store.getProposal(created.id);
    expect(stored?.state).toMatchObject({
      phase: 'review_required',
      effects: [
        {
          actionKind: 'wallet_materialization',
          result: {
            result: {
              success: true,
              verified: true,
              walletId: 'wallet-one',
              accountId: 'actual-generated-wallet-one',
            },
          },
        },
      ],
    });
    delete fixture.state.accounts['actual-generated-wallet-one'];
    await fixture.refreshObservations();
    await expect(
      fixture.service.propose(fixture.actor, {
        action: { ...wallet, accountName: 'Duplicate after partial composite' },
      }),
    ).rejects.toThrow(/invalid_or_existing_wallet/);
    fixture.failBeforeDispatch = null;
    expect((await fixture.service.execute(fixture.actor, created.id)).phase).toBe(
      'review_required',
    );
    expect((await proposal(fixture)).payload.plan.action.kind).toBe('reallocation');
    expect(fixture.writes.filter((write) => write.kind === 'wallet')).toHaveLength(1);
  });

  it('records a transfer as a verified ledger pair, never as institution settlement', async () => {
    const intent: { action: TransferIntent } = {
      action: {
        kind: 'transfer',
        transferId: 'transfer-one',
        correlationId: 'transfer-correlation-one',
        sourceAccountId: 'savings',
        destinationAccountId: 'checking',
        amount: money('1000'),
        date: '2026-09-06',
      },
    };
    const result = await approveAndExecute(fixture, intent);
    for (const capability of ['conclusion', 'observe', 'source', 'full-read'] as const)
      fixture.grant(result.approver, 'budget', fixture.actor.budgetId, capability);
    for (const id of ['savings', 'checking'])
      for (const capability of [
        'existence',
        'history',
        'name',
        'source',
        'balance',
        'full-read',
      ] as const)
        fixture.grant(result.approver, 'account', id, capability);
    fixture.grant(result.approver, 'transfer', 'transfer-one', 'full-read');
    await grantProposalDetail(fixture, result.approver, result.proposed.id);
    const approvalDetail = await fixture.service.getProposal(result.approver, result.proposed.id);
    expect(approvalDetail?.payload.plan.expectedPostconditions).toContainEqual(
      expect.objectContaining({
        kind: 'transfer_ledger_entry',
        transferId: 'transfer-one',
      }),
    );
    const executor = await fixture.addMember('transfer-detail-executor');
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['account', 'savings'],
      ['account', 'checking'],
      ['transfer', 'transfer-one'],
    ] as const)
      fixture.grant(executor, kind, id, 'transfer:execute');
    for (const capability of ['conclusion', 'observe', 'source', 'full-read'] as const)
      fixture.grant(executor, 'budget', fixture.actor.budgetId, capability);
    for (const id of ['savings', 'checking'])
      for (const capability of [
        'existence',
        'history',
        'name',
        'source',
        'balance',
        'full-read',
      ] as const)
        fixture.grant(executor, 'account', id, capability);
    fixture.grant(executor, 'transfer', 'transfer-one', 'full-read');
    await grantProposalDetail(fixture, executor, result.proposed.id);
    const executionDetail = await fixture.service.getProposal(executor, result.proposed.id);
    expect(executionDetail?.payload.plan.expectedPostconditions).toContainEqual(
      expect.objectContaining({
        kind: 'transfer_ledger_entry',
        transferId: 'transfer-one',
      }),
    );
    expect(result.result).toMatchObject({ phase: 'verified' });
    expect(fixture.writes).toContainEqual(
      expect.objectContaining({
        kind: 'transfer',
        transferId: 'transfer-one',
        sourceId: 'actual-transfer-source-transfer-one',
        destinationId: 'actual-transfer-destination-transfer-one',
      }),
    );
    expect(
      fixture.state.transactions.filter((row) =>
        row.notes?.includes('balanceframe:transfer:transfer-one:transfer-correlation-one'),
      ),
    ).toHaveLength(2);
    expect(result.result).not.toHaveProperty('settlement');
    await expect(fixture.service.propose(fixture.actor, intent)).rejects.toThrow();
  });

  it('rejects an unlinked opposite transfer pair and holds the uncertain transfer without retry', async () => {
    fixture.failTransferLink = true;
    const intent: { action: TransferIntent } = {
      action: {
        kind: 'transfer',
        transferId: 'transfer-one',
        correlationId: 'transfer-correlation-one',
        sourceAccountId: 'savings',
        destinationAccountId: 'checking',
        amount: money('1000'),
        date: '2026-09-06',
      },
    };
    const created = await proposal(fixture, intent);
    const approver = await fixture.addMember(`transfer-${created.id}`);
    fixture.grant(approver, 'budget', fixture.actor.budgetId, 'transfer:approve');
    fixture.grant(approver, 'account', 'savings', 'transfer:approve');
    fixture.grant(approver, 'account', 'checking', 'transfer:approve');
    fixture.grant(approver, 'transfer', 'transfer-one', 'transfer:approve');
    await fixture.approve(created.id, approver);
    const first = await fixture.service.execute(fixture.actor, created.id);
    expect(first).toMatchObject({ phase: 'review_required' });
    expect(fixture.state.transactions.filter((row) => row.transferAccountId === null)).toHaveLength(
      2,
    );
    await fixture.service.execute(fixture.actor, created.id);
    expect(fixture.writes.filter((write) => write.kind === 'transfer')).toHaveLength(1);
  });

  it('revalidates changed source evidence and current funding before any write', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`stale-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    fixture.state.assignments.reserve = 1000;
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);

    fixture.state.assignments.reserve = 6000;
    fixture.state.evidenceObservedAt = '2026-09-06T09:59:00.000Z';
    const fresh = await proposal(fixture);
    const freshApprover = await fixture.addMember(`evidence-stale-${fresh.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(freshApprover, kind, id, 'reallocation:approve');
    await fixture.approve(fresh.id, freshApprover);
    fixture.state.evidenceObservedAt = '2026-09-06T09:50:00.000Z';
    await expect(fixture.service.execute(fixture.actor, fresh.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });
  it('invalidates an approved action when the trusted evidence expiry changes before dispatch', async () => {
    const created = await proposal(fixture);
    const approver = await fixture.addMember(`evidence-expiry-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    await fixture.refreshObservations('2026-09-06T10:16:00.000Z');
    await expect(fixture.service.execute(fixture.actor, created.id)).rejects.toThrow();
    expect(fixture.writes).toEqual([]);
  });

  it('does not let two distinct donor actions dispatch to the same recipient from one stale baseline', async () => {
    const first = await proposal(fixture, reallocationIntent());
    const secondIntent = reallocationIntent({
      action: {
        kind: 'reallocation',
        assignments: [
          {
            sourceCategoryId: 'reserve-two',
            sourceAsOfMonth: '2026-09',
            destinationCategoryId: 'food',
            destinationAsOfMonth: '2026-09',
            amount: money('2000'),
          },
        ],
      },
    });
    await expect(fixture.service.propose(fixture.actor, secondIntent)).rejects.toThrow();
    expect(await fixture.store.getProposal(first.id)).toMatchObject({
      state: { phase: 'proposed' },
    });
    expect(fixture.writes).toEqual([]);
  });

  it('durably records partial composite effects, holds its budget, and never retries after lease reconciliation', async () => {
    fixture.failManualAfterWrite = true;
    const composite = {
      action: structuredClone(actionFixture.compositeIntent),
      decision: {
        accountId: 'checking',
        items: [
          {
            id: 'purchase-food',
            categoryId: 'food',
            accountId: 'checking',
            amount: money('2000'),
            purchaseAt: now,
            requiredBy: now,
          },
        ],
      },
    };
    const created = await proposal(fixture, composite);
    const approver = await fixture.addMember(`partial-${created.id}`);
    for (const [kind, id, capability] of [
      ['budget', fixture.actor.budgetId, 'reallocation:approve'],
      ['category', 'reserve', 'reallocation:approve'],
      ['category', 'food', 'reallocation:approve'],
      ['budget', fixture.actor.budgetId, 'transaction:approve'],
      ['category', 'food', 'transaction:approve'],
      ['account', 'checking', 'transaction:approve'],
      ['transaction', 'manual-parent-composite-1', 'transaction:approve'],
      ['ledger_effect', 'manual-parent-composite-1', 'transaction:approve'],
    ] as const)
      fixture.grant(approver, kind, id, capability);

    const walletIntent = {
      action: {
        kind: 'wallet_materialization' as const,
        walletId: 'wallet-two',
        accountName: 'Second wallet',
        currency: 'USD',
      },
    };
    fixture.grant(fixture.actor, 'wallet', 'wallet-two', 'wallet_materialization:propose');
    fixture.grant(fixture.actor, 'wallet', 'wallet-two', 'wallet_materialization:execute');
    for (const capability of ['existence', 'history', 'name', 'full-read'] as const)
      fixture.grant(fixture.actor, 'wallet', 'wallet-two', capability);
    const walletProposal = await proposal(fixture, walletIntent);
    fixture.grant(approver, 'budget', fixture.actor.budgetId, 'wallet_materialization:approve');
    fixture.grant(approver, 'wallet', 'wallet-two', 'wallet_materialization:approve');
    await fixture.approve(created.id, approver);
    await fixture.approve(walletProposal.id, approver);

    const result = await fixture.service.execute(fixture.actor, created.id);
    expect(result).toMatchObject({ phase: 'review_required' });
    expect(fixture.writes.map((write) => write.kind)).toEqual([
      'assignment',
      'assignment',
      'manual',
    ]);
    const stored = await fixture.store.getProposal(created.id);
    expect(stored?.state).toMatchObject({ phase: 'review_required' });
    const state = stored?.state as
      | {
          readonly effects?: readonly {
            readonly atomIndex: number;
            readonly actionKind: string;
            readonly stableIdentity: unknown;
            readonly result: unknown;
          }[];
        }
      | undefined;
    expect(state?.effects).toEqual([
      expect.objectContaining({
        atomIndex: 0,
        actionKind: 'reallocation',
        stableIdentity: { assignments: actionFixture.intent.assignments },
        result: expect.any(Object),
      }),
      expect.objectContaining({
        atomIndex: 1,
        actionKind: 'manual_transaction',
        stableIdentity: { parentId: 'manual-parent-composite-1' },
        result: expect.any(Object),
      }),
    ]);
    await expect(fixture.service.execute(fixture.actor, walletProposal.id)).rejects.toThrow();
    expect(fixture.writes.filter((write) => write.kind === 'wallet')).toEqual([]);

    const writesAfterAmbiguousAction = [...fixture.writes];
    await fixture.service.execute(fixture.actor, created.id);
    expect(fixture.writes).toEqual(writesAfterAmbiguousAction);
    await fixture.store.reconcileStrandedIdempotencyRecords();
    await expect(fixture.service.execute(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'review_required',
    });
    expect(fixture.writes).toEqual(writesAfterAmbiguousAction);
    fixture.setClock('2026-09-07T10:00:00.000Z');
    await expect(fixture.service.reconcile(fixture.actor, created.id)).resolves.toMatchObject({
      phase: 'review_required',
    });
    expect(fixture.writes).toEqual(writesAfterAmbiguousAction);
  });

  it('refuses reconciliation of proposed and approved actions without acquiring or dispatching', async () => {
    const created = await proposal(fixture, reallocationIntent());
    const acquire = vi.spyOn(fixture.store, 'acquireProposalExecution');
    await expect(fixture.service.reconcile(fixture.actor, created.id)).rejects.toThrow(
      /reconciliation/i,
    );
    const approver = await fixture.addMember(`reconcile-${created.id}`);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);
    await expect(fixture.service.reconcile(fixture.actor, created.id)).rejects.toThrow(
      /reconciliation/i,
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
    expect(await fixture.store.getProposal(created.id)).toMatchObject({
      state: { phase: 'approved' },
    });
  });

  it('refuses reconciliation without current action-read authority or the selected budget', async () => {
    const { proposed } = await approveAndExecute(fixture);
    const outsider = await fixture.addMember('reconcile-outsider');
    await expect(fixture.service.reconcile(outsider, proposed.id)).rejects.toThrow(
      /read authority/i,
    );
    await expect(
      fixture.service.reconcile({ ...fixture.actor, budgetId: 'other-budget' }, proposed.id),
    ).rejects.toThrow(/unavailable/i);
    await expect(fixture.service.reconcile(fixture.actor, 'missing-proposal')).rejects.toThrow(
      /unavailable/i,
    );
    expect(fixture.writes).toHaveLength(2);
  });

  it('recovers only by readback after proposal expiry and cannot redispatch an expired action', async () => {
    let interruptPostcondition = true;
    const verificationRequests: Array<{
      phase?: string;
      evaluatedAt: string;
      decisionCardRequest: { context: { evaluatedAt: string }; validUntil: string };
    }> = [];
    const native: ConsequentialActionNative = {
      planConsequentialAction: (input) => nativeModule.planConsequentialAction(input),
      verifyConsequentialAction: (input) => {
        const request = JSON.parse(input) as (typeof verificationRequests)[number];
        verificationRequests.push(request);
        if (request.phase === 'postconditions' && interruptPostcondition) {
          interruptPostcondition = false;
          throw new Error('Simulated interruption before verification finalization');
        }
        return nativeModule.verifyConsequentialAction(input);
      },
    };
    fixture.service = new ConsequentialActionService({
      liquidity: fixture.liquidity,
      store: fixture.store,
      native,
      clock: () => new Date(fixture.clockNow),
    });
    const base = reallocationIntent();
    const intent = {
      ...base,
      decision: { ...base.decision, expiresAt: '2026-09-06T10:05:00.000Z' },
    };
    const created = await proposal(fixture, intent);
    const approver = await fixture.addMember(`expired-recovery-${created.id}`);
    expect(created.decisionContext?.items).toMatchObject([{ purchaseAt: now, requiredBy: now }]);
    for (const [kind, id] of [
      ['budget', fixture.actor.budgetId],
      ['category', 'reserve'],
      ['category', 'food'],
    ] as const)
      fixture.grant(approver, kind, id, 'reallocation:approve');
    await fixture.approve(created.id, approver);

    expect(await fixture.service.execute(fixture.actor, created.id)).toMatchObject({
      phase: 'review_required',
    });
    const writesBeforeRecovery = [...fixture.writes];
    expect(await fixture.service.reconcile(fixture.actor, created.id)).toMatchObject({
      phase: 'review_required',
    });
    fixture.setClock('2026-09-06T10:05:00.000Z');
    expect(await fixture.service.reconcile(fixture.actor, created.id)).toMatchObject({
      phase: 'review_required',
    });
    fixture.setClock('2026-09-06T10:06:00.000Z');
    expect(await fixture.service.reconcile(approver, created.id)).toMatchObject({
      phase: 'review_required',
    });
    fixture.state.assignments.food! -= 1;
    expect(await fixture.service.reconcile(fixture.actor, created.id)).toMatchObject({
      phase: 'review_required',
    });
    expect(fixture.writes).toEqual(writesBeforeRecovery);
    fixture.state.assignments.food! += 1;
    expect(await fixture.service.reconcile(fixture.actor, created.id)).toMatchObject({
      phase: 'verified',
    });
    expect(await fixture.service.reconcile(fixture.actor, created.id)).toMatchObject({
      phase: 'verified',
    });
    expect(await fixture.service.execute(fixture.actor, created.id)).toMatchObject({
      phase: 'verified',
    });
    expect(verificationRequests.at(-1)).toMatchObject({
      phase: 'postconditions',
      evaluatedAt: fixture.clockNow,
      decisionCardRequest: {
        context: { evaluatedAt: created.createdAt },
        validUntil: created.expiresAt,
      },
    });
    expect(fixture.writes).toEqual(writesBeforeRecovery);
    expect(fixture.writes).toHaveLength(2);
  });
  it('executes an explicitly reviewed evidence credit through approval and the existing execution fence', async () => {
    const event = fixture.state.resolution!;
    event.ledgerEffect = { ...event.ledgerEffect, amount: money('500') };
    const action = {
      kind: 'evidence_credit',
      transaction: { ...manualIntent('evidence-credit').action.transaction, amount: money('500') },
      evidenceIds: [event.evidenceId],
    };
    const result = await approveAndExecute(fixture, { action });
    expect(
      result.result,
      JSON.stringify((await fixture.store.getProposal(result.proposed.id))?.state),
    ).toMatchObject({ phase: 'verified' });
    expect(fixture.writes).toContainEqual({
      kind: 'manual',
      parentId: 'evidence-credit',
      amount: 500,
      splits: 0,
    });
    await fixture.service.execute(fixture.actor, result.proposed.id);
    expect(fixture.writes.filter((write) => write.kind === 'manual')).toHaveLength(1);
    await expect(
      fixture.service.propose(fixture.actor, {
        action: { ...action, transaction: { ...action.transaction, amount: money('501') } },
      }),
    ).rejects.toThrow(/source|effect/);
  });

  it.each(['category', 'splits', 'recovery'] as const)(
    'pins and amends a reviewed existing imported settlement with %s without creating another debit',
    async (kind) => {
      const original = {
        ...manualRow({
          parentId: 'settlement',
          correlationId: 'existing',
          accountId: 'checking',
          amount: -500,
          date: '2026-09-06',
          categoryId: 'food',
          payeeName: 'Local shop',
          notes: 'manual note',
        }),
        importedId: 'bank-import',
        cleared: true,
      };
      fixture.state.transactions = [original];
      fixture.state.transactionCoverage = 'complete';
      fixture.state.spent.food = -500;
      fixture.state.payees = [
        { id: 'manual-payee-Local shop', name: 'Local shop', transferAccountId: null, mtid: null },
      ];
      await fixture.refreshObservations('2026-09-07T00:00:00.000Z');
      fixture.state.resolution!.subjectId = 'settlement';
      const classification =
        kind === 'splits'
          ? {
              categoryId: null,
              splits: [
                { categoryId: 'food', amount: money('-300') },
                { categoryId: 'reserve', amount: money('-200') },
              ],
            }
          : { categoryId: 'reserve', splits: [] };
      fixture.state.resolution!.ledgerEffect = {
        ...fixture.state.resolution!.ledgerEffect,
        ...classification,
      };
      const expected = {
        parentId: original.id,
        accountId: original.accountId,
        date: original.date,
        amount: original.amount,
        categoryId: original.categoryId,
        payeeName: original.payeeName,
        notes: original.notes,
        splits: [],
        transferAccountId: null,
      };
      const action = {
        kind: 'evidence_amendment',
        expected,
        expectedSource: original,
        transaction: { ...manualIntent('settlement').action.transaction, ...classification },
        evidenceIds: [fixture.state.resolution!.evidenceId],
      };
      await expect(
        fixture.service.propose(fixture.actor, {
          action: { ...action, expectedSource: { ...original, notes: 'forged' } },
        }),
      ).rejects.toThrow(/source settlement changed/);
      fixture.beforeAmendmentCapture = async () => {
        fixture.state.transactions[0] = { ...original, notes: 'changed during capture' };
      };
      await expect(fixture.service.propose(fixture.actor, { action })).rejects.toThrow(
        /source changed during capture/,
      );
      fixture.state.transactions = [original];
      fixture.beforeAmendmentCapture = async () => {
        fixture.grant(fixture.actor, 'transaction', 'settlement', 'source', false);
      };
      await expect(fixture.service.propose(fixture.actor, { action })).rejects.toThrow(
        /authorization|grant/i,
      );
      fixture.beforeAmendmentCapture = null;
      fixture.grant(fixture.actor, 'transaction', 'settlement', 'source', true);
      let outcome = await approveAndExecute(fixture, { action }, () => {
        fixture.amendmentProofValid = kind !== 'recovery';
      });
      if (kind === 'recovery') {
        expect(outcome.result.phase).toBe('review_required');
        fixture.setClock('2026-09-06T10:16:00.000Z');
        expect((await fixture.service.execute(fixture.actor, outcome.proposed.id)).phase).toBe(
          'review_required',
        );
        fixture.amendmentProofValid = true;
        outcome = {
          ...outcome,
          result: await fixture.service.execute(fixture.actor, outcome.proposed.id),
        };
      }
      expect(fixture.amendmentWrites).toBe(1);
      expect(
        outcome.result,
        JSON.stringify((await fixture.store.getProposal(outcome.proposed.id))?.state),
      ).toMatchObject({ phase: 'verified' });
      expect(fixture.state.transactions).toHaveLength(1);
      expect(fixture.state.transactions[0]).toMatchObject({
        id: 'settlement',
        importedId: 'bank-import',
        cleared: true,
        categoryId: classification.categoryId,
        notes: 'manual note',
      });
      expect(fixture.state.accounts.checking!.balance).toBe(13000);
    },
  );

  it('selects separate economic subjects from one evidence document and refuses an ambiguous legacy selector', async () => {
    const first = fixture.state.resolution!;
    first.ledgerEffect = { ...first.ledgerEffect, amount: money('500') };
    const second = {
      ...first,
      subjectId: 'bank-event-second',
      contentHash: 'sha256:second-event-content',
      ledgerEffect: { ...first.ledgerEffect, amount: money('700') },
    };
    fixture.state.additionalResolutions = [second];
    for (const capability of [...financialCapabilities, 'normalized-evidence'])
      fixture.grant(fixture.actor, 'evidence', second.subjectId, capability);
    const credit = (event: EconomicEventResolution, parentId: string) => ({
      kind: 'evidence_credit' as const,
      resolutionSubjectId: event.subjectId,
      evidenceIds: [event.evidenceId],
      transaction: {
        ...manualIntent(parentId).action.transaction,
        amount: event.ledgerEffect.amount,
      },
    });
    const ambiguous = credit(first, 'evidence-credit');
    const { resolutionSubjectId: _subject, ...legacy } = ambiguous;
    await expect(fixture.service.propose(fixture.actor, { action: legacy })).rejects.toThrow(
      /economic-event|source|one exact/,
    );
    const result = await approveAndExecute(fixture, {
      action: { kind: 'composite', actions: [ambiguous, credit(second, 'evidence-credit-two')] },
    });
    expect(
      result.result,
      JSON.stringify((await fixture.store.getProposal(result.proposed.id))?.state),
    ).toMatchObject({ phase: 'verified' });
    expect(fixture.writes.filter((write) => write.kind === 'manual')).toHaveLength(2);
  });
});
