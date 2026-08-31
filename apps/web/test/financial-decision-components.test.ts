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
