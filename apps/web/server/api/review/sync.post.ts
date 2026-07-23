import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  persistPendingReviewResult,
} from '@balanceframe/application';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

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

/** Synchronize the configured Actual budget and persist deterministic review candidates. */
export default defineEventHandler(async event => {
  const auth = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const workflow = getWorkflowStore(event);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, auth, false, requestId);
  }
  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const connected = await manager.restore();
    const protocol = await createNativeAnalysisProtocol();
    const result = await protocol.pendingReview(connected.connector, null);
    const created = await persistPendingReviewResult(
      workflow.store,
      connected.budget.id || connected.budget.groupId,
      result,
    );

    // Transition all discovered items to pending_review with structured reporting.
    const discovered = await workflow.store.listReviewItems({ status: 'discovered' });
    let transitioned = 0;
    let skipped = 0;
    let failed = 0;
    const reasons: Record<string, number> = {};

    for (const item of discovered) {
      try {
        await workflow.store.transitionReviewItem(item.id, {
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
    setResponseStatus(event, 500);
    return errorEnvelope(
      'SYNC_REVIEW_FAILED',
      error instanceof Error ? error.message : String(error),
      auth,
      true,
      requestId,
    );
  }
});
