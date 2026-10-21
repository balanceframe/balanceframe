<template>
  <details class="space-y-3 rounded border p-3">
    <summary class="cursor-pointer font-medium">Review receipt relationships and members</summary>
    <p>
      Attribute items, link a return to its original purchase, or link an invoice to an order. These
      choices record evidence. Financial changes require separate approval.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button
      type="button"
      :disabled="busy"
      data-testid="receipt-review-load"
      class="rounded border px-3 py-2"
      @click="load"
    >
      Load current receipt choices
    </button>
    <fieldset v-if="context" :disabled="busy" class="space-y-3">
      <label class="block"
        >Receipt<select v-model="receiptId" data-testid="receipt-review-receipt">
          <option value="">Choose a receipt</option>
          <option
            v-for="entry in context.receipts.filter((r) => r.valid || clearField)"
            :key="entry.receipt.id"
            :value="entry.receipt.id"
          >
            {{ entry.receipt.id }} · {{ entry.kind }}
          </option>
        </select></label
      >
      <label class="block"
        >Review field<select v-model="mode" data-testid="receipt-review-mode">
          <option value="member">Item member</option>
          <option value="return">Original purchase for return</option>
          <option value="fulfillment">Order fulfilled by invoice</option>
        </select></label
      >
      <label v-if="mode !== 'fulfillment'" class="block"
        >Item<select v-model="lineId" data-testid="receipt-review-line">
          <option value="">Choose an item</option>
          <option v-for="line in selected?.receipt.lines ?? []" :key="line.id" :value="line.id">
            {{ line.rawDescription }} · {{ line.net.minorUnits }} {{ line.net.currency }} minor
            units
          </option>
        </select></label
      >
      <label class="block"
        ><input v-model="clearField" type="checkbox" data-testid="receipt-review-clear" />Explicitly
        remove the reviewed value</label
      >
      <label v-if="mode === 'member' && !clearField" class="block"
        >Member<select v-model="memberId" data-testid="receipt-review-member">
          <option value="">Choose a permitted member</option>
          <option
            v-for="member in context.members"
            :key="member.membershipId"
            :value="member.membershipId"
          >
            {{ member.label }}
          </option>
        </select></label
      >
      <label v-if="mode === 'return' && !clearField" class="block"
        >Original purchase item<select v-model="originalKey" data-testid="receipt-review-original">
          <option value="">Choose an original item</option>
          <template v-for="entry in originals" :key="entry.receipt.id"
            ><option
              v-for="line in entry.receipt.lines.filter((l) => l.returnOfLineId === null)"
              :key="line.id"
              :value="JSON.stringify([entry.documentId, entry.receipt.id, line.id])"
            >
              {{ entry.receipt.id }} · {{ line.rawDescription }}
            </option></template
          >
        </select></label
      >
      <label v-if="mode === 'fulfillment' && !clearField" class="block"
        >Order<select v-model="orderKey" data-testid="receipt-review-order">
          <option value="">Choose an order</option>
          <option
            v-for="order in context.orders"
            :key="order.observationId"
            :value="JSON.stringify([order.documentId, order.observationId])"
          >
            {{ order.date }} · {{ order.counterparty ?? 'Unnamed order' }} ·
            {{ order.observationId }}
          </option>
        </select></label
      >
      <p v-for="entry in currentAnnotations" :key="JSON.stringify(entry.change)">
        Current human review: {{ entry.change.kind }} · {{ entry.actorId }} ·
        {{ entry.reviewedAt }} · {{ JSON.stringify(entry.change) }}
      </p>
      <label class="block"
        ><input v-model="confirmed" type="checkbox" data-testid="receipt-review-confirm" />I
        reviewed the source receipt and this exact relationship or member choice.</label
      >
      <label class="block"
        >{{ confirmationLabel
        }}<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          data-testid="receipt-review-password"
      /></label>
      <button
        type="button"
        :disabled="busy || !choice || !confirmed || !password"
        data-testid="receipt-review-save"
        class="rounded border px-3 py-2"
        @click="save"
      >
        Save reviewed receipt field
      </button>
    </fieldset>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { TransactionEvidenceResult } from '@balanceframe/protocol-generated';
