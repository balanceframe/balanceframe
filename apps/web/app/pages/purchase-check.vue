<template>
  <AnalysisPage title="Purchase Check" :loading="loading" :error="error">
    <template #error-actions
      ><button type="button" class="underline" @click="error = null">
        Return to purchase inputs
      </button></template
    >
    <template #content>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Purchase evaluation is read-only. Transfer proposals require separate exact review and
        approval; BalanceFrame never initiates bank transfers.
      </p>
      <div class="mb-4">
        <p v-if="catalogLoading" role="status">Loading authorized accounts and categories…</p>
        <p v-if="catalogError" role="alert" class="text-red-600">
          {{ catalogError }}
          <button type="button" class="underline" @click="loadCatalog">Retry catalog</button>
        </p>
        <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="evaluate">
          <label for="purchase-category" class="grid gap-1 text-sm"
            >Category
            <select
              id="purchase-category"
              v-model="categoryId"
              class="rounded border bg-transparent p-2"
              required
            >
              <option value="">Choose a category</option>
              <option
                v-for="category in catalog?.categories ?? []"
                :key="category.id"
                :value="category.id"
              >
                {{ category.name ?? 'Authorized category' }}
              </option>
            </select>
          </label>
          <label for="purchase-amount" class="grid gap-1 text-sm"
            >Amount (minor units)
            <input
              id="purchase-amount"
              v-model="amountStr"
              inputmode="numeric"
              pattern="[0-9]+"
              placeholder="5000 for 50.00"
              class="rounded border bg-transparent p-2"
              required
            />
          </label>
          <label for="purchase-currency" class="grid gap-1 text-sm"
            >Currency
            <input
              id="purchase-currency"
              v-model="currency"
              pattern="[A-Z]{3}"
              maxlength="3"
              class="rounded border bg-transparent p-2"
              required
            />
          </label>
          <label for="purchase-account" class="grid gap-1 text-sm"
            >Payment account
            <select
              id="purchase-account"
              v-model="accountId"
              class="rounded border bg-transparent p-2"
            >
              <option value="">No account selected — show alternatives</option>
              <option
                v-for="account in catalog?.accounts ?? []"
                :key="account.id"
                :value="account.id"
              >
                {{ account.name ?? 'Authorized account' }}
              </option>
            </select>
          </label>
          <label for="purchase-at" class="grid gap-1 text-sm"
            >Purchase time (UTC, optional)
            <input
              id="purchase-at"
              v-model="purchaseAt"
              type="datetime-local"
              class="rounded border bg-transparent p-2"
            />
          </label>
          <label for="purchase-required" class="grid gap-1 text-sm"
            >Payment required by (UTC, optional)
            <input
              id="purchase-required"
              v-model="requiredBy"
              type="datetime-local"
              class="rounded border bg-transparent p-2"
            />
          </label>
          <p class="text-xs text-gray-500 dark:text-gray-400 sm:col-span-2">
            Leave timing blank for an immediate check at the server's evaluation time. Set a future
            purchase time to review a transfer; an omitted payment deadline uses the purchase time.
          </p>
          <div class="flex flex-wrap items-center gap-3 sm:col-span-2">
            <UButton :disabled="!canEvaluate || loading" @click="evaluate">Evaluate</UButton
            ><NuxtLink
              v-if="catalog?.canCreateSession"
              to="/spend-sessions/new"
              class="text-sm underline"
              >Create a manual Spend Session</NuxtLink
            ><NuxtLink to="/liquidity" class="text-sm underline"
              >Current capacity and backing</NuxtLink
            >
          </div>
        </form>
        <p v-if="catalog && !catalog.categories.length" class="mt-2 text-sm">
          No authorized categories available. Ask the budget owner for access.
        </p>
      </div>
      <LiquidityResult
        v-if="result?.liquidity"
        :view="result.liquidity"
        selectable
        show-accounts
        @select-route="selectRoute"
        @plan-transfer="previewTransfer"
      />
      <p v-if="transferError" role="alert" class="my-3 text-red-600">{{ transferError }}</p>
      <p v-if="transferLoading" role="status">Preparing read-only transfer review…</p>
      <TransferPlanReview
        v-if="transferPreview"
        :key="transferPreview.previewId"
        :preview="transferPreview"
        class="my-4"
        @close="transferPreview = null"
      />

      <div v-if="result" class="mt-4">
        <!-- Verdict banner -->
        <UCard v-if="!result.liquidity">
          <template #header>
            <span class="font-semibold">Result</span>
          </template>
          <p class="text-sm">
            Verdict:
            <span :class="verdictClass" class="font-medium">
              {{ verdictLabel }}
            </span>
          </p>
          <ReasonCodeList
            v-if="legacyReasonCodes.length"
            :codes="legacyReasonCodes"
            :scope-labels="result.entityLabels"
            class="mt-2"
          />
          <p v-if="result.explanation" class="text-xs text-gray-500 mt-2">
            {{ result.explanation }}
          </p>

          <!-- Category budget summary -->
          <div
            class="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-gray-400 sm:grid-cols-3"
          >
            <div>
              Budget:
              <SemanticAmount v-if="result.categoryBudget" :amount="result.categoryBudget" />
              <span v-else class="font-medium text-gray-500 dark:text-gray-400">
                {{ categoryMoneyFallbackLabel }}
              </span>
            </div>
            <div>
              Spent:
              <SemanticAmount v-if="result.categorySpent" :amount="result.categorySpent" />
              <span v-else class="font-medium text-gray-500 dark:text-gray-400">
                {{ categoryMoneyFallbackLabel }}
              </span>
            </div>
            <div>
              Remaining:
              <SemanticAmount v-if="result.categoryRemaining" :amount="result.categoryRemaining" />
              <span v-else class="font-medium text-gray-500 dark:text-gray-400">
                {{ categoryMoneyFallbackLabel }}
              </span>
            </div>
          </div>
          <div class="mt-1 text-xs text-gray-600 dark:text-gray-400">
            {{
              result.decision
                ? 'Effective balance after pending and uncleared activity:'
                : 'Projected balance:'
            }}
            <SemanticAmount v-if="result.projectedBalance" :amount="result.projectedBalance" />
            <span v-else class="font-medium text-gray-500 dark:text-gray-400">Unavailable</span>
          </div>
          <div class="mt-1 text-xs text-gray-500">
            {{ envelopeFundingLabel }}
          </div>
        </UCard>

        <!-- Canonical decision evidence -->
        <UCard
          v-if="!result.liquidity && (result.decision || showInsufficientDecision)"
          class="mt-3"
        >
          <template #header>
            <h2 class="font-semibold">Decision evidence</h2>
          </template>

          <dl class="text-sm">
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-gray-500 dark:text-gray-400">Readiness</dt>
              <dd
                data-testid="decision-readiness"
                class="font-semibold"
                :class="decisionReadinessClass"
              >
                {{ decisionReadinessLabel }}
              </dd>
            </div>
          </dl>

          <InsufficientDataPanel
            v-if="showInsufficientDecision"
            :reason="result.explanation || undefined"
            class="mt-3"
          />

          <template v-if="result.decision">
            <div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <section
                data-testid="decision-before"
                aria-labelledby="decision-before-heading"
                class="min-w-0"
              >
                <h3
                  id="decision-before-heading"
                  class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Before
                </h3>
                <ul v-if="result.decision.before.amounts.length" class="mt-2 space-y-2">
                  <li
                    v-for="amount in result.decision.before.amounts"
                    :key="decisionAmountKey(amount)"
                    class="text-sm"
                  >
                    <p class="font-medium text-gray-900 dark:text-gray-100">
                      {{ formatSemanticLabel(amount.label) }}
                    </p>
                    <p class="text-xs text-gray-500 dark:text-gray-400">
                      {{ formatDecisionScope(amount.scope) }}
                    </p>
                    <SemanticAmount
                      :amount="amount.amount"
                      :semantic-class="amount.label"
                      state="known"
                    />
                  </li>
                </ul>
                <p v-else class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  No semantic amounts available.
                </p>
              </section>

              <section
                data-testid="decision-after"
                aria-labelledby="decision-after-heading"
                class="min-w-0"
              >
                <h3
                  id="decision-after-heading"
                  class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  After
                </h3>
                <ul v-if="result.decision.after.amounts.length" class="mt-2 space-y-2">
                  <li
                    v-for="amount in result.decision.after.amounts"
                    :key="decisionAmountKey(amount)"
                    class="text-sm"
                  >
                    <p class="font-medium text-gray-900 dark:text-gray-100">
                      {{ formatSemanticLabel(amount.label) }}
                    </p>
                    <p class="text-xs text-gray-500 dark:text-gray-400">
                      {{ formatDecisionScope(amount.scope) }}
                    </p>
                    <SemanticAmount
                      :amount="amount.amount"
                      :semantic-class="amount.label"
                      state="known"
                    />
                  </li>
                </ul>
                <p v-else class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  No semantic amounts available.
                </p>
              </section>
            </div>

            <dl
              data-testid="decision-identity"
              class="mt-4 grid grid-cols-1 gap-2 border-t border-gray-200 pt-3 text-xs dark:border-gray-700 sm:grid-cols-2"
            >
              <div>
                <dt class="text-gray-500 dark:text-gray-400">Snapshot</dt>
                <dd class="break-all font-medium text-gray-900 dark:text-gray-100">
                  {{ result.decision.metadata.context.snapshotId }}
                </dd>
              </div>
              <div>
                <dt class="text-gray-500 dark:text-gray-400">Policy</dt>
                <dd class="break-all font-medium text-gray-900 dark:text-gray-100">
                  {{ result.decision.metadata.context.policyVersion }}
                </dd>
              </div>
              <div>
                <dt class="text-gray-500 dark:text-gray-400">Request</dt>
                <dd class="break-all font-medium text-gray-900 dark:text-gray-100">
                  {{ result.decision.metadata.requestId }}
                </dd>
              </div>
              <div>
                <dt class="text-gray-500 dark:text-gray-400">Valid until</dt>
                <dd class="break-all font-medium text-gray-900 dark:text-gray-100">
                  {{ result.decision.expiresAt }}
                </dd>
              </div>
            </dl>

            <section
              v-if="result.decision.issues.length"
              aria-labelledby="decision-issues-heading"
              class="mt-4"
            >
              <h3
                id="decision-issues-heading"
                class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
              >
                Issues and remediation
              </h3>
              <ReasonCodeList
                :issues="result.decision.issues"
                :scope-labels="result.entityLabels"
                class="mt-2"
              />
            </section>

            <section aria-labelledby="decision-evidence-heading" class="mt-4">
              <h3
                id="decision-evidence-heading"
                class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
              >
                Evidence references
              </h3>
              <p
                v-if="decisionEvidenceKinds.length"
                class="mt-1 text-xs text-gray-500 dark:text-gray-400"
              >
                Kinds:
                <code
                  v-for="kind in decisionEvidenceKinds"
                  :key="kind"
                  class="ml-1 font-mono text-gray-700 dark:text-gray-300"
                >
                  {{ kind }}
                </code>
              </p>
              <EvidenceDrawer
                :references="decisionEvidenceReferences"
                :snapshot-id="result.decision.metadata.context.snapshotId"
                :policy-version="result.decision.metadata.context.policyVersion"
                class="mt-2"
              />
            </section>
          </template>
        </UCard>

        <!-- Proposals (reallocation suggestions) -->
        <UCard
          v-if="showAlternativesAndConsequences && result.proposals && result.proposals.length"
          class="mt-3"
        >
          <template #header>
            <span class="font-semibold">Proposals</span>
          </template>
          <div
            v-for="(p, i) in result.proposals"
            :key="i"
            class="text-xs text-gray-600 dark:text-gray-400 mb-1"
          >
            <span class="font-medium">{{ p.label }}</span>
            &mdash; Move <SemanticAmount :amount="p.amount" /> to {{ p.targetCategoryId }}
          </div>
        </UCard>

        <!-- Donors (available reallocation sources) -->
        <UCard
          v-if="showAlternativesAndConsequences && result.donors && result.donors.length"
          class="mt-3"
        >
          <template #header>
            <span class="font-semibold">Donor</span>
          </template>
          <div
            v-for="(d, i) in result.donors"
            :key="i"
            class="text-xs text-gray-600 dark:text-gray-400 mb-1"
          >
            {{ d.categoryId }}: <SemanticAmount :amount="d.availableAmount" /> available
          </div>
          <NuxtLink to="/liquidity#reallocation" class="text-sm underline"
            >Preview a cash-neutral category reallocation</NuxtLink
          >
        </UCard>

        <!-- Protected categories -->
        <UCard
          v-if="
            showAlternativesAndConsequences &&
            result.protectedCategories &&
            result.protectedCategories.length
          "
          class="mt-3"
        >
          <template #header>
            <span class="font-semibold">Protected</span>
          </template>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="pc in result.protectedCategories"
              :key="pc"
              class="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            >
              {{ pc }}
            </span>
          </div>
        </UCard>

        <!-- Expiry -->
        <UCard v-if="result.expiry" class="mt-3">
          <template #header>
            <span class="font-semibold">Expiry</span>
          </template>
          <p class="text-xs text-gray-600 dark:text-gray-400">{{ result.expiry }}</p>
        </UCard>

        <!-- Competition -->
        <UCard v-if="showAlternativesAndConsequences && result.competition" class="mt-3">
          <template #header>
            <span class="font-semibold">Competition</span>
          </template>
          <p class="text-xs text-gray-600 dark:text-gray-400">
            {{ result.competition.competingPurchases }} competing purchase{{
              result.competition.competingPurchases !== 1 ? 's' : ''
            }}
            &mdash; Total committed: <SemanticAmount :amount="result.competition.totalCommitted" />
          </p>
        </UCard>

        <!-- Evidence / Policy / Freshness -->
        <UCard v-if="result.evidence || result.policy || result.freshness" class="mt-3">
          <template #header>
            <span class="font-semibold">Evidence</span>
          </template>
          <div v-if="result.evidence" class="text-xs text-gray-600 dark:text-gray-400">
            Source: {{ result.evidence.source }}
            <span v-if="result.evidence.snapshotAge">
              &middot; Snapshot age: {{ result.evidence.snapshotAge }}</span
            >
          </div>
          <div v-if="result.policy" class="text-xs text-gray-600 dark:text-gray-400 mt-1">
            Policy:
            {{
              result.policy.allowsReallocations
                ? 'Reallocation allowed'
                : 'Reallocation not allowed'
            }}
          </div>
          <div class="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Freshness: <span v-if="result.freshness">{{ result.freshness.label }}</span
            ><span v-else>unknown</span>
          </div>
        </UCard>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type {
  DecisionAmount,
  DecisionScope,
  EvidenceReference,
  ProspectiveDecisionEnvelope,
  PurchaseEvaluation,
} from '@balanceframe/protocol-generated';
import type { Amount } from '../components/types';
import type { PublicLiquidityView, PublicTransferPreview } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';

