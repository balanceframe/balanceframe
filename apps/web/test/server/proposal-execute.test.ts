import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  SqliteWorkflowStore,
  canonicalProposalHash,
} from '@balanceframe/workflow-store';
import type {
  GenericActionProposal,
  GenericProposalOperation,
  ReviewItem,
  ResourceGrantRestrictions,
} from '@balanceframe/workflow-store';
import type {
  AutomationRule,
  ActualMerchantSourceCapture,
  BudgetLedger,
  LedgerSnapshotResult,
  RuleDeletePrecondition,
  RuleProposal,
  RuleCreatePrecondition,
} from '@balanceframe/actual-adapter';
import {
  createNativeCategorizationMutationProtocol, createNativeRuleMutationProtocol,
  createMerchantIntelligenceService,
} from '@balanceframe/application';
import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import type { ConnectionConfig, ConnectionManager } from '@balanceframe/application';
import type { RuleProposalInput } from '../../../../packages/application/src/rule-mutation';
import type { ConnectedBudget } from '../../../../packages/application/src/connection-manager';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import type * as MutationExecutor from '../../server/utils/mutation-executor';
import { canonicalProtocolSnapshotSchema, merchantAnalysisRequestSchema } from '@balanceframe/protocol-generated/validators';
import type { ApiEnvelope, EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore, setReviewMutationExecutorFactory } from '../../server/utils/workflow-store';
import type { HumanControlAuth, ReauthenticationEvent } from '../../server/utils/reauthentication';
import {
  getHumanControlAuth,
  issueReauthentication,
  REAUTH_COOKIE_NAME,
} from '../../server/utils/reauthentication';
import { buildCategorizationProposalIntent } from '../../server/utils/categorization-proposal';
import correctReview from '../../server/api/review/correct.post';
import { createRuleProposal } from '../../server/utils/rule-create';
import fixture from '../../../../protocol/fixtures/representative.json';
import merchantFixture from '../../../../protocol/fixtures/merchant-intelligence.json';
import { completeNativeRuleSourceAvailability, grantNativeRuleSources, nativeRuleSource } from './native-rule-source.fixture';

interface TestConnection {
  config: { budgetId: string; serverUrl: string };
  budget: { id: string };
  connector: BudgetLedger;
  synchronization: {
    snapshot: ProtocolSnapshot;
    rulePlanningSourceAvailability?:LedgerSnapshotResult['rulePlanningSourceAvailability'];
    financialSnapshot: {
      legacySnapshot: {
        accounts: unknown[];
        categories: unknown[];
        transactions: unknown[];
      };
    };
  };
}
type TestConnectionManager = {
  loadConfig(): Promise<ConnectionConfig | null>;
  withConnection<T>(
    operation: (connected: TestConnection) => Promise<T>,
    options?: { dispose?: boolean },
  ): Promise<T>;
};

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  producerLoadConfig: vi.fn<TestConnectionManager['loadConfig']>(),
  producerWithConnection: vi.fn<TestConnectionManager['withConnection']>(),
  mutationLoadConfig: vi.fn<TestConnectionManager['loadConfig']>(),
  mutationWithConnection: vi.fn<TestConnectionManager['withConnection']>(),
}));

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
vi.mock('@balanceframe/application', async () => {
  const actual = await import('../../../../packages/application/src/index');
  return {
    ...actual,
    createDefaultConnectionManager: () => ({
      loadConfig: mocks.producerLoadConfig,
      withConnection: mocks.producerWithConnection,
    }),
  };
});
vi.mock('../../server/utils/mutation-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof MutationExecutor>();
  return {
    ...actual,
    createMutationConnectionManager: () => ({
      loadConfig: mocks.mutationLoadConfig,
      withConnection: mocks.mutationWithConnection,
    }),
  };
});

import proposeRule from '../../server/api/review/propose-rule.post';
import executeProposal from '../../server/api/proposal/[id]/execute.post';

const OWNER_ID = 'proposal-execute-owner';
const PROPOSER_ID = 'proposal-execute-proposer';
const APPROVER_PREFIX = 'proposal-execute-approver';
let approverId = '';
let approverSessionId = '';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-08-01T12:00:00.000Z';
const EXPIRES_AT = '2026-08-02T12:00:00.000Z';
const RULE_ID = 'proposal-execute-current-rule';
const CREATED_RULE_ID = 'proposal-execute-created-rule';
const transaction = fixture.transactions[0]!;
const currentCategoryId = transaction.categoryId!;
const categoryId = fixture.transactions[1]!.categoryId!;
const composite = {
  operations: [],
  reallocations: [],
  transferRecommendations: [],
  ledgerProjections: [],
  evidenceReferences: [],
};
const actualRule: AutomationRule = {
  id: RULE_ID,
  name: 'Current Actual rule',
  order: 3,
  trigger: [{ field: 'account', op: 'is', value: transaction.accountId }],
  actions: [{ op: 'set', field: 'category', value: currentCategoryId }],
  inactive: false,
  stage: 'pre',
  conditionsOp: 'and',
};
const ruleSnapshot = {
  id: actualRule.id,
  name: actualRule.name,
  order: actualRule.order,
  trigger: actualRule.trigger,
  actions: actualRule.actions,
  inactive: actualRule.inactive,
  stage: actualRule.stage,
  conditionsOp: actualRule.conditionsOp,
};
const baseSnapshot: ProtocolSnapshot = canonicalProtocolSnapshotSchema.parse({
  ...fixture,
  snapshotDate: NOW,
});

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & EventWithContext & { body: unknown };

let store: SqliteWorkflowStore;
let bootstrapped = false;
let sequence = 0;
let spaceId = '';
let budgetId = '';
let proposerMembershipId = '';
let actorMembershipId = '';
let connection: TestConnection;
let protocolSnapshot: ProtocolSnapshot;
let actualRules: AutomationRule[];
let ledger: BudgetLedger;

function event(
  body: unknown = {},
  id = '',
  requestActor = approverId,
  proofCookie?: string,
): RequestEvent {
  const responseHeaders = new Map<string, string | string[]>();
  const response: TestResponse = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return responseHeaders.get(name.toLowerCase());
    },
    removeHeader(name) {
      responseHeaders.delete(name.toLowerCase());
    },
  };
  return {
    body,
    node: {
      req: {
        headers: {
          origin: ORIGIN,
          'x-balanceframe-space': spaceId,
          cookie: [
            'better-auth.session_token=authoritative-session-cookie',
            ...(proofCookie ? [`${REAUTH_COOKIE_NAME}=${proofCookie}`] : []),
          ].join('; '),
        },
      },
      res: response,
    },
    context: {
      params: { id },
      auth: {
        authenticated: true,
        user: { id: requestActor },
        actorId: requestActor,
        method: 'session',
        principalType: 'human',
        sessionId: `session:${requestActor}`,
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false, reviewAndApply: true },
    },
  } as unknown as RequestEvent;
}

function grant(
  granteeId: string,
  membershipId: string,
  capability: string,
  resourceKind: 'budget' | 'account' | 'category' | 'rule' | 'transaction',
  resourceId: string,
  restrictions?: ResourceGrantRestrictions,
) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: granteeId,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    restrictions,
    granted: true,
    now: NOW,
  });
}

function operationResources(operation: GenericProposalOperation) {
  if (operation === 'set_category')
    return [
      ['transaction', transaction.id],
      ['account', transaction.accountId],
      ['category', currentCategoryId],
      ['category', categoryId],
    ] as const;
  if (operation === 'create_rule')
    return [
      ['transaction', transaction.id],
      ['category', currentCategoryId],
      ['account', transaction.accountId],
      ['category', categoryId],
    ] as const;
  return [
    ['rule', RULE_ID],
    ['account', transaction.accountId],
    ['category', currentCategoryId],
    ['category', categoryId],
  ] as const;
}

