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
            <span
              class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold"
              >Current</span
            >
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
            <span
              class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold"
              >Change to</span
            >
            <p
              v-if="categoriesError"
              role="alert"
              class="mt-1 text-sm text-red-600 dark:text-red-400"
            >
              {{ categoriesError }}
            </p>
            <p
              v-else-if="categoriesLoading"
              role="status"
              class="mt-1 text-sm text-gray-500 dark:text-gray-400"
            >
              Loading categories…
            </p>
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
                :disabled="submitting || categoriesLoading"
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
              :disabled="submitting"
              @click="onCancel"
            />
            <UButton
              ref="confirmButton"
              label="Confirm"
              color="primary"
              variant="solid"
              :loading="submitting"
              :disabled="submitting || !selected"
              @click="onConfirm"
            />
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import type { ReviewQueueItem } from '../../src/review';

interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly groupName: string | null;
  readonly isIncome: boolean;
}

const props = defineProps<{
  open: boolean;
  item: ReviewQueueItem | null;
  submitting?: boolean;
  categories?: readonly CategoryOption[];
  categoriesLoading?: boolean;
  categoriesError?: string | null;
}>();

const emit = defineEmits<{
  confirm: [categoryId: string];
  cancel: [];
}>();

const selected = ref<string | undefined>(undefined);
const confirmButton = ref<unknown>(null);
const categoryById = computed(
  () => new Map((props.categories ?? []).map((category) => [category.id, category])),
);

function focusConfirmButton(): void {
  const target = confirmButton.value;
  if (target instanceof HTMLElement) {
    target.focus();
    return;
  }
  if (typeof target === 'object' && target !== null && '$el' in target) {
    const { $el } = target;
    if ($el instanceof HTMLElement) $el.focus();
  }
}

/** Return a human-friendly name for a category ID, falling back to the raw ID. */
function displayName(id: string | undefined | null): string {
  if (!id) return '—';
  return categoryById.value.get(id)?.name ?? props.item?.evidence.categoryNames?.[id] ?? id;
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
    const category = categoryById.value.get(id);
    const name = category?.name ?? displayName(id);
    const label = category?.groupName ? `${name} — ${category.groupName}` : name;
    items.push({ id, label: hint ? `${label} — ${hint}` : label });
  }

  add(ev.suggestedCategory, 'suggested');
  add(ev.currentCategory, 'current');
  for (const alt of ev.alternatives) {
    add(alt);
  }
  for (const category of props.categories ?? []) {
    add(category.id);
  }
  return items;
});

const showChangePreview = computed(() => {
  if (!props.item) return false;
  const cp = props.item.evidence.changePreview;
  return cp.fromCategory !== cp.toCategory;
});

/** Reset selection when the modal opens. */
watch(
  () => props.open,
  (open) => {
    if (open) {
      const suggested = props.item?.evidence.suggestedCategory;
      selected.value = categoryItems.value.some((item) => item.id === suggested)
        ? suggested
        : undefined;
    }
  },
);

watch(
  () => props.submitting,
  async (submitting, wasSubmitting) => {
    if (wasSubmitting && !submitting && props.open) {
      await nextTick();
      focusConfirmButton();
    }
  },
);

function onConfirm() {
  if (!props.submitting && selected.value) emit('confirm', selected.value);
}

function onCancel() {
  if (!props.submitting) emit('cancel');
}
</script>
