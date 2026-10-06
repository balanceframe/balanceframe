import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { Ref } from 'vue';
import type { ReviewQueueItem, ReviewStatus } from '../../src/review';
import type { ProposalApprovalView } from '../../server/utils/proposal-approval-view';
import ReviewPage from '../../app/pages/review.vue';
import ReviewQueue from '../../app/components/ReviewQueue.vue';
import ReviewItem from '../../app/components/ReviewItem.vue';
import ReviewActions from '../../app/components/ReviewActions.vue';
import CategoryCorrectModal from '../../app/components/CategoryCorrectModal.vue';
import ProposedRulesModal from '../../app/components/ProposedRulesModal.vue';

const auth = vi.hoisted(() => ({
  session: undefined as unknown as Ref<{ data: { user: { id: string; email: string } } | null }>,
}));
vi.mock('../../lib/auth-client', () => ({
  authClient: { useSession: () => auth.session },
}));
auth.session = ref({ data: { user: { id: 'owner-1', email: 'owner@example.test' } } });
const stubs = {
  UContainer: { template: '<main><slot /></main>' },
  UCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
  UButton: {
    props: ['label', 'disabled'],
    template: '<button type="button" :disabled="disabled"><slot />{{ label }}</button>',
  },
  UBadge: { props: ['label'], template: '<span><slot />{{ label }}</span>' },
  UFieldGroup: { template: '<div><slot /></div>' },
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
      money: { minorUnits: '-4275', currency: 'USD' },
      currency: 'USD',
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

function approvalProposal(reviewId: string, categoryId: string): ProposalApprovalView {
  return {
    id: `proposal-${reviewId}`,
    operation: 'set_category',
    spaceId: 'space-test',
    budgetId: 'budget-test',
    requesterActorId: 'requester-test',
    requesterMembershipId: 'membership-test',
    governancePolicyVersion: 'governance-1',
    currentGovernancePolicyVersion: 'governance-1',
    requesterMembershipCurrent: true,
    policyVersion: 'policy-1',
    payloadHash: 'b'.repeat(64),
    privateEnvelopeVisible: true,
    payload: { kind: 'set_category', transactionId: `tx-${reviewId}`, categoryId },
    preconditions: { reviewId, transactionVersion: 1 },
    expiresAt: '2026-10-03T12:00:00.000Z',
    requiredApprovers: 1,
    approvers: [],
    disposition: 'approval_required',
    canApprove: true,
    canExecute: true,
  };
}

function approvalRequired(reviewId: string, categoryId: string) {
  return response({
    itemId: reviewId,
    success: false,
    approvalRequired: true,
    applied: false,
    verified: false,
    categorizationExecuted: false,
    disposition: 'approval_required',
    proposal: approvalProposal(reviewId, categoryId),
  });
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
    global: {
      components: { ReviewQueue, ReviewItem, ReviewActions, CategoryCorrectModal, ProposedRulesModal },
      stubs,
    },
  });
  pages.push(page);
  return page;
}

function mutations() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
}

