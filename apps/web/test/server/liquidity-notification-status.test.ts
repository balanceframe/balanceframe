import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import handler from '../../server/api/notifications/status.get';

// Load the Source Native store in Vitest's hoisted mock factory, not a stale workspace dist export.
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

const OWNER = 'notification-status-owner';
const READER = 'notification-status-reader';
const OTHER = 'notification-status-other-recipient';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const ownerControl = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: 'notification-status-owner-session',
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let budgetId = '';
let spaceId = '';
let membershipId = '';

function request(selectedSpace = spaceId) {
  const headers = new Map<string, string | number | readonly string[]>();
  return {
    node: {
      req: {
        headers: {
          origin: ORIGIN,
          'x-balanceframe-space': selectedSpace,
        },
      },
      res: {
        statusCode: 200,
        statusMessage: '',
        headersSent: false,
        setHeader(name: string, value: string | number | readonly string[]) {
          headers.set(name.toLowerCase(), value);
        },
        getHeader(name: string) {
          return headers.get(name.toLowerCase());
        },
        removeHeader(name: string) {
          headers.delete(name.toLowerCase());
        },
      },
    },
    context: {
      auth: {
        authenticated: true,
        actorId: READER,
        user: { id: READER },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: 'notification-status-reader-session',
        impersonatedBy: null,
      },
      runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false },
    },
  } as unknown as H3.H3Event & EventWithContext;
}

function createScope(selectedBudget: string) {
  const created = store.governance.createSpace({
    actorId: OWNER,
    name: `Notification status fixture ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerControl,
  });
  const space = store.governance.bindBudget({
    spaceId: created.id,
    budgetId: selectedBudget,
    now: NOW,
    auth: ownerControl,
  });
  const reader = store.governance.addMembership({
    spaceId: space.id,
    actorId: READER,
    validFrom: NOW,
    now: NOW,
    auth: ownerControl,
  });
  return { spaceId: space.id, membershipId: reader.id };
}

function grant(capability: string, restrictions: { aggregateOnly?: boolean } = {}) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: READER,
    membershipId,
    budgetId,
    capability,
    resourceKind: 'budget',
    resourceId: budgetId,
    restrictions,
    granted: true,
    now: NOW,
  });
}

async function createDelivery(input: {
  selectedBudget: string;
  classification?: string;
  recipientId?: string;
  correlationId?: string;
  failed?: boolean;
  secondOffset: number;
}) {
  const createdAt = new Date(Date.parse(NOW) + input.secondOffset * 1000).toISOString();
  vi.setSystemTime(new Date(createdAt));
  const event = await store.createNotificationEvent({
    budgetId: input.selectedBudget,
    classification: input.classification ?? 'budget_alert',
    recipientId: input.recipientId ?? READER,
    scope: `budget:${input.selectedBudget}`,
    payload: { title: 'Financial finding', rawEvidence: 'private notification payload' },
    policyVersion: 'notification-status-policy-v1',
    correlationId: input.correlationId,
    now: createdAt,
  });
  const outbox = await store.enqueueNotification({
    eventId: event.id,
    deliveryKey: event.id,
    channelType: 'in_app',
  });
  if (input.failed) {
    await store.claimNotificationDelivery(outbox.id, outbox.id);
    await store.failNotificationDelivery(outbox.id, outbox.id, 'fixture delivery failure', false);
  }
  return outbox;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'notification-status-scope-'));
  const opened = getWorkflowStore(request('') as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Notification owner', email: 'notification-owner@example.test', claimId: 'notification-status-fixture' });
  await store.finalizeBootstrap({ claimId: 'notification-status-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(READER, 'active', [], 'unscoped');
  await store.upsertActorMembership(OTHER, 'active', [], 'unscoped');
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  budgetId = `notification-status-budget-${++sequence}`;
  const selected = createScope(budgetId);
  spaceId = selected.spaceId;
  membershipId = selected.membershipId;
  grant('notification:receive');
  grant('observe');
  grant('full-read');
  await store.saveNotificationPolicy({
    spaceId,
    policyKey: 'notification',
    policyVersion: 'notification-status-policy-v1',
    policy: {
      recipients: [{ actorId: READER, channels: ['in_app'], quietHours: null }],
      channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('selected-space authorized notification status', () => {
  it('counts current recipient notifications without over-requiring full-read and denies after receive revocation', async () => {
    const pending = await createDelivery({ selectedBudget: budgetId, secondOffset: 0 });
    const failed = await createDelivery({ selectedBudget: budgetId, failed: true, secondOffset: 1 });
    const foreign = createScope(`notification-status-private-${sequence}`);
    await createDelivery({ selectedBudget: `notification-status-private-${sequence}`, secondOffset: 2 });
    store.governance.addMembership({
      spaceId,
      actorId: OTHER,
      validFrom: NOW,
      now: NOW,
      auth: ownerControl,
    });
    await createDelivery({ selectedBudget: budgetId, recipientId: OTHER, secondOffset: 3 });
    const privateFinding = await store.createFinding({
      budgetId,
      classification: 'transfer_needs_attention',
      description: 'private transfer finding',
      evidence: { transferId: 'not-a-current-proposal' },
      actorId: READER,
    });
    await createDelivery({
      selectedBudget: budgetId,
      classification: 'transfer_needs_attention',
      correlationId: `liquidity-finding:${privateFinding.id}`,
      secondOffset: 4,
    });

    const event = request();
    const allowed = await handler(event);
    expect(allowed.status).toBe('ok');
    expect(allowed.result).toMatchObject({ pendingCount: 1, failedCount: 1, recipientCount: 1 });
    expect(pending.id).not.toBe(failed.id);
    expect(foreign.spaceId).not.toBe(spaceId);

    store.governance.setResourceGrant({
      spaceId,
      actorId: READER,
      membershipId,
      budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: NOW,
      auth: ownerControl,
    });
    const withoutFullRead = await handler(event);
    expect(withoutFullRead.status).toBe('ok');
    expect(withoutFullRead.result).toMatchObject({ pendingCount: 1, failedCount: 1 });

    store.governance.setResourceGrant({
      spaceId,
      actorId: READER,
      membershipId,
      budgetId,
      capability: 'notification:receive',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: NOW,
      auth: ownerControl,
    });
    const revoked = await handler(event);
    expect(revoked.status).toBe('error');
    expect(revoked.error?.code).toBe('FORBIDDEN');
    expect(JSON.stringify([allowed, withoutFullRead, revoked])).not.toContain('private notification payload');
    expect(JSON.stringify([allowed, withoutFullRead, revoked])).not.toContain('private transfer finding');
  });
});