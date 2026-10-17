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
        <p v-if="demoEntryError" role="alert" class="text-red-600">
          {{ demoEntryError }}
          <button type="button" class="underline" @click="loadCatalog">Retry demo entry</button>
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
            Leave timing blank to evaluate at request time. Set a future purchase time to review a
            transfer; an omitted payment deadline uses the purchase time.
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
        :proposal-disabled="proposalBusy || !evaluatedDecision"
        @plan-transfer="previewTransfer"
        @propose="proposeAction"
      />
      <p v-if="proposalError" role="alert" class="my-3 text-red-600">{{ proposalError }}</p>
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
import { onBeforeUnmount, onMounted } from 'vue';
import type { ConsequentialActionIntent } from '@balanceframe/protocol-generated';
import type { PublicDecisionCard, PublicLiquidityView, PublicTransferPreview } from '@balanceframe/application';
import DecisionCardView from '../components/DecisionCardView.vue';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';

interface DemoState {
  status: 'loading' | 'ready' | 'failed';
  scenarioId: string;
  generation: number;
  anchor: string | null;
  shared: true;
  personaId: string | null;
  csrfToken: string | null;
  failureCode?: string;
}

interface DemoEntry {
  generation: number;
  path: string;
  input?: {
    categoryId: string;
    accountId?: string;
    amount: { minorUnits: string; currency: string };
    purchaseAt?: string;
    requiredBy?: string;
  };
}

function demoModeConfigured() {
  try {
    return typeof useRuntimeConfig === 'function' && useRuntimeConfig()?.public?.demoMode === true;
  } catch {
    return false;
  }
}

function parseDemoState(value: unknown): DemoState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DemoState>;
  if (
    (candidate.status !== 'loading' && candidate.status !== 'ready' && candidate.status !== 'failed') ||
    typeof candidate.scenarioId !== 'string' ||
    typeof candidate.generation !== 'number' ||
    !Number.isSafeInteger(candidate.generation) ||
    candidate.shared !== true
  ) {
    return null;
  }
  return {
    status: candidate.status,
    scenarioId: candidate.scenarioId,
    generation: candidate.generation,
    anchor: typeof candidate.anchor === 'string' ? candidate.anchor : null,
    shared: true,
    personaId: typeof candidate.personaId === 'string' ? candidate.personaId : null,
    csrfToken: typeof candidate.csrfToken === 'string' ? candidate.csrfToken : null,
    ...(typeof candidate.failureCode === 'string' ? { failureCode: candidate.failureCode } : {}),
  };
}

function parseDemoEntry(value: unknown): DemoEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DemoEntry>;
  if (
    typeof candidate.generation !== 'number' ||
    !Number.isSafeInteger(candidate.generation) ||
    typeof candidate.path !== 'string' ||
    !candidate.path.startsWith('/') ||
    candidate.path.includes('?') ||
    candidate.path.includes('#')
  ) {
    return null;
  }
  return candidate as DemoEntry;
}

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
const demoEntryError = ref('');
const purchaseAt = ref('');
const requiredBy = ref('');
const transferPreview = ref<PublicTransferPreview | null>(null);
const transferLoading = ref(false);
const proposalBusy = ref(false);
const proposalError = ref('');
const evaluatedDecision = ref<EvaluatedPurchaseDecision | null>(null);
const transferError = ref('');
const demoMode = ref(demoModeConfigured());
interface EvaluatedPurchaseDecision {
  accountId: string | null;
  items: [{
    id: 'purchase';
    categoryId: string;
    amount: { minorUnits: string; currency: string };
    accountId: string | null;
    purchaseAt: string;
    requiredBy: string;
    priority: 'planned';
  }];
  adjustments: [];
  warningThresholds: [];
  expiresAt: string;
}
let evaluationRevision = 0;
let catalogRequestRevision = 0;
let demoEntryRetryTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  [categoryId, amountStr, currency, accountId, purchaseAt, requiredBy],
  () => {
    evaluationRevision += 1;
    loading.value = false;
    transferLoading.value = false;
    error.value = null;
    card.value = null;
    evaluatedDecision.value = null;
    transferPreview.value = null;
    transferError.value = '';
    proposalError.value = '';
  },
  { flush: 'sync' },
);

