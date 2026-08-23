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
              scope: { kind: 'account', id: 'fd-account-checking' },
              evidence: [],
              remediation: {
                code: 'review_future_safety',
                action: 'Review the qualified future-safety finding before purchase.',
              },
              redaction: 'visible',
            },
            {
              code: 'duplicate_transfer_ambiguity',
              severity: 'warning',
              effect: 'blocks',
              scope: { kind: 'transaction', id: 'fd-transfer-one-sided' },
              evidence: [],
              remediation: {
                code: 'review_transfer',
                action: 'Review the related transactions and resolve the transfer ambiguity.',
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

function currentResult(
  readiness: 'ready' | 'qualified' | 'blocked',
  overrides: Record<string, unknown> = {},
) {
  return legacyResult({
    verdict: readiness === 'blocked' ? 'insufficient_data' : 'safe',
    explanation:
      readiness === 'blocked'
        ? 'Insufficient data prevents a reliable purchase decision.'
        : 'Budget allows this purchase.',
    envelopeFundingState: 'funded',
    entityLabels: {
      'fd-category-groceries': 'Groceries',
      'fd-account-checking': 'Household Checking',
      'fd-transaction-pending': 'Fixture Grocer · 2026-08-23',
      'fd-transaction-existing': 'Fixture Grocer · 2026-08-23',
      'fd-transfer-one-sided': 'Card Transfer · 2026-08-23',
    },
    decision: decision(readiness),
    ...overrides,
  });
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
    const wrapper = await evaluate(currentResult('ready'));

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
    ['blocked', 'Insufficient data'],
  ] as const)('renders the typed %s readiness as exactly %s', async (readiness, label) => {
    const wrapper = await evaluate(currentResult(readiness));

    expect(wrapper.get('[data-testid="decision-readiness"]').text().trim()).toBe(label);
  });

  it('renders the typed blocked decision while suppressing legacy action suggestions', async () => {
    const wrapper = await evaluate(currentResult('blocked'));
    const text = wrapper.text();

    expect(wrapper.get('[data-testid="decision-readiness"]').text().trim()).toBe(
      'Insufficient data',
    );

    const before = wrapper.get('[data-testid="decision-before"]');
    expect(before.text()).toContain('Before');
    expect(before.text()).toContain('Envelope availability');
    expect(before.text()).toContain('Category: Groceries');
    expect(before.text()).toContain('50.00');
    expect(before.text()).toContain('USD');

    const after = wrapper.get('[data-testid="decision-after"]');
    expect(after.text()).toContain('After');
    expect(after.text()).toContain('Envelope availability');
    expect(after.text()).toContain('Category: Groceries');
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
    expect(blockingIssue.text()).toContain('Groceries');
    expect(blockingIssue.text()).toContain(
      'Release the conflicting reservation before purchasing.',
    );

    const futureIssue = wrapper.get('[data-issue-code="fd_future_safety_code"]');
    expect(futureIssue.text()).toContain('Fd Future Safety Code');
    expect(futureIssue.text()).toContain('Critical');
    expect(futureIssue.text()).toContain('Qualifies');
    expect(futureIssue.text()).toContain('Household Checking');
    expect(futureIssue.text()).toContain(
      'Review the qualified future-safety finding before purchase.',
    );
    expect(before.text()).not.toContain('fd-category-groceries');
    expect(after.text()).not.toContain('fd-category-groceries');
    expect(blockingIssue.text()).not.toContain('fd-category-groceries');
    expect(futureIssue.text()).not.toContain('fd-account-checking');

    const transferIssue = wrapper.get('[data-issue-code="duplicate_transfer_ambiguity"]');
    expect(transferIssue.text()).toContain('Card Transfer · 2026-08-23');
    expect(transferIssue.text()).not.toContain('fd-transfer-one-sided');

    expect(text).toContain('Decision evidence');
    const evidenceButtons = wrapper.findAll('button[aria-label="Show evidence summary"]');
    expect(evidenceButtons.length).toBeGreaterThan(0);
    for (const button of evidenceButtons) {
      expect(button.text()).toContain('(4)');
      await button.trigger('click');
    }
    const evidenceSummaries = wrapper.findAll('[role="region"][aria-label="Evidence summary"]');
    expect(evidenceSummaries).toHaveLength(evidenceButtons.length);
    for (const summary of evidenceSummaries) {
      expect(summary.text()).toContain('4 references');
      expect(summary.text()).toContain('Prospective Claim evidence');
      expect(summary.text()).toContain('Restricted evidence');
      expect(summary.text()).not.toContain('fd-issue-reservation-proof');
      expect(summary.text()).not.toContain('fd-source-active-reservation');
    }

    const technicalEvidenceButtons = wrapper.findAll(
      'button[aria-label="Show technical evidence details"]',
    );
    expect(technicalEvidenceButtons).toHaveLength(evidenceButtons.length);
    for (const button of technicalEvidenceButtons) await button.trigger('click');
    expect(wrapper.text()).toContain('fd-issue-reservation-proof');
    expect(wrapper.text()).toContain('fd-source-active-reservation');
    expect(wrapper.text()).toContain('prospective_claim');
    expect(wrapper.text()).not.toContain('fd-secret-issue-proof');
    expect(wrapper.text()).not.toContain('fd-secret-reservation');

    expect(text).toContain('Verdict:');
    expect(text).toContain('Insufficient Data');
    expect(text).toContain('Reservation Conflict');
    expect(text).toContain('Fd Future Reason Code');
    expect(text).toContain('Insufficient data prevents a reliable purchase decision.');
    expect(text).toContain('Budget:');
    expect(text).toContain('Spent:');
    expect(text).toContain('Remaining:');
    expect(text).toContain('Effective balance after pending and uncleared activity:');
    expect(text).not.toContain('Projected balance:');
    expect(text).toContain('Unavailable');
    expect(text).toContain('Envelope budget active');
    expect(text).not.toContain('Release reservation first');
    expect(text).not.toContain('fd-category-flexible');
    expect(text).not.toContain('fd-category-rent');
    expect(text).toContain('Legacy evaluation expires in five minutes');
    expect(text).not.toContain('2 competing purchases');
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

  it('renders currency-incompatible semantic amounts as unavailable rather than zero money', async () => {
    const currencyMismatch = decision('blocked');
    currencyMismatch.before.amounts = [];
    currencyMismatch.after.amounts = [];
    currencyMismatch.issues = [
      {
        code: 'currency_mismatch',
        severity: 'critical',
        effect: 'blocks',
        scope: { kind: 'category', id: 'fd-category-groceries' },
        evidence: [],
        remediation: {
          code: 'use_compatible_currency',
          action: 'Use an account and category with the purchase currency.',
        },
        redaction: 'visible',
      },
    ];

    const wrapper = await evaluate(
      currentResult('blocked', {
        decision: currencyMismatch,
        envelopeFundingState: 'unavailable',
        categoryBudget: null,
        categorySpent: null,
        categoryRemaining: null,
        projectedBalance: null,
        reasonCodes: ['currency_mismatch'],
      }),
    );

    expect(wrapper.get('[data-testid="decision-readiness"]').text().trim()).toBe(
      'Insufficient data',
    );
    expect(wrapper.text()).toContain('Unavailable');
    expect(wrapper.text()).not.toContain('Unknown');
    expect(wrapper.text()).not.toContain('0.00');
    expect(wrapper.text()).not.toContain('USD');
    expect(wrapper.findAllComponents(SemanticAmount)).toHaveLength(0);
  });

  it('states when a zero-value envelope has no assigned funds', async () => {
    const unfundedDecision = decision('ready');
    unfundedDecision.before.amounts = unfundedDecision.before.amounts.map((amount) => ({
      ...amount,
      amount: { ...amount.amount, minorUnits: '0' },
    }));
    unfundedDecision.after.amounts = unfundedDecision.after.amounts.map((amount) => ({
      ...amount,
      amount: { ...amount.amount, minorUnits: '0' },
    }));
    unfundedDecision.payload.categoryBudget = { minorUnits: '0', currency: 'USD' };
    unfundedDecision.payload.categorySpent = { minorUnits: '0', currency: 'USD' };
    unfundedDecision.payload.categoryRemaining = { minorUnits: '0', currency: 'USD' };

    const wrapper = await evaluate(
      currentResult('ready', {
        decision: unfundedDecision,
        envelopeFundingState: 'unfunded',
        categoryBudget: { minorUnits: '0', currency: 'USD' },
        categorySpent: { minorUnits: '0', currency: 'USD' },
        categoryRemaining: { minorUnits: '0', currency: 'USD' },
      }),
    );

    expect(wrapper.text()).toContain('Envelope has no assigned funds');
    expect(wrapper.text()).not.toContain('Envelope budget active');
    expect(wrapper.text()).not.toContain('No envelope (cash-flow only)');
  });

  it('continues to render a legacy-only purchase response', async () => {
    const wrapper = await evaluate(
      legacyResult({
        allowable: true,
        verdict: 'safe',
        reasonCodes: ['sufficient_budget'],
        explanation: 'Budget allows this purchase.',
        projectedBalance: { minorUnits: '125000', currency: 'USD' },
        expiry: null,
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
    expect(wrapper.text()).toContain('Release reservation first');
    expect(wrapper.text()).toContain('fd-category-flexible');
    expect(wrapper.text()).toContain('fd-category-rent');
    expect(wrapper.text()).toContain('2 competing purchases');
  });
});
