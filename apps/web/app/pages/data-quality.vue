<template>
  <AnalysisPage
    title="Data Quality"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Overall score -->
        <UCard v-if="overallScore !== null">
          <template #header><span class="font-semibold">Overall Quality Score</span></template>
          <p class="text-3xl font-bold text-gray-900 dark:text-white" data-testid="overall-score">{{ overallScore }}<span class="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">/ 100</span></p>
        </UCard>

        <!-- Dimensions table -->
        <div v-if="dimensions.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Quality Dimensions</h3>
          <AnalysisTable :columns="dimensionColumns" :rows="dimensionRows" />
        </div>

        <!-- Recommendations / remediation -->
        <div v-if="recommendations.length" class="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
          <h3 class="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-2">Recommended Actions</h3>
          <ul class="space-y-1">
            <li v-for="(rec, i) in recommendations" :key="i" class="text-sm text-blue-700 dark:text-blue-400 flex items-start gap-2">
              <span class="shrink-0 mt-0.5 i-heroicons-arrow-right" />
              <span>{{ rec }}</span>
            </li>
          </ul>
        </div>

        <!-- Empty state -->
        <div v-if="!dimensions.length && !recommendations.length" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No data quality metrics available.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">

definePageMeta({ layout: 'default' });

interface QualityDimension {
  name: string;
  score: number | null;
  severity: string;
  details: string[];
}

interface QualityDimensionApi {
  name?: string;
  dimension?: string;
  score: number | null;
  severity?: string;
  explanation?: string;
  details?: string[];
  worstSeverity: string | null;
}

interface DataQualityResult {
  overallScore: number | null;
  dimensions: QualityDimensionApi[];
  recommendations: string[];
}

interface Envelope<T> {
  schemaVersion: string;
  requestId: string;
  status: 'ok' | 'error';
  dataFreshness: { isStale: boolean; lastSync: string | null; label: string } | null;
  authorization: unknown;
  result: T | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

const displayScore = (score: number | null): number | null =>
  score !== null && score >= 0 && score <= 1 ? score * 100 : score;

const normalizeDimension = (dimension: QualityDimensionApi): QualityDimension => ({
  name: dimension.name ?? dimension.dimension ?? 'Unknown',
  score: displayScore(dimension.score),
  severity: dimension.severity ?? dimension.worstSeverity ?? 'unknown',
  details: dimension.details ?? (dimension.explanation ? [dimension.explanation] : []),
});


const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const overallScore = ref<number | null>(null);
const dimensions = ref<QualityDimension[]>([]);
const recommendations = ref<string[]>([]);

const hasData = computed(() => dimensions.value.length > 0 || recommendations.value.length > 0);

const dimensionColumns = [
  { key: 'name', label: 'Dimension' },
  { key: 'scoreLabel', label: 'Score' },
  { key: 'severity', label: 'Severity', type: 'badge' as const },
  { key: 'detailsLabel', label: 'Details' },
];

const dimensionRows = computed(() =>
  dimensions.value.map(d => ({
    name: d.name,
    scoreLabel: d.score !== null ? `${d.score} / 100` : 'N/A',
    severity: d.severity,
    detailsLabel: d.details.join('; ') || '—',
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<Envelope<DataQualityResult>>('/api/data-quality');
    if (res.status === 'ok' && res.result) {
      overallScore.value = displayScore(res.result.overallScore);
      dimensions.value = res.result.dimensions.map(normalizeDimension);
      recommendations.value = res.result.recommendations;
      freshness.value = res.dataFreshness;
    } else {
      error.value = { code: res.error?.code ?? 'UNKNOWN', message: res.error?.message ?? 'Data quality analysis returned an error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
