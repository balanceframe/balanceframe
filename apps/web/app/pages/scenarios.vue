<template>
  <AnalysisPage title="What-If Scenarios" :loading="loading" :error="error">
    <template #content>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Review and compare budget scenarios. Scenarios are read-only views of ledger data.
      </p>
      <div class="space-y-3">
        <UCard v-for="s in scenarios" :key="s.id">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">{{ s.name }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ s.description }}</p>
            </div>
            <span class="text-xs text-gray-400">{{ s.createdAt }}</span>
          </div>
        </UCard>
        <div v-if="!scenarios.length" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No scenarios yet.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const scenarios = ref<Array<{ id: string; name: string; description: string; createdAt: string }>>([]);
</script>
