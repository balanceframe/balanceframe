<template>
  <UContainer class="h-dvh overflow-hidden flex flex-col py-4">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <h1 class="text-xl font-bold">Review Transactions</h1>
      <div class="flex items-center gap-2">
        <UButton
          variant="ghost"
          color="neutral"
          size="sm"
          label="Sign out"
          icon="i-heroicons-arrow-right-on-rectangle"
          @click="handleSignOut"
        />
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

    <!-- Error state (API errors, not empty queue) -->
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
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
          <!-- Queue sidebar -->
          <div class="lg:col-span-1 flex flex-col min-h-0">
            <ReviewQueue
              :items="adapter.state.items"
              :current-index="adapter.state.currentIndex"
              :selected-indices="adapter.state.selectedIndices"
              :has-more="adapter.state.hasMore"
              @navigate="adapter.selectIndex($event)"
              @toggle-selection="adapter.toggleSelection($event)"
              @load-more="load"
              class="flex-1"
            />
          </div>
          <!-- Current item detail -->
          <div class="lg:col-span-2 order-1 lg:order-2 flex flex-col min-h-0">
            <ReviewItem
              :item="adapter.state.currentItem"
              :state="adapter.state"
              class="flex-1"
            />
          </div>
        </div>

        <!-- Session metrics stay above the pinned action footer. -->
        <ReviewMetrics
          v-if="adapter.state.metrics.resolvedCount > 0"
          :metrics="adapter.state.metrics"
          class="shrink-0 mt-4"
        />

        <!-- Action footer remains the last, visible row in the viewport. -->
        <ReviewActions
          :has-current="!!adapter.state.currentItem"
          :has-selection="adapter.state.selectedIndices.length > 0"
          :loading="adapter.loading"
          :metrics="adapter.state.metrics"
          :has-rule-candidates="!!adapter.state.currentItem?.evidence.ruleCandidates?.length"
          @correct="openCorrectModal"
          @propose-rule="promptProposeRule"
          @approve="adapter.approve()"
          @reject="adapter.reject()"
          @refresh="adapter.refresh()"
  :proposal-count="activeProposals.length"
          @undo="adapter.undo()"
          @bulk-approve="adapter.bulkApprove()"
          @bulk-reject="adapter.bulkReject()"
          @bulk-skip="adapter.bulkSkip()"
          @show-proposals="openProposalsModal"
          @reset-metrics="adapter.resetMetrics()"
          class="shrink-0"
        />
      </div>
    </template>

    <!-- Keyboard handler (invisible) — holds initial focus on page load -->
    <input
      ref="keyboardInput"
      class="absolute opacity-0 w-0 h-0 pointer-events-none"
      aria-hidden="true"
      tabindex="-1"
    />

<!-- Category correction modal -->
<CategoryCorrectModal
  :open="showCorrectModal"
  :item="adapter.state.currentItem"
  @confirm="onCorrectConfirm"
  @cancel="onCorrectCancel"
/>

<!-- Proposed rules modal -->
<ProposedRulesModal
  :open="showProposalsModal"
  :proposals="activeProposals"
  @close="showProposalsModal = false"
  @accepted="handleProposalAccepted"
  @discarded="handleProposalDiscarded"
/>
  </UContainer>
</template>

<script setup lang="ts">
/**
 * Review transactions page.
 *
 * REQUIRES runtimeConfig.public.apiBase to be configured. When the API
 * backend is absent the page renders a non-operational error state — it
 * NEVER falls back to an in-memory SqliteWorkflowStore or exposes mutation
 * controls without a remote backend.
 */
import { authClient } from '../../lib/auth-client';
import { useApiReviewController } from '../../composables/useApiReviewController';
import { createUnavailableAdapter } from '../../composables/createUnavailableAdapter';
import { useReviewActions } from '../../composables/useReviewActions';
import ProposedRulesModal from '../components/ProposedRulesModal.vue';
import type { CategorizationProposalListItem } from '../components/ProposedRulesModal.vue';

// ── Mode selection ──────────────────────────────────────────────────
// Use the configured API base, falling back to the current origin for
// same-origin SPA operation (the default with Better Auth on Nuxt).
const config = useRuntimeConfig();
const apiBase = config.public.apiBase || (import.meta.client ? window.location.origin : '');

// Session auth is provided by Better Auth's HttpOnly session cookie, sent
// automatically with same-origin fetch requests — no Bearer token needed.
const adapter = apiBase
  ? useApiReviewController(apiBase)
  : createUnavailableAdapter();
const actions = useReviewActions(adapter, openCorrectModal);

// Focus the hidden keyboard input so shortcuts work on page load.
// A document-level keydown listener ensures shortcuts remain active after
// pointer-triggered actions (which would otherwise steal focus from the
// hidden input).
const keyboardInput = ref<HTMLInputElement | null>(null);
function handleGlobalKeydown(event: KeyboardEvent) {
  // Ignore events in editable elements to avoid interfering with typing.
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.isContentEditable) return;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // Don't steal browser shortcuts (Ctrl+C, Ctrl+A, etc.)
  if (event.ctrlKey || event.metaKey) return;

  actions.handleKeyboard(event);
}
onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown);
  keyboardInput.value?.focus();
  load();
  fetchProposals();
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown);
});

// ── Helpers ──────────────────────────────────────────────────────────

const currentCount = computed(() => adapter.state.items.length);

async function load() {
  await adapter.loadNextPage();
  keyboardInput.value?.focus();
}

const showProposalsModal = ref(false);
const activeProposals = ref<CategorizationProposalListItem[]>([]);

async function openProposalsModal(): Promise<void> {
  await fetchProposals();
  showProposalsModal.value = true;
}

async function fetchProposals(): Promise<void> {
  try {
    const res = await fetch('/api/proposal', {
      credentials: 'same-origin',
    });
    if (!res.ok) return;
    const body = await res.json();
    if (body.status === 'error') return;
    activeProposals.value = body.result?.proposals ?? [];
  } catch {
    // Silently ignore fetch errors — the modal will show empty state
  }
}

const showCorrectModal = ref(false);

function openCorrectModal(_category?: string) {
  if (adapter.state.currentItem) showCorrectModal.value = true;
}

function onCorrectConfirm(categoryId: string) {
  showCorrectModal.value = false;
  adapter.correct(categoryId);
}

function onCorrectCancel() {
  showCorrectModal.value = false;
}

async function promptProposeRule(): Promise<void> {
  const current = adapter.state.currentItem;
  if (!current) return;
  const merchant = current.evidence.normalizedMerchant;
  const categoryId = current.reviewItem.categoryId;
  if (merchant && categoryId) {
    const result = await adapter.proposeRule(current.reviewItem.id, merchant, categoryId);
    if (result.success) {
      const toast = useToast();
      toast.add({
        title: 'Rule proposal created',
        description: `${merchant} → ${categoryId}`,
        icon: 'i-heroicons-sparkles',
        color: 'success',
        duration: 10000,
        actions: [{
          label: 'Review proposal',
          color: 'neutral',
          onClick: () => { showProposalsModal.value = true; },
        }],
      });
      // Refresh proposals list so count is accurate
      await fetchProposals();
    }
  }
}

async function handleProposalAccepted(_proposalId: string) {
  showProposalsModal.value = false;
  await adapter.refresh();
  await fetchProposals();
}

async function handleProposalDiscarded(_proposalId: string) {
  await fetchProposals();
}

async function handleSignOut() {
  await authClient.signOut();
  await navigateTo('/');
}
</script>
