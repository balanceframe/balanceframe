import { afterEach, describe, expect, it } from 'vitest';
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

describe('durable notification deduplication', () => {
  let store: SqliteWorkflowStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('deduplicates concurrent creation and delivery across recreated runtimes', async () => {
    store = new SqliteWorkflowStore(':memory:');
    const deliveries: Array<{ payload: unknown; deliveryKey: string }> = [];
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      async deliver(payload, deliveryKey) {
        deliveries.push({ payload, deliveryKey });
        return { ok: true, code: 'delivered' };
      },
      isHealthy: () => true,
    };
    const firstRuntime = new NotificationRuntime(store, notificationPolicy(), [adapter]);
    const recreatedRuntime = new NotificationRuntime(store, notificationPolicy(), [adapter]);
    firstRuntime.setReAuthorizationHook(async () => true);
    recreatedRuntime.setReAuthorizationHook(async () => true);

    const firstRevision = decisionIdentity('sha256:revision-1');
    const [first, repeated] = await Promise.all([
      firstRuntime.create(notificationInput(firstRevision)),
      recreatedRuntime.create(notificationInput(firstRevision)),
    ]);

    expect(repeated.event.id).toBe(first.event.id);
    expect(first.outboxRecords).toHaveLength(1);
    expect(repeated.outboxRecords).toHaveLength(1);
    expect(repeated.outboxRecords[0]!.id).toBe(first.outboxRecords[0]!.id);
    expect(await store.listOutboxRecords()).toHaveLength(1);

    const deliveryResults = await Promise.all([
      firstRuntime.dispatch(first.outboxRecords[0]!.id, 'claim-first-runtime'),
      recreatedRuntime.dispatch(repeated.outboxRecords[0]!.id, 'claim-recreated-runtime'),
    ]);

    expect(deliveryResults.filter(({ status }) => status === 'delivered')).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
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
    expect(changedRecipient.outboxRecords[0]!.id).not.toBe(first.outboxRecords[0]!.id);
    expect(await store.listOutboxRecords()).toHaveLength(3);
  });
});
