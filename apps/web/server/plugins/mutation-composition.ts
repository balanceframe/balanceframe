/**
 * Server plugin that wires the event-context-aware ReviewMutationExecutor
 * factory for reviewAndApply mode.
 *
 * The factory reads runtime configuration from the event context and
 * creates a per-request executor.  This allows the composition root to
 * inject BudgetLedger and CategorizationMutationService instances
 * without the web layer depending on @balanceframe/application or
 * @balanceframe/actual-adapter.
 *
 * reviewAndApply mode is opt-in via runtimeConfig.reviewAndApply = true.
 * Observe mode (default) never writes to Actual.
 */

import {
  setReviewMutationExecutorFactory,
  type ReviewMutationExecutorFactory,
  type EventWithContext,
  type ReviewMutationExecutor,
  type MutationStatus,
} from '../utils/workflow-store';

/**
 * Default factory implementation.
 *
 * In production, the composition root (host app or CLI) should replace
 * this with a factory that creates a BudgetLedger from event context
 * config and wraps CategorizationMutationService.
 *
 * Test harnesses may call setReviewMutationExecutorFactory directly
 * with their own factory.
 *
 * @returns a default executor that returns 'denied' (no-op) when no
 *          real services are configured, or null when reviewAndApply
 *          is not active.
 */
export function createDefaultExecutorFactory(): ReviewMutationExecutorFactory {
  return (event: EventWithContext): ReviewMutationExecutor | null => {
    const config = event.context.runtimeConfig as Record<string, unknown> | undefined;

    // Only activate in reviewAndApply mode
    if (!config?.reviewAndApply) return null;

    // In production, this would:
    //   1. Read Actual server URL / password from config
    //   2. Create an ActualClient
    //   3. Create an ActualConnector (BudgetLedger)
    //   4. Create a RustMutationProtocol
    //   5. Create a CategorizationMutationService
    //   6. Return an executor that wraps the service
    //
    // For now, return a denied executor — the composition root should
    // call setReviewMutationExecutorFactory with the real factory.

    return async (_input, _store, _item) => ({
      mutationStatus: 'denied' as MutationStatus,
      success: false,
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
      error: 'Mutation service not configured: call setReviewMutationExecutorFactory with a real factory',
    });
  };
}

export default defineNitroPlugin(() => {
  setReviewMutationExecutorFactory(createDefaultExecutorFactory());
  console.log('[mutation-composition] Default executor factory registered');
});
