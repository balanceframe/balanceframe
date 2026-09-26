<template>
  <article
    data-testid="purchase-card"
    class="space-y-4 rounded border border-gray-200 p-4 dark:border-gray-700"
    aria-label="Purchase decision card"
  >
    <header class="flex flex-wrap items-baseline justify-between gap-3">
      <h2 class="text-lg font-semibold">Purchase decision</h2>
      <p data-testid="card-outcome" class="font-semibold">{{ outcomeLabel(card.outcome) }}</p>
    </header>

    <div class="grid gap-3 text-sm sm:grid-cols-2">
      <section data-testid="card-budget-status">
        <h3 class="font-medium">Category budget funding</h3>
        <p>{{ fundingStatusLabel(card.budgetFundingStatus) }}</p>
        <p class="text-xs text-gray-500">
          Category funding is separate from payment-account liquidity.
        </p>
      </section>
      <section data-testid="card-payment-status">
        <h3 class="font-medium">Payment-account liquidity</h3>
        <p>{{ paymentStatusLabel(card.paymentLiquidityStatus) }}</p>
        <p class="text-xs text-gray-500">
          Payment readiness describes the selected account and does not change category funding.
        </p>
      </section>
    </div>

    <section
      v-if="showFinancialState && card.selectedAccountId"
      data-testid="card-selected-account"
      class="rounded border border-gray-200 p-3 text-sm dark:border-gray-700"
    >
      <h3 class="font-medium">Selected payment account</h3>
      <p>{{ accountLabel(card.selectedAccountId) }} ({{ card.selectedAccountId }})</p>
    </section>

    <template v-if="showFinancialState">
      <section
        v-for="entry in visibleStates"
        :key="entry.label"
        :data-testid="`card-${entry.label}`"
        class="min-w-0 rounded border p-3"
      >
        <h3 class="font-semibold">{{ entry.label === 'before' ? 'Before purchase' : 'After purchase' }}</h3>
        <div class="mt-2 space-y-3 text-sm">
          <section>
            <h4 class="font-medium">Categories</h4>
            <p v-if="!entry.state.categories.length" class="text-gray-500">No category state available.</p>
            <ul v-else class="space-y-2">
              <li v-for="category in entry.state.categories" :key="category.categoryId">
                <p class="font-medium">
                  {{ categoryLabel(category.categoryId) }} ({{ category.categoryId }})
                </p>
                <p>Availability: {{ formatAmount(category.availability) }}</p>
                <p>Commitments: {{ formatAmount(category.commitments) }}</p>
                <p>Reservations: {{ formatAmount(category.reservations) }}</p>
                <p>Uncommitted availability: {{ formatAmount(category.uncommittedAvailability) }}</p>
                <p>Safe to redirect: {{ formatAmount(category.safeToRedirect) }}</p>
              </li>
            </ul>
          </section>
          <section>
            <h4 class="font-medium">Accounts</h4>
            <p v-if="!entry.state.accounts.length" class="text-gray-500">No account state available.</p>
            <ul v-else class="space-y-2">
              <li v-for="account in entry.state.accounts" :key="account.accountId">
                <p class="font-medium">
                  {{ accountLabel(account.accountId) }} ({{ account.accountId }})
                </p>
                <p>Recorded balance: {{ formatAmount(account.recordedBalance) }}</p>
                <p>Adjusted cash: {{ formatAmount(account.adjustedCash) }}</p>
                <p>Signed headroom: {{ formatAmount(account.signedHeadroom) }}</p>
                <p>Existing shortfall: {{ formatAmount(account.existingShortfall) }}</p>
                <p>Safe spending capacity: {{ formatAmount(account.safeSpendingCapacity) }}</p>
                <p>Safe transfer capacity: {{ formatAmount(account.safeTransferCapacity) }}</p>
                <p>Backing capacity: {{ formatAmount(account.backingCapacity) }}</p>
                <ul v-if="account.deductions.length" class="list-disc pl-5 text-xs">
                  <li v-for="(deduction, index) in account.deductions" :key="index">
                    {{ deduction.reason }}: {{ formatAmount(deduction.amount) }}
                  </li>
                </ul>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <section
        v-if="visibleStates.some((entry) => entry.state.goals.length)"
        data-testid="card-goals"
      >
        <h3 class="font-semibold">Goals</h3>
        <div class="grid gap-3 md:grid-cols-2">
          <section
            v-for="entry in visibleStates"
            :key="`${entry.label}-goals`"
            class="rounded border p-2 text-sm"
          >
            <h4 class="font-medium">{{ entry.label === 'before' ? 'Before' : 'After' }}</h4>
            <p v-if="!entry.state.goals.length" class="text-gray-500">No goals projected.</p>
            <ul v-else class="space-y-2">
              <li v-for="goal in entry.state.goals" :key="goal.categoryId + goal.asOfMonth">
                <p>
                  {{ categoryLabel(goal.categoryId) }} ({{ goal.categoryId }}) · {{ goal.asOfMonth }} ·
                  {{ goal.state }}
                </p>
                <p>
                  Availability: {{ formatAmount(goal.availability) }} · Safe remaining:
                  {{ formatAmount(goal.uncommittedAvailability) }}
                </p>
                <p>
                  Shortfall: {{ formatAmount(goal.shortfall) }} · Required retained:
                  {{ formatAmount(goal.requiredRetained) }}
                </p>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <section
        v-if="visibleStates.some((entry) => entry.state.obligations.length)"
        data-testid="card-obligations"
      >
        <h3 class="font-semibold">Obligations and recurring commitments</h3>
        <div class="grid gap-3 md:grid-cols-2">
          <section
            v-for="entry in visibleStates"
            :key="`${entry.label}-obligations`"
            class="rounded border p-2 text-sm"
          >
            <h4 class="font-medium">{{ entry.label === 'before' ? 'Before' : 'After' }}</h4>
            <p v-if="!entry.state.obligations.length" class="text-gray-500">No obligations projected.</p>
            <ul v-else class="space-y-2">
              <li
                v-for="(obligation, index) in entry.state.obligations"
                :key="`${obligation.scheduleId ?? 'obligation'}-${index}`"
              >
                <p>
                  {{ obligation.classification }} ·
                  {{ obligation.recurring ? 'Recurring' : 'One-time' }}
                </p>
                <p v-if="obligation.dueAt">Due {{ obligation.dueAt }}</p>
                <p v-if="obligation.amount">Amount: {{ formatAmount(obligation.amount) }}</p>
                <p v-else>Amount: Unknown</p>
                <p v-if="obligation.scheduleId">Schedule: {{ obligation.scheduleId }}</p>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <section
        v-if="visibleStates.some((entry) => entry.state.runway)"
        data-testid="card-runway"
        class="rounded border p-3"
      >
        <h3 class="font-semibold">Runway</h3>
        <div class="grid gap-2 text-sm sm:grid-cols-2">
          <p v-for="entry in visibleStates" :key="`${entry.label}-runway`">
            <span class="font-medium">{{ entry.label === 'before' ? 'Before' : 'After' }}:</span>
            <template v-if="entry.state.runway?.state === 'known'">
              {{ formatAmount(entry.state.runway.remainingSafeCash) }}
              <span v-if="entry.state.runway.accountId"> ({{ entry.state.runway.accountId }})</span>
            </template>
            <template v-else>Unknown</template>
          </p>
        </div>
      </section>
    </template>

    <section
      v-if="actionableTransferPaths.length || reallocationPaths.length"
      class="space-y-3"
    >
      <h3 class="font-semibold">Funding paths and alternatives</h3>
      <section
        v-for="(path, index) in card.fundingPaths"
        :key="`${path.kind}-${index}`"
        data-testid="card-funding-path"
        class="rounded border border-amber-300 p-3 dark:border-amber-700"
      >
        <template v-if="path.kind === 'account_transfer'">
          <h4 class="font-medium">Account transfer</h4>
          <ul class="mt-2 space-y-2 text-sm">
            <li v-for="(leg, legIndex) in path.legs" :key="legIndex">
              {{ accountLabel(leg.sourceAccountId) }} ({{ leg.sourceAccountId }}) →
              {{ accountLabel(leg.destinationAccountId) }} ({{ leg.destinationAccountId }})
              <div data-testid="transfer-amount">Amount: {{ formatAmount(leg.amount) }}</div>
              <div data-testid="transfer-timing">
                Required by {{ leg.requiredBy }} · Estimated arrival {{ leg.estimatedArrival }}
              </div>
              <div class="text-xs text-gray-600 dark:text-gray-400">
                Source safe capacity: {{ formatAmount(leg.sourceBefore) }} →
                {{ formatAmount(leg.sourceAfter) }} · Destination safe capacity:
                {{ formatAmount(leg.destinationBefore) }} →
                {{ formatAmount(leg.destinationAfter) }}
              </div>
            </li>
          </ul>
          <p data-testid="transfer-approval" class="mt-2 text-sm">
            Approval required: {{ approvalLabel }}
          </p>
          <p class="mt-2 text-xs text-gray-500">
            Review is read-only. No transfer is initiated or reserved automatically.
          </p>
          <button
            v-if="canPlanTransfer(path)"
            data-testid="plan-transfer"
            type="button"
            class="mt-2 rounded border px-3 py-1 text-sm"
            @click="emit('plan-transfer', transferItemId(path))"
          >
            Review exact transfer
          </button>
        </template>

        <template v-else>
          <h4 class="font-medium">Category reallocation</h4>
          <p class="text-sm">
            {{ categoryLabel(path.sourceCategoryId) }} ({{ path.sourceCategoryId }}) →
            {{ categoryLabel(path.destinationCategoryId) }} ({{ path.destinationCategoryId }}) ·
            {{ formatAmount(path.amount) }}
          </p>
          <p class="text-sm">Approval required: {{ path.approvalRequired ? 'Yes' : 'No' }}</p>
          <div class="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              Before: {{ formatAmount(path.before.sourceAvailability) }} source /
              {{ formatAmount(path.before.destinationAvailability) }} destination
            </p>
            <p>
              After: {{ formatAmount(path.after.sourceAvailability) }} source /
              {{ formatAmount(path.after.destinationAvailability) }} destination
            </p>
          </div>
          <ul v-if="path.tradeoffs.length" class="mt-2 list-disc pl-5 text-sm">
            <li v-for="tradeoff in path.tradeoffs" :key="tradeoff">{{ tradeoff }}</li>
          </ul>
        </template>
      </section>
    </section>

    <section v-if="card.opportunityCosts?.length" class="rounded border p-3">
      <h3 class="font-semibold">Opportunity costs</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="(cost, index) in card.opportunityCosts" :key="`${cost.sourceCategoryId}-${index}`">
          Redirect {{ formatAmount(cost.amount) }} from {{ categoryLabel(cost.sourceCategoryId) }} to
          {{ categoryLabel(cost.destinationCategoryId) }}; safe-to-redirect changes from
          {{ formatAmount(cost.beforeSafeToRedirect) }} to {{ formatAmount(cost.afterSafeToRedirect) }}.
          <span class="text-xs">{{ cost.tradeoff }}</span>
        </li>
      </ul>
    </section>

    <section v-if="card.conflicts?.length" class="rounded border border-amber-300 p-3">
      <h3 class="font-semibold">Conflicts</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="(conflict, index) in card.conflicts" :key="`${conflict.itemId}-${index}`">
          {{ conflict.reason }} for {{ accountLabel(conflict.accountId) }};
          payment status {{ paymentStatusLabel(conflict.paymentLiquidityStatus) }}.
        </li>
      </ul>
    </section>

    <section v-if="card.cart && showFinancialState" class="rounded border p-3">
      <h3 class="font-semibold">Cart</h3>
      <dl class="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt>Subtotal</dt><dd>{{ formatAmount(card.cart.subtotal) }}</dd></div>
        <div><dt>Tax</dt><dd>{{ formatAmount(card.cart.tax) }}</dd></div>
        <div><dt>Fee</dt><dd>{{ formatAmount(card.cart.fee) }}</dd></div>
        <div><dt>Discount</dt><dd>{{ formatAmount(card.cart.discount) }}</dd></div>
        <div><dt>Total</dt><dd>{{ formatAmount(card.cart.total) }}</dd></div>
      </dl>
    </section>

    <section
      v-if="card.warnings?.length && showFinancialState"
      class="rounded border border-amber-300 p-3"
    >
      <h3 class="font-semibold">Cart warnings</h3>
      <ul class="space-y-2 text-sm">
        <li v-for="(warning, index) in card.warnings" :key="`${warning.thresholdId}-${index}`">
          Threshold {{ formatAmount(warning.threshold) }} exceeded by
          {{ formatAmount(warning.excess) }} (actual {{ formatAmount(warning.actual) }}).
          <ul v-if="warning.alternatives.length" class="list-disc pl-5">
            <li v-for="alternative in warning.alternatives" :key="alternative.removedItemIds.join(',')">
              Optional-first trim: {{ formatAmount(alternative.total) }} ·
              {{ outcomeLabel(alternative.outcome) }}
            </li>
          </ul>
        </li>
      </ul>
    </section>

    <section v-if="card.trimAlternatives?.length && showFinancialState" class="rounded border p-3">
      <h3 class="font-semibold">Optional-first trim alternatives</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="alternative in card.trimAlternatives" :key="alternative.removedItemIds.join(',')">
          Remove {{ alternative.removedItemIds.join(', ') }} →
          {{ formatAmount(alternative.total) }} · {{ outcomeLabel(alternative.outcome) }}
        </li>
      </ul>
    </section>

    <details v-if="card.evidence?.length" data-testid="card-evidence" class="rounded border p-3">
      <summary class="cursor-pointer font-semibold">Evidence and freshness ({{ card.evidence.length }})</summary>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="(reference, index) in card.evidence" :key="`${reference.kind}-${index}`">
          {{ reference.kind }} · {{ reference.authorized ? 'Authorized' : 'Restricted' }} ·
          {{ reference.redaction === 'visible' ? 'Visible' : 'Redacted' }}
        </li>
      </ul>
      <p class="mt-2 text-xs text-gray-500">
        Evidence references are disclosed without private source identifiers or integrity hashes.
      </p>
    </details>

    <section v-if="card.blockers?.length" data-testid="card-blockers" class="rounded border p-3">
      <h3 class="font-semibold">Blockers</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="blocker in card.blockers" :key="blocker">{{ blocker }}</li>
      </ul>
    </section>

    <section v-if="card.reasons?.length" class="rounded border p-3">
      <h3 class="font-semibold">Decision reasons</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="reason in card.reasons" :key="reason">{{ reason }}</li>
      </ul>
    </section>

    <section v-if="card.assumptions?.length" data-testid="card-assumptions" class="rounded border p-3">
      <h3 class="font-semibold">Assumptions</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        <li v-for="assumption in card.assumptions" :key="assumption">{{ assumption }}</li>
      </ul>
    </section>

    <section
      v-if="card.expiresAt || card.earliestExpiry"
      data-testid="card-expiry"
      class="rounded border p-3 text-sm"
    >
      <h3 class="font-semibold">Expiry</h3>
      <p v-if="card.expiresAt">Valid until {{ card.expiresAt }}</p>
      <p v-if="card.earliestExpiry">Earliest expiry {{ card.earliestExpiry }}</p>
    </section>
  </article>
