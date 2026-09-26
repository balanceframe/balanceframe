<template>
  <AnalysisPage title="Purchase Check" :loading="loading" :error="error">
    <template #error-actions
      ><button type="button" class="underline" @click="error = null">
        Return to purchase inputs
      </button></template
    >
    <template #content>
      <p class="mb-4 text-xs text-gray-500 dark:text-gray-400">
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
            <UButton :disabled="!canEvaluate || loading" @click="evaluate">Evaluate</UButton>
            <NuxtLink
              v-if="catalog?.canCreateSession"
              to="/spend-sessions/new"
              class="text-sm underline"
              >Create a manual Spend Session</NuxtLink
            >
            <NuxtLink to="/liquidity" class="text-sm underline"
              >Current capacity and backing</NuxtLink
            >
          </div>
        </form>
        <p v-if="catalog && !catalog.categories.length" class="mt-2 text-sm">
          No authorized categories available. Ask the budget owner for access.
        </p>
      </div>

      <DecisionCardView
        v-if="card"
        :card="card"
        :catalog="catalog ?? undefined"
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
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { PublicDecisionCard, PublicLiquidityView, PublicTransferPreview } from '@balanceframe/application';
import DecisionCardView from '../components/DecisionCardView.vue';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';

definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const categoryId = ref('');
const amountStr = ref('');
const currency = ref('USD');
const accountId = ref('');
const card = ref<PublicDecisionCard | null>(null);
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
    card.value = null;
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

async function previewTransfer(_purchaseItemId?: string) {
  if (!card.value) return;
  const transferPath = card.value.fundingPaths.find((path) => path.kind === 'account_transfer');
  if (
    !transferPath ||
    transferPath.kind !== 'account_transfer' ||
    card.value.outcome !== 'safe_after_date' ||
    card.value.paymentLiquidityStatus !== 'transfer_required' ||
    card.value.blockers.length > 0
  )
    return;

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

async function evaluate() {
  loading.value = true;
  error.value = null;
  card.value = null;
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

    const response = await $fetch<{
      status: string;
      result: { card: PublicDecisionCard } | null;
    }>('/api/purchase/evaluate', { query });
    if (response.status !== 'ok' || !response.result?.card) {
      error.value = { code: 'EVAL_FAILED', message: 'Evaluation returned no Decision Card.' };
    } else if (revision === evaluationRevision) {
      card.value = response.result.card;
    }
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: liquidityError(e) };
  } finally {
    loading.value = false;
  }
}
</script>
