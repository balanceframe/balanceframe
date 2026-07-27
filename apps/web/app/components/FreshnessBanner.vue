<template>
  <div v-if="freshness" class="flex items-center gap-2 text-xs px-3 py-1.5 rounded-md"
    :class="freshness.isStale
      ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800'
      : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'"
  >
    <span class="shrink-0" :class="freshness.isStale ? 'i-heroicons-exclamation-triangle' : 'i-heroicons-check-circle'" />
    <span>{{ freshness.isStale ? 'Stale data' : 'Data current' }}</span>
    <span v-if="freshness.lastSync" class="opacity-70">
      &mdash; synced {{ formatTimeAgo(freshness.lastSync) }}
    </span>
  </div>
</template>

<script setup lang="ts">
interface Freshness {
  isStale: boolean;
  lastSync: string | null;
  label: string;
}

defineProps<{
  freshness: Freshness | null;
}>();

function formatTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
</script>
