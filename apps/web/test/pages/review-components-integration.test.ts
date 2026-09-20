import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { ReviewQueueItem, ReviewStatus } from '../../src/review';
import ReviewPage from '../../app/pages/review.vue';
import ReviewQueue from '../../app/components/ReviewQueue.vue';
import ReviewItem from '../../app/components/ReviewItem.vue';
import ReviewActions from '../../app/components/ReviewActions.vue';
import CategoryCorrectModal from '../../app/components/CategoryCorrectModal.vue';

const stubs = {
  UContainer: { template: '<main><slot /></main>' },
  UCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
  UButton: {
    props: ['label', 'disabled'],
    template: '<button type="button" :disabled="disabled"><slot />{{ label }}</button>',
  },
  UBadge: { props: ['label'], template: '<span><slot />{{ label }}</span>' },
  UButtonGroup: { template: '<div><slot /></div>' },
  USeparator: true,
  UAlert: {
    props: ['title', 'description'],
    template: '<aside role="alert">{{ title }} {{ description }}<slot name="trailing" /></aside>',
  },
  UModal: {
    props: ['open'],
    template: '<div v-if="open" role="dialog"><slot name="content" /></div>',
  },
  USelectMenu: {
    props: ['modelValue', 'items', 'disabled'],
    emits: ['update:modelValue'],
    template: `<select aria-label="Category" :value="modelValue" :disabled="disabled" @change="$emit('update:modelValue', $event.target.value)"><option value="">Choose category</option><option v-for="item in items" :key="item.id" :value="item.id">{{ item.label }}</option></select>`,
  },
  SavedViewPicker: true,
  ReviewMetrics: true,
  ProposedRulesModal: true,
};

