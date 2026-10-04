import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { CategoryReallocation, TransferPlan } from '@balanceframe/protocol-generated';
import {
  canonicalProposalHash,
  canonicalProposalJson,
  GENERIC_MUTATION_POLICY_VERSION,
} from '../src/index.js';
import type { GetProposalApprovalSummaryInput, ProposalApprovalSummary } from '../src/index.js';
import { deriveProposalAuthorizationFacts } from '../src/proposal.js';
import type { ProposalAuthorizationFacts } from '../src/proposal.js';
import type { GovernanceResourceRef } from '../src/governance-types.js';
import { SqliteWorkflowStore } from '../src/store.js';
import type {
  ActionProposal,
  CreateApprovalInput,
  CreateApprovalsInput,
  CreateProposalInput,
  ProposalApproval,
} from '../src/types.js';

const now = '2098-01-01T12:00:00.000Z';
const after = '2098-01-01T13:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const budgetId = 'budget-governance';
const amount = (minorUnits: string) => ({ minorUnits, currency: 'USD' });


type HumanAuth = {
  method: 'human-session';
  actorId: string;
  sessionId: string;
  reauthenticatedAt: string;
};
type OperationalAuth =
  | HumanAuth
  | { method: 'session'; actorId: string; sessionId: string }
  | {
      method: 'api-key';
      actorId: string;
      credentialId: string;
      credentialOwnerId: string;
      principalType: 'human';
    }
  | {
      method: 'api-key';
      actorId: string;
      credentialId: string;
      credentialOwnerId: string;
      principalType: 'agent';
      delegationId: string;
      delegationVersion: string;
    };

const auth = (actorId: string, reauthenticatedAt = now): HumanAuth => ({
  method: 'human-session',
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt,
});

function transferPlan(hash = 'a'.repeat(64)): TransferPlan {
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId: 'snapshot-1',
    contentHash: 'ledger-content-1',
    policyVersion: 'financial-policy-1',
    policyHash: 'financial-policy-hash-1',
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt,
    minimumAmount: amount('20'),
    payloadHash: hash,
    legs: [
      {
        id: 'transfer-leg-1',
        sourceAccountId: 'acct-source',
        destinationAccountId: 'acct-destination',
        amount: amount('20'),
        requiredBy: expiresAt,
        estimatedArrival: now,
        timingRouteId: 'route-1',
        sourceBefore: {
          accountId: 'acct-source',
          recordedBalance: amount('100'),
          signedHeadroom: amount('100'),
          backingCapacity: amount('100'),
          baselineTransactionIds: [],
        },
        destinationBefore: {
          accountId: 'acct-destination',
          recordedBalance: amount('100'),
          signedHeadroom: amount('100'),
          backingCapacity: amount('100'),
          baselineTransactionIds: [],
        },
        sourceAfter: amount('80'),
        destinationAfter: amount('120'),
      },
    ],
    reservations: [
      {
        kind: 'account_debit',
        resourceId: 'acct-source',
        amount: amount('20'),
        economicObligationId: 'transfer-1',
        categoryId: null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
    backingAfter: {
      version: '1',
      snapshotId: 'snapshot-1',
      contentHash: 'ledger-content-1',
      policyVersion: 'financial-policy-1',
      policyHash: 'financial-policy-hash-1',
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}

const reallocation: CategoryReallocation = {
  id: 'reallocation-1',
  sourceCategoryId: 'cat-donor',
  destinationCategoryId: 'cat-food',
  amount: amount('2500'),
};

function payload(transactionId = 'txn-exact-1') {
  const nativePlan = transferPlan();
  return {
    kind: 'set_category' as const,
    transactionId,
    categoryId: 'cat-food',
    composite: {
      operations: [
        {
          id: 'operation-out-1',
          operation: 'set_category',
          transactionId,
          accountId: 'acct-source',
          categoryId: 'cat-food',
          direction: 'outgoing',
          amount: amount('12500'),
          currentCategoryId: null,
          actualVersion: 'actual-v1',
        },
        {
          id: 'operation-out-2',
          operation: 'set_category',
          transactionId: `${transactionId}-2`,
          accountId: 'acct-source',
          categoryId: 'cat-food',
          direction: 'outgoing',
          amount: amount('6000'),
          currentCategoryId: null,
          actualVersion: 'actual-v1',
        },
        {
          id: 'operation-in-1',
          operation: 'set_category',
          transactionId: `${transactionId}-3`,
          accountId: 'acct-destination',
          categoryId: 'cat-food',
          direction: 'incoming',
          amount: amount('12000'),
          currentCategoryId: null,
          actualVersion: 'actual-v1',
        },
      ],
      reallocations: [reallocation],
      transferRecommendations: [nativePlan],
      ledgerProjections: [
        {
          id: 'projection-1',
          transactionId,
          accountId: 'acct-source',
          categoryId: 'cat-food',
          amount: amount('12500'),
          expectedCategoryId: null,
          actualVersion: 'actual-v1',
        },
      ],
      evidenceReferences: [
        {
          evidenceId: 'receipt-1',
          kind: 'receipt',
          authorized: true,
          redaction: 'visible',
          amount: amount('12500'),
          documentDigest: 'receipt-digest-1',
        },
      ],
      nativePayloadHash: nativePlan.payloadHash,
    },
  };
}

function proposalInput(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  const transactionId = overrides.payload?.transactionId ?? 'txn-exact-1';
  return {
    spaceId: currentSpaceId,
    operation: 'set_category',
    budgetId,
    payload: payload(transactionId),
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify({
      transactionId,
      accountId: 'acct-source',
      amount: amount('12500'),
      direction: 'outgoing',
      currentCategoryId: null,
      actualVersion: 'actual-v1',
    }),
    expiresAt,
    actorId: 'proposer',
    auth: auth('proposer'),
    provenance: 'model-derived',
    providerModel: 'test/model',
    correlationId: 'approval-contract-test',
    ...overrides,
  };
}

type GenericProposal = Extract<ActionProposal, { operation: 'set_category' | 'create_rule' }>;

async function createProposal(input = proposalInput()): Promise<GenericProposal> {
  const preconditions = JSON.parse(input.preconditions) as unknown;
  currentProposalResources = [
    { resourceKind: 'budget', resourceId: input.budgetId },
    ...deriveProposalAuthorizationFacts(input.operation, input.payload, preconditions).resources,
  ];
  const capabilityPrefix = input.operation === 'set_category' ? 'categorization' : 'rule';
  const grants = [
    { actorId: input.actorId, capability: `${capabilityPrefix}:propose` },
    ...['approver-a', 'approver-b', 'approver-c']
      .filter((actorId) => actorId !== input.actorId)
      .map((actorId) => ({ actorId, capability: `${capabilityPrefix}:approve` })),
    ...['executor']
      .filter((actorId) => actorId !== input.actorId)
      .map((actorId) => ({ actorId, capability: `${capabilityPrefix}:execute` })),
  ];
  for (const resource of currentProposalResources) {
    for (const grant of grants) {
      const membership = governance.getCurrentMembership({
        spaceId: input.spaceId,
        actorId: grant.actorId,
        now,
      });
      if (!membership) continue;
      governance.setResourceGrant({
        spaceId: input.spaceId,
        actorId: grant.actorId,
        budgetId: input.budgetId,
        membershipId: membership.id,
        capability: grant.capability,
        ...resource,
        granted: true,
        now,
        auth: auth('owner'),
      });
    }
  }
  const proposal = await store.createProposal(input);
  if (proposal.operation !== 'set_category' && proposal.operation !== 'create_rule')
    throw new Error('Expected a generic set-category or rule proposal');
  expect(proposal.payloadHash).toBe(
    canonicalProposalHash({
      operation: input.operation,
      budgetId: input.budgetId,
      payload: input.payload,
      preconditions,
      actorId: input.actorId,
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt,
    }),
  );
  return proposal;
}

async function approve(
  proposal: GenericProposal,
  actorId: string,
  approvalExpiry = proposal.expiresAt,
  at = now,
) {
  return store.createApproval({
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    actorId,
    expiresAt: approvalExpiry,
    auth: auth(actorId, at),
    now: at,
  });
}
async function createHumanApprovedProposal() {
  const proposal = await createProposal();
  const approvals = [
    await approve(proposal, 'approver-a'),
    await approve(proposal, 'approver-b'),
  ];
  return { proposal, approvals };
}


function acquisitionInput(
  proposal: GenericProposal,
  overrides: Partial<{
    actorId: string;
    payloadHash: string;
    governancePolicyVersion: string;
    idempotencyKey: string;
    serialisedEffect: string;
    approvalId: string;
    auth: OperationalAuth;
    now: string;
    requestId: string;
    correlationId: string;
  }> = {},
) {
  const actorId = overrides.actorId ?? 'executor';
  return {
    actorId,
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    governancePolicyVersion: proposal.governancePolicyVersion,
    idempotencyKey: 'execute:exact-proposal',
    serialisedEffect: JSON.stringify({
      operation: proposal.operation,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions),
    }),
    auth: auth(actorId, overrides.now ?? now),
    now,
    requestId: 'request-exact-proposal',
    correlationId: 'approval-contract-test',
    ...overrides,
  };
}

function readApprovalSummary(
  proposalId: string,
  actorId: string,
  at = now,
  spaceId = currentSpaceId,
  operationalAuth: OperationalAuth = auth(actorId, at),
): Promise<ProposalApprovalSummary> {
  const input: GetProposalApprovalSummaryInput = {
    proposalId,
    spaceId,
    actorId,
    auth: operationalAuth,
    now: at,
  };
  return store.getProposalApprovalSummary(input);
}

type NativeRuleMutation = 'update_rule' | 'delete_rule';

function nativeRuleSnapshot(
  id = 'rule-governed-state',
  stage: 'pre' | null | 'post' = 'pre',
) {
  return {
    id,
    name: 'Market groceries',
    order: 7,
    trigger: [
      { field: 'account', op: 'is', value: `acct-${id}` },
      { field: 'category', op: 'is', value: `cat-before-${id}` },
    ],
    actions: [{ op: 'set', field: 'category', value: `cat-after-${id}` }],
    inactive: false,
    stage,
    conditionsOp: 'or' as const,
  };
}

function nativeRuleResources(ruleId: string): GovernanceResourceRef[] {
  return [
    { resourceKind: 'budget', resourceId: budgetId },
    { resourceKind: 'rule', resourceId: ruleId },
    { resourceKind: 'account', resourceId: `acct-${ruleId}` },
    { resourceKind: 'category', resourceId: `cat-before-${ruleId}` },
    { resourceKind: 'category', resourceId: `cat-after-${ruleId}` },
  ];
}

async function createNativeRuleMutationProposal(
  operation: NativeRuleMutation,
  options: {
    rule?: unknown;
    override?: unknown;
    payload?: unknown;
    preconditions?: unknown;
    grantResources?: GovernanceResourceRef[];
  } = {},
) {
  const rule = options.rule ?? nativeRuleSnapshot();
  const ruleRecord = typeof rule === 'object' && rule !== null
    ? rule as Record<string, unknown>
    : {};
  const ruleId = typeof ruleRecord.id === 'string' ? ruleRecord.id : 'rule-governed-state';
  const payload = options.payload ?? (
    operation === 'update_rule'
      ? { kind: operation, ruleId, inactive: true }
      : { kind: operation, ruleId }
  );
  const preconditions = options.preconditions ?? {
    rule,
    override: options.override === undefined ? null : options.override,
  };
  const input = {
    spaceId: currentSpaceId,
    operation,
    budgetId,
    payload,
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    expiresAt,
    actorId: 'proposer',
    auth: auth('proposer'),
    provenance: 'manual',
  };
  const resources = options.grantResources ?? nativeRuleResources(ruleId);
  currentProposalResources = resources;
  const grants = [
    { actorId: 'proposer', capability: 'rule:propose' },
    ...['approver-a', 'approver-b', 'approver-c']
      .map((actorId) => ({ actorId, capability: 'rule:approve' })),
    { actorId: 'executor', capability: 'rule:execute' },
  ];
  for (const resource of resources) {
    for (const grant of grants) {
      const membership = governance.getCurrentMembership({
        spaceId: currentSpaceId,
        actorId: grant.actorId,
        now,
      });
      if (!membership) continue;
      governance.setResourceGrant({
        spaceId: currentSpaceId,
        actorId: grant.actorId,
        budgetId,
        membershipId: membership.id,
        capability: grant.capability,
        ...resource,
        granted: true,
        now,
        auth: auth('owner'),
      });
    }
  }
  const proposal = await store.createProposal(input as unknown as CreateProposalInput);
  return { proposal, input, resources };
}

function nativeRuleExecutionInput(
  proposal: GenericProposal,
  operation: NativeRuleMutation,
  idempotencyKey: string,
) {
  return {
    actorId: 'executor',
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    governancePolicyVersion: proposal.governancePolicyVersion,
    idempotencyKey,
    serialisedEffect: JSON.stringify({
      operation,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions),
    }),
    auth: auth('executor'),
    now,
    requestId: `request:${idempotencyKey}`,
    correlationId: 'approval-contract-test',
  };
}

async function approveNativeRuleMutation(proposal: GenericProposal, actorId: string) {
  return store.createApproval({
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    actorId,
    expiresAt: proposal.expiresAt,
    auth: auth(actorId),
    now,
  });
}

let currentSpaceId: string;
let store: SqliteWorkflowStore;
let governance: SqliteWorkflowStore['governance'];
let currentProposalResources: GovernanceResourceRef[] = [];

function createApprovals(input: CreateApprovalsInput): Promise<ProposalApproval[]> {
  return store.createApprovals(input);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  store = new SqliteWorkflowStore(':memory:');
  governance = store.governance;
  const claimId = 'governance-test-bootstrap';
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId });
  await store.finalizeBootstrap({ claimId, ownerUserId: 'owner' });
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

async function identity(actorId: string) {
  await store.upsertActorMembership(actorId, 'active', [], 'unscoped');
}

