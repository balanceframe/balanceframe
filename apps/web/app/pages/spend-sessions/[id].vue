<template>
  <AnalysisPage title="Spend Session" :loading="loading" :error="error"
    ><template #error-actions
      ><button type="button" class="underline" @click="load">Retry loading</button></template
    ><template #content
      ><div class="mb-4 flex gap-4">
        <NuxtLink to="/purchase-check" class="text-sm underline">Purchase check</NuxtLink
        ><button type="button" class="text-sm underline" @click="load">Reload session</button>
      </div>
      <SpendSessionEditor
        v-if="session && catalog"
        :key="`${session.id}:${session.version}`"
        :session="session"
        :catalog="catalog" /></template
  ></AnalysisPage>
</template>
<script setup lang="ts">
import type { PublicLiquidityView, PublicSpendSession } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../../utils/liquidity-client';
definePageMeta({ layout: 'default' });
const route = useRoute();
const session = ref<PublicSpendSession | null>(null);
const catalog = ref<PublicLiquidityView | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
async function load() {
  loading.value = true;
  error.value = null;
  session.value = null;
  try {
    const [detail, view] = await Promise.all([
      liquidityRequest<PublicSpendSession>(
        `/api/spend-sessions/${encodeURIComponent(String(route.params.id))}`,
      ),
      liquidityRequest<PublicLiquidityView>('/api/liquidity/spendability'),
    ]);
    session.value = detail;
    catalog.value = view;
  } catch (e) {
    error.value = { code: 'SESSION_UNAVAILABLE', message: liquidityError(e) };
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
