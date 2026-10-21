<template>
  <section aria-label="Spend Session evidence" class="space-y-2 rounded border p-3 text-sm">
    <p>
      Keep these saved items with your transaction evidence and compare them with a later receipt.
      Planned amounts remain pending; payment and completion use their existing review workflow.
    </p>
    <button type="button" :disabled="busy" class="rounded border px-3 py-2" @click="importSession">
      {{ busy ? 'Importing saved items…' : 'Use saved items as evidence' }}
    </button>
    <p v-if="imported" role="status">
      Saved items imported as pending evidence.
      <NuxtLink to="/review#transaction-evidence" class="underline"
        >Review transaction evidence</NuxtLink
      >
    </p>
    <SpendSessionReceiptComparison v-if="importedDocumentId" :document-id="importedDocumentId" />
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import SpendSessionReceiptComparison from './SpendSessionReceiptComparison.vue';
import { z } from 'zod';
import { evidenceRequest } from '../utils/transaction-evidence-client';
const props = defineProps<{ sessionId: string; version: number }>();
const busy = ref(false);
const imported = ref(false);
const importedDocumentId = ref('');
const error = ref('');
let generation = 0;
const receipt = z.object({ document: z.object({ id: z.string().min(1) }), duplicate: z.boolean() });
function clear() {
  generation++;
  busy.value = false;
  imported.value = false;
  importedDocumentId.value = '';
  error.value = '';
}
watch(() => [props.sessionId, props.version], clear);
onUnmounted(clear);
async function importSession() {
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  imported.value = false;
  importedDocumentId.value = '';
  try {
    const result = await evidenceRequest('/api/evidence/spend-session', receipt, 'POST', {
      sessionId: props.sessionId,
      expectedVersion: props.version,
    });
    if (generation === ticket) {
      imported.value = true;
      importedDocumentId.value = result.document.id;
    }
  } catch {
    if (generation === ticket)
      error.value =
        'Import unavailable. Reload the saved session and current evidence permissions before retrying.';
  } finally {
    if (generation === ticket) busy.value = false;
  }
}
</script>
