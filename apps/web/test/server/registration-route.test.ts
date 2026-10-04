/**
 * Route-level behavior tests for self-hosted registration API endpoints.
 *
 * Exercises the actual handler functions with mocked I/O boundaries:
 *   - h3     (readBody, setResponseStatus, defineEventHandler)
 *   - auth   (auth.api.createUser)
 *   - store  (getWorkflowStore → mock store)
 *   - crypto (randomUUID)
 *
 * Every test imports the handler directly (mock defineEventHandler is the
 * identity function) and drives it with a synthetic event object.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type * as WorkflowUtils from '../../server/utils/workflow-store';
import type * as Reauthentication from '../../server/utils/reauthentication';

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockReadBody,
  mockSetResponseStatus,
  mockSetHeader,
  mockCreateUser,
  mockListUsers,
  mockGetWorkflowStore,
  mockAuthenticateInvitationHuman,
  mockHasTrustedRequestOrigin,
} = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockSetResponseStatus: vi.fn(),
  mockSetHeader: vi.fn(),
  mockCreateUser: vi.fn(),
  mockListUsers: vi.fn(),
  mockGetWorkflowStore: vi.fn(),
  mockAuthenticateInvitationHuman: vi.fn(),
  mockHasTrustedRequestOrigin: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock h3 — defineEventHandler unwraps so we get the raw handler function
// ---------------------------------------------------------------------------

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mockReadBody,
  setResponseStatus: mockSetResponseStatus,
  setHeader: mockSetHeader,
}));

// ---------------------------------------------------------------------------
// Mock lib/auth — used by the legacy bootstrap endpoint, never invitation redemption.
vi.mock('../../lib/auth', () => ({
  auth: { api: { createUser: mockCreateUser, listUsers: mockListUsers } },
}));

// ---------------------------------------------------------------------------
// Mock workflow-store — provides getWorkflowStore (per-test store injection)
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowUtils>();
  return { ...actual, getWorkflowStore: mockGetWorkflowStore };
});

vi.mock('../../server/utils/reauthentication', async (importOriginal) => {
  const actual = await importOriginal<typeof Reauthentication>();
  return {
    ...actual,
    authenticateInvitationHuman: mockAuthenticateInvitationHuman,
    hasTrustedRequestOrigin: mockHasTrustedRequestOrigin,
  };
});

// ---------------------------------------------------------------------------
// Import handlers (after all mocks are in place)
// ---------------------------------------------------------------------------

import configHandler from '../../server/api/auth/config.get';
import bootstrapHandler from '../../server/api/registration/bootstrap.post';
import redeemHandler from '../../server/api/invitations/redeem.post';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape matching the store interface methods the routes depend on. */
interface MockStore {
  getRegistrationState: Mock;
  claimBootstrap: Mock;
  finalizeBootstrap: Mock;
  createInvitation: Mock;
  revokeInvitation: Mock;
  claimInvitation: Mock;
  upsertActorMembership: Mock;
  completeInvitationRedemption: Mock;
  appendAuditRecord: Mock;
}

