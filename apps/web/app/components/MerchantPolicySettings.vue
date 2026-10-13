<template>
  <section aria-label="Merchant policy and calendar settings" :aria-busy="busy" class="space-y-4 text-sm">
    <h2 class="text-lg font-semibold">Merchant policy and explicit offline calendar</h2>
    <p>Local-only/off is the default. Provider allowlists and billing quotas are separate from source transaction Money. Changing this policy does not send research, approve a proposal or write Actual.</p>
    <button type="button" :disabled="busy" class="underline" @click="load">{{ policy ? 'Reload complete merchant policy' : 'Load merchant policy' }}</button>
    <p v-if="busy" role="status">Checking complete policy and account override authority…</p>
    <p v-if="error" role="alert">{{ error }} Reload the complete policy, or ask an authorized holder. Partial projected settings cannot be saved.</p>
    <p v-if="outcome" role="status">{{ outcome }}</p>
    <form v-if="policy" class="space-y-4" @submit.prevent="save">
      <p>Policy version {{ policy.version }} · deletion/consent generation {{ policy.generation }}. This saves the complete policy and every displayed account override.</p>
      <fieldset :disabled="busy" class="grid gap-3 rounded border p-3 sm:grid-cols-2">
        <legend class="font-medium">Provider policy — not an external dispatch action</legend>
        <label><span class="block">Provider mode</span><select v-model="mode" aria-label="Provider mode" class="w-full rounded border p-2 dark:bg-gray-950"><option value="disabled">Off / disabled</option><option value="local-only">Local-only</option><option value="external-allowed">External allowed (separate consent and authority required)</option></select></label>
        <label><span class="block">External provider allowlist (one exact provider ID per line)</span><textarea v-model="providers" aria-label="External provider allowlist" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Searches per UTC day (zero disables dispatch)</span><input v-model="searches" aria-label="Daily search quota" type="number" min="0" step="1" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Monthly application-dispatched billing cap (exact billing minor units)</span><input v-model="spend" aria-label="Monthly billing quota minor units" type="number" min="0" step="1" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Provider billing currency (not source/account currency)</span><input v-model="billingCurrency" aria-label="Provider billing currency" maxlength="3" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Evidence cache TTL hours (1–720)</span><input v-model="ttl" aria-label="Cache TTL hours" type="number" min="1" max="720" step="1" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <p class="sm:col-span-2">Caps cover this application's requests, not provider subscriptions, manual usage or other applications. Unknown pricing prevents paid dispatch. Enabling a provider is not consent to send bank text; external research has a separate authorized egress action.</p>
      </fieldset>
      <fieldset :disabled="busy" class="grid gap-3 rounded border p-3 sm:grid-cols-3">
        <legend class="font-medium">Budget calendar default — explicitly selected</legend>
        <label><span class="block">Budget jurisdiction</span><select v-model="budget.jurisdiction" aria-label="Budget jurisdiction" class="w-full rounded border p-2 dark:bg-gray-950"><option value="">Unknown / not configured</option><option value="US">US</option><option value="CA">Canada (CA)</option><option value="GB">United Kingdom (GB)</option><option v-if="budget.jurisdiction && !jurisdictions.includes(budget.jurisdiction)" :value="budget.jurisdiction">Unsupported existing: {{ budget.jurisdiction }}</option></select></label>
        <label><span class="block">Budget subdivision (blank = national)</span><input v-model="budget.subdivision" aria-label="Budget subdivision" placeholder="e.g. CA, ON, ENG" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Budget IANA time zone</span><input v-model="budget.timeZone" aria-label="Budget IANA time zone" placeholder="Explicit IANA zone" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <p class="sm:col-span-3">National/subdivision public dates are possible displacement evidence, not proof of bank closure. No jurisdiction or time zone is inferred from currency, browser locale or merchant text. Unsupported jurisdiction/subdivision/year is visibly unknown.</p>
      </fieldset>
      <fieldset :disabled="busy" class="space-y-3 rounded border p-3">
        <legend class="font-medium">Complete account calendar overrides</legend>
        <p>Unknown override explicitly disables a calendar for that account; removing an override restores the budget default. Saving never omits undisplayed hidden overrides: a full policy read is required.</p>
        <div v-for="(account, index) in accounts" :key="index" class="grid gap-3 rounded border p-2 sm:grid-cols-2 lg:grid-cols-5">
          <label><span class="block">Exact account ID</span><input v-model="account.accountId" :aria-label="`Override ${index + 1} account ID`" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
          <label><span class="block">Jurisdiction</span><select v-model="account.selection.jurisdiction" :aria-label="`Override ${index + 1} jurisdiction`" class="w-full rounded border p-2 dark:bg-gray-950"><option value="">Unknown / explicitly disabled</option><option value="US">US</option><option value="CA">CA</option><option value="GB">GB</option><option v-if="account.selection.jurisdiction && !jurisdictions.includes(account.selection.jurisdiction)" :value="account.selection.jurisdiction">Unsupported existing: {{ account.selection.jurisdiction }}</option></select></label>
          <label><span class="block">Subdivision (blank = national)</span><input v-model="account.selection.subdivision" :aria-label="`Override ${index + 1} subdivision`" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
          <label><span class="block">IANA time zone</span><input v-model="account.selection.timeZone" :aria-label="`Override ${index + 1} IANA time zone`" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
          <button type="button" class="underline" @click="accounts.splice(index, 1)">Remove this override</button>
        </div>
        <button type="button" class="underline" @click="accounts.push({ accountId: '', selection: { jurisdiction: '', subdivision: '', timeZone: '' } })">Add account calendar override</button>
      </fieldset>
      <label class="block"><span class="block">{{ confirmationLabel }}</span><input v-model="password" type="password" autocomplete="current-password" class="rounded border p-2 dark:bg-gray-950" /></label>
      <button type="submit" :disabled="busy || !password" class="rounded border px-3 py-2">Save complete merchant policy</button>
    </form>
    <section v-if="policy" class="space-y-3 rounded border p-3" aria-label="Saved offline calendar lookup">
      <h3 class="font-medium">Look up the stored offline calendar</h3>
      <p>Uses saved policy, never unsaved form values. Coverage/version and unknown state come from SourceFactory.</p>
      <label><span class="block">Exact account ID for lookup</span><input v-model="lookupAccount" aria-label="Calendar lookup account ID" class="rounded border p-2 dark:bg-gray-950" /></label>
      <label class="ml-3"><span class="block">Civil year</span><input v-model="lookupYear" aria-label="Calendar lookup civil year" type="number" step="1" class="rounded border p-2 dark:bg-gray-950" /></label>
      <button type="button" :disabled="busy || !lookupAccount" class="block underline" @click="lookup">Look up saved calendar</button>
      <p v-if="calendar?.state === 'unknown'" role="status">Calendar unknown — jurisdiction/subdivision/year may be unconfigured or unsupported. Ordinary cadence remains available.</p>
      <template v-if="calendar?.state === 'known'">
        <p>{{ calendar.calendar.jurisdiction }} / {{ calendar.calendar.subdivision ?? 'national' }} · {{ calendar.calendar.timeZone }}</p>
        <p>Calendar version {{ calendar.calendar.version }} · coverage {{ calendar.calendar.coverageStart }} to {{ calendar.calendar.coverageEnd }}</p>
        <details><summary class="cursor-pointer">Offline public holiday civil dates (not bank closure facts)</summary><ul><li v-for="holiday in calendar.calendar.holidays" :key="holiday.date">{{ holiday.date }} — {{ holiday.name }}</li></ul></details>
      </template>
    </section>
    <button type="button" :disabled="busy" class="underline" @click="loadResearchPolicy">Load effective research policy and space settings</button>
    <section v-if="researchPolicy" aria-label="Effective research policy" class="space-y-2 rounded border p-3">
      <h3 class="font-medium">Effective research mode: {{ researchPolicy.resolved.mode }}</h3>
      <p>Only the intersection of installation, space, budget and current delegated authority permits external research. A child's opt-in cannot override ancestor denial. Missing credentials / unknown pricing still prevent dispatch. This policy view never sends a query.</p>
      <p>Effective providers: {{ researchPolicy.resolved.allowedProviderIds.join(', ') || 'None' }} · billing currency {{ researchPolicy.resolved.billingCurrency ?? 'Unknown' }} · daily searches {{ researchPolicy.resolved.maxSearchesPerDay }} · monthly billing cap {{ researchPolicy.resolved.maxSpendMinorUnitsPerMonth }} exact minor units · TTL {{ researchPolicy.resolved.cacheTtlHours }} hours.</p>
      <h4 class="font-medium">Installation policy — read-only</h4>
      <p>Version {{ researchPolicy.installation.version }} · mode {{ researchPolicy.installation.value.mode }} · providers {{ researchPolicy.installation.value.allowedProviderIds.join(', ') || 'None' }}</p>
      <p>Daily {{ researchPolicy.installation.value.maxSearchesPerDay }} · monthly {{ researchPolicy.installation.value.maxSpendMinorUnitsPerMonth }} billing minor units {{ researchPolicy.installation.value.billingCurrency }} · TTL {{ researchPolicy.installation.value.cacheTtlHours }} hours.</p>
      <p>Saved space version {{ researchPolicy.space.version }} · mode {{ researchPolicy.space.value.mode }}. Saved budget version {{ researchPolicy.budget.version }} · mode {{ researchPolicy.budget.value.mode }}. Budget controls/calendar remain a separate complete replacement above.</p>
      <p v-for="layer in researchPolicy.resolved.layers" :key="layer.kind">{{ layer.kind }} v{{ layer.version }}: {{ layer.mode }} · {{ layer.reason }}</p>
    </section>
    <form v-if="researchPolicy" aria-label="Space research policy" class="space-y-3" @submit.prevent="saveSpacePolicy">
      <fieldset :disabled="busy" class="grid gap-3 rounded border p-3 sm:grid-cols-2">
        <legend class="font-medium">Independent space research policy — version {{ researchPolicy.space.version }}</legend>
        <label><span class="block">Space provider mode</span><select v-model="spaceMode" aria-label="Space provider mode" class="w-full rounded border p-2 dark:bg-gray-950"><option value="disabled">Off / disabled</option><option value="local-only">Local-only</option><option value="external-allowed">External allowed (ancestor policy and separate consent still required)</option></select></label>
        <label><span class="block">Space provider allowlist (one exact ID per line)</span><textarea v-model="spaceProviders" aria-label="Space provider allowlist" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Space searches per UTC day</span><input v-model="spaceSearches" aria-label="Space daily search quota" type="number" min="0" step="1" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Space monthly billing cap (exact minor units)</span><input v-model="spaceSpend" aria-label="Space monthly billing quota minor units" type="number" min="0" step="1" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Space provider billing currency</span><input v-model="spaceCurrency" aria-label="Space provider billing currency" maxlength="3" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <label><span class="block">Space cache TTL hours (1–720)</span><input v-model="spaceTtl" aria-label="Space cache TTL hours" type="number" min="1" max="720" step="1" class="w-full rounded border p-2 dark:bg-gray-950" /></label>
        <p class="sm:col-span-2">This changes only the space policy, not the installation or budget calendar. Zero quota disables dispatch; caps cover application-dispatched usage, not other provider usage. Opt-in is not per-query consent.</p>
      </fieldset>
      <label class="block"><span class="block">{{ confirmationLabel }} — fresh confirmation for space policy</span><input v-model="spacePassword" type="password" autocomplete="current-password" class="rounded border p-2 dark:bg-gray-950" /></label>
      <button type="submit" :disabled="busy || !spacePassword" class="rounded border px-3 py-2">Save space research policy</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import type { MerchantPolicyView, MerchantPolicyInput, MerchantResearchPolicyView, MerchantCalendarLookup, MerchantCalendarSelection } from '@balanceframe/application';
