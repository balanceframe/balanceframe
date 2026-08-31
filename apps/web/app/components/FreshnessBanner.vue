<template>
  <div
    v-if="shouldRender"
    role="status"
    class="flex flex-col items-start gap-2 rounded-md border px-3 py-1.5 text-xs motion-reduce:transition-none"
    :aria-label="ariaLabel"
    :class="bannerClass"
  >
    <div class="flex w-full min-w-0 items-center gap-2">
      <span class="shrink-0" :class="iconClass" aria-hidden="true" />
      <span class="font-medium">{{ summaryLabel }}</span>
      <span v-if="legacyLastSync" class="opacity-70">
        &mdash; synced {{ formatTimeAgo(legacyLastSync) }}
      </span>
      <button
        v-if="showRefresh"
        type="button"
        class="ml-auto shrink-0 rounded p-1 hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
        aria-label="Refresh data"
        @click="emit('refresh')"
      >
        <span class="i-heroicons-arrow-path" aria-hidden="true" />
      </button>
    </div>

    <ul
      v-if="hasAccounts"
      aria-label="Account freshness"
      class="grid w-full gap-1.5 border-t border-current/20 pt-2 sm:grid-cols-2"
    >
      <li
        v-for="account in accounts"
        :key="account.accountId"
        class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2"
        :data-account-id="account.accountId"
        :data-state="normalizedAccountState(account.state)"
      >
        <span class="min-w-0 truncate">{{ account.label }}</span>
        <span class="shrink-0 font-medium">
          {{ accountStateLabel(account.state) }}
        </span>
        <span v-if="account.observedAt" class="basis-full opacity-70">
          Observed {{ formatTimeAgo(account.observedAt) }}
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import type { AccountFreshness, AccountFreshnessState, Freshness } from './types';

type OverallFreshnessState = 'current' | 'stale' | 'unavailable' | 'mixed';

const props = defineProps<{
  freshness?: Freshness | null;
  accounts?: AccountFreshness[];
  showRefresh?: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();

const hasAccounts = computed(() => Boolean(props.accounts?.length));
const shouldRender = computed(() => Boolean(props.freshness) || hasAccounts.value);
const overallState = computed<OverallFreshnessState>(() => {
  if (!hasAccounts.value) return props.freshness?.isStale ? 'stale' : 'current';

  const states = new Set(
    props.accounts?.map((account) => normalizedAccountState(account.state)) ?? [],
  );
  if (states.size === 1 && states.has('current')) return 'current';
  if (states.size === 1 && states.has('stale')) return 'stale';
  if ([...states].every((state) => state === 'unavailable' || state === 'unknown')) {
    return 'unavailable';
  }
  return 'mixed';
});
const ariaLabel = computed(() => {
  if (hasAccounts.value) return `Data freshness: ${overallState.value}`;
  const state = props.freshness?.isStale ? 'stale' : 'current';
  return `Data freshness: ${state} — ${props.freshness?.label ?? state}`;
});
const summaryLabel = computed(() => {
  switch (overallState.value) {
    case 'current':
      return 'Data current';
    case 'stale':
      return 'Stale data';
    case 'unavailable':
      return 'Data unavailable';
    default:
      return 'Mixed freshness';
  }
});
const legacyLastSync = computed(() =>
  hasAccounts.value ? null : (props.freshness?.lastSync ?? null),
);
const iconClass = computed(() => {
  switch (overallState.value) {
    case 'current':
      return 'i-heroicons-check-circle';
    case 'stale':
      return 'i-heroicons-exclamation-triangle';
    case 'unavailable':
      return 'i-heroicons-minus-circle';
    default:
      return 'i-heroicons-information-circle';
  }
});
const bannerClass = computed(() => {
  switch (overallState.value) {
    case 'current':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400';
    case 'stale':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400';
    case 'unavailable':
      return 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300';
    default:
      return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
  }
});

function normalizedAccountState(state: AccountFreshnessState): AccountFreshnessState {
  switch (state) {
    case 'current':
    case 'stale':
    case 'unavailable':
    case 'unknown':
      return state;
    default:
      return 'unknown';
  }
}

function accountStateLabel(state: AccountFreshnessState): string {
  switch (normalizedAccountState(state)) {
    case 'current':
      return 'Current';
    case 'stale':
      return 'Stale';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'Unknown';
  }
}

function formatTimeAgo(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return 'time unavailable';

  const ms = Math.max(0, Date.now() - timestamp);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}
</script>
