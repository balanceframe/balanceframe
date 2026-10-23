<template>
  <details class="rounded border p-3">
    <summary class="cursor-pointer font-medium">Reviewed receipt item rules</summary>
    <p class="my-2">
      Simulate scoped item criteria against current reviewed receipt history. Priority is source
      SKU/UPC, exact approved item, exact retailer label, department, product family, then approved
      deterministic historical text match. Broader rules require two independent human-reviewed
      sources. Unmatched items remain available for manual category review. Approved rules produce
      local suggestions; ledger changes require a separate proposal.
    </p>
    <button
      type="button"
      data-testid="load-item-rules"
      :disabled="busy"
      class="rounded border px-3 py-2"
      @click="load"
    >
      {{ loaded ? 'Refresh item rules' : 'Load item rules' }}
    </button>
    <p v-if="busy" role="status">Checking current item-rule sources…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="loaded">
      <fieldset :disabled="busy" class="my-3 grid gap-3 sm:grid-cols-2">
        <legend class="font-medium">Narrow item criteria</legend>
        <label
          >Receipt source<select
            v-model="form.connectorId"
            data-testid="item-rule-source"
            class="block w-full rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Choose source</option>
            <option v-for="id in connectorIds" :key="id" :value="id">{{ id }}</option>
          </select></label
        >
        <label
          >Account<select
            v-model="form.accountId"
            data-testid="item-rule-account"
            class="block w-full rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Choose account</option>
            <option v-for="account in targets.accounts" :key="account.id" :value="account.id">
              {{ account.name }}
            </option>
          </select></label
        >
        <label
          >Exact merchant / counterparty<input
            v-model="form.counterparty"
            data-testid="item-rule-merchant"
            maxlength="256"
            class="block w-full rounded border p-2 dark:bg-gray-950"
        /></label>
        <label
          >Funding instrument reference<input
            v-model="form.fundingInstrumentId"
            data-testid="item-rule-funding"
            class="block w-full rounded border p-2 dark:bg-gray-950"
        /></label>
        <label
          >Criterion<select
            v-model="form.criterionKind"
            data-testid="item-rule-criterion"
            class="block w-full rounded border p-2 dark:bg-gray-950"
          >
            <option value="exact">Exact source SKU / UPC or approved item</option>
            <option value="retailer_mapping">Exact retailer receipt label</option>
            <option value="department">Department</option>
            <option value="product_family">Product family</option>
            <option value="historical_similarity">Approved historical text match</option>
          </select></label
        >
        <template v-if="form.criterionKind === 'exact'">
          <label
            >Exact source SKU / UPC<input
              v-model="form.sku"
              data-testid="item-rule-sku"
              class="block w-full rounded border p-2 dark:bg-gray-950"
          /></label>
          <label
            >Exact approved normalized item<input
              v-model="form.normalizedDescription"
              class="block w-full rounded border p-2 dark:bg-gray-950"
          /></label>
        </template>
        <label v-else
          >Exact reviewed value<input
            v-model="form.criterionValue"
            data-testid="item-rule-criterion-value"
            maxlength="256"
            class="block w-full rounded border p-2 dark:bg-gray-950"
        /></label>
        <p v-if="form.criterionKind === 'historical_similarity'">
          Deterministic text comparison requires at least two distinct reference tokens and 80%
          token-set overlap. This is an approved text rule; no model inference runs here.
        </p>
        <label
          >Suggested category<select
            v-model="form.categoryId"
            data-testid="item-rule-category"
            class="block w-full rounded border p-2 dark:bg-gray-950"
          >
            <option value="">Choose category</option>
            <option v-for="category in targets.categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select></label
        >
        <button
          type="button"
          data-testid="learn-item-candidates"
          :disabled="!form.connectorId || !form.accountId"
          class="rounded border px-3 py-2"
          @click="loadCandidates"
        >
          Inspect repeated reviewed outcomes
        </button>
        <button
          type="button"
          data-testid="simulate-item-rule"
          :disabled="!validForm"
          class="rounded border px-3 py-2"
          @click="simulate"
        >
          Simulate item rule
        </button>
        <button
          type="button"
          data-testid="load-item-suggestions"
          :disabled="!form.accountId"
          class="rounded border px-3 py-2"
          @click="loadSuggestions"
        >
          Check approved suggestions
        </button>
      </fieldset>
    </template>
    <section v-if="learning" aria-label="Repeated reviewed item patterns" class="space-y-2">
      <p>
        Only explicit current human line reviews count. Repeated patterns require separate proposal
        and approval.
      </p>
      <p v-if="!learning.candidates.length">
        No consistent pattern has two independent reviewed sources.
      </p>
      <details v-if="learning.reviewedOutcomes.length">
        <summary>Current human review provenance</summary>
        <p
          v-for="outcome in learning.reviewedOutcomes"
          :key="`${outcome.documentId}:${outcome.lineId}`"
        >
          {{ outcome.actorId }} · {{ outcome.reviewedAt }} · policy {{ outcome.policyVersion }} ·
          {{ outcome.documentId }} / {{ outcome.lineId }} → {{ outcome.categoryId ?? 'Revoked' }}
        </p>
      </details>
      <p v-if="learning.conflicts.length">{{ learning.conflicts.join(', ') }}</p>
      <article
        v-for="candidate in learning.candidates"
        :key="candidate.candidateHash"
        class="rounded border p-3"
      >
        <p>
          Exact merchant {{ candidate.rule.counterparty }} · account
          {{ accountName(candidate.accountId) }} · funding
          {{ candidate.rule.fundingInstrumentId }} · {{ ruleLabel(candidate.rule) }} →
          {{ categoryName(candidate.rule.categoryId) }}
        </p>
        <p>
          {{ candidate.reviewCount }} independent reviewed sources · {{ candidate.candidateHash }}
        </p>
        <p v-for="example in candidate.examples" :key="`${example.receiptId}:${example.lineId}`">
          {{ example.documentId }} / {{ example.receiptId }} / {{ example.lineId }}
        </p>
        <button
          type="button"
          data-testid="propose-learned-item-rule"
          :disabled="busy"
          class="rounded border p-2"
          @click="proposeCandidate(candidate.candidateHash)"
        >
          Create proposal for separate review
        </button>
      </article>
    </section>
    <article v-for="rule in rules" :key="rule.id" class="my-3 space-y-2 rounded border p-3">
      <h3 class="font-medium">{{ ruleLabel(rule.rule) }} · {{ rule.state }}</h3>
      <p>
        Source {{ rule.connectorId }} / {{ rule.rule.sourceId }} · funding
        {{ rule.rule.fundingInstrumentId }} · account {{ accountName(rule.accountId) }} · category
        {{ categoryName(rule.rule.categoryId) }}
      </p>
      <p>
        {{ ruleTier(rule.rule) }} · Exact merchant {{ rule.rule.counterparty }} · SKU
        {{ rule.rule.sku ?? 'Any' }} · item
        {{ rule.rule.normalizedDescription ?? 'Any' }}
      </p>
      <details v-if="rule.learning">
        <summary>Repeated-outcome proposal provenance</summary>
        <p>{{ rule.learning.candidateHash }}</p>
        <p
          v-for="outcome in rule.learning.outcomes"
          :key="`${outcome.documentId}:${outcome.lineId}`"
        >
          {{ outcome.actorId }} · {{ outcome.reviewedAt }} · policy {{ outcome.policyVersion }} ·
          {{ outcome.documentId }} / {{ outcome.lineId }}
        </p>
      </details>
      <p>
        {{ rule.simulation.matches.length }} historical matches ·
        {{ rule.simulation.falsePositiveRisk }} · conflicts:
        {{ rule.simulation.conflicts.join(', ') || 'None identified' }}
      </p>
      <p>
        Current Actual rules considered:
        {{ rule.actualInteraction.actualRuleIds.join(', ') || 'None' }}
      </p>
      <ul>
        <li v-for="example in rule.examples" :key="`${example.receiptId}:${example.lineId}`">
          {{ example.rawDescription }} · {{ example.normalizedDescription }} ·
          <SemanticAmount :amount="example.amount" /> · {{ example.receiptId }} /
          {{ example.lineId }} · source {{ example.documentId }}
        </li>
      </ul>
      <p>Policy {{ rule.policyVersion }} · expires {{ rule.expiresAt }}</p>
      <p class="break-all font-mono">{{ rule.payloadHash }}</p>
      <ul v-if="rule.approvals.length">
        <li v-for="(approval, index) in rule.approvals" :key="index">
          {{ approval.action }} by {{ approval.actorId }} at {{ approval.at }}
        </li>
      </ul>
      <button
        v-if="rule.state === 'proposed' || rule.state === 'revoked'"
        type="button"
        data-testid="approve-item-rule"
        :disabled="
          busy || !password || !!rule.simulation.conflicts.length || !rule.simulation.matches.length
        "
        class="rounded border px-3 py-2"
        @click="decide(rule, 'approve')"
      >
        Approve displayed item rule
      </button>
      <button
        v-if="rule.state === 'approved'"
        type="button"
        data-testid="revoke-item-rule"
        :disabled="busy || !password"
        class="rounded border px-3 py-2"
        @click="decide(rule, 'revoke')"
      >
        Revoke item rule
      </button>
    </article>
    <label v-if="loaded" class="block"
      >{{ confirmationLabel
      }}<input
        v-model="password"
        data-testid="item-rule-password"
        type="password"
        autocomplete="current-password"
        class="ml-2 rounded border p-2 dark:bg-gray-950"
        :disabled="busy"
    /></label>
    <ul v-if="suggestions.length" aria-label="Local item suggestions">
      <li
        v-for="suggestion in suggestions"
        :key="`${suggestion.proposalId}:${suggestion.receiptId}:${suggestion.lineId}`"
      >
        {{ suggestion.receiptId }} / {{ suggestion.lineId }} →
        {{ categoryName(suggestion.categoryId) }} · {{ suggestion.state }} ·
        {{ suggestion.reasonCodes.join(', ') }}
      </li>
    </ul>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { evidenceRequest, evidenceTargetsSchema } from '../utils/transaction-evidence-client';
