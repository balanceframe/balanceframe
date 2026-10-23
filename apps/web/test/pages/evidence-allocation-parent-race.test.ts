import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { TransactionEvidenceResultSchema } from '@balanceframe/protocol-generated/validators';
import TransactionEvidencePanel from '../../app/components/TransactionEvidencePanel.vue';
import EvidenceSettlementAllocation from '../../app/components/EvidenceSettlementAllocation.vue';
import source from '../../../../protocol/fixtures/evidence-settlement-plan.json';
import fixture from '../../../../protocol/fixtures/transaction-evidence-result.json';

const request = vi.fn();
const wrappers: VueWrapper[] = [];
const reply = (result: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result, error: null }));
const document = {
  id: 'allocation-source',
  connectorId: 'retail-import',
  sourceId: 'two-receipts',
  sourceTimestamp: '2026-10-15T12:00:00Z',
  receivedAt: '2026-10-15T12:01:00Z',
  mediaType: 'application/json',
  parserVersion: 'retail-v1',
  contentHash: 'a'.repeat(64),
  parseStatus: 'parsed',
  retentionUntil: '2026-10-22T12:00:00Z',
  quality: ['user_import'],
  extraction: {
    observations: source.evidence.observations
      .filter((observation) => observation.kind !== 'ledger_transaction')
      .map(({ provenance: _provenance, ...observation }) => observation),
    receipts: source.evidence.receipts,
  },
};
const resolution = {
  ...fixture,
  events: source.evidence.receipts.map((receipt, index) => ({
    ...fixture.events[0]!,
    id: `allocation-event-${index}`,
    observationIds: [receipt.observationId],
    evidenceIds: [document.id],
    projectionObservation: null,
  })),
  receipts: source.evidence.receipts.map((receipt) => ({
    receiptId: receipt.id,
    valid: true,
    allocatedDiscount: [],
    allocatedTax: [],
    reasonCodes: [],
  })),
};
const targets = {
  accounts: [{ id: 'checking', name: 'Checking' }],
  categories: [{ id: 'food', name: 'Food' }],
};

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('allocation completion during parent target refresh', () => {
  it('releases the parent loading state and ignores its stale target response', async () => {
    request.mockImplementation(async (url: string) =>
      url === '/api/evidence/health' ? reply({ connectors: [] }) : reply({ documents: [document] }),
    );
    const wrapper = mount(TransactionEvidencePanel, {
      global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
    });
    wrappers.push(wrapper);
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(reply(resolution));
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(reply(targets));
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();

    const allocation = wrapper.getComponent(EvidenceSettlementAllocation);
    let finishTargets!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishTargets = resolve;
        }),
    );
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="load-evidence"]').element.disabled).toBe(
      true,
    );

    // The child owns an independent save request, so it can finish during this refresh.
    allocation.vm.$emit(
      'saved',
      TransactionEvidenceResultSchema.parse({ ...resolution, resolutionHash: 'b'.repeat(64) }),
    );
    await flushPromises();
    expect(wrapper.text()).toContain('Reviewed allocation saved');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="load-evidence"]').element.disabled).toBe(
      false,
    );

    finishTargets(reply(targets));
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="load-evidence"]').element.disabled).toBe(
      false,
    );
    expect(wrapper.findComponent(EvidenceSettlementAllocation).exists()).toBe(false);
  });
});
