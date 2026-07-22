/**
 * Regression tests for useReviewActions composable.
 *
 * Verifies keyboard-to-action dispatch parity:
 * every action binding invoked by keyboard must match the semantics
 * of the corresponding visible button (approve, correct, reject, skip).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ReviewControllerAdapter, WebActionResult } from '../types/review-client';
import { useReviewActions } from '../composables/useReviewActions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface KeyboardEventMock {
  key: string;
  ctrlKey: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
}

function createKeyEvent(key: string, ctrlKey = false): KeyboardEventMock {
  return { key, ctrlKey, preventDefault: vi.fn() };
}

function createMockResult(overrides: Partial<WebActionResult> = {}): WebActionResult {
  return {
    itemId: 'item-1',
    success: true,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let adapter: ReviewControllerAdapter;
let onCorrect: Mock;
let actions: { handleKeyboard: (event: KeyboardEventMock) => boolean };

beforeEach(() => {
  onCorrect = vi.fn();

  adapter = {
    state: {
      items: [],
      currentItem: null,
      currentIndex: 0,
      selectedIndices: [],
      hasMore: true,
      loading: false,
      error: null,
      metrics: {
        resolvedCount: 0,
        approvedCount: 0,
        correctedCount: 0,
        rejectedCount: 0,
        skippedCount: 0,
        startTime: Date.now(),
      },
    },
    loading: false,
    error: null,
    loadNextPage: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(createMockResult()),
    correct: vi.fn().mockResolvedValue(createMockResult()),
    reject: vi.fn().mockResolvedValue(createMockResult()),
    skip: vi.fn().mockResolvedValue(createMockResult()),
    undo: vi.fn().mockResolvedValue(createMockResult()),
    selectNext: vi.fn(),
    selectPrevious: vi.fn(),
    toggleSelection: vi.fn(),
    clearSelection: vi.fn(),
    bulkApprove: vi.fn().mockResolvedValue({ results: [], consumedCount: 0, errorCount: 0 }),
    bulkCorrect: vi.fn().mockResolvedValue({ results: [], consumedCount: 0, errorCount: 0 }),
    bulkReject: vi.fn().mockResolvedValue({ results: [], consumedCount: 0, errorCount: 0 }),
    bulkSkip: vi.fn().mockResolvedValue({ results: [], consumedCount: 0, errorCount: 0 }),
    resetMetrics: vi.fn(),
    setError: vi.fn(),
    clearError: vi.fn(),
  } satisfies ReviewControllerAdapter;

  actions = useReviewActions(adapter, onCorrect);
});

// ---------------------------------------------------------------------------
// Contract: handleKeyboard dispatching
// ---------------------------------------------------------------------------

describe('useReviewActions', () => {
  describe('handleKeyboard', () => {
    it('returns true when the event was handled (calls preventDefault)', () => {
      const event = createKeyEvent('Enter');
      const preventSpy = event.preventDefault;

      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(true);
      expect(preventSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false for unbound keys', () => {
      const event = createKeyEvent('Escape');

      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('Enter calls adapter.approve and prevents default', () => {
      const event = createKeyEvent('Enter');

      actions.handleKeyboard(event);

      expect(adapter.approve).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('r calls adapter.reject and prevents default', () => {
      const event = createKeyEvent('r');

      actions.handleKeyboard(event);

      expect(adapter.reject).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('R calls adapter.reject (uppercase)', () => {
      actions.handleKeyboard(createKeyEvent('R'));
      expect(adapter.reject).toHaveBeenCalledTimes(1);
    });

    it('s calls adapter.skip and prevents default', () => {
      const event = createKeyEvent('s');

      actions.handleKeyboard(event);

      expect(adapter.skip).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('z without ctrl calls adapter.undo and prevents default', () => {
      const event = createKeyEvent('z');
      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(true);
      expect(adapter.undo).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('ctrl+z calls adapter.undo and prevents default', () => {
      const event = createKeyEvent('z', true);

      actions.handleKeyboard(event);

      expect(adapter.undo).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('ArrowDown calls adapter.selectNext and prevents default', () => {
      const event = createKeyEvent('ArrowDown');

      actions.handleKeyboard(event);

      expect(adapter.selectNext).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('ArrowUp calls adapter.selectPrevious and prevents default', () => {
      const event = createKeyEvent('ArrowUp');

      actions.handleKeyboard(event);

      expect(adapter.selectPrevious).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });
  });

  // ====================================================================
  // Correction shortcut regression — C key invokes correction flow
  // ====================================================================

  describe('correct shortcut (c / C)', () => {
    it('calls the onCorrect callback when lowercase c is pressed', () => {
      const event = createKeyEvent('c');

      const handled = actions.handleKeyboard(event);

      // Must be marked handled so the event does not propagate
      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(onCorrect).toHaveBeenCalledTimes(1);
    });

    it('calls the onCorrect callback when uppercase C is pressed', () => {
      actions.handleKeyboard(createKeyEvent('C'));

      expect(onCorrect).toHaveBeenCalledTimes(1);
    });

    it('does not invoke adapter.correct directly (delegates to callback)', () => {
      actions.handleKeyboard(createKeyEvent('c'));

      expect(adapter.correct).not.toHaveBeenCalled();
    });

    it('works without onCorrect callback (graceful fallback when omitted)', () => {
      const { handleKeyboard } = useReviewActions(adapter);

      const event = createKeyEvent('c');

      const handled = handleKeyboard(event);

      // Must still prevent default and mark handled
      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('does not call onCorrect for other keys', () => {
      actions.handleKeyboard(createKeyEvent('r'));
      actions.handleKeyboard(createKeyEvent('s'));
      actions.handleKeyboard(createKeyEvent('Enter'));

      expect(onCorrect).not.toHaveBeenCalled();
    });
  });

  // ====================================================================
  // Regression: keyboard shortcuts survive pointer-triggered actions
  // ====================================================================
  //
  // After a button click triggers an action directly on the adapter,
  // keyboard shortcuts must remain active.  These tests simulate the
  // page-level contract: the keyboard handler is called on keydown
  // regardless of what stole focus.

  describe('mixed-modality (pointer + keyboard)', () => {
    it('keyboard approve works after pointer-triggered reject', () => {
      // Simulate a pointer click calling adapter.reject
      adapter.reject();
      expect(adapter.reject).toHaveBeenCalledTimes(1);

      // Keyboard shortcut must still work
      const event = createKeyEvent('Enter');
      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(adapter.approve).toHaveBeenCalledTimes(1);
    });

    it('keyboard reject works after pointer-triggered approve', () => {
      adapter.approve();
      expect(adapter.approve).toHaveBeenCalledTimes(1);

      const event = createKeyEvent('r');
      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(true);
      expect(adapter.reject).toHaveBeenCalledTimes(1);
    });

    it('correction shortcut works after pointer-triggered skip', () => {
      adapter.skip();
      expect(adapter.skip).toHaveBeenCalledTimes(1);

      const event = createKeyEvent('c');
      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(true);
      expect(onCorrect).toHaveBeenCalledTimes(1);
    });

    it('multiple pointer-triggered actions do not disable keyboard handling', () => {
      adapter.approve();
      adapter.reject();
      adapter.skip();

      // Keyboard should still work after several pointer actions
      const event = createKeyEvent('s');
      const handled = actions.handleKeyboard(event);

      expect(handled).toBe(true);
      expect(adapter.skip).toHaveBeenCalledTimes(2); // once from pointer, once from keyboard
    });
  });
});
