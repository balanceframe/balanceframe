<template>
  <div class="flex items-center gap-2">
    <label class="text-xs font-medium text-gray-500 dark:text-gray-400">View:</label>
    <USelectMenu
      :items="views"
      option-attribute="name"
      value-attribute="viewId"
      size="sm"
      class="min-w-[160px]"
      @update:model-value="(val: ViewOption) => emit('select', val.viewId)"
    />
    <UButton
      v-if="showSave"
      variant="ghost"
      size="xs"
      icon="i-heroicons-bookmark"
      aria-label="Save current view"
      @click="emit('save')"
    />
  </div>
</template>

<script setup lang="ts">
interface ViewOption {
  viewId: string;
  name: string;
  viewType: string;
}

defineProps<{
  views: ViewOption[];
  showSave?: boolean;
}>();

const emit = defineEmits<{
  select: [viewId: string];
  save: [];
}>();
</script>
