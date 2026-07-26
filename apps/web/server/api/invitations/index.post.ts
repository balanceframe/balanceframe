/**
 * POST /api/invitations — create a one-time invitation link.
 *
 * Only the instance owner (whose user ID matches registration_state.owner_user_id)
 * may create invitations.  The raw token is returned exclusively in this response;
 * the stored record contains only the sha256 digest.  Audit is handled by the store.
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore } from '../../utils/workflow-store';
import {
  requireOwner,
} from '../../utils/registration';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();

  // 1. Ensure session auth
  const ctx = event.context.auth;
  if (!ctx?.authenticated) {
    setResponseStatus(event, 401);
    return {
      schemaVersion: '1',
      requestId,
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        retryable: false,
        reasonCodes: ['auth.missing_credentials'],
      },
    };
  }

  // 2. Verify owner status
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return {
      schemaVersion: '1',
      requestId,
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Store unavailable',
        retryable: true,
        reasonCodes: ['store.unavailable'],
      },
    };
  }

  let state;
  try {
    state = await wf.store.getRegistrationState();
  } catch {
    setResponseStatus(event, 503);
    return {
      schemaVersion: '1',
      requestId,
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Registration state unavailable',
        retryable: false,
        reasonCodes: ['store.missing_migration'],
      },
    };
  }

  if (state.mode !== 'complete' || !state.ownerUserId) {
    setResponseStatus(event, 400);
    return {
      schemaVersion: '1',
      requestId,
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'INVITATION_FAILED',
        message: 'Instance has not been bootstrapped',
        retryable: false,
        reasonCodes: ['bootstrap.not_completed'],
      },
    };
  }

  const ownerCheck = requireOwner(event, state.ownerUserId);
  if (!ownerCheck.ok) return ownerCheck.response;

  // 3. Create invitation via store
  // Store generates the raw token, computes the digest, persists, and appends audit.
  let result;
  try {
    result = await wf.store.createInvitation(ctx.actorId);
  } catch (err) {
    setResponseStatus(event, 500);
    return {
      schemaVersion: '1',
      requestId,
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create invitation',
        retryable: true,
        reasonCodes: ['invitation.persist_failed'],
      },
    };
  }

  // 4. Return invitation metadata and copyable URL
  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: {
      invitation: {
        id: result.invitation.id,
        expiresAt: result.invitation.expiresAt,
      },
      inviteUrl: result.inviteUrl,
    },
    error: null,
  };
});
