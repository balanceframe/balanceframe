<template>
  <section aria-label="Transaction evidence" :aria-busy="busy" class="space-y-4 text-sm">
    <p>
      Receipts, wallet activity, and settlement evidence explain the economic event. Actual and
      ordinary review remain available if a source needs repair.
    </p>
    <details class="rounded border p-3">
      <summary class="cursor-pointer font-medium">Add receipt or wallet evidence</summary>
      <p class="my-2">
        Add a receipt photo with optional entered details, or upload a versioned wallet or receipt
        extraction. Photos and PDFs without entered details await extraction. Raw content is
        encrypted and retained for seven days; imports never authorize a ledger change.
      </p>
      <fieldset :disabled="busy" class="grid gap-3 sm:grid-cols-2">
        <ReceiptPhotoCapture
          :disabled="busy"
          :reset-key="photoResetKey"
          @selected="selectPhoto"
          @cleared="clearSelectedPhoto"
        />
        <div v-if="isManualReceiptSource" class="space-y-3 rounded border p-3 sm:col-span-2">
          <template v-if="isReceiptPhoto">
            <button
              type="button"
              data-testid="extract-receipt-photo"
              :disabled="busy || ocrBusy"
              class="rounded border px-3 py-2"
              @click="extractPhotoText"
            >
              {{ ocrBusy ? 'Reading photo text…' : 'Read photo text (optional)' }}
            </button>
            <p v-if="ocrNotice" role="status">{{ ocrNotice }}</p>
            <label v-if="ocrText" class="block"
              >Unverified extracted text — check against the photo<textarea
                v-model="ocrText"
                data-testid="receipt-ocr-text"
                rows="8"
                class="block w-full rounded border p-2 dark:bg-gray-950"
              />
            </label>
          </template>
          <label
            ><input
              v-model="manualPhotoReview"
              data-testid="manual-receipt-entry"
              type="checkbox"
            />
            Enter receipt details now</label
          >
          <p>
            The uploaded receipt is the source. Enter only facts you can read; missing line items
            remain unknown.
          </p>
          <div v-if="manualPhotoReview" class="grid gap-3 sm:grid-cols-2">
            <label
              >Receipt type<select
                v-model="photoForm.kind"
                class="block w-full rounded border p-2 dark:bg-gray-950"
              >
                <option value="purchase">Purchase</option>
                <option value="refund">Refund</option>
              </select></label
            >
            <label
              >Receipt date<input
                v-model="photoForm.date"
                data-testid="photo-date"
                type="date"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <label
              >Total shown on receipt<input
                v-model="photoForm.total"
                data-testid="photo-total"
                inputmode="decimal"
                placeholder="12.34"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <label
              >Currency<input
                v-model="photoForm.currency"
                data-testid="photo-currency"
                maxlength="3"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <label
              >Merchant (optional)<input
                v-model="photoForm.merchant"
                data-testid="photo-merchant"
                maxlength="256"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <label
              >Funding reference, if known<input
                v-model="photoForm.fundingInstrumentId"
                maxlength="256"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <p v-if="photoSummary" class="sm:col-span-2">
              Entered {{ photoSummary.kind }} total:
              <SemanticAmount :amount="photoSummary.total" />. This remains unverified evidence.
            </p>
            <p v-else class="sm:col-span-2">
              Enter a valid date, currency, and exact positive total. Use a decimal point and no
              thousands separators.
            </p>
            <label class="sm:col-span-2"
              ><input v-model="photoItemsEnabled" data-testid="photo-items-mode" type="checkbox" />
              Enter item and payment tender details (optional)</label
            >
            <ReceiptPhotoItemsEntry v-if="photoItemsEnabled" v-model="photoItems" />
            <p v-if="photoItemsEnabled && !photoExtraction" role="status" class="sm:col-span-2">
              Complete every item amount, quantity, receipt discount/tax and tender, or turn off
              item entry to save the source and summary. Values are not calculated or repaired here.
            </p>
          </div>
          <p v-else>
            The source will be retained for later extraction; no financial amount will be inferred.
          </p>
        </div>
        <details data-testid="evidence-import-settings" class="rounded border p-3 sm:col-span-2">
          <summary class="cursor-pointer font-medium">Other files and import settings</summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label
              >Source type<select
                v-model="sourceKind"
                data-testid="evidence-source-kind"
                class="block w-full rounded border p-2 dark:bg-gray-950"
              >
                <option value="retail">Receipt or retailer order</option>
                <option value="wallet">Wallet activity or statement</option>
              </select></label
            >
            <label
              >Source file<input
                ref="fileControl"
                type="file"
                accept=".json,.pdf,.png,.jpg,.jpeg"
                data-testid="evidence-file"
                class="block w-full rounded border p-2"
                @change="selectFile"
            /></label>
            <label
              >Source reference<input
                v-model="sourceId"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <label
              >Source timestamp (UTC)<input
                v-model="sourceTime"
                data-testid="evidence-source-time"
                type="datetime-local"
                class="block w-full rounded border p-2 dark:bg-gray-950"
            /></label>
            <label
              >Visibility<select
                v-model="visibility"
                class="block w-full rounded border p-2 dark:bg-gray-950"
              >
                <option value="private">Private — this actor only</option>
                <option value="shared">Shared — authorized members of this space</option>
              </select></label
            >
          </div>
        </details>
        <p v-if="file" class="sm:col-span-2">
          Selected source: {{ file.name }} ·
          {{
            visibility === 'private'
              ? 'Private to this actor'
              : 'Shared under current space permissions'
          }}
        </p>
        <button
          type="button"
          data-testid="import-evidence"
          :disabled="
            busy ||
            !file ||
            !sourceId.trim() ||
            !sourceTime ||
            (isManualReceiptSource && manualPhotoReview && !photoExtraction)
          "
          class="self-end rounded border px-3 py-2"
          @click="importFile"
        >
          {{ isManualReceiptSource ? 'Add receipt evidence' : 'Import evidence' }}
        </button>
      </fieldset>
    </details>
    <button
      type="button"
      data-testid="load-evidence"
      :disabled="busy"
      class="rounded border px-3 py-2"
      @click="load"
    >
      {{ loaded ? 'Refresh transaction evidence' : 'Load transaction evidence' }}
    </button>
    <p v-if="busy" role="status">Loading current evidence…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="loaded">
      <div v-if="!documents.length" role="status">
        No evidence is visible under your current access.
      </div>
      <details v-if="connectors.length" class="rounded border p-3">
        <summary class="cursor-pointer font-medium">Source health and coverage</summary>
        <article v-for="connector in connectors" :key="connector.connectorId" class="mt-2">
          <h3 class="font-medium">{{ connector.connectorId }}</h3>
          <p>
            Latest received {{ connector.latestReceivedAt }} · latest parsed
            {{ connector.latestParsedAt ?? 'No supported extraction' }}
          </p>
          <p>
            {{ connector.documentCount }} visible documents ·
            {{ connector.unsupportedCount }} unsupported templates ·
            {{ connector.malformedCount }} malformed
          </p>
          <p v-if="connector.statementCoverage">
            Statement coverage: {{ connector.statementCoverage.state }} · human-attested, not
            provider-authenticated
          </p>
          <template
            v-for="wallet in connector.statementCoverage?.wallets ?? []"
            :key="wallet.walletId"
            ><p>Wallet balance: {{ wallet.balanceState }} · {{ wallet.reasonCodes.join(', ') }}</p>
            <p
              v-for="interval in wallet.coverage.intervals"
              :key="interval.startDate + interval.endDate"
            >
              {{ wallet.walletId }} · {{ interval.startDate }} through {{ interval.endDate }} ·
              {{ interval.state }} · {{ interval.reasonCodes.join(', ') }}
            </p>
            <p>
              Uncovered activity:
              {{ wallet.coverage.uncoveredObservationIds.join(', ') || 'None visible' }} · blocked
              activity: {{ wallet.coverage.blockedObservationIds.join(', ') || 'None visible' }}
            </p></template
          >
          <p v-if="connector.duplicateCount != null">
            {{ connector.duplicateCount }} duplicate deliveries
          </p>
        </article>
      </details>
      <details v-for="document in documents" :key="document.id" class="rounded border p-3">
        <summary class="cursor-pointer font-medium">
          {{ document.sourceId }} · {{ statusLabel(document.parseStatus) }}
        </summary>
        <p>
          Source {{ document.connectorId }} · {{ document.sourceTimestamp }} · received
          {{ document.receivedAt }}
        </p>
        <p>
          Parser {{ document.parserVersion }} · raw retention until {{ document.retentionUntil }}
        </p>
        <p>{{ document.quality.join(', ') }}</p>
        <p class="break-all font-mono">{{ document.contentHash }}</p>
        <EvidenceSourcePhoto :document-id="document.id" :media-type="document.mediaType" />
      </details>
      <EvidenceReceiptVersionReview
        v-if="documents.length"
        :source-version="documents.map((document) => document.id + document.contentHash).join(',')"
        @saved="receiptVersionSaved"
      />
      <WalletStatementReview
        v-if="documents.length"
        :source-version="documents.map((document) => document.id + document.contentHash).join(',')"
        @changed="walletProofChanged"
      />
      <button
        v-if="documents.some((document) => document.parseStatus === 'parsed')"
        type="button"
        data-testid="resolve-evidence"
        :disabled="busy"
        class="rounded border px-3 py-2"
        @click="resolve"
      >
        Resolve current evidence
      </button>
      <TransactionEvidenceResult v-if="displayResolution" :result="displayResolution" />
      <div v-if="resolution" class="space-y-3">
        <button
          v-if="
            editableEvents.length ||
            hasActualCandidates ||
            resolution.receipts.some((receipt) => receipt.valid)
          "
          type="button"
          data-testid="load-evidence-targets"
          :disabled="busy"
          class="rounded border px-3 py-2"
          @click="loadTargets"
        >
          Choose permitted ledger destinations
        </button>
        <EvidenceReceiptReview
          :resolution-hash="resolution.resolutionHash"
          @saved="receiptReviewSaved"
        />
        <EvidenceSettlementReview
          v-if="targets"
          :resolution="resolution"
          :accounts="targets.accounts"
          :document-ids="documents.map((document) => document.id)"
          @match="selectSettlement"
        />
        <EvidenceAllocationMatrix
          v-if="targets"
          :resolution="resolution"
          :receipts="documents.flatMap((document) => document.extraction?.receipts ?? [])"
          :accounts="targets.accounts"
          :categories="targets.categories"
          @saved="allocationSaved"
        />
        <EvidenceSettlementAllocation
          v-if="targets"
          :resolution="resolution"
          :receipts="documents.flatMap((document) => document.extraction?.receipts ?? [])"
          :accounts="targets.accounts"
          :categories="targets.categories"
          @saved="allocationSaved"
        />
        <fieldset
          v-for="event in targets ? editableEvents : []"
          :key="event.id"
          :disabled="busy"
          class="space-y-3 rounded border p-3"
        >
          <legend class="font-medium">
            {{
              event.reasonCodes.includes('existing_ledger_transaction')
                ? 'Matched settlement category review'
                : wholeEventSource(event)?.direction === 'inflow'
                  ? 'Exact credit'
                  : 'Exact debit'
            }}
            — {{ event.id }}
          </legend>
          <p>
            Amount and date come from the resolved source. This records your ledger intent; it does
            not create a transaction.
          </p>
          <template v-if="effectForms[event.id]">
            <label class="block"
              >Ledger account<select
                v-model="effectForms[event.id]!.accountId"
                data-testid="evidence-target-account"
                :disabled="event.reasonCodes.includes('existing_ledger_transaction')"
                class="ml-2 rounded border p-2 dark:bg-gray-950"
              >
                <option value="">Choose account</option>
                <option v-for="account in targets?.accounts" :key="account.id" :value="account.id">
                  {{ account.name }}
                </option>
              </select></label
            >
            <EvidenceReceiptLines
              v-if="eventReceipt(event)"
              :receipt="eventReceipt(event)!"
              :account-id="effectForms[event.id]!.accountId"
              :valid="
                resolution!.receipts.some(
                  (receipt) => receipt.receiptId === eventReceipt(event)!.id && receipt.valid,
                )
              "
              :direction="effectForms[event.id]!.direction"
              :categories="targets?.categories ?? []"
              @change="effectForms[event.id]!.receiptSplits = $event"
              @review="effectForms[event.id]!.itemCategoryDecisions = $event"
            />
            <label v-if="effectForms[event.id]!.receiptSplits === undefined" class="block"
              >Category<select
                v-model="effectForms[event.id]!.categoryId"
                data-testid="evidence-target-category"
                class="ml-2 rounded border p-2 dark:bg-gray-950"
              >
                <option value="">Choose category</option>
                <option
                  v-for="category in targets?.categories"
                  :key="category.id"
                  :value="category.id"
                >
                  {{ category.name }}
                </option>
              </select></label
            >
          </template>
        </fieldset>
        <div
          v-for="event in displayResolution?.events.filter(
            (event) =>
              event.projectionObservation?.ledgerEffect ||
              event.projectionObservations?.some((proof) => proof.ledgerEffect),
          )"
          :key="`proposal:${event.id}`"
        >
          <button
            type="button"
            data-testid="propose-evidence-debit"
            :disabled="busy || proposalRequested[event.id]"
            class="rounded border px-3 py-2"
            @click="propose(event.id)"
          >
            Create exact ledger proposal
          </button>
          <NuxtLink
            v-if="proposalLinks[event.id]"
            :to="`/proposals/${encodeURIComponent(proposalLinks[event.id]!)}`"
            class="ml-3 underline"
            >Review exact proposal</NuxtLink
          >
        </div>
      </div>
      <fieldset v-if="resolution" :disabled="busy" class="space-y-3 rounded border p-3">
        <legend class="font-medium">Focused evidence decisions</legend>
        <label
          v-for="event in displayResolution?.events.filter(
            (event) => event.eventType === 'unknown',
          )"
          :key="event.id"
          class="block"
        >
          What was this payment for? <span class="break-all">{{ event.id }}</span>
          <select
            v-model="purposes[event.id]"
            data-testid="event-purpose"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Keep unresolved</option>
            <option v-for="purpose in purposeOptions" :key="purpose" :value="purpose">
              {{ purpose.replaceAll('_', ' ') }}
            </option>
          </select>
        </label>
        <p
          v-if="
            !displayResolution?.events.some((event) => event.eventType === 'unknown') &&
            !displayResolution?.relationships.some(
              (relationship) => relationship.state === 'candidate',
            )
          "
        >
          No unresolved purpose or proposed source match needs a decision.
        </p>
        <label
          v-for="relationship in displayResolution?.relationships.filter(
            (relationship) => relationship.state === 'candidate',
          )"
          :key="relationship.id"
          class="block"
        >
          {{ relationship.fromId }} / {{ relationship.toId }} ·
          {{ relationship.kind.replaceAll('_', ' ') }}
          <select
            v-model="relationshipChoices[relationship.id]"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Keep unresolved</option>
            <option value="confirmed">Confirm match</option>
            <option value="rejected">Keep separate</option>
          </select>
        </label>
        <label class="block"
          >{{ confirmationLabel
          }}<input
            v-model="password"
            data-testid="evidence-password"
            type="password"
            autocomplete="current-password"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
        /></label>
        <button
          type="button"
          data-testid="save-evidence-decision"
          :disabled="busy || !password || !hasDecision"
          class="rounded border px-3 py-2"
          @click="saveDecision"
        >
          Save evidence decision
        </button>
        <p>
          This records evidence only. A ledger proposal, approval, and execution remain separate
          actions.
        </p>
      </fieldset>
      <EvidenceItemRules
        :connector-ids="[...new Set(documents.map((document) => document.connectorId))]"
        :refresh-key="refreshKey"
      />
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  EvidenceObservationSchema,
  TransactionEvidenceResultSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  EvidenceObservation,
  EconomicEventLedgerEffect,
  TransactionEvidenceResult as Resolution,
} from '@balanceframe/protocol-generated';
import {
  evidenceDocumentViewSchema,
  evidenceListViewSchema,
  evidenceHealthViewSchema,
  evidenceTargetsSchema,
  evidenceRequest,
} from '../utils/transaction-evidence-client';
import { z } from 'zod';
import TransactionEvidenceResult from './TransactionEvidenceResult.vue';
import EvidenceItemRules from './EvidenceItemRules.vue';
import ReceiptPhotoCapture from './ReceiptPhotoCapture.vue';
import ReceiptPhotoItemsEntry from './ReceiptPhotoItemsEntry.vue';
import WalletStatementReview from './WalletStatementReview.vue';
import EvidenceReceiptVersionReview from './EvidenceReceiptVersionReview.vue';
import EvidenceReceiptReview from './EvidenceReceiptReview.vue';
import EvidenceSettlementReview from './EvidenceSettlementReview.vue';
import EvidenceSettlementAllocation from './EvidenceSettlementAllocation.vue';
import EvidenceAllocationMatrix from './EvidenceAllocationMatrix.vue';
import EvidenceSourcePhoto from './EvidenceSourcePhoto.vue';
import EvidenceReceiptLines from './EvidenceReceiptLines.vue';
import type { EvidenceSettlementMatch } from '../utils/evidence-settlement-client';
import SemanticAmount from './SemanticAmount.vue';
import {
  receiptPhotoSummary,
  receiptPhotoExtraction,
  emptyReceiptPhotoItems,
  receiptPhotoOcrResultSchema,
  type ReceiptPhotoForm,
} from '../utils/receipt-photo-client';
import { reauthenticateHuman } from '../utils/reauthentication';
const props = defineProps<{ refreshKey?: number }>();
const busy = ref(false);
const loaded = ref(false);
const error = ref('');
const notice = ref('');
const documents = ref<ReturnType<typeof evidenceListViewSchema.parse>['documents']>([]);
const connectors = ref<ReturnType<typeof evidenceHealthViewSchema.parse>['connectors']>([]);
const resolution = ref<Resolution | null>(null);
const fileControl = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const photoResetKey = ref(0);
const emptyPhotoForm = (): ReceiptPhotoForm => ({
  kind: 'purchase',
  date: '',
  total: '',
  currency: '',
  merchant: '',
  fundingInstrumentId: '',
});
const photoForm = ref(emptyPhotoForm());
const manualPhotoReview = ref(false);
const photoItemsEnabled = ref(false);
const photoItems = ref(emptyReceiptPhotoItems());
function resetPhotoDetails() {
  photoForm.value = emptyPhotoForm();
  manualPhotoReview.value = false;
  photoItemsEnabled.value = false;
  photoItems.value = emptyReceiptPhotoItems();
}
watch(photoItemsEnabled, (enabled) => {
  if (!enabled) photoItems.value = emptyReceiptPhotoItems();
});
watch(manualPhotoReview, (enabled) => {
  if (!enabled) photoItemsEnabled.value = false;
});
const isReceiptPhoto = computed(
  () =>
    sourceKind.value === 'retail' &&
    file.value !== null &&
    ['image/jpeg', 'image/png'].includes(file.value.type),
);
const isManualReceiptSource = computed(
  () =>
    isReceiptPhoto.value ||
    (sourceKind.value === 'retail' && file.value?.type === 'application/pdf'),
);
const photoSummary = computed(() => receiptPhotoSummary(photoForm.value));
const photoExtraction = computed(() =>
  receiptPhotoExtraction(photoForm.value, photoItemsEnabled.value ? photoItems.value : undefined),
);
const ocrBusy = ref(false);
const ocrText = ref('');
const ocrNotice = ref('');
let ocrGeneration = 0;
function resetPhotoOcr() {
  ocrGeneration++;
  ocrBusy.value = false;
  ocrText.value = '';
  ocrNotice.value = '';
}
const sourceId = ref('');
const sourceTime = ref('');
const sourceKind = ref<'wallet' | 'retail'>('retail');
const visibility = ref<'private' | 'shared'>('private');
const password = ref('');
const purposes = ref<Record<string, EvidenceObservation['eventType'] | ''>>({});
const relationshipChoices = ref<Record<string, 'confirmed' | 'rejected' | ''>>({});
const targets = ref<ReturnType<typeof evidenceTargetsSchema.parse> | null>(null);
const effectForms = ref<
  Record<
    string,
    {
      accountId: string;
      categoryId: string;
      observationId: string;
      date: string;
      direction: 'inflow' | 'outflow';
      receiptSplits?: EconomicEventLedgerEffect['splits'] | null;
      itemCategoryDecisions?: {
        receiptId: string;
        lineId: string;
        accountId: string;
        categoryId: string;
      }[];
    }
  >
