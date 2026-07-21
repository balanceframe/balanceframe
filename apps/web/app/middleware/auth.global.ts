/**
 * Global auth route middleware.
 *
 * Checks the Better Auth session for authenticated pages and redirects
 * to `/login` when the session is missing or expired.
 *
 * In SPA mode this runs on the client after page load.  The session is
 * fetched directly from the Better Auth `get-session` endpoint.
 */

export default defineNuxtRouteMiddleware(async (to) => {
  // Allow the login page and auth API routes through without a session.
  if (to.path === '/login' || to.path.startsWith('/api/auth')) {
    return;
  }

  // Fetch the session from Better Auth's endpoint.
  try {
    const res = await $fetch<{ user?: { id: string; email: string } }>(
      '/api/auth/get-session',
      { credentials: 'same-origin' },
    );

    // Session exists — allow the navigation.
    if (res?.user) return;
  } catch {
    // Network error, server unavailable, etc. — redirect to login.
  }

  // Not authenticated — redirect.
  return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
});