function grantProposer(operation: GenericProposalOperation) {
  const capability = operation === 'set_category' ? 'categorization:propose' : 'rule:propose';
  grant(PROPOSER_ID, proposerMembershipId, capability, 'budget', budgetId);
  for (const [kind, id] of operationResources(operation))
    grant(PROPOSER_ID, proposerMembershipId, capability, kind, id);
  for (const grantCapability of ['existence', 'history', 'name'])
    grant(PROPOSER_ID, proposerMembershipId, grantCapability, 'account', transaction.accountId);
  for (const id of new Set([currentCategoryId, categoryId])) {
    grant(PROPOSER_ID, proposerMembershipId, 'existence', 'category', id);
    grant(PROPOSER_ID, proposerMembershipId, 'name', 'category', id);
  }
  grant(PROPOSER_ID, proposerMembershipId, 'observe', 'budget', budgetId);
  grant(PROPOSER_ID, proposerMembershipId, 'full-read', 'budget', budgetId);
  if (operation === 'create_rule') {
    grantNativeRuleSources(store,{ spaceId,budgetId,actorId:PROPOSER_ID,membershipId:proposerMembershipId,now:NOW },protocolSnapshot);
    for (const a of protocolSnapshot.accounts) grant(PROPOSER_ID,proposerMembershipId,'rule:propose','account',a.id);
    for (const c of protocolSnapshot.categories) grant(PROPOSER_ID,proposerMembershipId,'rule:propose','category',c.id);
    const visit = (rows: ProtocolSnapshot['transactions']) => {
      for (const t of rows) { grant(PROPOSER_ID,proposerMembershipId,'rule:propose','transaction',t.id); visit(t.subtransactions); }
    };
    visit(protocolSnapshot.transactions);
    for (const r of protocolSnapshot.rules) grant(PROPOSER_ID,proposerMembershipId,'rule:propose','rule',r.id);
  }
}

function grantOperator(
  operation: GenericProposalOperation,
  actor = approverId,
  membershipId = actorMembershipId,
) {
  const family = operation === 'set_category' ? 'categorization' : 'rule';
  const approvalCapability = `${family}:approve`;
  const executionCapability = `${family}:execute`;
  grant(actor, membershipId, approvalCapability, 'budget', budgetId);
  grant(actor, membershipId, executionCapability, 'budget', budgetId);
  for (const [kind, id] of operationResources(operation)) {
    grant(actor, membershipId, approvalCapability, kind, id);
    grant(actor, membershipId, executionCapability, kind, id);
  }
  if (operation === 'create_rule') {
    grantNativeRuleSources(store,{ spaceId,budgetId,actorId:actor,membershipId,now:NOW },protocolSnapshot);
    for (const [kind, ids] of [
      ['account',protocolSnapshot.accounts.map((a) => a.id)],['category',protocolSnapshot.categories.map((c) => c.id)],
      ['transaction',protocolSnapshot.transactions.map((t) => t.id)],['rule',protocolSnapshot.rules.map((r) => r.id)],
    ] as const) for (const id of ids) {
      grant(actor,membershipId,approvalCapability,kind,id);
      grant(actor,membershipId,executionCapability,kind,id);
    }
    const visit = (rows: ProtocolSnapshot['transactions']) => {
      for (const t of rows) {
        grant(actor,membershipId,approvalCapability,'transaction',t.id);
        grant(actor,membershipId,executionCapability,'transaction',t.id);
        visit(t.subtransactions);
      }
    };
    visit(protocolSnapshot.transactions);
  }
}

async function configureTwoApprovers() {
  const policy = store.governance.getPolicy({ spaceId });
  if (!policy) throw new Error('Test space has no approval policy');
  store.governance.setPolicy({
    spaceId,
    expectedVersion: policy.version,
    policy: { minimumApprovers: 2, approvalThresholds: [] },
    now: NOW,
    auth: {
      method: 'human-session',
      actorId: OWNER_ID,
      sessionId: `session:${OWNER_ID}`,
      reauthenticatedAt: NOW,
    },
  });

  const actorId = `${APPROVER_PREFIX}-second-${sequence}`;
  const sessionId = `session:${actorId}`;
  await store.upsertActorMembership(actorId, 'active', [], '');
  const membership = store.governance.addMembership({
    spaceId,
    actorId,
    validFrom: NOW,
    now: NOW,
    auth: {
      method: 'human-session',
      actorId: OWNER_ID,
      sessionId: `session:${OWNER_ID}`,
      reauthenticatedAt: NOW,
    },
  });
  return { actorId, sessionId, membershipId: membership.id };
}


function createLedger(): BudgetLedger {
  const snapshotResult = () => ({ snapshot: protocolSnapshot }) as unknown as LedgerSnapshotResult;
  const fakeLedger = {
    ...nativeRuleSource(() => protocolSnapshot),
    synchronize: vi.fn(async () => ({
      ...snapshotResult(),financialSnapshot:{legacySnapshot:protocolSnapshot},
      rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(protocolSnapshot),
    })),
    listRules: vi.fn(async () => actualRules),
    getRuleCategoryGroupMembers: vi.fn(async () => ({})),
    createRule: vi.fn(async (proposal: RuleProposal, precondition: RuleCreatePrecondition) => {
      precondition.assertExecutionCurrent();
      const condition = proposal.conditions[0] as { field: string; op: string; value: string };
      const action = proposal.actions[0] as { op: string; field: string; value: string };
      const nativeRule: AutomationRule = {
        id: CREATED_RULE_ID,
        name: '',
        order: actualRules.length,
        trigger: [condition],
        actions: [{ op: 'set', field: 'category', value: action.value }],
        inactive: false,
        stage: proposal.stage ?? 'post',
        conditionsOp: proposal.conditionsOp ?? 'and',
      };
      actualRules = [...actualRules, nativeRule];
      const protocolRule = {
        id: CREATED_RULE_ID,
        name: '',
        order: nativeRule.order,
        trigger: {
          stage: proposal.stage ?? 'post',
          conditionsOp: proposal.conditionsOp ?? 'and',
          conditions: [condition],
        },
        actions: [{ op: 'set', field: 'category', value: action.value }],
        inactive: false,
      } as (typeof protocolSnapshot.rules)[number];
      protocolSnapshot = {
        ...protocolSnapshot,
        rules: [...protocolSnapshot.rules, protocolRule],
      };
      return { success: true as const, id: CREATED_RULE_ID };
    }),
    deleteRule: vi.fn(async (ruleId: string, precondition: RuleDeletePrecondition) => {
      if (ruleId !== precondition.rule.id || precondition.actualVersion !== protocolSnapshot.actualVersion)
        throw new Error('The test ledger rejected a mismatched Actual rule precondition');
      precondition.assertExecutionCurrent();
      actualRules = actualRules.filter((rule) => rule.id !== ruleId);
      protocolSnapshot = {
        ...protocolSnapshot,
        rules: protocolSnapshot.rules.filter((rule) => rule.id !== ruleId),
      };
    }),
    setTransactionCategory: vi.fn(async (
      transactionId: string,
      newCategoryId: string,
      previousCategoryId: string | null,
    ) => {
      const categoryName = protocolSnapshot.categories.find(({ id }) => id === newCategoryId)?.name ?? null;
      protocolSnapshot = {
        ...protocolSnapshot,
        transactions: protocolSnapshot.transactions.map((row) => row.id === transactionId
          ? { ...row, categoryId: newCategoryId, categoryName }
          : row),
      };
      return {
        success: true as const,
        transactionId,
        previousCategoryId,
        newCategoryId,
        idempotencyKey: 'verified-route-fixture-write',
        verified: true as const,
      };
    }),
  };
  return fakeLedger as unknown as BudgetLedger;
}

