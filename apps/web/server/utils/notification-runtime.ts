import {
  InAppChannelAdapter,
  NotificationRuntime,
} from '@balanceframe/application';
import type { NotificationPolicy } from '@balanceframe/application';
import type { WorkflowStore } from '@balanceframe/workflow-store';
import { z } from 'zod';

const ChannelType = z.enum(['in_app', 'email', 'webhook']);
const PersistedPolicy = z.object({
  eligibility: z.array(z.object({
    classifications: z.array(z.string()),
    minSeverity: z.enum(['critical', 'high', 'normal', 'low']),
    requiredCapability: z.string().optional(),
    requiredScope: z.string().optional(),
  }).passthrough()).optional(),
  recipients: z.array(z.object({
    actorId: z.string().min(1),
    channels: z.array(ChannelType),
    quietHours: z.object({ startLocal: z.string(), endLocal: z.string() }).nullable().optional(),
  }).passthrough()).optional(),
  channels: z.array(z.object({
    type: ChannelType,
    enabled: z.boolean(),
    rateLimitPerMinute: z.number().int().nonnegative().optional(),
    displayName: z.string().optional(),
  }).passthrough()).optional(),
  redaction: z.record(z.string(), z.object({ visibleFields: z.array(z.string()) }).passthrough()).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  defaultRedactionClass: z.string().min(1).optional(),
}).passthrough();

const defaultPolicy: NotificationPolicy = {
  policyVersion: 'v1',
  eligibility: [{
    classifications: [
      'budget_alert',
      'review_complete',
      'security_alert',
      'data_quality',
      'alert',
      'recurrence',
      'target_risk',
      'proposal_transition',
      'workflow_result',
    ],
    minSeverity: 'normal',
    requiredCapability: 'notification:receive',
  }],
  recipients: [],
  channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
  redaction: {
    sensitive: { visibleFields: ['title', 'summary'] },
    public: { visibleFields: ['title', 'summary', 'amount', 'account'] },
    restricted: { visibleFields: ['title'] },
  },
  maxRetries: 3,
  defaultRedactionClass: 'public',
};

export async function createNotificationRuntime(store: WorkflowStore, spaceId: string) {
  const record = await store.getNotificationPolicy(spaceId, 'notification');
  let policy = defaultPolicy;
  if (record) {
    const raw: unknown = typeof record.policy === 'string' ? JSON.parse(record.policy) : record.policy;
    const parsed = PersistedPolicy.safeParse(raw);
    if (!parsed.success) throw new Error('Selected-space notification policy is invalid');
    policy = {
      policyVersion: record.policyVersion,
      eligibility: parsed.data.eligibility ?? defaultPolicy.eligibility,
      recipients: parsed.data.recipients?.map((recipient) => ({
        ...recipient,
        quietHours: recipient.quietHours ?? null,
      })) ?? defaultPolicy.recipients,
      channels: parsed.data.channels?.map((channel) => ({
        ...channel,
        rateLimitPerMinute: channel.rateLimitPerMinute ?? 60,
        displayName: channel.displayName ?? channel.type,
      })) ?? defaultPolicy.channels,
      redaction: parsed.data.redaction ?? defaultPolicy.redaction,
      maxRetries: parsed.data.maxRetries ?? defaultPolicy.maxRetries,
      defaultRedactionClass: parsed.data.defaultRedactionClass ?? defaultPolicy.defaultRedactionClass,
    };
  }
  return {
    runtime: new NotificationRuntime(store, policy, [new InAppChannelAdapter()]),
    policy,
  };
}
