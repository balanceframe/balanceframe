import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/store.js';
import type { GovernanceResourceRef, HumanControlContext, SpaceMembership } from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const later = '2098-01-01T12:05:00.000Z';
const budgetId = 'budget-regression';
const auth = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
  method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt,
});
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
type StoreInternalsForTest = { db: DatabaseType };
interface RuleInspectionSnapshot {
  id: string;
  name: string;
  order: number;
  trigger: { field: string; op: string; value: string }[];
  actions: { op: string; field: string; value: string }[];
  inactive: boolean;
  stage: null;
  conditionsOp: 'and';
}
interface RuleInspectionProposalFixture {
  space: { id: string };
  input: { operation: 'update_rule' | 'delete_rule' };
  rule: RuleInspectionSnapshot;
}

function testDatabase(store: SqliteWorkflowStore): DatabaseType {
  return (store as unknown as StoreInternalsForTest).db;
}

describe('governance authorization regressions', () => {
  let store: SqliteWorkflowStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'governance-regressions' });
    await store.finalizeBootstrap({ claimId: 'governance-regressions', ownerUserId: 'owner' });
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  async function twoSpaceFixture() {
    const governance = store.governance;
    const spaceA = governance.createSpace({ actorId: 'owner', name: 'A', kind: 'shared', now, auth: auth('owner') });
    const spaceB = governance.createSpace({ actorId: 'owner', name: 'B', kind: 'shared', now, auth: auth('owner') });
    await store.upsertActorMembership('manager-b', 'active', [], 'unscoped');
    const managerInA = governance.addMembership({
      spaceId: spaceA.id, actorId: 'manager-b', validFrom: now, now, auth: auth('owner'),
    });
    const managerInB = governance.addMembership({
      spaceId: spaceB.id, actorId: 'manager-b', validFrom: now, now, auth: auth('owner'),
    });
    for (const [spaceId, membership] of [[spaceA.id, managerInA], [spaceB.id, managerInB]] as const) {
      for (const capability of ['agent:manage', 'delegation:manage', 'summary']) {
        governance.setResourceGrant({
          spaceId,
          actorId: 'manager-b',
          membershipId: membership.id,
          capability,
          resourceKind: 'space',
          resourceId: spaceId,
          granted: true,
          now,
          auth: auth('owner'),
        });
      }
    }
    const ownerInA = governance.getCurrentMembership({ spaceId: spaceA.id, actorId: 'owner', now });
    if (!ownerInA) throw new Error('Space A owner membership unavailable');
    governance.setResourceGrant({
      spaceId: spaceA.id,
      actorId: 'owner',
      membershipId: ownerInA.id,
      capability: 'summary',
      resourceKind: 'space',
      resourceId: spaceA.id,
      granted: true,
      now,
      auth: auth('owner'),
    });
    return { governance, spaceA, spaceB, ownerInA, managerInA, managerInB };
  }

  async function originalSpaceADelegation() {
    const fixture = await twoSpaceFixture();
    const { governance, spaceA, ownerInA } = fixture;
    const agentId = 'agent:space-a';
    governance.registerAgent({ spaceId: spaceA.id, agentId, now, auth: auth('owner') });
    const delegation = governance.delegate({
      spaceId: spaceA.id,
      agentId,
      issuerMembershipId: ownerInA.id,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: spaceA.id }],
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('owner'),
    });
    governance.registerCredentialBinding({
      spaceId: spaceA.id,
      credentialId: 'credential:space-a',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth('owner'),
    });
    return { ...fixture, agentId, delegation };
  }

  function expectOriginalCredential(input: {
    governance: SqliteWorkflowStore['governance'];
    spaceId: string;
    agentId: string;
    delegationId: string;
    delegationVersion: string;
  }) {
    expect(input.governance.resolveCredentialPrincipal({
      credentialId: 'credential:space-a',
      referenceId: 'owner',
      spaceId: input.spaceId,
      now,
    })).toMatchObject({
      principalType: 'agent',
      actorId: input.agentId,
      delegationId: input.delegationId,
      delegationVersion: input.delegationVersion,
    });
  }

  it('rejects a selected-space replacement of another space delegation without revoking its credential', async () => {
    const fixture = await originalSpaceADelegation();
    const { governance, spaceA, spaceB, managerInB, delegation, agentId } = fixture;
    governance.registerAgent({ spaceId: spaceB.id, agentId: 'agent:space-b', now, auth: auth('manager-b') });

    expect(() => governance.delegate({
      id: delegation.id,
      spaceId: spaceB.id,
      agentId: 'agent:space-b',
      issuerMembershipId: managerInB.id,
      expectedVersion: delegation.version,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: spaceB.id }],
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('manager-b'),
    })).toThrow();

    expect(governance.listDelegations({ spaceId: spaceA.id, agentId })).toEqual([
      expect.objectContaining({ id: delegation.id, version: delegation.version, revokedAt: null }),
    ]);
    expect(governance.listDelegations({ spaceId: spaceB.id, agentId: 'agent:space-b' })).toEqual([]);
    expectOriginalCredential({
      governance, spaceId: spaceA.id, agentId, delegationId: delegation.id, delegationVersion: delegation.version,
    });
  });

  it('does not retarget an existing delegation to a different agent in the same space', async () => {
    const fixture = await originalSpaceADelegation();
    const { governance, spaceA, ownerInA, delegation, agentId } = fixture;
    governance.registerAgent({ spaceId: spaceA.id, agentId: 'agent:replacement', now, auth: auth('owner') });

    expect(() => governance.delegate({
      id: delegation.id,
      spaceId: spaceA.id,
      agentId: 'agent:replacement',
      issuerMembershipId: ownerInA.id,
      expectedVersion: delegation.version,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: spaceA.id }],
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('owner'),
    })).toThrow();

    expect(governance.listDelegations({ spaceId: spaceA.id, agentId })).toEqual([
      expect.objectContaining({ id: delegation.id, version: delegation.version, revokedAt: null }),
    ]);
    expectOriginalCredential({
      governance, spaceId: spaceA.id, agentId, delegationId: delegation.id, delegationVersion: delegation.version,
    });
  });

  it('does not retarget an existing delegation to a different issuer membership period', async () => {
    const fixture = await originalSpaceADelegation();
    const { governance, spaceA, managerInA, delegation, agentId } = fixture;
    governance.registerAgent({ spaceId: spaceA.id, agentId: 'agent:manager-b-in-a', now, auth: auth('manager-b') });

    expect(() => governance.delegate({
      id: delegation.id,
      spaceId: spaceA.id,
      agentId: 'agent:manager-b-in-a',
      issuerMembershipId: managerInA.id,
      expectedVersion: delegation.version,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: spaceA.id }],
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('manager-b'),
    })).toThrow();

    expect(governance.listDelegations({ spaceId: spaceA.id, agentId })).toEqual([
      expect.objectContaining({ id: delegation.id, version: delegation.version, revokedAt: null }),
    ]);
    expectOriginalCredential({
      governance, spaceId: spaceA.id, agentId, delegationId: delegation.id, delegationVersion: delegation.version,
    });
  });

  it('rejects confirmation authority at delegation issuance', () => {
    const governance = store.governance;
    const unbound = governance.createSpace({ actorId: 'owner', name: 'Settlement', kind: 'shared', now, auth: auth('owner') });
    const space = governance.bindBudget({ spaceId: unbound.id, budgetId, now, auth: auth('owner') });
    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    if (!issuer) throw new Error('Settlement issuer membership unavailable');
    const settlementRight = { capability: 'confirmation', resourceKind: 'budget' as const, resourceId: budgetId };
    governance.setResourceGrant({
      spaceId: space.id, actorId: 'owner', membershipId: issuer.id, budgetId,
      ...settlementRight, granted: true, now, auth: auth('owner'),
    });
    governance.registerAgent({ spaceId: space.id, agentId: 'agent:settlement', now, auth: auth('owner') });

    expect(() => governance.delegate({
      spaceId: space.id,
      agentId: 'agent:settlement',
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights: [settlementRight],
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('owner'),
    })).toThrow();
    expect(governance.listDelegations({ spaceId: space.id, agentId: 'agent:settlement' })).toEqual([]);
  });

  it('denies native confirmation for a backfilled agent while retaining approved operational execution', () => {
    const governance = store.governance;
    const unbound = governance.createSpace({ actorId: 'owner', name: 'Settlement', kind: 'shared', now, auth: auth('owner') });
    const space = governance.bindBudget({ spaceId: unbound.id, budgetId, now, auth: auth('owner') });
    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    const policy = governance.getPolicy({ spaceId: space.id });
    if (!issuer || !policy) throw new Error('Settlement governance fixture unavailable');
    const resources: GovernanceResourceRef[] = [
      { resourceKind: 'budget', resourceId: budgetId },
      { resourceKind: 'account', resourceId: 'checking' },
      { resourceKind: 'account', resourceId: 'savings' },
    ];
    for (const capability of ['confirmation', 'categorization:execute']) {
      for (const resource of resources) governance.setResourceGrant({
        spaceId: space.id,
        actorId: 'owner',
        membershipId: issuer.id,
        budgetId,
        capability,
        ...resource,
        granted: true,
        now,
        auth: auth('owner'),
      });
    }
    const agentId = 'agent:settlement';
    const credentialId = 'credential:settlement';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth('owner') });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights: resources.map((resource) => ({ capability: 'categorization:execute', ...resource })),
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('owner'),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth('owner'),
    });
    const agentAuth = {
      method: 'api-key' as const,
      actorId: agentId,
      credentialId,
      credentialOwnerId: 'owner',
      principalType: 'agent' as const,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
    };
    const approvedOperationalExecution = governance.authorize({
      actorId: agentId,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      spaceId: space.id,
      expectedPolicyVersion: policy.version,
      phase: 'execute',
      operation: 'categorize',
      required: [{ capability: 'categorization:execute', ...resources[0]! }],
      payload: { operations: [{ operation: 'categorize', direction: 'outgoing', amount: money('20') }] },
      now,
      auth: agentAuth,
      verifiedHumanApproval: true,
    });
    expect(approvedOperationalExecution).toMatchObject({
      allowed: true,
      disposition: { kind: 'authorized_without_approval' },
    });

    const confirmationRights = resources.map((resource) => ({ capability: 'confirmation', ...resource }));
    testDatabase(store).prepare('UPDATE agent_delegations SET rights=? WHERE id=? AND version=?')
      .run(JSON.stringify(confirmationRights), delegation.id, delegation.version);
    const nativeSettlement = governance.authorize({
      actorId: agentId,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      spaceId: space.id,
      expectedPolicyVersion: policy.version,
      phase: 'execute',
      operation: 'transfer',
      required: confirmationRights,
      payload: {
        operations: [{
          operation: 'transfer',
          direction: 'outgoing',
          amount: money('20'),
          sourceAccountId: 'checking',
          destinationAccountId: 'savings',
        }],
      },
      now,
      auth: agentAuth,
      verifiedHumanApproval: true,
    });
    expect(nativeSettlement.disposition.kind).toBe('denied');
  });

  it('compares delegation bounds as instants at equivalent UTC spellings', () => {
    const governance = store.governance;
    const space = governance.createSpace({ actorId: 'owner', name: 'Timestamp boundaries', kind: 'shared', now, auth: auth('owner') });
    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    if (!issuer) throw new Error('Timestamp issuer membership unavailable');
    governance.setResourceGrant({
      spaceId: space.id,
      actorId: 'owner',
      membershipId: issuer.id,
      capability: 'summary',
      resourceKind: 'space',
      resourceId: space.id,
      granted: true,
      now,
      auth: auth('owner'),
    });
    governance.registerAgent({ spaceId: space.id, agentId: 'agent:timestamp', now, auth: auth('owner') });
    const startsAt = '2098-01-01T12:00:00Z';
    const endsAt = '2098-01-01T12:00:01Z';
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId: 'agent:timestamp',
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: space.id }],
      validFrom: startsAt,
      validUntil: endsAt,
      now: startsAt,
      auth: auth('owner', startsAt),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: 'credential:timestamp',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: 'agent:timestamp',
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now: startsAt,
      auth: auth('owner', startsAt),
    });

    expect(governance.resolveCredentialPrincipal({
      credentialId: 'credential:timestamp', referenceId: 'owner', spaceId: space.id,
      now: '2098-01-01T12:00:00.000Z',
    })).toMatchObject({ principalType: 'agent', delegationId: delegation.id });
    expect(governance.resolveCredentialPrincipal({
      credentialId: 'credential:timestamp', referenceId: 'owner', spaceId: space.id,
      now: '2098-01-01T12:00:01.000Z',
    })).toBeNull();
    expect(governance.resolveCredentialPrincipal({
      credentialId: 'credential:timestamp', referenceId: 'owner', spaceId: space.id,
      now: '2098-01-01T12:00:01Z',
    })).toBeNull();
    expect(governance.resolveCredentialPrincipal({
      credentialId: 'credential:timestamp', referenceId: 'owner', spaceId: space.id,
      now: '2098-01-01T11:59:59.999Z',
    })).toBeNull();

    governance.revokeDelegation({
      spaceId: space.id,
      delegationId: delegation.id,
      expectedVersion: delegation.version,
      now: later,
      auth: auth('owner', later),
    });
    expect(governance.resolveCredentialPrincipal({
      credentialId: 'credential:timestamp', referenceId: 'owner', spaceId: space.id, now: later,
    })).toBeNull();
  });
  it('authorizes aggregate conclusions over complete non-private source closure only', async () => {
    const governance = store.governance;
    const space = governance.createSpace({
      actorId: 'owner',
      name: 'Aggregate source closure',
      kind: 'shared',
      now,
      auth: auth('owner'),
    });
    governance.bindBudget({ spaceId: space.id, budgetId, now, auth: auth('owner') });
    const member = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    const policy = governance.getPolicy({ spaceId: space.id });
    if (!member || !policy) throw new Error('Aggregate conclusion fixture unavailable');
    governance.setResourceGrant({
      spaceId: space.id,
      actorId: 'owner',
      membershipId: member.id,
      budgetId,
      capability: 'conclusion',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      restrictions: {
        aggregateOnly: true,
        accountIds: ['cash'],
        categoryIds: ['food'],
        operations: ['conclusion', 'purchase'],
        maxOperationCount: 1,
        maxGrossOutgoing: [{ currency: 'USD', minorUnits: '200' }],
      },
      now,
      auth: auth('owner'),
    });
    const actor = {
      actorId: 'owner',
      budgetId,
      spaceId: space.id,
      membershipId: member.id,
      governancePolicyVersion: policy.version,
      now,
    };
    const resources: GovernanceResourceRef[] = [
      { resourceKind: 'account', resourceId: 'cash' },
      { resourceKind: 'category', resourceId: 'food' },
      { resourceKind: 'transaction', resourceId: 'private-transaction' },
      { resourceKind: 'evidence', resourceId: 'private-evidence' },
      { resourceKind: 'reservation', resourceId: 'private-reservation' },
      { resourceKind: 'commitment', resourceId: 'private-commitment' },
      { resourceKind: 'rule', resourceId: 'private-rule' },
    ];
    const purchase = {
      operation: 'purchase' as const,
      direction: 'outgoing' as const,
      amount: money('100'),
      accountId: 'cash',
      categoryId: 'food',
    };
    const conclusion = {
      ...actor,
      resourceKind: 'budget' as const,
      resourceId: budgetId,
      capability: 'conclusion' as const,
      visibility: 'aggregate' as const,
      resources,
      operations: [purchase],
    };

    expect(store.liquidity.isAuthorized(conclusion)).toBe(true);
    expect(store.liquidity.isAuthorized({
      ...conclusion,
      resources: [...resources, { resourceKind: 'account', resourceId: 'private-account' }],
    })).toBe(false);
    expect(store.liquidity.isAuthorized({
      ...conclusion,
      resources: [...resources, { resourceKind: 'category', resourceId: 'private-category' }],
    })).toBe(false);
    expect(store.liquidity.isAuthorized({
      ...conclusion,
      operations: [{ ...purchase, operation: 'transfer' }],
    })).toBe(false);
    expect(store.liquidity.isAuthorized({
      ...conclusion,
      operations: [{ ...purchase, amount: money('201') }],
    })).toBe(false);
    expect(store.liquidity.isAuthorized({
      ...conclusion,
      operations: [purchase, purchase],
    })).toBe(false);
    expect(store.liquidity.isAuthorized({
      ...conclusion,
      capability: 'balance',
    })).toBe(false);
    for (const [resourceKind, resourceId] of [
      ['transaction', 'private-transaction'],
      ['evidence', 'private-evidence'],
      ['reservation', 'private-reservation'],
      ['commitment', 'private-commitment'],
      ['rule', 'private-rule'],
    ] as const)
      expect(store.liquidity.isAuthorized({
        ...actor,
        resourceKind,
        resourceId,
        capability: 'full-read',
      })).toBe(false);
  });

  async function ruleInspectionFixture(operation: 'update_rule' | 'delete_rule' = 'update_rule') {
    const governance = store.governance;
    const space = governance.createSpace({
      actorId: 'owner', name: 'Rule inspection', kind: 'shared', now, auth: auth('owner'),
    });
    governance.bindBudget({ spaceId: space.id, budgetId, now, auth: auth('owner') });
    const membership = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    const policy = governance.getPolicy({ spaceId: space.id });
    if (!membership || !policy) throw new Error('Rule inspection fixture unavailable');
    const rule: RuleInspectionSnapshot = {
      id: 'rule-account-A',
      name: 'Private rule name',
      order: 1,
      trigger: [{ field: 'account', op: 'is', value: 'acct-A' }],
      actions: [{ op: 'set', field: 'category', value: 'cat-food' }],
      inactive: false,
      stage: null,
      conditionsOp: 'and',
    };
    const restrictions = {
      accountIds: ['acct-A'],
      categoryIds: ['cat-food'],
      operations: [operation],
      proposalOnly: true,
      maxOperationCount: 1,
      maxGrossOutgoing: [money('0')],
    };
    const resources: GovernanceResourceRef[] = [
      { resourceKind: 'budget', resourceId: budgetId },
      { resourceKind: 'rule', resourceId: rule.id },
      { resourceKind: 'account', resourceId: 'acct-A' },
      { resourceKind: 'category', resourceId: 'cat-food' },
    ];
    for (const resource of resources)
      governance.setResourceGrant({
        spaceId: space.id, actorId: 'owner', membershipId: membership.id, budgetId,
        capability: 'rule:propose', ...resource, granted: true,
        restrictions: resource.resourceKind === 'budget' || resource.resourceKind === 'rule'
          ? restrictions : {},
        now, auth: auth('owner'),
      });
    const input = {
      actorId: 'owner', auth: auth('owner'), spaceId: space.id,
      membershipId: membership.id, expectedPolicyVersion: policy.version,
      budgetId, ruleId: rule.id, operation, now,
    };
    return { governance, space, membership, policy, input, rule, restrictions, resources };
  }

  async function createInspectedRuleProposal(
    fixture: RuleInspectionProposalFixture,
    rule = fixture.rule,
  ) {
    const operation = fixture.input.operation;
    return store.createProposal({
      operation, budgetId, spaceId: fixture.space.id,
      payload: operation === 'update_rule'
        ? { kind: operation, ruleId: rule.id, inactive: true }
        : { kind: operation, ruleId: rule.id },
      policyVersion: '1.0',
      preconditions: JSON.stringify({ rule, override: null }),
      expiresAt: later,
      actorId: 'owner',
      auth: auth('owner'),
      provenance: 'rule-inspection-regression',
    });
  }

  it.each(['update_rule', 'delete_rule'] as const)(
    'admits private rule baseline inspection but retains complete %s authorization',
    async (operation) => {
      const fixture = await ruleInspectionFixture(operation);
      const { governance, input, resources } = fixture;

      const admission = governance.authorizeRuleInspection(input);

      expect(admission).toMatchObject({
        inspectionAllowed: true,
        actorId: 'owner',
        membershipId: fixture.membership.id,
        policyVersion: fixture.policy.version,
      });
      expect(admission).not.toHaveProperty('disposition');
      expect(admission).not.toHaveProperty('requiredApprovers');
      expect(admission).not.toHaveProperty('rule');
      const operationRequest = {
        actorId: input.actorId, auth: input.auth, spaceId: input.spaceId,
        membershipId: input.membershipId, expectedPolicyVersion: input.expectedPolicyVersion,
        phase: 'propose' as const, operation, now,
        required: resources.slice(0, 2).map((resource) => ({
          ...resource, capability: 'rule:propose',
        })),
        payload: { operations: [] },
      };
      expect(governance.authorize(operationRequest).allowed).toBe(false);
      const forgedInspectionPurpose = {
        ...operationRequest, inspectionAllowed: true, purpose: 'rule_inspection',
      };
      expect(governance.authorize(forgedInspectionPurpose).allowed).toBe(false);
      expect((await createInspectedRuleProposal(fixture)).operation).toBe(operation);
    },
  );

  it.each(['account', 'category'] as const)(
    'still denies complete rule proposals outside the inspected %s bounds',
    async (resourceKind) => {
      const fixture = await ruleInspectionFixture();
      const outsideId = resourceKind === 'account' ? 'acct-B' : 'cat-private';
      fixture.governance.setResourceGrant({
        spaceId: fixture.space.id, actorId: 'owner', membershipId: fixture.membership.id,
        budgetId, capability: 'rule:propose', resourceKind, resourceId: outsideId,
        granted: true, now, auth: auth('owner'),
      });
      const outsideRule = resourceKind === 'account'
        ? { ...fixture.rule, trigger: [{ field: 'account', op: 'is', value: outsideId }] }
        : { ...fixture.rule, actions: [{ op: 'set', field: 'category', value: outsideId }] };

      expect(fixture.governance.authorizeRuleInspection(fixture.input).inspectionAllowed).toBe(true);
      await expect(createInspectedRuleProposal(fixture, outsideRule)).rejects.toMatchObject({
        reasonCode: 'authorization_denied',
      });
      expect(await store.listProposals()).toEqual([]);
    },
  );

  it.each([
    ['budget', 'zero count', { maxOperationCount: 0 }],
    ['rule', 'zero count', { maxOperationCount: 0 }],
    ['budget', 'wrong operation', { operations: ['delete_rule'] }],
    ['rule', 'wrong operation', { operations: ['delete_rule'] }],
    ['budget', 'aggregate-only visibility', { aggregateOnly: true }],
    ['rule', 'aggregate-only visibility', { aggregateOnly: true }],
  ] as const)('denies rule baseline inspection with %s %s restrictions', async (resourceKind, _name, limits) => {
    const fixture = await ruleInspectionFixture();
    fixture.governance.setResourceGrant({
      spaceId: fixture.space.id, actorId: 'owner', membershipId: fixture.membership.id,
      budgetId, capability: 'rule:propose', resourceKind,
      resourceId: resourceKind === 'budget' ? budgetId : fixture.rule.id,
      granted: true, restrictions: { ...fixture.restrictions, ...limits },
      now, auth: auth('owner'),
    });

    expect(fixture.governance.authorizeRuleInspection(fixture.input).inspectionAllowed).toBe(false);
  });

  it('denies ungranted and unknown rule baseline inspection identically', async () => {
    const fixture = await ruleInspectionFixture();
    fixture.governance.setResourceGrant({
      spaceId: fixture.space.id, actorId: 'owner', membershipId: fixture.membership.id,
      budgetId, capability: 'rule:propose', resourceKind: 'rule',
      resourceId: fixture.rule.id, granted: false, now, auth: auth('owner'),
    });

    const privateRule = fixture.governance.authorizeRuleInspection(fixture.input);
    const unknownRule = fixture.governance.authorizeRuleInspection({
      ...fixture.input, ruleId: 'unknown-rule',
    });

    expect(privateRule.inspectionAllowed).toBe(false);
    expect(unknownRule).toEqual(privateRule);
  });

  it('denies rule baseline inspection for a revoked human membership', async () => {
    const fixture = await ruleInspectionFixture();
    expect(fixture.governance.authorizeRuleInspection(fixture.input).inspectionAllowed).toBe(true);
    fixture.governance.revokeMembership({
      spaceId: fixture.space.id, membershipId: fixture.membership.id,
      now, auth: auth('owner'),
    });

    expect(fixture.governance.authorizeRuleInspection(fixture.input).inspectionAllowed).toBe(false);
  });

  it.each(['agent', 'issuer', 'delegation', 'credential', 'issuer grant'] as const)(
    'denies private rule baseline inspection after delegated %s revocation',
    async (revoked) => {
      const fixture = await ruleInspectionFixture();
      const { governance } = fixture;
      const agentId = 'agent:rule-inspection';
      const credentialId = 'credential:rule-inspection';
      governance.registerAgent({ spaceId: fixture.space.id, agentId, now, auth: auth('owner') });
      const delegation = governance.delegate({
        spaceId: fixture.space.id, agentId, issuerMembershipId: fixture.membership.id,
        expectedVersion: null,
        rights: fixture.resources.slice(0, 2).map((resource) => ({
          capability: 'rule:propose', ...resource, restrictions: fixture.restrictions,
        })),
        validFrom: now, validUntil: later, now, auth: auth('owner'),
      });
      governance.registerCredentialBinding({
        spaceId: fixture.space.id, credentialId, credentialOwnerId: 'owner',
        principalType: 'agent', principalId: agentId,
        delegationId: delegation.id, expectedDelegationVersion: delegation.version,
        now, auth: auth('owner'),
      });
      const agentInput = {
        ...fixture.input,
        actorId: agentId,
        auth: {
          method: 'api-key' as const, actorId: agentId, credentialId,
          credentialOwnerId: 'owner', principalType: 'agent' as const,
          delegationId: delegation.id, delegationVersion: delegation.version,
        },
      };
      expect(governance.authorizeRuleInspection(agentInput).inspectionAllowed).toBe(true);
      switch (revoked) {
        case 'agent':
          governance.setAgentStatus({
            spaceId: fixture.space.id, agentId, status: 'revoked', now, auth: auth('owner'),
          });
          break;
        case 'issuer':
          governance.revokeMembership({
            spaceId: fixture.space.id, membershipId: fixture.membership.id, now, auth: auth('owner'),
          });
          break;
        case 'delegation':
          governance.revokeDelegation({
            spaceId: fixture.space.id, delegationId: delegation.id,
            expectedVersion: delegation.version, now, auth: auth('owner'),
          });
          break;
        case 'credential':
          governance.revokeCredentialBinding({
            spaceId: fixture.space.id, credentialId, now, auth: auth('owner'),
          });
          break;
        case 'issuer grant':
          governance.setResourceGrant({
            spaceId: fixture.space.id, actorId: 'owner', membershipId: fixture.membership.id,
            budgetId, capability: 'rule:propose', resourceKind: 'rule',
            resourceId: fixture.rule.id, granted: false, now, auth: auth('owner'),
          });
          break;
      }

      expect(governance.authorizeRuleInspection(agentInput).inspectionAllowed).toBe(false);
    },
  );
});
