import SpendSessionReceiptComparison from '../../app/components/SpendSessionReceiptComparison.vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SpendSessionEvidence from '../../app/components/SpendSessionEvidence.vue';
const request = vi.fn();
const wrappers: VueWrapper[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', request);
  request.mockReset();
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(SpendSessionEvidence, {
    props: { sessionId: 'session', version: 4 },
    global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
  });
  wrappers.push(wrapper);
  return wrapper;
}
const reply = (result: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result, error: null }));
describe('saved Spend Session evidence handoff', () => {
  it('imports only the saved exact version as pending evidence without completing or authorizing a payment', async () => {
    request.mockResolvedValue(reply({ document: { id: 'imported' }, duplicate: false }));
    const wrapper = panel();
    expect(request).not.toHaveBeenCalled();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(request.mock.calls[0]![0]).toBe('/api/evidence/spend-session');
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({
      sessionId: 'session',
      expectedVersion: 4,
    });
    expect(wrapper.text()).toContain('Saved items imported as pending evidence');
    expect(wrapper.findComponent(SpendSessionReceiptComparison).props('documentId')).toBe(
      'imported',
    );
    expect(wrapper.find('a[href="/review#transaction-evidence"]').exists()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('reports unavailable or invalid evidence without confirming an import', async () => {
    request.mockResolvedValue(reply({ accepted: true }));
    const wrapper = panel();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Import unavailable');
    expect(wrapper.text()).not.toContain('Saved items imported');
  });
  it('clears a previous-context result when the saved session changes', async () => {
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const wrapper = panel();
    await wrapper.get('button').trigger('click');
    await wrapper.setProps({ sessionId: 'other', version: 1 });
    complete?.(reply({ document: { id: 'imported' }, duplicate: false }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('Saved items imported');
  });
});
