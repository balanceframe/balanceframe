import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { HumanControlContext } from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const auth = (actorId: string): HumanControlContext => ({ method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now });

// These replace global invitation authority; the public recipient never receives financial rights.
describe('scoped invitations and immutable issuer periods', () => {
  let store: SqliteWorkflowStore;
  let spaceId: string;
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'scoped-invite-fixture' });
    await store.finalizeBootstrap({ claimId: 'scoped-invite-fixture', ownerUserId: 'owner' });
    spaceId = store.governance.createSpace({ actorId: 'owner', name: 'Shared', kind: 'shared', now, auth: auth('owner') }).id;
  });
  afterEach(() => { store.close(); vi.useRealTimers(); });

  function token(inviteUrl: string): string {
    const value = new URL(inviteUrl).hash.slice(1);
    const result = new URLSearchParams(value).get('token');
    if (!result) throw new Error('Fixture invitation token missing');
    return result;
  }
  async function invite(creator = 'owner') {
    return store.createInvitation({ spaceId, auth: auth(creator), now });
  }
  async function claim(creator = 'owner') {
    const invitation = await invite(creator);
    const claimed = await store.claimInvitation({ token: token(invitation.inviteUrl), email: 'guest@example.test' });
    return { invitation, claimed };
  }

  it('joins only the captured space with a new period and no financial or actor-wide rights', async () => {
    const { invitation, claimed } = await claim();
    expect(claimed.spaceId).toBe(spaceId);
    await store.completeInvitationRedemption(claimed.claimId, 'guest', { auth: auth('guest'), email: 'guest@example.test', now });
    const identity = await store.getActorMembership('guest');
    expect(identity).toMatchObject({ actorId: 'guest', status: 'active', capabilities: [], scope: '' });
    const member = store.governance.getCurrentMembership({ spaceId, actorId: 'guest', now });
    expect(member).toMatchObject({ grantedBy: 'owner', validFrom: now, createdAt: now });
    expect(store.governance.listResourceGrants({ spaceId }).filter((grant) => grant.actorId === 'guest')).toEqual([]);
    expect((await store.listInvitations({ spaceId, auth: auth('owner'), now })).find(({ id }) => id === invitation.invitation.id)?.status).toBe('redeemed');
  });

  it('does not permit an ordinary space member or an actor registry wildcard to create an invitation', async () => {
    await store.upsertActorMembership('member', 'active', ['*'], '*');
    store.governance.addMembership({ spaceId, actorId: 'member', validFrom: now, now, auth: auth('owner') });
    await expect(invite('member')).rejects.toThrow(/denied|authoriz|control/i);
    expect(await store.listInvitations({ spaceId, auth: auth('owner'), now })).toEqual([]);
  });

  it('allows a nonowner current membership manager but cannot redeem after that issuer departs and rejoins', async () => {
    await store.upsertActorMembership('manager', 'active', [], '');
    const manager = store.governance.addMembership({ spaceId, actorId: 'manager', validFrom: now, now, auth: auth('owner') });
    store.governance.setResourceGrant({ spaceId, actorId: 'manager', membershipId: manager.id, capability: 'membership:manage', resourceKind: 'space', resourceId: spaceId, granted: true, now, auth: auth('owner') });
    const { invitation, claimed } = await claim('manager');
    store.governance.revokeMembership({ spaceId, membershipId: manager.id, now, auth: auth('owner') });
    const replacement = store.governance.addMembership({ spaceId, actorId: 'manager', validFrom: now, now, auth: auth('owner') });
    store.governance.setResourceGrant({ spaceId, actorId: 'manager', membershipId: replacement.id, capability: 'membership:manage', resourceKind: 'space', resourceId: spaceId, granted: true, now, auth: auth('owner') });
    await expect(store.completeInvitationRedemption(claimed.claimId, 'guest', { auth: auth('guest'), email: 'guest@example.test', now })).rejects.toThrow();
    expect(await store.getActorMembership('guest')).toBeNull();
    expect(store.governance.getCurrentMembership({ spaceId, actorId: 'guest', now })).toBeNull();
    expect((await store.listInvitations({ spaceId, auth: auth('owner'), now })).find(({ id }) => id === invitation.invitation.id)?.status).toBe('claimed');
  });

  it('keeps lists and revocation within the selected space instead of disclosing another invitation', async () => {
    const { invitation } = await claim();
    const other = store.governance.createSpace({ actorId: 'owner', name: 'Other', kind: 'personal', now, auth: auth('owner') });
    expect(await store.listInvitations({ spaceId: other.id, auth: auth('owner'), now })).toEqual([]);
    await expect(store.revokeInvitation({ spaceId: other.id, invitationId: invitation.invitation.id, auth: auth('owner'), now })).rejects.toThrow();
    expect((await store.listInvitations({ spaceId, auth: auth('owner'), now }))[0]?.status).toBe('claimed');
  });

  it.each(['wrong-email', 'wrong-human', 'stale-policy', 'revoked-token'] as const)('cannot partially provision identity or membership on %s redemption', async (failure) => {
    const { invitation, claimed } = await claim();
    if (failure === 'stale-policy') {
      const policy = store.governance.getPolicy({ spaceId })!;
      store.governance.setPolicy({ spaceId, expectedVersion: policy.version, policy: { minimumApprovers: 2, approvalThresholds: [] }, now, auth: auth('owner') });
    }
    if (failure === 'revoked-token') await store.revokeInvitation({ spaceId, invitationId: invitation.invitation.id, auth: auth('owner'), now });
    await expect(store.completeInvitationRedemption(claimed.claimId, 'guest', {
      auth: auth(failure === 'wrong-human' ? 'another-human' : 'guest'),
      email: failure === 'wrong-email' ? 'another@example.test' : 'guest@example.test', now,
    })).rejects.toThrow();
    expect(await store.getActorMembership('guest')).toBeNull();
    expect(store.governance.getCurrentMembership({ spaceId, actorId: 'guest', now })).toBeNull();
  });
});