import { ref } from 'vue';
import { merchantRequest } from '../utils/merchant-client';
import { reauthenticateHuman } from '../utils/reauthentication';
const policy = ref<MerchantPolicyView | null>(null);
const busy = ref(false); const error = ref(''); const outcome = ref(''); const password = ref('');
const mode = ref<MerchantPolicyView['value']['mode']>('local-only');
const providers = ref(''); const searches = ref('0'); const spend = ref('0'); const billingCurrency = ref(''); const ttl = ref('720');
const researchPolicy = ref<MerchantResearchPolicyView | null>(null);
const spaceMode = ref<MerchantPolicyView['value']['mode']>('local-only');
const spaceProviders = ref(''); const spaceSearches = ref('0'); const spaceSpend = ref('0');
const spaceCurrency = ref(''); const spaceTtl = ref('720'); const spacePassword = ref('');
const jurisdictions = ['US', 'CA', 'GB'];
interface CalendarForm { jurisdiction: string; subdivision: string; timeZone: string }
const budget = ref<CalendarForm>({ jurisdiction: '', subdivision: '', timeZone: '' });
const accounts = ref<Array<{ accountId: string; selection: CalendarForm }>>([]);
const lookupAccount = ref(''); const lookupYear = ref(String(new Date().getFullYear()));
const calendar = ref<MerchantCalendarLookup | null>(null);
const confirmationLabel = typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
  ? 'Disposable-demo confirmation (type CONFIRM)' : 'Account password';
