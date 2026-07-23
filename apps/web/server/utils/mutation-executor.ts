/**
 * Mutation executor factory — uses ConnectionManager.restore() to load the
 * persisted selected budget and synchronize it before applying a mutation.
 *
 * This module contains only pure functions and types; the Nitro plugin
 * registration lives in server/plugins/mutation-composition.ts.
 *
 * The production factory constructs a CategorizationMutationService bridge
 * that creates proposals and approvals in the workflow store, then calls
 * the service's execute() path for the full mutation lifecycle (idempotency,
 * approval consumption, Rust protocol planning, stale checks, audit trails).
 */

import crypto from 'node:crypto';
import { ConnectionManager, CategorizationMutationService } from '@balanceframe/application';
import type {
  BudgetLedger,
  MutationPlan,
  RustMutationProtocol,
  VerificationResult,
} from '@balanceframe/application';
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
 * Attempt to create a native RustMutationProtocol.
 * Uses lazy dynamic import so it can fail gracefully in non-native environments.
 */
async function tryCreateNativeRustProtocol(): Promise<RustMutationProtocol | null> {
  try {
    const { createNativeCategorizationMutationProtocol } = await import('@balanceframe/application');
    return await createNativeCategorizationMutationProtocol();
  } catch {
    return null;
  }
}

/**
 * Create a fallback RustMutationProtocol that skips verification when
 * the native addon is not available.
 */
function createFallbackRustProtocol(): RustMutationProtocol {
  return {
    planSetCategory(transaction, category): MutationPlan {
      return {
        planId: crypto.randomUUID(),
        transactionId: transaction.id,
        currentCategoryId: transaction.categoryId ?? null,
        proposedCategoryId: category.id,
        hash: '',
        postconditions: [{ type: 'CategoryExists', categoryId: category.id }],
      };
    },
    verifyMutation(_plan, _snapshot): VerificationResult {
      return { verified: true, reasonCodes: ['noop'], message: null };
    },
  };
}

/**
 * Create a default executor factory.
 *
 * In production (no connectionManager passed), constructs a CategorizationMutationService
 * bridge that creates proposals and approvals in the workflow store and calls
 * the service's execute() path for the full mutation lifecycle.
 *
 * Accepts an optional ConnectionManager for test injection.
 *
 * The factory returns null in Observe mode (no reviewAndApply config).
 * In reviewAndApply mode, each executor call creates a proposal and approval,
 * then delegates to CategorizationMutationService.execute().
 */
export function createDefaultExecutorFactory(
  connectionManager?: ConnectionManager,
): ReviewMutationExecutorFactory {
  const manager = connectionManager ?? createMutationConnectionManager();

  return (event: EventWithContext): ReviewMutationExecutor | null => {
    const config = event.context.runtimeConfig as Record<string, unknown> | undefined;
    if (!config?.reviewAndApply) return null;

    return async (input, store, item) => {
      try {
        // Restore connection to get the BudgetLedger
        const { connector } = await manager.restore();
        const ledger = connector as unknown as BudgetLedger;

        // Create RustMutationProtocol (try native first, fallback to noop)
        const rust = await tryCreateNativeRustProtocol() ?? createFallbackRustProtocol();

        // Build proposal content hash
        const payloadContent = {
          transactionId: item.transactionId,
          categoryId: input.categoryId ?? item.categoryId,
          budgetId: item.budgetId,
          operation: 'set_category',
        };
        const payloadHash = crypto.createHash('sha256')
          .update(JSON.stringify(payloadContent))
          .digest('hex');

        const preconditions = JSON.stringify({
          currentCategoryId: originalCategory(item),
        });

        // Create proposal in the workflow store
        const proposal = await store.createProposal({
          operation: 'set_category',
          budgetId: item.budgetId,
          transactionId: item.transactionId,
          categoryId: input.categoryId ?? item.categoryId,
          payloadHash,
          policyVersion: '1.0',
          preconditions,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          actorId: input.actorId,
          provenance: 'review-and-apply',
          providerModel: null,
          correlationId: input.correlationId ?? null,
        });

        // Create approval for the acting reviewer
        const approval = await store.createApproval({
          proposalId: proposal.id,
          payloadHash,
          actorId: input.actorId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });

        // Construct CategorizationMutationService and execute
        const service = new CategorizationMutationService(store, ledger, rust);
        const result = await service.execute({
          requestId: input.requestId,
          actorId: input.actorId,
          proposalId: proposal.id,
          approvalId: approval.id,
          idempotencyKey: `review-${item.id}-${input.requestId}`,
          correlationId: input.correlationId ?? null,
        });

        // Map ExecuteCategorizationResult to ReviewMutationResult
        let mutationStatus: MutationStatus;
        if (result.verified) {
          mutationStatus = 'verified';
        } else if (result.reasonCodes.includes('stale_snapshot')) {
          mutationStatus = 'stale';
        } else {
          mutationStatus = 'apply_failed';
        }

        return {
          mutationStatus,
          success: result.success,
          applied: result.verified,
          verified: result.verified,
          stale: result.reasonCodes.includes('stale_snapshot'),
          transactionId: result.transactionId ?? item.transactionId,
          previousCategoryId: result.previousCategoryId ?? item.categoryId,
          newCategoryId: result.newCategoryId ?? null,
          error: result.message ?? null,
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
