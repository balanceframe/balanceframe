<template>
  <AnalysisPage title="Targets &amp; Sinking Funds" :loading="loading" :error="error">
    <template #content>
      <!-- No-config state -->
      <div v-if="!hasData" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
        No target categories configured. Connect a budget to see target health and sinking fund progress.
      </div>

      <div v-if="targetData">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Categories</h3>
        <AnalysisTable :columns="targetColumns" :rows="targetRows" class="mb-6" />
      </div>
      <div v-if="sinkingData && sinkingRows.length">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Sinking Funds</h3>
        <AnalysisTable :columns="targetColumns" :rows="sinkingRows" />
      </div>
      <div v-if="sinkingData && !sinkingRows.length" class="text-center py-4 text-gray-400 dark:text-gray-500 text-sm">
        No sinking funds configured.
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const targetData = ref<{ categories: CategoryHealth[]; overallLabel: string } | null>(null);
const sinkingData = ref<{ sinkingFunds: CategoryHealth[]; fullyFunded: number } | null>(null);

interface CategoryHealth {
  categoryId: string;
  categoryName: string;
  progress: number;
  target: Amount;
  current: Amount;
  status: string;
}

const targetColumns = [
  { key: 'categoryName', label: 'Category' },
  { key: 'target', label: 'Target', type: 'amount' as const },
  { key: 'current', label: 'Current', type: 'amount' as const },
  { key: 'progress', label: 'Progress' },
  { key: 'status', label: 'Status', type: 'badge' as const },
];

const hasData = computed(() => (targetData.value?.categories ?? []).length > 0 || (sinkingData.value?.sinkingFunds ?? []).length > 0);

const targetRows = computed(() => (targetData.value?.categories ?? []).map(c => ({ ...c, progress: `${Math.round(c.progress * 100)}%` })));
const sinkingRows = computed(() => (sinkingData.value?.sinkingFunds ?? []).map(c => ({ ...c, progress: `${Math.round(c.progress * 100)}%` })));

onMounted(async () => {
  try {
    const [tRes, sRes] = await Promise.all([
      $fetch<{ status: string; result: { categories: CategoryHealth[]; overallLabel: string } }>('/api/targets/health'),
      $fetch<{ status: string; result: { sinkingFunds: CategoryHealth[]; fullyFunded: number } }>('/api/sinking-fund/health'),
    ]);
    if (tRes.status === 'ok') targetData.value = tRes.result;
    if (sRes.status === 'ok') sinkingData.value = sRes.result;
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
