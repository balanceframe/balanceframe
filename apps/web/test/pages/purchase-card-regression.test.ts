import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { PublicDecisionCard } from '@balanceframe/application';
import PurchaseCheckPage from '../../app/pages/purchase-check.vue';

const mockFetch = vi.fn();
const requestUrls: string[] = [];
vi.stubGlobal('$fetch', mockFetch);

type Money = { minorUnits: string; currency: 'USD' };

const money = (minorUnits: string): Money => ({ minorUnits, currency: 'USD' });

const catalog = {
  accounts: [
    { id: 'checking', name: 'Checking account' },
    { id: 'savings', name: 'Savings account' },
  ],
  categories: [{ id: 'food', name: 'Food' }],
  canCreateSession: false,
};

const okEnvelope = (result: unknown) => ({ status: 'ok', result });

const AnalysisPageStub = {
  template:
    '<main><div v-if="error" role="alert">{{ error.message }}</div><slot name="content" /></main>',
  props: ['title', 'loading', 'error'],
};

const UButtonStub = {
  template:
    '<button :disabled="disabled" type="button" @click="$emit(\'click\')"><slot /></button>',
  props: ['disabled'],
  emits: ['click'],
};

const globalMountOptions = {
  stubs: {
    AnalysisPage: AnalysisPageStub,
    NuxtLink: { template: '<a><slot /></a>', props: ['to'] },
    UAlert: { template: '<div role="alert"><slot /></div>' },
    UBadge: { template: '<span><slot /></span>' },
    UButton: UButtonStub,
    UCard: { template: '<section><header><slot name="header" /></header><slot /></section>' },
    UFormGroup: { template: '<label><slot /></label>', props: ['label'] },
    UInput: {
      template:
        '<input :value="modelValue" :type="type" @input="$emit(\'update:modelValue\', $event.target.value)" />',
      props: ['modelValue', 'type'],
      emits: ['update:modelValue'],
    },
    EvidenceDrawer: true,
    FindingCard: true,
    FreshnessBanner: true,
    InsufficientDataPanel: true,
    ReasonCodeList: true,
    SemanticAmount: {
      template: '<span>{{ amount?.minorUnits }} {{ amount?.currency }}</span>',
      props: ['amount'],
    },
    LiquidityResult: true,
    TransferPlanReview: true,
  },
};

const categoryState = (availability: string, policyKind = 'ordinary') => ({
  categoryId: 'food',
  asOfMonth: '2026-09',
  availability: money(availability),
  commitments: money('1000'),
  reservations: money('0'),
  uncommittedAvailability: money(availability),
  safeToRedirect: money('0'),
  policyKind,
});

const accountState = (accountId: string, balance: string, safeSpendingCapacity: string) => ({
  accountId,
  recordedBalance: money(balance),
  adjustedCash: money(balance),
  signedHeadroom: money(balance),
  existingShortfall: money('0'),
  safeSpendingCapacity: money(safeSpendingCapacity),
  safeTransferCapacity: money(safeSpendingCapacity),
  backingCapacity: money(balance),
  deductions: [],
  reasons: [],
});

const state = (
  categoryAvailability: string,
  checkingBalance: string,
  checkingSafeSpendingCapacity: string,
  savingsBalance: string,
  savingsSafeSpendingCapacity: string,
  runway: string,
  goalState: 'on_track' | 'at_risk',
) => ({
  categories: [categoryState(categoryAvailability)],
  accounts: [
    accountState('checking', checkingBalance, checkingSafeSpendingCapacity),
    accountState('savings', savingsBalance, savingsSafeSpendingCapacity),
  ],
  backing: {
    feasible: true,
    lines: [
      {
        accountId: 'checking',
        categoryId: 'food',
        cashBucketId: 'food',
        amount: money(categoryAvailability),
      },
    ],
    reasons: [],
  },
  goals: [
    {
      categoryId: 'food',
      asOfMonth: '2026-09',
      kind: 'goal',
      state: goalState,
      shortfall: money(goalState === 'on_track' ? '0' : '500'),
      minimumRetained: money('500'),
      projectedRemainingNeed: money('500'),
      requiredRetained: money('500'),
      targetState: 'unknown',
      availability: money(categoryAvailability),
      uncommittedAvailability: money(categoryAvailability),
    },
  ],
  obligations: [
    {
      economicObligationId: 'schedule:rent:2026-09-10',
      classification: 'commitment',
      accountId: 'checking',
      categoryId: 'food',
      amount: money('1000'),
      dueAt: '2026-09-10T12:00:00Z',
      state: 'active',
      recurring: false,
      scheduleId: 'rent',
      amountState: 'known',
    },
  ],
  runway: {
    state: 'known',
    accountId: 'checking',
    remainingSafeCash: money(runway),
    basis: 'selected_account_safe_spending_capacity',
  },
});

