/**
 * Liveness check endpoint.
 *
 * Returns basic process info (always ok). Use /api/health/ready for
 * real readiness (DB, migration, config).
 *
 * Always public — matched by the auth middleware allowlist.
 */

import { defineEventHandler } from 'h3';

export default defineEventHandler(async () => ({
  status: 'ok',
  version: '0.1.0',
}));
