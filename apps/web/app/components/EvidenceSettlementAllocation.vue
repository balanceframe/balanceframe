<template>
  <details class="space-y-3 rounded border p-3">
    <summary class="cursor-pointer font-medium">
      Allocate receipts to one existing settlement
    </summary>
    <p>
      Select whole receipts, the existing bank payment, and each item's category. Rust checks the
      totals. Saving records your reviewed categories and settlement evidence; a separate approved
      amendment changes Actual.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <fieldset :disabled="busy" class="space-y-3">
      <label v-for="receipt in available" :key="receipt.id" class="block">
        <input
          v-model="selectedIds"
          type="checkbox"
          :value="receipt.id"
          data-testid="allocation-receipt"
        />
        {{ receipt.id }} · <SemanticAmount :amount="receipt.total" />
      </label>
      <label class="block"
        >Account<select
          v-model="accountId"
          data-testid="allocation-account"
          class="ml-2 rounded border p-2 dark:bg-gray-950"
        >
          <option value="">Choose an account</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.name }}
          </option>
        </select></label
      >
      <button
        type="button"
        data-testid="allocation-find-targets"
        :disabled="!selected.length || !accountId"
        class="rounded border px-3 py-2"
        @click="loadTargets"
      >
        Find current payments
      </button>
      <label v-if="transactions.length" class="block"
        >Existing payment<select
          v-model="targetId"
          data-testid="allocation-target"
          class="ml-2 rounded border p-2 dark:bg-gray-950"
        >
          <option value="">Choose a payment</option>
          <option v-for="transaction in transactions" :key="transaction.id" :value="transaction.id">
            {{ transaction.date }} · {{ transaction.payeeName ?? 'No payee' }} ·
            {{ transaction.amount.minorUnits }} {{ transaction.amount.currency }} minor units
          </option>
        </select></label
      >
      <p v-if="loaded && !transactions.length">
        No current readable payments match this account, date, currency and direction.
      </p>
      <section v-for="receipt in selected" :key="receipt.id" class="space-y-2 rounded border p-3">
        <p>{{ receipt.id }} · <SemanticAmount :amount="receipt.total" /></p>
        <label v-for="line in receipt.lines" :key="line.id" class="block"
          >{{ line.rawDescription }} · <SemanticAmount :amount="line.net" />
          <select
            v-model="choices[lineKey(receipt.id, line.id)]"
            data-testid="allocation-line-category"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Choose a category</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
        </label>
      </section>
      <button
        type="button"
        data-testid="allocation-preview"
        :disabled="!valid"
        class="rounded border px-3 py-2"
        @click="preview"
      >
        Preview exact allocation
      </button>
    </fieldset>
    <section v-if="plan" class="space-y-3 rounded border p-3">
      <p>Existing settlement · <SemanticAmount :amount="plan.ledgerEffect.amount" /></p>
      <ul>
        <li v-for="item in plan.contributions" :key="lineKey(item.receiptId, item.lineId)">
          {{ item.receiptId }} · {{ categoryName(item.categoryId) }} ·
          <SemanticAmount :amount="item.amount" />
        </li>
      </ul>
      <p>
        Account, amount, date, payee and notes are preserved. No additional transaction is created.
      </p>
      <label class="block"
        ><input
          v-model="confirmed"
          type="checkbox"
          data-testid="allocation-confirm"
          :disabled="busy"
        />
        I reviewed these receipts, the selected existing payment, and each item category.</label
      >
      <label class="block"
        >{{ confirmationLabel
        }}<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          data-testid="allocation-password"
          :disabled="busy"
          class="ml-2 rounded border p-2 dark:bg-gray-950"
      /></label>
      <button
        type="button"
        data-testid="allocation-save"
        :disabled="busy || !confirmed || !password"
        class="rounded border px-3 py-2"
        @click="save"
      >
        Save reviewed allocation
      </button>
    </section>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type {
  EvidenceSettlementPlan,
  ReceiptEvidence,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
import {
  EvidenceSettlementPlanSchema,
  TransactionEvidenceResultSchema,
} from '@balanceframe/protocol-generated/validators';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import {
  evidenceSettlementTargetsSchema,
  type EvidenceSettlementTarget,
} from '../utils/evidence-settlement-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import SemanticAmount from './SemanticAmount.vue';
const props = defineProps<{
  resolution: TransactionEvidenceResult;
  receipts: ReceiptEvidence[];
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
}>();
const emit = defineEmits<{ saved: [value: TransactionEvidenceResult] }>();
const available = computed(() =>
  props.receipts.filter((receipt) =>
    props.resolution.receipts.some((result) => result.receiptId === receipt.id && result.valid),
  ),
);
const selectedIds = ref<string[]>([]);
const selected = computed(() =>
  available.value.filter((receipt) => selectedIds.value.includes(receipt.id)),
);
const accountId = ref('');
const targetId = ref('');
const transactions = ref<EvidenceSettlementTarget[]>([]);
const loaded = ref(false);
const choices = ref<Record<string, string>>({});
const plan = ref<EvidenceSettlementPlan | null>(null);
const confirmed = ref(false);
const password = ref('');
const busy = ref(false);
const error = ref('');
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
let generation = 0;
const lineKey = (receiptId: string, lineId: string) => JSON.stringify([receiptId, lineId]);
const lineCategories = computed(() =>
  selected.value.flatMap((receipt) =>
    receipt.lines.map((line) => ({
      receiptId: receipt.id,
      lineId: line.id,
      categoryId: choices.value[lineKey(receipt.id, line.id)] ?? '',
    })),
  ),
);
const valid = computed(
  () =>
    selected.value.length > 0 &&
    selected.value.every((receipt) => receipt.lines.length > 0) &&
    transactions.value.some((transaction) => transaction.id === targetId.value) &&
    lineCategories.value.every((line) =>
      props.categories.some((category) => category.id === line.categoryId),
    ),
);
function invalidate() {
  generation++;
  plan.value = null;
  confirmed.value = false;
  password.value = '';
  busy.value = false;
  error.value = '';
}
function clearTargets() {
  invalidate();
  transactions.value = [];
  targetId.value = '';
  loaded.value = false;
}
function clear() {
  clearTargets();
  selectedIds.value = [];
  accountId.value = '';
  choices.value = {};
}
watch(
  () => [
    props.resolution.resolutionHash,
    JSON.stringify(props.receipts),
    JSON.stringify(props.accounts),
    JSON.stringify(props.categories),
  ],
  clear,
);
watch([accountId, () => selectedIds.value.join('\0')], clearTargets);
watch([targetId, () => JSON.stringify(choices.value)], invalidate);
onUnmounted(() => {
  generation++;
});
function selector() {
  return {
    resolutionHash: props.resolution.resolutionHash,
    targetTransactionId: targetId.value,
    receiptIds: selected.value.map((receipt) => receipt.id),
    lineCategories: lineCategories.value,
  };
}
function categoryName(id: string) {
  return props.categories.find((category) => category.id === id)?.name ?? id;
}
async function loadTargets() {
  const first = selected.value[0];
  const event = props.resolution.events.find(
    (event) => first && event.observationIds.includes(first.observationId),
  );
  if (busy.value || !event || !props.accounts.some((account) => account.id === accountId.value))
    return;
  clearTargets();
  const ticket = generation;
  busy.value = true;
  try {
    const result = await evidenceRequest(
      '/api/evidence/settlement-targets',
      evidenceSettlementTargetsSchema,
      'POST',
      {
        resolutionHash: props.resolution.resolutionHash,
        eventId: event.id,
        accountId: accountId.value,
        matchMode: 'partial',
      },
    );
    if (ticket === generation) {
      transactions.value = result.transactions;
      loaded.value = true;
    }
  } catch {
    if (ticket === generation)
      error.value = 'Current settlement candidates unavailable. Refresh evidence and permissions.';
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
async function preview() {
  if (busy.value || !valid.value) return;
  invalidate();
  const ticket = generation;
  busy.value = true;
  try {
    const result = await evidenceRequest(
      '/api/evidence/settlement-preview',
      EvidenceSettlementPlanSchema,
      'POST',
      selector(),
    );
    if (ticket === generation) plan.value = result;
  } catch {
    if (ticket === generation)
      error.value =
        'Receipts do not currently support an exact allocation. Refresh sources, amounts and categories.';
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
async function save() {
  if (busy.value || !plan.value || !confirmed.value || !password.value || !valid.value) return;
  const body = { ...selector(), allocationHash: plan.value.allocationHash };
  const ticket = generation;
  busy.value = true;
  error.value = '';
  try {
    await reauthenticateHuman(password.value);
    if (ticket !== generation) return;
    const result = await evidenceRequest(
      '/api/evidence/settlement-allocation',
      TransactionEvidenceResultSchema,
      'POST',
      body,
    );
    if (ticket === generation) {
      invalidate();
      emit('saved', result);
    }
  } catch {
    if (ticket === generation) {
      plan.value = null;
      confirmed.value = false;
      error.value = 'Allocation or permission changed. Preview again before saving.';
    }
  } finally {
    if (ticket === generation) {
      busy.value = false;
      password.value = '';
    }
  }
}
</script>
