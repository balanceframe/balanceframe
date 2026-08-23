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

function isSensitivePayloadKey(key: string): boolean {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;

  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized.includes('payload') ||
    normalized.includes('rawevidence') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('apikey') ||
    normalized.includes('privatekey') ||
    normalized.includes('accesskey') ||
    normalized === 'authorization' ||
    normalized.endsWith('authorization') ||
    (normalized.includes('provider') &&
      (normalized.includes('auth') ||
        normalized.includes('cookie') ||
        normalized.includes('session') ||
        normalized.endsWith('key')))
  );
}

function sanitizePayloadValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) return null;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizePayloadValue(entry, ancestors));
    }

    const safe: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!isSensitivePayloadKey(key)) {
        safe[key] = sanitizePayloadValue(entry, ancestors);
      }
    }
    return safe;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeRedactedPayload(source: unknown): Record<string, unknown> {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return {};
  return sanitizePayloadValue(source, new Set()) as Record<string, unknown>;
}

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
    redactedPayload: sanitizeRedactedPayload(detail.redactedPayload),
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

    if (detail.event.recipientId !== undefined && detail.event.recipientId !== actorId) {
      const scope = typeof detail.event.scope === 'string' ? detail.event.scope.trim() : '';
      if (!scope) {
        setResponseStatus(event, 404);
        return errorEnvelope(
          'NOT_FOUND',
          'Notification not found or access denied.',
          authInfo,
          false,
          requestId,
        );
      }

      const adminAuth = await requireAuthorization(event, 'notification:admin', scope);
      if (!adminAuth.ok) {
        setResponseStatus(event, 404);
        return errorEnvelope(
          'NOT_FOUND',
          'Notification not found or access denied.',
          authInfo,
          false,
          requestId,
        );
      }
    }

    return okEnvelope(sanitizeNotificationDetail(detail), auth.info, requestId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    setResponseStatus(event, 503);
    return errorEnvelope('DETAIL_UNAVAILABLE', errorMessage, authInfo, false, requestId);
  }
});
