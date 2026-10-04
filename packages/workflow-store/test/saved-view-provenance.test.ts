import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '../src/store.js';
import type { HumanControlContext } from '../src/governance-types.js';

const now = '2098-01-01T12:00:00.000Z';
const later = '2098-01-01T13:00:00.000Z';
const actorId = 'saved-view-member';
const controlAuth = (id: string, at = new Date().toISOString()): HumanControlContext => ({
  method: 'human-session',
  actorId: id,
  sessionId: `session:${id}`,
  reauthenticatedAt: at,
});

describe('saved-view space and membership provenance', () => {
  let store: SqliteWorkflowStore;
  let tempDirectory: string | null;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    tempDirectory = null;
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: 'owner' });
    await store.upsertActorMembership(actorId, 'active', [], '');
  });

  afterEach(() => {
    store.close();
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function addSpace(budgetId: string) {
    const at = new Date().toISOString();
    const governance = store.governance;
    const unbound = governance.createSpace({
      actorId: 'owner',
      name: budgetId,
      kind: 'shared',
      now: at,
      auth: controlAuth('owner', at),
    });
    const space = governance.bindBudget({
      spaceId: unbound.id,
      budgetId,
      now: at,
      auth: controlAuth('owner', at),
    });
    const membership = governance.addMembership({
      spaceId: space.id,
      actorId,
      validFrom: at,
      now: at,
      auth: controlAuth('owner', at),
    });
    return {
      actorId,
      spaceId: space.id,
      budgetId,
      membershipId: membership.id,
    };
  }

  it('requires the supplied membership to belong to the saved-view actor', async () => {
    const selected = addSpace('saved-view-membership-owner');
    await expect(
      store.createSavedView({
        authority: { ...selected, actorId: 'spoofed-saved-view-actor' },
        name: 'Impersonated view',
        viewType: 'budget_summary',
        scope: {},
      }),
    ).rejects.toThrow('Saved view authority is not current');
  });

  it('allows the originating membership and denies another space, budget, or membership', async () => {
    const selected = addSpace('saved-view-budget-a');
    const other = addSpace('saved-view-budget-b');
    const saved = await store.createSavedView({
      authority: selected,
      name: 'Private view',
      viewType: 'budget_summary',
      scope: { category: 'private-category' },
      sort: 'date:asc',
    });
    expect(saved.viewId).toBeTypeOf('string');
    expect(saved).toMatchObject({
      name: 'Private view',
      viewType: 'budget_summary',
      scope: { category: 'private-category' },
      sort: 'date:asc',
      actorId,
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
      createdAt: now,
      lastUsedAt: null,
    });
    expect(await store.listSavedViews(selected)).toMatchObject([{ viewId: saved.viewId, name: 'Private view' }]);
    expect(await store.getSavedView(saved.viewId, selected)).toMatchObject({
      viewId: saved.viewId,
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
    });

    const updated = await store.updateSavedView(saved.viewId, {
      authority: selected,
      name: 'Renamed privately',
      scope: { category: 'updated-category' },
    });
    expect(updated.name).toBe('Renamed privately');
    expect(updated.sort).toBe('date:asc');
    const duplicate = await store.duplicateSavedView({
      sourceViewId: saved.viewId,
      name: 'Same-space copy',
      authority: selected,
    });
    expect(duplicate).toMatchObject({
      name: 'Same-space copy',
      actorId,
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
      sort: 'date:asc',
    });
    expect(duplicate.viewId).not.toBe(saved.viewId);
    expect(duplicate.viewType).toBe(saved.viewType);
    expect(duplicate.scope).toEqual({ category: 'updated-category' });
    const reSorted = await store.updateSavedView(saved.viewId, {
      authority: selected,
      sort: 'amount:desc',
    });
    expect(reSorted.sort).toBe('amount:desc');
    const cleared = await store.updateSavedView(saved.viewId, { authority: selected, sort: null });
    expect(cleared.sort).toBeNull();
    const used = await store.recordSavedViewUsage(saved.viewId, selected);
    expect(used.lastUsedAt).toBe(now);
    vi.setSystemTime(new Date(later));
    const usedAgain = await store.recordSavedViewUsage(saved.viewId, selected);
    expect(usedAgain.lastUsedAt).toBe(later);
    const renamedAfterUse = await store.updateSavedView(saved.viewId, {
      authority: selected,
      name: 'Used & Renamed',
    });
    expect(renamedAfterUse.scope).toEqual({ category: 'updated-category' });
    expect(renamedAfterUse.lastUsedAt).toBe(usedAgain.lastUsedAt);

    expect(await store.deleteSavedView(duplicate.viewId, selected)).toBe(true);
    expect(await store.getSavedView(duplicate.viewId, selected)).toBeNull();
    expect(await store.listSavedViews(selected)).toMatchObject([{ viewId: saved.viewId }]);
    expect(await store.getSavedView('missing-view', selected)).toBeNull();
    await expect(
      store.updateSavedView('missing-view', { authority: selected, name: 'Ghost' }),
    ).rejects.toThrow('Saved view missing-view not found');
    await expect(
      store.duplicateSavedView({
        sourceViewId: 'missing-view',
        name: 'Ghost copy',
        authority: selected,
      }),
    ).rejects.toThrow('Source saved view missing-view not found');
    await expect(store.recordSavedViewUsage('missing-view', selected)).rejects.toThrow(
      'Saved view missing-view not found',
    );
    expect(await store.deleteSavedView('missing-view', selected)).toBe(false);

    expect(await store.listSavedViews(other)).toEqual([]);
    expect(await store.getSavedView(saved.viewId, other)).toBeNull();
    await expect(store.updateSavedView(saved.viewId, { authority: other, name: 'Stolen' })).rejects.toThrow();
    await expect(store.duplicateSavedView({ sourceViewId: saved.viewId, name: 'Stolen copy', authority: other })).rejects.toThrow();
    await expect(store.recordSavedViewUsage(saved.viewId, other)).rejects.toThrow();
    expect(await store.deleteSavedView(saved.viewId, other)).toBe(false);
    const wrongScopes = [
      { ...selected, spaceId: other.spaceId },
      { ...selected, budgetId: 'saved-view-forged-budget' },
      { ...selected, membershipId: 'saved-view-forged-membership' },
    ];
    for (const authority of wrongScopes) {
      expect(await store.listSavedViews(authority)).toEqual([]);
      expect(await store.getSavedView(saved.viewId, authority)).toBeNull();
      await expect(
        store.updateSavedView(saved.viewId, { authority, name: 'Wrong scope' }),
      ).rejects.toThrow();
      await expect(
        store.duplicateSavedView({
          sourceViewId: saved.viewId,
          name: 'Wrong-scope copy',
          authority,
        }),
      ).rejects.toThrow();
      await expect(store.recordSavedViewUsage(saved.viewId, authority)).rejects.toThrow();
      expect(await store.deleteSavedView(saved.viewId, authority)).toBe(false);
    }

    expect(await store.getSavedView(saved.viewId, selected)).toMatchObject({
      name: 'Used & Renamed',
      scope: { category: 'updated-category' },
      sort: null,
      lastUsedAt: later,
    });
  });

  it('preserves an empty saved-view scope as an empty object', async () => {
    const selected = addSpace('saved-view-empty-scope-budget');
    const empty = await store.createSavedView({
      authority: selected,
      name: 'Empty scope view',
      viewType: 'budget_summary',
      scope: {},
    });
    expect(empty.scope).toEqual({});
    expect(empty.sort).toBeNull();
  });

  it('does not revive a saved view after the original membership leaves and rejoins', async () => {
    const selected = addSpace('saved-view-membership-budget');
    const saved = await store.createSavedView({
      authority: selected,
      name: 'Old period view',
      viewType: 'budget_summary',
      scope: { secret: 'old-period-scope' },
    });
    expect(await store.listSavedViews(selected)).toMatchObject([{ viewId: saved.viewId }]);
    expect(await store.getSavedView(saved.viewId, selected)).toMatchObject({ name: 'Old period view' });
    store.governance.revokeMembership({
      spaceId: selected.spaceId,
      membershipId: selected.membershipId,
      now: later,
      auth: controlAuth('owner', later),
    });
    const rejoined = store.governance.addMembership({
      spaceId: selected.spaceId,
      actorId,
      validFrom: later,
      now: later,
      auth: controlAuth('owner', later),
    });
    vi.setSystemTime(new Date(later));
    const newPeriod = { ...selected, membershipId: rejoined.id };

    expect(await store.listSavedViews(newPeriod)).toEqual([]);
    expect(await store.getSavedView(saved.viewId, newPeriod)).toBeNull();
    expect(await store.listSavedViews(selected)).toEqual([]);
    expect(await store.getSavedView(saved.viewId, selected)).toBeNull();
    await expect(store.updateSavedView(saved.viewId, { authority: newPeriod, name: 'Revived' })).rejects.toThrow();
    await expect(store.duplicateSavedView({ sourceViewId: saved.viewId, name: 'Revived copy', authority: newPeriod })).rejects.toThrow();
    await expect(store.recordSavedViewUsage(saved.viewId, newPeriod)).rejects.toThrow();
    expect(await store.deleteSavedView(saved.viewId, newPeriod)).toBe(false);
  });

  it('keeps legacy rows with null provenance inert for every operation', async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'saved-view-provenance-'));
    const databasePath = join(tempDirectory, 'workflow.sqlite');
    store.close();
    store = new SqliteWorkflowStore(databasePath);
    await store.claimBootstrap({
      name: 'Owner',
      email: 'owner@example.test',
      claimId: 'saved-view-legacy',
    });
    await store.finalizeBootstrap({
      claimId: 'saved-view-legacy',
      ownerUserId: 'owner',
    });
    await store.upsertActorMembership(actorId, 'active', [], '');
    const selected = addSpace('legacy-saved-view-budget');
    const current = await store.createSavedView({
      authority: selected,
      name: 'Current view',
      viewType: 'budget_summary',
      scope: { month: '2098-01' },
    });
    expect(await store.listSavedViews(selected)).toMatchObject([{ viewId: current.viewId }]);
    expect(await store.getSavedView(current.viewId, selected)).toMatchObject({ name: 'Current view' });
    const legacy = new Database(databasePath);
    legacy.prepare(`
      INSERT INTO saved_views (view_id, name, view_type, scope, sort, actor_id, created_at, last_used_at)
      VALUES ('legacy-view-id', 'Legacy private name', 'budget_summary', '{"private":"legacy-scope"}', NULL, ?, ?, NULL)
    `).run(actorId, now);
    legacy.close();

    expect(await store.listSavedViews(selected)).toMatchObject([{ viewId: current.viewId }]);
    expect(await store.getSavedView('legacy-view-id', selected)).toBeNull();
    await expect(store.updateSavedView('legacy-view-id', { authority: selected, name: 'Changed' })).rejects.toThrow();
    await expect(store.duplicateSavedView({ sourceViewId: 'legacy-view-id', name: 'Legacy copy', authority: selected })).rejects.toThrow();
    await expect(store.recordSavedViewUsage('legacy-view-id', selected)).rejects.toThrow();
    expect(await store.deleteSavedView('legacy-view-id', selected)).toBe(false);
    expect(await store.getSavedView(current.viewId, selected)).toMatchObject({ name: 'Current view' });

    const retained = new Database(databasePath);
    expect(retained.prepare('SELECT name, scope FROM saved_views WHERE view_id = ?').get('legacy-view-id'))
      .toEqual({ name: 'Legacy private name', scope: '{"private":"legacy-scope"}' });
    retained.close();
  });

});