</template>

<script setup lang="ts">
import type { PublicDecisionCard, PublicLiquidityView } from '@balanceframe/application';

defineOptions({ name: 'DecisionCardView' });

const props = defineProps<{ card: PublicDecisionCard; catalog?: PublicLiquidityView }>();
const emit = defineEmits<{ 'plan-transfer': [purchaseItemId: string] }>();

const showFinancialState = computed(
  () =>
    props.card.outcome !== 'insufficient_data' &&
    props.card.readiness?.status !== 'blocked' &&
    props.card.blockers.length === 0 &&
    props.card.before !== null &&
    props.card.after !== null,
);

const visibleStates = computed(() => {
  if (!showFinancialState.value || !props.card.before || !props.card.after) return [];
  return [
    { label: 'before' as const, state: props.card.before },
    { label: 'after' as const, state: props.card.after },
  ];
});

const actionableTransferPaths = computed(() =>
  props.card.fundingPaths.filter((path) => canPlanTransfer(path)),
);
const reallocationPaths = computed(() =>
  props.card.fundingPaths.filter((path) => path.kind === 'category_reallocation'),
);

const approvalLabel = computed(() =>
  props.card.authorizationRequirements?.length
    ? props.card.authorizationRequirements.join(', ')
    : 'Required by the transfer workflow',
);

