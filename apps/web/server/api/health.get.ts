/**
 * Health check endpoint.
 *
 * Returns server status, version, and effective operating mode based on
 * the actual runtime configuration rather than a hardcoded value.
 *
 * Readiness reflects:
 *  - Runtime config availability
 *  - Auth DB path resolution
 *  - Workflow store status
 *  - reviewAndApply mode flag
 *
 * Always public — matched by the auth middleware allowlist.
 */

import { resolveAuthDbPath } from '../../lib/auth-db-path';

export default defineEventHandler(async (event) => {
  const ctx = (event as unknown) as { context: { runtimeConfig: Record<string, unknown> } };
  const config = ctx.context.runtimeConfig;

  // Determine effective operating mode from runtime config
  const reviewAndApplyEnabled = config?.reviewAndApply === true;
  const effectiveMode = reviewAndApplyEnabled ? 'reviewAndApply' : 'observe';

  // Readiness: auth DB path resolvable
  const authDbPath = resolveAuthDbPath();
  const authDbConfigured = authDbPath.length > 0;

  // Readiness: apiToken or dev bypass configured
  const apiTokenConfigured = !!(config?.apiToken || process.env.BALANCEFRAME_API_TOKEN);
  const devBypassActive = config?.devBypassAuth === true ||
    process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true';
  const authConfigured = apiTokenConfigured || devBypassActive;

  // Readiness: workflow DB path configured
  const workflowDbPath = (config?.workflowDbPath as string) ||
    process.env.BALANCEFRAME_WORKFLOW_DB_PATH ||
    './data/workflow.db';
  const workflowDbConfigured = workflowDbPath.length > 0;

  // Overall readiness — all core dependencies must be satisfiable
  const ready = authDbConfigured && authConfigured && workflowDbConfigured;

  return {
    status: ready ? 'ok' : 'degraded',
    version: '0.1.0',
    mode: effectiveMode,
    reviewAndApplyEnabled,
    ready,
    checks: {
      authDb: authDbConfigured ? 'ok' : 'missing',
      apiToken: apiTokenConfigured ? 'ok' : (devBypassActive ? 'bypass' : 'missing'),
      workflowDb: workflowDbConfigured ? 'ok' : 'missing',
    },
  };
});