beforeEach(() => {
  auth.session.value = { data: { user: { id: 'owner-1', email: 'owner@example.test' } } };
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
      return approvalRequired(body.reviewId, body.categoryId ?? '');
    }
    if (url === '/api/review/approve') {
      return approvalRequired(body.reviewId, 'cat-groceries');
    }
    if (['/api/review/reject', '/api/review/skip'].includes(url)) {
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

describe('private Review lifetime', () => {
  const privateProposal = {
    id: 'private-proposal', operation: 'set_category', budgetId: 'budget-test',
    transactionId: 'private-tx', categoryId: 'private-category',
    preconditions: JSON.stringify({ merchant: 'Private proposal merchant' }),
    expiresAt: '2026-10-03T12:00:00.000Z', actorId: 'owner-1',
    provenance: 'review', providerModel: null, correlationId: null,
    createdAt: '2026-10-02T10:00:00.000Z', simulationStatus: 'missing',
  };

  it('restores the authorized proposal entrypoint when the initial session resolves after mounting', async () => {
    auth.session.value = { data: null };
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, options) => {
      if (new URL(String(input), 'https://review.test').pathname === '/api/proposal')
        return Promise.resolve(response({ proposals: [privateProposal] }));
      return normalFetch(input, options);
    });
    const page = mountPage();
    await flushPromises();
    auth.session.value = { data: { user: { id: 'owner-1', email: 'owner@example.test' } } };
    await flushPromises();
    await button(page, 'Proposed rules (1)').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('Private proposal merchant');
    expect(page.text()).toContain('private-category');
    expect(mutations()).toEqual([]);
  });

  it.each(['denied', 'error envelope', 'offline'])('removes the authorized proposal list after a %s refresh and reopening', async (kind) => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let denied = false;
    fetchMock.mockImplementation((input, options) => {
      if (new URL(String(input), 'https://review.test').pathname !== '/api/proposal')
        return normalFetch(input, options);
      if (!denied) return Promise.resolve(response({ proposals: [privateProposal] }));
      if (kind === 'offline') return Promise.reject(new Error('Offline'));
      return Promise.resolve(new Response(JSON.stringify({
        status: 'error', result: null, error: { code: 'DENIED', message: 'Private list denied' },
      }), { status: kind === 'denied' ? 403 : 200 }));
    });
    const page = mountPage();
    await flushPromises();
    await button(page, 'Proposed rules (1)').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('Private proposal merchant');
    expect(page.text()).toContain('private-category');
    await button(page, 'Close').trigger('click');
    denied = true;
    await button(page, 'Proposed rules (1)').trigger('click');
    await flushPromises();
    expect(page.text()).not.toContain('Private proposal merchant');
    expect(page.text()).not.toContain('private-category');
    expect(page.findComponent(ProposedRulesModal).props('proposals')).toEqual([]);
    expect(page.findAll('button').some((control) => control.text() === 'Review exact proposal')).toBe(false);
    await button(page, 'Close').trigger('click');
    expect(page.findComponent(ReviewActions).text()).not.toContain('Proposed rules (1)');
  });

  it('clears private queue, exact detail and list on identity change and rejects old successful responses', async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    const oldQueue = Promise.withResolvers<Response>();
    const oldList = Promise.withResolvers<Response>();
    const oldDetail = Promise.withResolvers<Response>();
    const exact = { ...approvalProposal('secret', 'private-category'), id: privateProposal.id };
    let refreshing = false;
    fetchMock.mockImplementation((input, options) => {
      const path = new URL(String(input), 'https://review.test').pathname;
      if (path === '/api/review' && refreshing) return oldQueue.promise;
      if (path === '/api/proposal') return refreshing ? oldList.promise : Promise.resolve(response({ proposals: [privateProposal] }));
      if (path === '/api/proposal/private-proposal')
        return refreshing ? oldDetail.promise : Promise.resolve(response({ proposal: exact, stale: false }));
      return normalFetch(input, options);
    });
    const page = mountPage();
    await flushPromises();
    await button(page, 'Proposed rules (1)').trigger('click');
    await flushPromises();
    await button(page, 'Review exact proposal').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('"private-category"');
    refreshing = true;
    await button(page, 'Refresh proposal view').trigger('click');
    await button(page, 'Close').trigger('click');
    await button(page, 'Proposed rules (1)').trigger('click');
    await button(page, 'Refresh').trigger('click');
    auth.session.value = { data: { user: { id: 'owner-2', email: 'other@example.test' } } };
    await flushPromises();
    expect(page.text()).not.toContain('Corner Grocer');
    expect(page.text()).not.toContain('Morning Cafe');
    expect(page.text()).not.toContain('Private proposal merchant');
    oldQueue.resolve(response({ items: stored, total }));
    oldList.resolve(response({ proposals: [privateProposal] }));
    oldDetail.resolve(response({ proposal: exact, stale: false }));
    await flushPromises();
    expect(page.text()).not.toContain('Corner Grocer');
    expect(page.text()).not.toContain('Private proposal merchant');
    expect(page.text()).not.toContain('"private-category"');
    expect(page.findComponent(ReviewQueue).exists()).toBe(false);
    expect(page.findComponent(ReviewItem).exists()).toBe(false);
    expect(page.findAll('button').filter((control) => control.text().startsWith('Execute exact'))).toEqual([]);
  });
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

  it('locks controls during approval and opens the exact proposal after a retry without consuming the item', async () => {
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
    expect(page.findComponent(ReviewQueue).text()).toContain('Corner Grocer');
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Corner Grocer');
    expect(page.text()).toContain('Displayed payload hash:');
    expect(page.text()).toContain('b'.repeat(64));
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

  it('opens correction options and retains the selected category in a proposal without changing the item', async () => {
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
    expect(page.findAll('[role="dialog"]')).toHaveLength(1);
    expect(page.findComponent(ProposedRulesModal).props('open')).toBe(true);
    expect(page.text()).toContain('Displayed payload hash:');
    expect(page.text()).toContain('"categoryId": "cat-fuel"');
    expect(page.findComponent(ReviewItem).get('h2').text()).toBe('Corner Grocer');
    expect(page.findComponent(ReviewItem).text()).toContain('Groceries');
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

  it('does not steal merchant-control focus when an earlier Review queue request completes', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const page = mountPage();
    await nextTick();
    const details = page.findAll('details').find(row => row.text().includes('Merchant evidence and patterns'))!;
    (details.element as HTMLDetailsElement).open = true;
    const control = button(page, 'Load merchant evidence and patterns');
    (control.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(control.element);
    pending.resolve(response({ items: stored, total }));
    await flushPromises();
    expect(document.activeElement).toBe(control.element);
    expect(mutations()).toHaveLength(0);
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
          { categoryId: 'cat-groceries', count: 3, lastClassified: '2026-05-30', firstDate: '2026-03-30', lastDate: '2026-05-30', ledgerCount: 2, correctionCount: 1 },
        ],
        ruleCandidates: [
          {
            merchant: 'Corner Grocer',
            currentCategory: 'cat-groceries',
            matchCount: 3,
            payeeId: 'payee-grocer', categoryId: 'cat-groceries', supportCount: 3, consistencyNumerator: 3, consistencyDenominator: 3,
          },
          {
            merchant: 'Corner Grocer',
            currentCategory: 'cat-dining',
            matchCount: 3,
            payeeId: 'payee-grocer', categoryId: 'cat-dining', supportCount: 3, consistencyNumerator: 3, consistencyDenominator: 3,
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
    expect(detail.text()).toContain('−42.75 USD');
    expect(detail.text()).toContain('Stale since');
    expect(detail.text()).toContain('Unassigned');
    expect(detail.text()).toContain('Groceries');
    expect(detail.text()).toContain('cat-unmapped');
    expect(detail.text()).toContain('3 observations');
    expect(detail.text()).toContain('2026-03-30');
    expect(detail.text()).toContain('2 ledger / 1 verified correction');
    expect(detail.text()).toMatch(/3 support observations\s*·\s*3 \/ 3 historical consistency/);
    expect(detail.text()).not.toContain('% consistent');
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
