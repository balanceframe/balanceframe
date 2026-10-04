<template>
  <UContainer class="max-w-2xl py-8">
    <UCard>
      <template #header>
        <div>
          <h1 class="text-xl font-semibold">Connect Actual Budget</h1>
          <p class="mt-1 text-sm text-gray-500">
            Select the Actual budget BalanceFrame should analyze. Your Actual server credentials
            remain server-side environment configuration.
          </p>
        </div>
      </template>

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="Connection setup failed"
        :description="error"
        class="mb-4"
      />
      <UAlert
        v-if="connected"
        color="success"
        variant="soft"
        title="Connection saved"
        description="The selected budget is ready to synchronize."
        class="mb-4"
      />

      <form class="mb-4 space-y-3" @submit.prevent="loadBudgets">
        <label class="grid gap-1 text-sm">
          {{ demoMode ? 'Disposable-demo confirmation (type CONFIRM)' : 'Account password' }}
          <input v-model="password" type="password" autocomplete="current-password" required class="rounded border bg-transparent p-2" />
        </label>
        <UButton type="button" label="Load available budgets" :disabled="loading || saving || !password" @click="loadBudgets" />
      </form>

      <div v-if="loading" class="text-sm text-gray-500">Loading Actual budgets…</div>
      <div v-else-if="loaded && budgets.length === 0" class="text-sm text-gray-500">
        No Actual budgets were returned. Check ACTUAL_SERVER_URL and ACTUAL_SECRET_KEY in the
        container environment.
      </div>
      <div v-else-if="budgets.length" class="space-y-3">
        <label
          v-for="budget in budgets"
          :key="budget.id || budget.groupId"
          class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <input
            v-model="selectedBudgetId"
            type="radio"
            name="budget"
            :value="budget.id || budget.groupId"
          />
          <span>
            <span class="block font-medium">{{ budget.name }}</span>
            <span class="block text-xs text-gray-500">{{
              budget.encrypted ? 'Encrypted' : 'Unencrypted'
            }}</span>
          </span>
        </label>
        <UButton
          :loading="saving"
          :disabled="!selectedBudgetId || loading || saving"
          label="Save connection"
          @click="saveConnection"
        />
      </div>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
import { reauthenticateHuman } from '../utils/reauthentication';

const demoMode = useRuntimeConfig().public.demoMode === true;
const password = ref('');
const loaded = ref(false);

interface Budget {
  id: string;
  groupId: string;
  name: string;
  encrypted: boolean;
}
interface Envelope<T> {
  status: 'ok' | 'error';
  result: T | null;
  error: { message: string } | null;
}

const budgets = ref<Budget[]>([]);
const selectedBudgetId = ref('');
const loading = ref(false);
const saving = ref(false);
const connected = ref(false);
const error = ref('');

async function loadBudgets(): Promise<void> {
  if (loading.value || saving.value || !password.value) return;
  loading.value = true;
  error.value = '';
  loaded.value = false;
  connected.value = false;
  budgets.value = [];
  selectedBudgetId.value = '';
  let passwordSnapshot = password.value;
  password.value = '';
  try {
    await reauthenticateHuman(passwordSnapshot);
    passwordSnapshot = '';
    const response = await $fetch<Envelope<{ budgets: Budget[] }>>('/api/connection/budgets');
    if (response.status !== 'ok' || !response.result) {
      throw new Error(response.error?.message ?? 'Unable to list Actual budgets.');
    }
    budgets.value = response.result.budgets;
    loaded.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    passwordSnapshot = '';
    loading.value = false;
  }
}

async function saveConnection(): Promise<void> {
  if (!selectedBudgetId.value || loading.value || saving.value) return;
  saving.value = true;
  connected.value = false;
  error.value = '';
  try {
    const response = await $fetch<Envelope<{ connected: boolean }>>('/api/connection', {
      method: 'POST',
      body: { budgetId: selectedBudgetId.value },
    });
    if (response.status !== 'ok' || !response.result?.connected) {
      throw new Error(response.error?.message ?? 'Unable to save the Actual connection.');
    }
    connected.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

</script>
