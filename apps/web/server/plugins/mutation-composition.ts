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
 *
 * The pure factory implementation lives in server/utils/mutation-executor.ts
 * so tests can import createDefaultExecutorFactory without triggering
 * Nitro's defineNitroPlugin globals.
 */

import { setReviewMutationExecutorFactory } from '../utils/workflow-store';
import { createDefaultExecutorFactory } from '../utils/mutation-executor';

export default defineNitroPlugin(() => {
  setReviewMutationExecutorFactory(createDefaultExecutorFactory());
  console.log('[mutation-composition] Actual mutation executor factory registered');
});
