<template>
  <AnalysisPage title="Transfer detail" :loading="loading" :error="error"
    ><template #error-actions
      ><button type="button" class="underline" @click="load">Retry loading</button></template
    ><template #content
      ><NuxtLink to="/" class="mb-4 inline-block text-sm underline">Back to attention</NuxtLink
      ><TransferWorkflow v-if="detail" :detail="detail" /><button
        v-if="error"
        type="button"
        class="underline"
        @click="load"
      >
        Retry transfer
      </button></template
    ></AnalysisPage
  >
</template>
<script setup lang="ts">
import type { PublicTransferDetail } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../../utils/liquidity-client';
definePageMeta({ layout: 'default' });
const route = useRoute();
const detail = ref<PublicTransferDetail | null>(null);
const loading = ref(true);
const error = ref<{ code: string; message: string } | null>(null);
async function load() {
  loading.value = true;
  error.value = null;
  detail.value = null;
  try {
    detail.value = await liquidityRequest<PublicTransferDetail>(
      `/api/transfer/${encodeURIComponent(String(route.params.id))}`,
    );
  } catch (e) {
    error.value = { code: 'TRANSFER_UNAVAILABLE', message: liquidityError(e) };
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
