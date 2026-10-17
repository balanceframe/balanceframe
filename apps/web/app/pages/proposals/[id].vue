<template>
  <AnalysisPage title="Consequential-action proposal" :loading="loading" :error="error">
    <template #error-actions>
      <button type="button" class="underline" :disabled="busy" @click="load">Refresh proposal</button>
    </template>
    <template #content>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" class="text-sm underline" :disabled="busy || loading" @click="load">
          Refresh current proposal
        </button>
      </div>
      <p v-if="stale" role="status" class="mb-4 rounded border border-amber-300 p-3 text-sm">
        This proposal no longer matches current versions or scope. Refresh to review current state; do not repeat an uncertain write.
      </p>
      <article v-if="proposal" class="space-y-5 rounded border p-4">
        <header>
          <h2 class="text-lg font-semibold">{{ phaseLabel }}</h2>
          <p>Proposal {{ proposal.id }} · {{ proposal.operation }}</p>
          <p class="text-sm">Selected space / budget: {{ proposal.spaceId }} / {{ proposal.budgetId }}</p>
        </header>

        <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt class="font-medium">Requester</dt><dd class="break-all">{{ proposal.requesterActorId ?? 'Unavailable' }}</dd></div>
          <div><dt class="font-medium">Requester membership current</dt><dd>{{ proposal.requesterMembershipCurrent ? 'Yes' : 'No' }}</dd></div>
          <div><dt class="font-medium">Captured governance version</dt><dd>{{ proposal.governancePolicyVersion ?? 'Unavailable' }}</dd></div>
          <div><dt class="font-medium">Current governance version</dt><dd>{{ proposal.currentGovernancePolicyVersion ?? 'Unavailable' }}</dd></div>
          <div><dt class="font-medium">Captured financial-policy version</dt><dd>{{ proposal.financialPolicyVersion ?? 'Unavailable' }}</dd></div>
          <div><dt class="font-medium">Captured source-policy version</dt><dd>{{ plan?.source.policyVersion ?? 'Unavailable' }}</dd></div>
          <div><dt class="font-medium">Current financial-policy version</dt><dd>{{ proposal.currentFinancialPolicyVersion ?? 'Unavailable' }}</dd></div>
          <div><dt class="font-medium">Assistance maximum</dt><dd>{{ proposal.currentAssistanceMaximum ?? 'Unavailable' }}</dd></div>
          <div data-testid="proposal-quorum"><dt class="font-medium">Required distinct human approvers</dt><dd>{{ proposal.requiredApprovers ?? 'Unavailable' }} · recorded {{ proposal.approvers?.length ?? 0 }}</dd></div>
          <div><dt class="font-medium">Proposal expires</dt><dd>{{ proposal.expiresAt }}</dd></div>
          <div class="sm:col-span-2"><dt class="font-medium">Payload hash</dt><dd class="break-all font-mono">{{ proposal.payloadHash }}</dd></div>
          <div v-if="plan" class="sm:col-span-2"><dt class="font-medium">Source snapshot reference</dt><dd class="break-all font-mono">{{ plan.source.snapshotReference }}</dd></div>
          <div v-if="plan" class="sm:col-span-2"><dt class="font-medium">Action plan expires</dt><dd>{{ plan.expiresAt }}</dd></div>
        </dl>

        <section>
          <h3 class="font-semibold">Current eligible human approvals</h3>
          <ul v-if="proposal.approvers?.length" class="mt-1 list-disc pl-5 text-sm">
            <li v-for="(approver, index) in proposal.approvers" :key="`${approver.actorId}:${approver.issuedAt}:${index}`">
              {{ approver.actorId }} · {{ approver.issuedAt }} · expires {{ approver.expiresAt }}
            </li>
          </ul>
          <p v-else class="mt-1 text-sm">No current eligible approvals.</p>
        </section>

        <section
          v-if="decisionContext?.items.length || decisionContext?.adjustments?.length || decisionContext?.warningThresholds?.length"
          class="space-y-2 rounded border p-3"
        >
          <h3 class="font-semibold">Pinned decision context</h3>
          <p>Decision horizon: {{ decisionContext.horizon.startsAt }} – {{ decisionContext.horizon.endsAt }}</p>
          <p>Decision valid until: {{ decisionContext.validUntil }}</p>
          <ul v-if="decisionContext.items.length" class="list-disc space-y-1 pl-5 text-sm">
            <li v-for="(item, index) in decisionContext.items" :key="`${item.id ?? item.categoryId}:${index}`">
              <span v-if="item.id">Item {{ item.id }} · </span>
              Category {{ item.categoryId }} · <SemanticAmount :amount="item.amount" />
              <span v-if="item.accountId"> · account {{ item.accountId }}</span>
              <span v-if="item.priority"> · {{ item.priority }}</span>
              <span v-if="item.quantity"> · quantity {{ item.quantity }}</span>
              <span v-if="item.purchaseAt"> · purchase {{ item.purchaseAt }}</span>
              <span v-if="item.requiredBy"> · required by {{ item.requiredBy }}</span>
              <ul v-if="item.categoryAllocations?.length" class="list-disc pl-5">
                <li v-for="(allocation, allocationIndex) in item.categoryAllocations" :key="allocationIndex">
                  Category split {{ allocation.categoryId }} · <SemanticAmount :amount="allocation.amount" />
                </li>
              </ul>
            </li>
          </ul>
          <ul v-if="decisionContext.adjustments?.length" class="list-disc pl-5 text-sm">
            <li v-for="(adjustment, index) in decisionContext.adjustments" :key="index">
              {{ adjustment.kind }} · {{ adjustment.categoryId }} · <SemanticAmount :amount="adjustment.amount" />
            </li>
          </ul>
          <ul v-if="decisionContext.warningThresholds?.length" class="list-disc pl-5 text-sm">
            <li v-for="(threshold, index) in decisionContext.warningThresholds" :key="index">
              {{ threshold.id }} · {{ threshold.basis }}<span v-if="threshold.basis === 'category_charge'"> · {{ threshold.categoryId }}</span>
              · maximum <SemanticAmount :amount="threshold.maximum" />
            </li>
          </ul>
        </section>

        <section v-if="plan" class="space-y-4">
          <h3 class="font-semibold">Exact proposed effects</h3>
          <ol class="space-y-3">
            <li v-for="(action, index) in actionAtoms" :key="`${action.kind}:${index}`" class="rounded border p-3">
              <h4 class="font-medium">Effect {{ index + 1 }} · {{ action.kind.replaceAll('_', ' ') }}</h4>
              <template v-if="action.kind === 'reallocation'">
                <dl v-for="(assignment, assignmentIndex) in action.assignments" :key="assignmentIndex" class="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  <div><dt class="inline font-medium">Source: </dt><dd class="inline">{{ assignment.sourceCategoryId }} · {{ assignment.sourceAsOfMonth }}</dd></div>
                  <div><dt class="inline font-medium">Destination: </dt><dd class="inline">{{ assignment.destinationCategoryId }} · {{ assignment.destinationAsOfMonth }}</dd></div>
                  <div><dt class="inline font-medium">Exact amount: </dt><dd class="inline"><SemanticAmount :amount="assignment.amount" /></dd></div>
                </dl>
              </template>
              <template v-else-if="action.kind === 'manual_transaction' || action.kind === 'evidence_projection'">
                <dl class="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  <div><dt class="inline font-medium">Parent transaction: </dt><dd class="inline break-all">{{ action.transaction.parentId }}</dd></div>
                  <div><dt class="inline font-medium">Account: </dt><dd class="inline break-all">{{ action.transaction.accountId }}</dd></div>
                  <div><dt class="inline font-medium">Date: </dt><dd class="inline">{{ action.transaction.date }}</dd></div>
                  <div><dt class="inline font-medium">Exact parent amount: </dt><dd class="inline"><SemanticAmount :amount="action.transaction.amount" /></dd></div>
                  <div><dt class="inline font-medium">Category: </dt><dd class="inline">{{ action.transaction.categoryId ?? 'Uncategorized' }}</dd></div>
                  <div><dt class="inline font-medium">Payee: </dt><dd class="inline">{{ action.transaction.payeeName ?? 'Not provided' }}</dd></div>
                  <div v-if="action.transaction.notes" class="sm:col-span-2"><dt class="inline font-medium">Notes: </dt><dd class="inline">{{ action.transaction.notes }}</dd></div>
                </dl>
                <section v-if="action.transaction.splits.length" class="mt-3">
                  <h5 class="text-sm font-medium">Every exact split child</h5>
                  <ul class="list-disc pl-5 text-sm">
                    <li v-for="(split, splitIndex) in action.transaction.splits" :key="splitIndex">
                      {{ split.categoryId }} · <SemanticAmount :amount="split.amount" />
                    </li>
                  </ul>
                </section>
                <p v-if="action.kind === 'evidence_projection'" class="mt-2 text-sm">
                  Resolved evidence IDs: {{ action.evidenceIds.join(', ') }}
                </p>
              </template>
              <template v-else-if="action.kind === 'wallet_materialization'">
                <p class="mt-2 text-sm">Wallet {{ action.walletId }} → account {{ action.accountName }} · {{ action.currency }} · zero opening balance.</p>
              </template>
              <template v-else>
                <dl class="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  <div><dt class="inline font-medium">Transfer ID: </dt><dd class="inline break-all">{{ action.transferId }}</dd></div>
                  <div><dt class="inline font-medium">Correlation ID: </dt><dd class="inline break-all">{{ action.correlationId }}</dd></div>
                  <div><dt class="inline font-medium">Source account: </dt><dd class="inline break-all">{{ action.sourceAccountId }}</dd></div>
                  <div><dt class="inline font-medium">Destination account: </dt><dd class="inline break-all">{{ action.destinationAccountId }}</dd></div>
                  <div><dt class="inline font-medium">Exact amount: </dt><dd class="inline"><SemanticAmount :amount="action.amount" /></dd></div>
                  <div><dt class="inline font-medium">Ledger date: </dt><dd class="inline">{{ action.date }}</dd></div>
                </dl>
                <p class="mt-2 text-sm">This creates a ledger entry only; it does not initiate or confirm institution settlement.</p>
              </template>
            </li>
          </ol>
        </section>
        <section v-if="plan?.evidenceReferences.length" class="rounded border p-3">
          <h3 class="font-semibold">Scoped evidence references</h3>
          <ul class="list-disc pl-5 text-sm">
            <li v-for="evidence in plan.evidenceReferences" :key="evidence.evidenceId">
              {{ evidence.evidenceId }} · subject {{ evidence.subjectId }} · {{ evidence.state }}
            </li>
          </ul>
        </section>

        <section v-if="plan?.impacts.length" class="space-y-3">
          <h3 class="font-semibold">Native reasons and typed financial impact</h3>
          <p>Native reason codes: {{ plan.reasonCodes.join(', ') || 'None' }}</p>
          <section v-for="(impact, index) in plan.impacts" :key="`${impact.kind}:${index}`" class="rounded border p-3">
            <template v-if="impact.kind === 'category_reallocation'">
              <p>Impact type: {{ impact.kind }}</p>
              <h4 class="font-medium" data-testid="action-category-envelope">Category envelope · {{ impact.sourceCategoryId }} ({{ impact.sourceAsOfMonth }}) → {{ impact.destinationCategoryId }} ({{ impact.destinationAsOfMonth }}) · <SemanticAmount :amount="impact.amount" /></h4>
              <dl class="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                <div><dt class="inline font-medium">Source protected: </dt><dd class="inline">{{ impact.sourceProtected ? 'Yes' : 'No' }}</dd></div>
                <div><dt class="inline font-medium">Source availability before: </dt><dd class="inline"><SemanticAmount :amount="impact.sourceAvailabilityBefore" /></dd></div>
                <div><dt class="inline font-medium">Uncommitted source availability before: </dt><dd class="inline"><SemanticAmount :amount="impact.sourceUncommittedAvailabilityBefore" /></dd></div>
                <div data-testid="action-remainder">
                  <dt class="font-medium">Source availability after / minimum retained / projected remaining need / safe to redirect after</dt>
                  <dd><SemanticAmount :amount="impact.sourceAvailabilityAfter" /> / <SemanticAmount :amount="impact.minimumRetained" /> / <SemanticAmount :amount="impact.projectedRemainingNeed" /> / <SemanticAmount :amount="impact.safeToRedirectAfter" /></dd>
                </div>
              </dl>
              <p class="mt-2 text-sm">Native rationale: {{ impact.rationale }}</p>
            </template>
            <template v-else-if="impact.kind === 'account_readiness' || impact.kind === 'payment_route'">
              <p>{{ impact.kind.replaceAll('_', ' ') }} · account {{ impact.accountId }} · {{ impact.state }}</p>
            </template>
            <template v-else-if="impact.kind === 'transfer_need'">
              <p>Transfer need · account {{ impact.accountId }} · <SemanticAmount :amount="impact.amount" /></p>
            </template>
            <template v-else-if="impact.kind === 'reservation_commitment'">
              <p>Target / bill {{ impact.categoryId }} · commitments <SemanticAmount :amount="impact.commitments" /> · reservations <SemanticAmount :amount="impact.reservations" /></p>
            </template>
            <template v-else>
              <p>Evidence {{ impact.evidenceId }} · {{ impact.state }}</p>
            </template>
          </section>
        </section>

        <section v-if="accountCashPostconditions.length" data-testid="action-account-cash" class="rounded border p-3">
          <h3 class="font-semibold">Account cash postconditions</h3>
          <ul class="list-disc pl-5 text-sm">
            <li v-for="(condition, index) in accountCashPostconditions" :key="index">
              {{ condition.accountId }} · <SemanticAmount :amount="condition.balance" />
            </li>
          </ul>
        </section>

        <section v-if="plan?.expectedPostconditions.length" class="rounded border p-3">
          <h3 class="font-semibold">Exact expected postconditions</h3>
          <ul class="list-disc pl-5 text-sm">
            <li v-for="(condition, index) in plan.expectedPostconditions" :key="index">
              <template v-if="condition.kind === 'assignment'">Assignment {{ condition.categoryId }} · {{ condition.asOfMonth }} · <SemanticAmount :amount="condition.amount" /></template>
              <template v-else-if="condition.kind === 'account_balance'">Account {{ condition.accountId }} · <SemanticAmount :amount="condition.balance" /></template>
              <template v-else-if="condition.kind === 'transaction'">Transaction {{ condition.parentId }} · account {{ condition.accountId }} · <SemanticAmount :amount="condition.amount" /> · {{ condition.date }} · {{ condition.splits.length }} disclosed split(s)</template>
              <template v-else-if="condition.kind === 'wallet_mapping'">Wallet {{ condition.walletId }} → {{ condition.accountName }} · on-budget · open · zero opening balance</template>
              <template v-else>Transfer ledger entry {{ condition.transferId }} · {{ condition.sourceAccountId }} → {{ condition.destinationAccountId }} · <SemanticAmount :amount="condition.amount" /> · {{ condition.date }}</template>
            </li>
          </ul>
        </section>

        <section v-if="state" class="rounded border p-3">
          <h3 class="font-semibold">Execution result</h3>
          <p>Phase: {{ state.phase }} · outcome: {{ state.outcome ?? 'not executed' }}</p>
          <p v-if="requiresReadOnlyRefresh" role="status">The write is uncertain or needs review. Refresh is read-only; do not repeat the financial action.</p>
          <template v-if="requiresReadOnlyRefresh">
            <p>Check prior execution reads Actual without repeating the action. Only the original executor can reconcile after the proposal expires. Unproven outcomes remain held for review.</p>
            <button data-testid="proposal-reconcile" type="button" class="mt-2 rounded border px-3 py-2 disabled:opacity-50" :disabled="busy || loading" @click="reconcile">
              {{ busy ? 'Checking…' : 'Check prior execution' }}
            </button>
          </template>
        </section>

        <section class="space-y-3 border-t pt-4">
          <p>Approval and execution are separate explicit actions. Current permissions: approve {{ canApprove ? 'allowed' : 'not allowed' }} · execute {{ canExecute ? 'allowed' : 'not allowed' }}.</p>
          <label class="grid max-w-sm gap-1 text-sm">
            <span>Fresh human confirmation</span>
            <input v-model="password" type="password" autocomplete="current-password" class="rounded border bg-transparent p-2" />
          </label>
          <div class="flex flex-wrap gap-3">
            <button data-testid="proposal-approve" type="button" class="rounded border px-3 py-2 disabled:opacity-50" :disabled="!canApprove || busy || !password" @click="mutate('approve')">
              {{ busy && pendingAction === 'approve' ? 'Approving…' : 'Approve displayed proposal' }}
            </button>
            <button data-testid="proposal-execute" type="button" class="rounded border px-3 py-2 disabled:opacity-50" :disabled="!canExecute || busy || !password" @click="mutate('execute')">
              {{ busy && pendingAction === 'execute' ? 'Executing…' : 'Execute approved proposal' }}
            </button>
          </div>
        </section>
      </article>
      <p v-else-if="!loading" role="status">The proposal or its scoped action projection is unavailable. Refresh to load the current authorized view.</p>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { z } from 'zod/v3';
