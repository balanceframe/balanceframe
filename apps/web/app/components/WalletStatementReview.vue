<template>
  <details class="space-y-3 rounded border p-3">
    <summary class="cursor-pointer font-medium">Review a local wallet statement</summary>
    <p>
      Confirm the printed period, balances and complete activity yourself. A human-attested
      statement is never provider-authenticated. Opening equity and other Actual changes require
      separate proposal approval.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button type="button" data-testid="wallet-proof-load" :disabled="busy" @click="load">
      Load current statement choices
    </button>
    <fieldset v-if="context" :disabled="busy" class="space-y-3">
      <label class="block"
        >Original statement<select v-model="documentId" data-testid="wallet-proof-document">
          <option value="">Choose a current original</option>
          <option v-for="document in context.documents" :key="document.id" :value="document.id">
            {{ document.sourceId }} · {{ document.mediaType }} · {{ document.id }}
          </option>
        </select></label
      >
      <label class="block"
        >Wallet<select v-model="walletId">
          <option value="">Enter a source-scoped wallet label</option>
          <option v-for="wallet in context.wallets" :key="wallet.walletId" :value="wallet.walletId">
            {{ wallet.walletId }} · {{ wallet.currency }}
          </option>
        </select></label
      >
      <label v-if="!walletId" class="block"
        >Wallet label on this source<input
          v-model="label"
          data-testid="wallet-proof-label"
          maxlength="256"
      /></label>
      <label v-if="!walletId" class="block"
        >Currency<input v-model="currency" maxlength="3"
      /></label>
      <label class="block"
        >Printed first day (inclusive)<input
          v-model="startDate"
          type="date"
          data-testid="wallet-proof-start"
      /></label>
      <label class="block"
        >Printed last day (inclusive)<input
          v-model="endDate"
          type="date"
          data-testid="wallet-proof-end"
      /></label>
      <label class="block"
        >Opening balance before first-day activity · {{ selectedCurrency }} minor units<input
          v-model="opening"
          inputmode="numeric"
          data-testid="wallet-proof-opening"
          placeholder="Leave blank if unknown"
      /></label>
      <label class="block"
        >Closing balance after last-day activity · {{ selectedCurrency }} minor units<input
          v-model="closing"
          inputmode="numeric"
          data-testid="wallet-proof-closing"
          placeholder="Leave blank if unknown"
      /></label>
      <button type="button" data-testid="wallet-proof-preview" :disabled="!valid" @click="preview">
        Preview exact statement claims
      </button>
      <button
        type="button"
        data-testid="wallet-proof-original"
        :disabled="!documentId"
        @click="original"
      >
        Retrieve authorized original
      </button>
      <a
        v-if="originalBytes"
        data-testid="wallet-proof-download"
        :href="`data:application/octet-stream;base64,${originalBytes}`"
        download="wallet-statement.bin"
        class="block underline"
        @click="originalDelivered = true"
        >Download original statement and inspect it locally</a
      >
      <section v-if="plan" class="space-y-2 rounded border p-3">
        <p>
          Human-attested claims · {{ plan.proof.startDate }} through {{ plan.proof.endDate }} ·
          {{ plan.proof.walletId }}
        </p>
        <p>Exact original hash {{ plan.proof.statement.contentHash }}</p>
        <p>
          Opening <SemanticAmount :amount="plan.proof.openingBalance" /> · Closing
          <SemanticAmount :amount="plan.proof.closingBalance" />
        </p>
        <p>
          Native interval activity: received <SemanticAmount :amount="plan.native.inflows" /> · sent
          <SemanticAmount :amount="plan.native.outflows" /> · net
          <SemanticAmount :amount="plan.native.netChange" />
        </p>
        <p v-for="activity in plan.native.activityManifest" :key="activity.observationId">
          Included completed activity {{ activity.observationId }} · {{ activity.contentHash }}
        </p>
        <p v-for="identity in plan.native.excludedObservationIds" :key="identity">
          Excluded or pending activity {{ identity }}
        </p>
        <TransactionEvidenceResult :result="plan.resolution" />
        <label class="block"
          ><input
            v-model="originalAcknowledged"
            type="checkbox"
            :disabled="!originalDelivered"
            data-testid="wallet-proof-original-ack"
          />I inspected this exact original and confirm these printed claims.</label
        >
        <label class="block"
          ><input
            v-model="completeAcknowledged"
            type="checkbox"
            data-testid="wallet-proof-complete-ack"
          />This manifest covers all completed balance-relevant activity in the printed interval,
          including activity not supplied by a bank feed.</label
        >
        <button
          type="button"
          data-testid="wallet-proof-attest"
          :disabled="
            !originalDelivered || !originalAcknowledged || !completeAcknowledged || !password
          "
          @click="attest"
        >
          Record human attestation
        </button>
      </section>
      <label class="block"
        >{{ confirmationLabel
        }}<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          data-testid="wallet-proof-password"
      /></label>
      <section v-if="openingAnchors.length" class="space-y-2 rounded border p-3">
        <p>
          Opening equity creates a wallet's starting balance. Review and approval remain separate.
        </p>
        <label class="block"
          >Native opening balance<select
            v-model="openingAnchorIndex"
            data-testid="wallet-opening-anchor"
          >
            <option value="">Choose a proved boundary</option>
            <option v-for="(anchor, index) in openingAnchors" :key="index" :value="String(index)">
              {{ anchor.walletId }} · {{ anchor.asOfDate }} · {{ anchor.amount.minorUnits }}
              {{ anchor.amount.currency }} minor units
            </option>
          </select></label
        >
        <label class="block"
          >New Actual wallet account name<input
            v-model="accountName"
            maxlength="256"
            data-testid="wallet-opening-name"
        /></label>
        <button
          type="button"
          data-testid="wallet-opening-propose"
          :disabled="!selectedOpeningAnchor || !accountName.trim()"
          @click="proposeOpening"
        >
          Prepare opening equity proposal
        </button>
        <a
          v-if="openingProposalId"
          data-testid="wallet-opening-proposal"
          :href="`/proposals/${encodeURIComponent(openingProposalId)}`"
          >Review opening equity proposal</a
        >
      </section>
      <section v-if="context.proofs.length" class="space-y-2 rounded border p-3">
        <p>Current human attestations. Revocation works after original bytes expire.</p>
        <label class="block"
          ><input
            v-model="revokeConfirmed"
            type="checkbox"
            data-testid="wallet-proof-revoke-confirm"
          />I intend to revoke the selected statement's authority for new dependent actions.</label
        >
        <div v-for="proof in context.proofs" :key="proof.proofId">
          <p>
            {{ proof.walletId }} · {{ proof.startDate }} through {{ proof.endDate }} ·
            human-attested by {{ proof.actorId }} at {{ proof.reviewedAt }}
          </p>
          <button
            type="button"
            data-testid="wallet-proof-revoke"
            :disabled="!revokeConfirmed || !password"
            @click="revoke(proof.proofId)"
          >
            Revoke {{ proof.proofId }}
          </button>
        </div>
      </section>
    </fieldset>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { z } from 'zod';
