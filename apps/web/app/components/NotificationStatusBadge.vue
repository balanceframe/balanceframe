<template>
  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
    :class="badgeClass"
  >
    <span class="w-1.5 h-1.5 rounded-full" :class="dotClass" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  status: string;
}>();

const statusConfig: Record<string, { label: string; bg: string; dot: string }> = {
  delivered: { label: 'Delivered', bg: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  pending: { label: 'Pending', bg: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  failed: { label: 'Failed', bg: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  suppressed: { label: 'Suppressed', bg: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400', dot: 'bg-gray-400' },
  acknowledged: { label: 'Acknowledged', bg: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400', dot: 'bg-blue-500' },
  retryable: { label: 'Retrying', bg: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400', dot: 'bg-orange-500' },
};

const config = computed(() => statusConfig[props.status] || { label: props.status, bg: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400', dot: 'bg-gray-400' });
const badgeClass = computed(() => config.value.bg);
const dotClass = computed(() => config.value.dot);
const label = computed(() => config.value.label);
</script>