async function setup(policy: {
  minimumApprovers?: number;
  approvalThresholds?: Array<{ currency: string; amountMinorUnits: string; requiredApprovers: number }>;
  operationApprovers?: Record<string, number>;
} = {}) {
  const actors = ['owner', 'proposer', 'approver-a', 'approver-b', 'approver-c', 'executor'];
  for (const actorId of actors) await identity(actorId);

  const unboundSpace = governance.createSpace({
    actorId: 'owner',
    name: 'Governed budget',
    kind: 'shared',
    now,
    auth: auth('owner'),
  });
  const space = governance.bindBudget({
    spaceId: unboundSpace.id,
    budgetId,
    now,
    auth: auth('owner'),
  });
  const initialPolicy = governance.getPolicy({ spaceId: space.id });
  if (!initialPolicy) throw new Error('New governance space has no current policy');
  currentSpaceId = space.id;
  const membershipIds: Record<string, string> = {
    owner: governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now }).id,
  };
  for (const actorId of actors.slice(1)) {
    membershipIds[actorId] = governance.addMembership({
      spaceId: space.id,
      actorId,
      validFrom: now,
      now,
      auth: auth('owner'),
    }).id;
  }

  const currentPolicy = governance.setPolicy({
    spaceId: space.id,
    expectedVersion: initialPolicy.version,
    policy: {
      minimumApprovers: policy.minimumApprovers ?? 1,
      approvalThresholds: policy.approvalThresholds ?? [],
      operationApprovers: policy.operationApprovers ?? { set_category: 2 },
    },
    now,
    auth: auth('owner'),
  });

  currentProposalResources = [];

  return { space, membershipIds, policy: currentPolicy };
}
async function bindAgentCredential(
  spaceId: string,
  issuerMembershipId: string,
  delegatedResources = currentProposalResources,
  delegatedCapabilities: readonly string[] = ['categorization:execute'],
) {
  const issuerActorId = 'owner';
  const agentId = 'agent:delegated-executor';
  const credentialId = 'key:delegated-executor';
  const validUntil = '2098-01-02T12:00:00.000Z';

  for (const capability of delegatedCapabilities) {
    for (const resource of currentProposalResources) {
      governance.setResourceGrant({
        spaceId,
        actorId: issuerActorId,
        budgetId,
        membershipId: issuerMembershipId,
        capability,
        ...resource,
        granted: true,
        now,
        auth: auth(issuerActorId),
      });
    }
  }

  governance.registerAgent({ spaceId, agentId, now, auth: auth(issuerActorId) });
  const rights = delegatedResources.flatMap((resource) =>
    delegatedCapabilities.map((capability) => ({ capability, ...resource })),
  );
  const delegation = governance.delegate({
    spaceId,
    agentId,
    issuerMembershipId,
    expectedVersion: null,
    rights,
    validFrom: now,
    validUntil,
    now,
    auth: auth(issuerActorId),
  });
  governance.registerCredentialBinding({
    spaceId,
    credentialId,
    credentialOwnerId: issuerActorId,
    principalType: 'agent',
    principalId: agentId,
    delegationId: delegation.id,
    expectedDelegationVersion: delegation.version,
    now,
    auth: auth(issuerActorId),
  });

  return {
    actorId: agentId,
    credentialId,
    delegation,
    rights,
    auth: {
      method: 'api-key' as const,
      actorId: agentId,
      credentialId,
      credentialOwnerId: issuerActorId,
      principalType: 'agent' as const,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
    },
  };
}

async function createAgentOriginProposal(
  spaceId: string,
  issuerMembershipId: string,
  delegatedCapabilities: readonly string[] = ['categorization:propose', 'categorization:execute'],
) {
  await createProposal();
  const agent = await bindAgentCredential(
    spaceId,
    issuerMembershipId,
    currentProposalResources,
    delegatedCapabilities,
  );
  const proposal = await createProposal(proposalInput({ actorId: agent.actorId, auth: agent.auth }));
  return { agent, proposal };
}


type StoreInternalsForTest = { db: DatabaseType };

function testDatabase(): DatabaseType {
  const internals = store as unknown as StoreInternalsForTest; // Bypass the private field only for persisted-row corruption and failure injection.
  return internals.db;
}
function sqlCount(sql: string, id: string): number {
  const row = testDatabase().prepare(sql).get(id);
  if (!row || typeof row !== 'object' || !('count' in row) || typeof row.count !== 'number')
    throw new Error('Count query returned an invalid row');
  return row.count;
}

function approvalEffects(proposalIds: readonly string[]) {
  return proposalIds.map((proposalId) => ({
    approvals: sqlCount('SELECT COUNT(*) AS count FROM proposal_approvals WHERE proposal_id = ?', proposalId),
    audits: sqlCount(
      "SELECT COUNT(*) AS count FROM audit_records WHERE proposal_id = ? AND classification = 'approval_granted'",
      proposalId,
    ),
  }));
}

function updateStoredPayload(proposalId: string, changedPayload: unknown) {
  const db = testDatabase();
  db.prepare('UPDATE action_proposals SET payload = ? WHERE id = ?').run(
    JSON.stringify(changedPayload),
    proposalId,
  );
}

function updateStoredPreconditions(proposalId: string, changedPreconditions: unknown) {
  const db = testDatabase();
  db.prepare('UPDATE action_proposals SET preconditions = ? WHERE id = ?').run(
    JSON.stringify(changedPreconditions),
    proposalId,
  );
}

