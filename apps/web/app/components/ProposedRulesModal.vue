<template>
  <UModal :open="open" @close="closeModal">
    <template #content>
      <UCard>
        <template #header>
          <h2 class="font-semibold text-lg">Proposed rules and review requests</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Review the exact server proposal, record human approval separately, then explicitly execute.
          </p>
        </template>

        <p v-if="approvalError" role="alert" class="mb-3 text-sm text-red-700">
          {{ approvalError }}
        </p>
        <p v-if="approvalOutcome" role="status" class="mb-3 text-sm text-green-700">
          {{ approvalOutcome }}
        </p>
        <UButton
          v-for="proposalId in unavailableIncomingProposalIds"
          :key="proposalId"
          label="Refresh proposal view"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="busy || loadingProposalId !== null"
          @click="loadProposal(proposalId, true)"
        />

        <section v-if="proposalEntries.length" class="space-y-4">
          <h3 class="font-medium">Exact server proposal snapshot</h3>
          <article
            v-for="entry in proposalEntries"
            :key="entry.proposal.id"
            class="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 class="font-medium">{{ proposalTitle(entry.proposal.operation) }}</h4>
                <p class="text-xs text-gray-500">Proposal {{ entry.proposal.id }}</p>
                <p v-if="entry.reviewId" class="text-xs text-gray-500">Review {{ entry.reviewId }}</p>
              </div>
              <UBadge color="warning" variant="soft" :label="entry.proposal.disposition" />
            </div>

            <dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <div><dt class="inline font-medium">Requester: </dt><dd class="inline break-all">{{ entry.proposal.requesterActorId }}</dd></div>
              <div>
                <dt class="inline font-medium">Requester membership epoch: </dt>
                <dd class="inline">{{ entry.proposal.requesterMembershipId }} · current {{ entry.proposal.requesterMembershipCurrent ?? 'unavailable' }}</dd>
              </div>
              <div><dt class="inline font-medium">Space / budget: </dt><dd class="inline">{{ entry.proposal.spaceId }} / {{ entry.proposal.budgetId }}</dd></div>
              <div><dt class="inline font-medium">Captured governance policy: </dt><dd class="inline">{{ entry.proposal.governancePolicyVersion }}</dd></div>
              <div><dt class="inline font-medium">Current governance policy: </dt><dd class="inline">{{ entry.proposal.currentGovernancePolicyVersion ?? 'Unavailable' }}</dd></div>
              <div><dt class="inline font-medium">{{ policyVersionLabel(entry.proposal.operation) }}: </dt><dd class="inline">{{ entry.proposal.policyVersion }}</dd></div>
              <div><dt class="inline font-medium">Required approvers: </dt><dd class="inline">{{ entry.proposal.requiredApprovers }}</dd></div>
              <div><dt class="inline font-medium">Expires: </dt><dd class="inline">{{ entry.proposal.expiresAt }}</dd></div>
              <div class="break-all sm:col-span-2"><dt class="inline font-medium">Displayed payload hash: </dt><dd class="inline font-mono">{{ entry.proposal.payloadHash }}</dd></div>
            </dl>

            <div>
              <h5 class="text-sm font-medium">Current eligible human approvals</h5>
              <ul v-if="entry.proposal.approvers.length" class="mt-1 list-disc pl-5 text-sm">
                <li v-for="(approver, index) in entry.proposal.approvers" :key="`${approver.actorId}:${approver.issuedAt}:${index}`">
                  {{ approver.actorId }} · {{ approver.issuedAt }} · expires {{ approver.expiresAt }}
                </li>
              </ul>
              <p v-else class="mt-1 text-sm text-gray-500">No current eligible approvals.</p>
            </div>

            <section v-if="entry.nativePayload" class="space-y-2 rounded border p-3">
              <h5 class="font-medium">Standalone Actual rule payload</h5>
              <p class="text-sm">Global future effect: this exact payee-ID rule applies to future matching transactions throughout the budget, not just the currently reviewed accounts.</p>
              <pre aria-label="Standalone Actual rule payload" class="overflow-x-auto text-xs">{{ entry.nativePayload }}</pre>
              <a
                :href="`data:application/json;charset=utf-8,${encodeURIComponent(entry.nativePayload)}`"
                :download="`actual-rule-${entry.proposal.id}.json`"
                class="inline-block underline focus-visible:outline focus-visible:outline-2"
              >Download standalone Actual rule JSON</a>
              <h5 class="font-medium">Complete reviewed current impact, category differences and conflicts</h5>
              <p class="text-sm">Matched IDs include unchanged-category matches. “wouldChange: false” is a match with no category change, not a financial execution.</p>
              <template v-if="entry.nativeImpact">
                <p>Current matched transactions: {{ entry.nativeImpact.transactionsMatched }}</p>
                <p>Full affected transaction IDs: {{ entry.nativeImpact.transactionsAffected.join(', ') || 'None' }}</p>
                <p>Existing native rule conflicts: {{ entry.nativeImpact.conflicts.join(', ') || 'None' }}</p>
                <div class="overflow-x-auto">
                  <table class="w-full text-left text-sm">
                    <caption class="text-left font-medium">Complete reviewed category differences (including unchanged matches), paged 100 rows at a time</caption>
                    <thead><tr><th scope="col">Transaction ID / payee</th><th scope="col">Exact source amount</th><th scope="col">Current category ID</th><th scope="col">Proposed category ID</th><th scope="col">Change</th></tr></thead>
                    <tbody><tr v-for="example in entry.nativeImpact.examples.slice((impactPages[entry.proposal.id] ?? 0) * 100, ((impactPages[entry.proposal.id] ?? 0) + 1) * 100)" :key="example.txId"><th scope="row">{{ example.txId }} / {{ example.payee ?? 'Unknown' }}</th><td><SemanticAmount :amount="example.amount" /></td><td>{{ example.currentCategory ?? 'Uncategorized' }}</td><td>{{ entry.nativeCategoryId }}</td><td>{{ example.wouldChange ? 'Would change category' : 'Matched; category unchanged' }}</td></tr></tbody>
                  </table>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                  <button type="button" :disabled="(impactPages[entry.proposal.id] ?? 0) === 0" class="underline" @click="impactPages[entry.proposal.id] = (impactPages[entry.proposal.id] ?? 0) - 1">Previous impact page</button>
                  <p>Page {{ (impactPages[entry.proposal.id] ?? 0) + 1 }} · {{ entry.nativeImpact.examples.length }} complete reviewed rows. No rows omitted from the review data.</p>
                  <button type="button" :disabled="((impactPages[entry.proposal.id] ?? 0) + 1) * 100 >= entry.nativeImpact.examples.length" class="underline" @click="impactPages[entry.proposal.id] = (impactPages[entry.proposal.id] ?? 0) + 1">Next impact page</button>
                </div>
                <details @toggle="impactJsonOpen[entry.proposal.id] = ($event.currentTarget as HTMLDetailsElement).open"><summary class="cursor-pointer font-medium">Exact complete reviewed simulation JSON</summary><pre v-if="impactJsonOpen[entry.proposal.id]" aria-label="Complete reviewed rule simulation" class="overflow-x-auto text-xs">{{ JSON.stringify(entry.nativeImpact, null, 2) }}</pre></details>
              </template>
              <p v-else role="alert">Reviewed simulation unavailable. Refresh the proposal before approval or execution.</p>
              <p class="text-sm">Creating, exporting or approving this proposal does not write to Actual. Execution is a separate governed action; changed source facts require a new review and approval.</p>
            </section>
            <div v-if="entry.proposal.privateEnvelopeVisible">
              <h5 class="text-sm font-medium">Exact persisted payload</h5>
              <pre class="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs dark:bg-gray-950">{{ JSON.stringify(entry.proposal.payload, null, 2) }}</pre>
            </div>
            <div v-if="entry.proposal.privateEnvelopeVisible">
              <h5 class="text-sm font-medium">Hash-bound preconditions</h5>
              <pre class="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs dark:bg-gray-950">{{ JSON.stringify(entry.proposal.preconditions, null, 2) }}</pre>
            </div>
            <p v-if="!entry.proposal.privateEnvelopeVisible" role="status" class="text-sm text-amber-700">Exact financial terms require independent read permissions. Approval is unavailable until those permissions are granted.</p>
            <p v-if="entry.stale" role="status" class="text-sm text-amber-700">This proposal is stale. Refresh its exact view before retrying approval or execution.</p>
            <p v-if="entry.simulationStatus" class="text-sm text-gray-500">Simulation: {{ entry.simulationStatus }}</p>
            <pre v-if="entry.simulation !== null" class="overflow-x-auto rounded bg-gray-50 p-2 text-xs dark:bg-gray-950">{{ JSON.stringify(entry.simulation, null, 2) }}</pre>

            <div class="flex flex-wrap gap-2">
              <UButton
                label="Refresh proposal view"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="busy"
                @click="loadProposal(entry.proposal.id)"
              />
              <UButton
                v-if="entry.proposal.canExecute"
                :disabled="busy || entry.stale"
                color="primary"
                variant="solid"
                size="xs"
                @click="executeProposal(entry.proposal.id)"
              >
                {{ executeLabel(entry.proposal.operation) }}
              </UButton>
            </div>
          </article>

          <div v-if="canApproveDisplayedReviews" class="space-y-2 rounded border border-gray-200 p-3 dark:border-gray-700">
            <p class="text-sm">This one action submits the ordered review IDs and the exact displayed hashes above. Approval does not execute any item.</p>
            <label class="block space-y-1 text-sm">
              <span class="font-medium">{{ confirmationLabel }}</span>
              <input v-model="password" type="password" autocomplete="current-password" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" />
            </label>
            <UButton
              label="Reauthenticate and approve displayed reviews"
              color="primary"
              variant="solid"
              :loading="busy"
              :disabled="busy || !password"
              @click="approveDisplayedReviews"
            />
          </div>

          <div v-else-if="singleApprovalProposal?.canApprove" class="space-y-2 rounded border border-gray-200 p-3 dark:border-gray-700">
            <label class="block space-y-1 text-sm">
              <span class="font-medium">{{ confirmationLabel }}</span>
              <input v-model="password" type="password" autocomplete="current-password" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" />
            </label>
            <UButton
              label="Reauthenticate and approve exact proposal"
              color="primary"
              variant="solid"
              :loading="busy"
              :disabled="busy || !password || singleApprovalStale"
              @click="approveExactProposal"
            />
          </div>
        </section>
        <label v-if="!hasApprovalControl && visibleProposals.length" class="my-3 block space-y-1 text-sm">
          <span class="font-medium">{{ confirmationLabel }}</span>
          <input v-model="password" type="password" autocomplete="current-password" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" />
        </label>
        <section v-if="visibleProposals.length" class="mt-5 space-y-3">
          <h3 class="font-medium">Other proposals</h3>
          <article
            v-for="prop in visibleProposals"
            :key="prop.id"
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div class="min-w-0 flex-1">
              <p class="font-medium truncate">{{ merchantFromPreconditions(prop.preconditions) }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {{ prop.operation }} · Category: <code>{{ prop.categoryId }}</code> · Expires {{ prop.expiresAt }}
              </p>
              <p class="text-xs text-gray-400">Created {{ formatDate(prop.createdAt) }} · Simulation {{ prop.simulationStatus }}</p>
            </div>
            <div class="flex gap-2">
              <UButton
                label="Review exact proposal"
                color="primary"
                variant="solid"
                size="xs"
                :loading="loadingProposalId === prop.id"
                :disabled="busy"
                @click="loadProposal(prop.id, true)"
              />
              <UButton
                label="Reauthenticate and discard"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="busy || !password"
                @click="onDiscard(prop.id)"
              />
            </div>
          </article>
        </section>

        <div v-if="!proposalEntries.length && !visibleProposals.length" class="text-center py-8 text-gray-400">
          No active proposals.
        </div>

        <template #footer>
          <div class="flex justify-end">
            <UButton label="Close" color="neutral" variant="ghost" @click="closeModal" />
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { z } from 'zod';
import SemanticAmount from './SemanticAmount.vue';
import type { RuleSimulationResult } from '@balanceframe/application';
import { reauthenticateHuman } from '../utils/reauthentication';
import { isProposalApprovalView } from '../../types/review-client';
import type { PendingProposalApproval } from '../../types/review-client';
import type { ProposalApprovalView } from '../../server/utils/proposal-approval-view';
import { authClient } from '../../lib/auth-client';

const confirmationLabel = typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
  ? 'Disposable-demo confirmation (type CONFIRM)' : 'Account password';

export interface CategorizationProposalListItem {
  readonly id: string;
  readonly operation: string;
  readonly budgetId: string;
  readonly transactionId: string;
  readonly categoryId: string;
  readonly preconditions: string;
  readonly expiresAt: string;
  readonly actorId: string;
  readonly provenance: string;
  readonly providerModel: string | null;
  readonly correlationId: string | null;
  readonly supersededAt?: string | null;
  readonly createdAt: string;
  readonly simulationStatus: 'present' | 'missing' | 'stale';
}

interface ProposalDetailState {
  readonly proposal: ProposalApprovalView;
  readonly stale: boolean;
  readonly simulation: unknown | null;
  readonly simulationStatus: string | null;
}

interface DisplayedProposal extends PendingProposalApproval {
  readonly stale: boolean;
  readonly simulation: unknown | null;
  readonly simulationStatus: string | null;
  readonly nativePayload?: string | null;
  readonly nativeImpact?: RuleSimulationResult | null;
  readonly nativeCategoryId?: string | null;
}

interface ApiResponseBody {
  readonly status?: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string; readonly retryable?: boolean } | null;
}

