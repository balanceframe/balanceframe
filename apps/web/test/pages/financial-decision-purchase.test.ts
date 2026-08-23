import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import EvidenceDrawer from '../../app/components/EvidenceDrawer.vue';
import FindingCard from '../../app/components/FindingCard.vue';
import FreshnessBanner from '../../app/components/FreshnessBanner.vue';
import InsufficientDataPanel from '../../app/components/InsufficientDataPanel.vue';
import ReasonCodeList from '../../app/components/ReasonCodeList.vue';
import SemanticAmount from '../../app/components/SemanticAmount.vue';
import PurchaseCheckPage from '../../app/pages/purchase-check.vue';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

const AnalysisPageStub = {
  template:
    '<main><h1>{{ title }}</h1><div v-if="error" role="alert">{{ error.code }} {{ error.message }}</div><slot name="content" /></main>',
  props: ['title', 'loading', 'error', 'freshness', 'insufficientData'],
};

const UButtonStub = {
  template:
    '<button :disabled="disabled" :aria-label="ariaLabel" type="button" @click="$emit(\'click\')"><slot /></button>',
  props: ['disabled', 'variant', 'size', 'icon', 'ariaLabel'],
  emits: ['click'],
};

const UInputStub = {
  template:
    '<input :value="modelValue" :placeholder="placeholder" :type="type" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  props: ['modelValue', 'placeholder', 'type'],
  emits: ['update:modelValue'],
};

const globalMountOptions = {
  components: {
    EvidenceDrawer,
    FindingCard,
    FreshnessBanner,
    InsufficientDataPanel,
    ReasonCodeList,
    SemanticAmount,
  },
  stubs: {
    AnalysisPage: AnalysisPageStub,
    UAlert: {
      template: '<div role="alert"><strong>{{ title }}</strong> {{ description }}<slot /></div>',
      props: ['title', 'description', 'color', 'variant'],
    },
    UBadge: {
      template: '<span><slot /></span>',
      props: ['color', 'variant', 'size'],
    },
    UButton: UButtonStub,
    UCard: { template: '<section><header><slot name="header" /></header><slot /></section>' },
    UFormGroup: {
      template: '<label>{{ label }}<slot /></label>',
      props: ['label'],
    },
    UInput: UInputStub,
  },
};

function okEnvelope(result: Record<string, unknown>) {
  return {
    schemaVersion: '1',
    requestId: 'api-request-purchase',
    status: 'ok',
    dataFreshness: {
      isStale: false,
      lastSync: '2026-08-23T11:59:00Z',
      label: 'current',
    },
    authorization: null,
    result,
    error: null,
  };
}

