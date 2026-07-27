<template>
  <AnalysisPage title="Financial Calendar" :loading="loading" :error="error">
    <template #content>
      <div class="text-center py-8 text-gray-500 dark:text-gray-400">
        <p class="text-sm">Upcoming bills and recurring transactions calendar view.</p>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });
const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
</script>
