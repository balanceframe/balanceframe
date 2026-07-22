import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  persistPendingReviewResult,
} from '@balanceframe/application';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

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
    const persisted = await persistPendingReviewResult(
      workflow.store,
      connected.budget.id || connected.budget.groupId,
      result,
    );
    // Transition all discovered items to pending_review so they appear
    // in the actionable review queue. Items remain discovered only when
    // they already exist with a newer version (idempotent dedup).
    const discovered = await workflow.store.listReviewItems({ status: 'discovered' });
    let transitioned = 0;
    for (const item of discovered) {
      try {
        await workflow.store.transitionReviewItem(item.id, {
          toStatus: 'pending_review',
          actor: 'system',
          reason: 'Auto-transition from sync: deterministic analysis complete',
          expectedVersion: item.version,
        });
        transitioned += 1;
      } catch {
        // skip items that can't transition (e.g. version conflict with
        // concurrent workflow)
      }
    }
    return okEnvelope(
      { synchronized: true, persisted, result },
      auth,
      requestId,
    );
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
