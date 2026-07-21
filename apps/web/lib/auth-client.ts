/**
 * Better Auth Vue client for BalanceFrame.
 *
 * Imported by Nuxt pages and composables for session management and auth
 * actions (sign-in, sign-up, sign-out).
 *
 * The client uses the same-origin session cookie set by the Nitro auth
 * handler — no Bearer token is minted in the browser.
 */

import { createAuthClient } from 'better-auth/vue';
import { apiKeyClient } from '@better-auth/api-key/client';

export const authClient = createAuthClient({
  plugins: [apiKeyClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
