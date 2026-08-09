<template>
  <AnalysisPage
    title="Income Overview"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <!-- Summary cards -->
        <div class="grid gap-4 sm:grid-cols-3">
          <UCard>
            <template #header><span class="font-semibold">Total Monthly Income</span></template>
            <SemanticAmount
              v-if="totalMonthly"
              :amount="totalMonthly"
              data-testid="total-monthly"
            />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">N/A</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Reliability Score</span></template>
            <p
              v-if="overallScore !== null"
              class="text-2xl font-bold text-gray-900 dark:text-white"
              data-testid="overall-score"
            >
              {{ nullableNormalizedScorePercent(overallScore)
              }}<span class="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">%</span>
            </p>
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">N/A</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Unreliable Sources</span></template>
            <p
              class="text-2xl font-bold text-gray-900 dark:text-white"
              data-testid="unreliable-count"
            >
              {{ unreliableSourceCount }}
            </p>
          </UCard>
        </div>

        <!-- Sources table -->
        <div v-if="sources.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Income Sources
          </h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Each source shows observed patterns from transaction history, not confirmed future
            income.
          </p>
          <AnalysisTable :columns="sourceColumns" :rows="sourceRows" />
        </div>

        <!-- Scope -->
        <ScopeSummary v-if="scopeLabel" :scope="{ label: scopeLabel }" />

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No income source data available.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';
import { normalizedScorePercent, nullableNormalizedScorePercent } from '../utils/financial-display';

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

interface IncomeSource {
  name: string;
  typicalMonthly: Amount;
  reliabilityScore: number;
  variability: number;
  paymentCount: number;
  isRegular: boolean;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const sources = ref<IncomeSource[]>([]);
const totalMonthly = ref<Amount | null>(null);
const overallScore = ref<number | null>(null);
const unreliableSourceCount = ref(0);

const hasData = computed(() => sources.value.length > 0);

const scopeLabel = computed(() => {
  const now = new Date();
  return `Analysis period: ${now.getFullYear()}`;
});

const sourceColumns = [
  { key: 'name', label: 'Source' },
  { key: 'typicalMonthly', label: 'Typical Monthly', type: 'amount' as const },
  { key: 'reliabilityScoreLabel', label: 'Reliability' },
  { key: 'paymentCount', label: 'Payments Observed' },
  { key: 'isRegularLabel', label: 'Pattern' },
];

const sourceRows = computed(() =>
  sources.value.map((s) => ({
    name: s.name,
    typicalMonthly: s.typicalMonthly,
    reliabilityScoreLabel: `${normalizedScorePercent(s.reliabilityScore)}%`,
    paymentCount: s.paymentCount,
    isRegularLabel: s.isRegular ? 'Regular' : 'Irregular',
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<
      Envelope<{
        sources: IncomeSource[];
        totalMonthly: Amount | null;
        overallScore: number | null;
        unreliableSourceCount: number;
      }>
    >('/api/income');
    if (res.status === 'ok' && res.result) {
      sources.value = res.result.sources;
      totalMonthly.value = res.result.totalMonthly;
      overallScore.value = res.result.overallScore;
      unreliableSourceCount.value = res.result.unreliableSourceCount;
      freshness.value = res.dataFreshness;
    } else {
      error.value = {
        code: res.error?.code ?? 'UNKNOWN',
        message: res.error?.message ?? 'Income analysis returned an error.',
      };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
