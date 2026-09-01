import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReadBody, mockSave, mockRequireAuthorization } = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockSave: vi.fn(),
  mockRequireAuthorization: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mockReadBody,
  setResponseStatus: vi.fn(),
}));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: { saveNotificationPolicy: mockSave } })),
  getActorId: vi.fn(() => 'actor-1'),
  requireAuthorization: mockRequireAuthorization,
  sanitizeError: vi.fn((err, _requestId, code, retryable) => ({
    code,
    message: String(err),
    retryable,
  })),
  okEnvelope: (result: unknown) => ({ status: 'ok', result }),
  errorEnvelope: (code: string, message: string, authorization: unknown) => ({
    status: 'error',
    authorization,
    error: { code, message },
  }),
}));

import handler from '../../server/api/notifications/policy.post';

describe('POST /api/notifications/policy authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthorization.mockResolvedValue({
      ok: true,
      info: { actorId: 'actor-1', capability: 'notification:admin', allowed: true },
    });
    mockReadBody.mockResolvedValue({ spaceId: 'space-a', policy: { maxRetries: 3 } });
    mockSave.mockResolvedValue({ id: 'policy-1', spaceId: 'space-a' });
  });

  it('rejects an invalid body before checking authorization or mutating the store', async () => {
    mockReadBody.mockRejectedValueOnce(new SyntaxError('invalid JSON'));
    const event = { context: { auth: { authenticated: true, user: { id: 'user-1' } } } };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('INVALID_BODY');
    expect(response.authorization).toBeNull();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('rejects a missing body space before checking authorization or mutating the store', async () => {
    mockReadBody.mockResolvedValueOnce({ policy: { maxRetries: 3 } });
    const event = { context: { auth: { authenticated: true, user: { id: 'user-1' } } } };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('MISSING_SPACE_ID');
    expect(response.authorization).toBeNull();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('rejects unauthorized callers after forwarding the body space to authorization', async () => {
    const forbidden = { status: 'error', error: { code: 'FORBIDDEN' } };
    mockRequireAuthorization.mockResolvedValueOnce({
      ok: false,
      info: null,
      response: forbidden,
    });
    const event = { context: { auth: { authenticated: false } } };

    const response = await handler(event);

    expect(response).toBe(forbidden);
    expect(mockReadBody).toHaveBeenCalledWith(event);
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-a',
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('allows a Better Auth session without auth spaceId when membership authorizes the body space', async () => {
    const event = { context: { auth: { authenticated: true, user: { id: 'user-1' } } } };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-a',
    );
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-a',
        policy: { maxRetries: 3 },
      }),
    );
    expect(mockRequireAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      mockSave.mock.invocationCallOrder[0],
    );
  });

  it('allows an authorized caller to mutate policy in the requested space', async () => {
    const event = {
      context: { auth: { authenticated: true, actorId: 'actor-1', spaceId: 'space-a' } },
    };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-a',
    );
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ spaceId: 'space-a' }));
  });

  it('returns the authorization denial for a restricted membership in the requested space', async () => {
    mockReadBody.mockResolvedValueOnce({ spaceId: 'space-b', policy: {} });
    const forbidden = { status: 'error', error: { code: 'FORBIDDEN' } };
    mockRequireAuthorization.mockImplementationOnce(async (_event, _capability, spaceId) =>
      spaceId === 'space-b'
        ? { ok: false, info: null, response: forbidden }
        : {
            ok: true,
            info: { actorId: 'actor-1', capability: 'notification:admin', allowed: true },
          },
    );
    const event = { context: { auth: { authenticated: true, user: { id: 'user-1' } } } };

    const response = await handler(event);

    expect(response).toBe(forbidden);
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-b',
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns a sanitized store failure after exact-scope authorization', async () => {
    mockSave.mockRejectedValueOnce(new Error('database unavailable'));
    const event = { context: { auth: { authenticated: true, user: { id: 'user-1' } } } };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('SAVE_FAILED');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-a',
    );
    expect(mockSave).toHaveBeenCalledOnce();
  });
});
