<template>
  <AnalysisPage
    title="Reports"
    :loading="loading"
    :error="error"
    :freshness="freshness"
    :insufficient-data="!loading && !error && !hasData"
  >
    <template #content>
      <div class="space-y-6">
        <SavedViewPicker
          :views="savedViews"
          :selected-view-id="selectedViewId"
          :loading="viewsLoading"
          :error="viewsError"
          :show-save="true"
          @select="applyView"
          @create="createView"
          @rename="renameView"
          @update="updateView"
          @duplicate="duplicateView"
          @delete="deleteView"
          @last-used="markViewUsed"
          @retry="loadViews"
        />

        <!-- Report type selector -->
        <div class="mb-4 flex flex-wrap gap-2">
          <UButton v-for="rt in reportTypes" :key="rt.value" :variant="reportType === rt.value ? 'solid' : 'outline'" size="sm" @click="selectReport(rt.value)">
            {{ rt.label }}
          </UButton>
        </div>
        <!-- Generate form -->
        <div v-if="reportType" class="mb-4">
          <UFormGroup label="Month range">
            <UInput v-model="monthRange" placeholder="YYYY-MM or YYYY-MM:YYYY-MM" />
          </UFormGroup>
          <UButton class="mt-2" @click="generate">Generate</UButton>
        </div>

        <!-- Generated report result -->
        <div v-if="reportResult" class="mt-4">
          <UCard>
            <template #header>
              <span class="font-semibold">{{ reportResult.reportType }} Report</span>
            </template>
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="report-id">Report ID: {{ reportResult.reportId }}</p>
            <p v-if="reportResult.label" class="text-sm mt-1 text-gray-600 dark:text-gray-400">Label: {{ reportResult.label }}</p>
            <p v-if="reportResult.transactionCount" class="text-sm mt-1 text-gray-600 dark:text-gray-400">Transactions: {{ reportResult.transactionCount }}</p>
            <SemanticAmount v-if="reportResult.totalAmount" :amount="reportResult.totalAmount" class="mt-1" />
            <p v-if="reportResult.generatedAt" class="text-xs text-gray-400 dark:text-gray-500 mt-2">Generated: {{ reportResult.generatedAt }}</p>
            <div v-if="reportResult.tags && reportResult.tags.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="tag in reportResult.tags" :key="tag" class="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                {{ tag }}
              </span>
            </div>
          </UCard>
        </div>

        <!-- Report history -->
        <div v-if="historyEntries.length" class="mt-6">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Report History</h3>
          <AnalysisTable :columns="historyColumns" :rows="historyRows" />
        </div>

        <!-- Saved views -->
        <div v-if="savedViews.length" class="mt-6">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Saved Views</h3>
          <AnalysisTable :columns="viewColumns" :rows="viewRows" />
        </div>

        <!-- Empty state -->
        <div v-if="!hasData && !reportType" class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          Select a report type above to get started.
        </div>
      </div>
    </template>
  </AnalysisPage>
</template>

<script setup lang="ts">
import type { Amount } from '../components/types';

definePageMeta({ layout: 'default' });

