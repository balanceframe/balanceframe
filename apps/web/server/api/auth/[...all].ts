/**
 * Catch-all auth handler for Better Auth.
 *
 * Mounts the Better Auth server handler at `/api/auth/*`.  This single
 * endpoint manages sign-in, sign-up, sign-out, session, passkeys, and
 * API-key operations automatically.
 *
 * Ordinary auth/session lifecycle endpoints remain public at the middleware.
 * This handler independently enforces consent and authority for control-plane
 * access, including administrative and credential-management reads.
 */

import { auth } from '../../../lib/auth';
import { getRequestPath, setResponseStatus, toWebRequest } from 'h3';
import {
  hasRecentReauthentication,
  type ReauthenticationEvent,
} from '../../utils/reauthentication';
import { requireRegisteredOwner } from '../../utils/legacy-financial-read';
import { requireAuthorization, type EventWithContext } from '../../utils/workflow-store';

const BLOCKED_CONTROL_PLANE_PATHS: Record<string, true> = {
  '/api/auth/admin/impersonate-user': true,
  '/api/auth/admin/stop-impersonating': true,
  '/api/auth/admin/remove-user': true,
  '/api/auth/delete-user': true,
  '/api/auth/delete-user/callback': true,
};

const IDENTITY_CONTROL_PATHS: Record<string, true> = {
  '/api/auth/update-user': true,
  '/api/auth/change-email': true,
};
const CREDENTIAL_CONTROL_PATHS: Record<string, true> = {
  '/api/auth/change-password': true,
  '/api/auth/set-password': true,
  '/api/auth/link-social': true,
  '/api/auth/unlink-account': true,
  '/api/auth/revoke-session': true,
  '/api/auth/revoke-sessions': true,
  '/api/auth/revoke-other-sessions': true,
};

function forbidden(event: Parameters<typeof setResponseStatus>[0], message: string) {
  setResponseStatus(event, 403);
  return { status: 'error', error: { code: 'FORBIDDEN', message } };
}

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event);
  if (BLOCKED_CONTROL_PLANE_PATHS[path]) {
    return forbidden(event, 'This Better Auth operation is disabled.');
  }

  const isAdminControl = path.startsWith('/api/auth/admin/');
  const isCredentialControl =
    path.startsWith('/api/auth/api-key/') || CREDENTIAL_CONTROL_PATHS[path] === true;
  if (isAdminControl || isCredentialControl || IDENTITY_CONTROL_PATHS[path] === true) {
    if (!(await hasRecentReauthentication(event as unknown as ReauthenticationEvent))) {
      return forbidden(event, 'A current reauthenticated human session is required.');
    }

    const capability = isCredentialControl ? 'credential:manage' : 'identity:manage';
    const authorization = await requireAuthorization(
      event as unknown as EventWithContext,
      capability,
    );
    if (!authorization.ok) return authorization.response;

    if (isAdminControl) {
      const owner = await requireRegisteredOwner(event as unknown as EventWithContext);
      if (!owner.ok) return owner.response;
    }
  }

  return auth.handler(toWebRequest(event));
});
