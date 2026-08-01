<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <header class="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm">
      <UContainer class="flex items-center justify-between h-14 px-4">
        <div class="flex items-center gap-3">
          <NuxtLink to="/" class="px-2 py-1 rounded-md text-base font-semibold text-gray-900 dark:text-white hover:text-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500">BalanceFrame</NuxtLink>
          <span data-testid="current-space" class="hidden sm:inline text-xs text-gray-500 dark:text-gray-400" aria-label="Current space">{{ currentSpace }}</span>
        </div>
        <nav class="hidden md:flex items-center gap-0.5" aria-label="Main navigation">
          <NuxtLink v-for="link in primaryLinks" :key="link.to" :to="link.to" class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500" active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20">{{ link.label }}</NuxtLink>
        </nav>
        <div class="flex items-center gap-2">
          <div v-if="authorization" data-testid="authorization-scope" class="hidden lg:block text-xs text-gray-500" :aria-label="`Authorization scope: ${authorization.capability}`">
            Scope: {{ authorization.capability }}<span v-if="authorization.allowed === false"> (restricted)</span>
          </div>
          <FreshnessBanner :freshness="freshness" :show-refresh="true" @refresh="refreshShell" />
          <div v-if="isAuthenticated" class="relative">
            <button type="button" class="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500" aria-label="Open user menu" :aria-expanded="userMenuOpen" @click="userMenuOpen = !userMenuOpen">{{ userEmail }}</button>
            <div v-if="userMenuOpen" class="absolute right-0 mt-2 w-36 rounded-md border bg-white p-1 shadow-lg dark:bg-gray-900" role="menu">
              <button type="button" class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500" aria-label="Sign out" role="menuitem" @click="handleSignOut">Sign out</button>
            </div>
          </div>
          <button type="button" class="md:hidden rounded-md p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500" aria-label="Toggle navigation menu" :aria-expanded="mobileOpen" aria-controls="mobile-navigation" @click="toggleMobile">☰</button>
        </div>
      </UContainer>
      <div v-if="mobileOpen" id="mobile-navigation" class="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <nav class="flex flex-col px-4 py-2 gap-1" aria-label="Mobile navigation">
          <NuxtLink v-for="link in mobileLinks" :key="link.to" :to="link.to" class="px-3 py-2 text-sm font-medium rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500" active-class="text-primary-600 bg-primary-50" @click="closeMobile">{{ link.label }}</NuxtLink>
        </nav>
      </div>
    </header>
    <div v-if="routePending" class="h-0.5 bg-primary-500" role="progressbar" aria-label="Loading page" aria-busy="true" />
    <main :aria-busy="routePending ? 'true' : undefined"><slot /></main>
    <footer class="border-t border-gray-200 dark:border-gray-800 py-4 mt-8"><UContainer class="px-4"><p class="text-xs text-gray-400 dark:text-gray-500 text-center">BalanceFrame &mdash; Budget Intelligence</p></UContainer></footer>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '../../lib/auth-client';
import FreshnessBanner from '../components/FreshnessBanner.vue';

const mobileOpen = ref(false);
const userMenuOpen = ref(false);
const routePending = ref(false);
const session = authClient.useSession();
const isAuthenticated = computed(() => !!session?.value?.data);
const userEmail = computed(() => session?.value?.data?.user?.email ?? 'Account');
const currentSpace = ref('Current space');
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const authorization = ref<{ capability?: string; allowed?: boolean } | null>(null);

const primaryLinks = [
  { to: '/review', label: 'Review' }, { to: '/rules', label: 'Rules' }, { to: '/purchase-check', label: 'Purchase Check' },
  { to: '/cash-flow', label: 'Cash Flow' }, { to: '/targets', label: 'Targets' }, { to: '/reports', label: 'Reports' }, { to: '/notifications', label: 'Notifications' },
];
const mobileLinks = [
  { to: '/', label: 'Home' }, ...primaryLinks, { to: '/data-quality', label: 'Data Quality' }, { to: '/liquidity', label: 'Liquidity' }, { to: '/calendar', label: 'Calendar' }, { to: '/trends', label: 'Trends' }, { to: '/obligations', label: 'Obligations' }, { to: '/income', label: 'Income' }, { to: '/forecast-accuracy', label: 'Forecast Accuracy' }, { to: '/scenarios', label: 'Scenarios' }, { to: '/health', label: 'Health' },
];

function toggleMobile() { mobileOpen.value = !mobileOpen.value; }
function closeMobile() { mobileOpen.value = false; }
async function handleSignOut() { await authClient.signOut(); userMenuOpen.value = false; await navigateTo('/'); }

async function refreshShell() {
  if (!isAuthenticated.value) return;
  try {
    const response = await $fetch<{ status: string; result?: { budgetName?: string; spaceName?: string; month?: string }; dataFreshness?: typeof freshness.value; authorization?: typeof authorization.value }>('/api/home/budget-summary', { query: { month: currentMonth() } });
    if (response.status === 'ok') {
      currentSpace.value = response.result?.spaceName ?? response.result?.budgetName ?? (response.result?.month ? `Budget · ${response.result.month}` : 'Current space');
      freshness.value = response.dataFreshness ?? null;
      authorization.value = response.authorization ?? null;
    }
  } catch { /* shell status is supplementary and must not block the page */ }
}
function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

onMounted(() => {
  void refreshShell();
  if (typeof useNuxtApp === 'function') {
    const app = useNuxtApp();
    app.hook('page:start', () => { routePending.value = true; });
    app.hook('page:finish', () => { routePending.value = false; });
  }
});
</script>