const props = defineProps<{
  open: boolean;
  proposals: readonly CategorizationProposalListItem[];
  proposalApprovalViews: readonly PendingProposalApproval[];
  initialProposal?: ProposalApprovalView | null;
}>();

const emit = defineEmits<{
  close: [];
  accepted: [proposalId: string];
  discarded: [proposalId: string];
  error: [message: string, retryable: boolean];
}>();

const busy = ref(false);
const password = ref('');
const approvalError = ref('');
const approvalOutcome = ref('');
const loadingProposalId = ref<string | null>(null);
const impactPages = ref<Record<string, number>>({});
const impactJsonOpen = ref<Record<string, boolean>>({});
const selectedProposalId = ref<string | null>(null);
const proposalDetails = ref<Record<string, ProposalDetailState>>({});
const unavailableProposalIds = ref<Record<string, boolean>>({});
const unavailableIncomingProposalIds = computed(() => {
  const ids = props.proposalApprovalViews.map((entry) => entry.proposal.id);
  if (props.initialProposal && !ids.includes(props.initialProposal.id)) ids.push(props.initialProposal.id);
  return ids.filter((id) => unavailableProposalIds.value[id]);
});
const incomingListUnavailable = ref(false);
const visibleProposals = computed(() => incomingListUnavailable.value ? [] : props.proposals);
const session = authClient.useSession();
const identityKey = computed(() => {
  const user = session.value?.data?.user;
  return user ? user.id ?? user.email : null;
});
let lifetime = 0;

