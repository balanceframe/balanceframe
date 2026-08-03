<template>
  <UContainer class="max-w-2xl py-8">
    <UCard>
      <template #header>
        <div>
          <h1 class="text-xl font-semibold">Connect Actual Budget</h1>
          <p class="mt-1 text-sm text-gray-500">
            Select the Actual budget BalanceFrame should analyze. Your Actual
            server credentials remain server-side environment configuration.
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

      <div v-if="loading" class="text-sm text-gray-500">Loading Actual budgets…</div>
      <div v-else-if="budgets.length === 0" class="text-sm text-gray-500">
        No Actual budgets were returned. Check ACTUAL_SERVER_URL and
        ACTUAL_SECRET_KEY in the container environment.
      </div>
      <div v-else class="space-y-3">
        <label v-for="budget in budgets" :key="budget.id || budget.groupId" class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-gray-50 dark:hover:bg-gray-800">
          <input v-model="selectedBudgetId" type="radio" name="budget" :value="budget.id || budget.groupId" />
          <span>
            <span class="block font-medium">{{ budget.name }}</span>
            <span class="block text-xs text-gray-500">{{ budget.encrypted ? 'Encrypted' : 'Unencrypted' }}</span>
          </span>
        </label>
        <UButton :loading="saving" :disabled="!selectedBudgetId || saving" label="Save connection" @click="saveConnection" />
      </div>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
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
const loading = ref(true);
const saving = ref(false);
const connected = ref(false);
const error = ref('');

async function loadBudgets(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const response = await $fetch<Envelope<{ budgets: Budget[] }>>('/api/connection/budgets');
    if (response.status !== 'ok' || !response.result) {
      throw new Error(response.error?.message ?? 'Unable to list Actual budgets.');
    }
    budgets.value = response.result.budgets;
    selectedBudgetId.value = budgets.value[0]?.id || budgets.value[0]?.groupId || '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function saveConnection(): Promise<void> {
  if (!selectedBudgetId.value || saving.value) return;
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

onMounted(() => { void loadBudgets(); });
</script>
