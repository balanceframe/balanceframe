<template>
  <span :class="colorClass" class="tabular-nums font-medium">
    {{ sign }}{{ dollars }}.{{ cents }}
    <span class="text-xs opacity-60 ml-0.5">{{ currency }}</span>
  </span>
</template>

<script setup lang="ts">
interface Amount {
  minorUnits: string;
  currency: string;
}

const props = defineProps<{
  amount: Amount;
  negative?: boolean;
}>();

const currency = computed(() => props.amount.currency || 'USD');
const isNegative = computed(() => props.negative || Number(props.amount.minorUnits) < 0);
const absUnits = computed(() => String(Math.abs(Number(props.amount.minorUnits))));
const dollars = computed(() => {
  const u = absUnits.value;
  const padded = u.padStart(3, '0');
  return padded.slice(0, -2) || '0';
});
const cents = computed(() => absUnits.value.slice(-2).padStart(2, '0'));
const sign = computed(() => isNegative.value ? '−' : '');
const colorClass = computed(() => isNegative.value ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100');
</script>
