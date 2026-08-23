import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { DecisionIssue, EvidenceReference } from '@balanceframe/protocol-generated';

import EvidenceDrawer from '../app/components/EvidenceDrawer.vue';
import FindingCard from '../app/components/FindingCard.vue';
import FreshnessBanner from '../app/components/FreshnessBanner.vue';
import InsufficientDataPanel from '../app/components/InsufficientDataPanel.vue';
import ReasonCodeList from '../app/components/ReasonCodeList.vue';
import SemanticAmount from '../app/components/SemanticAmount.vue';

const presentationGlobal = {
  components: {
    EvidenceDrawer,
    ReasonCodeList,
    SemanticAmount,
  },
  stubs: {
    UButton: {
      template: '<button type="button"><slot /></button>',
    },
    UCard: {
      template: '<article><slot /></article>',
    },
  },
};

const visibleEvidence: EvidenceReference = {
  evidenceId: 'transaction-visible-42',
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
    it('shows an authorized reference and a safe placeholder for redacted evidence', async () => {
      const wrapper = mount(EvidenceDrawer, {
        props: {
          references: [visibleEvidence, redactedEvidence],
          snapshotId: 'snapshot-2026-08-23',
          policyVersion: 'decision-policy-v3',
        },
        global: presentationGlobal,
      });

      const toggle = wrapper.get('button');
      expect(toggle.attributes('aria-expanded')).toBe('false');
      await toggle.trigger('click');

      const region = wrapper.get('[role="region"][aria-label="Evidence"]');
      expect(region.text()).toContain('Transaction');
      expect(region.text()).toContain('transaction-visible-42');
      expect(region.text()).toContain('Restricted evidence');
      expect(region.html()).not.toContain(REDACTED_SECRET);
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
    it('presents classification and lifecycle from one shared issue without inventing facts', async () => {
      const wrapper = mount(FindingCard, {
        props: {
          finding: {
            title: 'Transfer needs attention',
            severity: 'warning',
            classification: 'transfer_needs_attention',
            status: 'open',
            issue: blockingIssue,
            snapshotId: 'snapshot-transfer-8',
            policyVersion: 'attention-policy-v2',
          },
        },
        global: presentationGlobal,
      });

      const card = wrapper.get('article[aria-label="Finding: Transfer needs attention"]');
      const cardText = card.text().replace(/\s+/g, ' ').trim();
      expect(cardText).toContain('Transfer Needs Attention');
      expect(cardText).toContain('Open');
      expect(cardText).toContain('Duplicate Transfer Ambiguity');
      expect(cardText).toContain('Warning');
      expect(cardText).toContain('Blocks');
      expect(cardText).toContain('Account: account-checking');
      expect(cardText).toContain('Review the linked transfer entries.');
      expect(cardText).toContain('Snapshot: snapshot-transfer-8');
      expect(cardText).toContain('Policy: attention-policy-v2');
      expect(cardText.split('Review the linked transfer entries.')).toHaveLength(2);
      expect(cardText).not.toContain('0.00');
      expect(cardText).not.toContain('USD');
      expect(cardText).not.toContain('Data current');

      await wrapper.get('button').trigger('click');
      const expandedCardText = card.text().replace(/\s+/g, ' ').trim();
      expect(expandedCardText).toContain('transaction-visible-42');
      expect(expandedCardText.split('transaction-visible-42')).toHaveLength(2);
      expect(wrapper.html()).not.toContain(REDACTED_SECRET);
    });
  });
});
