<template>
  <UContainer class="h-[calc(100dvh-3.5rem)] overflow-hidden flex flex-col py-4">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-4 shrink-0">
      <div class="flex min-w-0 max-w-full flex-wrap items-center gap-3">
        <h1 class="text-xl font-bold">Review Transactions</h1>
        <SavedViewPicker
          :views="savedViews"
          :selected-view-id="selectedViewId"
          :loading="viewsLoading"
          :error="viewsError"
          :show-save="true"
          @select="applyView"
          @create="createView"
          @rename="renameView"
          @update="updateView"
          @duplicate="duplicateView"
          @delete="deleteView"
          @last-used="markViewUsed"
          @retry="loadViews"
        />
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <UBadge v-if="adapter.loading" color="warning" variant="soft" label="Loading…" />
        <UBadge v-else-if="adapter.error" color="error" variant="soft" :label="adapter.error" />
        <UBadge v-else color="neutral" variant="solid" :label="`${currentCount} items`" />
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-heroicons-arrow-path"
          :label="syncing ? 'Syncing...' : 'Sync'"
          :loading="syncing"
          :disabled="syncing"
          @click="handleSync"
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
      <p class="text-gray-500 dark:text-gray-400 text-lg">No items to review.</p>
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
            <ReviewItem :item="adapter.state.currentItem" :state="adapter.state" class="flex-1" />
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
      :submitting="correcting"
      :categories="reviewCategories"
      :categories-loading="categoriesLoading"
      :categories-error="categoriesError"
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
      @error="handleProposalError"
    />
  </UContainer>
</template>

<script setup lang="ts">
interface SavedView {
  viewId: string;
  name: string;
  viewType: string;
  scope: Record<string, unknown>;
  sort?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
}
interface SavedViewEnvelope<T> {
  status: 'ok' | 'error';
  result: T | null;
  error: { code: string; message: string; retryable?: boolean } | null;
}
interface ReviewCategoryOption {
  readonly id: string;
  readonly name: string;
  readonly groupName: string | null;
  readonly isIncome: boolean;
}
const savedViews = ref<SavedView[]>([]);
const selectedViewId = ref('');
const viewsLoading = ref(false);
const viewsError = ref<{ code: string; message: string; retryable?: boolean } | null>(null);
function promptView(message: string, fallback: string) {
  return import.meta.client ? window.prompt(message, fallback)?.trim() || null : fallback;
}
async function loadViews() {
  viewsLoading.value = true;
  viewsError.value = null;
  try {
    const res = await $fetch<SavedViewEnvelope<{ views: SavedView[] }>>('/api/reports/views');
    if (res.status === 'ok' && res.result) savedViews.value = res.result.views;
    else
      viewsError.value = {
        code: res.error?.code ?? 'VIEWS_FAILED',
        message: res.error?.message ?? 'Unable to load saved views.',
        retryable: !!res.error?.retryable,
      };
  } catch (e) {
    viewsError.value = { code: 'FETCH_ERROR', message: String(e), retryable: true };
  } finally {
    viewsLoading.value = false;
  }
}
async function viewAction(
  viewId: string,
  method: 'PATCH' | 'POST' | 'DELETE',
  url = `/api/reports/views/${viewId}`,
  body?: Record<string, unknown>,
) {
  try {
    const res = await $fetch<SavedViewEnvelope<SavedView | { deleted: boolean }>>(url, {
      method,
      body,
    });
    if (res.status !== 'ok' || !res.result)
      throw new Error(res.error?.message ?? 'Saved view action failed.');
    if (method === 'DELETE')
      savedViews.value = savedViews.value.filter((view) => view.viewId !== viewId);
    else if ('viewId' in res.result) {
      const view = res.result as SavedView;
      const index = savedViews.value.findIndex((item) => item.viewId === view.viewId);
      if (index >= 0) savedViews.value[index] = view;
      else savedViews.value.push(view);
      selectedViewId.value = view.viewId;
    }
  } catch (e) {
    viewsError.value = { code: 'VIEW_ACTION_FAILED', message: String(e), retryable: true };
  }
}
function applyView(viewId: string) {
  selectedViewId.value = viewId;
  if (viewId) void viewAction(viewId, 'PATCH', `/api/reports/views/${viewId}/last-used`);
}
function createView() {
  const name = promptView('Name this saved view', 'Review queue');
  if (name)
    void viewAction('', 'POST', '/api/reports/views', {
      name,
      viewType: 'pending_review',
      scope: {},
    });
}
function renameView(viewId: string) {
  const view = savedViews.value.find((item) => item.viewId === viewId);
  const name = promptView('Rename saved view', view?.name ?? '');
  if (name) void viewAction(viewId, 'PATCH', undefined, { name });
}
function updateView(viewId: string) {
  void viewAction(viewId, 'PATCH', undefined, { scope: {} });
}
function duplicateView(viewId: string) {
  const view = savedViews.value.find((item) => item.viewId === viewId);
  const name = promptView('Name duplicated view', `${view?.name ?? 'View'} copy`);
  if (name) void viewAction(viewId, 'POST', `/api/reports/views/${viewId}/duplicate`, { name });
}
function deleteView(viewId: string) {
  if (import.meta.client && !window.confirm('Delete this saved view?')) return;
  void viewAction(viewId, 'DELETE');
}
function markViewUsed(viewId: string) {
  void viewAction(viewId, 'PATCH', `/api/reports/views/${viewId}/last-used`);
}
/**
 * Review transactions page.
 *
 * REQUIRES runtimeConfig.public.apiBase to be configured. When the API
 * backend is absent the page renders a non-operational error state — it
 * NEVER falls back to an in-memory SqliteWorkflowStore or exposes mutation
 * controls without a remote backend.
 */
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
const adapter = apiBase ? useApiReviewController(apiBase) : createUnavailableAdapter();
const actions = useReviewActions(adapter, openCorrectModal);
const reviewCategories = ref<ReviewCategoryOption[]>([]);
const categoriesLoading = ref(false);
const categoriesLoaded = ref(false);
const categoriesError = ref<string | null>(null);
let categoryLoadPromise: Promise<void> | null = null;

