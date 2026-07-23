<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
          Rules
        </h2>
        <UBadge
          v-if="loading"
          color="warning"
          variant="soft"
          label="Loading..."
        />
        <UBadge
          v-else
          color="neutral"
          variant="solid"
          size="sm"
          :label="`${items.length} rules`"
        />
      </div>
    </template>

    <div v-if="items.length === 0 && !loading" class="text-center py-8">
      <p class="text-gray-500 dark:text-gray-400">
        No rules configured.
      </p>
    </div>

    <div v-else class="space-y-1 max-h-96 overflow-y-auto">
      <button
        v-for="rule in items"
        :key="rule.id"
        :class="listItemClass(rule.id)"
        @click="$emit('select', rule.id)"
        :aria-current="rule.id === selectedId ? 'true' : undefined"
      >
        <div class="flex items-center justify-between min-w-0">
          <span class="truncate text-sm font-medium">
            {{ rule.name }}
          </span>
          <div class="flex items-center gap-2 shrink-0 ml-2">
            <span class="text-xs text-gray-400">#{{ rule.order }}</span>
            <UBadge
              :color="rule.inactive ? 'neutral' : 'success'"
              variant="solid"
              size="xs"
            >
              {{ rule.inactive ? 'Inactive' : 'Active' }}
            </UBadge>
          </div>
        </div>
      </button>
    </div>
  </UCard>
</template>

<script setup lang="ts">
export interface RuleListItem {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly inactive: boolean;
}

const props = defineProps<{
  items: readonly RuleListItem[];
  selectedId: string | null;
  loading: boolean;
}>();

defineEmits<{
  select: [id: string];
}>();

function listItemClass(id: string): Record<string, boolean> {
  return {
    'w-full text-left px-3 py-2 rounded-md transition-colors text-sm': true,
    'bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-700': props.selectedId === id,
    'hover:bg-neutral-50 dark:hover:bg-neutral-800/50': props.selectedId !== id,
  };
}
</script>
