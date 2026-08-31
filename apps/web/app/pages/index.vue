<template>
  <!-- Logged-out landing -->
  <template v-if="!isAuthenticated">
    <UContainer class="min-h-screen flex items-center justify-center py-8">
      <UCard class="w-full max-w-md">
        <template #header>
          <h1 class="text-2xl font-bold">BalanceFrame</h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Sign in to continue</p>
        </template>

        <div class="flex flex-col gap-4">
          <UButton label="Sign in" size="lg" class="w-full" to="/login" />
        </div>

        <template #footer>
          <div class="flex flex-col gap-2 text-sm text-center">
            <NuxtLink
              v-if="bootstrapAvailable"
              to="/setup"
              class="text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
            >
              Set up this instance
            </NuxtLink>
            <p class="text-gray-500 dark:text-gray-400">
              Have an invitation link?
              <NuxtLink
                to="/invite"
                class="text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
              >
                Use it here
              </NuxtLink>
            </p>
          </div>
        </template>
      </UCard>
    </UContainer>
  </template>

  <!-- Authenticated attention dashboard -->
  <template v-else>
    <!-- Keep direct page mounts self-describing without duplicating the shell menu. -->
    <div class="sr-only" data-testid="direct-auth-fallback">
      <span>{{ userEmail }}</span>
      <button type="button" aria-label="Sign out" @click="handleDirectSignOut">Sign out</button>
    </div>
    <AnalysisPage
      title="Dashboard"
      :loading="loading"
      :error="error"
      :freshness="freshness"
      :insufficient-data="false"
      @retry="loadAttention"
    >
      <template #error-actions>
        <UButton
          v-if="error?.code === 'not_connected'"
          label="Configure Actual connection"
          to="/connection"
          icon="i-heroicons-plug"
        />
      </template>
      <template #content>
        <section
          v-if="data?.blockers?.length || data?.alerts?.length"
          aria-label="Financial decision attention"
          class="mb-6"
        >
          <div class="mb-4">
            <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">
              Financial decision attention
            </h2>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Resolve blocking issues before reviewing qualified alerts.
            </p>
          </div>

          <section v-if="data?.blockers?.length" aria-label="Blockers" class="mb-6">
            <h3
              class="mb-3 flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400"
            >
              <span class="i-heroicons-exclamation-circle" aria-hidden="true" />
              Blockers ({{ data.blockers.length }})
            </h3>
            <ul class="space-y-3" role="list">
              <li
                v-for="(blocker, index) in data.blockers"
                :key="attentionItemKey(blocker, index)"
                role="listitem"
              >
                <FindingCard :finding="attentionFinding(blocker)" />
              </li>
            </ul>
          </section>

          <section v-if="data?.alerts?.length" aria-label="Alerts">
            <h3
              class="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400"
            >
              <span class="i-heroicons-bell-alert" aria-hidden="true" />
              Alerts ({{ data.alerts.length }})
            </h3>
            <ul class="space-y-3" role="list">
              <li
                v-for="(alert, index) in data.alerts"
                :key="attentionItemKey(alert, index)"
                role="listitem"
              >
                <FindingCard :finding="attentionFinding(alert)" />
              </li>
            </ul>
          </section>
        </section>

        <!-- Target progress -->
        <section v-if="data?.targetProgress" aria-label="Target Progress" class="mb-6">
          <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Target Progress
          </h2>
          <UCard>
            <div class="flex items-center justify-between mb-3">
              <span class="text-sm font-medium" :class="progressLabelClass">{{
                progressLabel
              }}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400"
                >{{ data.targetProgress.healthyCount }} healthy /
                {{ data.targetProgress.atRiskCount }} at risk</span
              >
            </div>
            <div class="flex gap-1">
              <div
                v-for="i in data.targetProgress.healthyCount"
                :key="'h-' + i"
                class="h-2 flex-1 rounded-full bg-emerald-400 dark:bg-emerald-500"
              />
              <div
                v-for="i in data.targetProgress.atRiskCount"
                :key="'r-' + i"
                class="h-2 flex-1 rounded-full bg-red-400 dark:bg-red-500"
              />
            </div>
            <div
              v-if="data.targetProgress.totalSinkingFunds"
              class="mt-2 text-xs text-gray-500 dark:text-gray-400"
            >
              Sinking funds: {{ data.targetProgress.sinkingFundsOnTrack }} /
              {{ data.targetProgress.totalSinkingFunds }} on track
            </div>
          </UCard>
        </section>

        <!-- Category risks -->
        <section v-if="data?.categoryRisks?.length" aria-label="Category Risks" class="mb-6">
          <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Category Risks
          </h2>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <UCard v-for="cr in data.categoryRisks" :key="cr.categoryId">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{
                  cr.categoryName
                }}</span>
                <span
                  class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                  :class="
                    cr.risk === 'high'
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                      : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                  "
                >
                  {{ cr.risk }}
                </span>
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                <p>Remaining: <SemanticAmount :amount="cr.remainingBudget" /></p>
                <p>{{ cr.daysRemaining }} days remaining</p>
              </div>
              <ReasonCodeList v-if="cr.reasonCodes?.length" :codes="cr.reasonCodes" class="mt-2" />
            </UCard>
          </div>
        </section>

        <!-- Recurrences -->
        <section v-if="data?.recurrences?.length" aria-label="Recurring Transactions">
          <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Recurring Transactions
          </h2>
          <AnalysisTable :columns="recurrenceColumns" :rows="recurrenceRows" />
        </section>
      </template>
    </AnalysisPage>
  </template>
