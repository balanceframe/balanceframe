import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';

const state = vi.hoisted(() => ({ store: null as SqliteWorkflowStore | null }));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  setResponseStatus: vi.fn(),
  getQuery: () => ({}),
}));
vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: () => ({ store: state.store }),
  getActorId: () => 'reader',
  buildAuthorizationInfo: () => ({ actorId: 'reader', capability: 'observe', allowed: true }),
  requireAuthorization: async () => ({
    ok: true,
    info: { actorId: 'reader', capability: 'notification:receive', allowed: true },
  }),
  okEnvelope: (result: unknown) => ({ status: 'ok', result }),
  errorEnvelope: (code: string) => ({ status: 'error', error: { code } }),
}));
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@balanceframe/application')>()),
  createDefaultConnectionManager: () => ({ loadConfig: async () => ({ budgetId: 'selected' }) }),
}));
import handler from '../../server/api/notifications/status.get';

let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'notification-status-scope-'));
  state.store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
  await state.store.upsertActorMembership(
    'reader',
    'active',
    ['observe', 'notification:receive', 'liquidity:full-read'],
    '*',
  );
  state.store.liquidity.setResourceGrant({
    actorId: 'reader',
    budgetId: 'selected',
    resourceKind: 'budget',
    resourceId: 'selected',
    capability: 'full-read',
    granted: true,
    now: new Date().toISOString(),
  });
});
afterEach(() => {
  state.store?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('selected-budget authorized notification status', () => {
  it('counts only this recipient’s currently readable financial events and reflects revocation', async () => {
    const store = state.store!;
    for (const scope of [
      {
        budgetId: 'selected',
        recipientId: 'reader',
        classification: 'budget_alert',
        correlationId: null,
      },
      {
        budgetId: 'private',
        recipientId: 'reader',
        classification: 'budget_alert',
        correlationId: null,
      },
      {
        budgetId: 'selected',
        recipientId: 'other',
        classification: 'budget_alert',
        correlationId: null,
      },
      {
        budgetId: 'selected',
        recipientId: 'reader',
        classification: 'transfer_needs_attention',
        correlationId: 'liquidity-finding:hidden',
      },
    ]) {
      for (const failed of [false, true]) {
        const event = await store.createNotificationEvent({
          ...scope,
          scope: `budget:${scope.budgetId}`,
          payload: { title: 'Financial finding' },
          policyVersion: 'v1',
        });
        const outbox = await store.enqueueNotification({
          eventId: event.id,
          deliveryKey: event.id,
          channelType: 'in_app',
        });
        if (failed) {
          await store.claimNotificationDelivery(outbox.id, outbox.id);
          await store.failNotificationDelivery(
            outbox.id,
            outbox.id,
            'Temporary delivery failure',
            true,
          );
        }
      }
    }
    const event = { context: { auth: { authenticated: true, actorId: 'reader' } } };
    expect((await handler(event)).result).toMatchObject({ pendingCount: 1, failedCount: 1 });
    store.liquidity.setResourceGrant({
      actorId: 'reader',
      budgetId: 'selected',
      resourceKind: 'budget',
      resourceId: 'selected',
      capability: 'full-read',
      granted: false,
      now: new Date().toISOString(),
    });
    expect((await handler(event)).result).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });
});