function authorizedPurchaseInput(
  value: DemoEntry['input'] | undefined,
  view: PublicLiquidityView,
): DemoEntry['input'] | null {
  if (!value || typeof value !== 'object') return null;
  if (
    typeof value.categoryId !== 'string' ||
    !value.categoryId ||
    !view.categories.some((category) => category.id === value.categoryId)
  ) {
    return null;
  }
  if (
    value.accountId !== undefined &&
    (typeof value.accountId !== 'string' ||
      !value.accountId ||
      !view.accounts.some((account) => account.id === value.accountId))
  ) {
    return null;
  }
  if (
    !value.amount ||
    typeof value.amount !== 'object' ||
    typeof value.amount.minorUnits !== 'string' ||
    !/^[1-9]\d*$/.test(value.amount.minorUnits) ||
    typeof value.amount.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(value.amount.currency)
  ) {
    return null;
  }
  for (const timestamp of [value.purchaseAt, value.requiredBy]) {
    if (timestamp !== undefined && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))) {
      return null;
    }
  }
  return value;
}

function datetimeLocalValue(value: string | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 16);
}

function allowedDemoEntryPath(path: string) {
  return (
    path === '/purchase-check' ||
    /^\/spend-sessions\/[^/?#]+$/.test(path) ||
    /^\/spend-sessions\/[^/?#]+\/completions\/[^/?#]+$/.test(path)
  );
}

function queueDemoEntryRetry(view: PublicLiquidityView, requestRevision: number) {
  if (demoEntryRetryTimer) clearTimeout(demoEntryRetryTimer);
  demoEntryRetryTimer = setTimeout(() => {
    demoEntryRetryTimer = undefined;
    if (requestRevision === catalogRequestRevision) void loadDemoEntry(view, requestRevision);
  }, 1500);
}

async function loadDemoEntry(view: PublicLiquidityView, requestRevision: number) {
  if (!demoMode.value || requestRevision !== catalogRequestRevision) return;
  demoEntryError.value = '';
  try {
    const demoState = parseDemoState(
      await $fetch<unknown>('/__demo/state', { credentials: 'same-origin' }),
    );
    if (!demoState || requestRevision !== catalogRequestRevision) return;
    if (demoState.status === 'loading') {
      demoEntryError.value = 'The shared demo is still loading. This page will retry automatically.';
      queueDemoEntryRetry(view, requestRevision);
      return;
    }
    if (demoState.status === 'failed') {
      demoEntryError.value = 'The shared demo scenario is unavailable. Reset or retry the demo.';
      return;
    }
    const entry = parseDemoEntry(
      await $fetch<unknown>('/__demo/entry', {
        credentials: 'same-origin',
        query: { generation: demoState.generation },
      }),
    );
    if (!entry || entry.generation !== demoState.generation || requestRevision !== catalogRequestRevision) {
      demoEntryError.value = 'The demo entry changed before it could be opened. Retry the catalog.';
      return;
    }
    if (!allowedDemoEntryPath(entry.path)) {
      demoEntryError.value = 'The demo returned an unavailable entry. Retry the catalog.';
      return;
    }
    if (entry.path !== '/purchase-check') {
      if (typeof window !== 'undefined' && window.location.pathname !== entry.path) {
        window.location.assign(entry.path);
      }
      return;
    }
    const input = authorizedPurchaseInput(entry.input, view);
    if (!input) {
      demoEntryError.value = 'The demo entry did not match the authorized purchase catalog.';
      return;
    }
    categoryId.value = input.categoryId;
    amountStr.value = input.amount.minorUnits;
    currency.value = input.amount.currency;
    accountId.value = input.accountId ?? '';
    purchaseAt.value = datetimeLocalValue(input.purchaseAt);
    requiredBy.value = datetimeLocalValue(input.requiredBy);
  } catch {
    if (requestRevision === catalogRequestRevision) {
      demoEntryError.value = 'The demo entry is unavailable. Retry the catalog.';
    }
  }
}

async function loadCatalog() {
  if (demoEntryRetryTimer) {
    clearTimeout(demoEntryRetryTimer);
    demoEntryRetryTimer = undefined;
  }
  const requestRevision = ++catalogRequestRevision;
  catalogLoading.value = true;
  catalogError.value = '';
  demoEntryError.value = '';
  try {
    const loadedCatalog = await liquidityRequest<PublicLiquidityView>('/api/liquidity/spendability');
    if (requestRevision !== catalogRequestRevision) return;
    catalog.value = loadedCatalog;
    if (demoMode.value) void loadDemoEntry(loadedCatalog, requestRevision);
  } catch (e) {
    if (requestRevision === catalogRequestRevision) catalogError.value = liquidityError(e);
  } finally {
    if (requestRevision === catalogRequestRevision) catalogLoading.value = false;
  }
}

onMounted(() => {
  void loadCatalog();
});

onBeforeUnmount(() => {
  if (demoEntryRetryTimer) clearTimeout(demoEntryRetryTimer);
});

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
    if (revision === evaluationRevision) transferError.value = liquidityError(e);
  } finally {
    if (revision === evaluationRevision) transferLoading.value = false;
  }
}

