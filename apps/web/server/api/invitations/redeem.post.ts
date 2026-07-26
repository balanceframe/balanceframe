/**
 * POST /api/invitations/redeem — claim and redeem a one-time invitation.
 *
 * Public route (no auth required).  Accepts a token (from the URL fragment),
 * name, email, and password.  Invalid, revoked, expired, already-claimed,
 * and already-redeemed tokens all return the same generic error.
 *
 * The store's claimInvitation validates the token and claims the slot.
 * The route then creates the Better Auth user and completes redemption.
 *
 * On interruption (crash between claim and redemption), same-email retries
 * recover deterministically using the durable claim ID and, if the Better
 * Auth user was already created, the admin plugin's listUsers API.
 *
 * Auditing is handled by the store's completeInvitationRedemption — the route
 * does not produce a separate redemption audit record.
 */

import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import { auth } from '../../../lib/auth';
import { getWorkflowStore } from '../../utils/workflow-store';
import {
  normalizeEmail,
  validateEmail,
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
  if (!validateEmail(email)) {
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
  let redeemedUserId: string;
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
    redeemedUserId = baUser.id;
  } catch (err) {
    // Attempt recovery: if the user was already created in a prior attempt,
    // listUsers can find the existing user so we can finalize.
    const errMsg = err instanceof Error ? err.message.toLowerCase() : '';
    const isDuplicateEmail =
      errMsg.includes('email') &&
      (errMsg.includes('already') || errMsg.includes('exists') || errMsg.includes('duplicate'));

    if (isDuplicateEmail) {
      try {
        const listResult = await auth.api.listUsers({});
        const existing = listResult.users?.find(
          (u: { email?: string }) => u.email?.toLowerCase() === email,
        );
        if (existing?.id) {
          redeemedUserId = existing.id;
          // Continue to complete redemption with recovered user ID
          try {
            await wf.store.completeInvitationRedemption(
              claimResult.claimId,
              redeemedUserId,
              requestId,
            );
          } catch {
            setResponseStatus(event, 500);
            return invitationError(
              'Could not complete registration',
              requestId,
              'invitation.finalization_failed',
            );
          }
          // Assign empty membership
          try {
            await wf.store.upsertActorMembership(
              redeemedUserId,
              'active',
              [],
              '*',
            );
          } catch {
            // Membership missing but invitation is redeemed — reconcile can fix
            setResponseStatus(event, 500);
            return invitationError(
              'Could not complete registration',
              requestId,
              'invitation.membership_failed',
            );
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
        }
      } catch {
        // listUsers failed — fall through to generic error
      }
    }

    // Could not recover — invitation remains claimed for same-email retry
    setResponseStatus(event, 400);
    return invitationError('Could not create account', requestId, 'invitation.user_creation_failed');
  }

  // 6. Complete redemption — updates invitation state with the user ID.
  //    The store appends the authoritative invitation_redeemed audit record.
  //    On failure the invitation stays claimed (recoverable by reconcile).
  try {
    await wf.store.completeInvitationRedemption(
      claimResult.claimId,
      redeemedUserId,
      requestId,
    );
  } catch {
    setResponseStatus(event, 500);
    return invitationError(
      'Could not complete registration',
      requestId,
      'invitation.finalization_failed',
    );
  }

  // 7. Assign empty membership (active, no capabilities).
  //    If this fails the invitation is already redeemed; return an error so
  //    the caller knows the account was partially created.
  try {
    await wf.store.upsertActorMembership(redeemedUserId, 'active', [], '*');
  } catch {
    setResponseStatus(event, 500);
    return invitationError(
      'Could not complete registration',
      requestId,
      'invitation.membership_failed',
    );
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
