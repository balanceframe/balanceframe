/**
 * Failing tests for Phase 8 notification outbox/delivery lifecycle.
 *
 * TDD: these tests establish the expected contract before implementation.
 * Run with: pnpm --filter @balanceframe/workflow-store test
 *
 * Categories:
 * - Persist-before-dispatch: events exist before outbox records
 * - Idempotent delivery claims and retries
 * - Immutable event records (no mutation after creation)
 * - No duplicate visible send keys
 * - Delivery attempt immutability and query
 * - Acknowledge and suppression lifecycle
 * - Retry scheduling and claim expiry / crash recovery
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type {
  CreateNotificationEventInput,
  EnqueueNotificationInput,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tickSync(): void {
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
}

function waitMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENT_INPUT: CreateNotificationEventInput = {
  budgetId: 'budget-alpha',
  classification: 'budget_alert',
  payload: { message: 'Budget exceeded by 15%' },
  policyVersion: '1.0.0',
  recipientId: 'user-123',
  scope: 'budget-alpha',
  redactionClass: 'internal',
  channelConfigVersion: '2.1.0',
  correlationId: 'corr-test-001',
};

const ENQUEUE_INPUT: EnqueueNotificationInput = {
  eventId: '', // filled per test
  deliveryKey: 'delivery-key-001',
  channelType: 'email',
  channelConfigVersion: '2.1.0',
  maxAttempts: 3,
  correlationId: 'corr-test-001',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Notification lifecycle', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  // =======================================================================
  // Immutable event records
  // =======================================================================

  describe('createNotificationEvent', () => {
    it('persists a notification event with all fields intact', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);

      expect(event.id).toBeTypeOf('string');
      expect(event.eventVersion).toBe(1);
      expect(event.budgetId).toBe(EVENT_INPUT.budgetId);
      expect(event.classification).toBe(EVENT_INPUT.classification);
      expect(event.recipientId).toBe(EVENT_INPUT.recipientId);
      expect(event.scope).toBe(EVENT_INPUT.scope);
      expect(event.redactionClass).toBe(EVENT_INPUT.redactionClass);
      expect(event.channelConfigVersion).toBe(EVENT_INPUT.channelConfigVersion);
      expect(event.policyVersion).toBe(EVENT_INPUT.policyVersion);
      expect(event.correlationId).toBe(EVENT_INPUT.correlationId);
      expect(JSON.parse(event.payload)).toEqual(EVENT_INPUT.payload);
      expect(event.createdAt).toBeTypeOf('string');
    });

    it('assigns a stable UUID that can be used to retrieve the event', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const fetched = await store.getNotificationEvent(event.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(event.id);
    });

    it('propagates nullables as null when omitted', async () => {
      const event = await store.createNotificationEvent({
        budgetId: 'budget-beta',
        classification: 'review_needed',
        payload: { simple: true },
        policyVersion: '2.0.0',
      });

      expect(event.recipientId).toBeNull();
      expect(event.scope).toBeNull();
      expect(event.redactionClass).toBeNull();
      expect(event.channelConfigVersion).toBeNull();
      expect(event.correlationId).toBeNull();
    });

    it('returns null for unknown event IDs', async () => {
      const fetched = await store.getNotificationEvent('nonexistent-id');
      expect(fetched).toBeNull();
    });

    // ── Immutability ─────────────────────────────────────────

    it('does not allow mutation of a persisted event', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const fetched = await store.getNotificationEvent(event.id);

      // Verify that all fields are readonly — the only way to test this
      // is to check that re-reading gives the exact same values.
      expect(fetched).toEqual(event);
    });
  });

  // =======================================================================
  // Persist-before-dispatch
  // =======================================================================

  describe('enqueueNotification', () => {
    it('requires the event to exist before enqueue', async () => {
      // Deliberately use a non-existent event ID
      await expect(
        store.enqueueNotification({
          ...ENQUEUE_INPUT,
          eventId: 'no-such-event',
        }),
      ).rejects.toThrow('event');
    });

    it('creates an outbox record referencing the event', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      expect(outbox.id).toBeTypeOf('string');
      expect(outbox.eventId).toBe(event.id);
      expect(outbox.deliveryKey).toBe(ENQUEUE_INPUT.deliveryKey);
      expect(outbox.channelType).toBe(ENQUEUE_INPUT.channelType);
      expect(outbox.channelConfigVersion).toBe(ENQUEUE_INPUT.channelConfigVersion);
      expect(outbox.status).toBe('pending');
      expect(outbox.attemptCount).toBe(0);
      expect(outbox.maxAttempts).toBe(3);
      expect(outbox.claimToken).toBeNull();
      expect(outbox.claimExpiresAt).toBeNull();
      expect(outbox.lastAttemptedAt).toBeNull();
      expect(outbox.nextAttemptAt).toBeNull();
      expect(outbox.acknowledgedAt).toBeNull();
      expect(outbox.failedAt).toBeNull();
      expect(outbox.failureReason).toBeNull();
      expect(outbox.suppressedAt).toBeNull();
      expect(outbox.suppressedReason).toBeNull();
      expect(outbox.correlationId).toBe(ENQUEUE_INPUT.correlationId);
      expect(outbox.createdAt).toBeTypeOf('string');
      expect(outbox.updatedAt).toBeTypeOf('string');
    });

    it('defaults maxAttempts to 3 when omitted', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: 'dk-002',
        channelType: 'webhook',
      });
      expect(outbox.maxAttempts).toBe(3);
    });

    it('retrieves outbox record by ID', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      const fetched = await store.getOutboxRecord(outbox.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(outbox.id);
      expect(fetched!.eventId).toBe(event.id);
    });

    it('returns null for unknown outbox IDs', async () => {
      const fetched = await store.getOutboxRecord('nonexistent');
      expect(fetched).toBeNull();
    });

    // ── No duplicate visible send keys ────────────────────────

    it('rejects a duplicate deliveryKey for the same eventId + channelType', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: 'dup-key',
        channelType: 'email',
      });

      await expect(
        store.enqueueNotification({
          eventId: event.id,
          deliveryKey: 'dup-key',
          channelType: 'email',
        }),
      ).rejects.toThrow('deliveryKey');
    });

    it('allows the same deliveryKey across different channel types', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const first = await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: 'shared-key',
        channelType: 'email',
      });
      const second = await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: 'shared-key',
        channelType: 'push',
      });

      expect(first.id).not.toBe(second.id);
      expect(first.status).toBe('pending');
      expect(second.status).toBe('pending');
    });

    // ── Persist-before-dispatch invariant ─────────────────────

    it('persists the event before creating the outbox record (cross-table FK)', async () => {
      // The event must exist first — this is enforced by the FK constraint.
      // We already test this above; this test confirms the event is readable
      // after enqueue.
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      // Event should still be retrievable independently
      const fetchedEvent = await store.getNotificationEvent(event.id);
      expect(fetchedEvent).not.toBeNull();
      expect(fetchedEvent!.id).toBe(event.id);

      // Outbox should reference the event
      expect(outbox.eventId).toBe(event.id);
    });
  });

  // =======================================================================
  // Delivery claim / retry lifecycle
  // =======================================================================

  describe('claimNotificationDelivery', () => {
    it('claims a pending outbox record', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      const claimed = await store.claimNotificationDelivery(outbox.id, 'claim-abc');
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(outbox.id);
      expect(claimed!.status).toBe('delivering');
      expect(claimed!.claimToken).toBe('claim-abc');
      expect(claimed!.claimExpiresAt).toBeTypeOf('string');
      expect(claimed!.lastAttemptedAt).toBeTypeOf('string');
      expect(claimed!.attemptCount).toBe(1);
    });

    it('returns null for unknown outbox IDs', async () => {
      const claimed = await store.claimNotificationDelivery('no-such', 'tok');
      expect(claimed).toBeNull();
    });

    it('returns null if already claimed by a different token', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      await store.claimNotificationDelivery(outbox.id, 'token-a');
      const second = await store.claimNotificationDelivery(outbox.id, 'token-b');
      expect(second).toBeNull();
    });

    it('is idempotent when re-claiming with the same token', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      const first = await store.claimNotificationDelivery(outbox.id, 'same-token');
      const second = await store.claimNotificationDelivery(outbox.id, 'same-token');

      expect(second).not.toBeNull();
      expect(second!.id).toBe(first!.id);
      expect(second!.status).toBe('delivering');
      expect(second!.claimToken).toBe('same-token');
    });

    it('reclaims expired delivery claims (crash recovery)', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      // Claim with very short timeout
      await store.claimNotificationDelivery(outbox.id, 'crash-token', 1);
      await waitMs(10);

      // Now reclaim with a new token after expiry
      const reclaimed = await store.claimNotificationDelivery(outbox.id, 'recovery-token');
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.claimToken).toBe('recovery-token');
      expect(reclaimed!.status).toBe('delivering');
    });

    it('increments attemptCount on each claim', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });

      // Short timeout claim, wait for expiry, reclaim
      const first = await store.claimNotificationDelivery(outbox.id, 'tok-1', 1);
      expect(first!.attemptCount).toBe(1);
      await waitMs(10);

      const second = await store.claimNotificationDelivery(outbox.id, 'tok-2', 1);
      expect(second!.attemptCount).toBe(2);
      await waitMs(10);

      const third = await store.claimNotificationDelivery(outbox.id, 'tok-3', 1);
      expect(third!.attemptCount).toBe(3);
    });
  });

  // =======================================================================
  // Delivery completion
  // =======================================================================

  describe('completeNotificationDelivery', () => {
    it('marks a claimed record as delivered', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      await store.claimNotificationDelivery(outbox.id, 'token');

      const completed = await store.completeNotificationDelivery(outbox.id, 'token');

      expect(completed.status).toBe('delivered');
      expect(completed.claimToken).toBeNull();
      expect(completed.claimExpiresAt).toBeNull();
    });

    it('requires the valid claim token', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      await store.claimNotificationDelivery(outbox.id, 'right-token');

      await expect(
        store.completeNotificationDelivery(outbox.id, 'wrong-token'),
      ).rejects.toThrow('claim token');
    });

    it('records a successful delivery attempt', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      await store.claimNotificationDelivery(outbox.id, 'tok');

      await store.completeNotificationDelivery(outbox.id, 'tok', {
        code: '200',
        body: '{"sent":true}',
      });

      const attempts = await store.getDeliveryAttempts(outbox.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('success');
      expect(attempts[0].responseCode).toBe('200');
      expect(attempts[0].responseBody).toBe('{"sent":true}');
      expect(attempts[0].outboxId).toBe(outbox.id);
      expect(attempts[0].attemptNumber).toBe(1);
    });
  });

  // =======================================================================
  // Delivery failure and retry
  // =======================================================================

  describe('failNotificationDelivery', () => {
    it('fails non-retryable delivery', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      await store.claimNotificationDelivery(outbox.id, 'tok');

      const failed = await store.failNotificationDelivery(
        outbox.id, 'tok', 'Channel unreachable', false,
      );

      expect(failed.status).toBe('failed');
      expect(failed.failedAt).toBeTypeOf('string');
      expect(failed.failureReason).toBe('Channel unreachable');
      expect(failed.claimToken).toBeNull();
    });

    it('schedules retry for retryable failure with attempts remaining', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
        maxAttempts: 3,
      });
      await store.claimNotificationDelivery(outbox.id, 'tok');

      const failed = await store.failNotificationDelivery(
        outbox.id, 'tok', 'Timeout', true,
      );

      // Should remain 'failed' with a nextAttemptAt scheduled
      expect(failed.status).toBe('failed');
      expect(failed.attemptCount).toBe(1);
      expect(failed.nextAttemptAt).toBeTypeOf('string'); // scheduled retry
      expect(failed.failedAt).toBeTypeOf('string');
    });

    it('becomes terminal after exhausting all retry attempts', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
        maxAttempts: 1,
      });

      await store.claimNotificationDelivery(outbox.id, 'tok1', 1);
      await waitMs(10);

      const failed = await store.failNotificationDelivery(
        outbox.id, 'tok1', 'Permanent error', true,
      );

      expect(failed.status).toBe('failed');
      expect(failed.failureReason).toBe('Permanent error');
      expect(failed.nextAttemptAt).toBeNull(); // no more retries
    });

    it('records a failed delivery attempt', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      await store.claimNotificationDelivery(outbox.id, 'tok');

      await store.failNotificationDelivery(outbox.id, 'tok', 'Error', false);

      const attempts = await store.getDeliveryAttempts(outbox.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('failed');
      expect(attempts[0].errorMessage).toBe('Error');
      expect(attempts[0].attemptNumber).toBe(1);
    });

    it('requires the valid claim token', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
      });
      await store.claimNotificationDelivery(outbox.id, 'right');

      await expect(
        store.failNotificationDelivery(outbox.id, 'wrong', 'bad token', false),
      ).rejects.toThrow('claim token');
    });
  });

  // =======================================================================
  // Retryable notifications query
  // =======================================================================

  describe('getRetryableNotifications', () => {
    it('returns outbox records whose nextAttemptAt <= now', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
        maxAttempts: 3,
      });

      await store.claimNotificationDelivery(outbox.id, 'tok');
      // Fail retryably — schedules nextAttemptAt
      await store.failNotificationDelivery(outbox.id, 'tok', 'Temporary', true);

      // The failed record should show up in retryable queries
      // (nextAttemptAt was set to now by the fail method)
      const retryable = await store.getRetryableNotifications();
      expect(retryable.length).toBeGreaterThanOrEqual(1);
      expect(retryable.some(r => r.id === outbox.id)).toBe(true);
    });

    it('filters retryable by channel type', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const o1 = await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: 'dk-email',
        channelType: 'email',
        maxAttempts: 3,
      });
      const o2 = await store.enqueueNotification({
        eventId: event.id,
        deliveryKey: 'dk-push',
        channelType: 'push',
        maxAttempts: 3,
      });

      await store.claimNotificationDelivery(o1.id, 't1');
      await store.failNotificationDelivery(o1.id, 't1', 'temp', true);
      await store.claimNotificationDelivery(o2.id, 't2');
      await store.failNotificationDelivery(o2.id, 't2', 'temp', true);

      const emailRetries = await store.getRetryableNotifications(10, 'email');
      expect(emailRetries.every(r => r.channelType === 'email')).toBe(true);
      expect(emailRetries.some(r => r.id === o1.id)).toBe(true);
    });
  });

  // =======================================================================
  // Pending notifications query
  // =======================================================================

  describe('getPendingNotifications', () => {
    it('returns unclaimed outbox records with pending status', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      await store.enqueueNotification({ ...ENQUEUE_INPUT, eventId: event.id });

      const pending = await store.getPendingNotifications();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending');
    });

    it('does not return claimed/delivered/failed records', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const o1 = await store.enqueueNotification({ eventId: event.id, deliveryKey: 'dk-1', channelType: 'email' });
      const o2 = await store.enqueueNotification({ eventId: event.id, deliveryKey: 'dk-2', channelType: 'push' });

      await store.claimNotificationDelivery(o1.id, 't');
      await store.completeNotificationDelivery(o1.id, 't');

      const pending = await store.getPendingNotifications();
      expect(pending.some(r => r.id === o1.id)).toBe(false);
      expect(pending.some(r => r.id === o2.id)).toBe(true);
    });

    it('filters by channel type', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      await store.enqueueNotification({ eventId: event.id, deliveryKey: 'dk-1', channelType: 'email' });
      await store.enqueueNotification({ eventId: event.id, deliveryKey: 'dk-2', channelType: 'push' });

      const emailPending = await store.getPendingNotifications(10, 'email');
      expect(emailPending).toHaveLength(1);
      expect(emailPending[0].channelType).toBe('email');
    });
  });

  // =======================================================================
  // Delivery attempt queries
  // =======================================================================

  describe('getDeliveryAttempts', () => {
    it('returns all attempts ordered by attempt number', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({
        ...ENQUEUE_INPUT,
        eventId: event.id,
        maxAttempts: 5,
      });

      // Claim -> fail retryable -> claim again -> complete
      await store.claimNotificationDelivery(outbox.id, 'a1', 1);
      await store.failNotificationDelivery(outbox.id, 'a1', 'err', true);
      await waitMs(10);
      await store.claimNotificationDelivery(outbox.id, 'a2', 1);
      await store.completeNotificationDelivery(outbox.id, 'a2');

      const attempts = await store.getDeliveryAttempts(outbox.id);
      expect(attempts).toHaveLength(2);
      expect(attempts[0].attemptNumber).toBe(1);
      expect(attempts[1].attemptNumber).toBe(2);
    });

    it('returns empty array for unknown outbox ID', async () => {
      const attempts = await store.getDeliveryAttempts('no-such');
      expect(attempts).toEqual([]);
    });
  });

  // =======================================================================
  // Acknowledge lifecycle
  // =======================================================================

  describe('acknowledgeNotification', () => {
    it('acknowledges a delivered notification', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({ ...ENQUEUE_INPUT, eventId: event.id });
      await store.claimNotificationDelivery(outbox.id, 'tok');
      await store.completeNotificationDelivery(outbox.id, 'tok');

      const acked = await store.acknowledgeNotification(outbox.id);
      expect(acked.acknowledgedAt).toBeTypeOf('string');
      expect(acked.status).toBe('delivered');
    });

    it('throws if the notification is not in delivered status', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({ ...ENQUEUE_INPUT, eventId: event.id });
      // Still pending
      await expect(
        store.acknowledgeNotification(outbox.id),
      ).rejects.toThrow('status');
    });
  });

  // =======================================================================
  // Suppression lifecycle
  // =======================================================================

  describe('suppressNotification', () => {
    it('suppresses a pending notification', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({ ...ENQUEUE_INPUT, eventId: event.id });

      const suppressed = await store.suppressNotification(outbox.id, 'User opted out');
      expect(suppressed.status).toBe('suppressed');
      expect(suppressed.suppressedAt).toBeTypeOf('string');
      expect(suppressed.suppressedReason).toBe('User opted out');
    });

    it('suppresses a delivering notification (in-flight)', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({ ...ENQUEUE_INPUT, eventId: event.id });
      await store.claimNotificationDelivery(outbox.id, 'tok');

      const suppressed = await store.suppressNotification(outbox.id, 'Preempted');
      expect(suppressed.status).toBe('suppressed');
    });

    it('throws when suppressing an already-delivered notification', async () => {
      const event = await store.createNotificationEvent(EVENT_INPUT);
      const outbox = await store.enqueueNotification({ ...ENQUEUE_INPUT, eventId: event.id });
      await store.claimNotificationDelivery(outbox.id, 'tok');
      await store.completeNotificationDelivery(outbox.id, 'tok');

      await expect(
        store.suppressNotification(outbox.id, 'too late'),
      ).rejects.toThrow();
    });
  });
});
