import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  persistPendingReviewResult,
  createLiquidityService,
} from '@balanceframe/application';
import type { PendingReviewScope } from '@balanceframe/application';
import { getHumanControlAuth, hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  sanitizeError,
} from '../../utils/workflow-store';
import { updateReviewCategoryCatalog } from '../../utils/review-category-catalog';
import type { EventWithContext } from '../../utils/workflow-store';
import { requireFullRead } from '../../utils/legacy-financial-read';

/** Structured sync result with per-item outcome counts. */
export interface SyncReviewResult {
  readonly synchronized: true;
  /** Number of new deterministic review candidates persisted. */
  readonly created: number;
  /** Transitions: successfully moved from discovered to pending_review. */
  readonly transitioned: number;
  /** Items that were skipped (e.g. version conflict, already pending). */
  readonly skipped: number;
  /** Items that failed to transition with reason codes. */
  readonly failed: number;
  /** Per-failure reason codes. */
  readonly reasons: Record<string, number>;
  readonly result: unknown;
}

/** Return whether an unknown failure carries the requested application error code. */
function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Synchronize the configured Actual budget and persist deterministic review candidates. */
export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Review synchronization is unavailable.', null, false, requestId);
  }
  const access = await requireFullRead(event as unknown as EventWithContext);
  if (!access.ok) return access.response;
  const auth = access.info;
  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== access.budgetId) {
      setResponseStatus(event, 503);
      return errorEnvelope(
        'not_connected',
        'No ledger connected. Configure an Actual budget first.',
        auth,
        true,
        requestId,
      );
    }
    const workflow = getWorkflowStore(event);
    if ('error' in workflow) {
      setResponseStatus(event, 503);
      return errorEnvelope('STORE_UNAVAILABLE', 'Financial data is unavailable.', auth, false, requestId);
    }
    const { result, created } = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== access.budgetId || connected.budget.id !== access.budgetId)
        throw new Error('Selected budget changed');
      updateReviewCategoryCatalog(connected.config, connected.synchronization);
      const protocol = await createNativeAnalysisProtocol();
      const scope: PendingReviewScope = {
        store: workflow.store,
        scope: { spaceId: access.spaceId, budgetId: access.budgetId },
      };
      const synchronization = z.object({ snapshot: z.unknown() }).parse(connected.synchronization);
      const snapshot = canonicalProtocolSnapshotSchema.parse(synchronization.snapshot);
      const result = await protocol.pendingReview(snapshot, null, scope);
      const created = await persistPendingReviewResult(workflow.store, access.budgetId, result, snapshot);
      return { result, created };
    }, { expectedBudgetId: access.budgetId });
    const actorAuth = access.actor.auth;
    if (actorAuth?.method === 'session') {
      const humanAuth = await getHumanControlAuth(event as ReauthenticationEvent);
      if (
        humanAuth &&
        humanAuth.actorId === access.actor.actorId &&
        humanAuth.sessionId === actorAuth.sessionId
      ) {
        const liquidity = await createLiquidityService({
          connectionManager: manager,
          store: workflow.store,
        });
        await liquidity.reconcileActive({ ...access.actor, auth: humanAuth });
      }
    }

    // Transition all discovered items to pending_review with structured reporting.
    const discovered = await workflow.store.listReviewItems({ budgetId: access.budgetId, status: 'discovered' });
    let transitioned = 0;
    let skipped = 0;
    let failed = 0;
    const reasons: Record<string, number> = {};

    for (const item of discovered) {
      try {
        await workflow.store.transitionInternalReviewItem(item.id, {
          toStatus: 'pending_review',
          actor: 'system',
          reason: 'Auto-transition from sync: deterministic analysis complete',
          expectedVersion: item.version,
        });
        transitioned += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('version conflict') || message.includes('expected version')) {
          skipped += 1;
          reasons['version_conflict'] = (reasons['version_conflict'] ?? 0) + 1;
        } else if (message.includes('not allowed') || message.includes('invalid transition')) {
          skipped += 1;
          reasons['invalid_transition'] = (reasons['invalid_transition'] ?? 0) + 1;
        } else {
          failed += 1;
          reasons['unknown'] = (reasons['unknown'] ?? 0) + 1;
        }
      }
    }

    const syncResult: SyncReviewResult = {
      synchronized: true,
      created,
      transitioned,
      skipped,
      failed,
      reasons: Object.keys(reasons).length > 0 ? reasons : { none: 0 },
      result,
    };

    return okEnvelope(syncResult, auth, requestId);
  } catch (error) {
    if (errorHasCode(error, 'not_connected')) {
      setResponseStatus(event, 503);
      return errorEnvelope(
        'not_connected',
        'No ledger connected. Configure an Actual budget first.',
        auth,
        true,
        requestId,
      );
    }
    const safe = sanitizeError(error, requestId, 'SYNC_REVIEW_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, auth, safe.retryable, requestId);
  }
});
