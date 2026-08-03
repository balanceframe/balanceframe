<template>
  <UCard class="finding-card">
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-start gap-2 min-w-0">
        <span class="shrink-0 mt-0.5" :class="severityIcon" :style="{ color: severityColor }" />
        <div class="min-w-0">
          <h4 class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{{ finding.title }}</h4>
          <p v-if="finding.category" class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ finding.category }}</p>
        </div>
      </div>
      <div v-if="finding.amount" class="shrink-0">
        <SemanticAmount :amount="finding.amount" />
      </div>
    </div>

    <div v-if="finding.reasonCodes?.length" class="mt-2">
      <ReasonCodeList :codes="finding.reasonCodes" />
    </div>

    <div v-if="finding.detail" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
      {{ finding.detail }}
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { Amount } from './types';

interface Finding {
  title: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  category?: string;
  amount?: Amount;
  reasonCodes?: string[];
  detail?: string;
}

const props = defineProps<{
  finding: Finding;
}>();

const severityIcon = computed(() => {
  const map: Record<string, string> = {
    critical: 'i-heroicons-x-circle',
    warning: 'i-heroicons-exclamation-triangle',
    info: 'i-heroicons-information-circle',
    success: 'i-heroicons-check-circle',
  };
  return map[props.finding.severity] || 'i-heroicons-information-circle';
});

const severityColor = computed(() => {
  const map: Record<string, string> = {
    critical: '#dc2626',
    warning: '#d97706',
    info: '#2563eb',
    success: '#16a34a',
  };
  return map[props.finding.severity] || '#6b7280';
});
</script>
