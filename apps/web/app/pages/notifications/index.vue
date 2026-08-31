<template>
  <AnalysisPage title="Notifications" :loading="loading" :error="error">
    <template #content>
      <div class="space-y-6">
        <!-- Runtime status -->
        <div class="grid gap-4 sm:grid-cols-4" v-if="runtimeStatus">
          <UCard>
            <template #header><span class="font-semibold">Healthy</span></template>
            <p
              class="text-lg font-bold"
              :class="
                runtimeStatus.healthy
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              "
              data-testid="runtime-healthy"
            >
              {{ runtimeStatus.healthy ? 'Yes' : 'No' }}
            </p>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Pending</span></template>
            <p
              class="text-2xl font-bold text-amber-600 dark:text-amber-400"
              data-testid="pending-count"
            >
              {{ runtimeStatus.pendingCount }}
            </p>
          </UCard>
          <UCard v-if="typeof runtimeStatus.deliveredCount === 'number'">
            <template #header><span class="font-semibold">Delivered</span></template>
            <p
              class="text-2xl font-bold text-emerald-600 dark:text-emerald-400"
              data-testid="delivered-count"
            >
              {{ runtimeStatus.deliveredCount }}
            </p>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Failed</span></template>
            <p class="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="failed-count">
              {{ runtimeStatus.failedCount }}
            </p>
          </UCard>
        </div>

        <!-- Action result -->
        <UAlert
          v-if="actionResult"
          :title="actionResult.status"
          :description="actionResult.message"
          :color="actionResult.ok ? 'success' : 'error'"
          variant="soft"
          class="mb-4"
        />

        <section v-if="inboxItems.length" aria-labelledby="notification-inbox-heading">
          <h2
            id="notification-inbox-heading"
            class="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300"
          >
            Notification Inbox
          </h2>
          <aside
            aria-label="Delivery currency notice"
            class="mb-4 border-l-2 border-amber-400 pl-3 text-xs text-gray-600 dark:border-amber-500 dark:text-gray-300"
          >
            <p class="font-medium text-amber-800 dark:text-amber-300">
              Delivery is not current proof
            </p>
            <p class="mt-1">Delivery is not proof that the underlying conclusion is current.</p>
            <p class="mt-1 text-gray-500 dark:text-gray-400">
              Delivery state is tracked separately from finding state. Acknowledging or suppressing
              a notification does not affect the underlying finding.
            </p>
          </aside>

          <ul class="space-y-3" role="list">
            <li v-for="item in inboxItems" :key="item.outbox.id">
              <UCard>
                <template #header>
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <h3 class="font-semibold" data-testid="notification-title">
                      {{ redactedPayloadText(item, 'title') ?? 'Notification' }}
                    </h3>
                    <NotificationStatusBadge :status="item.outbox.status" />
                  </div>
                </template>

                <p
                  v-if="redactedPayloadText(item, 'summary')"
                  class="text-sm text-gray-600 dark:text-gray-300"
                  data-testid="notification-summary"
                >
                  {{ redactedPayloadText(item, 'summary') }}
                </p>

                <div
                  class="mt-3 grid gap-x-6 gap-y-1 text-xs text-gray-500 sm:grid-cols-2 dark:text-gray-400"
                  aria-label="Sanitized notification metadata"
                >
                  <p
                    v-if="notificationClassificationCode(item)"
                    :data-classification="notificationClassificationCode(item)"
                  >
                    Classification:
                    <span class="font-medium text-gray-700 dark:text-gray-200">
                      {{ notificationClassification(item) }}
                    </span>
                  </p>
                  <p>
                    Delivery state:
                    <span class="font-medium text-gray-700 dark:text-gray-200">
                      {{ deliveryStateLabel(item) }}
                    </span>
                  </p>
                  <p>
                    Notification state:
                    <span class="font-medium text-gray-700 dark:text-gray-200">
                      {{ notificationState(item) }}
                    </span>
                  </p>
                  <p>Channel: {{ formatIdentifier(item.outbox.channelType) }}</p>
                  <p>Attempts: {{ item.outbox.attemptCount }} / {{ item.outbox.maxAttempts }}</p>
                  <p v-if="redactedPayloadText(item, 'scope')">
                    Scope: {{ redactedPayloadText(item, 'scope') }}
                  </p>
                  <p v-if="notificationSnapshot(item)">
                    Snapshot: {{ notificationSnapshot(item) }}
                  </p>
                  <p v-if="notificationPolicyVersion(item)">
                    Policy: {{ notificationPolicyVersion(item) }}
                  </p>
                  <p v-if="item.event?.redactionClass">
                    Redaction: {{ formatIdentifier(item.event?.redactionClass ?? '') }}
                  </p>
                  <p v-if="item.outbox.acknowledgedAt">
                    Acknowledged: {{ item.outbox.acknowledgedAt }}
                  </p>
                  <p v-if="item.outbox.suppressedAt">Suppressed: {{ item.outbox.suppressedAt }}</p>
                </div>

                <section
                  v-if="item.deliveryAttempts.length"
                  aria-label="Delivery History"
                  class="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800"
                >
                  <h4 class="mb-2 text-xs font-semibold text-gray-500 dark:text-gray-400">
                    Delivery History
                  </h4>
                  <ol class="space-y-1">
                    <li
                      v-for="attempt in item.deliveryAttempts"
                      :key="attempt.id"
                      class="flex flex-wrap gap-x-2 text-xs text-gray-500 dark:text-gray-400"
                    >
                      <span
                        class="font-medium"
                        :class="
                          attempt.success
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                        "
                      >
                        {{ attempt.success ? 'Success' : 'Failed' }}
                      </span>
                      <span>{{ attempt.deliveredAt ?? attempt.attemptedAt }}</span>
                      <span v-if="attempt.failureReason" class="text-red-600 dark:text-red-400">
                        {{ attempt.failureReason }}
                      </span>
                    </li>
                  </ol>
                </section>

                <div
                  v-if="
                    item.outbox.status === 'delivered' &&
                    !item.outbox.acknowledgedAt &&
                    !acknowledgedIds.has(item.outbox.id) &&
                    !suppressedIds.has(item.outbox.id)
                  "
                  class="mt-3 flex flex-wrap gap-2"
                  aria-label="Notification actions"
                >
                  <UButton size="xs" variant="outline" @click="showAcknowledge(item.outbox.id)">
                    Acknowledge
                  </UButton>
                  <UButton
                    size="xs"
                    variant="outline"
                    color="warning"
                    @click="openSuppressDialog(item.outbox.id)"
                  >
                    Suppress
                  </UButton>
                </div>
              </UCard>
            </li>
          </ul>
        </section>

        <!-- Acknowledge dialog -->
        <UCard v-if="showAck">
          <template #header><span class="font-semibold">Acknowledge Notification</span></template>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-3">
            This marks the notification as received. It does not change the underlying finding.
          </p>
          <div class="flex gap-2">
            <UButton size="xs" @click="acknowledge">Confirm</UButton>
            <UButton size="xs" variant="outline" @click="showAck = false">Cancel</UButton>
          </div>
        </UCard>

        <!-- Suppress dialog -->
        <UCard v-if="showSuppressDialog">
          <template #header><span class="font-semibold">Suppress Notification</span></template>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-3">
            This prevents future delivery attempts. The notification is suppressed independently of
            any findings.
          </p>
          <UFormGroup label="Reason">
            <UInput v-model="supReason" placeholder="Why suppress this notification?" />
          </UFormGroup>
          <div class="flex gap-2 mt-2">
            <UButton size="xs" @click="suppressNotification">Suppress</UButton>
            <UButton size="xs" variant="outline" @click="showSuppressDialog = false"
              >Cancel</UButton
            >
          </div>
        </UCard>

        <!-- Policy info -->
        <UCard v-if="policy">
          <template #header><span class="font-semibold">Delivery Policy</span></template>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            Policy version: {{ policy.policyVersion }}
          </p>
          <p v-if="policyMaxRetries !== null" class="text-sm text-gray-600 dark:text-gray-400">
            Max retries: {{ policyMaxRetries }}
          </p>
          <p v-if="policyDefaultRedactionClass" class="text-sm text-gray-600 dark:text-gray-400">
            Default redaction class: {{ policyDefaultRedactionClass }}
          </p>
        </UCard>

        <!-- Empty state -->
        <div
          v-if="!inboxItems.length && !loading && !error"
          class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm"
        >
          No notifications in inbox.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });

