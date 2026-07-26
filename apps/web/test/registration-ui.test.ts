/**
 * Behavior-focused tests for registration UI components.
 *
 * Covers the five observable contracts without brittle snapshot assertions:
 *   1. Login — no public sign-up call or control
 *   2. Setup — renders/submits only when bootstrapAvailable
 *   3. Invite — reads token fragment, clears with replaceState, redirects
 *      to /login after success, never persists token
 *   4. Index — no public "Create account" affordance
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { Component } from 'vue';

// ---------------------------------------------------------------------------
// Mock shared dependencies — vi.hoisted ensures these are defined before
// vi.mock factory runs (since vi.mock is hoisted to the top of the file).
// ---------------------------------------------------------------------------

const { mockSignInEmail, mockSignUpEmail, mockSignOut, mockUseSession } = vi.hoisted(() => {
  const mockSignInEmail = vi.fn();
  const mockSignUpEmail = vi.fn();
  const mockSignOut = vi.fn();
  const mockUseSession = vi.fn(() => ({ value: { data: null, isPending: false } }));
  return { mockSignInEmail, mockSignUpEmail, mockSignOut, mockUseSession };
});

vi.mock('../lib/auth-client', () => ({
  authClient: {
    signIn: { email: mockSignInEmail },
    signUp: { email: mockSignUpEmail },
    signOut: mockSignOut,
    useSession: mockUseSession,
  },
}));

import LoginPage from '../app/pages/login.vue';
import SetupPage from '../app/pages/setup.vue';
import InvitePage from '../app/pages/invite.vue';
import IndexPage from '../app/pages/index.vue';

// ---------------------------------------------------------------------------
// Typed accessors for globals set up in vitest.setup.ts
// ---------------------------------------------------------------------------

/** Typed reference to the mocked global $fetch (ofetch) function. */
function getFetchMock(): ReturnType<typeof vi.fn> {
  // vi.stubGlobal('$fetch', vi.fn()) in vitest.setup.ts supplies this global
  const g = globalThis as unknown as { $fetch: ReturnType<typeof vi.fn> };
  const f = g.$fetch;
  if (!f) throw new Error('$fetch mock not configured in vitest.setup.ts');
  return f;
}

function getNavigateToMock(): ReturnType<typeof vi.fn> {
  // vi.stubGlobal('navigateTo', vi.fn()) in vitest.setup.ts supplies this global
  const g = globalThis as unknown as { navigateTo: ReturnType<typeof vi.fn> };
  const n = g.navigateTo;
  if (!n) throw new Error('navigateTo mock not configured in vitest.setup.ts');
  return n;
}


// ---------------------------------------------------------------------------
// Shared component stubs
// ---------------------------------------------------------------------------