function canPlanTransfer(path: PublicDecisionCard['fundingPaths'][number]): boolean {
  return (
    path.kind === 'account_transfer' &&
    showFinancialState.value &&
    props.card.outcome === 'safe_after_date' &&
    props.card.paymentLiquidityStatus === 'transfer_required' &&
    props.card.blockers.length === 0 &&
    path.legs.length > 0
  );
}

function transferItemId(path: PublicDecisionCard['fundingPaths'][number]): string {
  if (path.kind !== 'account_transfer') return '';
  const itemId = path.itemIds[0] ?? '';
  return itemId.split('::category-')[0] ?? itemId;
}

function outcomeLabel(value: string): string {
  const labels: Record<string, string> = {
    funded_now: 'Funded now',
    safe_after_date: 'Safe after date',
    safe_with_reallocation: 'Safe with reallocation',
    cash_available_but_unfunded: 'Cash available but unfunded',
    not_safe: 'Not safe',
    plan_breaking: 'Plan breaking',
    insufficient_data: 'Insufficient data',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

function fundingStatusLabel(value: string): string {
  if (value === 'funded') return 'Funded';
  if (value === 'unfunded') return 'Unfunded';
  return 'Insufficient data';
}

function paymentStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    ready: 'Ready',
    use_other_account: 'Use another account',
    transfer_required: 'Transfer required',
    transfer_too_late: 'Transfer too late',
    not_liquid: 'Not liquid',
    insufficient_data: 'Insufficient data',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

function formatAmount(amount: { minorUnits: string; currency: string } | null | undefined): string {
  if (!amount) return 'Unknown';
  const raw = String(amount.minorUnits);
  const negative = raw.startsWith('-') && raw !== '-0';
  const absolute = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, '') || '0';
  const padded = absolute.padStart(3, '0');
  const whole = padded.slice(0, -2) || '0';
  const cents = absolute.slice(-2).padStart(2, '0');
  return `${negative ? '−' : ''}${whole}.${cents} ${amount.currency}`;
}

function accountLabel(id: string): string {
  return props.catalog?.accounts.find((account) => account.id === id)?.name ?? 'Authorized account';
}

function categoryLabel(id: string): string {
  return props.catalog?.categories.find((category) => category.id === id)?.name ?? 'Authorized category';
}
</script>