describe('generic proposal approval and execution acquisition', () => {
  it('discards an exact governed intent under current human execution authority and invalidates its approvals', async () => {
    const { policy } = await setup();
    const proposal = await createProposal();
    const approval = await approve(proposal, 'approver-a');
    const result = await store.discardProposal(proposal.id, 'executor', {
      spaceId: currentSpaceId, governancePolicyVersion: policy.version, now, auth: auth('executor'),
    });
    expect(result?.supersededAt).toBe(now);
    expect((await store.getApproval(approval.id))?.status).toBe('superseded');
    const audit = await store.queryAuditRecords('proposal_superseded');
    expect(audit).toContainEqual(expect.objectContaining({
      actorId: 'executor', proposalId: proposal.id, payloadHash: proposal.payloadHash, result: 'discarded',
    }));
  });
  it('cannot discard an intent after its execution has already acquired authority', async () => {
    const { policy } = await setup();
    const { proposal } = await createHumanApprovedProposal();
    await store.acquireProposalExecution(acquisitionInput(proposal));
    expect(await store.discardProposal(proposal.id, 'executor', {
      spaceId: currentSpaceId, governancePolicyVersion: policy.version, now, auth: auth('executor'),
    })).toBeNull();
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });

  it.each([
    { label: 'ordinary session', proof: { method: 'session' as const, actorId: 'executor', sessionId: 'session:executor' } },
    { label: 'stale proof', proof: auth('executor', '2098-01-01T11:54:59.000Z') },
    { label: 'future proof', proof: auth('executor', '2098-01-01T12:00:01.000Z') },
    { label: 'different human', proof: auth('approver-a') },
  ])('denies discard with $label without superseding the proposal', async ({ proof }) => {
    const { policy } = await setup();
    const proposal = await createProposal();
    expect(await store.discardProposal(proposal.id, 'executor', {
      spaceId: currentSpaceId, governancePolicyVersion: policy.version, now, auth: proof,
    })).toBeNull();
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });

  it('rechecks every exact composite execution grant at discard commit', async () => {
    const { policy, membershipIds } = await setup();
    const proposal = await createProposal();
    const evidence = currentProposalResources.find(({ resourceKind }) => resourceKind === 'evidence');
    if (!evidence) throw new Error('Canonical composite fixture lacks evidence');
    governance.setResourceGrant({
      spaceId: currentSpaceId, actorId: 'executor', membershipId: membershipIds.executor, budgetId,
      ...evidence, capability: 'categorization:execute', granted: false, now, auth: auth('owner'),
    });
    expect(await store.discardProposal(proposal.id, 'executor', {
      spaceId: currentSpaceId, governancePolicyVersion: policy.version, now, auth: auth('executor'),
    })).toBeNull();
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });
  it('returns current distinct approvals to an approve-only viewer without consuming them', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const first = await approve(proposal, 'approver-a');
    const second = await approve(proposal, 'approver-b');
    const before = approvalEffects([proposal.id]);

    const approvalViewer = await readApprovalSummary(proposal.id, 'approver-c');
    const executorView = await readApprovalSummary(proposal.id, 'executor');
    expect(approvalViewer).toMatchObject({
      currentGovernancePolicyVersion: fixture.policy.version,
      requesterMembershipCurrent: true,
      requiredApprovers: 2,
      canApprove: true,
      canExecute: false,
    });
    expect(approvalViewer.disposition.kind).toBe('authorized_without_approval');
    expect(approvalViewer.approvers).toHaveLength(2);
    expect(approvalViewer.approvers.map(({ actorId }) => actorId).sort()).toEqual([
      'approver-a',
      'approver-b',
    ]);
    expect(approvalViewer.approvers).toEqual(
      expect.arrayContaining([
        { actorId: 'approver-a', issuedAt: first.createdAt, expiresAt: first.expiresAt },
        { actorId: 'approver-b', issuedAt: second.createdAt, expiresAt: second.expiresAt },
      ]),
    );
    expect(approvalViewer).not.toHaveProperty('payload');
    expect(approvalViewer).not.toHaveProperty('reauthenticatedSessionId');
    expect(executorView.disposition.kind).toBe('authorized_without_approval');
    expect(executorView.canExecute).toBe(true);
    expect(approvalEffects([proposal.id])).toEqual(before);
    expect(
      sqlCount(
        'SELECT COUNT(*) AS count FROM proposal_execution_acquisitions WHERE proposal_id = ?',
        proposal.id,
      ),
    ).toBe(0);
  });

  it('reports read-time approval eligibility without accepting ordinary-session proof at approval time', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const ordinarySession: OperationalAuth = {
      method: 'session',
      actorId: 'approver-c',
      sessionId: 'session:approver-c',
    };

    const summary = await readApprovalSummary(proposal.id, 'approver-c', now, currentSpaceId, ordinarySession);
    expect(summary.canApprove).toBe(true);

    await expect(store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'approver-c',
      expiresAt: proposal.expiresAt,
      auth: ordinarySession as unknown as CreateApprovalInput['auth'],
      now,
    })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    expect(await approve(proposal, 'approver-c')).toMatchObject({ actorId: 'approver-c', status: 'active' });
  });

  it('excludes approvals bound to a departed approver period after the same actor rejoins', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const oldApproval = await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');

    const after = '2098-01-01T13:00:00.000Z';
    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: oldApproval.membershipId!,
      now: after,
      auth: auth('owner', after),
    });
    const replacement = governance.addMembership({
      spaceId: fixture.space.id,
      actorId: 'approver-a',
      validFrom: after,
      now: after,
      auth: auth('owner', after),
    });
    for (const resource of currentProposalResources) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'approver-a',
        budgetId,
        membershipId: replacement.id,
        capability: 'categorization:approve',
        ...resource,
        granted: true,
        now: after,
        auth: auth('owner', after),
      });
    }

    const summary = await readApprovalSummary(proposal.id, 'approver-a', after);
    expect(summary.requesterMembershipCurrent).toBe(true);
    expect(summary.requiredApprovers).toBe(2);
    expect(summary.approvers.map(({ actorId }) => actorId).sort()).toEqual([
      'approver-b',
      'approver-c',
    ]);
    expect(summary.canApprove).toBe(true);
    expect(summary.canExecute).toBe(false);
  });

  it('filters expired and stale-policy votes while retaining other current human approvals', async () => {
    const fixture = await setup({
      approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10000', requiredApprovers: 3 }],
      operationApprovers: { set_category: 1 },
    });
    const proposal = await createProposal();
    const currentApproval = await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b', '2098-01-01T12:00:01.000Z');
    const stalePolicyApproval = await approve(proposal, 'approver-c');
    testDatabase()
      .prepare('UPDATE proposal_approvals SET governance_policy_version = ? WHERE id = ?')
      .run('older-policy-version', stalePolicyApproval.id);

    const at = '2098-01-01T13:00:00.000Z';
    const summary = await readApprovalSummary(proposal.id, 'executor', at);
    expect(summary.currentGovernancePolicyVersion).toBe(fixture.policy.version);
    expect(summary.requiredApprovers).toBe(3);
    expect(summary.approvers).toEqual([
      {
        actorId: 'approver-a',
        issuedAt: currentApproval.createdAt,
        expiresAt: currentApproval.expiresAt,
      },
    ]);
    expect(summary.disposition.kind).toBe('approval_required');
    expect(summary.canExecute).toBe(false);
  });

  it('derives current policy quota from complete base and composite facts, not captured versions', async () => {
    const fixture = await setup({
      approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10000', requiredApprovers: 2 }],
      operationApprovers: { set_category: 1 },
    });
    const basePayload = payload();
    const input = proposalInput({
      payload: {
        ...basePayload,
        composite: {
          ...basePayload.composite,
          operations: [
            {
              ...basePayload.composite.operations[2],
              id: 'operation-in-only',
              transactionId: 'txn-in-only',
              amount: amount('1000'),
            },
          ],
          reallocations: [],
          transferRecommendations: [],
          ledgerProjections: [],
          evidenceReferences: [],
        },
      },
    });
    const proposal = await createProposal(input);
    await approve(proposal, 'approver-a');
    const currentPolicy = governance.setPolicy({
      spaceId: fixture.space.id,
      expectedVersion: fixture.policy.version,
      policy: {
        minimumApprovers: 1,
        approvalThresholds: [{ currency: 'USD', amountMinorUnits: '12500', requiredApprovers: 3 }],
        operationApprovers: { set_category: 1 },
      },
      now: after,
      auth: auth('owner', after),
    });

    const summary = await readApprovalSummary(proposal.id, 'executor', after);
    expect(summary.currentGovernancePolicyVersion).toBe(currentPolicy.version);
    expect(summary.requesterMembershipCurrent).toBe(true);
    expect(summary.requiredApprovers).toBe(3);
    expect(summary.approvers).toEqual([]);
    expect(summary.canExecute).toBe(false);
    const approverView = await readApprovalSummary(proposal.id, 'approver-c', after);
    expect(approverView.currentGovernancePolicyVersion).toBe(currentPolicy.version);
    expect(approverView.requiredApprovers).toBe(3);
    expect(approverView.approvers).toEqual([]);
    expect(approverView.canApprove).toBe(false);
  });

  it('allows a proposal-only requester to view only their own current exact summary', async () => {
    const fixture = await setup();
    const ownProposal = await createProposal();
    const ownSummary = await readApprovalSummary(ownProposal.id, 'proposer');
    expect(ownSummary).toMatchObject({
      currentGovernancePolicyVersion: fixture.policy.version,
      requesterMembershipCurrent: true,
      requiredApprovers: 2,
      canApprove: false,
      canExecute: false,
    });
    expect(ownSummary.approvers).toEqual([]);
    expect(ownSummary).not.toHaveProperty('payload');

    const otherProposal = await createProposal(
      proposalInput({ actorId: 'approver-a', auth: auth('approver-a') }),
    );
    await expect(readApprovalSummary(otherProposal.id, 'proposer')).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
  });

  it('never reports an agent-authored proposal as human-approvable', async () => {
    await setup({ operationApprovers: { set_category: 1 } });
    await createProposal();
    const issuerMembershipId = governance.getCurrentMembership({
      spaceId: currentSpaceId,
      actorId: 'owner',
      now,
    })!.id;
    const agent = await bindAgentCredential(
      currentSpaceId,
      issuerMembershipId,
      currentProposalResources,
      ['categorization:propose'],
    );
    const proposal = await createProposal(proposalInput({ actorId: agent.actorId, auth: agent.auth }));

    expect(proposal).toMatchObject({
      actorId: agent.actorId,
      requesterMembershipId: issuerMembershipId,
    });
    expect(proposal).not.toHaveProperty('requesterDelegationId');
    expect(proposal).not.toHaveProperty('requesterDelegationVersion');
    expect(testDatabase().prepare(
      'SELECT requester_delegation_id, requester_delegation_version FROM action_proposals WHERE id = ?',
    ).get(proposal.id)).toMatchObject({
      requester_delegation_id: agent.delegation.id,
      requester_delegation_version: agent.delegation.version,
    });
    const summary = await readApprovalSummary(proposal.id, agent.actorId, now, currentSpaceId, agent.auth);
    expect(summary.canApprove).toBe(false);
    await expect(store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: agent.actorId,
      expiresAt: proposal.expiresAt,
      auth: auth(agent.actorId),
      now,
    })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
  });

  it('requires current read authority in the selected space before returning a summary', async () => {
    const fixture = await setup();
    const proposal = await createProposal();
    const foreignSpace = governance.createSpace({
      actorId: 'owner',
      name: 'Unselected budget scope',
      kind: 'shared',
      now,
      auth: auth('owner'),
    });

    await identity('reader');
    const readerMembership = governance.addMembership({
      spaceId: fixture.space.id,
      actorId: 'reader',
      validFrom: now,
      now,
      auth: auth('owner'),
    });
    await expect(readApprovalSummary(proposal.id, 'approver-a', now, foreignSpace.id)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(readApprovalSummary(proposal.id, 'reader')).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(readApprovalSummary(proposal.id, 'unknown-reader')).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });

    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'reader',
      budgetId,
      membershipId: readerMembership.id,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      now,
      auth: auth('owner'),
    });
    await expect(readApprovalSummary(proposal.id, 'reader')).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'reader',
      budgetId,
      membershipId: readerMembership.id,
      capability: 'full-read',
      resourceKind: 'evidence',
      resourceId: 'receipt-1',
      granted: true,
      now,
      auth: auth('owner'),
    });
    const readOnlySummary = await readApprovalSummary(proposal.id, 'reader');
    expect(readOnlySummary).toMatchObject({ canApprove: false, canExecute: false });
    expect(readOnlySummary.disposition.kind).toBe('approval_required');
    expect(readOnlySummary).not.toHaveProperty('payload');
  });

  it('denies private proposal-view admission to aggregate-only and disjoint full-read grants', async () => {
    const fixture = await setup();
    const proposal = await createProposal();
    const deniedReaders = [
      { actorId: 'aggregate-reader', restrictions: { aggregateOnly: true } },
      { actorId: 'disjoint-reader', restrictions: { accountIds: ['acct-other'], categoryIds: ['cat-other'] } },
    ];

    for (const reader of deniedReaders) {
      await identity(reader.actorId);
      const membership = governance.addMembership({
        spaceId: fixture.space.id,
        actorId: reader.actorId,
        validFrom: now,
        now,
        auth: auth('owner'),
      });
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: reader.actorId,
        budgetId,
        membershipId: membership.id,
        capability: 'full-read',
        resourceKind: 'budget',
        resourceId: budgetId,
        restrictions: reader.restrictions,
        granted: true,
        now,
        auth: auth('owner'),
      });
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: reader.actorId,
        budgetId,
        membershipId: membership.id,
        capability: 'full-read',
        resourceKind: 'evidence',
        resourceId: 'receipt-1',
        granted: true,
        now,
        auth: auth('owner'),
      });

      const denied = await readApprovalSummary(proposal.id, reader.actorId).catch((error: unknown) => error);
      expect(denied).toMatchObject({ reasonCode: 'authorization_denied' });
      expect(JSON.stringify(denied)).not.toContain('acct-source');
      expect(JSON.stringify(denied)).not.toContain('cat-food');
    }

    await identity('exact-private-reader');
    const exactMembership = governance.addMembership({
      spaceId: fixture.space.id,
      actorId: 'exact-private-reader',
      validFrom: now,
      now,
      auth: auth('owner'),
    });
    for (const resource of currentProposalResources) {
      if (resource.resourceKind === 'budget') continue;
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'exact-private-reader',
        budgetId,
        membershipId: exactMembership.id,
        capability: 'full-read',
        ...resource,
        granted: true,
        now,
        auth: auth('owner'),
      });
    }

    const exactRead = await readApprovalSummary(proposal.id, 'exact-private-reader');
    expect(exactRead).toMatchObject({ canApprove: false, canExecute: false });
    expect(exactRead).not.toHaveProperty('payload');
  });

  it('checks budget full-read operation-count and gross limits against complete proposal facts', async () => {
    const fixture = await setup();
    const proposal = await createProposal();
    const readers = [
      { actorId: 'count-limited-reader', restrictions: { maxOperationCount: 1 } },
      {
        actorId: 'gross-limited-reader',
        restrictions: { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '1' }] },
      },
    ];

    for (const reader of readers) {
      await identity(reader.actorId);
      const membership = governance.addMembership({
        spaceId: fixture.space.id,
        actorId: reader.actorId,
        validFrom: now,
        now,
        auth: auth('owner'),
      });
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: reader.actorId,
        budgetId,
        membershipId: membership.id,
        capability: 'full-read',
        resourceKind: 'budget',
        resourceId: budgetId,
        restrictions: reader.restrictions,
        granted: true,
        now,
        auth: auth('owner'),
      });
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: reader.actorId,
        budgetId,
        membershipId: membership.id,
        capability: 'full-read',
        resourceKind: 'evidence',
        resourceId: 'receipt-1',
        granted: true,
        now,
        auth: auth('owner'),
      });

      await expect(readApprovalSummary(proposal.id, reader.actorId)).rejects.toMatchObject({
        reasonCode: 'authorization_denied',
      });
    }
  });

  it('rejects summaries for legacy proposals without current governance provenance', async () => {
    await setup();
    const proposal = await createProposal();
    testDatabase()
      .prepare(
        'UPDATE action_proposals SET requester_membership_id = NULL, governance_policy_version = NULL WHERE id = ?',
      )
      .run(proposal.id);

    await expect(readApprovalSummary(proposal.id, 'approver-a')).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
  });

  it('rejects summaries after a requester leaves and rejoins under a new membership period', async () => {
    const fixture = await setup();
    const proposal = await createProposal();
    const requesterMembershipId = proposal.requesterMembershipId;
    if (!requesterMembershipId) throw new Error('Fixture proposal has no requester membership');

    const after = '2098-01-01T13:00:00.000Z';
    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: requesterMembershipId,
      now: after,
      auth: auth('owner', after),
    });
    governance.addMembership({
      spaceId: fixture.space.id,
      actorId: 'proposer',
      validFrom: after,
      now: after,
      auth: auth('owner', after),
    });

    await expect(readApprovalSummary(proposal.id, 'approver-a', after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
  });

  it('hashes the complete generic/composite envelope and binds its server-owned membership and policy versions', async () => {
    const fixture = await setup();
    const input = proposalInput();
    const proposal = await createProposal(input);

    expect(proposal.governancePolicyVersion).toBe(fixture.policy.version);
    expect(proposal.requesterMembershipId).toBe(fixture.membershipIds.proposer);
    const approval = await approve(proposal, 'approver-a');
    expect(approval.membershipId).toBe(fixture.membershipIds['approver-a']);
    expect(approval.governancePolicyVersion).toBe(fixture.policy.version);

    const base = {
      operation: input.operation,
      budgetId: input.budgetId,
      payload: input.payload,
      preconditions: JSON.parse(input.preconditions),
      actorId: input.actorId,
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt,
    };
    const composite = input.payload.composite;
    const originalPlan = transferPlan();
    const changedPlan: TransferPlan = {
      ...originalPlan,
      legs: originalPlan.legs.map((leg) => ({ ...leg, amount: amount('21') })),
    };
    const variants = [
      { ...base, operation: 'create_rule' },
      { ...base, budgetId: 'another-budget' },
      { ...base, actorId: 'another-requester' },
      { ...base, policyVersion: 'financial-policy-2' },
      { ...base, expiresAt: '2099-01-02T00:00:00.000Z' },
      { ...base, preconditions: { ...base.preconditions, accountId: 'acct-destination' } },
      { ...base, preconditions: { ...base.preconditions, amount: amount('12501') } },
      {
        ...base,
        payload: { ...input.payload, categoryId: 'cat-other' },
      },
      {
        ...base,
        payload: {
          ...input.payload,
          composite: {
            ...composite,
            operations: composite.operations.map((operation, index) =>
              index === 0 ? { ...operation, amount: amount('7001') } : operation,
            ),
          },
        },
      },
      {
        ...base,
        payload: {
          ...input.payload,
          composite: {
            ...composite,
            reallocations: [{ ...reallocation, amount: amount('2501') }],
          },
        },
      },
      {
        ...base,
        payload: {
          ...input.payload,
          composite: { ...composite, transferRecommendations: [changedPlan] },
        },
      },
      {
        ...base,
        payload: {
          ...input.payload,
          composite: {
            ...composite,
            ledgerProjections: composite.ledgerProjections.map((projection) => ({
              ...projection,
              amount: amount('12501'),
            })),
          },
        },
      },
      {
        ...base,
        payload: {
          ...input.payload,
          composite: {
            ...composite,
            evidenceReferences: composite.evidenceReferences.map((reference) => ({
              ...reference,
              evidenceId: 'receipt-changed',
            })),
          },
        },
      },
      {
        ...base,
        payload: {
          ...input.payload,
          composite: { ...composite, nativePayloadHash: 'b'.repeat(64) },
        },
      },
    ];
    const canonical = canonicalProposalHash(base);
    for (const variant of variants) expect(canonicalProposalHash(variant)).not.toBe(canonical);
  });

  it('requires distinct approvals to satisfy the operation threshold before one executor can acquire', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const first = await approve(proposal, 'approver-a');
    const second = await approve(proposal, 'approver-b');

    const acquired = await store.acquireProposalExecution(acquisitionInput(proposal));
    expect(acquired.claim.isOwner).toBe(true);
    expect(acquired.approvals.map(({ actorId }) => actorId)).toEqual(
      expect.arrayContaining([first.actorId, second.actorId]),
    );
    expect(acquired.auditRecord).not.toBeNull();
  });

  it('uses the bound gross USD outgoing amount, not an incoming net, to require the amount threshold', async () => {
    await setup({
      operationApprovers: { set_category: 1 },
      approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10000', requiredApprovers: 2 }],
    });
    const proposal = await createProposal();
    await approve(proposal, 'approver-a');

    await expect(store.acquireProposalExecution(acquisitionInput(proposal))).rejects.toMatchObject({
      reasonCode: 'approval_required',
    });
    expect(await store.getIdempotencyRecord('execute:exact-proposal')).toBeNull();

    await approve(proposal, 'approver-b');
    const acquired = await store.acquireProposalExecution(acquisitionInput(proposal));
    expect(acquired.claim.isOwner).toBe(true);
  });
  it('rejects an incomplete composite that omits its server-derived base transaction', async () => {
    await setup({
      operationApprovers: {},
      approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10000', requiredApprovers: 2 }],
    });
    const transactionId = 'txn-incomplete-composite';
    const sparsePayload: CreateProposalInput['payload'] = {
      kind: 'set_category',
      transactionId,
      categoryId: 'cat-food',
      composite: {
        operations: [{ operation: 'set_category' }],
        reallocations: [],
        transferRecommendations: [],
        ledgerProjections: [],
        evidenceReferences: [],
      },
    };

    await expect(createProposal(proposalInput({ payload: sparsePayload }))).rejects.toThrow();
    expect(await store.countProposals({ budgetId })).toBe(0);
  });

  it('retains omitted base outgoing facts for threshold and gross-limit authorization', async () => {
    const fixture = await setup({
      operationApprovers: {},
      approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10000', requiredApprovers: 2 }],
    });
    const transactionId = 'txn-base-financial-facts';
    const additionalPayload: CreateProposalInput['payload'] = {
      kind: 'set_category',
      transactionId,
      categoryId: 'cat-food',
      composite: {
        operations: [{
          operation: 'set_category',
          transactionId: 'txn-additional',
          accountId: 'acct-source',
          categoryId: 'cat-food',
          direction: 'outgoing',
          amount: amount('1000'),
          currentCategoryId: null,
          actualVersion: 'actual-v1',
        }],
        reallocations: [],
        transferRecommendations: [],
        ledgerProjections: [],
        evidenceReferences: [],
      },
    };
    const input = proposalInput({ payload: additionalPayload });
    const facts = deriveProposalAuthorizationFacts(input.operation, input.payload, JSON.parse(input.preconditions) as unknown);
    expect(facts.operations).toHaveLength(2);
    expect(facts.operations.map((operation) => operation.amount?.minorUnits).sort())
      .toEqual(['1000', '12500']);

    const proposal = await createProposal(input);
    await approve(proposal, 'approver-a');
    await expect(store.acquireProposalExecution(acquisitionInput(proposal))).rejects.toMatchObject({
      reasonCode: 'approval_required',
    });
    await approve(proposal, 'approver-b');
    for (const resource of currentProposalResources) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'executor',
        budgetId,
        membershipId: fixture.membershipIds.executor!,
        capability: 'categorization:execute',
        ...resource,
        granted: true,
        restrictions: { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '12000' }] },
        now,
        auth: auth('owner'),
      });
    }
    await expect(store.acquireProposalExecution(acquisitionInput(proposal, {
      idempotencyKey: 'execute:base-gross-limit',
    }))).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
  });


  it('admits Native categorization with amount-free evidence without counting it as cash flow', async () => {
    await setup({ operationApprovers: { set_category: 1 } });
    const transactionId = 'txn-evidence-without-amount';
    const originalPayload = payload(transactionId);
    const proposalPayload: CreateProposalInput['payload'] = {
      ...originalPayload,
      composite: {
        ...originalPayload.composite,
        evidenceReferences: [{
          evidenceId: 'receipt-1',
          kind: 'receipt',
          authorized: true,
          redaction: 'visible',
          documentDigest: 'receipt-digest-1',
        }],
      },
    };
    const input = proposalInput({ payload: proposalPayload });
    const facts = deriveProposalAuthorizationFacts(
      input.operation,
      input.payload,
      JSON.parse(input.preconditions) as unknown,
    );
    const evidenceOperation = facts.operations.find(({ operation }) => operation === 'evidence_reference');

    expect(facts.resources).toContainEqual({ resourceKind: 'evidence', resourceId: 'receipt-1' });
    expect(facts.operations).toHaveLength(7);
    expect(evidenceOperation).toMatchObject({ operation: 'evidence_reference', evidenceId: 'receipt-1' });
    expect(evidenceOperation).not.toHaveProperty('direction');
    expect(evidenceOperation).not.toHaveProperty('amount');

    const proposal = await createProposal(input);
    expect(proposal.operation).toBe('set_category');
    expect(currentProposalResources).toContainEqual({ resourceKind: 'evidence', resourceId: 'receipt-1' });
  });

  it('still denies an outgoing monetary projection without its amount', async () => {
    await setup({ operationApprovers: { set_category: 1 } });
    const transactionId = 'txn-missing-projection-amount';
    const originalPayload = payload(transactionId);
    const proposalPayload: CreateProposalInput['payload'] = {
      ...originalPayload,
      composite: {
        ...originalPayload.composite,
        ledgerProjections: [{
          id: 'projection-without-amount',
          transactionId,
          accountId: 'acct-source',
          categoryId: 'cat-food',
          expectedCategoryId: null,
          actualVersion: 'actual-v1',
        }],
        evidenceReferences: [{
          evidenceId: 'receipt-1',
          kind: 'receipt',
          authorized: true,
          redaction: 'visible',
          documentDigest: 'receipt-digest-1',
        }],
      },
    };

    await expect(createProposal(proposalInput({ payload: proposalPayload })))
      .rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.countProposals({ budgetId })).toBe(0);
  });

  it('rejects gross outgoing totals that overflow the signed ledger amount boundary', async () => {
    await setup({ operationApprovers: { set_category: 1 } });
    const transactionId = 'txn-overflow';
    const proposalPayload = payload(transactionId);
    const maximum = '9223372036854775807';
    proposalPayload.composite.operations[0]!.amount = amount(maximum);
    proposalPayload.composite.ledgerProjections[0]!.amount = amount(maximum);
    const preconditions = JSON.stringify({
      transactionId,
      accountId: 'acct-source',
      amount: amount(maximum),
      direction: 'outgoing',
      currentCategoryId: null,
      actualVersion: 'actual-v1',
    });

    await expect(createProposal(proposalInput({ payload: proposalPayload, preconditions })))
      .rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.countProposals({ budgetId })).toBe(0);
  });

  it('lists and counts proposals using their current budget and lifecycle filters', async () => {
    await setup({ operationApprovers: { set_category: 1 } });
    const active = await createProposal(proposalInput({ payload: payload('txn-list-active') }));
    const superseded = await createProposal(proposalInput({ payload: payload('txn-list-superseded') }));
    await store.supersedeProposal(superseded.id);

    expect(await store.countProposals({ budgetId, operations: ['set_category'] })).toBe(2);
    expect(await store.countProposals({
      budgetId,
      operations: ['set_category'],
      superseded: false,
    })).toBe(1);
    expect(await store.listProposals({
      budgetId,
      operations: ['set_category'],
      superseded: false,
    }).then((proposals) => proposals.map(({ id }) => id))).toEqual([active.id]);
    expect(await store.listProposals({
      budgetId,
      operations: ['set_category'],
      superseded: true,
    }).then((proposals) => proposals.map(({ id }) => id))).toEqual([superseded.id]);
  });

  it('keeps proposer, approver, and executor grants separate', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();

    await expect(
      store.createApproval({
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        actorId: 'proposer',
        expiresAt: proposal.expiresAt,
        auth: auth('proposer'),
        now,
      }),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, { actorId: 'approver-a', auth: auth('approver-a') }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, { actorId: 'proposer', auth: auth('proposer') }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, { actorId: 'owner', auth: auth('owner') }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
  });

  it('allows an independently bound agent to execute only the exact human-approved proposal', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const { proposal, approvals } = await createHumanApprovedProposal();
    const agent = await bindAgentCredential(
      fixture.space.id,
      fixture.membershipIds.owner!,
    );

    expect(
      governance.resolveCredentialPrincipal({
        credentialId: agent.credentialId,
        referenceId: 'owner',
        now,
      }),
    ).toMatchObject({
      principalType: 'agent',
      actorId: agent.actorId,
      credentialOwnerId: 'owner',
      delegationId: agent.delegation.id,
      delegationVersion: agent.delegation.version,
    });
    await expect(
      store.createApproval({
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        actorId: agent.actorId,
        expiresAt: proposal.expiresAt,
        auth: auth(agent.actorId),
        now,
      }),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(() =>
      governance.setPolicy({
        spaceId: fixture.space.id,
        expectedVersion: fixture.policy.version,
        policy: {
          minimumApprovers: 1,
          approvalThresholds: [],
          operationApprovers: { set_category: 2 },
        },
        now,
        auth: auth(agent.actorId),
      }),
    ).toThrow();

    const settlementRight = {
      capability: 'confirmation',
      resourceKind: 'budget' as const,
      resourceId: budgetId,
    };
    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'owner',
      budgetId,
      membershipId: fixture.membershipIds.owner!,
      ...settlementRight,
      granted: true,
      now,
      auth: auth('owner'),
    });
    expect(() =>
      governance.delegate({
        spaceId: fixture.space.id,
        agentId: agent.actorId,
        issuerMembershipId: fixture.membershipIds.owner!,
        expectedVersion: null,
        rights: [settlementRight],
        validFrom: now,
        validUntil: '2098-01-02T12:00:00.000Z',
        now,
        auth: auth('owner'),
      }),
    ).toThrow();

    testDatabase().prepare('UPDATE agent_delegations SET rights=? WHERE id=? AND version=?')
      .run(JSON.stringify([settlementRight]), agent.delegation.id, agent.delegation.version);
    expect(
      governance.authorize({
        actorId: agent.actorId,
        agentId: agent.actorId,
        delegationId: agent.delegation.id,
        delegationVersion: agent.delegation.version,
        spaceId: fixture.space.id,
        expectedPolicyVersion: fixture.policy.version,
        phase: 'execute',
        operation: 'transfer',
        required: [settlementRight],
        now,
        payload: {
          operations: [
            { operation: 'transfer', direction: 'outgoing', amount: amount('20') },
          ],
        },
        auth: agent.auth,
        verifiedHumanApproval: true,
      }).disposition.kind,
    ).toBe('denied');
    testDatabase().prepare('UPDATE agent_delegations SET rights=? WHERE id=? AND version=?')
      .run(JSON.stringify(agent.delegation.rights), agent.delegation.id, agent.delegation.version);


    const summary = await store.getProposalApprovalSummary({
      proposalId: proposal.id,
      spaceId: fixture.space.id,
      actorId: agent.actorId,
      auth: agent.auth,
      requestId: 'agent-proposal-read',
      now,
    });
    expect(summary).toMatchObject({
      executionAuthorized: true,
      approvalAuthorized: false,
      privateEnvelopeVisible: false,
      canExecute: true,
      canApprove: false,
    });
    const admission = (await store.queryAuditRecordsByProposal(proposal.id))
      .find((record) => record.classification === 'authorization_check' && record.requestId === 'agent-proposal-read');
    expect(admission).toMatchObject({
      actorId: agent.actorId,
      budgetId,
      payloadHash: proposal.payloadHash,
      requestId: 'agent-proposal-read',
      correlationId: 'agent-proposal-read',
      policyVersion: fixture.policy.version,
    });
    expect(JSON.parse(admission?.result ?? '{}')).toMatchObject({
      kind: 'proposal_read_admission',
      spaceId: fixture.space.id,
      membershipId: agent.delegation.issuerMembershipId,
      delegationId: agent.delegation.id,
      delegationVersion: agent.delegation.version,
    });
    expect(JSON.stringify(admission)).not.toContain(agent.auth.credentialId);
    expect(admission?.backendIds).toBe('[]');

    const acquired = await store.acquireProposalExecution(
      acquisitionInput(proposal, { actorId: agent.actorId, auth: agent.auth }),
    );
    expect(acquired.claim.isOwner).toBe(true);
    expect(acquired.approvals.map(({ actorId }) => actorId)).toEqual(
      expect.arrayContaining(approvals.map(({ actorId }) => actorId)),
    );
    expect(acquired.auditRecord).toMatchObject({ actorId: agent.actorId });
  });

  it('keeps the unchanged original agent delegation eligible to acquire its proposal', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 1 } });
    const { agent, proposal } = await createAgentOriginProposal(fixture.space.id, fixture.membershipIds.owner!);
    const approval = await approve(proposal, 'approver-a');

    const acquired = await store.acquireProposalExecution(
      acquisitionInput(proposal, { actorId: agent.actorId, auth: agent.auth }),
    );

    expect(proposal).toMatchObject({ requesterMembershipId: fixture.membershipIds.owner });
    expect(testDatabase().prepare(
      'SELECT requester_delegation_id, requester_delegation_version FROM action_proposals WHERE id = ?',
    ).get(proposal.id)).toMatchObject({
      requester_delegation_id: agent.delegation.id,
      requester_delegation_version: agent.delegation.version,
    });
    expect(acquired.claim.isOwner).toBe(true);
    expect(acquired.approvals.map(({ id }) => id)).toContain(approval.id);
  });

  it('denies approval, view, and acquisition after the original delegation is replaced by a new version', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 1 } });
    const { agent, proposal } = await createAgentOriginProposal(fixture.space.id, fixture.membershipIds.owner!);
    const originalApproval = await approve(proposal, 'approver-a');
    const alternateDelegation = governance.delegate({
      spaceId: fixture.space.id,
      agentId: agent.actorId,
      issuerMembershipId: fixture.membershipIds.owner!,
      expectedVersion: null,
      rights: agent.rights,
      validFrom: now,
      validUntil: '2098-01-03T12:00:00.000Z',
      now,
      auth: auth('owner'),
    });
    const alternateCredentialId = `${agent.credentialId}:alternate`;
    governance.registerCredentialBinding({
      spaceId: fixture.space.id,
      credentialId: alternateCredentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agent.actorId,
      delegationId: alternateDelegation.id,
      expectedDelegationVersion: alternateDelegation.version,
      now,
      auth: auth('owner'),
    });
    const alternateAuth: OperationalAuth = {
      method: 'api-key',
      actorId: agent.actorId,
      credentialId: alternateCredentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent',
      delegationId: alternateDelegation.id,
      delegationVersion: alternateDelegation.version,
    };
    await expect(readApprovalSummary(
      proposal.id,
      agent.actorId,
      now,
      fixture.space.id,
      alternateAuth,
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    await expect(store.acquireProposalExecution(
      acquisitionInput(proposal, {
        actorId: agent.actorId,
        auth: alternateAuth,
        idempotencyKey: 'execute:alternate-delegation',
      }),
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    const replacement = governance.delegate({
      id: agent.delegation.id,
      spaceId: fixture.space.id,
      agentId: agent.actorId,
      issuerMembershipId: fixture.membershipIds.owner!,
      expectedVersion: agent.delegation.version,
      rights: agent.rights,
      validFrom: after,
      validUntil: '2098-01-03T12:00:00.000Z',
      now: after,
      auth: auth('owner', after),
    });
    const replacementCredentialId = `${agent.credentialId}:replacement`;
    governance.registerCredentialBinding({
      spaceId: fixture.space.id,
      credentialId: replacementCredentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agent.actorId,
      delegationId: replacement.id,
      expectedDelegationVersion: replacement.version,
      now: after,
      auth: auth('owner', after),
    });
    const replacementAuth: OperationalAuth = {
      method: 'api-key',
      actorId: agent.actorId,
      credentialId: replacementCredentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent',
      delegationId: replacement.id,
      delegationVersion: replacement.version,
    };

    await expect(approve(proposal, 'approver-b', proposal.expiresAt, after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(readApprovalSummary(proposal.id, 'approver-c', after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(store.acquireProposalExecution(
      acquisitionInput(proposal, {
        actorId: agent.actorId,
        auth: replacementAuth,
        idempotencyKey: 'execute:replacement-delegation',
        now: after,
      }),
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    expect((await store.getApproval(originalApproval.id))?.status).toBe('active');
    expect(await store.getIdempotencyRecord('execute:replacement-delegation')).toBeNull();
  });

  it('rechecks the original issuer right before approval, private view, and acquisition', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 1 } });
    const { agent, proposal } = await createAgentOriginProposal(fixture.space.id, fixture.membershipIds.owner!);
    const originalApproval = await approve(proposal, 'approver-a');

    for (const resource of currentProposalResources) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'owner',
        budgetId,
        membershipId: fixture.membershipIds.owner!,
        capability: 'categorization:propose',
        ...resource,
        granted: false,
        now: after,
        auth: auth('owner', after),
      });
    }

    await expect(approve(proposal, 'approver-b', proposal.expiresAt, after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(readApprovalSummary(proposal.id, 'approver-c', after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(store.acquireProposalExecution(
      acquisitionInput(proposal, {
        actorId: agent.actorId,
        auth: agent.auth,
        idempotencyKey: 'execute:issuer-propose-right-revoked',
        now: after,
      }),
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    expect((await store.getApproval(originalApproval.id))?.status).toBe('active');
    expect(await store.getIdempotencyRecord('execute:issuer-propose-right-revoked')).toBeNull();
  });

  it('rechecks the original human requester proposal grant before approval and acquisition', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 1 } });
    const proposal = await createProposal();
    const originalApproval = await approve(proposal, 'approver-a');

    for (const resource of currentProposalResources) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'proposer',
        budgetId,
        membershipId: fixture.membershipIds.proposer!,
        capability: 'categorization:propose',
        ...resource,
        granted: false,
        now: after,
        auth: auth('owner', after),
      });
    }

    await expect(approve(proposal, 'approver-b', proposal.expiresAt, after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(store.acquireProposalExecution(
      acquisitionInput(proposal, {
        actorId: 'executor',
        auth: auth('executor', after),
        idempotencyKey: 'execute:human-proposer-right-revoked',
        now: after,
      }),
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    expect((await store.getApproval(originalApproval.id))?.status).toBe('active');
    expect(await store.getIdempotencyRecord('execute:human-proposer-right-revoked')).toBeNull();
  });

  it('rejects approval, private view, and acquisition after the original issuer membership ends', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 1 } });
    const { agent, proposal } = await createAgentOriginProposal(fixture.space.id, fixture.membershipIds.owner!);
    await approve(proposal, 'approver-a');
    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: fixture.membershipIds.owner!,
      now: after,
      auth: auth('owner', after),
    });

    await expect(approve(proposal, 'approver-b', proposal.expiresAt, after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(readApprovalSummary(proposal.id, 'approver-c', after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(store.acquireProposalExecution(
      acquisitionInput(proposal, {
        actorId: agent.actorId,
        auth: agent.auth,
        idempotencyKey: 'execute:departed-original-issuer',
        now: after,
      }),
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:departed-original-issuer')).toBeNull();
  });

  it('does not admit an ambiguous legacy agent proposal without its original delegation', async () => {
    await setup({ operationApprovers: { set_category: 1 } });
    const proposal = await createProposal();
    const legacyAgentId = 'agent:legacy-ambiguous';
    const changedHash = canonicalProposalHash({
      operation: proposal.operation,
      budgetId: proposal.budgetId,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions) as unknown,
      actorId: legacyAgentId,
      policyVersion: proposal.policyVersion,
      expiresAt: proposal.expiresAt,
    });
    testDatabase().prepare('UPDATE action_proposals SET actor_id=?,payload_hash=? WHERE id=?')
      .run(legacyAgentId, changedHash, proposal.id);

    await expect(readApprovalSummary(proposal.id, 'approver-c')).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(store.createApproval({
      proposalId: proposal.id,
      payloadHash: changedHash,
      actorId: 'approver-a',
      expiresAt: proposal.expiresAt,
      auth: auth('approver-a'),
      now,
    })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    await expect(store.acquireProposalExecution(
      acquisitionInput(proposal, { payloadHash: changedHash, idempotencyKey: 'execute:ambiguous-legacy' }),
    )).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
  });

  it('rejects a revoked agent key without falling back to its human credential owner', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const { proposal, approvals } = await createHumanApprovedProposal();
    const agent = await bindAgentCredential(fixture.space.id, fixture.membershipIds.owner!);
    governance.revokeCredentialBinding({
      credentialId: agent.credentialId,
      spaceId: fixture.space.id,
      now: after,
      auth: auth('owner', after),
    });

    expect(
      governance.resolveCredentialPrincipal({
        credentialId: agent.credentialId,
        referenceId: 'owner',
        now: after,
      }),
    ).toBeNull();
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          actorId: agent.actorId,
          auth: agent.auth,
          idempotencyKey: 'execute:revoked-agent-key',
          now: after,
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:revoked-agent-key')).toBeNull();
    for (const approval of approvals) {
      expect((await store.getApproval(approval.id))?.status).toBe('active');
    }
  });

  it('rejects an agent delegation that omits a required composite resource', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const { proposal } = await createHumanApprovedProposal();
    const delegatedResources = currentProposalResources.filter(
      (resource) => resource.resourceId !== 'acct-destination',
    );
    const agent = await bindAgentCredential(
      fixture.space.id,
      fixture.membershipIds.owner!,
      delegatedResources,
    );

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          actorId: agent.actorId,
          auth: agent.auth,
          idempotencyKey: 'execute:agent-out-of-scope',
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:agent-out-of-scope')).toBeNull();
  });

  it('rejects an agent key bound to a superseded delegation version', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const { proposal } = await createHumanApprovedProposal();
    const agent = await bindAgentCredential(fixture.space.id, fixture.membershipIds.owner!);
    const renewed = governance.delegate({
      spaceId: fixture.space.id,
      agentId: agent.actorId,
      id: agent.delegation.id,
      issuerMembershipId: fixture.membershipIds.owner!,
      expectedVersion: agent.delegation.version,
      rights: agent.rights,
      validFrom: after,
      validUntil: '2098-01-03T12:00:00.000Z',
      now: after,
      auth: auth('owner', after),
    });
    expect(renewed.version).not.toBe(agent.delegation.version);
    expect(
      governance.resolveCredentialPrincipal({
        credentialId: agent.credentialId,
        referenceId: 'owner',
        now: after,
      }),
    ).toBeNull();

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          actorId: agent.actorId,
          auth: agent.auth,
          idempotencyKey: 'execute:stale-delegation-version',
          now: after,
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:stale-delegation-version')).toBeNull();
  });

  it('rejects delegated execution after the issuer membership ends', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const { proposal } = await createHumanApprovedProposal();
    const agent = await bindAgentCredential(fixture.space.id, fixture.membershipIds.owner!);
    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: fixture.membershipIds.owner!,
      now: after,
      auth: auth('owner', after),
    });

    expect(
      governance.resolveCredentialPrincipal({
        credentialId: agent.credentialId,
        referenceId: 'owner',
        now: after,
      }),
    ).toBeNull();
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          actorId: agent.actorId,
          auth: agent.auth,
          idempotencyKey: 'execute:departed-issuer',
          now: after,
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:departed-issuer')).toBeNull();
  });

  it('intersects delegation rights with the issuer current resource grants', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const { proposal } = await createHumanApprovedProposal();
    const agent = await bindAgentCredential(fixture.space.id, fixture.membershipIds.owner!);
    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'owner',
      budgetId,
      membershipId: fixture.membershipIds.owner!,
      capability: 'categorization:execute',
      resourceKind: 'account',
      resourceId: 'acct-destination',
      granted: false,
      now: after,
      auth: auth('owner', after),
    });

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          actorId: agent.actorId,
          auth: agent.auth,
          idempotencyKey: 'execute:issuer-grant-revoked',
          now: after,
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:issuer-grant-revoked')).toBeNull();
  });

  it('requires the displayed exact hash for approval and rejects a hint from another proposal', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    await expect(
      store.createApproval({
        proposalId: proposal.id,
        payloadHash: 'f'.repeat(64),
        actorId: 'approver-a',
        expiresAt: proposal.expiresAt,
        auth: auth('approver-a'),
        now,
      }),
    ).rejects.toMatchObject({ reasonCode: 'payload_hash_mismatch' });

    const other = await createProposal(proposalInput({
      payload: payload('txn-other-proposal'),
      preconditions: JSON.stringify({
        transactionId: 'txn-other-proposal',
        accountId: 'acct-source',
        amount: amount('12500'),
        direction: 'outgoing',
        currentCategoryId: null,
        actualVersion: 'actual-v1',
      }),
    }));
    const foreignApproval = await approve(other, 'approver-a');
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, { approvalId: foreignApproval.id }),
      ),
    ).rejects.toThrow();
    expect(await store.getIdempotencyRecord('execute:exact-proposal')).toBeNull();
  });

  it('recomputes the full stored hash at approval and acquisition rather than trusting the saved hash', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const tamperedAtApproval = await createProposal();
    const changedAtApproval = payload();
    changedAtApproval.composite.evidenceReferences[0] = {
      ...changedAtApproval.composite.evidenceReferences[0]!,
      evidenceId: 'substituted-receipt',
    };
    updateStoredPayload(tamperedAtApproval.id, changedAtApproval);
    await expect(approve(tamperedAtApproval, 'approver-a')).rejects.toMatchObject({
      reasonCode: 'payload_hash_mismatch',
    });

    const tamperedAtAcquisition = await createProposal(proposalInput({
      payload: payload('txn-acquire-tamper'),
      preconditions: JSON.stringify({
        transactionId: 'txn-acquire-tamper',
        accountId: 'acct-source',
        direction: 'outgoing',
        amount: amount('12500'),
        currentCategoryId: null,
        actualVersion: 'actual-v1',
      }),
    }));
    const first = await approve(tamperedAtAcquisition, 'approver-a');
    const second = await approve(tamperedAtAcquisition, 'approver-b');
    updateStoredPreconditions(tamperedAtAcquisition.id, {
      transactionId: 'txn-acquire-tamper',
      accountId: 'acct-source',
      amount: amount('1'),
      currentCategoryId: null,
      actualVersion: 'actual-v1',
    });

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(tamperedAtAcquisition, { idempotencyKey: 'execute:tampered-envelope' }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'payload_hash_mismatch' });
    expect((await store.getApproval(first.id))?.status).toBe('active');
    expect((await store.getApproval(second.id))?.status).toBe('active');
    expect(await store.getIdempotencyRecord('execute:tampered-envelope')).toBeNull();
  });

  it('does not revive an approval from a departed membership period after the same actor rejoins', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 3 } });
    const proposal = await createProposal();
    const oldMembershipId = fixture.membershipIds['approver-a']!;
    const oldApproval = await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');

    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: oldMembershipId,
      now: after,
      auth: auth('owner', after),
    });
    const replacement = governance.addMembership({
      spaceId: fixture.space.id,
      actorId: 'approver-a',
      validFrom: after,
      now: after,
      auth: auth('owner', after),
    });
    for (const resource of currentProposalResources) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'approver-a',
        budgetId,
        membershipId: replacement.id,
        capability: 'categorization:approve',
        ...resource,
        granted: true,
        now: after,
        auth: auth('owner', after),
      });
    }

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          idempotencyKey: 'execute:after-rejoin',
          now: after,
          auth: auth('executor', after),
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'approval_required' });
    expect((await store.getApproval(oldApproval.id))?.actorId).toBe('approver-a');
    expect((await store.getApproval(oldApproval.id))?.status).toBe('active');
    expect(await store.getIdempotencyRecord('execute:after-rejoin')).toBeNull();
  });

  it('denies acquisition when the executor grant is revoked after approval', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const first = await approve(proposal, 'approver-a');
    const second = await approve(proposal, 'approver-b');

    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'executor',
      budgetId,
      membershipId: fixture.membershipIds.executor!,
      capability: 'categorization:execute',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: after,
      auth: auth('owner', after),
    });

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          idempotencyKey: 'execute:revoked-executor',
          now: after,
          auth: auth('executor', after),
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    expect(await store.getIdempotencyRecord('execute:revoked-executor')).toBeNull();
    expect((await store.getApproval(first.id))?.status).toBe('active');
    expect((await store.getApproval(second.id))?.status).toBe('active');
  });

  it('rejects stale governance policy versions before claiming idempotency or consuming approvals', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const first = await approve(proposal, 'approver-a');
    const second = await approve(proposal, 'approver-b');
    const current = governance.setPolicy({
      spaceId: fixture.space.id,
      expectedVersion: fixture.policy.version,
      policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: { set_category: 2 } },
      now: after,
      auth: auth('owner', after),
    });

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, {
          governancePolicyVersion: current.version,
          idempotencyKey: 'execute:stale-policy',
          now: after,
          auth: auth('executor', after),
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'policy_version_mismatch' });
    expect(await store.getIdempotencyRecord('execute:stale-policy')).toBeNull();
    expect((await store.getApproval(first.id))?.status).toBe('active');
    expect((await store.getApproval(second.id))?.status).toBe('active');
  });

  it('rejects expired proposals and expired or consumed approvals', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const expiredProposal = await createProposal(
      proposalInput({ expiresAt: '2098-01-01T12:01:00.000Z' }),
    );
    await approve(expiredProposal, 'approver-a');
    await approve(expiredProposal, 'approver-b');
    vi.setSystemTime(new Date('2098-01-01T12:02:00.000Z'));
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(expiredProposal, {
          idempotencyKey: 'execute:expired-proposal',
          now: '2098-01-01T12:02:00.000Z',
          auth: auth('executor', '2098-01-01T12:02:00.000Z'),
        }),
      ),
    ).rejects.toThrow();
    expect(await store.getIdempotencyRecord('execute:expired-proposal')).toBeNull();

    vi.setSystemTime(new Date(now));
    const expiredApprovalProposal = await createProposal(proposalInput({
      payload: payload('txn-expired-approval'),
      preconditions: JSON.stringify({
        transactionId: 'txn-expired-approval',
        accountId: 'acct-source',
        direction: 'outgoing',
        amount: amount('12500'),
        currentCategoryId: null,
        actualVersion: 'actual-v1',
      }),
    }));
    await approve(expiredApprovalProposal, 'approver-a', '2098-01-01T12:01:00.000Z');
    await approve(expiredApprovalProposal, 'approver-b', '2098-01-01T12:01:00.000Z');
    vi.setSystemTime(new Date('2098-01-01T12:02:00.000Z'));
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(expiredApprovalProposal, {
          idempotencyKey: 'execute:expired-approval',
          now: '2098-01-01T12:02:00.000Z',
          auth: auth('executor', '2098-01-01T12:02:00.000Z'),
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'approval_required' });

    vi.setSystemTime(new Date(now));
    const consumedProposal = await createProposal(proposalInput({
      payload: payload('txn-consumed-approval'),
      preconditions: JSON.stringify({
        transactionId: 'txn-consumed-approval',
        accountId: 'acct-source',
        amount: amount('12500'),
        direction: 'outgoing',
        currentCategoryId: null,
        actualVersion: 'actual-v1',
      }),
    }));
    const consumed = await approve(consumedProposal, 'approver-a');
    await approve(consumedProposal, 'approver-b');
    testDatabase()
      .prepare("UPDATE proposal_approvals SET status = 'consumed', consumed_at = ? WHERE id = ?")
      .run(now, consumed.id);
    await expect(
      store.acquireProposalExecution(
        acquisitionInput(consumedProposal, { idempotencyKey: 'execute:consumed-approval' }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'approval_required' });
  });

  it('serializes concurrent distinct keys to one proposal-level acquisition', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    const keys = ['execute:concurrent-a', 'execute:concurrent-b'];
    const outcomes = await Promise.allSettled(
      keys.map((idempotencyKey) =>
        store.acquireProposalExecution(acquisitionInput(proposal, { idempotencyKey })),
      ),
    );
    const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
    const loser = outcomes.find((outcome) => outcome.status === 'rejected');
    if (!winner || winner.status !== 'fulfilled' || !loser || loser.status !== 'rejected') {
      throw new Error('Expected one acquired and one rejected execution key');
    }

    expect(winner.value.claim.isOwner).toBe(true);
    expect(winner.value.auditRecord).not.toBeNull();
    expect(loser.reason).toMatchObject({ reasonCode: 'idempotency_in_progress' });
    const losingKey = keys.find((key) => key !== winner.value.claim.record.idempotencyKey)!;
    expect(await store.getIdempotencyRecord(losingKey)).toBeNull();
    expect(
      (await store.queryAuditRecordsByProposal(proposal.id)).filter(
        (record) => record.classification === 'execution_started',
      ),
    ).toHaveLength(1);
  });

  it('replays one exact idempotency key but forbids a second key from acquiring the proposal write', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');

    const first = await store.acquireProposalExecution(acquisitionInput(proposal));
    expect(first.claim.isOwner).toBe(true);
    expect(first.auditRecord).not.toBeNull();

    const replay = await store.acquireProposalExecution(acquisitionInput(proposal));
    expect(replay.claim.isOwner).toBe(false);
    expect(replay.claim.record.idempotencyKey).toBe(first.claim.record.idempotencyKey);
    expect(replay.auditRecord).toBeNull();

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, { idempotencyKey: 'execute:another-key' }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });
    expect(await store.getIdempotencyRecord('execute:another-key')).toBeNull();
    expect((await store.queryAuditRecordsByProposal(proposal.id)).filter(
      (record) => record.classification === 'execution_started',
    )).toHaveLength(1);
  });

  it('rolls back approval consumption and idempotency when acquisition audit insertion fails', async () => {
    await setup({ operationApprovers: { set_category: 2 } });
    const proposal = await createProposal();
    const first = await approve(proposal, 'approver-a');
    const second = await approve(proposal, 'approver-b');
    const db = testDatabase();
    db.exec(`
      CREATE TRIGGER fail_execution_acquisition_audit
      BEFORE INSERT ON audit_records
      WHEN NEW.idempotency_key = 'execute:audit-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced acquisition audit failure');
      END;
    `);

    await expect(
      store.acquireProposalExecution(
        acquisitionInput(proposal, { idempotencyKey: 'execute:audit-failure' }),
      ),
    ).rejects.toThrow();

    expect(await store.getIdempotencyRecord('execute:audit-failure')).toBeNull();
    expect((await store.getApproval(first.id))?.status).toBe('active');
    expect((await store.getApproval(second.id))?.status).toBe('active');
    expect(
      (await store.queryAuditRecordsByProposal(proposal.id)).some(
        (record) => record.classification === 'execution_started',
      ),
    ).toBe(false);
  });
  it('preserves own __proto__ JSON keys in the exact generic envelope hash', () => {
    const withOwnKey = JSON.parse('{"__proto__":{"value":"bound"},"categoryId":"food"}') as unknown;
    const withoutOwnKey = { categoryId: 'food' };
    const envelope = {
      operation: 'set_category',
      budgetId,
      preconditions: {},
      actorId: 'proposer',
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    };

    expect(canonicalProposalJson(withOwnKey)).toBe(
      '{"__proto__":{"value":"bound"},"categoryId":"food"}',
    );
    expect(canonicalProposalHash({ ...envelope, payload: withOwnKey })).not.toBe(
      canonicalProposalHash({ ...envelope, payload: withoutOwnKey }),
    );
  });

  it('rejects sparse, decorated, symbol-keyed, and accessor JSON envelope values', () => {
    const sparse = new Array(1);
    const decorated = Object.assign([1], { extra: true });
    const symbolKeyed = Object.defineProperty({ value: 1 }, Symbol('hidden'), { value: true });
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });

    for (const value of [sparse, decorated, symbolKeyed, accessor])
      expect(() => canonicalProposalJson(value)).toThrow();
  });

  it('creates a bulk of approvals with attributed durable audits in one store call', async () => {
    const fixture = await setup({ operationApprovers: { set_category: 1 } });
    const first = await createProposal(proposalInput({ payload: payload('txn-bulk-1') }));
    const second = await createProposal(proposalInput({ payload: payload('txn-bulk-2') }));

    const approvals = await createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: second.id, payloadHash: second.payloadHash },
      ],
      auth: auth('approver-a'),
      now,
      requestId: 'bulk-request',
      correlationId: 'bulk-correlation',
    });

    expect(approvals.map(({ proposalId, payloadHash, actorId, membershipId }) => ({
      proposalId,
      payloadHash,
      actorId,
      membershipId,
    }))).toEqual([
      {
        proposalId: first.id,
        payloadHash: first.payloadHash,
        actorId: 'approver-a',
        membershipId: fixture.membershipIds['approver-a'],
      },
      {
        proposalId: second.id,
        payloadHash: second.payloadHash,
        actorId: 'approver-a',
        membershipId: fixture.membershipIds['approver-a'],
      },
    ]);
    expect(approvalEffects([first.id, second.id])).toEqual([
      { approvals: 1, audits: 1 },
      { approvals: 1, audits: 1 },
    ]);
    const audited = await store.queryAuditRecordsByProposal(first.id);
    expect(audited.find(({ classification }) => classification === 'approval_granted')).toMatchObject({
      actorId: 'approver-a',
      requestId: 'bulk-request',
      correlationId: 'bulk-correlation',
      payloadHash: first.payloadHash,
    });
  });

  it('rolls back every bulk approval and audit when the last displayed hash is missing or stale', async () => {
    const fixture = await setup();
    const first = await createProposal(proposalInput({ payload: payload('txn-bulk-hash-1') }));
    const second = await createProposal(proposalInput({ payload: payload('txn-bulk-hash-2') }));

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: second.id, payloadHash: '' },
      ],
      auth: auth('approver-a'),
      now,
    })).rejects.toMatchObject({ reasonCode: 'payload_hash_mismatch' });

    expect(approvalEffects([first.id, second.id])).toEqual([
      { approvals: 0, audits: 0 },
      { approvals: 0, audits: 0 },
    ]);
  });

  it('rejects duplicate proposals in a bulk and leaves no approval side effects', async () => {
    const fixture = await setup();
    const proposal = await createProposal();

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: proposal.id, payloadHash: proposal.payloadHash },
        { proposalId: proposal.id, payloadHash: proposal.payloadHash },
      ],
      auth: auth('approver-a'),
      now,
    })).rejects.toThrow(/Duplicate proposal in bulk approvals/);

    expect(approvalEffects([proposal.id])).toEqual([{ approvals: 0, audits: 0 }]);
  });

  it('rejects a proposal outside the selected space without committing earlier batch rows', async () => {
    const fixture = await setup();
    const first = await createProposal(proposalInput({ payload: payload('txn-bulk-space-1') }));
    const otherBudgetId = 'budget-bulk-other';
    const unboundOtherSpace = governance.createSpace({
      actorId: 'owner',
      name: 'Other governed budget',
      kind: 'shared',
      now,
      auth: auth('owner'),
    });
    const otherSpace = governance.bindBudget({
      spaceId: unboundOtherSpace.id,
      budgetId: otherBudgetId,
      now,
      auth: auth('owner'),
    });
    for (const actorId of ['proposer', 'approver-a']) {
      governance.addMembership({
        spaceId: otherSpace.id,
        actorId,
        validFrom: now,
        now,
        auth: auth('owner'),
      });
    }
    const other = await createProposal(proposalInput({
      payload: payload('txn-bulk-space-2'),
      budgetId: otherBudgetId,
      spaceId: otherSpace.id,
    }));

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: other.id, payloadHash: other.payloadHash },
      ],
      auth: auth('approver-a'),
      now,
    })).rejects.toThrow(/unavailable in selected space/);

    expect(approvalEffects([first.id, other.id])).toEqual([
      { approvals: 0, audits: 0 },
      { approvals: 0, audits: 0 },
    ]);
  });

  it('rolls back a valid first approval when a later proposal is expired', async () => {
    const fixture = await setup();
    const first = await createProposal(proposalInput({ payload: payload('txn-bulk-expiry-1') }));
    const expired = await createProposal(proposalInput({ payload: payload('txn-bulk-expiry-2') }));
    testDatabase().prepare('UPDATE action_proposals SET expires_at = ? WHERE id = ?').run(now, expired.id);

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: expired.id, payloadHash: expired.payloadHash },
      ],
      auth: auth('approver-a'),
      now,
    })).rejects.toMatchObject({ reasonCode: 'proposal_expired' });

    expect(approvalEffects([first.id, expired.id])).toEqual([
      { approvals: 0, audits: 0 },
      { approvals: 0, audits: 0 },
    ]);
  });

  it('rolls back a valid first approval when the later proposal issuer membership has ended', async () => {
    const fixture = await setup();
    const first = await createProposal(proposalInput({ payload: payload('txn-bulk-departed-1') }));
    const departedActor = 'departing-proposer';
    await identity(departedActor);
    const membership = governance.addMembership({
      spaceId: fixture.space.id,
      actorId: departedActor,
      validFrom: now,
      now,
      auth: auth('owner'),
    });
    const departedProposal = await createProposal(proposalInput({
      payload: payload('txn-bulk-departed-2'),
      actorId: departedActor,
      auth: auth(departedActor),
    }));
    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: membership.id,
      now: after,
      auth: auth('owner', after),
    });

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: departedProposal.id, payloadHash: departedProposal.payloadHash },
      ],
      auth: auth('approver-a', after),
      now: after,
    })).rejects.toThrow(/Proposal requester membership is no longer current/);

    expect(approvalEffects([first.id, departedProposal.id])).toEqual([
      { approvals: 0, audits: 0 },
      { approvals: 0, audits: 0 },
    ]);
  });

  it('rolls back earlier approvals when a later proposal needs a revoked approver resource', async () => {
    const fixture = await setup();
    const noEvidence = payload('txn-bulk-resource-1');
    noEvidence.composite.evidenceReferences = [];
    const first = await createProposal(proposalInput({ payload: noEvidence }));
    const second = await createProposal(proposalInput({ payload: payload('txn-bulk-resource-2') }));
    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'approver-a',
      budgetId,
      membershipId: fixture.membershipIds['approver-a']!,
      capability: 'categorization:approve',
      resourceKind: 'evidence',
      resourceId: 'receipt-1',
      granted: false,
      now: after,
      auth: auth('owner', after),
    });

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: second.id, payloadHash: second.payloadHash },
      ],
      auth: auth('approver-a', after),
      now: after,
    })).rejects.toThrow(/Current scoped grant unavailable/);

    expect(approvalEffects([first.id, second.id])).toEqual([
      { approvals: 0, audits: 0 },
      { approvals: 0, audits: 0 },
    ]);
  });

  it('rolls back bulk approval rows when durable approval audit insertion fails', async () => {
    const fixture = await setup();
    const first = await createProposal(proposalInput({ payload: payload('txn-bulk-audit-1') }));
    const second = await createProposal(proposalInput({ payload: payload('txn-bulk-audit-2') }));
    testDatabase().exec(`
      CREATE TRIGGER fail_bulk_approval_audit
      BEFORE INSERT ON audit_records
      WHEN NEW.classification = 'approval_granted'
      BEGIN
        SELECT RAISE(ABORT, 'forced approval audit failure');
      END;
    `);

    await expect(createApprovals({
      spaceId: fixture.space.id,
      approvals: [
        { proposalId: first.id, payloadHash: first.payloadHash },
        { proposalId: second.id, payloadHash: second.payloadHash },
      ],
      auth: auth('approver-a'),
      now,
    })).rejects.toThrow(/forced approval audit failure/);

    expect(approvalEffects([first.id, second.id])).toEqual([
      { approvals: 0, audits: 0 },
      { approvals: 0, audits: 0 },
    ]);
  });

  it('requires the normalized executable rule in payload instead of copying preconditions into it', async () => {
    const fixture = await setup();
    const normalizedRule = {
      name: 'Market groceries',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Market' }],
      actions: [{ type: 'set-category', field: 'category', value: 'cat-food' }],
      conditionsOp: 'and',
    };
    for (const resource of [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      { resourceKind: 'category' as const, resourceId: 'cat-food' },
    ]) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'proposer',
        budgetId,
        membershipId: fixture.membershipIds.proposer!,
        capability: 'rule:propose',
        ...resource,
        granted: true,
        now,
        auth: auth('owner'),
      });
    }
    const input: CreateProposalInput = {
      operation: 'create_rule',
      budgetId,
      spaceId: fixture.space.id,
      payload: {
        kind: 'create_rule',
        transactionId: null,
        categoryId: 'cat-food',
        rule: {},
      },
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify({ reviewId: 'review-rule-source', nativeRule: normalizedRule }),
      expiresAt,
      actorId: 'proposer',
      auth: auth('proposer'),
      provenance: 'manual',
    };

    await expect(store.createProposal(input)).rejects.toThrow();
    expect(await store.countProposals({ budgetId, operations: ['create_rule'] })).toBe(0);
  });
  it('keeps payee-only rule effects global under account-restricted grants and scopes only exact AND account rules', async () => {
    const fixture = await setup({
      operationApprovers: { create_rule: 1, update_rule: 1, delete_rule: 1 },
    });
    const accountRestriction = { accountIds: ['acct-A'] };
    const authorizeFacts = (
      operation: 'create_rule' | NativeRuleMutation,
      facts: ProposalAuthorizationFacts,
      restrictions: { accountIds?: string[] },
    ) => {
      const refs: GovernanceResourceRef[] = [
        { resourceKind: 'budget', resourceId: budgetId },
        ...facts.resources,
      ];
      for (const ref of refs) {
        governance.provisionResourceGrant({
          spaceId: fixture.space.id,
          actorId: 'proposer',
          membershipId: fixture.membershipIds.proposer!,
          budgetId,
          capability: 'rule:propose',
          ...ref,
          granted: true,
          restrictions: ref.resourceKind === 'budget' ? restrictions : {},
          now,
        });
      }
      return governance.authorize({
        actorId: 'proposer',
        spaceId: fixture.space.id,
        membershipId: fixture.membershipIds.proposer,
        expectedPolicyVersion: fixture.policy.version,
        phase: 'propose',
        operation,
        required: refs.map((ref) => ({ ...ref, capability: 'rule:propose' })),
        payload: { operations: facts.operations, resources: facts.resources },
        now,
      });
    };
    for (const conditionsOp of ['and', 'or'] as const) {
      const payload = {
        kind: 'create_rule',
        transactionId: null,
        categoryId: 'cat-food',
        rule: {
          name: 'Market groceries',
          conditions: [{ field: 'payee_name', op: 'is', value: 'Market' }],
          actions: [{ type: 'set-category', field: 'category', value: 'cat-food' }],
          conditionsOp,
        },
      };
      const sourceLess = deriveProposalAuthorizationFacts(
        'create_rule',
        payload,
        {},
      );
      const sourceDerived = deriveProposalAuthorizationFacts(
        'create_rule',
        payload,
        { transaction: { transactionId: 'txn-A', accountId: 'acct-A' } },
      );
      expect(authorizeFacts('create_rule', sourceLess, accountRestriction).allowed).toBe(false);
      expect(authorizeFacts('create_rule', sourceDerived, accountRestriction).allowed).toBe(false);
      expect(authorizeFacts('create_rule', sourceLess, {}).allowed).toBe(true);
    }

    const delegatedFacts = deriveProposalAuthorizationFacts(
      'create_rule',
      {
        kind: 'create_rule',
        transactionId: null,
        categoryId: 'cat-food',
        rule: {
          name: 'Market groceries',
          conditions: [{ field: 'payee_name', op: 'is', value: 'Market' }],
          actions: [{ type: 'set-category', field: 'category', value: 'cat-food' }],
          conditionsOp: 'and',
        },
      },
      {},
    );
    const delegatedRefs: GovernanceResourceRef[] = [
      { resourceKind: 'budget', resourceId: budgetId },
      ...delegatedFacts.resources,
    ];
    for (const ref of delegatedRefs)
      governance.provisionResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'owner',
        membershipId: fixture.membershipIds.owner!,
        budgetId,
        capability: 'rule:propose',
        ...ref,
        granted: true,
        now,
      });
    const agentId = 'agent:rule-account-scope';
    const credentialId = 'key:rule-account-scope';
    governance.registerAgent({ spaceId: fixture.space.id, agentId, now, auth: auth('owner') });
    const delegation = governance.delegate({
      spaceId: fixture.space.id,
      agentId,
      issuerMembershipId: fixture.membershipIds.owner!,
      expectedVersion: null,
      rights: delegatedRefs.map((ref) => ({
        ...ref,
        capability: 'rule:propose',
        ...(ref.resourceKind === 'budget' ? { restrictions: accountRestriction } : {}),
      })),
      validFrom: now,
      validUntil: expiresAt,
      now,
      auth: auth('owner'),
    });
    governance.registerCredentialBinding({
      spaceId: fixture.space.id,
      credentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth('owner'),
    });
    expect(governance.authorize({
      actorId: agentId,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      auth: {
        method: 'api-key',
        actorId: agentId,
        credentialId,
        credentialOwnerId: 'owner',
        principalType: 'agent',
        delegationId: delegation.id,
        delegationVersion: delegation.version,
      },
      spaceId: fixture.space.id,
      membershipId: fixture.membershipIds.owner,
      expectedPolicyVersion: fixture.policy.version,
      phase: 'propose',
      operation: 'create_rule',
      required: delegatedRefs.map((ref) => ({ ...ref, capability: 'rule:propose' })),
      payload: { operations: delegatedFacts.operations, resources: delegatedFacts.resources },
      now,
    }).allowed).toBe(false);

    const scopedRule = {
      ...nativeRuleSnapshot('rule-account-a'),
      trigger: [
        { field: 'account', op: 'is', value: 'acct-A' },
        { field: 'payee_name', op: 'is', value: 'Market' },
      ],
      conditionsOp: 'and' as const,
    };
    const lifecycleFacts = (operation: NativeRuleMutation, rule: typeof scopedRule) =>
      deriveProposalAuthorizationFacts(
        operation,
        operation === 'update_rule'
          ? { kind: operation, ruleId: rule.id, inactive: true }
          : { kind: operation, ruleId: rule.id },
        { rule, override: null },
      );

    for (const operation of ['update_rule', 'delete_rule'] as const) {
      const scoped = lifecycleFacts(operation, scopedRule);
      expect(authorizeFacts(operation, scoped, accountRestriction).allowed).toBe(true);
      const unknownRule = {
        ...scopedRule,
        trigger: [
          ...scopedRule.trigger,
          { field: 'unsupported_predicate', op: 'is', value: 'unknown' },
        ],
      };
      const unknown = lifecycleFacts(operation, unknownRule);
      expect(authorizeFacts(operation, unknown, accountRestriction).allowed).toBe(false);

      const globalRule = { ...scopedRule, conditionsOp: 'or' as const };
      const global = lifecycleFacts(operation, globalRule);
      const metadataChanged = lifecycleFacts(operation, {
        ...globalRule,
        name: 'Renamed rule',
        order: 99,
        inactive: true,
        stage: 'post',
      });
      expect(authorizeFacts(operation, global, accountRestriction).allowed).toBe(false);
      expect(authorizeFacts(operation, metadataChanged, accountRestriction).allowed).toBe(false);
    }
  });
  it('routes exact local rule updates and Actual deletions through current native quorum and acquisition', async () => {
    await setup({ operationApprovers: { update_rule: 2, delete_rule: 2 } });

    for (const operation of ['update_rule', 'delete_rule'] as const) {
      const rule = nativeRuleSnapshot();
      const payload = operation === 'update_rule'
        ? {
            kind: operation,
            ruleId: rule.id,
            inactive: true,
            composite: {
              operations: [],
              reallocations: [],
              transferRecommendations: [],
              ledgerProjections: [],
              evidenceReferences: [],
            },
          }
        : { kind: operation, ruleId: rule.id };
      const { proposal, input } = await createNativeRuleMutationProposal(operation, { rule, payload });
      const preconditions = JSON.parse(input.preconditions);
      expect(proposal.operation).toBe(operation);
      expect(proposal.payload).toEqual(input.payload);
      expect(JSON.parse(proposal.preconditions)).toEqual(preconditions);
      expect(proposal.payloadHash).toBe(canonicalProposalHash({
        operation,
        budgetId,
        payload: input.payload,
        preconditions,
        actorId: 'proposer',
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        expiresAt,
      }));
      expect(proposal.payload).toEqual(payload);

      const beforeApprovals = await readApprovalSummary(proposal.id, 'executor');
      expect(beforeApprovals).toMatchObject({
        requiredApprovers: 2,
        disposition: { kind: 'approval_required' },
        canExecute: false,
      });
      const executionInput = nativeRuleExecutionInput(
        proposal as unknown as GenericProposal,
        operation,
        `execute:${operation}:${proposal.id}`,
      );
      await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');
      await expect(store.acquireProposalExecution(executionInput)).rejects.toMatchObject({
        reasonCode: 'approval_required',
      });
      expect(await store.getIdempotencyRecord(executionInput.idempotencyKey)).toBeNull();

      await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-b');
      const approved = await readApprovalSummary(proposal.id, 'executor');
      expect(approved.disposition.kind).toBe('authorized_without_approval');
      expect(approved.canExecute).toBe(true);

      const acquired = await store.acquireProposalExecution(executionInput);
      expect(acquired.claim.isOwner).toBe(true);
      expect(acquired.approvals.map(({ actorId }) => actorId).sort()).toEqual([
        'approver-a',
        'approver-b',
      ]);
      const replay = await store.acquireProposalExecution(executionInput);
      expect(replay.claim.isOwner).toBe(false);
      expect(replay.auditRecord).toBeNull();
    }

    const nullStageRule = nativeRuleSnapshot('rule-null-stage', null);
    const { proposal } = await createNativeRuleMutationProposal('delete_rule', {
      rule: nullStageRule,
    });
    expect(JSON.parse(proposal.preconditions).rule.stage).toBeNull();
  });

  it('requires the exact current budget, rule, account, and category grants derived from the before-rule snapshot', async () => {
    await setup({ operationApprovers: { update_rule: 1 } });
    const missingReferences = [
      { kind: 'rule' as const, id: (ruleId: string) => ruleId },
      { kind: 'account' as const, id: (ruleId: string) => `acct-${ruleId}` },
      { kind: 'category' as const, id: (ruleId: string) => `cat-before-${ruleId}` },
      { kind: 'category' as const, id: (ruleId: string) => `cat-after-${ruleId}` },
    ];

    for (const [index, missing] of missingReferences.entries()) {
      const ruleId = `rule-missing-resource-${index}`;
      const resources = nativeRuleResources(ruleId).filter(
        (resource) => resource.resourceKind !== missing.kind || resource.resourceId !== missing.id(ruleId),
      );
      await expect(createNativeRuleMutationProposal('update_rule', {
        rule: nativeRuleSnapshot(ruleId),
        grantResources: resources,
      })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    }
    expect(await store.listProposals()).toHaveLength(0);
  });

  it('authorizes every scalar and list account/category ID from Actual rule fields', async () => {
    await setup({ operationApprovers: { delete_rule: 1 } });
    const makeListedRule = (ruleId: string) => ({
      ...nativeRuleSnapshot(ruleId),
      trigger: [
        { field: 'account', op: 'oneOf', value: [`acct-one-${ruleId}`, `acct-two-${ruleId}`] },
        { field: 'category', op: 'notOneOf', value: [`cat-one-${ruleId}`, `cat-two-${ruleId}`] },
      ],
      actions: [{ op: 'set', field: 'category', value: `cat-action-${ruleId}` }],
    });

    for (const [index, missingIndex] of [2, 3, 4, 5, 6].entries()) {
      const ruleId = `rule-list-scope-${index}`;
      const required = [
        { resourceKind: 'budget' as const, resourceId: budgetId },
        { resourceKind: 'rule' as const, resourceId: ruleId },
        { resourceKind: 'account' as const, resourceId: `acct-one-${ruleId}` },
        { resourceKind: 'account' as const, resourceId: `acct-two-${ruleId}` },
        { resourceKind: 'category' as const, resourceId: `cat-one-${ruleId}` },
        { resourceKind: 'category' as const, resourceId: `cat-two-${ruleId}` },
        { resourceKind: 'category' as const, resourceId: `cat-action-${ruleId}` },
      ];
      const missingResource = required[missingIndex]!;
      await expect(createNativeRuleMutationProposal('delete_rule', {
        rule: makeListedRule(ruleId),
        grantResources: required.filter((resource) =>
          resource.resourceKind !== missingResource.resourceKind ||
          resource.resourceId !== missingResource.resourceId),
      })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    }

    const ruleId = 'rule-list-scope-complete';
    const rule = makeListedRule(ruleId);
    const required = [
      ...nativeRuleResources(ruleId).slice(0, 2),
      { resourceKind: 'account' as const, resourceId: `acct-one-${ruleId}` },
      { resourceKind: 'account' as const, resourceId: `acct-two-${ruleId}` },
      { resourceKind: 'category' as const, resourceId: `cat-one-${ruleId}` },
      { resourceKind: 'category' as const, resourceId: `cat-two-${ruleId}` },
      { resourceKind: 'category' as const, resourceId: `cat-action-${ruleId}` },
    ];
    const complete = await createNativeRuleMutationProposal('delete_rule', {
      rule,
      grantResources: required,
    });
    expect(complete.proposal.operation).toBe('delete_rule');
    expect(await store.listProposals()).toHaveLength(1);
  });
  it('does not treat Actual name patterns, uncategorized nulls, or empty rule names as resource IDs', async () => {
    await setup({ operationApprovers: { update_rule: 1 } });
    const rule = {
      ...nativeRuleSnapshot('rule-non-id-actual-values'),
      name: '',
      trigger: [
        { field: 'account', op: 'contains', value: 'Main Checking' },
        { field: 'account', op: 'onBudget', value: '' },
        { field: 'category', op: 'matches', value: '^Groceries$' },
        { field: 'category', op: 'is', value: null },
        { field: 'category_group', op: 'contains', value: 'Household' },
      ],
      actions: [{ op: 'set', field: 'category', value: null }],
    };
    const { proposal } = await createNativeRuleMutationProposal('update_rule', {
      rule,
      grantResources: [
        { resourceKind: 'budget', resourceId: budgetId },
        { resourceKind: 'rule', resourceId: rule.id },
      ],
    });

    expect(proposal.operation).toBe('update_rule');
  });

  it('rejects malformed IDs in recognized Actual account and category references', async () => {
    await setup({ operationApprovers: { delete_rule: 1 } });
    const malformedRules = [
      {
        rule: {
          ...nativeRuleSnapshot('rule-invalid-account-id-type'),
          trigger: [{ field: 'account', op: 'is', value: 17 }],
        },
        message: /account.*resource/i,
      },
      {
        rule: {
          ...nativeRuleSnapshot('rule-invalid-category-list-id'),
          trigger: [{ field: 'category', op: 'oneOf', value: ['cat-valid', ' '] }],
        },
        message: /category.*resource/i,
      },
      {
        rule: {
          ...nativeRuleSnapshot('rule-invalid-action-category-id'),
          actions: [{ op: 'set', field: 'category', value: 17 }],
        },
        message: /category.*resource/i,
      },
    ];

    for (const { rule, message } of malformedRules)
      await expect(createNativeRuleMutationProposal('delete_rule', { rule })).rejects.toThrow(message);
    expect(await store.listProposals()).toHaveLength(0);
  });

  it('resolves category-group predicates to all current category resources and fails closed when incomplete', async () => {
    await setup({ operationApprovers: { delete_rule: 1 } });
    const groupRule = (ruleId: string, groupId: string, categories: string[]) => {
      const rule = nativeRuleSnapshot(ruleId);
      rule.trigger.push({ field: 'category_group', op: 'is', value: groupId });
      return {
        rule,
        preconditions: {
          rule,
          override: null,
          categoryGroupMembers: { [groupId]: categories },
        },
        resources: [
          ...nativeRuleResources(ruleId),
          ...categories.map((resourceId) => ({ resourceKind: 'category' as const, resourceId })),
        ],
      };
    };
    const unresolved = groupRule('rule-category-group-unresolved', 'group-unresolved', [
      'cat-unresolved-member',
    ]);
    await expect(createNativeRuleMutationProposal('delete_rule', {
      rule: unresolved.rule,
      grantResources: unresolved.resources,
    })).rejects.toThrow(/category.?group/i);

    const invalidMembers = groupRule('rule-category-group-invalid-members', 'group-invalid-members', [
      'cat-valid-member',
    ]);
    await expect(createNativeRuleMutationProposal('delete_rule', {
      rule: invalidMembers.rule,
      preconditions: {
        ...invalidMembers.preconditions,
        categoryGroupMembers: { 'group-invalid-members': [' '] },
      },
      grantResources: nativeRuleResources('rule-category-group-invalid-members'),
    })).rejects.toThrow(/category.*(member|resource)/i);

    const current = groupRule('rule-category-group-current', 'group-current', [
      'cat-current-market',
      'cat-current-dining',
    ]);
    await expect(createNativeRuleMutationProposal('delete_rule', {
      rule: current.rule,
      preconditions: current.preconditions,
      grantResources: current.resources.filter(
        (resource) => resource.resourceId !== 'cat-current-dining',
      ),
    })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    const complete = await createNativeRuleMutationProposal('delete_rule', {
      rule: current.rule,
      preconditions: current.preconditions,
      grantResources: current.resources,
    });
    expect(complete.proposal.operation).toBe('delete_rule');
    expect(JSON.parse(complete.proposal.preconditions).categoryGroupMembers)
      .toEqual({ 'group-current': ['cat-current-market', 'cat-current-dining'] });
    expect(await store.listProposals()).toHaveLength(1);
  });
  it('rejects incomplete rule snapshots, missing override state, malformed toggles, target mismatch, and disguised deletion creation', async () => {
    const fixture = await setup({ operationApprovers: { update_rule: 1, delete_rule: 1 } });
    const missingStage = { ...nativeRuleSnapshot('rule-missing-stage'), stage: undefined };
    const missingConditionsOp = {
      ...nativeRuleSnapshot('rule-missing-conditions-op'),
      conditionsOp: undefined,
    };
    const invalidAccountReference = nativeRuleSnapshot('rule-invalid-account');
    invalidAccountReference.trigger[0] = { field: 'account', op: 'is', value: '' };
    const invalidRuleInactive = {
      ...nativeRuleSnapshot('rule-invalid-before-inactive'),
      inactive: 'false',
    };
    const wrongTargetOverride = await store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: 'rule-override-wrong-target',
      inactive: false,
      expectedVersion: null,
    });
    await expect(createNativeRuleMutationProposal('update_rule', {
      rule: nativeRuleSnapshot('rule-override-target'),
      override: wrongTargetOverride,
    })).rejects.toThrow(/override.*rule|rule.*override/i);
    const malformedInputs: Array<{
      operation: NativeRuleMutation;
      options: Parameters<typeof createNativeRuleMutationProposal>[1];
      message: RegExp;
    }> = [
      {
        operation: 'update_rule',
        options: {
          rule: nativeRuleSnapshot('rule-no-override-state'),
          preconditions: {
            rule: nativeRuleSnapshot('rule-no-override-state'),
          },
        },
        message: /override/i,
      },
      {
        operation: 'update_rule',
        options: {
          rule: nativeRuleSnapshot('rule-missing-before-rule'),
          preconditions: { override: null },
        },
        message: /rule.*snapshot|precondition.*rule/i,
      },
      {
        operation: 'update_rule',
        options: { rule: missingStage },
        message: /stage/i,
      },
      {
        operation: 'update_rule',
        options: { rule: missingConditionsOp },
        message: /conditionsOp/i,
      },
      {
        operation: 'update_rule',
        options: {
          payload: { kind: 'update_rule', ruleId: 'another-rule', inactive: true },
        },
        message: /rule.*(id|match)|target.*rule/i,
      },
      {
        operation: 'update_rule',
        options: {
          payload: { kind: 'update_rule', ruleId: 'rule-invalid-inactive', inactive: 'true' },
          rule: nativeRuleSnapshot('rule-invalid-inactive'),
        },
        message: /inactive/i,
      },
      {
        operation: 'update_rule',
        options: { rule: invalidRuleInactive },
        message: /inactive/i,
      },
      {
        operation: 'update_rule',
        options: {
          payload: {
            kind: 'update_rule',
            ruleId: 'rule-unsupported-composite',
            inactive: true,
            composite: {
              operations: [{ operation: 'set_category' }],
              reallocations: [],
              transferRecommendations: [],
              ledgerProjections: [],
              evidenceReferences: [],
            },
          },
          rule: nativeRuleSnapshot('rule-unsupported-composite'),
        },
        message: /composite/i,
      },
      {
        operation: 'update_rule',
        options: { rule: invalidAccountReference },
        message: /account.*resource/i,
      },
      {
        operation: 'delete_rule',
        options: {
          rule: nativeRuleSnapshot('rule-delete-replacement'),
          payload: {
            kind: 'delete_rule',
            ruleId: 'rule-delete-replacement',
            rule: { name: 'replacement rule', actions: [] },
          },
        },
        message: /replacement|delete_rule.*rule/i,
      },
    ];

    for (const { operation, options, message } of malformedInputs)
      await expect(createNativeRuleMutationProposal(operation, options)).rejects.toThrow(message);
    expect(await store.listProposals()).toHaveLength(0);
  });

  it('hashes the exact current scoped override and denies acquisition after its version changes', async () => {
    const fixture = await setup({ operationApprovers: { update_rule: 2 } });
    const rule = nativeRuleSnapshot('rule-versioned-override');
    const override = await store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      inactive: false,
      expectedVersion: null,
    });
    const { proposal, input } = await createNativeRuleMutationProposal('update_rule', {
      rule,
      override,
    });
    const preconditions = JSON.parse(input.preconditions);
    expect(preconditions).toMatchObject({ rule, override });
    expect(proposal.payloadHash).toBe(canonicalProposalHash({
      operation: 'update_rule',
      budgetId,
      payload: input.payload,
      preconditions,
      actorId: 'proposer',
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    }));
    const changedVersionHash = canonicalProposalHash({
      operation: 'update_rule',
      budgetId,
      payload: input.payload,
      preconditions: {
        ...preconditions,
        override: { ...override, version: override.version + 1 },
      },
      actorId: 'proposer',
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    });
    expect(changedVersionHash).not.toBe(proposal.payloadHash);

    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');
    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-b');
    await store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      inactive: true,
      expectedVersion: override.version,
    });
    const executionInput = nativeRuleExecutionInput(
      proposal as unknown as GenericProposal,
      'update_rule',
      'execute:stale-rule-override',
    );
    await expect(store.acquireProposalExecution(executionInput)).rejects.toThrow();
    expect(await store.getIdempotencyRecord(executionInput.idempotencyKey)).toBeNull();
  });
  it('invalidates an absent-override approval across absent-present-removed-reinserted transitions', async () => {
    const fixture = await setup({ operationApprovers: { update_rule: 2 } });
    const rule = nativeRuleSnapshot('rule-override-absence-aba');
    const { proposal } = await createNativeRuleMutationProposal('update_rule', { rule });
    expect(JSON.parse(proposal.preconditions)).toMatchObject({ rule, override: null });
    const executionInput = nativeRuleExecutionInput(
      proposal as unknown as GenericProposal,
      'update_rule',
      'execute:absent-override-aba',
    );
    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');
    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-b');

    const present = await store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      inactive: true,
      expectedVersion: null,
    });
    await store.removeRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      expectedVersion: present.version,
    });
    const removed = await store.getRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
    });
    expect(removed).toEqual({
      ruleId: rule.id,
      inactive: null,
      version: present.version + 1,
    });
    await expect(store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      inactive: false,
      expectedVersion: null,
    })).rejects.toThrow();

    await expect(store.acquireProposalExecution(executionInput)).rejects.toThrow();
    const tombstone = removed;
    if (!tombstone) throw new Error('Expected the retained absent-state revision');
    const reinserted = await store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      inactive: false,
      expectedVersion: tombstone.version,
    });
    expect(reinserted.version).toBe(tombstone.version + 1);
    await expect(store.acquireProposalExecution(executionInput)).rejects.toThrow();
    expect(await store.getIdempotencyRecord(executionInput.idempotencyKey)).toBeNull();
  });
  it.each([
    { operation: 'update_rule' as const, seedOverride: false },
    { operation: 'delete_rule' as const, seedOverride: true },
  ])('replays a completed $operation after its captured override baseline changes', async ({
    operation,
    seedOverride,
  }) => {
    const fixture = await setup({ operationApprovers: { [operation]: 1 } });
    const rule = nativeRuleSnapshot(`rule-completed-${operation}`);
    const initialOverride = seedOverride
      ? await store.setRuleOverride({
          spaceId: fixture.space.id,
          budgetId,
          ruleId: rule.id,
          inactive: true,
          expectedVersion: null,
        })
      : null;
    const { proposal } = await createNativeRuleMutationProposal(operation, {
      rule,
      override: initialOverride,
    });
    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');
    const input = nativeRuleExecutionInput(
      proposal as unknown as GenericProposal,
      operation,
      `execute:completed-${operation}`,
    );
    expect((await store.acquireProposalExecution(input)).claim.isOwner).toBe(true);

    if (operation === 'update_rule') {
      await store.setRuleOverride({
        spaceId: fixture.space.id,
        budgetId,
        ruleId: rule.id,
        inactive: true,
        expectedVersion: null,
      });
    } else {
      if (!initialOverride) throw new Error('Delete fixture needs a captured override');
      await store.removeRuleOverride({
        spaceId: fixture.space.id,
        budgetId,
        ruleId: rule.id,
        expectedVersion: initialOverride.version,
      });
    }
    await store.completeIdempotencyRecord(input.idempotencyKey, null);
    const completed = await store.getIdempotencyRecord(input.idempotencyKey);
    if (!completed) throw new Error('Completed execution record is missing');
    const activeReplay = await store.acquireProposalExecution({
      ...input,
      now: after,
      auth: auth('executor', after),
    });
    expect(activeReplay.claim.isOwner).toBe(false);
    expect(activeReplay.claim.record).toEqual(completed);
    expect(activeReplay.approvals).toEqual([]);
    expect(activeReplay.auditRecord).toBeNull();
    await store.supersedeProposal(proposal.id);

    const replayNow = '2100-01-01T00:00:00.000Z';
    const replay = await store.acquireProposalExecution({
      ...input,
      now: replayNow,
      auth: auth('executor', replayNow),
    });
    expect(replay.claim.isOwner).toBe(false);
    expect(replay.claim.record).toEqual(completed);
    expect(replay.approvals).toEqual([]);
    expect(replay.auditRecord).toBeNull();
    expect(await store.getRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
    })).toEqual(operation === 'update_rule'
      ? { ruleId: rule.id, inactive: true, version: 1 }
      : {
          ruleId: rule.id,
          inactive: null,
          version: (initialOverride?.version ?? 0) + 1,
        });
    expect(await store.queryAuditRecords('execution_started')).toHaveLength(1);
  });

  it('keeps completed rule replay bound to its key, actor, exact effect, and current execution grants', async () => {
    const fixture = await setup({ operationApprovers: { update_rule: 1 } });
    const rule = nativeRuleSnapshot('rule-completed-replay-authority');
    const { proposal, resources } = await createNativeRuleMutationProposal('update_rule', { rule });
    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');
    const input = nativeRuleExecutionInput(
      proposal as unknown as GenericProposal,
      'update_rule',
      'execute:completed-replay-authority',
    );
    await store.acquireProposalExecution(input);
    await store.setRuleOverride({
      spaceId: fixture.space.id,
      budgetId,
      ruleId: rule.id,
      inactive: true,
      expectedVersion: null,
    });
    await store.completeIdempotencyRecord(input.idempotencyKey, null);

    await expect(store.acquireProposalExecution({
      ...input,
      idempotencyKey: 'execute:completed-replay-different-key',
    })).rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });
    await expect(store.acquireProposalExecution({
      ...input,
      serialisedEffect: `${input.serialisedEffect} `,
    })).rejects.toMatchObject({ reasonCode: 'idempotency_replay_mismatch' });
    await expect(store.acquireProposalExecution({
      ...input,
      actorId: 'approver-a',
      auth: auth('approver-a'),
    })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });

    const executorMembershipId = fixture.membershipIds.executor;
    if (!executorMembershipId) throw new Error('Fixture executor membership is missing');
    const budgetResource = resources.find((resource) => resource.resourceKind === 'budget');
    if (!budgetResource) throw new Error('Rule proposal requires the budget resource');
    governance.setResourceGrant({
      spaceId: fixture.space.id,
      actorId: 'executor',
      membershipId: executorMembershipId,
      budgetId,
      capability: 'rule:execute',
      ...budgetResource,
      granted: false,
      now,
      auth: auth('owner'),
    });
    await expect(store.acquireProposalExecution(input)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
  });
  it('keeps a rule lifecycle proposal unreadable and unexecutable after its requester rejoins', async () => {
    const fixture = await setup({ operationApprovers: { delete_rule: 1 } });
    const { proposal, resources } = await createNativeRuleMutationProposal('delete_rule');
    const requesterMembershipId = proposal.requesterMembershipId;
    if (!requesterMembershipId) throw new Error('Fixture proposal has no requester membership');
    await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');

    const after = '2098-01-01T13:00:00.000Z';
    governance.revokeMembership({
      spaceId: fixture.space.id,
      membershipId: requesterMembershipId,
      now: after,
      auth: auth('owner', after),
    });
    const replacementMembership = governance.addMembership({
      spaceId: fixture.space.id,
      actorId: 'proposer',
      validFrom: after,
      now: after,
      auth: auth('owner', after),
    });
    for (const resource of resources) {
      governance.setResourceGrant({
        spaceId: fixture.space.id,
        actorId: 'proposer',
        budgetId,
        membershipId: replacementMembership.id,
        capability: 'rule:propose',
        ...resource,
        granted: true,
        now: after,
        auth: auth('owner', after),
      });
    }

    await expect(readApprovalSummary(proposal.id, 'executor', after)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
    await expect(store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'approver-b',
      expiresAt: proposal.expiresAt,
      auth: auth('approver-b', after),
      now: after,
    })).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
    const executionInput = {
      ...nativeRuleExecutionInput(
        proposal as unknown as GenericProposal,
        'delete_rule',
        'execute:departed-rule-requester',
      ),
      now: after,
      auth: auth('executor', after),
    };
    await expect(store.acquireProposalExecution(executionInput)).rejects.toMatchObject({
      reasonCode: 'authorization_denied',
    });
  });
  it('admits and acquires update and delete proposals for a known empty category group', async () => {
    await setup({ operationApprovers: { update_rule: 1, delete_rule: 1 } });

    for (const operation of ['update_rule', 'delete_rule'] as const) {
      const rule = nativeRuleSnapshot(`rule-empty-group-${operation}`);
      rule.trigger.push({ field: 'category_group', op: 'is', value: 'group-empty' });
      const preconditions = {
        rule,
        override: null,
        categoryGroupMembers: { 'group-empty': [] },
      };
      const { proposal } = await createNativeRuleMutationProposal(operation, {
        rule,
        preconditions,
      });

      expect(JSON.parse(proposal.preconditions).categoryGroupMembers)
        .toEqual({ 'group-empty': [] });
      await approveNativeRuleMutation(proposal as unknown as GenericProposal, 'approver-a');
      const execution = await store.acquireProposalExecution(
        nativeRuleExecutionInput(
          proposal as unknown as GenericProposal,
          operation,
          `execute:empty-group:${operation}`,
        ),
      );
      expect(execution.claim.isOwner).toBe(true);
      expect(execution.approvals.map(({ actorId }) => actorId)).toEqual(['approver-a']);
    }
  });

  it('rejects missing, malformed, and duplicate category-group member closures', async () => {
    await setup({ operationApprovers: { delete_rule: 1 } });
    const invalidClosures = [
      {},
      { 'group-empty': null },
      { 'group-empty': [' '] },
      { 'group-empty': ['category-a', 'category-a'] },
    ];

    for (const [index, categoryGroupMembers] of invalidClosures.entries()) {
      const rule = nativeRuleSnapshot(`rule-empty-group-invalid-${index}`);
      rule.trigger.push({ field: 'category_group', op: 'is', value: 'group-empty' });
      await expect(createNativeRuleMutationProposal('delete_rule', {
        rule,
        preconditions: { rule, override: null, categoryGroupMembers },
      })).rejects.toThrow();
    }
    expect(await store.listProposals()).toHaveLength(0);
  });
  it('accepts an empty original review category only when it exactly matches the current review', async () => {
    await setup();
    const discovered = await store.createReviewItem({
      budgetId,
      transactionId: 'txn-exact-1',
      categoryId: '',
      classifier: 'fixture',
      provenance: 'canonical-uncategorized-source',
      sourceTransaction: {
        id: 'txn-exact-1',
        accountId: 'acct-source',
        categoryId: null,
        direction: 'outgoing',
        amount: amount('12500'),
      },
    });
    const suggestion = await store.transitionInternalReviewItem(discovered.id, {
      toStatus: 'suggestion_generated',
      actor: 'trusted-fixture',
      expectedVersion: discovered.version,
    });
    const review = await store.transitionInternalReviewItem(suggestion.id, {
      toStatus: 'pending_review',
      actor: 'trusted-fixture',
      expectedVersion: suggestion.version,
    });
    const base = proposalInput();
    const preconditions = {
      ...(JSON.parse(base.preconditions) as Record<string, unknown>),
      reviewId: review.id,
      reviewProvenance: {
        budgetId,
        transactionId: review.transactionId,
        categoryId: '',
        status: review.status,
        version: review.version,
      },
    };
    const proposal = await createProposal(proposalInput({
      preconditions: JSON.stringify(preconditions),
    }));

    expect(await store.isProposalReviewProvenanceCurrent(proposal.id)).toBe(true);
    const persisted = JSON.parse(proposal.preconditions) as Record<string, unknown>;
    expect(persisted.reviewProvenance).toMatchObject({ categoryId: '' });

    const mismatched = {
      ...preconditions,
      reviewProvenance: { ...preconditions.reviewProvenance, categoryId: 'cat-other' },
    };
    await expect(createProposal(proposalInput({
      preconditions: JSON.stringify(mismatched),
    }))).rejects.toMatchObject({ reasonCode: 'authorization_denied' });
  });
});
