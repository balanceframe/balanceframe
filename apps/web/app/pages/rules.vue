<template>
  <UContainer class="py-4">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-bold">Rules</h1>
      <div class="flex items-center gap-2">
        <UButton
          v-if="pendingRuleProposal"
          label="Review pending rule proposal"
          color="primary"
          variant="solid"
          size="sm"
          @click="showProposalModal = true"
        />
        <UButton
          variant="ghost"
          color="neutral"
          size="sm"
          label="Sign out"
          icon="i-heroicons-arrow-right-on-rectangle"
          @click="handleSignOut"
        />
      </div>
    </div>

    <details class="mb-4 rounded border border-neutral-200 dark:border-neutral-700">
      <summary class="cursor-pointer px-3 py-2 font-medium focus-visible:outline focus-visible:outline-2">Merchant policy and calendar settings</summary>
      <MerchantPolicySettings class="p-3" />
    </details>

    <!-- Error state -->
    <UAlert
      v-if="error"
      title="Failed to load rules"
      :description="error"
      color="error"
      variant="soft"
      class="mb-4"
    >
      <template #trailing>
        <UButton label="Retry" color="error" variant="solid" size="sm" @click="loadRules" />
      </template>
    </UAlert>

    <!-- Loading state (initial fetch) -->
    <div v-if="!rules && !error" class="text-center py-8">
      <p class="text-gray-500 dark:text-gray-400">Loading rules...</p>
    </div>

    <!-- Loaded state -->
    <template v-if="rules">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <!-- Rule list sidebar -->
        <div class="lg:col-span-1 order-2 lg:order-1">
          <RuleList
            :items="rules.items"
            :selected-id="selectedId"
            :loading="loading"
            @select="handleSelect"
          />
        </div>

        <!-- Selected rule detail -->
        <div class="lg:col-span-2 order-1 lg:order-2">
          <RuleDetail
            v-if="selectedRule"
            :rule="selectedRule"
            @toggle="handleToggleRule"
            @delete="handleDeleteRule"
          />
          <UCard v-else class="text-center py-8">
            <p class="text-gray-500 dark:text-gray-400">Select a rule to view details.</p>
          </UCard>
        </div>
      </div>
    </template>
    <ProposedRulesModal
      :open="showProposalModal"
      :proposals="[]"
      :proposal-approval-views="[]"
      :initial-proposal="pendingRuleProposal"
      @accepted="handleRuleProposalAccepted"
      @close="showProposalModal = false"
    />
  </UContainer>
</template>

<script setup lang="ts">
import { authClient } from '../../lib/auth-client';
import { isProposalApprovalView } from '../../types/review-client';
import type { ProposalApprovalView } from '../../server/utils/proposal-approval-view';
import MerchantPolicySettings from '../components/MerchantPolicySettings.vue';
interface RuleListItem {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly inactive: boolean;
}

interface RuleListResult {
  readonly items: readonly RuleListItem[];
  readonly total: number;
}

interface RuleShowResult {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly trigger: unknown;
  readonly actions: unknown;
  readonly inactive: boolean;
}
interface RuleMutationResult {
  readonly proposal?: unknown;
  readonly applied?: boolean;
  readonly verified?: boolean;
}


interface ApiEnvelope<T> {
  readonly schemaVersion: string;
  readonly requestId: string;
  readonly status: 'ok' | 'error';
  readonly result: T | null;
  readonly error: { code: string; message: string; retryable: boolean } | null;
  readonly auth: unknown;
}
const pendingRuleProposal = ref<ProposalApprovalView | null>(null);
const showProposalModal = ref(false);


const config = useRuntimeConfig();
const toast = useToast();
const apiBase = config.public.apiBase || (import.meta.client ? window.location.origin : '');

const rules = ref<RuleListResult | null>(null);
const selectedRule = ref<RuleShowResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

onMounted(async () => {
  await loadRules();
});

