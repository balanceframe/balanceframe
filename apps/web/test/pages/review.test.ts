import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import {
  computed,
  nextTick,
  onBeforeMount,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  readonly,
  ref,
  shallowRef,
  watch,
} from 'vue';
import type {
  ReviewMetricsSnapshot,
  ReviewQueueItem,
  ReviewSurfaceState,
} from '../../src/review';
import type {
  ReviewControllerAdapter,
  WebActionResult,
  WebBulkActionResult,
} from '../../types/review-client';
import ReviewPage from '../../app/pages/review.vue';

interface ToastAction {
  readonly label: string;
  readonly color?: string;
  onClick: () => void | Promise<void>;
}

interface ToastMessage {
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly color: string;
  readonly duration: number;
  readonly actions?: readonly ToastAction[];
}

interface SyncError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

const composableDoubles = vi.hoisted(() => ({
  adapter: undefined as unknown as ReviewControllerAdapter,
  handleKeyboard: vi.fn<(event: KeyboardEvent) => boolean>(),
}));

vi.mock('../../composables/useApiReviewController', () => ({
  useApiReviewController: () => composableDoubles.adapter,
}));

vi.mock('../../composables/useReviewActions', () => ({
  useReviewActions: () => ({
    handleKeyboard: composableDoubles.handleKeyboard,
  }),
}));

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ value: { data: { user: { email: 'review@test.dev' } } } }),
    signOut: vi.fn(),
  },
}));

const correctSpy = vi.fn<(categoryId: string) => Promise<WebActionResult>>();
const dollarFetchSpy = vi.fn<(url: string, options?: Record<string, unknown>) => Promise<unknown>>();
const fetchSpy = vi.fn<typeof fetch>();
const navigateToSpy = vi.fn<(path: string) => Promise<void>>();
const toastAddSpy = vi.fn<(message: ToastMessage) => void>();

const METRICS: ReviewMetricsSnapshot = {
  medianReviewTimeMs: 0,
  interactionsPerAction: 0,
  acceptanceRate: 0,
  correctionRate: 0,
  rejectionRate: 0,
  backlogCount: 1,
  backlogMaxAgeMs: 0,
  backlogMeanAgeMs: 0,
  coverage: 0,
  interactionLatencyMs: 0,
  recurrenceCount: 0,
  duplicatesAvoided: 0,
  createdCount: 0,
  resolvedCount: 0,
};

