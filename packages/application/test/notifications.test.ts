/**
 * TDD: tests for NotificationRuntime.
 *
 * Covers:
 * - authorized/unauthorized re-authorization hook
 * - revocation (actor loses capability mid-lifecycle)
 * - redaction by authorized field set
 * - quiet hours suppression
 * - rate limit suppression
 * - retry and crash recovery
 * - malformed callback acknowledgement
 * - channel adapter outage
 * - all channels disabled policy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
import {
  NotificationRuntime,
  InAppChannelAdapter,
  type NotificationPolicy,
  type CreateNotificationInput,
  type RuntimeStatus,
  type ChannelType,
  NotificationRuntimeError,
} from '../src/notifications';

// ---------------------------------------------------------------------------
// WorkflowStore type (for mocks only)
// ---------------------------------------------------------------------------
import type {
  WorkflowStore,
  NotificationEvent,
  NotificationOutboxRecord,
  AppendAuditInput,
  NotificationPolicyRecord,
  RecipientResolution,
} from '@balanceframe/workflow-store';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_BUDGET = 'budget_test_001';
const TEST_ACTOR_A = 'usr_alice';
const TEST_ACTOR_B = 'usr_bob';
const TEST_EVENT_ID = 'evt_001';
const TEST_OUTBOX_ID = 'obx_001';
const TEST_POLICY_VER = 'pol_v1';

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

function defaultPolicy(overrides: Partial<NotificationPolicy> = {}): NotificationPolicy {
  return {
    policyVersion: TEST_POLICY_VER,
    eligibility: [
      {
        classifications: ['budget_alert', 'review_complete', 'data_quality', 'alert', 'recurrence', 'target_risk', 'proposal_transition', 'workflow_result'],
        minSeverity: 'normal',
        requiredCapability: 'notification:receive',
        requiredScope: '',
      },
    ],
    recipients: [
      {
        actorId: TEST_ACTOR_A,
        channels: ['in_app', 'email'],
        quietHours: null,
      },
    ],
    channels: [
      { type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
      { type: 'email', enabled: true, rateLimitPerMinute: 10, displayName: 'Email' },
    ],
    redaction: {
      sensitive: { visibleFields: ['title', 'summary'] },
      public: { visibleFields: ['title', 'summary', 'amount', 'account'] },
      restricted: { visibleFields: ['title'] },
    },
    maxRetries: 3,
    defaultRedactionClass: 'public',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Notification event mock factory
// ---------------------------------------------------------------------------

function mockEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: TEST_EVENT_ID,
    eventVersion: 1,
    budgetId: TEST_BUDGET,
    classification: 'budget_alert',
    recipientId: TEST_ACTOR_A,
    scope: TEST_BUDGET,
    redactionClass: 'sensitive',
    channelConfigVersion: null,
    policyVersion: TEST_POLICY_VER,
    correlationId: null,
    payload: JSON.stringify({
      title: 'Budget Alert',
      summary: 'You exceeded your dining budget',
      amount: 15000,
      account: 'Checking',
      internalNote: 'audit:12345',
    }),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Outbox record mock factory
// ---------------------------------------------------------------------------

function mockOutbox(overrides: Partial<NotificationOutboxRecord> = {}): NotificationOutboxRecord {
  return {
    id: TEST_OUTBOX_ID,
    eventId: TEST_EVENT_ID,
    deliveryKey: 'dk_001',
    channelType: 'in_app',
    channelConfigVersion: null,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    claimToken: null,
    claimExpiresAt: null,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    acknowledgedAt: null,
    failedAt: null,
    failureReason: null,
    suppressedAt: null,
    suppressedReason: null,
    correlationId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Store mock factory — typed mock implementing WorkflowStore
// ---------------------------------------------------------------------------

type StoreMock = {
  [K in keyof WorkflowStore]: Mock;
};

function createStoreMock(): StoreMock {
  const proto: Record<string, unknown> = {};
  const storeMethods: Array<keyof WorkflowStore> = [
    'saveSuggestion', 'getActiveSuggestion', 'getSuggestion', 'getTransactionSuggestions',
    'supersedeSuggestions', 'enqueueJob', 'claimJob', 'completeJob', 'failJob',
    'getPendingJobs', 'getJobByCandidateId', 'createReviewItem', 'getReviewItem',
    'findReviewByIssue', 'listReviewItems', 'countReviewItems', 'listReviewItemsByCorrelation',
    'transitionReviewItem', 'transitionReviewItems', 'updateReviewItemCategory',
    'undoReviewTransition', 'getReviewActions', 'createProposal', 'getProposal',
    'findActiveProposal', 'listProposals', 'countProposals', 'supersedeProposal',
    'createApproval', 'getApproval', 'findActiveApprovals', 'consumeApproval',
    'verifyApprovalForExecution', 'createIdempotencyRecord', 'getIdempotencyRecord',
    'completeIdempotencyRecord', 'findStrandedIdempotencyRecords',
    'reconcileStrandedIdempotencyRecords', 'appendAuditRecord', 'queryAuditRecords',
    'queryAuditRecordsByProposal', 'queryCorrectionHistory', 'findCorrectionConflicts',
    'getRegistrationState', 'claimBootstrap', 'finalizeBootstrap', 'createInvitation',
    'revokeInvitation', 'listInvitations', 'claimInvitation', 'completeInvitationRedemption',
    'reconcileClaimedInvitations', 'evaluateAuthorization', 'upsertActorMembership',
    'getActorMembership', 'deleteActorMembership', 'recordExport', 'getLastExport',
    'deleteScopeData', 'setRuleOverride', 'getRuleOverrides', 'removeRuleOverride',
    'createNotificationEvent', 'getNotificationEvent', 'enqueueNotification',
    'claimNotificationDelivery', 'completeNotificationDelivery', 'failNotificationDelivery',
    'acknowledgeNotification', 'suppressNotification', 'getOutboxRecord',
    'getPendingNotifications', 'getRetryableNotifications', 'getDeliveryAttempts',
    'listOutboxRecords',
    'getNotificationPolicy', 'saveNotificationPolicy',
    'resolveRecipients', 'listNotificationPolicies', 'deleteNotificationPolicy',
    'recordPolicyVersion', 'getPolicyVersion', 'getActivePolicyVersion',
    'listPolicyVersions', 'createSavedFilter', 'updateSavedFilter', 'getSavedFilter',
    'listSavedFilters', 'deleteSavedFilter', 'createReportRecord', 'getReportRecord',
    'listReportRecords', 'expireReportRecord', 'cancelPendingJobs',
    'createFinding', 'getFinding', 'listFindings', 'countFindings',
    'acknowledgeFinding', 'correctFinding', 'dismissFinding', 'reopenFinding',
    'supersedeFinding', 'expireFinding',
    'getReportHistory', 'listSavedViews', 'createSavedView', 'updateSavedView',
    'duplicateSavedView', 'deleteSavedView', 'recordSavedViewUsage', 'getSavedView',
  ];
  for (const key of storeMethods) {
    proto[key] = vi.fn();
  }
  return proto as unknown as StoreMock;
}

// ---------------------------------------------------------------------------
// Runtime fixture
// ---------------------------------------------------------------------------

interface RuntimeFixture {
  store: StoreMock;
  adapter: InAppChannelAdapter;
  runtime: NotificationRuntime;
}

function createFixture(
  policyOverrides: Partial<NotificationPolicy> = {},
): RuntimeFixture {
  const store = createStoreMock();
  const adapter = new InAppChannelAdapter();
  const policy = defaultPolicy(policyOverrides);
  const runtime = new NotificationRuntime(store, policy, [adapter]);
  return { store, adapter, runtime };
}

// ---------------------------------------------------------------------------
// Default create input
// ---------------------------------------------------------------------------

function defaultInput(overrides: Partial<CreateNotificationInput> = {}): CreateNotificationInput {
  return {
    budgetId: TEST_BUDGET,
    classification: 'budget_alert',
    severity: 'high',
    payload: {
      title: 'Budget Alert',
      summary: 'You exceeded your dining budget',
      amount: 15000,
      account: 'Checking',
      internalNote: 'audit:12345',
    },
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('NotificationRuntime', () => {
  let fixture: RuntimeFixture;
  let store: StoreMock;
  let adapter: InAppChannelAdapter;
  let runtime: NotificationRuntime;

  beforeEach(() => {
    fixture = createFixture();
    store = fixture.store;
    adapter = fixture.adapter;
    runtime = fixture.runtime;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    adapter.clearDeliveries();
  });

  // -----------------------------------------------------------------------
  // Eligibility
  // -----------------------------------------------------------------------

  describe('evaluateEligibility', () => {
    it('returns true for matching classification and sufficient severity', () => {
      expect(runtime.evaluateEligibility('budget_alert', 'high')).toBe(true);
    });

    it('returns true for matching classification with exactly matching severity', () => {
      expect(runtime.evaluateEligibility('budget_alert', 'normal')).toBe(true);
    });

    it('returns false for unknown classification', () => {
      expect(runtime.evaluateEligibility('unknown_type', 'critical')).toBe(false);
    });

    it('returns false for insufficient severity', () => {
      expect(runtime.evaluateEligibility('budget_alert', 'low')).toBe(false);
    });

    it('returns true for critical severity on high-min rule', () => {
      const custom = createFixture({
        eligibility: [
          {
            classifications: ['security_alert'],
            minSeverity: 'critical',
            requiredCapability: 'notification:receive',
          },
        ],
      });
      expect(custom.runtime.evaluateEligibility('security_alert', 'critical')).toBe(true);
      expect(custom.runtime.evaluateEligibility('security_alert', 'high')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Event creation (authorized/unauthorized)
  // -----------------------------------------------------------------------

  describe('create — authorized vs unauthorized', () => {
    it('creates notification when re-authorization hook allows', async () => {
      const event = mockEvent();
      const outbox = mockOutbox();
      store.createNotificationEvent.mockResolvedValue(event);
      store.enqueueNotification.mockResolvedValue(outbox);

      runtime.setReAuthorizationHook(async () => true);

      const result = await runtime.create(defaultInput());

      expect(result.event.id).toBe(TEST_EVENT_ID);
      expect(result.outboxRecords).toHaveLength(2);
      expect(store.createNotificationEvent).toHaveBeenCalledTimes(1);
      expect(store.enqueueNotification).toHaveBeenCalledTimes(2);
    });

    it('suppresses notification when re-authorization hook denies', async () => {
      const event = mockEvent();
      store.createNotificationEvent.mockResolvedValue(event);

      runtime.setReAuthorizationHook(async () => false);

      const result = await runtime.create(defaultInput());

      expect(result.event.id).toBe(TEST_EVENT_ID);
      expect(result.outboxRecords).toHaveLength(0);
      expect(store.enqueueNotification).not.toHaveBeenCalled();
    });

    it('creates notification without re-authorization hook — uses store-backed membership', async () => {
      const event = mockEvent();
      const outbox = mockOutbox();
      store.createNotificationEvent.mockResolvedValue(event);
      store.enqueueNotification.mockResolvedValue(outbox);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const result = await runtime.create(defaultInput());

      expect(result.event.id).toBe(TEST_EVENT_ID);
      expect(result.outboxRecords).toHaveLength(2);
    });

    it('throws NOT_ELIGIBLE for mismatched classification', async () => {
      await expect(
        runtime.create(defaultInput({ classification: 'unknown' })),
      ).rejects.toThrow(NotificationRuntimeError);
    });

    it('throws NOT_ELIGIBLE for insufficient severity', async () => {
      await expect(
        runtime.create(defaultInput({ severity: 'low' })),
      ).rejects.toThrow(NotificationRuntimeError);
    });
  });

  // -----------------------------------------------------------------------
  // Revocation
  // -----------------------------------------------------------------------

  describe('revocation — capability removed mid-lifecycle', () => {
    it('re-authorization hook returning false suppresses outboxes', async () => {
      const capabilityCheck: Mock = vi.fn();
      runtime.setReAuthorizationHook(async (actorId, capability, scope) => {
        capabilityCheck(actorId, capability, scope);
        return false;
      });

      const event = mockEvent();
      store.createNotificationEvent.mockResolvedValue(event);

      const result = await runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(0);
      expect(capabilityCheck).toHaveBeenCalledWith(
        TEST_ACTOR_A,
        'notification:receive',
        '',
      );
    });

    it('suppresses only the revoked actor, other recipients still get deliveries', async () => {
      const policy = defaultPolicy({
        recipients: [
          { actorId: TEST_ACTOR_A, channels: ['in_app'], quietHours: null },
          { actorId: TEST_ACTOR_B, channels: ['in_app'], quietHours: null },
        ],
      });
      const local = createFixture(policy);
      local.store.createNotificationEvent.mockResolvedValue(mockEvent());
      local.store.enqueueNotification.mockResolvedValue(mockOutbox());

      local.runtime.setReAuthorizationHook(async (actorId) => {
        return actorId === TEST_ACTOR_B;
      });

      const result = await local.runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(1);
      expect(local.store.enqueueNotification).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Redaction
  // -----------------------------------------------------------------------

  describe('redaction', () => {
    it('redacts sensitive fields from payload for actors without notification:admin', async () => {
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const event = mockEvent({ redactionClass: 'sensitive' });
      const redacted = await runtime.redactForActor(event, TEST_ACTOR_A);

      expect(redacted.title).toBe('Budget Alert');
      expect(redacted.summary).toBe('You exceeded your dining budget');
      expect(redacted.amount).toBeUndefined();
      expect(redacted.account).toBeUndefined();
      expect(redacted.internalNote).toBeUndefined();
    });

    it('shows all fields for actors with notification:admin capability', async () => {
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:admin', 'notification:receive'],
        scope: TEST_BUDGET,
      });

      const event = mockEvent({ redactionClass: 'sensitive' });
      const redacted = await runtime.redactForActor(event, TEST_ACTOR_A);

      expect(redacted.title).toBe('Budget Alert');
      expect(redacted.amount).toBe(15000);
      expect(redacted.account).toBe('Checking');
      expect(redacted.internalNote).toBe('audit:12345');
    });

    it('returns empty object for unknown redaction class', async () => {
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const event = mockEvent({ redactionClass: 'nonexistent' });
      const redacted = await runtime.redactForActor(event, TEST_ACTOR_A);

      expect(redacted).toEqual({});
    });

    it('uses default redaction class when event has null', async () => {
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const event = mockEvent({ redactionClass: null });
      const redacted = await runtime.redactForActor(event, TEST_ACTOR_A);

      expect(redacted.title).toBe('Budget Alert');
      expect(redacted.amount).toBe(15000);
      expect(redacted.internalNote).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Quiet hours
  // -----------------------------------------------------------------------

  describe('quiet hours', () => {
    it('suppresses notification during quiet hours window', async () => {
      vi.setSystemTime(new Date('2026-07-27T23:30:00Z'));

      const policy = defaultPolicy({
        recipients: [
          {
            actorId: TEST_ACTOR_A,
            channels: ['in_app'],
            quietHours: { startLocal: '22:00', endLocal: '07:00' },
          },
        ],
      });
      const local = createFixture(policy);
      local.store.createNotificationEvent.mockResolvedValue(mockEvent());
      local.store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const result = await local.runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(0);
      expect(local.store.enqueueNotification).not.toHaveBeenCalled();
    });

    it('delivers notification outside quiet hours window', async () => {
      vi.setSystemTime(new Date('2026-07-27T14:00:00Z'));

      const policy = defaultPolicy({
        recipients: [
          {
            actorId: TEST_ACTOR_A,
            channels: ['in_app'],
            quietHours: { startLocal: '22:00', endLocal: '07:00' },
          },
        ],
      });
      const local = createFixture(policy);
      local.store.createNotificationEvent.mockResolvedValue(mockEvent());
      local.store.enqueueNotification.mockResolvedValue(mockOutbox());
      local.store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const result = await local.runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(1);
      expect(local.store.enqueueNotification).toHaveBeenCalledTimes(1);
    });

    it('delivers when recipient has no quiet hours configured', async () => {
      const event = mockEvent();
      const outbox = mockOutbox();
      store.createNotificationEvent.mockResolvedValue(event);
      store.enqueueNotification.mockResolvedValue(outbox);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const result = await runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Rate limits
  // -----------------------------------------------------------------------

  describe('rate limits', () => {
    it('suppresses notifications that exceed rate limit', async () => {
      const policy = defaultPolicy({
        channels: [
          { type: 'in_app', enabled: true, rateLimitPerMinute: 1, displayName: 'In-App' },
        ],
      });
      const local = createFixture(policy);
      local.store.createNotificationEvent.mockResolvedValue(mockEvent());
      local.store.enqueueNotification.mockResolvedValue(mockOutbox());
      local.store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      await local.runtime.create(defaultInput({ correlationId: 'first' }));
      expect(local.store.enqueueNotification).toHaveBeenCalledTimes(1);

      local.store.createNotificationEvent.mockResolvedValue(mockEvent({ id: 'evt_002' }));
      await local.runtime.create(defaultInput({ correlationId: 'second' }));

      expect(local.store.enqueueNotification).toHaveBeenCalledTimes(1);
    });

    it('allows burst up to rate limit then blocks', async () => {
      const policy = defaultPolicy({
        channels: [
          { type: 'in_app', enabled: true, rateLimitPerMinute: 3, displayName: 'In-App' },
        ],
      });
      const local = createFixture(policy);
      local.store.createNotificationEvent.mockResolvedValue(mockEvent());
      local.store.enqueueNotification.mockResolvedValue(mockOutbox());
      local.store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      for (let i = 0; i < 4; i++) {
        local.store.createNotificationEvent.mockResolvedValue(
          mockEvent({ id: `evt_${i}` }),
        );
        await local.runtime.create(defaultInput({ correlationId: `batch_${i}` }));
      }

      expect(local.store.enqueueNotification).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------------------
  // Retry and crash recovery
  // -----------------------------------------------------------------------

  describe('retry / crash recovery', () => {
    it('fails delivery and schedules retry when adapter returns error', async () => {
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'pending', attemptCount: 0 }),
      );
      store.getNotificationEvent.mockResolvedValue(mockEvent());
      store.failNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'failed', attemptCount: 1, failureReason: 'Channel adapter unhealthy' }),
      );

      adapter.setHealthy(false);
      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_001');

      expect(outcome.status).toBe('retryable');
      expect(store.failNotificationDelivery).toHaveBeenCalled();
      expect(outcome.errorMessage).toBe('Channel adapter unhealthy');
    });

    it('terminally fails after exhausting retries', async () => {
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({
          status: 'delivering',
          attemptCount: 3,
          maxAttempts: 3,
        }),
      );
      store.getNotificationEvent.mockResolvedValue(mockEvent());
      store.failNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'failed', attemptCount: 4, failureReason: 'Channel adapter unhealthy' }),
      );

      adapter.setHealthy(false);
      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_002');

      expect(outcome.status).toBe('failed');
    });

    it('recovers from crash — reclaims expired claim', async () => {
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({
          status: 'delivering',
          attemptCount: 1,
          maxAttempts: 3,
          claimToken: 'stale_tok',
          claimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      store.getNotificationEvent.mockResolvedValue(mockEvent());
      store.completeNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'delivered', attemptCount: 2 }),
      );

      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_recovery');

      expect(outcome.status).toBe('delivered');
    });

    it('returns failed when claim fails (already claimed by another worker)', async () => {
      store.claimNotificationDelivery.mockResolvedValue(null);

      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_conflict');

      expect(outcome.status).toBe('failed');
    });
  });

  // -----------------------------------------------------------------------
  // Malformed callback
  // -----------------------------------------------------------------------

  describe('malformed callback acknowledgement', () => {
    it('acknowledges notification despite garbage callback data', async () => {
      const record = mockOutbox({ status: 'delivered' });
      store.acknowledgeNotification.mockResolvedValue(record);

      const result = await runtime.acknowledgeFromCallback(TEST_OUTBOX_ID, {
        garbage: 'data',
        malicious: '<script>',
        nullByte: '\0',
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe('delivered');
      expect(store.acknowledgeNotification).toHaveBeenCalledWith(TEST_OUTBOX_ID);
    });

    it('acknowledges with empty callback data', async () => {
      const record = mockOutbox({ status: 'delivered' });
      store.acknowledgeNotification.mockResolvedValue(record);

      const result = await runtime.acknowledgeFromCallback(TEST_OUTBOX_ID, {});

      expect(result.status).toBe('delivered');
    });

    it('acknowledgement only changes notification state (no other mutations)', async () => {
      store.acknowledgeNotification.mockResolvedValue(
        mockOutbox({ status: 'delivered' }),
      );

      await runtime.acknowledgeFromCallback(TEST_OUTBOX_ID, { action: 'DELETE_ALL' });

      expect(store.acknowledgeNotification).toHaveBeenCalledTimes(1);
      expect(store.completeNotificationDelivery).not.toHaveBeenCalled();
      expect(store.failNotificationDelivery).not.toHaveBeenCalled();
      expect(store.suppressNotification).not.toHaveBeenCalled();
      expect(store.createNotificationEvent).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Channel adapter outage
  // -----------------------------------------------------------------------

  describe('channel adapter outage', () => {
    it('fails delivery when adapter reports unhealthy', async () => {
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'pending', attemptCount: 0 }),
      );

      adapter.setHealthy(false);

      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_outage');

      expect(outcome.status).toBe('retryable');
      expect(outcome.errorMessage).toBe('Channel adapter unhealthy');
    });

    it('runtime status reflects unhealthy adapter', async () => {
      store.getPendingNotifications.mockResolvedValue([]);
      store.getRetryableNotifications.mockResolvedValue([]);

      adapter.setHealthy(false);

      const status = await runtime.getStatus();

      expect(status.healthy).toBe(false);
      expect(status.channelStatuses).toHaveLength(1);
      expect(status.channelStatuses[0].healthy).toBe(false);
    });

    it('recovers after adapter becomes healthy again', async () => {
      store.getPendingNotifications.mockResolvedValue([]);
      store.getRetryableNotifications.mockResolvedValue([]);

      adapter.setHealthy(false);
      let status = await runtime.getStatus();
      expect(status.healthy).toBe(false);

      adapter.setHealthy(true);
      status = await runtime.getStatus();
      expect(status.healthy).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // All channels disabled
  // -----------------------------------------------------------------------

  describe('all channels disabled', () => {
    it('creates event but no outbox records when all channels disabled', async () => {
      const policy = defaultPolicy({
        channels: [
          { type: 'in_app', enabled: false, rateLimitPerMinute: 60, displayName: 'In-App' },
          { type: 'email', enabled: false, rateLimitPerMinute: 10, displayName: 'Email' },
        ],
      });
      const local = createFixture(policy);
      const event = mockEvent();
      local.store.createNotificationEvent.mockResolvedValue(event);

      const result = await local.runtime.create(defaultInput());

      expect(result.event.id).toBe(TEST_EVENT_ID);
      expect(result.outboxRecords).toHaveLength(0);
      expect(local.store.enqueueNotification).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Dispatch and batch processing
  // -----------------------------------------------------------------------

  describe('dispatch', () => {
    it('delivers successfully through in-app adapter', async () => {
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'pending', attemptCount: 0 }),
      );
      store.getNotificationEvent.mockResolvedValue(mockEvent());
      store.completeNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'delivered', attemptCount: 1 }),
      );

      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_deliver');

      expect(outcome.status).toBe('delivered');
      expect(outcome.attemptNumber).toBe(1);
    });

    it('fails when no adapter registered for channel type', async () => {
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'pending', channelType: 'webhook', attemptCount: 0 }),
      );
      store.failNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'failed', channelType: 'webhook' }),
      );

      const outcome = await runtime.dispatch(TEST_OUTBOX_ID, 'tok_no_adapter');

      expect(outcome.status).toBe('failed');
      expect(outcome.errorMessage).toContain('No adapter registered');
    });
  });

  describe('processPending', () => {
    it('processes all pending notifications', async () => {
      store.getPendingNotifications.mockResolvedValue([
        mockOutbox({ id: 'obx_001' }),
        mockOutbox({ id: 'obx_002' }),
      ]);
      store.claimNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'pending', attemptCount: 0 }),
      );
      store.getNotificationEvent.mockResolvedValue(mockEvent());
      store.completeNotificationDelivery.mockResolvedValue(
        mockOutbox({ status: 'delivered', attemptCount: 1 }),
      );

      const outcomes = await runtime.processPending(10);

      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].status).toBe('delivered');
      expect(outcomes[1].status).toBe('delivered');
    });
  });

  // -----------------------------------------------------------------------
  // Runtime status
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns healthy status when everything is operational', async () => {
      store.getPendingNotifications.mockResolvedValue([]);
      store.getRetryableNotifications.mockResolvedValue([]);

      const status = await runtime.getStatus();

      expect(status.healthy).toBe(true);
      expect(status.storeConnected).toBe(true);
      expect(status.pendingCount).toBe(0);
      expect(status.failedCount).toBe(0);
    });

    it('reports store disconnection', async () => {
      store.getPendingNotifications.mockRejectedValue(new Error('DB connection lost'));

      const status = await runtime.getStatus();

      expect(status.storeConnected).toBe(false);
      expect(status.healthy).toBe(false);
    });

    it('reports pending and failed counts', async () => {
      store.getPendingNotifications.mockResolvedValue([
        mockOutbox({ id: 'obx_001' }),
        mockOutbox({ id: 'obx_002' }),
      ]);
      store.getRetryableNotifications.mockResolvedValue([
        mockOutbox({ id: 'obx_003' }),
      ]);

      const status = await runtime.getStatus();

      expect(status.pendingCount).toBe(2);
      expect(status.failedCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Stored policy
  // -----------------------------------------------------------------------

  describe('getStoredPolicy', () => {
    it('returns in-memory policy when no stored policy exists', async () => {
      store.getNotificationPolicy.mockResolvedValue(null);

      const policy = await runtime.getStoredPolicy('space_default');

      expect(policy.policyVersion).toBe(TEST_POLICY_VER);
      // In-memory policy has 1 eligibility rule covering 2 classifications
      expect(policy.eligibility).toHaveLength(1);
      expect(policy.eligibility[0].classifications).toContain('budget_alert');
      expect(policy.eligibility[0].classifications).toContain('review_complete');
    });

    it('merges stored policy with in-memory defaults', async () => {
      store.getNotificationPolicy.mockResolvedValue({
        id: 'pol_001',
        spaceId: 'space_default',
        policyKey: 'notification',
        policyVersion: 'v2',
        policy: JSON.stringify({ maxRetries: 5 }),
        isActive: true,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      });

      const policy = await runtime.getStoredPolicy('space_default');

      expect(policy.policyVersion).toBe('v2');
      expect(policy.maxRetries).toBe(5);
      // In-memory defaults preserved for missing fields
      expect(policy.eligibility).toHaveLength(1);
      expect(policy.defaultRedactionClass).toBe('public');
    });

    it('falls back to in-memory policy when stored policy JSON is malformed', async () => {
      store.getNotificationPolicy.mockResolvedValue({
        id: 'pol_002',
        spaceId: 'space_default',
        policyKey: 'notification',
        policyVersion: 'v3',
        policy: '{invalid json}',
        isActive: true,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      });

      const policy = await runtime.getStoredPolicy('space_default');

      expect(policy.policyVersion).toBe(TEST_POLICY_VER);
      expect(policy.maxRetries).toBe(3);
    });
  });

  describe('getStoredPolicyVersion', () => {
    it('returns null when no stored policy exists', async () => {
      store.getNotificationPolicy.mockResolvedValue(null);

      const version = await runtime.getStoredPolicyVersion('space_default');

      expect(version).toBeNull();
    });

    it('returns the stored policy version', async () => {
      store.getNotificationPolicy.mockResolvedValue({
        id: 'pol_003',
        spaceId: 'space_default',
        policyKey: 'notification',
        policyVersion: 'v2',
        policy: '{}',
        isActive: true,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      });

      const version = await runtime.getStoredPolicyVersion('space_default');

      expect(version).toBe('v2');
    });
  });

  // -----------------------------------------------------------------------
  // Inbox listing
  // -----------------------------------------------------------------------

  describe('listOutbox', () => {
    it('returns records for the matching actor with redacted payload', async () => {
      const event = mockEvent({ recipientId: TEST_ACTOR_A });
      const outbox = mockOutbox({ eventId: event.id });
      store.listOutboxRecords.mockResolvedValue([outbox]);
      store.getNotificationEvent.mockResolvedValue(event);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });
      store.getDeliveryAttempts.mockResolvedValue([]);

      const items = await runtime.listOutbox(TEST_ACTOR_A);

      expect(items).toHaveLength(1);
      expect(items[0].outbox.id).toBe(TEST_OUTBOX_ID);
      expect(items[0].event.id).toBe(TEST_EVENT_ID);
      expect(items[0].redactedPayload.title).toBe('Budget Alert');
      expect(items[0].deliveryAttempts).toEqual([]);
    });

    it('skips records where the event is missing', async () => {
      const outbox = mockOutbox();
      store.listOutboxRecords.mockResolvedValue([outbox]);
      store.getNotificationEvent.mockResolvedValue(null);

      const items = await runtime.listOutbox(TEST_ACTOR_A);

      expect(items).toHaveLength(0);
    });

    it('filters records by recipientId — excludes non-matching actors', async () => {
      const event = mockEvent({ recipientId: 'usr_other', id: 'evt_other' });
      const outbox = mockOutbox({ eventId: 'evt_other', id: 'obx_other' });
      store.listOutboxRecords.mockResolvedValue([outbox]);
      store.getNotificationEvent.mockResolvedValue(event);

      const items = await runtime.listOutbox(TEST_ACTOR_A);

      expect(items).toHaveLength(0);
    });

    it('passes filter options to the store', async () => {
      store.listOutboxRecords.mockResolvedValue([]);

      await runtime.listOutbox(TEST_ACTOR_A, { status: 'delivered', channelType: 'in_app', limit: 10, offset: 5 });

      expect(store.listOutboxRecords).toHaveBeenCalledWith({
        status: 'delivered',
        channelType: 'in_app',
        limit: 10,
        offset: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Outbox detail
  // -----------------------------------------------------------------------

  describe('getOutboxDetail', () => {
    it('returns detail for the intended recipient', async () => {
      const event = mockEvent({ recipientId: TEST_ACTOR_A });
      const outbox = mockOutbox({ eventId: event.id });
      store.getOutboxRecord.mockResolvedValue(outbox);
      store.getNotificationEvent.mockResolvedValue(event);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });
      store.getDeliveryAttempts.mockResolvedValue([]);

      const detail = await runtime.getOutboxDetail(TEST_OUTBOX_ID, TEST_ACTOR_A);

      expect(detail).not.toBeNull();
      expect(detail!.outbox.id).toBe(TEST_OUTBOX_ID);
      expect(detail!.event.id).toBe(TEST_EVENT_ID);
    });

    it('returns null for outbox that does not exist', async () => {
      store.getOutboxRecord.mockResolvedValue(null);

      const detail = await runtime.getOutboxDetail('nonexistent', TEST_ACTOR_A);

      expect(detail).toBeNull();
    });

    it('returns null for mismatch between actor and recipient', async () => {
      const event = mockEvent({ recipientId: 'usr_other' });
      const outbox = mockOutbox({ eventId: event.id });
      store.getOutboxRecord.mockResolvedValue(outbox);
      store.getNotificationEvent.mockResolvedValue(event);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const detail = await runtime.getOutboxDetail(TEST_OUTBOX_ID, TEST_ACTOR_A);

      expect(detail).toBeNull();
    });

    it('allows admin to view any notification', async () => {
      const event = mockEvent({ recipientId: 'usr_other' });
      const outbox = mockOutbox({ eventId: event.id });
      store.getOutboxRecord.mockResolvedValue(outbox);
      store.getNotificationEvent.mockResolvedValue(event);
      store.getActorMembership.mockResolvedValue({
        actorId: 'usr_admin',
        status: 'active',
        capabilities: ['notification:admin'],
        scope: '*',
      });
      store.getDeliveryAttempts.mockResolvedValue([]);

      const detail = await runtime.getOutboxDetail(TEST_OUTBOX_ID, 'usr_admin');

      expect(detail).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Audit — recordAudit input validation
  // -----------------------------------------------------------------------

  describe('audit — recordAudit respects AppendAuditInput contract', () => {
    const APPEND_AUDIT_KEYS: Array<keyof AppendAuditInput> = [
      'classification',
      'actorId',
      'operation',
      'proposalId',
      'payloadHash',
      'budgetId',
      'backendIds',
      'policyVersion',
      'authorizationDisposition',
      'idempotencyKey',
      'expectedPriorState',
      'observedResultState',
      'providerModel',
      'correlationId',
      'requestId',
      'result',
      'isError',
    ];

    function auditInvocationArgs(): Record<string, unknown> {
      const calls = store.appendAuditRecord.mock.calls;
      if (calls.length === 0) throw new Error('appendAuditRecord was never called');
      return calls[0][0];
    }

    beforeEach(() => {
      const event = mockEvent();
      const outbox = mockOutbox();
      store.createNotificationEvent.mockResolvedValue(event);
      store.enqueueNotification.mockResolvedValue(outbox);
    });

    it('does NOT pass targetId to appendAuditRecord', async () => {
      await runtime.create(defaultInput());

      const args = auditInvocationArgs();
      expect(args).not.toHaveProperty('targetId');
    });

    it('does NOT pass payload to appendAuditRecord', async () => {
      await runtime.create(defaultInput());

      const args = auditInvocationArgs();
      expect(args).not.toHaveProperty('payload');
    });

    it('passes result field', async () => {
      await runtime.create(defaultInput());

      const args = auditInvocationArgs();
      expect(args).toHaveProperty('result');
      expect(typeof args.result).toBe('string');
    });

    it('passes only keys that exist in AppendAuditInput', async () => {
      await runtime.create(defaultInput());

      const args = auditInvocationArgs();
      const passedKeys = Object.keys(args);
      for (const key of passedKeys) {
        expect(APPEND_AUDIT_KEYS).toContain(key);
      }
    });

    it('preserves eventId correlation via correlationId', async () => {
      await runtime.create(defaultInput());

      const args = auditInvocationArgs();
      // At least one audit call should carry the event id as correlation
      expect(args.correlationId).toBe(TEST_EVENT_ID);
    });
  });

  // -----------------------------------------------------------------------
  // Enhanced RuntimeStatus — disabled/outage channels
  // -----------------------------------------------------------------------

  describe('getStatus — disabled/outage channels', () => {
    it('includes disabledChannels from policy', async () => {
      store.getPendingNotifications.mockResolvedValue([]);
      store.getRetryableNotifications.mockResolvedValue([]);

      const policy = defaultPolicy({
        channels: [
          { type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
          { type: 'email', enabled: false, rateLimitPerMinute: 10, displayName: 'Email' },
        ],
      });
      const local = createFixture(policy);

      const status = await local.runtime.getStatus();

      expect(status.disabledChannels).toEqual(['email']);
    });

    it('includes outageChannels when adapter is unhealthy', async () => {
      store.getPendingNotifications.mockResolvedValue([]);
      store.getRetryableNotifications.mockResolvedValue([]);

      adapter.setHealthy(false);
      const status = await runtime.getStatus();

      expect(status.outageChannels).toEqual(['in_app']);
    });

    it('returns empty disabledChannels when all channels enabled', async () => {
      store.getPendingNotifications.mockResolvedValue([]);
      store.getRetryableNotifications.mockResolvedValue([]);

      const status = await runtime.getStatus();

      expect(status.disabledChannels).toEqual([]);
      expect(status.outageChannels).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Store-backed per-space policy loading
  // -----------------------------------------------------------------------

  describe('loadPersistedPolicy', () => {
    it('loads and applies persisted policy for a space', async () => {
      const persistedPolicy = {
        id: 'pol_space_1',
        spaceId: 'space_1',
        policyKey: 'notification',
        policyVersion: 'v3',
        policy: JSON.stringify({
          maxRetries: 5,
          defaultRedactionClass: 'restricted',
        }),
        isActive: true,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      };
      store.getNotificationPolicy.mockResolvedValue(persistedPolicy);

      const loadedPolicy = await runtime.loadPersistedPolicy('space_1');

      expect(loadedPolicy.policyVersion).toBe('v3');
      expect(loadedPolicy.maxRetries).toBe(5);
      expect(loadedPolicy.defaultRedactionClass).toBe('restricted');
    });

    it('falls back to in-memory policy when no persisted policy exists', async () => {
      store.getNotificationPolicy.mockResolvedValue(null);

      const loadedPolicy = await runtime.loadPersistedPolicy('space_nonexistent');

      expect(loadedPolicy.policyVersion).toBe(TEST_POLICY_VER);
      expect(loadedPolicy.maxRetries).toBe(3);
    });

    it('returns the active policy record for a space', async () => {
      const persistedPolicy = {
        id: 'pol_space_2',
        spaceId: 'space_2',
        policyKey: 'notification',
        policyVersion: 'v5',
        policy: JSON.stringify({ maxRetries: 7 }),
        isActive: true,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      };
      store.getNotificationPolicy.mockResolvedValue(persistedPolicy);

      const loadedPolicy = await runtime.loadPersistedPolicy('space_2');

      expect(loadedPolicy.policyVersion).toBe('v5');
      expect(loadedPolicy.maxRetries).toBe(7);
      // Eligibility rules from default policy preserved
      expect(loadedPolicy.eligibility).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Store-backed re-authorization
  // -----------------------------------------------------------------------

  describe('store-backed re-authorization', () => {
    it('uses store membership for re-auth when no hook is set', async () => {
      const event = mockEvent();
      const outbox = mockOutbox();
      store.createNotificationEvent.mockResolvedValue(event);
      store.enqueueNotification.mockResolvedValue(outbox);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      const result = await runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(2);
      expect(store.getActorMembership).toHaveBeenCalled();
    });

    it('suppresses notification when store membership is inactive', async () => {
      const event = mockEvent();
      store.createNotificationEvent.mockResolvedValue(event);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'inactive',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      runtime.setReAuthorizationHook(null);
      const result = await runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(0);
    });

    it('suppresses notification when store membership lacks required capability', async () => {
      const event = mockEvent();
      store.createNotificationEvent.mockResolvedValue(event);
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['other:capability'],
        scope: TEST_BUDGET,
      });

      runtime.setReAuthorizationHook(null);
      const result = await runtime.create(defaultInput());

      expect(result.outboxRecords).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Deterministic producer entry points
  // -----------------------------------------------------------------------

  describe('producers — deterministic event entry points', () => {
    beforeEach(() => {
      store.createNotificationEvent.mockImplementation(async () => {
        // Return the classification from the most recent call args
        const args = store.createNotificationEvent.mock.calls;
        const lastCall = args[args.length - 1]?.[0];
        return mockEvent({
          classification: lastCall?.classification ?? 'budget_alert',
          budgetId: lastCall?.budgetId ?? TEST_BUDGET,
        });
      });
      store.enqueueNotification.mockResolvedValue(mockOutbox());
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });
    });

    it('produceDataQualityEvent creates event with data_quality classification', async () => {
      const result = await runtime.produceDataQualityEvent({
        budgetId: TEST_BUDGET,
        findingId: 'fq_001',
        severity: 'high',
        title: 'Missing category',
        description: '3 transactions lack category',
        affectedCount: 3,
      });

      expect(result.event.classification).toBe('data_quality');
      expect(store.createNotificationEvent).toHaveBeenCalledTimes(1);
      const eventInput = store.createNotificationEvent.mock.calls[0][0];
      expect(eventInput.classification).toBe('data_quality');
      const payload = eventInput.payload as Record<string, unknown>;
      expect(payload.findingId).toBe('fq_001');
      expect(payload.affectedCount).toBe(3);
    });

    it('produceAlertEvent creates event with alert classification', async () => {
      const result = await runtime.produceAlertEvent({
        budgetId: TEST_BUDGET,
        alertId: 'alr_001',
        severity: 'critical',
        title: 'Budget overspend',
        summary: 'Dining budget exceeded by $50',
      });

      expect(result.event.classification).toBe('alert');
      const eventInput = store.createNotificationEvent.mock.calls[0][0];
      const payload = eventInput.payload as Record<string, unknown>;
      expect(payload.alertId).toBe('alr_001');
      expect(payload.title).toBe('Budget overspend');
    });

    it('produceRecurrenceEvent creates event with recurrence classification', async () => {
      const result = await runtime.produceRecurrenceEvent({
        budgetId: TEST_BUDGET,
        findingId: 'rec_001',
        severity: 'normal',
        title: 'Duplicate transaction detected',
        merchant: 'Coffee Shop',
        duplicateCount: 2,
      });

      expect(result.event.classification).toBe('recurrence');
      const eventInput = store.createNotificationEvent.mock.calls[0][0];
      const payload = eventInput.payload as Record<string, unknown>;
      expect(payload.findingId).toBe('rec_001');
      expect(payload.duplicateCount).toBe(2);
    });

    it('produceTargetRiskEvent creates event with target_risk classification', async () => {
      const result = await runtime.produceTargetRiskEvent({
        budgetId: TEST_BUDGET,
        findingId: 'tr_001',
        severity: 'high',
        title: 'Sinking fund behind schedule',
        targetName: 'Vacation Fund',
        shortfallPercent: 15,
      });

      expect(result.event.classification).toBe('target_risk');
      const eventInput = store.createNotificationEvent.mock.calls[0][0];
      const payload = eventInput.payload as Record<string, unknown>;
      expect(payload.targetName).toBe('Vacation Fund');
      expect(payload.shortfallPercent).toBe(15);
    });

    it('produceProposalTransitionEvent creates event with proposal_transition classification', async () => {
      const result = await runtime.produceProposalTransitionEvent({
        budgetId: TEST_BUDGET,
        proposalId: 'prop_001',
        severity: 'normal',
        title: 'Proposal approved',
        fromStatus: 'pending_review',
        toStatus: 'approved',
      });

      expect(result.event.classification).toBe('proposal_transition');
      const eventInput = store.createNotificationEvent.mock.calls[0][0];
      const payload = eventInput.payload as Record<string, unknown>;
      expect(payload.proposalId).toBe('prop_001');
      expect(payload.fromStatus).toBe('pending_review');
      expect(payload.toStatus).toBe('approved');
    });

    it('produceWorkflowResultEvent creates event with workflow_result classification', async () => {
      const result = await runtime.produceWorkflowResultEvent({
        budgetId: TEST_BUDGET,
        workflowId: 'wf_001',
        severity: 'high',
        title: 'Analysis complete',
        summary: '5 transactions reviewed',
        result: 'completed',
      });

      expect(result.event.classification).toBe('workflow_result');
      const eventInput = store.createNotificationEvent.mock.calls[0][0];
      const payload = eventInput.payload as Record<string, unknown>;
      expect(payload.workflowId).toBe('wf_001');
      expect(payload.result).toBe('completed');
    });

    it('all producer calls are deterministic — same input produces same event classification and delivery key', async () => {
      const result1 = await runtime.produceDataQualityEvent({
        budgetId: TEST_BUDGET,
        findingId: 'fq_det',
        severity: 'normal',
        title: 'Test',
        description: 'Test',
        affectedCount: 1,
      });
      const result2 = await runtime.produceDataQualityEvent({
        budgetId: TEST_BUDGET,
        findingId: 'fq_det',
        severity: 'normal',
        title: 'Test',
        description: 'Test',
        affectedCount: 1,
      });

      expect(result1.event.classification).toBe(result2.event.classification);
      // Delivery keys are deterministic per event+channel
      expect(result1.outboxRecords[0].deliveryKey).toBe(result2.outboxRecords[0].deliveryKey);
    });

    it('producers persist event before outbox records', async () => {
      const callOrder: string[] = [];
      store.createNotificationEvent.mockImplementation(async () => {
        callOrder.push('event');
        return mockEvent();
      });
      store.enqueueNotification.mockImplementation(async () => {
        callOrder.push('outbox');
        return mockOutbox();
      });
      store.getActorMembership.mockResolvedValue({
        actorId: TEST_ACTOR_A,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: TEST_BUDGET,
      });

      await runtime.produceAlertEvent({
        budgetId: TEST_BUDGET,
        alertId: 'alr_order',
        severity: 'normal',
        title: 'Test',
        summary: 'Test',
      });

      // Event must be the first store call, outboxes come after
      expect(callOrder[0]).toBe('event');
      expect(callOrder.slice(1).every(c => c === 'outbox')).toBe(true);
    });

    it('producer events do not mutate ledger state', async () => {
      const ledgerMutations: string[] = [];
      // No ledger methods are available on the mock store —
      // any call to create/save/transition on the store mock
      // that isn't a notification method represents a ledger mutation.
      const notificationMethods = new Set([
        'createNotificationEvent', 'getNotificationEvent',
        'enqueueNotification', 'claimNotificationDelivery',
        'completeNotificationDelivery', 'failNotificationDelivery',
        'acknowledgeNotification', 'suppressNotification',
        'getOutboxRecord', 'getPendingNotifications',
        'getRetryableNotifications', 'getDeliveryAttempts',
        'listOutboxRecords',
        'getNotificationPolicy', 'getActorMembership',
        'appendAuditRecord',
        'resolveRecipients',
      ]);

      await runtime.produceAlertEvent({
        budgetId: TEST_BUDGET,
        alertId: 'alr_nop',
        severity: 'normal',
        title: 'Test',
        summary: 'Test',
      });

      // Check that no non-notification store methods were called
      for (const [method, mock] of Object.entries(store)) {
        if (!notificationMethods.has(method) && mock.mock.calls.length > 0) {
          ledgerMutations.push(method);
        }
      }
      expect(ledgerMutations).toEqual([]);
    });
  });
});