definePageMeta({ layout: 'default' });

interface Proposal {
  targetCategoryId: string;
  amount: Amount;
  label: string;
}

interface Donor {
  categoryId: string;
  availableAmount: Amount;
}

interface Competition {
  competingPurchases: number;
  totalCommitted: Amount;
}

interface Evidence {
  source: string;
  snapshotAge: string | null;
}

interface Policy {
  allowsReallocations: boolean;
}

interface Freshness {
  isStale: boolean;
  lastSync: string | null;
  label: string;
}

interface PurchaseResult {
  liquidity?: PublicLiquidityView;
  allowable: boolean;
  verdict?:
    | 'safe'
    | 'safe_with_qualifications'
    | 'safe_with_reallocation'
    | 'not_safe'
    | 'insufficient_data';
  reasonCodes: string[];
  explanation?: string;
  categoryBudget: Amount | null;
  categorySpent: Amount | null;
  categoryRemaining: Amount | null;
  projectedBalance: Amount | null;
  hasEnvelope: boolean;
  envelopeFundingState?: 'funded' | 'unfunded' | 'unavailable';
  entityLabels?: Record<string, string>;
  proposals: Proposal[];
  donors: Donor[];
  protectedCategories: string[];
  expiry: string | null;
  competition: Competition | null;
  evidence: Evidence | null;
  policy: Policy | null;
  freshness: Freshness | null;
  decision?: ProspectiveDecisionEnvelope<PurchaseEvaluation>;
}

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const categoryId = ref('');
const amountStr = ref('');
const currency = ref('USD');
const accountId = ref('');
const result = ref<PurchaseResult | null>(null);
const catalog = ref<PublicLiquidityView | null>(null);
const catalogLoading = ref(true);
const catalogError = ref('');
const purchaseAt = ref('');
const requiredBy = ref('');
const transferPreview = ref<PublicTransferPreview | null>(null);
const transferLoading = ref(false);
const transferError = ref('');
let evaluationRevision = 0;
watch(
  [categoryId, amountStr, currency, accountId, purchaseAt, requiredBy],
  () => {
    evaluationRevision += 1;
    result.value = null;
    transferPreview.value = null;
    transferError.value = '';
  },
  { flush: 'sync' },
);
async function loadCatalog() {
  catalogLoading.value = true;
  catalogError.value = '';
  try {
    catalog.value = await liquidityRequest<PublicLiquidityView>('/api/liquidity/spendability');
  } catch (e) {
    catalogError.value = liquidityError(e);
  } finally {
    catalogLoading.value = false;
  }
}
onMounted(loadCatalog);
async function selectRoute(id: string) {
  accountId.value = id;
  await nextTick();
  await evaluate();
}
async function previewTransfer() {
  transferLoading.value = true;
  transferError.value = '';
  transferPreview.value = null;
  const revision = evaluationRevision;
  try {
    const preview = await liquidityRequest<PublicTransferPreview>('/api/transfer/preview', 'POST', {
      kind: 'purchase',
      categoryId: categoryId.value,
      amount: { minorUnits: amountStr.value, currency: currency.value },
      ...(accountId.value ? { accountId: accountId.value } : {}),
      ...(purchaseAt.value ? { purchaseAt: new Date(`${purchaseAt.value}Z`).toISOString() } : {}),
      ...(requiredBy.value ? { requiredBy: new Date(`${requiredBy.value}Z`).toISOString() } : {}),
    });
    if (revision === evaluationRevision) transferPreview.value = preview;
  } catch (e) {
    transferError.value = liquidityError(e);
  } finally {
    transferLoading.value = false;
  }
}

