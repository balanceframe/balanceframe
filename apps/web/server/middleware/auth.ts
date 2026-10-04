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
import { fromNodeHeaders } from 'better-auth/node';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { auth } from '../../lib/auth';
import { enforceDemoBoundary } from '../utils/demo-boundary';
import { authMigrationFailed, authMigrationMessage } from '../utils/auth-migration-status';
import type { TrustedAuthContext } from '../utils/reauthentication';
import { getWorkflowStore } from '../utils/workflow-store';
import type { EventWithContext } from '../utils/workflow-store';

interface ResolvedCredentialPrincipal {
  principalType: 'human' | 'agent';
  actorId: string;
  credentialId: string;
  credentialOwnerId: string;
  delegationId?: string;
  delegationVersion?: string;
}

interface CredentialPrincipalAuthority {
  resolveCredentialPrincipal(input: {
    credentialId: string;
    referenceId: string;
    now: string;
  }): ResolvedCredentialPrincipal | null | Promise<ResolvedCredentialPrincipal | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// /api routes that do NOT require authentication — everything else is denied by default.
const PUBLIC_API_ALLOWLIST = [
  '/api/health',
  '/api/health/ready',
  '/api/auth',
  '/api/registration/bootstrap',
  '/api/invitations/redeem',
];

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
  context: Omit<TrustedAuthContext, 'authenticated'>,
): void {
  const canonicalActorId =
    typeof context.user?.id === 'string' && context.user.id.length > 0
      ? context.user.id
      : context.actorId;
  const authContext: TrustedAuthContext = {
    ...context,
    authenticated: true,
    actorId: canonicalActorId,
  };
  event.context.auth = authContext;
}

