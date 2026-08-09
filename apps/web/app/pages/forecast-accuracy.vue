<template>
  <AnalysisPage
    title="Forecast Accuracy"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Summary cards -->
        <div class="grid gap-4 sm:grid-cols-2">
          <UCard>
            <template #header><span class="font-semibold">Overall Calibration</span></template>
            <p
              v-if="overallCalibrated"
              class="text-lg font-bold text-emerald-600 dark:text-emerald-400"
              data-testid="overall-calibrated"
            >
              Calibrated
            </p>
            <p
              v-else
              class="text-lg font-bold text-amber-600 dark:text-amber-400"
              data-testid="overall-calibrated"
            >
              Not Calibrated
            </p>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Dimensions Tracked</span></template>
            <p
              class="text-2xl font-bold text-gray-900 dark:text-white"
              data-testid="dimensions-tracked"
            >
              {{ metrics.length }}
            </p>
          </UCard>
        </div>

        <!-- Calibration metrics table -->
        <div v-if="metrics.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Calibration Metrics
          </h3>
          <AnalysisTable :columns="metricColumns" :rows="metricRows" />
        </div>

        <!-- Recommendations -->
        <div
          v-if="recommendations.length"
          class="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4"
        >
          <h3 class="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-2">
            Recommendations
          </h3>
          <ul class="space-y-1">
            <li
              v-for="(rec, i) in recommendations"
              :key="i"
              class="text-sm text-blue-700 dark:text-blue-400 flex items-start gap-2"
            >
              <span class="shrink-0 mt-0.5 i-heroicons-arrow-right" />
              <span>{{ rec }}</span>
            </li>
          </ul>
        </div>

        <!-- Scope -->
        <ScopeSummary v-if="scopeLabel" :scope="{ label: scopeLabel }" />

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No forecast accuracy data available.
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

interface CalibrationMetric {
  metricName: string;
  mape: number | null;
  bias: number | null;
  periodsCompared: number;
  isCalibrated: boolean;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const metrics = ref<CalibrationMetric[]>([]);
const overallCalibrated = ref(false);
const recommendations = ref<string[]>([]);

const hasData = computed(() => metrics.value.length > 0 || recommendations.value.length > 0);

const scopeLabel = computed(() => {
  const now = new Date();
  return `Evaluation period: ${now.getFullYear()}`;
});

const metricColumns = [
  { key: 'metricName', label: 'Metric' },
  { key: 'mapeLabel', label: 'MAPE' },
  { key: 'biasLabel', label: 'Bias' },
  { key: 'periodsCompared', label: 'Periods' },
  { key: 'calibratedLabel', label: 'Status' },
];

function normalizedPercentageLabel(value: number, signed = false): string {
  const percentage = value * 100;
  const sign = signed && percentage > 0 ? '+' : '';
  return `${sign}${percentage.toFixed(1)}%`;
}

const metricRows = computed(() =>
  metrics.value.map((m) => ({
    metricName: m.metricName,
    mapeLabel: m.mape !== null ? normalizedPercentageLabel(m.mape) : 'N/A',
    biasLabel: m.bias !== null ? normalizedPercentageLabel(m.bias, true) : 'N/A',
    periodsCompared: m.periodsCompared,
    calibratedLabel: m.isCalibrated ? 'Calibrated' : 'Not Calibrated',
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<
      Envelope<{
        metrics: CalibrationMetric[];
        overallCalibrated: boolean;
        recommendations: string[];
      }>
    >('/api/forecast-accuracy');
    if (res.status === 'ok' && res.result) {
      metrics.value = res.result.metrics;
      overallCalibrated.value = res.result.overallCalibrated;
      recommendations.value = res.result.recommendations;
      freshness.value = res.dataFreshness;
    } else {
      error.value = {
        code: res.error?.code ?? 'UNKNOWN',
        message: res.error?.message ?? 'Forecast accuracy analysis returned an error.',
      };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
