import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { HumanControlContext } from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const later = '2098-01-01T12:00:01.000Z';
const auth = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
  method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt,
});

describe('selected-space agent registration', () => {
  let store: SqliteWorkflowStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'agent-scope' });
    await store.finalizeBootstrap({ claimId: 'agent-scope', ownerUserId: 'owner' });
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('registers under the requested space, not the first space managed by that actor', () => {
    const first = store.governance.createSpace({ actorId: 'owner', name: 'First', kind: 'shared', now, auth: auth('owner') });
    const target = store.governance.createSpace({ actorId: 'owner', name: 'Target', kind: 'shared', now: later, auth: auth('owner') });
    const firstAgent = store.governance.registerAgent({
      spaceId: first.id, agentId: 'agent:first', now, auth: auth('owner'),
    });
    const selectedInput = { spaceId: target.id, agentId: 'agent:target', now: later, auth: auth('owner', later) };

    const targetAgent = store.governance.registerAgent(selectedInput);

    expect(targetAgent.registeredSpaceId).toBe(target.id);
    expect(targetAgent.registeredSpaceId).not.toBe(first.id);
    expect(store.governance.listAgents({ spaceId: first.id }).map(({ agentId }) => agentId))
      .toEqual([firstAgent.agentId]);
    expect(store.governance.listAgents({ spaceId: target.id }).map(({ agentId }) => agentId))
      .toEqual([targetAgent.agentId]);
  });

  it('does not let a manager in one space register an agent into another selected space', async () => {
    const first = store.governance.createSpace({ actorId: 'owner', name: 'First', kind: 'shared', now, auth: auth('owner') });
    const target = store.governance.createSpace({ actorId: 'owner', name: 'Target', kind: 'shared', now: later, auth: auth('owner', later) });
    await store.upsertActorMembership('other-manager', 'active', ['*'], '*');
    const firstMembership = store.governance.addMembership({
      spaceId: first.id, actorId: 'other-manager', validFrom: now, now, auth: auth('owner'),
    });
    store.governance.addMembership({
      spaceId: target.id, actorId: 'other-manager', validFrom: later, now: later, auth: auth('owner', later),
    });
    store.governance.provisionResourceGrant({
      spaceId: first.id,
      actorId: 'other-manager',
      membershipId: firstMembership.id,
      capability: 'agent:manage',
      resourceKind: 'space',
      resourceId: first.id,
      granted: true,
      now,
    });

    expect(() => store.governance.registerAgent({
      spaceId: target.id, agentId: 'agent:forbidden', now: later, auth: auth('other-manager', later),
    })).toThrow();
  });
});
