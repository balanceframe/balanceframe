<template>
  <AnalysisPage title="Data Quality" :loading="loading" :error="error">
    <template #content>
      <div class="space-y-4">
        <UCard>
          <template #header><span class="font-semibold">Uncategorized Transactions</span></template>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ qualityMetrics.uncategorized }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Transactions needing category assignment</p>
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Missing Payees</span></template>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ qualityMetrics.missingPayees }}</p>
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Zero Amounts</span></template>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ qualityMetrics.zeroAmounts }}</p>
        </UCard>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });
const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const qualityMetrics = ref({ uncategorized: 0, missingPayees: 0, zeroAmounts: 0 });
</script>
