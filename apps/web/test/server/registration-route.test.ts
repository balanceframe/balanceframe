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

const {
  mockReadBody,
  mockSetResponseStatus,
  mockCreateUser,
  mockGetWorkflowStore,
} = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockSetResponseStatus: vi.fn(),
  mockCreateUser: vi.fn(),
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
// ---------------------------------------------------------------------------

vi.mock('../../lib/auth', () => ({
  auth: {
    api: {
      createUser: mockCreateUser,
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

    const response = await configHandler(mockEvent()) as ResponseEnvelope;

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

    const response = await configHandler(mockEvent()) as ResponseEnvelope;

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
  });

  it('rejects malformed body with stable generic error', async () => {
    mockReadBody.mockResolvedValue({});

    const response = await bootstrapHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      400,
    );
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

    const response = await bootstrapHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      400,
    );
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

    const response = await bootstrapHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      400,
    );
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    // No indication of what went wrong
    expect(JSON.stringify(response)).not.toContain('wrong');
    expect(JSON.stringify(response)).not.toContain('invalid secret');
    expect(JSON.stringify(response)).not.toContain(BOOTSTRAP_SECRET);
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

    const response = await bootstrapHandler(mockEvent()) as ResponseEnvelope;

    // Verifies createUser was called without forwarded request headers
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    const createUserArg = mockCreateUser.mock.calls[0][0] as Record<string, unknown>;
    expect(createUserArg).toHaveProperty('body');
    expect(createUserArg).not.toHaveProperty('headers');
    expect((createUserArg.body as Record<string, unknown>)).toMatchObject({
      name: 'Owner User',
      email: 'owner@example.com',
    });
    // Verifies claimBootstrap received a claimId and the same claimId
    // flows to finalizeBootstrap with the returned Better Auth user ID
    expect(mockStore.claimBootstrap).toHaveBeenCalledTimes(1);
    const claimBootstrapInput = mockStore.claimBootstrap.mock.calls[0][0] as Record<string, unknown>;
    expect(claimBootstrapInput).toMatchObject({
      name: 'Owner User',
      email: 'owner@example.com',
    });
    expect(typeof claimBootstrapInput.claimId).toBe('string');
    expect(mockStore.finalizeBootstrap).toHaveBeenCalledWith({
      claimId: claimBootstrapInput.claimId,
      ownerUserId: baUserId,
    });
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      message: 'Instance owner account created. You can now sign in.',
    });
  });

  it('rejects duplicate bootstrap with stable generic error', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Second User',
      email: 'second@example.com',
      password: 'another-secure-password',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    // Store throws because owner already exists
    mockStore.claimBootstrap.mockRejectedValue(
      new Error('Bootstrap already completed'),
    );

    const response = await bootstrapHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      503,
    );
    expect(response.error!.code).toBe('REGISTRATION_FAILED');
    // Must not reveal that bootstrap is already completed
    expect(JSON.stringify(response)).not.toContain('already');
    expect(JSON.stringify(response)).not.toContain('completed');
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

    const response = await createInviteHandler(event) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      403,
    );
    expect(response.error!.code).toBe('FORBIDDEN');
    expect(response.error!.message).toBe(
      'Only the instance owner can perform this action',
    );
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

    const response = await createInviteHandler(event) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    // The raw token must only appear in the inviteUrl fragment
    expect(response.result).toHaveProperty('inviteUrl');
    expect((response.result as Record<string, unknown>).inviteUrl).toMatch(
      /#token=.+$/,
    );
    expect((response.result as Record<string, unknown>).inviteUrl).toContain(
      rawToken,
    );
    // Other response fields must NOT contain the raw token
    expect(
      JSON.stringify((response.result as Record<string, unknown>).invitation),
    ).not.toContain(rawToken);
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
    mockStore.claimInvitation.mockRejectedValue(
      new Error('Invitation not found'),
    );

    const response = await redeemHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      400,
    );
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // Must not leak the token value or the specific reason
    expect(JSON.stringify(response)).not.toContain('invalid-token-value');
    expect(response.error).not.toHaveProperty('reasonCodes');
  });

  it('succeeds and calls completeInvitationRedemption with empty membership', async () => {
    const claimId = 'claim-for-redeem-01';
    const redeemedUserId = 'redeemed-user-abc-456';
    const validToken =
      'valid-token-sixty-four-chars-for-test-purposes-0123456789abcdef';
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
    mockStore.appendAuditRecord.mockResolvedValue(undefined);

    const response = await redeemHandler(mockEvent()) as ResponseEnvelope;

    // Verify empty membership was assigned
    expect(mockStore.upsertActorMembership).toHaveBeenCalledWith(
      redeemedUserId,
      'active',
      [],
      '*',
    );
    // Verify redemption was completed with the correct IDs
    expect(mockStore.completeInvitationRedemption).toHaveBeenCalledWith(
      claimId,
      redeemedUserId,
    );
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
    mockStore.claimInvitation.mockRejectedValue(
      new Error('Invitation has been revoked'),
    );

    const response = await redeemHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      400,
    );
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
    mockStore.claimInvitation.mockRejectedValue(
      new Error('Invitation already claimed'),
    );

    const response = await redeemHandler(mockEvent()) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(
      expect.anything(),
      400,
    );
    expect(response.error!.code).toBe('INVITATION_FAILED');
    // Must not leak the token value or distinguish the failure reason
    expect(JSON.stringify(response)).not.toContain('replayed-token-value');
    expect(JSON.stringify(response)).not.toContain('claimed');
  });
});
