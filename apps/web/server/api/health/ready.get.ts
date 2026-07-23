/**
 * Readiness check endpoint.
 *
 * Returns ok only when all dependencies are healthy — auth DB, migration
 * status, authentication config, and workflow store. Returns 503 when
 * the service is alive but not ready to serve requests.
 *
 * Always public — matched by the auth middleware allowlist.
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { resolveAuthDbPath } from '../../../lib/auth-db-path';
import {
  authMigrationFailed,
  authMigrationMessage,
} from '../../utils/auth-migration-status';
import { getWorkflowStore } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const ctx = event as {
    context: { runtimeConfig?: Record<string, unknown> };
  };
  const config = ctx.context.runtimeConfig ?? {};
  const environment = process.env.NODE_ENV || 'production';

  // 1. Auth DB path resolvable
  const authDbPath = resolveAuthDbPath();
  const authDbOk = authDbPath.length > 0;

  // 2. Auth migration passed (startup schema migration)
  const migrationOk = !authMigrationFailed;
  const migrationDetail = migrationOk
    ? 'ok'
    : `failed: ${authMigrationMessage ?? 'unknown error'}`;

  // 3. Auth configured — apiToken or dev bypass
  const apiTokenOk = !!(config.apiToken || process.env.BALANCEFRAME_API_TOKEN);
  const bypassRequested =
    config.devBypassAuth === true ||
    process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true';
  const devBypassActive =
    bypassRequested &&
    (environment === 'development' || environment === 'test');
  const authConfigured = apiTokenOk || devBypassActive;

  // 4. Workflow DB path configured
  const workflowDbPath =
    (config.workflowDbPath as string) ||
    process.env.BALANCEFRAME_WORKFLOW_DB_PATH ||
    './data/workflow.db';
  const workflowDbOk = workflowDbPath.length > 0;

  // 5. Workflow store accessible (real probe — tries to open if not yet
  //    initialised, reports existing error if it previously failed).
  const storeResult = getWorkflowStore(
    event as { context: Record<string, unknown> },
  );
  const workflowStoreOk = !('error' in storeResult);

  const checks = {
    authDb: authDbOk ? 'ok' : 'missing',
    authMigration: migrationDetail,
    authConfigured: authConfigured
      ? 'ok'
      : apiTokenOk
        ? 'ok'
        : devBypassActive
          ? 'bypass'
          : 'missing',
    workflowDb: workflowDbOk ? 'ok' : 'missing',
    workflowStore: workflowStoreOk ? 'ok' : 'unavailable',
  };

  const ready =
    authDbOk && migrationOk && authConfigured && workflowDbOk && workflowStoreOk;

  if (!ready) {
    setResponseStatus(event, 503);
  }

  return {
    status: ready ? 'ok' : 'degraded',
    checks,
  };
});
