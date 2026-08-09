<template>
  <div class="flex min-h-screen flex-col bg-gray-50 dark:bg-gray-950" @click="handleLayoutClick">
    <header
      class="sticky top-0 z-50 h-14 border-b border-gray-200 bg-white/90 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/90"
    >
      <UContainer class="flex h-full items-center justify-between px-4">
        <div class="flex items-center gap-3">
          <NuxtLink
            to="/"
            class="rounded-md px-2 py-1 text-base font-semibold text-gray-900 hover:text-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-white"
            >BalanceFrame</NuxtLink
          >
          <span
            data-testid="current-space"
            class="hidden text-xs text-gray-500 sm:inline dark:text-gray-400"
            aria-label="Current space"
            >{{ currentSpace }}</span
          >
        </div>

        <nav class="hidden items-center gap-0.5 xl:flex" aria-label="Main navigation">
          <template v-for="link in navigation.direct" :key="link.to">
            <span v-if="link.disabledReason" class="inline-flex" :title="link.disabledReason">
              <button
                type="button"
                disabled
                class="cursor-not-allowed rounded-md px-3 py-1.5 text-sm font-medium text-gray-400 opacity-60 dark:text-gray-600"
                :data-navigation-disabled="link.to"
                :title="link.disabledReason"
                :aria-label="`${link.label} — ${link.disabledReason}`"
              >
                {{ link.label }}
              </button>
            </span>
            <NuxtLink
              v-else
              :to="link.to"
              class="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              active-class="bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400"
            >
              {{ link.label }}
            </NuxtLink>
          </template>
          <div
            v-for="group in navigation.groups"
            :key="group.id"
            class="relative"
            data-navigation-popover
          >
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              :class="{
                'bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400':
                  isGroupActive(group),
              }"
              :id="triggerId(group.id)"
              :aria-controls="panelId(group.id)"
              :aria-current="isGroupActive(group) ? 'page' : undefined"
              :aria-expanded="openGroup === group.id"
              @click="toggleGroup(group.id)"
              @keydown="handleGroupButtonKeydown(group.id, $event)"
            >
              {{ group.label }}
              <span
                class="i-heroicons-chevron-down size-3 transition-transform motion-reduce:transition-none"
                :class="{ 'rotate-180': openGroup === group.id }"
                aria-hidden="true"
              />
            </button>
            <div
              v-if="openGroup === group.id"
              :id="panelId(group.id)"
              class="absolute left-0 top-full z-10 mt-2 w-52 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
              @keydown="handlePanelKeydown(group.id, $event)"
            >
              <template v-for="link in group.links" :key="link.to">
                <span v-if="link.disabledReason" class="block" :title="link.disabledReason">
                  <button
                    type="button"
                    disabled
                    class="block w-full cursor-not-allowed rounded-md px-3 py-2 text-left text-sm font-medium text-gray-400 opacity-60 dark:text-gray-600"
                    :data-navigation-disabled="link.to"
                    :title="link.disabledReason"
                    :aria-label="`${link.label} — ${link.disabledReason}`"
                  >
                    {{ link.label }}
                  </button>
                </span>
                <NuxtLink
                  v-else
                  :to="link.to"
                  class="block rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
                  active-class="bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400"
                  @click="closeNavigationMenus"
                >
                  {{ link.label }}
                </NuxtLink>
              </template>
            </div>
          </div>
        </nav>

        <div class="flex items-center gap-2">
          <div
            v-if="authorization"
            data-testid="authorization-scope"
            class="hidden text-xs text-gray-500 lg:block"
            :aria-label="`Authorization scope: ${authorization.capability}`"
          >
            Scope: {{ authorization.capability
            }}<span v-if="authorization.allowed === false"> (restricted)</span>
          </div>
          <FreshnessBanner :freshness="freshness" :show-refresh="true" @refresh="refreshShell" />
          <div v-if="isAuthenticated" class="relative" data-navigation-popover>
            <button
              id="user-menu-trigger"
              type="button"
              class="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-400 dark:hover:bg-gray-800"
              aria-label="Open user menu"
              aria-haspopup="menu"
              :aria-expanded="userMenuOpen"
              :title="userEmail"
              @click="toggleUserMenu"
              @keydown.down.prevent="openUserMenuAndFocus"
              @keydown.esc.stop.prevent="closeUserMenu(true)"
            >
              <span class="hidden sm:inline">{{ userEmail }}</span>
              <span class="sm:hidden">Account</span>
            </button>
            <div
              v-if="userMenuOpen"
              class="absolute right-0 mt-2 w-56 rounded-md border bg-white p-1 shadow-lg dark:bg-gray-900"
              role="menu"
              @keydown.esc.stop.prevent="closeUserMenu(true)"
            >
              <p class="truncate px-2 py-1 text-xs text-gray-500 dark:text-gray-400">
                {{ userEmail }}
              </p>
              <button
                id="user-menu-sign-out"
                type="button"
                class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
                aria-label="Sign out"
                role="menuitem"
                @click="handleSignOut"
              >
                Sign out
              </button>
            </div>
          </div>
          <button
            type="button"
            class="rounded-md p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 xl:hidden"
            aria-label="Toggle navigation menu"
            :aria-expanded="mobileOpen"
            aria-controls="mobile-navigation"
            data-navigation-popover
            @click="toggleMobile"
          >
            ☰
          </button>
        </div>
      </UContainer>

      <div
        v-if="mobileOpen"
        id="mobile-navigation"
        class="border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 xl:hidden"
        data-navigation-popover
      >
        <nav
          class="max-h-[calc(100vh-3.5rem)] overflow-y-auto overscroll-contain px-4 py-3"
          aria-label="Mobile navigation"
        >
          <section>
            <p
              class="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              Main
            </p>
            <template v-for="link in navigation.direct" :key="link.to">
              <span v-if="link.disabledReason" class="block" :title="link.disabledReason">
                <button
                  type="button"
                  disabled
                  class="block w-full cursor-not-allowed rounded-md px-3 py-2 text-left text-sm font-medium text-gray-400 opacity-60 dark:text-gray-600"
                  :data-navigation-disabled="link.to"
                  :title="link.disabledReason"
                  :aria-label="`${link.label} — ${link.disabledReason}`"
                >
                  {{ link.label }}
                </button>
              </span>
              <NuxtLink
                v-else
                :to="link.to"
                class="block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
                active-class="bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400"
                @click="closeNavigationMenus"
              >
                {{ link.label }}
              </NuxtLink>
            </template>
          </section>
          <section v-for="group in navigation.groups" :key="group.id" class="mt-3">
            <p
              class="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              {{ group.label }}
            </p>
            <template v-for="link in group.links" :key="link.to">
              <span v-if="link.disabledReason" class="block" :title="link.disabledReason">
                <button
                  type="button"
                  disabled
                  class="block w-full cursor-not-allowed rounded-md px-3 py-2 text-left text-sm font-medium text-gray-400 opacity-60 dark:text-gray-600"
                  :data-navigation-disabled="link.to"
                  :title="link.disabledReason"
                  :aria-label="`${link.label} — ${link.disabledReason}`"
                >
                  {{ link.label }}
                </button>
              </span>
              <NuxtLink
                v-else
                :to="link.to"
                class="block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
                active-class="bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400"
                @click="closeNavigationMenus"
              >
                {{ link.label }}
              </NuxtLink>
            </template>
          </section>
        </nav>
      </div>
    </header>
    <div
      v-if="routePending"
      class="h-0.5 bg-primary-500"
      role="progressbar"
      aria-label="Loading page"
      aria-busy="true"
    />
    <main class="flex-1" :aria-busy="routePending ? 'true' : undefined"><slot /></main>
    <footer
      v-if="route.path !== '/review'"
      class="mt-8 border-t border-gray-200 py-4 dark:border-gray-800"
    >
      <UContainer class="px-4"
        ><p class="text-center text-xs text-gray-400 dark:text-gray-500">
          BalanceFrame &mdash; Budget Intelligence
        </p></UContainer
      >
    </footer>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '../../lib/auth-client';