import {
  walletStatementContextSchema,
  walletStatementPreviewSchema,
  walletStatementStateSchema,
  type WalletStatementContext,
  type WalletStatementPreviewView,
} from '../utils/wallet-statement-client';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import SemanticAmount from './SemanticAmount.vue';
import TransactionEvidenceResult from './TransactionEvidenceResult.vue';
const props = defineProps<{ sourceVersion: string }>();
const emit = defineEmits<{ changed: [] }>();
const context = ref<WalletStatementContext | null>(null),
  plan = ref<WalletStatementPreviewView | null>(null);
const documentId = ref(''),
  walletId = ref(''),
  label = ref(''),
  currency = ref('USD'),
  startDate = ref(''),
  endDate = ref(''),
  opening = ref(''),
  closing = ref(''),
  password = ref(''),
  originalBytes = ref(''),
  error = ref(''),
  notice = ref('');
const originalDelivered = ref(false),
  originalAcknowledged = ref(false),
  completeAcknowledged = ref(false),
  revokeConfirmed = ref(false),
  busy = ref(false);
const openingAnchorIndex = ref(''),
  accountName = ref(''),
  openingProposalId = ref('');
const openingAnchors = computed(() => [
  ...new Map(
    (context.value?.resolution.wallets ?? [])
      .flatMap((wallet) => wallet.balanceAnchors ?? [])
      .filter(
        (anchor) =>
          anchor.boundary === 'before_day_activity' && /^[1-9]\d*$/.test(anchor.amount.minorUnits),
      )
      .map((anchor) => [JSON.stringify(anchor), anchor] as const),
  ).values(),
]);
const selectedOpeningAnchor = computed(() =>
  openingAnchorIndex.value === ''
    ? null
    : (openingAnchors.value[Number(openingAnchorIndex.value)] ?? null),
);
let generation = 0;
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
const selectedCurrency = computed(
  () =>
    context.value?.wallets.find((wallet) => wallet.walletId === walletId.value)?.currency ??
    currency.value,
);
const valid = computed(
  () =>
    context.value?.documents.some((document) => document.id === documentId.value) &&
    (walletId.value || label.value.trim()) &&
    /^[A-Z]{3}$/.test(selectedCurrency.value) &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate.value) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate.value) &&
    startDate.value <= endDate.value &&
    (opening.value !== '' || closing.value !== '') &&
    [opening.value, closing.value].every(
      (amount) => amount === '' || /^(0|[1-9]\d{0,18})$/.test(amount),
    ),
);
function invalidate() {
  generation++;
  plan.value = null;
  openingAnchorIndex.value = '';
  openingProposalId.value = '';
  password.value = '';
  originalAcknowledged.value = false;
  completeAcknowledged.value = false;
  revokeConfirmed.value = false;
  busy.value = false;
  error.value = '';
}
function clearOriginal() {
  originalBytes.value = '';
  originalDelivered.value = false;
}
watch([documentId, walletId, label, currency, startDate, endDate, opening, closing], invalidate);
watch(documentId, clearOriginal);
watch(
  () => props.sourceVersion,
  () => {
    invalidate();
    clearOriginal();
    context.value = null;
  },
);
onUnmounted(() => {
  invalidate();
  clearOriginal();
});
function selector() {
  const money = (value: string) =>
    value === '' ? null : { minorUnits: value, currency: selectedCurrency.value };
  return {
    statementDocumentId: documentId.value,
    wallet: walletId.value
      ? { kind: 'existing', walletId: walletId.value }
      : { kind: 'new', label: label.value.trim(), currency: currency.value },
    startDate: startDate.value,
    endDate: endDate.value,
    openingBalance: money(opening.value),
    closingBalance: money(closing.value),
  };
}
async function load() {
  if (busy.value) return;
  invalidate();
  clearOriginal();
  const current = generation;
  busy.value = true;
  try {
    const value = await evidenceRequest(
      '/api/evidence/wallet-statements',
      walletStatementContextSchema,
    );
    if (current === generation) context.value = value;
  } catch {
    if (current === generation)
      error.value = 'Statement review unavailable. Refresh sources and permissions.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function preview() {
  if (busy.value || !valid.value) return;
  invalidate();
  const current = generation;
  busy.value = true;
  try {
    const value = await evidenceRequest(
      '/api/evidence/wallet-statements/preview',
      walletStatementPreviewSchema,
      'POST',
      selector(),
    );
    if (current === generation) plan.value = value;
  } catch {
    if (current === generation)
      error.value =
        'Statement preview unavailable. Check the original, exact balances, period and source permissions.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function original() {
  if (busy.value || !documentId.value) return;
  const current = ++generation;
  busy.value = true;
  clearOriginal();
  originalAcknowledged.value = false;
  try {
    const value = await evidenceRequest(
      `/api/evidence/${encodeURIComponent(documentId.value)}/raw`,
      z.object({
        contentBase64: z
          .string()
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
          .max(14 * 1024 * 1024)
          .nullable(),
      }),
    );
    if (current !== generation) return;
    if (!value.contentBase64) throw new Error('expired');
    originalBytes.value = value.contentBase64;
  } catch {
    if (current === generation)
      error.value = 'Original unavailable or expired. Existing attestations can still be revoked.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function write(path: string, body: unknown) {
  const current = ++generation,
    secret = password.value;
  password.value = '';
  busy.value = true;
  error.value = '';
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    const value = await evidenceRequest(path, walletStatementStateSchema, 'POST', body);
    if (current !== generation) return;
    if (context.value) {
      context.value.foldHash = value.foldHash;
      context.value.proofs = value.proofs;
    }
    plan.value = null;
    context.value = null;
    openingAnchorIndex.value = '';
    openingProposalId.value = '';
    originalAcknowledged.value = false;
    completeAcknowledged.value = false;
    revokeConfirmed.value = false;
    clearOriginal();
    notice.value =
      'Human proof updated. Resolve evidence again before preparing any financial proposal.';
    emit('changed');
  } catch {
    if (current === generation)
      error.value =
        'Statement update unavailable. Refresh current proof, sources and permissions before retrying.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function attest() {
  if (
    busy.value ||
    !plan.value ||
    !originalDelivered.value ||
    !originalAcknowledged.value ||
    !completeAcknowledged.value ||
    !password.value
  )
    return;
  await write('/api/evidence/wallet-statements', {
    ...selector(),
    previewHash: plan.value.previewHash,
    expectedProofFoldHash: plan.value.proofFoldHash,
    originalAcknowledged: true,
    completeActivityAcknowledged: true,
  });
}
async function revoke(proofId: string) {
  if (busy.value || !context.value || !revokeConfirmed.value || !password.value) return;
  await write('/api/evidence/wallet-statements/revoke', {
    proofId,
    expectedProofFoldHash: context.value.foldHash,
  });
}
async function proposeOpening() {
  const anchor = selectedOpeningAnchor.value,
    currentContext = context.value;
  if (busy.value || !anchor || !currentContext || !accountName.value.trim()) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  openingProposalId.value = '';
  try {
    const value = await evidenceRequest(
      '/api/evidence/wallet-statements/proposal',
      z.object({ proposalId: z.string().min(1).max(256) }),
      'POST',
      {
        resolutionHash: currentContext.resolution.resolutionHash,
        walletId: anchor.walletId,
        proofSetHash: anchor.proofSetHash,
        activityManifestHash: anchor.activityManifestHash,
        asOfDate: anchor.asOfDate,
        accountName: accountName.value.trim(),
      },
    );
    if (current === generation) openingProposalId.value = value.proposalId;
  } catch {
    if (current === generation)
      error.value =
        'Opening equity proposal unavailable. Refresh current proof, permissions and wallet account state.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
