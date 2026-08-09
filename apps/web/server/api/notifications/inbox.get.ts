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
  buildAuthorizationInfo,
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

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  // Authorization gate
  const auth = await requireAuthorization(event, 'notification:receive');
  if (!auth.ok) {
    setResponseStatus(event, 403);
    return auth.response;
  }

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

    const items = await rt.listOutbox(actorId, {
      status: statusFilter,
      channelType: query.channel || undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });

    return okEnvelope({ items, count: items.length }, auth.info, requestId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    setResponseStatus(event, 503);
    return errorEnvelope('INBOX_UNAVAILABLE', errorMessage, authInfo, false, requestId);
  }
});