import {
  evidenceItemRuleViewSchema,
  evidenceItemRulesViewSchema,
  evidenceItemSuggestionsViewSchema,
  evidenceItemCandidatesViewSchema,
} from '../utils/evidence-item-rules-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import SemanticAmount from './SemanticAmount.vue';
const props = defineProps<{ connectorIds: string[]; refreshKey?: number }>();
type Rule = ReturnType<typeof evidenceItemRuleViewSchema.parse>;
const busy = ref(false);
const loaded = ref(false);
const error = ref('');
const password = ref('');
const rules = ref<Rule[]>([]);
const learning = ref<ReturnType<typeof evidenceItemCandidatesViewSchema.parse> | null>(null);
const suggestions = ref<ReturnType<typeof evidenceItemSuggestionsViewSchema.parse>>([]);
const targets = ref<ReturnType<typeof evidenceTargetsSchema.parse>>({
  accounts: [],
  categories: [],
});
const emptyForm = () => ({
  connectorId: '',
  accountId: '',
  fundingInstrumentId: '',
  counterparty: '',
  sku: '',
  normalizedDescription: '',
  categoryId: '',
  criterionKind: 'exact' as
    'exact' | 'retailer_mapping' | 'department' | 'product_family' | 'historical_similarity',
  criterionValue: '',
});
const form = ref(emptyForm());
const validForm = computed(
  () =>
    props.connectorIds.includes(form.value.connectorId) &&
    targets.value.accounts.some((value) => value.id === form.value.accountId) &&
    targets.value.categories.some((value) => value.id === form.value.categoryId) &&
    !!form.value.fundingInstrumentId.trim() &&
    !!form.value.counterparty.trim() &&
    (form.value.criterionKind === 'exact'
      ? !!form.value.sku.trim() || !!form.value.normalizedDescription.trim()
      : !!form.value.criterionValue.trim()),
);
function ruleTier(rule: Rule['rule']): string {
  return rule.criterion
    ? {
        retailer_mapping: 'Exact retailer label',
        department: 'Department',
        product_family: 'Product family',
        historical_similarity: 'Approved deterministic historical text match (80% token overlap)',
      }[rule.criterion.kind]
    : rule.sku
      ? 'Exact source SKU / UPC'
      : 'Exact approved item';
}
function ruleLabel(rule: Rule['rule']): string {
  return `${ruleTier(rule)}: ${rule.criterion?.value ?? rule.sku ?? rule.normalizedDescription}`;
}
const accountName = (id: string) =>
  targets.value.accounts.find((value) => value.id === id)?.name ?? id;