const uiStubs: Record<string, Component> = {
  UContainer: { template: '<div class="ui-container"><slot /></div>' },
  UCard: {
    template:
      '<div class="ui-card"><slot name="header" /><slot /><slot name="footer" /></div>',
  },
  UForm: { template: '<form class="ui-form"><slot /></form>' },
  UFormField: {
    props: ['label'],
    template: '<div class="ui-form-field"><label>{{ label }}</label><slot /></div>',
  },
  UInput: {
    props: ['modelValue', 'type', 'placeholder'],
    template:
      '<input class="ui-input" :type="type" :placeholder="placeholder" :value="modelValue" />',
  },
  UButton: {
    props: ['type', 'loading', 'to', 'label'],
    template:
      '<button :type="type" :class="loading && \'loading\'" class="ui-button" @click="$emit(\'click\', $event)"><slot />{{ label }}</button>',
  },
  UAlert: { props: ['title'], template: '<div class="ui-alert">{{ title }}<slot /></div>' },
  NuxtLink: {
    props: ['to'],
    template: '<a :href="to" class="nuxt-link"><slot /></a>',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance microtask queue and Vue reactivity. */
async function flush() {
  await nextTick();
}

const configResponse = {
  registrationMode: 'bootstrap',
  bootstrapAvailable: true,
};
const inviteConfigResponse = {
  registrationMode: 'invite',
  bootstrapAvailable: false,
};

// ---------------------------------------------------------------------------
// 1. Login — no public sign-up
// ---------------------------------------------------------------------------

describe('login.vue — sign-in only, no sign-up affordance', () => {
  let wrapper: ReturnType<typeof mount>;

  beforeEach(async () => {
    vi.clearAllMocks();
    getFetchMock().mockResolvedValue(configResponse);
    wrapper = mount(LoginPage, { global: { stubs: uiStubs } });
    await flush();
  });

  it('does not call authClient.signUp anywhere', () => {
    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });

  it('renders a sign-in form with email and password inputs', () => {
    const inputs = wrapper.findAll('input');
    const emailInputs = inputs.filter(
      (i) => i.attributes('type') === 'email',
    );
    const passwordInputs = inputs.filter(
      (i) => i.attributes('type') === 'password',
    );
    expect(emailInputs.length).toBeGreaterThanOrEqual(1);
    expect(passwordInputs.length).toBeGreaterThanOrEqual(1);
    expect(wrapper.text()).toContain('Sign in');
  });

  it('has no "Create account" button or sign-up form', () => {
    expect(wrapper.text()).not.toMatch(/create.?account/i);
    expect(wrapper.text()).not.toMatch(/sign.?up/i);
  });

  it('calls authClient.signIn.email and navigates to /review on valid submit', async () => {
    mockSignInEmail.mockResolvedValueOnce({ error: null });
    const navigateToMock = getNavigateToMock();

    wrapper.vm.signInEmail = 'a@b.com';
    wrapper.vm.signInPassword = 'secret';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    expect(mockSignInEmail).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'secret',
    });
    expect(navigateToMock).toHaveBeenCalledWith('/review');
  });

  it('shows error when sign-in fails', async () => {
    mockSignInEmail.mockResolvedValueOnce({
      error: { message: 'Invalid credentials' },
    });
    const navigateToMock = getNavigateToMock();

    wrapper.vm.signInEmail = 'bad@example.com';
    wrapper.vm.signInPassword = 'wrong';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    expect(wrapper.text()).toContain('Invalid credentials');
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('shows "Set up this instance" link when bootstrapAvailable', async () => {
    getFetchMock().mockResolvedValueOnce(configResponse);
    wrapper = mount(LoginPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('Set up this instance');
  });

  it('shows invitation instruction when bootstrap is not available', async () => {
    getFetchMock().mockResolvedValueOnce(inviteConfigResponse);
    wrapper = mount(LoginPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('invitation link');
  });
});

// ---------------------------------------------------------------------------
// 2. Setup — renders/submits only when bootstrapAvailable
// ---------------------------------------------------------------------------

describe('setup.vue — bootstrap flow gate', () => {
  let wrapper: ReturnType<typeof mount>;

  it('shows loading state initially', async () => {
    getFetchMock().mockReturnValue(new Promise(() => {})); // never resolves
    wrapper = mount(SetupPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('Loading');
  });

  it('renders the bootstrap form when bootstrapAvailable is true', async () => {
    getFetchMock().mockResolvedValue(configResponse);
    wrapper = mount(SetupPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('Bootstrap secret');
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('shows "already been set up" when bootstrapAvailable is false', async () => {
    getFetchMock().mockResolvedValue(inviteConfigResponse);
    wrapper = mount(SetupPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('already been set up');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('calls bootstrap API and navigates to /login on success', async () => {
    const fetchMock = getFetchMock();
    const navigateToMock = getNavigateToMock();
    fetchMock.mockResolvedValue(configResponse);
    wrapper = mount(SetupPage, { global: { stubs: uiStubs } });
    await flush();

    // The bootstrap $fetch was already called for config in onMounted.
    // Set up the next call for the submit.
    fetchMock.mockResolvedValueOnce(undefined);

    wrapper.vm.name = 'Owner';
    wrapper.vm.email = 'owner@example.com';
    wrapper.vm.password = 'secure-password';
    wrapper.vm.bootstrapSecret = 'my-secret';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    // Should have called the bootstrap endpoint
    const fetchCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as string) === '/api/registration/bootstrap',
    );
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0][1]).toEqual({
      method: 'POST',
      body: {
        name: 'Owner',
        email: 'owner@example.com',
        password: 'secure-password',
        bootstrapSecret: 'my-secret',
      },
    });

    expect(navigateToMock).toHaveBeenCalledWith('/login');
  });

  it('shows error text on bootstrap failure', async () => {
    const fetchMock = getFetchMock();
    const navigateToMock = getNavigateToMock();
    fetchMock.mockResolvedValue(configResponse);
    wrapper = mount(SetupPage, { global: { stubs: uiStubs } });
    await flush();

    // Reject the submit call
    fetchMock.mockRejectedValueOnce(new Error('Invalid secret'));

    wrapper.vm.name = 'Owner';
    wrapper.vm.email = 'owner@example.com';
    wrapper.vm.password = 'secure-password';
    wrapper.vm.bootstrapSecret = 'bad-secret';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    expect(wrapper.text()).toContain('Invalid secret');
    // Should NOT navigate on error
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('does not persist the bootstrap secret to storage', async () => {
    // The secret is held in a reactive ref only.
    // Verify no localStorage/sessionStorage interaction.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValue(configResponse);
    wrapper = mount(SetupPage, { global: { stubs: uiStubs } });
    await flush();

    wrapper.vm.bootstrapSecret = 'super-secret-value';
    await flush();

    // Simulate submit (even if it fails, the secret shouldn't be stored)
    fetchMock.mockRejectedValueOnce(new Error('fail'));
    await wrapper.find('form').trigger('submit');
    await flush();

    // No storage write should have occurred with the secret
    const secretWrites = setItem.mock.calls.filter(
      ([key]: unknown[]) => typeof key === 'string' && /secret/i.test(key),
    );
    expect(secretWrites).toHaveLength(0);
    setItem.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. Invite — fragment token, replaceState, redirect, no persistence
// ---------------------------------------------------------------------------

describe('invite.vue — token fragment handling and redemption', () => {
  let wrapper: ReturnType<typeof mount>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset location hash
    window.location.hash = '';
  });

  it('reads token from URL fragment and clears it with replaceState on mount', async () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    window.location.hash = '#token=abc123';

    wrapper = mount(InvitePage, { global: { stubs: uiStubs } });
    await flush();

    // Token should be extracted into the reactive ref
    expect(wrapper.vm.token).toBe('abc123');
    // Fragment should be cleared from URL
    expect(replaceStateSpy).toHaveBeenCalledWith(
      null,
      '',
      window.location.pathname + window.location.search,
    );
    replaceStateSpy.mockRestore();
  });

  it('shows the redemption form when a token is present', async () => {
    window.location.hash = '#token=valid-token';

    wrapper = mount(InvitePage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('Create account');
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('shows "invalid or has expired" when no token is present', async () => {
    wrapper = mount(InvitePage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('invalid or has expired');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('calls redeem API and navigates to /login on success', async () => {
    const fetchMock = getFetchMock();
    const navigateToMock = getNavigateToMock();
    window.location.hash = '#token=abc123';

    fetchMock.mockResolvedValueOnce(undefined); // successful redeem

    wrapper = mount(InvitePage, { global: { stubs: uiStubs } });
    await flush();

    wrapper.vm.name = 'Invited';
    wrapper.vm.email = 'invited@example.com';
    wrapper.vm.password = 'password';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/invitations/redeem', {
      method: 'POST',
      body: {
        token: 'abc123',
        name: 'Invited',
        email: 'invited@example.com',
        password: 'password',
      },
    });
    expect(navigateToMock).toHaveBeenCalledWith('/login');
  });

  it('clears token and shows generic expired message on redeem failure', async () => {
    const fetchMock = getFetchMock();
    const navigateToMock = getNavigateToMock();
    window.location.hash = '#token=abc123';

    fetchMock.mockRejectedValueOnce(new Error('Invalid invitation'));

    wrapper = mount(InvitePage, { global: { stubs: uiStubs } });
    await flush();

    wrapper.vm.name = 'Invited';
    wrapper.vm.email = 'invited@example.com';
    wrapper.vm.password = 'password';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    // Token ref should be cleared on failure
    expect(wrapper.vm.token).toBe('');
    // Generic expired message shown instead of the specific API error
    expect(wrapper.text()).toContain('invalid or has expired');
    // Should not navigate on error
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('does not persist the token to localStorage or sessionStorage', async () => {
    const localStorageSetItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchMock = getFetchMock();
    window.location.hash = '#token=no-store-token';

    wrapper = mount(InvitePage, { global: { stubs: uiStubs } });
    await flush();

    // Simulate full lifecycle: form fill, submit (even failure clears token)
    fetchMock.mockRejectedValueOnce(new Error('fail'));
    wrapper.vm.name = 'Test';
    wrapper.vm.email = 'test@example.com';
    wrapper.vm.password = 'password';
    await flush();

    await wrapper.find('form').trigger('submit');
    await flush();

    // Verify no storage writes leaked the token
    const tokenWrites = localStorageSetItem.mock.calls.filter(
      ([key]: unknown[]) => typeof key === 'string' && /token/i.test(key),
    );
    expect(tokenWrites).toHaveLength(0);

    // Verify token is not in sessionStorage either
    expect(sessionStorage.getItem('token')).toBeNull();

    localStorageSetItem.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. Index — no public "Create account" affordance
// ---------------------------------------------------------------------------

describe('index.vue — no create-account affordance', () => {
  let wrapper: ReturnType<typeof mount>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: not authenticated
    mockUseSession.mockReturnValue({
      value: { data: null, isPending: false },
    });
  });

  it('shows "Sign in" button when logged out', async () => {
    wrapper = mount(IndexPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('Sign in');
  });

  it('has no "Create account" or "Sign up" affordance', async () => {
    wrapper = mount(IndexPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).not.toMatch(/create.?account/i);
    expect(wrapper.text()).not.toMatch(/sign.?up/i);
  });

  it('shows "Set up this instance" when bootstrapAvailable', async () => {
    getFetchMock().mockResolvedValueOnce(configResponse);

    wrapper = mount(IndexPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('Set up this instance');
  });

  it('shows invitation-link instruction when bootstrap is not available', async () => {
    getFetchMock().mockResolvedValueOnce(inviteConfigResponse);

    wrapper = mount(IndexPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('invitation link');
  });

  it('shows signed-in state when user is authenticated', async () => {
    mockUseSession.mockReturnValue({
      value: {
        data: { user: { email: 'admin@example.com', id: 'u1' } },
        isPending: false,
      },
    });

    wrapper = mount(IndexPage, { global: { stubs: uiStubs } });
    await flush();

    expect(wrapper.text()).toContain('admin@example.com');
    expect(wrapper.text()).toContain('Sign out');
    // Should not show sign-in related text when signed in
    expect(wrapper.text()).not.toContain('Sign in');
  });

  it('calls authClient.signOut on sign-out click', async () => {
    mockUseSession.mockReturnValue({
      value: {
        data: { user: { email: 'admin@example.com', id: 'u1' } },
        isPending: false,
      },
    });

    wrapper = mount(IndexPage, { global: { stubs: uiStubs } });
    await flush();

    // Find the sign-out button by label text
    const buttons = wrapper.findAll('button');
    const signOutButton = buttons.find((b) => b.text() === 'Sign out');
    expect(signOutButton).toBeDefined();

    if (signOutButton) {
      await signOutButton.trigger('click');
      await flush();
      expect(mockSignOut).toHaveBeenCalled();
    }
  });
});
