import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import CategorizationPreview from '../../app/components/CategorizationPreview.vue';
const auth = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../../lib/auth-client', () => ({ authClient: { useSession: () => auth.session } }));
const hash = 'a'.repeat(64);
const report = {
  simulationOnly: true,
  status: 'eligible_on_captured_inputs',
  proposalId: 'proposal',
  payloadHash: hash,
  source: {
    kind: 'locally_observed',
    startedAt: '2026-10-27T08:00:00.000Z',
    completedAt: '2026-10-27T08:00:01.000Z',
    atomic: false,
    serverConfirmed: false,
    maySynchronize: true,
  },
  plan: {
    planId: 'plan',
    transactionId: 'tx',
    currentCategoryId: 'old',
    proposedCategoryId: 'new',
  },
  requiredApprovers: 2,
  reasonCodes: [],
  disclosure:
    'Actual source synchronization may post configured schedules. Execute remains separate.',
};
const wrappers: ReturnType<typeof mount>[] = [];
function page() {
  auth.session = ref({ data: { user: { id: 'human' }, session: { id: 'session' } } });
  const wrapper = mount(CategorizationPreview, {
    props: { proposalId: 'proposal', payloadHash: hash, active: true },
  });
  wrappers.push(wrapper);
  return wrapper;
}
function response(result: unknown) {
  return new Response(JSON.stringify({ status: 'ok', result }));
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.unstubAllGlobals();
});
describe('synchronization-capable categorization preview', () => {
  it('shows an unknown approval requirement as unavailable rather than zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({
            ...report,
            status: 'blocked',
            plan: null,
            requiredApprovers: null,
            reasonCodes: ['idempotency_in_progress'],
          }),
        ),
    );
    const wrapper = page();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Human approval requirement: unavailable');
    expect(wrapper.text()).not.toContain('approvers: 0');
  });
  it('discloses source effects before an explicit click and never calls approval or execution', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(report));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = page();
    expect(wrapper.text()).toContain('configured scheduled transactions');
    expect(fetcher).not.toHaveBeenCalled();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/proposal/proposal/preview',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store' }),
    );
    expect(wrapper.text()).toContain('Eligible on captured inputs');
    expect(wrapper.text()).toContain('not atomic or server-confirmed');
    expect(wrapper.text()).toContain(report.source.startedAt);
    expect(wrapper.text()).toContain('new');
  });
  it.each(['close', 'new-proposal', 'sign-out'] as const)(
    'discards a delayed private response after %s',
    async (kind) => {
      let resolve!: (value: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((fulfill) => {
              resolve = fulfill;
            }),
        ),
      );
      const wrapper = page();
      await wrapper.get('button').trigger('click');
      if (kind === 'close') await wrapper.setProps({ active: false });
      if (kind === 'new-proposal') await wrapper.setProps({ payloadHash: 'b'.repeat(64) });
      if (kind === 'sign-out') {
        (auth.session as ReturnType<typeof ref>).value = { data: null };
        await flushPromises();
      }
      resolve(response(report));
      await flushPromises();
      expect(wrapper.text()).not.toContain('Eligible on captured inputs');
      expect(wrapper.text()).not.toContain('new');
    },
  );
  it.each([
    'wrong-hash',
    'atomic-claim',
    'blocked-with-plan',
    'missing-plan',
    'error',
    'bad-json',
  ] as const)('withholds %s responses and clears previous facts', async (kind) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(report));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = page();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Eligible on captured inputs');
    fetcher.mockResolvedValueOnce(
      kind === 'wrong-hash'
        ? response({ ...report, payloadHash: 'b'.repeat(64) })
        : kind === 'atomic-claim'
          ? response({ ...report, source: { ...report.source, atomic: true } })
          : kind === 'blocked-with-plan'
            ? response({ ...report, status: 'blocked' })
            : kind === 'missing-plan'
              ? response({ ...report, plan: null })
              : kind === 'error'
                ? new Response(
                    JSON.stringify({
                      status: 'error',
                      error: { message: 'private server detail' },
                    }),
                    { status: 403 },
                  )
                : new Response('{'),
    );
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('Eligible on captured inputs');
    expect(wrapper.text()).not.toContain('private server detail');
    expect(wrapper.get('[role="alert"]').text()).toContain('Preview unavailable');
  });
  it('presents blocked and pending-human results without enabling execution', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...report, status: 'approval_required', reasonCodes: ['approval_required'] }),
      )
      .mockResolvedValueOnce(
        response({ ...report, status: 'blocked', plan: null, reasonCodes: ['source_changed'] }),
      );
    vi.stubGlobal('fetch', fetcher);
    const wrapper = page();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Human approval required');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Blocked');
    expect(wrapper.text()).toContain('Preview attempt');
    expect(wrapper.text()).toContain('no usable locally observed assessment');
    expect(wrapper.text()).toContain('source_changed');
    expect(wrapper.findAll('button')).toHaveLength(1);
  });
});
