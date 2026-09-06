import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '../src/store.js';

const actor = { actorId: 'holder', budgetId: 'budget' };
const now = '2098-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
describe('trusted liquidity evaluation state and governed catalogs', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'liquidity-state-'));
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: actor.actorId });
    store.liquidity.provisionOwnerAccess({
      ...actor,
      now,
      resources: [
        { resourceKind: 'account', resourceId: 'private' },
        { resourceKind: 'category', resourceId: 'food' },
      ],
    });
    store.liquidity.savePolicy({
      ...actor,
      now,
      expectedVersion: null,
      policy: { version: 'one', policyHash: 'hash', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
    store.liquidity.saveSupplementalFacts({
      ...actor,
      now,
      expectedVersion: 0,
      expiresAt,
      observations: [{ accountId: 'private', observedAt: now, expiresAt, owned: true }],
    });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('loads sensitive evaluation inputs for a current conclusion grantee without granting visibility', async () => {
    const reader = { actorId: 'reader', budgetId: 'budget' };
    await store.upsertActorMembership('reader', 'active', ['observe'], 'budget:budget');
    store.liquidity.manageResourceGrant({
      ...reader,
      managerId: actor.actorId,
      resourceKind: 'category',
      resourceId: 'food',
      capability: 'conclusion',
      granted: true,
      now,
    });
    const state = store.liquidity.loadEvaluationState({ ...reader, now });
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
    store.liquidity.manageResourceGrant({
      ...reader,
      managerId: actor.actorId,
      resourceKind: 'category',
      resourceId: 'food',
      capability: 'conclusion',
      granted: false,
      now,
    });
    expect(() => store.liquidity.loadEvaluationState({ ...reader, now })).toThrow(/authoriz/i);
  });
  it('denies observe-only, revoked and wrong-budget memberships; retains expired version for editing', async () => {
    await store.upsertActorMembership('observer', 'active', ['observe'], 'budget:budget');
    expect(() =>
      store.liquidity.loadEvaluationState({ actorId: 'observer', budgetId: 'budget', now }),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.loadEvaluationState({ ...actor, budgetId: 'elsewhere', now }),
    ).toThrow(/authoriz/i);
    expect(
      store.liquidity.loadEvaluationState({ ...actor, now: '2100-01-01T00:00:00.000Z' })
        .supplemental?.version,
    ).toBe(1);
    await store.upsertActorMembership(
      actor.actorId,
      'revoked',
      ['liquidity:conclusion'],
      'budget:budget',
    );
    expect(() => store.liquidity.loadEvaluationState({ ...actor, now })).toThrow(/authoriz/i);
  });
  it('lists only active same-budget members and grants to a current registered owner', async () => {
    await store.upsertActorMembership('reader', 'active', ['observe'], 'budget:budget');
    await store.upsertActorMembership('foreign', 'active', ['observe'], 'budget:elsewhere');
    await store.upsertActorMembership('revoked', 'revoked', ['observe'], 'budget:budget');
    const catalog = store.liquidity.getResourceGrantCatalog(actor);
    expect(catalog.members.map((member) => member.actorId).sort()).toEqual(['holder', 'reader']);
    expect(catalog.grants.some((grant) => grant.resourceId === 'private')).toBe(true);
    expect(() =>
      store.liquidity.getResourceGrantCatalog({ actorId: 'reader', budgetId: 'budget' }),
    ).toThrow(/authoriz/i);
  });
  it('cancels a manual session with CAS and replay without deleting immutable evidence', () => {
    const session = store.liquidity.saveSpendSession(
      {
        ...actor,
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
    const input = { ...actor, id: session.id, expectedVersion: 1, idempotencyKey: 'cancel', now };
    expect(() => store.liquidity.cancelSpendSession({ ...input, expectedVersion: 2 })).toThrow(
      /version|conflict/i,
    );
    const cancelled = store.liquidity.cancelSpendSession(input);
    expect(cancelled).toMatchObject({
      id: 'session',
      version: 2,
      expiresAt: now,
      items: session.items,
    });
    expect(store.liquidity.cancelSpendSession(input)).toEqual(cancelled);
    expect(store.liquidity.listSpendSessions({ ...actor, now })).toEqual([]);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
  });
});
