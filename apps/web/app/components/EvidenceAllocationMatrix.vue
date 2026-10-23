<template>
  <details class="space-y-3 rounded border p-3">
    <summary class="cursor-pointer font-medium">
      Allocate item amounts across existing payments
    </summary>
    <p>
      Select receipts and existing payments, then enter each item's explicit contribution in minor
      units. Rust checks all capacities and shows unallocated amounts. Saving evidence does not
      change Actual.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <fieldset :disabled="busy" class="space-y-3">
      <label v-for="receipt in available" :key="receipt.id" class="block"
        ><input
          v-model="receiptIds"
          type="checkbox"
          :value="receipt.id"
          data-testid="matrix-receipt" />{{ receipt.id }} · <SemanticAmount :amount="receipt.total"
      /></label>
      <label class="block"
        >Find payments in account<select v-model="accountId" data-testid="matrix-account">
          <option value="">Choose an account</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.name }}
          </option>
        </select></label
      >
      <button
        type="button"
        data-testid="matrix-find"
        :disabled="!selected.length || !accountId"
        @click="find"
      >
        Find current payments
      </button>
      <label v-for="target in targets" :key="target.id" class="block"
        ><input
          v-model="targetIds"
          type="checkbox"
          :value="target.id"
          data-testid="matrix-target" />{{ target.date }} · {{ target.payeeName ?? 'No payee' }} ·
        <SemanticAmount :amount="target.amount"
      /></label>
      <section v-for="receipt in selected" :key="receipt.id" class="space-y-3 rounded border p-2">
        <div v-for="line in receipt.lines" :key="line.id">
          <p>
            {{ receipt.id }} · {{ line.rawDescription }} · <SemanticAmount :amount="line.net" />
          </p>
          <label
            >Category<select
              v-model="categoriesByLine[key(receipt.id, line.id)]"
              data-testid="matrix-category"
            >
              <option value="">Choose a category</option>
              <option v-for="category in categories" :key="category.id" :value="category.id">
                {{ category.name }}
              </option>
            </select></label
          >
          <label
            >Reviewed account context<select
              v-model="accountsByLine[key(receipt.id, line.id)]"
              data-testid="matrix-line-account"
            >
              <option value="">Choose an account context</option>
              <option v-for="account in selectedAccounts" :key="account.id" :value="account.id">
                {{ account.name }}
              </option>
            </select></label
          >
          <label v-for="target in selectedTargets" :key="target.id" class="block"
            >{{ target.id }} contribution · {{ line.net.currency }} minor units<input
              v-model="amounts[key(receipt.id, line.id, target.id)]"
              inputmode="numeric"
              data-testid="matrix-cell"
          /></label>
        </div>
      </section>
      <button type="button" data-testid="matrix-preview" :disabled="!valid" @click="preview">
        Preview exact item allocation
      </button>
    </fieldset>
    <section v-if="plan" class="space-y-3 rounded border p-3">
      <div v-for="projection in plan.projections" :key="projection.targetObservationId">
        <p>
          {{ projection.ledgerTransactionId }} ·
          <SemanticAmount :amount="projection.ledgerEffect.amount" />
        </p>
        <p v-for="split in projection.ledgerEffect.splits" :key="split.categoryId">
          {{ split.categoryId }} · <SemanticAmount :amount="split.amount" />
        </p>
      </div>
      <p v-for="remainder in plan.remainders" :key="key(remainder.receiptId, remainder.lineId)">
        Unallocated {{ remainder.receiptId }} · {{ remainder.lineId }} ·
        <SemanticAmount :amount="remainder.amount" />
      </p>
      <p v-for="remainder in plan.targetRemainders" :key="remainder.targetObservationId">
        Unfunded payment {{ remainder.targetObservationId }} ·
        <SemanticAmount :amount="remainder.amount" />
      </p>
      <p>
        Each complete payment keeps its account, amount, date, payee and notes. A separate governed
        proposal reviews all resulting amendments.
      </p>
      <label class="block"
        ><input
          v-model="confirmed"
          type="checkbox"
          data-testid="matrix-confirm"
          :disabled="busy"
        />I reviewed these exact item contributions, categories, account contexts, payments and
        remainders.</label
      >
      <label class="block"
        >{{ confirmationLabel
        }}<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          data-testid="matrix-password"
          :disabled="busy"
      /></label>
      <button
        type="button"
        data-testid="matrix-save"
        :disabled="busy || !confirmed || !password"
        @click="save"
      >
        Save exact allocation evidence
      </button>
    </section>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type {
  EvidenceAllocationPlan,
  ReceiptEvidence,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
import {
  EvidenceAllocationPlanSchema,
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
const receiptIds = ref<string[]>([]),
  targetIds = ref<string[]>([]),
  accountId = ref('');
const targets = ref<Array<EvidenceSettlementTarget & { accountId: string }>>([]);
const categoriesByLine = ref<Record<string, string>>({}),
  accountsByLine = ref<Record<string, string>>({}),
  amounts = ref<Record<string, string>>({});
const plan = ref<EvidenceAllocationPlan | null>(null),
  confirmed = ref(false),
  password = ref(''),
  busy = ref(false),
  error = ref('');
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
let generation = 0;
const key = (...ids: string[]) => JSON.stringify(ids);
const available = computed(() =>
  props.receipts.filter((receipt) =>
    props.resolution.receipts.some((r) => r.receiptId === receipt.id && r.valid),
  ),
);
const selected = computed(() => available.value.filter((r) => receiptIds.value.includes(r.id)));
const selectedTargets = computed(() => targets.value.filter((t) => targetIds.value.includes(t.id)));
const selectedAccounts = computed(() =>
  props.accounts.filter((a) => selectedTargets.value.some((t) => t.accountId === a.id)),
);
const lineCategories = computed(() =>
  selected.value.flatMap((receipt) =>
    receipt.lines.map((line) => ({
      receiptId: receipt.id,
      lineId: line.id,
      categoryId: categoriesByLine.value[key(receipt.id, line.id)] ?? '',
      accountId: accountsByLine.value[key(receipt.id, line.id)] ?? '',
    })),
  ),
);
const cells = computed(() =>
  selected.value.flatMap((receipt) =>
    receipt.lines.flatMap((line) =>
      selectedTargets.value.flatMap((target) => {
        const amount = amounts.value[key(receipt.id, line.id, target.id)];
        return amount
          ? [
              {
                receiptId: receipt.id,
                lineId: line.id,
                targetTransactionId: target.id,
                amount: { minorUnits: amount, currency: line.net.currency },
              },
            ]
          : [];
      }),
    ),
  ),
);
const valid = computed(
  () =>
    selected.value.length > 0 &&
    selected.value.every((r) => r.lines.length > 0) &&
    selectedTargets.value.length > 0 &&
    lineCategories.value.every(
      (l) =>
        props.categories.some((c) => c.id === l.categoryId) &&
        selectedAccounts.value.some((a) => a.id === l.accountId),
    ) &&
    cells.value.length > 0 &&
    cells.value.every((c) => /^[1-9]\d{0,18}$/.test(c.amount.minorUnits)),
);
function invalidate() {
  generation++;
  plan.value = null;
  confirmed.value = false;
  password.value = '';
  busy.value = false;
  error.value = '';
}
watch([receiptIds, targetIds, categoriesByLine, accountsByLine, amounts], invalidate, {
  deep: true,
});
watch(
  () => [
    props.resolution.resolutionHash,
    JSON.stringify(props.receipts),
    JSON.stringify(props.accounts),
    JSON.stringify(props.categories),
  ],
  () => {
    invalidate();
    receiptIds.value = [];
    targetIds.value = [];
    targets.value = [];
    categoriesByLine.value = {};
    accountsByLine.value = {};
    amounts.value = {};
  },
);
onUnmounted(invalidate);
function selector() {
  return {
    resolutionHash: props.resolution.resolutionHash,
    receiptIds: selected.value.map((r) => r.id),
    targetTransactionIds: selectedTargets.value.map((t) => t.id),
    lineCategories: lineCategories.value,
    cells: cells.value,
  };
}
async function find() {
  if (busy.value || !selected.value.length || !accountId.value) return;
  invalidate();
  const current = generation,
    account = accountId.value;
  busy.value = true;
  try {
    const event = props.resolution.events.find((e) =>
      e.observationIds.includes(selected.value[0]!.observationId),
    );
    if (!event) throw new Error('source changed');
    const result = await evidenceRequest(
      '/api/evidence/settlement-targets',
      evidenceSettlementTargetsSchema,
      'POST',
      {
        resolutionHash: props.resolution.resolutionHash,
        eventId: event.id,
        accountId: account,
        matchMode: 'partial',
      },
    );
    if (current !== generation) return;
    const keep = targets.value.filter((t) => t.accountId !== account);
    targets.value = [...keep, ...result.transactions.map((t) => ({ ...t, accountId: account }))];
    targetIds.value = targetIds.value.filter((id) => targets.value.some((t) => t.id === id));
  } catch {
    if (current === generation)
      error.value = 'Current payments unavailable. Refresh sources and permissions.';
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
      '/api/evidence/allocation-preview',
      EvidenceAllocationPlanSchema,
      'POST',
      selector(),
    );
    if (current === generation) plan.value = value;
  } catch {
    if (current === generation)
      error.value =
        'Allocation needs review. Check the exact cells, tenders, sources and permissions.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function save() {
  if (busy.value || !plan.value || !confirmed.value || !password.value) return;
  const current = ++generation,
    body = { ...selector(), allocationSetHash: plan.value.allocationSetHash },
    secret = password.value;
  password.value = '';
  busy.value = true;
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    const value = await evidenceRequest(
      '/api/evidence/allocation',
      TransactionEvidenceResultSchema,
      'POST',
      body,
    );
    if (current === generation) {
      confirmed.value = false;
      emit('saved', value);
    }
  } catch {
    if (current === generation)
      error.value = 'Allocation unavailable. Refresh current sources and permissions.';
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
