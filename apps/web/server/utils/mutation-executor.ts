/**
 * Mutation executor factory — uses ConnectionManager.restore() to load the
 * persisted selected budget and synchronize it before applying a mutation.
 *
 * This module contains only pure functions and types; the Nitro plugin
 * registration lives in server/plugins/mutation-composition.ts.
 */

import { ConnectionManager } from '@balanceframe/application';
import { ActualConnector, createDefaultActualClient, EnvCredentialStore } from '@balanceframe/actual-adapter';
import type {
  EventWithContext,
  ReviewMutationExecutor,
  ReviewMutationExecutorFactory,
  MutationStatus,
} from './workflow-store';
import type { ReviewItem } from '@balanceframe/workflow-store';

// ---------------------------------------------------------------------------
// Production helpers
// ---------------------------------------------------------------------------

/** Create a production ConnectionManager configured for mutation (reviewAndApply) mode. */
export function createMutationConnectionManager(
  options?: { configPath?: string },
): ConnectionManager {
  return new ConnectionManager({
    configPath: options?.configPath,
    credentialStore: new EnvCredentialStore(),
    connectorFactory: async () => new ActualConnector({
      client: await createDefaultActualClient(),
      credentialStore: new EnvCredentialStore(),
      mode: 'reviewAndApply',
    }),
  });
}

/**
 * Extract the original Actual category from classifier evidence.
 *
 * When a reviewer corrects a suggestion, the workflow item's categoryId is
 * updated to the corrected category.  The mutation precondition must
 * reference the original Actual category (evidence.currentCategory) so the
 * Actual API can verify the transaction is still in the expected category
 * before applying.  Falls back to null (no precondition check) when
 * evidence does not carry currentCategory.
 */
function originalCategory(item: ReviewItem): string | null {
  const ev = item.evidence as Record<string, unknown> | undefined;
  // Prefer evidence.currentCategory when present and non-empty
  if (ev && typeof ev.currentCategory === 'string' && ev.currentCategory) {
    return ev.currentCategory as string;
  }
  // Fall back to item.categoryId so the precondition check uses the
  // item's current category even when evidence doesn't carry currentCategory.
  // Map empty/null categoryId to null (no precondition check).
  return item.categoryId || null;
}

/**
 * Create a default executor factory.
 *
 * Accepts an optional ConnectionManager for test injection. When omitted
 * (production), creates a default connection manager using environment
 * credentials in reviewAndApply mode.
 *
 * The factory returns null in Observe mode (no reviewAndApply config).
 * In reviewAndApply mode, each executor call restores via ConnectionManager,
 * applies the category mutation, and re-reads for verification.
 */
export function createDefaultExecutorFactory(
  connectionManager?: ConnectionManager,
): ReviewMutationExecutorFactory {
  // The web production composition must inject CategorizationMutationService;
  // never fall back to a parallel direct ledger mutation implementation.
  if (!connectionManager) {
    return () => null;
  }
  const manager = connectionManager ?? createMutationConnectionManager();

  return (event: EventWithContext): ReviewMutationExecutor | null => {
    const config = event.context.runtimeConfig as Record<string, unknown> | undefined;
    if (!config?.reviewAndApply) return null;

    return async (input, _store, item) => {
      try {
        const { connector } = await manager.restore();
        // The connector from restore is an ActualConnector at runtime.
        // Cast via unknown to avoid leaking BudgetLedger details into the
        // ConnectionManager interface, while keeping the mutation call typed.
        const ledger = connector as unknown as {
          setTransactionCategory: (
            transactionId: string,
            proposedCategoryId: string,
            currentCategoryId: string | null,
          ) => Promise<{ success: boolean; previousCategoryId?: string | null }>;
          synchronize: () => Promise<{
            snapshot: { transactions: Array<{ id: string; categoryId?: string | null }> };
          }>;
        };

        const mutation = await ledger.setTransactionCategory(
          item.transactionId,
          input.categoryId ?? item.categoryId,
          originalCategory(item),
        );

        const reread = await ledger.synchronize();
        const transaction = reread.snapshot.transactions.find(
          tx => tx.id === item.transactionId,
        );
        const verified =
          transaction?.categoryId === (input.categoryId ?? item.categoryId);

        return {
          mutationStatus: (verified && mutation.success
            ? 'verified'
            : 'apply_failed') as MutationStatus,
          success: verified && mutation.success,
          applied: mutation.success,
          verified,
          stale: false,
          transactionId: item.transactionId,
          previousCategoryId: mutation.previousCategoryId ?? item.categoryId,
          newCategoryId: transaction?.categoryId ?? null,
          error:
            verified && mutation.success
              ? null
              : 'Actual reread did not verify the category.',
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
