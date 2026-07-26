/**
 * POST /api/invitations/:id/revoke — revoke an active invitation.
 *
 * Only the instance owner may revoke invitations.
 * The raw token is never stored server-side, so revocation only prevents
 * future claims; any leaked token is permanently invalidated.
 * The store writes the authoritative audit record with actor context.
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore } from '../../../utils/workflow-store';
import { requireOwner } from '../../../utils/registration';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();

  // 1. Resolve the invitation ID from the route parameter
  const invitationId = event.context.params?.id;

  if (!invitationId || typeof invitationId !== 'string') {
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
        message: 'Invitation ID is required',
        retryable: false,
        reasonCodes: ['validation.missing_id'],
      },
    };
  }

  // 2. Ensure session auth
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

  // 3. Access store
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

  // 4. Verify owner
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

  // 5. Revoke the invitation
  try {
    await wf.store.revokeInvitation(invitationId, ctx.actorId, requestId);
  } catch {
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
        message: 'Could not revoke invitation',
        retryable: false,
        reasonCodes: ['invitation.revoke_failed'],
      },
    };
  }

  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: {
      message: 'Invitation revoked',
    },
    error: null,
  };
});