async function loadRules() {
  error.value = null;
  loading.value = true;
  selectedRule.value = null;
  selectedId.value = null;

  try {
    const res = await $fetch<ApiEnvelope<RuleListResult>>('/api/rule', {
      baseURL: apiBase || undefined,
      credentials: 'same-origin',
    });

    if (res.status === 'ok' && res.result) {
      rules.value = res.result;
    } else {
      error.value = res.error?.message ?? 'Unknown error';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to fetch rules';
  } finally {
    loading.value = false;
  }
}

async function handleSelect(id: string) {
  selectedId.value = id;

  // Clear previous detail immediately for responsive feedback.
  selectedRule.value = null;

  try {
    const res = await $fetch<ApiEnvelope<RuleShowResult>>(`/api/rule/${id}`, {
      baseURL: apiBase || undefined,
      credentials: 'same-origin',
    });

    if (res.status === 'ok' && res.result) {
      selectedRule.value = res.result;
    } else {
      error.value = res.error?.message ?? 'Failed to load rule';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to fetch rule';
  }
}

async function handleSignOut() {
  await authClient.signOut();
  await navigateTo('/');
}

async function handleToggleRule(id: string, inactive: boolean) {
  if (pendingRuleProposal.value) {
    showProposalModal.value = true;
    return;
  }
  try {
    const res = await $fetch<ApiEnvelope<RuleMutationResult>>(`/api/rule/${id}`, {
      method: 'PATCH',
      baseURL: apiBase || undefined,
      credentials: 'same-origin',
      body: { inactive },
    });
    retainPendingProposal(res, id, 'update_rule', inactive);
  } catch (e) {
    toast.add({
      title: 'Failed to propose BalanceFrame classification change',
      description: e instanceof Error ? e.message : 'Connection error',
      color: 'error',
      duration: 10000,
    });
  }
}
async function handleDeleteRule(id: string) {
  if (pendingRuleProposal.value) {
    showProposalModal.value = true;
    return;
  }
  const confirmed = window.confirm(
    'Delete this rule from Actual? This starts a separate human-approved deletion. The rule remains in Actual until the proposal is explicitly executed.',
  );
  if (!confirmed) return;
  try {
    const res = await $fetch<ApiEnvelope<RuleMutationResult>>(`/api/rule/${id}`, {
      method: 'DELETE',
      baseURL: apiBase || undefined,
      credentials: 'same-origin',
    });
    retainPendingProposal(res, id, 'delete_rule');
  } catch (e) {
    toast.add({
      title: 'Failed to propose Actual rule deletion',
      description: e instanceof Error ? e.message : 'Connection error',
      color: 'error',
      duration: 10000,
    });
  }
}

function retainPendingProposal(
  response: ApiEnvelope<RuleMutationResult>,
  ruleId: string,
  operation: 'update_rule' | 'delete_rule',
  inactive?: boolean,
): void {
  const result = response.result;
  const proposal = result?.proposal;
  if (
    response.status !== 'ok' ||
    !result ||
    result.applied !== false ||
    result.verified !== false ||
    !isProposalApprovalView(proposal) ||
    proposal.operation !== operation ||
    proposal.disposition !== 'approval_required' ||
    proposal.payload === null ||
    !('ruleId' in proposal.payload) ||
    proposal.payload.kind !== operation ||
    proposal.payload.ruleId !== ruleId ||
    (operation === 'update_rule' &&
      (!('inactive' in proposal.payload) || proposal.payload.inactive !== inactive))
  ) {
    throw new Error(
      response.error?.message ?? 'The server did not return an exact pending rule proposal.',
    );
  }
  pendingRuleProposal.value = proposal;
  showProposalModal.value = true;
}

async function handleRuleProposalAccepted(proposalId: string): Promise<void> {
  if (pendingRuleProposal.value?.id !== proposalId) return;
  pendingRuleProposal.value = null;
  showProposalModal.value = false;
  await loadRules();
}
</script>