function clearPrivateState(): void {
  lifetime += 1;
  for (const entry of props.proposalApprovalViews) unavailableProposalIds.value[entry.proposal.id] = true;
  if (props.initialProposal) unavailableProposalIds.value[props.initialProposal.id] = true;
  proposalDetails.value = {};
  selectedProposalId.value = null;
  password.value = '';
  approvalError.value = '';
  approvalOutcome.value = '';
  loadingProposalId.value = null;
  impactPages.value = {};
  impactJsonOpen.value = {};
  busy.value = false;
}

function closeModal(): void {
  clearPrivateState();
  emit('close');
}

watch(() => props.open, (open) => {
  if (!open) clearPrivateState();
}, { flush: 'sync' });
watch(identityKey, () => {
  clearPrivateState();
  incomingListUnavailable.value = true;
}, { flush: 'sync' });
watch(() => props.proposals, () => {
  incomingListUnavailable.value = false;
});
watch(() => props.proposalApprovalViews, (views, previous) => {
  for (const entry of previous) {
    if (!views.some((current) => current.proposal.id === entry.proposal.id)) {
      delete proposalDetails.value[entry.proposal.id];
      delete unavailableProposalIds.value[entry.proposal.id];
      if (selectedProposalId.value === entry.proposal.id) selectedProposalId.value = null;
    }
  }
  for (const entry of views) {
    if (previous.find((old) => old.proposal.id === entry.proposal.id)?.proposal !== entry.proposal) {
      delete proposalDetails.value[entry.proposal.id];
      delete unavailableProposalIds.value[entry.proposal.id];
    }
  }
});
watch(() => props.initialProposal, (proposal, previous) => {
  if (previous && proposal !== previous) {
    delete proposalDetails.value[previous.id];
    delete unavailableProposalIds.value[previous.id];
    if (selectedProposalId.value === previous.id) selectedProposalId.value = null;
  }
  if (proposal && proposal !== previous) delete unavailableProposalIds.value[proposal.id];
});
onScopeDispose(clearPrivateState);

