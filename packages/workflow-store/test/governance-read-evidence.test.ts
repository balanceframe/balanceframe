import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type {
  GovernanceAuthorizationInput, HumanControlContext, ResourceGrantRestrictions,
} from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const later = '2098-01-01T12:05:00.000Z';
const budgetId = 'budget-evidence-read';
const auth = (actorId: string): HumanControlContext => ({
  method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now,
});
const subjectRights = (key: string): GovernanceAuthorizationInput['required'] => [
  { resourceKind: 'evidence', resourceId: key, capability: 'evidence', visibility: 'resource' },
  { resourceKind: 'evidence', resourceId: key, capability: 'normalized-evidence', visibility: 'resource' },
];

function withSubject(input: GovernanceAuthorizationInput, key: string): GovernanceAuthorizationInput {
  return {
    ...input,
    required: [...input.required, ...subjectRights(key)],
    payload: { ...input.payload, operations: [...input.payload.operations, { operation: input.operation, evidenceId: key }] },
  };
}

describe('read evidence subject batch authorization', () => {
  let store: SqliteWorkflowStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'evidence-read' });
    await store.finalizeBootstrap({ claimId: 'evidence-read', ownerUserId: 'owner' });
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function fixture() {
    const governance = store.governance;
    const space = governance.createSpace({ actorId: 'owner', name: 'Read evidence', kind: 'shared', now, auth: auth('owner') });
    governance.bindBudget({ spaceId: space.id, budgetId, now, auth: auth('owner') });
    const member = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    const policy = governance.getPolicy({ spaceId: space.id });
    if (!member || !policy) throw new Error('Evidence governance fixture unavailable');
    const required: GovernanceAuthorizationInput['required'] = [
      { resourceKind: 'budget', resourceId: budgetId, capability: 'full-read', visibility: 'resource' },
      { resourceKind: 'account', resourceId: 'checking', capability: 'transaction', visibility: 'resource' },
      { resourceKind: 'account', resourceId: 'savings', capability: 'transaction', visibility: 'resource' },
      { resourceKind: 'transaction', resourceId: 'txn-a', capability: 'transaction', visibility: 'resource' },
      { resourceKind: 'transaction', resourceId: 'txn-b', capability: 'transaction', visibility: 'resource' },
    ];
    function grant(right: GovernanceAuthorizationInput['required'][number], restrictions: ResourceGrantRestrictions = {}, granted = true) {
      return governance.setResourceGrant({
        ...right, spaceId: space.id, budgetId, actorId: 'owner', membershipId: member!.id,
        restrictions, granted, now, auth: auth('owner'),
      });
    }
    for (const right of [...required, ...subjectRights('subject-a'), ...subjectRights('subject-b')]) grant(right);
    const input: GovernanceAuthorizationInput = {
      actorId: 'owner', spaceId: space.id, membershipId: member.id, expectedPolicyVersion: policy.version,
      phase: 'read', operation: 'evidence', now, auth: auth('owner'), required,
      payload: {
        operations: [
          { operation: 'transaction', transactionId: 'txn-a', accountId: 'checking', categoryId: 'food', direction: 'outgoing', amount: { currency: 'USD', minorUnits: '9007199254740993' } },
          { operation: 'transaction', transactionId: 'txn-b', accountId: 'savings', categoryId: 'rent', direction: 'outgoing', amount: { currency: 'EUR', minorUnits: '20' } },
        ],
      },
    };
    return { governance, space, member, policy, required, input, grant };
  }

  it('selectively admits exact full-payload peers and counts N+1 rather than N+all subjects', () => {
    const { governance, input, grant } = fixture();
    for (const key of ['subject-a', 'subject-b']) {
      for (const right of subjectRights(key)) grant(right, { maxOperationCount: 3 });
    }
    const keys = ['subject-a', 'missing-subject', 'subject-b'];
    const expected = keys.filter((key) => governance.authorize(withSubject(input, key)).allowed);
    expect(expected).toEqual(['subject-a', 'subject-b']);
    expect(governance.authorizeReadEvidenceSubjects(input, keys)).toEqual(expected);
    grant(subjectRights('subject-b')[1]!, {}, false);
    expect(governance.authorizeReadEvidenceSubjects(input, keys)).toEqual(['subject-a']);
  });

  it.each([
    { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '9007199254740992' }, { currency: 'EUR', minorUnits: '20' }] },
    { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '9007199254740993' }] },
    { maxOperationCount: 2 },
    { accountIds: ['checking'] },
    { categoryIds: ['food'] },
    { operations: ['evidence'] },
    { proposalOnly: true },
    { aggregateOnly: true },
  ] satisfies ResourceGrantRestrictions[])('checks full source closure on normalized-evidence restrictions %j', (restrictions) => {
    const { governance, input, grant } = fixture();
    grant(subjectRights('subject-a')[1]!, restrictions);
    expect(governance.authorize(withSubject(input, 'subject-a')).allowed).toBe(false);
    expect(governance.authorizeReadEvidenceSubjects(input, ['subject-a', 'subject-b'])).toEqual(['subject-b']);
  });

  it('applies the added subject operation to common source grant limits too', () => {
    const { governance, input, required, grant } = fixture();
    grant(required[3]!, { maxOperationCount: 2 });
    expect(governance.authorize(input).allowed).toBe(true);
    expect(governance.authorizeReadEvidenceSubjects(input, ['subject-a', 'subject-b'])).toEqual([]);
    grant(required[3]!, { maxOperationCount: 3 });
    expect(governance.authorizeReadEvidenceSubjects(input, ['subject-a', 'subject-b'])).toEqual(['subject-a', 'subject-b']);
    grant(required[4]!, {}, false);
    expect(governance.authorizeReadEvidenceSubjects(input, ['subject-a'])).toEqual([]);
  });

  it('fails closed for duplicate invalid keys non-read phases and malformed full payloads', () => {
    const { governance, input } = fixture();
    expect(governance.authorizeReadEvidenceSubjects(input, [])).toEqual([]);
    for (const keys of [['subject-a', 'subject-a'], ['subject-a', ''], ['subject-a', ' '], ['subject-a', 7] as unknown as string[]]) {
      expect(governance.authorizeReadEvidenceSubjects(input, keys)).toEqual([]);
    }
    for (const phase of ['propose', 'approve', 'execute'] as const) {
      expect(governance.authorizeReadEvidenceSubjects({ ...input, phase }, ['subject-a'])).toEqual([]);
    }
    const malformed = [
      { ...input, now: 'invalid' },
      { ...input, required: [] },
      { ...input, payload: { operations: [{ operation: 'transaction', direction: 'outgoing' as const }] } },
      { ...input, payload: { operations: [{ operation: 'transaction', accountId: '' }] } },
      { ...input, payload: { operations: [{ operation: 'transaction', direction: 'outgoing' as const, amount: { currency: 'USD', minorUnits: '9223372036854775808' } }] } },
      { ...input, payload: { operations: null } } as unknown as GovernanceAuthorizationInput,
      { ...input, payload: null } as unknown as GovernanceAuthorizationInput,
    ];
    for (const invalid of malformed) expect(governance.authorizeReadEvidenceSubjects(invalid, ['subject-a'])).toEqual([]);
  });

  it('freshly fences policy membership credential expiry and identity on each batch', () => {
    const { governance, input, space, policy, member } = fixture();
    expect(governance.authorizeReadEvidenceSubjects(input, ['subject-a'])).toEqual(['subject-a']);
    expect(governance.authorizeReadEvidenceSubjects({ ...input, auth: { ...auth('owner'), credentialExpiresAt: now } }, ['subject-a'])).toEqual([]);
    expect(governance.authorizeReadEvidenceSubjects({ ...input, auth: auth('other') }, ['subject-a'])).toEqual([]);
    governance.setPolicy({ spaceId: space.id, expectedVersion: policy.version, policy: { minimumApprovers: 1, approvalThresholds: [] }, now, auth: auth('owner') });
    expect(governance.authorizeReadEvidenceSubjects(input, ['subject-a'])).toEqual([]);
    const current = governance.getPolicy({ spaceId: space.id });
    if (!current) throw new Error('Current policy unavailable');
    governance.revokeMembership({ spaceId: space.id, membershipId: member.id, now, auth: auth('owner') });
    expect(governance.authorizeReadEvidenceSubjects({ ...input, expectedPolicyVersion: current.version }, ['subject-a'])).toEqual([]);
  });

  it('uses current delegated rights issuer grants binding and expiry for selective admission', () => {
    const { governance, input, space, member, required, grant } = fixture();
    const agentId = 'agent:evidence-read';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth('owner') });
    const rights = [...required, ...subjectRights('subject-a')];
    const delegation = governance.delegate({
      spaceId: space.id, agentId, issuerMembershipId: member.id, expectedVersion: null,
      rights, validFrom: now, validUntil: later, now, auth: auth('owner'),
    });
    governance.registerCredentialBinding({
      spaceId: space.id, credentialId: 'credential:evidence-read', credentialOwnerId: 'owner',
      principalType: 'agent', principalId: agentId, delegationId: delegation.id,
      expectedDelegationVersion: delegation.version, now, auth: auth('owner'),
    });
    const delegated: GovernanceAuthorizationInput = {
      ...input, actorId: agentId, agentId, delegationId: delegation.id, delegationVersion: delegation.version,
      auth: { method: 'api-key', actorId: agentId, credentialId: 'credential:evidence-read', credentialOwnerId: 'owner', principalType: 'agent', delegationId: delegation.id, delegationVersion: delegation.version },
    };
    expect(governance.authorizeReadEvidenceSubjects(delegated, ['subject-a', 'subject-b'])).toEqual(['subject-a']);
    expect(governance.authorizeReadEvidenceSubjects({ ...delegated, now: later }, ['subject-a'])).toEqual([]);
    grant(required[4]!, {}, false);
    expect(governance.authorizeReadEvidenceSubjects(delegated, ['subject-a'])).toEqual([]);
    grant(required[4]!);
    governance.revokeCredentialBinding({ spaceId: space.id, credentialId: 'credential:evidence-read', now, auth: auth('owner') });
    expect(governance.authorizeReadEvidenceSubjects(delegated, ['subject-a'])).toEqual([]);
  });
});
