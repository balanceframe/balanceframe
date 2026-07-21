/**
 * Client-side composable for session credentials.
 *
 * Better Auth manages the session via its HttpOnly cookie (set by the Nitro
 * `/api/auth/*` handler).  No Bearer token is exposed to browser JavaScript.
 *
 * This composable returns null for the Bearer token, meaning the API
 * controller relies entirely on same-origin session cookies.
 *
 * Usage:
 *   const { getSessionToken } = useSessionToken();
 *   const adapter = useApiReviewController(apiBase, { getSessionToken });
 *
 * The callback always returns null; the adapter omits the Authorization
 * header and depends on the same-origin cookie for authentication.
 */

export function useSessionToken() {
  function getSessionToken(): string | null {
    return null;
  }

  return { getSessionToken };
}

/**
 * Reset the module-level token cache.
 *
 * No-op: the composable no longer maintains a fetch cache.  Kept for
 * backward compatibility with test imports.
 */
export function resetSessionTokenCache(): void {
  // No cache to reset.
}
