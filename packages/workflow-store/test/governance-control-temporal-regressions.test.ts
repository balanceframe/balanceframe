import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/store.js';
import type { HumanControlContext } from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const later = '2098-01-01T12:05:00.000Z';
const auth = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
  method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt,
});

const CONTROL_CAPABILITIES = [
  'space:manage', 'identity:manage', 'membership:manage', 'connection:manage', 'policy:manage',
  'grant:manage', 'agent:manage', 'delegation:manage', 'credential:manage', 'audit:read',
] as const;
const CONTROL_APPROVAL_SETTLEMENT_VARIANTS = [
  'approval', 'approve', 'approval:read', 'approval:manage', 'categorization:approve', 'rule:approve',
  'transfer.approve', 'confirmation', 'confirm', 'transfer:confirmation', 'transfer.confirm',
  'settlement', 'settle', 'transfer:settlement', 'transfer:settle', 'control', 'control:read',
  'control-plane:read', 'space.control:read', 'initiation-report',
] as const;
const NONDELEGABLE_AGENT_CAPABILITIES = [
  ...CONTROL_CAPABILITIES, ...CONTROL_APPROVAL_SETTLEMENT_VARIANTS,
] as const;

type StoreInternalsForTest = { db: DatabaseType };
function testDatabase(store: SqliteWorkflowStore): DatabaseType {
  return (store as unknown as StoreInternalsForTest).db;
}

