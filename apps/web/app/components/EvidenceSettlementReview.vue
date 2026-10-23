<template>
  <details class="space-y-3 rounded border p-3">
    <summary class="cursor-pointer font-medium">Match current settlements</summary>
    <p>
      Check the current ledger before creating a transaction or changing its categories. Selecting a
      match records evidence intent; save it with human confirmation below.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <article v-for="event in events" :key="event.id" class="mt-3 space-y-2 rounded border p-3">
      <p>{{ event.eventType.replaceAll('_', ' ') }} · <SemanticAmount :amount="event.amount" /></p>
      <label
        >Account<select
          v-model="selectedAccounts[event.id]"
          data-testid="settlement-account"
          :disabled="busy"
          class="ml-2 rounded border p-2 dark:bg-gray-950"
          @change="clearCandidates(event.id)"
        >
          <option value="">Choose an account</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.name }}
          </option>
        </select></label
      >
      <button
        type="button"
        data-testid="load-settlements"
        :disabled="busy || !selectedAccounts[event.id]"
        class="ml-2 rounded border px-3 py-2"
        @click="load(event.id)"
      >
        Find current settlements
      </button>
      <div
        v-for="transaction in candidates[event.id] ?? []"
        :key="transaction.id"
        class="space-y-2 rounded border p-3"
      >
        <p>
          {{ transaction.payeeName ?? 'No payee' }} · {{ transaction.date }} ·
          <SemanticAmount :amount="transaction.amount" />
        </p>
        <p>
          {{
            transaction.categoryName ??
            (transaction.categoryId ? 'Category name unavailable' : 'Uncategorized')
          }}
        </p>
        <ul v-if="transaction.splits.length">
          <li v-for="split in transaction.splits" :key="split.id">
            {{ split.categoryName ?? 'Uncategorized item' }} ·
            <SemanticAmount :amount="split.amount" />
          </li>
        </ul>
        <button
          v-if="relationship(event.id, transaction.id)"
          type="button"
          data-testid="select-settlement"
          :disabled="busy"
          class="rounded border px-3 py-2"
          @click="select(event.id, transaction)"
        >
          {{
            relationship(event.id, transaction.id)?.state === 'confirmed'
              ? 'Use matched settlement for category review'
              : 'Select settlement match'
          }}
        </button>
        <p v-else>No current native match is available. Keep this settlement separate.</p>
      </div>
      <p v-if="loaded[event.id] && !candidates[event.id]?.length">
        No current settlements are visible for this event under your permissions.
      </p>
    </article>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { TransactionEvidenceResult } from '@balanceframe/protocol-generated';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import {
  evidenceSettlementTargetsSchema,
  type EvidenceSettlementTarget,
  type EvidenceSettlementMatch,
} from '../utils/evidence-settlement-client';
import SemanticAmount from './SemanticAmount.vue';
const props = defineProps<{
  resolution: TransactionEvidenceResult;
  accounts: Array<{ id: string; name: string }>;
  documentIds: string[];
}>();
const emit = defineEmits<{ match: [value: EvidenceSettlementMatch] }>();
const events = computed(() =>
  props.resolution.events.filter((event) =>
    event.evidenceIds.some((id) => props.documentIds.includes(id)),
  ),
);
const selectedAccounts = ref<Record<string, string>>({});
const candidates = ref<Record<string, EvidenceSettlementTarget[]>>({});
const loaded = ref<Record<string, boolean>>({});
const busy = ref(false);
const error = ref('');
let generation = 0;
function clear() {
  generation++;
  selectedAccounts.value = {};
  candidates.value = {};
  loaded.value = {};
  busy.value = false;
  error.value = '';
}
watch(
  () => [
    props.resolution.resolutionHash,
    props.accounts.map((account) => account.id).join('\0'),
    props.documentIds.join('\0'),
  ],
  clear,
);
onUnmounted(clear);
function clearCandidates(eventId: string) {
  generation++;
  delete candidates.value[eventId];
  delete loaded.value[eventId];
  busy.value = false;
}
function relationship(eventId: string, transactionId: string) {
  const event = events.value.find((item) => item.id === eventId);
  return props.resolution.relationships.find(
    (item) =>
      ['candidate', 'confirmed'].includes(item.state) &&
      ((item.toId === `actual:${transactionId}` && event?.observationIds.includes(item.fromId)) ||
        (item.fromId === `actual:${transactionId}` && event?.observationIds.includes(item.toId))),
  );
}
async function load(eventId: string) {
  const accountId = selectedAccounts.value[eventId];
  if (!accountId || !props.accounts.some((account) => account.id === accountId) || busy.value)
    return;
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  delete candidates.value[eventId];
  delete loaded.value[eventId];
  try {
    const result = await evidenceRequest(
      '/api/evidence/settlement-targets',
      evidenceSettlementTargetsSchema,
      'POST',
      { resolutionHash: props.resolution.resolutionHash, eventId, accountId },
    );
    if (generation === ticket) {
      candidates.value[eventId] = result.transactions;
      loaded.value[eventId] = true;
    }
  } catch {
    if (generation === ticket)
      error.value = 'Settlement candidates unavailable. Refresh current evidence and permissions.';
  } finally {
    if (generation === ticket) busy.value = false;
  }
}
function select(eventId: string, transaction: EvidenceSettlementTarget) {
  const match = relationship(eventId, transaction.id);
  const accountId = selectedAccounts.value[eventId];
  if (
    !match ||
    !accountId ||
    busy.value ||
    !candidates.value[eventId]?.some((item) => item === transaction)
  )
    return;
  emit('match', { eventId, relationshipId: match.id, accountId, transaction });
}
</script>
