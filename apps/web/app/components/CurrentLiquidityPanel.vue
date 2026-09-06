<template>
  <section class="mb-8 space-y-4" aria-labelledby="current-liquidity-heading">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 id="current-liquidity-heading" class="text-2xl font-semibold">
          Account-aware spendability
        </h1>
        <p class="text-sm text-gray-500">
          Current capacity and constrained category backing — separate from future projections.
        </p>
      </div>
      <button
        type="button"
        class="rounded border px-3 py-2 text-sm"
        :disabled="loading"
        @click="load"
      >
        Refresh current data
      </button>
    </div>
    <p v-if="loading" role="status">Loading current account capacity…</p>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <template v-if="view"
      ><div class="flex flex-wrap gap-4 text-sm">
        <NuxtLink to="/purchase-check" class="underline">Check a purchase</NuxtLink
        ><NuxtLink v-if="view.canCreateSession" to="/spend-sessions/new" class="underline"
          >Create Spend Session</NuxtLink
        ><NuxtLink
          v-if="view.canConfigure || view.canManageGrants"
          to="/liquidity/settings"
          class="underline"
          >Account policies, evidence and access</NuxtLink
        >
      </div>
      <LiquidityResult :view="view" show-accounts />
      <UCard id="reallocation" class="scroll-mt-20"
        ><template #header
          ><h2 class="font-semibold">Cash-neutral category reallocation preview</h2></template
        >
        <p class="text-sm">
          Move category assignments in a read-only scenario. This does not move bank cash, execute a
          reallocation or make a payment account ready.
        </p>
        <form class="mt-3 grid gap-3 sm:grid-cols-2" @submit.prevent="previewReallocation">
          <label class="grid gap-1 text-sm"
            >From category<select
              v-model="source"
              required
              class="rounded border bg-transparent p-2"
            >
              <option value="">Choose source</option>
              <option v-for="category in view.categories" :key="category.id" :value="category.id">
                {{ category.name ?? 'Authorized category' }}
              </option>
            </select></label
          ><label class="grid gap-1 text-sm"
            >To category<select
              v-model="destination"
              required
              class="rounded border bg-transparent p-2"
            >
              <option value="">Choose destination</option>
              <option v-for="category in view.categories" :key="category.id" :value="category.id">
                {{ category.name ?? 'Authorized category' }}
              </option>
            </select></label
          ><label class="grid gap-1 text-sm"
            >Amount (minor units)<input
              v-model="amount"
              inputmode="numeric"
              pattern="[0-9]+"
              required
              class="rounded border bg-transparent p-2" /></label
          ><label class="grid gap-1 text-sm"
            >Currency<input
              v-model="currency"
              pattern="[A-Z]{3}"
              maxlength="3"
              required
              class="rounded border bg-transparent p-2" /></label
          ><UButton
            :disabled="previewing || !source || !destination || source === destination || !amount"
            @click="previewReallocation"
            >Preview category and backing effects</UButton
          >
        </form>
        <p v-if="previewing" role="status">Evaluating cash-neutral scenario…</p>
        <p v-if="previewError" role="alert" class="mt-2 text-red-600">{{ previewError }}</p>
        <div v-if="reallocation" class="mt-4">
          <p class="font-medium">Preview only — bank cash unchanged</p>
          <LiquidityResult :view="reallocation" show-accounts />
        </div>
      </UCard>
    </template>
  </section>
</template>
<script setup lang="ts">
import type { PublicLiquidityView } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
const view = ref<PublicLiquidityView | null>(null);
const loading = ref(true);
const error = ref('');
const source = ref('');
const destination = ref('');
const amount = ref('');
const currency = ref('USD');
const reallocation = ref<PublicLiquidityView | null>(null);
const previewing = ref(false);
const previewError = ref('');
let revision = 0;
watch([source, destination, amount, currency], () => {
  revision += 1;
  reallocation.value = null;
});
async function load() {
  loading.value = true;
  error.value = '';
  view.value = null;
  reallocation.value = null;
  try {
    view.value = await liquidityRequest<PublicLiquidityView>('/api/liquidity/spendability');
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    loading.value = false;
  }
}
async function previewReallocation() {
  if (previewing.value) return;
  previewing.value = true;
  previewError.value = '';
  reallocation.value = null;
  const currentRevision = revision;
  try {
    const result = await liquidityRequest<PublicLiquidityView>(
      '/api/liquidity/reallocation-preview',
      'POST',
      {
        moves: [
          {
            id: 'reallocation-preview',
            sourceCategoryId: source.value,
            destinationCategoryId: destination.value,
            amount: { minorUnits: amount.value, currency: currency.value },
          },
        ],
      },
    );
    if (currentRevision === revision) reallocation.value = result;
  } catch (e) {
    previewError.value = liquidityError(e);
  } finally {
    previewing.value = false;
  }
}
onMounted(load);
</script>
