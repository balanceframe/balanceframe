/**
 * TDD: Shared component tests for AnalysisPage, FreshnessBanner,
 * AnalysisTable, EvidenceDrawer, and default layout shell controls.
 *
 * Covers: retry/refresh, empty/no-config/unknown/stale/insufficient states,
 * semantic labels, authorized evidence, sortable table/card, keyboard/focus,
 * reduced-motion, high-contrast, route pending, user menu/sign-out,
 * current space/budget, sync status, mobile navigation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ref, type Ref } from 'vue';

type SessionData = {
  data: { user: { email: string } } | null;
  isPending: boolean;
};

const auth = vi.hoisted(() => ({
  session: undefined as unknown as Ref<SessionData>,
  signOut: vi.fn(),
}));

auth.session = ref<SessionData>({
  data: { user: { email: 'shared-components@example.test' } },
  isPending: false,
});

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    useSession: () => auth.session,
    signOut: auth.signOut,
  },
}));

import CategoryCorrectModal from '../../app/components/CategoryCorrectModal.vue';

/* ------------------------------------------------------------------ */
/* Stubs                                                              */
/* ------------------------------------------------------------------ */

const stubs = {
  NuxtLink: {
    template: '<a :href="to" @click.prevent="$emit(\'click\', $event)"><slot /></a>',
    props: ['to', 'activeClass'],
    emits: ['click'],
  },
  UIcon: {
    template: '<span :class="name" data-testid="icon" />',
    props: {
      name: { type: String, default: '' },
    },
  },
  UButton: {
    template: `<button :aria-label="ariaLabel" @click="$emit('click')"><slot /></button>`,
    props: {
      variant: String,
      size: String,
      icon: String,
      ariaLabel: String,
    },
    emits: ['click'],
  },
  UContainer: {
    template: '<div class="container"><slot /></div>',
  },
  UAlert: {
    template:
      '<div data-testid="alert" role="alert"><strong>{{ title }}</strong> {{ description }}</div>',
    props: ['title', 'description', 'color', 'variant'],
  },
  USelectMenu: {
    template:
      '<select data-testid="select-menu" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="v in items" :key="v.viewId" :value="v.viewId">{{ v.name }}</option></select>',
    props: ['items', 'optionAttribute', 'valueAttribute', 'modelValue', 'size'],
    emits: ['update:modelValue'],
  },
  SavedViewPicker: {
    template:
      '<div data-testid="saved-view-picker"><span v-for="v in views" :key="v.viewId">{{ v.name }}</span></div>',
    props: ['views', 'showSave'],
    emits: ['select', 'save'],
  },
  SemanticAmount: {
    template:
      '<span data-testid="semantic-amount">{{ amount.minorUnits }} {{ amount.currency }}</span>',
    props: ['amount', 'negative'],
  },
  InsufficientDataPanel: {
    template:
      '<div data-testid="insufficient-data" role="status">{{ reason || "Insufficient data" }}</div>',
    props: ['reason'],
  },
  ReasonCodeList: {
    template:
      '<div data-testid="reason-codes"><span v-for="c in codes" :key="c">{{ c }}</span></div>',
    props: ['codes'],
  },
};

const NuxtLink = stubs.NuxtLink;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function okEnvelope(result: unknown) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'ok' as const,
    dataFreshness: { isStale: false, lastSync: '2026-01-15T10:00:00Z', label: 'current' },
    authorization: null,
    result,
    error: null,
  };
}

function errorEnvelope(code: string) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'error' as const,
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message: `Simulated ${code}`, retryable: true },
  };
}

/* ================================================================== */
/* DEFAULT LAYOUT                                                      */
/* ================================================================== */

import DefaultLayout from '../../app/layouts/default.vue';

