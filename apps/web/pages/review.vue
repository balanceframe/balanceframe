<template>
  <UContainer class="py-4">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-bold">Review Transactions</h1>
      <div class="flex gap-2">
        <UBadge
          v-if="adapter.loading"
          color="warning"
          variant="soft"
          label="Loading…"
        />
        <UBadge
          v-else-if="adapter.error"
          color="error"
          variant="soft"
          :label="adapter.error"
        />
        <UBadge
          v-else
          color="neutral"
          variant="solid"
          :label="`${currentCount} items`"
        />
      </div>
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="adapter.state.error"
      :title="adapter.state.error.code"
      :description="adapter.state.error.message"
      color="error"
      variant="soft"
      class="mb-4"
    >
      <template #trailing>
        <UButton
          v-if="adapter.state.error.retryable"
          label="Retry"
          color="error"
          variant="solid"
          size="sm"
          @click="load"
        />
      </template>
    </UAlert>

    <!-- Empty state -->
    <UCard v-if="!adapter.state.currentItem && !adapter.loading" class="text-center py-8">
      <p class="text-gray-500 dark:text-gray-400 text-lg">
        No items to review.
      </p>
      <UButton
        v-if="adapter.state.hasMore"
        label="Load more"
        color="primary"
        variant="solid"
        class="mt-4"
        @click="load"
      />
    </UCard>

    <!-- Review queue and current-item detail -->
    <template v-if="adapter.state.currentItem">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <!-- Queue sidebar -->
        <div class="lg:col-span-1 order-2 lg:order-1">
          <ReviewQueue
            :items="adapter.state.items"
            :current-index="adapter.state.currentIndex"
            :selected-indices="adapter.state.selectedIndices"
            :has-more="adapter.state.hasMore"
            @select="adapter.toggleSelection($event)"
            @load-more="load"
          />
        </div>

        <!-- Current item detail -->
        <div class="lg:col-span-2 order-1 lg:order-2">
          <ReviewItem
            :item="adapter.state.currentItem"
            :state="adapter.state"
          />
        </div>
      </div>

      <!-- Action bar -->
      <ReviewActions
        :has-current="!!adapter.state.currentItem"
        :has-selection="adapter.state.selectedIndices.length > 0"
        :loading="adapter.loading"
        :metrics="adapter.state.metrics"
        @approve="adapter.approve()"
        @correct="promptAndCorrect"
        @reject="adapter.reject()"
        @skip="adapter.skip()"
        @undo="adapter.undo()"
        @bulk-approve="adapter.bulkApprove()"
        @bulk-reject="adapter.bulkReject()"
        @bulk-skip="adapter.bulkSkip()"
        @refresh="adapter.refresh()"
        @reset-metrics="adapter.resetMetrics()"
        :class="{ 'mt-4': adapter.state.currentItem }"
      />

      <!-- Metrics summary -->
      <ReviewMetrics
        v-if="adapter.state.metrics.resolvedCount > 0"
        :metrics="adapter.state.metrics"
        class="mt-4"
      />
    </template>

    <!-- Keyboard handler (invisible) -->
    <input
      ref="keyboardInput"
      class="absolute opacity-0 w-0 h-0 pointer-events-none"
      aria-hidden="true"
      tabindex="-1"
      @keydown="actions.handleKeyboard"
    />
  </UContainer>
</template>

<script setup lang="ts">
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { ReviewController } from '../src/review.js';
import { useReviewController } from '../composables/useReviewController';
import { useApiReviewController } from '../composables/useApiReviewController';
import { useReviewActions } from '../composables/useReviewActions';
import type { ReviewControllerAdapter } from '../types/review-client';

// ── Mode selection ──────────────────────────────────────────────────
// When runtimeConfig.public.apiBase is configured, use Nitro API routes.
// Otherwise fall back to the in-memory WorkflowStore (development/legacy).
const config = useRuntimeConfig();
const apiBase = config.public.apiBase;

let adapter: ReviewControllerAdapter;
if (apiBase) {
  adapter = useApiReviewController(apiBase);
} else {
  const store = new SqliteWorkflowStore(':memory:');
  const controller = new ReviewController(store, {
    actorId: 'web-user',
    pageSize: 50,
  });
  adapter = useReviewController(controller);
}
const actions = useReviewActions(adapter);

// Focus the hidden keyboard input so shortcuts work on page load.
const keyboardInput = ref<HTMLInputElement | null>(null);
onMounted(() => {
  keyboardInput.value?.focus();
  load();
});

// ── Helpers ──────────────────────────────────────────────────────────

const currentCount = computed(() => adapter.state.items.length);

async function load() {
  await adapter.loadNextPage();
  keyboardInput.value?.focus();
}

function promptAndCorrect(category?: string) {
  const cat = category ?? prompt('Category ID:');
  if (cat) adapter.correct(cat);
}
</script>