function decision(readiness: 'ready' | 'qualified' | 'blocked') {
  return {
    metadata: {
      contractVersion: '1.0',
      decisionId: `fd-decision-${readiness}`,
      decisionKind: 'purchase',
      requestId: `fd-request-${readiness}`,
      correlationId: 'fd-correlation-2026-08-23',
      context: {
        evaluatedAt: '2026-08-23T12:00:00Z',
        horizon: {
          startsAt: '2026-08-23T12:00:00Z',
          endsAt: '2026-09-22T12:00:00Z',
        },
        policy: {
          pendingMode: 'includeConservatively',
          uncategorizedMode: 'reserveFullAmount',
          unclearedMode: 'include',
          maxBankSyncAgeMinutes: null,
          maxBudgetSnapshotAgeMinutes: null,
          accountOverrides: { includeOnly: null, exclude: [] },
        },
        policyVersion: 'fd-policy-v1',
        policyHash: 'sha256:fd-policy-v1',
        snapshotId: 'fd-snapshot-2026-08-23',
        contentHash: 'sha256:fd-snapshot-2026-08-23',
      },
    },
    readiness,
    before: {
      amounts: [
        {
          label: 'envelopeAvailability',
          scope: { kind: 'category', id: 'fd-category-groceries' },
          amount: { minorUnits: '5000', currency: 'USD' },
        },
      ],
    },
    after: {
      amounts: [
        {
          label: 'envelopeAvailability',
          scope: { kind: 'category', id: 'fd-category-groceries' },
          amount: { minorUnits: '-500', currency: 'USD' },
        },
      ],
    },
    issues:
      readiness === 'blocked'
        ? [
            {
              code: 'reservation_conflict',
              severity: 'critical',
              effect: 'blocks',
              scope: { kind: 'category', id: 'fd-category-groceries' },
              evidence: [
                {
                  evidenceId: 'fd-issue-reservation-proof',
                  kind: 'prospective_claim',
                  authorized: true,
                  redaction: 'visible',
                },
                {
                  evidenceId: 'fd-secret-issue-proof',
                  kind: 'prospective_claim',
                  authorized: false,
                  redaction: 'redacted',
                },
              ],
              remediation: {
                code: 'release_conflicting_reservation',
                action: 'Release the conflicting reservation before purchasing.',
              },
              redaction: 'visible',
            },
            {
              code: 'fd_future_safety_code',
              severity: 'critical',
              effect: 'qualifies',
              scope: { kind: 'global' },
              evidence: [],
              remediation: {
                code: 'review_future_safety',
                action: 'Review the qualified future-safety finding before purchase.',
              },
              redaction: 'visible',
            },
          ]
        : [],
    evidence: [
      {
        evidenceId: 'fd-source-active-reservation',
        kind: 'prospective_claim',
        authorized: true,
        redaction: 'visible',
      },
      {
        evidenceId: 'fd-secret-reservation',
        kind: 'prospective_claim',
        authorized: false,
        redaction: 'redacted',
      },
    ],
    alternatives: [],
    expiresAt: '2026-08-23T12:05:00Z',
    redaction: readiness === 'blocked' ? 'redacted' : 'visible',
    payload: {
      allowable: readiness !== 'blocked',
      reasonCodes: readiness === 'blocked' ? ['reservation_conflict'] : ['within_budget'],
      categoryBudget: { minorUnits: '20000', currency: 'USD' },
      categorySpent: { minorUnits: '15000', currency: 'USD' },
      categoryRemaining: { minorUnits: '-500', currency: 'USD' },
      projectedBalance: null,
    },
  };
}

function legacyResult(overrides: Record<string, unknown> = {}) {
  return {
    allowable: false,
    verdict: 'not_safe',
    reasonCodes: ['reservation_conflict', 'fd_future_reason_code'],
    explanation: 'An active reservation conflicts with this purchase.',
    categoryBudget: { minorUnits: '20000', currency: 'USD' },
    categorySpent: { minorUnits: '15000', currency: 'USD' },
    categoryRemaining: { minorUnits: '-500', currency: 'USD' },
    projectedBalance: null,
    hasEnvelope: true,
    proposals: [
      {
        targetCategoryId: 'fd-category-groceries',
        amount: { minorUnits: '5500', currency: 'USD' },
        label: 'Release reservation first',
      },
    ],
    donors: [
      {
        categoryId: 'fd-category-flexible',
        availableAmount: { minorUnits: '7000', currency: 'USD' },
      },
    ],
    protectedCategories: ['fd-category-rent'],
    expiry: 'Legacy evaluation expires in five minutes',
    competition: {
      competingPurchases: 2,
      totalCommitted: { minorUnits: '8000', currency: 'USD' },
    },
    evidence: { source: 'native_protocol', snapshotAge: '1m' },
    policy: { allowsReallocations: true },
    freshness: {
      isStale: false,
      lastSync: '2026-08-23T11:59:00Z',
      label: 'current',
    },
    ...overrides,
  };
}

function mountPage(): VueWrapper {
  return mount(PurchaseCheckPage, { global: globalMountOptions });
}

async function evaluate(result: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce(okEnvelope(result));
  const wrapper = mountPage();
  const inputs = wrapper.findAll('input');

  await inputs[0].setValue('fd-category-groceries');
  await inputs[1].setValue('5500');
  await inputs[2].setValue('USD');
  await inputs[3].setValue('fd-account-checking');
  await wrapper.get('button').trigger('click');
  await flushPromises();

  return wrapper;
}

