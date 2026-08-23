<template>
  <div>
    <UButton
      variant="ghost"
      size="sm"
      :icon="open ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
      :aria-expanded="String(open)"
      :aria-controls="contentId"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
    >
      {{ open ? 'Hide' : 'Show' }} evidence
    </UButton>

    <div
      v-if="open"
      :id="contentId"
      role="region"
      aria-label="Evidence"
      class="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800"
    >
      <template v-if="references !== undefined">
        <p v-if="references.length === 0" class="italic text-gray-400 dark:text-gray-500">
          No evidence available.
        </p>
        <ul v-else class="space-y-2">
          <li
            v-for="(reference, index) in references"
            :key="index"
            class="text-gray-700 dark:text-gray-300"
          >
            <template v-if="reference.authorized && reference.redaction !== 'redacted'">
              <span class="font-medium">{{ formatIdentifier(reference.kind) }}</span>
              <span
                class="mt-0.5 block break-all font-mono text-xs text-gray-500 dark:text-gray-400"
              >
                {{ reference.evidenceId }}
              </span>
            </template>
            <span v-else>Restricted evidence</span>
          </li>
        </ul>
      </template>

      <template v-else>
        <p v-if="evidence.length === 0" class="italic text-gray-400 dark:text-gray-500">
          No evidence available.
        </p>
        <ul v-else class="space-y-2">
          <li
            v-for="(item, index) in evidence"
            :key="index"
            class="flex items-start gap-2 text-gray-700 dark:text-gray-300"
          >
            <span class="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true"
              >•</span
            >
            <div>
              <p>{{ item.description }}</p>
              <p v-if="item.detail" class="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                {{ item.detail }}
              </p>
            </div>
          </li>
        </ul>
      </template>

      <dl
        v-if="snapshotId || policyVersion"
        class="mt-3 space-y-1 border-t border-gray-200 pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
      >
        <div v-if="snapshotId">
          <dt class="inline font-medium">Snapshot:</dt>
          <dd class="inline break-all">{{ snapshotId }}</dd>
        </div>
        <div v-if="policyVersion">
          <dt class="inline font-medium">Policy:</dt>
          <dd class="inline break-all">{{ policyVersion }}</dd>
        </div>
      </dl>

      <p v-if="fallbackMessage" class="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {{ fallbackMessage }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EvidenceReference } from '@balanceframe/protocol-generated';
import { ref, useId } from 'vue';

interface EvidenceItem {
  description: string;
  detail?: string;
}

const props = withDefaults(
  defineProps<{
    evidence?: EvidenceItem[];
    references?: EvidenceReference[];
    snapshotId?: string;
    policyVersion?: string;
    fallbackMessage?: string;
  }>(),
  {
    evidence: () => [],
  },
);

const open = ref(false);
const contentId = `evidence-drawer-${useId()}`;

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Evidence';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}
</script>
