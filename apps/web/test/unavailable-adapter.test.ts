/**
 * Tests for the unavailable/configuration-missing adapter.
 *
 * The page MUST render a non-operational state when no API backend is
 * configured — it MUST NOT construct an in-memory SqliteWorkflowStore or
 * expose mutation controls.
 *
 * These tests verify the factory contract in isolation (no Vue rendering
 * needed, compatible with the node test environment).
 */

import { describe, expect, it } from 'vitest';
import { createUnavailableAdapter } from '../composables/createUnavailableAdapter';

describe('createUnavailableAdapter', () => {
  const adapter = createUnavailableAdapter();

  // ── Operational state ──────────────────────────────────────────────

  it('is never loading', () => {
    expect(adapter.loading).toBe(false);
    expect(adapter.state.loading).toBe(false);
  });

  it('has empty item list', () => {
    expect(adapter.state.items).toEqual([]);
    expect(adapter.state.currentItem).toBeNull();
    expect(adapter.state.currentIndex).toBe(0);
    expect(adapter.state.selectedIndices).toEqual([]);
  });

  it('has CONFIG_MISSING error in state', () => {
    expect(adapter.state.error).not.toBeNull();
    expect(adapter.state.error!.code).toBe('CONFIG_MISSING');
    expect(adapter.state.error!.message).toContain('API backend is not configured');
    expect(adapter.state.error!.retryable).toBe(false);
  });

  // ── No mutation surface ────────────────────────────────────────────

  it('rejects approve with non-success result', async () => {
    const r = await adapter.approve();
    expect(r.success).toBe(false);
    expect(r.error).toContain('not configured');
  });

  it('rejects correct with non-success result', async () => {
    const r = await adapter.correct('cat-foo');
    expect(r.success).toBe(false);
  });

  it('rejects reject with non-success result', async () => {
    const r = await adapter.reject();
    expect(r.success).toBe(false);
  });

  it('rejects skip with non-success result', async () => {
    const r = await adapter.skip();
    expect(r.success).toBe(false);
  });

  it('rejects undo with non-success result', async () => {
    const r = await adapter.undo();
    expect(r.success).toBe(false);
  });

  it('rejects bulk actions with empty result', async () => {
    const r = await adapter.bulkApprove();
    expect(r.results).toEqual([]);
    expect(r.consumedCount).toBe(0);
  });

  // ── Safe navigation / selection (no-ops) ───────────────────────────

  it('does not throw on selectNext', () => {
    expect(() => adapter.selectNext()).not.toThrow();
  });

  it('does not throw on toggleSelection', () => {
    expect(() => adapter.toggleSelection(0)).not.toThrow();
  });

  // ── HasMore / loaded-contract ──────────────────────────────────────

  it('has no more items', () => {
    expect(adapter.state.hasMore).toBe(false);
  });

  it('loadNextPage resolves without error', async () => {
    await expect(adapter.loadNextPage()).resolves.toBeUndefined();
  });
});
