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
        :catalog="catalog"
        @draft-state="draftDirty = $event"
        @saved="load"
      />
      <p v-if="session && draftDirty" role="status" class="mt-4 text-amber-700">
        Save and re-evaluate your cart before creating claims or completing this session.
      </p>
      <div v-else-if="session" class="mt-6 space-y-6">
        <ProspectiveClaimPanel :key="`${session.id}:${session.version}:claims`" :session="session" />
        <SessionCompletionPanel :key="`${session.id}:${session.version}:completion`" :session="session" />
      </div></template
  ></AnalysisPage>
</template>
<script setup lang="ts">
import type { PublicLiquidityView, PublicSpendSession } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '@/utils/liquidity-client';
definePageMeta({ layout: 'default' });
const route = useRoute();
const session = ref<PublicSpendSession | null>(null);
const catalog = ref<PublicLiquidityView | null>(null);
const draftDirty = ref(false);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
async function load() {
  loading.value = true;
  error.value = null;
  session.value = null;
  draftDirty.value = false;
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
