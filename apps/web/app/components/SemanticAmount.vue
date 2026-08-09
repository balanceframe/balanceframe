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
const rawUnits = computed(() => props.amount.minorUnits);
const absUnits = computed(() => {
  const magnitude = rawUnits.value.startsWith('-') ? rawUnits.value.slice(1) : rawUnits.value;
  return magnitude.replace(/^0+(?=\d)/, '') || '0';
});
const isNegative = computed(
  () => props.negative || (rawUnits.value.startsWith('-') && absUnits.value !== '0'),
);
const dollars = computed(() => {
  const u = absUnits.value;
  const padded = u.padStart(3, '0');
  return padded.slice(0, -2) || '0';
});
const cents = computed(() => absUnits.value.slice(-2).padStart(2, '0'));
const sign = computed(() => (isNegative.value ? '−' : ''));
const colorClass = computed(() =>
  isNegative.value ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100',
);
</script>
