<template>
  <section class="space-y-4" aria-label="Transfer workflow">
    <UCard
      ><template #header><h2 class="font-semibold">Transfer status</h2></template>
      <p data-testid="transfer-phase" class="text-lg font-semibold">
        {{
          current.phase === 'initiated'
            ? 'User-reported initiated — awaiting settlement'
            : current.phase === 'approved' && current.instructionsAvailable
              ? 'User action required'
              : label(current.phase)
        }}
      </p>
      <p v-if="current.outcome" role="status" class="text-amber-700">
        {{ label(current.outcome) }} — review the evidence and refresh before taking further action.
      </p>
      <p>Approvals {{ current.approvalCount }} / {{ current.requiredApprovals }}</p>
      <dl class="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt>Source import</dt>
          <dd data-testid="source-observed">
            {{ current.sourceObserved ? 'Observed' : 'Not observed' }}
          </dd>
        </div>
        <div>
          <dt>Destination import</dt>
          <dd>{{ current.destinationObserved ? 'Observed' : 'Not observed' }}</dd>
        </div>
        <div>
          <dt>Reconciliation</dt>
          <dd>{{ current.reconciled ? 'Reconciled' : 'Not reconciled' }}</dd>
        </div>
      </dl>
      <p class="mt-3 text-sm">
        User acknowledgement is not settlement. A recorded ledger transfer or one-sided import is
        not confirmation. Only trusted matching settlement evidence can confirm this transfer.
      </p>
      <ReasonCodeList :codes="current.reasons" />
    </UCard>
    <UCard v-if="current.conclusion?.authorizedHolderRequired"
      ><template #header><h2 class="font-semibold">Authorized holder needed</h2></template>
      <p>
        Ask an authorized holder to transfer
        <SemanticAmount :amount="current.conclusion.minimumAmount" /> by
        {{ current.conclusion.requiredBy }}. Private source details and action controls are not
        shared.
      </p></UCard
    >
    <UCard v-if="current.plan && !error"
      ><template #header
        ><h2 class="font-semibold">
          {{
            current.instructionsAvailable
              ? 'User action required — transfer instructions'
              : 'Immutable transfer plan'
          }}
        </h2></template
      >
      <p>
        Minimum: <SemanticAmount :amount="current.plan.minimumAmount" /> · Required by
        {{ current.plan.requiredBy }}
      </p>
      <p>
        Estimated arrival {{ current.plan.estimatedArrival }} · Plan expires
        {{ current.plan.expiresAt }}
      </p>
      <ol class="mt-3 list-inside list-decimal space-y-3">
        <li v-for="(leg, index) in current.plan.legs" :key="index" class="rounded border p-3">
          <span
            >{{ leg.sourceAccountName ?? 'Source account' }} →
            {{ leg.destinationAccountName ?? 'Destination account' }}:
            <SemanticAmount :amount="leg.amount"
          /></span>
          <p class="mt-1 text-sm">
            Source safe capacity <SemanticAmount :amount="leg.sourceCapacityBefore" /> →
            <SemanticAmount :amount="leg.sourceCapacityAfter" />; destination
            <SemanticAmount :amount="leg.destinationCapacityBefore" /> →
            <SemanticAmount :amount="leg.destinationCapacityAfter" />
          </p>
          <p v-if="current.instructionsAvailable" class="mt-2 text-sm">
            Use your bank's own transfer flow for these exact accounts and amount. BalanceFrame does
            not initiate the transfer.
          </p>
        </li>
      </ol>
      <ReasonCodeList :codes="current.plan.reasons" />
      <ul class="text-sm">
        <li v-for="assumption in current.plan.assumptions" :key="assumption">{{ assumption }}</li>
      </ul>
    </UCard>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <div class="flex flex-wrap gap-2" aria-label="Transfer actions">
      <template
        v-if="!error && current.payloadHash && !current.conclusion?.authorizedHolderRequired"
      >
        <UButton v-if="current.canApprove" :disabled="busy" @click="act('approve')"
          >Approve exact transfer</UButton
        >
        <UButton v-if="current.canGetInstructions" :disabled="busy" @click="act('instructions')"
          >Get transfer instructions</UButton
        >
        <UButton
          v-if="current.canReportInitiated"
          data-testid="report-initiated"
          :disabled="busy"
          @click="act('report-initiated')"
          >I initiated this transfer — report only</UButton
        >
        <UButton
          v-if="current.canReconcile"
          :disabled="busy"
          variant="outline"
          @click="act('reconcile')"
          >Check trusted settlement evidence</UButton
        >
        <UButton
          v-if="current.canCancel"
          :disabled="busy"
          color="error"
          variant="outline"
          @click="act('cancel')"
          >Cancel transfer proposal</UButton
        >
      </template>
      <UButton :disabled="busy" variant="ghost" @click="refresh">Refresh transfer status</UButton>
    </div>
    <p v-if="busy" role="status">Updating transfer…</p>
  </section>
</template>
<script setup lang="ts">
import type { PublicTransferDetail } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
const props = defineProps<{ detail: PublicTransferDetail }>();
const current = ref(props.detail);
const busy = ref(false);
const error = ref('');
watch(
  () => props.detail,
  (detail) => {
    current.value = detail;
  },
);
const attempts = new Map<string, string>();
function label(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}
async function act(action: string) {
  if (!current.value.payloadHash || busy.value) return;
  busy.value = true;
  error.value = '';
  const key = `${current.value.version}:${action}`;
  if (!attempts.has(key)) attempts.set(key, crypto.randomUUID());
  try {
    current.value = await liquidityRequest<PublicTransferDetail>(
      `/api/transfer/${encodeURIComponent(current.value.id)}/${action}`,
      'POST',
      {
        payloadHash: current.value.payloadHash,
        expectedVersion: current.value.version,
        idempotencyKey: attempts.get(key),
      },
    );
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  busy.value = true;
  error.value = '';
  try {
    current.value = await liquidityRequest<PublicTransferDetail>(
      `/api/transfer/${encodeURIComponent(current.value.id)}`,
    );
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
</script>
