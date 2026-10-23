<template>
  <section aria-label="Transaction evidence resolution" class="space-y-4 text-sm">
    <p>
      Economic-event resolution · policy {{ result.policyVersion }}. Ledger proposals require
      separate review and approval.
    </p>
    <p v-if="!result.events.length" role="status">No economic events in the admitted evidence.</p>
    <article v-for="event in result.events" :key="event.id" class="space-y-2 rounded border p-3">
      <h3 class="font-semibold">{{ label(event.eventType) }} · {{ label(event.state) }}</h3>
      <p>
        <SemanticAmount :amount="event.amount" semantic-class="economicEventResolution" /> ·
        {{ event.id }}
      </p>
      <p v-if="event.eventType === 'unknown'">Needs purpose evidence</p>
      <p>Sources: {{ event.evidenceIds.join(', ') }}</p>
      <p v-for="reason in event.reasonCodes" :key="reason">{{ label(reason) }}</p>
      <template v-for="proof in projections(event)" :key="JSON.stringify(proof.scope)">
        <div v-if="proof?.ledgerEffect" class="rounded bg-gray-50 p-2 dark:bg-gray-900">
          <h4 class="font-medium">
            Proposed ledger consequence ·
            {{ proof.scope.kind === 'global' ? 'global' : proof.scope.id }}
          </h4>
          <p>
            Account {{ proof.ledgerEffect.accountId }} ·
            {{ proof.ledgerEffect.date }}
          </p>
          <p>
            <SemanticAmount :amount="proof.ledgerEffect.amount" semantic-class="proposal" />
          </p>
          <p v-for="(split, index) in proof.ledgerEffect.splits" :key="index">
            {{ split.categoryId }}:
            <SemanticAmount :amount="split.amount" semantic-class="proposal" />
          </p>
        </div>
      </template>
    </article>
    <article
      v-for="wallet in result.wallets"
      :key="wallet.walletId"
      class="space-y-1 rounded border p-3"
    >
      <h3 class="font-semibold">Wallet {{ wallet.walletId }}</h3>
      <p v-if="wallet.openingBalance === null">Opening balance unknown</p>
      <p v-else>
        Opening balance:
        <SemanticAmount :amount="wallet.openingBalance" semantic-class="normalizedEvidence" />
      </p>
      <p>
        Closing balance:
        <SemanticAmount :amount="wallet.closingBalance" semantic-class="normalizedEvidence" />
      </p>
      <p>{{ label(wallet.balanceState) }} · {{ label(wallet.projection) }}</p>
      <p v-for="reason in wallet.reasonCodes" :key="reason">{{ label(reason) }}</p>
    </article>
    <article
      v-for="receipt in result.receipts"
      :key="receipt.receiptId"
      class="space-y-1 rounded border p-3"
    >
      <h3 class="font-semibold">
        {{ receipt.receiptId }} ·
        {{ receipt.valid ? 'Receipt totals verified' : 'Receipt totals need review' }}
      </h3>
      <p v-for="reason in receipt.reasonCodes" :key="reason">{{ label(reason) }}</p>
    </article>
    <ul v-if="result.blockers.length" aria-label="Evidence requiring attention" class="space-y-2">
      <li
        v-for="(blocker, index) in result.blockers"
        :key="index"
        class="rounded border border-amber-300 p-2"
      >
        {{ label(blocker.code) }} · {{ blocker.subjectId }} · Sources
        {{ blocker.evidenceIds.join(', ') }}
      </li>
    </ul>
    <details>
      <summary class="cursor-pointer">Resolution provenance</summary>
      <p class="break-all font-mono">{{ result.resolutionHash }}</p>
    </details>
  </section>
</template>
<script setup lang="ts">
import type {
  TransactionEvidenceResult,
  SourceObservation,
} from '@balanceframe/protocol-generated';
import SemanticAmount from './SemanticAmount.vue';
defineProps<{ result: TransactionEvidenceResult }>();
function projections(event: TransactionEvidenceResult['events'][number]): SourceObservation[] {
  return [
    ...(event.projectionObservation ? [event.projectionObservation] : []),
    ...(event.projectionObservations ?? []),
  ];
}
function label(value: string): string {
  return value.replaceAll('_', ' ');
}
</script>
