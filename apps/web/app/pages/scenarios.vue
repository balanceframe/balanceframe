<template>
  <AnalysisPage
    title="What-If Scenarios"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Read-only notice -->
        <div class="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Scenarios are read-only views of ledger data. Changes to budget allocations or category limits are only simulated — they do not modify actual transactions or rules.
          </p>
        </div>

        <!-- Comparison summary -->
        <UCard v-if="summary">
          <template #header><span class="font-semibold">Comparison Summary</span></template>
          <p class="text-sm text-gray-700 dark:text-gray-300" data-testid="scenario-summary">{{ summary }}</p>
        </UCard>

        <!-- Deltas table -->
        <div v-if="deltas.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Dimension Deltas</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">Baseline vs. comparison — labels indicate direction of simulated change only.</p>
          <AnalysisTable :columns="deltaColumns" :rows="deltaRows" />
        </div>

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No scenario comparison data. Provide baseline and comparison parameters to generate a comparison.
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

interface ScenarioComparisonDelta {
  dimension: string;
  baselineValue: unknown;
  comparisonValue: unknown;
  change: string;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const deltas = ref<ScenarioComparisonDelta[]>([]);
const summary = ref('');

const hasData = computed(() => deltas.value.length > 0);

const deltaColumns = [
  { key: 'dimension', label: 'Dimension' },
  { key: 'baselineLabel', label: 'Baseline' },
  { key: 'comparisonLabel', label: 'Comparison' },
  { key: 'change', label: 'Change' },
];

const deltaRows = computed(() =>
  deltas.value.map(d => ({
    dimension: d.dimension,
    baselineLabel: formatValue(d.baselineValue),
    comparisonLabel: formatValue(d.comparisonValue),
    change: d.change,
  })),
);

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'number') return val.toLocaleString();
  return String(val);
}

onMounted(async () => {
  try {
    const res = await $fetch<Envelope<{
      deltas: ScenarioComparisonDelta[];
      summary: string;
    }>>('/api/scenarios');
    if (res.status === 'ok' && res.result) {
      deltas.value = res.result.deltas;
      summary.value = res.result.summary;
      freshness.value = res.dataFreshness;
    } else {
      error.value = { code: res.error?.code ?? 'UNKNOWN', message: res.error?.message ?? 'Scenario comparison returned an error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