import { consequentialActionIntentSchema, consequentialActionPlanSchema } from '@balanceframe/protocol-generated/validators';
import type { ConsequentialActionPublicPlan, ConsequentialActionProposal } from '@balanceframe/application';
import type { ConsequentialActionIntent, ConsequentialActionPlan } from '@balanceframe/protocol-generated';
import SemanticAmount from '../../components/SemanticAmount.vue';
import { reauthenticateHuman } from '../../utils/reauthentication';
import { liquidityError, liquidityRequest } from '../../utils/liquidity-client';

const AssistanceMaximum = z.enum([
  'analysis_only',
  'recommend_actions',
  'create_approval_proposal',
  'execute_approved_actions',
]);
const planViewSchema = z.object({
  version: z.literal('1'),
  action: z.custom<ConsequentialActionIntent>((value) => consequentialActionIntentSchema.safeParse(value).success),
  expiresAt: z.string(),
  reasonCodes: z.custom<ConsequentialActionPlan['reasonCodes']>((value) => consequentialActionPlanSchema.shape.reasonCodes.safeParse(value).success),
  impacts: z.custom<ConsequentialActionPlan['impacts']>((value) => consequentialActionPlanSchema.shape.impacts.safeParse(value).success),
  expectedPostconditions: z.custom<ConsequentialActionPlan['expectedPostconditions']>((value) => consequentialActionPlanSchema.shape.expectedPostconditions.safeParse(value).success),
  evidenceReferences: z.array(z.object({
    evidenceId: z.string(),
    subjectId: z.string(),
    state: z.enum(['resolved', 'stale', 'missing']),
  }).strip()),
  source: z.object({
    snapshotReference: z.string(),
    policyVersion: z.string(),
    financialPolicyVersion: z.string(),
    claimSetRevision: z.string(),
  }).strip(),
}).strip();
const moneySchema = z.object({ minorUnits: z.string(), currency: z.string() }).strict();
const decisionContextSchema = z.object({
  horizon: z.object({ startsAt: z.string(), endsAt: z.string() }).strip(),
  validUntil: z.string(),
  items: z.array(z.object({
    id: z.string().optional(),
    categoryId: z.string(),
    accountId: z.string().nullable(),
    amount: moneySchema,
    purchaseAt: z.string().optional(),
    requiredBy: z.string().optional(),
    priority: z.string().optional(),
    quantity: z.number().int().positive().optional(),
    categoryAllocations: z.array(z.object({ categoryId: z.string(), amount: moneySchema }).strip()).optional(),
  }).strip()),
  adjustments: z.array(z.object({
    kind: z.enum(['tax', 'fee', 'discount']),
    categoryId: z.string(),
    amount: moneySchema,
  }).strip()).optional(),
  warningThresholds: z.array(z.discriminatedUnion('basis', [
    z.object({ id: z.string(), basis: z.literal('cart_total'), maximum: moneySchema }).strip(),
    z.object({ id: z.string(), basis: z.literal('category_charge'), categoryId: z.string(), maximum: moneySchema }).strip(),
  ])).optional(),
}).strip();
const approverSchema = z.object({
  actorId: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
}).strip();
const proposalViewSchema = z.object({
  id: z.string(),
  operation: z.literal('consequential_action'),
  spaceId: z.string(),
  budgetId: z.string(),
  requesterActorId: z.string(),
  requesterMembershipCurrent: z.boolean(),
  governancePolicyVersion: z.string().nullable(),
  currentGovernancePolicyVersion: z.string(),
  currentFinancialPolicyVersion: z.string().nullable(),
  financialPolicyVersion: z.string(),
  policyVersion: z.string(),
  payloadHash: z.string(),
  payload: z.object({
    kind: z.literal('consequential_action'),
    plan: planViewSchema,
  }).strip(),
  decisionContext: decisionContextSchema.nullable(),
  expiresAt: z.string(),
  requiredApprovers: z.number().int().nonnegative(),
  approvers: z.array(approverSchema),
  disposition: z.string(),
  canApprove: z.boolean(),
  canExecute: z.boolean(),
  currentAssistanceMaximum: AssistanceMaximum,
  state: z.object({
    phase: z.enum(['proposed', 'approved', 'write_intent', 'verified', 'review_required', 'invalidated_no_dispatch']),
    outcome: z.string().nullable(),
  }).strip(),
}).strip();
const detailSchema = z.object({
  proposal: proposalViewSchema,
  stale: z.boolean().optional(),
}).strip();
type Detail = z.infer<typeof detailSchema>;
type PlanView = ConsequentialActionPublicPlan;
type ActionState = ConsequentialActionProposal['state'];
type CashPostcondition = Extract<ConsequentialActionPlan['expectedPostconditions'][number], { kind: 'account_balance' }>;

