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
          <ReasonCodeList
            v-if="result.reasonCodes && result.reasonCodes.length"
            :codes="result.reasonCodes"
            class="mt-2"
          />
          <p v-if="result.explanation" class="text-xs text-gray-500 mt-2">
            {{ result.explanation }}
          </p>

          <!-- Category budget summary -->
          <div
            v-if="result.categoryBudget"
            class="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-600 dark:text-gray-400"
          >
            <div>Budget: <SemanticAmount :amount="result.categoryBudget" /></div>
            <div v-if="result.categorySpent">
              Spent: <SemanticAmount :amount="result.categorySpent" />
            </div>
            <div v-if="result.categoryRemaining">
              Remaining: <SemanticAmount :amount="result.categoryRemaining" />
            </div>
          </div>
          <div v-if="result.projectedBalance" class="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Projected balance: <SemanticAmount :amount="result.projectedBalance" />
          </div>
          <div class="mt-1 text-xs text-gray-500">
            {{ result.hasEnvelope ? 'Envelope budget active' : 'No envelope (cash-flow only)' }}
          </div>
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