function item(
  id: string,
  merchant: string,
  status: ReviewStatus = 'pending_review',
): ReviewQueueItem {
  return {
    reviewItem: {
      id,
      suggestionId: null,
      budgetId: 'budget-test',
      transactionId: `tx-${id}`,
      categoryId: 'cat-groceries',
      classifier: 'test-classifier',
      promptVersion: 'v1',
      transactionVersion: 1,
      status,
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
      originalImportedName: `CARD ${merchant}`,
      normalizedMerchant: merchant,
      account: 'Checking',
      amount: -42.75,
      currentCategory: 'cat-unassigned',
      suggestedCategory: 'cat-groceries',
      alternatives: ['cat-dining'],
      history: [],
      ruleCandidates: [],
      provenance: 'test',
      freshness: null,
      changePreview: {
        fromCategory: 'cat-unassigned',
        toCategory: 'cat-groceries',
        affectsEnvelope: true,
      },
      correlationId: null,
      promptVersion: 'v1',
      categoryNames: {
        'cat-groceries': 'Groceries',
        'cat-dining': 'Dining',
        'cat-unassigned': 'Unassigned',
      },
    },
    homogeneity: {
      homogeneous: true,
      commonStatus: status,
      commonCategory: 'cat-groceries',
      commonClassifier: 'test-classifier',
      groupSize: 1,
      conflictReason: null,
    },
    actionable: status === 'pending_review',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function response(result: unknown) {
  return new Response(JSON.stringify({ status: 'ok', result, error: null }), { status: 200 });
}

function failure(message: string) {
  return new Response(
    JSON.stringify({
      status: 'error',
      result: null,
      error: { code: 'conflict', message, retryable: true },
    }),
    { status: 200 },
  );
}

const fetchMock = vi.fn<typeof fetch>();
const toast = vi.fn();
const pages: VueWrapper[] = [];
let stored: ReviewQueueItem[];
let total: number;

function button(page: VueWrapper, label: string) {
  const control = page.findAll('button').find((candidate) => candidate.text() === label);
  if (!control) throw new Error(`Missing button: ${label}`);
  return control;
}

function queueRow(page: VueWrapper, merchant: string) {
  const control = page
    .findComponent(ReviewQueue)
    .findAll('button')
    .find((candidate) => candidate.text().includes(merchant));
  if (!control) throw new Error(`Missing queue merchant: ${merchant}`);
  return control;
}

function mountPage() {
  const page = mount(ReviewPage, {
    attachTo: document.body,
    global: { components: { ReviewQueue, ReviewItem, ReviewActions, CategoryCorrectModal }, stubs },
  });
  pages.push(page);
  return page;
}

function mutations() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
}

beforeEach(() => {
  stored = [item('grocer', 'Corner Grocer'), item('cafe', 'Morning Cafe')];
  total = stored.length;
  fetchMock.mockReset();
  toast.mockReset();
  fetchMock.mockImplementation(async (input, options) => {
    const url = new URL(String(input), 'https://review.test').pathname;
    if (url === '/api/review') return response({ items: stored, total });
    if (url === '/api/proposal') return response({ proposals: [] });
    if (url === '/api/review/categories')
      return response({
        categories: [
          { id: 'cat-groceries', name: 'Groceries', groupName: 'Essentials', isIncome: false },
          { id: 'cat-fuel', name: 'Fuel', groupName: 'Transport', isIncome: false },
        ],
      });
    const body = JSON.parse(String(options?.body ?? '{}')) as {
      reviewId: string;
      categoryId?: string;
    };
    if (url === '/api/review/correct') {
      stored = stored.map((entry): ReviewQueueItem =>
        entry.reviewItem.id !== body.reviewId
          ? entry
          : {
              ...entry,
              reviewItem: {
                ...entry.reviewItem,
                categoryId: body.categoryId!,
                status: 'correcting',
              },
              evidence: {
                ...entry.evidence,
                suggestedCategory: body.categoryId!,
                categoryNames: { ...entry.evidence.categoryNames, 'cat-fuel': 'Fuel' },
                changePreview: { ...entry.evidence.changePreview, toCategory: body.categoryId! },
              },
            },
      );
      return response({ itemId: body.reviewId, success: true, error: null });
    }
    if (['/api/review/approve', '/api/review/reject', '/api/review/skip'].includes(url)) {
      stored = stored.filter((entry) => entry.reviewItem.id !== body.reviewId);
      total = stored.length;
      return response({ itemId: body.reviewId, success: true, error: null });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    '$fetch',
    vi.fn().mockResolvedValue({ status: 'ok', result: { views: [] }, error: null }),
  );
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('nextTick', nextTick);
  vi.stubGlobal('onMounted', onMounted);
  vi.stubGlobal('onUnmounted', onUnmounted);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://review.test' } }));
  vi.stubGlobal('useToast', () => ({ add: toast }));
  vi.stubGlobal('navigateTo', vi.fn());
});

afterEach(() => {
  for (const page of pages.splice(0)) {
    const element = page.element;
    page.unmount();
    element.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real review queue, evidence and actions', () => {
  it('distinguishes navigation from shift selection and hides bulk actions when selection is cleared', async () => {
    const page = mountPage();
    await flushPromises();
    await queueRow(page, 'Morning Cafe').trigger('click', { shiftKey: true });
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Corner Grocer');
    expect(queueRow(page, 'Corner Grocer').attributes('aria-current')).toBe('true');
    expect(button(page, 'Bulk approve').exists()).toBe(true);
    await queueRow(page, 'Morning Cafe').trigger('click', { shiftKey: true });
    expect(page.findComponent(ReviewActions).text()).not.toContain('Bulk approve');
    await queueRow(page, 'Corner Grocer').trigger('click', { shiftKey: true });
    await queueRow(page, 'Morning Cafe').trigger('click');
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Morning Cafe');
    expect(queueRow(page, 'Morning Cafe').attributes('aria-current')).toBe('true');
    expect(page.findComponent(ReviewActions).text()).not.toContain('Bulk approve');
    expect(mutations()).toEqual([]);
  });

  it('locks mutation controls during approval and keeps a rejected approval retryable without removing the item', async () => {
    const page = mountPage();
    await flushPromises();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await button(page, 'Approve').trigger('click');
    for (const label of ['Approve', 'Reject', 'Skip', 'Edit', 'Undo', 'Refresh']) {
      expect(button(page, label).attributes('disabled')).toBeDefined();
    }
    await button(page, 'Approve').trigger('click');
    expect(mutations().map(([url]) => String(url))).toEqual([
      'https://review.test/api/review/approve',
    ]);
    pending.resolve(failure('Transaction changed; refresh before approving'));
    await flushPromises();
    expect(page.text()).toContain('Transaction changed; refresh before approving');
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Corner Grocer');
    expect(button(page, 'Approve').attributes('disabled')).toBeUndefined();
    await button(page, 'Approve').trigger('click');
    await flushPromises();
    expect(page.findComponent(ReviewQueue).text()).not.toContain('Corner Grocer');
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Morning Cafe');
  });

  it('skips the selected transaction through the visible action and advances the queue', async () => {
    const page = mountPage();
    await flushPromises();
    await button(page, 'Skip').trigger('click');
    await flushPromises();
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Morning Cafe');
    expect(page.findComponent(ReviewQueue).text()).not.toContain('Corner Grocer');
  });

  it('rejects the final transaction into the empty state without retaining approval controls', async () => {
    stored = [stored[0]!];
    total = 1;
    const page = mountPage();
    await flushPromises();
    await button(page, 'Reject').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('No items to review');
    expect(page.findComponent(ReviewActions).exists()).toBe(false);
    expect(page.findComponent(ReviewItem).exists()).toBe(false);
  });

  it('opens real correction options, cancels without mutation, then preserves a rejected choice for retry', async () => {
    const page = mountPage();
    await flushPromises();
    await button(page, 'Edit').trigger('click');
    const category = page.get('select[aria-label="Category"]');
    expect(
      category.findAll('option').filter((option) => option.attributes('value') === 'cat-groceries'),
    ).toHaveLength(1);
    expect(
      category
        .findAll('option')
        .find((option) => option.attributes('value') === 'cat-fuel')!
        .text(),
    ).toContain('Transport');
    await category.setValue('cat-fuel');
    await button(page, 'Cancel').trigger('click');
    expect(page.find('[role="dialog"]').exists()).toBe(false);
    expect(mutations()).toEqual([]);
    await button(page, 'Edit').trigger('click');
    expect((page.get('select').element as HTMLSelectElement).value).toBe('cat-groceries');
    await page.get('select').setValue('cat-fuel');
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await button(page, 'Confirm').trigger('click');
    expect(button(page, 'Confirm').attributes('disabled')).toBeDefined();
    expect(button(page, 'Cancel').attributes('disabled')).toBeDefined();
    await button(page, 'Cancel').trigger('click');
    expect(page.find('[role="dialog"]').exists()).toBe(true);
    pending.resolve(failure('Category is temporarily unavailable'));
    await flushPromises();
    expect(page.text()).toContain('Category is temporarily unavailable');
    expect(page.find('[role="dialog"]').exists()).toBe(true);
    expect((page.get('select').element as HTMLSelectElement).value).toBe('cat-fuel');
    await button(page, 'Confirm').trigger('click');
    await flushPromises();
    expect(page.find('[role="dialog"]').exists()).toBe(false);
    expect(page.findComponent(ReviewItem).text()).toContain('Edited');
    expect(page.findComponent(ReviewItem).text()).toContain('Fuel');
    expect(page.findComponent(ReviewQueue).text()).toContain('Corner Grocer');
  });

  it('shows loading without an empty claim, recovers a list error and loads remaining queue items', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const page = mountPage();
    await nextTick();
    expect(page.text()).toContain('Loading');
    expect(page.text()).not.toContain('No items to review');
    pending.resolve(failure('Review service unavailable'));
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('Review service unavailable');
    total = 3;
    await button(page, 'Retry').trigger('click');
    await flushPromises();
    expect(page.find('[role="alert"]').exists()).toBe(false);
    stored.push(item('fuel', 'Fuel Station'));
    await button(page, 'Load more').trigger('click');
    await flushPromises();
    expect(queueRow(page, 'Fuel Station').exists()).toBe(true);
    expect(page.findComponent(ReviewQueue).text()).not.toContain('Load more');
  });

  it('renders decision evidence with resolved category names, expiry, history and rule consistency', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-01T00:00:00.000Z'));
    stored[0] = {
      ...stored[0]!,
      evidence: {
        ...stored[0]!.evidence,
        correlationId: 'trace-review',
        freshness: '2026-05-31T00:00:00.000Z',
        alternatives: ['cat-dining', 'cat-unmapped'],
        history: [
          { categoryId: 'cat-groceries', count: 3, lastClassified: '2026-05-30T00:00:00.000Z' },
        ],
        ruleCandidates: [
          {
            merchant: 'Corner Grocer',
            currentCategory: 'cat-groceries',
            matchCount: 3,
            consistency: 0.876,
          },
          {
            merchant: 'Corner Grocer',
            currentCategory: 'cat-dining',
            matchCount: 1,
            consistency: 1,
          },
        ],
      },
    };
    stored[1] = {
      ...stored[1]!,
      evidence: {
        ...stored[1]!.evidence,
        freshness: '2026-06-02T00:00:00.000Z',
        changePreview: {
          fromCategory: 'cat-groceries',
          toCategory: 'cat-groceries',
          affectsEnvelope: false,
        },
        alternatives: [],
      },
    };
    const page = mountPage();
    await flushPromises();
    const detail = page.findComponent(ReviewItem);
    expect(detail.text()).toContain('-$42.75');
    expect(detail.text()).toContain('Stale since');
    expect(detail.text()).toContain('Unassigned');
    expect(detail.text()).toContain('Groceries');
    expect(detail.text()).toContain('cat-unmapped');
    expect(detail.text()).toContain('3x');
    expect(detail.text()).toMatch(/3 matches\s*·\s*88% consistent/);
    expect(detail.text()).toMatch(/1 match\s*·\s*100% consistent/);
    expect(button(page, 'Create rule').exists()).toBe(true);
    await queueRow(page, 'Morning Cafe').trigger('click');
    expect(detail.text()).toContain('Fresh until');
    expect(detail.text()).not.toContain('Stale since');
    expect(detail.text()).not.toContain('Alternatives');
    expect(detail.text()).not.toContain('Prior classifications');
    expect(detail.text()).not.toContain('From');
    expect(page.findComponent(ReviewActions).text()).not.toContain('Create rule');
  });

  it('distinguishes an approved proposal from verified application and failed recovery', async () => {
    stored = [
      item('approved', 'Approved Grocer', 'approved'),
      item('applied', 'Applied Grocer', 'applied'),
      item('failed', 'Failed Grocer', 'apply_failed'),
    ];
    total = 3;
    const page = mountPage();
    await flushPromises();
    expect(page.findComponent(ReviewItem).text()).not.toContain('Verified applied');
    await queueRow(page, 'Applied Grocer').trigger('click');
    expect(page.findComponent(ReviewItem).text()).toContain('Verified applied');
    await queueRow(page, 'Failed Grocer').trigger('click');
    expect(page.findComponent(ReviewItem).text()).toContain('Failed');
    expect(page.findComponent(ReviewItem).text()).not.toContain('Verified applied');
  });
});

describe('review action availability', () => {
  it('rejects item actions without a current transaction and prevents bulk mutations while loading', async () => {
    const actions = mount(ReviewActions, {
      props: {
        hasCurrent: false,
        hasSelection: false,
        loading: false,
        metrics: null,
        hasRuleCandidates: true,
        proposalCount: 2,
      },
      global: { stubs },
    });
    pages.push(actions);
    for (const label of ['Approve', 'Reject', 'Skip', 'Edit', 'Create rule']) {
      expect(button(actions, label).attributes('disabled')).toBeDefined();
      await button(actions, label).trigger('click');
    }
    for (const event of ['approve', 'reject', 'skip', 'correct', 'propose-rule']) {
      expect(actions.emitted(event)).toBeUndefined();
    }
    expect(button(actions, 'Refresh').attributes('disabled')).toBeUndefined();
    await actions.setProps({ hasCurrent: true, hasSelection: true, loading: true });
    for (const label of [
      'Bulk approve',
      'Bulk reject',
      'Bulk skip',
      'Proposed rules (2)',
      'Refresh',
      'Undo',
    ]) {
      expect(button(actions, label).attributes('disabled')).toBeDefined();
      await button(actions, label).trigger('click');
    }
    for (const event of [
      'bulk-approve',
      'bulk-reject',
      'bulk-skip',
      'show-proposals',
      'refresh',
      'undo',
    ]) {
      expect(actions.emitted(event)).toBeUndefined();
    }
    await actions.setProps({ loading: false, hasRuleCandidates: false, proposalCount: 0 });
    expect(button(actions, 'Approve').attributes('disabled')).toBeUndefined();
    expect(button(actions, 'Bulk approve').attributes('disabled')).toBeUndefined();
    expect(actions.text()).not.toContain('Create rule');
    expect(actions.text()).not.toContain('Proposed rules');
  });
});
