<template>
  <div class="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
    <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
      <thead class="bg-gray-50 dark:bg-gray-800">
        <tr>
          <th v-for="col in columns" :key="col.key"
            scope="col"
            class="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
          >
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody class="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-800">
        <tr v-for="(row, i) in rows" :key="i" class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
          <td v-for="col in columns" :key="col.key" class="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
            <template v-if="col.type === 'amount' && typeof row[col.key] === 'object' && row[col.key] !== null">
              <SemanticAmount :amount="row[col.key] as Amount" />
            </template>
            <template v-else-if="col.type === 'badge'">
              <span class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                :class="badgeClass(String(row[col.key]))">
                {{ row[col.key] }}
              </span>
            </template>
            <template v-else>
              {{ row[col.key] }}
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length" class="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No data available.
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import type { Amount } from './types';

interface Column {
  key: string;
  label: string;
  type?: 'text' | 'amount' | 'badge';
}

defineProps<{
  columns: Column[];
  rows: Record<string, unknown>[];
}>();

function badgeClass(value: string): string {
  const good = ['on_track', 'healthy', 'delivered', 'sufficient', 'paid'];
  const bad = ['at_risk', 'overspent', 'failed', 'critical', 'overdue'];
  if (good.includes(value)) return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
  if (bad.includes(value)) return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
  return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
}
</script>
