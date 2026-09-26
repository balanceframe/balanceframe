<template>
  <section class="space-y-4" aria-label="Session completion">
    <UCard>
      <template #header><h2 class="font-semibold">Complete saved spend session</h2></template>
      <p class="text-sm">
        Review the exact debit and category splits before approval. Approval only records human
        consent; execution is a separate explicit action and writes to Actual.
      </p>
      <p v-if="sessionChanged" role="status" class="mt-2 text-amber-700">
        Session changed. This completion review is stale; reload the current saved session before
        proposing or acting on it.
      </p>
      <p v-if="sessionExpired" role="status" class="mt-2 text-amber-700">
        Session expired. A completion cannot be proposed from this saved session.
      </p>
      <p v-if="!hasCard" role="status" class="mt-2 text-amber-700">
        The current Card has no exact cart to complete.
      </p>
      <p v-if="hasCard && !fundedCard" role="status" class="mt-2 text-amber-700">
        The current Card is not funded now; review its blockers before proposing a completion.
      </p>
      <form class="mt-4 space-y-3" @submit.prevent="propose">
        <fieldset
          :disabled="saving || busy || sessionChanged || sessionExpired || !fundedCard"
          class="grid gap-3 sm:grid-cols-2"
        >
          <label class="grid gap-1 text-sm">
            Payee name (optional)
            <input
              v-model="payeeName"
              data-testid="completion-payee"
              class="rounded border px-2 py-1"
              type="text"
              maxlength="256"
            />
          </label>
          <label class="grid gap-1 text-sm sm:col-span-2">
            Notes (optional)
            <textarea
              v-model="notes"
              data-testid="completion-notes"
              class="rounded border px-2 py-1"
              maxlength="2048"
              rows="2"
            />
          </label>
        </fieldset>
        <UButton
          data-testid="completion-propose"
          :disabled="proposeDisabled"
          @click="propose"
        >
          {{ busy ? 'Updating completion…' : 'Propose exact completion' }}
        </UButton>
      </form>
    </UCard>

    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>

    <UCard v-for="completion in completions" :key="completion.id" class="space-y-4">
      <template #header>
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="font-semibold">Completion review</h2>
          <p data-testid="completion-status" class="font-semibold">
            {{ statusLabel(completion) }}
          </p>
        </div>
      </template>
      <NuxtLink
        :to="reviewPath(completion.id)"
        :data-testid="`completion-coapproval-link-${completion.id}`"
        class="text-sm underline"
      >
        Open co-approval review
      </NuxtLink>

      <p class="text-sm">
        Approvals {{ completion.approvalCount }} / {{ completion.requiredApprovals }} · Proposal
        version {{ completion.version }}
      </p>
      <p v-if="completion.outcome" role="status" class="text-amber-700">
        Outcome: {{ humanize(completion.outcome) }}. Refresh and review the current evidence before
        taking any further action.
      </p>

      <section
        v-if="completion.debit"
        data-testid="completion-debit"
        class="rounded border p-3 text-sm"
      >
        <h3 class="font-semibold">Exact debit</h3>
        <dl class="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <dt>Amount</dt>
            <dd data-testid="completion-debit-amount">
              <SemanticAmount
                v-if="debitAmount(completion)"
                :amount="debitAmount(completion)"
                :negative="completion.debit.amount < 0"
              />
              <span v-else>Unknown amount</span>
            </dd>
          </div>
          <div>
            <dt>Payment account</dt>
            <dd data-testid="completion-debit-account">{{ completion.debit.accountId }}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd data-testid="completion-date">{{ completion.debit.date }}</dd>
          </div>
          <div>
            <dt>Payee</dt>
            <dd>{{ completion.debit.payeeName ?? 'Not provided' }}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt>Notes</dt>
            <dd>{{ completion.debit.notes ?? 'Not provided' }}</dd>
          </div>
        </dl>

        <section class="mt-3">
          <h4 class="font-medium">Category charges</h4>
          <ul class="mt-1 space-y-1">
            <li
              v-for="charge in completion.debit.categoryCharges"
              :key="charge.categoryId"
              :data-testid="`completion-category-${charge.categoryId}`"
            >
              {{ charge.categoryId }}:
              <SemanticAmount :amount="charge.amount" />
            </li>
          </ul>
        </section>

        <section v-if="completion.debit.splits.length" class="mt-3">
          <h4 class="font-medium">Ledger splits</h4>
          <ul class="mt-1 space-y-1">
            <li
              v-for="split in completion.debit.splits"
              :key="split.categoryId"
              :data-testid="`completion-split-${split.categoryId}`"
            >
              {{ split.categoryId }}:
              <SemanticAmount
                v-if="splitAmount(completion, split)"
                :amount="splitAmount(completion, split)"
                :negative="split.amount < 0"
              />
              <span v-else>Unknown amount</span>
            </li>
          </ul>
        </section>
      </section>
      <p v-else role="status" class="text-amber-700">Restricted completion details.</p>

      <p v-if="cooldownActive(completion)" role="status" class="text-amber-700">
        Cooldown until {{ completion.cooldownUntil }}. Refresh readiness after this interval before
        approval.
      </p>
      <p
        v-else-if="completion.cooldownUntil && completion.phase === 'proposed' && !completion.canApprove"
        role="status"
        class="text-amber-700"
      >
        Approval is not currently ready. Refresh the completion and review the latest status.
      </p>

      <p
        v-if="completion.phase === 'write_intent' || completion.phase === 'review_required' || completion.reviewRequired"
        role="status"
        class="text-amber-700"
      >
        Human review required: the write outcome is uncertain and must not be treated as settled.
      </p>
      <p v-else-if="completion.importedTransactionId" role="status" class="text-amber-700">
        Import-linked transaction found. Review reconciliation evidence; this is not a verified manual
        transaction.
      </p>
      <p v-else-if="completion.manualTransactionId && completion.phase === 'verified'" role="status">
        Verified manual transaction: {{ completion.manualTransactionId }}
      </p>

      <div
        v-if="completion.debit && completion.payloadHash && completion.phase === 'proposed' && !completion.reviewRequired"
        class="space-y-2"
        aria-label="Completion approval"
      >
        <label class="flex items-start gap-2 text-sm">
          <input
            v-model="approveConfirmations[completion.id]"
            data-testid="completion-approve-confirmation"
            type="checkbox"
            :disabled="confirmationDisabled(completion)"
          />
          I reviewed the exact account, debit, date, payee, notes, and category splits above.
        </label>
        <UButton
          data-testid="completion-approve"
          :disabled="approveDisabled(completion)"
          @click="approve(completion)"
        >
          {{ busy ? 'Approving…' : 'Approve exact completion' }}
        </UButton>
      </div>

      <div
        v-if="completion.debit && completion.payloadHash && completion.phase === 'approved' && !completion.reviewRequired"
        class="space-y-2"
        aria-label="Completion execution"
      >
        <p class="text-sm">
          Approved, but not executed. No ledger transaction is written until you explicitly confirm
          execution below.
        </p>
        <label class="flex items-start gap-2 text-sm">
          <input
            v-model="executeConfirmations[completion.id]"
            data-testid="completion-execute-confirmation"
            type="checkbox"
            :disabled="confirmationDisabled(completion)"
          />
          I explicitly confirm writing this exact debit to the selected account.
        </label>
        <UButton
          data-testid="completion-execute"
          :disabled="executeDisabled(completion)"
          @click="execute(completion)"
        >
          {{ busy ? 'Executing…' : 'Execute exact completion' }}
        </UButton>
      </div>

      <UButton
        v-if="reconcileAllowed(completion)"
        data-testid="completion-reconcile"
        variant="ghost"
        :disabled="busy || saving || sessionChanged"
        @click="reconcile(completion)"
      >
        Check Actual reconciliation
      </UButton>

      <UButton
        data-testid="completion-refresh"
        variant="ghost"
        :disabled="busy || saving"
        @click="refresh"
      >
        Refresh completion readiness
      </UButton>
    </UCard>

    <p v-if="!completions.length && !busy" class="text-sm" data-testid="completion-none">
      No completion proposal exists for this saved session.
    </p>
    <p v-if="busy" role="status">Refreshing completion status…</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PublicSessionCompletion, PublicSpendSession } from '@balanceframe/application';
