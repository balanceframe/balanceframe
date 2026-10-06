<template>
  <section aria-label="Local merchant evidence and pattern decisions" :aria-busy="busy" class="space-y-4 text-sm">
    <p>Local evidence and observed patterns, including already categorized transactions. This is evidence review, not another categorization inbox. Loading local evidence never requests a provider; optional public-business research below requires its own preview and consent.</p>
    <button ref="refreshControl" type="button" :disabled="busy" class="underline" @click="load()">{{ analysis ? 'Refresh merchant evidence' : 'Load merchant evidence and patterns' }}</button>
    <p v-if="busy" role="status">Loading / rechecking current source authority…</p>
    <p v-if="error" role="alert">{{ error }} Refresh current evidence, or ask an authorized holder for the required access.</p>
    <p v-if="outcome" role="status">{{ outcome }}</p>
    <template v-if="analysis">
      <section class="space-y-1 rounded border p-3" aria-label="Admitted source coverage">
        <h3 class="font-medium">Current admitted source coverage (not the whole private budget)</h3>
        <p>As of civil date: {{ analysis.asOfDate }} · normalization {{ analysis.normalizationVersion }}</p>
        <p>Captured {{ analysis.sourceAdmission.capturedAt }} · expires {{ analysis.sourceAdmission.expiresAt }}</p>
        <p>Effective history: {{ analysis.coverage.startDate ?? 'Unknown' }} to {{ analysis.coverage.endDate ?? 'Unknown' }} · {{ analysis.coverage.limited ? 'Partial / bounded coverage' : 'Admitted coverage' }}</p>
        <p>Source-reported original admitted count {{ analysis.sourceAdmission.originalTransactionCount }} · admitted input {{ analysis.coverage.inputCount }} · eligible {{ analysis.coverage.eligibleCount }} · excluded {{ analysis.coverage.excludedCount }} · truncated {{ analysis.sourceAdmission.truncatedCount }} · pending {{ analysis.sourceAdmission.pendingState }}</p>
        <p v-for="(state, collection) in analysis.sourceAdmission.collections" :key="collection">{{ collection }}: {{ state }}</p>
        <p v-for="account in analysis.sourceAdmission.accountCoverage" :key="account.accountId">Account {{ account.accountId }}: {{ account.state }} · {{ account.startDate }} to {{ account.endDate }} · currency {{ account.currencyState }}</p>
        <p>Coverage reasons: {{ analysis.coverage.reasonCodes.join(', ') || 'None' }}</p>
        <details><summary class="cursor-pointer">Current source versions</summary><p class="break-all font-mono">Facts hash {{ analysis.sourceAdmission.factsHash }} · visibility revision {{ analysis.sourceAdmission.visibilityHash }}</p></details>
        <p v-if="expired" role="alert">Evidence expired. Refresh before confirming or rejecting any decision.</p>
      </section>
      <fieldset :disabled="busy || expired" class="flex flex-wrap items-end gap-3 rounded border p-3">
        <legend class="font-medium">Explicit human evidence decisions</legend>
        <label class="space-y-1"><span class="block">Decision visibility</span><select v-model="visibility" aria-label="Decision visibility" class="rounded border p-2 dark:bg-gray-950"><option value="private">Private — this actor only</option><option value="shared">Shared — current authorized space</option></select></label>
        <label class="space-y-1"><span class="block">{{ confirmationLabel }}</span><input v-model="password" type="password" autocomplete="current-password" class="rounded border p-2 dark:bg-gray-950" /></label>
        <p class="w-full">Confirm/reject records attributed intent only. SourceFactory rechecks source, scope and optimistic versions. Shared confirmation is not external research consent.</p>
      </fieldset>
      <p v-if="!analysis.suggestions.length && !analysis.recurrences.length" role="status">No admitted merchant suggestions or observed patterns. Ordinary native Review remains usable; source/evidence access may be unavailable.</p>
      <datalist id="merchant-actual-payees"><option v-for="payee in analysis.payees" :key="payee.id" :value="payee.id">{{ payee.name }}</option></datalist>
      <article v-for="suggestion in analysis.suggestions" :key="suggestion.transactionId" class="space-y-3 rounded border p-3">
        <details open><summary class="cursor-pointer font-medium">Transaction evidence {{ suggestion.transactionId }}</summary><MerchantEvidence :suggestion="suggestion" :source-transaction="suggestion.sourceTransaction" :category-names="categoryNames" :normalization-version="analysis.normalizationVersion" :as-of-date="analysis.asOfDate" :expires-at="analysis.sourceAdmission.expiresAt" /></details>
        <p class="break-all">Evidence key {{ suggestion.evidenceKey }} · policy version {{ suggestion.reviewContext.merchantPolicyVersion }} · expires {{ suggestion.reviewContext.expiresAt }}</p>
        <h4 class="font-medium">Explicit alias mapping (does not merge native payees)</h4>
        <fieldset v-if="aliasForms[suggestion.transactionId]" :disabled="busy || expired" class="flex min-w-0 flex-wrap gap-3">
          <label><span class="block">Alias source field</span><select v-model="aliasForms[suggestion.transactionId]!.sourceField" aria-label="Alias source field" class="rounded border p-2 dark:bg-gray-950"><option v-for="field in sourceFields" :key="field" :value="field">{{ field }}</option></select></label>
          <label><span class="block">Target Actual payee ID</span><input v-model="aliasForms[suggestion.transactionId]!.targetPayeeId" aria-label="Target Actual payee ID" list="merchant-actual-payees" class="rounded border p-2 dark:bg-gray-950" /></label>
          <label class="min-w-0 max-w-full"><span class="block">Alias account scope</span><select v-model="aliasForms[suggestion.transactionId]!.accountScoped" aria-label="Alias account scope" class="max-w-full rounded border p-2 dark:bg-gray-950"><option :value="true">This account only</option><option :value="false">Whole admitted budget (requires global authority)</option></select></label>
          <label v-if="suggestion.aliasDecisions.length" class="min-w-0 max-w-full"><span class="block">Decision to update</span><select v-model="aliasForms[suggestion.transactionId]!.decisionId" aria-label="Existing alias decision" class="max-w-full rounded border p-2 dark:bg-gray-950"><option value="">Current matching decision, or new if none</option><option v-for="decision in suggestion.aliasDecisions.filter(d => d.visibility === visibility)" :key="decision.id" :value="decision.id">{{ decision.id }} · {{ decision.sourceField }} · {{ decision.state }} · v{{ decision.version }}</option></select></label>
          <button type="button" :disabled="!canAlias(suggestion)" class="rounded border px-3 py-2" @click="decideAlias(suggestion, 'confirm')">Confirm alias</button>
          <button type="button" :disabled="!canAlias(suggestion)" class="rounded border px-3 py-2" @click="decideAlias(suggestion, 'reject')">Reject alias</button>
        </fieldset>
        <p v-if="!canAlias(suggestion)">Choose a present admitted source field, an existing exact Actual payee ID and fresh human confirmation. Unknown, unavailable, unsupported, absent and empty source text cannot confirm a mapping.</p>
        <ul><li v-for="decision in suggestion.aliasDecisions" :key="`${decision.visibility}:${decision.id}`">{{ decision.visibility }} alias {{ decision.id }}: {{ decision.state }} · {{ decision.sourceField }} → {{ decision.targetPayeeId }} · account {{ decision.accountId ?? 'budget' }} · v{{ decision.version }} · {{ decision.updatedAt }}</li></ul>
        <MerchantResearch :key="`${suggestion.evidenceKey}:${suggestion.evidenceRevision}`" :evidence-key="suggestion.evidenceKey" :evidence-revision="suggestion.evidenceRevision" :expires-at="suggestion.reviewContext.expiresAt" :disabled="busy || expired" />
      </article>
      <button v-if="analysis.suggestionPage.nextCursor" type="button" :disabled="busy || expired" class="underline" @click="load(true)">Load more authorized evidence</button>
      <section aria-label="Observed pattern controls" class="space-y-3">
        <h3 class="font-medium">Observed patterns across the admitted dataset</h3>
        <p v-if="!analysis.recurrences.length">No admitted observed patterns. Schedules below remain separate expectations.</p>
        <article v-for="pattern in analysis.recurrences" :key="pattern.id" class="space-y-3 rounded border p-3">
          <details open><summary class="cursor-pointer font-medium">{{ pattern.normalizedMerchant }} — {{ pattern.frequency }}</summary><MerchantEvidence :recurrence="pattern" :normalization-version="analysis.normalizationVersion" :as-of-date="analysis.asOfDate" :expires-at="analysis.sourceAdmission.expiresAt" /></details>
          <ul><li v-for="decision in pattern.patternDecisions" :key="`${decision.visibility}:${decision.id}`">{{ decision.visibility }} decision {{ decision.id }}: {{ decision.state }} · v{{ decision.version }} · {{ decision.updatedAt }}</li></ul>
          <label v-if="pattern.patternDecisions.filter(d => d.visibility === visibility).length > 1"><span class="block">Exact pattern decision to update</span><select v-model="patternDecisionIds[pattern.id]" aria-label="Existing pattern decision" class="rounded border p-2 dark:bg-gray-950"><option value="">Choose exact decision</option><option v-for="decision in pattern.patternDecisions.filter(d => d.visibility === visibility)" :key="decision.id" :value="decision.id">{{ decision.id }} · {{ decision.state }} · v{{ decision.version }}</option></select></label>
          <div class="flex flex-wrap gap-2"><button type="button" :disabled="busy || expired || !password" class="rounded border px-3 py-2" @click="decidePattern(pattern, 'confirm')">Confirm pattern</button><button type="button" :disabled="busy || expired || !password" class="rounded border px-3 py-2" @click="decidePattern(pattern, 'reject')">Reject pattern</button></div>
          <MerchantResearch :key="`${pattern.evidenceKey}:${pattern.evidenceRevision}`" :evidence-key="pattern.evidenceKey" :evidence-revision="pattern.evidenceRevision" :expires-at="analysis.sourceAdmission.expiresAt" :disabled="busy || expired" />
        </article>
      </section>
      <details><summary class="cursor-pointer font-medium">Source scheduled expectations ({{ analysis.scheduledExpectations.length }}) — not observed recurrence</summary><pre class="overflow-x-auto text-xs">{{ JSON.stringify(analysis.scheduledExpectations, null, 2) }}</pre></details>
      <button type="button" :disabled="busy || !password" class="underline" @click="exportEvidence">Reauthenticate and export authorized evidence</button>
      <a v-if="exportJson" :href="`data:application/json;charset=utf-8,${encodeURIComponent(exportJson)}`" download="merchant-evidence.json" class="ml-3 underline">Download current authorized evidence JSON</a>
    </template>
  </section>
