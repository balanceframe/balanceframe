/**
 * GET /api/review/categories — exposes the selected Actual budget's live category catalog.
 *
 * Existing pending review items may predate category enrichment, so the correction UI must
 * receive all current, non-deleted Actual categories independently of persisted suggestions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateDefaultConnectionManager,
  mockLoadConfig,
  mockWithConnection,
  mockSetResponseStatus,
  mockRequireAuthorization,
} = vi.hoisted(() => {
  const mockLoadConfig = vi.fn();
  const mockWithConnection = vi.fn();
  return {
    mockLoadConfig,
    mockWithConnection,
    mockCreateDefaultConnectionManager: vi.fn(() => ({
      loadConfig: mockLoadConfig,
      withConnection: mockWithConnection,
    })),
    mockSetResponseStatus: vi.fn(),
    mockRequireAuthorization: vi.fn(),
  };
});

vi.mock('@balanceframe/application', async (importOriginal) => {
  const original = await importOriginal<typeof import('@balanceframe/application')>();
  return {
    ...original,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
  };
});

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  setResponseStatus: mockSetResponseStatus,
}));

vi.mock('../../server/utils/workflow-store', () => ({
  requireAuthorization: mockRequireAuthorization,
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  okEnvelope: (result: unknown) => ({
    status: 'ok' as const,
    result,
    error: null,
  }),
  errorEnvelope: (code: string, message: string, _auth: unknown, retryable = false) => ({
    status: 'error' as const,
    result: null,
    error: { code, message, retryable },
  }),
  sanitizeError: (error: unknown, _requestId: string, code: string, retryable = false) => ({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable,
  }),
}));

import handler from '../../server/api/review/categories.get';

describe('GET /api/review/categories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthorization.mockResolvedValue({
      ok: true,
      info: {
        actorId: 'test-actor',
        capability: 'observe',
        allowed: true,
      },
    });
    mockLoadConfig.mockResolvedValue({
      version: 1,
      serverUrl: 'http://actual_server:5006',
      budgetId: 'budget-1',
      budgetName: 'Household',
      groupId: 'group-1',
    });
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) =>
        operation({
          synchronization: {
            snapshot: {
              categories: [
                {
                  id: 'cat-rent',
                  name: 'Rent',
                  groupName: 'Housing',
                  isIncome: false,
                  deleted: false,
                },
                {
                  id: 'cat-deleted',
                  name: 'Old category',
                  groupName: 'Archived',
                  isIncome: false,
                  deleted: true,
                },
                {
                  id: 'cat-fuel',
                  name: 'Fuel',
                  groupName: 'Transportation',
                  isIncome: false,
                  deleted: false,
                },
                { id: '', name: 'Malformed', deleted: false },
              ],
            },
          },
        }),
    );
  });

  it('returns every current Actual category for correcting existing review items', async () => {
    const response = await handler({ context: { auth: { authenticated: true } } });

    expect(response.status).toBe('ok');
    expect(response.result?.categories).toEqual([
      {
        id: 'cat-rent',
        name: 'Rent',
        groupName: 'Housing',
        isIncome: false,
      },
      {
        id: 'cat-fuel',
        name: 'Fuel',
        groupName: 'Transportation',
        isIncome: false,
      },
    ]);
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
  });


  it('does not disclose categories without the observe capability', async () => {
    const deniedResponse = {
      status: 'error' as const,
      result: null,
      error: {
        code: 'CAPABILITY_DENIED',
        message: 'Required capability not granted',
        retryable: false,
      },
    };
    mockRequireAuthorization.mockResolvedValue({
      ok: false,
      response: deniedResponse,
    });

    const response = await handler({ context: { auth: { authenticated: true } } });

    expect(response).toBe(deniedResponse);
    expect(mockCreateDefaultConnectionManager).not.toHaveBeenCalled();
    expect(mockWithConnection).not.toHaveBeenCalled();
  });
  it('returns not_connected without opening Actual when no budget is selected', async () => {
    mockLoadConfig.mockResolvedValue(null);

    const response = await handler({ context: { auth: { authenticated: true } } });

    expect(response.status).toBe('error');
    expect(response.error).toEqual({
      code: 'not_connected',
      message: 'No ledger connected. Configure an Actual budget first.',
      retryable: true,
    });
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
  });
});
