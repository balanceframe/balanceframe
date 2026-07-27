<template>
  <UContainer class="py-6">
    <!-- Header with title and actions -->
    <div class="flex items-center justify-between mb-6">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-900 dark:text-white">{{ title }}</h1>
        <FreshnessBanner v-if="freshness" :freshness="freshness" />
      </div>
      <div class="flex items-center gap-2">
        <SavedViewPicker
          v-if="views"
          :views="views"
          :show-save="true"
          @select="handleViewSelect"
          @save="handleViewSave"
        />
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-2xl text-gray-400" />
      <span class="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading...</span>
    </div>

    <!-- Error state -->
    <UAlert
      v-else-if="error"
      :title="error.code"
      :description="error.message"
      color="error"
      variant="soft"
      class="mb-4"
    />

    <!-- Insufficient data -->
    <InsufficientDataPanel v-else-if="insufficientData" :reason="insufficientReason" />

    <!-- Default slot for page content -->
    <slot v-else name="content" />

    <!-- Fallback empty state -->
    <div v-if="!loading && !error && !$slots.content && !insufficientData"
      class="text-center py-12 text-gray-400 dark:text-gray-500 text-sm">
      No data available.
    </div>
  </UContainer>
</template>

<script setup lang="ts">
interface ViewOption {
  viewId: string;
  name: string;
  viewType: string;
}

interface Freshness {
  isStale: boolean;
  lastSync: string | null;
  label: string;
}

interface ErrorInfo {
  code: string;
  message: string;
}

defineProps<{
  title: string;
  loading?: boolean;
  error?: ErrorInfo | null;
  freshness?: Freshness | null;
  views?: ViewOption[];
  insufficientData?: boolean;
  insufficientReason?: string;
}>();

const emit = defineEmits<{
  viewSelect: [viewId: string];
  viewSave: [];
}>();

function handleViewSelect(viewId: string) {
  emit('viewSelect', viewId);
}

function handleViewSave() {
  emit('viewSave');
}
</script>
