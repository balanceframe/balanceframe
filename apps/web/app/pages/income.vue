<template>
  <AnalysisPage title="Income Overview" :loading="loading" :error="error">
    <template #content>
      <AnalysisTable :columns="incomeColumns" :rows="incomeRows" />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const incomes = ref<Array<{ source: string; amount: Amount; frequency: string; date: string }>>([]);

const incomeColumns = [
  { key: 'source', label: 'Source' },
  { key: 'amount', label: 'Amount', type: 'amount' as const },
  { key: 'frequency', label: 'Frequency' },
  { key: 'date', label: 'Date' },
];

const incomeRows = computed(() => incomes.value);
</script>
