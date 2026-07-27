<template>
  <AnalysisPage title="Liquidity" :loading="loading" :error="error">
    <template #content>
      <div class="grid gap-4 sm:grid-cols-2">
        <UCard>
          <template #header><span class="font-semibold">Current Balance</span></template>
          <SemanticAmount :amount="{ minorUnits: liquidityData.currentBalance, currency: 'USD' }" />
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Available</span></template>
          <SemanticAmount :amount="{ minorUnits: liquidityData.available, currency: 'USD' }" />
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Upcoming</span></template>
          <SemanticAmount :amount="{ minorUnits: liquidityData.upcoming, currency: 'USD' }" />
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Liquidity Ratio</span></template>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ liquidityData.ratio }}%</p>
        </UCard>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });
const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const liquidityData = ref({ currentBalance: '0', available: '0', upcoming: '0', ratio: 0 });
</script>
