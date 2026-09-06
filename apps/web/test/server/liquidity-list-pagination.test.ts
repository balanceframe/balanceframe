import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
const state = vi.hoisted(() => ({ store: null as SqliteWorkflowStore | null }));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  setResponseStatus: vi.fn(),
  getQuery: (event: { query?: unknown }) => event.query ?? {},
}));
vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: () => ({ store: state.store }),
  getActorId: () => 'reader',
  buildAuthorizationInfo: () => ({ actorId: 'reader', capability: 'observe', allowed: true }),
  requireAuthorization: async () => ({
    ok: true,
    info: { actorId: 'reader', capability: 'observe', allowed: true },
  }),
  okEnvelope: (result: unknown) => ({ status: 'ok', result }),
  errorEnvelope: (code: string) => ({ status: 'error', error: { code } }),
  sanitizeError: () => ({ code: 'LIST_FAILED', message: 'Unavailable', retryable: false }),
}));
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@balanceframe/application')>()),
  createDefaultConnectionManager: () => ({ loadConfig: async () => ({ budgetId: 'selected' }) }),
}));
import findings from '../../server/api/findings/index.get';
import inbox from '../../server/api/notifications/inbox.get';
let directory: string;
const request = (offset = '0') => ({
  query: { limit: '1', offset },
  context: { auth: { authenticated: true, actorId: 'reader' } },
});
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T10:00:00.000Z'));
  directory = mkdtempSync(join(tmpdir(), 'liquidity-pagination-'));
  state.store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
  await state.store.upsertActorMembership(
    'reader',
    'active',
    ['observe', 'notification:receive', 'liquidity:full-read'],
    '*',
  );
  for (const budgetId of ['selected', 'private'])
    state.store.liquidity.setResourceGrant({
      actorId: 'reader',
      budgetId,
      resourceKind: 'budget',
      resourceId: budgetId,
      capability: 'full-read',
      granted: true,
      now: new Date().toISOString(),
    });
});
afterEach(() => {
  state.store?.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
describe('authorized financial list pagination', () => {
  it('applies selected budget and current finding permissions before visible page positions', async () => {
    const store = state.store!;
    const first = await store.createFinding({
      budgetId: 'selected',
      classification: 'budget_alert',
      severity: 'high',
      description: 'Visible first',
      evidence: {},
      actorId: 'reader',
    });
    const second = await store.createFinding({
      budgetId: 'selected',
      classification: 'budget_alert',
      severity: 'medium',
      description: 'Visible second',
      evidence: {},
      actorId: 'reader',
    });
    await store.createFinding({
      budgetId: 'private',
      classification: 'budget_alert',
      severity: 'critical',
      description: 'Other budget',
      evidence: {},
      actorId: 'reader',
    });
    await store.createFinding({
      budgetId: 'selected',
      classification: 'transfer_needs_attention',
      severity: 'critical',
      description: 'Private transfer',
      evidence: { transferId: 'hidden' },
      actorId: 'reader',
    });
    expect((await findings(request())).result.map((finding: { id: string }) => finding.id)).toEqual(
      [first.id],
    );
    expect(
      (await findings(request('1'))).result.map((finding: { id: string }) => finding.id),
    ).toEqual([second.id]);
  });
  it('applies selected budget, recipient and current transfer visibility before inbox pagination and counts', async () => {
    const store = state.store!;
    const visible: string[] = [];
    for (const [index, data] of [
      {
        budgetId: 'selected',
        recipientId: 'reader',
        classification: 'budget_alert',
        correlationId: null,
      },
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
    ].entries()) {
      vi.setSystemTime(new Date(`2026-09-06T10:00:0${index}.000Z`));
      const event = await store.createNotificationEvent({
        ...data,
        scope: `budget:${data.budgetId}`,
        policyVersion: 'v1',
        payload: { title: 'Finding' },
      });
      const outbox = await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: event.id,
        channelType: 'in_app',
      });
      if (index < 2) visible.unshift(outbox.id);
    }
    const first = (await inbox(request())).result;
    expect(first.items.map((item: { outbox: { id: string } }) => item.outbox.id)).toEqual([
      visible[0],
    ]);
    expect(first.count).toBe(1);
    const second = (await inbox(request('1'))).result;
    expect(second.items.map((item: { outbox: { id: string } }) => item.outbox.id)).toEqual([
      visible[1],
    ]);
    expect(second.count).toBe(1);
  });
});