import type { Amount } from './types';
import SemanticAmount from './SemanticAmount.vue';
import { liquidityError, liquidityRequest } from '../utils/liquidity-client';

const props = defineProps<{ session: PublicSpendSession; saving?: boolean }>();

type CompletionDebit = NonNullable<PublicSessionCompletion['debit']>;
type CompletionSplit = CompletionDebit['splits'][number];

const completions = ref<PublicSessionCompletion[]>([]);
const busy = ref(false);
const error = ref('');
const payeeName = ref('');
const notes = ref('');
const approveConfirmations = ref<Record<string, boolean>>({});
const executeConfirmations = ref<Record<string, boolean>>({});
const initialSessionId = props.session.id;
const initialSessionVersion = props.session.version;
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

const saving = computed(() => props.saving === true);
const sessionChanged = computed(
  () => props.session.id !== initialSessionId || props.session.version !== initialSessionVersion,
);
const sessionExpired = computed(() => Date.parse(props.session.expiresAt) <= clock.value);
const hasCard = computed(() => Boolean(props.session.card?.cart));
const fundedCard = computed(() => hasCard.value && props.session.card?.outcome === 'funded_now');
const proposeDisabled = computed(
  () =>
    saving.value ||
    busy.value ||
    sessionChanged.value ||
    sessionExpired.value ||
    !fundedCard.value,
);

