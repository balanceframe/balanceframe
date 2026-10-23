<template>
  <AnalysisPage title="Cash Flow Projection" :loading="loading" :error="error" @retry="project">
    <template #error-actions>
      <UButton class="mt-3" @click="error = null">Edit parameters</UButton>
    </template>
    <template #content>
      <div class="mb-4">
        <UFormField label="Months to project" class="mb-3">
          <UInput v-model.number="months" type="number" min="1" max="24" />
        </UFormField>
        <UButton :disabled="!months || months < 1" @click="project">Project</UButton>
      </div>

      <!-- Data warning -->
      <UCard v-if="dataWarning" class="mb-4">
        <template #header>
          <span class="font-semibold text-amber-700 dark:text-amber-400">Warning</span>
        </template>
        <p class="text-xs text-gray-600 dark:text-gray-400">{{ dataWarning }}</p>
      </UCard>

      <AnalysisTable
        v-if="projections.length"
        :columns="flowColumns"
        :rows="projections"
        class="mt-4"
      />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import { analysisError } from '../utils/analysis-error';
import type { CashFlowProjectionResult } from '@balanceframe/application';
import type { Envelope } from '../components/types';

definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string; retryable?: boolean } | null>(null);
const months = ref(3);
const projections = ref<Record<string, unknown>[]>([]);
const dataWarning = ref<string | null>(null);

const flowColumns = [
  { key: 'month', label: 'Month' },
  { key: 'projectedIncome', label: 'Income', type: 'amount' as const },
  { key: 'projectedExpenses', label: 'Expenses', type: 'amount' as const },
  { key: 'netChange', label: 'Net', type: 'amount' as const },
  { key: 'endingBalance', label: 'Ending', type: 'amount' as const },
];

async function project() {
  loading.value = true;
  error.value = null;
  try {
    const res = await $fetch<Envelope<CashFlowProjectionResult>>('/api/cash-flow/project', {
      query: { months: String(months.value) },
    });
    if (res.status === 'ok' && res.result) {
      projections.value = res.result.monthlyProjections.map((projection) => ({
        ...projection,
        projectedIncome: projection.projectedIncome ?? 'Unknown',
        projectedExpenses: projection.projectedExpenses ?? 'Unknown',
        netChange: projection.netChange ?? 'Unknown',
        endingBalance: projection.endingBalance ?? 'Unknown',
      }));
      dataWarning.value =
        res.result.dataWarning ??
        (res.result.sufficientData ? null : 'Projection data is insufficient.');
    } else {
      error.value = {
        code: res.error?.code ?? 'PROJECT_FAILED',
        message: res.error?.message ?? 'Projection returned error.',
        retryable: res.error?.retryable ?? false,
      };
    }
  } catch (e) {
    error.value = analysisError(e);
  } finally {
    loading.value = false;
  }
}
</script>
