<template>
  <section aria-label="Optional external merchant research" :aria-busy="busy" class="space-y-3 rounded border p-3 text-sm">
    <h4 class="font-medium">Optional public-business research — separate from local evidence</h4>
    <p>Enter a standalone public business name yourself. Never copy private bank text, notes, names or identifiers. Nothing is prefilled or sent automatically. Local review remains available without a provider.</p>
    <label class="block"><span class="block">Public business name</span><input v-model="merchant" aria-label="Public business name" maxlength="160" autocomplete="off" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
    <label class="block"><span class="block">Optional coarse research locale — explicitly selected</span><select v-model="locale" aria-label="Research locale" class="rounded border p-2 dark:bg-gray-950"><option value="">None</option><option value="US">US</option><option value="CA">Canada</option><option value="GB">United Kingdom</option></select></label>
    <label class="flex items-start gap-2"><input v-model="publicBusiness" aria-label="Standalone public business declaration" type="checkbox" /><span>I declare this manually entered standalone text identifies a public business, not private Actual data. This is not consent to dispatch.</span></label>
    <div class="flex flex-wrap gap-3">
      <button type="button" :disabled="!canQuery || busy" class="rounded border px-3 py-2" @click="previewResearch">Preview external research</button>
      <button type="button" :disabled="!canQuery || busy" class="underline" @click="loadHistorical">Load historical research</button>
      <button type="button" class="underline" @click="reset">Reset research input</button>
    </div>
    <section v-if="preview" aria-label="Exact external research preview" class="space-y-2 break-words rounded border p-3">
      <h5 class="font-medium">Exact external research preview</h5>
      <p class="whitespace-pre-wrap">Sent merchant text: {{ preview.merchant }}</p>
      <p>Sent locale: {{ preview.locale ?? 'None' }} · fields sent: {{ preview.fieldsSent.join(', ') }}</p>
      <p>Provider {{ preview.providerId }} · version {{ preview.providerVersion }}</p>
      <p v-if="preview.providerVersion === 'scenario-fixture/1'" aria-label="Research fixture provenance">
        Closed fixture — no live provider request. Billing atoms are modeled scenario accounting, not real provider cost.
      </p>
      <p>Maximum cost: {{ preview.maxCostAtoms }} billing atoms {{ preview.billingCurrency }}. 1,000,000 atoms = one billing minor unit; this is not transaction Money.</p>
      <p>Target {{ preview.evidenceKey }} · revision {{ preview.evidenceRevision }} · consent expires {{ preview.expiresAt }}</p>
      <p class="whitespace-pre-wrap">{{ preview.disclosure }}</p>
      <label class="flex items-start gap-2"><input v-model="consent" aria-label="Consent to this exact external preview" type="checkbox" :disabled="busy || unavailable" /><span>I independently consent to sending only this exact preview to this provider.</span></label>
    </section>
    <button type="button" :disabled="!canSend" class="rounded border px-3 py-2" @click="send">Send consented external research</button>
    <p v-if="busy" role="status">Checking current research authority… No automatic retries.</p>
    <p v-if="unavailable" role="status">Current source or preview expired / unavailable. Refresh local evidence and obtain a new preview before sending.</p>
    <p v-if="error" role="alert">{{ error }} No automatic retry was made. Review current evidence before requesting a new preview.</p>
    <p v-if="outcome" role="status">{{ outcome }}</p>
    <MerchantEvidence v-if="enrichment" :enrichment="enrichment" />
  </section>
</template>

<script setup lang="ts">
import type { MerchantResearchQuery, MerchantResearchPreview, MerchantResearchOutcome } from '@balanceframe/application';
import type { MerchantEnrichment } from '@balanceframe/workflow-store';
import { computed, onUnmounted, ref, watch } from 'vue';
import { merchantRequest } from '../utils/merchant-client';
import MerchantEvidence from './MerchantEvidence.vue';
const props = defineProps<{ evidenceKey: string; evidenceRevision: string; expiresAt: string; disabled?: boolean }>();
const merchant = ref('');
const locale = ref<'' | 'US' | 'CA' | 'GB'>('');
const publicBusiness = ref(false);
const consent = ref(false);
const preview = ref<Extract<MerchantResearchPreview, { status: 'ready' }> | null>(null);
const enrichment = ref<MerchantEnrichment | null>(null);
const busy = ref(false);
const error = ref('');
const outcome = ref('');
const now = ref(Date.now());
let generation = 0;
let timer: number | undefined;
const unavailable = computed(() => props.disabled === true || !Number.isFinite(Date.parse(props.expiresAt))
  || Date.parse(props.expiresAt) <= now.value || (preview.value !== null && Date.parse(preview.value.expiresAt) <= now.value));