/** Minimal response envelope shape for assertions. */
interface ResponseEnvelope {
  schemaVersion: string;
  requestId: string;
  status: string;
  dataFreshness: unknown;
  authorization: unknown;
  result: Record<string, unknown> | null;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    reasonCodes?: string[];
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(): MockStore {
  return {
    getRegistrationState: vi.fn(),
    claimBootstrap: vi.fn(),
    finalizeBootstrap: vi.fn(),
    createInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    claimInvitation: vi.fn(),
    upsertActorMembership: vi.fn(),
    completeInvitationRedemption: vi.fn(),
    appendAuditRecord: vi.fn(),
  };
}

/** Create a minimal mock event that satisfies the shape used by handlers. */
function mockEvent(opts?: {
  auth?: { authenticated: boolean; actorId: string };
  params?: Record<string, string>;
}) {
  return {
    context: {
      auth: opts?.auth ?? null,
      params: opts?.params ?? {},
    },
  };
}

const BOOTSTRAP_SECRET = 'test-secret-thirty-two-chars-long!!!';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockStore: MockStore;

beforeEach(() => {
  mockStore = createMockStore();
  mockGetWorkflowStore.mockReturnValue({ store: mockStore });
});

afterEach(() => {
  // Clean up env vars that may have been set for specific tests
  delete process.env.BALANCEFRAME_BOOTSTRAP_SECRET;
  delete process.env.BALANCEFRAME_BOOTSTRAP_SECRET_FILE;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------
// GET /api/auth/config
// ---------------------------------------------------------------

describe('GET /api/auth/config', () => {
  it('returns registration mode without exposing the bootstrap secret', async () => {
    process.env.BALANCEFRAME_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;
    mockStore.getRegistrationState.mockResolvedValue({
      mode: 'bootstrap',
      ownerUserId: null,
      bootstrappedAt: null,
    });

    const response = (await configHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect(response.result).not.toBeNull();
    expect(response.error).toBeNull();
    expect(response.result).toMatchObject({
      registrationMode: 'bootstrap',
      bootstrapAvailable: true,
      invitationRequired: false,
    });
    // The secret value must never appear in the response
    expect(JSON.stringify(response)).not.toContain(BOOTSTRAP_SECRET);
    expect(response.result).not.toHaveProperty('secret');
  });

  it('returns safe defaults when store is unavailable', async () => {
    mockGetWorkflowStore.mockReturnValue({ error: 'Store not ready' });

    const response = (await configHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      registrationMode: 'invite',
      bootstrapAvailable: false,
      invitationRequired: true,
    });
  });
});

// ---------------------------------------------------------------
// POST /api/registration/bootstrap
// ---------------------------------------------------------------
describe('POST /api/registration/bootstrap', () => {
  beforeEach(() => {
    process.env.BALANCEFRAME_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;
    mockStore.getRegistrationState.mockResolvedValue({
      mode: 'bootstrap',
      ownerUserId: null,
      bootstrappedAt: null,
    });
  });

  it('rejects malformed body with stable generic error', async () => {
    mockReadBody.mockResolvedValue({});

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.status).toBe('error');
    expect(response.error).not.toBeNull();
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    // Must not leak reason codes
    expect(response.error).not.toHaveProperty('reasonCodes');
  });

  it('rejects short password with stable generic error', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Test',
      email: 'test@example.com',
      password: 'short',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    expect(response.error).not.toHaveProperty('reasonCodes');
  });

  it('rejects wrong bootstrap secret without enumerating', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Test',
      email: 'test@example.com',
      password: 'password12345678',
      bootstrapSecret: 'this-is-the-wrong-secret-value-here!!!',
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    // No indication of what went wrong
    expect(JSON.stringify(response)).not.toContain('wrong');
    expect(JSON.stringify(response)).not.toContain('invalid secret');
    expect(JSON.stringify(response)).not.toContain(BOOTSTRAP_SECRET);
  });

  it('rejects invalid email format before claiming', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Test',
      email: 'not-an-email',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    // claimBootstrap and createUser must NOT be called — email rejected before claim
    expect(mockStore.claimBootstrap).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    expect(response.error).not.toHaveProperty('reasonCodes');
  });

