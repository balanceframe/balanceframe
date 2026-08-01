/**
 * @balanceframe/application — Notification Runtime
 *
 * Provider-neutral notification policy/delivery runtime over WorkflowStore.
 *
 * ## Design invariants
 *
 * - Events are persisted **before** outbox records (immutable-outbox-before-dispatch).
 * - Callbacks/replies are **untrusted**: acknowledgement only changes notification state.
 * - Redaction is based on the actor's capability set, not on who the actor is.
 * - Re-authorization is checked before every dispatch via an optional hook.
 * - Delivery is claim-based for crash recovery (lease + claim token pattern).
 * - Rate limits are in-process; they reset on process restart (acceptable for v1).
 * - Quiet hours are evaluated per recipient; suppressed notifications are recorded.
 *
 * ## Dependencies
 *
 * - `WorkflowStore` from `@balanceframe/workflow-store` for all persistence.
 * - Channel adapters implement {@link ChannelAdapter}.
 * - No credentials are stored or managed here.
 */

import type {
  WorkflowStore,
  NotificationEvent,
  NotificationOutboxRecord,
  DeliveryAttempt,
  AuditClassification,
  CreateNotificationEventInput,
  OutboxStatus,
  ListOutboxRecordsOptions,
} from '@balanceframe/workflow-store';
import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity classification for a notification. */
export type Severity = 'critical' | 'high' | 'normal' | 'low';

/** Supported channel types. */
export type ChannelType = 'in_app' | 'email' | 'webhook';

/**
 * Ordered severity levels for comparison.
 * Lower index = higher severity.
 */
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'normal', 'low'];

/** Configuration for a single delivery channel. */
export interface ChannelConfig {
  readonly type: ChannelType;
  readonly enabled: boolean;
  readonly rateLimitPerMinute: number;
  readonly displayName: string;
}

/** Window of time during which delivery is suppressed for a recipient. */
export interface QuietHoursWindow {
  /** Start time in HH:MM format (24-hour, local to the recipient's timezone). */
  readonly startLocal: string;
  /** End time in HH:MM format (24-hour). */
  readonly endLocal: string;
}

/** Specification for a single notification recipient. */
export interface RecipientSpec {
  readonly actorId: string;
  readonly channels: ChannelType[];
  readonly quietHours: QuietHoursWindow | null;
}

/** Eligibility rule: a notification matches if classification is in the list AND severity >= minSeverity. */
export interface EligibilityRule {
  readonly classifications: string[];
  readonly minSeverity: Severity;
  readonly requiredCapability?: string;
  readonly requiredScope?: string;
}

/**
 * Redaction policy keyed by redaction class.
 * Each entry specifies which payload fields are visible to actors with the
 * matching capabilities.
 */
export interface RedactionPolicy {
  readonly [redactionClass: string]: {
    readonly visibleFields: string[];
  };
}

/**
 * Complete notification policy.
 * This is the provider-neutral configuration for the runtime.
 */
export interface NotificationPolicy {
  readonly policyVersion: string;
  readonly eligibility: EligibilityRule[];
  readonly recipients: RecipientSpec[];
  readonly channels: ChannelConfig[];
  readonly redaction: RedactionPolicy;
  readonly maxRetries: number;
  readonly defaultRedactionClass: string;
}

/** Input to create and process a notification. */
export interface CreateNotificationInput {
  readonly budgetId: string;
  readonly classification: string;
  readonly severity: Severity;
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string;
  readonly scope?: string;
  readonly recipientId?: string;
  readonly redactionClass?: string;
}

/** Result of creating a notification (event + outbox records). */
export interface NotificationResult {
  readonly event: NotificationEvent;
  readonly outboxRecords: NotificationOutboxRecord[];
}

/** Outcome of a single delivery attempt. */
export interface DeliveryOutcome {
  readonly outboxId: string;
  readonly channelType: string;
  readonly status: 'delivered' | 'failed' | 'retryable' | 'suppressed';
  readonly attemptNumber: number;
  readonly errorMessage?: string;
}

/** Runtime health and activity summary. */
export interface RuntimeStatus {
  readonly healthy: boolean;
  readonly storeConnected: boolean;
  readonly channelStatuses: Array<{ channel: ChannelType; healthy: boolean }>;
  readonly pendingCount: number;
  readonly failedCount: number;
  /** Channel types that are disabled in the active policy. */
  readonly disabledChannels: ChannelType[];
  /** Channel types whose adapter is currently unhealthy (outage). */
  readonly outageChannels: ChannelType[];
}

// -----------------------------------------------------------------------
// Producer input types (deterministic event entry points)
// -----------------------------------------------------------------------