function setLifecycleRule() {
  actualRules = [actualRule];
  const protocolRule = {
    id: actualRule.id,
    name: actualRule.name,
    order: actualRule.order,
    trigger: {
      stage: actualRule.stage,
      conditionsOp: actualRule.conditionsOp,
      conditions: actualRule.trigger,
    },
    actions: actualRule.actions,
    inactive: actualRule.inactive,
  } as (typeof protocolSnapshot.rules)[number];
  protocolSnapshot = { ...protocolSnapshot, rules: [protocolRule] };
}

async function proposalInput(operation: GenericProposalOperation): Promise<{
  payload: GenericActionProposal['payload'];
  preconditions: Record<string, unknown>;
}> {
  switch (operation) {
    case 'set_category': {
      const protocol = await createNativeCategorizationMutationProtocol();
      if (!protocol) throw new Error('Native categorization planning is unavailable');
      const currentTransaction = protocolSnapshot.transactions.find((row) => row.id === transaction.id);
      const category = protocolSnapshot.categories.find((row) => row.id === categoryId);
      if (!currentTransaction || !category) throw new Error('Canonical fixture resources are missing');
      return buildCategorizationProposalIntent({
        protocol,
        snapshot: protocolSnapshot,
        transaction: currentTransaction,
        category,
      });
    }
    case 'create_rule':
      return {
        payload: {
          kind: 'create_rule',
          transactionId: null,
          categoryId,
          composite,
          rule: {
            stage: 'post', conditionsOp: 'and',
            conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
            actions: [{ op: 'set', field: 'category', value: categoryId }],
          },
        },
        preconditions: { ruleName: `Auto-rule for ${transaction.payeeName}`, actualVersion: fixture.actualVersion },
      };
    case 'update_rule':
      return {
        payload: { kind: 'update_rule', ruleId: RULE_ID, inactive: true, composite },
        preconditions: {
          rule: ruleSnapshot,
          override: null,
          actualVersion: fixture.actualVersion,
          categoryGroupMembers: {},
        },
      };
    case 'delete_rule':
      return {
        payload: { kind: 'delete_rule', ruleId: RULE_ID, composite },
        preconditions: {
          rule: ruleSnapshot,
          override: null,
          actualVersion: fixture.actualVersion,
          categoryGroupMembers: {},
        },
      };
  }
}

async function pendingReview(reviewTransactionId = transaction.id, recommendedCategoryId = currentCategoryId) {
  const source = fixture.transactions.find(({ id }) => id === reviewTransactionId);
  const signedAmount = source ? BigInt(source.amount.minorUnits) : null;
  const discovered = await store.createReviewItem({
    transactionId: reviewTransactionId,
    budgetId,
    categoryId: recommendedCategoryId,
    classifier: 'fixture',
    provenance: 'test',
    ...(source && signedAmount !== null ? {
      sourceTransaction: {
        id: source.id,
        accountId: source.accountId,
        categoryId: source.categoryId ?? null,
        direction: signedAmount < 0n ? 'outgoing' as const : 'incoming' as const,
        amount: {
          minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
          currency: source.amount.currency,
        },
      },
    } : {}),
  });
  const suggested = await store.transitionInternalReviewItem(discovered.id, {
    toStatus: 'suggestion_generated',
    actor: PROPOSER_ID,
    expectedVersion: discovered.version,
  });
  return store.transitionInternalReviewItem(suggested.id, {
    toStatus: 'pending_review',
    actor: PROPOSER_ID,
    expectedVersion: suggested.version,
  });
}

async function requireProposal(id: string): Promise<GenericActionProposal> {
  const proposal = await store.getProposal(id);
  if (!proposal || proposal.operation === 'transfer' || proposal.operation === 'session_completion')
    throw new Error('Expected a persisted generic proposal');
  return proposal;
}

async function seed(operation: GenericProposalOperation): Promise<GenericActionProposal> {
  grantProposer(operation);
  if (operation === 'update_rule' || operation === 'delete_rule') setLifecycleRule();
  const { payload, preconditions } = await proposalInput(operation);
  const expiresAt = EXPIRES_AT;
  const proposal = await store.createProposal({
    operation,
    spaceId,
    budgetId,
    payload,
    payloadHash: canonicalProposalHash({
      operation,
      budgetId,
      payload,
      preconditions,
      actorId: PROPOSER_ID,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    }),
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    expiresAt,
    actorId: PROPOSER_ID,
    auth: { method: 'session', actorId: PROPOSER_ID, sessionId: `session:${PROPOSER_ID}` },
    provenance: 'proposal-execute-test',
  });
  return requireProposal(proposal.id);
}

async function proposalFromReviewRoute(): Promise<GenericActionProposal> {
  grantProposer('create_rule');
  const review = await pendingReview();
  const response = await proposeRule(event(
    { reviewId: review.id, categoryId },
    '',
    PROPOSER_ID,
  ));
  expect(response.error).toBeNull();
  expect(response.status).toBe('ok');
  const id = response.result!.proposal.id;
  const proposal = await requireProposal(id);
  const preconditions = JSON.parse(proposal.preconditions) as Record<string, unknown>;
  expect(proposal).toMatchObject({
    operation: 'create_rule',
    payload: { kind: 'create_rule', composite },
  });
  expect(preconditions.actualVersion).toBe(fixture.actualVersion);
  return proposal;
}

