/**
 * Composable that exposes ReviewActionBindings as callable template helpers.
 *
 * Every action has identical semantics whether triggered by keyboard,
 * touch, or programmatic invocation — no input modality duplicates
 * business logic.
 */

import type { ReviewControllerAdapter } from '../types/review-client';

/**
 * Provides keyboard-friendly action helpers backed by the controller adapter.
 *
 * @param adapter - a {@link ReviewControllerAdapter} instance
 * @param onCorrect - optional callback invoked when the user presses the
 *   correct key (C/c). The component is expected to prompt for a category
 *   and then call `adapter.correct(categoryId)`.
 * @param onProposeRule - optional callback invoked to open the rule-proposal
 *   flow. Currently triggered programmatically rather than by direct keyboard.
 */
export function useReviewActions(
  adapter: ReviewControllerAdapter,
  onCorrect?: () => void,
  onProposeRule?: () => void,
) {
  /**
   * Map a KeyboardEvent to a review action.  Returns true when the event
   * was handled (preventDefault already called).
   *
   * Key bindings (Nuxt-convention friendly):
   *   Enter       — approve
   *   KeyC        — edit category (opens correction modal)
   *   KeyS        — skip
   *   KeyZ + ctrl — undo
   *   ArrowDown   — selectNext
   *   ArrowUp     — selectPrevious
   */
  function handleKeyboard(event: KeyboardEvent): boolean {
    const { ctrlKey, metaKey, key } = event;

    switch (key) {
      case 'Enter':
        adapter.approve();
        event.preventDefault();
        return true;

      case 'c':
      case 'C':
        event.preventDefault();
        onCorrect?.();
        return true;

      case 'r':
      case 'R':
        adapter.reject();
        event.preventDefault();
        return true;

      case 's':
      case 'S':
        adapter.skip();
        event.preventDefault();
        return true;

      case 'z':
      case 'Z':
        // Require Ctrl/Cmd modifier — bare z must not mutate state.
        if (!ctrlKey && !metaKey) return false;
        adapter.undo();
        event.preventDefault();
        return true;

      case 'ArrowDown':
        adapter.selectNext();
        event.preventDefault();
        return true;

      case 'ArrowUp':
        adapter.selectPrevious();
        event.preventDefault();
        return true;

      default:
        return false;
    }
  }
  /**
   * Trigger the onProposeRule callback, if provided.
   */
  function proposeRule(): void {
    onProposeRule?.();
  }

  return {
    handleKeyboard,
    proposeRule,
  };
}
