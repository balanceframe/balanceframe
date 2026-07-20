<template>
  <UCard>
    <template #header>
      <h2 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
        Queue
      </h2>
    </template>

    <div class="space-y-1 max-h-96 overflow-y-auto">
      <button
        v-for="(item, idx) in items"
        :key="item.reviewItem.id"
        :class="queueItemClass(idx)"
        @click="$emit('select', idx)"
        :aria-current="idx === currentIndex ? 'true' : undefined"
      >
        <div class="flex items-center justify-between min-w-0">
          <span class="truncate text-sm font-medium">
            {{ item.evidence.normalizedMerchant }}
          </span>
          <UBadge
            :color="statusColor(item.reviewItem.status)"
            variant="solid"
            size="xs"
            class="shrink-0 ml-2"
          >
            {{ item.reviewItem.status }}
          </UBadge>
        </div>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {{ formatAmount(item.evidence.amount) }}
        </div>
      </button>
    </div>

    <template #footer>
      <UButton
        v-if="hasMore"
        label="Load more"
        color="neutral"
        variant="ghost"
        size="sm"
        class="w-full"
        @click="$emit('load-more')"
      />
    </template>
  </UCard>
</template>

<script setup lang="ts">
import type { ReviewQueueItem, ReviewStatus } from '../src/review.js';
import { computed } from 'vue';

const props = defineProps<{
  items: readonly ReviewQueueItem[];
  currentIndex: number;
  selectedIndices: readonly number[];
  hasMore: boolean;
}>();

defineEmits<{
  select: [index: number];
  'load-more': [];
}>();

function queueItemClass(idx: number): Record<string, boolean> {
  const isCurrent = idx === props.currentIndex;
  const isSelected = props.selectedIndices.includes(idx);
  return {
    'w-full text-left px-3 py-2 rounded-md transition-colors text-sm': true,
    'bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-700': isCurrent,
    'bg-neutral-100 dark:bg-neutral-800': isSelected && !isCurrent,
    'hover:bg-neutral-50 dark:hover:bg-neutral-800/50': !isCurrent && !isSelected,
  };
}

function statusColor(status: ReviewStatus): string {
  switch (status) {
    case 'pending_review': return 'primary';
    case 'approved':       return 'success';
    case 'correcting':     return 'warning';
    case 'superseded':     return 'neutral';
    case 'skipped':
    case 'rejected':       return 'error';
    default:               return 'neutral';
  }
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}
</script>
