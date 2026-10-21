<template>
  <section aria-label="Receipt comparison" class="space-y-3 rounded border p-3 text-sm">
    <p>
      Compare saved items with a receipt. This does not complete the session, consume its
      reservation, or create a payment. Planned prices remain reference prices.
    </p>
    <button
      type="button"
      data-testid="session-receipt-load"
      :disabled="busy"
      class="rounded border px-3 py-2"
      @click="load"
    >
      Find current receipts
    </button>
    <template v-if="context">
      <p>
        Saved session {{ context.snapshot.intent.id }} · version
        {{ context.snapshot.intent.version }}
      </p>
      <p v-for="reference in context.completionReferences" :key="reference.proposalId">
        Existing completion {{ reference.proposalId }}
        <span v-if="reference.manualTransactionId">
          · manual transaction {{ reference.manualTransactionId }}</span
        >
        <span v-if="reference.importedTransactionId">
          · imported transaction {{ reference.importedTransactionId }}</span
        >
      </p>
      <p v-if="context.associations.length">
        {{ context.associations.length }} current reviewed comparisons.
      </p>
      <label class="block"
        >Receipt
        <select
          v-model="selectedKey"
          data-testid="session-receipt-choice"
          class="ml-2 rounded border p-2 dark:bg-gray-950"
          @change="resetMappings"
        >
          <option value="">Choose receipt</option>
          <option
            v-for="receipt in context.receipts"
            :key="receiptKey(receipt)"
            :value="receiptKey(receipt)"
          >
            {{ receipt.counterparty ?? 'Receipt' }} · {{ receipt.date }}
          </option>
        </select>
      </label>
      <template v-if="selectedReceipt">
        <p>
          Receipt amount:
          <SemanticAmount :amount="selectedReceipt.amount" semantic-class="normalizedEvidence" />
        </p>
        <label class="block"
          >Purchase coverage
          <select
            v-model="coverage"
            data-testid="session-receipt-coverage"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
            @change="coverageChanged"
          >
            <option value="unknown">Coverage unknown</option>
            <option value="partial_purchase">Part of the purchase</option>
            <option value="complete_purchase">Complete purchase</option>
          </select>
        </label>
        <div
          v-for="item in context.snapshot.intent.items"
          :key="item.id"
          class="space-y-1 rounded border p-2"
        >
          <label class="block"
            >Saved item {{ item.barcode ?? item.id }}
            <select
              :value="choices.get(item.id) ?? ''"
              data-testid="session-receipt-item"
              class="ml-2 rounded border p-2 dark:bg-gray-950"
              @change="choose(item.id, $event)"
            >
              <option value="">Unresolved</option>
              <option v-if="coverage === 'complete_purchase'" value="__omitted__">
                Not purchased
              </option>
              <option
                v-for="line in selectedReceipt.lines"
                :key="line.id"
                :value="`line:${line.id}`"
              >
                {{ line.description }}
              </option>
            </select>
          </label>
          <label v-if="lineFor(item.id)"
            ><input
              type="checkbox"
              :checked="substitutions.has(item.id)"
              @change="substitute(item.id, $event)"
            />
            Substituted item</label
          >
        </div>
        <label v-for="line in unmappedLines" :key="line.id" class="block"
          ><input
            type="checkbox"
            :checked="extraLines.has(line.id)"
            @change="extra(line.id, $event)"
          />
          Additional purchase: {{ line.description }}</label
        >
        <button
          type="button"
          data-testid="session-receipt-compare"
          :disabled="busy || duplicateMapping"
          class="rounded border px-3 py-2"
          @click="compare"
        >
          Compare reviewed items
        </button>
        <p v-if="duplicateMapping" role="alert">A receipt line can match only one saved item.</p>
      </template>
    </template>
    <div v-if="result" class="space-y-2">
      <p>
        Comparison: {{ result.state }} · receipt claim
        <SemanticAmount :amount="result.receiptTotal" semantic-class="normalizedEvidence" />
      </p>
      <div v-for="(row, index) in result.rows" :key="index" class="rounded border p-2">
        <p>
          {{ row.sessionItemId ?? row.receiptLineId }}: {{ row.status
          }}<span v-if="row.changes.length">
            · {{ row.changes.map((change) => change.replaceAll('_', ' ')).join(', ') }}</span
          >
        </p>
        <p>
          Quantity: {{ row.quantityComparison }} · Price comparison:
          {{ row.priceComparison === 'currency_mismatch' ? 'unavailable' : row.priceComparison }}
        </p>
        <p v-if="row.priceBasis">
          Reference basis:
          {{
            row.priceBasis === 'unit_amount_vs_unit_gross'
              ? 'per unit, before receipt discounts and tax'
              : 'line gross, before receipt discounts and tax'
          }}
        </p>
        <p v-if="row.plannedReference">
          Saved reference:
          <SemanticAmount :amount="row.plannedReference" semantic-class="normalizedEvidence" />
        </p>
        <p v-if="row.observedReference">
          Receipt reference:
          <SemanticAmount :amount="row.observedReference" semantic-class="normalizedEvidence" />
        </p>
        <p v-for="reason in row.reasonCodes" :key="reason">
          {{
            reason === 'currency_mismatch'
              ? 'Currencies differ; prices cannot be compared.'
              : 'Estimated reference price; this is not a settled amount.'
          }}
        </p>
      </div>
      <p v-if="result.candidates.length">
        Identifier matches remain suggestions until you map the items above.
      </p>
      <p v-for="reason in result.reasonCodes" :key="reason">{{ reason }}</p>
      <template v-if="result.state !== 'blocked'">
        <label class="block"
          >Confirm your current session
          <input
            v-model="password"
            data-testid="session-receipt-password"
            type="password"
            autocomplete="current-password"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
        /></label>
        <button
          type="button"
          data-testid="session-receipt-save"
          :disabled="busy || !password"
          class="rounded border px-3 py-2"
          @click="save"
        >
          Save reviewed comparison
        </button>
      </template>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { CompareSpendSessionReceiptResultSchema } from '@balanceframe/protocol-generated/validators';
