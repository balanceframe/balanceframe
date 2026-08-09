<template>
  <AnalysisPage
    title="Financial Calendar"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Summary -->
        <div class="grid gap-4 sm:grid-cols-2">
          <UCard>
            <template #header><span class="font-semibold">Unpaid Bills</span></template>
            <SemanticAmount v-if="totalUnpaid" :amount="totalUnpaid" data-testid="total-unpaid" />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">None</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Unpaid Count</span></template>
            <p class="text-2xl font-bold text-gray-900 dark:text-white" data-testid="unpaid-count">
              {{ unpaidCount }}
            </p>
          </UCard>
        </div>

        <!-- Entries table -->
        <div v-if="entries.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Bill Calendar Entries
          </h3>
          <AnalysisTable :columns="entryColumns" :rows="entryRows" />
        </div>

        <!-- Scope -->
        <ScopeSummary v-if="scopeLabel" :scope="{ label: scopeLabel }" />

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No calendar entries available.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

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

interface BillCalendarEntry {
  name: string;
  dueDate: string;
  amount: Amount;
  categoryId: string | null;
  status: string;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const entries = ref<BillCalendarEntry[]>([]);
const totalUnpaid = ref<Amount | null>(null);
const unpaidCount = ref(0);

const hasData = computed(() => entries.value.length > 0);

const referenceDate = computed(() => {
  const now = new Date();
  return now.toISOString().slice(0, 10);
});

const scopeLabel = computed(() => `Reference: ${referenceDate.value}`);

const entryColumns = [
  { key: 'name', label: 'Bill' },
  { key: 'amount', label: 'Amount', type: 'amount' as const },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'status', label: 'Status', type: 'badge' as const },
];

const entryRows = computed(() =>
  entries.value.map((e) => ({
    name: e.name,
    amount: e.amount,
    dueDate: e.dueDate,
    status: e.status,
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<
      Envelope<{
        entries: BillCalendarEntry[];
        totalUnpaid: Amount | null;
        unpaidCount: number;
      }>
    >('/api/calendar', { query: { referenceDate: referenceDate.value } });
    if (res.status === 'ok' && res.result) {
      entries.value = res.result.entries;
      totalUnpaid.value = res.result.totalUnpaid;
      unpaidCount.value = res.result.unpaidCount;
      freshness.value = res.dataFreshness;
    } else {
      error.value = {
        code: res.error?.code ?? 'UNKNOWN',
        message: res.error?.message ?? 'Calendar analysis returned an error.',
      };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
