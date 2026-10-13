import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecisionIssue, EvidenceReference } from '@balanceframe/protocol-generated';

import EvidenceDrawer from '../app/components/EvidenceDrawer.vue';
import FindingCard from '../app/components/FindingCard.vue';
import FreshnessBanner from '../app/components/FreshnessBanner.vue';
import InsufficientDataPanel from '../app/components/InsufficientDataPanel.vue';
import ReasonCodeList from '../app/components/ReasonCodeList.vue';
import SemanticAmount from '../app/components/SemanticAmount.vue';
import { flushPromises } from '@vue/test-utils';
import rawFixture from '../../../protocol/fixtures/merchant-intelligence.json';
import { merchantAnalysisRequestSchema, merchantAnalysisResultSchema } from '@balanceframe/protocol-generated/validators';
import MerchantEvidence from '../app/components/MerchantEvidence.vue';
import MerchantReviewPanel from '../app/components/MerchantReviewPanel.vue';
import MerchantPolicySettings from '../app/components/MerchantPolicySettings.vue';
import ReviewItem from '../app/components/ReviewItem.vue';
import type { ReviewQueueItem, ReviewSurfaceState } from '../src/review';

const fixture = {
  request: merchantAnalysisRequestSchema.parse(rawFixture.request),
  result: merchantAnalysisResultSchema.parse(rawFixture.result),
  recurrenceResult: merchantAnalysisResultSchema.parse(rawFixture.recurrenceResult),
};

const presentationGlobal = {
  components: {
    EvidenceDrawer,
    ReasonCodeList,
    SemanticAmount,
  },
  stubs: {
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    UButton: {
      template: '<button type="button"><slot /></button>',
    },
    UCard: {
      template: '<article><slot /></article>',
    },
    UBadge: {
      template: '<span><slot /></span>',
    },
  },
};

const VISIBLE_EVIDENCE_UUID = '4b6c8f4e-9a11-4cbd-86fc-0af96d2d3581';
const SNAPSHOT_HASH = 'sha256:40f04c938d5c88c1';
const REVISION_HASH = 'sha256:184d9b02be37a1a6';

const visibleEvidence: EvidenceReference = {
  evidenceId: VISIBLE_EVIDENCE_UUID,
  kind: 'transaction',
  authorized: true,
  redaction: 'visible',
};

const REDACTED_SECRET = 'private-account-token-9f22';
const redactedEvidence: EvidenceReference = {
  evidenceId: REDACTED_SECRET,
  kind: 'account',
  authorized: false,
  redaction: 'redacted',
};

const blockingIssue: DecisionIssue = {
  code: 'duplicate_transfer_ambiguity',
  severity: 'warning',
  effect: 'blocks',
  scope: { kind: 'account', id: 'account-checking' },
  evidence: [visibleEvidence, redactedEvidence],
  remediation: {
    code: 'review_transfer',
    action: 'Review the linked transfer entries.',
  },
  redaction: 'redacted',
};

