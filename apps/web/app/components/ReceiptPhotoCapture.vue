<template>
  <div class="space-y-2 sm:col-span-2">
    <label class="block font-medium"
      >Take a receipt photo or choose an image
      <input
        ref="control"
        data-testid="receipt-camera"
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        :disabled="disabled"
        class="mt-2 block w-full rounded border p-3"
        @change="select"
      />
    </label>
    <p>
      Keep the full receipt in focus. JPEG or PNG, up to 5 MiB. Photos remain untrusted evidence
      until reviewed; importing a photo never authorizes a payment.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <img
      v-if="preview"
      :src="preview"
      alt="Selected receipt preview"
      class="max-h-96 max-w-full rounded border object-contain"
    />
  </div>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
const props = defineProps<{ disabled: boolean; resetKey: number }>();
const emit = defineEmits<{ selected: [file: File]; cleared: [] }>();
const control = ref<HTMLInputElement | null>(null);
const preview = ref('');
const error = ref('');
function clear() {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = '';
  error.value = '';
  if (control.value) control.value.value = '';
}
watch(() => props.resetKey, clear);
onUnmounted(clear);
function select(event: Event) {
  if (props.disabled) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  clear();
  if (!file) {
    emit('cleared');
    return;
  }
  if (
    !['image/jpeg', 'image/png'].includes(file.type) ||
    file.size > 5 * 1024 * 1024 ||
    file.size === 0
  ) {
    emit('cleared');
    error.value =
      'Choose a JPEG or PNG photo of at most 5 MiB. Convert other image formats before uploading.';
    return;
  }
  preview.value = URL.createObjectURL(file);
  emit('selected', file);
}
</script>
