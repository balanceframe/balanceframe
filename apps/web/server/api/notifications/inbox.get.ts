/**
 * GET /api/notifications/inbox — list notification inbox (outbox records).
 *
 * Read-only with respect to ledger data (only reads notification state).
 * Distinguishes delivery state from finding state — returns outbox records
 * with their delivery status, redacted event payload, and delivery attempts.
 *
 * Requires notification:receive capability.
 */

import { defineEventHandler, getQuery, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { canReadFinancialNotification, selectedLiquidityActor } from '../../utils/liquidity-service';
import { createNotificationRuntime } from '../../utils/notification-runtime';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';

const InboxQuery = z.object({
  status: z.enum(['pending', 'delivering', 'delivered', 'failed', 'suppressed']).optional(),
  channel: z.enum(['in_app', 'email', 'webhook']).optional(),
  limit: z.coerce.number().int().min(0).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
}).strict();

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
    redactedPayload: sanitizeRedactedPayload(item.redactedPayload),
    deliveryAttempts: item.deliveryAttempts.map((attempt) =>
      pickSafeFields(attempt, DELIVERY_ATTEMPT_FIELDS),
    ),
  };
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'notification:receive',
    `budget:${budgetId}`,
  );
  if (!authorization.ok) return authorization.response;
  const query = InboxQuery.safeParse(getQuery(event));
  if (!query.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_QUERY', 'Notification inbox query is invalid.', authorization.info, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Notification inbox is unavailable.', authorization.info, false, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authorization.info, false, requestId);
  }

  try {
    const { runtime } = await createNotificationRuntime(workflow.store, selected.space.id);
    const storedItems = await runtime.listOutbox(selected.auth.actorId, {
      budgetId,
      status: query.data.status,
      channelType: query.data.channel,
      limit: query.data.limit,
      offset: query.data.offset,
      canReadEvent: async (notification) => {
        if (notification.spaceId !== selected.space.id || notification.budgetId !== budgetId ||
            notification.recipientId !== selected.auth.actorId ||
            notification.recipientMembershipId !== selected.membership.id)
          return false;
        return notification.classification !== 'transfer_needs_attention' ||
          canReadFinancialNotification(workflow.store, actor, notification);
      },
    });
    const items = storedItems.map(sanitizeNotificationItem);
    return okEnvelope({ items, count: items.length }, authorization.info, requestId);
  } catch {
    setResponseStatus(event, 503);
    return errorEnvelope('INBOX_UNAVAILABLE', 'Notification inbox is unavailable.', authorization.info, false, requestId);
  }
});