  it('rejects email with embedded spaces before claiming', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Test',
      email: 'test@ example.com',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(mockStore.claimBootstrap).not.toHaveBeenCalled();
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
  });

  it('returns 409 conflict when owner already exists', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Second User',
      email: 'second@example.com',
      password: 'another-secure-password',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    // Registration state reports owner already exists
    mockStore.getRegistrationState.mockResolvedValue({
      mode: 'complete',
      ownerUserId: 'existing-owner',
      bootstrappedAt: '2025-01-01T00:00:00.000Z',
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 409);
    // Must not attempt claim or BA user creation
    expect(mockStore.claimBootstrap).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    // Must not reveal the nature of the conflict
    expect(JSON.stringify(response)).not.toContain('already');
    expect(JSON.stringify(response)).not.toContain('owner');
    expect(JSON.stringify(response)).not.toContain('completed');
  });

  it('returns 409 when bootstrap already claimed with different email', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Intruder',
      email: 'intruder@example.com',
      password: 'another-secure-password',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    // Store throws because a different email already claimed the slot
    mockStore.claimBootstrap.mockRejectedValue(new Error('Bootstrap already claimed'));

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 409);
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    expect(JSON.stringify(response)).not.toContain('already');
    expect(JSON.stringify(response)).not.toContain('claimed');
  });

  it('returns 503 when store throws migration or unexpected error', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Owner User',
      email: 'owner@example.com',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    // Store throws a generic error (missing migration, db locked, etc.)
    mockStore.claimBootstrap.mockRejectedValue(new Error('no such table: registration_state'));

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
  });

  it('succeeds and creates BA user without forwarded headers', async () => {
    const baUserId = 'ba-user-abc-123';
    mockReadBody.mockResolvedValue({
      name: 'Owner User',
      email: 'owner@example.com',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    mockCreateUser.mockResolvedValue({
      user: { id: baUserId },
    });
    const fixedClaimId = 'claim-id-001';
    mockStore.claimBootstrap.mockResolvedValue({ claimId: fixedClaimId });
    mockStore.finalizeBootstrap.mockResolvedValue({
      ownerUserId: baUserId,
      bootstrappedAt: '2025-01-01T00:00:00.000Z',
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    // Verifies createUser was called without forwarded request headers
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    const createUserArg = mockCreateUser.mock.calls[0][0] as Record<string, unknown>;
    expect(createUserArg).toHaveProperty('body');
    expect(createUserArg).not.toHaveProperty('headers');
    expect(createUserArg.body as Record<string, unknown>).toMatchObject({
      name: 'Owner User',
      email: 'owner@example.com',
    });
    // Verifies claimBootstrap received a claimId
    expect(mockStore.claimBootstrap).toHaveBeenCalledTimes(1);
    const claimBootstrapInput = mockStore.claimBootstrap.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(claimBootstrapInput).toMatchObject({
      name: 'Owner User',
      email: 'owner@example.com',
    });
    expect(typeof claimBootstrapInput.claimId).toBe('string');
    expect(mockStore.finalizeBootstrap).toHaveBeenCalledWith({
      claimId: fixedClaimId,
      ownerUserId: baUserId,
    });
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      message: 'Instance owner account created. You can now sign in.',
    });
  });

  it('reuses existing claimId on same-email retry after interrupted claim', async () => {
    const existingClaimId = 'existing-claim-retry-001';
    const baUserId = 'ba-user-retry-123';
    mockReadBody.mockResolvedValue({
      name: 'Owner User',
      email: 'owner@example.com',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    mockCreateUser.mockResolvedValue({ user: { id: baUserId } });
    // claimBootstrap returns existing claimId (same-email retry from previous interruption)
    mockStore.claimBootstrap.mockResolvedValue({ claimId: existingClaimId });
    mockStore.finalizeBootstrap.mockResolvedValue({
      ownerUserId: baUserId,
      bootstrappedAt: '2025-01-01T00:00:00.000Z',
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    // Route must use the returned claimId, not generate a new random one
    expect(mockStore.finalizeBootstrap).toHaveBeenCalledWith({
      claimId: existingClaimId,
      ownerUserId: baUserId,
    });
    expect(response.status).toBe('ok');
  });

  it('recovers via listUsers when createUser fails because user already exists', async () => {
    const existingClaimId = 'recovery-claim-001';
    const existingUserId = 'ba-user-recovery-456';
    mockReadBody.mockResolvedValue({
      name: 'Owner User',
      email: 'owner@example.com',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    // claimBootstrap succeeds with existing claimId
    mockStore.claimBootstrap.mockResolvedValue({ claimId: existingClaimId });
    // createUser throws because the user was already created in a previous attempt
    mockCreateUser.mockRejectedValue(new Error('User with this email already exists'));
    // listUsers returns the existing user so we can recover
    mockListUsers.mockResolvedValue({
      users: [{ id: existingUserId, email: 'owner@example.com' }],
    });
    mockStore.finalizeBootstrap.mockResolvedValue({
      ownerUserId: existingUserId,
      bootstrappedAt: '2025-01-01T00:00:00.000Z',
    });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    // Should have called listUsers to find the existing user
    expect(mockListUsers).toHaveBeenCalledTimes(1);
    // Should have finalized with the recovered user ID
    expect(mockStore.finalizeBootstrap).toHaveBeenCalledWith({
      claimId: existingClaimId,
      ownerUserId: existingUserId,
    });
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      message: 'Instance owner account created. You can now sign in.',
    });
  });

  it('fails with 400 when createUser fails and user cannot be recovered', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Owner User',
      email: 'owner@example.com',
      password: 'secure-password-here-42',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    mockStore.claimBootstrap.mockResolvedValue({ claimId: 'claim-001' });
    // createUser fails with a non-duplicate error
    mockCreateUser.mockRejectedValue(new Error('Database connection error'));
    // listUsers returns empty — no existing user to recover
    mockListUsers.mockResolvedValue({ users: [] });

    const response = (await bootstrapHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    expect(mockStore.finalizeBootstrap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// POST /api/invitations/redeem
// ---------------------------------------------------------------

describe('POST /api/invitations/redeem', () => {
  const token = 'ab'.repeat(32);
  const humanAuth = {
    method: 'human-session' as const,
    actorId: 'existing-user-42',
    sessionId: 'session-42',
    reauthenticatedAt: '2025-06-01T12:00:00.000Z',
  };

  beforeEach(() => {
    mockHasTrustedRequestOrigin.mockReset();
    mockAuthenticateInvitationHuman.mockReset();
    mockCreateUser.mockReset();
    mockListUsers.mockReset();
    mockHasTrustedRequestOrigin.mockReturnValue(true);
    mockAuthenticateInvitationHuman.mockResolvedValue({
      auth: humanAuth,
      email: 'verified@example.com',
    });
    mockStore.claimInvitation.mockResolvedValue({
      claimId: 'claim-42',
      email: 'verified@example.com',
      spaceId: 'space-42',
    });
    mockStore.completeInvitationRedemption.mockResolvedValue(undefined);
  });

  it('redeems only an existing verified human identity and passes the fresh proof to the store', async () => {
    const event = mockEvent();
    mockReadBody.mockResolvedValue({
      token,
      name: 'Existing invited member',
      email: 'verified@example.com',
      password: 'correct horse battery staple',
    });

    const response = (await redeemHandler(event)) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect(mockHasTrustedRequestOrigin).toHaveBeenCalledWith(event);
    expect(mockStore.claimInvitation).toHaveBeenCalledWith({
      token,
      email: 'verified@example.com',
      requestId: expect.any(String),
      correlationId: expect.any(String),
    });
    expect(mockAuthenticateInvitationHuman).toHaveBeenCalledWith(
      event,
      'verified@example.com',
      'correct horse battery staple',
    );
    expect(mockStore.claimInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      mockAuthenticateInvitationHuman.mock.invocationCallOrder[0],
    );
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledWith(
      'claim-42',
      'existing-user-42',
      expect.objectContaining({
        auth: humanAuth,
        email: 'verified@example.com',
        requestId: expect.any(String),
      }),
    );
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(mockStore.upsertActorMembership).not.toHaveBeenCalled();
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain('correct horse battery staple');
    expect(response.result).not.toHaveProperty('token');
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'cache-control', 'no-store');
  });

  it('uses the protected claim email for account sign-in after canonicalizing submitted email', async () => {
    mockReadBody.mockResolvedValue({
      token,
      name: 'Existing invited member',
      email: ' VERIFIED@example.com ',
      password: 'correct horse battery staple',
    });

    await redeemHandler(mockEvent());

    expect(mockStore.claimInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'verified@example.com' }),
    );
    expect(mockAuthenticateInvitationHuman).toHaveBeenCalledWith(
      expect.anything(),
      'verified@example.com',
      'correct horse battery staple',
    );
  });

  it('creates an invited account only after a valid claim and then authenticates its real session', async () => {
    const createdAuth = {
      method: 'human-session' as const,
      actorId: 'new-user-42',
      sessionId: 'new-session-42',
      reauthenticatedAt: '2025-06-01T12:00:00.000Z',
    };
    mockReadBody.mockResolvedValue({
      token,
      name: 'New invited member',
      email: 'verified@example.com',
      password: 'correct horse battery staple',
    });
    mockAuthenticateInvitationHuman
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ auth: createdAuth, email: 'verified@example.com' });
    mockCreateUser.mockResolvedValue({
      user: { id: 'new-user-42', email: 'verified@example.com' },
    });

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect(mockStore.claimInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateUser.mock.invocationCallOrder[0],
    );
    expect(mockCreateUser).toHaveBeenCalledWith({
      body: {
        name: 'New invited member',
        email: 'verified@example.com',
        password: 'correct horse battery staple',
      },
    });
    expect(mockAuthenticateInvitationHuman).toHaveBeenCalledTimes(2);
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledWith(
      'claim-42',
      'new-user-42',
      expect.objectContaining({ auth: createdAuth, email: 'verified@example.com' }),
    );
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain('correct horse battery staple');
  });

  it('does not adopt an existing account without its actual password session', async () => {
    mockAuthenticateInvitationHuman.mockResolvedValue(null);
    mockCreateUser.mockRejectedValue(new Error('User with this email already exists'));
    mockReadBody.mockResolvedValue({
      token,
      name: 'Existing invited member',
      email: 'verified@example.com',
      password: 'wrong-password',
    });

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('error');
    expect(response.error!.code).toBe('INVITATION_FAILED');
    expect(mockStore.claimInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateUser.mock.invocationCallOrder[0],
    );
    expect(mockStore.completeInvitationRedemption).not.toHaveBeenCalled();
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(token);
  });

  it('does not switch an already authenticated human to a different invitation identity', async () => {
    mockReadBody.mockResolvedValue({
      token,
      name: 'Other invited member',
      email: 'verified@example.com',
      password: 'correct horse battery staple',
    });
    const event = mockEvent({ auth: { authenticated: true, actorId: 'signed-in-user' } });

    const response = (await redeemHandler(event)) as ResponseEnvelope;

    expect(response.status).toBe('error');
    expect(response.error!.code).toBe('INVITATION_FAILED');
    expect(mockStore.claimInvitation).toHaveBeenCalledOnce();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockStore.completeInvitationRedemption).not.toHaveBeenCalled();
  });

  it('rejects body-supplied identity fields before authenticating or claiming', async () => {
    mockReadBody.mockResolvedValue({
      token,
      name: 'Attacker',
      email: 'verified@example.com',
      password: 'correct horse battery staple',
      actorId: 'attacker-controlled-user',
    });

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('error');
    expect(response.error!.code).toBe('INVITATION_FAILED');
    expect(mockAuthenticateInvitationHuman).not.toHaveBeenCalled();
    expect(mockStore.claimInvitation).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('rejects an untrusted browser origin before reading credentials', async () => {
    const event = mockEvent();
    mockHasTrustedRequestOrigin.mockReturnValue(false);

    const response = (await redeemHandler(event)) as ResponseEnvelope;

    expect(response.status).toBe('error');
    expect(mockReadBody).not.toHaveBeenCalled();
    expect(mockAuthenticateInvitationHuman).not.toHaveBeenCalled();
    expect(mockStore.claimInvitation).not.toHaveBeenCalled();
  });

  it('returns one generic failure for invalid, revoked, or replayed invitation tokens', async () => {
    mockReadBody.mockResolvedValue({
      token,
      name: 'Invited member',
      email: 'verified@example.com',
      password: 'correct horse battery staple',
    });
    mockStore.claimInvitation.mockRejectedValue(new Error('Invitation has been revoked'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('error');
    expect(response.error!.code).toBe('INVITATION_FAILED');
    expect(response.error!.retryable).toBe(false);
    expect(JSON.stringify(response)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain('revoked');
    expect(mockStore.completeInvitationRedemption).not.toHaveBeenCalled();
    expect(mockAuthenticateInvitationHuman).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('does not complete a claim when atomic redemption fails', async () => {
    mockReadBody.mockResolvedValue({
      token,
      name: 'Invited member',
      email: 'verified@example.com',
      password: 'correct horse battery staple',
    });
    mockStore.completeInvitationRedemption.mockRejectedValue(new Error('Update failed'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('error');
    expect(response.error!.code).toBe('INVITATION_FAILED');
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledOnce();
    expect(mockStore.upsertActorMembership).not.toHaveBeenCalled();
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(token);
  });
});
