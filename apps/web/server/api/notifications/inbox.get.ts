/**
 * GET /api/notifications/inbox — list notification inbox (outbox records).
 *
 * Read-only with respect to ledger data (only reads notification state).
 * Distinguishes delivery state from finding state — returns outbox records
 * with their delivery status, redacted event payload, and delivery attempts.
 *
 * Requires notification:receive capability.
 */

import { defineEventHandler, setResponseStatus, getQuery } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  getActorId,
} from '../../utils/workflow-store';
import type { OutboxStatus } from '@balanceframe/workflow-store';
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

interface InboxQuery {
  status?: string;
  channel?: string;
  limit?: string;
  offset?: string;
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

interface NotificationItem {
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
function sanitizeNotificationItem(item: NotificationItem) {
  return {
    outbox: pickSafeFields(item.outbox, DELIVERY_STATE_FIELDS),
    event: pickSafeFields(item.event, EVENT_METADATA_FIELDS),
    redactedPayload: item.redactedPayload,
    deliveryAttempts: item.deliveryAttempts.map((attempt) =>
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
    const query = getQuery(event) as InboxQuery;

    const validStatuses: OutboxStatus[] = [
      'pending',
      'delivering',
      'delivered',
      'failed',
      'suppressed',
    ];
    const statusFilter: OutboxStatus | undefined =
      query.status && validStatuses.includes(query.status as OutboxStatus)
        ? (query.status as OutboxStatus)
        : undefined;

    const storedItems = await rt.listOutbox(actorId, {
      status: statusFilter,
      channelType: query.channel || undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
    const items = storedItems.map((item) => sanitizeNotificationItem(item));

    return okEnvelope({ items, count: items.length }, auth.info, requestId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    setResponseStatus(event, 503);
    return errorEnvelope('INBOX_UNAVAILABLE', errorMessage, authInfo, false, requestId);
  }
});
