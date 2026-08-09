<template>
  <AnalysisPage
    title="Cash Flow Projection"
    :loading="loading"
    :error="error"
    :insufficient-data="!projectionMonths && !loading && !error"
  >
    <template #content>
      <div class="mb-4">
        <UFormGroup label="Months to project" class="mb-3">
          <UInput v-model.number="months" type="number" min="1" max="24" />
        </UFormGroup>
        <UButton :disabled="!months || months < 1" @click="project">Project</UButton>
      </div>

      <!-- Data warning -->
      <UCard v-if="dataWarning" class="mb-4">
        <template #header>
          <span class="font-semibold text-amber-700 dark:text-amber-400">Warning</span>
        </template>
        <p class="text-xs text-gray-600 dark:text-gray-400">{{ dataWarning }}</p>
      </UCard>

      <!-- Envelope Availability (separate from projection) -->
      <UCard v-if="envelopeAvailability" class="mb-4">
        <template #header>
          <span class="font-semibold">Envelope Availability</span>
        </template>
        <div class="text-xs text-gray-600 dark:text-gray-400">
          <p>
            {{ envelopeAvailability.available ? 'Envelopes active' : 'No envelopes configured' }}
          </p>
          <p v-if="envelopeAvailability.envelopeCount">
            {{ envelopeAvailability.envelopeCount }} envelope{{
              envelopeAvailability.envelopeCount !== 1 ? 's' : ''
            }}
          </p>
          <div v-if="envelopeAvailability.totalBudgeted" class="mt-1">
            Total budgeted: <SemanticAmount :amount="envelopeAvailability.totalBudgeted" /> &middot;
            Spent: <SemanticAmount :amount="envelopeAvailability.totalSpent" />
          </div>
        </div>
      </UCard>

      <!-- Projection table -->
      <div v-if="projections.length" class="mt-4">
        <AnalysisTable :columns="flowColumns" :rows="projections" />
        <p v-if="summary" class="text-xs text-gray-500 dark:text-gray-400 mt-2">
          Net: <SemanticAmount :amount="summary.netProjection" /> &middot; Min:
          <SemanticAmount :amount="summary.minBalance" /> &middot; Max:
          <SemanticAmount :amount="summary.maxBalance" />
        </p>
      </div>

      <!-- Assumptions -->
      <UCard v-if="assumptions" class="mt-4">
        <template #header>
          <span class="font-semibold">Assumptions</span>
        </template>
        <div class="text-xs text-gray-600 dark:text-gray-400">
          <p>Based on: {{ assumptions.basedOn }}</p>
          <p v-if="assumptions.note">{{ assumptions.note }}</p>
        </div>
      </UCard>

      <!-- Scope -->
      <UCard v-if="scope" class="mt-4">
        <template #header>
          <span class="font-semibold">Scope</span>
        </template>
        <div class="text-xs text-gray-600 dark:text-gray-400">
          <p v-if="scope.accountsIncluded?.length">
            Accounts: {{ scope.accountsIncluded.join(', ') }}
          </p>
          <p v-if="scope.categoriesIncluded?.length">
            Categories: {{ scope.categoriesIncluded.join(', ') }}
          </p>
        </div>
      </UCard>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

interface Assumptions {
  basedOn: string;
  inflationRate: number | null;
  growthRate: number | null;
  note: string;
}

interface Scope {
  monthsProjected: number;
  accountsIncluded: string[];
  categoriesIncluded: string[];
}

interface EnvelopeAvailability {
  available: boolean;
  envelopeCount: number;
  totalBudgeted: Amount;
  totalSpent: Amount;
}

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const months = ref(3);
const projections = ref<Record<string, unknown>[]>([]);
const summary = ref<{ netProjection: Amount; minBalance: Amount; maxBalance: Amount } | null>(null);
const projectionMonths = ref(0);
const assumptions = ref<Assumptions | null>(null);
const scope = ref<Scope | null>(null);
const envelopeAvailability = ref<EnvelopeAvailability | null>(null);
const dataWarning = ref<string | null>(null);

const flowColumns = [
  { key: 'month', label: 'Month' },
  { key: 'income', label: 'Income', type: 'amount' as const },
  { key: 'expenses', label: 'Expenses', type: 'amount' as const },
  { key: 'netFlow', label: 'Net', type: 'amount' as const },
  { key: 'endingBalance', label: 'Ending', type: 'amount' as const },
];

async function project() {
  loading.value = true;
  error.value = null;
  try {
    const res = await $fetch<{
      status: string;
      result: {
        projectionMonths: number;
        projections: Array<{
          month: string;
          income: Amount;
          expenses: Amount;
          netFlow: Amount;
          endingBalance: Amount;
        }>;
        summary: { netProjection: Amount; minBalance: Amount; maxBalance: Amount };
        assumptions: Assumptions;
        scope: Scope;
        envelopeAvailability: EnvelopeAvailability;
        sufficientData: boolean;
        dataWarning: string | null;
      };
    }>('/api/cash-flow/project', { query: { months: String(months.value) } });
    if (res.status === 'ok') {
      projectionMonths.value = res.result.projectionMonths;
      projections.value = res.result.projections.map((p) => ({ ...p }));
      summary.value = res.result.summary;
      assumptions.value = res.result.assumptions ?? null;
      scope.value = res.result.scope ?? null;
      envelopeAvailability.value = res.result.envelopeAvailability ?? null;
      dataWarning.value = res.result.dataWarning ?? null;
    } else {
      error.value = { code: 'PROJECT_FAILED', message: 'Projection returned error.' };
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
}
</script>
