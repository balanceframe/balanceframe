<template>
  <UCard>
    <template #header
      ><h2 class="font-semibold">Approved category payment preferences</h2></template
    >
    <p class="text-sm">
      Save an explicit preferred payment account for a category. Purchase evaluation remains
      read-only. An explicit purchase choice or session account takes precedence; a preference does
      not override account eligibility, current evidence or safe capacity.
    </p>
    <p v-if="loading" role="status" class="mt-3">Loading approved payment preferences…</p>
    <p v-if="error" role="alert" class="mt-3 text-red-600">{{ error }}</p>
    <p v-if="preferences && !preferences.canManage" role="status" class="mt-3">
      Your current permissions do not allow managing payment preferences.
    </p>
    <form v-if="preferences?.canManage" class="mt-4 space-y-3" @submit.prevent="save">
      <fieldset :disabled="busy" class="grid gap-3 sm:grid-cols-3">
        <label class="grid gap-1 text-sm"
          >Category<select
            v-model="categoryId"
            data-testid="preference-category"
            required
            class="rounded border bg-transparent p-2"
          >
            <option value="">Choose a category</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.name ?? 'Authorized category' }}
            </option>
          </select></label
        >
        <label class="grid gap-1 text-sm"
          >Preferred payment account<select
            v-model="accountId"
            data-testid="preference-account"
            required
            class="rounded border bg-transparent p-2"
          >
            <option value="">Choose an account</option>
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.name ?? 'Authorized account' }}
            </option>
          </select></label
        >
        <label class="grid gap-1 text-sm"
          >Preference expiry (UTC)<input
            v-model="expiresAt"
            type="datetime-local"
            required
            class="rounded border bg-transparent p-2"
        /></label>
      </fieldset>
      <p v-if="existing" class="text-xs text-gray-500">
        Updating the saved preference. Existing evaluations are not changed until reevaluated.
      </p>
      <UButton :disabled="busy || !categoryId || !accountId || !expiresAt" @click="save">{{
        busy ? 'Saving preference…' : 'Save approved payment preference'
      }}</UButton>
    </form>
    <p v-if="saved" role="status" class="mt-3">
      Approved preference saved. Evaluate again with no explicit or session account to apply the
      preferred route.
    </p>
    <section v-if="preferences?.items.length" class="mt-4">
      <h3 class="font-medium">Current preferences</h3>
      <ul class="mt-2 space-y-2 text-sm">
        <li v-for="item in preferences.items" :key="item.id">
          {{ categoryName(item.categoryId) }} → {{ accountName(item.accountId) }} · Expires
          {{ item.expiresAt
          }}<span v-if="Date.parse(item.expiresAt) <= Date.now()">
            · Expired — not a current route preference</span
          >
        </li>
      </ul>
    </section>
    <button v-if="error" type="button" class="mt-3 text-sm underline" @click="load">
      Reload payment preferences
    </button>
  </UCard>
</template>
<script setup lang="ts">
import type {
  PublicLiquidityAccount,
  PublicCategoryBacking,
  PublicLiquidityPreferences,
} from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
const props = defineProps<{
  accounts: PublicLiquidityAccount[];
  categories: PublicCategoryBacking[];
}>();
const preferences = ref<PublicLiquidityPreferences | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const categoryId = ref('');
const accountId = ref('');
const expiresAt = ref(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
const existing = computed(() =>
  preferences.value?.items.find((item) => item.categoryId === categoryId.value),
);
watch(
  categoryId,
  () => {
    accountId.value = existing.value?.accountId ?? '';
    expiresAt.value = (
      existing.value?.expiresAt ?? new Date(Date.now() + 86400000).toISOString()
    ).slice(0, 16);
    saved.value = false;
  },
  { flush: 'sync' },
);
function categoryName(id: string) {
  return props.categories.find((category) => category.id === id)?.name ?? 'Authorized category';
}
function accountName(id: string) {
  return props.accounts.find((account) => account.id === id)?.name ?? 'Authorized account';
}
async function load() {
  loading.value = true;
  error.value = '';
  preferences.value = null;
  try {
    preferences.value = await liquidityRequest<PublicLiquidityPreferences>(
      '/api/liquidity/preferences',
    );
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!preferences.value?.canManage || busy.value || !categoryId.value || !accountId.value) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    preferences.value = await liquidityRequest<PublicLiquidityPreferences>(
      '/api/liquidity/preferences',
      'PUT',
      {
        categoryId: categoryId.value,
        accountId: accountId.value,
        expectedVersion: existing.value?.version ?? 0,
        expiresAt: new Date(`${expiresAt.value}Z`).toISOString(),
      },
    );
    saved.value = true;
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
