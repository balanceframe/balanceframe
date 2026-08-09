<template>
  <div class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
    <span class="font-medium">{{ scope.label }}</span>
    <span
      v-if="scope.count !== undefined"
      class="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs"
    >
      {{ scope.count }}
    </span>
    <span v-if="scope.filter && Object.keys(scope.filter).length" class="opacity-60">
      {{ describeFilter(scope.filter) }}
    </span>
  </div>
</template>

<script setup lang="ts">
interface Scope {
  label: string;
  filter?: Record<string, unknown>;
  count?: number;
}

defineProps<{
  scope: Scope;
}>();

function describeFilter(filter: Record<string, unknown>): string {
  return Object.entries(filter)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}
</script>