interface Envelope<T> {
  schemaVersion: string;
  requestId: string;
  status: 'ok' | 'error';
  dataFreshness: { isStale: boolean; lastSync: string | null; label: string } | null;
  authorization: unknown;
  result: T | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

interface ReportGenerationResult {
  reportId: string;
  reportType: string;
  label: string;
  transactionCount: number;
  totalAmount: Amount;
  generatedAt: string;
  tags: string[];
}

interface ReportHistoryEntry {
  id: string;
  reportType: string;
  budgetId: string | null;
  generatedAt: string;
  label: string;
  isExpired: boolean;
}

interface SavedView {
  viewId: string;
  name: string;
  viewType: string;
  scope: Record<string, unknown>;
  sort?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
}

const loading = ref(true);
const error = ref<{ code: string; message: string; retryable?: boolean } | null>(null);
const freshness = ref<{ isStale: boolean; lastSync: string | null; label: string } | null>(null);
const reportType = ref('');
const monthRange = ref('');
const reportResult = ref<ReportGenerationResult | null>(null);
const historyEntries = ref<ReportHistoryEntry[]>([]);
const historyTotal = ref(0);
const savedViews = ref<SavedView[]>([]);
const selectedViewId = ref('');
const viewsLoading = ref(false);
const viewsError = ref<{ code: string; message: string; retryable?: boolean } | null>(null);

const hasData = computed(() => historyEntries.value.length > 0 || savedViews.value.length > 0 || reportResult.value !== null);

const reportTypes = [
  { label: 'Spending', value: 'spending' },
  { label: 'Income', value: 'income' },
  { label: 'Net Worth', value: 'net_worth' },
  { label: 'Category Breakdown', value: 'category_breakdown' },
  { label: 'Cash Flow', value: 'cash_flow' },
];

const historyColumns = [
  { key: 'label', label: 'Report' },
  { key: 'reportType', label: 'Type' },
  { key: 'generatedAt', label: 'Generated' },
  { key: 'isExpiredLabel', label: 'Status' },
];

const historyRows = computed(() =>
  historyEntries.value.map(h => ({
    label: h.label,
    reportType: h.reportType,
    generatedAt: h.generatedAt,
    isExpiredLabel: h.isExpired ? 'Expired' : 'Active',
  })),
);

const viewColumns = [
  { key: 'name', label: 'View' },
  { key: 'viewType', label: 'Type' },
  { key: 'scope', label: 'Authorized scope' },
  { key: 'sort', label: 'Sort' },
  { key: 'createdAt', label: 'Created' },
  { key: 'lastUsedAt', label: 'Last used' },
];

const viewRows = computed(() =>
  savedViews.value.map(v => ({
    viewId: v.viewId,
    name: v.name,
    viewType: v.viewType,
    scope: Object.keys(v.scope ?? {}).length ? JSON.stringify(v.scope) : 'authorized',
    sort: v.sort || 'default',
    createdAt: v.createdAt,
    lastUsedAt: v.lastUsedAt ?? 'Never',
  })),
);
function selectReport(val: string) { reportType.value = val; }

function promptValue(message: string, fallback: string): string | null {
  if (!import.meta.client) return fallback;
  const value = window.prompt(message, fallback);
  return value?.trim() || null;
}

async function mutateView(viewId: string, method: 'PATCH' | 'POST' | 'DELETE', url = `/api/reports/views/${viewId}`, body?: Record<string, unknown>) {
  viewsError.value = null;
  try {
    const res = await $fetch<Envelope<SavedView | { deleted: boolean }>>(url, { method, body });
    if (res.status !== 'ok' || !res.result) throw new Error(res.error?.message ?? 'Saved view action failed.');
    if (method === 'DELETE') {
      savedViews.value = savedViews.value.filter(view => view.viewId !== viewId);
      if (selectedViewId.value === viewId) selectedViewId.value = '';
    } else if ('viewId' in res.result) {
      const view = res.result as SavedView;
      const index = savedViews.value.findIndex(item => item.viewId === view.viewId);
      if (index >= 0) savedViews.value[index] = view;
      else savedViews.value.push(view);
      if (method === 'POST') selectedViewId.value = view.viewId;
    }
  } catch (e) {
    viewsError.value = { code: 'VIEW_ACTION_FAILED', message: String(e), retryable: true };
  }
}

function applyView(viewId: string) {
  selectedViewId.value = viewId;
  const view = savedViews.value.find(item => item.viewId === viewId);
  if (!view) return;
  if (typeof view.scope.monthRange === 'string') monthRange.value = view.scope.monthRange;
  if (typeof view.scope.reportType === 'string') reportType.value = view.scope.reportType;
  void mutateView(viewId, 'PATCH', `/api/reports/views/${viewId}/last-used`);
}
function createView() {
  const name = promptValue('Name this saved view', `${reportType.value || 'Report'} view`);
  if (!name) return;
  void mutateView('', 'POST', '/api/reports/views', { name, viewType: 'reports', scope: { reportType: reportType.value, monthRange: monthRange.value } });
}
function renameView(viewId: string) {
  const view = savedViews.value.find(item => item.viewId === viewId);
  const name = promptValue('Rename saved view', view?.name ?? '');
  if (name) void mutateView(viewId, 'PATCH', undefined, { name });
}
function updateView(viewId: string) {
  void mutateView(viewId, 'PATCH', undefined, { scope: { reportType: reportType.value, monthRange: monthRange.value } });
}
function duplicateView(viewId: string) {
  const view = savedViews.value.find(item => item.viewId === viewId);
  const name = promptValue('Name duplicated view', `${view?.name ?? 'View'} copy`);
  if (name) void mutateView(viewId, 'POST', `/api/reports/views/${viewId}/duplicate`, { name });
}
function deleteView(viewId: string) {
  if (import.meta.client && !window.confirm('Delete this saved view?')) return;
  void mutateView(viewId, 'DELETE');
}
function markViewUsed(viewId: string) {
  void mutateView(viewId, 'PATCH', `/api/reports/views/${viewId}/last-used`);
}

async function loadViews() {
  viewsLoading.value = true;
  viewsError.value = null;
  try {
    const res = await $fetch<Envelope<{ views: SavedView[]; total: number }>>('/api/reports/views');
    if (res.status === 'ok' && res.result) savedViews.value = res.result.views;
    else viewsError.value = { code: res.error?.code ?? 'VIEWS_FAILED', message: res.error?.message ?? 'Failed to load saved views.', retryable: !!res.error?.retryable };
  } catch (e) {
    viewsError.value = { code: 'FETCH_ERROR', message: String(e), retryable: true };
  } finally { viewsLoading.value = false; }
}

async function generate() {
  if (!reportType.value || !monthRange.value) return;
  loading.value = true;
  error.value = null;
  try {
    const res = await $fetch<Envelope<ReportGenerationResult>>('/api/reports/generate', {
      query: { reportType: reportType.value, monthRange: monthRange.value },
    });
    if (res.status === 'ok' && res.result) reportResult.value = res.result;
    else error.value = { code: res.error?.code ?? 'GENERATE_FAILED', message: res.error?.message ?? 'Report generation returned an error.' };
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally { loading.value = false; }
}

onMounted(async () => {
  try {
    const historyRes = await $fetch<Envelope<{ entries: ReportHistoryEntry[]; total: number }>>('/api/reports/history');
    if (historyRes.status === 'ok' && historyRes.result) {
      historyEntries.value = historyRes.result.entries;
      historyTotal.value = historyRes.result.total;
      freshness.value = historyRes.dataFreshness;
    } else {
      error.value = { code: historyRes.error?.code ?? 'HISTORY_FAILED', message: historyRes.error?.message ?? 'Failed to load report history.' };
    }
    await loadViews();
  } catch (e) {
    error.value = { code: 'FETCH_ERROR', message: String(e) };
  } finally { loading.value = false; }
});
</script>
