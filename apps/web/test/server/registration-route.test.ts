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

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockReadBody, mockSetResponseStatus, mockCreateUser, mockListUsers, mockGetWorkflowStore } =
  vi.hoisted(() => ({
    mockReadBody: vi.fn(),
    mockSetResponseStatus: vi.fn(),
    mockCreateUser: vi.fn(),
    mockListUsers: vi.fn(),
    mockGetWorkflowStore: vi.fn(),
  }));

// ---------------------------------------------------------------------------
// Mock h3 — defineEventHandler unwraps so we get the raw handler function
// ---------------------------------------------------------------------------

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mockReadBody,
  setResponseStatus: mockSetResponseStatus,
}));

// ---------------------------------------------------------------------------
// Mock lib/auth — heavy native bindings; expose only createUser
vi.mock('../../lib/auth', () => ({
  auth: {
    api: {
      createUser: mockCreateUser,
      listUsers: mockListUsers,
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock workflow-store — provides getWorkflowStore (per-test store injection)
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
}));

// ---------------------------------------------------------------------------
// Import handlers (after all mocks are in place)
// ---------------------------------------------------------------------------

import configHandler from '../../server/api/auth/config.get';
import bootstrapHandler from '../../server/api/registration/bootstrap.post';
import createInviteHandler from '../../server/api/invitations/index.post';
import revokeHandler from '../../server/api/invitations/[id]/revoke.post';
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
// POST /api/invitations
// ---------------------------------------------------------------

describe('POST /api/invitations', () => {
  const OWNER_ID = 'owner-user-id-42';

  beforeEach(() => {
    mockStore.getRegistrationState.mockResolvedValue({
      mode: 'complete',
      ownerUserId: OWNER_ID,
      bootstrappedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('rejects invitation creation by non-owner', async () => {
    const event = mockEvent({
      auth: { authenticated: true, actorId: 'other-user-99' },
    });

    const response = (await createInviteHandler(event)) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 403);
    expect(response.error!.code).toBe('FORBIDDEN');
    expect(response.error!.message).toBe('Only the instance owner can perform this action');
    expect(mockStore.createInvitation).not.toHaveBeenCalled();
  });

  it('returns raw token only inside the inviteUrl fragment', async () => {
    const rawToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const inviteUrl = `http://localhost:3000/invite#token=${rawToken}`;
    const invitationId = 'invitation-abc-001';
    const expiresAt = '2025-01-08T00:00:00.000Z';

    mockStore.createInvitation.mockResolvedValue({
      invitation: { id: invitationId, expiresAt, status: 'active' },
      inviteUrl,
    });

    const event = mockEvent({
      auth: { authenticated: true, actorId: OWNER_ID },
    });

    const response = (await createInviteHandler(event)) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    // The raw token must only appear in the inviteUrl fragment
    expect(response.result).toHaveProperty('inviteUrl');
    expect((response.result as Record<string, unknown>).inviteUrl).toMatch(/#token=.+$/);
    expect((response.result as Record<string, unknown>).inviteUrl).toContain(rawToken);
    // Other response fields must NOT contain the raw token
    expect(JSON.stringify((response.result as Record<string, unknown>).invitation)).not.toContain(
      rawToken,
    );
    expect(response.result).not.toHaveProperty('token');
  });
});

// ---------------------------------------------------------------
// POST /api/invitations/redeem
// ---------------------------------------------------------------

describe('POST /api/invitations/redeem', () => {
  beforeEach(() => {
    mockStore.getRegistrationState.mockResolvedValue({
      mode: 'complete',
      ownerUserId: 'owner-user-id-42',
      bootstrappedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('rejects invalid token with neutral generic error', async () => {
    mockReadBody.mockResolvedValue({
      token: 'invalid-token-value',
      name: 'New User',
      email: 'newuser@example.com',
      password: 'password12345678',
    });
    mockStore.claimInvitation.mockRejectedValue(new Error('Invitation not found'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // Must not leak reasonCodes or lifecycle/state information — neutral contract
    expect(response.error!.reasonCodes).toBeUndefined();
    // Invalid tokens are terminal failures — never retryable
    expect(response.error!.retryable).toBe(false);
    expect(JSON.stringify(response)).not.toContain('invalid-token-value');
    // Must not leak the raw token value
  });

  it('rejects malformed email before claiming invitation', async () => {
    mockReadBody.mockResolvedValue({
      token: 'some-valid-token-value',
      name: 'New User',
      email: 'a@b',
      password: 'password12345678',
    });

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    // claimInvitation must NOT be called — email rejected before claim
    expect(mockStore.claimInvitation).not.toHaveBeenCalled();
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // Validation errors are user-correctable (reasonCode starts with validation.)
    expect(response.error!.retryable).toBe(true);
    // Must not leak the email value
    expect(JSON.stringify(response)).not.toContain('a@b');
    expect(JSON.stringify(response)).not.toContain('invalid');
  });

  it('grants redeemed members read-only observe access', async () => {
    const claimId = 'claim-for-redeem-01';
    const redeemedUserId = 'redeemed-user-abc-456';
    const validToken = 'valid-token-sixty-four-chars-for-test-purposes-0123456789abcdef';
    mockReadBody.mockResolvedValue({
      token: validToken,
      name: 'Redeemed User',
      email: 'redeemed@example.com',
      password: 'long-enough-password',
    });
    mockStore.claimInvitation.mockResolvedValue({ claimId });
    mockCreateUser.mockResolvedValue({
      user: { id: redeemedUserId },
    });
    mockStore.upsertActorMembership.mockResolvedValue(undefined);
    mockStore.completeInvitationRedemption.mockResolvedValue(undefined);

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    // Membership provisioning is atomic with redemption inside the workflow store.
    expect(mockStore.upsertActorMembership).not.toHaveBeenCalled();
    // Verify redemption was completed with the correct IDs and requestId
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledWith(
      claimId,
      redeemedUserId,
      expect.objectContaining({
        requestId: expect.any(String),
        provisionReadOnlyMembership: true,
      }),
    );
    // Route must NOT produce its own audit — store handles it
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
    // Verify the raw token never appears in the response
    expect(response.status).toBe('ok');
    expect(JSON.stringify(response)).not.toContain(validToken);
    expect(response.result).not.toHaveProperty('token');
  });

  it('rejects revoked token with same generic error as invalid token', async () => {
    mockReadBody.mockResolvedValue({
      token: 'some-revoked-token',
      name: 'Attacker',
      email: 'attacker@example.com',
      password: 'password12345678',
    });
    mockStore.claimInvitation.mockRejectedValue(new Error('Invitation has been revoked'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // Must not distinguish revoked from invalid
    expect(JSON.stringify(response)).not.toContain('revoked');
  });

  it('rejects replayed token with same generic error', async () => {
    mockReadBody.mockResolvedValue({
      token: 'replayed-token-value',
      name: 'Replayer',
      email: 'replayer@example.com',
      password: 'password12345678',
    });
    // claimInvitation throws on replayed (already claimed/redeemed) tokens
    mockStore.claimInvitation.mockRejectedValue(new Error('Invitation already claimed'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // Must not leak the token value or distinguish the failure reason
    expect(JSON.stringify(response)).not.toContain('replayed-token-value');
    expect(JSON.stringify(response)).not.toContain('claimed');
  });

  it('fails with 400 when createUser fails (non-duplicate) — does not redeem invitation', async () => {
    const claimId = 'claim-nonrecoverable-001';
    mockReadBody.mockResolvedValue({
      token: 'some-token-value-here',
      name: 'New User',
      email: 'newuser@example.com',
      password: 'password12345678',
    });
    mockStore.claimInvitation.mockResolvedValue({ claimId });
    // createUser fails with a non-duplicate error
    mockCreateUser.mockRejectedValue(new Error('Database connection error'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // completeInvitationRedemption must NOT be called — invitation stays claimed
    expect(mockStore.completeInvitationRedemption).not.toHaveBeenCalled();
    // The claim is left stranded; no permanent state change
    expect(mockStore.upsertActorMembership).not.toHaveBeenCalled();
    // No redemption audit should be produced
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
    expect(response.status).toBe('error');
  });

  it('recovers via listUsers when createUser fails due to duplicate email', async () => {
    const claimId = 'claim-recovery-002';
    const existingUserId = 'recovered-user-789';
    mockReadBody.mockResolvedValue({
      token: 'another-valid-token',
      name: 'Existing User',
      email: 'existing@example.com',
      password: 'password12345678',
    });
    mockStore.claimInvitation.mockResolvedValue({ claimId });
    // createUser throws duplicate email error
    mockCreateUser.mockRejectedValue(new Error('User with this email already exists'));
    mockListUsers.mockResolvedValue({
      users: [{ id: existingUserId, email: 'existing@example.com' }],
    });
    mockStore.completeInvitationRedemption.mockResolvedValue(undefined);
    mockStore.upsertActorMembership.mockResolvedValue(undefined);

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    // Should have called listUsers to find the existing user
    expect(mockListUsers).toHaveBeenCalledTimes(1);
    // Should complete redemption with the recovered user ID
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledWith(
      claimId,
      existingUserId,
      expect.objectContaining({
        requestId: expect.any(String),
        provisionReadOnlyMembership: false,
      }),
    );
    expect(mockStore.upsertActorMembership).not.toHaveBeenCalled();
    expect(response.status).toBe('ok');
    // No route-level audit — store handles it
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
  });

  it('returns 500 when completeInvitationRedemption fails after createUser', async () => {
    const claimId = 'claim-finalize-fail-004';
    const redeemedUserId = 'finalize-fail-user';
    mockReadBody.mockResolvedValue({
      token: 'finalize-fail-token',
      name: 'Finalize Fail',
      email: 'finalize-fail@example.com',
      password: 'password12345678',
    });
    mockStore.claimInvitation.mockResolvedValue({ claimId });
    mockCreateUser.mockResolvedValue({ user: { id: redeemedUserId } });
    // completeInvitationRedemption throws
    mockStore.completeInvitationRedemption.mockRejectedValue(new Error('Update failed'));

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 500);
    expect(response.error!.code).toBe('INVITATION_FAILED');
    expect(response.status).toBe('error');
    // upsertActorMembership should not be called since finalization failed
    expect(mockStore.upsertActorMembership).not.toHaveBeenCalled();
    // No route-level audit
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
  });

  it('produces exactly one redemption audit via store (no route-level audit)', async () => {
    const claimId = 'claim-audit-005';
    const redeemedUserId = 'audit-check-user';
    mockReadBody.mockResolvedValue({
      token: 'audit-check-token',
      name: 'Audit Check',
      email: 'audit-check@example.com',
      password: 'password12345678',
    });
    mockStore.claimInvitation.mockResolvedValue({ claimId });
    mockCreateUser.mockResolvedValue({ user: { id: redeemedUserId } });
    mockStore.completeInvitationRedemption.mockResolvedValue(undefined);
    mockStore.upsertActorMembership.mockResolvedValue(undefined);

    const response = (await redeemHandler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    // CompleteInvitationRedemption was called — its internal audit is the only one
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledWith(
      claimId,
      redeemedUserId,
      expect.objectContaining({
        requestId: expect.any(String),
        provisionReadOnlyMembership: true,
      }),
    );
    // Route must NOT produce its own audit record
    expect(mockStore.appendAuditRecord).not.toHaveBeenCalled();
  });
});
