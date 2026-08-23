<template>
  <AnalysisPage
    title="Financial Health"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Composite score -->
        <UCard role="region" aria-label="Global health score — not purchase readiness">
          <template #header>
            <span class="font-semibold">Global health score — not purchase readiness</span>
          </template>
          <p class="text-3xl font-bold text-gray-900 dark:text-white" data-testid="composite-score">
            {{ normalizedScorePercent(compositeScore)
            }}<span class="ml-1 text-sm font-normal text-gray-500 dark:text-gray-400">/ 100</span>
          </p>
          <p
            v-if="hasLimitedDataQuality"
            role="status"
            aria-label="Qualified by limited data quality"
            class="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300"
          >
            Qualified by limited data quality
          </p>
        </UCard>

        <!-- Dimension cards -->
        <div v-if="dimensions.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Health Dimensions
          </h3>
          <div class="grid gap-4 sm:grid-cols-2">
            <UCard v-for="d in dimensions" :key="d.dimension">
              <template #header>
                <div class="flex items-center justify-between">
                  <span class="font-semibold">{{ d.dimension }}</span>
                  <span
                    class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                    :class="severityClass(d.severity)"
                  >
                    {{ d.severity }}
                  </span>
                </div>
              </template>
              <div class="space-y-1">
                <p
                  class="text-lg font-bold text-gray-900 dark:text-white"
                  :data-testid="`dim-score-${d.dimension}`"
                >
                  {{ normalizedScorePercent(d.score)
                  }}<span class="text-xs font-normal text-gray-500 dark:text-gray-400 ml-1"
                    >/ 100 (weight: {{ normalizedScorePercent(d.weight) }}%)</span
                  >
                </p>
                <p class="text-xs text-gray-600 dark:text-gray-400">{{ d.explanation }}</p>
              </div>
            </UCard>
          </div>
        </div>

        <!-- Summary -->
        <UCard v-if="summary">
          <template #header><span class="font-semibold">Summary</span></template>
          <p class="text-sm text-gray-700 dark:text-gray-300">{{ summary }}</p>
        </UCard>

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

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No health assessment data available.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import { normalizedScorePercent } from '../utils/financial-display';

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

interface HealthDimension {
  dimension: string;
  score: number;
  weight: number;
  explanation: string;
  severity: string;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const dimensions = ref<HealthDimension[]>([]);
const compositeScore = ref(0);
const summary = ref('');
const recommendations = ref<string[]>([]);

const hasData = computed(() => dimensions.value.length > 0);
const hasLimitedDataQuality = computed(() =>
  dimensions.value.some(
    (dimension) => dimension.dimension === 'data_quality' && dimension.score < 0.7,
  ),
);

const currentMonth = computed(() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
});

function severityClass(severity: string): string {
  if (severity === 'good' || severity === 'healthy')
    return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
  if (severity === 'warning' || severity === 'caution')
    return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
  if (severity === 'critical' || severity === 'poor')
    return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
  return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
}

onMounted(async () => {
  try {
    const res = await $fetch<
      Envelope<{
        dimensions: HealthDimension[];
        compositeScore: number;
        summary: string;
        recommendations: string[];
      }>
    >('/api/financial-health', { query: { currentMonth: currentMonth.value } });
    if (res.status === 'ok' && res.result) {
      dimensions.value = res.result.dimensions;
      compositeScore.value = res.result.compositeScore;
      summary.value = res.result.summary;
      recommendations.value = res.result.recommendations;
      freshness.value = res.dataFreshness;
    } else {
      error.value = {
        code: res.error?.code ?? 'UNKNOWN',
        message: res.error?.message ?? 'Health assessment returned an error.',
      };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
