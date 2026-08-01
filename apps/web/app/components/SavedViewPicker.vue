<template>
  <div class="flex flex-wrap items-center gap-2" data-testid="saved-view-picker">
    <label class="text-xs font-medium text-gray-500 dark:text-gray-400" for="saved-view-select">View:</label>
    <select
      id="saved-view-select"
      :value="selectedViewId"
      :disabled="loading || !views.length"
      class="min-w-[160px] rounded border px-2 py-1 text-sm"
      @change="onSelect"
    >
      <option value="">Select a saved view</option>
      <option v-for="view in views" :key="view.viewId" :value="view.viewId">
        {{ view.name }}
      </option>
    </select>
    <span v-if="loading" role="status" class="text-xs text-gray-500">Loading saved views…</span>
    <span v-else-if="error" role="alert" class="text-xs text-red-600">{{ error.message }}</span>
    <button v-if="error?.retryable" type="button" class="text-xs underline" aria-label="Retry saved views" @click="emit('retry')">Retry</button>
    <template v-if="selectedView">
      <button type="button" class="text-xs underline" @click="emit('rename', selectedView.viewId)">Rename</button>
      <button type="button" class="text-xs underline" @click="emit('update', selectedView.viewId)">Update</button>
      <button type="button" class="text-xs underline" @click="emit('duplicate', selectedView.viewId)">Duplicate</button>
      <button type="button" class="text-xs text-red-600 underline" @click="emit('delete', selectedView.viewId)">Delete</button>
      <button type="button" class="text-xs underline" @click="emit('last-used', selectedView.viewId)">Mark used</button>
    </template>
    <button v-if="showSave" type="button" class="text-xs underline" aria-label="Save current view" @click="emitCreate">Save</button>
    <span v-if="selectedView" class="text-xs text-gray-500">
      {{ selectedView.viewType }} · scope: {{ scopeLabel }} · sort: {{ selectedView.sort || 'default' }}
    </span>
  </div>
</template>

<script setup lang="ts">
interface ViewOption {
  viewId: string;
  name: string;
  viewType: string;
  scope?: Record<string, unknown>;
  sort?: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
}

const props = withDefaults(defineProps<{
  views: ViewOption[];
  showSave?: boolean;
  selectedViewId?: string;
  loading?: boolean;
  error?: { code: string; message: string; retryable?: boolean } | null;
}>(), { selectedViewId: '', loading: false, error: null });

const emit = defineEmits<{
  select: [viewId: string];
  create: [];
  save: [];
  rename: [viewId: string];
  update: [viewId: string];
  duplicate: [viewId: string];
  delete: [viewId: string];
  'last-used': [viewId: string];
  retry: [];
}>();

const selectedView = computed(() => props.views.find(view => view.viewId === props.selectedViewId));
const scopeLabel = computed(() => selectedView.value?.scope && Object.keys(selectedView.value.scope).length
  ? JSON.stringify(selectedView.value.scope)
  : 'authorized');

function onSelect(event: Event) {
  emit('select', (event.target as HTMLSelectElement).value);
}

function emitCreate() {
  emit('create');
  emit('save');
}
</script>

