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
 */
export function useReviewActions(adapter: ReviewControllerAdapter) {
  /**
   * Map a KeyboardEvent to a review action.  Returns true when the event
   * was handled (preventDefault already called).
   *
   * Key bindings (Nuxt-convention friendly):
   *   Enter       — approve
   *   KeyC        — correct (prompts for category)
   *   KeyR        — reject
   *   KeyS        — skip
   *   KeyZ + ctrl — undo
   *   ArrowDown   — selectNext
   *   ArrowUp     — selectPrevious
   */
  function handleKeyboard(event: KeyboardEvent): boolean {
    const { ctrlKey, key } = event;

    switch (key) {
      case 'Enter':
        adapter.approve();
        event.preventDefault();
        return true;

      case 'c':
      case 'C':
        // Prompt for category — the UI layer supplies the category.
        // This binding just flags intent; the component supplies the input.
        event.preventDefault();
        return false;

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
        if (ctrlKey) {
          adapter.undo();
          event.preventDefault();
          return true;
        }
        return false;

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

  return {
    handleKeyboard,
  };
}
