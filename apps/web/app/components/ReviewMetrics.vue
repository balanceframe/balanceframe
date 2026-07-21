<template>
  <UCard>
    <template #header>
      <h3 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
        Session metrics
      </h3>
    </template>

    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
      <div class="text-center">
        <p class="text-lg font-bold">{{ metrics.resolvedCount }}</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Resolved</p>
      </div>
      <div class="text-center">
        <p class="text-lg font-bold">{{ pct(metrics.acceptanceRate) }}%</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Acceptance</p>
      </div>
      <div class="text-center">
        <p class="text-lg font-bold">{{ pct(metrics.correctionRate) }}%</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Correction</p>
      </div>
      <div class="text-center">
        <p class="text-lg font-bold">{{ pct(metrics.rejectionRate) }}%</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Rejection</p>
      </div>
      <div class="text-center">
        <p class="text-lg font-bold">{{ formatMs(metrics.medianReviewTimeMs) }}</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Median time</p>
      </div>
      <div class="text-center">
        <p class="text-lg font-bold">{{ metrics.backlogCount }}</p>
        <p class="text-xs text-gray-500 dark:text-gray-400">Backlog</p>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { ReviewMetricsSnapshot } from '../../src/review.js';

defineProps<{
  metrics: ReviewMetricsSnapshot;
}>();

function pct(rate: number): string {
  return (rate * 100).toFixed(0);
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}
</script>
