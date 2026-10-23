<template>
  <div class="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
    <table
      class="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm"
      :aria-label="ariaLabel"
    >
      <thead class="bg-gray-50 dark:bg-gray-800">
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            scope="col"
            :aria-sort="
              activeSortKey === col.key
                ? activeSortDir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined
            "
            class="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
          >
            <button
              type="button"
              class="flex items-center gap-1 w-full text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-primary-500 focus-visible:outline-offset-2"
              tabindex="0"
              :aria-label="`Sort by ${col.label}`"
              @click="sortBy(col.key)"
            >
              {{ col.label }}
              <span v-if="activeSortKey === col.key" class="text-[10px]">{{
                activeSortDir === 'asc' ? '▲' : '▼'
              }}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody class="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-800">
        <tr
          v-for="(row, i) in sortedRows"
          :key="i"
          class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
        >
          <td
            v-for="col in columns"
            :key="col.key"
            class="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300"
          >
            <template
              v-if="
                col.type === 'amount' && typeof row[col.key] === 'object' && row[col.key] !== null
              "
            >
              <SemanticAmount :amount="row[col.key] as Amount" />
            </template>
            <template v-else-if="col.type === 'badge'">
              <span
                class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                :class="badgeClass(String(row[col.key]))"
              >
                {{ row[col.key] }}
              </span>
            </template>
            <template v-else>
              {{ row[col.key] }}
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td
            :colspan="columns.length"
            class="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500"
          >
            No data available.
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Amount } from './types';

interface Column {
  key: string;
  label: string;
  type?: 'text' | 'amount' | 'badge';
}

const props = defineProps<{
  columns: Column[];
  rows: Record<string, unknown>[];
  ariaLabel?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
}>();

const emit = defineEmits<{
  sort: [key: string];
}>();

const localSortKey = ref('');
const localSortDir = ref<'asc' | 'desc'>('asc');
const activeSortKey = computed(() => props.sortKey ?? localSortKey.value);
const activeSortDir = computed(() =>
  props.sortKey === undefined ? localSortDir.value : (props.sortDir ?? 'asc'),
);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const numericLabel = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(%|\/\s*100)?$/;

function isAmount(value: unknown): value is Amount {
  return (
    typeof value === 'object' &&
    value !== null &&
    'minorUnits' in value &&
    typeof value.minorUnits === 'string' &&
    /^-?\d+$/.test(value.minorUnits) &&
    'currency' in value &&
    typeof value.currency === 'string'
  );
}

function compareValues(left: unknown, right: unknown): number {
  if (isAmount(left) && isAmount(right)) {
    const currency = collator.compare(left.currency, right.currency);
    if (currency) return currency;
    const leftUnits = BigInt(left.minorUnits);
    const rightUnits = BigInt(right.minorUnits);
    return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number')
    return left < right ? -1 : left > right ? 1 : 0;
  const leftLabel = numericLabel.exec(String(left).trim());
  const rightLabel = numericLabel.exec(String(right).trim());
  const leftNumeric = leftLabel?.[1];
  const rightNumeric = rightLabel?.[1];
  if (leftNumeric !== undefined && rightNumeric !== undefined && leftLabel?.[2] === rightLabel?.[2]) {
    if (!leftNumeric.includes('.') && !rightNumeric.includes('.')) {
      const leftInteger = BigInt(leftNumeric);
      const rightInteger = BigInt(rightNumeric);
      return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
    }
    const difference = Number(leftNumeric) - Number(rightNumeric);
    if (Number.isFinite(difference)) return Math.sign(difference);
  }
  return collator.compare(String(left), String(right));
}

const sortedRows = computed(() => {
  if (!activeSortKey.value || props.sortKey !== undefined) return props.rows;
  const key = activeSortKey.value;
  return [...props.rows].sort((left, right) => {
    const a = left[key];
    const b = right[key];
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
    if (b === null || b === undefined) return -1;
    return compareValues(a, b) * (activeSortDir.value === 'asc' ? 1 : -1);
  });
});

function sortBy(key: string) {
  if (props.sortKey === undefined) {
    localSortDir.value =
      localSortKey.value === key && localSortDir.value === 'asc' ? 'desc' : 'asc';
    localSortKey.value = key;
  }
  emit('sort', key);
}

function badgeClass(value: string): string {
  const good = ['on_track', 'healthy', 'delivered', 'sufficient', 'paid'];
  const bad = ['at_risk', 'overspent', 'failed', 'critical', 'overdue'];
  if (good.includes(value))
    return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
  if (bad.includes(value)) return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
  return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
}
</script>
