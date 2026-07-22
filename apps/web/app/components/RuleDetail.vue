<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
          Rule Details
        </h2>
        <div class="flex items-center gap-2">
          <UBadge
            :color="rule.inactive ? 'neutral' : 'success'"
            variant="solid"
            size="sm"
          >
            {{ rule.inactive ? 'Inactive' : 'Active' }}
          </UBadge>
          <span class="text-xs text-gray-400">#{{ rule.order }}</span>
        </div>
      </div>
    </template>

    <div class="space-y-4">
      <!-- Name -->
      <div>
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Name</h3>
        <p class="text-base font-semibold">{{ rule.name }}</p>
      </div>

      <!-- ID -->
      <div>
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">ID</h3>
        <p class="text-sm font-mono text-gray-600 dark:text-gray-400 break-all">{{ rule.id }}</p>
      </div>

      <!-- Order -->
      <div>
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Order</h3>
        <p class="text-sm">{{ rule.order }}</p>
      </div>

      <!-- Trigger conditions -->
      <div v-if="rule.trigger">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Trigger</h3>
        <pre class="mt-1 text-xs bg-gray-50 dark:bg-gray-800 rounded-md p-3 overflow-x-auto font-mono">{{ formatJson(rule.trigger) }}</pre>
      </div>

      <!-- Actions -->
      <div v-if="rule.actions">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Actions</h3>
        <pre class="mt-1 text-xs bg-gray-50 dark:bg-gray-800 rounded-md p-3 overflow-x-auto font-mono">{{ formatJson(rule.actions) }}</pre>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
export interface RuleShowResult {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly trigger: unknown;
  readonly actions: unknown;
  readonly inactive: boolean;
}

const props = defineProps<{
  rule: RuleShowResult;
}>();

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
</script>