import FreshnessBanner from '../components/FreshnessBanner.vue';

type NavigationGroupId = 'analysis' | 'planning' | 'system';

interface NavigationLink {
  to: string;
  label: string;
  disabledReason?: string;
}

interface NavigationGroup {
  id: NavigationGroupId;
  label: string;
  links: readonly NavigationLink[];
}

const navigation: { direct: readonly NavigationLink[]; groups: readonly NavigationGroup[] } = {
  direct: [
    { to: '/', label: 'Dashboard' },
    { to: '/review', label: 'Review' },
    { to: '/notifications', label: 'Notifications' },
  ],
  groups: [
    {
      id: 'analysis',
      label: 'Analysis',
      links: [
        { to: '/data-quality', label: 'Data Quality' },
        { to: '/liquidity', label: 'Liquidity' },
        { to: '/calendar', label: 'Calendar' },
        { to: '/trends', label: 'Trends' },
        { to: '/income', label: 'Income' },
        { to: '/health', label: 'Health' },
      ],
    },
    {
      id: 'planning',
      label: 'Planning',
      links: [
        { to: '/cash-flow', label: 'Cash Flow' },
        { to: '/targets', label: 'Targets' },
        { to: '/obligations', label: 'Obligations' },
        { to: '/forecast-accuracy', label: 'Forecast Accuracy' },
        { to: '/scenarios', label: 'Scenarios' },
        { to: '/reports', label: 'Reports' },
      ],
    },
    {
      id: 'system',
      label: 'System',
      links: [
        { to: '/rules', label: 'Rules' },
        { to: '/purchase-check', label: 'Purchase Check' },
        { to: '/connection', label: 'Connection' },
      ],
    },
  ],
};

