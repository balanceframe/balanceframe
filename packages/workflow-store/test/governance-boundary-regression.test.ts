import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { HumanControlContext, GovernanceAuthorizationInput, Space } from '../src/governance-types.js';
import type { LiquidityClaimBundle, ProspectiveClaim, TransferPlan } from '@balanceframe/protocol-generated';
import type { SessionCompletionPayload } from '../src/types.js';

const now = '2098-01-01T12:00:00.000Z';
const after = '2098-01-01T12:01:00.000Z';
const later = '2098-02-01T12:00:00.000Z';
const tomorrow = '2098-01-02T12:00:00.000Z';
const budgetId = 'budget';
const ownerId = 'owner';
const auth = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
  method: 'human-session',
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt,
});
const nativeCapabilities = [
  'approval',
  'audit',
  'balance',
  'category',
  'confirmation',
  'existence',
  'history',
  'initiation-report',
  'liquidity',
  'name',
  'policy',
  'proposal',
  'session',
  'source',
] as const;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function completionPayload(sessionId: string, sessionVersion: number): SessionCompletionPayload {
  return {
    kind: 'session_completion',
    sessionId,
    sessionVersion,
    intentHash: hash({ sessionId, sessionVersion }),
    materialHash: hash({ snapshot: 'native-fixture' }),
    manualInput: {
      parentId: 'session-parent',
      correlationId: 'session-correlation',
      accountId: 'checking',
      amount: -20,
      date: '2098-01-01',
      categoryId: 'food',
    },
    categoryCharges: [{ categoryId: 'food', amount: money('20') }],
    cooldownUntil: null,
  };
}
function completionClaim(): LiquidityClaimBundle {
  return {
    id: 'completion-claim',
    creationSnapshotId: 'snapshot',
    creationPolicyVersion: 'native-1',
    state: 'active',
    expiresAt: later,
    initiated: false,
    effects: [
      {
        kind: 'account_debit',
        resourceId: 'checking',
        amount: money('20'),
        economicObligationId: 'completion:completion-session:account:checking',
        categoryId: null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
      {
        kind: 'category',
        resourceId: 'food',
        amount: money('20'),
        economicObligationId: 'completion:completion-session:category:food',
        categoryId: 'food',
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
  };
}
function transferPlan(): TransferPlan {
  const before = (accountId: string) => ({
    accountId,
    recordedBalance: money('100'),
    signedHeadroom: money('100'),
    backingCapacity: money('100'),
    baselineTransactionIds: [],
  });
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId: 'transfer-snapshot',
    contentHash: 'ledger',
    policyVersion: 'native-1',
    policyHash: 'native-policy',
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt: later,
    minimumAmount: money('20'),
    payloadHash: 'a'.repeat(64),
    legs: [{
      id: 'transfer-leg',
      sourceAccountId: 'checking',
      destinationAccountId: 'savings',
      amount: money('20'),
      requiredBy: later,
      estimatedArrival: now,
      timingRouteId: 'route',
      sourceBefore: before('checking'),
      destinationBefore: before('savings'),
      sourceAfter: money('80'),
      destinationAfter: money('120'),
    }],
    reservations: [{
      kind: 'account_debit',
      resourceId: 'checking',
      amount: money('20'),
      economicObligationId: 'transfer:checking',
      categoryId: null,
      includedInBalance: false,
      matchedTransactionIds: [],
    }],
    backingAfter: {
      version: '1',
      snapshotId: 'transfer-snapshot',
      contentHash: 'ledger',
      policyVersion: 'native-1',
      policyHash: 'native-policy',
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}



describe('Phase 7 governance boundary regressions', () => {
  let store: SqliteWorkflowStore;
  let governance: SqliteWorkflowStore['governance'];
  let space: Space;
  let ownerMembershipId: string;
  let nativePolicyCreated = false;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    const claimId = 'governance-boundary-fixture';
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId });
    await store.finalizeBootstrap({ claimId, ownerUserId: ownerId });
    governance = store.governance;
    space = governance.createSpace({
      actorId: ownerId,
      name: 'Governed budget',
      kind: 'shared',
      now,
      auth: auth(ownerId),
    });
    space = governance.bindBudget({ spaceId: space.id, budgetId, now, auth: auth(ownerId) });
    ownerMembershipId = governance.getCurrentMembership({
      spaceId: space.id,
      actorId: ownerId,
      now,
    })!.id;
    nativePolicyCreated = false;
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function currentPolicy() {
    return governance.getPolicy({ spaceId: space.id }) ?? governance.setPolicy({
      spaceId: space.id,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: {} },
      now,
      auth: auth(ownerId),
    });
  }
  function liquidityContext(at = now, membershipId = ownerMembershipId) {
    return {
      actorId: ownerId,
      budgetId,
      spaceId: space.id,
      membershipId,
      governancePolicyVersion: currentPolicy().version,
      now: at,
      auth: auth(ownerId, at),
    };
  }

  function grant(
    actorId: string,
    membershipId: string,
    capability: string,
    resourceKind: 'budget' | 'account' | 'category' | 'space',
    resourceId: string,
    at = now,
    restrictions?: { readonly operations?: readonly string[] },
  ) {
    return governance.provisionResourceGrant({
      spaceId: space.id,
      actorId,
      budgetId,
      membershipId,
      capability,
      resourceKind,
      resourceId,
      granted: true,
      ...(restrictions === undefined ? {} : { restrictions }),
      now: at,
    });
  }

  function authorizeAgent(input: {
    policyVersion: string;
    agentId: string;
    delegationId: string;
    delegationVersion: string;
    credentialId: string;
    at?: string;
  }) {
    const at = input.at ?? now;
    return governance.authorize({
      actorId: input.agentId,
      agentId: input.agentId,
      delegationId: input.delegationId,
      delegationVersion: input.delegationVersion,
      spaceId: space.id,
      expectedPolicyVersion: input.policyVersion,
      phase: 'read',
      operation: 'summary.read',
      required: [{ capability: 'summary', resourceKind: 'budget', resourceId: budgetId }],
      payload: { operations: [] },
      now: at,
      auth: {
        method: 'api-key',
        actorId: input.agentId,
        credentialId: input.credentialId,
        credentialOwnerId: ownerId,
        principalType: 'agent',
        delegationId: input.delegationId,
        delegationVersion: input.delegationVersion,
      },
    });
  }

  async function prepareNativeLiquidity(membershipId = ownerMembershipId, at = now) {
    const policy = currentPolicy();
    grant(ownerId, membershipId, 'policy', 'budget', budgetId, at);
    if (!nativePolicyCreated) {
      store.liquidity.savePolicy({
        ...liquidityContext(at, membershipId),
        expectedVersion: null,
        expectedGovernancePolicyVersion: policy.version,
        policy: {
          version: 'native-1',
          policyHash: 'native-policy',
          expiresAt: later,
          accounts: [],
          transferRoutes: [],
        },
        approvalPolicy: { minimumApprovers: 1 },
      });
      nativePolicyCreated = true;
    }
    for (const capability of nativeCapabilities) {
      if (capability === 'policy') continue;
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['account', 'checking'],
        ['account', 'savings'],
        ['category', 'food'],
      ] as const)
        grant(ownerId, membershipId, capability, resourceKind, resourceId, at);
    }
  }

  async function rejoinOwner() {
    const managerId = 'governance-manager';
    await store.upsertActorMembership(managerId, 'active', [], '');
    const manager = governance.addMembership({
      spaceId: space.id,
      actorId: managerId,
      validFrom: now,
      now,
      auth: auth(ownerId),
    });
    governance.provisionResourceGrant({
      spaceId: space.id,
      actorId: managerId,
      budgetId,
      membershipId: manager.id,
      capability: 'identity:manage',
      resourceKind: 'space',
      resourceId: space.id,
      granted: true,
      now,
    });
    governance.revokeMembership({
      spaceId: space.id,
      membershipId: ownerMembershipId,
      now: after,
      auth: auth(ownerId, after),
    });
    const rejoined = governance.addMembership({
      spaceId: space.id,
      actorId: ownerId,
      validFrom: after,
      now: after,
      auth: auth(managerId, after),
    });
    ownerMembershipId = rejoined.id;
    return rejoined;
  }

  function setGovernanceApprovers(minimumApprovers: number, at: string) {
    const current = currentPolicy();
    return governance.setPolicy({
      spaceId: space.id,
      expectedVersion: current.version,
      policy: { minimumApprovers, approvalThresholds: [], operationApprovers: {} },
      now: at,
      auth: auth(ownerId, at),
    });
  }

  async function admitCompletion() {
    await prepareNativeLiquidity();
    const session = store.liquidity.saveSpendSession({
      ...liquidityContext(),
      id: 'completion-session',
      expectedVersion: 0,
      idempotencyKey: 'completion-session:create',
      expiresAt: later,
      accountId: 'checking',
      items: [{
        id: 'completion-item',
        categoryId: 'food',
        amount: money('20'),
        accountId: 'checking',
        purchaseAt: now,
        requiredBy: later,
      }],
    }, () => ({ valid: true }));
    const payload = completionPayload(session.id, session.version);
    return store.liquidity.admitSessionCompletion({
      ...liquidityContext(),
      sessionId: session.id,
      expectedSessionVersion: session.version,
      payload,
      payloadHash: hash(payload),
      claim: completionClaim(),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'completion:admit',
    }, () => ({ valid: true }));
  }

  async function addCompletionApprover(actorId: string) {
    await store.upsertActorMembership(actorId, 'active', [], `budget:${budgetId}`);
    const membership = governance.addMembership({
      spaceId: space.id,
      actorId,
      validFrom: now,
      now,
      auth: auth(ownerId),
    });
    for (const capability of ['approval', 'proposal', 'session', 'liquidity'] as const)
      grant(actorId, membership.id, capability, 'budget', budgetId);
    for (const [resourceKind, resourceId] of [
      ['account', 'checking'],
      ['category', 'food'],
    ] as const)
      for (const capability of ['approval', 'liquidity', 'proposal'] as const)
        grant(actorId, membership.id, capability, resourceKind, resourceId);
    return {
      ...liquidityContext(now, membership.id),
      actorId,
      auth: auth(actorId),
    };
  }

  async function addTransferApprover(actorId: string) {
    await store.upsertActorMembership(actorId, 'active', [], `budget:${budgetId}`);
    const membership = governance.addMembership({
      spaceId: space.id,
      actorId,
      validFrom: now,
      now,
      auth: auth(ownerId),
    });
    grant(actorId, membership.id, 'approval', 'budget', budgetId);
    grant(actorId, membership.id, 'liquidity', 'budget', budgetId);
    for (const accountId of ['checking', 'savings'])
      grant(actorId, membership.id, 'approval', 'account', accountId);
    grant(actorId, membership.id, 'source', 'account', 'checking');
    return {
      ...liquidityContext(now, membership.id),
      actorId,
      auth: auth(actorId),
    };
  }

  async function admitTransfer() {
    await prepareNativeLiquidity();
    return store.liquidity.admitTransferProposal({
      ...liquidityContext(),
      plan: transferPlan(),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'transfer:admit',
    }, () => ({ valid: true }));
  }

  it('creates a ready control catalog and default one-human policy without financial grants', () => {
    const policy = governance.getPolicy({ spaceId: space.id });
    const grants = governance.listResourceGrants({ spaceId: space.id });
    const capabilities = grants.map(({ capability }) => capability);

    expect(policy?.minimumApprovers).toBe(1);
    expect(capabilities).toEqual(expect.arrayContaining([
      'identity:manage', 'connection:manage', 'audit:read', 'policy:manage',
    ]));
    expect(grants.some(({ capability }) =>
      ['conclusion', 'liquidity', 'proposal', 'approval', 'balance'].includes(capability),
    )).toBe(false);
  });

  it('authorizes current session-read and proposal scopes through the native adapter', async () => {
    await prepareNativeLiquidity();
    expect(store.liquidity.isAuthorized({
      ...liquidityContext(),
      capability: 'session',
      resourceKind: 'budget',
      resourceId: budgetId,
      phase: 'read',
    })).toBe(true);
    expect(store.liquidity.isAuthorized({
      ...liquidityContext(),
      capability: 'proposal',
      resourceKind: 'budget',
      resourceId: budgetId,
      phase: 'propose',
    })).toBe(true);
  });

  it('binds an existing budget only through the registered owner and never changes the binding', async () => {
    const personal = governance.createSpace({
      actorId: ownerId,
      name: 'Personal',
      kind: 'personal',
      now,
      auth: auth(ownerId),
    });
    await store.upsertActorMembership('manager', 'active', ['*'], '*');
    const manager = governance.addMembership({
      spaceId: personal.id,
      actorId: 'manager',
      validFrom: now,
      now,
      auth: auth(ownerId),
    });
    governance.provisionResourceGrant({
      spaceId: personal.id,
      actorId: 'manager',
      membershipId: manager.id,
      capability: 'connection:manage',
      resourceKind: 'space',
      resourceId: personal.id,
      granted: true,
      now,
    });
    governance.provisionResourceGrant({
      spaceId: personal.id,
      actorId: 'manager',
      membershipId: manager.id,
      capability: 'identity:manage',
      resourceKind: 'space',
      resourceId: personal.id,
      granted: true,
      now,
    });
    expect(() => governance.bindBudget({
      spaceId: personal.id,
      budgetId: 'arbitrary-budget',
      now,
      auth: auth('manager'),
    })).toThrow();
    expect(() => governance.bindBudget({
      spaceId: personal.id,
      budgetId,
      now,
      auth: auth(ownerId),
    })).toThrow();
    expect(governance.bindBudget({
      spaceId: personal.id,
      budgetId: 'unused-budget',
      now,
      auth: auth(ownerId),
    }).budgetId).toBe('unused-budget');
    const membership = governance.getCurrentMembership({
      spaceId: personal.id,
      actorId: ownerId,
      now,
    })!;
    const policy = governance.getPolicy({ spaceId: personal.id })!;
    expect(governance.authorize({
      actorId: ownerId,
      spaceId: personal.id,
      membershipId: membership.id,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'identity:manage',
      required: [{ capability: 'identity:manage', resourceKind: 'space', resourceId: personal.id }],
      payload: { operations: [] },
      now,
      auth: auth(ownerId),
    }).allowed).toBe(true);
    expect(governance.authorize({
      actorId: 'manager',
      spaceId: personal.id,
      membershipId: manager.id,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'identity:manage',
      required: [{ capability: 'identity:manage', resourceKind: 'space', resourceId: personal.id }],
      payload: { operations: [] },
      now,
      auth: auth('manager'),
    }).allowed).toBe(true);
    expect(governance.listResourceGrants({ spaceId: personal.id }).some(({ capability }) =>
      ['conclusion', 'liquidity', 'proposal', 'approval', 'balance'].includes(capability),
    )).toBe(false);
    expect(() => governance.bindBudget({
      spaceId: personal.id,
      budgetId: 'different-budget',
      now,
      auth: auth(ownerId),
    })).toThrow();
  });

  it('normalizes equivalent UTC timestamps when resolving half-open membership periods', async () => {
    await store.upsertActorMembership('member', 'active', [], '');
    const membership = governance.addMembership({
      spaceId: space.id,
      actorId: 'member',
      validFrom: '2098-01-01T12:00:00Z',
      now,
      auth: auth(ownerId),
    });

    expect(governance.getCurrentMembership({ spaceId: space.id, actorId: 'member', now })?.id)
      .toBe(membership.id);
  });

  it('applies operation restrictions to membership-management control actions', async () => {
    await store.upsertActorMembership('member', 'active', [], '');
    governance.setResourceGrant({
      spaceId: space.id,
      actorId: ownerId,
      budgetId,
      membershipId: ownerMembershipId,
      capability: 'identity:manage',
      resourceKind: 'space',
      resourceId: space.id,
      granted: true,
      restrictions: { operations: [] },
      now,
      auth: auth(ownerId),
    });

    expect(() => governance.addMembership({
      spaceId: space.id,
      actorId: 'member',
      validFrom: now,
      now,
      auth: auth(ownerId),
    })).toThrow();
  });

  it('never bypasses approval through inherited operation-policy property names', () => {
    const policy = currentPolicy();
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId);
    const request = {
      actorId: ownerId,
      spaceId: space.id,
      membershipId: ownerMembershipId,
      expectedPolicyVersion: policy.version,
      phase: 'propose' as const,
      required: [{ capability: 'summary', resourceKind: 'budget' as const, resourceId: budgetId }],
      payload: { operations: [] },
      now,
      auth: auth(ownerId),
    };
    for (const operation of ['toString', 'constructor', '__proto__']) {
      const result = governance.authorize({ ...request, operation });
      expect(['approval_required', 'denied']).toContain(result.disposition.kind);
    }

    const configured = governance.setPolicy({
      spaceId: space.id,
      expectedVersion: policy.version,
      policy: {
        minimumApprovers: 1,
        approvalThresholds: [],
        operationApprovers: Object.defineProperty({}, '__proto__', { value: 3, enumerable: true }),
      },
      now,
      auth: auth(ownerId),
    });
    const result = governance.authorize({
      ...request,
      expectedPolicyVersion: configured.version,
      operation: '__proto__',
    });
    expect(result.requiredApprovers).toBe(3);
    expect(result.disposition.kind).toBe('approval_required');
  });

  it('keeps delegated restrictions narrower than issuer grants during current agent authorization', () => {
    const previousPolicy = currentPolicy();
    const policy = governance.setPolicy({
      spaceId: space.id,
      expectedVersion: previousPolicy.version,
      policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: {} },
      now,
      auth: auth(ownerId),
    });
    const capability = 'categorization:propose';
    const issuerBounds = {
      accountIds: ['checking', 'savings'],
      categoryIds: ['food', 'rent'],
      operations: ['set_category', 'transfer'],
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '10000' }],
      maxOperationCount: 5,
    };
    const delegatedBounds = {
      accountIds: ['checking'],
      categoryIds: ['food'],
      operations: ['set_category'],
      proposalOnly: true,
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '5000' }],
      maxOperationCount: 1,
    };
    const resources = [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      { resourceKind: 'account' as const, resourceId: 'checking' },
      { resourceKind: 'account' as const, resourceId: 'savings' },
      { resourceKind: 'category' as const, resourceId: 'food' },
      { resourceKind: 'category' as const, resourceId: 'rent' },
    ];
    for (const resource of resources) {
      governance.provisionResourceGrant({
        spaceId: space.id,
        actorId: ownerId,
        membershipId: ownerMembershipId,
        budgetId,
        capability,
        ...resource,
        granted: true,
        restrictions: issuerBounds,
        now,
      });
    }

    const agentId = 'agent:narrow-bounds';
    const credentialId = 'key:narrow-bounds';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth(ownerId) });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: null,
      rights: resources.map((resource) => ({ capability, ...resource, restrictions: delegatedBounds })),
      validFrom: now,
      validUntil: tomorrow,
      now,
      auth: auth(ownerId),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId,
      credentialOwnerId: ownerId,
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth(ownerId),
    });

    const authorize = (request: {
      readonly phase?: 'propose' | 'execute';
      readonly operation?: string;
      readonly accountId?: string;
      readonly categoryId?: string;
      readonly amounts?: readonly string[];
    } = {}) => {
      const phase = request.phase ?? 'propose';
      const accountId = request.accountId ?? 'checking';
      const categoryId = request.categoryId ?? 'food';
      return governance.authorize({
        actorId: agentId,
        agentId,
        delegationId: delegation.id,
        delegationVersion: delegation.version,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase,
        operation: request.operation ?? 'set_category',
        required: [
          { capability, resourceKind: 'budget', resourceId: budgetId },
          { capability, resourceKind: 'account', resourceId: accountId },
          { capability, resourceKind: 'category', resourceId: categoryId },
        ],
        payload: {
          operations: (request.amounts ?? ['4000']).map((minorUnits) => ({
            operation: 'set_category',
            direction: 'outgoing',
            amount: money(minorUnits),
            accountId,
            categoryId,
          })),
        },
        now,
        auth: {
          method: 'api-key',
          actorId: agentId,
          credentialId,
          credentialOwnerId: ownerId,
          principalType: 'agent',
          delegationId: delegation.id,
          delegationVersion: delegation.version,
        },
        ...(phase === 'execute' ? { verifiedHumanApproval: true } : {}),
      });
    };

    expect(delegation.rights.find((right) => right.resourceKind === 'budget')?.restrictions)
      .toEqual(delegatedBounds);
    expect(authorize()).toMatchObject({
      allowed: true,
      disposition: { kind: 'approval_required' },
      policyVersion: policy.version,
    });
    expect([
      authorize({ amounts: ['5001'] }).disposition.kind,
      authorize({ amounts: ['100', '100'] }).disposition.kind,
      authorize({ operation: 'transfer' }).disposition.kind,
      authorize({ phase: 'execute' }).disposition.kind,
      authorize({ accountId: 'savings' }).disposition.kind,
      authorize({ categoryId: 'rent' }).disposition.kind,
    ]).toEqual(Array(6).fill('denied'));

    for (const restrictions of [
      { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '10001' }] },
      { maxOperationCount: 6 },
      { accountIds: ['checking', 'savings', 'other'] },
      { categoryIds: ['food', 'rent', 'other'] },
      { operations: ['set_category', 'transfer', 'summary.read'] },
      { maxOperationCount: -1 },
    ]) {
      expect(() => governance.delegate({
        spaceId: space.id,
        agentId,
        issuerMembershipId: ownerMembershipId,
        expectedVersion: null,
        rights: [{ capability, resourceKind: 'budget', resourceId: budgetId, restrictions }],
        validFrom: now,
        validUntil: tomorrow,
        now,
        auth: auth(ownerId),
      })).toThrow();
    }

    governance.provisionResourceGrant({
      spaceId: space.id,
      actorId: ownerId,
      membershipId: ownerMembershipId,
      budgetId,
      capability,
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      restrictions: {
        ...issuerBounds,
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '3000' }],
      },
      now,
    });
    expect(authorize().disposition.kind).toBe('denied');
  });

  it('rejects an agent key after its exact delegation version is superseded', () => {
    const policy = currentPolicy();
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId);
    const agentId = 'agent:planner';
    const credentialId = 'key:planner';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth(ownerId) });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'budget', resourceId: budgetId }],
      validFrom: now,
      validUntil: tomorrow,
      now,
      auth: auth(ownerId),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId,
      credentialOwnerId: ownerId,
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth(ownerId),
    });
    const request = {
      policyVersion: policy.version,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      credentialId,
    };
    expect(authorizeAgent(request).disposition.kind).toBe('authorized_without_approval');

    governance.delegate({
      id: delegation.id,
      spaceId: space.id,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: delegation.version,
      rights: delegation.rights,
      validFrom: after,
      validUntil: tomorrow,
      now: after,
      auth: auth(ownerId, after),
    });

    expect(authorizeAgent({ ...request, at: after }).disposition.kind).toBe('denied');
  });

  it('keeps agent authority bound to the original issuer membership period', async () => {
    const policy = currentPolicy();
    const agentId = 'agent:original-issuer';
    const credentialId = 'key:original-issuer';
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId);
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth(ownerId) });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'budget', resourceId: budgetId }],
      validFrom: now,
      validUntil: tomorrow,
      now,
      auth: auth(ownerId),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId,
      credentialOwnerId: ownerId,
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth(ownerId),
    });
    expect(authorizeAgent({
      policyVersion: policy.version,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      credentialId,
    }).allowed).toBe(true);

    await rejoinOwner();
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId, after);

    expect(authorizeAgent({
      policyVersion: policy.version,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      credentialId,
      at: after,
    }).disposition.kind).toBe('denied');
  });

  it('rejects a revoked human API-key binding instead of trusting its unchanged actor ID', () => {
    const policy = currentPolicy();
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId);
    const credentialId = 'key:owner';
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId,
      credentialOwnerId: ownerId,
      principalType: 'human',
      principalId: ownerId,
      now,
      auth: auth(ownerId),
    });
    const request: GovernanceAuthorizationInput = {
      actorId: ownerId,
      spaceId: space.id,
      membershipId: ownerMembershipId,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'summary.read',
      required: [{ capability: 'summary', resourceKind: 'budget', resourceId: budgetId }],
      payload: { operations: [] },
      now,
      auth: {
        method: 'api-key',
        actorId: ownerId,
        credentialId,
        credentialOwnerId: ownerId,
        principalType: 'human',
      },
    };
    expect(governance.authorize(request).allowed).toBe(true);
    governance.revokeCredentialBinding({ credentialId, spaceId: space.id, now: after, auth: auth(ownerId, after) });

    expect(governance.authorize({ ...request, now: after }).disposition.kind).toBe('denied');
  });

  it('resolves bound credentials only in their selected space and live issuer period', async () => {
    const otherSpace = governance.createSpace({
      actorId: ownerId,
      name: 'Independent personal space',
      kind: 'personal',
      now,
      auth: auth(ownerId),
    });
    const resolveCredential = governance.resolveCredentialPrincipal.bind(governance);
    const humanCredentialId = 'key:scoped-human';
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId);
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: humanCredentialId,
      credentialOwnerId: ownerId,
      principalType: 'human',
      principalId: ownerId,
      now,
      auth: auth(ownerId),
    });
    expect(resolveCredential({
      credentialId: humanCredentialId,
      referenceId: ownerId,
      now,
      spaceId: space.id,
    })).toEqual(expect.objectContaining({ principalType: 'human', actorId: ownerId }));
    expect(resolveCredential({
      credentialId: humanCredentialId,
      referenceId: ownerId,
      now,
      spaceId: otherSpace.id,
    })).toBeNull();
    expect(resolveCredential({
      credentialId: 'key:unbound-human',
      referenceId: ownerId,
      now,
      spaceId: otherSpace.id,
    })).toEqual(expect.objectContaining({ principalType: 'human', actorId: ownerId }));
    const humanPolicy = currentPolicy();
    const humanRequest: GovernanceAuthorizationInput = {
      actorId: ownerId,
      spaceId: space.id,
      membershipId: ownerMembershipId,
      expectedPolicyVersion: humanPolicy.version,
      phase: 'read',
      operation: 'summary.read',
      required: [{ capability: 'summary', resourceKind: 'budget', resourceId: budgetId }],
      payload: { operations: [] },
      now,
      auth: {
        method: 'api-key',
        actorId: ownerId,
        credentialId: humanCredentialId,
        credentialOwnerId: ownerId,
        principalType: 'human',
      },
    };
    expect(governance.authorize(humanRequest).allowed).toBe(true);

    const agentId = 'agent:scoped';
    const credentialId = 'key:scoped-agent';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth(ownerId) });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'budget', resourceId: budgetId }],
      validFrom: now,
      validUntil: tomorrow,
      now,
      auth: auth(ownerId),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId,
      credentialOwnerId: ownerId,
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth(ownerId),
    });
    expect(resolveCredential({
      credentialId,
      referenceId: ownerId,
      now,
      spaceId: space.id,
    })).toEqual(expect.objectContaining({ principalType: 'agent', actorId: agentId }));
    expect(resolveCredential({
      credentialId,
      referenceId: ownerId,
      now,
      spaceId: otherSpace.id,
    })).toBeNull();

    await rejoinOwner();
    grant(ownerId, ownerMembershipId, 'summary', 'budget', budgetId, after);
    expect(resolveCredential({
      credentialId: humanCredentialId,
      referenceId: ownerId,
      now: after,
      spaceId: space.id,
    })).toBeNull();
    expect(resolveCredential({
      credentialId: 'key:unbound-human',
      referenceId: ownerId,
      now: after,
      spaceId: space.id,
    })).toEqual(expect.objectContaining({ principalType: 'human', actorId: ownerId }));
    expect(governance.authorize({
      ...humanRequest,
      membershipId: ownerMembershipId,
      now: after,
    }).disposition.kind).toBe('denied');
    expect(resolveCredential({
      credentialId,
      referenceId: ownerId,
      now: after,
      spaceId: space.id,
    })).toBeNull();
  });

  it('applies the currency threshold and operation maximum to session-completion approvals', async () => {
    const current = currentPolicy();
    governance.setPolicy({
      spaceId: space.id,
      expectedVersion: current.version,
      policy: {
        minimumApprovers: 1,
        approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10', requiredApprovers: 4 }],
        operationApprovers: { session_completion: 3 },
      },
      now,
      auth: auth(ownerId),
    });
    const proposal = await admitCompletion();
    const approver = await addCompletionApprover('completion-threshold-approver');
    const approved = store.liquidity.approveSessionCompletion({
      ...approver,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'completion:one-approval',
      now,
    }, () => ({ valid: true }));

    expect(approved.requiredApprovals).toBe(4);
    expect(approved.approvalCount).toBe(1);
    expect(approved.state.phase).toBe('proposed');
    expect(() => store.liquidity.beginSessionCompletionWrite({
      ...liquidityContext(),
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'completion:unapproved-write',
      now,
      auth: auth(ownerId),
    }, () => ({ valid: true }))).toThrow();
    expect(store.liquidity.getClaimSet(liquidityContext()).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'completion-claim', state: 'active' })]));
  });

  it('rechecks the live governance quorum before acquiring a completion write intent', async () => {
    const proposal = await admitCompletion();
    const approver = await addCompletionApprover('completion-quorum-approver');
    const approved = store.liquidity.approveSessionCompletion({
      ...approver,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'completion:approve-before-policy-change',
      now,
    }, () => ({ valid: true }));
    expect(approved.state.phase).toBe('approved');
    setGovernanceApprovers(2, after);

    expect(() => store.liquidity.beginSessionCompletionWrite({
      ...liquidityContext(after),
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'completion:write-after-policy-change',
      now: after,
      auth: auth(ownerId, after),
    }, () => ({ valid: true }))).toThrow();
    expect(store.liquidity.getClaimSet(liquidityContext(after)).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'completion-claim', state: 'active' })]));
  });

  it('does not let a previous membership period approve native session completion writes', async () => {
    const proposal = await admitCompletion();
    const approver = await addCompletionApprover('completion-old-period-approver');
    const approved = store.liquidity.approveSessionCompletion({
      ...approver,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'completion:old-period-approval',
      now,
    }, () => ({ valid: true }));
    expect(approved.state.phase).toBe('approved');
    await rejoinOwner();

    expect(() => store.liquidity.beginSessionCompletionWrite({
      ...liquidityContext(after),
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'completion:write-after-rejoin',
      now: after,
      auth: auth(ownerId, after),
    }, () => ({ valid: true }))).toThrow();
    for (const [resourceKind, resourceId] of [
      ['budget', budgetId],
      ['account', 'checking'],
      ['category', 'food'],
    ] as const)
      grant(approver.actorId, approver.membershipId, 'liquidity', resourceKind, resourceId, after);
    expect(store.liquidity.getClaimSet({ ...approver, now: after }).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'completion-claim', state: 'active' })]));
  });

  it('applies currency and operation approval requirements to transfer initiation', async () => {
    const current = currentPolicy();
    governance.setPolicy({
      spaceId: space.id,
      expectedVersion: current.version,
      policy: {
        minimumApprovers: 1,
        approvalThresholds: [{ currency: 'USD', amountMinorUnits: '10', requiredApprovers: 4 }],
        operationApprovers: { transfer: 3 },
      },
      now,
      auth: auth(ownerId),
    });
    const proposal = await admitTransfer();
    const approver = await addTransferApprover('transfer-threshold-approver');
    const approved = store.liquidity.approveTransfer({
      ...approver,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'transfer:one-approval',
      now,
    }, () => ({ valid: true }));
    const summary = store.liquidity.getTransferApprovalSummary({
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      now,
    });

    expect(summary.requiredApprovals).toBe(4);
    expect(summary.approvalCount).toBe(1);
    expect(approved.state.phase).toBe('awaiting_approval');
    expect(() => store.liquidity.reportTransferInitiated({
      ...liquidityContext(),
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'transfer:unapproved-initiation',
      now,
      auth: auth(ownerId),
    }, () => ({ valid: true }))).toThrow();
    expect(store.liquidity.getClaimSet(liquidityContext()).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'active' })]));
  });

  it('rechecks the live governance quorum before transfer initiation', async () => {
    const proposal = await admitTransfer();
    const approver = await addTransferApprover('transfer-quorum-approver');
    const approved = store.liquidity.approveTransfer({
      ...approver,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'transfer:approve-before-policy-change',
      now,
    }, () => ({ valid: true }));
    expect(approved.state.phase).toBe('approved');
    setGovernanceApprovers(2, after);

    expect(() => store.liquidity.reportTransferInitiated({
      ...liquidityContext(after),
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'transfer:initiate-after-policy-change',
      now: after,
      auth: auth(ownerId, after),
    }, () => ({ valid: true }))).toThrow();
    expect(store.liquidity.getClaimSet(liquidityContext(after)).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'active' })]));
  });

  it('does not let a previous membership period authorize transfer initiation', async () => {
    const proposal = await admitTransfer();
    const approver = await addTransferApprover('transfer-old-period-approver');
    const approved = store.liquidity.approveTransfer({
      ...approver,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'transfer:old-period-approval',
      now,
    }, () => ({ valid: true }));
    expect(approved.state.phase).toBe('approved');
    await rejoinOwner();

    expect(() => store.liquidity.reportTransferInitiated({
      ...liquidityContext(after),
      actorId: ownerId,
      budgetId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'transfer:initiate-after-rejoin',
      now: after,
      auth: auth(ownerId, after),
    }, () => ({ valid: true }))).toThrow();
    for (const [resourceKind, resourceId] of [
      ['budget', budgetId],
      ['account', 'checking'],
    ] as const)
      grant(approver.actorId, approver.membershipId, 'liquidity', resourceKind, resourceId, after);
    expect(store.liquidity.getClaimSet({ ...approver, now: after }).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'active' })]));
  });

  it('does not restore payment preferences or prospective-claim write authority after departure and rejoin', async () => {
    await prepareNativeLiquidity();
    store.liquidity.savePaymentPreference({
      ...liquidityContext(),
      actorId: ownerId,
      budgetId,
      id: 'preferred-route',
      expectedVersion: 0,
      categoryId: 'food',
      accountId: 'checking',
      expiresAt: later,
      now,
    });
    const claim: ProspectiveClaim & { mode: 'block' } = {
      claimId: 'private-claim',
      kind: 'reservation',
      sourceId: 'obligation:private',
      scope: { kind: 'category', id: 'food' },
      amount: { minorUnits: '20', currency: 'USD' },
      status: 'active',
      effectiveFrom: now,
      expiresAt: later,
      visibility: 'visible',
      policyVersion: 'native-1',
      snapshotId: 'snapshot-1',
      mode: 'block',
    };
    store.liquidity.saveProspectiveClaim({
      ...liquidityContext(),
      actorId: ownerId,
      budgetId,
      claim,
      expectedClaimSetRevision: '0',
      idempotencyKey: 'claim:create',
      now,
    }, () => ({ valid: true }));

    await rejoinOwner();
    for (const [resourceKind, resourceId] of [
      ['budget', budgetId],
      ['account', 'checking'],
      ['category', 'food'],
    ] as const)
      grant(ownerId, ownerMembershipId, 'liquidity', resourceKind, resourceId, after);

    expect(store.liquidity.getPaymentPreferences(liquidityContext(after))).toEqual([]);
    expect(store.liquidity.listProspectiveClaims(liquidityContext(after))).toEqual([]);
    expect(() => store.liquidity.transitionProspectiveClaim({
      ...liquidityContext(after),
      claimId: claim.claimId,
      transition: 'release',
      expectedClaimSetRevision: '1',
      idempotencyKey: 'claim:old-membership-release',
      now: after,
    })).toThrow();
    expect(store.liquidity.getClaimSet(liquidityContext(after)).bundles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: claim.claimId, state: 'active' })]));
  });
});