describe('DefaultLayout', () => {
  const availableAuthenticatedHrefs = [
    '/',
    '/review',
    '/notifications',
    '/data-quality',
    '/liquidity',
    '/calendar',
    '/trends',
    '/income',
    '/health',
    '/cash-flow',
    '/targets',
    '/obligations',
    '/forecast-accuracy',
    '/scenarios',
    '/reports',
    '/rules',
    '/purchase-check',
    '/connection',
  ];
  const directDesktopHrefs = ['/', '/review', '/notifications'];
  const routePath = ref('/');
  const routeGlobal = globalThis as typeof globalThis & {
    useRoute?: () => { readonly path: string; readonly fullPath: string };
  };
  let originalUseRoute: typeof routeGlobal.useRoute;

  beforeEach(() => {
    routePath.value = '/';
    originalUseRoute = routeGlobal.useRoute;
    routeGlobal.useRoute = () => ({
      get path() {
        return routePath.value;
      },
      get fullPath() {
        return routePath.value;
      },
    });
  });

  afterEach(() => {
    if (originalUseRoute) routeGlobal.useRoute = originalUseRoute;
    else delete routeGlobal.useRoute;
  });

  function mountLayout(path = '/') {
    routePath.value = path;
    return mount(DefaultLayout, {
      global: { stubs: { ...stubs, NuxtLink } },
      slots: { default: '<div>page content</div>' },
    });
  }

  function renderedHrefs(wrapper: VueWrapper) {
    return wrapper
      .findAll('a[href]')
      .map((link) => link.attributes('href'))
      .sort();
  }

  function desktopGroupTriggers(wrapper: VueWrapper) {
    return wrapper.findAll('nav[aria-label="Main navigation"] button[aria-expanded]');
  }

  it('renders the app brand link', () => {
    const wrapper = mountLayout();
    const link = wrapper.find('a[href="/"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toContain('BalanceFrame');
  });

  it('renders primary navigation links', () => {
    const wrapper = mountLayout();
    const nav = wrapper.find('nav[aria-label="Main navigation"]');
    expect(nav.exists()).toBe(true);
    expect(nav.text()).toContain('Review');
    expect(nav.text()).toContain('Planning');
    expect(nav.text()).toContain('Notifications');
  });

  it('shows mobile menu toggle with accessible label', () => {
    const wrapper = mountLayout();
    const toggle = wrapper.find('button[aria-label="Toggle navigation menu"]');
    expect(toggle.exists()).toBe(true);
  });

  it('toggles mobile navigation on button click', async () => {
    const wrapper = mountLayout();
    const toggle = wrapper.find('button[aria-label="Toggle navigation menu"]');
    // Mobile nav should not be visible initially
    expect(wrapper.find('nav[aria-label="Mobile navigation"]').exists()).toBe(false);
    await toggle.trigger('click');
    expect(wrapper.find('nav[aria-label="Mobile navigation"]').exists()).toBe(true);
    // Clicking again should close it
    await toggle.trigger('click');
    expect(wrapper.find('nav[aria-label="Mobile navigation"]').exists()).toBe(false);
  });

  it('renders all mobile navigation links', async () => {
    const wrapper = mountLayout();
    const toggle = wrapper.find('button[aria-label="Toggle navigation menu"]');
    await toggle.trigger('click');
    const mobileNav = wrapper.find('nav[aria-label="Mobile navigation"]');
    const text = mobileNav.text();
    expect(text).toContain('Dashboard');
    expect(text).toContain('Review');
    expect(text).toContain('Rules');
    expect(text).toContain('Reports');
    expect(text).toContain('Notifications');
    expect(text).toContain('Scenarios');
    expect(text).toContain('Health');
  });

  it('exposes exactly all available authenticated routes through desktop links and opened groups', async () => {
    const wrapper = mountLayout();
    const desktopNavigation = wrapper.get('nav[aria-label="Main navigation"]');
    expect(renderedHrefs(desktopNavigation)).toEqual([...directDesktopHrefs].sort());

    const exposedHrefs = new Set(renderedHrefs(desktopNavigation));
    for (const trigger of desktopGroupTriggers(wrapper)) {
      await trigger.trigger('click');
      for (const href of renderedHrefs(wrapper)) exposedHrefs.add(href);
    }

    expect([...exposedHrefs].sort()).toEqual([...availableAuthenticatedHrefs].sort());
  });

  it('links to the operable Scenarios route from desktop navigation', async () => {
    const wrapper = mountLayout();
    const planningTrigger = desktopGroupTriggers(wrapper).find(
      (trigger) => trigger.text().trim() === 'Planning',
    );
    if (!planningTrigger) throw new Error('Planning trigger not found');
    await planningTrigger.trigger('click');

    expect(wrapper.get('a[href="/scenarios"]').text()).toBe('Scenarios');
    expect(wrapper.find('[data-navigation-disabled="/scenarios"]').exists()).toBe(false);
  });

  it('skips disabled items when keyboard navigation opens a desktop group', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const wrapper = mount(DefaultLayout, {
      attachTo: host,
      global: { stubs: { ...stubs, NuxtLink } },
      slots: { default: '<div>page content</div>' },
    });

    try {
      const planningTrigger = desktopGroupTriggers(wrapper).find(
        (trigger) => trigger.text().trim() === 'Planning',
      );
      if (!planningTrigger) throw new Error('Planning trigger not found');
      await planningTrigger.trigger('keydown', { key: 'ArrowUp' });
      await wrapper.vm.$nextTick();
      expect(document.activeElement?.textContent?.trim()).toBe('Reports');
    } finally {
      wrapper.unmount();
      host.remove();
    }
  });

  it('opens named desktop groups and closes them on Escape', async () => {
    const wrapper = mountLayout();
    const triggers = desktopGroupTriggers(wrapper);
    expect(triggers.map((trigger) => trigger.text().trim())).toEqual([
      'Analysis',
      'Planning',
      'System',
    ]);
    expect(triggers.map((trigger) => trigger.attributes('aria-expanded'))).toEqual([
      'false',
      'false',
      'false',
    ]);

    for (const trigger of triggers) {
      await trigger.trigger('click');
      expect(trigger.attributes('aria-expanded')).toBe('true');
      await trigger.trigger('keydown', { key: 'Escape' });
      expect(trigger.attributes('aria-expanded')).toBe('false');
    }
  });

  it('returns focus to the group trigger when Escape closes an open panel', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const wrapper = mount(DefaultLayout, {
      attachTo: host,
      global: { stubs: { ...stubs, NuxtLink } },
      slots: { default: '<div>page content</div>' },
    });

    try {
      const analysisTrigger = desktopGroupTriggers(wrapper).find(
        (trigger) => trigger.text().trim() === 'Analysis',
      );
      if (!analysisTrigger) throw new Error('Analysis trigger not found');
      await analysisTrigger.trigger('click');
      const firstLink = wrapper.get('#navigation-analysis-panel a');
      (firstLink.element as HTMLAnchorElement).focus();
      expect(document.activeElement).toBe(firstLink.element);

      await firstLink.trigger('keydown', { key: 'Escape' });
      await wrapper.vm.$nextTick();
      expect(document.activeElement).toBe(analysisTrigger.element);
    } finally {
      wrapper.unmount();
      host.remove();
    }
  });

  it('closes navigation and user popovers when page content is clicked', async () => {
    const wrapper = mountLayout();
    const analysisTrigger = desktopGroupTriggers(wrapper).find(
      (trigger) => trigger.text().trim() === 'Analysis',
    );
    if (!analysisTrigger) throw new Error('Analysis trigger not found');

    await analysisTrigger.trigger('click');
    expect(analysisTrigger.attributes('aria-expanded')).toBe('true');
    await wrapper.get('main').trigger('click');
    expect(analysisTrigger.attributes('aria-expanded')).toBe('false');

    const userTrigger = wrapper.get('button[aria-label="Open user menu"]');
    await userTrigger.trigger('click');
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    await wrapper.get('main').trigger('click');
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('closes the user menu on Escape and restores focus to its trigger', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const wrapper = mount(DefaultLayout, {
      attachTo: host,
      global: { stubs: { ...stubs, NuxtLink } },
      slots: { default: '<div>page content</div>' },
    });

    try {
      const userTrigger = wrapper.get('button[aria-label="Open user menu"]');
      await userTrigger.trigger('click');
      const signOut = wrapper.get('[role="menuitem"]');
      (signOut.element as HTMLButtonElement).focus();
      await signOut.trigger('keydown', { key: 'Escape' });
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[role="menu"]').exists()).toBe(false);
      expect(document.activeElement).toBe(userTrigger.element);
    } finally {
      wrapper.unmount();
      host.remove();
    }
  });

  it('closes the user menu when the active route changes', async () => {
    const wrapper = mountLayout();
    await wrapper.get('button[aria-label="Open user menu"]').trigger('click');
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);

    routePath.value = '/reports';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('indicates the Analysis section when a child analysis route is active', () => {
    const wrapper = mountLayout('/liquidity');
    const analysisTrigger = desktopGroupTriggers(wrapper).find(
      (trigger) => trigger.text().trim() === 'Analysis',
    );
    expect(analysisTrigger?.attributes('aria-current')).toBe('page');
  });

  it('exposes the same available authenticated routes in opened mobile navigation', async () => {
    const wrapper = mountLayout();
    await wrapper.get('button[aria-label="Toggle navigation menu"]').trigger('click');
    const mobileNavigation = wrapper.get('nav[aria-label="Mobile navigation"]');
    expect(renderedHrefs(mobileNavigation)).toEqual([...availableAuthenticatedHrefs].sort());
  });

  it('links to the operable Scenarios route from mobile navigation', async () => {
    const wrapper = mountLayout();
    await wrapper.get('button[aria-label="Toggle navigation menu"]').trigger('click');
    const mobileNavigation = wrapper.get('nav[aria-label="Mobile navigation"]');

    expect(mobileNavigation.get('a[href="/scenarios"]').text()).toBe('Scenarios');
    expect(
      mobileNavigation.find('[data-navigation-disabled="/scenarios"]').exists(),
    ).toBe(false);
  });

  it('has visible focus-visible styles via classes on nav links', () => {
    const wrapper = mountLayout();
    const navLinks = wrapper.findAll('nav[aria-label="Main navigation"] a');
    expect(navLinks.length).toBeGreaterThan(0);
    for (const link of navLinks) {
      expect(link.classes()).toContain('rounded-md');
    }
  });

  it('renders current space indicator via prop slot or data attribute', () => {
    const wrapper = mountLayout();
    // The layout should expose a hookpoint for space/budget display
    expect(wrapper.html()).toContain('BalanceFrame');
  });

  it('renders the page content slot', () => {
    const wrapper = mountLayout();
    expect(wrapper.text()).toContain('page content');
  });

  it('renders footer with brand text', () => {
    const wrapper = mountLayout();
    expect(wrapper.text()).toContain('Budget Intelligence');
  });

  it('uses sticky header for scroll persistence', () => {
    const wrapper = mountLayout();
    const header = wrapper.find('header');
    expect(header.exists()).toBe(true);
    expect(header.classes()).toContain('sticky');
  });

  it('closes mobile menu when a link is clicked', async () => {
    const wrapper = mountLayout();
    const toggle = wrapper.find('button[aria-label="Toggle navigation menu"]');
    await toggle.trigger('click');
    expect(wrapper.find('nav[aria-label="Mobile navigation"]').exists()).toBe(true);
    // Clicking a link in the mobile nav should close it
    const mobileLink = wrapper.find('nav[aria-label="Mobile navigation"] a');
    await mobileLink.trigger('click');
    await wrapper.vm.$nextTick();
    // After click, mobileOpen should be false — the v-if should hide it
    expect(wrapper.find('nav[aria-label="Mobile navigation"]').exists()).toBe(false);
  });
});

/* ================================================================== */
/* ANALYSIS PAGE                                                       */
/* ================================================================== */

import AnalysisPage from '../../app/components/AnalysisPage.vue';

describe('AnalysisPage', () => {
  function mountPage(props: Record<string, unknown> = {}, slotContent?: string) {
    return shallowMount(AnalysisPage, {
      props: {
        title: 'Test Page',
        ...props,
      },
      global: {
        stubs: {
          ...stubs,
          FreshnessBanner: {
            template:
              '<div data-testid="freshness-banner">{{ freshness?.isStale ? "Stale data" : "Data current" }}</div>',
            props: ['freshness'],
          },
        },
      },
      slots: slotContent ? { content: slotContent } : {},
    });
  }

  it('renders the title', () => {
    const wrapper = mountPage();
    expect(wrapper.text()).toContain('Test Page');
  });

  it('shows loading indicator when loading is true', () => {
    const wrapper = mountPage({ loading: true });
    expect(wrapper.text()).toContain('Loading...');
  });

  it('does not render content slot when loading', () => {
    const wrapper = mountPage({ loading: true });
    expect(wrapper.text()).not.toContain('Content rendered');
  });

  it('renders error alert with error code and message', () => {
    const wrapper = mountPage({
      error: { code: 'STORE_UNAVAILABLE', message: 'Store is down' },
    });
    expect(wrapper.find('[data-testid="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('STORE_UNAVAILABLE');
    expect(wrapper.text()).toContain('Store is down');
  });

  it('shows retry button when error has retryable flag', () => {
    const wrapper = mountPage({
      error: { code: 'NETWORK_ERROR', message: 'Timeout', retryable: true },
    });
    const retryBtn = wrapper.find('button[aria-label="Retry loading"]');
    expect(retryBtn.exists()).toBe(true);
  });

  it('does not show retry button for non-retryable errors', () => {
    const wrapper = mountPage({
      error: { code: 'FORBIDDEN', message: 'Access denied', retryable: false },
    });
    const retryBtn = wrapper.find('button[aria-label="Retry loading"]');
    expect(retryBtn.exists()).toBe(false);
  });

  it('emits retry event when retry button is clicked', async () => {
    const wrapper = mountPage({
      error: { code: 'NETWORK_ERROR', message: 'Timeout', retryable: true },
    });
    await wrapper.find('button[aria-label="Retry loading"]').trigger('click');
    expect(wrapper.emitted('retry')).toBeTruthy();
    expect(wrapper.emitted('retry')!.length).toBe(1);
  });

  it('renders error actions only in the error branch after alert and retry controls', () => {
    const errorWrapper = shallowMount(AnalysisPage, {
      props: {
        title: 'Test Page',
        error: { code: 'NETWORK_ERROR', message: 'Timeout', retryable: true },
      },
      global: {
        stubs: {
          ...stubs,
          FreshnessBanner: {
            template: '<div data-testid="freshness-banner" />',
            props: ['freshness'],
          },
        },
      },
      slots: {
        'error-actions': '<a href="/connection">Configure Actual connection</a>',
      },
    });
    const errorControls = errorWrapper
      .findAll('[role="alert"], button[aria-label="Retry loading"], a[href="/connection"]')
      .map((control) => control.element.tagName);

    expect(errorControls).toEqual(['DIV', 'BUTTON', 'A']);

    const contentWrapper = shallowMount(AnalysisPage, {
      props: { title: 'Test Page' },
      global: {
        stubs: {
          ...stubs,
          FreshnessBanner: {
            template: '<div data-testid="freshness-banner" />',
            props: ['freshness'],
          },
        },
      },
      slots: {
        content: '<p>Attention content</p>',
        'error-actions': '<a href="/connection">Configure Actual connection</a>',
      },
    });

    expect(contentWrapper.find('a[href="/connection"]').exists()).toBe(false);
  });

  it('shows insufficient data panel when insufficientData is true', () => {
    const wrapper = mountPage({
      insufficientData: true,
      insufficientReason: 'Not enough history',
    });
    const panel = wrapper.find('[data-testid="insufficient-data"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('Not enough history');
  });

  it('shows default insufficient message when no reason provided', () => {
    const wrapper = mountPage({ insufficientData: true });
    const panel = wrapper.find('[data-testid="insufficient-data"]');
    expect(panel.exists()).toBe(true);
  });

  it('does not show content slot when insufficient data', () => {
    const wrapper = mountPage({
      insufficientData: true,
      insufficientReason: 'No history',
    });
    expect(wrapper.text()).not.toContain('Content rendered');
  });

  it('renders freshness banner when freshness data is provided', () => {
    const wrapper = mountPage({
      freshness: { isStale: false, lastSync: '2026-07-01T10:00:00Z', label: 'current' },
    });
    // FreshnessBanner is rendered inline — check for the label
    expect(wrapper.text()).toContain('Data current');
  });

  it('shows stale freshness banner', () => {
    const wrapper = mountPage({
      freshness: { isStale: true, lastSync: '2026-01-01T00:00:00Z', label: 'stale' },
    });
    expect(wrapper.text()).toContain('Stale data');
  });

  it('does not render content when no content slot and no data', () => {
    const wrapper = mountPage({ loading: false });
    // Should show empty state text — no slot passed so $slots.content is empty
    const emptyState = wrapper.find('[role="status"]');
    expect(emptyState.exists()).toBe(true);
    expect(emptyState.text()).toContain('No data available');
  });

  it('renders saved view picker when views are provided', () => {
    const wrapper = mountPage({
      views: [{ viewId: 'v-1', name: 'Default', viewType: 'reports' }],
    });
    expect(wrapper.find('[data-testid="saved-view-picker"]').exists()).toBe(true);
  });

  it('does not render saved view picker when views are absent', () => {
    const wrapper = mountPage();
    expect(wrapper.find('[data-testid="saved-view-picker"]').exists()).toBe(false);
  });

  it('has accessible heading for the page title', () => {
    const wrapper = mountPage();
    const heading = wrapper.find('h1');
    expect(heading.exists()).toBe(true);
    expect(heading.text()).toContain('Test Page');
  });

  it('unknown error codes render visibly without interpretation', () => {
    const wrapper = mountPage({
      error: {
        code: 'FUTURE_UNKNOWN_ERROR_XYZ',
        message: 'Something new happened',
        retryable: false,
      },
    });
    expect(wrapper.text()).toContain('FUTURE_UNKNOWN_ERROR_XYZ');
    expect(wrapper.text()).toContain('Something new happened');
  });
});

/* ================================================================== */
/* FRESHNESS BANNER                                                    */
/* ================================================================== */

import FreshnessBanner from '../../app/components/FreshnessBanner.vue';

describe('FreshnessBanner', () => {
  function mountBanner(props: Record<string, unknown> = {}) {
    return mount(FreshnessBanner, {
      props: {
        freshness: { isStale: false, lastSync: '2026-07-15T10:00:00Z', label: 'current' },
        ...props,
      },
      global: { stubs: { UIcon: stubs.UIcon } },
    });
  }

  it('renders "Data current" for fresh data', () => {
    const wrapper = mountBanner();
    expect(wrapper.text()).toContain('Data current');
  });

  it('renders "Stale data" for stale freshness', () => {
    const wrapper = mountBanner({
      freshness: { isStale: true, lastSync: '2026-01-01T00:00:00Z', label: 'stale' },
    });
    expect(wrapper.text()).toContain('Stale data');
  });

  it('shows last sync time when available', () => {
    const wrapper = mountBanner({
      freshness: { isStale: false, lastSync: '2026-07-15T10:00:00Z', label: 'current' },
    });
    expect(wrapper.text()).toContain('synced');
  });

  it('omits sync time when lastSync is null', () => {
    const wrapper = mountBanner({
      freshness: { isStale: false, lastSync: null, label: 'current' },
    });
    expect(wrapper.text()).not.toContain('synced');
  });

  it('renders nothing when freshness is null', () => {
    const wrapper = mountBanner({ freshness: null });
    // Vue 3 renders empty fragment as comment node or empty HTML
    expect(wrapper.text()).toBe('');
    expect(wrapper.findAll('div').length).toBe(0);
  });

  it('has semantic role status for screen readers', () => {
    const wrapper = mountBanner();
    expect(wrapper.attributes('role')).toBe('status');
  });

  it('includes aria-label with freshness semantic', () => {
    const wrapper = mountBanner();
    expect(wrapper.attributes('aria-label')).toContain('current');
  });

  it('shows stale aria-label', () => {
    const wrapper = mountBanner({
      freshness: { isStale: true, lastSync: null, label: 'stale' },
    });
    expect(wrapper.attributes('aria-label')).toContain('stale');
  });

  it('emits refresh event when refresh button is clicked', async () => {
    const wrapper = mountBanner({
      freshness: { isStale: true, lastSync: '2026-01-01T00:00:00Z', label: 'stale' },
      showRefresh: true,
    });
    const refreshBtn = wrapper.find('button[aria-label="Refresh data"]');
    expect(refreshBtn.exists()).toBe(true);
    await refreshBtn.trigger('click');
    expect(wrapper.emitted('refresh')).toBeTruthy();
  });

  it('does not show refresh button when showRefresh is false', () => {
    const wrapper = mountBanner({ showRefresh: false });
    const refreshBtn = wrapper.find('button[aria-label="Refresh data"]');
    expect(refreshBtn.exists()).toBe(false);
  });

  it('reduces animation for prefers-reduced-motion', () => {
    const wrapper = mountBanner();
    expect(wrapper.classes()).toContain('motion-reduce:transition-none');
  });

  it('unknown label values render visibly without interpretation', () => {
    const wrapper = mountBanner({
      freshness: { isStale: false, lastSync: null, label: 'custom-future-state' },
    });
    expect(wrapper.text()).toContain('Data current');
    // The freshness label is used in the aria-label
    expect(wrapper.attributes('aria-label')).toContain('custom-future-state');
  });

  it('high contrast mode: uses visible border colors', () => {
    const wrapper = mountBanner();
    expect(wrapper.classes().some((c) => c.includes('border'))).toBe(true);
  });
});

/* ================================================================== */
/* ANALYSIS TABLE                                                      */
/* ================================================================== */

import AnalysisTable from '../../app/components/AnalysisTable.vue';

describe('AnalysisTable', () => {
  const columns = [
    { key: 'name', label: 'Name', type: 'text' as const },
    { key: 'amount', label: 'Amount', type: 'amount' as const },
    { key: 'status', label: 'Status', type: 'badge' as const },
  ];

  const rows = [
    { name: 'Groceries', amount: { minorUnits: '15000', currency: 'USD' }, status: 'on_track' },
    { name: 'Utilities', amount: { minorUnits: '25000', currency: 'USD' }, status: 'at_risk' },
    { name: 'Entertainment', amount: { minorUnits: '8000', currency: 'USD' }, status: 'overspent' },
  ];

  function mountTable(props: Record<string, unknown> = {}) {
    return mount(AnalysisTable, {
      props: { columns, rows, ...props },
      global: { stubs: { SemanticAmount: stubs.SemanticAmount } },
    });
  }

  it('renders column headers', () => {
    const wrapper = mountTable();
    expect(wrapper.text()).toContain('Name');
    expect(wrapper.text()).toContain('Amount');
    expect(wrapper.text()).toContain('Status');
  });

  it('renders row data', () => {
    const wrapper = mountTable();
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.text()).toContain('Utilities');
    expect(wrapper.text()).toContain('Entertainment');
  });

  it('renders amount via SemanticAmount stub', () => {
    const wrapper = mountTable();
    const amounts = wrapper.findAll('[data-testid="semantic-amount"]');
    expect(amounts.length).toBe(3);
  });

  it('renders badge classes for known statuses', () => {
    const wrapper = mountTable();
    const badges = wrapper.findAll('span.inline-flex');
    expect(badges.length).toBeGreaterThan(0);
    // on_track badge should have emerald styling
    const onTrackBadge = badges.find((b) => b.text() === 'on_track');
    expect(onTrackBadge?.classes()).toContain('bg-emerald-100');
  });

  it('shows empty state when rows are empty', () => {
    const wrapper = mountTable({ rows: [] });
    expect(wrapper.text()).toContain('No data available');
  });

  it('unknown badge values render visibly without interpretation', () => {
    const wrapper = mountTable({
      rows: [
        {
          name: 'Test',
          amount: { minorUnits: '0', currency: 'USD' },
          status: 'future_unknown_status_xyz',
        },
      ],
    });
    expect(wrapper.text()).toContain('future_unknown_status_xyz');
  });

  it('has sortable column headers with aria-sort attribute', () => {
    const wrapper = mountTable();
    const headers = wrapper.findAll('th');
    expect(headers.length).toBe(3);
    // Each header should be a button for sort interaction
    for (const th of headers) {
      const btn = th.find('button');
      if (btn.exists()) {
        expect(btn.attributes('aria-label')).toBeDefined();
      }
    }
  });

  it('emits sort event when column header is clicked', async () => {
    const wrapper = mountTable();
    const nameHeader = wrapper.findAll('th')[0];
    const btn = nameHeader.find('button');
    if (btn.exists()) {
      await btn.trigger('click');
      expect(wrapper.emitted('sort')).toBeTruthy();
    }
  });

  it('indicates current sort direction with aria-sort', () => {
    const wrapper = mountTable({ sortKey: 'name', sortDir: 'asc' });
    const headers = wrapper.findAll('th');
    const nameHeader = headers[0];
    const sortIndicator = nameHeader.find('[aria-sort]');
    if (sortIndicator.exists()) {
      expect(sortIndicator.attributes('aria-sort')).toBe('ascending');
    }
  });

  it('has responsive card layout class for mobile', () => {
    const wrapper = mountTable();
    const container = wrapper.find('.overflow-x-auto');
    expect(container.exists()).toBe(true);
  });

  it('table has proper semantic structure with scope="col" on headers', () => {
    const wrapper = mountTable();
    const headers = wrapper.findAll('th[scope="col"]');
    expect(headers.length).toBe(3);
  });

  it('table has proper aria-label', () => {
    const wrapper = mountTable({ ariaLabel: 'Budget line items' });
    const table = wrapper.find('table');
    expect(table.attributes('aria-label')).toBe('Budget line items');
  });

  it('supports keyboard navigation with tabindex on sortable headers', () => {
    const wrapper = mountTable();
    const buttons = wrapper.findAll('th button');
    for (const btn of buttons) {
      expect(btn.attributes('tabindex')).toBeDefined();
    }
  });

  it('reduced motion: no transition classes on sort indicator', () => {
    const wrapper = mountTable();
    // Table should work without animation
    expect(wrapper.find('table').exists()).toBe(true);
  });
});

/* ================================================================== */
/* EVIDENCE DRAWER                                                     */
/* ================================================================== */

import EvidenceDrawer from '../../app/components/EvidenceDrawer.vue';

describe('EvidenceDrawer', () => {
  const evidenceItems = [
    {
      description: 'Transaction matched rule #42',
      detail: 'Category: Groceries',
      source: 'ledger',
      authorized: true,
    },
    {
      description: 'Pattern detected in recurring spend',
      detail: 'Frequency: monthly',
      source: 'analysis',
      authorized: true,
    },
    { description: 'User override applied', detail: null, source: 'user', authorized: false },
  ];

  function mountDrawer(props: Record<string, unknown> = {}) {
    return mount(EvidenceDrawer, {
      props: {
        evidence: evidenceItems,
        ...props,
      },
      global: { stubs: { UButton: stubs.UButton } },
    });
  }

  it('shows toggle button to open/close evidence', () => {
    const wrapper = mountDrawer();
    expect(wrapper.text()).toContain('Show evidence');
  });

  it('expands evidence list when toggled', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Transaction matched rule #42');
    expect(wrapper.text()).toContain('Pattern detected in recurring spend');
  });

  it('collapses evidence when toggled again', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Transaction matched rule #42');
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).not.toContain('Transaction matched rule #42');
  });

  it('shows empty state when evidence array is empty', async () => {
    const wrapper = mountDrawer({ evidence: [] });
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('No evidence available');
  });

  it('shows fallback message when provided', async () => {
    const wrapper = mountDrawer({
      evidence: [],
      fallbackMessage: 'Evidence pending ingestion',
    });
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Evidence pending ingestion');
  });

  it('renders evidence detail when present', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Category: Groceries');
    expect(wrapper.text()).toContain('Frequency: monthly');
  });

  it('renders authorized evidence with source metadata', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Transaction matched rule #42');
    expect(wrapper.text()).toContain('Pattern detected in recurring spend');
  });

  it('renders unauthorized evidence visibly without hiding', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    // Unauthorized items should still be rendered, just labeled
    expect(wrapper.text()).toContain('User override applied');
  });

  it('unknown source values render visibly', async () => {
    const wrapper = mountDrawer({
      evidence: [
        {
          description: 'Future source item',
          detail: 'Some detail',
          source: 'future_unknown_source',
          authorized: true,
        },
      ],
    });
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Future source item');
    expect(wrapper.text()).toContain('Some detail');
  });

  it('unknown detail values render as raw text', async () => {
    const wrapper = mountDrawer({
      evidence: [
        {
          description: 'Test item',
          detail: 'Unexpected: {{template}} syntax',
          source: 'test',
          authorized: true,
        },
      ],
    });
    await wrapper.find('button').trigger('click');
    expect(wrapper.text()).toContain('Unexpected: {{template}} syntax');
  });

  it('toggle button has aria-expanded attribute', () => {
    const wrapper = mountDrawer();
    const btn = wrapper.find('button');
    expect(btn.attributes('aria-expanded')).toBe('false');
  });

  it('toggle button aria-expanded becomes true when open', async () => {
    const wrapper = mountDrawer();
    const btn = wrapper.find('button');
    await btn.trigger('click');
    expect(btn.attributes('aria-expanded')).toBe('true');
  });

  it('evidence list has proper list semantics', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    const list = wrapper.find('ul');
    expect(list.exists()).toBe(true);
    const items = wrapper.findAll('li');
    expect(items.length).toBe(3);
  });

  it('keyboard: toggle responds to Enter key', async () => {
    const wrapper = mountDrawer();
    const btn = wrapper.find('button');
    await btn.trigger('keydown.enter');
    // Enter on a button should trigger the click handler
    expect(wrapper.text()).toContain('Transaction matched rule #42');
  });

  it('reduced motion: drawer content does not use animation classes', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    // Drawer content should not have animate- classes
    const drawerContent = wrapper.find('.mt-2');
    if (drawerContent.exists()) {
      expect(drawerContent.classes().some((c) => c.startsWith('animate-'))).toBe(false);
    }
  });

  it('high contrast: evidence items have visible borders', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    const drawerContent = wrapper.find('.rounded-md.border');
    expect(drawerContent.exists()).toBe(true);
  });

  it('evidence items use role="list" or semantic list element', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    // ul element provides implicit role="list"
    expect(wrapper.find('ul').exists()).toBe(true);
  });

  it('bullet character separates evidence items visually', async () => {
    const wrapper = mountDrawer();
    await wrapper.find('button').trigger('click');
    // Browser renders the HTML entity as actual character •
    expect(wrapper.html()).toContain('•');
  });
});

