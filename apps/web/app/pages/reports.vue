<template>
  <AnalysisPage title="Reports" :loading="loading" :error="error">
    <template #content>
      <div class="mb-4 flex flex-wrap gap-2">
        <UButton v-for="rt in reportTypes" :key="rt.value" :variant="reportType === rt.value ? 'solid' : 'outline'" size="sm" @click="selectReport(rt.value)">
          {{ rt.label }}
        </UButton>
      </div>

      <div v-if="reportType" class="mb-4">
        <UFormGroup label="Month range">
          <UInput v-model="monthRange" placeholder="YYYY-MM or YYYY-MM:YYYY-MM" />
        </UFormGroup>
        <UButton class="mt-2" @click="generate">Generate</UButton>
      </div>

      <div v-if="reportResult" class="mt-4">
        <UCard>
          <template #header>
            <span class="font-semibold">{{ reportResult.reportType }} Report</span>
          </template>
          <p class="text-sm text-gray-600 dark:text-gray-400">Report ID: {{ reportResult.reportId }}</p>
          <p v-if="reportResult.summary" class="text-sm mt-2">{{ reportResult.summary }}</p>
        </UCard>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const reportType = ref('');
const monthRange = ref('');
const reportResult = ref<{ reportId: string; reportType: string; summary?: string } | null>(null);

const reportTypes = [
  { label: 'Spending', value: 'spending' },
  { label: 'Income', value: 'income' },
  { label: 'Net Worth', value: 'net_worth' },
  { label: 'Category Breakdown', value: 'category_breakdown' },
  { label: 'Cash Flow', value: 'cash_flow' },
];

function selectReport(val: string) { reportType.value = val; }

async function generate() {
  if (!reportType.value || !monthRange.value) return;
  loading.value = true;
  error.value = null;
  try {
    const res = await $fetch<{ status: string; result: { reportId: string; reportType: string; summary?: string } }>('/api/reports/generate', {
      query: { reportType: reportType.value, monthRange: monthRange.value },
    });
    if (res.status === 'ok') reportResult.value = res.result;
    else error.value = { code: 'GENERATE_FAILED', message: 'Report generation returned error.' };
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
}
</script>
