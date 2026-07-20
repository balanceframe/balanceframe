/**
 * Client-side composable for session credentials.
 *
 * Session tokens are NOT minted from a public browser endpoint — they are
 * provisioned externally as an HttpOnly `balanceframe_session` cookie and
 * sent automatically with same-origin fetch requests.
 *
 * This composable returns null for the Bearer token, meaning the API
 * controller relies entirely on same-origin credentials (cookies).
 * No private server token is ever exposed to browser JavaScript.
 *
 * Usage:
 *   const { getSessionToken } = useSessionToken();
 *   const adapter = useApiReviewController(apiBase, { getSessionToken });
 *
 * The callback always returns null; the adapter omits the Authorization
 * header and depends on the same-origin cookie for authentication.
 */

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Vue composable that provides a session-token callback.
 *
 * Returns null always — session auth is handled exclusively via the
 * HttpOnly `balanceframe_session` cookie, not a browser-minted Bearer
 * token.
 */
export function useSessionToken() {
  function getSessionToken(): string | null {
    return null;
  }

  return { getSessionToken };
}

// ---------------------------------------------------------------------------
// Test support
// ---------------------------------------------------------------------------

/**
 * Reset the module-level token cache.
 *
 * No-op: the composable no longer maintains a fetch cache.  Kept for
 * backward compatibility with test imports.
 */
export function resetSessionTokenCache(): void {
  // No cache to reset.
}
