<template>
  <AnalysisPage title="Completion co-approval" :loading="loading" :error="error">
    <template #error-actions>
      <button type="button" class="underline" @click="load">Retry loading</button>
    </template>
    <template #content>
      <section v-if="completion" class="space-y-4" aria-label="Session completion co-approval">
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-baseline justify-between gap-3">
              <h1 class="font-semibold">Review exact completion</h1>
              <p data-testid="completion-status" class="font-semibold">
                {{ statusLabel(completion) }}
              </p>
            </div>
          </template>

          <p class="text-sm">
            This scoped review contains the exact debit proposed by the session owner. It loads only
            the proposal and does not expose the owner's private session. Approval records your
            consent only; execution is a separate explicit action.
          </p>
          <p class="mt-2 text-sm">
            Approvals {{ completion.approvalCount }} / {{ completion.requiredApprovals }} · Proposal
            version {{ completion.version }}
          </p>
          <p v-if="completion.outcome" role="status" class="mt-2 text-amber-700">
            Outcome: {{ humanize(completion.outcome) }}. Refresh and review the current evidence before
            taking any further action.
          </p>

          <section
            v-if="completion.debit"
            data-testid="completion-debit"
            class="mt-4 rounded border p-3 text-sm"
          >
            <h2 class="font-semibold">Exact debit</h2>
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
              <h3 class="font-medium">Category charges</h3>
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
              <h3 class="font-medium">Ledger splits</h3>
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
          <p v-else role="status" class="mt-4 text-amber-700">Restricted completion details.</p>

          <p v-if="cooldownActive(completion)" role="status" class="mt-3 text-amber-700">
            Cooldown until {{ completion.cooldownUntil }}. Refresh readiness after this interval before
            approval.
          </p>
          <p
            v-else-if="completion.cooldownUntil && completion.phase === 'proposed' && !completion.canApprove"
            role="status"
            class="mt-3 text-amber-700"
          >
            Approval is not currently ready. Refresh the completion and review the latest status.
          </p>
          <p
            v-if="completion.phase === 'write_intent' || completion.phase === 'review_required' || completion.reviewRequired"
            role="status"
            class="mt-3 text-amber-700"
          >
            Human review required: the write outcome is uncertain and must not be treated as settled.
          </p>
          <p v-else-if="completion.importedTransactionId" role="status" class="mt-3 text-amber-700">
            Import-linked transaction found. Review reconciliation evidence; this is not a verified manual
            transaction.
          </p>
          <p v-else-if="completion.manualTransactionId && completion.phase === 'verified'" role="status" class="mt-3">
            Verified manual transaction: {{ completion.manualTransactionId }}
          </p>

          <div
            v-if="completion.debit && completion.payloadHash && completion.phase === 'proposed' && !completion.reviewRequired"
            class="mt-4 space-y-2"
            aria-label="Completion co-approval"
          >
            <label class="flex items-start gap-2 text-sm">
              <input
                v-model="confirmed"
                data-testid="completion-approve-confirmation"
                type="checkbox"
                :disabled="confirmationDisabled(completion)"
              />
              I reviewed the exact account, debit, date, payee, notes, and category splits above.
            </label>
            <UButton
              data-testid="completion-approve"
              :disabled="approveDisabled(completion)"
              @click="approve"
            >
              {{ busy ? 'Approving…' : 'Approve exact completion' }}
            </UButton>
            <p v-if="!completion.canApprove && !cooldownActive(completion)" role="status" class="text-sm text-amber-700">
              Approval is unavailable with the current authorization or evidence. Refresh the proposal before acting.
            </p>
          </div>
          <p v-else-if="completion.phase === 'approved'" role="status" class="mt-4 text-sm">
            This completion has the required approvals. No ledger transaction is written from this
            review page.
          </p>

          <UButton
            data-testid="completion-refresh"
            variant="ghost"
            :disabled="busy"
            @click="load"
          >
            Refresh completion readiness
          </UButton>
        </UCard>
      </section>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PublicSessionCompletion } from '@balanceframe/application';
import type { Amount } from '../../../../components/types';
import SemanticAmount from '../../../../components/SemanticAmount.vue';
import { liquidityError, liquidityRequest } from '../../../../utils/liquidity-client';

