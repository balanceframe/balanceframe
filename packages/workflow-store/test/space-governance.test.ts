import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import { GENERIC_MUTATION_POLICY_VERSION } from '../src/index.js';
import type { TransferPlan } from '@balanceframe/protocol-generated';
import type {
  ApprovalThreshold,
  GovernanceAuthorizationInput,
  GovernanceOperation,
  HumanControlContext,
  ResourceGrantRestrictions,
} from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const after = '2098-01-01T13:00:00.000Z';
const tomorrow = '2098-01-02T12:00:00.000Z';
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function auditTransferPlan(): TransferPlan {
  const sourceAccountId = 'private-source-account';
  const destinationAccountId = 'private-destination-account';
  const snapshotId = 'audit-snapshot';
  const contentHash = 'audit-content';
  const policyVersion = '1';
  const policyHash = 'private-financial-policy';
  const before = (accountId: string) => ({
    accountId,
    recordedBalance: usd('10000'),
    signedHeadroom: usd('10000'),
    backingCapacity: usd('10000'),
    baselineTransactionIds: [],
  });
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId,
    contentHash,
    policyVersion,
    policyHash,
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt: tomorrow,
    minimumAmount: usd('2000'),
    payloadHash: 'a'.repeat(64),
    legs: [{
      id: 'audit-transfer-leg',
      sourceAccountId,
      destinationAccountId,
      amount: usd('2000'),
      requiredBy: tomorrow,
      estimatedArrival: now,
      timingRouteId: 'audit-route',
      sourceBefore: before(sourceAccountId),
      destinationBefore: before(destinationAccountId),
      sourceAfter: usd('8000'),
      destinationAfter: usd('12000'),
    }],
    reservations: [{
      kind: 'account_debit',
      resourceId: sourceAccountId,
      amount: usd('2000'),
      economicObligationId: 'private-obligation-reference',
      categoryId: null,
      includedInBalance: false,
      matchedTransactionIds: [],
    }],
    backingAfter: {
      version: '1',
      snapshotId,
      contentHash,
      policyVersion,
      policyHash,
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}
const auth = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
  method: 'human-session',
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt,
});
const untrustedAuth = (method: 'api-key' | 'agent') =>
  ({ ...auth('owner'), method }) as never;