describe('native governance control and temporal regressions', () => {
  let store: SqliteWorkflowStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'control-temporal' });
    await store.finalizeBootstrap({ claimId: 'control-temporal', ownerUserId: 'owner' });
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function createSpace(governance = store.governance) {
    return governance.createSpace({ actorId: 'owner', name: 'Governance regression', kind: 'shared', now, auth: auth('owner') });
  }

  it('rejects control, approval, settlement, and confirmation delegation on issue and current read evaluation', () => {
    const governance = store.governance;
    const space = createSpace();
    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    const policy = governance.getPolicy({ spaceId: space.id });
    if (!issuer || !policy) throw new Error('Governance regression fixture unavailable');

    for (const capability of NONDELEGABLE_AGENT_CAPABILITIES) {
      governance.provisionResourceGrant({
        spaceId: space.id, actorId: 'owner', membershipId: issuer.id, capability,
        resourceKind: 'space', resourceId: space.id, granted: true, now,
      });
    }
    const agentId = 'agent:control-regression';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth('owner') });

    for (const [index, capability] of NONDELEGABLE_AGENT_CAPABILITIES.entries()) {
      expect(() => governance.delegate({
        id: `blocked-delegation-${index}`,
        spaceId: space.id,
        agentId,
        issuerMembershipId: issuer.id,
        expectedVersion: null,
        rights: [{ capability, resourceKind: 'space', resourceId: space.id }],
        validFrom: now,
        validUntil: later,
        now,
        auth: auth('owner'),
      }), capability).toThrow();
    }
    expect(governance.listDelegations({ spaceId: space.id, agentId })).toEqual([]);
    governance.provisionResourceGrant({
      spaceId: space.id, actorId: 'owner', membershipId: issuer.id, capability: 'summary',
      resourceKind: 'space', resourceId: space.id, granted: true, now,
    });

    const validDelegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: space.id }],
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('owner'),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: 'key:control-regression',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agentId,
      delegationId: validDelegation.id,
      expectedDelegationVersion: validDelegation.version,
      now,
      auth: auth('owner'),
    });
    const agentAuth = {
      method: 'api-key' as const,
      actorId: agentId,
      credentialId: 'key:control-regression',
      credentialOwnerId: 'owner',
      principalType: 'agent' as const,
      delegationId: validDelegation.id,
      delegationVersion: validDelegation.version,
    };

    for (const capability of NONDELEGABLE_AGENT_CAPABILITIES) {
      testDatabase(store).prepare('UPDATE agent_delegations SET rights=? WHERE id=? AND version=?')
        .run(JSON.stringify([{ capability, resourceKind: 'space', resourceId: space.id }]),
          validDelegation.id, validDelegation.version);
      const result = governance.authorize({
        actorId: agentId,
        agentId,
        delegationId: validDelegation.id,
        delegationVersion: validDelegation.version,
        spaceId: space.id,
        expectedPolicyVersion: policy.version,
        phase: 'read',
        operation: 'governance.read',
        required: [{ capability, resourceKind: 'space', resourceId: space.id }],
        payload: { operations: [] },
        now,
        auth: agentAuth,
      });
      expect(result.disposition.kind, capability).toBe('denied');
    }

    const humanControlRead = governance.authorize({
      actorId: 'owner',
      membershipId: issuer.id,
      spaceId: space.id,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'grant:manage',
      required: [{ capability: 'grant:manage', resourceKind: 'space', resourceId: space.id }],
      payload: { operations: [] },
      now,
      auth: auth('owner'),
    });
    expect(humanControlRead.disposition.kind).toBe('authorized_without_approval');
  });

  it('retains delegated financial reads, proposals, and human-approved operational execution', () => {
    const governance = store.governance;
    const space = createSpace();
    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    const policy = governance.getPolicy({ spaceId: space.id });
    if (!issuer || !policy) throw new Error('Governance regression fixture unavailable');
    const rights = [
      { capability: 'balance', resourceKind: 'account' as const, resourceId: 'checking' },
      { capability: 'categorization:propose', resourceKind: 'space' as const, resourceId: space.id },
      { capability: 'categorization:execute', resourceKind: 'space' as const, resourceId: space.id },
    ];
    for (const right of rights) governance.provisionResourceGrant({
      spaceId: space.id, actorId: 'owner', membershipId: issuer.id, ...right, granted: true, now,
    });
    const agentId = 'agent:operational-regression';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth('owner') });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights,
      validFrom: now,
      validUntil: later,
      now,
      auth: auth('owner'),
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: 'key:operational-regression',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth('owner'),
    });
    const authForAgent = {
      method: 'api-key' as const,
      actorId: agentId,
      credentialId: 'key:operational-regression',
      credentialOwnerId: 'owner',
      principalType: 'agent' as const,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
    };
    const authorize = (input: {
      phase: 'read' | 'propose' | 'execute';
      operation: string;
      capability: string;
      resourceKind: 'space' | 'account';
      resourceId: string;
      verifiedHumanApproval?: true;
    }) => governance.authorize({
      actorId: agentId,
      agentId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      spaceId: space.id,
      expectedPolicyVersion: policy.version,
      phase: input.phase,
      operation: input.operation,
      required: [{ capability: input.capability, resourceKind: input.resourceKind, resourceId: input.resourceId }],
      payload: { operations: [] },
      now,
      auth: authForAgent,
      ...(input.verifiedHumanApproval ? { verifiedHumanApproval: input.verifiedHumanApproval } : {}),
    });

    expect(authorize({
      phase: 'read', operation: 'balance.read', capability: 'balance', resourceKind: 'account', resourceId: 'checking',
    }).disposition.kind).toBe('authorized_without_approval');
    expect(authorize({
      phase: 'propose', operation: 'categorize', capability: 'categorization:propose',
      resourceKind: 'space', resourceId: space.id,
    }).disposition.kind).toBe('approval_required');
    expect(authorize({
      phase: 'execute', operation: 'categorize', capability: 'categorization:execute',
      resourceKind: 'space', resourceId: space.id, verifiedHumanApproval: true,
    }).disposition.kind).toBe('authorized_without_approval');
  });

  it('normalizes offset and fractional membership/delegation bounds and preserves half-open instants', async () => {
    const governance = store.governance;
    const space = createSpace();
    await store.upsertActorMembership('offset-member', 'active', [], 'unscoped');
    const offsetMembership = governance.addMembership({
      spaceId: space.id,
      actorId: 'offset-member',
      validFrom: '2026-10-03T10:00:00+02:00',
      validUntil: '2026-10-03T09:30:00Z',
      now,
      auth: auth('owner'),
    });
    expect(offsetMembership).toMatchObject({
      validFrom: '2026-10-03T08:00:00.000Z',
      validUntil: '2026-10-03T09:30:00.000Z',
    });
    expect(governance.getCurrentMembership({
      spaceId: space.id, actorId: 'offset-member', now: '2026-10-03T08:30:00Z',
    })?.id).toBe(offsetMembership.id);
    expect(() => governance.addMembership({
      spaceId: space.id,
      actorId: 'offset-member',
      validFrom: '2026-10-03T08:30:00Z',
      validUntil: '2026-10-03T08:40:00Z',
      now,
      auth: auth('owner'),
    })).toThrow(/overlap/i);

    await store.upsertActorMembership('fractional-member', 'active', [], 'unscoped');
    const millisecondEnd = '2098-01-01T12:00:00.001Z';
    const firstPeriod = governance.addMembership({
      spaceId: space.id,
      actorId: 'fractional-member',
      validFrom: '2098-01-01T12:00:00Z',
      validUntil: millisecondEnd,
      now,
      auth: auth('owner'),
    });
    const adjacentPeriod = governance.addMembership({
      spaceId: space.id,
      actorId: 'fractional-member',
      validFrom: millisecondEnd,
      now: millisecondEnd,
      auth: auth('owner', millisecondEnd),
    });
    expect(firstPeriod.validFrom).toBe('2098-01-01T12:00:00.000Z');
    expect(firstPeriod.validUntil).toBe(millisecondEnd);
    expect(adjacentPeriod.validFrom).toBe(millisecondEnd);
    expect(governance.getCurrentMembership({
      spaceId: space.id, actorId: 'fractional-member', now: millisecondEnd,
    })?.id).toBe(adjacentPeriod.id);

    const issuer = governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now });
    if (!issuer) throw new Error('Timestamp issuer membership unavailable');
    governance.provisionResourceGrant({
      spaceId: space.id, actorId: 'owner', membershipId: issuer.id, capability: 'summary',
      resourceKind: 'space', resourceId: space.id, granted: true, now,
    });
    const agentId = 'agent:offset-delegation';
    governance.registerAgent({ spaceId: space.id, agentId, now, auth: auth('owner') });
    const delegation = governance.delegate({
      spaceId: space.id,
      agentId,
      issuerMembershipId: issuer.id,
      expectedVersion: null,
      rights: [{ capability: 'summary', resourceKind: 'space', resourceId: space.id }],
      validFrom: '2098-01-01T14:00:00+02:00',
      validUntil: millisecondEnd,
      now,
      auth: auth('owner'),
    });
    expect(delegation).toMatchObject({
      validFrom: '2098-01-01T12:00:00.000Z',
      validUntil: millisecondEnd,
    });
    governance.registerCredentialBinding({
      spaceId: space.id,
      credentialId: 'key:offset-delegation',
      credentialOwnerId: 'owner',
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth('owner'),
    });
    expect(governance.resolveCredentialPrincipal({
      credentialId: 'key:offset-delegation', referenceId: 'owner', spaceId: space.id,
      now: '2098-01-01T14:00:00+02:00',
    })).toMatchObject({ principalType: 'agent', delegationId: delegation.id });
    expect(governance.resolveCredentialPrincipal({
      credentialId: 'key:offset-delegation', referenceId: 'owner', spaceId: space.id, now: millisecondEnd,
    })).toBeNull();
  });

  it('serializes competing membership additions before overlap evaluation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-governance-overlap-'));
    const databasePath = join(directory, 'workflow.sqlite');
    const firstStore = new SqliteWorkflowStore(databasePath);
    let secondStore: SqliteWorkflowStore | null = null;
    try {
      await firstStore.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'overlap-concurrency' });
      await firstStore.finalizeBootstrap({ claimId: 'overlap-concurrency', ownerUserId: 'owner' });
      const governance = firstStore.governance;
      const space = governance.createSpace({ actorId: 'owner', name: 'Concurrent memberships', kind: 'shared', now, auth: auth('owner') });
      await firstStore.upsertActorMembership('concurrent-member', 'active', [], 'unscoped');
      secondStore = new SqliteWorkflowStore(databasePath);
      const firstDb = testDatabase(firstStore);
      testDatabase(secondStore).pragma('busy_timeout = 0');
      const add = {
        spaceId: space.id,
        actorId: 'concurrent-member',
        validFrom: now,
        validUntil: later,
        now,
        auth: auth('owner'),
      };
      let attemptedCompetingWriter = false;
      let competingWriterError: unknown;
      const prepare = firstDb.prepare.bind(firstDb);
      firstDb.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes('SELECT valid_from,valid_until FROM space_memberships')) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property === 'all') {
              return (...params: string[]) => {
                const rows = target.all(...params);
                if (!attemptedCompetingWriter) {
                  attemptedCompetingWriter = true;
                  try {
                    secondStore!.governance.addMembership(add);
                  } catch (error) {
                    competingWriterError = error;
                  }
                }
                return rows;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }) as typeof firstDb.prepare;
      try {
        governance.addMembership(add);
      } finally {
        firstDb.prepare = prepare as typeof firstDb.prepare;
      }

      expect(attemptedCompetingWriter).toBe(true);
      expect(competingWriterError).toBeDefined();
      expect(governance.listMembershipHistory({ spaceId: space.id, actorId: 'concurrent-member' })).toHaveLength(1);
      expect(() => secondStore!.governance.addMembership(add)).toThrow(/overlap/i);
      expect(governance.listMembershipHistory({ spaceId: space.id, actorId: 'concurrent-member' })).toHaveLength(1);
    } finally {
      secondStore?.close();
      firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