const canQuery = computed(() => !unavailable.value && publicBusiness.value && merchant.value.trim().length > 0);
const canSend = computed(() => canQuery.value && !busy.value && consent.value && preview.value !== null);
function invalidate() {
  generation += 1; preview.value = null; consent.value = false; enrichment.value = null; error.value = ''; outcome.value = '';
}
watch([merchant, locale, publicBusiness], invalidate, { flush: 'sync' });
watch(() => [props.evidenceKey, props.evidenceRevision, props.expiresAt, props.disabled], () => {
  reset();
}, { flush: 'sync' });
function reset() {
  invalidate(); merchant.value = ''; locale.value = ''; publicBusiness.value = false;
}
function scheduleExpiry() {
  if (timer !== undefined) window.clearTimeout(timer);
  now.value = Date.now();
  if (unavailable.value) {
    consent.value = false;
    if (preview.value && Date.parse(preview.value.expiresAt) <= now.value) {
      preview.value = null; outcome.value = 'Preview expired. Obtain a new exact preview and independent consent.';
    }
    if (props.disabled || Date.parse(props.expiresAt) <= now.value) {
      generation += 1; preview.value = null; enrichment.value = null;
    }
  }
  const deadlines = [props.expiresAt, preview.value?.expiresAt, enrichment.value?.expiresAt]
    .map(value => value ? Date.parse(value) : NaN).filter(deadline => Number.isFinite(deadline) && deadline > now.value);
  if (enrichment.value && Date.parse(enrichment.value.expiresAt) <= now.value) enrichment.value = null;
  if (deadlines.length) timer = window.setTimeout(scheduleExpiry, Math.min(Math.min(...deadlines) - now.value, 2147483647));
}
watch(() => [props.expiresAt, preview.value?.expiresAt, enrichment.value?.expiresAt], scheduleExpiry, { immediate: true });
onUnmounted(() => { generation += 1; if (timer !== undefined) window.clearTimeout(timer); });
function query(): MerchantResearchQuery {
  return { evidenceKey: props.evidenceKey, evidenceRevision: props.evidenceRevision, merchant: merchant.value, locale: locale.value || null, publicBusiness: true };
}
async function previewResearch() {
  if (!canQuery.value || busy.value) return;
  invalidate(); const current = generation; const input = query(); busy.value = true;
  try {
    const result = await merchantRequest<MerchantResearchPreview>('/api/merchant/research/preview', 'POST', input);
    if (current !== generation || unavailable.value) return;
    if (result.status === 'denied') { error.value = `Research preview denied: ${result.code}.`; return; }
    if (result.evidenceKey !== input.evidenceKey || result.evidenceRevision !== input.evidenceRevision
      || result.locale !== input.locale || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) {
      error.value = 'Preview target changed or expired.'; return;
    }
    preview.value = result;
  } catch { if (current === generation) error.value = 'Research preview unavailable. Local evidence remains usable.'; }
  finally { busy.value = false; }
}
async function send() {
  now.value = Date.now();
  if (!canSend.value || !preview.value) return;
  const exact = preview.value;
  const current = generation;
  const input = { ...query(), merchant: exact.merchant, locale: exact.locale, previewToken: exact.previewToken, consent: true, idempotencyKey: crypto.randomUUID() };
  preview.value = null; consent.value = false; error.value = ''; outcome.value = ''; enrichment.value = null; busy.value = true;
  try {
    const result = await merchantRequest<MerchantResearchOutcome>('/api/merchant/research', 'POST', input);
    if (current !== generation || unavailable.value) return;
    if (result.status === 'succeeded' || result.status === 'cached') {
      if (result.enrichment.evidenceRevision !== props.evidenceRevision || Date.parse(result.enrichment.expiresAt) <= Date.now()) {
        error.value = 'Research result no longer matches current evidence.'; return;
      }
      enrichment.value = result.enrichment;
      outcome.value = 'Historical untrusted research received. No category, identity, confidence or financial decision was changed.';
    } else if (result.status === 'pending') {
      outcome.value = 'Research is pending with potential billing. The request may already have been dispatched; no automatic retry or polling occurs.';
    } else if (result.status === 'failed' || result.status === 'denied') {
      error.value = `Research ${result.status}: ${result.code}. ${result.billing === 'uncertain' ? 'There is potential billing; the request may already have been dispatched.' : 'Not dispatched.'}`;
    }
  } catch {
    if (current === generation) error.value = 'Research connection unavailable with potential billing. A dispatched request cannot be recalled. No automatic retry occurs.';
  } finally { busy.value = false; }
}
async function loadHistorical() {
  if (!canQuery.value || busy.value) return;
  invalidate(); const current = generation; busy.value = true;
  try {
    const result = await merchantRequest<{ enrichment: MerchantEnrichment | null }>('/api/merchant/research/cache', 'POST', query());
    if (current !== generation || unavailable.value) return;
    if (result.enrichment && result.enrichment.evidenceRevision === props.evidenceRevision && Date.parse(result.enrichment.expiresAt) > Date.now()) {
      enrichment.value = result.enrichment;
    } else outcome.value = 'No eligible historical research for this exact current target and query. Local evidence remains usable.';
  } catch { if (current === generation) error.value = 'Historical research unavailable under current authority or policy. Local evidence remains usable.'; }
  finally { busy.value = false; }
}
</script>
