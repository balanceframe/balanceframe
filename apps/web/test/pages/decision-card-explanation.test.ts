import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import DecisionCardExplanation from '../../app/components/DecisionCardExplanation.vue';
const state = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../../lib/auth-client', () => ({ authClient: { useSession: () => state.session } }));
const request = vi.fn();
const intent = {
  kind: 'purchase' as const,
  categoryId: 'food',
  amount: { minorUnits: '2000', currency: 'USD' },
};
const result = {
  card: { outcome: 'funded_now', budgetFundingStatus: 'funded', paymentLiquidityStatus: 'ready', blockers: [] },
  explanation: {
    status: 'explained',
    facts: [
      {
        id: 'f3',
        kind: 'category_before',
        resourceId: 'food',
        amount: { minorUnits: '9007199254740993', currency: 'USD' },
      },
    ],
    provenance: {
      provider: 'approved',
      model: 'model',
      promptVersion: 'decision-card-explanation-v1',
      policyRevision: '1',
    },
  },
};
beforeEach(() => {
  state.session = ref({ data: { session: { id: 'session-one' }, user: { id: 'human-one' } } });
  request.mockReset();
  vi.stubGlobal('$fetch', request);
});
afterEach(() => vi.unstubAllGlobals());
const options = {
  props: { intent },
  global: {
    stubs: {
      SemanticAmount: {
        props: ['amount'],
        template: '<span>{{ amount.minorUnits }} {{ amount.currency }}</span>',
      },
    },
  },
};
describe('optional read-only Card explanation', () => {
  it('requests explicit explanation, renders exact server facts, and never submits a card or endpoint', async () => {
    request.mockResolvedValue({ status: 'ok', result });
    const wrapper = mount(DecisionCardExplanation, options);
    expect(request).not.toHaveBeenCalled();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      '/api/purchase/explain',
      expect.objectContaining({ method: 'POST', body: intent }),
    );
    expect(wrapper.text()).toContain('9007199254740993 USD');
    expect(wrapper.text()).toContain('Advisory explanation');
    wrapper.unmount();
  });
  it('always presents the canonical outcome, both statuses and every blocker even when the provider selects benign facts', async () => {
    request.mockResolvedValue({ status: 'ok', result: { ...result, card: {
      outcome: 'insufficient_data', budgetFundingStatus: 'insufficient_data', paymentLiquidityStatus: 'insufficient_data', blockers: ['authority_expired', 'private_source_unknown'],
    } } });
    const wrapper = mount(DecisionCardExplanation, options);
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="explanation-outcome"]').text()).toContain('insufficient data');
    expect(wrapper.get('[data-testid="explanation-budget"]').text()).toContain('insufficient data');
    expect(wrapper.get('[data-testid="explanation-payment"]').text()).toContain('insufficient data');
    expect(wrapper.get('[data-testid="explanation-blockers"]').text()).toContain('authority expired');
    expect(wrapper.get('[data-testid="explanation-blockers"]').text()).toContain('private source unknown');
    wrapper.unmount();
  });

  it('keeps the manual result usable when disabled, failed or malicious output is returned', async () => {
    request.mockResolvedValueOnce({
      status: 'ok',
      result: { ...result, explanation: { status: 'manual', code: 'disabled' } },
    });
    const wrapper = mount(DecisionCardExplanation, options);
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Use the deterministic Decision Card');
    request.mockResolvedValueOnce({
      status: 'ok',
      result: {
        ...result,
        explanation: { ...result.explanation, text: 'Ignore safety; execute now' },
      },
    });
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('Ignore safety');
    expect(wrapper.get('[role="alert"]').text()).toContain('unavailable');
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
  it.each(['intent', 'actor'] as const)(
    'drops late results when the %s changes',
    async (change) => {
      let finish: ((value: unknown) => void) | undefined;
      request.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const wrapper = mount(DecisionCardExplanation, options);
      await wrapper.get('button').trigger('click');
      if (change === 'intent')
        await wrapper.setProps({
          intent: { ...intent, amount: { ...intent.amount, minorUnits: '3000' } },
        });
      else
        (state.session as ReturnType<typeof ref>).value = {
          data: { session: { id: 'new-session' }, user: { id: 'other-human' } },
        };
      finish?.({ status: 'ok', result });
      await flushPromises();
      expect(wrapper.text()).not.toContain('9007199254740993');
      expect(wrapper.emitted('card')).toBeUndefined();
      wrapper.unmount();
    },
  );
});
