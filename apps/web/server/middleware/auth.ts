/**
 * Authentication middleware for Nitro API routes.
 *
 * Reads a Bearer token from the Authorization header and compares it
 * against the configured API token.  If no token is configured the
 * middleware is bypassed (development mode).
 *
 * On success sets `event.context.auth = { authenticated: true }`.
 * On failure returns a 401 JSON error envelope.
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

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const token = config.apiToken || process.env.BALANCEFRAME_API_TOKEN;

  // Development mode — no token configured, skip auth.
  if (!token) return;

  const authHeader = getHeader(event, 'authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    setResponseStatus(event, 401);
    return unauthorized('Missing or invalid authorization header', 'auth.missing_token');
  }

  const bearerToken = authHeader.slice(7);
  if (bearerToken !== token) {
    setResponseStatus(event, 401);
    return unauthorized('Invalid authorization token', 'auth.invalid_token');
  }

  event.context.auth = { authenticated: true };
});
