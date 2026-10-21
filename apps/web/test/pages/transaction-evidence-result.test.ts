import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { TransactionEvidenceResult as Resolution } from '@balanceframe/protocol-generated';
import fixture from '../../../../protocol/fixtures/transaction-evidence.json';
import TransactionEvidenceResult from '../../app/components/TransactionEvidenceResult.vue';

function resolution(): Resolution {
  return {
    contractVersion: '1',
    policyVersion: fixture.policyVersion,
    resolutionHash: 'c'.repeat(64),
    relationships: [],
    wallets: [
      {
        walletId: 'wallet-unknown',
        openingBalance: null,
        closingBalance: null,
        balanceState: 'balance_unknown',
        projection: 'unresolved',
        reasonCodes: ['opening_balance_missing'],
      },
    ],
    receipts: [
      {
        receiptId: 'receipt-mismatch',
        valid: false,
        allocatedDiscount: [],
        allocatedTax: [],
        reasonCodes: ['receipt_total_mismatch'],
      },
    ],
    blockers: [
      { code: 'purpose_unresolved', subjectId: 'received-payment', evidenceIds: ['doc-wallet'] },
    ],
    events: [
      {
        id: 'received-payment',
        version: '1',
        eventType: 'unknown',
        state: 'ambiguous',
        amount: { minorUnits: '9223372036854775807', currency: 'JPY' },
        observationIds: fixture.observations.map((item) => item.id),
        evidenceIds: ['doc-wallet'],
        reasonCodes: ['purpose_unresolved'],
        projectionObservation: null,
      },
    ],
  };
}

describe('transaction evidence result', () => {
  it('shows exact event money, unresolved purpose and missing balance without suggesting income or an Actual write', () => {
    const wrapper = mount(TransactionEvidenceResult, { props: { result: resolution() } });
    expect(wrapper.text()).toContain('9223372036854775807 JPY');
    expect(wrapper.text()).toContain('Needs purpose evidence');
    expect(wrapper.text()).toContain('Opening balance unknown');
    expect(wrapper.text()).toContain('Receipt totals need review');
    expect(wrapper.text()).toContain('doc-wallet');
    expect(wrapper.text()).toContain('c'.repeat(64));
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('Income');
  });

  it('renders untrusted source identifiers as text and clears prior detail when result changes', async () => {
    const result = resolution();
    result.events[0]!.id = '<img src=x onerror=alert(1)>';
    const wrapper = mount(TransactionEvidenceResult, { props: { result } });
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    await wrapper.setProps({
      result: { ...result, events: [], wallets: [], receipts: [], blockers: [] },
    });
    expect(wrapper.text()).not.toContain('doc-wallet');
    expect(wrapper.text()).toContain('No economic events');
  });
});

it('renders each native plural allocation consequence with its exact target and amount', () => {
  const current = resolution();
  const proof = {
    kind: 'economic_event_resolution',
    scope: { kind: 'transaction', id: 'bank-1' },
    state: 'resolved',
    observedAt: null,
    contentHash: null,
    version: null,
    evidence: [],
    ledgerEffect: {
      accountId: 'checking',
      date: '2026-10-16',
      amount: { minorUnits: '-700', currency: 'USD' },
      categoryId: 'food',
      payeeName: null,
      notes: null,
      splits: [],
    },
  };
  current.events[0]!.projectionObservations = [
    proof,
    {
      ...proof,
      scope: { kind: 'transaction', id: 'bank-2' },
      ledgerEffect: { ...proof.ledgerEffect, amount: { minorUnits: '-500', currency: 'USD' } },
    },
  ] as Resolution['events'][number]['projectionObservations'];
  const wrapper = mount(TransactionEvidenceResult, { props: { result: current } });
  expect(wrapper.text()).toContain('bank-1');
  expect(wrapper.text()).toContain('bank-2');
  expect(wrapper.text()).toContain('7.00 USD');
  expect(wrapper.text()).toContain('5.00 USD');
});
