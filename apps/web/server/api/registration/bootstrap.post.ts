/**
 * POST /api/registration/bootstrap — create the first (owner) account.
 *
 * This is a public route guarded by a bootstrap operator secret.
 * It can only succeed once — after the owner exists all subsequent
 * requests return a non-enumerating error.
 *
 * The store's claimBootstrap handles state, membership, and audit atomically.
 * Better Auth user creation is a separate, cross-database step.
 */

import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import { auth } from '../../../lib/auth';
import { getWorkflowStore } from '../../utils/workflow-store';
import {
  normalizeEmail,
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
    return registrationError('Password must be at least 8 characters', requestId, 'validation.password_too_short');
  }

  const email = normalizeEmail(emailRaw);
  if (!email.includes('@') || email.length < 3) {
    setResponseStatus(event, 400);
    return registrationError('Invalid email address', requestId, 'validation.invalid_email');
  }

  // 3. Load and verify bootstrap secret
  const secretLoad = loadBootstrapSecret();
  if (!secretLoad.available) {
    setResponseStatus(event, 400);
    return registrationError('Bootstrap is not available', requestId, 'bootstrap.unavailable');
  }

  if (!verifyBootstrapSecret(providedSecret, secretLoad.secret)) {
    setResponseStatus(event, 400);
    return registrationError('Invalid bootstrap secret', requestId, 'bootstrap.invalid_secret');
  }

  // 4. Access store
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return registrationError('Store unavailable', requestId, 'store.unavailable');
  }

  // 5. Claim the bootstrap slot
  const claimId = crypto.randomUUID();
  try {
    await wf.store.claimBootstrap({ name, email, claimId });
  } catch (err) {
    setResponseStatus(event, 503);
    return registrationError('Registration store not initialised', requestId, 'store.missing_migration');
  }

  // 6. Create the Better Auth user (trusted server call — no headers forwarded)
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
    // Store already claimed the bootstrap slot; user cannot retry with different email
    setResponseStatus(event, 400);
    return registrationError('Could not create account', requestId, 'bootstrap.user_creation_failed');
  }

  // 7. Finalize bootstrap with the Better Auth user ID
  try {
    await wf.store.finalizeBootstrap({ claimId, ownerUserId: baUserId });
  } catch (err) {
    setResponseStatus(event, 500);
    return registrationError('Could not complete setup', requestId, 'bootstrap.finalization_failed');
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