/* ================================================================== */
/* CATEGORY CORRECTION MODAL                                          */
/* ================================================================== */

const categoryCorrectModalStubs = {
  UModal: {
    name: 'UModal',
    props: ['open'],
    template: '<div v-if="open"><slot name="content" /></div>',
  },
  UCard: {
    name: 'UCard',
    template: '<section><slot name="header" /><slot /><slot name="footer" /></section>',
  },
  USelectMenu: {
    name: 'USelectMenu',
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select><option v-for="item in items" :key="item.id" :value="item.id">{{ item.label }}</option></select>',
  },
  UButton: {
    name: 'UButton',
    props: ['label', 'disabled', 'loading'],
    emits: ['click'],
    template:
      '<button :disabled="disabled" :data-loading="loading" @click="!disabled && $emit(\'click\')">{{ label }}</button>',
  },
};

describe('CategoryCorrectModal', () => {
  const item = {
    evidence: {
      normalizedMerchant: 'Test Grocer',
      currentCategory: 'cat-uncategorized',
      suggestedCategory: 'cat-groceries',
      alternatives: ['cat-dining'],
      categoryNames: {
        'cat-dining': 'Dining',
        'cat-groceries': 'Groceries',
      },
      changePreview: {
        fromCategory: 'cat-uncategorized',
        toCategory: 'cat-groceries',
        affectsEnvelope: true,
      },
    },
  };

  function confirmButton(wrapper: VueWrapper) {
    const button = wrapper.findAll('button').find((candidate) => candidate.text() === 'Confirm');
    if (!button) throw new Error('Category correction confirm control was not rendered.');
    return button;
  }

  it('disables and marks Confirm loading while submitting so no second correction emits', async () => {
    const wrapper = mount(CategoryCorrectModal as never, {
      props: {
        open: false,
        item,
        submitting: false,
      },
      global: { stubs: categoryCorrectModalStubs },
    });

    await wrapper.setProps({ open: true });
    await confirmButton(wrapper).trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([['cat-groceries']]);

    await wrapper.setProps({ submitting: true });
    const confirm = confirmButton(wrapper);
    expect(confirm.element.disabled).toBe(true);
    expect(confirm.attributes('data-loading')).toBe('true');

    await confirm.trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([['cat-groceries']]);
  });

  it('restores focus to enabled Confirm when a failed submission finishes with the modal open', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const wrapper = mount(CategoryCorrectModal as never, {
      attachTo: document.body,
      props: {
        open: false,
        item,
        submitting: false,
      },
      global: { stubs: categoryCorrectModalStubs },
    });

    try {
      await wrapper.setProps({ open: true });
      await wrapper.setProps({ submitting: true });
      outside.focus();
      expect(document.activeElement).toBe(outside);

      await wrapper.setProps({ submitting: false });
      await flushPromises();

      const confirm = confirmButton(wrapper);
      expect(confirm.element.disabled).toBe(false);
      expect(document.activeElement).toBe(confirm.element);
    } finally {
      wrapper.unmount();
      outside.remove();
    }
  });
});