/** Real merchant current context and native plan; only SDK/source I/O is injected. */
async function merchantExecutionProposal() {
  const now = '2026-10-04T12:00:00.000Z';
  const expiresAt = '2026-10-05T12:00:00.000Z';
  vi.setSystemTime(now);
  const source = merchantAnalysisRequestSchema.parse(merchantFixture.request);
  protocolSnapshot = canonicalProtocolSnapshotSchema.parse({
    ...baseSnapshot, actualVersion: '26.10.0', snapshotDate: now,
    accounts: [{ ...baseSnapshot.accounts[0]!, id: 'account-checking' }],
    payees: source.payees, categories: source.categories, rules: [], schedules: [], budgets: [], tags: [],
    transactions: source.transactions.map((row) => ({
      ...row, importedPayee: row.importedPayee.value, notes: row.notes.value,
      categoryName: null, tags: [], subtransactions: [],
    })),
  });
  grantProposer('create_rule');
  grantOperator('create_rule');
  const key = 'merchant:transaction:tx-source';
  for (const [actorId, membershipId] of [
    [PROPOSER_ID, proposerMembershipId], [approverId, actorMembershipId],
  ]) for (const row of protocolSnapshot.transactions)
    for (const capability of ['evidence', 'normalized-evidence', 'source'])
      store.governance.provisionResourceGrant({
        spaceId, budgetId, actorId: actorId!, membershipId: membershipId!,
        resourceKind: 'evidence', resourceId: `merchant:transaction:${row.id}`, capability,
        granted: true, now,
      });
  for (const [resourceKind, resourceId, capability] of [
    ['budget', budgetId, 'policy'], ['space', spaceId, 'policy:manage'],
  ] as const) store.governance.provisionResourceGrant({
    spaceId, budgetId, actorId: PROPOSER_ID, membershipId: proposerMembershipId,
    resourceKind, resourceId, capability, granted: true, now,
  });
  const proposerProof = await issueApprovalProof(PROPOSER_ID, `session:${PROPOSER_ID}`);
  const executorProof = await issueApprovalProof();
  const governancePolicyVersion = store.governance.getPolicy({ spaceId })!.version;
  const actor = {
    actorId: approverId, spaceId, budgetId, membershipId: actorMembershipId,
    governancePolicyVersion, auth: executorProof.auth,
  };
  const manager = {
    loadConfig: mocks.mutationLoadConfig, withConnection: mocks.mutationWithConnection,
  } as unknown as ConnectionManager;
  const service = await createMerchantIntelligenceService({ store, connectionManager: manager });
  // The SDK test connection supplies the source methods used by the real service.
  const connected = connection as unknown as ConnectedBudget;
  let sourceAuthority: (() => boolean) | undefined;
  const context = await service.getCurrentRuleReviewContext(actor, {
    evidenceKey: key, connected, snapshot: protocolSnapshot,
    sourceAvailability: completeNativeRuleSourceAvailability(protocolSnapshot),
    capturePublicationAuthority: (authorize) => { sourceAuthority = authorize; },
  });
  const native = await createNativeRuleMutationProtocol();
  const input: RuleProposalInput = {
    name: 'Merchant publication fence', budgetId, stage: 'post', conditionsOp: 'and',
    conditions: [{ field: 'payee', op: 'is', value: 'payee-market' }],
    actions: [{ op: 'set', field: 'category', value: 'category-food' }],
    reviewContext: context,
  };
  const plan = native.planCreateRule(input, protocolSnapshot);
  const simulation = native.simulateCreateRulePlan(plan, protocolSnapshot);
  expect(simulation.transactionsMatched).toBeGreaterThan(0);
  for (const [actorId, membershipId, capability] of [
    [PROPOSER_ID, proposerMembershipId, 'rule:propose'],
    [approverId, actorMembershipId, 'rule:approve'], [approverId, actorMembershipId, 'rule:execute'],
  ]) store.governance.provisionResourceGrant({
    spaceId, budgetId, actorId: actorId!, membershipId: membershipId!, capability: capability!,
    resourceKind: 'evidence', resourceId: key, granted: true, now,
  });
  const proposalInput = {
    store, spaceId, budgetId, actorId: PROPOSER_ID, auth: proposerProof.auth,
    correlationId: 'merchant-execution-publication', expiresAt,
    name: input.name, payeeId: 'payee-market', categoryId: 'category-food',
    nativePlan: plan, currentContext: context, reviewedSimulation: simulation, snapshot: protocolSnapshot,
    origin: { kind: 'rule-route' as const },
    assertPublicationCurrent: () => {
      if (!sourceAuthority || !sourceAuthority())
        throw new Error('Canonical merchant proposal publication is no longer authorized');
    },
  };
  const proposal = await createRuleProposal(proposalInput);
  await store.createApproval({
    proposalId: proposal.id, payloadHash: proposal.payloadHash, actorId: approverId,
    auth: executorProof.auth, expiresAt, now,
  });
  return {
    proposal, proofCookie: executorProof.cookie, key, service,
    policyActor: { ...actor, actorId: PROPOSER_ID, membershipId: proposerMembershipId, auth: proposerProof.auth },
  };
}
async function proposalFromCorrectionRoute(recommendedCategoryId = currentCategoryId): Promise<{
  proposal: GenericActionProposal;
  review: ReviewItem;
}> {
  grantProposer('set_category');
  const review = await pendingReview(transaction.id, recommendedCategoryId);
  const manager = {
    loadConfig: mocks.producerLoadConfig,
    withConnection: mocks.producerWithConnection,
  } as unknown as ConnectionManager;
  setReviewMutationExecutorFactory(createDefaultExecutorFactory(manager));

  const response = await correctReview(event(
    { reviewId: review.id, categoryId },
    '',
    PROPOSER_ID,
  ));
  expect(response.error).toBeNull();
  expect(response.status).toBe('ok');
  expect(response.result).toMatchObject({
    itemId: review.id,
    categoryId,
    status: 'pending_review',
    mutationStatus: 'approval_required',
    applied: false,
    verified: false,
  });
  expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
  const result = response.result as unknown as { proposal: { id: string } };
  return { proposal: await requireProposal(result.proposal.id), review };
}


