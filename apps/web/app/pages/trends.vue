<template>
  <AnalysisPage title="Spending Trends" :loading="loading" :error="error">
    <template #content>
      <AnalysisTable :columns="trendColumns" :rows="trendRows" />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const trends = ref<Array<{ month: string; category: string; spent: Amount; budgeted: Amount; variance: number }>>([]);

const trendColumns = [
  { key: 'month', label: 'Month' },
  { key: 'category', label: 'Category' },
  { key: 'spent', label: 'Spent', type: 'amount' as const },
  { key: 'budgeted', label: 'Budgeted', type: 'amount' as const },
  { key: 'variance', label: 'Variance %' },
];

const trendRows = computed(() => trends.value);
</script>