const selectedProposalDetail = computed(() =>
  selectedProposalId.value ? proposalDetails.value[selectedProposalId.value] ?? null : null,
);

const proposalEntries = computed<DisplayedProposal[]>(() => {
  const entries: DisplayedProposal[] = props.proposalApprovalViews
    .filter((entry) => !unavailableProposalIds.value[entry.proposal.id])
    .map((entry) => {
    const refreshed = proposalDetails.value[entry.proposal.id];
    return {
      reviewId: entry.reviewId,
      proposal: refreshed?.proposal ?? entry.proposal,
      stale: refreshed?.stale ?? false,
      simulation: refreshed?.simulation ?? null,
      simulationStatus: refreshed?.simulationStatus ?? null,
    };
  });
  const initial = props.initialProposal;
  if (initial && !unavailableProposalIds.value[initial.id] && !entries.some((entry) => entry.proposal.id === initial.id)) {
    const refreshed = proposalDetails.value[initial.id];
    entries.unshift({
      reviewId: '',
      proposal: refreshed?.proposal ?? initial,
      stale: refreshed?.stale ?? false,
      simulation: refreshed?.simulation ?? null,
      simulationStatus: refreshed?.simulationStatus ?? null,
    });
  }
  const selected = selectedProposalDetail.value;
  if (selected && !entries.some((entry) => entry.proposal.id === selected.proposal.id)) {
    entries.push({
      reviewId: '',
      proposal: selected.proposal,
      stale: selected.stale,
      simulation: selected.simulation,
      simulationStatus: selected.simulationStatus,
    });
  }
  return entries.map((entry) => {
    const nativeRule = entry.proposal.privateEnvelopeVisible && entry.proposal.operation === 'create_rule'
      ? standaloneRuleSchema.safeParse(entry.proposal.preconditions?.nativeRule)
      : null;
    const impact = nativeRule?.success ? reviewedImpactSchema.safeParse(entry.proposal.preconditions?.reviewedSimulation) : null;
    return {
      ...entry,
      nativePayload: nativeRule?.success ? JSON.stringify(nativeRule.data, null, 2) : null,
      nativeCategoryId: nativeRule?.success ? nativeRule.data.actions[0].value : null,
      nativeImpact: impact?.success ? impact.data : null,
    };
  });
});

