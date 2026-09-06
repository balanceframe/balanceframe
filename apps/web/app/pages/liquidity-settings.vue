<template>
  <AnalysisPage title="Liquidity settings" :loading="loading" :error="error"
    ><template #error-actions
      ><button type="button" class="underline" @click="load">Retry loading</button></template
    ><template #content
      ><div class="mb-4 flex flex-wrap gap-4 text-sm">
        <NuxtLink to="/liquidity" class="underline">Back to current capacity and backing</NuxtLink
        ><button type="button" class="underline" @click="load">Reload configuration</button>
      </div>
      <div v-if="configuration?.canConfigure" class="space-y-6">
        <LiquidityPolicyEditor
          :key="`policy:${generation}`"
          :configuration="configuration"
          @saved="configuration = $event"
        /><LiquidityObservationEditor
          :key="`observations:${generation}`"
          :configuration="configuration"
          @saved="configuration = $event"
        /><LiquidityPreferenceEditor
          :key="`preferences:${generation}`"
          :accounts="configuration.accounts"
          :categories="configuration.categories"
        /><LiquidityGrantEditor />
      </div>
      <InsufficientDataPanel
        v-else-if="configuration"
        reason="Only a currently authorized budget owner can configure account policy and grants. Ask an authorized holder."
      /> </template
  ></AnalysisPage>
</template>
<script setup lang="ts">
import type { PublicLiquidityConfiguration } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
definePageMeta({ layout: 'default', path: '/liquidity/settings' });
const configuration = ref<PublicLiquidityConfiguration | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
const generation = ref(0);
async function load() {
  loading.value = true;
  error.value = null;
  configuration.value = null;
  try {
    configuration.value =
      await liquidityRequest<PublicLiquidityConfiguration>('/api/liquidity/policy');
    generation.value += 1;
  } catch (e) {
    error.value = { code: 'CONFIGURATION_UNAVAILABLE', message: liquidityError(e) };
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