</template>

<script setup lang="ts">
definePageMeta({
  layout: 'default',
});

import { authClient } from '../../lib/auth-client';

const session = authClient.useSession();
const isSessionPending = computed(() => session.value?.isPending ?? false);
const isAuthenticated = computed(() => !!session.value?.data);
const userEmail = computed(() => session.value?.data?.user?.email ?? '');
const sessionLoadKey = computed(() => {
  if (isSessionPending.value) return null;
  const user = session.value?.data?.user;
  return user ? `user:${user.id ?? user.email}` : 'anonymous';
});
const bootstrapAvailable = ref(false);

interface Amount {
  minorUnits: string;
  currency: string;
}

type FinancialAttentionClassification =
  | 'account_readiness_blocker'
  | 'transfer_needs_attention'
  | 'reservation_conflict'
  | 'commitment_conflict'
  | 'evidence_connector_degradation'
  | 'unresolved_material_evidence';

type DecisionScope =
  | { kind: 'global' }
  | {
      kind: 'account' | 'category' | 'transaction' | 'schedule' | 'claim';
      id: string;
    };

interface EvidenceReference {
  evidenceId: string;
  kind: string;
  authorized: boolean;
  redaction: 'visible' | 'redacted';
}

interface DecisionIssue {
  code: string;
  severity: 'critical' | 'warning' | 'info';
  effect: 'blocks' | 'qualifies';
  scope: DecisionScope;
  evidence: EvidenceReference[];
  remediation?: { code: string; action: string } | null;
  redaction: 'visible' | 'redacted';
}

interface AttentionDecisionMetadata {
  classification?: FinancialAttentionClassification;
  issue?: DecisionIssue;
  scopeLabel?: string;
  snapshotId?: string;
  policyVersion?: string;
  revision?: string;
  dedupKey?: string;
  findingId?: string;
  findingStatus?: string;
  findingVersion?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  expiresAt?: string | null;
}

interface Blocker extends AttentionDecisionMetadata {
  code: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  entityType?: string;
  entityId?: string;
}

interface Alert extends AttentionDecisionMetadata {
  code: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  categoryId?: string;
  categoryName?: string;
}

interface Recurrence {
  payeeName: string;
  amount: Amount;
  frequency: string;
  occurrences: number;
  lastOccurrence: string;
  isEstimated: boolean;
}

interface CategoryRisk {
  categoryId: string;
  categoryName: string;
  risk: string;
  reasonCodes: string[];
  remainingBudget: Amount;
  daysRemaining: number;
}

interface TargetProgress {
  overallLabel: string;
  healthyCount: number;
  atRiskCount: number;
  sinkingFundsOnTrack: number;
  totalSinkingFunds: number;
}

interface AttentionData {
  blockers: Blocker[];
  alerts: Alert[];
  recurrences: Recurrence[];
  categoryRisks: CategoryRisk[];
  targetProgress: TargetProgress;
}

interface AttentionError {
  code: string;
  message: string;
  retryable?: boolean;
}

const loading = ref(true);
const error = ref<AttentionError | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const data = ref<AttentionData | null>(null);

