/**
 * Global auth route middleware.
 *
 * Checks the Better Auth session for authenticated pages and redirects
 * to `/login` when the session is missing or expired.
 *
 * During SSR the middleware forwards the incoming request's Cookie header
 * so that the internal server-side session check can identify the user.
 * In SPA mode the browser sends the cookies automatically and
 * `useRequestHeaders` returns an empty map — no forwarding needed.
 */
import { defineNuxtRouteMiddleware, useRequestHeaders, navigateTo } from '#app';

export default defineNuxtRouteMiddleware(async (to) => {
  // Allow the login page and auth API routes through without a session.
  if (to.path === '/login' || to.path.startsWith('/api/auth')) {
    return;
  }

  // Fetch the session from Better Auth's endpoint.
  // Forward incoming Cookie during SSR so the session endpoint
  // can identify the user.  On the client, same-origin credentials
  // carry cookies automatically and useRequestHeaders is a no-op.
  const fetchOptions: RequestInit & { headers?: Record<string, string> } = {
    credentials: 'same-origin',
  };
  const reqHeaders = useRequestHeaders(['cookie']);
  if (reqHeaders.cookie) {
    fetchOptions.headers = { Cookie: reqHeaders.cookie };
  }

  try {
    const res = await $fetch<{ user?: { id: string; email: string } }>(
      '/api/auth/get-session',
      fetchOptions,
    );

    // Session exists — allow the navigation.
    if (res?.user) return;
  } catch {
    // Network error, server unavailable, etc. — redirect to login.
  }

  // Not authenticated — redirect.
  return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
});