const singleApprovalProposal = computed(() => {
  if (props.proposalApprovalViews.length > 1) return null;
  return selectedProposalDetail.value?.proposal ?? proposalEntries.value[0]?.proposal ?? null;
});
const canApproveDisplayedReviews = computed(
  () =>
    props.proposalApprovalViews.length > 1 &&
    props.proposalApprovalViews.every(({ proposal }) => {
      const displayed = proposalEntries.value.find((entry) => entry.proposal.id === proposal.id);
      return displayed?.proposal.canApprove === true && !displayed.stale;
    }),
);
const hasApprovalControl = computed(
  () => canApproveDisplayedReviews.value || singleApprovalProposal.value?.canApprove === true,
);
const singleApprovalStale = computed(() => {
  if (selectedProposalDetail.value) return selectedProposalDetail.value.stale;
  return proposalEntries.value[0]?.stale ?? false;
});

const standaloneRuleSchema = z.object({
  stage: z.literal('post'),
  conditionsOp: z.literal('and'),
  conditions: z.tuple([z.object({ field: z.literal('payee'), op: z.literal('is'), value: z.string().min(1) }).strict()]),
  actions: z.tuple([z.object({ op: z.literal('set'), field: z.literal('category'), value: z.string().min(1) }).strict()]),
}).strict();