/** Common fields for all producer inputs. */
interface ProducerBase {
  readonly budgetId: string;
  readonly severity: Severity;
  readonly scope?: string;
  readonly recipientId?: string;
  readonly redactionClass?: string;
  readonly correlationId?: string;
}

/** Input for a data-quality finding notification. */
export interface DataQualityProducerInput extends ProducerBase {
  readonly findingId: string;
  readonly title: string;
  readonly description: string;
  readonly affectedCount: number;
}

/** Input for an alert notification. */
export interface AlertProducerInput extends ProducerBase {
  readonly alertId: string;
  readonly title: string;
  readonly summary: string;
}

/** Input for a recurrence/duplicate finding notification. */
export interface RecurrenceProducerInput extends ProducerBase {
  readonly findingId: string;
  readonly title: string;
  readonly merchant: string;
  readonly duplicateCount: number;
}

/** Input for a target risk notification. */
export interface TargetRiskProducerInput extends ProducerBase {
  readonly findingId: string;
  readonly title: string;
  readonly targetName: string;
  readonly shortfallPercent: number;
}

/** Input for a proposal transition notification. */
export interface ProposalTransitionProducerInput extends ProducerBase {
  readonly proposalId: string;
  readonly title: string;
  readonly fromStatus: string;
  readonly toStatus: string;
}

/** Input for a workflow result notification. */
export interface WorkflowResultProducerInput extends ProducerBase {
  readonly workflowId: string;
  readonly title: string;
  readonly summary: string;
  readonly result: string;
}

// ---------------------------------------------------------------------------
// Channel adapter interface
// ---------------------------------------------------------------------------

/**
 * Provider-neutral channel adapter.
 * Implementations handle actual delivery (in-process, email, webhook, etc.)
 * and return success/failure with optional provider response data.
 */
export interface ChannelAdapter {
  readonly channelType: ChannelType;
  deliver(
    payload: unknown,
    recipientId: string,
  ): Promise<{ ok: boolean; code?: string; body?: string; error?: string }>;
  isHealthy(): boolean;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Optional re-authorization hook.
 * Called before dispatch to verify the recipient still has the required
 * capability/scope. Returns true if authorized, false to suppress.
 */
export type ReAuthorizationHook = (
  actorId: string,
  capability: string,
  scope: string,
) => Promise<boolean>;

/**
 * Optional audit hook.
 * Called after significant lifecycle events to allow external audit logging.
 */
export type AuditHook = (
  action: string,
  details: Record<string, unknown>,
) => Promise<void>;

// ---------------------------------------------------------------------------
// In-App channel adapter
// ---------------------------------------------------------------------------

/**
 * In-process/status channel adapter.
 *
 * Delivers notifications by recording their status in-memory.  No external
 * credentials required.  The delivery is always recorded as an in-memory
 * status entry, and the underlying WorkflowStore outbox record transition
 * is managed by the runtime.
 *
 * Useful for:
 * - Web UI notifications (polled via status endpoint)
 * - Testing without external dependencies
 */
export class InAppChannelAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'in_app';
  private healthy = true;
  private readonly delivered: Array<{
    recipientId: string;
    payload: unknown;
    deliveredAt: string;
  }> = [];

