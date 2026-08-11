import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { createDefaultConnectionManager } from '@balanceframe/application';
import { getReviewCategoryCatalog } from '../../utils/review-category-catalog';
import {
  requireAuthorization,
  errorEnvelope,
  okEnvelope,
  sanitizeError,
} from '../../utils/workflow-store';

/** Return whether an unknown failure carries the requested application error code. */
function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** List all current categories from the selected Actual budget for review correction. */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const authCheck = await requireAuthorization(event, 'observe');
  if (!authCheck.ok) return authCheck.response;
  const auth = authCheck.info;
  const requestId = crypto.randomUUID();

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config) {
      setResponseStatus(event, 503);
      return errorEnvelope(
        'not_connected',
        'No ledger connected. Configure an Actual budget first.',
        auth,
        true,
        requestId,
      );
    }

    const categories = await getReviewCategoryCatalog(config, () =>
      manager.withConnection(async (connected) => ({
        config: connected.config,
        synchronization: connected.synchronization,
      })),
    );
    return okEnvelope({ categories }, auth, requestId);
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

    const safe = sanitizeError(error, requestId, 'REVIEW_CATEGORIES_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, auth, safe.retryable, requestId);
  }
});
