/**
 * TDD: POST /api/reports/views body validation.
 *
 * Tests the handler-level validation and envelope response without
 * requiring a Nitro runtime.  Uses the same mock pattern as
 * registration-route.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockReadBody,
  mockSetResponseStatus,
  mockGetWorkflowStore,
  mockRestore,
  mockWithConnection,
  mockCreateDefaultConnectionManager,
  mockCreateNativeAnalysisProtocol,
} = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockSetResponseStatus: vi.fn(),
  mockGetWorkflowStore: vi.fn(),
  mockRestore: vi.fn(),
  mockWithConnection: vi.fn(),
  mockCreateDefaultConnectionManager: vi.fn(() => ({
    restore: mockRestore,
    withConnection: mockWithConnection,
  })),
  mockCreateNativeAnalysisProtocol: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @balanceframe/application — replace connection/protocol factories
// with deterministic test doubles so the handler can exercise its full path
// without a real ledger.
// ---------------------------------------------------------------------------

vi.mock('@balanceframe/application', async (i) => {
  const a = await i();
  return {
    ...a,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
    createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
  };
});

// ---------------------------------------------------------------------------
// Mock h3 — defineEventHandler unwraps so we get the raw handler function
// ---------------------------------------------------------------------------

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mockReadBody,
  setResponseStatus: mockSetResponseStatus,
}));

// ---------------------------------------------------------------------------
// Mock workflow-store — provides getWorkflowStore (per-test store injection)
// plus pure helpers used by the handler
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  buildAuthorizationInfo: () => null,
  getActorId: () => 'test-actor',
  sanitizeError: vi.fn((err: unknown, _requestId: string, code: string, retryable?: boolean) => ({
    code,
    message: err instanceof Error ? err.message : String(err),
    retryable: retryable ?? false,
  })),
  okEnvelope: (result: unknown, _auth: unknown, requestId?: string) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  }),
  errorEnvelope: (
    code: string,
    message: string,
    _auth: unknown,
    retryable?: boolean,
    requestId?: string,
  ) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'error' as const,
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message, retryable: retryable ?? false },
  }),
}));

// ---------------------------------------------------------------------------
// Import handler (after all mocks are in place)
// ---------------------------------------------------------------------------

import handler from '../../server/api/reports/views.post';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEvent() {
  return { context: {} };
}

function validBody(): Record<string, unknown> {
  return {
    name: 'My Saved View',
    viewType: 'attention',
    scope: { month: '2026-07', detailed: true },
    sort: 'name:asc',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetWorkflowStore.mockReturnValue({
    store: {
      createSavedView: vi.fn(
        async (input: {
          name: string;
          viewType: string;
          scope: Record<string, unknown>;
          sort?: string;
        }) => ({
          viewId: 'view_default',
          name: input.name,
          viewType: input.viewType,
          scope: input.scope,
          ...(input.sort ? { sort: input.sort } : {}),
          createdAt: '2026-07-27T12:00:00Z',
        }),
      ),
      listSavedViews: vi.fn(async () => []),
    },
  });
  mockRestore.mockResolvedValue({
    connector: { name: 'm' },
    budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false },
    synchronization: {},
  });
  mockWithConnection.mockImplementation(
    async (operation: (connected: unknown) => Promise<unknown>) => operation(await mockRestore()),
  );
  mockCreateNativeAnalysisProtocol.mockResolvedValue({ createSavedView: vi.fn() });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/reports/views', () => {
  it('rejects malformed JSON body with 400', async () => {
    mockReadBody.mockRejectedValue(new Error('JSON parse error'));

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.status).toBe('error');
    expect(response.error).not.toBeNull();
    expect(response.error!.code).toBe('INVALID_JSON');
  });

  it('rejects missing name with 422', async () => {
    mockReadBody.mockResolvedValue({
      name: '',
      viewType: 'attention',
      scope: {},
    });

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 422);
    expect(response.status).toBe('error');
    expect(response.error).not.toBeNull();
    expect(response.error!.code).toBe('MISSING_NAME');
  });

  it('rejects missing viewType with 422', async () => {
    mockReadBody.mockResolvedValue({
      name: 'My View',
      viewType: '',
      scope: {},
    });

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 422);
    expect(response.status).toBe('error');
    expect(response.error).not.toBeNull();
    expect(response.error!.code).toBe('MISSING_VIEW_TYPE');
  });

  it('accepts valid body and returns ok envelope with persisted view', async () => {
    mockReadBody.mockResolvedValue(validBody());

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).not.toHaveBeenCalled();
    expect(response.status).toBe('ok');
    expect(response.error).toBeNull();
    expect(response.result).not.toBeNull();
    expect(response.result).toHaveProperty('view');
    expect((response.result as Record<string, unknown>).view).toMatchObject({
      name: 'My Saved View',
      viewType: 'attention',
      scope: { month: '2026-07', detailed: true },
      sort: 'name:asc',
    });
    expect((response.result as Record<string, unknown>).view).toHaveProperty('viewId');
    expect((response.result as Record<string, unknown>).view).toHaveProperty('createdAt');
  });

  it('creates a saved view from the workflow store without opening a ledger connection', async () => {
    mockWithConnection.mockRejectedValue(
      Object.assign(new Error('No BalanceFrame connection configured.'), {
        code: 'not_connected',
      }),
    );
    mockReadBody.mockResolvedValue(validBody());

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect(response.result).toHaveProperty('view');
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
  });

  it('persists exact scope as passed in body', async () => {
    const scope = { month: '2026-07', detailed: true, tags: ['budget', 'quarterly'] };
    mockReadBody.mockResolvedValue({ name: 'Q3 View', viewType: 'budget_summary', scope });

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect((response.result as Record<string, unknown>).view).toMatchObject({ scope });
  });

  it('defaults scope to empty object when missing', async () => {
    mockReadBody.mockResolvedValue({ name: 'Minimal', viewType: 'attention' });

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect((response.result as Record<string, unknown>).view).toMatchObject({ scope: {} });
  });

  it('defaults scope to empty object when scope is not an object', async () => {
    mockReadBody.mockResolvedValue({
      name: 'Bad Scope',
      viewType: 'attention',
      scope: 'not-an-object',
    });

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    expect((response.result as Record<string, unknown>).view).toMatchObject({ scope: {} });
  });

  it('makes sort optional', async () => {
    mockReadBody.mockResolvedValue({ name: 'No Sort', viewType: 'attention', scope: {} });

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(response.status).toBe('ok');
    const view = (response.result as Record<string, unknown>).view as Record<string, unknown>;
    expect(view.sort).toBeUndefined();
  });

  it('returns 503 when store is unavailable', async () => {
    mockGetWorkflowStore.mockReturnValue({ error: 'Store not configured' });
    mockReadBody.mockResolvedValue(validBody());

    const response = (await handler(mockEvent())) as ResponseEnvelope;

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(response.status).toBe('error');
    expect(response.error!.code).toBe('STORE_UNAVAILABLE');
  });
});
