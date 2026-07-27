<template>
  <div>
    <UButton
      variant="ghost"
      size="sm"
      :icon="open ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-up'"
      @click="open = !open"
    >
      {{ open ? 'Hide' : 'Show' }} evidence
    </UButton>

    <div v-if="open" class="mt-2 p-3 bg-gray-50 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 text-sm">
      <div v-if="(evidence?.length ?? 0) === 0" class="text-gray-400 dark:text-gray-500 italic">
        No evidence available.
      </div>
      <ul v-else class="space-y-2">
        <li v-for="(item, i) in evidence" :key="i" class="flex items-start gap-2">
          <span class="text-gray-400 dark:text-gray-500 mt-0.5 shrink-0">&#8226;</span>
          <div>
            <p class="text-gray-700 dark:text-gray-300">{{ item.description }}</p>
            <p v-if="item.detail" class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{{ item.detail }}</p>
          </div>
        </li>
      </ul>
    </div>
  </div>

  <div v-if="open" class="mt-2 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-md border border-gray-200 dark:border-gray-700">
    <p class="text-xs text-gray-400 dark:text-gray-500">{{ fallbackMessage }}</p>
  </div>
</template>

<script setup lang="ts">
interface EvidenceItem {
  description: string;
  detail?: string;
}

const props = defineProps<{
  evidence?: EvidenceItem[];
  fallbackMessage?: string;
}>();

const open = ref(false);
</script>
