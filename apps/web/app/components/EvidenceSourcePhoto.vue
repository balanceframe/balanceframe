<template>
  <div v-if="['image/jpeg', 'image/png'].includes(mediaType)" class="space-y-2">
    <button
      type="button"
      :disabled="busy"
      class="rounded border px-3 py-2"
      @click="preview ? clear() : load()"
    >
      {{ preview ? 'Close original photo' : busy ? 'Loading original…' : 'View original photo' }}
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <img
      v-if="preview"
      :src="preview"
      alt="Original receipt photo"
      class="max-h-screen max-w-full rounded border object-contain"
    />
  </div>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { z } from 'zod';
import { evidenceRequest } from '../utils/transaction-evidence-client';
const props = defineProps<{ documentId: string; mediaType: string }>();
const preview = ref('');
const busy = ref(false);
const error = ref('');
let generation = 0;
const raw = z.object({
  contentBase64: z
    .string()
    .max(14 * 1024 * 1024)
    .nullable(),
});
function clear() {
  generation++;
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = '';
  busy.value = false;
  error.value = '';
}
watch(() => [props.documentId, props.mediaType], clear);
onUnmounted(clear);
async function load() {
  if (busy.value || !['image/jpeg', 'image/png'].includes(props.mediaType)) return;
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  try {
    const result = await evidenceRequest(
      `/api/evidence/${encodeURIComponent(props.documentId)}/raw`,
      raw,
    );
    if (generation !== ticket) return;
    if (
      !result.contentBase64 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.contentBase64)
    )
      throw new Error('Source bytes unavailable');
    const binary = atob(result.contentBase64);
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    preview.value = URL.createObjectURL(new Blob([bytes], { type: props.mediaType }));
  } catch {
    if (generation === ticket)
      error.value =
        'Original photo unavailable. Raw-source permission, retention, or source state may have changed.';
  } finally {
    if (generation === ticket) busy.value = false;
  }
}
</script>