// Focus the hidden keyboard input so shortcuts work on page load.
// A document-level keydown listener ensures shortcuts remain active after
// pointer-triggered actions (which would otherwise steal focus from the
// hidden input).
const keyboardInput = ref<HTMLInputElement | null>(null);

// Suppress review shortcuts while either correction/proposals modal is open.
const showCorrectModal = ref(false);
const correcting = ref(false);
const showProposalsModal = ref(false);
const modalOpen = computed(() => showCorrectModal.value || showProposalsModal.value);
const interactiveControlSelector =
  'a, button, input, textarea, select, summary, [contenteditable], [role="button"], [role="link"], [role="menuitem"]';

function handleGlobalKeydown(event: KeyboardEvent) {
  // The hidden input owns review shortcuts. Other editable and interactive
  // controls — including the shared shell navigation — keep normal keyboard behavior.
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.isContentEditable) return;
  if (target !== keyboardInput.value && target.closest(interactiveControlSelector)) return;
  // Suppress review shortcuts while a modal is open (Enter on modal
  // buttons must not approve, C must not re-open correction, etc.)
  if (modalOpen.value) return;

  // Don't steal browser shortcuts (Ctrl+C, Ctrl+A, etc.) — except undo
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== 'z') return;

  actions.handleKeyboard(event);
}
onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown);
  keyboardInput.value?.focus();
  load();
  loadViews();
  fetchProposals();
  void loadReviewCategories();
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown);
});
const syncing = ref(false);

// ── Helpers ──────────────────────────────────────────────────────────

const currentCount = computed(() => adapter.state.items.length);

async function load() {
  await adapter.loadNextPage();
  keyboardInput.value?.focus();
}

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

function loadReviewCategories(): Promise<void> {
  if (categoryLoadPromise) return categoryLoadPromise;
  categoriesLoading.value = true;
  categoriesError.value = null;
  categoryLoadPromise = (async () => {
    try {
      const response = await fetch('/api/review/categories', {
        credentials: 'same-origin',
      });
      const body = (await response.json()) as SavedViewEnvelope<{
        categories: ReviewCategoryOption[];
      }>;
      if (!response.ok || body.status !== 'ok' || !body.result) {
        throw new Error(body.error?.message ?? 'Unable to load Actual categories.');
      }
      reviewCategories.value = body.result.categories;
      categoriesLoaded.value = true;
    } catch (error) {
      categoriesLoaded.value = false;
      categoriesError.value =
        error instanceof Error ? error.message : 'Unable to load Actual categories.';
    } finally {
      categoriesLoading.value = false;
      categoryLoadPromise = null;
    }
  })();
  return categoryLoadPromise;
}

function openCorrectModal(_category?: string) {
  if (!adapter.state.currentItem) return;
  showCorrectModal.value = true;
  if (!categoriesLoaded.value && !categoriesLoading.value) void loadReviewCategories();
}

function onCorrectCancel() {
  if (correcting.value) return;
  showCorrectModal.value = false;
}

async function onCorrectConfirm(categoryId: string): Promise<void> {
  if (correcting.value) return;
  correcting.value = true;
  try {
    const result = await adapter.correct(categoryId);
    if (result?.success) {
      showCorrectModal.value = false;
      await nextTick();
      keyboardInput.value?.focus();
    }
  } finally {
    correcting.value = false;
  }
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
        actions: [
          {
            label: 'Review proposal',
            color: 'neutral',
            onClick: () => {
              showProposalsModal.value = true;
            },
          },
        ],
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

function handleProposalError(message: string, retryable: boolean): void {
  const toast = useToast();
  toast.add({
    title: 'Rule activation failed',
    description: retryable ? `${message} Try again after fixing the connection.` : message,
    color: 'error',
    duration: 10000,
  });
}

async function handleSync() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const res = await fetch('/api/review/sync', { method: 'POST', credentials: 'same-origin' });
    const data = await res.json();
    if (data.status === 'ok') {
      const toast = useToast();
      toast.add({ title: 'Sync complete', color: 'success', duration: 5000 });
      await adapter.refresh();
      const pendingCategoryLoad = categoryLoadPromise;
      if (pendingCategoryLoad) await pendingCategoryLoad;
      await loadReviewCategories();
    } else {
      const toast = useToast();
      const error = data.error;
      toast.add({
        title: 'Sync failed',
        description: error?.message ?? 'Unknown error',
        color: 'error',
        duration: 10000,
        ...(error?.code === 'not_connected'
          ? {
              actions: [
                {
                  label: 'Configure connection',
                  onClick: () => navigateTo('/connection'),
                },
              ],
            }
          : {}),
      });
    }
  } catch (e) {
    const toast = useToast();
    toast.add({
      title: 'Sync failed',
      description: e instanceof Error ? e.message : 'Connection error',
      color: 'error',
      duration: 10000,
    });
  } finally {
    syncing.value = false;
  }
}
</script>