describe('financial decision shared presentation', () => {
  describe('SemanticAmount', () => {
    it('exposes a known amount with its financial semantic class', () => {
      const wrapper = mount(SemanticAmount, {
        props: {
          amount: { minorUnits: '12500', currency: 'EUR' },
          semanticClass: 'accountLiquidity',
          state: 'known',
        },
      });

      const amount = wrapper.get('[data-semantic-class="accountLiquidity"]');
      expect(amount.attributes('aria-label')).toBe('Account liquidity: 125.00 EUR');
      expect(amount.text()).toBe('125.00 EUR');
    });

    it.each([
      ['unknown', 'Unknown'],
      ['unavailable', 'Unavailable'],
      ['redacted', 'Restricted'],
    ] as const)(
      'renders %s money explicitly without inventing zero or a currency',
      (state, label) => {
        const wrapper = mount(SemanticAmount, {
          props: {
            amount: null,
            semanticClass: state === 'redacted' ? 'redactedConclusion' : 'accountLiquidity',
            state,
          },
        });

        expect(wrapper.text()).toContain(label);
        expect(wrapper.text()).not.toContain('0.00');
        expect(wrapper.text()).not.toContain('USD');
        expect(wrapper.html()).not.toContain('minorUnits');
      },
    );
  });

  describe('FreshnessBanner', () => {
    it('announces mixed freshness and preserves each account state', () => {
      const wrapper = mount(FreshnessBanner, {
        props: {
          accounts: [
            {
              accountId: 'account-checking',
              label: 'Daily checking',
              state: 'current',
              observedAt: '2026-08-23T10:00:00.000Z',
            },
            {
              accountId: 'account-savings',
              label: 'Emergency savings',
              state: 'stale',
              observedAt: '2026-08-20T10:00:00.000Z',
            },
            {
              accountId: 'account-brokerage',
              label: 'Brokerage cash',
              state: 'unavailable',
              observedAt: null,
            },
          ],
        },
      });

      expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Data freshness: mixed');
      const rows = wrapper.findAll('li');
      expect(rows).toHaveLength(3);
      expect(rows[0]!.text()).toContain('Daily checking');
      expect(rows[0]!.text()).toContain('Current');
      expect(rows[1]!.text()).toContain('Emergency savings');
      expect(rows[1]!.text()).toContain('Stale');
      expect(rows[2]!.text()).toContain('Brokerage cash');
      expect(rows[2]!.text()).toContain('Unavailable');
      expect(rows[2]!.text()).not.toContain('Current');
    });
  });

  describe('ReasonCodeList', () => {
    it('renders known and forward-compatible issues with effect, severity, and remediation', () => {
      const unknownIssue: DecisionIssue = {
        code: 'future_connector_constraint',
        severity: 'info',
        effect: 'qualifies',
        scope: { kind: 'global' },
        evidence: [],
        remediation: {
          code: 'inspect_connector',
          action: 'Inspect connector guidance.',
        },
        redaction: 'visible',
      };
      const wrapper = mount(ReasonCodeList, {
        props: { issues: [blockingIssue, unknownIssue] },
      });

      const list = wrapper.get('ul');
      expect(list.attributes('aria-label')).toBe('Decision issues');
      const items = list.findAll('li');
      expect(items).toHaveLength(2);
      expect(items[0]!.attributes('data-issue-code')).toBe('duplicate_transfer_ambiguity');
      expect(items[0]!.text()).toContain('Duplicate Transfer Ambiguity');
      expect(items[0]!.text()).toContain('Warning');
      expect(items[0]!.text()).toContain('Blocks');
      expect(items[0]!.text()).toContain('Review the linked transfer entries.');
      expect(items[1]!.attributes('data-issue-code')).toBe('future_connector_constraint');
      expect(items[1]!.text()).toContain('Future Connector Constraint');
      expect(items[1]!.text()).toContain('Info');
      expect(items[1]!.text()).toContain('Qualifies');
      expect(items[1]!.text()).toContain('Inspect connector guidance.');
    });
  });

  describe('EvidenceDrawer', () => {
    it('summarizes evidence by kind and count while keeping technical identifiers secondary', async () => {
      const wrapper = mount(EvidenceDrawer, {
        props: {
          references: [visibleEvidence, redactedEvidence],
          snapshotId: SNAPSHOT_HASH,
          policyVersion: 'decision-policy-v3',
        },
        global: presentationGlobal,
      });

      const evidenceToggle = wrapper.get('button[aria-label="Show evidence summary"]');
      expect(evidenceToggle.attributes('aria-expanded')).toBe('false');
      expect(wrapper.text()).not.toContain(VISIBLE_EVIDENCE_UUID);
      expect(wrapper.text()).not.toContain(SNAPSHOT_HASH);

      await evidenceToggle.trigger('click');

      const region = wrapper.get('[role="region"][aria-label="Evidence summary"]');
      expect(region.get('[aria-label="Transaction evidence: 1 reference"]').exists()).toBe(true);
      expect(region.get('[aria-label="Restricted evidence: 1 reference"]').exists()).toBe(true);
      expect(region.text()).not.toContain(VISIBLE_EVIDENCE_UUID);
      expect(region.text()).not.toContain(REDACTED_SECRET);
      expect(region.text()).not.toContain(SNAPSHOT_HASH);

      const technicalToggle = region.get('button[aria-label="Show technical evidence details"]');
      expect(technicalToggle.attributes('aria-expanded')).toBe('false');
      await technicalToggle.trigger('click');

      const technicalRegion = region.get(
        '[role="region"][aria-label="Technical evidence details"]',
      );
      expect(technicalRegion.text()).toContain(VISIBLE_EVIDENCE_UUID);
      expect(technicalRegion.text()).toContain(SNAPSHOT_HASH);
      expect(wrapper.html()).not.toContain(REDACTED_SECRET);
    });
  });

  describe('InsufficientDataPanel', () => {
    it('announces the affected scope, severity, remediation, snapshot, and policy', () => {
      const issue: DecisionIssue = {
        ...blockingIssue,
        code: 'currency_mismatch',
        severity: 'critical',
        scope: { kind: 'account', id: 'account-eur' },
        remediation: {
          code: 'choose_compatible_currency',
          action: 'Choose an account with a compatible currency.',
        },
      };
      const wrapper = mount(InsufficientDataPanel, {
        props: {
          issue,
          snapshotId: 'snapshot-currency-17',
          policyVersion: 'purchase-policy-v4',
        },
      });

      const alert = wrapper.get('[role="alert"]');
      expect(alert.text()).toContain('Insufficient Data');
      expect(alert.text()).toContain('Critical');
      expect(alert.text()).toContain('Account: account-eur');
      expect(alert.text()).toContain('Choose an account with a compatible currency.');
      expect(alert.text()).toContain('Snapshot: snapshot-currency-17');
      expect(alert.text()).toContain('Policy: purchase-policy-v4');
      expect(alert.text()).not.toContain('0.00');
      expect(alert.text()).not.toContain('USD');
    });
  });

  describe('FindingCard', () => {
    it('keeps snapshot and revision hashes under accessible technical provenance', async () => {
      const wrapper = mount(FindingCard, {
        props: {
          finding: {
            title: 'Transfer needs attention',
            severity: 'warning',
            classification: 'transfer_needs_attention',
            status: 'open',
            issue: blockingIssue,
            snapshotId: SNAPSHOT_HASH,
            policyVersion: 'attention-policy-v2',
            revision: REVISION_HASH,
          },
        },
        global: presentationGlobal,
      });

      const card = wrapper.get('article[aria-label="Finding: Transfer needs attention"]');
      const primaryText = card.text().replace(/\s+/g, ' ').trim();
      expect(primaryText).toContain('Transfer Needs Attention');
      expect(primaryText).toContain('Open');
      expect(primaryText).toContain('Duplicate Transfer Ambiguity');
      expect(primaryText).toContain('Warning');
      expect(primaryText).toContain('Blocks');
      expect(primaryText).toContain('Account: account-checking');
      expect(primaryText).toContain('Review the linked transfer entries.');
      expect(primaryText.split('Review the linked transfer entries.')).toHaveLength(2);
      expect(primaryText).not.toContain(SNAPSHOT_HASH);
      expect(primaryText).not.toContain(REVISION_HASH);
      expect(primaryText).not.toContain(VISIBLE_EVIDENCE_UUID);
      expect(primaryText).not.toContain('0.00');
      expect(primaryText).not.toContain('USD');
      expect(primaryText).not.toContain('Data current');

      const provenanceToggle = card.get('button[aria-label="Show technical provenance"]');
      expect(provenanceToggle.text()).toContain('Technical provenance');
      expect(provenanceToggle.attributes('aria-expanded')).toBe('false');
      await provenanceToggle.trigger('click');

      const provenance = card.get('[role="region"][aria-label="Technical provenance"]');
      expect(provenance.text()).toContain(SNAPSHOT_HASH);
      expect(provenance.text()).toContain('attention-policy-v2');
      expect(provenance.text()).toContain(REVISION_HASH);

      const evidenceToggle = card.get('button[aria-label="Show evidence summary"]');
      await evidenceToggle.trigger('click');
      const evidence = card.get('[role="region"][aria-label="Evidence summary"]');
      expect(evidence.text()).not.toContain(VISIBLE_EVIDENCE_UUID);
      expect(wrapper.html()).not.toContain(REDACTED_SECRET);
    });
  });
});

