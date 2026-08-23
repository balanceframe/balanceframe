<template>
  <AnalysisPage title="Purchase Check" :loading="loading" :error="error">
    <template #content>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
        This page is read-only. Evaluations do not mutate ledger state or trigger transactions.
      </p>
      <div class="mb-4">
        <UFormGroup label="Category" class="mb-3">
          <UInput v-model="categoryId" placeholder="e.g. cg" />
        </UFormGroup>
        <UFormGroup label="Amount (minor units)" class="mb-3">
          <UInput v-model="amountStr" placeholder="e.g. 5000 for $50.00" type="number" />
        </UFormGroup>
        <UFormGroup label="Currency" class="mb-3">
          <UInput v-model="currency" placeholder="e.g. USD" />
        </UFormGroup>
        <UFormGroup label="Account" class="mb-3">
          <UInput v-model="accountId" placeholder="e.g. acct_checking (optional)" />
        </UFormGroup>
        <UButton :disabled="!canEvaluate" @click="evaluate">Evaluate</UButton>
      </div>

      <div v-if="result" class="mt-4">
        <!-- Verdict banner -->
        <UCard>
          <template #header>
            <span class="font-semibold">Result</span>
          </template>
          <p class="text-sm">
            Verdict:
            <span :class="verdictClass" class="font-medium">
              {{ verdictLabel }}
            </span>
          </p>
          <ReasonCodeList v-if="legacyReasonCodes.length" :codes="legacyReasonCodes" class="mt-2" />
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
              <span v-else class="font-medium text-gray-500 dark:text-gray-400">Unknown</span>
            </div>
            <div>
              Spent:
              <SemanticAmount v-if="result.categorySpent" :amount="result.categorySpent" />
              <span v-else class="font-medium text-gray-500 dark:text-gray-400">Unknown</span>
            </div>
            <div>
              Remaining:
              <SemanticAmount v-if="result.categoryRemaining" :amount="result.categoryRemaining" />
              <span v-else class="font-medium text-gray-500 dark:text-gray-400">Unknown</span>
            </div>
          </div>
          <div class="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Projected balance:
            <SemanticAmount v-if="result.projectedBalance" :amount="result.projectedBalance" />
            <span v-else class="font-medium text-gray-500 dark:text-gray-400">Unavailable</span>
          </div>
          <div class="mt-1 text-xs text-gray-500">
            {{ result.hasEnvelope ? 'Envelope budget active' : 'No envelope (cash-flow only)' }}
          </div>
        </UCard>

        <!-- Canonical decision evidence -->
        <UCard v-if="result.decision || showInsufficientDecision" class="mt-3">
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
              <ReasonCodeList :issues="result.decision.issues" class="mt-2" />
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
        <UCard v-if="result.proposals && result.proposals.length" class="mt-3">
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
        <UCard v-if="result.donors && result.donors.length" class="mt-3">
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
        </UCard>

        <!-- Protected categories -->
        <UCard v-if="result.protectedCategories && result.protectedCategories.length" class="mt-3">
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
        <UCard v-if="result.competition" class="mt-3">
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
  allowable: boolean;
  verdict: 'safe' | 'not_safe' | 'safe_with_reallocation' | 'insufficient_data';
  reasonCodes: string[];
  explanation: string;
  categoryBudget: Amount | null;
  categorySpent: Amount | null;
  categoryRemaining: Amount | null;
  projectedBalance: Amount | null;
  hasEnvelope: boolean;
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

const canEvaluate = computed(() =>
  Boolean(String(categoryId.value ?? '').trim() && String(amountStr.value ?? '').trim()),
);

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
      return 'Blocked';
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
      return 'text-red-600 dark:text-red-400';
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
  return 'id' in scope && scope.id ? `${kind}: ${scope.id}` : kind;
}

function decisionAmountKey(amount: DecisionAmount): string {
  const scopeId = 'id' in amount.scope && amount.scope.id ? amount.scope.id : '';
  return `${amount.label}:${amount.scope.kind}:${scopeId}`;
}

async function evaluate() {
  loading.value = true;
  error.value = null;
  result.value = null;
  try {
    const query: Record<string, string> = {
      categoryId: String(categoryId.value ?? '').trim(),
      amount: String(amountStr.value ?? '').trim(),
    };
    const normalizedCurrency = String(currency.value ?? '').trim();
    const normalizedAccountId = String(accountId.value ?? '').trim();
    if (normalizedCurrency) query.currency = normalizedCurrency;
    if (normalizedAccountId) query.accountId = normalizedAccountId;

    const res = await $fetch<{ status: string; result: PurchaseResult }>('/api/purchase/evaluate', {
      query,
    });
    if (res.status === 'ok') result.value = res.result;
    else error.value = { code: 'EVAL_FAILED', message: 'Evaluation returned error.' };
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
}
</script>
