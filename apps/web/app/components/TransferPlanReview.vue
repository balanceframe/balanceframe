<template>
  <UCard>
    <template #header><h2 class="font-semibold">Exact transfer review</h2></template>
    <p class="font-medium">Read-only preview — no funds moved or reserved</p>
    <p>Minimum required: <SemanticAmount :amount="preview.plan.minimumAmount" /></p>
    <p>
      Required by {{ preview.plan.requiredBy }} · Estimated arrival
      {{ preview.plan.estimatedArrival }}
    </p>
    <p>Expires {{ preview.plan.expiresAt }}</p>
    <ul class="mt-3 space-y-3">
      <li v-for="(leg, index) in preview.plan.legs" :key="index" class="rounded border p-3">
        <h3 class="font-medium">
          {{ leg.sourceAccountName ?? 'Source account' }} →
          {{ leg.destinationAccountName ?? 'Destination account' }}
        </h3>
        <SemanticAmount :amount="leg.amount" />
        <div class="grid gap-2 text-sm sm:grid-cols-2">
          <p>
            Source safe capacity: <SemanticAmount :amount="leg.sourceCapacityBefore" /> →
            <SemanticAmount :amount="leg.sourceCapacityAfter" />
          </p>
          <p>
            Destination safe capacity: <SemanticAmount :amount="leg.destinationCapacityBefore" /> →
            <SemanticAmount :amount="leg.destinationCapacityAfter" />
          </p>
        </div>
      </li>
    </ul>
    <ReasonCodeList :codes="preview.plan.reasons" />
    <ul class="my-3 text-sm">
      <li v-for="assumption in preview.plan.assumptions" :key="assumption">{{ assumption }}</li>
    </ul>
    <p class="text-sm">
      Proposing reserves the source capacity and starts approval. It does not initiate a bank
      transfer or change category funding.
    </p>
    <label class="my-3 flex items-start gap-2"
      ><input v-model="reviewed" type="checkbox" /> I reviewed the exact accounts, amounts, timing
      and source effects.</label
    >
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <UButton :disabled="busy || !reviewed || expired" @click="propose">{{
      busy ? 'Proposing…' : 'Propose reviewed transfer'
    }}</UButton>
    <p v-if="expired">Preview expired. Close this review and request a new preview.</p>
    <UButton variant="ghost" :disabled="busy" @click="emit('close')">Close preview</UButton>
  </UCard>
</template>
<script setup lang="ts">
import type { PublicTransferPreview, PublicTransferDetail } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
const props = defineProps<{ preview: PublicTransferPreview }>();
const emit = defineEmits<{ close: []; proposed: [detail: PublicTransferDetail] }>();
const busy = ref(false);
const reviewed = ref(false);
const error = ref('');
const expired = computed(() => Date.parse(props.preview.plan.expiresAt) <= Date.now());
const idempotencyKey = crypto.randomUUID();
async function propose() {
  busy.value = true;
  error.value = '';
  try {
    const detail = await liquidityRequest<PublicTransferDetail>('/api/transfer/propose', 'POST', {
      previewId: props.preview.previewId,
      payloadHash: props.preview.payloadHash,
      idempotencyKey,
    });
    emit('proposed', detail);
    await navigateTo(`/transfer/${encodeURIComponent(detail.id)}`);
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
</script>
