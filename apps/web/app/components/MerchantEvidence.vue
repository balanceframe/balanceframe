<template>
  <section class="space-y-3 break-words text-sm" aria-label="Merchant evidence">
    <p v-if="suggestion || recurrence"><strong>Evidence tier:</strong> {{ suggestion?.tier ?? recurrence?.tier ?? 'unavailable' }}. Not a calibrated probability. Confirmation records human intent, not verified execution.</p>
    <dl v-if="suggestion" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div><dt class="font-medium">Native transaction ID</dt><dd class="font-mono">{{ suggestion.transactionId }}</dd></div>
      <div><dt class="font-medium">Account ID</dt><dd class="font-mono">{{ suggestion.accountId }}</dd></div>
      <div><dt class="font-medium">Resolved payee ID</dt><dd class="font-mono">{{ suggestion.payeeId ?? 'Unknown' }}</dd></div>
      <div><dt class="font-medium">Suggested category and native ID</dt><dd>{{ categoryLabel(suggestion.categoryId) }}</dd></div>
      <div><dt class="font-medium">Native support count</dt><dd>{{ suggestion.supportCount }}</dd></div>
      <div><dt class="font-medium">Evidence revision</dt><dd class="font-mono">{{ suggestion.evidenceRevision }}</dd></div>
    </dl>
    <section v-if="sourceTransaction" class="space-y-2">
      <h4 class="font-medium">Current native source observation</h4>
      <p>Native payee: {{ sourceTransaction.payeeName ?? 'Unknown / not supplied' }} · ID {{ sourceTransaction.payeeId ?? 'Unknown' }} · category {{ categoryLabel(sourceTransaction.categoryId) }}</p>
      <p>Civil date: {{ sourceTransaction.date }} · <SemanticAmount :amount="sourceTransaction.amount" /></p>
      <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div v-for="field in rawFields" :key="field.name">
          <dt class="font-medium">{{ field.name }} — {{ field.source.state }}</dt>
          <dd class="whitespace-pre-wrap">{{ field.source.value === '' ? '(empty)' : field.source.value ?? 'No admitted source text' }}</dd>
        </div>
      </dl>
      <p class="text-xs">Unavailable means not admitted; unsupported means the connector has no field. Absent and empty are distinct. Native payee text is not invented bank text.</p>
    </section>
    <p v-else-if="suggestion" role="status">Raw source availability is unknown. Refresh current evidence; unavailable source fields cannot confirm an alias.</p>
    <template v-if="suggestion">
      <section v-if="suggestion.categoryHistory" class="space-y-2">
        <h4 class="font-medium">Full native category history</h4>
        <p>{{ suggestion.categoryHistory.totalCount }} outcomes across {{ suggestion.categoryHistory.categoryCount }} categories.</p>
        <p v-if="suggestion.categoryHistory.truncated">History entries truncated — {{ suggestion.categoryHistory.entries.length }} of {{ suggestion.categoryHistory.categoryCount }} categories displayed. Counts and civil endpoints are from the full admitted group, not explanation samples.</p>
        <p v-if="!suggestion.categoryHistory.entries.length">No admitted historical category outcomes.</p>
        <ul class="space-y-1">
          <li v-for="entry in suggestion.categoryHistory.entries" :key="entry.categoryId">{{ categoryLabel(entry.categoryId) }}: {{ entry.count }} observations · {{ entry.ledgerCount }} ledger / {{ entry.correctionCount }} verified correction · first civil date {{ entry.firstDate }} · last civil date {{ entry.lastDate }}</li>
        </ul>
      </section>
      <p v-else role="status">Full category history unavailable in this projection. Refresh current authorized evidence.</p>
      <section class="space-y-2">
        <h4 class="font-medium">Native alternatives (bounded detail, not a full candidate total)</h4>
        <p v-if="!suggestion.alternatives?.length">No admitted alternative detail.</p>
        <ul><li v-for="alternative in suggestion.alternatives" :key="alternative.categoryId">{{ categoryLabel(alternative.categoryId) }} · native support count {{ alternative.supportCount }} · tier {{ alternative.tier }} · reasons {{ alternative.reasonCodes.join(', ') || 'None' }}</li></ul>
      </section>
      <section class="space-y-2">
        <h4 class="font-medium">Exact native-ID rule-learning advice</h4>
        <p v-if="!suggestion.ruleCandidates?.length">No admitted history-backed rule candidate.</p>
        <ul><li v-for="candidate in suggestion.ruleCandidates" :key="`${candidate.payeeId}:${candidate.categoryId}`">Native payee ID {{ candidate.payeeId }} → category {{ categoryLabel(candidate.categoryId) }} · {{ candidate.supportCount }} full supporting outcomes · {{ candidate.consistencyNumerator }} / {{ candidate.consistencyDenominator }} historical consistency, not a confidence probability.</li></ul>
        <p>Advice does not grant native rule authority. Review a separate exact-ID proposal and its global future impact before independent approval or execution.</p>
      </section>
      <section v-for="group in evidenceGroups" :key="group.label" class="space-y-2">
        <h4 class="font-medium">{{ group.label }} ({{ group.rows.length }} displayed evidence samples)</h4>
        <p v-if="!group.rows.length">No admitted evidence samples.</p>
        <ul v-else class="space-y-2">
          <li v-for="(row, index) in group.rows" :key="`${row.sourceId}:${row.field}:${index}`" class="rounded border p-2">
            <p>Provenance: {{ row.kind }} · source ID {{ row.sourceId }} · field {{ row.field ?? 'Not applicable' }}</p>
            <p class="whitespace-pre-wrap">Raw text: {{ row.rawText ?? 'Not available in this sample' }}</p>
            <p class="whitespace-pre-wrap">Normalized text: {{ row.normalizedText ?? 'Not supplied' }}</p>
            <p>Source time: {{ row.sourceTime ?? 'Unknown' }} · version {{ row.version }} · reason {{ row.reasonCode }}</p>
          </li>
        </ul>
      </section>
      <p class="text-xs">Explanation samples are bounded; sample length is not the full history or an alternative-category count.</p>
      <p>Reason codes: {{ suggestion.reasonCodes.join(', ') || 'None' }}</p>
    </template>
    <template v-if="recurrence">
      <h4 class="font-medium">Observed pattern: {{ recurrence.normalizedMerchant }}</h4>
      <p>Pattern ID {{ recurrence.id }} · account {{ recurrence.accountId }} · native payee ID {{ recurrence.payeeId ?? 'Unknown' }}</p>
      <p>{{ recurrence.kind }} · {{ recurrence.frequency }} · {{ recurrence.direction }} · {{ recurrence.currency }} · decision {{ recurrence.decisionState }}</p>
      <p>Full occurrence count: {{ recurrence.occurrences }} · first civil date {{ recurrence.firstDate }} · last civil date {{ recurrence.lastDate }}</p>
      <p>Amount range: <SemanticAmount :amount="recurrence.minimumAmount" /> to <SemanticAmount :amount="recurrence.maximumAmount" /></p>
      <p>Exact variance: <span v-if="recurrence.varianceNumerator !== null && recurrence.varianceDenominator !== null">{{ recurrence.varianceNumerator }} / {{ recurrence.varianceDenominator }} {{ recurrence.currency }} minor units²</span><span v-else>Unknown / unavailable; see reason codes.</span></p>
      <details v-for="distribution in civilDistributions" :key="distribution.label" open>
        <summary class="cursor-pointer font-medium">{{ distribution.label }}</summary>
        <p v-if="!Object.keys(distribution.values).length">No admitted observations.</p>
        <ul v-else class="flex flex-wrap gap-x-4 gap-y-1"><li v-for="(count, key) in distribution.values" :key="key">{{ key }}: {{ count }}</li></ul>
      </details>
      <details v-for="period in occurrencePeriods" :key="period.label" open>
        <summary class="cursor-pointer font-medium">Occurrences per {{ period.label }}</summary>
        <p>Exact average: {{ period.values.averageNumerator }} / {{ period.values.averageDenominator }}</p>
        <h5 class="font-medium">Complete contiguous period counts (including zero periods)</h5>
        <ul class="flex flex-wrap gap-x-4 gap-y-1"><li v-for="(count, key) in period.values.periodCounts" :key="key">{{ key }}: {{ count }}</li></ul>
        <h5 class="font-medium">Occurrence-count distribution</h5>
        <ul class="flex flex-wrap gap-x-4 gap-y-1"><li v-for="(count, key) in period.values.countDistribution" :key="key">{{ key }} occurrences: {{ count }} periods</li></ul>
      </details>
      <details>
        <summary class="cursor-pointer font-medium">Bounded source samples ({{ recurrence.transactionIds.length }} IDs / {{ recurrence.dates.length }} civil dates)</summary>
        <p>Sampled transaction IDs: {{ recurrence.transactionIds.join(', ') || 'None' }}</p>
        <p>Sampled civil dates: {{ recurrence.dates.join(', ') || 'None' }}</p>
        <p>Sampled intervals in days: {{ recurrence.intervalDays.join(', ') || 'None' }}</p>
      </details>
      <p>Calendar version: {{ recurrence.calendarVersion ?? 'Unknown / not configured' }}</p>
      <p>Public holidays and weekends may explain calendar displacement; they are not proof that a particular bank was closed. Unknown calendars retain ordinary civil cadence with uncertainty. Ledger civil dates are not converted to UTC.</p>
      <p>Reason codes: {{ recurrence.reasonCodes.join(', ') || 'None' }}</p>
      <p class="font-mono">Evidence revision: {{ recurrence.evidenceRevision }}</p>
    </template>
    <template v-if="suggestion || recurrence">
      <p>Normalization version: {{ normalizationVersion ?? 'Unavailable in this projection' }}</p>
      <p>As of civil date: {{ asOfDate ?? 'Unavailable in this projection' }}</p>
      <p>Source evidence expires: {{ expiresAt ?? 'Unavailable in this projection' }}</p>
    </template>
    <section v-if="enrichment" aria-label="Historical untrusted research sources" class="space-y-2">
      <h4 class="font-medium">Historical untrusted external observations</h4>
      <p>Provider {{ enrichment.key.providerId }} · version {{ enrichment.key.providerVersion }} · confidence {{ enrichment.confidence }} (not a calibrated probability).</p>
      <p>Retrieved {{ enrichment.retrievedAt }} · expires {{ enrichment.expiresAt }} · policy version {{ enrichment.policyVersion }} · evidence revision {{ enrichment.evidenceRevision }}</p>
      <p>Fields sent: {{ enrichment.fieldsSent.join(', ') }} · normalization {{ enrichment.key.normalizationVersion }} · egress policy {{ enrichment.key.egressPolicyVersion }}</p>
      <p>Sources are historical search results, not proof of merchant identity, category, approval or financial facts. They never promote local evidence confidence or apply a ledger change. No linked page is fetched automatically.</p>
      <p v-if="!enrichment.sources.length">No attributable source detail was returned.</p>
      <ul class="space-y-2">
        <li v-for="(source, index) in enrichment.sources" :key="index" class="rounded border p-2">
          <a v-if="safeSourceUrl(source.url)" :href="safeSourceUrl(source.url)!" target="_blank" rel="noopener noreferrer" class="underline">{{ source.title || 'Source link' }}</a>
          <p v-else class="whitespace-pre-wrap">{{ source.title }} (unsafe link omitted)</p>
          <p class="whitespace-pre-wrap">{{ source.snippet }}</p>
        </li>
      </ul>
    </section>
  </section>