describe('Purchase Check canonical financial decision presentation', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('states that evaluation is read-only and evaluates the entered purchase', async () => {
    const wrapper = await evaluate({ ...legacyResult(), decision: decision('ready') });

    expect(wrapper.text()).toContain(
      'This page is read-only. Evaluations do not mutate ledger state or trigger transactions.',
    );
    expect(mockFetch).toHaveBeenCalledWith('/api/purchase/evaluate', {
      query: {
        categoryId: 'fd-category-groceries',
        amount: '5500',
        currency: 'USD',
        accountId: 'fd-account-checking',
      },
    });
  });

  it.each([
    ['ready', 'Ready'],
    ['qualified', 'Qualified'],
    ['blocked', 'Blocked'],
  ] as const)('renders the typed %s readiness as exactly %s', async (readiness, label) => {
    const wrapper = await evaluate({ ...legacyResult(), decision: decision(readiness) });

    expect(wrapper.get('[data-testid="decision-readiness"]').text().trim()).toBe(label);
  });

  it('renders the typed blocked decision without dropping the legacy purchase result', async () => {
    const wrapper = await evaluate({ ...legacyResult(), decision: decision('blocked') });
    const text = wrapper.text();

    expect(wrapper.get('[data-testid="decision-readiness"]').text().trim()).toBe('Blocked');

    const before = wrapper.get('[data-testid="decision-before"]');
    expect(before.text()).toContain('Before');
    expect(before.text()).toContain('Envelope availability');
    expect(before.text()).toContain('Category: fd-category-groceries');
    expect(before.text()).toContain('50.00');
    expect(before.text()).toContain('USD');

    const after = wrapper.get('[data-testid="decision-after"]');
    expect(after.text()).toContain('After');
    expect(after.text()).toContain('Envelope availability');
    expect(after.text()).toContain('Category: fd-category-groceries');
    expect(after.text()).toContain('−5.00');
    expect(after.text()).toContain('USD');

    const identity = wrapper.get('[data-testid="decision-identity"]');
    expect(identity.text()).toContain('Snapshot');
    expect(identity.text()).toContain('fd-snapshot-2026-08-23');
    expect(identity.text()).toContain('Policy');
    expect(identity.text()).toContain('fd-policy-v1');
    expect(identity.text()).toContain('Request');
    expect(identity.text()).toContain('fd-request-blocked');
    expect(identity.text()).toContain('Valid until');
    expect(identity.text()).toContain('2026-08-23T12:05:00Z');

    const blockingIssue = wrapper.get('[data-issue-code="reservation_conflict"]');
    expect(blockingIssue.text()).toContain('Reservation Conflict');
    expect(blockingIssue.text()).toContain('Critical');
    expect(blockingIssue.text()).toContain('Blocks');
    expect(blockingIssue.text()).toContain('Category: fd-category-groceries');
    expect(blockingIssue.text()).toContain(
      'Release the conflicting reservation before purchasing.',
    );

    const futureIssue = wrapper.get('[data-issue-code="fd_future_safety_code"]');
    expect(futureIssue.text()).toContain('Fd Future Safety Code');
    expect(futureIssue.text()).toContain('Critical');
    expect(futureIssue.text()).toContain('Qualifies');
    expect(futureIssue.text()).toContain('Global');
    expect(futureIssue.text()).toContain(
      'Review the qualified future-safety finding before purchase.',
    );

    expect(text).toContain('Decision evidence');
    const evidenceButtons = wrapper
      .findAll('button')
      .filter((button) => button.text().trim() === 'Show evidence');
    expect(evidenceButtons.length).toBeGreaterThan(0);
    for (const button of evidenceButtons) await button.trigger('click');
    expect(wrapper.find('[role="region"][aria-label="Evidence"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('fd-issue-reservation-proof');
    expect(wrapper.text()).toContain('fd-source-active-reservation');
    expect(wrapper.text()).toContain('prospective_claim');
    expect(wrapper.text()).toContain('Restricted evidence');
    expect(wrapper.text()).not.toContain('fd-secret-issue-proof');
    expect(wrapper.text()).not.toContain('fd-secret-reservation');

    expect(text).toContain('Verdict:');
    expect(text).toContain('Not Safe');
    expect(text).toContain('Reservation Conflict');
    expect(text).toContain('Fd Future Reason Code');
    expect(text).toContain('An active reservation conflicts with this purchase.');
    expect(text).toContain('Budget:');
    expect(text).toContain('Spent:');
    expect(text).toContain('Remaining:');
    expect(text).toContain('Projected balance:');
    expect(text).toContain('Unavailable');
    expect(text).toContain('Envelope budget active');
    expect(text).toContain('Release reservation first');
    expect(text).toContain('fd-category-flexible');
    expect(text).toContain('fd-category-rent');
    expect(text).toContain('Legacy evaluation expires in five minutes');
    expect(text).toContain('2 competing purchases');
    expect(text).toContain('native_protocol');
    expect(text).toContain('Snapshot age: 1m');
    expect(text).toContain('Reallocation allowed');
    expect(text).toContain('current');

    const renderedAmounts = wrapper.findAllComponents(SemanticAmount);
    expect(renderedAmounts.length).toBeGreaterThan(0);
    expect(renderedAmounts.every((amount) => amount.props('amount')?.minorUnits !== '0')).toBe(
      true,
    );
  });

  it('renders insufficient data explicitly without inventing zero, USD, or current facts', async () => {
    const wrapper = await evaluate(
      legacyResult({
        allowable: false,
        verdict: 'insufficient_data',
        reasonCodes: ['missing_snapshot'],
        explanation: 'The purchase cannot be evaluated from the available snapshot.',
        categoryBudget: null,
        categorySpent: null,
        categoryRemaining: null,
        projectedBalance: null,
        hasEnvelope: false,
        proposals: [],
        donors: [],
        protectedCategories: [],
        expiry: null,
        competition: null,
        evidence: null,
        policy: null,
        freshness: null,
      }),
    );

    expect(wrapper.get('[data-testid="decision-readiness"]').text().trim()).toBe(
      'Insufficient data',
    );
    expect(wrapper.findComponent(InsufficientDataPanel).exists()).toBe(true);
    expect(wrapper.text()).toContain('Insufficient data');
    expect(wrapper.text()).toContain('Unknown');
    expect(wrapper.text()).toContain('Unavailable');
    expect(wrapper.text()).toContain('Verdict:');
    expect(wrapper.text()).toContain('Insufficient Data');
    expect(wrapper.text()).not.toContain('0.00');
    expect(wrapper.text()).not.toContain('USD');
    expect(wrapper.text()).not.toContain('Data current');
    expect(wrapper.findAllComponents(SemanticAmount)).toHaveLength(0);
  });

  it('continues to render a legacy-only purchase response', async () => {
    const wrapper = await evaluate(
      legacyResult({
        allowable: true,
        verdict: 'safe',
        reasonCodes: ['sufficient_budget'],
        explanation: 'Budget allows this purchase.',
        projectedBalance: { minorUnits: '125000', currency: 'USD' },
        proposals: [],
        donors: [],
        protectedCategories: [],
        expiry: null,
        competition: null,
      }),
    );

    expect(wrapper.text()).toContain('Verdict:');
    expect(wrapper.text()).toContain('Safe');
    expect(wrapper.text()).toContain('Sufficient Budget');
    expect(wrapper.text()).toContain('Budget allows this purchase.');
    expect(wrapper.text()).toContain('Budget:');
    expect(wrapper.text()).toContain('200.00');
    expect(wrapper.text()).toContain('Projected balance:');
    expect(wrapper.text()).toContain('1250.00');
    expect(wrapper.text()).toContain('Envelope budget active');
  });
});