describe('space governance persistence and authorization', () => {
  let store: SqliteWorkflowStore;
  let governance: SqliteWorkflowStore['governance'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: 'owner' });
    governance = store.governance;
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  async function identity(actorId: string, status: 'active' | 'inactive' = 'active') {
    // Actor-wide capabilities/scope are identity state, never space authority.
    await store.upsertActorMembership(actorId, status, ['*'], '*');
  }

  function createSpace(
    actorId: string,
    kind: 'personal' | 'shared' = 'shared',
    budgetId?: string,
    context: HumanControlContext = auth(actorId),
  ) {
    const space = governance.createSpace({
      actorId,
      name: `${actorId}-${kind}`,
      kind,
      now,
      auth: context,
    });
    return budgetId === undefined
      ? space
      : governance.bindBudget({ spaceId: space.id, budgetId, now, auth: context });
  }

  function addMember(
    spaceId: string,
    actorId: string,
    validFrom = now,
    validUntil?: string,
    at = now,
  ) {
    return governance.addMembership({
      spaceId,
      actorId,
      validFrom,
      ...(validUntil === undefined ? {} : { validUntil }),
      now: at,
      auth: auth('owner', at),
    });
  }

  function setPolicy(
    spaceId: string,
    approvalThresholds: ApprovalThreshold[] = [],
    at = now,
  ) {
    const current = governance.getPolicy({ spaceId });
    return governance.setPolicy({
      spaceId,
      expectedVersion: current?.version ?? null,
      policy: { minimumApprovers: 1, approvalThresholds, operationApprovers: {} },
      now: at,
      auth: auth('owner', at),
    });
  }

  function grant(input: {
    actorId: string;
    budgetId: string;
    membershipId: string;
    capability: string;
    resourceKind: 'budget' | 'account' | 'category';
    resourceId: string;
    restrictions?: ResourceGrantRestrictions;
    authActorId?: string;
    at?: string;
  }) {
    const space = governance.getSpaceForBudget({ budgetId: input.budgetId });
    if (!space) throw new Error('Expected bound test budget');
    const at = input.at ?? now;
    return governance.setResourceGrant({
      spaceId: space.id,
      actorId: input.actorId,
      budgetId: input.budgetId,
      membershipId: input.membershipId,
      capability: input.capability,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      granted: true,
      ...(input.restrictions === undefined ? {} : { restrictions: input.restrictions }),
      now: at,
      auth: auth(input.authActorId ?? 'owner', at),
    });
  }

  function decision(
    input: Omit<GovernanceAuthorizationInput, 'payload' | 'now'> & {
      operations?: readonly GovernanceOperation[];
      now?: string;
    },
  ) {
    const { operations, ...request } = input;
    return governance.authorize({
      ...request,
      now: input.now ?? now,
      payload: { operations: operations ?? [] },
    });
  }

  it('reads an exact current grant without widening actor, membership, budget, resource, or capability', () => {
    const space = createSpace('owner', 'shared', 'budget');
    const membership = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now })!;
    const exact = { actorId: 'owner', spaceId: space.id, membershipId: membership.id, budgetId: 'budget',
      resourceKind: 'budget' as const, resourceId: 'budget', capability: 'source' };
    const granted = grant({ ...exact, restrictions: { accountIds: ['checking'] } });
    expect(governance.currentResourceGrant(exact)).toEqual(granted);
    for (const changed of [
      { actorId: 'other' }, { spaceId: 'other' }, { membershipId: 'other' }, { budgetId: 'other' },
      { resourceKind: 'account' as const }, { resourceId: 'other' }, { capability: 'rule:view' },
    ]) expect(governance.currentResourceGrant({ ...exact, ...changed })).toBeNull();
    governance.setResourceGrant({ ...exact, granted: false, now, auth: auth('owner') });
    expect(governance.currentResourceGrant(exact)).toBeNull();
  });

  it('creates spaces unbound and binds at most one budget through the owner operation', () => {
    const personal = createSpace('owner', 'personal');
    const shared = createSpace('owner', 'shared');
    const bound = governance.bindBudget({
      spaceId: shared.id,
      budgetId: 'budget-one',
      now,
      auth: auth('owner'),
    });

    expect(personal).toMatchObject({ kind: 'personal', budgetId: null, createdBy: 'owner' });
    expect(shared).toMatchObject({ kind: 'shared', budgetId: null, createdBy: 'owner' });
    expect(bound).toMatchObject({ kind: 'shared', budgetId: 'budget-one', createdBy: 'owner' });
    expect(governance.getCurrentMembership({ spaceId: personal.id, actorId: 'owner', now })).toMatchObject({
      actorId: 'owner',
      spaceId: personal.id,
    });
    const duplicate = createSpace('owner', 'shared');
    expect(() => governance.bindBudget({
      spaceId: duplicate.id,
      budgetId: 'budget-one',
      now,
      auth: auth('owner'),
    })).toThrow(/budget|space|bound/i);

    const policy = setPolicy(shared.id);
    const ownerMembership = governance.getCurrentMembership({
      spaceId: shared.id,
      actorId: 'owner',
      now,
    });
    expect(ownerMembership).not.toBeNull();
    const ownerRead = decision({
      actorId: 'owner',
      membershipId: ownerMembership!.id,
      spaceId: shared.id,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'balance.read',
      required: [
        { capability: 'balance', resourceKind: 'account', resourceId: 'checking', visibility: 'resource' },
      ],
    });
    expect(ownerRead.disposition.kind).toBe('denied'); // control-plane owner access does not imply financial access
  });

  it('uses half-open membership periods and keeps revoked attribution separate from a new grant period', async () => {
    await identity('member');
    const space = createSpace('owner', 'shared', 'budget');
    const first = addMember(space.id, 'member', now, after);
    const policy = setPolicy(space.id);
    const oldGrant = grant({
      actorId: 'member',
      budgetId: 'budget',
      membershipId: first.id,
      capability: 'summary',
      resourceKind: 'budget',
      resourceId: 'budget',
      restrictions: { aggregateOnly: true },
    });

    expect(oldGrant).toMatchObject({ actorId: 'member', membershipId: first.id, restrictions: { aggregateOnly: true } });
    expect(governance.getCurrentMembership({ spaceId: space.id, actorId: 'member', now })?.id).toBe(first.id);
    expect(governance.getCurrentMembership({ spaceId: space.id, actorId: 'member', now: after })).toBeNull();
    expect(
      decision({
        actorId: 'member',
        membershipId: first.id,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase: 'read',
        operation: 'summary.read',
        required: [{ capability: 'summary', resourceKind: 'budget', resourceId: 'budget', visibility: 'aggregate' }],
      }).disposition.kind,
    ).toBe('authorized_without_approval');

    expect(() => addMember(space.id, 'member', now, now)).toThrow(/time|interval|valid|overlap/i);
    expect(() => addMember(space.id, 'member', now, tomorrow)).toThrow(/overlap|membership|period/i);
    governance.revokeMembership({ spaceId: space.id, membershipId: first.id, now: after, auth: auth('owner', after) });
    const second = addMember(space.id, 'member', after, undefined, after);

    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ actorId: 'member', grantedBy: 'owner', validFrom: after });
    expect(governance.getCurrentMembership({ spaceId: space.id, actorId: 'member', now: after })?.id).toBe(
      second.id,
    );
    expect(governance.listMembershipHistory({ spaceId: space.id, actorId: 'member' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, actorId: 'member', grantedBy: 'owner', revokedAt: after }),
        expect.objectContaining({ id: second.id, actorId: 'member', grantedBy: 'owner' }),
      ]),
    );
    expect(
      governance.listResourceGrants({ spaceId: space.id, actorId: 'member' }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: oldGrant!.id, membershipId: first.id })]));
    expect(
      decision({
        actorId: 'member',
        membershipId: second.id,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase: 'read',
        operation: 'summary.read',
        required: [{ capability: 'summary', resourceKind: 'budget', resourceId: 'budget', visibility: 'aggregate' }],
        now: after,
      }).disposition.kind,
    ).toBe('denied');
    expect(
      decision({
        actorId: 'member',
        membershipId: first.id,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase: 'read',
        operation: 'summary.read',
        required: [{ capability: 'summary', resourceKind: 'budget', resourceId: 'budget', visibility: 'aggregate' }],
        now: after,
      }).disposition.kind,
    ).toBe('denied');
    expect(governance.listAuditRecords({ spaceId: space.id, actorId: 'owner', now: after })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: 'owner', classification: 'membership_added', subjectId: first.id }),
        expect.objectContaining({ actorId: 'owner', classification: 'membership_revoked', subjectId: first.id }),
      ]),
    );
  });
  it('lists only scoped Native operational audits without financial subjects or raw details', async () => {
    const budgetId = 'private-audit-budget';
    const space = createSpace('owner', 'shared', budgetId);
    const foreign = createSpace('owner', 'shared', 'foreign-audit-budget');
    const ownerMembership = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    if (!ownerMembership) throw new Error('Expected space owner membership');
    const memberships = new Map<string, string>();
    for (const actorId of ['auditor', 'proposer', 'approver', 'executor']) {
      await identity(actorId);
      memberships.set(actorId, addMember(space.id, actorId).id);
    }
    const auditorMembershipId = memberships.get('auditor');
    if (!auditorMembershipId) throw new Error('Expected current auditor membership');
    governance.setResourceGrant({
      spaceId: space.id,
      actorId: 'auditor',
      budgetId,
      membershipId: auditorMembershipId,
      capability: 'audit:read',
      resourceKind: 'space',
      resourceId: space.id,
      granted: true,
      now,
      auth: auth('owner'),
    });

    const proposalResources = [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      { resourceKind: 'transaction' as const, resourceId: 'private-transaction-reference' },
      { resourceKind: 'account' as const, resourceId: 'private-account-reference' },
      { resourceKind: 'category' as const, resourceId: 'private-category-reference' },
    ];
    for (const [actorId, capability] of [
      ['proposer', 'categorization:propose'],
      ['approver', 'categorization:approve'],
      ['executor', 'categorization:execute'],
    ] as const) {
      const membershipId = memberships.get(actorId);
      if (!membershipId) throw new Error('Expected current proposal actor membership');
      for (const resource of proposalResources)
        governance.setResourceGrant({
          spaceId: space.id,
          actorId,
          budgetId,
          membershipId,
          capability,
          ...resource,
          granted: true,
          now,
          auth: auth('owner'),
        });
    }

    const currentPolicy = governance.getPolicy({ spaceId: space.id });
    if (!currentPolicy) throw new Error('Expected governance policy');
    store.liquidity.savePolicy({
      actorId: 'owner',
      budgetId,
      spaceId: space.id,
      membershipId: ownerMembership.id,
      governancePolicyVersion: currentPolicy.version,
      expectedVersion: null,
      expectedGovernancePolicyVersion: currentPolicy.version,
      now,
      auth: auth('owner'),
      policy: {
        version: '1',
        policyHash: 'private-financial-policy',
        expiresAt: tomorrow,
        accounts: [],
        transferRoutes: [],
      },
      approvalPolicy: { minimumApprovers: 1 },
    });
    const financialResources = [
      { capability: 'proposal', resourceKind: 'budget' as const, resourceId: budgetId },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: 'private-source-account' },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: 'private-destination-account' },
      { capability: 'source', resourceKind: 'account' as const, resourceId: 'private-source-account' },
    ];
    for (const resource of financialResources)
      governance.setResourceGrant({
        spaceId: space.id,
        actorId: 'owner',
        budgetId,
        membershipId: ownerMembership.id,
        ...resource,
        granted: true,
        now,
        auth: auth('owner'),
      });
    const currentPolicyAfterLiquidity = governance.getPolicy({ spaceId: space.id });
    if (!currentPolicyAfterLiquidity) throw new Error('Expected current governance policy');
    store.liquidity.admitTransferProposal({
      actorId: 'owner',
      budgetId,
      spaceId: space.id,
      membershipId: ownerMembership.id,
      governancePolicyVersion: currentPolicyAfterLiquidity.version,
      now,
      auth: auth('owner'),
      plan: auditTransferPlan(),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'audit-financial-action',
    }, () => ({ valid: true }));

    const proposal = await store.createProposal({
      spaceId: space.id,
      operation: 'set_category',
      budgetId,
      payload: {
        kind: 'set_category',
        transactionId: 'private-transaction-reference',
        categoryId: 'private-category-reference',
      },
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify({
        transactionId: 'private-transaction-reference',
        accountId: 'private-account-reference',
        amount: usd('12500'),
        direction: 'outgoing',
        currentCategoryId: null,
        actualVersion: 'actual-v1',
      }),
      expiresAt: tomorrow,
      actorId: 'proposer',
      auth: auth('proposer'),
      provenance: 'native-audit-test',
    });
    const approval = await store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'approver',
      expiresAt: tomorrow,
      auth: auth('approver'),
      now,
    });
    await store.acquireProposalExecution({
      actorId: 'executor',
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      governancePolicyVersion: proposal.governancePolicyVersion,
      idempotencyKey: 'audit-generic-execution',
      serialisedEffect: JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions),
      }),
      auth: auth('executor'),
      now,
    });
    const invitation = await store.createInvitation({ spaceId: space.id, auth: auth('owner'), now });
    await store.revokeInvitation({
      spaceId: space.id,
      invitationId: invitation.invitation.id,
      auth: auth('owner'),
      now,
    });
    const foreignInvitation = await store.createInvitation({
      spaceId: foreign.id,
      auth: auth('owner', after),
      now: after,
    });
    await store.revokeInvitation({
      spaceId: foreign.id,
      invitationId: foreignInvitation.invitation.id,
      auth: auth('owner', after),
      now: after,
    });
    const unbound = createSpace('owner');
    const unboundInvitation = await store.createInvitation({
      spaceId: unbound.id,
      auth: auth('owner'),
      now,
    });
    await store.revokeInvitation({
      spaceId: unbound.id,
      invitationId: unboundInvitation.invitation.id,
      auth: auth('owner'),
      now,
    });

    const records = governance.listAuditRecords({ spaceId: space.id, actorId: 'auditor', now: after });
    expect(records.map(({ actorId, classification, timestamp }) => ({ actorId, classification, timestamp })))
      .toEqual(expect.arrayContaining([
        { actorId: 'approver', classification: 'approval_granted', timestamp: now },
        { actorId: 'executor', classification: 'execution_started', timestamp: now },
        { actorId: 'owner', classification: 'workflow_transition', timestamp: now },
        { actorId: 'owner', classification: 'invitation_created', timestamp: now },
        { actorId: 'owner', classification: 'invitation_revoked', timestamp: now },
      ]));
    const operational = records.filter(({ classification }) => [
      'approval_granted', 'execution_started', 'workflow_transition', 'invitation_created', 'invitation_revoked',
    ].includes(classification));
    expect(operational.every(({ subjectId }) => subjectId === null)).toBe(true);
    expect(records.every((record) => !Object.hasOwn(record, 'details'))).toBe(true);
    expect(records.some(({ classification, timestamp }) =>
      classification === 'invitation_created' && timestamp === after,
    )).toBe(false);
    const serialized = JSON.stringify(records);
    for (const privateValue of [
      budgetId,
      proposal.id,
      proposal.payloadHash,
      approval.id,
      invitation.invitation.id,
      invitation.inviteUrl,
      'private-transaction-reference',
      'private-account-reference',
      'private-category-reference',
      'private-source-account',
      'private-destination-account',
      'private-obligation-reference',
    ]) expect(serialized).not.toContain(privateValue);

    const unboundRecords = governance.listAuditRecords({ spaceId: unbound.id, actorId: 'owner', now: after });
    expect(unboundRecords.map(({ classification, actorId }) => ({ classification, actorId })))
      .toEqual(expect.arrayContaining([
        { classification: 'invitation_created', actorId: 'owner' },
        { classification: 'invitation_revoked', actorId: 'owner' },
      ]));
  });

  it('rejects invalid temporal boundaries, overlapping periods, and inactive identities', async () => {
    await identity('member');
    const space = createSpace('owner', 'shared', 'budget');
    const member = addMember(space.id, 'member', now, tomorrow);
    const policy = setPolicy(space.id);

    expect(() => addMember(space.id, 'member', 'not-a-time', tomorrow)).toThrow(/time|date|valid/i);
    expect(() => addMember(space.id, 'member', tomorrow, after, now)).toThrow(/time|interval|valid/i);
    expect(() => addMember(space.id, 'member', now, after)).toThrow(/overlap|membership|period/i);
    await store.upsertActorMembership('member', 'inactive', ['*'], '*');
    expect(governance.getCurrentMembership({ spaceId: space.id, actorId: 'member', now })).toBeNull();
    expect(
      decision({
        actorId: 'member',
        membershipId: member.id,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase: 'read',
        operation: 'summary.read',
        required: [{ capability: 'summary', resourceKind: 'budget', resourceId: 'budget', visibility: 'aggregate' }],
      }).disposition.kind,
    ).toBe('denied');
  });

  it('applies current governance policy thresholds to complete gross amounts and operation counts', async () => {
    await identity('member');
    const space = createSpace('owner', 'shared', 'budget');
    const member = addMember(space.id, 'member');
    const firstPolicy = setPolicy(space.id, [
      { currency: 'USD', amountMinorUnits: '500', requiredApprovers: 2 },
    ]);
    const limits = { operations: ['transfer.propose'], proposalOnly: true, maxGrossOutgoing: [usd('500')], maxOperationCount: 3 };
    for (const [resourceKind, resourceId] of [
      ['budget', 'budget'],
      ['account', 'source'],
      ['account', 'destination'],
    ] as const) {
      grant({
        actorId: 'member',
        budgetId: 'budget',
        membershipId: member.id,
        capability: 'transfer.propose',
        resourceKind,
        resourceId,
        restrictions: limits,
      });
    }

    const required = [
      { capability: 'transfer.propose', resourceKind: 'budget' as const, resourceId: 'budget' },
      { capability: 'transfer.propose', resourceKind: 'account' as const, resourceId: 'source' },
      { capability: 'transfer.propose', resourceKind: 'account' as const, resourceId: 'destination' },
    ];
    const complete = [
      { operation: 'transfer.propose', direction: 'outgoing' as const, amount: usd('300'), accountId: 'source' },
      { operation: 'transfer.propose', direction: 'outgoing' as const, amount: usd('300'), accountId: 'source' },
      { operation: 'transfer.propose', direction: 'incoming' as const, amount: usd('500'), accountId: 'destination' },
    ];
    const grossOverLimit = decision({
      actorId: 'member',
      membershipId: member.id,
      spaceId: space.id,
      expectedPolicyVersion: firstPolicy.version,
      phase: 'propose',
      operation: 'transfer.propose',
      required,
      operations: complete,
    });
    expect(grossOverLimit.disposition.kind).toBe('denied'); // outgoing 600 is not netted against incoming 500

    const exactlyWithinLimit = decision({
      actorId: 'member',
      membershipId: member.id,
      spaceId: space.id,
      expectedPolicyVersion: firstPolicy.version,
      phase: 'propose',
      operation: 'transfer.propose',
      required: required.slice(0, 2),
      operations: [
        { ...complete[0]!, amount: usd('250') },
        { ...complete[1]!, amount: usd('250') },
      ],
    });
    expect(exactlyWithinLimit.disposition.kind).toBe('approval_required');
    expect(exactlyWithinLimit.requiredApprovers).toBe(2);

    const tooManyOperations = decision({
      actorId: 'member',
      membershipId: member.id,
      spaceId: space.id,
      expectedPolicyVersion: firstPolicy.version,
      phase: 'propose',
      operation: 'transfer.propose',
      required,
      operations: [
        ...complete.slice(0, 2),
        { ...complete[0]!, amount: usd('1') },
        { ...complete[1]!, amount: usd('1') },
      ],
    });
    expect(tooManyOperations.disposition.kind).toBe('denied');

    const secondPolicy = governance.setPolicy({
      spaceId: space.id,
      expectedVersion: firstPolicy.version,
      policy: {
        minimumApprovers: 1,
        approvalThresholds: [{ currency: 'USD', amountMinorUnits: '1', requiredApprovers: 3 }],
        operationApprovers: { categorize: 2 },
      },
      now: after,
      auth: auth('owner', after),
    });
    expect(secondPolicy.version).not.toBe(firstPolicy.version);
    expect(() =>
      governance.setPolicy({
        spaceId: space.id,
        expectedVersion: firstPolicy.version,
        policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: {} },
        now: after,
        auth: auth('owner', after),
      }),
    ).toThrow(/version|conflict|policy/i);
    const stale = decision({
      actorId: 'member',
      membershipId: member.id,
      spaceId: space.id,
      expectedPolicyVersion: firstPolicy.version,
      phase: 'propose',
      operation: 'transfer.propose',
      required: required.slice(0, 2),
      operations: [{ ...complete[0]!, amount: usd('10') }],
    });
    expect(stale.disposition.kind).toBe('denied');
    expect(stale.policyVersion).toBe(secondPolicy.version);
  });

  it('enforces aggregate-only, selected account/category, operation, and proposal-only restrictions', async () => {
    await identity('reader');
    const space = createSpace('owner', 'shared', 'budget');
    const policy = setPolicy(space.id);
    const reader = addMember(space.id, 'reader');
    const transactionGrant = grant({
      actorId: 'reader',
      budgetId: 'budget',
      membershipId: reader.id,
      capability: 'transaction.view',
      resourceKind: 'budget',
      resourceId: 'budget',
      restrictions: { aggregateOnly: true, accountIds: ['checking'], categoryIds: ['food'] },
    });
    expect(transactionGrant).toMatchObject({ membershipId: reader.id, restrictions: { aggregateOnly: true } });

    const aggregate = (visibility: 'aggregate' | 'resource', accountId = 'checking', categoryId = 'food') =>
      decision({
        actorId: 'reader',
        membershipId: reader.id,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase: 'read',
        operation: 'transaction.read',
        required: [{ capability: 'transaction.view', resourceKind: 'budget', resourceId: 'budget', visibility }],
        operations: [{ operation: 'transaction.read', accountId, categoryId }],
      });
    expect(aggregate('aggregate').disposition.kind).toBe('authorized_without_approval');
    expect(aggregate('resource').disposition.kind).toBe('denied');
    expect(aggregate('aggregate', 'savings').disposition.kind).toBe('denied');
    expect(aggregate('aggregate', 'checking', 'travel').disposition.kind).toBe('denied');

    grant({
      actorId: 'reader',
      budgetId: 'budget',
      membershipId: reader.id,
      capability: 'balance',
      resourceKind: 'account',
      resourceId: 'checking',
    });
    expect(
      store.liquidity.isAuthorized({
        actorId: 'reader',
        budgetId: 'budget',
        spaceId: space.id,
        membershipId: reader.id,
        capability: 'balance',
        resourceKind: 'account',
        resourceId: 'checking',
        now,
      }),
    ).toBe(true); // LiquidityWorkflow consumes the same membership-bound resource_grants authority.

    grant({
      actorId: 'reader',
      budgetId: 'budget',
      membershipId: reader.id,
      capability: 'transfer.propose',
      resourceKind: 'budget',
      resourceId: 'budget',
      restrictions: { operations: ['transfer.propose'], proposalOnly: true },
    });
    const scoped = (phase: 'propose' | 'execute', operation: string) =>
      decision({
        actorId: 'reader',
        membershipId: reader.id,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase,
        operation,
        required: [{ capability: 'transfer.propose', resourceKind: 'budget', resourceId: 'budget' }],
        operations: [{ operation, direction: 'outgoing', amount: usd('1') }],
      });
    expect(scoped('propose', 'transfer.propose').disposition.kind).toBe('approval_required');
    expect(scoped('execute', 'transfer.propose').disposition.kind).toBe('denied');
    expect(scoped('propose', 'transfer.execute').disposition.kind).toBe('denied');
  });

  it('does not combine differently restricted grants to cover one complete operation', async () => {
    await identity('member');
    const space = createSpace('owner', 'shared', 'budget');
    const policy = setPolicy(space.id);
    const member = addMember(space.id, 'member');
    grant({
      actorId: 'member',
      budgetId: 'budget',
      membershipId: member.id,
      capability: 'transfer.propose',
      resourceKind: 'account',
      resourceId: 'source',
      restrictions: { accountIds: ['source'], categoryIds: ['food'], maxGrossOutgoing: [usd('40')] },
    });
    grant({
      actorId: 'member',
      budgetId: 'budget',
      membershipId: member.id,
      capability: 'transfer.propose',
      resourceKind: 'category',
      resourceId: 'food',
      restrictions: { accountIds: ['source'], categoryIds: ['food'], maxGrossOutgoing: [usd('70')] },
    });

    const result = decision({
      actorId: 'member',
      membershipId: member.id,
      spaceId: space.id,
      expectedPolicyVersion: policy.version,
      phase: 'propose',
      operation: 'transfer.propose',
      required: [
        { capability: 'transfer.propose', resourceKind: 'account', resourceId: 'source' },
        { capability: 'transfer.propose', resourceKind: 'category', resourceId: 'food' },
      ],
      operations: [
        {
          operation: 'transfer.propose',
          direction: 'outgoing',
          amount: usd('50'),
          accountId: 'source',
          categoryId: 'food',
        },
      ],
    });
    expect(result.disposition.kind).toBe('denied'); // neither grant alone covers the exact payload
  });

  it('isolates memberships, grants, budgets, and spaces despite actor-wide wildcards', async () => {
    await identity('member');
    const first = createSpace('owner', 'shared', 'budget-one');
    const second = createSpace('owner', 'shared', 'budget-two');
    const policy = setPolicy(first.id);
    setPolicy(second.id);
    const member = addMember(first.id, 'member');
    grant({
      actorId: 'member',
      budgetId: 'budget-one',
      membershipId: member.id,
      capability: 'summary',
      resourceKind: 'budget',
      resourceId: 'budget-one',
    });
    const request = {
      actorId: 'member',
      expectedPolicyVersion: policy.version,
      phase: 'read' as const,
      operation: 'summary.read',
      required: [{ capability: 'summary', resourceKind: 'budget' as const, resourceId: 'budget-one', visibility: 'aggregate' as const }],
    };
    expect(decision({ ...request, membershipId: member.id, spaceId: first.id }).disposition.kind).toBe(
      'authorized_without_approval',
    );
    expect(decision({ ...request, membershipId: member.id, spaceId: second.id }).disposition.kind).toBe(
      'denied',
    );
    expect(
      decision({ ...request, membershipId: member.id, spaceId: first.id, expectedPolicyVersion: '999' })
        .disposition.kind,
    ).toBe('denied');
    expect(
      decision({ ...request, membershipId: 'not-this-membership', spaceId: first.id }).disposition.kind,
    ).toBe('denied');
  });

  it('bounds versioned agent delegations and credentials by issuer rights and active membership', async () => {
    const space = createSpace('owner', 'shared', 'budget');
    const policy = setPolicy(space.id);
    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now })!;
    grant({
      actorId: 'owner',
      budgetId: 'budget',
      membershipId: issuer.id,
      capability: 'summary',
      resourceKind: 'budget',
      resourceId: 'budget',
    });
    governance.registerAgent({ spaceId: space.id, agentId: 'agent:planner', now, auth: auth('owner') });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId: 'agent:planner',
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'budget', resourceId: 'budget' }],
      validFrom: now,
      validUntil: after,
      now,
      auth: auth('owner'),
    });
    expect(delegation.version).toBe('1');
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: 'verified-key-v1',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: 'agent:planner',
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth('owner'),
    });
    const agentAuth = {
      method: 'api-key' as const,
      actorId: 'agent:planner',
      credentialId: 'verified-key-v1',
      credentialOwnerId: 'owner',
      principalType: 'agent' as const,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
    };

    const agentRequest = {
      actorId: 'agent:planner',
      agentId: 'agent:planner',
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      spaceId: space.id,
      expectedPolicyVersion: policy.version,
      phase: 'read' as const,
      operation: 'summary.read',
      required: [{ capability: 'summary', resourceKind: 'budget' as const, resourceId: 'budget', visibility: 'aggregate' as const }],
      auth: agentAuth,
    };
    expect(decision(agentRequest).disposition.kind).toBe('authorized_without_approval');
    expect(decision({ ...agentRequest, phase: 'approve' }).disposition.kind).toBe('denied');
    expect(decision({ ...agentRequest, phase: 'execute' }).disposition.kind).toBe('denied');
    expect(decision({ ...agentRequest, now: after }).disposition.kind).toBe('denied'); // validUntil is exclusive

    expect(() =>
      governance.delegate({
        spaceId: space.id,
        agentId: 'agent:planner',
        issuerMembershipId: issuer.id,
        expectedVersion: delegation.version,
        rights: [{ capability: 'balance', resourceKind: 'account', resourceId: 'private' }],
        validFrom: now,
        validUntil: tomorrow,
        now,
        auth: auth('owner'),
      }),
    ).toThrow(/authority|grant|right|denied/i);

    const renewed = governance.delegate({
      id: delegation.id,
      spaceId: space.id,
      agentId: 'agent:planner',
      issuerMembershipId: issuer.id,
      expectedVersion: delegation.version,
      rights: [{ capability: 'summary', resourceKind: 'budget', resourceId: 'budget' }],
      validFrom: after,
      validUntil: tomorrow,
      now: after,
      auth: auth('owner', after),
    });
    expect(renewed.id).toBe(delegation.id);
    expect(renewed.version).not.toBe(delegation.version);
    expect(governance.listDelegations({ spaceId: space.id, agentId: 'agent:planner' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: delegation.id, version: delegation.version, revokedAt: after }),
        expect.objectContaining({ id: renewed.id, version: renewed.version, issuerMembershipId: issuer.id }),
      ]),
    );

    const binding = governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: 'verified-key-id',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: 'agent:planner',
      delegationId: renewed.id,
      expectedDelegationVersion: renewed.version,
      now: after,
      auth: auth('owner', after),
    });
    expect(decision({
      ...agentRequest,
      delegationVersion: renewed.version,
      auth: {
        ...agentAuth,
        credentialId: 'verified-key-id',
        delegationVersion: renewed.version,
      },
      now: after,
    }).disposition.kind).toBe('authorized_without_approval');
    expect(binding).toMatchObject({
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: 'agent:planner',
      delegationId: renewed.id,
      delegationVersion: renewed.version,
    });
    expect(
      governance.resolveCredentialPrincipal({
        credentialId: 'unbound-human-key',
        referenceId: 'owner',
        now: after,
      }),
    ).toMatchObject({ principalType: 'human', actorId: 'owner' });
    expect(
      governance.resolveCredentialPrincipal({
        credentialId: 'unbound-human-key',
        referenceId: 'agent:planner',
        now: after,
      }),
    ).toBeNull();
    expect(
      governance.resolveCredentialPrincipal({
        credentialId: 'verified-key-id',
        referenceId: 'owner',
        now: after,
      }),
    ).toMatchObject({ principalType: 'agent', actorId: 'agent:planner', delegationVersion: renewed.version });

    governance.revokeDelegation({
      spaceId: space.id,
      delegationId: renewed.id,
      expectedVersion: renewed.version,
      now: after,
      auth: auth('owner', after),
    });
    expect(
      governance.resolveCredentialPrincipal({
        credentialId: 'verified-key-id',
        referenceId: 'owner',
        now: after,
      }),
    ).toBeNull(); // a revoked agent key never falls back to its human credential owner
    expect(decision({ ...agentRequest, now: after }).disposition.kind).toBe('denied');
  });

  it('does not mistake execution admission for exact verified human approval', async () => {
    const space = createSpace('owner', 'shared', 'budget');
    const policy = setPolicy(space.id);
    const member = governance.getCurrentMembership({
      spaceId: space.id, actorId: 'owner', now,
    })!;
    grant({
      actorId: 'owner', budgetId: 'budget', membershipId: member.id,
      capability: 'confirmation', resourceKind: 'budget', resourceId: 'budget',
    });
    const operations: GovernanceOperation[] = [
      { operation: 'confirmation', direction: 'outgoing', amount: usd('50') },
    ];
    expect(decision({
      actorId: 'owner', spaceId: space.id, membershipId: member.id,
      expectedPolicyVersion: policy.version, phase: 'execute', operation: 'confirmation',
      required: [{ capability: 'confirmation', resourceKind: 'budget', resourceId: 'budget' }],
      operations, auth: auth('owner'),
    }).disposition.kind).toBe('approval_required');
    expect(store.liquidity.isAuthorized({
      actorId: 'owner', budgetId: 'budget', spaceId: space.id, membershipId: member.id,
      governancePolicyVersion: policy.version, now, auth: auth('owner'),
      phase: 'execute', operation: 'confirmation', capability: 'confirmation',
      resourceKind: 'budget', resourceId: 'budget', operations,
    })).toBe(false);
  });

  it('requires recent reauthenticated human sessions for control-plane mutations', async () => {
    const stale = auth('owner', '2098-01-01T11:54:59.999Z');
    expect(() =>
      governance.createSpace({ actorId: 'owner', name: 'stale', kind: 'personal', now, auth: stale }),
    ).toThrow(/recent|reauth|session/i);
    expect(() =>
      governance.createSpace({
        actorId: 'owner',
        name: 'api-key',
        kind: 'personal',
        now,
        auth: untrustedAuth('api-key'),
      }),
    ).toThrow(/human|session|reauth|authoriz/i);
    expect(() =>
      governance.createSpace({
        actorId: 'owner',
        name: 'agent',
        kind: 'personal',
        now,
        auth: untrustedAuth('agent'),
      }),
    ).toThrow(/human|session|reauth|authoriz/i);
    expect(() =>
      governance.createSpace({ actorId: 'owner', name: 'mismatch', kind: 'personal', now, auth: auth('other') }),
    ).toThrow(/actor|session|authoriz/i);

    const space = createSpace('owner', 'personal');
    await identity('member');
    expect(() =>
      governance.addMembership({
        spaceId: space.id,
        actorId: 'member',
        validFrom: 'invalid',
        now,
        auth: auth('owner'),
      }),
    ).toThrow(/time|date|valid/i);
  });
});
