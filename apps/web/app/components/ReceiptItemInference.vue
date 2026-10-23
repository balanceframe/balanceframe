<template>
  <div class="space-y-2 rounded border p-2" aria-label="Optional receipt category suggestion">
    <p>Optional suggestions leave manual category selection available. Amounts stay unchanged.</p>
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        data-testid="receipt-inference-local"
        :disabled="busy"
        class="rounded border px-2 py-1"
        @click="preview('local')"
      >
        Preview local suggestion
      </button>
      <button
        type="button"
        data-testid="receipt-inference-external"
        :disabled="busy"
        class="rounded border px-2 py-1"
        @click="preview('external')"
      >
        Preview external suggestion
      </button>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="result?.state === 'preview'">
      <p>
        {{ result.provider.locality }} provider: {{ result.provider.id }} · model
        {{ result.provider.model }}
      </p>
      <p>
        Only this label and these category aliases and labels may be sent. Check them for private
        information before consenting.
      </p>
      <pre
        class="overflow-auto whitespace-pre-wrap break-all"
        data-testid="receipt-inference-payload"
        >{{ JSON.stringify(result.payload, null, 2) }}</pre>
      <p class="break-all">
        Payload hash: {{ result.payloadHash }} · expires {{ result.expiresAt }}
      </p>
      <label class="block"
        >Current password
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="rounded border p-1"
      /></label>
      <button
        type="button"
        data-testid="receipt-inference-consent"
        :disabled="busy || !password"
        class="rounded border px-2 py-1"
        @click="run"
      >
        Consent to this request
      </button>
      <button
        type="button"
        data-testid="receipt-inference-withdraw"
        :disabled="!password"
        class="rounded border px-2 py-1"
        @click="withdraw('revoked')"
      >
        Withdraw consent
      </button>
    </template>
    <template v-if="result?.state === 'suggested' || result?.state === 'deterministic'">
      <p>
        Suggested category:
        {{ categories.find((category) => category.id === suggestedCategory)?.name }}
      </p>
      <p v-if="result.state === 'suggested'">
        {{ result.provenance.locality }} · {{ result.provenance.id }} ·
        {{ result.provenance.model }}
      </p>
      <button
        type="button"
        data-testid="receipt-inference-use"
        :disabled="!suggestedCategory || busy"
        class="rounded border px-2 py-1"
        @click="useSuggestion"
      >
        Use suggested category
      </button>
      <template v-if="result.state === 'suggested'">
        <label class="block"
          >Current password
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="rounded border p-1"
        /></label>
        <button
          type="button"
          data-testid="receipt-inference-reject"
          :disabled="busy || !password"
          class="rounded border px-2 py-1"
          @click="withdraw('rejected')"
        >
          Reject suggestion
        </button>
      </template>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import {
  receiptInferenceViewSchema,
  receiptInferenceWithdrawnSchema,
  type ReceiptInferenceView,
} from '../utils/receipt-item-inference-client';
const props = defineProps<{
  accountId: string;
  receiptId: string;
  lineId: string;
  categories: { id: string; name: string }[];
}>();
const emit = defineEmits<{ suggested: [categoryId: string] }>();
const result = ref<ReceiptInferenceView | null>(null);
const password = ref('');
const notice = ref('');
const busy = ref(false);
let generation = 0;
const suggestedCategory = computed(() => {
  const current = result.value;
  return current &&
    (current.state === 'suggested' || current.state === 'deterministic') &&
    current.receiptId === props.receiptId &&
    current.lineId === props.lineId &&
    props.categories.some((category) => category.id === current.categoryId)
    ? current.categoryId
    : null;
});
function reset() {
  generation++;
  result.value = null;
  password.value = '';
  notice.value = '';
  busy.value = false;
}
watch(() => [props.accountId, props.receiptId, props.lineId, props.categories], reset, {
  deep: true,
});
onUnmounted(reset);
function show(value: ReceiptInferenceView) {
  result.value = value;
  notice.value =
    value.state === 'manual'
      ? value.reasonCode === 'local_first'
        ? 'Try an available local suggestion first. External requests always need separate consent.'
        : 'Optional suggestions are unavailable. Choose a category manually.'
      : 'Review this suggestion before choosing a category. Evidence confirmation remains separate.';
}
async function preview(locality: 'local' | 'external') {
  if (busy.value) return;
  const current = ++generation;
  busy.value = true;
  result.value = null;
  notice.value = '';
  try {
    const value = await evidenceRequest(
      '/api/evidence/inference/preview',
      receiptInferenceViewSchema,
      'POST',
      { accountId: props.accountId, receiptId: props.receiptId, lineId: props.lineId, locality },
    );
    if (current === generation) show(value);
  } catch {
    if (current === generation)
      notice.value = 'Optional suggestions are unavailable. Choose a category manually.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function run() {
  const displayed = result.value;
  if (displayed?.state !== 'preview' || busy.value || !password.value) return;
  const current = ++generation;
  const secret = password.value;
  password.value = '';
  busy.value = true;
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    const value = await evidenceRequest(
      '/api/evidence/inference/run',
      receiptInferenceViewSchema,
      'POST',
      { previewId: displayed.previewId, payloadHash: displayed.payloadHash },
    );
    if (current === generation) show(value);
  } catch {
    if (current === generation) {
      result.value = null;
      notice.value = 'Optional suggestions are unavailable. Choose a category manually.';
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function withdraw(action: 'rejected' | 'revoked') {
  const displayed = result.value;
  if (
    !displayed ||
    (displayed.state !== 'preview' && displayed.state !== 'suggested') ||
    !password.value
  )
    return;
  const current = ++generation;
  const secret = password.value;
  password.value = '';
  busy.value = true;
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    await evidenceRequest(
      '/api/evidence/inference/withdraw',
      receiptInferenceWithdrawnSchema,
      'POST',
      { previewId: displayed.previewId, payloadHash: displayed.payloadHash, action },
    );
    if (current === generation) {
      result.value = null;
      notice.value = 'Suggestion withdrawn. Choose a category manually.';
    }
  } catch {
    if (current === generation) {
      result.value = null;
      notice.value =
        'Withdrawal could not be confirmed. Refresh before requesting another suggestion.';
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
function useSuggestion() {
  if (suggestedCategory.value) emit('suggested', suggestedCategory.value);
}
</script>
