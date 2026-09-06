<template>
  <section class="space-y-4" aria-label="Current spendability">
    <FreshnessBanner
      :freshness="{
        isStale: expired,
        lastSync: view.evaluatedAt,
        label: expired ? 'Evaluation expired' : 'Evaluated snapshot',
      }"
    />
    <p v-if="expired" role="status">
      This evaluation has expired. Refresh before relying on a route.
    </p>
    <p class="text-xs text-gray-500">
      Evaluated {{ view.evaluatedAt }} · Valid until {{ view.expiresAt }} · Horizon
      {{ view.horizon.startsAt }} to {{ view.horizon.endsAt }}
    </p>
    <InsufficientDataPanel
      v-if="
        view.paymentStatus === 'insufficient_data' || view.fundingStatus === 'insufficient_data'
      "
      reason="Required evidence is incomplete. Missing amounts are unknown, not zero."
    />
    <UCard v-for="purchase in view.purchases" :key="purchase.id">
      <template #header
        ><h2 class="font-semibold">
          {{ categoryName(purchase.categoryId) }} · <SemanticAmount :amount="purchase.amount" /></h2
      ></template>
      <div class="grid gap-4 sm:grid-cols-2">
        <section>
          <h3 class="font-medium">Category funding</h3>
          <p :data-testid="`funding-${purchase.id}`">{{ statusLabel(purchase.fundingStatus) }}</p>
          <p class="text-xs text-gray-500">
            Category funding does not establish payment-account readiness.
          </p>
        </section>
        <section>
          <h3 class="font-medium">Selected payment account</h3>
          <p>
            {{
              purchase.selectedAccountId
                ? accountName(purchase.selectedAccountId)
                : 'No payment account selected'
            }}
          </p>
          <p :data-testid="`payment-${purchase.id}`" class="font-semibold">
            {{ statusLabel(purchase.paymentStatus) }}
          </p>
          <p v-if="purchase.routeOrigin" class="text-xs text-gray-500">
            Route: {{ statusLabel(purchase.routeOrigin) }}
          </p>
        </section>
        <section>
          <h3 class="font-medium">Safe additional spending before</h3>
          <SemanticAmount :amount="purchase.safeCapacityBefore ?? null" />
        </section>
        <section>
          <h3 class="font-medium">Safe capacity after purchase</h3>
          <span :data-testid="`capacity-after-${purchase.id}`"
            ><SemanticAmount :amount="purchase.safeCapacityAfter ?? null"
          /></span>
        </section>
      </div>
      <section v-if="purchase.credit" class="mt-4 border-t pt-3">
        <h3 class="font-medium">Card authorization and due-date payment cash</h3>
        <p>
          Authorization before:
          <SemanticAmount :amount="purchase.credit.authorizationBefore ?? null" /> · After:
          <SemanticAmount :amount="purchase.credit.authorizationAfter ?? null" />
        </p>
        <p>
          Payment account:
          {{
            purchase.credit.paymentAccountName ??
            (purchase.credit.paymentAccountId
              ? accountName(purchase.credit.paymentAccountId)
              : 'Unavailable')
          }}
        </p>
        <p>
          Due {{ purchase.credit.paymentDueAt }} · Payment cash:
          {{ statusLabel(purchase.credit.paymentCashStatus) }}
        </p>
        <p class="text-xs text-gray-500">
          Card credit is not cash backing. Immediate checking capacity is separate from cash needed
          by the card due date.
        </p>
      </section>
      <section v-if="purchase.alternatives.length" class="mt-4">
        <h3 class="font-medium">Alternative payment routes</h3>
        <ul class="space-y-2">
          <li
            v-for="route in purchase.alternatives"
            :key="route.accountId"
            class="flex flex-wrap items-center gap-2"
          >
            <span
              >{{ route.accountName ?? accountName(route.accountId) }} —
              {{ statusLabel(route.status) }}</span
            ><UButton
              v-if="selectable && !expired"
              :data-testid="`route-${route.accountId}`"
              size="xs"
              variant="outline"
              @click="emit('selectRoute', route.accountId, purchase.id)"
              >Use this account</UButton
            >
          </li>
        </ul>
      </section>
      <section v-if="purchase.transfer" class="mt-4 rounded border border-amber-300 p-3">
        <h3 class="font-medium">Exact minimum transfer needed</h3>
        <SemanticAmount :amount="purchase.transfer.minimumAmount" />
        <p>Required by {{ purchase.transfer.requiredBy }}</p>
        <p v-if="purchase.transfer.estimatedArrival">
          Estimated arrival {{ purchase.transfer.estimatedArrival }}
        </p>
        <p v-if="purchase.transfer.authorizedHolderRequired">
          Ask an authorized holder to arrange this transfer. Private source details and action
          permissions are not shared.
        </p>
        <template v-else
          ><p class="text-xs text-gray-500">
            A transfer moves account cash, not category assignments. Previewing does not reserve or
            move funds.
          </p>
          <UButton
            v-if="purchase.canPlanTransfer && !expired"
            :data-testid="`plan-transfer-${purchase.id}`"
            class="mt-2"
            variant="outline"
            @click="emit('planTransfer', purchase.id)"
            >Review exact transfer</UButton
          ></template
        >
      </section>
      <ReasonCodeList v-if="purchase.reasons.length" :codes="purchase.reasons" class="mt-3" />
    </UCard>
    <section v-if="showAccounts" aria-label="Account capacities" class="space-y-3">
      <h2 class="text-lg font-semibold">Current account capacity</h2>
      <p class="text-sm text-gray-500">
        Displayed balance is not safe additional spending. Expected income is projection-only.
      </p>
      <p v-if="!view.accounts.length">No accounts are available with your current permissions.</p>
      <div class="grid gap-3 lg:grid-cols-2">
        <UCard v-for="account in view.accounts" :key="account.id">
          <template #header
            ><h3 class="font-semibold">
              {{ account.name ?? 'Authorized account' }}
              <span class="text-xs font-normal">{{
                account.role ? statusLabel(account.role) : 'Role unknown'
              }}</span>
            </h3></template
          >
          <dl class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt>Recorded balance</dt>
              <dd><SemanticAmount :amount="account.balance ?? null" /></dd>
            </div>
            <div>
              <dt>Safe spending before</dt>
              <dd><SemanticAmount :amount="account.safeSpendingBefore ?? null" /></dd>
            </div>
            <div>
              <dt>Safe spending after</dt>
              <dd><SemanticAmount :amount="account.safeSpendingAfter ?? null" /></dd>
            </div>
            <div>
              <dt>Safe transferable excess</dt>
              <dd><SemanticAmount :amount="account.safeTransfer ?? null" /></dd>
            </div>
            <div>
              <dt>Backing capacity</dt>
              <dd><SemanticAmount :amount="account.backingCapacity ?? null" /></dd>
            </div>
            <div>
              <dt>Signed headroom</dt>
              <dd><SemanticAmount :amount="account.signedHeadroom ?? null" /></dd>
            </div>
          </dl>
          <details class="mt-3">
            <summary class="cursor-pointer font-medium">
              Protected buffers, obligations and evidence
            </summary>
            <ul class="mt-2 space-y-1">
              <li v-for="(deduction, index) in account.deductions ?? []" :key="index">
                {{ statusLabel(deduction.reason) }}: <SemanticAmount :amount="deduction.amount" />
              </li>
            </ul>
            <p v-if="!account.deductions">Deduction detail unavailable.</p>
            <ul class="mt-2 space-y-2 text-xs">
              <li v-for="(quality, index) in account.quality ?? []" :key="index">
                {{ statusLabel(quality.state) }} · {{ statusLabel(quality.source)
                }}<span v-if="quality.observedAt"> · Observed {{ quality.observedAt }}</span
                ><span v-if="quality.expiresAt"> · Expires {{ quality.expiresAt }}</span
                ><ReasonCodeList :codes="quality.reasons" />
              </li>
            </ul>
          </details>
          <ReasonCodeList :codes="account.reasons" class="mt-2" />
        </UCard>
      </div>
    </section>
    <section v-if="showAccounts" aria-label="Category backing" class="space-y-3">
      <h2 class="text-lg font-semibold">Constrained category backing</h2>
      <p class="text-sm text-gray-500">
        A current derived allocation, not permanent dollar provenance. Category reassignment does
        not move bank cash.
      </p>
      <p v-if="!view.categories.length">
        No category backing is available with your current permissions.
      </p>
      <UCard
        v-for="category in view.categories"
        :id="`category-${category.id}`"
        :key="category.id"
        class="scroll-mt-20"
      >
        <template #header
          ><h3 class="font-semibold">{{ category.name ?? 'Authorized category' }}</h3></template
        >
        <p>
          Available before: <SemanticAmount :amount="category.availabilityBefore ?? null" /> ·
          After: <SemanticAmount :amount="category.availabilityAfter ?? null" />
        </p>
        <p>
          {{
            category.feasible === null
              ? 'Backing feasibility unavailable'
              : category.feasible
                ? 'Feasible backing'
                : 'No feasible backing'
          }}
        </p>
        <ul>
          <li v-for="line in category.backing" :key="`${line.accountId}:${line.asOfMonth}`">
            {{ line.accountName ?? accountName(line.accountId) }}:
            <SemanticAmount :amount="line.amount" /> ·
            {{ line.periodKind === 'future' ? 'Future allocation' : 'Current month' }}
            {{ line.asOfMonth }}
          </li>
        </ul>
        <ReasonCodeList :codes="category.reasons" />
      </UCard>
    </section>
    <ReasonCodeList v-if="view.reasons.length" :codes="view.reasons" />
    <details v-if="view.assumptions.length || view.snapshotId || view.policyVersion">
      <summary class="cursor-pointer font-medium">Assumptions and evaluation identity</summary>
      <ul>
        <li v-for="assumption in view.assumptions" :key="assumption">{{ assumption }}</li>
      </ul>
      <EvidenceDrawer
        :references="[]"
        :snapshot-id="view.snapshotId"
        :policy-version="view.policyVersion"
      />
    </details>
  </section>
</template>
<script setup lang="ts">
import type { PublicLiquidityView } from '@balanceframe/application';
const props = withDefaults(
  defineProps<{ view: PublicLiquidityView; showAccounts?: boolean; selectable?: boolean }>(),
  { showAccounts: false, selectable: false },
);
const emit = defineEmits<{
  selectRoute: [accountId: string, purchaseId: string];
  planTransfer: [purchaseId: string];
}>();
const expired = computed(() => Date.parse(props.view.expiresAt) <= Date.now());
function statusLabel(value: string | null) {
  if (!value) return 'Unavailable';
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}
function accountName(id: string) {
  return props.view.accounts.find((account) => account.id === id)?.name ?? 'Authorized account';
}
function categoryName(id: string) {
  return props.view.categories.find((category) => category.id === id)?.name ?? 'Purchase';
}
</script>