const canEvaluate = computed(() =>
  Boolean(String(categoryId.value ?? '').trim() && String(amountStr.value ?? '').trim()),
);

const showAlternativesAndConsequences = computed(() => {
  const currentResult = result.value;
  if (!currentResult) return false;
  const isCanonical = Boolean(
    currentResult.decision || currentResult.envelopeFundingState || currentResult.entityLabels,
  );
  return !isCanonical || currentResult.verdict !== 'insufficient_data';
});

const legacyReasonCodes = computed(() => {
  const currentResult = result.value;
  if (!currentResult?.decision?.issues.length) return currentResult?.reasonCodes ?? [];

  const decisionIssueCodes = new Set(currentResult.decision.issues.map((issue) => issue.code));
  return currentResult.reasonCodes.filter((code) => !decisionIssueCodes.has(code));
});

const verdictLabel = computed(() => {
  switch (result.value?.verdict) {
    case 'safe':
      return 'Safe';
    case 'safe_with_qualifications':
      return 'Safe with Qualifications';
    case 'safe_with_reallocation':
      return 'Safe with Reallocation';
    case 'not_safe':
      return 'Not Safe';
    case 'insufficient_data':
      return 'Insufficient Data';
    default:
      return result.value?.allowable ? 'Yes' : 'No';
  }
});

