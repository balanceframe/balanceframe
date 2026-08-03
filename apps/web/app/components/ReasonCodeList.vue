<template>
  <div v-if="codes.length" class="flex flex-wrap gap-1.5">
    <span
      v-for="code in codes"
      :key="code"
      class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
      :class="severityClass(code)"
    >
      {{ formatCode(code) }}
    </span>
  </div>
  <span v-else class="text-xs text-gray-400 dark:text-gray-500">No reason codes</span>
</template>

<script setup lang="ts">
defineProps<{
  codes: string[];
}>();

function formatCode(code: string): string {
  return code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function severityClass(_code: string): string {
  return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
}
</script>
