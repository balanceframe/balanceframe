<template>
  <AnalysisPage
    title="Liquidity"
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
            <template #header><span class="font-semibold">Total Liquid</span></template>
            <SemanticAmount v-if="totalLiquid" :amount="totalLiquid" data-testid="total-liquid" />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">Unavailable</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Total Obligations</span></template>
            <SemanticAmount
              v-if="totalObligations"
              :amount="totalObligations"
              data-testid="total-obligations"
            />
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">Unavailable</span>
          </UCard>
          <UCard>
            <template #header><span class="font-semibold">Coverage Ratio</span></template>
            <div v-if="coverage.length">
              <p
                v-for="(c, i) in coverage"
                :key="i"
                class="text-2xl font-bold text-gray-900 dark:text-white"
                data-testid="coverage-ratio"
              >
                {{ coverageLabel(c) }}
                <span
                  v-if="c.ratio !== null"
                  class="text-xs font-normal text-gray-500 dark:text-gray-400 ml-1"
                  >{{ formatCoverageRatio(c.ratio) }}x</span
                >
              </p>
            </div>
            <span v-else class="text-gray-400 dark:text-gray-500 text-sm">No coverage data</span>
          </UCard>
        </div>

        <!-- Upcoming obligations table -->
        <div v-if="upcomingObligations.length">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Upcoming Obligations
          </h3>
          <AnalysisTable :columns="obligationColumns" :rows="obligationRows" />
        </div>

        <!-- Scope / evidence -->
        <ScopeSummary v-if="scopeLabel" :scope="{ label: scopeLabel }" />

        <!-- Empty state -->
        <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No liquidity data available.
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

interface UpcomingObligation {
  name: string;
  dueDate: string;
  amount: Amount;
  categoryId: string | null;
  isRecurring: boolean;
}

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const totalLiquid = ref<Amount | null>(null);
const totalObligations = ref<Amount | null>(null);
const coverage = ref<Array<{ ratio: number | null; label: string }>>([]);
const upcomingObligations = ref<UpcomingObligation[]>([]);

const hasData = computed(
  () =>
    totalLiquid.value !== null ||
    totalObligations.value !== null ||
    upcomingObligations.value.length > 0,
);

const currentMonth = computed(() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
});

const scopeLabel = computed(() => `Month: ${currentMonth.value}`);

function coverageLabel(coverageRatio: { ratio: number | null; label: string }): string {
  if (coverageRatio.ratio !== null) return coverageRatio.label;
  if (coverageRatio.label === 'no obligations') {
    return `No upcoming obligations in ${currentMonth.value}`;
  }
  if (coverageRatio.label === 'no 30-day obligations') {
    return `No scheduled obligations in ${currentMonth.value}`;
  }
  return coverageRatio.label;
}

function formatCoverageRatio(ratio: number): string {
  return ratio.toFixed(2).replace(/\.?0+$/, '');
}

const obligationColumns = [
  { key: 'name', label: 'Obligation' },
  { key: 'amount', label: 'Amount', type: 'amount' as const },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'isRecurring', label: 'Recurring' },
];

const obligationRows = computed(() =>
  upcomingObligations.value.map((o) => ({
    name: o.name,
    amount: o.amount,
    dueDate: o.dueDate,
    isRecurring: o.isRecurring ? 'Yes' : 'No',
  })),
);

onMounted(async () => {
  try {
    const res = await $fetch<
      Envelope<{
        totalLiquid: Amount | null;
        totalObligations: Amount | null;
        coverage: Array<{ ratio: number | null; label: string }>;
        upcomingObligations: UpcomingObligation[];
      }>
    >('/api/liquidity', { query: { currentMonth: currentMonth.value } });
    if (res.status === 'ok' && res.result) {
      totalLiquid.value = res.result.totalLiquid;
      totalObligations.value = res.result.totalObligations;
      coverage.value = res.result.coverage;
      upcomingObligations.value = res.result.upcomingObligations;
      freshness.value = res.dataFreshness;
    } else {
      error.value = {
        code: res.error?.code ?? 'UNKNOWN',
        message: res.error?.message ?? 'Liquidity analysis returned an error.',
      };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