</template>

<script setup lang="ts">
import type { MerchantSuggestion, MerchantRecurrence } from '@balanceframe/protocol-generated';
import type { MerchantPublicSuggestion } from '@balanceframe/application';
import type { MerchantEnrichment } from '@balanceframe/workflow-store';
import { computed } from 'vue';
import SemanticAmount from './SemanticAmount.vue';
const props = defineProps<{
  suggestion?: MerchantSuggestion;
  recurrence?: MerchantRecurrence;
  sourceTransaction?: MerchantPublicSuggestion['sourceTransaction'];
  categoryNames?: Readonly<Record<string, string>>;
  normalizationVersion?: string;
  asOfDate?: string;
  expiresAt?: string;
  enrichment?: MerchantEnrichment;
}>();
function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(value) ? url.href : null;
  } catch { return null; }
}
function categoryLabel(id: string | null): string {
  return id === null ? 'Unresolved / no category ID supplied' : `${props.categoryNames?.[id] ?? 'Unknown category name'} (${id})`;
}
const rawFields = computed(() => props.sourceTransaction
  ? (['importedPayee', 'description', 'verboseTitle', 'notes'] as const).map((name) => ({ name, source: props.sourceTransaction![name] }))
  : []);
const evidenceGroups = computed(() => [
  { label: 'Supporting evidence / attributed history', rows: props.suggestion?.evidence ?? [] },
  { label: 'Contradictions / alternatives', rows: props.suggestion?.contradictions ?? [] },
]);
const civilDistributions = computed(() => props.recurrence ? [
  { label: 'Interval distribution (days)', values: props.recurrence.intervalDistribution },
  { label: 'Civil day of month', values: props.recurrence.dayOfMonth },
  { label: 'Civil day of week (ISO 1–7)', values: props.recurrence.dayOfWeek },
  { label: 'Month-of-year seasonality', values: props.recurrence.monthOfYear },
  { label: 'Year distribution', values: props.recurrence.yearDistribution },
] : []);
const occurrencePeriods = computed(() => props.recurrence ? [
  { label: 'week', values: props.recurrence.occurrencesPerWeek },
  { label: 'month', values: props.recurrence.occurrencesPerMonth },
  { label: 'year', values: props.recurrence.occurrencesPerYear },
] : []);
</script>
