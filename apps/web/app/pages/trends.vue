<template>
  <AnalysisPage
    title="Spending Trends"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Summary totals -->
        <div class="grid gap-4 sm:grid-cols-4">
          <UCard>
            <template #header><span class="font-semibold">Total Budgeted</span></template>
            <SemanticAmount v-if="totalBudgeted" :amount="totalBudgeted" data-testid="total-budgeted" />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">N/A</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Total Actual</span></template>
            <SemanticAmount v-if="totalActual" :amount="totalActual" data-testid="total-actual" />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">N/A</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Total Variance</span></template>
            <SemanticAmount v-if="totalVariance" :amount="totalVariance" data-testid="total-variance" />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">N/A</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Overall Variance</span></template>
            <p class="text-2xl font-bold text-gray-900 dark:text-white" data-testid="overall-variance">
              {{ overallVariancePercent !== null ? `${overallVariancePercent}%` : 'N/A' }}
            </p>
          </UCard>
        </div>

        <!-- Category variances table -->
        <div v-if="categoryVariances.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Category Variances</h3>
          <AnalysisTable :columns="varianceColumns" :rows="varianceRows" />
        </div>

        <!-- Trends table -->
        <div v-if="trends.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Trend Directions</h3>
          <AnalysisTable :columns="trendColumns" :rows="trendRows" />
        </div>

        <!-- Scope -->
        <ScopeSummary v-if="scopeLabel" :scope="{ label: scopeLabel }" />

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No trend data available.
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

interface CategoryVariance {
  categoryId: string;
  categoryName: string;
  budgeted: Amount;
  actual: Amount;
  variance: Amount;
  variancePercent: number;
  label: string;
}

interface CategoryTrend {
  categoryId: string;
  categoryName: string;
  direction: string;
  avgChange: number;
  periodsAnalyzed: number;
  seasonalityDetected: boolean;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const categoryVariances = ref<CategoryVariance[]>([]);
const trends = ref<CategoryTrend[]>([]);
const totalBudgeted = ref<Amount | null>(null);
const totalActual = ref<Amount | null>(null);
const totalVariance = ref<Amount | null>(null);
const overallVariancePercent = ref<number | null>(null);

const hasData = computed(() => categoryVariances.value.length > 0 || trends.value.length > 0);

const referenceDate = computed(() => {
  const now = new Date();
  return now.toISOString().slice(0, 7); // YYYY-MM
});

const scopeLabel = computed(() => `Period: ${referenceDate.value}`);

const varianceColumns = [
  { key: 'categoryName', label: 'Category' },
  { key: 'budgeted', label: 'Budgeted', type: 'amount' as const },
  { key: 'actual', label: 'Actual', type: 'amount' as const },
  { key: 'variance', label: 'Variance', type: 'amount' as const },
  { key: 'variancePercentLabel', label: 'Variance %' },
  { key: 'label', label: 'Status', type: 'badge' as const },
];

const varianceRows = computed(() =>
  categoryVariances.value.map(v => ({
    categoryName: v.categoryName,
    budgeted: v.budgeted,
    actual: v.actual,
    variance: v.variance,
    variancePercentLabel: `${v.variancePercent > 0 ? '+' : ''}${v.variancePercent}%`,
    label: v.label,
  })),
);

const trendColumns = [
  { key: 'categoryName', label: 'Category' },
  { key: 'direction', label: 'Direction', type: 'badge' as const },
  { key: 'avgChangeLabel', label: 'Avg Change' },
  { key: 'periodsAnalyzed', label: 'Periods' },
  { key: 'seasonalityLabel', label: 'Seasonality' },
];

const trendRows = computed(() =>
  trends.value.map(t => ({
    categoryName: t.categoryName,
    direction: t.direction,
    avgChangeLabel: `${t.avgChange > 0 ? '+' : ''}${t.avgChange}%`,
    periodsAnalyzed: t.periodsAnalyzed,
    seasonalityLabel: t.seasonalityDetected ? 'Detected' : 'None',
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<Envelope<{
      categoryVariances: CategoryVariance[];
      trends: CategoryTrend[];
      totalBudgeted: Amount | null;
      totalActual: Amount | null;
      totalVariance: Amount | null;
      overallVariancePercent: number | null;
    }>>('/api/trends-variance', { query: { referenceDate: referenceDate.value } });
    if (res.status === 'ok' && res.result) {
      categoryVariances.value = res.result.categoryVariances;
      trends.value = res.result.trends;
      totalBudgeted.value = res.result.totalBudgeted;
      totalActual.value = res.result.totalActual;
      totalVariance.value = res.result.totalVariance;
      overallVariancePercent.value = res.result.overallVariancePercent;
      freshness.value = res.dataFreshness;
    } else {
      error.value = { code: res.error?.code ?? 'UNKNOWN', message: res.error?.message ?? 'Trends analysis returned an error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
