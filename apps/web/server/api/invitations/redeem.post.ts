/**
 * POST /api/invitations/redeem — claim and redeem a one-time invitation.
 *
 * Public route (no auth required).  Accepts a token (from the URL fragment),
 * name, email, and password.  Invalid, revoked, expired, already-claimed,
 * and already-redeemed tokens all return the same generic error.
 *
 * The store's claimInvitation validates the token and claims the slot.
 * The route then creates the Better Auth user and completes redemption.
 */

import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import { auth } from '../../../lib/auth';
import { getWorkflowStore } from '../../utils/workflow-store';
import {
  normalizeEmail,
  invitationError,
} from '../../utils/registration';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();

  // 1. Parse body
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return invitationError('Invalid request body', requestId, 'validation.invalid_body');
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const emailRaw = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // 2. Validate required fields
  if (!token || !name || !emailRaw || !password) {
    setResponseStatus(event, 400);
    return invitationError('All fields are required', requestId, 'validation.missing_fields');
  }

  if (password.length < 8) {
    setResponseStatus(event, 400);
    return invitationError('Password must be at least 8 characters', requestId, 'validation.password_too_short');
  }

  const email = normalizeEmail(emailRaw);
  if (!email.includes('@') || email.length < 3) {
    setResponseStatus(event, 400);
    return invitationError('Invalid email address', requestId, 'validation.invalid_email');
  }

  // 3. Access store
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return invitationError('Store unavailable', requestId, 'store.unavailable');
  }

  // 4. Claim invitation — store validates token, computes digest internally,
  //    checks expiry, and returns a claimId for cross-database recovery.
  let claimResult;
  try {
    claimResult = await wf.store.claimInvitation({ token, email });
  } catch {
    setResponseStatus(event, 400);
    return invitationError('Invalid or expired invitation', requestId, 'invitation.invalid');
  }

  // 5. Create the Better Auth user (trusted server call — no headers forwarded)
  let createdUser: { id: string };
  try {
    const result = await auth.api.createUser({
      body: {
        name,
        email,
        password,
      },
    });
    const baUser = result.user;
    if (typeof baUser !== 'object' || baUser === null) {
      throw new Error('Unexpected user response shape');
    }
    if (!('id' in baUser) || typeof baUser.id !== 'string') {
      throw new Error('Unexpected user response shape');
    }
    createdUser = { id: baUser.id };
  } catch (err) {
    // Roll back the claim — best-effort
    try {
      await wf.store.completeInvitationRedemption(claimResult.claimId, '__failed__');
    } catch {
      // Ignore rollback errors
    }
    setResponseStatus(event, 400);
    return invitationError('Could not create account', requestId, 'invitation.user_creation_failed');
  }

  const redeemedUserId = createdUser.id;

  // 6. Assign empty membership (active, no capabilities)
  try {
    await wf.store.upsertActorMembership(redeemedUserId, 'active', [], '*');
  } catch {
    // Non-fatal
  }

  // 7. Complete redemption — updates invitation state with the user ID
  try {
    await wf.store.completeInvitationRedemption(claimResult.claimId, redeemedUserId);
  } catch {
    // Interrupted finalization — reconcile path handles this
  }

  // 8. Append audit record
  try {
    await wf.store.appendAuditRecord({
      classification: 'invitation_redeemed',
      actorId: redeemedUserId,
      operation: 'redeem_invitation',
      requestId,
      result: `Invitation redeemed for user ${redeemedUserId}`,
    });
  } catch {
    // Non-fatal audit failure
  }

  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: {
      message: 'Account created. You can now sign in.',
    },
    error: null,
  };
});
