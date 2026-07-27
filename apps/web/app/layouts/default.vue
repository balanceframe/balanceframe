<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <!-- Navigation header -->
    <header class="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm">
      <UContainer class="flex items-center justify-between h-14 px-4">
        <div class="flex items-center gap-1">
          <NuxtLink to="/" class="text-base font-semibold text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-400 transition-colors px-2 py-1 rounded-md">
            BalanceFrame
          </NuxtLink>
        </div>

        <!-- Primary navigation -->
        <nav class="hidden md:flex items-center gap-0.5" aria-label="Main navigation">
          <NuxtLink
            to="/review"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Review
          </NuxtLink>
          <NuxtLink
            to="/rules"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Rules
          </NuxtLink>
          <NuxtLink
            to="/purchase-check"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Purchase Check
          </NuxtLink>
          <NuxtLink
            to="/cash-flow"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Cash Flow
          </NuxtLink>
          <NuxtLink
            to="/targets"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Targets
          </NuxtLink>
          <NuxtLink
            to="/reports"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Reports
          </NuxtLink>
          <NuxtLink
            to="/notifications"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
          >
            Notifications
          </NuxtLink>
        </nav>

        <!-- Mobile menu toggle -->
        <UButton
          variant="ghost"
          icon="i-heroicons-bars-3"
          class="md:hidden"
          aria-label="Toggle navigation menu"
          @click="mobileOpen = !mobileOpen"
        />
      </UContainer>

      <!-- Mobile navigation -->
      <div v-if="mobileOpen" class="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <nav class="flex flex-col px-4 py-2 gap-1" aria-label="Mobile navigation">
          <NuxtLink
            v-for="link in mobileLinks"
            :key="link.to"
            :to="link.to"
            class="px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            active-class="text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20"
            @click="mobileOpen = false"
          >
            {{ link.label }}
          </NuxtLink>
        </nav>
      </div>
    </header>

    <!-- Page content -->
    <main>
      <slot />
    </main>

    <!-- Footer -->
    <footer class="border-t border-gray-200 dark:border-gray-800 py-4 mt-8">
      <UContainer class="px-4">
        <p class="text-xs text-gray-400 dark:text-gray-500 text-center">
          BalanceFrame &mdash; Budget Intelligence
        </p>
      </UContainer>
    </footer>
  </div>
</template>

<script setup lang="ts">
const mobileOpen = ref(false);

const mobileLinks = [
  { to: '/', label: 'Home' },
  { to: '/review', label: 'Review' },
  { to: '/rules', label: 'Rules' },
  { to: '/purchase-check', label: 'Purchase Check' },
  { to: '/cash-flow', label: 'Cash Flow' },
  { to: '/targets', label: 'Targets' },
  { to: '/reports', label: 'Reports' },
  { to: '/notifications', label: 'Notifications' },
  { to: '/data-quality', label: 'Data Quality' },
  { to: '/liquidity', label: 'Liquidity' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/trends', label: 'Trends' },
  { to: '/obligations', label: 'Obligations' },
  { to: '/income', label: 'Income' },
  { to: '/forecast-accuracy', label: 'Forecast Accuracy' },
  { to: '/scenarios', label: 'Scenarios' },
  { to: '/health', label: 'Health' },
];
</script>
