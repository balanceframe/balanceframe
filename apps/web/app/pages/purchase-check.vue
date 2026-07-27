<template>
  <AnalysisPage title="Purchase Check" :loading="loading" :error="error">
    <template #content>
      <div class="mb-4">
        <UFormGroup label="Category" class="mb-3">
          <UInput v-model="categoryId" placeholder="e.g. cg" />
        </UFormGroup>
        <UFormGroup label="Amount (minor units)" class="mb-3">
          <UInput v-model="amountStr" placeholder="e.g. 5000 for $50.00" type="number" />
        </UFormGroup>
        <UButton :disabled="!canEvaluate" @click="evaluate">Evaluate</UButton>
      </div>

      <div v-if="result" class="mt-4">
        <UCard>
          <template #header>
            <span class="font-semibold">Result</span>
          </template>
          <p class="text-sm">Allowable: 
            <span :class="result.allowable ? 'text-emerald-600' : 'text-red-600'" class="font-medium">
              {{ result.allowable ? 'Yes' : 'No' }}
            </span>
          </p>
          <ReasonCodeList v-if="result.reasonCodes" :codes="result.reasonCodes" class="mt-2" />
          <p v-if="result.explanation" class="text-xs text-gray-500 mt-2">{{ result.explanation }}</p>
        </UCard>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' });

const loading = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const categoryId = ref('');
const amountStr = ref('');
const result = ref<{ allowable: boolean; reasonCodes?: string[]; explanation?: string } | null>(null);

const canEvaluate = computed(() => categoryId.value.trim() && amountStr.value.trim());

async function evaluate() {
  loading.value = true;
  error.value = null;
  result.value = null;
  try {
    const res = await $fetch<{ status: string; result: { allowable: boolean; reasonCodes?: string[]; explanation?: string } }>('/api/purchase/evaluate', {
      query: { categoryId: categoryId.value.trim(), amount: amountStr.value.trim() },
    });
    if (res.status === 'ok') result.value = res.result;
    else error.value = { code: 'EVAL_FAILED', message: 'Evaluation returned error.' };
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally {
    loading.value = false;
  }
}
</script>