import { TransactionEvidenceResultSchema } from '@balanceframe/protocol-generated/validators';
import {
  receiptReviewContextSchema,
  type ReceiptReviewContext,
} from '../utils/evidence-receipt-review-client';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import { reauthenticateHuman } from '../utils/reauthentication';
const props = defineProps<{ resolutionHash: string }>();
const emit = defineEmits<{ saved: [value: TransactionEvidenceResult] }>();
const context = ref<ReceiptReviewContext | null>(null);
const receiptId = ref(''),
  lineId = ref(''),
  mode = ref<'member' | 'return' | 'fulfillment'>('member');
const memberId = ref(''),
  originalKey = ref(''),
  orderKey = ref('');
const clearField = ref(false),
  confirmed = ref(false),
  password = ref(''),
  busy = ref(false),
  error = ref('');
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
let generation = 0;
const selected = computed(() =>
  context.value?.receipts.find(
    (r) => (r.valid || clearField.value) && r.receipt.id === receiptId.value,
  ),
);
const originals = computed(
  () =>
    context.value?.receipts.filter(
      (r) => r.valid && ['purchase', 'p2p_payment'].includes(r.kind),
    ) ?? [],
);
const currentAnnotations = computed(
  () =>
    context.value?.annotations.filter(
      (a) =>
        a.receiptId === receiptId.value &&
        a.change.kind === mode.value &&
        (!('lineId' in a.change) || a.change.lineId === lineId.value),
    ) ?? [],
);
const choice = computed(() => {
  if (!selected.value) return null;
  const receiptId = selected.value.receipt.id;
  if (mode.value === 'fulfillment') {
    if (clearField.value) return { kind: 'fulfillment', receiptId, order: null };
    const order = context.value?.orders.find(
      (o) => JSON.stringify([o.documentId, o.observationId]) === orderKey.value,
    );
    return order
      ? {
          kind: 'fulfillment',
          receiptId,
          order: { documentId: order.documentId, observationId: order.observationId },
        }
      : null;
  }
  const line = selected.value.receipt.lines.find((l) => l.id === lineId.value);
  if (!line) return null;
  if (mode.value === 'member')
    return clearField.value
      ? { kind: 'member', receiptId, lineId: line.id, membershipId: null }
      : context.value?.members.some((m) => m.membershipId === memberId.value)
        ? { kind: 'member', receiptId, lineId: line.id, membershipId: memberId.value }
        : null;
  if (selected.value.kind !== 'refund') return null;
  if (clearField.value) return { kind: 'return', receiptId, lineId: line.id, original: null };
  for (const entry of originals.value)
    for (const original of entry.receipt.lines)
      if (
        original.returnOfLineId === null &&
        JSON.stringify([entry.documentId, entry.receipt.id, original.id]) === originalKey.value
      )
        return {
          kind: 'return',
          receiptId,
          lineId: line.id,
          original: {
            documentId: entry.documentId,
            receiptId: entry.receipt.id,
            lineId: original.id,
          },
        };
  return null;
});
function invalidate() {
  generation++;
  confirmed.value = false;
  password.value = '';
  busy.value = false;
  error.value = '';
}
watch([receiptId, lineId, mode, memberId, originalKey, orderKey, clearField], invalidate);
watch(receiptId, () => {
  lineId.value = '';
});
watch(mode, () => {
  clearField.value = false;
});
watch(
  () => props.resolutionHash,
  () => {
    invalidate();
    context.value = null;
    receiptId.value = '';
    lineId.value = '';
    memberId.value = '';
    originalKey.value = '';
    orderKey.value = '';
    clearField.value = false;
  },
);
onUnmounted(invalidate);
async function load() {
  if (busy.value) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  try {
    const value = await evidenceRequest('/api/evidence/receipt-review', receiptReviewContextSchema);
    if (current !== generation) return;
    if (value.resolutionHash !== props.resolutionHash) throw new Error('changed');
    context.value = value;
  } catch {
    if (current === generation)
      error.value = 'Receipt review unavailable. Refresh current sources and permissions.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function save() {
  if (busy.value || !choice.value || !confirmed.value || !password.value) return;
  const current = ++generation;
  const body = { resolutionHash: props.resolutionHash, decisions: [choice.value] };
  const secret = password.value;
  password.value = '';
  busy.value = true;
  error.value = '';
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    const value = await evidenceRequest(
      '/api/evidence/receipt-review',
      TransactionEvidenceResultSchema,
      'POST',
      body,
    );
    if (current !== generation) return;
    confirmed.value = false;
    emit('saved', value);
  } catch {
    if (current === generation)
      error.value = 'Receipt review unavailable. Refresh current sources and permissions.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
