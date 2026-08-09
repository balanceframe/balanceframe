/**
 * POST /api/registration/bootstrap — create the first (owner) account.
 *
 * This is a public route guarded by a bootstrap operator secret.
 * It can only succeed once — after the owner exists all subsequent
 * requests return a non-enumerating error.
 *
 * The store's claimBootstrap handles state, membership, and audit atomically.
 * Better Auth user creation is a separate, cross-database step.
 * On interruption (crash between claim and finalization), same-email retries
 * recover deterministically using the durable claim ID and, if the Better
 * Auth user was already created, the admin plugin's listUsers API.
 */

import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import { auth } from '../../../lib/auth';
import { getWorkflowStore } from '../../utils/workflow-store';
import {
  normalizeEmail,
  validateEmail,
  loadBootstrapSecret,
  verifyBootstrapSecret,
  registrationError,
} from '../../utils/registration';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();

  // 1. Parse body
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return registrationError('Invalid request body', requestId, 'validation.invalid_body');
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const emailRaw = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const providedSecret = typeof body.bootstrapSecret === 'string' ? body.bootstrapSecret : '';

  // 2. Validate required fields
  if (!name || !emailRaw || !password || !providedSecret) {
    setResponseStatus(event, 400);
    return registrationError('All fields are required', requestId, 'validation.missing_fields');
  }

  if (password.length < 8) {
    setResponseStatus(event, 400);
    return registrationError(
      'Password must be at least 8 characters',
      requestId,
      'validation.password_too_short',
    );
  }

  const email = normalizeEmail(emailRaw);

  // 3. Validate email with Better Auth-compatible semantics BEFORE claiming
  //    This prevents a malformed email from consuming the bootstrap claim slot.
  if (!validateEmail(email)) {
    setResponseStatus(event, 400);
    return registrationError('Invalid email address', requestId, 'validation.invalid_email');
  }

  // 4. Load and verify bootstrap secret
  const secretLoad = loadBootstrapSecret();
  if (!secretLoad.available) {
    setResponseStatus(event, 400);
    return registrationError('Bootstrap is not available', requestId, 'bootstrap.unavailable');
  }

  if (!verifyBootstrapSecret(providedSecret, secretLoad.secret)) {
    setResponseStatus(event, 400);
    return registrationError('Invalid bootstrap secret', requestId, 'bootstrap.invalid_secret');
  }

  // 5. Access store
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return registrationError('Store unavailable', requestId, 'store.unavailable');
  }

  // 6. Check registration state — distinguish already-bootstrapped (409)
  //    from store/migration errors (503).
  try {
    const regState = await wf.store.getRegistrationState();
    if (regState.mode === 'complete') {
      setResponseStatus(event, 409);
      return registrationError(
        'Bootstrap is not available',
        requestId,
        'bootstrap.already_completed',
      );
    }
  } catch {
    // If we can't read the state, treat as unavailable
    setResponseStatus(event, 503);
    return registrationError('Store unavailable', requestId, 'store.state_read_error');
  }

  // 7. Claim the bootstrap slot — capture the durable claim ID for finalization.
  //    On same-email retry the store returns the existing claimId, which we MUST
  //    use (not a newly generated one) to successfully finalize.
  let effectiveClaimId: string;
  try {
    const claimId = crypto.randomUUID();
    const claimResult = await wf.store.claimBootstrap({ name, email, claimId });
    effectiveClaimId = claimResult.claimId;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    // Known conflict states from the store — return 409 to distinguish from 503
    if (message.includes('already completed') || message.includes('already claimed')) {
      setResponseStatus(event, 409);
      return registrationError('Bootstrap is not available', requestId, 'bootstrap.conflict');
    }
    // Everything else (missing migration, db locked, etc.) — 503
    setResponseStatus(event, 503);
    return registrationError(
      'Registration store not initialised',
      requestId,
      'store.missing_migration',
    );
  }

  // 8. Create the Better Auth user (trusted server call — no headers forwarded)
  let baUserId: string;
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
    baUserId = baUser.id;
  } catch (err) {
    // Attempt recovery: if the user was already created in a prior attempt,
    // listUsers can find the existing user so we can finalize.
    const errMsg = err instanceof Error ? err.message.toLowerCase() : '';
    const isDuplicateEmail =
      errMsg.includes('email') &&
      (errMsg.includes('already') || errMsg.includes('exists') || errMsg.includes('duplicate'));

    if (isDuplicateEmail) {
      try {
        const listResult = await auth.api.listUsers({ query: {} });
        const existing = listResult.users?.find(
          (u: { email?: string }) => u.email?.toLowerCase() === email,
        );
        if (existing?.id) {
          baUserId = existing.id;
          // Finalize with the recovered user ID
          try {
            await wf.store.finalizeBootstrap({ claimId: effectiveClaimId, ownerUserId: baUserId });
          } catch {
            setResponseStatus(event, 500);
            return registrationError(
              'Could not complete setup',
              requestId,
              'bootstrap.finalization_failed',
            );
          }

          return {
            schemaVersion: '1',
            requestId,
            status: 'ok',
            dataFreshness: null,
            authorization: null,
            result: {
              message: 'Instance owner account created. You can now sign in.',
            },
            error: null,
          };
        }
      } catch {
        // listUsers failed — fall through to generic error
      }
    }

    // Could not recover — claim remains for same-email retry
    setResponseStatus(event, 400);
    return registrationError(
      'Could not create account',
      requestId,
      'bootstrap.user_creation_failed',
    );
  }

  // 9. Finalize bootstrap using the effective (possibly reused) claim ID
  try {
    await wf.store.finalizeBootstrap({ claimId: effectiveClaimId, ownerUserId: baUserId });
  } catch (err) {
    setResponseStatus(event, 500);
    return registrationError(
      'Could not complete setup',
      requestId,
      'bootstrap.finalization_failed',
    );
  }

  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: {
      message: 'Instance owner account created. You can now sign in.',
    },
    error: null,
  };
});