>({});
const proposalLinks = ref<Record<string, string>>({});
const proposalRequested = ref<Record<string, boolean>>({});
const sourceObservations = computed(() =>
  documents.value.flatMap((document) =>
    (document.extraction?.observations ?? []).flatMap((value) => {
      const parsed = EvidenceObservationSchema.omit({ provenance: true }).safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
);
// Presentation is scoped to imported sources; decisions retain the complete native result/hash.
const displayResolution = computed(() => {
  const result = resolution.value;
  if (!result) return null;
  const documentIds = new Set(documents.value.map((document) => document.id));
  const events = result.events.filter((event) =>
    event.evidenceIds.some((id) => documentIds.has(id)),
  );
  const observationIds = new Set(events.flatMap((event) => event.observationIds));
  const receiptIds = new Set(
    documents.value.flatMap(
      (document) => document.extraction?.receipts?.map((receipt) => receipt.id) ?? [],
    ),
  );
  const walletIds = new Set(
    sourceObservations.value.flatMap((observation) =>
      observation.walletId ? [observation.walletId] : [],
    ),
  );
  return {
    ...result,
    events,
    relationships: result.relationships.filter(
      (relationship) =>
        observationIds.has(relationship.fromId) || observationIds.has(relationship.toId),
    ),
    blockers: result.blockers.filter((blocker) =>
      blocker.evidenceIds.some((id) => documentIds.has(id)),
    ),
    receipts: result.receipts.filter((receipt) => receiptIds.has(receipt.receiptId)),
    wallets: result.wallets.filter((wallet) => walletIds.has(wallet.walletId)),
  };
});
function eventReceipt(event: Resolution['events'][number]) {
  const matches = documents.value
    .flatMap((document) => document.extraction?.receipts ?? [])
    .filter(
      (receipt) =>
        event.observationIds.includes(receipt.observationId) &&
        receipt.total.currency === event.amount.currency &&
        receipt.total.minorUnits === event.amount.minorUnits,
    );
  // Versions, multiple receipts, and partial tenders require their own allocation review.
  return matches.length === 1 ? matches[0] : undefined;
}
// Each reviewed effect remains bound to a whole-event source and its original direction.
function wholeEventSource(event: Resolution['events'][number]) {
  return sourceObservations.value.find(
    (observation) =>
      event.observationIds.includes(observation.id) &&
      observation.kind !== 'ledger_transaction' &&
      observation.status === 'completed' &&
      observation.amount.currency === event.amount.currency &&
      observation.amount.minorUnits === event.amount.minorUnits &&
      event.amount.minorUnits !== '0',
  );
}
const editableEvents = computed(
  () =>
    resolution.value?.events.filter(
      (event) =>
        event.state === 'resolved' &&
        !event.projectionObservation &&
        !['transfer', 'self_transfer'].includes(event.eventType) &&
        wholeEventSource(event),
    ) ?? [],
);
const hasActualCandidates = computed(
  () =>
    resolution.value?.relationships.some(
      (item) =>
        ['candidate', 'confirmed'].includes(item.state) &&
        (item.fromId.startsWith('actual:') || item.toId.startsWith('actual:')),
    ) ?? false,
);
const validEffect = (form: {
  accountId: string;
  categoryId: string;
  receiptSplits?: EconomicEventLedgerEffect['splits'] | null;
}) =>
  Boolean(
    targets.value?.accounts.some((account) => account.id === form.accountId) &&
    (form.receiptSplits === undefined
      ? targets.value?.categories.some((category) => category.id === form.categoryId)
      : form.receiptSplits?.length &&
        form.receiptSplits.every((split) =>
          targets.value?.categories.some((category) => category.id === split.categoryId),
        )),
  );
const purposeOptions = [
  'reimbursement',
  'repayment',
  'rent_contribution',
  'refund',
  'self_transfer',
  'gift',
  'business_income',
  'income',
  'purchase',
  'transfer',
  'p2p_payment',
] as const;
const hasDecision = computed(
  () =>
    Object.values(purposes.value).some(Boolean) ||
    Object.values(relationshipChoices.value).some(Boolean) ||
    Object.values(effectForms.value).some(validEffect),
);
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
let generation = 0;
function clear() {
  generation += 1;
  documents.value = [];
  connectors.value = [];
  resolution.value = null;
  loaded.value = false;
  busy.value = false;
  error.value = '';
  notice.value = '';
  resetFile();
  resetDecisions();
}
function resetDecisions() {
  password.value = '';
  purposes.value = {};
  relationshipChoices.value = {};
  effectForms.value = {};
  targets.value = null;
  proposalLinks.value = {};
  proposalRequested.value = {};
}
watch(() => props.refreshKey, clear);
watch(
  sourceKind,
  () => {
    generation += 1;
    busy.value = false;
    resetPhotoOcr();
    resetPhotoDetails();
  },
  { flush: 'sync' },
);
onUnmounted(clear);
function resetFile() {
  resetPhotoOcr();
  photoResetKey.value += 1;
  resetPhotoDetails();
  file.value = null;
  sourceId.value = '';
  sourceTime.value = '';
  visibility.value = 'private';
  if (fileControl.value) fileControl.value.value = '';
}
function selectFile(event: Event) {
  generation += 1;
  busy.value = false;
  resetPhotoOcr();
  photoResetKey.value += 1;
  resetPhotoDetails();
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  sourceId.value = file.value?.name ?? '';
  error.value = '';
  notice.value = '';
  if (file.value && file.value.size > 5 * 1024 * 1024) {
    resetFile();
    error.value = 'Use a source file of at most 5 MiB.';
  }
}
function selectPhoto(photo: File) {
  generation += 1;
  busy.value = false;
  resetPhotoOcr();
  file.value = photo;
  sourceId.value = photo.name;
  sourceKind.value = 'retail';
  visibility.value = 'private';
  sourceTime.value = new Date().toISOString().slice(0, 16);
  resetPhotoDetails();
  manualPhotoReview.value = true;
  error.value = '';
  notice.value = '';
  if (fileControl.value) fileControl.value.value = '';
}
function clearSelectedPhoto() {
  generation += 1;
  busy.value = false;
  resetPhotoOcr();
  file.value = null;
  sourceId.value = '';
  resetPhotoDetails();
  if (fileControl.value) fileControl.value.value = '';
}
async function importFile() {
  const selected = file.value;
  if (
    busy.value ||
    !selected ||
    !sourceId.value.trim() ||
    !sourceTime.value ||
    (isManualReceiptSource.value && manualPhotoReview.value && !photoExtraction.value)
  )
    return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  notice.value = '';
  resolution.value = null;
  try {
    const metadata = {
      sourceKind: sourceKind.value,
      connectorId: `local-${sourceKind.value}`,
      sourceId: sourceId.value.trim(),
      sourceTimestamp: new Date(`${sourceTime.value}Z`).toISOString(),
      visibility: visibility.value,
      ...(isManualReceiptSource.value && manualPhotoReview.value
        ? { userExtraction: photoExtraction.value }
        : {}),
    };
    const content = await sourceContent(selected);
    if (generation !== current) return;
    const mediaType = selected.name.toLowerCase().endsWith('.json')
      ? 'application/json'
      : selected.type;
    const saved = await evidenceRequest(
      '/api/evidence',
      z.object({ document: evidenceDocumentViewSchema, duplicate: z.boolean() }),
      'POST',
      {
        mediaType,
        contentEncoding: 'base64',
        content,
        retentionDays: 7,
        ...metadata,
      },
    );
    if (generation !== current) return;
    resetFile();
    notice.value = saved.duplicate
      ? 'Identical evidence already imported.'
      : `Evidence imported (${saved.document.id}). Current grants determine who can view its normalization.`;
    await load();
  } catch {
    if (generation === current)
      error.value =
        'Evidence import unavailable. Check the source file, timestamp, and current permissions before retrying.';
  } finally {
    if (generation === current) busy.value = false;
  }
}
async function sourceContent(selected: File): Promise<string> {
  const bytes = new Uint8Array(await selected.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}
async function extractPhotoText() {
  const selected = file.value;
  if (!selected || !isReceiptPhoto.value || busy.value || ocrBusy.value) return;
  const ticket = ++ocrGeneration;
  ocrBusy.value = true;
  ocrText.value = '';
  ocrNotice.value = '';
  try {
    const contentBase64 = await sourceContent(selected);
    if (ocrGeneration !== ticket) return;
    const result = await evidenceRequest(
      '/api/evidence/extract-photo',
      receiptPhotoOcrResultSchema,
      'POST',
      { mediaType: selected.type, contentBase64 },
    );
    if (ocrGeneration !== ticket) return;
    if (result.state === 'extracted') {
      ocrText.value = result.text;
      ocrNotice.value =
        'Text extracted. Check it against the photo before entering receipt details.';
    } else
      ocrNotice.value =
        'Text extraction is unavailable. You can still enter receipt details or save the photo.';
  } catch {
    if (ocrGeneration === ticket)
      ocrNotice.value =
        'Text extraction is unavailable. You can still enter receipt details or save the photo.';
  } finally {
    if (ocrGeneration === ticket) ocrBusy.value = false;
  }
}
async function load() {
  resetDecisions();
  const current = ++generation;
  busy.value = true;
  error.value = '';
  resolution.value = null;
  documents.value = [];
  connectors.value = [];
  loaded.value = false;
  try {
    const [list, health] = await Promise.all([
      evidenceRequest('/api/evidence', evidenceListViewSchema),
      evidenceRequest('/api/evidence/health', evidenceHealthViewSchema),
    ]);
    if (generation !== current) return;
    documents.value = list.documents;
    connectors.value = health.connectors;
    loaded.value = true;
  } catch {
    if (generation === current)
      error.value =
        'Evidence unavailable. Refresh current sources and permissions before retrying.';
  } finally {
    if (generation === current) busy.value = false;
  }
}
async function resolve() {
  if (busy.value) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  resolution.value = null;
  resetDecisions();
  try {
    const result = await evidenceRequest(
      '/api/evidence/resolve',
      TransactionEvidenceResultSchema,
      'POST',
      {},
    );
    if (generation === current) resolution.value = result;
  } catch {
    if (generation === current)
      error.value =
        'Evidence unavailable. Refresh current sources and permissions before retrying.';
  } finally {
    if (generation === current) busy.value = false;
  }
}
function receiptVersionSaved() {
  walletProofChanged();
  notice.value =
    'Receipt version relationship updated. Resolve current evidence before preparing a financial proposal.';
}
function walletProofChanged() {
  generation++;
  busy.value = false;
  resolution.value = null;
  resetDecisions();
  notice.value =
    'Human statement proof updated. Refresh evidence before preparing any financial proposal.';
}
function receiptReviewSaved(result: Resolution) {
  allocationSaved(result);
  notice.value =
    'Receipt relationship review saved. Any financial change requires its own proposal and approval.';
}
function allocationSaved(result: Resolution) {
  generation++;
  busy.value = false;
  error.value = '';
  resolution.value = result;
  resetDecisions();
  notice.value =
    'Reviewed allocation saved. Create and approve the exact settlement amendment before changing Actual.';
}
async function loadTargets() {
  if (busy.value) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  try {
    const result = await evidenceRequest('/api/evidence/targets', evidenceTargetsSchema);
    if (generation !== current) return;
    targets.value = result;
    for (const event of editableEvents.value) {
      const source = wholeEventSource(event);
      if (source)
        effectForms.value[event.id] = {
          accountId: '',
          categoryId: '',
          observationId: source.id,
          date: source.date,
          direction: source.direction,
        };
    }
  } catch {
    if (generation === current)
      error.value = 'Current permitted ledger destinations are unavailable.';
  } finally {
    if (generation === current) busy.value = false;
  }
}
function selectSettlement(value: EvidenceSettlementMatch) {
  const event = resolution.value?.events.find((item) => item.id === value.eventId);
  const match = resolution.value?.relationships.find((item) => item.id === value.relationshipId);
  if (
    !event ||
    !match ||
    !['candidate', 'confirmed'].includes(match.state) ||
    !targets.value?.accounts.some((account) => account.id === value.accountId)
  )
    return;
  const actualId = `actual:${value.transaction.id}`;
  if (!(
    (match.toId === actualId && event.observationIds.includes(match.fromId)) ||
    (match.fromId === actualId && event.observationIds.includes(match.toId))
  ))
    return;
  relationshipChoices.value[match.id] = 'confirmed';
  const form = effectForms.value[event.id];
  if (
    form &&
    value.transaction.amount.currency === event.amount.currency &&
    value.transaction.amount.minorUnits ===
      (form.direction === 'inflow' ? event.amount.minorUnits : `-${event.amount.minorUnits}`)
  ) {
    form.accountId = value.accountId;
    form.date = value.transaction.date;
  }
  notice.value =
    'Settlement selected. Confirm the displayed evidence decision before creating a ledger proposal.';
}
async function propose(eventId: string) {
  const prior = resolution.value;
  if (busy.value || !prior || proposalRequested.value[eventId]) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  proposalRequested.value[eventId] = true;
  try {
    const result = await evidenceRequest(
      '/api/evidence/proposal',
      z.object({ proposalId: z.string().min(1) }),
      'POST',
      {
        resolutionHash: prior.resolutionHash,
        eventId,
        ...(prior.events.find((event) => event.id === eventId)?.allocationSetHash
          ? {
              allocationSetHash: prior.events.find((event) => event.id === eventId)!
                .allocationSetHash,
            }
          : {}),
      },
    );
    if (generation === current) {
      proposalLinks.value[eventId] = result.proposalId;
      notice.value = 'Proposal saved. Review its exact payload and approvals before execution.';
    }
  } catch {
    if (generation === current)
      error.value =
        'Proposal outcome is unavailable. Refresh and check current proposals before submitting another intent.';
  } finally {
    if (generation === current) busy.value = false;
  }
}
async function saveDecision() {
  const prior = resolution.value;
  if (busy.value || !prior || !password.value || !hasDecision.value) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  notice.value = '';
  const body = {
    resolutionHash: prior.resolutionHash,
    relationships: prior.relationships.map((relationship) => ({
      ...relationship,
      state: relationshipChoices.value[relationship.id] || relationship.state,
    })),
    purposeDecisions: prior.events.flatMap((event) =>
      purposes.value[event.id]
        ? event.observationIds.map((observationId) => ({
            observationId,
            eventType: purposes.value[event.id],
          }))
        : [],
    ),
    itemCategoryDecisions: Object.values(effectForms.value).flatMap(
      (form) => form.itemCategoryDecisions ?? [],
    ),
    ledgerEffects: prior.events.flatMap((event) => {
      const form = effectForms.value[event.id];
      return form && validEffect(form)
        ? [
            {
              observationId: form.observationId,
              effect: {
                accountId: form.accountId,
                categoryId: form.receiptSplits === undefined ? form.categoryId : null,
                date: form.date,
                amount: {
                  ...event.amount,
                  minorUnits:
                    form.direction === 'inflow'
                      ? event.amount.minorUnits
                      : `-${event.amount.minorUnits}`,
                },
                payeeName: null,
                notes: null,
                splits: form.receiptSplits ?? [],
              },
            },
          ]
        : [];
    }),
  };
  try {
    await reauthenticateHuman(password.value);
    if (generation !== current) return;
    const result = await evidenceRequest(
      '/api/evidence/decision',
      TransactionEvidenceResultSchema,
      'POST',
      body,
    );
    if (generation === current) {
      resolution.value = result;
      resetDecisions();
      notice.value =
        'Evidence decision saved. Ledger changes still require an exact authorized proposal.';
    }
  } catch {
    if (generation === current) {
      resolution.value = null;
      purposes.value = {};
      relationshipChoices.value = {};
      error.value =
        'Evidence or permission changed. Refresh and review before saving another decision.';
    }
  } finally {
    password.value = '';
    if (generation === current) busy.value = false;
  }
}
function statusLabel(status: string): string {
  return status === 'parsed'
    ? 'Normalized evidence'
    : status === 'unsupported_template'
      ? 'Extraction required'
      : status === 'source_conflict'
        ? 'Source conflict'
        : 'Source needs repair';
}
</script>
