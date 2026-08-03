<template>
  <AnalysisPage title="Notifications" :loading="loading" :error="error">
    <template #content>
      <div class="space-y-6">
        <!-- Runtime status -->
        <div class="grid gap-4 sm:grid-cols-4" v-if="runtimeStatus">
          <UCard>
            <template #header><span class="font-semibold">Healthy</span></template>
            <p class="text-lg font-bold" :class="runtimeStatus.healthy ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'" data-testid="runtime-healthy">
              {{ runtimeStatus.healthy ? 'Yes' : 'No' }}
            </p>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Pending</span></template>
            <p class="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="pending-count">{{ runtimeStatus.pendingCount }}</p>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Delivered</span></template>
            <p class="text-2xl font-bold text-emerald-600 dark:text-emerald-400" data-testid="delivered-count">{{ runtimeStatus.deliveredCount }}</p>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Failed</span></template>
            <p class="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="failed-count">{{ runtimeStatus.failedCount }}</p>
          </UCard>
        </div>

        <!-- Action result -->
        <UAlert v-if="actionResult" :title="actionResult.status" :description="actionResult.message" :color="actionResult.ok ? 'success' : 'error'" variant="soft" class="mb-4" />

        <!-- Notification inbox -->
        <div v-if="inboxItems.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Notification Inbox</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">Delivery state is tracked separately from finding state. Acknowledging or suppressing a notification does not affect the underlying finding.</p>
          <UCard v-for="item in inboxItems" :key="item.outbox.id" class="mb-3">
            <template #header>
              <div class="flex items-center justify-between">
                <span class="font-semibold" data-testid="notification-title">{{ item.redactedPayload.title || 'Notification' }}</span>
                <span class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                  :class="deliveryStatusClass(item.outbox.status)">
                  {{ item.outbox.status }}
                </span>
              </div>
            </template>
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="notification-summary">{{ item.redactedPayload.summary || '' }}</p>
            <div class="mt-2 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
              <span>Channel: {{ item.outbox.channelType }}</span>
              <span>Attempts: {{ item.outbox.attemptCount }}</span>
              <span v-if="item.outbox.acknowledgedAt">Acknowledged: {{ item.outbox.acknowledgedAt }}</span>
              <span v-if="item.outbox.suppressedAt">Suppressed: {{ item.outbox.suppressedAt }}</span>
            </div>

            <!-- Delivery attempts -->
            <div v-if="item.deliveryAttempts.length" class="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
              <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Delivery History</h4>
              <div v-for="attempt in item.deliveryAttempts" :key="attempt.id" class="text-xs text-gray-500 dark:text-gray-400 flex gap-2">
                <span :class="attempt.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
                  {{ attempt.success ? 'Success' : 'Failed' }}
                </span>
                <span>{{ attempt.deliveredAt }}</span>
                <span v-if="attempt.failureReason" class="text-red-500 dark:text-red-400">{{ attempt.failureReason }}</span>
              </div>
            </div>

            <!-- Acknowledge / Suppress actions (separate from findings) -->
            <div class="mt-3 flex gap-2" v-if="item.outbox.status === 'delivered'">
              <UButton size="xs" variant="outline" @click="showAcknowledge(item.outbox.id)">Acknowledge</UButton>
              <UButton size="xs" variant="outline" color="warning" @click="openSuppressDialog(item.outbox.id)">Suppress</UButton>
            </div>
          </UCard>
        </div>

        <!-- Acknowledge dialog -->
        <UCard v-if="showAck">
          <template #header><span class="font-semibold">Acknowledge Notification</span></template>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-3">This marks the notification as received. It does not change the underlying finding.</p>
          <div class="flex gap-2">
            <UButton size="xs" @click="acknowledge">Confirm</UButton>
            <UButton size="xs" variant="outline" @click="showAck = false">Cancel</UButton>
          </div>
        </UCard>

        <!-- Suppress dialog -->
        <UCard v-if="showSuppressDialog">
          <template #header><span class="font-semibold">Suppress Notification</span></template>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-3">This prevents future delivery attempts. The notification is suppressed independently of any findings.</p>
          <UFormGroup label="Reason">
            <UInput v-model="supReason" placeholder="Why suppress this notification?" />
          </UFormGroup>
          <div class="flex gap-2 mt-2">
            <UButton size="xs" @click="suppressNotification">Suppress</UButton>
            <UButton size="xs" variant="outline" @click="showSuppressDialog = false">Cancel</UButton>
          </div>
        </UCard>

        <!-- Policy info -->
        <UCard v-if="policy">
          <template #header><span class="font-semibold">Delivery Policy</span></template>
          <p class="text-sm text-gray-600 dark:text-gray-400">Policy version: {{ policy.policyVersion }}</p>
          <p class="text-sm text-gray-600 dark:text-gray-400">Max retries: {{ policy.maxRetries }}</p>
          <p class="text-sm text-gray-600 dark:text-gray-400">Default redaction class: {{ policy.defaultRedactionClass }}</p>
        </UCard>

        <!-- Empty state -->
        <div v-if="!inboxItems.length && !loading && !error" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
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
  event: { classification: string; createdAt: string };
  redactedPayload: Record<string, unknown>;
  deliveryAttempts: Array<{
    id: string;
    success: boolean;
    deliveredAt: string;
    failureReason: string | null;
  }>;
}

interface RuntimeStatus {
  healthy: boolean;
  storeConnected: boolean;
  pendingCount: number;
  deliveredCount: number;
  failedCount: number;
  channelStatuses: Array<{ channel: string; healthy: boolean }>;
}

interface NotificationPolicy {
  policyVersion: string;
  maxRetries: number;
  defaultRedactionClass: string;
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

function deliveryStatusClass(status: string): string {
  if (status === 'delivered') return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
  if (status === 'pending') return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
  if (status === 'failed') return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
  if (status === 'suppressed') return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
  return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
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
  try {
    await $fetch('/api/notifications/acknowledge', { method: 'POST', body: { outboxId: ackOutboxId.value } });
    actionResult.value = { ok: true, status: 'Acknowledged', message: 'Notification acknowledged. This does not affect any associated findings.' };
    showAck.value = false;
    ackOutboxId.value = '';
  } catch (e) {
    actionResult.value = { ok: false, status: 'Error', message: String(e) };
  }
}

async function suppressNotification() {
  if (!supOutboxId.value || !supReason.value) return;
  try {
    await $fetch('/api/notifications/suppress', { method: 'POST', body: { outboxId: supOutboxId.value, reason: supReason.value } });
    actionResult.value = { ok: true, status: 'Suppressed', message: 'Notification suppressed. This does not affect any associated findings.' };
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
      $fetch<Envelope<NotificationPolicy>>('/api/notifications/policy', { query: { spaceId: 'default', policyKey: 'delivery' } }).catch(() => null),
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