const canEvaluate = computed(() =>
  Boolean(String(categoryId.value ?? '').trim() && String(amountStr.value ?? '').trim()),
);

async function evaluate() {
  const revision = ++evaluationRevision;
  loading.value = true;
  error.value = null;
  card.value = null;
  evaluatedDecision.value = null;
  transferPreview.value = null;
  try {
    const category = String(categoryId.value ?? '').trim();
    const minorUnits = String(amountStr.value ?? '').trim();
    const normalizedCurrency = String(currency.value ?? '').trim() || 'USD';
    const selectedAccountId = String(accountId.value ?? '').trim() || null;
    const evaluatedAt = new Date().toISOString();
    const purchaseTime = purchaseAt.value
      ? new Date(`${purchaseAt.value}Z`).toISOString()
      : evaluatedAt;
    const deadline = requiredBy.value
      ? new Date(`${requiredBy.value}Z`).toISOString()
      : purchaseTime;
    const snapshot = {
      categoryId: category,
      amount: { minorUnits, currency: normalizedCurrency },
      accountId: selectedAccountId,
      purchaseAt: purchaseTime,
      requiredBy: deadline,
    };
    const query: Record<string, string> = {
      categoryId: snapshot.categoryId,
      amount: snapshot.amount.minorUnits,
      currency: snapshot.amount.currency,
      purchaseAt: snapshot.purchaseAt,
      requiredBy: snapshot.requiredBy,
    };
    if (snapshot.accountId) query.accountId = snapshot.accountId;

    const response = await $fetch<{
      status: string;
      result: { card: PublicDecisionCard } | null;
    }>('/api/purchase/evaluate', { query });
    if (revision !== evaluationRevision) return;
    if (response.status !== 'ok' || !response.result?.card) {
      error.value = { code: 'EVAL_FAILED', message: 'Evaluation returned no Decision Card.' };
    } else {
      const evaluatedCard = response.result.card;
      card.value = evaluatedCard;
      evaluatedDecision.value = evaluatedCard.expiresAt
        ? {
            accountId: snapshot.accountId,
            items: [{
              id: 'purchase',
              categoryId: snapshot.categoryId,
              amount: snapshot.amount,
              accountId: snapshot.accountId,
              purchaseAt: snapshot.purchaseAt,
              requiredBy: snapshot.requiredBy,
              priority: 'planned',
            }],
            adjustments: [],
            warningThresholds: [],
            expiresAt: evaluatedCard.expiresAt,
          }
        : null;
    }
  } catch (e) {
    if (revision === evaluationRevision)
      error.value = { code: 'FETCH_ERROR', message: liquidityError(e) };
  } finally {
    if (revision === evaluationRevision) loading.value = false;
  }
}

async function proposeAction(action: Extract<ConsequentialActionIntent, { kind: 'reallocation' }>) {
  const decision = evaluatedDecision.value;
  if (!decision || proposalBusy.value) return;
  proposalBusy.value = true;
  proposalError.value = '';
  try {
    const result = await liquidityRequest<{ proposal: { id: string } }>(
      '/api/proposal/action',
      'POST',
      { action, decision },
    );
    await navigateTo(`/proposals/${encodeURIComponent(result.proposal.id)}`);
  } catch (cause) {
    proposalError.value = liquidityError(cause);
  } finally {
    proposalBusy.value = false;
  }
}
</script>