const reviewedImpactSchema = z.object({
  ruleId: z.string(), name: z.string(),
  transactionsMatched: z.number().int().nonnegative(),
  transactionsAffected: z.array(z.string()),
  categoryDistribution: z.record(z.string(), z.number().int().nonnegative()),
  conflicts: z.array(z.string()),
  examples: z.array(z.object({
    txId: z.string(), payee: z.string().nullable(),
    amount: z.object({ minorUnits: z.string().regex(/^-?\d+$/), currency: z.string().regex(/^[A-Z]{3}$/) }),
    currentCategory: z.string().nullable(), wouldChange: z.boolean(),
  })),
});

async function responseBody(response: Response): Promise<ApiResponseBody> {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`INVALID_RESPONSE: The server returned an invalid response (HTTP ${response.status}).`);
  }
  return body as ApiResponseBody;
}

function responseError(body: ApiResponseBody, fallback: string): string {
  const message = typeof body.error?.message === 'string' ? body.error.message : fallback;
  return typeof body.error?.code === 'string' ? `${body.error.code}: ${message}` : message;
}

function merchantFromPreconditions(preconditionsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(preconditionsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const merchant = (parsed as Record<string, unknown>).merchant;
      return typeof merchant === 'string' ? merchant : '—';
    }
    return '—';
  } catch {
    return '—';
  }
}

function formatDate(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso;
}

function proposalTitle(operation: ProposalApprovalView['operation']): string {
  switch (operation) {
    case 'set_category':
      return 'Category change';
    case 'create_rule':
      return 'Rule creation';
    case 'update_rule':
      return 'BalanceFrame classification update';
    case 'delete_rule':
      return 'Actual rule deletion';
  }
}

function policyVersionLabel(operation: ProposalApprovalView['operation']): string {
  return operation === 'set_category' ? 'Financial policy version' : 'Native algorithm version';
}

function executeLabel(operation: ProposalApprovalView['operation']): string {
  switch (operation) {
    case 'set_category':
      return 'Execute exact categorization';
    case 'update_rule':
      return 'Execute exact rule update';
    case 'delete_rule':
      return 'Execute exact rule deletion';
    case 'create_rule':
      return 'Execute exact rule proposal';
  }
}