const cart = {
  subtotal: money('2000'),
  tax: money('0'),
  fee: money('0'),
  discount: money('0'),
  total: money('2000'),
  categoryCharges: [{ categoryId: 'food', amount: money('2000') }],
  accountCharges: [{ accountId: 'checking', amount: money('2000') }],
};

const item = (outcome: PublicDecisionCard['outcome'], paymentLiquidityStatus: string) => ({
  id: 'purchase-1',
  categoryId: 'food',
  amount: money('2000'),
  priority: 'planned',
  outcome,
  budgetFundingStatus: 'funded',
  paymentLiquidityStatus,
  selectedAccountId: 'checking',
  selectionSource: 'explicit',
  reasons: [],
  before: null,
  after: null,
});

const baseCard = (
  outcome: PublicDecisionCard['outcome'],
  paymentLiquidityStatus: 'ready' | 'transfer_required',
): PublicDecisionCard =>
  ({
    outcome,
    budgetFundingStatus: 'funded',
    paymentLiquidityStatus,
    selectedAccountId: 'checking',
    selectionSource: 'explicit',
    before: state('2000', '9000', '7000', '20000', '17000', '9000', 'on_track'),
    after: state('0', '11000', '9000', '17000', '14000', '7000', 'at_risk'),
    fundingPaths: [],
    evidence: [
      {
        evidenceId: 'checking-freshness',
        kind: 'bank_sync',
        authorized: true,
        redaction: 'visible',
      },
    ],
    blockers: [],
    cart,
    warnings: [],
    trimAlternatives: [],
    opportunityCosts: [],
    conflicts: [],
    authorizationRequirements: [],
    reasons: ['category_funded'],
    assumptions: ['Purchase evaluation is read-only.'],
    earliestExpiry: '2026-09-06T18:00:00Z',
    expiresAt: '2026-09-06T18:00:00Z',
    readiness: {
      outcome,
      status: 'evaluated',
      blockers: [],
      budgetFundingStatus: 'funded',
      paymentLiquidityStatus,
    },
    items: [item(outcome, paymentLiquidityStatus)],
  }) as PublicDecisionCard;

const fundedNowCard = (): PublicDecisionCard => baseCard('funded_now', 'ready');

const safeAfterDateCard = (): PublicDecisionCard => {
  const card = baseCard('safe_after_date', 'transfer_required');
  card.fundingPaths = [
    {
      kind: 'account_transfer',
      itemIds: ['purchase-1'],
      minimumAmount: money('3000'),
      expiresAt: '2026-09-06T18:00:00Z',
      legs: [
        {
          sourceAccountId: 'savings',
          destinationAccountId: 'checking',
          amount: money('3000'),
          requiredBy: '2026-09-06T12:00:00Z',
          estimatedArrival: '2026-09-06T11:00:00Z',
          sourceBefore: money('20000'),
          destinationBefore: money('9000'),
          sourceAfter: money('17000'),
          destinationAfter: money('12000'),
        },
      ],
    },
  ];
  card.authorizationRequirements = ['account_transfer_approval'];
  card.reasons = ['payment_account_requires_transfer'];
  card.assumptions = ['Transfer arrival is estimated and requires separate approval.'];
  return card;
};

