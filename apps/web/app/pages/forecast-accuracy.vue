<template>
  <AnalysisPage title="Forecast Accuracy" :loading="loading" :error="error">
    <template #content>
      <div class="grid gap-4 sm:grid-cols-2">
        <UCard>
          <template #header><span class="font-semibold">Overall Accuracy</span></template>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ accuracy }}%</p>
        </UCard>
        <UCard>
          <template #header><span class="font-semibold">Categories Tracked</span></template>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ trackedCategories }}</p>
        </UCard>
      </div>
      <AnalysisTable :columns="accuracyColumns" :rows="accuracyRows" class="mt-4" />
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const accuracy = ref(0);
const trackedCategories = ref(0);
const categoryAccuracy = ref<Array<{ category: string; accuracy: number; trend: string }>>([]);

const accuracyColumns = [
  { key: 'category', label: 'Category' },
  { key: 'accuracy', label: 'Accuracy %' },
  { key: 'trend', label: 'Trend' },
];

const accuracyRows = computed(() => categoryAccuracy.value);
</script>