function touchClock() {
  clock.value = Date.now();
}
function pathFor(sessionId: string, completionId?: string, action?: 'approve' | 'execute' | 'reconcile') {
  const base = `/api/spend-sessions/${encodeURIComponent(sessionId)}/completions`;
  return completionId && action
    ? `${base}/${encodeURIComponent(completionId)}/${action}`
    : base;
}
function reviewPath(completionId: string) {
  return `/spend-sessions/${encodeURIComponent(props.session.id)}/completions/${encodeURIComponent(completionId)}`;
}
function attemptKey(scope: string, version: number) {
  const key = `${props.session.id}:${scope}:${version}`;
  const existing = attempts.get(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  attempts.set(key, created);
  return created;
}
const attempts = new Map<string, string>();

function humanize(value: string) {
  return value.replaceAll('_', ' ');
}
function statusLabel(completion: PublicSessionCompletion) {
  if (
    completion.reviewRequired ||
    completion.phase === 'write_intent' ||
    completion.phase === 'review_required'
  ) {
    return 'Human review required';
  }
  if (completion.importedTransactionId) return 'Import-linked transaction';
  if (completion.phase === 'verified' && completion.manualTransactionId)
    return 'Verified manual transaction';
  if (completion.phase === 'approved') return 'Approved — not executed';
  if (completion.phase === 'proposed') return 'Awaiting human approval';
  if (completion.phase === 'closed') return 'Closed';
  return humanize(completion.phase);
}
function currencyFor(completion: PublicSessionCompletion, categoryId: string) {
  return completion.debit?.categoryCharges.find((charge) => charge.categoryId === categoryId)?.amount
    .currency ?? completion.debit?.categoryCharges[0]?.amount.currency ?? null;
}
function signedAmount(value: number, currency: string | null): Amount | null {
  if (!currency || !Number.isSafeInteger(value)) return null;
  return { minorUnits: String(Math.abs(value)), currency };
}
function debitAmount(completion: PublicSessionCompletion): Amount | null {
  const debit = completion.debit;
  return debit ? signedAmount(debit.amount, debit.categoryCharges[0]?.amount.currency ?? null) : null;
}
function splitAmount(completion: PublicSessionCompletion, split: CompletionSplit): Amount | null {
  return signedAmount(split.amount, currencyFor(completion, split.categoryId));
}
function cooldownActive(completion: PublicSessionCompletion) {
  return Boolean(completion.cooldownUntil && Date.parse(completion.cooldownUntil) > clock.value);
}
function expired(completion: PublicSessionCompletion) {
  return Date.parse(completion.expiresAt) <= clock.value;
}
function detailsAvailable(completion: PublicSessionCompletion) {
  return Boolean(completion.debit && completion.payloadHash);
}
function confirmationDisabled(completion: PublicSessionCompletion) {
  return (
    saving.value ||
    busy.value ||
    sessionChanged.value ||
    expired(completion) ||
    !detailsAvailable(completion) ||
    completion.reviewRequired
  );
}
function approveDisabled(completion: PublicSessionCompletion) {
  return (
    confirmationDisabled(completion) ||
    !completion.canApprove ||
    cooldownActive(completion) ||
    !approveConfirmations.value[completion.id]
  );
}
function executeDisabled(completion: PublicSessionCompletion) {
  return (
    confirmationDisabled(completion) ||
    !completion.canExecute ||
    !executeConfirmations.value[completion.id]
  );
}
function reconcileAllowed(completion: PublicSessionCompletion) {
  return detailsAvailable(completion) &&
    (completion.phase === 'verified' ||
      completion.phase === 'write_intent' ||
      completion.phase === 'review_required');
}
function upsertCompletion(completion: PublicSessionCompletion) {
  const current = completions.value.findIndex((item) => item.id === completion.id);
  if (current < 0) completions.value = [...completions.value, completion];
  else completions.value[current] = completion;
}
async function reloadList(preferred?: PublicSessionCompletion) {
  const loaded = await liquidityRequest<PublicSessionCompletion[]>(pathFor(props.session.id));
  if (!preferred) {
    completions.value = loaded;
    return;
  }
  const index = loaded.findIndex((item) => item.id === preferred.id);
  if (index < 0) loaded.push(preferred);
  else if (preferred.version >= loaded[index]!.version) loaded[index] = preferred;
  completions.value = loaded;
}
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  touchClock();
  try {
    await reloadList();
  } catch (failure) {
    error.value = liquidityError(failure);
  } finally {
    busy.value = false;
  }
}
async function propose() {
  if (proposeDisabled.value) return;
  busy.value = true;
  error.value = '';
  touchClock();
  const body: Record<string, unknown> = {
    expectedSessionVersion: props.session.version,
    idempotencyKey: attemptKey('propose', props.session.version),
  };
  const payee = payeeName.value.trim();
  const note = notes.value.trim();
  if (payee) body.payeeName = payee;
  if (note) body.notes = note;
  try {
    const proposed = await liquidityRequest<PublicSessionCompletion>(
      pathFor(props.session.id),
      'POST',
      body,
    );
    upsertCompletion(proposed);
    await reloadList(proposed);
    approveConfirmations.value[proposed.id] = false;
    executeConfirmations.value[proposed.id] = false;
  } catch (failure) {
    error.value = liquidityError(failure);
  } finally {
    busy.value = false;
  }
}
async function act(completion: PublicSessionCompletion, action: 'approve' | 'execute' | 'reconcile') {
  if (
    busy.value ||
    saving.value ||
    sessionChanged.value ||
    (action === 'reconcile'
      ? !reconcileAllowed(completion)
      : action === 'approve'
        ? approveDisabled(completion)
        : executeDisabled(completion))
  )
    return;
  busy.value = true;
  error.value = '';
  touchClock();
  try {
    const updated = await liquidityRequest<PublicSessionCompletion>(
      pathFor(props.session.id, completion.id, action),
      'POST',
      {
        payloadHash: completion.payloadHash,
        expectedVersion: completion.version,
        idempotencyKey: attemptKey(action, completion.version),
      },
    );
    upsertCompletion(updated);
    await reloadList(updated);
    approveConfirmations.value[completion.id] = false;
    executeConfirmations.value[completion.id] = false;
  } catch (failure) {
    error.value = liquidityError(failure);
  } finally {
    busy.value = false;
  }
}
async function approve(completion: PublicSessionCompletion) {
  await act(completion, 'approve');
}
async function execute(completion: PublicSessionCompletion) {
  await act(completion, 'execute');
}
async function reconcile(completion: PublicSessionCompletion) {
  await act(completion, 'reconcile');
}

onMounted(() => {
  clockTimer = setInterval(touchClock, 1000);
  void refresh();
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});
</script>