const insufficientDataCard = (): PublicDecisionCard =>
  ({
    outcome: 'insufficient_data',
    budgetFundingStatus: 'insufficient_data',
    paymentLiquidityStatus: 'insufficient_data',
    selectedAccountId: null,
    before: null,
    after: null,
    fundingPaths: [],
    evidence: [],
    blockers: ['account_freshness'],
    cart: null,
    warnings: [],
    trimAlternatives: [],
    readiness: {
      outcome: 'insufficient_data',
      status: 'blocked',
      blockers: ['account_freshness'],
      budgetFundingStatus: 'insufficient_data',
      paymentLiquidityStatus: 'insufficient_data',
    },
  }) as PublicDecisionCard;

async function mountAndEvaluate(
  card: PublicDecisionCard,
  options: {
    accountId?: string;
    purchaseAt?: string;
    requiredBy?: string;
  } = {},
) {
  mockFetch.mockImplementation((url?: string) => {
    requestUrls.push(url ?? '');
    if (url === '/api/liquidity/spendability') return Promise.resolve(okEnvelope(catalog));
    if (url === '/api/purchase/evaluate') return Promise.resolve(okEnvelope({ card }));
    return Promise.resolve(okEnvelope({}));
  });

  const wrapper = mount(PurchaseCheckPage, { global: globalMountOptions });
  await flushPromises();
  await wrapper.get('#purchase-category').setValue('food');
  await wrapper.get('#purchase-amount').setValue('2000');
  await wrapper.get('#purchase-currency').setValue('USD');
  if (options.accountId) await wrapper.get('#purchase-account').setValue(options.accountId);
  if (options.purchaseAt !== undefined) await wrapper.get('#purchase-at').setValue(options.purchaseAt);
  if (options.requiredBy !== undefined)
    await wrapper.get('#purchase-required').setValue(options.requiredBy);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  return wrapper;
}

