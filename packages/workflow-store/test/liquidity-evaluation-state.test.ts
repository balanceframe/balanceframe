import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HumanControlContext } from '../src/governance-types.js';
import { SqliteWorkflowStore } from '../src/store.js';

const actor = { actorId: 'holder', budgetId: 'budget' };
const now = '2098-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const afterExpiry = '2100-01-01T00:00:00.000Z';

describe('trusted liquidity evaluation state and governed catalogs', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  let spaceId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'liquidity-state-'));
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: actor.actorId });
    const space = store.governance.createSpace({
      actorId: actor.actorId,
      name: 'Governed budget',
      kind: 'shared',
      now,
      auth: human(actor.actorId),
    });
    spaceId = store.governance.bindBudget({
      spaceId: space.id,
      budgetId: actor.budgetId,
      now,
      auth: human(actor.actorId),
    }).id;
    for (const [capability, resourceKind, resourceId] of [
      ['policy', 'budget', actor.budgetId],
      ['policy', 'account', 'private'],
      ['conclusion', 'budget', actor.budgetId],
      ['session', 'budget', actor.budgetId],
      ['liquidity', 'budget', actor.budgetId],
      ['liquidity', 'account', 'private'],
      ['category', 'category', 'food'],
    ] as const)
      provisionGrant(actor.actorId, capability, resourceKind, resourceId);

    const policy = store.governance.getPolicy({ spaceId })!;
    store.liquidity.savePolicy({
      ...liquidityContext(actor.actorId),
      expectedVersion: null,
      expectedGovernancePolicyVersion: policy.version,
      now,
      policy: { version: 'one', policyHash: 'hash', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
    store.liquidity.saveSupplementalFacts({
      ...liquidityContext(actor.actorId),
      expectedVersion: 0,
      expiresAt,
      observations: [{ accountId: 'private', observedAt: now, expiresAt, owned: true }],
    });
  });

  function human(actorId: string, reauthenticatedAt = now): HumanControlContext {
    return {
      method: 'human-session',
      actorId,
      sessionId: `session:${actorId}`,
      reauthenticatedAt,
    };
  }

  function liquidityContext(
    actorId = actor.actorId,
    at = now,
    selectedBudgetId = actor.budgetId,
  ) {
    const membership = store.governance.getCurrentMembership({ spaceId, actorId, now: at });
    const policy = store.governance.getPolicy({ spaceId });
    return {
      actorId,
      budgetId: selectedBudgetId,
      spaceId,
      ...(membership ? { membershipId: membership.id } : {}),
      ...(policy ? { governancePolicyVersion: policy.version } : {}),
      now: at,
      auth: human(actorId, at),
    };
  }

  function provisionGrant(
    actorId: string,
    capability: string,
    resourceKind: 'budget' | 'account' | 'category',
    resourceId: string,
    granted = true,
    at = now,
  ): void {
    const membership = store.governance.getCurrentMembership({ spaceId, actorId, now: at });
    if (!membership) throw new Error('Current governed fixture membership unavailable');
    store.governance.provisionResourceGrant({
      spaceId,
      actorId,
      budgetId: actor.budgetId,
      membershipId: membership.id,
      capability,
      resourceKind,
      resourceId,
      granted,
      now: at,
    });
  }

  async function addMember(
    actorId: string,
    roles: string[] = ['observe'],
    scope = `budget:${actor.budgetId}`,
    selectedSpaceId = spaceId,
  ) {
    await store.upsertActorMembership(actorId, 'active', roles, scope);
    return store.governance.addMembership({
      spaceId: selectedSpaceId,
      actorId,
      validFrom: now,
      now,
      auth: human(actor.actorId),
    });
  }

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('loads sensitive evaluation inputs for a current conclusion grantee without granting visibility', async () => {
    const readerId = 'reader';
    await addMember(readerId, ['observe'], `budget:${actor.budgetId}`);
    provisionGrant(readerId, 'conclusion', 'budget', actor.budgetId);
    const reader = liquidityContext(readerId);
    const state = store.liquidity.loadEvaluationState(reader);
    expect(state.policy?.policy.version).toBe('one');
    expect(state.supplemental?.observations[0]?.accountId).toBe('private');
    expect(
      store.liquidity.isAuthorized({
        ...reader,
        resourceKind: 'account',
        resourceId: 'private',
        capability: 'existence',
      }),
    ).toBe(false);
    provisionGrant(readerId, 'conclusion', 'budget', actor.budgetId, false);
    expect(() => store.liquidity.loadEvaluationState(reader)).toThrow();
  });
  it('loads private server evaluation inputs for aggregate-only conclusion without granting private reads', async () => {
    const readerId = 'aggregate-reader';
    const membership = await addMember(readerId, ['observe'], `budget:${actor.budgetId}`);
    store.governance.provisionResourceGrant({
      spaceId,
      actorId: readerId,
      membershipId: membership.id,
      budgetId: actor.budgetId,
      capability: 'conclusion',
      resourceKind: 'budget',
      resourceId: actor.budgetId,
      granted: true,
      restrictions: { aggregateOnly: true },
      now,
    });
    const reader = liquidityContext(readerId);
    expect(store.liquidity.isAuthorized({
      ...reader,
      resourceKind: 'budget',
      resourceId: actor.budgetId,
      capability: 'conclusion',
      visibility: 'aggregate',
    })).toBe(true);
    expect(store.liquidity.isAuthorized({
      ...reader,
      resourceKind: 'budget',
      resourceId: actor.budgetId,
      capability: 'conclusion',
      visibility: 'resource',
    })).toBe(false);
    const state = store.liquidity.loadEvaluationState(reader);
    expect(state.policy?.policy.version).toBe('one');
    expect(state.supplemental?.observations[0]?.accountId).toBe('private');
    expect(() => store.liquidity.getPolicy(reader)).toThrow();
    expect(() => store.liquidity.getResourceGrantCatalog(reader)).toThrow();
  });

  it('denies observe-only, revoked and wrong-budget memberships; retains expired version for editing', async () => {
    const observerId = 'observer';
    await addMember(observerId, ['observe'], `budget:${actor.budgetId}`);
    expect(() => store.liquidity.loadEvaluationState(liquidityContext(observerId))).toThrow();
    expect(() =>
      store.liquidity.loadEvaluationState(liquidityContext(actor.actorId, now, 'elsewhere')),
    ).toThrow();
    expect(
      store.liquidity.loadEvaluationState(liquidityContext(actor.actorId, afterExpiry))
        .supplemental?.version,
    ).toBe(1);
    await store.upsertActorMembership(
      actor.actorId,
      'revoked',
      ['liquidity:conclusion'],
      `budget:${actor.budgetId}`,
    );
    expect(() => store.liquidity.loadEvaluationState(liquidityContext(actor.actorId))).toThrow();
  });

  it('lists only active same-budget members and grants to a current registered owner', async () => {
    const readerId = 'reader';
    await addMember(readerId, ['observe'], `budget:${actor.budgetId}`);

    const otherSpace = store.governance.createSpace({
      actorId: actor.actorId,
      name: 'Other budget',
      kind: 'shared',
      now,
      auth: human(actor.actorId),
    });
    store.governance.bindBudget({
      spaceId: otherSpace.id,
      budgetId: 'elsewhere',
      now,
      auth: human(actor.actorId),
    });
    await addMember('foreign', ['observe'], 'budget:elsewhere', otherSpace.id);

    const revoked = await addMember('revoked', ['observe'], `budget:${actor.budgetId}`);
    store.governance.revokeMembership({
      spaceId,
      membershipId: revoked.id,
      now,
      auth: human(actor.actorId),
    });

    const catalog = store.liquidity.getResourceGrantCatalog(liquidityContext(actor.actorId));
    expect(catalog.members.map((member) => member.actorId).sort()).toEqual(['holder', 'reader']);
    expect(catalog.grants.some((grant) => grant.resourceId === 'private')).toBe(true);
    expect(() =>
      store.liquidity.getResourceGrantCatalog(liquidityContext(readerId)),
    ).toThrow();
  });
  it('cancels a manual session with CAS and replay without deleting immutable evidence', () => {
    const session = store.liquidity.saveSpendSession(
      {
        ...liquidityContext(actor.actorId),
        id: 'session',
        expectedVersion: 0,
        idempotencyKey: 'create',
        now,
        expiresAt,
        accountId: 'private',
        items: [
          {
            id: 'item',
            categoryId: 'food',
            amount: { minorUnits: '20', currency: 'USD' },
            purchaseAt: now,
            requiredBy: now,
            routeSelection: {
              explicitAccountId: 'private',
              sessionAccountId: null,
              approvedPreference: null,
              historicalRoute: null,
            },
          },
        ],
      },
      () => ({ valid: true }),
    );
    const input = { ...liquidityContext(actor.actorId), id: session.id, expectedVersion: 1, idempotencyKey: 'cancel' };
    expect(() => store.liquidity.cancelSpendSession({ ...input, expectedVersion: 2 })).toThrow();
    const cancelled = store.liquidity.cancelSpendSession(input);
    expect(cancelled).toMatchObject({
      id: 'session',
      version: 2,
      expiresAt: now,
      items: session.items,
    });
    expect(store.liquidity.cancelSpendSession(input)).toEqual(cancelled);
    expect(store.liquidity.listSpendSessions(liquidityContext(actor.actorId))).toEqual([]);
    expect(store.liquidity.getClaimSet(liquidityContext(actor.actorId)).bundles).toEqual([]);
  });
});