async function issueApprovalProof(
  actorId = approverId,
  sessionId = approverSessionId,
): Promise<{ cookie: string; auth: HumanControlAuth }> {
  mocks.getSession.mockResolvedValue({
    user: { id: actorId },
    session: { id: sessionId, userId: actorId },
  });
  mocks.verifyPassword.mockResolvedValue({ status: true });
  const issuedOn = event({}, '', actorId);
  const issued = await issueReauthentication(issuedOn as unknown as ReauthenticationEvent, 'correct-password');
  if (!issued) throw new Error('Could not issue the test session-bound approval proof');
  const header = issuedOn.node.res.getHeader('set-cookie');
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const cookie = values
    .map((value) => value.split(';', 1)[0]!)
    .find((value) => value.startsWith(`${REAUTH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('Approval proof cookie was not issued');
  const proof = cookie.slice(REAUTH_COOKIE_NAME.length + 1);
  const proofEvent = event({}, '', actorId, proof);
  const auth = await getHumanControlAuth(proofEvent as unknown as ReauthenticationEvent);
  if (!auth || auth.actorId !== actorId || auth.sessionId !== sessionId)
    throw new Error('The issued approval proof is not bound to the current human session');
  return { cookie: proof, auth };
}

async function approveAs(
  proposal: GenericActionProposal,
  actorId: string,
  sessionId: string,
  membershipId: string,
): Promise<string> {
  const { cookie, auth } = await issueApprovalProof(actorId, sessionId);
  grantOperator(proposal.operation, actorId, membershipId);
  await store.createApproval({
    proposalId: proposal.id,
    actorId,
    payloadHash: proposal.payloadHash,
    expiresAt: proposal.expiresAt,
    auth,
    now: NOW,
  });
  return cookie;
}

async function approve(proposal: GenericActionProposal): Promise<string> {
  return approveAs(proposal, approverId, approverSessionId, actorMembershipId);
}


beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  vi.stubEnv('BETTER_AUTH_SECRET', 'proposal-execute-test-secret');
  vi.stubEnv('NUXT_BETTER_AUTH_SECRET', 'proposal-execute-test-secret');
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  vi.stubEnv('NUXT_DEV_BYPASS_AUTH', 'false');

  spaceId = '';
  const currentSequence = ++sequence;
  budgetId = `proposal-execute-budget-${currentSequence}`;
  approverId = `${APPROVER_PREFIX}-${currentSequence}`;
  approverSessionId = `session:${approverId}`;
  const provider = getWorkflowStore(event() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Proposal execution owner',
      email: 'proposal-execute-owner@example.test',
      claimId: 'proposal-execute-route-fixture',
    });
    await store.finalizeBootstrap({ claimId: 'proposal-execute-route-fixture', ownerUserId: OWNER_ID });
    bootstrapped = true;
  }
  const ownerAuth = {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: NOW,
  };
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Proposal execution space ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now: NOW, auth: ownerAuth });
  if (!store.governance.getPolicy({ spaceId })) {
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth: ownerAuth,
    });
  }
  await store.upsertActorMembership(PROPOSER_ID, 'active', [], '');
  await store.upsertActorMembership(approverId, 'active', [], '');
  proposerMembershipId = store.governance.addMembership({
    spaceId,
    actorId: PROPOSER_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;
  actorMembershipId = store.governance.addMembership({
    spaceId,
    actorId: approverId,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;

  protocolSnapshot = baseSnapshot;
  actualRules = [];
  ledger = createLedger();
  connection = {
    config: { budgetId, serverUrl: 'https://actual.invalid' },
    budget: { id: budgetId },
    connector: ledger,
    synchronization: {
      snapshot: protocolSnapshot,
      rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(protocolSnapshot),
      financialSnapshot: {
        legacySnapshot: {
          accounts: fixture.accounts,
          categories: fixture.categories,
          transactions: fixture.transactions,
        },
      },
    },
  };
  const config: ConnectionConfig = {
    version: 1,
    budgetId,
    serverUrl: 'https://actual.invalid',
    budgetName: 'Fixture budget',
    groupId: 'fixture-group',
  };
  mocks.producerLoadConfig.mockResolvedValue(config);
  mocks.mutationLoadConfig.mockResolvedValue(config);
  mocks.producerWithConnection.mockImplementation(async (operation) => operation(connection));
  mocks.mutationWithConnection.mockImplementation(async (operation) => operation(connection));
  setReviewMutationExecutorFactory(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setReviewMutationExecutorFactory(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(() => store.close());

describe('proposal execution route', () => {
  it('proposes approves and executes the exact nested split child through real Store and Native verification', async () => {
    const child = structuredClone(baseSnapshot.transactions.find((row) => row.id === transaction.id)!);
    protocolSnapshot = {
      ...baseSnapshot,
      transactions: [{ ...child, id: 'execute-split-parent', categoryId: null, categoryName: null, subtransactions: [
        { ...child, id: 'execute-split-intermediate', categoryId: null, categoryName: null, subtransactions: [child] },
      ] }],
    };
    ledger.setTransactionCategory = vi.fn<BudgetLedger['setTransactionCategory']>(async (id, target, previous) => {
      if (id !== child.id || previous !== child.categoryId) throw new Error('SDK child write precondition mismatch');
      child.categoryId = target;
      child.categoryName = protocolSnapshot.categories.find((row) => row.id === target)?.name ?? null;
      return { success: true, transactionId: id, previousCategoryId: previous, newCategoryId: target, idempotencyKey: 'nested-child-write', verified: true };
    });
    const { proposal, review } = await proposalFromCorrectionRoute();
    expect(proposal.payload).toMatchObject({ transactionId: child.id, categoryId });
    expect(JSON.parse(proposal.preconditions)).toMatchObject({
      reviewId: review.id, reviewProvenance: { transactionId: child.id, version: review.version },
      transaction: { id: child.id, amount: { currency: child.amount.currency, minorUnits: '1500' } },
    });
    await approve(proposal);
    const execution = await executeProposal(event({}, proposal.id, approverId));
    expect(execution.status).toBe('ok');
    expect(execution.result?.verified).toBe(true);
    expect(ledger.setTransactionCategory).toHaveBeenCalledWith(child.id, categoryId, currentCategoryId);
    expect(child.categoryId).toBe(categoryId);
    expect((await store.getReviewItem(review.id))?.status).toBe('applied');
    expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toMatchObject([
      { reviewItemId: review.id, transactionId: child.id, previousCategoryId: currentCategoryId },
    ]);
  });

  it('executes an already approved exact child plan when the current canonical source is recursively nested', async () => {
    const { proposal, review } = await proposalFromCorrectionRoute();
    await approve(proposal);
    const child = structuredClone(baseSnapshot.transactions.find((row) => row.id === transaction.id)!);
    protocolSnapshot = {
      ...baseSnapshot,
      transactions: [{ ...child, id: 'approved-split-parent', categoryId: null, categoryName: null, subtransactions: [
        { ...child, id: 'approved-split-intermediate', categoryId: null, categoryName: null, subtransactions: [child] },
      ] }],
    };
    ledger.setTransactionCategory = vi.fn<BudgetLedger['setTransactionCategory']>(async (id, target, previous) => {
      if (id !== child.id || previous !== child.categoryId) throw new Error('SDK child write precondition mismatch');
      child.categoryId = target;
      child.categoryName = protocolSnapshot.categories.find((row) => row.id === target)?.name ?? null;
      return { success: true, transactionId: id, previousCategoryId: previous, newCategoryId: target, idempotencyKey: 'approved-child-write', verified: true };
    });
    const execution = await executeProposal(event({}, proposal.id, approverId));
    expect(execution.status).toBe('ok');
    expect(execution.result?.verified).toBe(true);
    expect(ledger.setTransactionCategory).toHaveBeenCalledWith(child.id, categoryId, currentCategoryId);
    expect((await store.getReviewItem(review.id))?.status).toBe('applied');
  });

  it('refuses an approved categorization before write when a top-level and nested source share the transaction ID', async () => {
    const { proposal, review } = await proposalFromCorrectionRoute();
    await approve(proposal);
    const row = structuredClone(baseSnapshot.transactions.find((value) => value.id === transaction.id)!);
    protocolSnapshot = { ...baseSnapshot, transactions: [row, {
      ...row, id: 'conflicting-source-parent', categoryId: null, categoryName: null, subtransactions: [structuredClone(row)],
    }] };
    const execution = await executeProposal(event({}, proposal.id, approverId));
    expect(execution.status).toBe('error');
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');
    expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toEqual([]);
  });

  it('does not finalize a child categorization when its post-write canonical reread has duplicate transaction identities', async () => {
    const { proposal, review } = await proposalFromCorrectionRoute();
    await approve(proposal);
    const write = ledger.setTransactionCategory.bind(ledger);
    ledger.setTransactionCategory = vi.fn<BudgetLedger['setTransactionCategory']>(async (id, target, previous) => {
      const outcome = await write(id, target, previous);
      const row = structuredClone(protocolSnapshot.transactions.find((value) => value.id === id)!);
      protocolSnapshot = { ...protocolSnapshot, transactions: [...protocolSnapshot.transactions, {
        ...row, id: 'conflicting-reread-parent', categoryId: null, categoryName: null, subtransactions: [row],
      }] };
      return outcome;
    });
    const execution = await executeProposal(event({}, proposal.id, approverId));
    expect(execution.status).toBe('error');
    expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
    expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');
    expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toEqual([]);
  });

  it.each(['missing','failed-rules','closed-history'] as const)(
    'consumes acquired approvals without an SDK write when native planning source is %s',
    async (failed) => {
      if (failed === 'closed-history') protocolSnapshot = {...protocolSnapshot,accounts:[
        ...protocolSnapshot.accounts,{...structuredClone(protocolSnapshot.accounts[0]!),id:'sdk-closed-account',isClosed:true},
      ]};
      const proposal = await proposalFromReviewRoute();
      const proofCookie = await approve(proposal);
      const approval = (await store.findActiveApprovals(proposal.id))[0]!;
      const availability = completeNativeRuleSourceAvailability(protocolSnapshot);
      if (failed === 'failed-rules') availability.rules = 'unavailable';
      if (failed === 'closed-history') availability.history.find((row) => row.accountId === 'sdk-closed-account')!.state = 'unavailable';
      vi.mocked(ledger.synchronize).mockResolvedValueOnce({
        snapshot:protocolSnapshot,...(failed === 'missing' ? {} : {rulePlanningSourceAvailability:availability}),
      } as unknown as LedgerSnapshotResult);
      const response = await executeProposal(event({},proposal.id,approverId,proofCookie));
      expect(response.status).toBe('error');
      expect(ledger.createRule).not.toHaveBeenCalled();
      expect((await store.getApproval(approval.id))?.status).toBe('consumed');
    },
  );

  it('rechecks current source authority after SDK capture and consumes acquired approval without writing', async () => {
    const proposal = await proposalFromReviewRoute();
    const proofCookie = await approve(proposal);
    const approval = (await store.findActiveApprovals(proposal.id))[0]!;
    vi.mocked(ledger.synchronize).mockImplementationOnce(async () => {
      store.governance.setResourceGrant({
        spaceId, actorId: approverId, membershipId: actorMembershipId, budgetId,
        resourceKind: 'budget', resourceId: budgetId, capability: 'merchant:analyze',
        granted: false, now: NOW,
        auth: { method: 'human-session', actorId: OWNER_ID, sessionId: `session:${OWNER_ID}`, reauthenticatedAt: NOW },
      });
      return {snapshot:protocolSnapshot,rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(protocolSnapshot)} as unknown as LedgerSnapshotResult;
    });
    const response = await executeProposal(event({}, proposal.id, approverId, proofCookie));
    expect(response.status).toBe('error');
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect((await store.getApproval(approval.id))?.status).toBe('consumed');
    expect(mocks.mutationWithConnection).toHaveBeenCalledWith(expect.any(Function), {
      expectedBudgetId: budgetId, dispose: true, synchronize: false,
    });
  });

  it('blocks a fully approved altered reviewed simulation with an unchanged native plan hash', async () => {
    const original = await proposalFromReviewRoute();
    const preconditions = JSON.parse(original.preconditions) as Record<string, unknown>;
    const simulation = preconditions.reviewedSimulation as { transactionsAffected: string[]; transactionsMatched: number };
    simulation.transactionsAffected = [];
    simulation.transactionsMatched = 0;
    const proposal = await store.createProposal({
      operation: 'create_rule',spaceId,budgetId,payload:original.payload,
      policyVersion:GENERIC_MUTATION_POLICY_VERSION,preconditions:JSON.stringify(preconditions),
      expiresAt:original.expiresAt,actorId:PROPOSER_ID,
      auth:{ method:'session',actorId:PROPOSER_ID,sessionId:`session:${PROPOSER_ID}` },provenance:'test',
    });
    const proofCookie = await approve(proposal);
    const approval = (await store.findActiveApprovals(proposal.id))[0]!;
    const response = await executeProposal(event({},proposal.id,approverId,proofCookie));
    expect(response.status).toBe('error');
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect((await store.getApproval(approval.id))?.status).toBe('consumed');
  });

  it('denies a future-global native rule for a narrowed current execution actor before broad SDK reads', async () => {
    const proposal = await proposalFromReviewRoute();
    const proofCookie = await approve(proposal);
    grant(approverId,actorMembershipId,'rule:execute','budget',budgetId,{accountIds:[transaction.accountId]});
    const response = await executeProposal(event({},proposal.id,approverId,proofCookie));
    expect(response.status).toBe('error');
    expect(mocks.mutationWithConnection).not.toHaveBeenCalled();
    expect(ledger.synchronize).toHaveBeenCalledTimes(1);
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('replays verified native rule execution without invoking unavailable current-source or ledger dependencies', async () => {
    const proposal = await proposalFromReviewRoute();
    const proofCookie = await approve(proposal);
    const first = await executeProposal(event({},proposal.id,approverId,proofCookie));
    expect(first.status).toBe('ok');
    mocks.mutationWithConnection.mockClear();
    mocks.mutationLoadConfig.mockClear();
    const capture = vi.mocked((ledger as BudgetLedger & ActualMerchantSourceCapture).captureMerchantSource);
    capture.mockClear();
    const replay = await executeProposal(event({},proposal.id,approverId));
    expect(replay.status).toBe('ok');
    expect(replay.result).toEqual(first.result);
    expect(mocks.mutationWithConnection).not.toHaveBeenCalled();
    expect(mocks.mutationLoadConfig).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(ledger.createRule).toHaveBeenCalledOnce();
  });

  it.each(['already succeeded', 'completed while queued'] as const)(
    'publishes an exact ordinary null-evidence replay when %s without source capture or redispatch',
    async (timing) => {
      const proposal = await proposalFromReviewRoute();
      const proofCookie = await approve(proposal);
      expect(JSON.parse(proposal.preconditions)).toMatchObject({ reviewContext: { evidenceKey: null } });
      const sourceLedger = ledger as BudgetLedger & ActualMerchantSourceCapture;
      const capture = vi.mocked(sourceLedger.captureMerchantSource);
      capture.mockClear();
      vi.mocked(ledger.synchronize).mockClear();
      const synchronize = vi.mocked(ledger.synchronize).getMockImplementation();
      if (!synchronize) throw new Error('Canonical SDK synchronization fixture is unavailable');
      let reachedFirst!: () => void;
      let releaseFirst!: () => void;
      let reachedSecond!: () => void;
      const firstAcquired = new Promise<void>((resolve) => { reachedFirst = resolve; });
      const resumeFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondQueued = new Promise<void>((resolve) => { reachedSecond = resolve; });
      vi.mocked(ledger.synchronize).mockImplementationOnce(async (options) => {
        reachedFirst();
        await resumeFirst;
        return synchronize(options);
      });
      let first: Promise<ApiEnvelope<unknown>>;
      let turns = 0;
      let capturesBeforeReplay = 0;
      let synchronizationsBeforeReplay = 0;
      mocks.mutationWithConnection.mockImplementation(async (operation) => {
        if (++turns === 2) {
          reachedSecond();
          await first;
          capturesBeforeReplay = capture.mock.calls.length;
          synchronizationsBeforeReplay = vi.mocked(ledger.synchronize).mock.calls.length;
        }
        return operation(connection);
      });
      first = executeProposal(event({}, proposal.id, approverId, proofCookie));
      await firstAcquired;
      expect((await store.getIdempotencyRecord(`${proposal.id}:execute:${approverId}`))?.status).toBe('in_progress');
      let replay: Promise<ApiEnvelope<unknown>>;
      if (timing === 'completed while queued') {
        replay = executeProposal(event({}, proposal.id, approverId));
        await Promise.race([
          secondQueued,
          replay.then((response) => {
            throw new Error(`Replay stopped before its queued turn: ${JSON.stringify({
              status: response.status, errorCode: response.error?.code,
            })}`);
          }),
        ]);
        releaseFirst();
      } else {
        releaseFirst();
        expect((await first).status).toBe('ok');
        capture.mockClear();
        vi.mocked(ledger.synchronize).mockClear();
        mocks.mutationWithConnection.mockClear();
        replay = executeProposal(event({}, proposal.id, approverId));
      }
      const original = await first;
      expect(original.status).toBe('ok');
      const repeated = await replay;
      expect(repeated.status).toBe('ok');
      expect(repeated.result).toEqual(original.result);
      expect(repeated.result).toMatchObject({ ruleId: CREATED_RULE_ID, verified: true });
      expect(capture.mock.calls).toHaveLength(capturesBeforeReplay);
      expect(vi.mocked(ledger.synchronize).mock.calls).toHaveLength(synchronizationsBeforeReplay);
      if (timing === 'already succeeded') expect(mocks.mutationWithConnection).not.toHaveBeenCalled();
      else expect(turns).toBe(2);
      expect(ledger.createRule).toHaveBeenCalledOnce();
      expect((await store.getIdempotencyRecord(`${proposal.id}:execute:${approverId}`))?.status).toBe('succeeded');
      expect(await store.queryAuditRecordsByProposal(proposal.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          classification: 'execution_completed', expectedPriorState: proposal.preconditions,
        }),
      ]));
    },
  );


  it.each([
    'set_category',
    'create_rule',
    'update_rule',
    'delete_rule',
  ] as const)('executes the approved %s proposal through its native mutation service', async (operation) => {
    const proposal = operation === 'create_rule'
      ? await proposalFromReviewRoute()
      : await seed(operation);
    const proofCookie = await approve(proposal);
    grant(approverId, actorMembershipId, operation === 'set_category' ? 'categorization:execute' : 'rule:execute',
      'budget', budgetId, { operations: [operation] });

    const response = await executeProposal(event({}, proposal.id, approverId, proofCookie));

    expect(response.error).toBeNull();
    expect(response.status).toBe('ok');
    expect(response.result!.verified).toBe(true);
    expect(response.result!.proposalId).toBe(proposal.id);
    expect((await store.getProposal(proposal.id))?.supersededAt).not.toBeNull();
    if (operation === 'set_category') {
      expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
      expect(response.result).toMatchObject({ transactionId: transaction.id, categoryId });
    } else if (operation === 'create_rule') {
      expect(ledger.createRule).toHaveBeenCalledOnce();
      expect(ledger.createRule).toHaveBeenCalledWith({
        stage:'post',conditionsOp:'and',
        conditions:[{field:'payee',op:'is',value:transaction.payeeId}],
        actions:[{op:'set',field:'category',value:categoryId}],
      }, { assertExecutionCurrent: expect.any(Function) });
      expect(response.result).toMatchObject({ ruleId: CREATED_RULE_ID });
    } else if (operation === 'update_rule') {
      expect(await store.getRuleOverride({ spaceId, budgetId, ruleId: RULE_ID })).toMatchObject({
        ruleId: RULE_ID,
        inactive: true,
        version: 1,
      });
    } else {
      expect(ledger.deleteRule).toHaveBeenCalledOnce();
      expect(await ledger.listRules()).not.toContainEqual(expect.objectContaining({ id: RULE_ID }));
    }
  });
  it('approves and executes an uncategorized correction with empty immutable original-category provenance', async () => {
    const uncategorized = fixture.transactions.find(({ categoryId: original }) => original === null)!;
    grantProposer('set_category');
    grant(PROPOSER_ID, proposerMembershipId, 'categorization:propose', 'transaction', uncategorized.id);
    grant(PROPOSER_ID, proposerMembershipId, 'categorization:propose', 'account', uncategorized.accountId);
    const review = await pendingReview(uncategorized.id, '');
    const manager = {
      loadConfig: mocks.producerLoadConfig,
      withConnection: mocks.producerWithConnection,
    } as unknown as ConnectionManager;
    setReviewMutationExecutorFactory(createDefaultExecutorFactory(manager));

    const correction = await correctReview(event(
      { reviewId: review.id, categoryId },
      '',
      PROPOSER_ID,
    ));

    expect(correction.status).toBe('ok');
    const corrected = correction.result as unknown as { proposal: { id: string } };
    const proposal = await requireProposal(corrected.proposal.id);
    expect(JSON.parse(proposal.preconditions)).toMatchObject({
      reviewId: review.id,
      reviewProvenance: {
        budgetId,
        transactionId: uncategorized.id,
        categoryId: '',
        status: 'pending_review',
        version: review.version,
      },
    });
    expect(await store.isProposalReviewProvenanceCurrent(proposal.id)).toBe(true);
    expect((await store.getReviewItem(review.id))?.categoryId).toBe('');

    for (const capability of ['categorization:approve', 'categorization:execute'])
      for (const [kind, id] of [
        ['transaction', uncategorized.id],
        ['account', uncategorized.accountId],
      ] as const)
        grant(approverId, actorMembershipId, capability, kind, id);
    await approve(proposal);
    const execution = await executeProposal(event({}, proposal.id, approverId));

    expect(execution.status).toBe('ok');
    expect(execution.result?.verified).toBe(true);
    expect(ledger.setTransactionCategory).toHaveBeenCalledWith(uncategorized.id, categoryId, null);
    expect((await store.getReviewItem(review.id))?.categoryId).toBe(categoryId);
    expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toMatchObject([
      { reviewItemId: review.id, transactionId: uncategorized.id, previousCategoryId: null },
    ]);
  });

  it.each([currentCategoryId, categoryId])('keeps a corrected review recommendation %s pending until two distinct approvals and verified execution', async (recommendedCategoryId) => {
    const secondApprover = await configureTwoApprovers();
    const { proposal, review } = await proposalFromCorrectionRoute(recommendedCategoryId);
    const preconditions = JSON.parse(proposal.preconditions) as Record<string, unknown>;
    const idempotencyKey = `${proposal.id}:execute:${approverId}`;
    const nativePlan = preconditions.nativePlan as { planId: string };

    expect(proposal).toMatchObject({
      operation: 'set_category',
      payload: { kind: 'set_category', transactionId: transaction.id, categoryId },
    });
    expect(preconditions).toMatchObject({
      reviewId: review.id,
      reviewProvenance: {
        budgetId,
        transactionId: transaction.id,
        categoryId: recommendedCategoryId,
        status: 'pending_review',
        version: review.version,
      },
    });
    expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');

    const firstProof = await approve(proposal);
    const insufficient = await executeProposal(event({}, proposal.id, approverId, firstProof));
    expect(insufficient.status).toBe('error');
    expect(insufficient.error).toMatchObject({ code: 'PROPOSAL_NOT_APPROVED' });
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');

    await approveAs(proposal, secondApprover.actorId, secondApprover.sessionId, secondApprover.membershipId);
    const response = await executeProposal(event({}, proposal.id, approverId));

    expect(response.error).toBeNull();
    expect(response.status).toBe('ok');
    expect(response.result!.verified).toBe(true);
    const successfulRecord = await store.getIdempotencyRecord(idempotencyKey);
    expect(successfulRecord?.status).toBe('succeeded');
    expect(JSON.parse(successfulRecord?.serialisedResult ?? 'null')).toMatchObject({
      verified: true,
      transactionId: transaction.id,
      previousCategoryId: currentCategoryId,
      newCategoryId: categoryId,
      planId: nativePlan.planId,
    });
    expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
    expect((await store.getReviewItem(review.id))?.status).toBe('applied');
    expect((await store.getReviewItem(review.id))?.categoryId).toBe(categoryId);
    const history = await store.queryCorrectionHistory({ reviewItemId: review.id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      reviewItemId: review.id,
      transactionId: transaction.id,
      previousCategoryId: currentCategoryId,
      categoryId,
      fromStatus: 'pending_review',
      toStatus: 'applied',
      proposalId: proposal.id,
      proposalActorId: PROPOSER_ID,
      payloadHash: proposal.payloadHash,
      idempotencyKey: `${proposal.id}:execute:${approverId}`,
      actor: approverId,
      verified: true,
    });
    expect(await store.listReviewItems({ budgetId, status: 'pending_review' }))
      .not.toContainEqual(expect.objectContaining({ id: review.id }));
    expect(await store.listReviewItems({ budgetId, status: 'correcting' }))
      .not.toContainEqual(expect.objectContaining({ id: review.id }));

    mocks.mutationWithConnection.mockRejectedValue(new Error('Disposable Actual transport unavailable after verified execution'));
    const replay = await executeProposal(event({}, proposal.id, approverId));
    expect(replay.error).toBeNull();
    expect(replay.result!.verified).toBe(true);
    expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
    expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toEqual(history);
    expect((await store.getIdempotencyRecord(idempotencyKey))?.serialisedResult)
      .toBe(successfulRecord?.serialisedResult);
  });
  it.each(['categorization:execute', 'rule:execute'])('does not enumerate a proposal through a budget-only %s action grant', async (capability) => {
    const operation = capability === 'categorization:execute' ? 'set_category' : 'create_rule';
    grantProposer(operation);
    const proposal = await seed(operation);
    grant(approverId, actorMembershipId, capability, 'budget', budgetId);
    const known = await executeProposal(event({}, proposal.id, approverId));
    const absent = await executeProposal(event({}, 'missing-proposal', approverId));
    expect(known.status).toBe('error');
    expect(known.error).toEqual(absent.error);
    expect(known.authorization).toEqual(absent.authorization);
    expect(mocks.mutationLoadConfig).not.toHaveBeenCalled();
    expect(mocks.mutationWithConnection).not.toHaveBeenCalled();
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'mismatched'] as const)(
    'keeps review pending when Native rejects a %s stored verified result',
    async (resultCase) => {
      const { proposal, review } = await proposalFromCorrectionRoute();
      await approve(proposal);
      const complete = store.completeIdempotencyRecord.bind(store);
      vi.spyOn(store, 'completeIdempotencyRecord').mockImplementation(
        async (key, errorMessage, isRetryable, serialisedResult) => complete(
          key,
          errorMessage,
          isRetryable,
          !serialisedResult || errorMessage ? serialisedResult
            : resultCase === 'malformed' ? '{'
              : JSON.stringify({
                verified: true,
                transactionId: transaction.id,
                previousCategoryId: currentCategoryId,
                newCategoryId: 'wrong-category',
                planId: 'wrong-plan',
              }),
        ),
      );

      const response = await executeProposal(event({}, proposal.id, approverId));

      expect(response.status).toBe('error');
      expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
      expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');
      expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toEqual([]);
    },
  );

  it('leaves a review pending and unverified when the post-write reread fails', async () => {
    const { proposal, review } = await proposalFromCorrectionRoute();
    await approve(proposal);
    let syncCount = 0;
    ledger.synchronize = vi.fn(async () => {
      syncCount++;
      if (syncCount === 2) throw new Error('post-write reread unavailable');
      return { snapshot: protocolSnapshot } as LedgerSnapshotResult;
    });

    const response = await executeProposal(event({}, proposal.id, approverId));

    expect(response.status).toBe('error');
    expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
    expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');
    expect(await store.queryCorrectionHistory({ reviewItemId: review.id })).toEqual([]);
    expect(await store.getIdempotencyRecord(`${proposal.id}:execute:${approverId}`))
      .toMatchObject({ status: 'terminal_failed', serialisedResult: null });
  });

  it('rejects a review reference for another transaction before the SDK write', async () => {
    grantProposer('set_category');
    const review = await pendingReview('other-review-transaction');
    grant(PROPOSER_ID, proposerMembershipId, 'categorization:propose', 'transaction', review.transactionId);
    const protocol = await createNativeCategorizationMutationProtocol();
    const tx = protocolSnapshot.transactions.find(({ id }) => id === transaction.id);
    const category = protocolSnapshot.categories.find(({ id }) => id === categoryId);
    if (!protocol || !tx || !category) throw new Error('Fixture Native categorization inputs are missing');
    const intent = buildCategorizationProposalIntent({
      protocol,
      snapshot: protocolSnapshot,
      transaction: tx,
      category,
      review,
    });
    const proposalIdsBefore = (await store.listProposals()).map(({ id }) => id);
    await expect(store.createProposal({
      operation: 'set_category',
      budgetId,
      spaceId,
      payload: intent.payload,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify(intent.preconditions),
      expiresAt: EXPIRES_AT,
      actorId: PROPOSER_ID,
      auth: { method: 'session', actorId: PROPOSER_ID, sessionId: `session:${PROPOSER_ID}` },
      provenance: 'proposal-execute-review-mismatch-test',
    })).rejects.toThrow();
    expect((await store.listProposals()).map(({ id }) => id)).toEqual(proposalIdsBefore);
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    expect((await store.getReviewItem(review.id))?.status).toBe('pending_review');
  });
  it.each([
    ['disconnect', 'unchanged'], ['disconnect', 'normalized-evidence'],
    ['disconnect', 'session'], ['disconnect', 'policy'],
    ['supersession', 'unchanged'], ['supersession', 'normalized-evidence'],
    ['supersession', 'session'], ['supersession', 'policy'],
  ] as const)('retains merchant publication authority through %s: %s', async (boundary, change) => {
    const admitted = await merchantExecutionProposal();
    let credentialCurrent = true;
    let boundaryReached = false;
    const revoke = async () => {
      boundaryReached = true;
      if (change === 'normalized-evidence')
        store.governance.setResourceGrant({
          spaceId, budgetId, actorId: approverId, membershipId: actorMembershipId,
          resourceKind: 'evidence', resourceId: admitted.key, capability: 'normalized-evidence',
          granted: false, now: new Date().toISOString(),
          auth: {
            method: 'human-session', actorId: OWNER_ID, sessionId: `session:${OWNER_ID}`,
            reauthenticatedAt: new Date().toISOString(),
          },
        });
      if (change === 'session') credentialCurrent = false;
      if (change === 'policy')
        await admitted.service.setPolicy(admitted.policyActor, {
          expectedVersion: 0, value: {
            mode: 'disabled', allowedProviderIds: [], maxSearchesPerDay: 0,
            maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720,
          },
        });
    };
    if (boundary === 'disconnect') {
      const disconnect = vi.fn(async () => { await revoke(); });
      mocks.mutationWithConnection.mockImplementation(async (operation, options) => {
        const result = await operation(connection);
        if (!options?.dispose) throw new Error('Execution must dispose its mutation connection');
        await disconnect();
        return result;
      });
    } else {
      const supersede = store.supersedeProposal.bind(store);
      vi.spyOn(store, 'supersedeProposal').mockImplementation(async (id) => {
        await supersede(id);
        await revoke();
      });
    }
    const request = event({}, admitted.proposal.id, approverId, admitted.proofCookie);
    if (!request.context.auth) throw new Error('Fixture requires its real selected request identity');
    request.context.auth.isCredentialValid = () => credentialCurrent;
    request.context.auth.credentialExpiresAt = '2026-10-05T12:00:00.000Z';
    mocks.getSession.mockResolvedValue({
      user: { id: approverId }, session: {
        id: approverSessionId, userId: approverId, expiresAt: new Date('2026-10-05T12:00:00.000Z'),
      },
    });
    const response = await executeProposal(request);
    expect(boundaryReached, JSON.stringify({ status: response.status, errorCode: response.error?.code })).toBe(true);
    expect(response.status).toBe(change === 'unchanged' ? 'ok' : 'error');
    if (change === 'unchanged')
      expect(response.result).toMatchObject({ ruleId: CREATED_RULE_ID, verified: true });
    else {
      expect(response.result).toBeNull();
      expect(JSON.stringify(response)).not.toContain(CREATED_RULE_ID);
      expect(response.error).toMatchObject({ code: 'PUBLICATION_WITHHELD', retryable: false });
      expect(response.error?.message).toMatch(/dispatched.*not rolled back/i);
    }
    expect(ledger.createRule).toHaveBeenCalledOnce();
    expect(protocolSnapshot.rules.filter((rule) => rule.id === CREATED_RULE_ID)).toHaveLength(1);
    expect((await store.getIdempotencyRecord(`${admitted.proposal.id}:execute:${approverId}`))?.status).toBe('succeeded');
    expect(await store.queryAuditRecordsByProposal(admitted.proposal.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: 'execution_completed', expectedPriorState: admitted.proposal.preconditions,
      }),
    ]));
    if (change !== 'session') {
      const capture = vi.mocked((ledger as BudgetLedger & ActualMerchantSourceCapture).captureMerchantSource);
      capture.mockClear();
      vi.mocked(ledger.synchronize).mockClear();
      mocks.mutationWithConnection.mockClear();
      const durable = await store.getIdempotencyRecord(`${admitted.proposal.id}:execute:${approverId}`);
      const audit = await store.queryAuditRecordsByProposal(admitted.proposal.id);
      const replay = await executeProposal(event({}, admitted.proposal.id, approverId));
      expect(replay.status).toBe(change === 'unchanged' ? 'ok' : 'error');
      if (change === 'unchanged')
        expect(replay.result).toMatchObject({ ruleId: CREATED_RULE_ID, verified: true });
      else {
        expect(replay.result).toBeNull();
        expect(JSON.stringify(replay)).not.toContain(CREATED_RULE_ID);
        expect(replay.error).toMatchObject({ code: 'PUBLICATION_WITHHELD', retryable: false });
        expect(replay.error?.message).toMatch(/dispatched.*not rolled back/i);
      }
      expect(capture).not.toHaveBeenCalled();
      expect(ledger.synchronize).not.toHaveBeenCalled();
      expect(mocks.mutationWithConnection).not.toHaveBeenCalled();
      expect(ledger.createRule).toHaveBeenCalledOnce();
      expect(await store.getIdempotencyRecord(`${admitted.proposal.id}:execute:${approverId}`)).toEqual(durable);
      const replayAudit = await store.queryAuditRecordsByProposal(admitted.proposal.id);
      expect(replayAudit).toEqual(expect.arrayContaining(audit));
      expect(replayAudit.filter((record) => record.classification === 'execution_completed'))
        .toEqual(audit.filter((record) => record.classification === 'execution_completed'));
    }
  });
});
