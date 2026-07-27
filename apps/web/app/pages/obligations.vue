<template>
  <AnalysisPage title="Obligations" :loading="loading" :error="error">
    <template #content>
      <AnalysisTable :columns="obligationColumns" :rows="obligationRows" />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const obligations = ref<Array<{ name: string; amount: Amount; dueDate: string; status: string }>>([]);

const obligationColumns = [
  { key: 'name', label: 'Obligation' },
  { key: 'amount', label: 'Amount', type: 'amount' as const },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'status', label: 'Status', type: 'badge' as const },
];

const obligationRows = computed(() => obligations.value);
</script>
