import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { getHumanControlAuth, hasTrustedRequestOrigin } from '../../utils/reauthentication';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';

const ChannelType = z.enum(['in_app', 'email', 'webhook']);
const Severity = z.enum(['critical', 'high', 'normal', 'low']);
const NotificationPolicy = z.object({
  policyVersion: z.string().trim().min(1).max(100),
  eligibility: z.array(z.object({
    classifications: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
    minSeverity: Severity,
    requiredCapability: z.string().trim().min(1).max(100).optional(),
    requiredScope: z.string().trim().min(1).max(200).optional(),
  }).strict()).max(100),
  recipients: z.array(z.object({
    actorId: z.string().trim().min(1).max(200),
    channels: z.array(ChannelType).max(3),
    quietHours: z.object({
      startLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      endLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    }).strict().nullable(),
  }).strict()).max(1000),
  channels: z.array(z.object({
    type: ChannelType,
    enabled: z.boolean(),
    rateLimitPerMinute: z.number().int().min(1).max(10000),
    displayName: z.string().trim().min(1).max(100),
  }).strict()).max(10),
  redaction: z.record(z.string().trim().min(1).max(100), z.object({
    visibleFields: z.array(z.string().trim().min(1).max(100)).max(100),
  }).strict()),
  maxRetries: z.number().int().min(0).max(20),
  defaultRedactionClass: z.string().trim().min(1).max(100),
}).strict();

const Body = z.object({
  spaceId: z.string().trim().min(1).max(200).optional(),
  policy: NotificationPolicy,
}).strict();

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');

  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Notification policy is unavailable.', null, false, requestId);
  }
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;

  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'policy:manage',
    `space:${selected.space.id}`,
  );
  if (!authorization.ok) return authorization.response;

  const auth = await getHumanControlAuth(event as ReauthenticationEvent);
  if (!auth || auth.actorId !== selected.auth.actorId) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'HUMAN_CONTROL_REQUIRED',
      'Recent human reauthentication is required.',
      authorization.info,
      false,
      requestId,
    );
  }

  const body = Body.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_POLICY', 'A complete valid notification policy is required.', authorization.info, false, requestId);
  }
  if (body.data.spaceId !== undefined && body.data.spaceId !== selected.space.id) {
    setResponseStatus(event, 403);
    return errorEnvelope('SPACE_SCOPE_MISMATCH', 'The policy space must match the selected space.', authorization.info, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, authorization.info, false, requestId);
  }

  const now = new Date().toISOString();
  try {
    const hasForeignRecipient = body.data.policy.recipients.some((recipient) =>
      !workflow.store.governance.getCurrentMembership({
        spaceId: selected.space.id,
        actorId: recipient.actorId,
        now,
      }),
    );
    const expectedScope = selected.space.budgetId ? `budget:${selected.space.budgetId}` : null;
    const hasForeignScope = body.data.policy.eligibility.some((rule) =>
      rule.requiredScope !== undefined && rule.requiredScope !== expectedScope,
    );
    const hasUnexpectedCapability = body.data.policy.eligibility.some((rule) =>
      rule.requiredCapability !== undefined && rule.requiredCapability !== 'notification:receive',
    );
    if (hasForeignRecipient || hasForeignScope || hasUnexpectedCapability) {
      setResponseStatus(event, 400);
      return errorEnvelope(
        'INVALID_POLICY_SCOPE',
        'Notification recipients and scopes must remain within the selected space.',
        authorization.info,
        false,
        requestId,
      );
    }

    const saved = await workflow.store.saveNotificationPolicy({
      spaceId: selected.space.id,
      policyKey: 'notification',
      policyVersion: body.data.policy.policyVersion,
      policy: body.data.policy,
    });
    return okEnvelope(saved, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'SAVE_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
