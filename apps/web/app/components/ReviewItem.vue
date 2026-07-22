<template>
  <UCard
    class="h-full min-h-0 flex flex-col"
    :ui="{ body: 'flex flex-col flex-1 min-h-0' }"
  >
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold truncate">
          {{ item.evidence.normalizedMerchant }}
        </h2>
        <UBadge
          :color="statusBadgeColor"
          variant="solid"
          size="sm"
        >
          {{ item.reviewItem.status }}
        </UBadge>
      </div>
    </template>

    <div class="space-y-3 flex-1 overflow-y-auto min-h-0">
      <!-- Transaction details -->
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span class="text-gray-500 dark:text-gray-400">Original name</span>
          <p class="font-medium">{{ item.evidence.originalImportedName }}</p>
        </div>
        <div>
          <span class="text-gray-500 dark:text-gray-400">Account</span>
          <p class="font-medium">{{ item.evidence.account }}</p>
        </div>
        <div>
          <span class="text-gray-500 dark:text-gray-400">Amount</span>
          <p class="font-medium">{{ formatAmount(item.evidence.amount) }}</p>
        </div>
        <div>
          <span class="text-gray-500 dark:text-gray-400">Provenance</span>
          <p class="font-medium">{{ item.evidence.provenance }}</p>
        </div>
      </div>

      <!-- Proposal metadata -->
      <div class="border-t pt-3 border-neutral-200 dark:border-neutral-700">
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div v-if="item.evidence.correlationId">
            <span class="text-xs text-gray-500 dark:text-gray-400">Correlation ID</span>
            <p class="font-mono text-xs mt-0.5">{{ item.evidence.correlationId }}</p>
          </div>
          <div v-if="item.evidence.promptVersion">
            <span class="text-xs text-gray-500 dark:text-gray-400">Prompt version</span>
            <p class="font-medium text-xs mt-0.5">{{ item.evidence.promptVersion }}</p>
          </div>
          <div>
            <span class="text-xs text-gray-500 dark:text-gray-400">Recovery state</span>
            <div class="mt-0.5">
              <UBadge
                :color="statusBadgeColor"
                variant="solid"
                size="sm"
              >
                {{ recoveryStateLabel }}
              </UBadge>
            </div>
          </div>
        </div>
      </div>

      <!-- Category change preview (hidden when unchanged) -->
      <div
        v-if="item.evidence.changePreview.fromCategory !== item.evidence.changePreview.toCategory"
        class="border-t pt-3 border-neutral-200 dark:border-neutral-700"
      >
        <div class="flex items-center gap-2 text-sm">
          <span class="text-gray-500 dark:text-gray-400">From</span>
          <UBadge color="neutral" variant="soft">
            {{ displayName(item.evidence.changePreview.fromCategory) }}
          </UBadge>
          <span class="text-gray-400">&rarr;</span>
          <span class="text-gray-500 dark:text-gray-400">To</span>
          <UBadge
            :color="item.evidence.changePreview.affectsEnvelope ? 'warning' : 'success'"
            variant="soft"
          >
            {{ displayName(item.evidence.changePreview.toCategory) }}
          </UBadge>
        </div>
      </div>

      <!-- Freshness / expiry indicator -->
      <div v-if="item.evidence.freshness" class="text-xs text-gray-400">
        <span v-if="!isStale(item.evidence.freshness)">
          &#x2713; Fresh until {{ formatDate(item.evidence.freshness) }}
        </span>
        <span v-else class="text-warning-600 dark:text-warning-400 font-medium">
          &#9888; Stale since {{ formatDate(item.evidence.freshness) }}
        </span>
      </div>

      <!-- Alternative categories -->
      <div v-if="item.evidence.alternatives.length > 0" class="border-t pt-3 border-neutral-200 dark:border-neutral-700">
        <span class="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Alternatives
        </span>
        <div class="flex flex-wrap gap-1">
          <UBadge
            v-for="alt in item.evidence.alternatives"
            :key="alt"
            color="neutral"
            variant="outline"
            size="sm"
          >
            {{ displayName(alt) }}
          </UBadge>
        </div>
      </div>

      <!-- Classification history -->
      <div
        v-if="item.evidence.history.length > 0"
        class="border-t pt-3 border-neutral-200 dark:border-neutral-700"
      >
        <span class="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Prior classifications
        </span>
        <div class="space-y-1">
          <div
            v-for="h in item.evidence.history"
            :key="h.categoryId + h.lastClassified"
            class="flex items-center justify-between text-xs"
          >
            <span>{{ displayName(h.categoryId) }}</span>
            <span class="text-gray-400">{{ h.count }}x &middot; {{ formatDate(h.lastClassified) }}</span>
          </div>
        </div>
      </div>

      <!-- Rule candidates -->
      <div
        v-if="item.evidence.ruleCandidates.length > 0"
        class="border-t pt-3 border-neutral-200 dark:border-neutral-700"
      >
        <span class="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Create rule
        </span>
        <div class="space-y-2">
          <div
            v-for="rc in item.evidence.ruleCandidates"
            :key="rc.merchant + rc.currentCategory"
            class="flex items-center justify-between px-2 py-1 rounded bg-neutral-50 dark:bg-neutral-800 text-xs"
          >
            <span>
              {{ rc.merchant }}&rarr;
              <span class="font-medium">{{ displayName(rc.currentCategory) }}</span>
            </span>
            <span class="text-gray-400">
              {{ rc.matchCount }} match{{ rc.matchCount !== 1 ? 'es' : '' }}
              &middot;
              {{ Math.round(rc.consistency * 100) }}% consistent
            </span>
          </div>
        </div>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { ReviewQueueItem, ReviewSurfaceState } from '../../src/review.js';
import { computed } from 'vue';

const props = defineProps<{
  item: ReviewQueueItem;
  state: ReviewSurfaceState;
}>();

const statusBadgeColor = computed(() => {
  switch (props.item.reviewItem.status) {
    case 'pending_review': return 'primary';
    case 'approved':       return 'success';
    case 'correcting':     return 'warning';
    case 'superseded':     return 'neutral';
    case 'skipped':
    case 'rejected':       return 'error';
    case 'applied':        return 'success';
    case 'apply_failed':   return 'error';
    default:               return 'neutral';
  }
});

const recoveryStateLabel = computed(() => {
  switch (props.item.reviewItem.status) {
    case 'pending_review': return 'Awaiting review';
    case 'approved':       return 'Approved';
    case 'correcting':     return 'Recovering';
    case 'superseded':     return 'Superseded';
    case 'skipped':        return 'Skipped';
    case 'rejected':       return 'Rejected';
    case 'applied':        return 'Verified applied';
    case 'apply_failed':   return 'Failed';
    default:               return props.item.reviewItem.status;
  }
});

function displayName(id: string | undefined | null): string {
  if (!id) return '—';
  return props.item.evidence.categoryNames?.[id] ?? id;
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isStale(freshness: string): boolean {
  return new Date(freshness).getTime() < Date.now();
}
</script>
