import { defineEventHandler, setResponseStatus } from 'h3';
import { createDefaultConnectionManager } from '@balanceframe/application';
import {
  requireAuthorization,
  errorEnvelope,
  okEnvelope,
  sanitizeError,
} from '../../utils/workflow-store';

interface ReviewCategory {
  readonly id: string;
  readonly name: string;
  readonly groupName: string | null;
  readonly isIncome: boolean;
}

/** Return whether an unknown failure carries the requested application error code. */
function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Extract current, selectable categories from an Actual synchronization result. */
function categoriesFromSynchronization(synchronization: unknown): ReviewCategory[] {
  if (typeof synchronization !== 'object' || synchronization === null) return [];
  const snapshot = (synchronization as Record<string, unknown>).snapshot;
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const rawCategories = (snapshot as Record<string, unknown>).categories;
  if (!Array.isArray(rawCategories)) return [];

  const categories = new Map<string, ReviewCategory>();
  for (const value of rawCategories) {
    if (typeof value !== 'object' || value === null) continue;
    const category = value as Record<string, unknown>;
    if (category.deleted === true) continue;
    if (typeof category.id !== 'string' || category.id.length === 0) continue;
    if (typeof category.name !== 'string' || category.name.length === 0) continue;

    categories.set(category.id, {
      id: category.id,
      name: category.name,
      groupName:
        typeof category.groupName === 'string' && category.groupName.length > 0
          ? category.groupName
          : null,
      isIncome: category.isIncome === true,
    });
  }

  return [...categories.values()].sort(
    (left, right) =>
      (left.groupName ?? '').localeCompare(right.groupName ?? '') ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

/** List all current categories from the selected Actual budget for review correction. */
export default defineEventHandler(async (event) => {
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

    const categories = await manager.withConnection(async (connected) =>
      categoriesFromSynchronization(connected.synchronization),
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