async function loadProposal(proposalId: string, select = false): Promise<void> {
  if (loadingProposalId.value) return;
  if (!props.open) return;
  const requestLifetime = lifetime;
  loadingProposalId.value = proposalId;
  impactPages.value[proposalId] = 0;
  approvalError.value = '';
  try {
    const response = await fetch(`/api/proposal/${encodeURIComponent(proposalId)}`, {
      credentials: 'same-origin',
    });
    const body = await responseBody(response);
    if (requestLifetime !== lifetime) return;
    if (!response.ok || body.status !== 'ok' || !body.result || typeof body.result !== 'object') {
      throw new Error(responseError(body, `Failed to load proposal (HTTP ${response.status}).`));
    }
    const result = body.result as {
      proposal?: unknown;
      stale?: unknown;
      simulation?: unknown;
      simulationStatus?: unknown;
    };
    if (!isProposalApprovalView(result.proposal)) {
      throw new Error('INVALID_PROPOSAL_VIEW: The server did not return the exact proposal snapshot.');
    }
    proposalDetails.value = {
      ...proposalDetails.value,
      [proposalId]: {
        proposal: result.proposal,
        stale: result.stale === true,
        simulation: result.simulation ?? null,
        simulationStatus: typeof result.simulationStatus === 'string' ? result.simulationStatus : null,
      },
    };
    if (select) selectedProposalId.value = proposalId;
    delete unavailableProposalIds.value[proposalId];
  } catch (cause) {
    if (requestLifetime !== lifetime) return;
    clearPrivateState();
    approvalError.value = cause instanceof Error ? cause.message : 'Failed to load the exact proposal view.';
  } finally {
    if (requestLifetime === lifetime) loadingProposalId.value = null;
  }
}

async function approveExactProposal(): Promise<void> {
  const requestLifetime = lifetime;
  const proposal = singleApprovalProposal.value;
  const passwordSnapshot = password.value;
  if (!proposal || !proposal.canApprove || !passwordSnapshot || busy.value || singleApprovalStale.value) return;
  const proposalId = proposal.id;
  const displayedPayloadHash = proposal.payloadHash;
  busy.value = true;
  approvalError.value = '';
  approvalOutcome.value = '';
  try {
    await reauthenticateHuman(passwordSnapshot);
    if (requestLifetime !== lifetime) return;
    const response = await fetch(`/api/proposal/${encodeURIComponent(proposalId)}/approve`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payloadHash: displayedPayloadHash }),
    });
    const body = await responseBody(response);
    if (requestLifetime !== lifetime) return;
    if (!response.ok || body.status !== 'ok' || !body.result) {
      throw new Error(responseError(body, `Proposal approval failed (HTTP ${response.status}).`));
    }
    approvalOutcome.value = 'Human approval recorded. The proposal has not been executed.';
    await loadProposal(proposalId);
  } catch (cause) {
    if (requestLifetime !== lifetime) return;
    approvalError.value = cause instanceof Error ? cause.message : 'Proposal approval failed.';
  } finally {
    if (requestLifetime === lifetime) {
      password.value = '';
      busy.value = false;
    }
  }
}