interface Envelope<T> {
  schemaVersion: string;
  requestId: string;
  status: 'ok' | 'error';
  dataFreshness: { isStale: boolean; lastSync: string | null; label: string } | null;
  authorization: unknown;
  result: T | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

interface InboxItem {
  outbox: {
    id: string;
    channelType: string;
    status: string;
    attemptCount: number;
    maxAttempts: number;
    acknowledgedAt: string | null;
    suppressedAt: string | null;
  };
  event?: {
    classification?: string;
    createdAt?: string;
    policyVersion?: string;
    redactionClass?: string;
  } | null;
  redactedPayload: Record<string, unknown>;
  deliveryAttempts: Array<{
    id: string;
    success: boolean;
    attemptedAt?: string | null;
    deliveredAt: string | null;
    failureReason: string | null;
  }>;
}

interface RuntimeStatus {
  healthy: boolean;
  storeConnected: boolean;
  pendingCount: number;
  deliveredCount?: number;
  failedCount: number;
  channelStatuses: Array<{ channel: string; healthy: boolean }>;
}

interface NotificationPolicy {
  policyVersion: string;
  maxRetries?: number;
  defaultRedactionClass?: string;
  policy?: string;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const runtimeStatus = ref<RuntimeStatus | null>(null);
const inboxItems = ref<InboxItem[]>([]);
const policy = ref<NotificationPolicy | null>(null);
const showAck = ref(false);
const showSuppressDialog = ref(false);
const ackOutboxId = ref('');
const supOutboxId = ref('');
const supReason = ref('');
const actionResult = ref<{ ok: boolean; status: string; message: string } | null>(null);
const acknowledgedIds = ref(new Set<string>());
const suppressedIds = ref(new Set<string>());

const parsedPolicy = computed<Record<string, unknown> | null>(() => {
  if (!policy.value?.policy) return null;

  try {
    const parsed: unknown = JSON.parse(policy.value.policy);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
});

const policyMaxRetries = computed<number | null>(() => {
  const value = policy.value?.maxRetries ?? parsedPolicy.value?.maxRetries;
  return typeof value === 'number' ? value : null;
});

const policyDefaultRedactionClass = computed<string | null>(() => {
  const value = policy.value?.defaultRedactionClass ?? parsedPolicy.value?.defaultRedactionClass;
  return typeof value === 'string' && value.length ? value : null;
});

function redactedPayloadText(item: InboxItem, field: string): string | null {
  const value = item.redactedPayload[field];
  return typeof value === 'string' && value.length ? value : null;
}

function notificationClassificationCode(item: InboxItem): string | null {
  const eventClassification = item.event?.classification;
  return (
    redactedPayloadText(item, 'classification') ??
    (typeof eventClassification === 'string' && eventClassification.length
      ? eventClassification
      : null)
  );
}

function notificationClassification(item: InboxItem): string | null {
  const classification = notificationClassificationCode(item);
  return classification ? formatIdentifier(classification) : null;
}

function notificationSnapshot(item: InboxItem): string | null {
  return redactedPayloadText(item, 'snapshotId');
}

function notificationPolicyVersion(item: InboxItem): string | null {
  return redactedPayloadText(item, 'policyVersion') ?? item.event?.policyVersion ?? null;
}

function deliveryStateLabel(item: InboxItem): string {
  return item.event ? formatIdentifier(item.outbox.status) : item.outbox.status;
}

function notificationState(item: InboxItem): string {
  if (item.outbox.suppressedAt || suppressedIds.value.has(item.outbox.id)) {
    return 'Suppressed';
  }
  if (item.outbox.acknowledgedAt || acknowledgedIds.value.has(item.outbox.id)) {
    return 'Acknowledged';
  }
  return 'Unacknowledged';
}

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Unclassified Notification';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}

function showAcknowledge(outboxId: string) {
  ackOutboxId.value = outboxId;
  showAck.value = true;
}

function openSuppressDialog(outboxId: string) {
  supOutboxId.value = outboxId;
  supReason.value = '';
  showSuppressDialog.value = true;
}

async function acknowledge() {
  if (!ackOutboxId.value) return;
  const outboxId = ackOutboxId.value;
  try {
    await $fetch('/api/notifications/acknowledge', {
      method: 'POST',
      body: { outboxId },
    });
    acknowledgedIds.value = new Set([...acknowledgedIds.value, outboxId]);
    actionResult.value = {
      ok: true,
      status: 'Acknowledged',
      message: 'Notification acknowledged. This does not affect any associated findings.',
    };
    showAck.value = false;
    ackOutboxId.value = '';
  } catch (e) {
    actionResult.value = { ok: false, status: 'Error', message: String(e) };
  }
}

async function suppressNotification() {
  if (!supOutboxId.value || !supReason.value) return;
  const outboxId = supOutboxId.value;
  try {
    await $fetch('/api/notifications/suppress', {
      method: 'POST',
      body: { outboxId, reason: supReason.value },
    });
    suppressedIds.value = new Set([...suppressedIds.value, outboxId]);
    actionResult.value = {
      ok: true,
      status: 'Suppressed',
      message: 'Notification suppressed. This does not affect any associated findings.',
    };
    showSuppressDialog.value = false;
    supOutboxId.value = '';
    supReason.value = '';
  } catch (e) {
    actionResult.value = { ok: false, status: 'Error', message: String(e) };
  }
}

onMounted(async () => {
  try {
    const [statusRes, inboxRes, policyRes] = await Promise.all([
      $fetch<Envelope<RuntimeStatus>>('/api/notifications/status'),
      $fetch<Envelope<{ items: InboxItem[]; count: number }>>('/api/notifications/inbox'),
      $fetch<Envelope<NotificationPolicy>>('/api/notifications/policy', {
        query: { spaceId: 'default', policyKey: 'delivery' },
      }).catch(() => null),
    ]);
    if (statusRes.status === 'ok' && statusRes.result) {
      runtimeStatus.value = statusRes.result;
    }
    if (inboxRes.status === 'ok' && inboxRes.result) {
      inboxItems.value = inboxRes.result.items;
    }
    if (policyRes && policyRes.status === 'ok' && policyRes.result) {
      policy.value = policyRes.result;
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
