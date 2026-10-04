import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import {
  NotificationRuntime,
  financialDecisionDedupKey,
  type ChannelAdapter,
  type CreateNotificationInput,
  type FinancialDecisionIdentity,
  type NotificationPolicy,
} from '../src';

const BUDGET_ID = 'budget-durable-dedup';
const PRIMARY_RECIPIENT = 'actor-primary';
const SECONDARY_RECIPIENT = 'actor-secondary';
const SCOPE = 'category:groceries';
const AUTHORITY_NOW = '2026-08-23T12:00:00.000Z';

function notificationPolicy(): NotificationPolicy {
  return {
    policyVersion: 'financial-attention-v1',
    eligibility: [
      {
        classifications: ['reservation_conflict'],
        minSeverity: 'normal',
        requiredCapability: 'notification:receive',
        requiredScope: SCOPE,
      },
    ],
    recipients: [
      {
        actorId: PRIMARY_RECIPIENT,
        channels: ['in_app'],
        quietHours: null,
      },
      {
        actorId: SECONDARY_RECIPIENT,
        channels: ['in_app'],
        quietHours: null,
      },
    ],
    channels: [
      {
        type: 'in_app',
        enabled: true,
        rateLimitPerMinute: 60,
        displayName: 'In app',
      },
    ],
    redaction: {
      restricted: { visibleFields: ['title', 'summary'] },
    },
    maxRetries: 3,
    defaultRedactionClass: 'restricted',
  };
}

function decisionIdentity(revision: string): FinancialDecisionIdentity {
  return {
    classification: 'reservation_conflict',
    scope: { kind: 'category', id: 'groceries' },
    snapshotId: 'snapshot-durable-dedup',
    policyVersion: 'financial-attention-v1',
    revision,
  };
}

function notificationInput(
  identity: FinancialDecisionIdentity,
  recipientId = PRIMARY_RECIPIENT,
): CreateNotificationInput {
  return {
    budgetId: BUDGET_ID,
    classification: 'reservation_conflict',
    severity: 'high',
    payload: {
      title: 'Reservation conflict',
      summary: 'A reservation conflicts with this purchase.',
    },
    scope: SCOPE,
    recipientId,
    dedupKey: financialDecisionDedupKey(identity),
  };
}

function humanAuth(actorId: string) {
  return {
    method: 'human-session' as const,
    actorId,
    sessionId: `fixture-session-${actorId}`,
    reauthenticatedAt: AUTHORITY_NOW,
  };
}

describe('durable notification deduplication', () => {
  let store: SqliteWorkflowStore | undefined;
  let spaceId: string;
  let primaryMembershipId: string;
  let secondaryMembershipId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AUTHORITY_NOW));
    store = new SqliteWorkflowStore(':memory:');
    const claimId = 'durable-notification-fixture';
    await store.claimBootstrap({ name: 'Primary', email: 'primary@example.test', claimId });
    await store.finalizeBootstrap({ claimId, ownerUserId: PRIMARY_RECIPIENT });
    const auth = humanAuth(PRIMARY_RECIPIENT);
    const unboundSpace = store.governance.createSpace({
      actorId: PRIMARY_RECIPIENT,
      name: 'Durable notification fixture',
      kind: 'shared',
      now: AUTHORITY_NOW,
      auth,
    });
    const space = store.governance.bindBudget({
      spaceId: unboundSpace.id,
      budgetId: BUDGET_ID,
      now: AUTHORITY_NOW,
      auth,
    });
    spaceId = space.id;
    const primaryMembership = store.governance.getCurrentMembership({
      spaceId,
      actorId: PRIMARY_RECIPIENT,
      now: AUTHORITY_NOW,
    });
    if (!primaryMembership) throw new Error('Primary fixture membership missing');
    primaryMembershipId = primaryMembership.id;

    await store.upsertActorMembership(SECONDARY_RECIPIENT, 'active', [], '');
    const secondaryMembership = store.governance.addMembership({
      spaceId,
      actorId: SECONDARY_RECIPIENT,
      validFrom: AUTHORITY_NOW,
      now: AUTHORITY_NOW,
      auth,
    });
    secondaryMembershipId = secondaryMembership.id;

    for (const [actorId, membershipId] of [
      [PRIMARY_RECIPIENT, primaryMembershipId],
      [SECONDARY_RECIPIENT, secondaryMembershipId],
    ] as const) {
      store.governance.provisionResourceGrant({
        spaceId,
        membershipId,
        actorId,
        budgetId: BUDGET_ID,
        resourceKind: 'category',
        resourceId: 'groceries',
        capability: 'notification:receive',
        granted: true,
        now: AUTHORITY_NOW,
      });
    }
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    vi.useRealTimers();
  });

  it('deduplicates concurrent creation and delivery across recreated runtimes', async () => {
    if (!store) throw new Error('Durable notification fixture unavailable');
    const deliveries: Array<{ payload: unknown; recipientId: string }> = [];
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      async deliver(payload, recipientId) {
        deliveries.push({ payload, recipientId });
        return { ok: true, code: 'delivered' };
      },
      isHealthy: () => true,
    };
    const firstRuntime = new NotificationRuntime(store, notificationPolicy(), [adapter]);
    const recreatedRuntime = new NotificationRuntime(store, notificationPolicy(), [adapter]);

    const firstRevision = decisionIdentity('sha256:revision-1');
    const [first, repeated] = await Promise.all([
      firstRuntime.create(notificationInput(firstRevision)),
      recreatedRuntime.create(notificationInput(firstRevision)),
    ]);

    expect(repeated.event.id).toBe(first.event.id);
    expect(first.event.spaceId).toBe(spaceId);
    expect(first.event.recipientMembershipId).toBe(primaryMembershipId);
    expect(first.event.scope).toBe(SCOPE);
    expect(first.outboxRecords).toHaveLength(1);
    expect(repeated.outboxRecords).toHaveLength(1);
    expect(repeated.outboxRecords[0]!.id).toBe(first.outboxRecords[0]!.id);
    expect(await store.listOutboxRecords()).toHaveLength(1);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM notification_events').get()).toEqual({
      count: 1,
    });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM notification_outbox').get()).toEqual({
      count: 1,
    });

    const deliveryResults = await Promise.all([
      firstRuntime.dispatch(first.outboxRecords[0]!.id, 'claim-first-runtime'),
      recreatedRuntime.dispatch(repeated.outboxRecords[0]!.id, 'claim-recreated-runtime'),
    ]);

    expect(deliveryResults.filter(({ status }) => status === 'delivered')).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.recipientId).toBe(PRIMARY_RECIPIENT);
    expect(await store.getDeliveryAttempts(first.outboxRecords[0]!.id)).toHaveLength(1);

    const changedRevision = await recreatedRuntime.create(
      notificationInput(decisionIdentity('sha256:revision-2')),
    );
    const changedRecipient = await firstRuntime.create(
      notificationInput(firstRevision, SECONDARY_RECIPIENT),
    );

    expect(changedRevision.event.id).not.toBe(first.event.id);
    expect(changedRevision.outboxRecords[0]!.id).not.toBe(first.outboxRecords[0]!.id);
    expect(changedRecipient.event.id).not.toBe(first.event.id);
    expect(changedRecipient.event.recipientMembershipId).toBe(secondaryMembershipId);
    expect(changedRecipient.outboxRecords[0]!.id).not.toBe(first.outboxRecords[0]!.id);
    expect(await store.listOutboxRecords()).toHaveLength(3);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM notification_events').get()).toEqual({
      count: 3,
    });
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM notification_outbox').get()).toEqual({
      count: 3,
    });
  });
});