const route = useRoute();
const mobileOpen = ref(false);
const openGroup = ref<NavigationGroupId | null>(null);
const userMenuOpen = ref(false);
const routePending = ref(false);
const session = authClient.useSession();
const isAuthenticated = computed(() => !!session?.value?.data);
const userEmail = computed(() => session?.value?.data?.user?.email ?? 'Account');
const currentSpace = ref('Current space');
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const authorization = ref<{ capability?: string; allowed?: boolean } | null>(null);

function panelId(groupId: NavigationGroupId) {
  return `navigation-${groupId}-panel`;
}

function triggerId(groupId: NavigationGroupId) {
  return `navigation-${groupId}-trigger`;
}

function isGroupActive(group: NavigationGroup) {
  return group.links.some((link) => !link.disabledReason && link.to === route.path);
}

function closeNavigationMenus() {
  mobileOpen.value = false;
  openGroup.value = null;
  userMenuOpen.value = false;
}

function toggleGroup(groupId: NavigationGroupId) {
  const nextGroup = openGroup.value === groupId ? null : groupId;
  closeNavigationMenus();
  openGroup.value = nextGroup;
}

function focusGroupLink(groupId: NavigationGroupId, edge: 'first' | 'last') {
  void nextTick(() => {
    const links = document
      .getElementById(panelId(groupId))
      ?.querySelectorAll<HTMLAnchorElement>('a');
    const index = edge === 'first' ? 0 : (links?.length ?? 0) - 1;
    links?.[index]?.focus();
  });
}

function closeGroupAndRestoreFocus(groupId: NavigationGroupId) {
  openGroup.value = null;
  void nextTick(() => {
    document.getElementById(triggerId(groupId))?.focus();
  });
}

function handleGroupButtonKeydown(groupId: NavigationGroupId, event: KeyboardEvent) {
  if (event.key === 'Escape') {
    openGroup.value = null;
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openGroup.value = groupId;
    focusGroupLink(groupId, event.key === 'ArrowDown' ? 'first' : 'last');
  }
}

function handlePanelKeydown(groupId: NavigationGroupId, event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeGroupAndRestoreFocus(groupId);
    return;
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

  const links = document.getElementById(panelId(groupId))?.querySelectorAll<HTMLAnchorElement>('a');
  if (!links?.length) return;
  const currentIndex = Array.from(links).indexOf(event.target as HTMLAnchorElement);
  if (currentIndex < 0) return;

  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  links[(currentIndex + direction + links.length) % links.length]?.focus();
}

function closeUserMenu(restoreFocus = false) {
  userMenuOpen.value = false;
  if (restoreFocus) {
    void nextTick(() => {
      document.getElementById('user-menu-trigger')?.focus();
    });
  }
}

function openUserMenuAndFocus() {
  closeNavigationMenus();
  userMenuOpen.value = true;
  void nextTick(() => {
    document.getElementById('user-menu-sign-out')?.focus();
  });
}

function toggleUserMenu() {
  const nextOpen = !userMenuOpen.value;
  closeNavigationMenus();
  userMenuOpen.value = nextOpen;
}

function handleLayoutClick(event: MouseEvent) {
  if (!mobileOpen.value && !openGroup.value && !userMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Element && target.closest('[data-navigation-popover]')) return;
  closeNavigationMenus();
}

function toggleMobile() {
  const nextOpen = !mobileOpen.value;
  closeNavigationMenus();
  mobileOpen.value = nextOpen;
}

async function handleSignOut() {
  await authClient.signOut();
  userMenuOpen.value = false;
  await navigateTo('/');
}

async function refreshShell() {
  if (!isAuthenticated.value) return;
  try {
    const response = await $fetch<{
      status: string;
      result?: { budgetName?: string; spaceName?: string; month?: string };
      dataFreshness?: typeof freshness.value;
      authorization?: typeof authorization.value;
    }>('/api/home/budget-summary', { query: { month: currentMonth() } });
    if (response.status === 'ok') {
      currentSpace.value =
        response.result?.spaceName ??
        response.result?.budgetName ??
        (response.result?.month ? `Budget · ${response.result.month}` : 'Current space');
      freshness.value = response.dataFreshness ?? null;
      authorization.value = response.authorization ?? null;
    }
  } catch {
    /* shell status is supplementary and must not block the page */
  }
}

function currentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

watch(() => route.fullPath, closeNavigationMenus);

onMounted(() => {
  void refreshShell();
  if (typeof useNuxtApp === 'function') {
    const app = useNuxtApp();
    app.hook('page:start', () => {
      routePending.value = true;
    });
    app.hook('page:finish', () => {
      routePending.value = false;
    });
  }
});
</script>
