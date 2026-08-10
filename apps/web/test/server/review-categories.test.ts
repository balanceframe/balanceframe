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
  mockSetHeader,
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
    mockSetHeader: vi.fn(),
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
  setHeader: mockSetHeader,
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

import type { ConnectionConfig } from '@balanceframe/application';
import handler from '../../server/api/review/categories.get';

let configOrdinal = 0;

function routeConfig(caseId: string): ConnectionConfig {
  return {
    version: 1,
    serverUrl: `http://${caseId}.actual.test:5006`,
    budgetId: `${caseId}-budget`,
    budgetName: 'Household',
    groupId: `${caseId}-group`,
  };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('GET /api/review/categories', () => {
  beforeEach(() => {
    configOrdinal += 1;
    vi.clearAllMocks();
    mockRequireAuthorization.mockResolvedValue({
      ok: true,
      info: {
        actorId: 'test-actor',
        capability: 'observe',
        allowed: true,
      },
    });
    const config = routeConfig(`route-${configOrdinal}`);
    mockLoadConfig.mockResolvedValue(config);
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) =>
        operation({
          config,
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
    const event = { context: { auth: { authenticated: true } } };
    const response = await handler(event);

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
    expect(mockRequireAuthorization).toHaveBeenCalledOnce();
    expect(mockRequireAuthorization).toHaveBeenCalledWith(event, 'observe');
    expect(mockSetHeader).toHaveBeenCalledOnce();
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'private, no-store');
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
  });

  it('reuses the configured budget catalog across sequential requests', async () => {
    const firstResponse = await handler({ context: { auth: { authenticated: true } } });
    const secondResponse = await handler({ context: { auth: { authenticated: true } } });

    expect(firstResponse).toEqual(secondResponse);
    expect(firstResponse.status).toBe('ok');
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
  });

  it('keys a restored catalog by the active lifecycle config instead of the stale requested config', async () => {
    const requestedConfig = routeConfig(`route-stale-request-${configOrdinal}`);
    const activeConfig = routeConfig(`route-active-connection-${configOrdinal}`);
    mockLoadConfig.mockResolvedValue(requestedConfig);
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) =>
        operation({
          config: activeConfig,
          synchronization: {
            snapshot: {
              categories: [
                {
                  id: 'cat-active',
                  name: 'Active connection',
                  groupName: 'Active group',
                  isIncome: false,
                  deleted: false,
                },
              ],
            },
          },
        }),
    );

    const restoredResponse = await handler({
      context: { auth: { authenticated: true } },
    });

    expect(restoredResponse.status).toBe('ok');
    expect(restoredResponse.result?.categories).toEqual([
      {
        id: 'cat-active',
        name: 'Active connection',
        groupName: 'Active group',
        isIncome: false,
      },
    ]);

    mockLoadConfig.mockResolvedValue(activeConfig);
    const cachedActiveResponse = await handler({
      context: { auth: { authenticated: true } },
    });

    expect(cachedActiveResponse).toEqual(restoredResponse);
    expect(mockWithConnection).toHaveBeenCalledOnce();

    mockLoadConfig.mockResolvedValue(requestedConfig);
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) =>
        operation({
          config: requestedConfig,
          synchronization: {
            snapshot: {
              categories: [
                {
                  id: 'cat-requested',
                  name: 'Requested connection',
                  groupName: 'Requested group',
                  isIncome: false,
                  deleted: false,
                },
              ],
            },
          },
        }),
    );

    const requestedResponse = await handler({
      context: { auth: { authenticated: true } },
    });

    expect(requestedResponse.result?.categories).toEqual([
      {
        id: 'cat-requested',
        name: 'Requested connection',
        groupName: 'Requested group',
        isIncome: false,
      },
    ]);
    expect(requestedResponse.result?.categories).not.toContainEqual(
      expect.objectContaining({ id: 'cat-active' }),
    );
    expect(mockWithConnection).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent cold requests for the configured budget', async () => {
    const config = routeConfig(`route-concurrent-${configOrdinal}`);
    mockLoadConfig.mockResolvedValue(config);
    const releaseColdLoad = createDeferred();
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) => {
        await releaseColdLoad.promise;
        return operation({
          config,
          synchronization: {
            snapshot: {
              categories: [],
            },
          },
        });
      },
    );

    const requests = [
      handler({ context: { auth: { authenticated: true } } }),
      handler({ context: { auth: { authenticated: true } } }),
    ] as const;

    try {
      await vi.waitFor(() => {
        expect(mockLoadConfig).toHaveBeenCalledTimes(2);
        expect(mockWithConnection).toHaveBeenCalledTimes(1);
      });
    } finally {
      releaseColdLoad.resolve();
      await Promise.allSettled(requests);
    }

    const [firstResponse, secondResponse] = await Promise.all(requests);
    expect(firstResponse).toEqual(secondResponse);
    expect(firstResponse.status).toBe('ok');
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
  });

  it('does not disclose categories without the observe capability', async () => {
    const event = { context: { auth: { authenticated: true } } };
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

    const response = await handler(event);

    expect(mockRequireAuthorization).toHaveBeenCalledOnce();
    expect(mockRequireAuthorization).toHaveBeenCalledWith(event, 'observe');
    expect(mockSetHeader).toHaveBeenCalledOnce();
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'private, no-store');
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
