<template>
  <div class="flex flex-col items-center justify-center py-8 text-center">
    <div class="i-heroicons-chart-bar-square text-3xl text-gray-300 dark:text-gray-600 mb-2" />
    <p class="text-sm text-gray-500 dark:text-gray-400 font-medium">Insufficient Data</p>
    <p class="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-xs">
      {{ reason || 'Not enough transaction history is available for this analysis.' }}
    </p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  reason?: string;
}>();
</script>