const CURRENT_ITEM: ReviewQueueItem = {
  reviewItem: {
    id: 'review-001',
    suggestionId: null,
    budgetId: 'budget-001',
    transactionId: 'transaction-001',
    categoryId: 'cat-groceries',
    classifier: 'test-classifier',
    promptVersion: 'test-v1',
    transactionVersion: 1,
    status: 'pending_review',
    correlationId: null,
    assignedReviewerId: null,
    approvedBy: [],
    reviewersRequired: 1,
    priority: 0,
    evidence: {},
    provenance: 'test',
    supersededBy: null,
    supersededReason: null,
    freshnessExpiresAt: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  evidence: {
    originalImportedName: 'Test Grocer',
    normalizedMerchant: 'Test Grocer',
    account: 'Checking',
    amount: 1250,
    currentCategory: 'cat-uncategorized',
    suggestedCategory: 'cat-groceries',
    alternatives: ['cat-dining'],
    history: [],
    ruleCandidates: [],
    provenance: 'test',
    freshness: null,
    changePreview: {
      fromCategory: 'cat-uncategorized',
      toCategory: 'cat-groceries',
      affectsEnvelope: true,
    },
    correlationId: null,
    categoryNames: {
      'cat-dining': 'Dining',
      'cat-groceries': 'Groceries',
    },
    promptVersion: 'test-v1',
  },
  homogeneity: {
    homogeneous: true,
    commonStatus: 'pending_review',
    commonCategory: 'cat-groceries',
    commonClassifier: 'test-classifier',
    groupSize: 1,
    conflictReason: null,
  },
  actionable: true,
};

function successfulAction(): WebActionResult {
  return { itemId: CURRENT_ITEM.reviewItem.id, success: true, error: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function createAdapter(): ReviewControllerAdapter {
  const state: ReviewSurfaceState = {
    items: [CURRENT_ITEM],
    currentIndex: 0,
    currentItem: CURRENT_ITEM,
    selectedIndices: [],
    selectionHomogeneity: CURRENT_ITEM.homogeneity,
    metrics: METRICS,
    hasMore: false,
    loading: false,
    error: null,
  };
  const emptyBulkResult: WebBulkActionResult = {
    results: [],
    consumedCount: 0,
    errorCount: 0,
  };

  return {
    state,
    loading: false,
    error: null,
    loadNextPage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    approve: vi.fn<() => Promise<WebActionResult>>().mockResolvedValue(successfulAction()),
    correct: correctSpy,
    reject: vi.fn<() => Promise<WebActionResult>>().mockResolvedValue(successfulAction()),
    skip: vi.fn<() => Promise<WebActionResult>>().mockResolvedValue(successfulAction()),
    undo: vi.fn<() => Promise<WebActionResult>>().mockResolvedValue(successfulAction()),
    proposeRule: vi.fn<(reviewId: string, merchant: string, categoryId: string) => Promise<WebActionResult>>().mockResolvedValue(successfulAction()),
    bulkApprove: vi.fn<() => Promise<WebBulkActionResult>>().mockResolvedValue(emptyBulkResult),
    bulkCorrect: vi.fn<(categoryId: string) => Promise<WebBulkActionResult>>().mockResolvedValue(emptyBulkResult),
    bulkReject: vi.fn<() => Promise<WebBulkActionResult>>().mockResolvedValue(emptyBulkResult),
    bulkSkip: vi.fn<() => Promise<WebBulkActionResult>>().mockResolvedValue(emptyBulkResult),
    selectNext: vi.fn<() => void>(),
    selectPrevious: vi.fn<() => void>(),
    selectIndex: vi.fn<(index: number) => void>(),
    toggleSelection: vi.fn<(index: number) => void>(),
    clearSelection: vi.fn<() => void>(),
    resetMetrics: vi.fn<() => void>(),
    setError: vi.fn<(code: string, message: string, retryable?: boolean) => void>(),
    clearError: vi.fn<() => void>(),
  } satisfies ReviewControllerAdapter;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

const stubs = {
  UContainer: { name: 'UContainer', template: '<section><slot /></section>' },
  UButton: {
    name: 'UButton',
    props: ['label', 'loading', 'disabled'],
    emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot />{{ label }}</button>',
  },
  UBadge: {
    name: 'UBadge',
    props: ['label'],
    template: '<span><slot />{{ label }}</span>',
  },
  UAlert: {
    name: 'UAlert',
    props: ['title', 'description'],
    template: '<aside><strong>{{ title }}</strong><span>{{ description }}</span><slot name="trailing" /></aside>',
  },
  UCard: {
    name: 'UCard',
    template: '<section><slot name="header" /><slot /></section>',
  },
  SavedViewPicker: {
    name: 'SavedViewPicker',
    props: ['views', 'selectedViewId', 'loading', 'error', 'showSave'],
    emits: ['select', 'create', 'rename', 'update', 'duplicate', 'delete', 'last-used', 'retry'],
    template: '<div data-testid="saved-view-picker" />',
  },
  ReviewQueue: {
    name: 'ReviewQueue',
    props: ['items', 'currentIndex', 'selectedIndices', 'hasMore'],
    emits: ['navigate', 'toggle-selection', 'load-more'],
    template: '<nav data-testid="review-queue" />',
  },
  ReviewItem: {
    name: 'ReviewItem',
    props: ['item', 'state'],
    template: '<article data-testid="review-item" />',
  },
  ReviewMetrics: {
    name: 'ReviewMetrics',
    props: ['metrics'],
    template: '<section data-testid="review-metrics" />',
  },
  ReviewActions: {
    name: 'ReviewActions',
    props: ['hasCurrent', 'hasSelection', 'loading', 'metrics', 'hasRuleCandidates', 'proposalCount'],
    emits: ['correct', 'propose-rule', 'approve', 'reject', 'refresh', 'undo', 'bulk-approve', 'bulk-reject', 'bulk-skip', 'show-proposals', 'reset-metrics'],
    template: `
      <div>
        <button type="button" data-testid="open-correction" @click="$emit('correct')">Correct</button>
        <button type="button" data-testid="open-proposals" @click="$emit('show-proposals')">Proposals</button>
      </div>
    `,
  },
  CategoryCorrectModal: {
    name: 'CategoryCorrectModal',
    props: ['open', 'item', 'submitting'],
    emits: ['confirm', 'cancel'],
    setup(props: { open: boolean }) {
      const modalButton = ref<HTMLButtonElement | null>(null);
      watch(() => props.open, async (open) => {
        if (open) {
          await nextTick();
          modalButton.value?.focus();
        }
      });
      return { modalButton };
    },
    template: `
      <div v-if="open" role="dialog" aria-label="Correct category">
        <button ref="modalButton" type="button" data-testid="correction-modal-focus">Choose category</button>
      </div>
    `,
  },
  ProposedRulesModal: {
    name: 'ProposedRulesModal',
    props: ['open', 'proposals'],
    emits: ['close', 'accepted', 'discarded', 'error'],
    template: '<div v-if="open" role="dialog" aria-label="Proposed rules" />',
  },
};


const mountedWrappers: VueWrapper[] = [];
let syncError: SyncError;

function installGlobals(): void {
  vi.stubGlobal('$fetch', dollarFetchSpy);
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://api.test' } }));
  vi.stubGlobal('useToast', () => ({ add: toastAddSpy }));
  vi.stubGlobal('navigateTo', navigateToSpy);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('onMounted', onMounted);
  vi.stubGlobal('onUnmounted', onUnmounted);
  vi.stubGlobal('onBeforeMount', onBeforeMount);
  vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('nextTick', nextTick);
  vi.stubGlobal('shallowRef', shallowRef);
  vi.stubGlobal('readonly', readonly);
}

async function mountPage(): Promise<VueWrapper> {
  const page = shallowMount(ReviewPage as never, {
    attachTo: document.body,
    global: { stubs },
  }) as VueWrapper;
  mountedWrappers.push(page);
  await flushPromises();
  return page;
}


function correctionModal(page: VueWrapper): VueWrapper {
  const modal = page.findComponent({ name: 'CategoryCorrectModal' });
  if (!modal.exists()) throw new Error('Category correction modal stub was not rendered.');
  return modal;
}

function proposedRulesModal(page: VueWrapper): VueWrapper {
  const modal = page.findComponent({ name: 'ProposedRulesModal' });
  if (!modal.exists()) throw new Error('Proposed rules modal stub was not rendered.');
  return modal;
}

function syncButton(page: VueWrapper) {
  const button = page.findAll('button').find((candidate) => candidate.text() === 'Sync');
  if (!button) throw new Error('Sync button was not rendered.');
  return button;
}
function hiddenKeyboardInput(page: VueWrapper): HTMLInputElement {
  return page.get('input[aria-hidden="true"]').element as HTMLInputElement;
}

function dispatchShortcutFromKeyboardInput(page: VueWrapper): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, key: 'c' });
  hiddenKeyboardInput(page).dispatchEvent(event);
  return event;
}


describe('review page recovery behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composableDoubles.adapter = createAdapter();
    composableDoubles.handleKeyboard.mockReturnValue(false);
    correctSpy.mockResolvedValue(successfulAction());
    dollarFetchSpy.mockResolvedValue({ status: 'ok', result: { views: [] }, error: null });
    navigateToSpy.mockResolvedValue(undefined);
    syncError = {
      code: 'not_connected',
      message: 'No ledger connected. Configure an Actual budget first.',
      retryable: true,
    };
    fetchSpy.mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === '/api/review/sync') {
        return jsonResponse({ status: 'error', result: null, error: syncError });
      }
      if (url === '/api/proposal') {
        return jsonResponse({ status: 'ok', result: { proposals: [] }, error: null });
      }
      throw new Error(`Unexpected native fetch request: ${url}`);
    });
    installGlobals();
  });

  afterEach(() => {
    const pages = mountedWrappers.splice(0);
    let cleanupError: unknown;

    for (const page of pages) {
      const element = page.element;
      try {
        page.unmount();
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        element.remove();
      } catch (error) {
        cleanupError ??= error;
      }
    }


    if (cleanupError) throw cleanupError;
  });

  it('routes shortcuts from the focused hidden keyboard input when no modal is open', async () => {
    const page = await mountPage();
    const keyboardInput = hiddenKeyboardInput(page);
    keyboardInput.focus();
    expect(document.activeElement).toBe(keyboardInput);

    const event = dispatchShortcutFromKeyboardInput(page);

    expect(composableDoubles.handleKeyboard).toHaveBeenCalledOnce();
    expect(composableDoubles.handleKeyboard).toHaveBeenCalledWith(event);
  });

  it('suppresses shortcuts dispatched from the hidden keyboard input while the correction modal is open', async () => {
    const page = await mountPage();

    await page.get('[data-testid="open-correction"]').trigger('click');
    await nextTick();
    expect(correctionModal(page).props('open')).toBe(true);

    dispatchShortcutFromKeyboardInput(page);
    expect(composableDoubles.handleKeyboard).not.toHaveBeenCalled();
  });

  it('suppresses shortcuts dispatched from the hidden keyboard input while the proposed-rules modal is open', async () => {
    const page = await mountPage();

    await page.get('[data-testid="open-proposals"]').trigger('click');
    await flushPromises();
    expect(proposedRulesModal(page).props('open')).toBe(true);

    dispatchShortcutFromKeyboardInput(page);
    expect(composableDoubles.handleKeyboard).not.toHaveBeenCalled();
  });

  it('closes a successful correction and restores hidden keyboard focus', async () => {
    const page = await mountPage();

    await page.get('[data-testid="open-correction"]').trigger('click');
    await nextTick();
    const modal = correctionModal(page);
    const modalFocusControl = page.get('[data-testid="correction-modal-focus"]');
    modalFocusControl.element.focus();
    expect(document.activeElement).toBe(modalFocusControl.element);

    modal.vm.$emit('confirm', 'cat-dining');
    await flushPromises();
    await nextTick();

    expect(correctSpy).toHaveBeenCalledOnce();
    expect(correctSpy).toHaveBeenCalledWith('cat-dining');
    expect(modal.props('open')).toBe(false);
    expect(document.activeElement).toBe(page.get('input[aria-hidden="true"]').element);
  });

  it('submits a correction once while pending, then closes, resets, and restores focus on success', async () => {
    const correction = createDeferred<WebActionResult>();
    correctSpy.mockReturnValueOnce(correction.promise);
    const page = await mountPage();

    await page.get('[data-testid="open-correction"]').trigger('click');
    await nextTick();
    const modal = correctionModal(page);
    const modalFocusControl = page.get('[data-testid="correction-modal-focus"]');
    modalFocusControl.element.focus();

    modal.vm.$emit('confirm', 'cat-dining');
    modal.vm.$emit('confirm', 'cat-dining');
    await nextTick();

    expect(correctSpy).toHaveBeenCalledOnce();
    expect(correctSpy).toHaveBeenCalledWith('cat-dining');
    expect(modal.props('submitting')).toBe(true);
    expect(modal.props('open')).toBe(true);

    correction.resolve(successfulAction());
    await flushPromises();
    await nextTick();

    expect(modal.props('open')).toBe(false);
    expect(modal.props('submitting')).toBe(false);
    expect(document.activeElement).toBe(page.get('input[aria-hidden="true"]').element);
  });

  it('keeps the correction modal open and resets submission when correction fails', async () => {
    correctSpy.mockResolvedValue({ itemId: CURRENT_ITEM.reviewItem.id, success: false, error: 'Category rejected' });
    const page = await mountPage();

    await page.get('[data-testid="open-correction"]').trigger('click');
    await nextTick();
    const modal = correctionModal(page);

    modal.vm.$emit('confirm', 'cat-dining');
    await flushPromises();
    await nextTick();

    expect(correctSpy).toHaveBeenCalledOnce();
    expect(correctSpy).toHaveBeenCalledWith('cat-dining');
    expect(modal.props('open')).toBe(true);
    expect(modal.props('submitting')).toBe(false);
  });

  it('offers connection setup for the canonical not_connected Sync failure', async () => {
    const page = await mountPage();

    await syncButton(page).trigger('click');
    await flushPromises();

    expect(toastAddSpy).toHaveBeenCalledOnce();
    const toast = toastAddSpy.mock.calls[0]?.[0];
    if (!toast) throw new Error('Sync failure did not create a toast.');
    expect(toast).toMatchObject({
      title: 'Sync failed',
      description: 'No ledger connected. Configure an Actual budget first.',
      color: 'error',
    });
    expect(toast.actions).toHaveLength(1);
    const connectionAction = toast.actions?.[0];
    if (!connectionAction) throw new Error('not_connected Sync toast did not include a connection action.');
    expect(connectionAction.label).toBe('Configure connection');

    await connectionAction.onClick();
    expect(navigateToSpy).toHaveBeenCalledOnce();
    expect(navigateToSpy).toHaveBeenCalledWith('/connection');
  });

  it('does not offer connection setup for other Sync failures', async () => {
    syncError = {
      code: 'sync_failed',
      message: 'The ledger rejected this Sync.',
      retryable: true,
    };
    const page = await mountPage();

    await syncButton(page).trigger('click');
    await flushPromises();

    expect(toastAddSpy).toHaveBeenCalledOnce();
    const toast = toastAddSpy.mock.calls[0]?.[0];
    if (!toast) throw new Error('Sync failure did not create a toast.');
    expect(toast.actions).toBeUndefined();
    expect(navigateToSpy).not.toHaveBeenCalled();
  });
});
