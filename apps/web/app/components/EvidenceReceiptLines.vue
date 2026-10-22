<template>
  <section class="space-y-2 rounded border p-3" aria-label="Receipt item categories">
    <p v-if="!valid">
      Receipt totals need review before item categories can become a ledger split.
    </p>
    <template v-else>
      <label
        ><input v-model="active" data-testid="receipt-line-mode" type="checkbox" /> Categorize
        receipt items</label
      >
      <p>
        Item amounts are preserved from the receipt. The exact split requires separate evidence
        confirmation and proposal approval.
      </p>
      <div v-if="active && accountId" class="space-y-2">
        <button
          type="button"
          data-testid="receipt-line-suggestions"
          :disabled="suggestionsBusy"
          class="rounded border px-3 py-2"
          @click="loadSuggestions"
        >
          {{ suggestionsBusy ? 'Checking approved rules…' : 'Use approved item suggestions' }}
        </button>
        <p v-if="suggestionsNotice" role="status">{{ suggestionsNotice }}</p>
        <details v-if="suggestionSources.length">
          <summary>Suggestion provenance</summary>
          <p
            v-for="source in suggestionSources"
            :key="`${source.proposalId}:${source.lineId}`"
            class="break-all"
          >
            {{ source.proposalId }} · {{ source.payloadHash }} · {{ source.reasonCodes.join(', ') }}
          </p>
        </details>
      </div>
      <label v-if="active && accountId" class="block">
        <input v-model="learnReviewed" data-testid="receipt-line-learning" type="checkbox" />
        Confirm these item categories as reviewed outcomes for future reviewed item rules
      </label>
      <p v-if="learnReviewed">
        Saving the evidence decision records these exact line choices; learning never activates a
        rule.
      </p>
      <div v-for="line in receipt.lines" :key="line.id" class="space-y-1">
        <p>
          {{ line.rawDescription }} ·
          <SemanticAmount :amount="line.net" semantic-class="normalizedEvidence" />
        </p>
        <p v-if="line.net.minorUnits === '0'">No ledger amount for this item.</p>
        <label v-if="active && line.net.minorUnits !== '0'"
          >Category
          <select
            v-model="choices[line.id]"
            data-testid="receipt-line-category"
            class="ml-2 rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Choose category</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
        </label>
        <ReceiptItemInference
          v-if="active && accountId && line.net.minorUnits !== '0'"
          :account-id="accountId"
          :receipt-id="receipt.id"
          :line-id="line.id"
          :categories="categories"
          @suggested="
            (category) => {
              if (!choices[line.id] && categories.some((value) => value.id === category))
                choices[line.id] = category;
            }
          "
        />
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { EconomicEventLedgerEffect, ReceiptEvidence } from '@balanceframe/protocol-generated';
import SemanticAmount from './SemanticAmount.vue';
import ReceiptItemInference from './ReceiptItemInference.vue';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import { evidenceItemSuggestionsViewSchema } from '../utils/evidence-item-rules-client';
const props = defineProps<{
  receipt: ReceiptEvidence;
  valid: boolean;
  direction: 'inflow' | 'outflow';
  categories: { id: string; name: string }[];
  accountId?: string;
}>();
const emit = defineEmits<{
  change: [EconomicEventLedgerEffect['splits'] | null | undefined];
  review: [{ receiptId: string; lineId: string; accountId: string; categoryId: string }[]];
}>();
const learnReviewed = ref(false);
const active = ref(false);
const choices = ref<Record<string, string>>({});
const suggestionsBusy = ref(false);
const suggestionsNotice = ref('');
const suggestionSources = ref<ReturnType<typeof evidenceItemSuggestionsViewSchema.parse>>([]);
let generation = 0;
function resetSuggestions() {
  generation++;
  suggestionsBusy.value = false;
  suggestionsNotice.value = '';
  suggestionSources.value = [];
}
async function loadSuggestions() {
  if (!props.accountId || suggestionsBusy.value) return;
  const current = ++generation;
  const accountId = props.accountId;
  suggestionsBusy.value = true;
  suggestionsNotice.value = '';
  suggestionSources.value = [];
  try {
    const result = await evidenceRequest(
      '/api/evidence/rules/suggestions',
      evidenceItemSuggestionsViewSchema,
      'POST',
      { accountId },
    );
    if (current !== generation) return;
    const currentSources = result.filter(
      (source) =>
        source.accountId === accountId &&
        source.receiptId === props.receipt.id &&
        financialLines.value.some((line) => line.id === source.lineId) &&
        props.categories.some((category) => category.id === source.categoryId),
    );
    suggestionSources.value = currentSources;
    let conflicts = false;
    for (const line of financialLines.value) {
      const sources = currentSources.filter((source) => source.lineId === line.id);
      const categories = new Set(sources.map((source) => source.categoryId));
      if (sources.some((source) => source.state === 'conflicting_rules') || categories.size > 1) {
        conflicts = true;
        continue;
      }
      const categoryId = sources[0]?.categoryId;
      if (categoryId && !choices.value[line.id]) choices.value[line.id] = categoryId;
    }
    suggestionsNotice.value = conflicts
      ? 'Conflicting approved rules need manual review.'
      : 'Review the suggested categories before confirming evidence. Amounts are unchanged.';
  } catch {
    if (current === generation)
      suggestionsNotice.value = 'Approved rules are unavailable. Choose categories manually.';
  } finally {
    if (current === generation) suggestionsBusy.value = false;
  }
}
const financialLines = computed(() =>
  props.receipt.lines.filter((line) => line.net.minorUnits !== '0'),
);
const split = computed(() => {
  if (!active.value) return undefined;
  if (
    !props.valid ||
    !financialLines.value.length ||
    financialLines.value.some(
      (line) => !props.categories.some((category) => category.id === choices.value[line.id]),
    )
  )
    return null;
  return financialLines.value.map((line) => ({
    categoryId: choices.value[line.id]!,
    amount: {
      ...line.net,
      minorUnits: props.direction === 'inflow' ? line.net.minorUnits : `-${line.net.minorUnits}`,
    },
  }));
});
watch(split, (value) => emit('change', value));
watch(
  () => [learnReviewed.value, split.value, props.accountId] as const,
  () => {
    emit(
      'review',
      learnReviewed.value && split.value && props.accountId
        ? financialLines.value.map((line) => ({
            receiptId: props.receipt.id,
            lineId: line.id,
            accountId: props.accountId!,
            categoryId: choices.value[line.id]!,
          }))
        : [],
    );
  },
);
watch(
  () => props.receipt,
  () => {
    resetSuggestions();
    active.value = false;
    choices.value = {};
    learnReviewed.value = false;
  },
);
watch(
  () => props.accountId,
  () => {
    resetSuggestions();
    choices.value = {};
    learnReviewed.value = false;
  },
);
onUnmounted(resetSuggestions);
</script>
