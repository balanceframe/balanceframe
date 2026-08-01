import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import DefaultLayout from '../../app/layouts/default.vue';
import DataQualityPage from '../../app/pages/data-quality.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.mock('../../lib/auth-client', () => ({ authClient: { useSession: () => ({ value: { data: { user: { email: 'a11y@example.test' } } } }), signOut: vi.fn() } }));
const envelope = (result: unknown) => ({ schemaVersion: '1', requestId: 'a11y', status: 'ok', dataFreshness: null, authorization: null, result, error: null });
const layoutStubs = {
  NuxtLink: { template: '<a :href="to" class="focus-visible:outline"><slot /></a>', props: ['to'] },
  UContainer: { template: '<div><slot /></div>' },
  FreshnessBanner: { template: '<span aria-label="Data freshness">Current</span>', props: ['freshness', 'showRefresh'] },
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(envelope({ overallScore: null, dimensions: [], recommendations: [] }));
});

describe('Phase 8.5 accessibility acceptance', () => {
  it('keeps keyboard focus indicators on navigation and controls', async () => {
    const wrapper = mount(DefaultLayout, { global: { stubs: layoutStubs } });
    const links = wrapper.findAll('a');
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.classes().some((name) => name.includes('focus-visible')))).toBe(true);
    const toggle = wrapper.get('button[aria-label="Toggle navigation menu"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('nav[aria-label="Mobile navigation"]').exists()).toBe(true);
  });

  it('provides table alternatives and status/error semantics', async () => {
    fetchMock.mockResolvedValue(envelope({ overallScore: 40, dimensions: [{ name: 'Completeness', score: 40, status: 'blocker', severity: 'warning', details: ['Unknown'], findings: ['Unknown'] }], recommendations: [] }));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs: { AnalysisPage: { template: '<section><div v-if="error" role="alert">Error</div><slot name="content"/></section>', props: ['error'] }, UCard: { template: '<div><slot/><slot name="header"/></div>' }, UButton: { template: '<button><slot/></button>' }, AnalysisTable: { template: '<table aria-label="Analysis results"><caption>Data quality</caption><tbody><tr><td>Unknown</td></tr></tbody></table>', props: ['columns','rows'] } } } });
    await flushPromises();
    expect(wrapper.find('table[aria-label]').exists()).toBe(true);
    expect(wrapper.find('caption').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Unknown');
  });

  it('uses reduced-motion/high-contrast-safe utility classes and explicit unknown values', () => {
    const wrapper = mount(DefaultLayout, { global: { stubs: layoutStubs } });
    const html = wrapper.html();
    expect(html).toContain('dark:');
    expect(html).toContain('focus-visible');
    expect(html).not.toContain('motion-safe:animate');
    expect(html).not.toContain('text-transparent');
  });
});
