<template>
  <section aria-label="Decision explanation" class="my-4 space-y-2 rounded border p-3">
    <button type="button" :disabled="busy || !principal" class="underline" @click="explain">
      {{ busy ? 'Preparing explanation…' : 'Explain this decision' }}
    </button>
    <p class="text-sm">
      Optional explanation. The deterministic Decision Card remains authoritative.
    </p>
    <p v-if="error" role="alert">Explanation unavailable. Use the deterministic Decision Card.</p>
    <div v-if="summary" class="space-y-1">
      <p data-testid="explanation-outcome">Decision: {{ summary.outcome.replaceAll('_', ' ') }}</p>
      <p data-testid="explanation-budget">Budget funding: {{ summary.budgetFundingStatus.replaceAll('_', ' ') }}</p>
      <p data-testid="explanation-payment">Payment liquidity: {{ summary.paymentLiquidityStatus.replaceAll('_', ' ') }}</p>
      <ul v-if="summary.blockers.length" data-testid="explanation-blockers" class="list-disc pl-5">
        <li v-for="(blocker, index) in summary.blockers" :key="index">{{ blocker.replaceAll('_', ' ') }}</li>
      </ul>
    </div>
    <p v-if="view?.status === 'manual'" role="status">
      Explanation unavailable ({{ view.code }}). Use the deterministic Decision Card and its current
      evidence.
    </p>
    <template v-if="view?.status === 'explained'">
      <p>Advisory explanation of the current result:</p>
      <ol class="list-decimal pl-5">
        <li v-for="fact in view.facts" :key="fact.id">
          {{ labels[fact.kind] }}<span v-if="fact.resourceId"> · {{ fact.resourceId }}</span
          >:
          <SemanticAmount
            v-if="fact.amount"
            :amount="fact.amount"
            semantic-class="envelopeAvailability"
          />
          <span v-else>{{ fact.code?.replaceAll('_', ' ') }}</span>
        </li>
      </ol>
      <p class="text-xs">
        Provider {{ view.provenance.provider }} · model {{ view.provenance.model }} ·
        {{ view.provenance.promptVersion }}
      </p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { decisionCardExplanationSummarySchema, decisionCardExplanationViewSchema } from '@balanceframe/application';
import type {
  DecisionCardExplanationView,
  LiquidityPurchaseIntent,
  PublicDecisionCard,
} from '@balanceframe/application';
import { authClient } from '../../lib/auth-client';
import { liquidityRequest } from '../utils/liquidity-client';
const props = defineProps<{ intent: LiquidityPurchaseIntent }>();
const emit = defineEmits<{ card: [PublicDecisionCard] }>();
const session = authClient.useSession();
const principal = computed(() => {
  const data = session?.value?.data;
  return data?.user?.id && data?.session?.id ? `${data.user.id}:${data.session.id}` : '';
});
const view = ref<DecisionCardExplanationView | null>(null);
const summary = ref<ReturnType<typeof decisionCardExplanationSummarySchema.parse> | null>(null);
const busy = ref(false),
  error = ref(false);
const labels = {
  outcome: 'Decision',
  budget_funding: 'Budget funding',
  payment_liquidity: 'Payment liquidity',
  blocker: 'Required evidence or action',
  reason: 'Reason',
  category_before: 'Category availability before',
  category_after: 'Category availability after',
};
let generation = 0;
function clear() {
  generation++;
  view.value = null;
  summary.value = null;
  busy.value = false;
  error.value = false;
}
watch(() => [props.intent, principal.value], clear, { deep: true, flush: 'sync' });
onUnmounted(clear);
async function explain() {
  if (busy.value || !principal.value) return;
  const ticket = ++generation;
  busy.value = true;
  view.value = null;
  summary.value = null;
  error.value = false;
  try {
    const result = await liquidityRequest<{ card: PublicDecisionCard; explanation: unknown }>(
      '/api/purchase/explain',
      'POST',
      { ...props.intent },
    );
    if (ticket !== generation) return;
    const explanation = decisionCardExplanationViewSchema.parse(result.explanation);
    summary.value = decisionCardExplanationSummarySchema.parse(result.card);
    view.value = explanation;
    emit('card', result.card);
  } catch {
    if (ticket === generation) error.value = true;
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
</script>
