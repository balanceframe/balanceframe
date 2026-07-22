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
  ActualConnector,
  createDefaultActualClient,
  EnvCredentialStore,
} from '@balanceframe/actual-adapter';
import {
  setReviewMutationExecutorFactory,
  type ReviewMutationExecutorFactory,
  type EventWithContext,
  type ReviewMutationExecutor,
  type MutationStatus,
} from '../utils/workflow-store';

async function createLedger(event: EventWithContext): Promise<ActualConnector> {
  const config = event.context.runtimeConfig as Record<string, unknown> | undefined;
  const credentialStore = new EnvCredentialStore();
  const credentials = await credentialStore.load();
  if (!credentials) throw new Error('No Actual credentials configured.');
  const connector = new ActualConnector({
    client: await createDefaultActualClient(),
    credentialStore,
    mode: 'reviewAndApply',
  });
  const budgets = await connector.connect(credentials);
  const budgetId = typeof config?.actualBudgetId === 'string'
    ? config.actualBudgetId
    : process.env.ACTUAL_BUDGET_ID ?? process.env.ACTUAL_GROUP_ID;
  if (!budgetId) throw new Error('No Actual budget configured.');
  const budget = budgets.find(item => item.id === budgetId || item.groupId === budgetId);
  if (!budget) throw new Error(`Actual budget "${budgetId}" was not found.`);
  await connector.selectBudget(budget.id || budget.groupId, credentials.budgetPassword);
  return connector;
}

export function createDefaultExecutorFactory(): ReviewMutationExecutorFactory {
  return (event: EventWithContext): ReviewMutationExecutor | null => {
    const config = event.context.runtimeConfig as Record<string, unknown> | undefined;
    if (!config?.reviewAndApply) return null;
    return async (input, _store, item) => {
      try {
        const ledger = await createLedger(event);
        const mutation = await ledger.setTransactionCategory(
          item.transactionId,
          input.categoryId ?? item.categoryId,
          item.categoryId,
        );
        const reread = await ledger.synchronize();
        const transaction = reread.snapshot.transactions.find(tx => tx.id === item.transactionId);
        const verified = transaction?.categoryId === (input.categoryId ?? item.categoryId);
        return {
          mutationStatus: verified && mutation.success ? 'verified' as MutationStatus : 'apply_failed' as MutationStatus,
          success: verified && mutation.success,
          applied: mutation.success,
          verified,
          stale: false,
          transactionId: item.transactionId,
          previousCategoryId: mutation.previousCategoryId ?? item.categoryId,
          newCategoryId: transaction?.categoryId ?? null,
          error: verified && mutation.success ? undefined : 'Actual reread did not verify the category.',
        };
      } catch (error) {
        return {
          mutationStatus: 'apply_failed' as MutationStatus,
          success: false,
          applied: false,
          verified: false,
          stale: false,
          transactionId: item.transactionId,
          previousCategoryId: item.categoryId,
          newCategoryId: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };
  };
}

export default defineNitroPlugin(() => {
  setReviewMutationExecutorFactory(createDefaultExecutorFactory());
  console.log('[mutation-composition] Actual mutation executor factory registered');
});

