<template>
  <UCard
    class="h-full min-h-0 flex flex-col"
    :ui="{ body: 'flex flex-col flex-1 min-h-0' }"
  >
    <template #header>
      <h2 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
        Queue
      </h2>
    </template>

    <div class="space-y-1 flex-1 overflow-y-auto min-h-0">
      <button
        v-for="(item, idx) in items"
        :key="item.reviewItem.id"
        :class="queueItemClass(idx)"
        @click="onItemClick(idx, $event)"
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
            {{ statusLabel(item.reviewItem.status) }}
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
import type { ReviewQueueItem, ReviewStatus } from '../../src/review.js';
import { computed } from 'vue';

const props = defineProps<{
  items: readonly ReviewQueueItem[];
  currentIndex: number;
  selectedIndices: readonly number[];
  hasMore: boolean;
}>();

const emit = defineEmits<{
  navigate: [index: number];
  'toggle-selection': [index: number];
  'load-more': [];
}>();

function onItemClick(idx: number, event: MouseEvent): void {
  if (event.shiftKey) {
    emit('toggle-selection', idx);
    return;
  }
  emit('navigate', idx);
}

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

function statusColor(status: ReviewStatus): 'primary' | 'success' | 'warning' | 'neutral' | 'error' {
  switch (status) {
    case 'pending_review': return 'primary';
    case 'approved':       return 'success';
    case 'correcting':     return 'neutral';
    case 'superseded':     return 'neutral';
    case 'skipped':
    case 'rejected':       return 'error';
    default:               return 'neutral';
  }
}

function statusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'pending_review':   return 'Pending Review';
    case 'approved':         return 'Approved';
    case 'correcting':       return 'Edited';
    case 'superseded':       return 'Superseded';
    case 'skipped':          return 'Skipped';
    case 'rejected':         return 'Rejected';
    case 'applied':          return 'Applied';
    case 'apply_failed':     return 'Apply Failed';
    default:                 return status;
  }
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}
</script>
