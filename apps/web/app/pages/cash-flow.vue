<template>
  <AnalysisPage title="Cash Flow Projection" :loading="loading" :error="error" :insufficient-data="!projectionMonths && !loading && !error">
    <template #content>
      <div class="mb-4">
        <UFormGroup label="Months to project" class="mb-3">
          <UInput v-model.number="months" type="number" min="1" max="24" />
        </UFormGroup>
        <UButton :disabled="!months || months < 1" @click="project">Project</UButton>
      </div>

      <div v-if="projections.length" class="mt-4">
        <AnalysisTable :columns="flowColumns" :rows="projections" />
        <p v-if="summary" class="text-xs text-gray-500 dark:text-gray-400 mt-2">
          Net: <SemanticAmount :amount="summary.netProjection" />
          &middot; Min: <SemanticAmount :amount="summary.minBalance" />
          &middot; Max: <SemanticAmount :amount="summary.maxBalance" />
        </p>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const months = ref(3);
const projections = ref<Record<string, unknown>[]>([]);
const summary = ref<{ netProjection: Amount; minBalance: Amount; maxBalance: Amount } | null>(null);
const projectionMonths = ref(0);

const flowColumns = [
  { key: 'month', label: 'Month' },
  { key: 'income', label: 'Income', type: 'amount' as const },
  { key: 'expenses', label: 'Expenses', type: 'amount' as const },
  { key: 'netFlow', label: 'Net', type: 'amount' as const },
  { key: 'endingBalance', label: 'Ending', type: 'amount' as const },
];

async function project() {
  loading.value = true;
  error.value = null;
  try {
    const res = await $fetch<{
      status: string;
      result: {
        projectionMonths: number;
        projections: Array<{ month: string; income: Amount; expenses: Amount; netFlow: Amount; endingBalance: Amount }>;
        summary: { netProjection: Amount; minBalance: Amount; maxBalance: Amount };
      };
    }>('/api/cash-flow/project', { query: { months: String(months.value) } });
    if (res.status === 'ok') {
      projectionMonths.value = res.result.projectionMonths;
      projections.value = res.result.projections.map(p => ({ ...p }));
      summary.value = res.result.summary;
    } else {
      error.value = { code: 'PROJECT_FAILED', message: 'Projection returned error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
}
</script>
