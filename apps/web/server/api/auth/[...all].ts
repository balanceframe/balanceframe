/**
 * Catch-all auth handler for Better Auth.
 *
 * Mounts the Better Auth server handler at `/api/auth/*`.  This single
 * endpoint manages sign-in, sign-up, sign-out, session, passkeys, and
 * API-key operations automatically.
 *
 * The handler is always public (Nitro does not fire the global middleware
 * for paths that match a route handler first), so auth endpoints are
 * reachable without a session — they manage the session lifecycle.
 */

import { auth } from '../../../lib/auth';
import { toWebRequest } from 'h3';

export default defineEventHandler((event) => {
  return auth.handler(toWebRequest(event));
});