function applyPolicy(value: MerchantPolicyView) {
  policy.value = value; mode.value = value.value.mode; providers.value = value.value.allowedProviderIds.join('\n');
  searches.value = String(value.value.maxSearchesPerDay); spend.value = String(value.value.maxSpendMinorUnitsPerMonth);
  billingCurrency.value = value.value.billingCurrency; ttl.value = String(value.value.cacheTtlHours);
  const selection = value.value.calendar?.budget;
  budget.value = { jurisdiction: selection?.jurisdiction ?? '', subdivision: selection?.subdivision ?? '', timeZone: selection?.timeZone ?? '' };
  accounts.value = (value.value.calendar?.accounts ?? []).map(account => ({ accountId: account.accountId, selection: { jurisdiction: account.selection?.jurisdiction ?? '', subdivision: account.selection?.subdivision ?? '', timeZone: account.selection?.timeZone ?? '' } }));
}
async function load() {
  if (busy.value) return;
  busy.value = true; error.value = ''; outcome.value = ''; policy.value = null; calendar.value = null; password.value = '';
  try { applyPolicy(await merchantRequest<MerchantPolicyView>('/api/merchant/policy')); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : 'Complete policy unavailable.'; }
  finally { busy.value = false; }
}
function selection(form: CalendarForm): MerchantCalendarSelection | null {
  if (!form.jurisdiction) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(form.timeZone)) throw new Error('Select a valid IANA time zone for each configured calendar.');
  try { new Intl.DateTimeFormat('en', { timeZone: form.timeZone }).format(0); }
  catch { throw new Error('Select a valid IANA time zone for each configured calendar.'); }
  return { jurisdiction: form.jurisdiction, subdivision: form.subdivision.trim() || null, timeZone: form.timeZone };
}
async function save() {
  if (busy.value || !policy.value || !password.value) return;
  error.value = ''; outcome.value = ''; const proof = password.value; password.value = '';
  let input: MerchantPolicyInput;
  try {
    const limits = [searches.value, spend.value, ttl.value].map(value => Number(value));
    if (limits.some(value => !Number.isSafeInteger(value) || value < 0) || limits[2]! < 1 || limits[2]! > 720 || !/^[A-Z]{3}$/.test(billingCurrency.value)) throw new Error('Enter safe nonnegative integer quotas, a 1–720 hour TTL and an explicit three-letter billing currency.');
    const ids = accounts.value.map(account => account.accountId);
    if (ids.some(id => !id || id.trim() !== id) || new Set(ids).size !== ids.length) throw new Error('Every account override needs a unique exact account ID.');
    const allowedProviderIds = providers.value.split(/[\n,]/).map(id => id.trim()).filter(Boolean);
    if (new Set(allowedProviderIds).size !== allowedProviderIds.length) throw new Error('Provider allowlist IDs must be unique.');
    input = { expectedVersion: policy.value.version, value: { ...policy.value.value, mode: mode.value, allowedProviderIds, maxSearchesPerDay: limits[0]!, maxSpendMinorUnitsPerMonth: limits[1]!, billingCurrency: billingCurrency.value, cacheTtlHours: limits[2]!, calendar: { budget: selection(budget.value), accounts: accounts.value.map(account => ({ accountId: account.accountId, selection: selection(account.selection) })) } } };
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'Invalid policy settings.'; return; }
  busy.value = true;
  try {
    await reauthenticateHuman(proof);
    applyPolicy(await merchantRequest<MerchantPolicyView>('/api/merchant/policy', 'PUT', input));
    calendar.value = null; researchPolicy.value = null; spacePassword.value = '';
    outcome.value = 'Policy saved on the server. Reload effective research policy after this budget change. No research or financial write was dispatched.';
  } catch (failure) { policy.value = null; calendar.value = null; error.value = failure instanceof Error ? failure.message : 'Policy save refused. Reload current authority.'; }
  finally { busy.value = false; }
}
async function lookup() {
  if (busy.value || !policy.value || !lookupAccount.value) return;
  error.value = ''; calendar.value = null;
  const year = Number(lookupYear.value);
  if (!Number.isSafeInteger(year)) { error.value = 'Select an integer civil year.'; return; }
  busy.value = true;
  try { calendar.value = await merchantRequest<MerchantCalendarLookup>(`/api/merchant/calendar?${new URLSearchParams({ accountId: lookupAccount.value, year: String(year) })}`); }
  catch (failure) { policy.value = null; error.value = failure instanceof Error ? failure.message : 'Calendar lookup unavailable.'; }
  finally { busy.value = false; }
}
async function loadResearchPolicy() {
  if (busy.value) return;
  busy.value = true; error.value = ''; outcome.value = ''; researchPolicy.value = null; spacePassword.value = '';
  try {
    const value = await merchantRequest<MerchantResearchPolicyView>('/api/merchant/research/policy');
    applyResearchPolicy(value);
  } catch { error.value = 'Effective research policy unavailable. Local review and independently loaded budget calendar remain usable.'; }
  finally { busy.value = false; }
}
function applyResearchPolicy(value: MerchantResearchPolicyView) {
  researchPolicy.value = value;
  spaceMode.value = value.space.value.mode; spaceProviders.value = value.space.value.allowedProviderIds.join('\n');
  spaceSearches.value = String(value.space.value.maxSearchesPerDay); spaceSpend.value = String(value.space.value.maxSpendMinorUnitsPerMonth);
  spaceCurrency.value = value.space.value.billingCurrency; spaceTtl.value = String(value.space.value.cacheTtlHours);
}
async function saveSpacePolicy() {
  if (busy.value || !researchPolicy.value || !spacePassword.value) return;
  error.value = ''; outcome.value = ''; const proof = spacePassword.value; spacePassword.value = '';
  let input: MerchantPolicyInput;
  try {
    const rawLimits = [spaceSearches.value, spaceSpend.value, spaceTtl.value];
    const limits = rawLimits.map(value => Number(value));
    if (rawLimits.some(value => !/^\d+$/.test(value)) || limits.some(value => !Number.isSafeInteger(value) || value < 0)
      || limits[2]! < 1 || limits[2]! > 720 || !/^[A-Z]{3}$/.test(spaceCurrency.value))
      throw new Error('Enter exact safe nonnegative integer space quotas, a 1–720 hour TTL and an explicit three-letter billing currency.');
    const allowedProviderIds = spaceProviders.value.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (new Set(allowedProviderIds).size !== allowedProviderIds.length) throw new Error('Space provider allowlist IDs must be unique.');
    input = { expectedVersion: researchPolicy.value.space.version, value: {
      mode: spaceMode.value, allowedProviderIds, maxSearchesPerDay: limits[0]!, maxSpendMinorUnitsPerMonth: limits[1]!,
      billingCurrency: spaceCurrency.value, cacheTtlHours: limits[2]!,
    } };
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'Invalid space policy settings.'; return; }
  busy.value = true;
  try {
    await reauthenticateHuman(proof);
    await merchantRequest<MerchantPolicyView>('/api/merchant/space-policy', 'PUT', input);
    applyResearchPolicy(await merchantRequest<MerchantResearchPolicyView>('/api/merchant/research/policy'));
    outcome.value = 'Space policy saved; effective ancestor/budget policy rechecked. No research or financial write was dispatched.';
  } catch (failure) {
    researchPolicy.value = null;
    error.value = failure instanceof Error ? failure.message : 'Space policy save refused. Reload current authority.';
  } finally { busy.value = false; }
}
</script>