definePageMeta({ layout: 'default' });

const route = useRoute();
const sessionId = computed(() => String(route.params.id ?? ''));
const proposalId = computed(() => String(route.params.proposalId ?? ''));
const completion = ref<PublicSessionCompletion | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const confirmed = ref(false);
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const approvalKeys = new Map<string, string>();

function completionPath(action?: 'approve') {
  const base = `/api/spend-sessions/${encodeURIComponent(sessionId.value)}/completions/${encodeURIComponent(proposalId.value)}`;
  return action ? `${base}/${action}` : base;
}

function humanize(value: string) {
  return value.replaceAll('_', ' ');
}

function statusLabel(value: PublicSessionCompletion) {
  if (value.reviewRequired || value.phase === 'write_intent' || value.phase === 'review_required')
    return 'Human review required';
  if (value.importedTransactionId) return 'Import-linked transaction';
  if (value.phase === 'verified' && value.manualTransactionId) return 'Verified manual transaction';
  if (value.phase === 'approved') return 'Approved — not executed';
  if (value.phase === 'proposed') return 'Awaiting human approval';
  if (value.phase === 'closed') return 'Closed';
  return humanize(value.phase);
}

function currencyFor(value: PublicSessionCompletion, categoryId: string) {
  return value.debit?.categoryCharges.find((charge) => charge.categoryId === categoryId)?.amount.currency
    ?? value.debit?.categoryCharges[0]?.amount.currency
    ?? null;
}

function signedAmount(value: number, currency: string | null): Amount | null {
  if (!currency || !Number.isSafeInteger(value)) return null;
  return { minorUnits: String(Math.abs(value)), currency };
}

function debitAmount(value: PublicSessionCompletion): Amount | null {
  const debit = value.debit;
  return debit ? signedAmount(debit.amount, debit.categoryCharges[0]?.amount.currency ?? null) : null;
}

type CompletionSplit = NonNullable<PublicSessionCompletion['debit']>['splits'][number];
function splitAmount(value: PublicSessionCompletion, split: CompletionSplit): Amount | null {
  return signedAmount(split.amount, currencyFor(value, split.categoryId));
}

function expired(value: PublicSessionCompletion) {
  return Date.parse(value.expiresAt) <= clock.value;
}

function cooldownActive(value: PublicSessionCompletion) {
  return Boolean(value.cooldownUntil && Date.parse(value.cooldownUntil) > clock.value);
}

function detailsAvailable(value: PublicSessionCompletion) {
  return Boolean(value.debit && value.payloadHash);
}

function confirmationDisabled(value: PublicSessionCompletion) {
  return busy.value || expired(value) || cooldownActive(value) || !detailsAvailable(value) ||
    !value.canApprove || value.reviewRequired;
}

function approveDisabled(value: PublicSessionCompletion) {
  return confirmationDisabled(value) || !confirmed.value || value.phase !== 'proposed';
}

function approvalKey(version: number) {
  const key = `${proposalId.value}:${version}`;
  const existing = approvalKeys.get(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  approvalKeys.set(key, created);
  return created;
}

async function load() {
  if (busy.value) return;
  loading.value = true;
  error.value = null;
  completion.value = null;
  confirmed.value = false;
  clock.value = Date.now();
  try {
    completion.value = await liquidityRequest<PublicSessionCompletion>(completionPath());
  } catch (failure) {
    error.value = { code: 'COMPLETION_UNAVAILABLE', message: liquidityError(failure) };
  } finally {
    loading.value = false;
  }
}

async function approve() {
  const current = completion.value;
  if (!current || approveDisabled(current) || busy.value) return;
  busy.value = true;
  error.value = null;
  clock.value = Date.now();
  try {
    completion.value = await liquidityRequest<PublicSessionCompletion>(completionPath('approve'), 'POST', {
      payloadHash: current.payloadHash,
      expectedVersion: current.version,
      idempotencyKey: approvalKey(current.version),
    });
    confirmed.value = false;
  } catch (failure) {
    error.value = { code: 'COMPLETION_APPROVAL_UNAVAILABLE', message: liquidityError(failure) };
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  clockTimer = setInterval(() => {
    clock.value = Date.now();
  }, 1000);
  void load();
});

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});
</script>
