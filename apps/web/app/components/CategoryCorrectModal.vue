<template>
  <UModal :open="open" @close="onCancel">
    <template #content>
      <UCard>
        <template #header>
          <h2 class="font-semibold text-lg">
            Edit category — {{ item?.evidence.normalizedMerchant ?? '—' }}
          </h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Select a new category for this transaction.
          </p>
        </template>

        <div class="space-y-4">
          <!-- Current category display -->
          <div>
            <span class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Current</span>
            <p class="font-medium mt-0.5">{{ displayName(item?.evidence.currentCategory) }}</p>
            <p v-if="showChangePreview" class="text-xs text-gray-400 mt-0.5">
              {{ displayName(item?.evidence.changePreview.fromCategory) }}
              &rarr;
              {{ displayName(item?.evidence.changePreview.toCategory) }}
              <span v-if="item?.evidence.changePreview.affectsEnvelope"> (affects envelope)</span>
            </p>
          </div>

          <!-- Searchable category selector -->
          <div>
            <span class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Change to</span>
            <div class="mt-1">
              <USelectMenu
                v-model="selected"
                :items="categoryItems"
                value-key="id"
                label-key="label"
                placeholder="Search categories…"
                searchable
                searchable-placeholder="Type to filter…"
                class="w-full"
                size="lg"
              />
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              label="Cancel"
              color="neutral"
              variant="ghost"
              @click="onCancel"
            />
            <UButton
              label="Confirm"
              color="primary"
              variant="solid"
              :disabled="!selected"
              @click="onConfirm"
            />
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { ReviewQueueItem } from '../../src/review';

const props = defineProps<{
  open: boolean;
  item: ReviewQueueItem | null;
}>();

const emit = defineEmits<{
  confirm: [categoryId: string];
  cancel: [];
}>();

const selected = ref<string | undefined>(undefined);

/** Return a human-friendly name for a category ID, falling back to the raw ID. */
function displayName(id: string | undefined | null): string {
  if (!id) return '—';
  return props.item?.evidence.categoryNames?.[id] ?? id;
}

/** Build a deduplicated, prioritised list of category options for the dropdown. */
const categoryItems = computed(() => {
  if (!props.item) return [];
  const ev = props.item.evidence;
  const seen = new Set<string>();
  const items: { id: string; label: string }[] = [];

  function add(id: string, hint?: string) {
    if (!id || id === '—' || seen.has(id)) return;
    seen.add(id);
    const name = displayName(id);
    const label = name !== id ? `${name} (${id})` : id;
    items.push({ id, label: hint ? `${label} — ${hint}` : label });
  }

  add(ev.suggestedCategory, 'suggested');
  add(ev.currentCategory, 'current');
  for (const alt of ev.alternatives) {
    add(alt);
  }
  return items;
});

const showChangePreview = computed(() => {
  if (!props.item) return false;
  const cp = props.item.evidence.changePreview;
  return cp.fromCategory !== cp.toCategory;
});

/** Reset selection when the modal opens. */
watch(() => props.open, (open) => {
  if (open) {
    selected.value = props.item?.evidence.suggestedCategory ?? undefined;
  }
});

function onConfirm() {
  if (selected.value) emit('confirm', selected.value);
}

function onCancel() {
  emit('cancel');
}
</script>
