<template>
  <span
    :class="colorClass"
    class="tabular-nums font-medium"
    :data-semantic-class="semanticClass"
    :data-state="resolvedState"
    :aria-label="accessibleLabel"
  >
    {{ displayText }}
  </span>
</template>

<script setup lang="ts">
import type { Amount, FinancialSemanticClass, SemanticAmountState } from './types';

const props = defineProps<{
  amount: Amount | null;
  negative?: boolean;
  semanticClass?: FinancialSemanticClass;
  state?: SemanticAmountState;
}>();

const resolvedState = computed<SemanticAmountState>(() => {
  const requestedState = props.state ?? 'known';
  return requestedState === 'known' && !props.amount ? 'unknown' : requestedState;
});

const rawUnits = computed(() => props.amount?.minorUnits ?? '');
const absUnits = computed(() => {
  const magnitude = rawUnits.value.startsWith('-') ? rawUnits.value.slice(1) : rawUnits.value;
  return magnitude.replace(/^0+(?=\d)/, '') || '0';
});
const isNegative = computed(
  () =>
    resolvedState.value === 'known' &&
    (props.negative === true || (rawUnits.value.startsWith('-') && absUnits.value !== '0')),
);
const formattedAmount = computed(() => {
  if (resolvedState.value !== 'known' || !props.amount) return null;

  const padded = absUnits.value.padStart(3, '0');
  const dollars = padded.slice(0, -2) || '0';
  const cents = absUnits.value.slice(-2).padStart(2, '0');
  const sign = isNegative.value ? '−' : '';
  return `${sign}${dollars}.${cents} ${props.amount.currency}`;
});
const stateLabel = computed(() => {
  switch (resolvedState.value) {
    case 'unknown':
      return 'Unknown';
    case 'unavailable':
      return 'Unavailable';
    case 'redacted':
      return 'Restricted';
    default:
      return '';
  }
});
const displayText = computed(() => formattedAmount.value ?? stateLabel.value);
const semanticLabel = computed(() => {
  if (!props.semanticClass) return null;
  const words = props.semanticClass.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
});
const accessibleLabel = computed(() =>
  semanticLabel.value ? `${semanticLabel.value}: ${displayText.value}` : undefined,
);
const colorClass = computed(() => {
  if (resolvedState.value !== 'known') return 'text-gray-500 dark:text-gray-400';
  return isNegative.value ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100';
});
</script>