async function approveDisplayedReviews(): Promise<void> {
  const requestLifetime = lifetime;
  const snapshots = props.proposalApprovalViews.map(({ reviewId, proposal }) => {
    const displayed = proposalEntries.value.find((entry) => entry.proposal.id === proposal.id);
    return {
      reviewId,
      proposalId: proposal.id,
      payloadHash: displayed?.proposal.payloadHash ?? proposal.payloadHash,
      canApprove: displayed?.proposal.canApprove === true,
      stale: displayed?.stale ?? true,
    };
  });
  const passwordSnapshot = password.value;
  if (!snapshots.length || snapshots.some((snapshot) => !snapshot.canApprove || snapshot.stale) ||
      !passwordSnapshot || busy.value) return;
  const ids = snapshots.map((snapshot) => snapshot.reviewId);
  const payloadHashes = Object.fromEntries(
    snapshots.map((snapshot) => [snapshot.reviewId, snapshot.payloadHash]),
  );
  busy.value = true;
  approvalError.value = '';
  approvalOutcome.value = '';
  try {
    await reauthenticateHuman(passwordSnapshot);
    if (requestLifetime !== lifetime) return;
    const response = await fetch('/api/review/approve-bulk', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, payloadHashes }),
    });
    const body = await responseBody(response);
    if (requestLifetime !== lifetime) return;
    if (!response.ok || body.status !== 'ok' || !body.result) {
      throw new Error(responseError(body, `Bulk proposal approval failed (HTTP ${response.status}).`));
    }
    approvalOutcome.value = 'The server recorded the displayed approvals. No review item was executed.';
    for (const snapshot of snapshots) {
      if (requestLifetime !== lifetime) break;
      await loadProposal(snapshot.proposalId);
    }
  } catch (cause) {
    if (requestLifetime !== lifetime) return;
    approvalError.value = cause instanceof Error ? cause.message : 'Bulk proposal approval failed.';
  } finally {
    if (requestLifetime === lifetime) {
      password.value = '';
      busy.value = false;
    }
  }
}

async function executeProposal(proposalId: string): Promise<void> {
  const requestLifetime = lifetime;
  const entry = proposalEntries.value.find((item) => item.proposal.id === proposalId);
  if (busy.value || !entry || !entry.proposal.canExecute || entry.stale) return;
  const displayedPayloadHash = entry.proposal.payloadHash;
  busy.value = true;
  approvalError.value = '';
  approvalOutcome.value = '';
  try {
    const response = await fetch(`/api/proposal/${encodeURIComponent(proposalId)}/execute`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payloadHash: displayedPayloadHash }),
    });
    const body = await responseBody(response);
    if (requestLifetime !== lifetime) return;
    const result = body.result;
    if (
      !response.ok ||
      body.status !== 'ok' ||
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      (result as Record<string, unknown>).proposalId !== proposalId ||
      (result as Record<string, unknown>).verified !== true
    ) {
      throw new Error(responseError(body, `Proposal execution was not verified (HTTP ${response.status}).`));
    }
    emit('accepted', proposalId);
    delete proposalDetails.value[proposalId];
    selectedProposalId.value = null;
  } catch (cause) {
    if (requestLifetime !== lifetime) return;
    approvalError.value = cause instanceof Error ? cause.message : 'Proposal execution failed.';
  } finally {
    if (requestLifetime === lifetime) busy.value = false;
  }
}

async function onDiscard(proposalId: string): Promise<void> {
  const requestLifetime = lifetime;
  const passwordSnapshot = password.value;
  if (busy.value || !passwordSnapshot || !visibleProposals.value.some((proposal) => proposal.id === proposalId)) return;
  busy.value = true;
  approvalError.value = '';
  approvalOutcome.value = '';
  try {
    await reauthenticateHuman(passwordSnapshot);
    if (requestLifetime !== lifetime) return;
    const response = await fetch(`/api/proposal/${encodeURIComponent(proposalId)}/discard`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await responseBody(response);
    if (requestLifetime !== lifetime) return;
    const result = body.result;
    if (
      !response.ok ||
      body.status !== 'ok' ||
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      (result as Record<string, unknown>).proposalId !== proposalId ||
      (result as Record<string, unknown>).discarded !== true
    ) {
      throw new Error(responseError(body, `Proposal discard failed (HTTP ${response.status}).`));
    }
    emit('discarded', proposalId);
    delete proposalDetails.value[proposalId];
    selectedProposalId.value = null;
  } catch (cause) {
    if (requestLifetime !== lifetime) return;
    approvalError.value = cause instanceof Error ? cause.message : 'Proposal discard failed.';
  } finally {
    if (requestLifetime === lifetime) {
      password.value = '';
      busy.value = false;
    }
  }
}

</script>
