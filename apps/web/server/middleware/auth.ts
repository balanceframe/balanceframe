/**
 * Authentication middleware for Nitro API routes.
 *
 * Uses Better Auth for session and credential validation, with a legacy
 * `BALANCEFRAME_API_TOKEN` fallback during migration.
 *
 * Auth resolution order:
 *   1. Better Auth session (cookie) — from authenticated browser session
 *   2. Better Auth API key (Bearer token)
 *   3. Legacy `BALANCEFRAME_API_TOKEN` env var (Bearer or cookie)
 *   4. Development bypass (`devBypassAuth` / `BALANCEFRAME_DEV_BYPASS_AUTH`)
 *
 * Health (`/api/health`) is always public.  Better Auth's own routes
 * (`/api/auth/*`) are handled by the catch-all handler and never reach
 * this middleware.
 *
 * On success, `event.context.auth` is set to `{ authenticated, actorId, user? }`.
 */

import {
  defineEventHandler,
  getCookie,
  getHeader,
  getRequestHeaders,
  getRequestPath,
  setHeader,
  setResponseStatus,
} from 'h3';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { auth } from '../../lib/auth';
import { authMigrationFailed, authMigrationMessage } from '../utils/auth-migration-status';
import type { EventWithContext } from '../utils/workflow-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// /api routes that do NOT require authentication — everything else is denied by default.
const PUBLIC_API_ALLOWLIST = ['/api/health', '/api/health/ready', '/api/auth'];

// Startup warning when dev bypass env var is active.
if (process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true') {
  console.warn(
    '[auth] WARNING: Development auth bypass is ACTIVE via BALANCEFRAME_DEV_BYPASS_AUTH. ' +
    'This should only be enabled in local development environments.',
  );
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unauthorized(message: string, reasonCode: string) {
  return {
    schemaVersion: '1',
    requestId: crypto.randomUUID(),
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: {
      code: 'UNAUTHORIZED',
      message,
      retryable: false,
      reasonCodes: [reasonCode],
    },
  };
}

function serviceUnavailable(message: string) {
  return {
    schemaVersion: '1',
    requestId: crypto.randomUUID(),
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message,
      retryable: true,
      reasonCodes: ['auth.not_configured'],
    },
  };
}

function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readConfig(event: EventWithContext): Record<string, unknown> {
  try {
    return useRuntimeConfig(event) as Record<string, unknown>;
  } catch {
    // Unit tests and non-Nitro callers may not provide runtime config.
    return event.context.runtimeConfig ?? {};
  }
}

function setAuthContext(
  event: EventWithContext,
  actorId: string,
  user?: Record<string, unknown>,
): void {
  const ctx: { authenticated: true; actorId: string; user?: Record<string, unknown> } = {
    authenticated: true,
    actorId,
  };
  if (user) ctx.user = user;
  event.context.auth = ctx;
}

function validateSessionToken(
  token: string,
  apiToken: string,
): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSignature] = parts as [string, string, string];
  const signingInput = `${encHeader}.${encPayload}`;

  const expectedSig = createHmac('sha256', apiToken)
    .update(signingInput)
    .digest('base64url');

  const sigBuf = Buffer.from(encSignature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const decoded = Buffer.from(encPayload, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    if (now >= exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event);

  // 1. Public allowlist — always pass through without auth.
  const isPublic = PUBLIC_API_ALLOWLIST.some((p) => path === p || path.startsWith(p + '/'));
  if (isPublic) return;

  // 2. Non-API routes pass through (Nuxt pages, static assets, etc.).
  if (!path.startsWith('/api/')) return;

  // 3. Auth migration check — if migrations failed, reject all API
  //    requests with 503 to prevent serving degraded auth state.
  if (authMigrationFailed) {
    setResponseStatus(event, 503);
    return serviceUnavailable(
      `Auth database migration failed: ${authMigrationMessage ?? 'unknown error'}. ` +
      'Server cannot accept authenticated requests until resolved.',
    );
  }

  // 3. Check environment configuration.
  const config = readConfig(event);
  const legacyToken =
    (config.apiToken as string) || process.env.BALANCEFRAME_API_TOKEN || '';

  // 4. Dev bypass (local development only).
  const nodeEnv = process.env.NODE_ENV;
  const bypassRequested =
    config.devBypassAuth === true ||
    process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true';

  if (bypassRequested) {
    // Never honor bypass in production — guard against misconfiguration.
    if (
      !nodeEnv ||
      (nodeEnv !== 'development' && nodeEnv !== 'test')
    ) {
      setResponseStatus(event, 503);
      return serviceUnavailable(
        'Dev bypass is not allowed in production. ' +
        'Set NODE_ENV=development or NODE_ENV=test for local development.',
      );
    }
    const actorId = (config.authActorId as string) || 'dev-bypass';
    setAuthContext(event, actorId);
    return;
  }

  // 5. Try Better Auth session.
  try {
    const rawHeaders = getRequestHeaders(event);
    const headers = new Headers();
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (value) headers.set(key, String(value));
    }
    const session = await auth.api.getSession({ headers });
    if (session?.user) {
      setAuthContext(event, session.user.id, session.user as Record<string, unknown>);
      return;
    }
  } catch {
    // Fall through to legacy auth.
  }

  // 6. Try Bearer token.
  const authHeader = getHeader(event, 'authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // 6a. Try Better Auth API key.
    try {
      const rawHeaders = getRequestHeaders(event);
      const headers = new Headers();
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (value) headers.set(key, String(value));
      }
      const result = await auth.api.verifyApiKey({ body: { key: token }, headers });
      if (result?.valid && result.user?.id) {
        setAuthContext(event, result.user.id, result.user as Record<string, unknown>);
        return;
      }
    } catch {
      // Fall through to legacy token check.
    }

    // 6b. Legacy token fallback.
    if (legacyToken && safeEqual(token, legacyToken)) {
      setAuthContext(event, (config.authActorId as string) || 'api-user');
      return;
    }
  }

  // 7. Try session cookie (legacy HMAC / plain match fallback).
  const sessionCookie = getCookie(event, 'balanceframe_session');
  if (sessionCookie && legacyToken) {
    if (safeEqual(sessionCookie, legacyToken)) {
      setAuthContext(event, (config.authActorId as string) || 'api-user');
      return;
    }
    const payload = validateSessionToken(sessionCookie, legacyToken);
    if (payload) {
      setAuthContext(
        event,
        (payload.actorId as string) || (config.authActorId as string) || 'api-user',
      );
      return;
    }
  }

  // 8. No token or session configured — fail closed.
  if (!legacyToken) {
    setResponseStatus(event, 503);
    return serviceUnavailable(
      'API token not configured. Set apiToken (NUXT_API_TOKEN) or ' +
        'BALANCEFRAME_API_TOKEN, or enable devBypassAuth for local development.',
    );
  }

  // 9. Denied — valid token was configured but none provided.
  setHeader(event, 'WWW-Authenticate', 'Bearer');
  setResponseStatus(event, 401);
  return unauthorized('Authentication required', 'auth.missing_credentials');
});