import type {
  CompareSpendSessionReceiptResult,
  SessionReceiptReview,
} from '@balanceframe/protocol-generated';
import {
  spendSessionReceiptContextSchema,
  spendSessionReceiptSavedSchema,
} from '../utils/spend-session-receipt-client';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import type { z } from 'zod';
const props = defineProps<{ documentId: string }>();
type Context = z.infer<typeof spendSessionReceiptContextSchema>;
type ReceiptChoice = Context['receipts'][number];
const context = ref<Context | null>(null);
const selectedKey = ref('');
const coverage = ref<SessionReceiptReview['coverage']>('unknown');
const choices = ref(new Map<string, string>());
const substitutions = ref(new Set<string>());
const extraLines = ref(new Set<string>());
const result = ref<CompareSpendSessionReceiptResult | null>(null);
const password = ref('');
const busy = ref(false);
const notice = ref('');
const error = ref('');
let generation = 0;
const receiptKey = (receipt: ReceiptChoice) =>
  JSON.stringify([receipt.documentId, receipt.receiptId]);
const selectedReceipt = computed(() =>
  context.value?.receipts.find((receipt) => receiptKey(receipt) === selectedKey.value),
);
function lineFor(itemId: string): string | null {
  const choice = choices.value.get(itemId);
  return choice?.startsWith('line:') &&
    selectedReceipt.value?.lines.some((line) => line.id === choice.slice(5))
    ? choice.slice(5)
    : null;
}
const mappedLines = computed(() =>
  (context.value?.snapshot.intent.items ?? []).flatMap((item) => {
    const line = lineFor(item.id);
    return line ? [line] : [];
  }),
);
const duplicateMapping = computed(
  () => new Set(mappedLines.value).size !== mappedLines.value.length,
);
const unmappedLines = computed(
  () => selectedReceipt.value?.lines.filter((line) => !mappedLines.value.includes(line.id)) ?? [],
);
function invalidate() {
  generation++;
  busy.value = false;
  result.value = null;
  password.value = '';
  notice.value = '';
  error.value = '';
}
function resetMappings() {
  choices.value.clear();
  substitutions.value.clear();
  extraLines.value.clear();
  coverage.value = 'unknown';
  invalidate();
}
function clear() {
  context.value = null;
  selectedKey.value = '';
  resetMappings();
}
watch(() => props.documentId, clear);
onUnmounted(clear);
function choose(id: string, event: Event) {
  choices.value.set(id, (event.target as HTMLSelectElement).value);
  for (const line of mappedLines.value) extraLines.value.delete(line);
  invalidate();
}
function substitute(id: string, event: Event) {
  if ((event.target as HTMLInputElement).checked) substitutions.value.add(id);
  else substitutions.value.delete(id);
  invalidate();
}
function extra(id: string, event: Event) {
  if ((event.target as HTMLInputElement).checked) extraLines.value.add(id);
  else extraLines.value.delete(id);
  invalidate();
}
function coverageChanged() {
  if (coverage.value !== 'complete_purchase')
    for (const [id, choice] of choices.value)
      if (choice === '__omitted__') choices.value.delete(id);
  invalidate();
}
function input() {
  if (!context.value || !selectedReceipt.value || duplicateMapping.value)
    throw new Error('Choose current receipt mappings');
  const items = context.value.snapshot.intent.items;
  return {
    sessionDocumentId: props.documentId,
    receipt: {
      documentId: selectedReceipt.value.documentId,
      receiptId: selectedReceipt.value.receiptId,
    },
    review: {
      coverage: coverage.value,
      pairs: items.flatMap((item) => {
        const line = lineFor(item.id);
        return line
          ? [
              {
                sessionItemId: item.id,
                receiptLineId: line,
                kind: substitutions.value.has(item.id)
                  ? ('substitution' as const)
                  : ('same_item' as const),
              },
            ]
          : [];
      }),
      omittedItemIds:
        coverage.value === 'complete_purchase'
          ? items
              .filter((item) => choices.value.get(item.id) === '__omitted__')
              .map((item) => item.id)
          : [],
      newLineIds: unmappedLines.value
        .filter((line) => extraLines.value.has(line.id))
        .map((line) => line.id),
    },
  };
}
async function load() {
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  notice.value = '';
  result.value = null;
  password.value = '';
  try {
    const loaded = await evidenceRequest(
      '/api/evidence/session-context',
      spendSessionReceiptContextSchema,
      'POST',
      { sessionDocumentId: props.documentId },
    );
    if (generation !== ticket) return;
    if (loaded.snapshot.documentId !== props.documentId) throw new Error('Context changed');
    context.value = loaded;
    selectedKey.value = '';
    choices.value.clear();
    substitutions.value.clear();
    extraLines.value.clear();
    coverage.value = 'unknown';
  } catch {
    if (generation === ticket) {
      context.value = null;
      error.value =
        'Receipt comparison unavailable. Reload the current saved session and evidence permissions.';
    }
  } finally {
    if (generation === ticket) busy.value = false;
  }
}
async function compare() {
  if (busy.value || !selectedReceipt.value || duplicateMapping.value) return;
  const body = input();
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  notice.value = '';
  result.value = null;
  password.value = '';
  try {
    const compared = await evidenceRequest(
      '/api/evidence/session-compare',
      CompareSpendSessionReceiptResultSchema,
      'POST',
      body,
    );
    if (generation !== ticket) return;
    if (
      compared.sessionDocumentId !== props.documentId ||
      compared.receiptDocumentId !== body.receipt.documentId ||
      compared.receiptId !== body.receipt.receiptId
    )
      throw new Error('Comparison changed');
    result.value = compared;
  } catch {
    if (generation === ticket)
      error.value = 'Receipt comparison unavailable. Review current sources and mappings.';
  } finally {
    if (generation === ticket) busy.value = false;
  }
}
async function save() {
  if (busy.value || !result.value || !password.value || result.value.state === 'blocked') return;
  const body = { ...input(), comparisonHash: result.value.comparisonHash };
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await reauthenticateHuman(password.value);
    if (generation !== ticket) return;
    const saved = await evidenceRequest(
      '/api/evidence/session-association',
      spendSessionReceiptSavedSchema,
      'POST',
      body,
    );
    if (generation === ticket) {
      if (saved.result.comparisonHash !== body.comparisonHash)
        throw new Error('Saved comparison changed');
      notice.value =
        'Comparison saved. Existing payment and completion reconciliation remain separate.';
    }
  } catch {
    if (generation === ticket)
      error.value =
        'Comparison save unavailable. Reload current reviewed comparisons before retrying.';
  } finally {
    if (generation === ticket) {
      busy.value = false;
      password.value = '';
    }
  }
}
</script>