describe('Purchase Check Decision Card contract', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    requestUrls.length = 0;
  });

  it('renders a funded_now Card with separate budget/payment readiness and exact before/after state', async () => {
    const wrapper = await mountAndEvaluate(fundedNowCard(), { accountId: 'checking' });
    const card = wrapper.get('[data-testid="purchase-card"]');

    expect(wrapper.get('[data-testid="card-outcome"]').text()).toBe('Funded now');
    expect(wrapper.get('[data-testid="card-budget-status"]').text()).toContain('Funded');
    expect(wrapper.get('[data-testid="card-payment-status"]').text()).toContain('Ready');
    expect(wrapper.get('[data-testid="card-selected-account"]').text()).toContain('checking');

    const before = wrapper.get('[data-testid="card-before"]');
    expect(before.text()).toContain('food');
    expect(before.text()).toContain('20.00 USD');
    expect(before.text()).toContain('checking');
    const after = wrapper.get('[data-testid="card-after"]');
    expect(after.text()).toContain('food');
    expect(after.text()).toContain('0.00 USD');
    expect(after.text()).toContain('checking');

    expect(wrapper.get('[data-testid="card-goals"]').text()).toContain('food');
    expect(wrapper.get('[data-testid="card-obligations"]').text()).toContain('2026-09-10');
    expect(wrapper.get('[data-testid="card-runway"]').text()).toContain('90.00 USD');
    expect(wrapper.get('[data-testid="card-evidence"]').text()).toMatch(/evidence|bank/i);
    expect(wrapper.get('[data-testid="card-assumptions"]').text()).toMatch(/read.only/i);
    expect(wrapper.get('[data-testid="card-expiry"]').text()).toContain('2026-09-06');
    expect(card.find('[data-testid="card-funding-path"]').exists()).toBe(false);
    expect(card.find('[data-testid="plan-transfer"]').exists()).toBe(false);

  });

  it('keeps large evidence trails collapsed until the reader opens them', async () => {
    const card = fundedNowCard();
    const wrapper = await mountAndEvaluate({
      ...card,
      evidence: Array.from({ length: 60 }, () => card.evidence[0]!),
    });
    const disclosure = wrapper.get<HTMLDetailsElement>('[data-testid="card-evidence"]');
    expect(disclosure.element.open).toBe(false);
    await disclosure.get('summary').trigger('click');
    expect(disclosure.element.open).toBe(true);
    expect(disclosure.findAll('li')).toHaveLength(60);
  });

  it('renders safe_after_date with funded budget, transfer-required payment, exact path timing, approval, and no mutation', async () => {
    const wrapper = await mountAndEvaluate(safeAfterDateCard(), {
      accountId: 'checking',
      purchaseAt: '2026-09-06T12:00',
      requiredBy: '2026-09-06T12:00',
    });
    const card = wrapper.get('[data-testid="purchase-card"]');

    expect(wrapper.get('[data-testid="card-outcome"]').text()).toBe('Safe after date');
    expect(wrapper.get('[data-testid="card-budget-status"]').text()).toContain('Funded');
    expect(wrapper.get('[data-testid="card-payment-status"]').text()).toContain('Transfer required');
    expect(wrapper.get('[data-testid="card-selected-account"]').text()).toContain('checking');
    expect(wrapper.get('[data-testid="card-before"]').text()).toContain('20.00 USD');
    expect(wrapper.get('[data-testid="card-before"]').text()).toContain('food');
    expect(wrapper.get('[data-testid="card-after"]').text()).toContain('0.00 USD');
    expect(wrapper.get('[data-testid="card-after"]').text()).toContain('food');

    const path = wrapper.get('[data-testid="card-funding-path"]');
    expect(path.text()).toContain('savings');
    expect(path.text()).toContain('checking');
    expect(wrapper.get('[data-testid="transfer-amount"]').text()).toContain('30.00 USD');
    expect(wrapper.get('[data-testid="transfer-timing"]').text()).toContain('2026-09-06');
    expect(wrapper.get('[data-testid="transfer-timing"]').text()).toContain('11:00');
    expect(wrapper.get('[data-testid="transfer-timing"]').text()).toContain('12:00');
    expect(wrapper.get('[data-testid="transfer-approval"]').text()).toMatch(/approval|required/i);
    expect(wrapper.get('[data-testid="plan-transfer"]').attributes('disabled')).toBeUndefined();

    expect(wrapper.get('[data-testid="card-goals"]').text()).toContain('food');
    expect(wrapper.get('[data-testid="card-obligations"]').text()).toContain('2026-09-10');
    expect(wrapper.get('[data-testid="card-runway"]').text()).toContain('70.00 USD');
    expect(wrapper.get('[data-testid="card-evidence"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="card-assumptions"]').text()).toMatch(/approval/i);
    expect(wrapper.get('[data-testid="card-expiry"]').text()).toContain('2026-09-06');

    expect(requestUrls.filter((url) => url.includes('/api/transfer/'))).toEqual([]);
    expect(card.text()).not.toContain('legacy');
    expect(card.text()).not.toContain('Verdict:');
  });

  it('renders restricted insufficient_data with null financial states, blockers, and no private identifiers or hashes', async () => {
    const wrapper = await mountAndEvaluate(insufficientDataCard(), { accountId: 'checking' });
    const card = wrapper.get('[data-testid="purchase-card"]');

    expect(wrapper.get('[data-testid="card-outcome"]').text()).toBe('Insufficient data');
    expect(wrapper.get('[data-testid="card-budget-status"]').text()).toContain('Insufficient data');
    expect(wrapper.get('[data-testid="card-payment-status"]').text()).toContain('Insufficient data');
    expect(wrapper.get('[data-testid="card-blockers"]').text()).toContain('account_freshness');
    expect(card.find('[data-testid="card-after"]').exists()).toBe(false);
    expect(card.find('[data-testid="card-before"]').exists()).toBe(false);
    expect(card.find('[data-testid="card-selected-account"]').exists()).toBe(false);
    expect(card.find('[data-testid="card-goals"]').exists()).toBe(false);
    expect(card.find('[data-testid="card-obligations"]').exists()).toBe(false);
    expect(card.find('[data-testid="card-runway"]').exists()).toBe(false);
    expect(card.find('[data-testid="card-funding-path"]').exists()).toBe(false);
    expect(card.find('[data-testid="plan-transfer"]').exists()).toBe(false);

    const rendered = card.text();
    expect(rendered).not.toMatch(/planHash|snapshotId|contentHash|policyHash|private[-_]/i);
    expect(rendered).not.toContain('0.00 USD');
    expect(rendered).not.toContain('20.00 USD');
  });
});
