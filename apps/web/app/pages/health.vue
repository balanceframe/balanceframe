<template>
  <AnalysisPage title="Budget Health" :loading="loading" :error="error">
    <template #content>
      <div class="grid gap-4 sm:grid-cols-3 mb-6">
        <UCard>
          <template #header><span class="font-semibold">Overall Health</span></template>
          <p class="text-lg font-bold" :class="healthColor">{{ healthLabel }}</p>
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Categories on Track</span></template>
          <p class="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{{ onTrack }}</p>
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Categories at Risk</span></template>
          <p class="text-2xl font-bold text-red-600 dark:text-red-400">{{ atRisk }}</p>
        </UCard>
      </div>
      <AnalysisTable :columns="healthColumns" :rows="healthRows" />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const healthLabel = ref('Unknown');
const onTrack = ref(0);
const atRisk = ref(0);
const categories = ref<Array<{ categoryName: string; budgeted: Amount; spent: Amount; remaining: Amount; status: string }>>([]);

const healthColor = computed(() => {
  if (healthLabel.value === 'healthy') return 'text-emerald-600 dark:text-emerald-400';
  if (healthLabel.value === 'caution') return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
});

const healthColumns = [
  { key: 'categoryName', label: 'Category' },
  { key: 'budgeted', label: 'Budgeted', type: 'amount' as const },
  { key: 'spent', label: 'Spent', type: 'amount' as const },
  { key: 'remaining', label: 'Remaining', type: 'amount' as const },
  { key: 'status', label: 'Status', type: 'badge' as const },
];

const healthRows = computed(() => categories.value);

onMounted(async () => {
  try {
    const res = await $fetch<{ status: string; result: { categories: Array<{ categoryName: string; budgeted: Amount; spent: Amount; remaining: Amount; status: string }>; overallLabel: string } }>('/api/home/budget-summary');
    if (res.status === 'ok') {
      categories.value = res.result.categories;
      healthLabel.value = res.result.overallLabel;
      onTrack.value = res.result.categories.filter(c => c.status === 'on_track').length;
      atRisk.value = res.result.categories.filter(c => c.status !== 'on_track').length;
    } else {
      error.value = { code: 'NO_DATA', message: 'Budget summary returned error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
});
</script>