function isAttentionErrorResponse(cause: unknown): cause is { data: { error: AttentionError } } {
  if (typeof cause !== 'object' || cause === null || !('data' in cause)) {
    return false;
  }

  const { data } = cause;
  if (typeof data !== 'object' || data === null || !('error' in data)) {
    return false;
  }

  const { error } = data;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string' &&
    (!('retryable' in error) || typeof error.retryable === 'boolean')
  );
}

let loadGeneration = 0;

async function loadAttention(): Promise<void> {
  const generation = ++loadGeneration;
  if (!isAuthenticated.value) {
    try {
      const config = await $fetch<{
        result: {
          registrationMode: string;
          bootstrapAvailable: boolean;
          invitationRequired: boolean;
        };
      }>('/api/auth/config');
      if (generation === loadGeneration) {
        bootstrapAvailable.value = config.result.bootstrapAvailable;
      }
    } catch {
      // Config unavailable — default to invite-only mode (no bootstrap link).
    } finally {
      if (generation === loadGeneration) {
        loading.value = false;
      }
    }
    return;
  }

  loading.value = true;
  data.value = null;
  error.value = null;
  freshness.value = null;
  try {
    const res = await $fetch<{
      status: string;
      result: AttentionData;
      dataFreshness: { isStale: boolean; lastSync: string | null; label: string } | null;
    }>('/api/home/attention', {
      query: { detailed: 'true', month: currentMonth() },
      retry: 0,
    });
    if (generation !== loadGeneration) return;
    if (res.status === 'ok') {
      data.value = res.result;
      freshness.value = res.dataFreshness;
    } else {
      error.value = { code: 'EMPTY', message: 'No attention data returned.' };
    }
  } catch (cause: unknown) {
    if (generation !== loadGeneration) return;
    if (isAttentionErrorResponse(cause)) {
      error.value = cause.data.error;
    } else {
      error.value = {
        code: 'FETCH_ERROR',
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      };
    }
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
    }
  }
}

let lastAutomaticLoadKey: string | null = null;
watch(
  sessionLoadKey,
  (loadKey) => {
    if (loadKey === null || loadKey === lastAutomaticLoadKey) return;
    lastAutomaticLoadKey = loadKey;
    void loadAttention();
  },
  { immediate: true },
);
async function handleDirectSignOut(): Promise<void> {
  await authClient.signOut();
  await navigateTo('/');
}

type AttentionItem = Blocker | Alert;

function attentionItemKey(item: AttentionItem, index: number): string {
  return (
    item.findingId ?? item.dedupKey ?? `${item.classification ?? 'legacy'}:${item.code}:${index}`
  );
}

function attentionFinding(item: AttentionItem) {
  const entityType = 'entityType' in item ? item.entityType : undefined;
  const categoryName = 'categoryName' in item ? item.categoryName : undefined;

  return {
    title: item.message,
    severity: item.severity,
    scopeLabel: item.scopeLabel,
    category: item.scopeLabel ?? categoryName ?? entityType,
    entityType,
    reasonCodes: item.issue ? undefined : [item.code],
    classification: item.classification,
    status: item.findingStatus,
    issue: item.issue,
    snapshotId: item.snapshotId,
    policyVersion: item.policyVersion,
    revision: item.revision,
    findingVersion: item.findingVersion,
    firstObservedAt: item.firstObservedAt,
    lastObservedAt: item.lastObservedAt,
    expiresAt: item.expiresAt ?? undefined,
  };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const progressLabel = computed(() => {
  const label = data.value?.targetProgress?.overallLabel;
  if (label === 'healthy') return 'Healthy';
  if (label === 'at_risk') return 'At Risk';
  return label ?? 'Unknown';
});

const progressLabelClass = computed(() => {
  const label = data.value?.targetProgress?.overallLabel;
  if (label === 'healthy') return 'text-emerald-700 dark:text-emerald-400';
  if (label === 'at_risk') return 'text-red-700 dark:text-red-400';
  return 'text-gray-500 dark:text-gray-400';
});

const recurrenceColumns = [
  { key: 'payeeName', label: 'Payee' },
  { key: 'amount', label: 'Amount', type: 'amount' as const },
  { key: 'frequency', label: 'Frequency' },
  { key: 'occurrences', label: 'Occurrences' },
  { key: 'lastOccurrence', label: 'Last' },
  { key: 'isEstimated', label: 'Estimated', type: 'badge' as const },
];

const recurrenceRows = computed(() => {
  return (data.value?.recurrences ?? []).map((r) => ({
    ...r,
    isEstimated: r.isEstimated ? 'Estimated' : 'Confirmed',
  }));
});
</script>