</template>

<script setup lang="ts">
import type { MerchantAnalysisView, MerchantDecisionInput, MerchantPublicSuggestion, MerchantPublicRecurrence, MerchantExport } from '@balanceframe/application';
import type { MerchantSourceField } from '@balanceframe/protocol-generated';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { merchantRequest } from '../utils/merchant-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import MerchantEvidence from './MerchantEvidence.vue';
import MerchantResearch from './MerchantResearch.vue';
const props = defineProps<{ transactionId?: string | null; refreshKey?: number }>();
const analysis = ref<MerchantAnalysisView | null>(null);
const busy = ref(false);
const error = ref('');
const outcome = ref('');
const exportJson = ref('');
const visibility = ref<'private' | 'shared'>('private');
const refreshControl = ref<HTMLButtonElement | null>(null);
const password = ref('');
const sourceFields: MerchantSourceField[] = ['importedPayee', 'payeeName', 'description', 'verboseTitle', 'notes'];
const confirmationLabel = typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
  ? 'Disposable-demo confirmation (type CONFIRM)' : 'Account password';
interface AliasForm { sourceField: MerchantSourceField; targetPayeeId: string; accountScoped: boolean; decisionId: string }
const aliasForms = ref<Record<string, AliasForm>>({});
const patternDecisionIds = ref<Record<string, string>>({});
const payeeIds = computed(() => new Set(analysis.value?.payees.map(payee => payee.id) ?? []));
const categoryNames = computed(() => Object.fromEntries((analysis.value?.categories ?? []).map(category => [category.id, category.name])));
const currentTime = ref(Date.now());
const expired = computed(() => !analysis.value || Date.parse(analysis.value.sourceAdmission.expiresAt) <= currentTime.value);
let expiryTimer: number | undefined;
function scheduleExpiry() {
  if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
  currentTime.value = Date.now();
  const deadline = analysis.value && Date.parse(analysis.value.sourceAdmission.expiresAt);
  if (deadline && deadline > currentTime.value)
    expiryTimer = window.setTimeout(scheduleExpiry, Math.min(deadline - currentTime.value, 2147483647));
}
watch(() => analysis.value?.sourceAdmission.expiresAt, scheduleExpiry);
onUnmounted(() => {
  if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
});
let generation = 0;
watch(() => [props.transactionId, props.refreshKey], () => {
  generation += 1; analysis.value = null; exportJson.value = ''; error.value = ''; outcome.value = ''; password.value = '';
});
watch(visibility, () => {
  patternDecisionIds.value = {};
  for (const form of Object.values(aliasForms.value)) form.decisionId = '';
});
async function load(more = false) {
  if (busy.value) return;
  const prior = analysis.value;
  const current = ++generation;
  busy.value = true; error.value = ''; exportJson.value = '';
  if (!more) analysis.value = null;
  try {
    const query = new URLSearchParams();
    if (props.transactionId) query.set('transactionId', props.transactionId);
    if (more && prior?.suggestionPage.nextCursor) {
      query.set('cursor', prior.suggestionPage.nextCursor); query.set('factsHash', prior.sourceAdmission.factsHash);
    }
    const next = await merchantRequest<MerchantAnalysisView>(`/api/merchant${query.size ? `?${query}` : ''}`);
    if (current !== generation) return;
    analysis.value = more && prior ? { ...next, suggestions: [...prior.suggestions, ...next.suggestions] } : next;
    for (const suggestion of next.suggestions) aliasForms.value[suggestion.transactionId] = {
      sourceField: 'importedPayee', targetPayeeId: suggestion.payeeId ?? '', accountScoped: true, decisionId: '',
    };
  } catch (failure) {
    if (current !== generation) return;
    analysis.value = null; error.value = failure instanceof Error ? failure.message : 'Unable to load current evidence.';
  } finally {
    busy.value = false;
    await restoreRefreshFocus();
  }
}
function canAlias(suggestion: MerchantPublicSuggestion) {
  const form = aliasForms.value[suggestion.transactionId];
  const source = suggestion.sourceTransaction;
  if (!form || !source || busy.value || expired.value || !password.value || !payeeIds.value.has(form.targetPayeeId)) return false;
  return form.sourceField === 'payeeName' ? !!source.payeeName : source[form.sourceField].state === 'present' && !!source[form.sourceField].value;
}
async function decideAlias(suggestion: MerchantPublicSuggestion, action: 'confirm' | 'reject') {
  if (!canAlias(suggestion)) return;
  const form = aliasForms.value[suggestion.transactionId]!;
  const accountId = form.accountScoped ? suggestion.accountId : null;
  const matches = suggestion.aliasDecisions.filter(d => d.visibility === visibility.value && d.sourceField === form.sourceField && d.accountId === accountId);
  const selected = form.decisionId ? matches.find(d => d.id === form.decisionId) : matches.length === 1 ? matches[0] : undefined;
  if ((form.decisionId && !selected) || (!form.decisionId && matches.length > 1)) { error.value = 'Choose the exact current alias decision to update; then review its version.'; return; }
  await saveDecision({ id: selected?.id ?? crypto.randomUUID(), evidenceKey: suggestion.evidenceKey, evidenceRevision: suggestion.evidenceRevision, expectedVersion: selected?.version ?? 0, visibility: visibility.value, kind: 'alias', transactionId: suggestion.transactionId, sourceField: form.sourceField, targetPayeeId: form.targetPayeeId, accountId }, action);
}
async function decidePattern(pattern: MerchantPublicRecurrence, action: 'confirm' | 'reject') {
  if (busy.value || expired.value || !password.value) return;
  const matches = pattern.patternDecisions.filter(d => d.visibility === visibility.value);
  const selectedId = patternDecisionIds.value[pattern.id];
  const selected = selectedId ? matches.find(d => d.id === selectedId) : matches.length === 1 ? matches[0] : undefined;
  if ((selectedId && !selected) || (!selectedId && matches.length > 1)) { error.value = 'Choose the exact current pattern decision to update; then review its version.'; return; }
  await saveDecision({ id: selected?.id ?? crypto.randomUUID(), evidenceKey: pattern.evidenceKey, evidenceRevision: pattern.evidenceRevision, expectedVersion: selected?.version ?? 0, visibility: visibility.value, kind: 'pattern', patternId: pattern.id }, action);
}
async function saveDecision(input: MerchantDecisionInput, action: 'confirm' | 'reject') {
  busy.value = true; error.value = ''; outcome.value = '';
  const proof = password.value; password.value = '';
  const current = generation;
  try {
    await reauthenticateHuman(proof);
    if (current !== generation) return;
    await merchantRequest(`/api/merchant/${action}`, 'POST', input);
    if (current !== generation) return;
    busy.value = false;
    await load();
    if (analysis.value) outcome.value = 'Decision saved on the server; current evidence reloaded. No Actual financial write occurred.';
  } catch (failure) {
    if (current !== generation) return;
    analysis.value = null; exportJson.value = '';
    error.value = failure instanceof Error ? failure.message : 'Decision failed. Refresh and review again.';
  }
  finally {
    busy.value = false;
    await restoreRefreshFocus();
  }
}
async function exportEvidence() {
  busy.value = true; error.value = ''; exportJson.value = '';
  const proof = password.value; password.value = '';
  const current = generation;
  try {
    await reauthenticateHuman(proof);
    if (current !== generation) return;
    const result = await merchantRequest<MerchantExport>('/api/merchant/export');
    if (current === generation) exportJson.value = JSON.stringify(result, null, 2);
  } catch (failure) {
    if (current !== generation) return;
    analysis.value = null;
    error.value = failure instanceof Error ? failure.message : 'Export denied. Refresh current access.';
  }
  finally { busy.value = false; await restoreRefreshFocus(); }
}
async function restoreRefreshFocus() {
  await nextTick();
  refreshControl.value?.focus();
}
</script>
