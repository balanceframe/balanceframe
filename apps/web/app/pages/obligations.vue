<template>
  <AnalysisPage
    title="Irregular Obligations"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Planning input notice -->
        <div class="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 flex items-start gap-2">
          <span class="shrink-0 mt-0.5 i-heroicons-information-circle text-amber-600 dark:text-amber-400" />
          <p class="text-sm text-amber-700 dark:text-amber-400">These are <strong>planning inputs</strong> derived from schedule patterns, not confirmed ledger facts. Amounts and dates are estimates.</p>
        </div>

        <!-- Summary -->
        <UCard v-if="totalEstimatedAnnual">
          <template #header><span class="font-semibold">Estimated Annual Total</span></template>
          <SemanticAmount :amount="totalEstimatedAnnual" data-testid="total-annual" />
        </UCard>

        <!-- Obligations table -->
        <div v-if="obligations.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Detected Obligations</h3>
          <AnalysisTable :columns="obligationColumns" :rows="obligationRows" />
        </div>

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No irregular obligations detected.
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

interface IrregularObligation {
  name: string;
  kind: string;
  typicalAmount: Amount;
  frequency: string;
  categoryId: string | null;
  nextExpectedDate: string | null;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const obligations = ref<IrregularObligation[]>([]);
const totalEstimatedAnnual = ref<Amount | null>(null);

const hasData = computed(() => obligations.value.length > 0);

const obligationColumns = [
  { key: 'name', label: 'Obligation' },
  { key: 'typicalAmount', label: 'Typical Amount', type: 'amount' as const },
  { key: 'kind', label: 'Kind', type: 'badge' as const },
  { key: 'frequency', label: 'Frequency' },
  { key: 'nextExpectedDateLabel', label: 'Next Expected' },
];

const obligationRows = computed(() =>
  obligations.value.map(o => ({
    name: o.name,
    typicalAmount: o.typicalAmount,
    kind: o.kind,
    frequency: o.frequency,
    nextExpectedDateLabel: o.nextExpectedDate ?? 'Unknown',
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<Envelope<{
      obligations: IrregularObligation[];
      totalEstimatedAnnual: Amount | null;
    }>>('/api/obligations');
    if (res.status === 'ok' && res.result) {
      obligations.value = res.result.obligations;
      totalEstimatedAnnual.value = res.result.totalEstimatedAnnual;
      freshness.value = res.dataFreshness;
    } else {
      error.value = { code: res.error?.code ?? 'UNKNOWN', message: res.error?.message ?? 'Obligations analysis returned an error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
