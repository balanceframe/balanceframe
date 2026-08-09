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
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'actor-1',
    capability: 'notification:admin',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'actor-1'),
  requireAuthorization: mockRequireAuthorization,
  sanitizeError: vi.fn((err, _requestId, code, retryable) => ({
    code,
    message: String(err),
    retryable,
  })),
  okEnvelope: (result: unknown) => ({ status: 'ok', result }),
  errorEnvelope: (code: string, message: string) => ({ status: 'error', error: { code, message } }),
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

  it('rejects unauthorized callers before reading body or mutating the store', async () => {
    mockRequireAuthorization.mockResolvedValueOnce({
      ok: false,
      info: null,
      response: { status: 'error', error: { code: 'FORBIDDEN' } },
    });
    const response = await handler({ context: { auth: { authenticated: true } } });
    expect(response.error.code).toBe('FORBIDDEN');
    expect(mockReadBody).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('allows an authorized caller to mutate policy in the same space', async () => {
    const response = await handler({
      context: { auth: { authenticated: true, actorId: 'actor-1', spaceId: 'space-a' } },
    });
    expect(response.status).toBe('ok');
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ spaceId: 'space-a' }));
  });

  it('rejects a body space outside the authorized space scope', async () => {
    mockReadBody.mockResolvedValueOnce({ spaceId: 'space-b', policy: {} });
    const response = await handler({
      context: { auth: { authenticated: true, actorId: 'actor-1', spaceId: 'space-a' } },
    });
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('SPACE_SCOPE_MISMATCH');
    expect(mockSave).not.toHaveBeenCalled();
  });
});
