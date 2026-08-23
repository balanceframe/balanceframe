/**
 * GET /api/notifications/:id — get notification detail (outbox record + event).
 *
 * Read-only with respect to ledger data (only reads notification state).
 * Distinguishes delivery state from finding state — returns the outbox record
 * with its redacted event payload and delivery history.
 *
 * Requires notification:receive capability.  Only the intended recipient or
 * an admin can view a notification.
 */

import { defineEventHandler, setResponseStatus, getRouterParam } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  getActorId,
} from '../../utils/workflow-store';
import {
  NotificationRuntime,
  InAppChannelAdapter,
  type NotificationPolicy,
} from '@balanceframe/application';

// Module-level singleton (lazy-initialised)
let runtime: NotificationRuntime | null = null;

function getRuntime(store: ReturnType<typeof getWorkflowStore>): NotificationRuntime {
  if (runtime) return runtime;
  if ('error' in store) throw new Error('Workflow store not available');
  const defaultPolicy: NotificationPolicy = {
    policyVersion: 'v1',
    eligibility: [],
    recipients: [],
    channels: [
      { type: 'in_app' as const, enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
    ],
    redaction: { public: { visibleFields: ['title', 'summary'] } },
    maxRetries: 3,
    defaultRedactionClass: 'public',
  };
  runtime = new NotificationRuntime(store.store, defaultPolicy, [new InAppChannelAdapter()]);
  return runtime;
}

const EVENT_METADATA_FIELDS = [
  'id',
  'eventVersion',
  'budgetId',
  'classification',
  'recipientId',
  'scope',
  'redactionClass',
  'channelConfigVersion',
  'policyVersion',
  'correlationId',
  'createdAt',
] as const;

const DELIVERY_STATE_FIELDS = [
  'id',
  'eventId',
  'deliveryKey',
  'channelType',
  'channelConfigVersion',
  'status',
  'attemptCount',
  'maxAttempts',
  'claimExpiresAt',
  'lastAttemptedAt',
  'nextAttemptAt',
  'acknowledgedAt',
  'failedAt',
  'failureReason',
  'suppressedAt',
  'suppressedReason',
  'correlationId',
  'createdAt',
  'updatedAt',
] as const;

const DELIVERY_ATTEMPT_FIELDS = [
  'id',
  'outboxId',
  'attemptNumber',
  'status',
  'responseCode',
  'attemptedAt',
  'success',
  'deliveredAt',
  'failureReason',
] as const;

interface NotificationDetail {
  readonly outbox: unknown;
  readonly event: unknown;
  readonly redactedPayload: Record<string, unknown>;
  readonly deliveryAttempts: readonly unknown[];
}

function pickSafeFields(source: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return {};

  const safe: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      safe[field] = (source as Record<string, unknown>)[field];
    }
  }
  return safe;
}

/** Convert persisted notification records into the browser-safe DTO. */
function sanitizeNotificationDetail(detail: NotificationDetail) {
  return {
    outbox: pickSafeFields(detail.outbox, DELIVERY_STATE_FIELDS),
    event: pickSafeFields(detail.event, EVENT_METADATA_FIELDS),
    redactedPayload: detail.redactedPayload,
    deliveryAttempts: detail.deliveryAttempts.map((attempt) =>
      pickSafeFields(attempt, DELIVERY_ATTEMPT_FIELDS),
    ),
  };
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();

  // Authorization gate
  const auth = await requireAuthorization(event, 'notification:receive');
  if (!auth.ok) {
    setResponseStatus(event, 403);
    return auth.response;
  }
  const authInfo = auth.info;

  try {
    const wf = getWorkflowStore(event);
    if ('error' in wf) {
      setResponseStatus(event, 503);
      return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
    }

    const rt = getRuntime(wf);
    const actorId = getActorId(event);
    const outboxId = getRouterParam(event, 'id');

    if (!outboxId) {
      setResponseStatus(event, 400);
      return errorEnvelope(
        'MISSING_ID',
        'Notification outbox ID is required.',
        authInfo,
        false,
        requestId,
      );
    }

    const detail = await rt.getOutboxDetail(outboxId, actorId);

    if (!detail) {
      setResponseStatus(event, 404);
      return errorEnvelope(
        'NOT_FOUND',
        'Notification not found or access denied.',
        authInfo,
        false,
        requestId,
      );
    }

    return okEnvelope(sanitizeNotificationDetail(detail), auth.info, requestId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    setResponseStatus(event, 503);
    return errorEnvelope('DETAIL_UNAVAILABLE', errorMessage, authInfo, false, requestId);
  }
});