function validateSessionToken(token: string, apiToken: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSignature] = parts as [string, string, string];
  const signingInput = `${encHeader}.${encPayload}`;

  const expectedSig = createHmac('sha256', apiToken).update(signingInput).digest('base64url');

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
  const demoBoundaryResponse = enforceDemoBoundary(event as unknown as EventWithContext);
  if (demoBoundaryResponse) return demoBoundaryResponse;
  const path = getRequestPath(event);
  // Keep auth lifecycle routes reachable while attributing existing sessions for handler guards.
  const isAuthPath = path === '/api/auth' || path.startsWith('/api/auth/');
  const isPublic = PUBLIC_API_ALLOWLIST.some((p) => path === p || path.startsWith(p + '/'));
  if (isPublic && !isAuthPath) return;

  // 2. Non-API routes pass through (Nuxt pages, static assets, etc.).
  if (!path.startsWith('/api/')) return;
  delete event.context.auth;

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
  const legacyToken = (config.apiToken as string) || process.env.BALANCEFRAME_API_TOKEN || '';

  // An explicit credential never falls back to a different cookie principal.
  const authHeader = getHeader(event, 'authorization');
  if (authHeader !== undefined) {
    const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authHeader);
    if (!bearer) {
      setHeader(event, 'WWW-Authenticate', 'Bearer');
      setResponseStatus(event, 401);
      return unauthorized('Authentication required', 'auth.missing_credentials');
    }
    const token = bearer[1]!;
    let verifiedKey: { id: string; referenceId: string } | null = null;
    try {
      const headers = fromNodeHeaders(getRequestHeaders(event));
      const result = await auth.api.verifyApiKey({ body: { key: token }, headers });
      const key = result?.key;
      if (
        result?.valid &&
        typeof key?.id === 'string' &&
        key.id.length > 0 &&
        typeof key.referenceId === 'string' &&
        key.referenceId.length > 0
      ) {
        verifiedKey = { id: key.id, referenceId: key.referenceId };
      }
    } catch {
      // An invalid explicit key must not fall through to a session cookie.
    }

    if (verifiedKey) {
      const workflow = getWorkflowStore(event);
      if ('error' in workflow) {
        setResponseStatus(event, 503);
        return serviceUnavailable('Authentication authority is unavailable.');
      }
      // Core owns the binding; a missing resolver must never infer a human from the key owner.
      const governanceStore = workflow.store as unknown as {
        governance?: CredentialPrincipalAuthority;
      };
      const authority = governanceStore.governance;
      if (typeof authority?.resolveCredentialPrincipal !== 'function') {
        setResponseStatus(event, 503);
        return serviceUnavailable('Authentication authority is unavailable.');
      }

      let principal: ResolvedCredentialPrincipal | null;
      try {
        principal = await authority.resolveCredentialPrincipal({
          credentialId: verifiedKey.id,
          referenceId: verifiedKey.referenceId,
          now: new Date().toISOString(),
        });
      } catch {
        setResponseStatus(event, 503);
        return serviceUnavailable('Authentication authority is unavailable.');
      }
      if (
        !principal ||
        principal.credentialId !== verifiedKey.id ||
        principal.credentialOwnerId !== verifiedKey.referenceId ||
        typeof principal.actorId !== 'string' ||
        principal.actorId.length === 0 ||
        (principal.principalType !== 'human' && principal.principalType !== 'agent') ||
        (principal.principalType === 'human' && principal.actorId !== verifiedKey.referenceId) ||
        (principal.principalType === 'agent' &&
          (typeof principal.delegationId !== 'string' ||
            principal.delegationId.length === 0 ||
            typeof principal.delegationVersion !== 'string' ||
            principal.delegationVersion.length === 0))
      ) {
        setHeader(event, 'WWW-Authenticate', 'Bearer');
        setResponseStatus(event, 401);
        return unauthorized('Authentication required', 'auth.invalid_credentials');
      }
      setAuthContext(event, {
        actorId: principal.actorId,
        credentialId: principal.credentialId,
        credentialOwnerId: principal.credentialOwnerId,
        delegationId: principal.delegationId,
        delegationVersion: principal.delegationVersion,
        method: 'api-key',
        principalType: principal.principalType,
      });
      return;
    }

    if (legacyToken && safeEqual(token, legacyToken)) {
      setAuthContext(event, {
        actorId: (config.authActorId as string) || 'api-user',
        method: 'legacy-token',
        principalType: 'human',
      });
      return;
    }
    if (!legacyToken) {
      setResponseStatus(event, 503);
      return serviceUnavailable(
        'API token not configured. Set apiToken (NUXT_API_TOKEN) or ' +
          'BALANCEFRAME_API_TOKEN, or enable devBypassAuth for local development.',
      );
    }
    setHeader(event, 'WWW-Authenticate', 'Bearer');
    setResponseStatus(event, 401);
    return unauthorized('Authentication required', 'auth.missing_credentials');
  }

  // 5. Dev bypass (local development only).
  const nodeEnv = process.env.NODE_ENV;
  const bypassRequested =
    config.devBypassAuth === true || process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true';

  if (bypassRequested) {
    if (!nodeEnv || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
      setResponseStatus(event, 503);
      return serviceUnavailable(
        'Dev bypass is not allowed in production. ' +
          'Set NODE_ENV=development or NODE_ENV=test for local development.',
      );
    }
    const actorId = (config.authActorId as string) || 'dev-bypass';
    setAuthContext(event, { actorId, method: 'development', principalType: 'human' });
    return;
  }

  // 6. Try the authoritative Better Auth session.
  try {
    const headers = fromNodeHeaders(getRequestHeaders(event));
    const session = await auth.api.getSession({ headers });
    if (session?.user) {
      const actorId = session.user.id;
      const sessionId = session.session?.id;
      if (
        typeof actorId === 'string' &&
        actorId.length > 0 &&
        typeof sessionId === 'string' &&
        sessionId.length > 0 &&
        session.session?.userId === actorId
      ) {
        const impersonatedBy =
          typeof session.session.impersonatedBy === 'string'
            ? session.session.impersonatedBy
            : null;
        setAuthContext(event, {
          actorId,
          user: session.user as Record<string, unknown>,
          method: 'session',
          sessionId,
          principalType: 'human',
          impersonatedBy,
        });
        if (impersonatedBy && !isAuthPath) {
          setResponseStatus(event, 403);
          return unauthorized(
            'Impersonated sessions cannot access governed resources',
            'auth.impersonation_forbidden',
          );
        }
        return;
      }
    }
  } catch {
    // Fall through to legacy auth.
  }

  // 7. Try the legacy session cookie only when no explicit Bearer was supplied.
  const sessionCookie = getCookie(event, 'balanceframe_session');
  if (sessionCookie && legacyToken) {
    if (safeEqual(sessionCookie, legacyToken)) {
      setAuthContext(event, {
        actorId: (config.authActorId as string) || 'api-user',
        method: 'legacy-token',
        principalType: 'human',
      });
      return;
    }
    const payload = validateSessionToken(sessionCookie, legacyToken);
    if (payload) {
      setAuthContext(event, {
        actorId: (payload.actorId as string) || (config.authActorId as string) || 'api-user',
        method: 'legacy-token',
        principalType: 'human',
      });
      return;
    }
  }

  if (isAuthPath) return;

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
