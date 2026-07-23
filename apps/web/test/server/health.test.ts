/**
 * Tests for the health check endpoints.
 *
 * Covers:
 * - /api/health returns basic process info (always ok)
 * - /api/health/ready returns ok when all checks pass
 * - /api/health/ready returns 503 when auth migration failed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — must be set up before importing the handlers
// ---------------------------------------------------------------------------

const { mockSetResponseStatus } = vi.hoisted(() => ({
  mockSetResponseStatus: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  setResponseStatus: mockSetResponseStatus,
}));

const { mockResolveAuthDbPath } = vi.hoisted(() => ({
  mockResolveAuthDbPath: vi.fn(() => './data/auth.db'),
}));

vi.mock('../../lib/auth-db-path', () => ({
  resolveAuthDbPath: mockResolveAuthDbPath,
}));

// auth-migration-status exports mutable module-level `let` bindings.
// Mock with an internal state object so tests control the values via
// the same exports the source code uses (setAuthMigrationFailed etc).
vi.mock('../../server/utils/auth-migration-status', () => {
  const state = { failed: false, message: null as string | null };

  return {
    get authMigrationFailed() {
      return state.failed;
    },
    get authMigrationMessage() {
      return state.message;
    },
    setAuthMigrationFailed(message: string) {
      state.failed = true;
      state.message = message;
    },
    resetAuthMigrationStatus() {
      state.failed = false;
      state.message = null;
    },
  };
});

const { mockGetWorkflowStore } = vi.hoisted(() => ({
  mockGetWorkflowStore: vi.fn(),
}));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
}));

// ---------------------------------------------------------------------------
// Import handlers (after mocks)
// ---------------------------------------------------------------------------

import healthHandler from '../../server/api/health.get';
import readyHandler from '../../server/api/health/ready.get';

// Import mock-controller functions from the mocked module
import {
  setAuthMigrationFailed,
  resetAuthMigrationStatus,
} from '../../server/utils/auth-migration-status';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Mock event type matching what the handlers expect from context
interface MockEvent {
  context: {
    runtimeConfig?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/api/health — liveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok status with version', async () => {
    const event: MockEvent = { context: {} };
    const result = await (healthHandler as (event: MockEvent) => unknown)(
      event,
    ) as Record<string, unknown>;

    expect(result.status).toBe('ok');
    expect(result.version).toBe('0.1.0');
  });
});

describe('/api/health/ready — readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: all checks pass
    mockResolveAuthDbPath.mockReturnValue('./data/auth.db');
    mockGetWorkflowStore.mockReturnValue({ store: {} as never });

    // Reset migration state via the mock's exported controller
    resetAuthMigrationStatus();
  });

  it('returns ok when all dependencies are healthy', async () => {
    const event: MockEvent = {
      context: { runtimeConfig: { apiToken: 's3cret' } },
    };

    const result = await (readyHandler as (event: MockEvent) => unknown)(
      event,
    ) as Record<string, unknown>;

    expect(result.status).toBe('ok');
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
  });

  it('returns degraded and 503 when auth migration failed', async () => {
    // Simulate migration failure using the mock's controller function
    setAuthMigrationFailed('table already exists');

    const event: MockEvent = {
      context: { runtimeConfig: { apiToken: 's3cret' } },
    };

    const result = await (readyHandler as (event: MockEvent) => unknown)(
      event,
    ) as Record<string, unknown>;

    expect(result.status).toBe('degraded');
    expect((result.checks as Record<string, string>).authMigration).toContain(
      'failed',
    );
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
  });

  it('returns degraded when auth DB path is empty', async () => {
    mockResolveAuthDbPath.mockReturnValue('');

    const event: MockEvent = {
      context: { runtimeConfig: { apiToken: 's3cret' } },
    };

    const result = await (readyHandler as (event: MockEvent) => unknown)(
      event,
    ) as Record<string, unknown>;

    expect(result.status).toBe('degraded');
    expect((result.checks as Record<string, string>).authDb).toBe('missing');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
  });

  it('returns degraded when workflow store returns an error', async () => {
    mockGetWorkflowStore.mockReturnValue({
      error: 'Failed to open workflow database',
    });

    const event: MockEvent = {
      context: { runtimeConfig: { apiToken: 's3cret' } },
    };

    const result = await (readyHandler as (event: MockEvent) => unknown)(
      event,
    ) as Record<string, unknown>;

    expect(result.status).toBe('degraded');
    expect((result.checks as Record<string, string>).workflowStore).toBe(
      'unavailable',
    );
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
  });

  it('returns degraded when no auth is configured', async () => {
    const event: MockEvent = { context: { runtimeConfig: {} } };

    const result = await (readyHandler as (event: MockEvent) => unknown)(
      event,
    ) as Record<string, unknown>;

    expect(result.status).toBe('degraded');
    expect((result.checks as Record<string, string>).authConfigured).toBe(
      'missing',
    );
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
  });
});