const verdictClass = computed(() => {
  switch (result.value?.verdict) {
    case 'safe':
      return 'text-emerald-600';
    case 'safe_with_qualifications':
    case 'safe_with_reallocation':
      return 'text-amber-600';
    case 'not_safe':
      return 'text-red-600';
    case 'insufficient_data':
      return 'text-gray-500';
    default:
      return result.value?.allowable ? 'text-emerald-600' : 'text-red-600';
  }
});

const showInsufficientDecision = computed(
  () => !result.value?.decision && result.value?.verdict === 'insufficient_data',
);

const decisionReadinessLabel = computed(() => {
  switch (result.value?.decision?.readiness) {
    case 'ready':
      return 'Ready';
    case 'qualified':
      return 'Qualified';
    case 'blocked':
      return 'Insufficient data';
    default:
      return showInsufficientDecision.value ? 'Insufficient data' : '';
  }
});

const decisionReadinessClass = computed(() => {
  switch (result.value?.decision?.readiness) {
    case 'ready':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'qualified':
      return 'text-amber-600 dark:text-amber-400';
    case 'blocked':
      return 'text-gray-600 dark:text-gray-300';
    default:
      return 'text-gray-600 dark:text-gray-300';
  }
});

const decisionEvidenceReferences = computed<EvidenceReference[]>(() => {
  const decision = result.value?.decision;
  if (!decision) return [];
  return [...decision.evidence, ...decision.issues.flatMap((issue) => issue.evidence)];
});

