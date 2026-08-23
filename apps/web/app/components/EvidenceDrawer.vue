<template>
  <div>
    <UButton
      variant="ghost"
      size="sm"
      :icon="open ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
      :aria-label="open ? 'Hide evidence summary' : 'Show evidence summary'"
      :aria-expanded="String(open)"
      :aria-controls="contentId"
      @click="toggleSummary"
      @keydown.enter.prevent="toggleSummary"
    >
      {{ open ? 'Hide' : 'Show' }} evidence
      <span class="text-gray-500 dark:text-gray-400">({{ evidenceCount }})</span>
    </UButton>

    <div
      v-if="open"
      :id="contentId"
      role="region"
      aria-label="Evidence summary"
      class="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800"
    >
      <template v-if="references !== undefined">
        <p v-if="references.length === 0" class="italic text-gray-500 dark:text-gray-400">
          No evidence available.
        </p>
        <template v-else>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {{ referenceTotalLabel }}
          </p>
          <ul class="mt-2 space-y-1.5" aria-label="Evidence kinds">
            <li
              v-for="summaryItem in referenceSummaries"
              :key="summaryItem.key"
              :aria-label="referenceSummaryAriaLabel(summaryItem)"
              class="flex items-center justify-between gap-3 text-gray-700 dark:text-gray-300"
            >
              <span class="font-medium">{{ summaryItem.label }} evidence</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">
                {{ referenceCountLabel(summaryItem.count) }}
              </span>
            </li>
          </ul>
        </template>
      </template>

      <template v-else>
        <p v-if="evidence.length === 0" class="italic text-gray-500 dark:text-gray-400">
          No evidence available.
        </p>
        <template v-else>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {{ evidence.length }} evidence {{ evidence.length === 1 ? 'item' : 'items' }}
          </p>
          <ul class="mt-2 space-y-2">
            <li
              v-for="(item, index) in evidence"
              :key="index"
              class="flex items-start gap-2 text-gray-700 dark:text-gray-300"
            >
              <span class="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true">
                •
              </span>
              <div>
                <p>{{ item.description }}</p>
                <p v-if="item.detail" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {{ item.detail }}
                </p>
              </div>
            </li>
          </ul>
        </template>
      </template>

      <div
        v-if="hasTechnicalDetails"
        class="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700"
      >
        <UButton
          variant="ghost"
          size="xs"
          :icon="technicalOpen ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
          :aria-label="
            technicalOpen ? 'Hide technical evidence details' : 'Show technical evidence details'
          "
          :aria-expanded="String(technicalOpen)"
          :aria-controls="technicalContentId"
          @click="technicalOpen = !technicalOpen"
        >
          Technical details
        </UButton>

        <div
          v-if="technicalOpen"
          :id="technicalContentId"
          role="region"
          aria-label="Technical evidence details"
          class="mt-2"
        >
          <dl class="space-y-1 text-xs text-gray-500 dark:text-gray-400">
            <div v-for="(reference, index) in technicalReferences" :key="index">
              <dt class="inline font-medium">{{ formatIdentifier(reference.kind) }} reference:</dt>
              {{ ' ' }}
              <dd class="inline break-all font-mono">{{ reference.evidenceId }}</dd>
            </div>
            <div v-if="snapshotId">
              <dt class="inline font-medium">Snapshot:</dt>
              {{ ' ' }}
              <dd class="inline break-all font-mono">{{ snapshotId }}</dd>
            </div>
            <div v-if="policyVersion">
              <dt class="inline font-medium">Policy:</dt>
              {{ ' ' }}
              <dd class="inline break-all font-mono">{{ policyVersion }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <p v-if="fallbackMessage" class="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {{ fallbackMessage }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EvidenceReference } from '@balanceframe/protocol-generated';
import { computed, ref, useId } from 'vue';

interface EvidenceItem {
  description: string;
  detail?: string;
}

interface ReferenceSummary {
  key: string;
  label: string;
  count: number;
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
const technicalOpen = ref(false);
const contentId = `evidence-drawer-${useId()}`;
const technicalContentId = `${contentId}-technical`;

const evidenceCount = computed(() => props.references?.length ?? props.evidence.length);

const referenceSummaries = computed<ReferenceSummary[]>(() => {
  if (props.references === undefined) return [];

  const summaries = new Map<string, ReferenceSummary>();
  for (const reference of props.references) {
    const restricted = !reference.authorized || reference.redaction === 'redacted';
    const key = restricted ? 'restricted' : reference.kind;
    const existing = summaries.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    summaries.set(key, {
      key,
      label: restricted ? 'Restricted' : formatIdentifier(reference.kind),
      count: 1,
    });
  }
  return [...summaries.values()];
});

const technicalReferences = computed(
  () =>
    props.references?.filter(
      (reference) => reference.authorized && reference.redaction !== 'redacted',
    ) ?? [],
);

const hasTechnicalDetails = computed(
  () =>
    technicalReferences.value.length > 0 ||
    Boolean(props.snapshotId) ||
    Boolean(props.policyVersion),
);

const referenceTotalLabel = computed(() => referenceCountLabel(props.references?.length ?? 0));

function toggleSummary(): void {
  open.value = !open.value;
  if (!open.value) technicalOpen.value = false;
}

function referenceCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'reference' : 'references'}`;
}

function referenceSummaryAriaLabel(summary: ReferenceSummary): string {
  return `${summary.label} evidence: ${referenceCountLabel(summary.count)}`;
}

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Evidence';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}
</script>
