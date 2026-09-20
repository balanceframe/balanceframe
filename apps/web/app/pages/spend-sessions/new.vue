<template>
  <AnalysisPage title="New Spend Session" :loading="loading" :error="error"
    ><template #error-actions
      ><button type="button" class="underline" @click="load">Retry loading</button></template
    ><template #content
      ><NuxtLink to="/purchase-check" class="mb-4 inline-block text-sm underline"
        >Back to purchase check</NuxtLink
      ><SpendSessionEditor v-if="catalog" :catalog="catalog" /><button
        v-if="error"
        type="button"
        class="underline"
        @click="load"
      >
        Retry
      </button></template
    ></AnalysisPage
  >
</template>
<script setup lang="ts">
import type { PublicLiquidityView } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../../utils/liquidity-client';
definePageMeta({ layout: 'default' });
const catalog = ref<PublicLiquidityView | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
async function load() {
  loading.value = true;
  error.value = null;
  try {
    catalog.value = await liquidityRequest<PublicLiquidityView>('/api/liquidity/spendability');
  } catch (e) {
    error.value = { code: 'SESSION_UNAVAILABLE', message: liquidityError(e) };
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