const decisionEvidenceKinds = computed(() => [
  ...new Set(
    decisionEvidenceReferences.value
      .filter((reference) => reference.authorized && reference.redaction !== 'redacted')
      .map((reference) => reference.kind),
  ),
]);

function formatSemanticLabel(label: string): string {
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

function formatDecisionScope(scope: DecisionScope): string {
  const kind = formatSemanticLabel(scope.kind);
  if (!('id' in scope) || !scope.id) return kind;
  return `${kind}: ${result.value?.entityLabels?.[scope.id] ?? scope.id}`;
}

const categoryMoneyFallbackLabel = computed(() =>
  result.value?.envelopeFundingState === 'unavailable' ? 'Unavailable' : 'Unknown',
);

const envelopeFundingLabel = computed(() => {
  switch (result.value?.envelopeFundingState) {
    case 'funded':
      return 'Envelope budget active';
    case 'unfunded':
      return 'Envelope has no assigned funds';
    case 'unavailable':
      return 'Envelope funding unavailable';
    default:
      return result.value?.hasEnvelope ? 'Envelope budget active' : 'No envelope (cash-flow only)';
  }
});

function decisionAmountKey(amount: DecisionAmount): string {
  const scopeId = 'id' in amount.scope && amount.scope.id ? amount.scope.id : '';
  return `${amount.label}:${amount.scope.kind}:${scopeId}`;
}

async function evaluate() {
  loading.value = true;
  error.value = null;
  result.value = null;
  transferPreview.value = null;
  const revision = evaluationRevision;
  try {
    const query: Record<string, string> = {
      categoryId: String(categoryId.value ?? '').trim(),
      amount: String(amountStr.value ?? '').trim(),
    };
    const normalizedCurrency = String(currency.value ?? '').trim();
    const normalizedAccountId = String(accountId.value ?? '').trim();
    if (normalizedCurrency) query.currency = normalizedCurrency;
    if (normalizedAccountId) query.accountId = normalizedAccountId;
    if (purchaseAt.value) query.purchaseAt = new Date(`${purchaseAt.value}Z`).toISOString();
    if (requiredBy.value) query.requiredBy = new Date(`${requiredBy.value}Z`).toISOString();

    const res = await $fetch<{ status: string; result: PurchaseResult }>('/api/purchase/evaluate', {
      query,
    });
    if (res.status === 'ok') {
      if (revision === evaluationRevision) result.value = res.result;
    } else error.value = { code: 'EVAL_FAILED', message: 'Evaluation returned error.' };
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: liquidityError(e) };
  } finally {
    loading.value = false;
  }
}
</script>