definePageMeta({ layout: 'default' });
const route = useRoute();
const detail = ref<Detail | null>(null);
const loading = ref(true);
const serverStale = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const password = ref('');
const busy = ref(false);
const pendingAction = ref<'approve' | 'execute' | null>(null);
const dispatchUncertain = ref(false);
const proposal = computed(() => detail.value?.proposal ?? null);
const plan = computed<PlanView | null>(() => proposal.value?.payload?.plan ?? null);
const capturedPolicyVersionsCurrent = computed(() =>
  Boolean(
    proposal.value?.governancePolicyVersion &&
    proposal.value.currentGovernancePolicyVersion &&
    proposal.value.governancePolicyVersion === proposal.value.currentGovernancePolicyVersion &&
    proposal.value.financialPolicyVersion &&
    proposal.value.currentFinancialPolicyVersion &&
    proposal.value.financialPolicyVersion === proposal.value.currentFinancialPolicyVersion,
  ),
);
const stale = computed(() =>
  serverStale.value || !capturedPolicyVersionsCurrent.value || proposal.value?.requesterMembershipCurrent !== true,
);
const state = computed<ActionState | null>(() => proposal.value?.state ?? null);
const decisionContext = computed(() => proposal.value?.decisionContext ?? null);
const actionAtoms = computed(() => {
  const action = plan.value?.action;
  if (!action) return [];
  return action.kind === 'composite' ? action.actions : [action];
});
const accountCashPostconditions = computed(() =>
  (plan.value?.expectedPostconditions ?? []).filter(
    (condition): condition is CashPostcondition => condition.kind === 'account_balance',
  ),
);
const phaseLabel = computed(() => {
  if (dispatchUncertain.value) return 'Execution state uncertain — refresh only';
  if (state.value?.phase === 'review_required' || state.value?.outcome === 'review_required') return 'Review required';
  if (state.value?.phase === 'write_intent') return 'Execution state uncertain — refresh only';
  if (state.value?.phase === 'invalidated_no_dispatch') return 'Action invalidated — not dispatched';
  if (state.value?.outcome === 'verified' || state.value?.phase === 'verified') return 'Execution result';
  if (state.value?.phase === 'approved') return 'Approved — not executed';
  if (state.value?.phase === 'proposed') return 'Proposed';
  return 'Proposal status unavailable';
});
const requiresReadOnlyRefresh = computed(() =>
  dispatchUncertain.value ||
  state.value?.phase === 'write_intent' ||
  state.value?.phase === 'review_required' ||
  state.value?.outcome === 'review_required',
);
const canApprove = computed(() =>
  !dispatchUncertain.value &&
  !!proposal.value?.payload &&
  proposal.value.canApprove === true &&
  proposal.value.currentAssistanceMaximum !== undefined &&
  ['create_approval_proposal', 'execute_approved_actions'].includes(proposal.value.currentAssistanceMaximum) &&
  state.value?.phase === 'proposed' &&
  !stale.value,
);
const canExecute = computed(() =>
  !dispatchUncertain.value &&
  !!proposal.value?.payload &&
  proposal.value.canExecute === true &&
  proposal.value.currentAssistanceMaximum === 'execute_approved_actions' &&
  state.value?.phase === 'approved' &&
  !stale.value,
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const result = await liquidityRequest<unknown>(
      `/api/proposal/${encodeURIComponent(String(route.params.id ?? ''))}`,
    );
    const parsed = detailSchema.safeParse(result);
    if (!parsed.success) {
      detail.value = null;
      error.value = { code: 'PROPOSAL_VIEW_UNAVAILABLE', message: 'The current proposal view is unavailable in this selected space.' };
    } else {
      detail.value = parsed.data;
      dispatchUncertain.value = false;
      serverStale.value = parsed.data.stale ?? false;
    }
  } catch (cause) {
    detail.value = null;
    error.value = { code: 'PROPOSAL_READ_FAILED', message: liquidityError(cause) };
  } finally {
    loading.value = false;
  }
}