const categoryName = (id: string) =>
  targets.value.categories.find((value) => value.id === id)?.name ?? id;
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
let generation = 0;
function clear() {
  generation++;
  loaded.value = false;
  busy.value = false;
  error.value = '';
  password.value = '';
  rules.value = [];
  learning.value = null;
  suggestions.value = [];
  targets.value = { accounts: [], categories: [] };
  form.value = emptyForm();
}
watch(() => [props.refreshKey, props.connectorIds.join('\0')], clear);
watch(
  () => [form.value.connectorId, form.value.accountId],
  () => {
    generation++;
    busy.value = false;
    learning.value = null;
    password.value = '';
  },
);
onUnmounted(clear);
async function run(operation: (current: () => boolean) => Promise<void>) {
  const ticket = ++generation;
  busy.value = true;
  error.value = '';
  const current = () => generation === ticket;
  try {
    await operation(current);
  } catch {
    if (current()) {
      error.value =
        'Item rules unavailable. Refresh current sources and permissions before retrying.';
      rules.value = [];
      learning.value = null;
      suggestions.value = [];
    }
  } finally {
    if (current()) {
      busy.value = false;
      password.value = '';
    }
  }
}
async function load() {
  await run(async (current) => {
    const result = await evidenceRequest('/api/evidence/rules', evidenceItemRulesViewSchema);
    if (!current()) return;
    const names = await evidenceRequest('/api/evidence/targets', evidenceTargetsSchema);
    if (current()) {
      rules.value = result;
      targets.value = names;
      loaded.value = true;
      suggestions.value = [];
    }
  });
}
async function loadCandidates() {
  const body = { connectorId: form.value.connectorId, accountId: form.value.accountId };
  await run(async (current) => {
    const result = await evidenceRequest(
      '/api/evidence/rules/candidates',
      evidenceItemCandidatesViewSchema,
      'POST',
      body,
    );
    if (current()) learning.value = result;
  });
}
async function proposeCandidate(candidateHash: string) {
  const prior = learning.value;
  if (!prior || Date.parse(prior.expiresAt) <= Date.now()) {
    learning.value = null;
    return;
  }
  await run(async (current) => {
    const rule = await evidenceRequest(
      '/api/evidence/rules/from-candidate',
      evidenceItemRuleViewSchema,
      'POST',
      { connectorId: prior.connectorId, accountId: prior.accountId, candidateHash },
    );
    if (current()) {
      rules.value = [...rules.value, rule];
      learning.value = null;
    }
  });
}
async function simulate() {
  if (!validForm.value) return;
  const { criterionKind, criterionValue, ...base } = form.value;
  const body = {
    ...base,
    fundingInstrumentId: form.value.fundingInstrumentId.trim(),
    sku: criterionKind === 'exact' ? form.value.sku.trim() || null : null,
    normalizedDescription:
      criterionKind === 'exact' ? form.value.normalizedDescription.trim() || null : null,
    ...(criterionKind === 'exact'
      ? {}
      : { criterion: { kind: criterionKind, value: criterionValue } }),
  };
  await run(async (current) => {
    const rule = await evidenceRequest(
      '/api/evidence/rules',
      evidenceItemRuleViewSchema,
      'POST',
      body,
    );
    if (current()) {
      rules.value = [...rules.value, rule];
      suggestions.value = [];
    }
  });
}
async function decide(rule: Rule, action: 'approve' | 'revoke') {
  const confirmation = password.value;
  const body = { proposalId: rule.id, payloadHash: rule.payloadHash };
  await run(async (current) => {
    await reauthenticateHuman(confirmation);
    if (!current()) return;
    const result = await evidenceRequest(
      `/api/evidence/rules/${action}`,
      evidenceItemRuleViewSchema,
      'POST',
      body,
    );
    if (current()) {
      rules.value = rules.value.map((value) => (value.id === result.id ? result : value));
      suggestions.value = [];
    }
  });
}
async function loadSuggestions() {
  const body = { accountId: form.value.accountId };
  await run(async (current) => {
    const result = await evidenceRequest(
      '/api/evidence/rules/suggestions',
      evidenceItemSuggestionsViewSchema,
      'POST',
      body,
    );
    if (current()) suggestions.value = result;
  });
}
</script>
