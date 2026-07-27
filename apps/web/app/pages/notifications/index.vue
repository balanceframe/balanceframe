<template>
  <AnalysisPage title="Notifications" :loading="loading" :error="error">
    <template #content>
      <!-- Runtime status -->
      <UCard v-if="runtimeStatus" class="mb-4">
        <template #header>
          <span class="font-semibold">Runtime Status</span>
        </template>
        <div class="flex items-center gap-2 mb-2">
          <span class="w-2 h-2 rounded-full" :class="runtimeStatus.healthy ? 'bg-emerald-500' : 'bg-red-500'" />
          <span class="text-sm">{{ runtimeStatus.healthy ? 'Healthy' : 'Unhealthy' }}</span>
        </div>
        <div class="text-xs text-gray-500 dark:text-gray-400">
          <p>Store connected: {{ runtimeStatus.storeConnected ? 'Yes' : 'No' }}</p>
          <p>Pending: {{ runtimeStatus.pendingCount }}</p>
          <p>Delivered: {{ runtimeStatus.deliveredCount }}</p>
          <p>Failed: {{ runtimeStatus.failedCount }}</p>
        </div>
      </UCard>

      <!-- Action buttons -->
      <div class="flex gap-2 mb-4">
        <UButton size="sm" variant="outline" @click="refreshStatus">Refresh</UButton>
        <UButton size="sm" variant="outline" @click="showAck = true">Acknowledge</UButton>
        <UButton size="sm" variant="outline" @click="showSuppress = true">Suppress</UButton>
      </div>

      <!-- Acknowledge form -->
      <UCard v-if="showAck" class="mb-4">
        <template #header><span class="font-semibold text-sm">Acknowledge Notification</span></template>
        <UFormGroup label="Outbox ID">
          <UInput v-model="ackOutboxId" placeholder="ob_..." />
        </UFormGroup>
        <UButton size="sm" class="mt-2" @click="acknowledge">Submit</UButton>
      </UCard>

      <!-- Suppress form -->
      <UCard v-if="showSuppress" class="mb-4">
        <template #header><span class="font-semibold text-sm">Suppress Notification</span></template>
        <UFormGroup label="Outbox ID">
          <UInput v-model="supOutboxId" placeholder="ob_..." />
        </UFormGroup>
        <UFormGroup label="Reason">
          <UInput v-model="supReason" placeholder="Why?" />
        </UFormGroup>
        <UButton size="sm" class="mt-2" @click="suppress">Submit</UButton>
      </UCard>

      <UAlert v-if="actionResult" :title="actionResult.status" :description="actionResult.message" :color="actionResult.ok ? 'success' : 'error'" variant="soft" class="mb-4" />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const runtimeStatus = ref<{ healthy: boolean; storeConnected: boolean; pendingCount: number; deliveredCount: number; failedCount: number } | null>(null);
const showAck = ref(false);
const showSuppress = ref(false);
const ackOutboxId = ref('');
const supOutboxId = ref('');
const supReason = ref('');
const actionResult = ref<{ ok: boolean; status: string; message: string } | null>(null);

async function refreshStatus() {
  loading.value = true;
  try {
    const res = await $fetch<{ status: string; result: { healthy: boolean; storeConnected: boolean; channelStatuses: Array<{ channel: string; healthy: boolean }>; pendingCount: number; deliveredCount: number; failedCount: number } }>('/api/notifications/status');
    if (res.status === 'ok') runtimeStatus.value = res.result;
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
}

async function acknowledge() {
  if (!ackOutboxId.value) return;
  try {
    const res = await $fetch('/api/notifications/acknowledge', { method: 'POST', body: { outboxId: ackOutboxId.value } });
    actionResult.value = { ok: true, status: 'Acknowledged', message: 'Notification acknowledged.' };
    showAck.value = false;
    ackOutboxId.value = '';
  } catch (e) {
    actionResult.value = { ok: false, status: 'Error', message: String(e) };
  }
}

async function suppress() {
  if (!supOutboxId.value || !supReason.value) return;
  try {
    const res = await $fetch('/api/notifications/suppress', { method: 'POST', body: { outboxId: supOutboxId.value, reason: supReason.value } });
    actionResult.value = { ok: true, status: 'Suppressed', message: 'Notification suppressed.' };
    showSuppress.value = false;
    supOutboxId.value = '';
    supReason.value = '';
  } catch (e) {
    actionResult.value = { ok: false, status: 'Error', message: String(e) };
  }
}

onMounted(refreshStatus);
</script>
