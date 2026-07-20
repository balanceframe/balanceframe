/**
 * Authentication middleware for Nitro API routes.
 *
 * Secures operational API prefixes (`/api/review`, `/api/proposal`) by
 * requiring one of:
 *
 *   a) A Bearer token matching the configured apiToken (for external
 *      tools and CLI usage).
 *   b) An HttpOnly `balanceframe_session` cookie whose value is an
 *      HMAC-signed session token or a direct match to the configured
 *      apiToken (for same-origin browser requests).
 *
 * Health (`/api/health`) is always public.  Non-operational paths
 * (browser assets, Nuxt SSR, etc.) pass through.
 *
 * When no apiToken is configured the middleware returns 503 with a
 * non-retryable error.  A `devBypassAuth` runtime config flag can
 * disable authentication for local development without a token.
 *
 * Actor identity is derived from the `authActorId` runtime config
 * value, defaulting to `"api-user"`.  There is NO public endpoint that
 * mints bearer credentials — the session cookie must be provisioned by
 * external auth infrastructure (reverse proxy, login service, etc.).
 */

import {
  defineEventHandler,
  getCookie,
  getHeader,
  getRequestPath,
  setHeader,
  setResponseStatus,
} from 'h3';
import { EventWithContext } from '../utils/workflow-store';
import { timingSafeEqual, createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** URL path prefixes that require authentication. */
const OPERATIONAL_API_PREFIXES = ['/api/review', '/api/proposal'];

/** Path that health is served at — always public. */
const HEALTH_PATH = '/api/health';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the 401 error envelope.
 * Also sets the WWW-Authenticate challenge header.
 */
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

/**
 * Build the 503 error envelope (fail-closed response).
 */
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

/**
 * Constant-time string comparison.
 *
 * Uses Node.js `crypto.timingSafeEqual` after a fast length check.
 * The length check is not constant-time but for API tokens of known
 * format this leak is acceptable.
 */
function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the effective runtime config from the event context.
 *
 * In Nitro this is equivalent to `useRuntimeConfig(event)` — the
 * Nitro server pops `event.context.runtimeConfig` from config +
 * environment variables.
 */
function readConfig(event: EventWithContext): Record<string, unknown> {
  return event.context.runtimeConfig ?? {};
}

/**
 * Validate an HMAC-signed session token.
 *
 * Format: `base64url(header).base64url(payload).base64url(signature)`
 * The signature is HMAC-SHA256 over `header.payload` using apiToken as the key.
 *
 * The payload carries `iat` (issued-at) and `exp` (absolute expiry) values.
 * Returns the decoded payload on success, or `null` when the token is
 * malformed, expired, or has a forged signature.
 *
 * The session token is NOT obtainable from any public endpoint — it must be
 * provisioned externally (e.g. as an HttpOnly `balanceframe_session` cookie
 * set by auth infrastructure that shares the apiToken secret).
 */
function validateSessionToken(
  token: string,
  apiToken: string,
): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSignature] = parts as [string, string, string];
  const signingInput = `${encHeader}.${encPayload}`;

  // Recompute and verify the HMAC signature.
  const expectedSig = createHmac('sha256', apiToken)
    .update(signingInput)
    .digest('base64url');

  const sigBuf = Buffer.from(encSignature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  // Parse the payload and check expiration.
  let payload: Record<string, unknown>;
  try {
    const decoded = Buffer.from(encPayload, 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (now >= exp) return null;

  return payload;
}
// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event);

  // 1. Health endpoint — always public.
  if (path === HEALTH_PATH) return;

  // 2. Non-operational routes (browser, static, etc.) — public.
  const isOperational = OPERATIONAL_API_PREFIXES.some((p) => path.startsWith(p));
  if (!isOperational) return;

  // 3. Check configuration.
  const config = readConfig(event);
  const configuredToken: string =
    (config.apiToken as string) ||
    process.env.BALANCEFRAME_API_TOKEN ||
    '';

  // 3a. No token configured.
  if (!configuredToken) {
    // Explicit development bypass.
    // Accepts: runtimeConfig.devBypassAuth, NUXT_DEV_BYPASS_AUTH,
    //          or BALANCEFRAME_DEV_BYPASS_AUTH env var.
    const bypassAuth =
      (config.devBypassAuth as boolean | string) ||
      process.env.BALANCEFRAME_DEV_BYPASS_AUTH ||
      false;
    if (bypassAuth) return;

    // Fail closed — return 503 Service Unavailable.
    setResponseStatus(event, 503);
    return serviceUnavailable(
      'API token not configured. Set apiToken (NUXT_API_TOKEN) or ' +
        'BALANCEFRAME_API_TOKEN, or enable devBypassAuth for local development.',
    );
  }

  // 4. Validate Bearer token (for external tools / CLI).
  const authHeader = getHeader(event, 'authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (safeEqual(bearerToken, configuredToken)) {
      const actorId =
        (config.authActorId as string) || 'api-user';
      event.context.auth = { authenticated: true, actorId };
      return;
    }
  }

  // 5. Validate session cookie (for same-origin browser requests).
  // The `balanceframe_session` cookie is provisioned by external auth
  // infrastructure — there is no public endpoint that mints it.
  const sessionCookie = getCookie(event, 'balanceframe_session');
  if (sessionCookie) {
    // 5a. Direct match against the configured apiToken.
    if (safeEqual(sessionCookie, configuredToken)) {
      const actorId =
        (config.authActorId as string) || 'api-user';
      event.context.auth = { authenticated: true, actorId };
      return;
    }

    // 5b. Validate as an HMAC-signed session token.
    // The external auth mints tokens using the same apiToken secret.
    const sessionPayload = validateSessionToken(sessionCookie, configuredToken);
    if (sessionPayload) {
      const actorId =
        (config.authActorId as string) || 'api-user';
      event.context.auth = { authenticated: true, actorId };
      return;
    }
  }

  // 6. Not authenticated — reject.
  setResponseStatus(event, 401);
  setHeader(event, 'WWW-Authenticate', 'Bearer');
  return unauthorized(
    'Missing or invalid credentials. Provide a Bearer token or a valid ' +
      'balanceframe_session cookie.',
    'auth.missing_credentials',
  );
});