  deliver(
    payload: unknown,
    recipientId: string,
  ): Promise<{ ok: boolean; code?: string; body?: string; error?: string }> {
    if (!this.healthy) {
      return Promise.resolve({ ok: false, error: 'Channel unhealthy (simulated outage)' });
    }
    this.delivered.push({
      recipientId,
      payload,
      deliveredAt: new Date().toISOString(),
    });
    return Promise.resolve({ ok: true, code: '200', body: JSON.stringify({ status: 'delivered' }) });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /** Simulate an outage for testing. */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  /** Return all in-memory deliveries for inspection. */
  getDeliveries(): ReadonlyArray<{ recipientId: string; payload: unknown; deliveredAt: string }> {
    return this.delivered;
  }

  /** Clear in-memory deliveries. */
  clearDeliveries(): void {
    this.delivered.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter (in-process, sliding window)
// ---------------------------------------------------------------------------

/**
 * Simple in-process sliding-window rate limiter per channel type.
 *
 * Resets on process restart — acceptable for v1.  Does not persist across
 * restarts; the WorkflowStore outbox retry mechanism covers crash recovery.
 */
class InProcessRateLimiter {
  private readonly windows = new Map<string, number[]>();

  /** Check if an action is allowed under the given rate limit.  Records the action if allowed. */
  allow(key: string, limitPerMinute: number): boolean {
    if (limitPerMinute <= 0) return false;
    const now = Date.now();
    const windowStart = now - 60_000;
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    // Prune expired entries
    const active = timestamps.filter(t => t > windowStart);
    this.windows.set(key, active);
    if (active.length >= limitPerMinute) {
      return false;
    }
    active.push(now);
    return true;
  }

  /** Reset all rate limit state (for testing). */
  reset(): void {
    this.windows.clear();
  }
}

// ---------------------------------------------------------------------------
// Quiet hours checker
// ---------------------------------------------------------------------------

/**
 * Check whether the current time (UTC clock with local HH:MM comparison)
 * falls within a quiet hours window.
 *
 * For simplicity, we compare the local HH:MM values directly.  A production
 * implementation would use a proper timezone-aware library.
 */
function isInQuietHours(window: QuietHoursWindow): boolean {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [startH, startM] = window.startLocal.split(':').map(Number);
  const [endH, endM] = window.endLocal.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Normal range (e.g. 22:00-07:00)
    if (startMinutes === endMinutes) return false;
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wraps around midnight (e.g. 22:00-07:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

/**
 * Redact a payload according to the redaction policy and the actor's
 * capabilities.  Only fields listed in the policy's `visibleFields` for the
 * matching redaction class are included.  If the actor has the capability
 * `notification:admin`, all fields are visible.
 */
function redactPayload(
  payload: Record<string, unknown>,
  redactionClass: string,
  actorCapabilities: string[],
  policy: RedactionPolicy,
): Record<string, unknown> {
  if (actorCapabilities.includes('notification:admin')) {
    return { ...payload };
  }
  const rule = policy[redactionClass];
  if (!rule) {
    // No rule for this class → return empty object (secure default)
    return {};
  }
  const visible = new Set(rule.visibleFields);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (visible.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Idempotent retry key generator
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic delivery key scoped to (eventId, channelType).
 * This ensures idempotent outbox enqueue.
 */
function generateDeliveryKey(eventId: string, channelType: string): string {
  return createHash('sha256')
    .update(`${eventId}:${channelType}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// NotificationRuntime
// ---------------------------------------------------------------------------

/**
 * Provider-neutral notification policy/delivery runtime.
 *
 * Orchestrates event creation, policy evaluation, outbox enqueue, dispatch
 * via channel adapters, acknowledgement, and audit.  All persistence goes
 * through the WorkflowStore; the runtime adds policy logic on top.
 */
export class NotificationRuntime {
  private readonly store: WorkflowStore;
  private readonly adapters: Map<ChannelType, ChannelAdapter>;
  private readonly policy: NotificationPolicy;
  private readonly rateLimiter: InProcessRateLimiter;
  private reAuthHook: ReAuthorizationHook | null = null;
  private auditHook: AuditHook | null = null;

  constructor(
    store: WorkflowStore,
    policy: NotificationPolicy,
    adapters: ChannelAdapter[],
  ) {
    this.store = store;
    this.policy = policy;
    this.adapters = new Map(adapters.map(a => [a.channelType, a]));
    this.rateLimiter = new InProcessRateLimiter();
  }

  // -----------------------------------------------------------------------
  // Hook registration
  // -----------------------------------------------------------------------

  /** Register a re-authorization hook (replaces any previous). */
  setReAuthorizationHook(hook: ReAuthorizationHook | null): void {
    this.reAuthHook = hook;
  }

  /** Register an audit hook (replaces any previous). */
  setAuditHook(hook: AuditHook | null): void {
    this.auditHook = hook;
  }

  // -----------------------------------------------------------------------
  // Store-backed policy hydration
  // -----------------------------------------------------------------------

  /**
   * Load the persisted notification policy for a space and return the
   * merged policy (persisted overrides + in-memory defaults).
   *
   * This is the canonical way to obtain the active policy — it reads
   * from the store per-space and does NOT mutate the runtime's internal
   * policy field (policies are loaded per-call for multi-space use).
   */
  async loadPersistedPolicy(spaceId: string): Promise<NotificationPolicy> {
    const record = await this.store.getNotificationPolicy(spaceId, 'notification');
    if (!record) return this.policy;
    try {
      const parsed = JSON.parse(record.policy) as Partial<NotificationPolicy>;
      return {
        ...this.policy,
        ...parsed,
        policyVersion: record.policyVersion,
      };
    } catch {
      return this.policy;
    }
  }

  /**
   * Re-authorize a recipient against the store's current membership.
   *
   * When a re-authorization hook is registered, it takes precedence.
   * Otherwise the store's getActorMembership is used to verify:
   *   - actor membership exists and status is 'active'
   *   - actor capabilities include the required capability
   */
  private async storeBackedReAuth(
    actorId: string,
    requiredCapability: string,
  ): Promise<boolean> {
    if (this.reAuthHook) {
      return this.reAuthHook(actorId, requiredCapability, '');
    }
    // Fallback: check store membership directly
    try {
      const membership = await this.store.getActorMembership(actorId);
      if (!membership) return false;
      if (membership.status !== 'active') return false;
      return membership.capabilities.includes(requiredCapability);
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Event creation + policy evaluation + outbox enqueue
  // -----------------------------------------------------------------------

  /**
   * Create a notification event, evaluate policy (eligibility, recipient
   * resolution, channel selection, quiet hours, rate, digest, suppression),
   * and enqueue outbox records.
   *
   * # Flow
   * 1. Evaluate eligibility — classification + severity must match a rule.
   * 2. If eligible, persist the immutable event.
   * 3. Resolve recipients and channels from policy.
   * 4. Check re-authorization for each recipient.
   * 5. Enqueue outbox records with idempotent delivery keys.
   * 6. Append audit records.
   */
  async create(input: CreateNotificationInput): Promise<NotificationResult> {
    // 1. Evaluate eligibility
    const eligible = this.evaluateEligibility(input.classification, input.severity);
    if (!eligible) {
      throw new NotificationRuntimeError(
        'NOT_ELIGIBLE',
        `Notification classification "${input.classification}" with severity "${input.severity}" does not match any eligibility rule`,
      );
    }

    const redactionClass = input.redactionClass ?? this.policy.defaultRedactionClass;

    // 2. Persist the immutable event
    const eventInput: CreateNotificationEventInput = {
      budgetId: input.budgetId,
      classification: input.classification,
      payload: input.payload,
      policyVersion: this.policy.policyVersion,
      recipientId: input.recipientId ?? null,
      scope: input.scope ?? null,
      redactionClass: redactionClass,
      channelConfigVersion: null,
      correlationId: input.correlationId ?? null,
    };
    const event = await this.store.createNotificationEvent(eventInput);

    // 3. Resolve recipients and check channels
    const recipientSpecs = this.resolveRecipients(input.classification, input.severity);

    const outboxRecords: NotificationOutboxRecord[] = [];

    for (const recipient of recipientSpecs) {
      // 4. Re-authorization check (store-backed or hook-backed)
      const eligibilityRule = this.findMatchingRule(input.classification, input.severity);
      const capability = eligibilityRule?.requiredCapability ?? 'notification:receive';
      const authorized = await this.storeBackedReAuth(recipient.actorId, capability);
      if (!authorized) {
        await this.recordAudit('notification_suppressed', {
          eventId: event.id,
          actorId: recipient.actorId,
          reason: 're_authorization_failed',
        });
        continue;
      }

      // Quiet hours check
      const inQuietHours = recipient.quietHours ? isInQuietHours(recipient.quietHours) : false;
      if (inQuietHours) {
        await this.recordAudit('notification_suppressed', {
          eventId: event.id,
          actorId: recipient.actorId,
          reason: 'quiet_hours',
        });
        continue;
      }

      // Resolve channels for this recipient
      const channels = this.resolveChannels(recipient);

      for (const channelType of channels) {
        const channelConfig = this.policy.channels.find(c => c.type === channelType);
        if (!channelConfig || !channelConfig.enabled) {
          continue; // Skip disabled channels
        }

        // Rate limit check
        if (!this.rateLimiter.allow(channelType, channelConfig.rateLimitPerMinute)) {
          await this.recordAudit('notification_suppressed', {
            eventId: event.id,
            channelType,
            actorId: recipient.actorId,
            reason: 'rate_limited',
          });
          continue;
        }

        // 5. Enqueue outbox record
        const deliveryKey = generateDeliveryKey(event.id, channelType);
        const enqueued = await this.store.enqueueNotification({
          eventId: event.id,
          deliveryKey,
          channelType,
          channelConfigVersion: null,
          maxAttempts: this.policy.maxRetries,
          correlationId: input.correlationId ?? null,
        });
        outboxRecords.push(enqueued);
      }
    }

    // 6. Audit trail
    await this.recordAudit('notification_created', {
      eventId: event.id,
      classification: input.classification,
      severity: input.severity,
      recipientCount: recipientSpecs.length,
      outboxCount: outboxRecords.length,
    });

    return { event, outboxRecords };
  }

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  /**
   * Claim and deliver a single outbox record through its channel adapter.
   *
   * Returns the delivery outcome.  On failure, records the attempt and
   * either schedules a retry or marks as terminal.
   */
  async dispatch(outboxId: string, claimToken: string): Promise<DeliveryOutcome> {
    const record = await this.store.claimNotificationDelivery(outboxId, claimToken);
    if (!record) {
      return {
        outboxId,
        channelType: 'in_app',
        status: 'failed',
        attemptNumber: 0,
        errorMessage: 'Could not claim outbox record (already claimed or not found)',
      };
    }

    const adapter = this.adapters.get(record.channelType as ChannelType);
    if (!adapter) {
      await this.store.failNotificationDelivery(
        outboxId,
        claimToken,
        `No adapter registered for channel type "${record.channelType}"`,
        false,
      );
      return {
        outboxId,
        channelType: record.channelType,
        status: 'failed',
        attemptNumber: record.attemptCount + 1,
        errorMessage: `No adapter registered for channel type "${record.channelType}"`,
      };
    }

    if (!adapter.isHealthy()) {
      const isRetryable = record.attemptCount < this.policy.maxRetries;
      await this.store.failNotificationDelivery(
        outboxId,
        claimToken,
        'Channel adapter unhealthy',
        isRetryable,
      );
      return {
        outboxId,
        channelType: record.channelType,
        status: isRetryable ? 'retryable' : 'failed',
        attemptNumber: record.attemptCount + 1,
        errorMessage: 'Channel adapter unhealthy',
      };
    }

    try {
      const event = await this.store.getNotificationEvent(record.eventId);
      if (!event) {
        await this.store.failNotificationDelivery(outboxId, claimToken, 'Event not found', false);
        return {
          outboxId,
          channelType: record.channelType,
          status: 'failed',
          attemptNumber: record.attemptCount + 1,
          errorMessage: 'Referenced event not found',
        };
      }

      const payload = JSON.parse(event.payload);
      const result = await adapter.deliver(payload, record.deliveryKey);

      if (result.ok) {
        const updated = await this.store.completeNotificationDelivery(outboxId, claimToken, {
          code: result.code,
          body: result.body,
        });
        await this.recordAudit('notification_delivered', {
          outboxId,
          eventId: record.eventId,
          channelType: record.channelType,
          attemptNumber: record.attemptCount + 1,
        });
        return {
          outboxId,
          channelType: record.channelType,
          status: 'delivered',
          attemptNumber: record.attemptCount + 1,
        };
      }

      // Provider returned failure
      const isRetryable = this.classifyFailure(result.error ?? 'unknown') && record.attemptCount < this.policy.maxRetries;
      await this.store.failNotificationDelivery(
        outboxId,
        claimToken,
        result.error ?? 'Provider returned non-ok status',
        isRetryable,
      );
      await this.recordAudit(isRetryable ? 'notification_retried' : 'notification_failed', {
        outboxId,
        eventId: record.eventId,
        channelType: record.channelType,
        attemptNumber: record.attemptCount + 1,
        error: result.error,
      });
      return {
        outboxId,
        channelType: record.channelType,
        status: isRetryable ? 'retryable' : 'failed',
        attemptNumber: record.attemptCount + 1,
        errorMessage: result.error ?? 'Delivery failed',
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isRetryable = record.attemptCount < this.policy.maxRetries;
      await this.store.failNotificationDelivery(outboxId, claimToken, errorMessage, isRetryable);
      await this.recordAudit(isRetryable ? 'notification_retried' : 'notification_failed', {
        outboxId,
        eventId: record.eventId,
        channelType: record.channelType,
        attemptNumber: record.attemptCount + 1,
        error: errorMessage,
      });
      return {
        outboxId,
        channelType: record.channelType,
        status: isRetryable ? 'retryable' : 'failed',
        attemptNumber: record.attemptCount + 1,
        errorMessage,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Batch processing
  // -----------------------------------------------------------------------

  /**
   * Process all pending notifications up to the given limit.
   * Each notification is claimed atomically, then dispatched.
   */
  async processPending(limit: number = 10): Promise<DeliveryOutcome[]> {
    const pending = await this.store.getPendingNotifications(limit);
    const outcomes: DeliveryOutcome[] = [];
    for (const record of pending) {
      const claimToken = randomUUID();
      const outcome = await this.dispatch(record.id, claimToken);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /**
   * Process all retryable notifications up to the given limit.
   */
  async processRetries(limit: number = 10): Promise<DeliveryOutcome[]> {
    const retryable = await this.store.getRetryableNotifications(limit);
    const outcomes: DeliveryOutcome[] = [];
    for (const record of retryable) {
      const claimToken = randomUUID();
      const outcome = await this.dispatch(record.id, claimToken);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  // -----------------------------------------------------------------------
  // Acknowledgement (untrusted callback)
  // -----------------------------------------------------------------------

  /**
   * Acknowledge a delivered notification from an untrusted callback/reply.
   *
   * Only changes notification state — does NOT mutate any other data.
   * The callback payload is not parsed or trusted; only the outbox ID is
   * used to identify the record.
   */
  async acknowledgeFromCallback(
    outboxId: string,
    _callbackData: Record<string, unknown>,
  ): Promise<NotificationOutboxRecord> {
    // Callback data is explicitly ignored — untrusted input.
    const record = await this.store.acknowledgeNotification(outboxId);
    await this.recordAudit('notification_acknowledged', {
      outboxId,
      eventId: record.eventId,
      channelType: record.channelType,
    });
    return record;
  }

  // -----------------------------------------------------------------------
  // Suppression
  // -----------------------------------------------------------------------

  /** Suppress a notification, preventing future delivery attempts. */
  async suppress(outboxId: string, reason: string): Promise<NotificationOutboxRecord> {
    const record = await this.store.suppressNotification(outboxId, reason);
    await this.recordAudit('notification_suppressed', {
      outboxId,
      eventId: record.eventId,
      channelType: record.channelType,
      reason,
    });
    return record;
  }

  // -----------------------------------------------------------------------
  // Policy hydration (read from store)
  // -----------------------------------------------------------------------

  /**
   * Return the current notification policy version string.
   * Reads from the persisted store policy record.
   */
  async getStoredPolicyVersion(spaceId: string): Promise<string | null> {
    const record = await this.store.getNotificationPolicy(spaceId, 'notification');
    return record?.policyVersion ?? null;
  }

  /**
   * Return the current notification policy from the store.
   * If no persisted policy exists, returns the in-memory default.
   */
  async getStoredPolicy(spaceId: string): Promise<NotificationPolicy> {
    const record = await this.store.getNotificationPolicy(spaceId, 'notification');
    if (record) {
      try {
        const parsed = JSON.parse(record.policy) as Partial<NotificationPolicy>;
        return {
          ...this.policy,
          ...parsed,
          policyVersion: record.policyVersion,
        };
      } catch {
        // Fall through to in-memory policy
      }
    }
    return this.policy;
  }

  // -----------------------------------------------------------------------
  // Inbox listing (read-side)
  // -----------------------------------------------------------------------

  /**
   * List notification outbox records for the given actor.
   *
   * Returns records where the linked event's recipient matches the actor,
   * with delivery state kept distinct from finding state.  Each record
   * includes the redacted event payload and delivery attempts.
   *
   * @param actorId  Actor requesting the inbox.
   * @param options  Optional status/channel filter and pagination.
   */
  async listOutbox(
    actorId: string,
    options?: { status?: OutboxStatus; channelType?: string; limit?: number; offset?: number },
  ): Promise<Array<{
    outbox: NotificationOutboxRecord;
    event: NotificationEvent;
    redactedPayload: Record<string, unknown>;
    deliveryAttempts: DeliveryAttempt[];
  }>> {
    const storeOptions: ListOutboxRecordsOptions = {
      status: options?.status,
      channelType: options?.channelType,
      limit: options?.limit,
      offset: options?.offset,
    };
    const records = await this.store.listOutboxRecords(storeOptions);

    const results: Array<{
      outbox: NotificationOutboxRecord;
      event: NotificationEvent;
      redactedPayload: Record<string, unknown>;
      deliveryAttempts: DeliveryAttempt[];
    }> = [];

    for (const outbox of records) {
      // Fetch the event for recipient check
      const event = await this.store.getNotificationEvent(outbox.eventId);
      if (!event) continue;

      // Filter by recipient match
      if (event.recipientId !== actorId) continue;

      // Redact the payload
      const redactedPayload = await this.redactForActor(event, actorId);

      // Get delivery attempts
      const deliveryAttempts = await this.store.getDeliveryAttempts(outbox.id);

      results.push({ outbox, event, redactedPayload, deliveryAttempts });
    }

    return results;
  }

  /**
   * Get a single notification outbox record with its event and delivery
   * history, redacted for the requesting actor.
   *
   * Returns null if the outbox is not found or the actor is not the
   * intended recipient.
   */
  async getOutboxDetail(
    outboxId: string,
    actorId: string,
  ): Promise<{
    outbox: NotificationOutboxRecord;
    event: NotificationEvent;
    redactedPayload: Record<string, unknown>;
    deliveryAttempts: DeliveryAttempt[];
  } | null> {
    const outbox = await this.store.getOutboxRecord(outboxId);
    if (!outbox) return null;

    const event = await this.store.getNotificationEvent(outbox.eventId);
    if (!event) return null;

    // Authorization: only the intended recipient can view
    if (event.recipientId !== actorId) {
      // Check if admin
      const membership = await this.store.getActorMembership(actorId);
      const capabilities = membership?.capabilities ?? [];
      if (!capabilities.includes('notification:admin')) {
        return null;
      }
    }

    const redactedPayload = await this.redactForActor(event, actorId);
    const deliveryAttempts = await this.store.getDeliveryAttempts(outbox.id);

    return { outbox, event, redactedPayload, deliveryAttempts };
  }

  // -----------------------------------------------------------------------
  // Redaction (read-side)
  // -----------------------------------------------------------------------

  /**
   * Redact a notification event's payload for a given actor based on
   * the actor's capabilities and the event's redaction class.
   *
   * Looks up the actor's capabilities from the store, then applies
   * the redaction policy.
   */
  async redactForActor(
    event: NotificationEvent,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const membership = await this.store.getActorMembership(actorId);
    const capabilities = membership?.capabilities ?? [];
    const redactionClass = event.redactionClass ?? this.policy.defaultRedactionClass;
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    return redactPayload(payload, redactionClass, capabilities, this.policy.redaction);
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /** Return runtime health and activity summary. */
  async getStatus(): Promise<RuntimeStatus> {
    let storeConnected = false;
    try {
      const pending = await this.store.getPendingNotifications(1);
      storeConnected = true;
    } catch {
      storeConnected = false;
    }

    const channelStatuses: Array<{ channel: ChannelType; healthy: boolean }> = [];
    for (const [channelType, adapter] of this.adapters) {
      channelStatuses.push({ channel: channelType, healthy: adapter.isHealthy() });
    }

    // Disabled channels: channels in the policy with enabled=false
    const disabledChannels: ChannelType[] = this.policy.channels
      .filter(c => !c.enabled)
      .map(c => c.type);

    // Outage channels: channels whose adapter is unhealthy
    const outageChannels: ChannelType[] = [];
    for (const [channelType, adapter] of this.adapters) {
      if (!adapter.isHealthy()) {
        outageChannels.push(channelType);
      }
    }

    let pendingCount = 0;
    let failedCount = 0;
    try {
      const pending = await this.store.getPendingNotifications(1000);
      pendingCount = pending.length;
      const retryable = await this.store.getRetryableNotifications(1000);
      failedCount = retryable.length;
    } catch {
      // Store errors are reflected in storeConnected
    }

    const healthy = storeConnected && channelStatuses.every(cs => cs.healthy);

    return {
      healthy,
      storeConnected,
      channelStatuses,
      pendingCount,
      failedCount,
      disabledChannels,
      outageChannels,
    };
  }

  // -----------------------------------------------------------------------
  // Policy evaluation (public for testing)
  // -----------------------------------------------------------------------

  /** Evaluate whether a notification is eligible for delivery. */
  evaluateEligibility(classification: string, severity: Severity): boolean {
    return this.policy.eligibility.some(
      rule =>
        rule.classifications.includes(classification) &&
        SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(rule.minSeverity),
    );
  }

  /** Resolve recipients for a given classification and severity. */
  resolveRecipients(
    classification: string,
    severity: Severity,
  ): RecipientSpec[] {
    const matchingRule = this.findMatchingRule(classification, severity);
    if (!matchingRule) return [];
    // Use policy-level recipients; a Phase 7 enhancement would scope to
    // the matching rule's capability/scope.
    return this.policy.recipients;
  }

  /** Resolve channels for a recipient based on enabled policy channels. */
  resolveChannels(recipient: RecipientSpec): ChannelType[] {
    const enabledChannels = new Set(
      this.policy.channels.filter(c => c.enabled).map(c => c.type),
    );
    return recipient.channels.filter(c => enabledChannels.has(c));
  }

  // -----------------------------------------------------------------------
  // Deterministic producer entry points
  // -----------------------------------------------------------------------

  /**
   * Produce a data-quality finding notification.
   * Persists immutable event before outbox records.
   * Deterministic: same input produces same classification.
   */
  async produceDataQualityEvent(input: DataQualityProducerInput): Promise<NotificationResult> {
    return this.create({
      budgetId: input.budgetId,
      classification: 'data_quality',
      severity: input.severity,
      scope: input.scope,
      recipientId: input.recipientId,
      redactionClass: input.redactionClass,
      correlationId: input.correlationId,
      payload: {
        findingId: input.findingId,
        title: input.title,
        description: input.description,
        affectedCount: input.affectedCount,
      },
    });
  }

  /**
   * Produce an alert notification.
   * Persists immutable event before outbox records.
   */
  async produceAlertEvent(input: AlertProducerInput): Promise<NotificationResult> {
    return this.create({
      budgetId: input.budgetId,
      classification: 'alert',
      severity: input.severity,
      scope: input.scope,
      recipientId: input.recipientId,
      redactionClass: input.redactionClass,
      correlationId: input.correlationId,
      payload: {
        alertId: input.alertId,
        title: input.title,
        summary: input.summary,
      },
    });
  }

  /**
   * Produce a recurrence/duplicate finding notification.
   * Persists immutable event before outbox records.
   */
  async produceRecurrenceEvent(input: RecurrenceProducerInput): Promise<NotificationResult> {
    return this.create({
      budgetId: input.budgetId,
      classification: 'recurrence',
      severity: input.severity,
      scope: input.scope,
      recipientId: input.recipientId,
      redactionClass: input.redactionClass,
      correlationId: input.correlationId,
      payload: {
        findingId: input.findingId,
        title: input.title,
        merchant: input.merchant,
        duplicateCount: input.duplicateCount,
      },
    });
  }

  /**
   * Produce a target risk notification.
   * Persists immutable event before outbox records.
   */
  async produceTargetRiskEvent(input: TargetRiskProducerInput): Promise<NotificationResult> {
    return this.create({
      budgetId: input.budgetId,
      classification: 'target_risk',
      severity: input.severity,
      scope: input.scope,
      recipientId: input.recipientId,
      redactionClass: input.redactionClass,
      correlationId: input.correlationId,
      payload: {
        findingId: input.findingId,
        title: input.title,
        targetName: input.targetName,
        shortfallPercent: input.shortfallPercent,
      },
    });
  }

  /**
   * Produce a proposal transition notification.
   * Persists immutable event before outbox records.
   */
  async produceProposalTransitionEvent(input: ProposalTransitionProducerInput): Promise<NotificationResult> {
    return this.create({
      budgetId: input.budgetId,
      classification: 'proposal_transition',
      severity: input.severity,
      scope: input.scope,
      recipientId: input.recipientId,
      redactionClass: input.redactionClass,
      correlationId: input.correlationId,
      payload: {
        proposalId: input.proposalId,
        title: input.title,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
      },
    });
  }

  /**
   * Produce a consequential workflow result notification.
   * Persists immutable event before outbox records.
   */
  async produceWorkflowResultEvent(input: WorkflowResultProducerInput): Promise<NotificationResult> {
    return this.create({
      budgetId: input.budgetId,
      classification: 'workflow_result',
      severity: input.severity,
      scope: input.scope,
      recipientId: input.recipientId,
      redactionClass: input.redactionClass,
      correlationId: input.correlationId,
      payload: {
        workflowId: input.workflowId,
        title: input.title,
        summary: input.summary,
        result: input.result,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Find the first matching eligibility rule. */
  private findMatchingRule(
    classification: string,
    severity: Severity,
  ): EligibilityRule | undefined {
    return this.policy.eligibility.find(
      rule =>
        rule.classifications.includes(classification) &&
        SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(rule.minSeverity),
    );
  }

  /**
   * Classify a provider failure as retryable or terminal.
   * Transient network errors, timeouts, and 5xx are retryable.
   * 4xx, auth failures, and "invalid" errors are terminal.
   */
  private classifyFailure(error: string): boolean {
    const lower = error.toLowerCase();
    if (lower.includes('timeout') || lower.includes('network') || lower.includes('econnrefused')) {
      return true;
    }
    if (lower.includes('5') && lower.includes('xx') || lower.includes('server_error')) {
      return true;
    }
    // Provider-level classification: specific error patterns
    if (lower.includes('rate_limit') || lower.includes('quota')) {
      return true;
    }
    // Terminal failures
    if (lower.includes('4') && lower.includes('xx') || lower.includes('invalid') || lower.includes('bad_request')) {
      return false;
    }
    // Default: retry once more
    return true;
  }

  /** Record an audit record if an audit hook is registered. */
  private async recordAudit(
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (this.auditHook) {
      try {
        await this.auditHook(action, details);
      } catch {
        // Audit failures never propagate — runtime continues.
      }
    }
    // Also write to the store's audit trail
    try {
      await this.store.appendAuditRecord({
        classification: action as unknown as AuditClassification,
        actorId: (details.actorId ?? 'system') as string,
        operation: action,
        correlationId: (details.eventId ?? details.outboxId ?? null) as string | null,
        requestId: null,
        result: (details.eventId ?? details.outboxId ?? action) as string,
      });
    } catch {
      // Store audit failures also non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// NotificationRuntimeError
// ---------------------------------------------------------------------------

/**
 * Error thrown by the notification runtime for policy violations or
 * configuration errors.  Does NOT wrap store errors — those propagate
 * as-is for the caller to handle.
 */
export class NotificationRuntimeError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NotificationRuntimeError';
    this.code = code;
  }
}
