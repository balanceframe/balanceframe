<template>
  <AnalysisPage title="Targets &amp; Sinking Funds" :loading="loading" :error="error" @retry="load">
    <template #content>
      <!-- No-config state -->
      <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
        No target categories configured. Connect a budget to see target health and sinking fund
        progress.
      </div>

      <div v-if="targetData">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Categories</h3>
        <AnalysisTable :columns="targetColumns" :rows="targetRows" class="mb-6" />
        <nav aria-label="Category backing details" class="mb-6 flex flex-wrap gap-3 text-sm">
          <NuxtLink
            v-for="category in targetData.categories"
            :key="category.categoryId"
            :to="`/liquidity#category-${encodeURIComponent(category.categoryId)}`"
            class="underline"
            >{{ category.categoryName }} — current cash backing</NuxtLink
          >
        </nav>
      </div>
      <div v-if="sinkingData && sinkingRows.length">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Sinking Funds</h3>
        <AnalysisTable :columns="sinkingColumns" :rows="sinkingRows" />
      </div>
      <div
        v-if="sinkingData && !sinkingRows.length"
        class="text-center py-4 text-gray-400 dark:text-gray-500 text-sm"
      >
        No sinking funds configured.
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { TargetHealthResult, SinkingFundHealthResult } from '@balanceframe/application';
import type { Envelope } from '../components/types';
import { analysisError } from '../utils/analysis-error';
import { nullableNormalizedScorePercent } from '../utils/financial-display';

definePageMeta({ layout: 'default' });

const loading = ref(true);
const error = ref<{ code: string; message: string; retryable?: boolean } | null>(null);
const targetData = ref<TargetHealthResult | null>(null);
const sinkingData = ref<SinkingFundHealthResult | null>(null);

const targetColumns = [
  { key: 'categoryName', label: 'Category' },
  { key: 'budgeted', label: 'Budgeted', type: 'amount' as const },
  { key: 'spent', label: 'Spent', type: 'amount' as const },
  { key: 'remaining', label: 'Remaining', type: 'amount' as const },
  { key: 'healthLabel', label: 'Status', type: 'badge' as const },
];
const sinkingColumns = [
  { key: 'categoryName', label: 'Category' },
  { key: 'targetAmount', label: 'Target', type: 'amount' as const },
  { key: 'remaining', label: 'Remaining', type: 'amount' as const },
  { key: 'targetProgress', label: 'Progress' },
  { key: 'healthLabel', label: 'Status', type: 'badge' as const },
];

const hasData = computed(
  () =>
    (targetData.value?.categories ?? []).length > 0 ||
    (sinkingData.value?.sinkingFunds ?? []).length > 0,
);

const targetRows = computed(() =>
  (targetData.value?.categories ?? []).map((category) => ({ ...category })),
);
const sinkingRows = computed(() =>
  (sinkingData.value?.sinkingFunds ?? []).map((category) => {
    const progress = nullableNormalizedScorePercent(category.targetProgress);
    return {
      ...category,
      targetAmount: category.targetAmount ?? 'Unknown',
      targetProgress: progress === null ? 'Unknown' : `${progress}%`,
    };
  }),
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [tRes, sRes] = await Promise.all([
      $fetch<Envelope<TargetHealthResult>>('/api/targets/health'),
      $fetch<Envelope<SinkingFundHealthResult>>('/api/sinking-fund/health'),
    ]);
    const failure = [tRes, sRes].find((response) => response.status !== 'ok' || !response.result);
    if (failure) {
      error.value = failure.error ?? {
        code: 'TARGETS_FAILED',
        message: 'Target health returned an error.',
        retryable: false,
      };
      return;
    }
    targetData.value = tRes.result;
    sinkingData.value = sRes.result;
  } catch (e) {
    error.value = analysisError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
