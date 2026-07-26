/**
 * GET /api/auth/config — public registration configuration.
 *
 * Returns the current registration mode so the UI can render the appropriate
 * landing page (setup wizard vs. sign-in prompt).
 *
 * This endpoint never reveals whether a bootstrap secret is configured,
 * only whether setup is available.
 */

import { defineEventHandler } from 'h3';
import { getWorkflowStore } from '../../utils/workflow-store';
import { loadBootstrapSecret } from '../../utils/registration';
import type { RegistrationState } from '@balanceframe/workflow-store';

export default defineEventHandler(async (event) => {
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    return {
      schemaVersion: '1',
      requestId: crypto.randomUUID(),
      status: 'ok',
      dataFreshness: null,
      authorization: null,
      result: {
        registrationMode: 'invite',
        bootstrapAvailable: false,
        invitationRequired: true,
      },
      error: null,
    };
  }

  let state: RegistrationState;
  try {
    state = await wf.store.getRegistrationState();
  } catch {
    // Store not yet migrated — treat as unconfigured (bootstrap available)
    state = { mode: 'bootstrap', ownerUserId: null, bootstrappedAt: null };
  }

  const bootstrapSecret = loadBootstrapSecret();
  const bootstrapAvailable = state.mode === 'bootstrap' && bootstrapSecret.available;
  const ownerExists = state.mode === 'complete';

  return {
    schemaVersion: '1',
    requestId: crypto.randomUUID(),
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: {
      registrationMode: ownerExists ? 'invite' : 'bootstrap',
      bootstrapAvailable,
      invitationRequired: ownerExists,
    },
    error: null,
  };
});
