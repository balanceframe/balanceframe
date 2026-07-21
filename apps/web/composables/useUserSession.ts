/**
 * Composable for auth state used by Nuxt pages and middleware.
 *
 * Wraps Better Auth's Vue client session with convenience helpers.
 */

import { authClient } from '../lib/auth-client';

export function useUserSession() {
  const { data: session, isPending } = authClient.useSession();

  const isAuthenticated = computed(() => !!session.value?.user);
  const user = computed(() => session.value?.user ?? null);

  return { session, isAuthenticated, user, isPending };
}
