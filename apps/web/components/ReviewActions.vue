<template>
  <UCard>
    <div class="flex flex-wrap items-center gap-2">
      <!-- Single-item actions (always visible) -->
      <UButtonGroup size="md">
        <UButton
          label="Approve"
          color="success"
          variant="solid"
          icon="i-heroicons-check-circle"
          :disabled="!hasCurrent || loading"
          @click="$emit('approve')"
        />
        <UButton
          label="Reject"
          color="error"
          variant="solid"
          icon="i-heroicons-x-circle"
          :disabled="!hasCurrent || loading"
          @click="$emit('reject')"
        />
        <UButton
          label="Skip"
          color="neutral"
          variant="solid"
          icon="i-heroicons-forward"
          :disabled="!hasCurrent || loading"
          @click="$emit('skip')"
        />
        <UButton
          label="Correct"
          color="warning"
          variant="solid"
          icon="i-heroicons-pencil-square"
          :disabled="!hasCurrent || loading"
          @click="$emit('correct')"
        />
      </UButtonGroup>

      <USeparator orientation="vertical" class="h-6" />

      <!-- Undo -->
      <UButton
        label="Undo"
        color="neutral"
        variant="ghost"
        icon="i-heroicons-arrow-uturn-left"
        :disabled="loading"
        @click="$emit('undo')"
      />

      <USeparator orientation="vertical" class="h-6" />

      <!-- Bulk actions (visible when selection active) -->
      <template v-if="hasSelection">
        <UButtonGroup size="sm">
          <UButton
            label="Bulk approve"
            color="success"
            variant="outline"
            :disabled="loading"
            @click="$emit('bulk-approve')"
          />
          <UButton
            label="Bulk reject"
            color="error"
            variant="outline"
            :disabled="loading"
            @click="$emit('bulk-reject')"
          />
          <UButton
            label="Bulk skip"
            color="neutral"
            variant="outline"
            :disabled="loading"
            @click="$emit('bulk-skip')"
          />
        </UButtonGroup>
      </template>

      <div class="flex-1" />

      <!-- Utility actions -->
      <UButton
        label="Refresh"
        color="neutral"
        variant="ghost"
        icon="i-heroicons-arrow-path"
        size="sm"
        :disabled="loading"
        @click="$emit('refresh')"
      />
    </div>
  </UCard>
</template>

<script setup lang="ts">
defineProps<{
  hasCurrent: boolean;
  hasSelection: boolean;
  loading: boolean;
  metrics: unknown;
}>();

defineEmits<{
  approve: [];
  correct: [category?: string];
  reject: [];
  skip: [];
  undo: [];
  'bulk-approve': [];
  'bulk-reject': [];
  'bulk-skip': [];
  refresh: [];
  'reset-metrics': [];
}>();
</script>