describe('merchant intelligence Review controls', () => {
  afterEach(() => vi.unstubAllGlobals());
  const envelope = (result: unknown) => new Response(JSON.stringify({ status: 'ok', result, error: null }));
  const analysis = () => ({
    ...fixture.recurrenceResult,
    normalizationVersion: fixture.recurrenceResult.normalizationVersion,
    asOfDate: fixture.request.asOfDate,
    payees: fixture.request.payees.map(({ id, name }) => ({ id, name })),
    categories: fixture.request.categories.map(({ id, name }) => ({ id, name })),
    sourceAdmission: { ...fixture.recurrenceResult.sourceAdmission, expiresAt: '2099-01-01T00:00:00Z' },
    suggestionPage: { eligibleCandidates: 0, returned: 0, nextCursor: null },
    recurrences: fixture.recurrenceResult.recurrences.map((r) => ({
      ...r, evidenceKey: `merchant:pattern:${r.id}`,
      patternDecisions: [{ id: 'existing-private-pattern', patternId: r.id, visibility: 'private', state: 'rejected', version: 7, updatedAt: '2024-12-31T12:00:00Z' }],
    })),
  });
  const button = (wrapper: VueWrapper, label: string) =>
    wrapper.findAll('button').find((b) => b.text() === label)!;
  it('uses authoritative Review Money rather than a floating classifier display amount', () => {
    const item = {
      reviewItem: { status: 'pending_review' },
      evidence: {
        originalImportedName: 'Market', normalizedMerchant: 'Market', account: 'Checking',
        amount: -0.01, money: { minorUnits: '-9223372036854775808', currency: 'JPY' },
        provenance: 'native-rule', alternatives: [], history: [], ruleCandidates: [],
        freshness: null, changePreview: { fromCategory: 'food', toCategory: 'food' },
      },
    } as unknown as ReviewQueueItem;
    const wrapper = mount(ReviewItem, {
      props: { item, state: {} as ReviewSurfaceState },
      global: presentationGlobal,
    });
    expect(wrapper.text()).toContain('−9223372036854775808 JPY');
    expect(wrapper.text()).not.toContain('$');
  });


  it('keeps native evidence tiers, civil endpoints, exact rational variance and complete distributions visible', () => {
    const wrapper = mount(MerchantEvidence, {
      props: { recurrence: fixture.recurrenceResult.recurrences[0]!, normalizationVersion: 'merchant/2' },
      global: presentationGlobal,
    });
    expect(wrapper.text()).toContain('inferred');
    expect(wrapper.text()).toContain('Not a calibrated probability');
    expect(wrapper.text()).toContain('2024-01-31');
    expect(wrapper.text()).toContain('2024-03-31');
    expect(wrapper.text()).toContain('20000 / 3 USD minor units²');
    expect(wrapper.text()).toContain('2024-W06: 0');
    expect(wrapper.text()).toContain('1 / 3');
    expect(wrapper.text()).toContain('not proof');
    expect(wrapper.text()).not.toContain('confidence: 100%');
  });
  it('shows full native history counts and endpoints separately from bounded explanations and exact rule consistency', () => {
    const suggestion = {
      ...fixture.result.suggestions[0]!,
      categoryId: 'category-food',
      categoryHistory: {
        totalCount: 210, categoryCount: 2, truncated: true,
        entries: [{ categoryId: 'category-food', count: 206, ledgerCount: 205, correctionCount: 1, firstDate: '2020-01-01', lastDate: '2024-12-30' }],
      },
      alternatives: [{ categoryId: 'category-other', supportCount: 4, tier: 'insufficient_data' as const, reasonCodes: ['sparse_history'] }],
      ruleCandidates: [{ payeeId: 'payee-market', categoryId: 'category-food', supportCount: 206, consistencyNumerator: 206, consistencyDenominator: 210 }],
    };
    const wrapper = mount(MerchantEvidence, {
      props: { suggestion, categoryNames: { 'category-food': 'Food', 'category-other': 'Other' } },
      global: presentationGlobal,
    });
    expect(wrapper.text()).toContain('210 outcomes across 2 categories');
    expect(wrapper.text()).toContain('206 observations');
    expect(wrapper.text()).toContain('205 ledger / 1 verified correction');
    expect(wrapper.text()).toContain('2020-01-01');
    expect(wrapper.text()).toContain('2024-12-30');
    expect(wrapper.text()).toContain('History entries truncated');
    expect(wrapper.text()).toContain('category-other');
    expect(wrapper.text()).toContain('insufficient_data');
    expect(wrapper.text()).toContain('206 / 210');
    expect(wrapper.text()).toContain('Food');
    expect(wrapper.text()).toContain('Other');
    expect(wrapper.text()).not.toContain('100%');
  });

  it.each([
    ['JPY', '-9223372036854775808', '−9223372036854775808 JPY'],
    ['KWD', '9223372036854775807', '9223372036854775.807 KWD'],
  ])('formats %s money without float conversion or two-decimal assumptions', (currency, minorUnits, expected) => {
    expect(mount(SemanticAmount, { props: { amount: { currency, minorUnits } } }).text()).toBe(expected);
  });

  it('preserves raw canonical units when a currency exponent is unknown rather than inventing decimals', () => {
    const wrapper = mount(SemanticAmount, { props: { amount: { minorUnits: '123', currency: 'ZZZ' } } });
    expect(wrapper.text()).toBe('123 minor units ZZZ (currency exponent unknown)');
  });

  it('allows categorized-only pattern review and reuses the persisted exact decision version after refresh', async () => {
    const data = analysis();
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/reauth') return new Response(JSON.stringify({ status: 'success' }));
      if (url === '/api/merchant/reject') {
        const body = JSON.parse(String(options?.body));
        expect(body).toMatchObject({
          id: 'existing-private-pattern', expectedVersion: 7, visibility: 'private',
          kind: 'pattern', patternId: data.recurrences[0]!.id,
          evidenceKey: data.recurrences[0]!.evidenceKey, evidenceRevision: data.recurrences[0]!.evidenceRevision,
        });
        return envelope({ id: body.id, state: 'rejected', version: 8 });
      }
      return envelope(data);
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantReviewPanel, { global: { ...presentationGlobal, components: { MerchantEvidence } } });
    await button(wrapper, 'Load merchant evidence and patterns').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('corner market');
    await wrapper.get('input[type="password"]').setValue('source-password');
    await button(wrapper, 'Reject pattern').trigger('click');
    await flushPromises();
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/merchant')).toHaveLength(2);
    expect(wrapper.text()).toContain('rejected');
    expect(wrapper.text()).not.toContain('Verified execution');
  });

  it('clears old evidence on denied refresh and gives an actionable conflict without optimistic success', async () => {
    let denied = false;
    vi.stubGlobal('fetch', vi.fn(async () => denied
      ? new Response(JSON.stringify({ status: 'error', result: null, error: { code: 'FORBIDDEN', message: 'Request current evidence access.', retryable: false } }))
      : envelope(analysis())));
    const wrapper = mount(MerchantReviewPanel, { global: { ...presentationGlobal, components: { MerchantEvidence } } });
    await button(wrapper, 'Load merchant evidence and patterns').trigger('click');
    await flushPromises();
    denied = true;
    await button(wrapper, 'Refresh merchant evidence').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Request current evidence access.');
    expect(wrapper.text()).not.toContain('corner market');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Reject pattern')).toBe(false);
  });

  it('distinguishes unsupported, absent, empty and restricted raw fields and renders malicious text only as text', () => {
    const wrapper = mount(MerchantEvidence, {
      props: {
        suggestion: fixture.result.suggestions[0]!,
        asOfDate: fixture.request.asOfDate,
        expiresAt: fixture.result.sourceAdmission.expiresAt,
        normalizationVersion: fixture.result.normalizationVersion,
        sourceTransaction: {
          ...fixture.request.transactions[0]!,
          importedPayee: { state: 'present', value: '<img src=x onerror=alert(1)>' },
          notes: { state: 'unavailable', value: null },
        },
      },
      global: presentationGlobal,
    });
    expect(wrapper.text()).toContain('unsupported');
    expect(wrapper.text()).toContain('absent');
    expect(wrapper.text()).toContain('unavailable');
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('payee-market');
    expect(wrapper.text()).toContain('As of civil date: 2024-12-31');
    expect(wrapper.text()).toContain('Source evidence expires: 2025-01-01T12:00:00Z');
  });

  it('requires present raw source and sends alias confirmation to the server with explicit shared scope', async () => {
    const suggestion = {
      ...fixture.result.suggestions[0]!,
      sourceTransaction: fixture.request.transactions[0]!,
      evidenceKey: 'merchant:transaction:tx-source', aliasDecisions: [],
      reviewContext: { expiresAt: '2099-01-01T00:00:00Z' },
    };
    const data = { ...analysis(), suggestions: [suggestion] };
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/reauth') return new Response(JSON.stringify({ status: 'success' }));
      if (url === '/api/merchant/confirm') {
        expect(JSON.parse(String(options?.body))).toMatchObject({
          kind: 'alias', transactionId: 'tx-source', sourceField: 'importedPayee',
          targetPayeeId: 'payee-other', accountId: 'account-checking', visibility: 'shared',
          evidenceKey: suggestion.evidenceKey, evidenceRevision: suggestion.evidenceRevision, expectedVersion: 0,
        });
        return envelope({ id: 'alias-persisted', state: 'accepted', version: 1 });
      }
      return envelope(data);
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantReviewPanel, { global: { ...presentationGlobal, components: { MerchantEvidence } } });
    await button(wrapper, 'Load merchant evidence and patterns').trigger('click');
    await flushPromises();
    await wrapper.get('select[aria-label="Alias source field"]').setValue('description');
    expect(button(wrapper, 'Confirm alias').attributes('disabled')).toBeDefined();
    await wrapper.get('select[aria-label="Alias source field"]').setValue('importedPayee');
    await wrapper.get('input[aria-label="Target Actual payee ID"]').setValue('payee-other');
    await wrapper.get('select[aria-label="Decision visibility"]').setValue('shared');
    await wrapper.get('input[type="password"]').setValue('source-password');
    await button(wrapper, 'Confirm alias').trigger('click');
    await flushPromises();
    expect(fetcher.mock.calls.some(([url]) => url === '/api/merchant/confirm')).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url.includes('proposal'))).toBe(false);
  });

  it('preserves full account calendar overrides in policy replacement and does not infer a jurisdiction', async () => {
    const value = {
      mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0,
      maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720,
      calendar: { budget: null, accounts: [{ accountId: 'private-account', selection: { jurisdiction: 'CA', subdivision: 'ON', timeZone: 'America/Toronto' } }] },
    };
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/reauth') return new Response(JSON.stringify({ status: 'success' }));
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        expect(body.expectedVersion).toBe(3);
        expect(body.value.calendar.accounts).toEqual(value.calendar.accounts);
        expect(body.value.calendar.budget).toEqual({ jurisdiction: 'GB', subdivision: null, timeZone: 'Europe/London' });
        return envelope({ value: body.value, version: 4, generation: 0 });
      }
      return envelope({ value, version: 3, generation: 0 });
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantPolicySettings, { global: presentationGlobal });
    await button(wrapper, 'Load merchant policy').trigger('click');
    await flushPromises();
    expect(wrapper.get<HTMLSelectElement>('select[aria-label="Budget jurisdiction"]').element.value).toBe('');
    await wrapper.get('select[aria-label="Budget jurisdiction"]').setValue('GB');
    await wrapper.get('input[aria-label="Budget IANA time zone"]').setValue('Europe/London');
    await wrapper.get('input[type="password"]').setValue('source-password');
    expect(button(wrapper, 'Save complete merchant policy').attributes('type')).toBe('submit');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Policy saved');
  });
  it('makes a stale decision actionable and never marks it accepted locally', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/reauth') return new Response(JSON.stringify({ status: 'success' }));
      if (url === '/api/merchant/confirm') return new Response(JSON.stringify({
        status: 'error', result: null,
        error: { code: 'CONFLICT', message: 'Evidence changed. Refresh and review again.', retryable: true },
      }), { status: 409 });
      return envelope(analysis());
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantReviewPanel, { global: { ...presentationGlobal, components: { MerchantEvidence } } });
    await button(wrapper, 'Load merchant evidence and patterns').trigger('click');
    await flushPromises();
    await wrapper.get('input[type="password"]').setValue('source-password');
    await button(wrapper, 'Confirm pattern').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Refresh');
    expect(wrapper.text()).not.toContain('Decision saved');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('corner market');
  });
  it('refuses partial policy overwrite when the full policy read is unauthorized', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: 'error', result: null,
      error: { code: 'FORBIDDEN', message: 'Complete account override control required.', retryable: false },
    })));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantPolicySettings, { global: presentationGlobal });
    await button(wrapper, 'Load merchant policy').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Complete account override control required.');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Save complete merchant policy')).toBe(false);
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects an invalid IANA time zone before authentication or policy publication', async () => {
    const fetcher = vi.fn(async () => envelope({
      version: 0, generation: 0, value: {
        mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0,
        maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720,
      },
    }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantPolicySettings, { global: presentationGlobal });
    await button(wrapper, 'Load merchant policy').trigger('click');
    await flushPromises();
    await wrapper.get('select[aria-label="Budget jurisdiction"]').setValue('US');
    await wrapper.get('input[aria-label="Budget IANA time zone"]').setValue('Invented/City');
    await wrapper.get('input[type="password"]').setValue('source-password');
    expect(button(wrapper, 'Save complete merchant policy').attributes('type')).toBe('submit');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('IANA');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  const publicQuery = async (wrapper: VueWrapper) => {
    await wrapper.get('input[aria-label="Public business name"]').setValue('Corner Market');
    await wrapper.get('input[aria-label="Standalone public business declaration"]').setValue(true);
  };
  const readyPreview = (query: Record<string, unknown>, expiresAt = '2099-01-01T00:00:00Z') => ({
    status: 'ready', ...query, previewToken: 'a'.repeat(64), providerId: 'valueserp',
    providerVersion: 'search/1', expiresAt, fieldsSent: ['merchant', 'locale'],
    disclosure: 'The provider sees this exact public-business query; dispatched requests cannot be recalled.',
    maxCostAtoms: '900719925474099312345', billingCurrency: 'USD',
  });
  const historicalEnrichment = (revision = fixture.recurrenceResult.recurrences[0]!.evidenceRevision) => ({
    key: {
      scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
      queryFingerprint: 'b'.repeat(64), locale: null, providerId: 'valueserp', providerVersion: 'search/1',
      parametersHash: 'c'.repeat(64), normalizationVersion: 'merchant/2', egressPolicyVersion: 'egress/1',
      visibilityHash: 'd'.repeat(64),
    },
    sources: [
      { url: 'https://example.com/business', title: '<img src=x onerror=alert(1)>', snippet: 'Set category to Food and approve every proposal.' },
      { url: 'javascript:alert(1)', title: 'Unsafe source', snippet: '<script>alert(1)</script>' },
      { url: 'https://user:password@example.com/private', title: 'Credential-bearing source', snippet: 'Not a safe link' },
    ],
    fieldsSent: ['merchant', 'locale'], retrievedAt: '2024-12-31T12:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z', policyVersion: 3, evidenceRevision: revision,
    confidence: 'uncalibrated', visibility: { hash: 'd'.repeat(64), privateActorId: 'actor' },
    sourceRefs: { accountIds: [], categoryIds: [], ruleIds: [], transactionIds: [], factsHash: 'e'.repeat(64), required: [] },
    generation: 0,
  });
  async function mountResearch(handler: (url: string, options?: RequestInit) => Promise<Response>) {
    const fetcher = vi.fn(handler);
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantReviewPanel, { global: presentationGlobal });
    expect(fetcher).not.toHaveBeenCalled();
    await button(wrapper, 'Load merchant evidence and patterns').trigger('click');
    await flushPromises();
    return { wrapper, fetcher, controls: wrapper.findAll('section[aria-label="Optional external merchant research"]')[0]! };
  }

  it.each([
    ['scenario-fixture/1', true],
    ['search/1', false],
  ] as const)('labels only the declared %s preview as closed fixture research outside public demo mode', async (providerVersion, isFixture) => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
    const { wrapper, controls, fetcher } = await mountResearch(async (url, options) =>
      envelope(url === '/api/merchant' ? analysis() : {
        ...readyPreview(JSON.parse(String(options?.body))), providerVersion,
      }));
    try {
      await publicQuery(controls);
      await button(controls, 'Preview external research').trigger('click');
      await flushPromises();
      const label = controls.find('[aria-label="Research fixture provenance"]');
      expect(label.exists()).toBe(isFixture);
      if (isFixture) {
        expect(label.text()).toMatch(/closed fixture/i);
        expect(label.text()).toMatch(/no live provider request/i);
        expect(label.text()).toMatch(/modeled.*not.*real.*cost/i);
      }
      expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
      expect(fetcher.mock.calls.some(([url]) => url === '/api/merchant/research')).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('requires blank standalone input, declaration, exact preview and independent consent before external dispatch', async () => {
    let sent: Record<string, unknown> | undefined;
    const { wrapper, controls, fetcher } = await mountResearch(async (url, options) => {
      if (url === '/api/merchant') return envelope(analysis());
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      if (url === '/api/merchant/research/preview') return envelope(readyPreview(body));
      if (url === '/api/merchant/research') { sent = body; return envelope({ status: 'pending', attemptId: 'attempt' }); }
      throw new Error(`Unexpected HTTP action ${url}`);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(controls.get<HTMLInputElement>('input[aria-label="Public business name"]').element.value).toBe('');
    expect(controls.get<HTMLSelectElement>('select[aria-label="Research locale"]').element.value).toBe('');
    expect(button(controls, 'Preview external research').attributes('disabled')).toBeDefined();
    await controls.get('input[aria-label="Public business name"]').setValue('Corner Market');
    expect(button(controls, 'Preview external research').attributes('disabled')).toBeDefined();
    await controls.get('input[aria-label="Standalone public business declaration"]').setValue(true);
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    await button(controls, 'Preview external research').trigger('click');
    await flushPromises();
    const disclosure = controls.get('[aria-label="Exact external research preview"]').text();
    expect(disclosure).toContain('Corner Market');
    expect(disclosure).toContain('valueserp');
    expect(disclosure).toContain('search/1');
    expect(disclosure).toContain('merchant, locale');
    expect(disclosure).toContain('900719925474099312345');
    expect(disclosure).toContain('1,000,000 atoms');
    expect(disclosure).toContain('USD');
    expect(disclosure).toContain('dispatched requests cannot be recalled');
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    await controls.get('input[aria-label="Consent to this exact external preview"]').setValue(true);
    await button(controls, 'Send consented external research').trigger('click');
    await flushPromises();
    expect(sent).toEqual({
      evidenceKey: analysis().recurrences[0]!.evidenceKey,
      evidenceRevision: analysis().recurrences[0]!.evidenceRevision,
      merchant: 'Corner Market', locale: null, publicBusiness: true, consent: true,
      previewToken: 'a'.repeat(64), idempotencyKey: expect.any(String),
    });
    expect(controls.text()).toContain('potential billing');
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/merchant/research')).toHaveLength(1);
    expect(wrapper.text()).toContain('Confirm pattern');
  });

  it.each(['query', 'locale', 'declaration'] as const)('invalidates exact consent and token when %s changes', async (change) => {
    const { controls, fetcher } = await mountResearch(async (url, options) =>
      envelope(url === '/api/merchant' ? analysis() : readyPreview(JSON.parse(String(options?.body)))));
    await publicQuery(controls);
    await button(controls, 'Preview external research').trigger('click');
    await flushPromises();
    await controls.get('input[aria-label="Consent to this exact external preview"]').setValue(true);
    if (change === 'query') await controls.get('input[aria-label="Public business name"]').setValue('Different Market');
    if (change === 'locale') await controls.get('select[aria-label="Research locale"]').setValue('CA');
    if (change === 'declaration') await controls.get('input[aria-label="Standalone public business declaration"]').setValue(false);
    expect(controls.find('[aria-label="Exact external research preview"]').exists()).toBe(false);
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    await button(controls, 'Send consented external research').trigger('click');
    expect(fetcher.mock.calls.some(([url]) => url === '/api/merchant/research')).toBe(false);
  });

  it('discards a late preview after query changes, blocks duplicate busy actions and refuses a mismatched target', async () => {
    let resolvePreview!: (response: Response) => void;
    let query: Record<string, unknown> = {};
    const { controls, fetcher } = await mountResearch(async (url, options) => {
      if (url === '/api/merchant') return envelope(analysis());
      query = JSON.parse(String(options?.body));
      return new Promise<Response>((resolve) => { resolvePreview = resolve; });
    });
    await publicQuery(controls);
    await button(controls, 'Preview external research').trigger('click');
    expect(button(controls, 'Preview external research').attributes('disabled')).toBeDefined();
    await button(controls, 'Preview external research').trigger('click');
    await controls.get('input[aria-label="Public business name"]').setValue('Other Market');
    resolvePreview(envelope(readyPreview(query)));
    await flushPromises();
    expect(controls.find('[aria-label="Exact external research preview"]').exists()).toBe(false);
    await button(controls, 'Preview external research').trigger('click');
    resolvePreview(envelope({ ...readyPreview(query), evidenceKey: 'merchant:pattern:wrong-target' }));
    await flushPromises();
    expect(controls.find('[aria-label="Exact external research preview"]').exists()).toBe(false);
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/merchant/research/preview')).toHaveLength(2);
  });

  it('expires consent while idle and never sends an expired preview', async () => {
    vi.useFakeTimers();
    const { wrapper, controls, fetcher } = await mountResearch(async (url, options) =>
      envelope(url === '/api/merchant' ? analysis() : readyPreview(JSON.parse(String(options?.body)), new Date(Date.now() + 1000).toISOString())));
    try {
      await publicQuery(controls);
      await button(controls, 'Preview external research').trigger('click');
      await flushPromises();
      await controls.get('input[aria-label="Consent to this exact external preview"]').setValue(true);
      expect(button(controls, 'Send consented external research').attributes('disabled')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1001);
      expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
      await button(controls, 'Send consented external research').trigger('click');
      expect(fetcher.mock.calls.some(([url]) => url === '/api/merchant/research')).toBe(false);
    } finally { wrapper.unmount(); vi.useRealTimers(); }
  });

  it('does not transplant late private cache evidence after review context changes or fetch automatically', async () => {
    let resolveCache!: (response: Response) => void;
    const { wrapper, controls, fetcher } = await mountResearch(async (url) => {
      if (url === '/api/merchant') return envelope(analysis());
      if (url === '/api/merchant/research/cache') return new Promise<Response>((resolve) => { resolveCache = resolve; });
      throw new Error(`Unexpected HTTP action ${url}`);
    });
    await publicQuery(controls);
    await button(controls, 'Load historical research').trigger('click');
    await wrapper.setProps({ transactionId: 'other-authorized-transaction', refreshKey: 1 });
    resolveCache(envelope({ enrichment: historicalEnrichment() }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('Set category to Food');
    expect(wrapper.find('a[href="https://example.com/business"]').exists()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('renders explicitly loaded historical sources as untrusted text and safe links without financial or evidence promotion', async () => {
    const { wrapper, controls, fetcher } = await mountResearch(async (url) =>
      envelope(url === '/api/merchant' ? analysis() : { enrichment: historicalEnrichment() }));
    await publicQuery(controls);
    await button(controls, 'Load historical research').trigger('click');
    await flushPromises();
    expect(controls.text()).toContain('<img src=x onerror=alert(1)>');
    expect(controls.text()).toContain('<script>alert(1)</script>');
    expect(controls.find('img').exists()).toBe(false);
    expect(controls.find('script').exists()).toBe(false);
    const links = controls.findAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.attributes('href')).toBe('https://example.com/business');
    expect(links[0]!.attributes('rel')).toContain('noopener');
    expect(links[0]!.attributes('rel')).toContain('noreferrer');
    expect(controls.text()).toContain('2024-12-31T12:00:00Z');
    expect(controls.text()).toContain('2099-01-01T00:00:00Z');
    expect(controls.text()).toContain('valueserp');
    expect(controls.text()).toContain('uncalibrated');
    expect(controls.text()).toContain('merchant, locale');
    expect(controls.findAll('button').some(b => /apply|approve|confirm category/i.test(b.text()))).toBe(false);
    expect(wrapper.text()).toContain('Evidence tier: inferred');
    expect(fetcher.mock.calls.some(([url]) => /confirm|proposal|research$/.test(url))).toBe(false);
  });

  it('binds standalone research to suggestion evidence rather than its native payee or transaction text', async () => {
    const suggestion = {
      ...fixture.result.suggestions[0]!, sourceTransaction: fixture.request.transactions[0]!,
      evidenceKey: 'merchant:transaction:tx-source', aliasDecisions: [],
      reviewContext: { expiresAt: '2099-01-01T00:00:00Z' },
    };
    let sent: Record<string, unknown> | undefined;
    const { controls } = await mountResearch(async (url, options) => {
      if (url === '/api/merchant') return envelope({ ...analysis(), suggestions: [suggestion], recurrences: [] });
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      if (url === '/api/merchant/research/preview') return envelope(readyPreview(body));
      sent = body; return envelope({ status: 'pending', attemptId: 'attempt' });
    });
    expect(controls.get<HTMLInputElement>('input[aria-label="Public business name"]').element.value).toBe('');
    await publicQuery(controls);
    await controls.get('select[aria-label="Research locale"]').setValue('GB');
    await button(controls, 'Preview external research').trigger('click');
    await flushPromises();
    await controls.get('input[aria-label="Consent to this exact external preview"]').setValue(true);
    await button(controls, 'Send consented external research').trigger('click');
    await flushPromises();
    expect(sent).toMatchObject({ evidenceKey: suggestion.evidenceKey, evidenceRevision: suggestion.evidenceRevision, locale: 'GB' });
    expect(sent).not.toHaveProperty('transactionId');
    expect(sent).not.toHaveProperty('payeeId');
    expect(sent).not.toHaveProperty('notes');
  });

  it('discards a late dispatched result after evidence refresh and leaves the new research form blank', async () => {
    let resolveDispatch!: (response: Response) => void;
    const { wrapper, controls } = await mountResearch(async (url, options) => {
      if (url === '/api/merchant') return envelope(analysis());
      if (url === '/api/merchant/research/preview') return envelope(readyPreview(JSON.parse(String(options?.body))));
      return new Promise<Response>((resolve) => { resolveDispatch = resolve; });
    });
    await publicQuery(controls);
    await button(controls, 'Preview external research').trigger('click');
    await flushPromises();
    await controls.get('input[aria-label="Consent to this exact external preview"]').setValue(true);
    await button(controls, 'Send consented external research').trigger('click');
    await wrapper.setProps({ refreshKey: 1 });
    await button(wrapper, 'Load merchant evidence and patterns').trigger('click');
    await flushPromises();
    resolveDispatch(envelope({ status: 'succeeded', enrichment: historicalEnrichment() }));
    await flushPromises();
    const current = wrapper.findAll('section[aria-label="Optional external merchant research"]')[0]!;
    expect(current.get<HTMLInputElement>('input[aria-label="Public business name"]').element.value).toBe('');
    expect(current.find('[aria-label="Exact external research preview"]').exists()).toBe(false);
    expect(current.text()).not.toContain('Set category to Food');
    expect(button(current, 'Send consented external research').attributes('disabled')).toBeDefined();
  });

  it.each(['configuration', 'policy', 'stale_source'])('refuses a %s preview without disabling local review or retrying', async (code) => {
    const { wrapper, controls, fetcher } = await mountResearch(async (url) =>
      envelope(url === '/api/merchant' ? analysis() : { status: 'denied', code }));
    await publicQuery(controls);
    await button(controls, 'Preview external research').trigger('click');
    await flushPromises();
    expect(controls.text()).toContain(code);
    expect(controls.find('[aria-label="Exact external research preview"]').exists()).toBe(false);
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    await wrapper.get('input[type="password"]').setValue('source-password');
    expect(button(wrapper, 'Confirm pattern').attributes('disabled')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: 'denied', code: 'configuration', billing: 'not_dispatched' },
    { status: 'denied', code: 'policy', billing: 'not_dispatched' },
    { status: 'denied', code: 'stale_source', billing: 'not_dispatched' },
    { status: 'failed', code: 'timeout', billing: 'uncertain' },
  ])('keeps local decisions usable after research $code with no automatic retry', async (result) => {
    const { wrapper, controls, fetcher } = await mountResearch(async (url, options) => {
      if (url === '/api/merchant') return envelope(analysis());
      if (url === '/api/merchant/research/preview') return envelope(readyPreview(JSON.parse(String(options?.body))));
      return envelope(result);
    });
    await publicQuery(controls);
    await button(controls, 'Preview external research').trigger('click');
    await flushPromises();
    await controls.get('input[aria-label="Consent to this exact external preview"]').setValue(true);
    await button(controls, 'Send consented external research').trigger('click');
    await flushPromises();
    expect(controls.text()).toContain(result.code);
    if (result.billing === 'uncertain') expect(controls.text()).toContain('potential billing');
    await wrapper.get('input[type="password"]').setValue('source-password');
    expect(button(wrapper, 'Confirm pattern').attributes('disabled')).toBeUndefined();
    expect(button(controls, 'Send consented external research').attributes('disabled')).toBeDefined();
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/merchant/research')).toHaveLength(1);
  });

  it('shows ancestor denial and saves space opt-in independently with fresh human proof and its own optimistic version', async () => {
    const value = {
      mode: 'external-allowed', allowedProviderIds: ['valueserp'], maxSearchesPerDay: 10,
      maxSpendMinorUnitsPerMonth: 25, billingCurrency: 'USD', cacheTtlHours: 24,
    };
    const policyView = {
      installation: { version: 'installation/7', value: { ...value, mode: 'local-only' } },
      space: { value, version: 9, generation: 2 },
      budget: { value: { ...value, calendar: { budget: null, accounts: [] } }, version: 3, generation: 1 },
      resolved: { mode: 'local-only', allowedProviderIds: [], billingCurrency: 'USD', maxSearchesPerDay: 10,
        maxSpendMinorUnitsPerMonth: 25, cacheTtlHours: 24,
        layers: [{ kind: 'installation', version: 'installation/7', mode: 'local-only', reason: 'local-only' },
          { kind: 'space', version: '9', mode: 'external-allowed', reason: 'allowed' },
          { kind: 'budget', version: '3', mode: 'external-allowed', reason: 'allowed' }] },
    };
    let saved: Record<string, unknown> | undefined;
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      order.push(url);
      if (url === '/api/reauth') return new Response(JSON.stringify({ status: 'success' }));
      if (url === '/api/merchant/space-policy') {
        saved = JSON.parse(String(options?.body));
        return envelope({ ...policyView.space, version: 10 });
      }
      return envelope(policyView);
    }));
    const wrapper = mount(MerchantPolicySettings, { global: presentationGlobal });
    await button(wrapper, 'Load effective research policy and space settings').trigger('click');
    await flushPromises();
    const effective = wrapper.get('[aria-label="Effective research policy"]');
    expect(effective.text()).toContain('local-only');
    expect(effective.text()).toContain('installation/7');
    expect(effective.find('input,select,textarea').exists()).toBe(false);
    const space = wrapper.get('form[aria-label="Space research policy"]');
    expect(button(space, 'Save space research policy').attributes('disabled')).toBeDefined();
    await space.get('input[aria-label="Space daily search quota"]').setValue('8');
    await space.get('input[type="password"]').setValue('source-password');
    await space.trigger('submit');
    await flushPromises();
    expect(saved).toEqual({ expectedVersion: 9, value: { ...value, maxSearchesPerDay: 8 } });
    expect(order.indexOf('/api/reauth')).toBeLessThan(order.indexOf('/api/merchant/space-policy'));
    expect(order.filter(url => url === '/api/merchant/policy')).toHaveLength(0);
    expect(space.get<HTMLInputElement>('input[type="password"]').element.value).toBe('');
    expect(wrapper.get('[aria-label="Effective research policy"]').text()).toContain('local-only');
  });

  it('clears editable space state on optimistic conflict without overriding installation or the saved budget calendar', async () => {
    const value = { mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720 };
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/reauth') return new Response(JSON.stringify({ status: 'success' }));
      if (url === '/api/merchant/space-policy') return new Response(JSON.stringify({ status: 'error', result: null, error: { code: 'CONFLICT' } }), { status: 409 });
      return envelope({ installation: { value, version: 'installation/1' }, space: { value, version: 2, generation: 0 },
        budget: { value, version: 3, generation: 0 }, resolved: { ...value, layers: [] } });
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(MerchantPolicySettings, { global: presentationGlobal });
    await button(wrapper, 'Load effective research policy and space settings').trigger('click');
    await flushPromises();
    const space = wrapper.get('form[aria-label="Space research policy"]');
    await space.get('input[type="password"]').setValue('source-password');
    await space.trigger('submit');
    await flushPromises();
    expect(wrapper.find('form[aria-label="Space research policy"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Refresh and review');
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/merchant/space-policy')).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => url === '/api/merchant/policy')).toBe(false);
  });
});