async function reconcile() {
  const current = proposal.value;
  if (!current || !requiresReadOnlyRefresh.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await liquidityRequest<unknown>(`/api/proposal/${encodeURIComponent(current.id)}/reconcile`, 'POST');
    await load();
  } catch (cause) {
    error.value = { code: 'PROPOSAL_RECONCILIATION_FAILED', message: liquidityError(cause) };
  } finally {
    busy.value = false;
  }
}

async function mutate(action: 'approve' | 'execute') {
  const current = proposal.value;
  const payloadHash = current?.payloadHash;
  const passwordSnapshot = password.value;
  if (!current || !payloadHash || !passwordSnapshot || busy.value) return;
  if (action === 'approve' ? !canApprove.value : !canExecute.value) return;
  password.value = '';
  busy.value = true;
  pendingAction.value = action;
  error.value = null;
  try {
    await reauthenticateHuman(passwordSnapshot);
    try {
      await liquidityRequest<unknown>(
        `/api/proposal/${encodeURIComponent(current.id)}/${action}`,
        'POST',
        action === 'approve' ? { payloadHash } : undefined,
      );
    } catch (cause) {
      if (action === 'execute') dispatchUncertain.value = true;
      throw cause;
    }
    await load();
  } catch (cause) {
    error.value = { code: 'PROPOSAL_ACTION_FAILED', message: liquidityError(cause) };
  } finally {
    password.value = '';
    busy.value = false;
    pendingAction.value = null;
  }
}


onMounted(() => void load());
</script>
