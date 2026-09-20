<template>
  <UCard
    ><template #header
      ><h2 class="font-semibold">Supplemental account facts — user-attested</h2></template
    >
    <p class="text-sm">
      These are your observations, not institution or provider evidence. Actual remains
      authoritative for recorded balances and category availability. Unknown fields stay unknown.
      Sync changes can invalidate a current-ledger confirmation.
    </p>
    <form class="mt-4 space-y-4" @submit.prevent="save">
      <fieldset :disabled="busy || !configuration.canConfigure" class="space-y-4">
        <label class="grid gap-1 text-sm"
          >Observation expiry (UTC)<input
            v-model="expiresAt"
            type="datetime-local"
            required
            class="rounded border bg-transparent p-2"
        /></label>
        <fieldset v-for="row in rows" :key="row.accountId" class="rounded border p-3">
          <legend class="px-1 font-semibold">{{ accountName(row.accountId) }}</legend>
          <label class="mb-3 block text-sm"
            ><input v-model="row.enabled" type="checkbox" /> Include supplemental observations for
            this account</label
          >
          <div v-if="row.enabled" class="space-y-3">
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label class="grid gap-1 text-sm"
                >Account kind<select v-model="row.kind" class="rounded border bg-transparent p-2">
                  <option value="">Unknown / not attested</option>
                  <option value="cash">Cash</option>
                  <option value="credit">Credit</option>
                </select></label
              ><label class="grid gap-1 text-sm"
                >Observed currency<input
                  v-model="row.currency"
                  pattern="[A-Z]{3}"
                  maxlength="3"
                  placeholder="Unknown"
                  class="rounded border bg-transparent p-2" /></label
              ><label class="grid gap-1 text-sm"
                >Ownership<select v-model="row.owned" class="rounded border bg-transparent p-2">
                  <option :value="null">Unknown</option>
                  <option :value="true">Owned</option>
                  <option :value="false">Not owned</option>
                </select></label
              ><label class="grid gap-1 text-sm"
                >Holds (minor units; blank = unknown)<input
                  v-model="row.holds"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  class="rounded border bg-transparent p-2"
              /></label>
            </div>
            <label class="flex items-start gap-2 rounded border border-amber-300 p-3 text-sm"
              ><input v-model="row.confirmed" type="checkbox" /> I checked this account's current
              Actual ledger against current account activity and confirm it is current. This is a
              manual attestation, not a bank sync.</label
            >
            <details v-if="row.kind === 'credit'" class="rounded border p-3">
              <summary class="cursor-pointer font-medium">
                Card authorization and payment facts
              </summary>
              <label class="my-3 block text-sm"
                ><input v-model="row.includeCredit" type="checkbox" /> Attest card authorization and
                due-date cash facts</label
              >
              <div v-if="row.includeCredit" class="grid gap-3 sm:grid-cols-2">
                <label class="grid gap-1 text-sm"
                  >Authorization available (minor units)<input
                    v-model="row.credit.authorizationAvailable.minorUnits"
                    pattern="[0-9]+"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Reserved payment cash (minor units)<input
                    v-model="row.credit.reservedCash.minorUnits"
                    pattern="[0-9]+"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Payment account<select
                    v-model="row.credit.paymentAccountId"
                    required
                    class="rounded border bg-transparent p-2"
                  >
                    <option value="">Choose account</option>
                    <option
                      v-for="account in configuration.accounts"
                      :key="account.id"
                      :value="account.id"
                    >
                      {{ account.name ?? 'Authorized account' }}
                    </option>
                  </select></label
                ><label class="grid gap-1 text-sm"
                  >Payment category<select
                    v-model="row.credit.paymentCategoryId"
                    required
                    class="rounded border bg-transparent p-2"
                  >
                    <option value="">Choose category</option>
                    <option
                      v-for="category in configuration.categories"
                      :key="category.id"
                      :value="category.id"
                    >
                      {{ category.name ?? 'Authorized category' }}
                    </option>
                  </select></label
                ><label class="grid gap-1 text-sm"
                  >Card due date (UTC)<input
                    v-model="row.credit.dueAt"
                    type="datetime-local"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Payment obligation reference<input
                    v-model="row.credit.economicObligationId"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="text-sm"
                  ><input v-model="row.credit.pendingIncludedInAuthorization" type="checkbox" />
                  Pending purchases already included in authorization available</label
                >
              </div>
            </details>
            <details class="rounded border p-3">
              <summary class="cursor-pointer font-medium">Additional scheduled obligations</summary>
              <p class="my-2 text-xs">
                These add to, never erase, imported ledger obligations. Use the same economic
                obligation reference for the same card payment to prevent duplicate reservation.
              </p>
              <div
                v-for="(obligation, index) in row.obligations"
                :key="obligation.id"
                class="mb-3 grid gap-2 rounded border p-2 sm:grid-cols-2"
              >
                <label class="grid gap-1 text-sm"
                  >Economic obligation reference<input
                    v-model="obligation.economicObligationId"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Amount (minor units)<input
                    v-model="obligation.amount.minorUnits"
                    pattern="[0-9]+"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Due (UTC)<input
                    v-model="obligation.dueAt"
                    type="datetime-local"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Category<select
                    v-model="obligation.categoryId"
                    class="rounded border bg-transparent p-2"
                  >
                    <option :value="null">No category</option>
                    <option
                      v-for="category in configuration.categories"
                      :key="category.id"
                      :value="category.id"
                    >
                      {{ category.name ?? 'Authorized category' }}
                    </option>
                  </select></label
                ><label class="text-sm"
                  ><input v-model="obligation.paid" type="checkbox" /> Already paid</label
                ><label class="text-sm"
                  ><input v-model="obligation.includedInBalance" type="checkbox" /> Already included
                  in recorded balance</label
                ><button
                  type="button"
                  class="text-sm underline"
                  @click="row.obligations.splice(index, 1)"
                >
                  Remove supplemental obligation
                </button>
              </div>
              <button type="button" class="text-sm underline" @click="addObligation(row)">
                Add obligation
              </button>
            </details>
            <details class="rounded border p-3">
              <summary class="cursor-pointer font-medium">
                Additional pending / uncleared activity
              </summary>
              <p class="my-2 text-xs">
                Manual activity is not settlement evidence. These entries add to imported activity;
                an empty list does not establish complete coverage.
              </p>
              <div
                v-for="(flow, index) in row.flows"
                :key="flow.id"
                class="mb-3 grid gap-2 rounded border p-2 sm:grid-cols-2"
              >
                <label class="grid gap-1 text-sm"
                  >Economic obligation reference<input
                    v-model="flow.economicObligationId"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="grid gap-1 text-sm"
                  >Direction<select
                    v-model="flow.direction"
                    class="rounded border bg-transparent p-2"
                  >
                    <option value="outflow">Outflow</option>
                    <option value="inflow">Inflow</option>
                  </select></label
                ><label class="grid gap-1 text-sm"
                  >Amount (minor units)<input
                    v-model="flow.amount.minorUnits"
                    pattern="[0-9]+"
                    required
                    class="rounded border bg-transparent p-2" /></label
                ><label class="text-sm"
                  ><input v-model="flow.includedInBalance" type="checkbox" /> Already included in
                  recorded balance</label
                ><button
                  type="button"
                  class="text-sm underline"
                  @click="row.flows.splice(index, 1)"
                >
                  Remove supplemental activity
                </button>
              </div>
              <button type="button" class="text-sm underline" @click="addFlow(row)">
                Add pending / uncleared activity
              </button>
            </details>
          </div>
        </fieldset>
        <UButton :disabled="busy" @click="save">{{
          busy ? 'Saving observations…' : 'Save user-attested observations'
        }}</UButton>
      </fieldset>
    </form>
    <p v-if="error" role="alert" class="mt-3 text-red-600">{{ error }}</p>
    <p v-if="saved" role="status" class="mt-3">
      Observations saved. Current results must be reevaluated.
    </p>
  </UCard>
</template>
<script setup lang="ts">
import type {
  PublicLiquidityConfiguration,
  PublicUserAttestedObservation,
} from '@balanceframe/application';
import type {
  CashObligation,
  CreditLiquidityFact,
  UnsettledFlow,
} from '@balanceframe/protocol-generated';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
interface ObservationRow {
  accountId: string;
  enabled: boolean;
  kind: '' | 'cash' | 'credit';
  currency: string;
  owned: boolean | null;
  holds: string;
  confirmed: boolean;
  includeCredit: boolean;
  credit: Omit<CreditLiquidityFact, 'evidence'>;
  obligations: CashObligation[];
  flows: UnsettledFlow[];
}
const props = defineProps<{ configuration: PublicLiquidityConfiguration }>();
const emit = defineEmits<{ saved: [configuration: PublicLiquidityConfiguration] }>();
const rows = ref<ObservationRow[]>(
  props.configuration.accounts.map((account) => {
    const observation = props.configuration.observations.find(
      (item) => item.accountId === account.id,
    );
    const currency = observation?.currency ?? '';
    const credit = observation?.credit;
    return {
      accountId: account.id,
      enabled: !!observation,
      kind: observation?.kind === 'cash' || observation?.kind === 'credit' ? observation.kind : '',
      currency,
      owned: observation?.owned ?? null,
      holds: observation?.holds?.minorUnits ?? '',
      confirmed: false,
      includeCredit: !!credit,
      credit: credit
        ? {
            ...credit,
            authorizationAvailable: { ...credit.authorizationAvailable },
            reservedCash: { ...credit.reservedCash },
            dueAt: credit.dueAt.slice(0, 16),
          }
        : {
            authorizationAvailable: { minorUnits: '', currency },
            reservedCash: { minorUnits: '', currency },
            paymentAccountId: '',
            paymentCategoryId: '',
            dueAt: '',
            economicObligationId: crypto.randomUUID(),
            pendingIncludedInAuthorization: false,
          },
      obligations: (observation?.obligations ?? []).map((item) => ({
        ...item,
        amount: { ...item.amount },
        dueAt: item.dueAt.slice(0, 16),
      })),
      flows: (observation?.unsettledFlows ?? []).map((flow) => ({
        ...flow,
        amount: { ...flow.amount },
      })),
    };
  }),
);
const expiresAt = ref(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
const busy = ref(false);
const error = ref('');
const saved = ref(false);
function accountName(id: string) {
  return (
    props.configuration.accounts.find((account) => account.id === id)?.name ?? 'Authorized account'
  );
}
function addObligation(row: ObservationRow) {
  const id = crypto.randomUUID();
  row.obligations.push({
    id,
    economicObligationId: id,
    categoryId: null,
    amount: { minorUnits: '', currency: row.currency },
    dueAt: '',
    paid: false,
    includedInBalance: false,
    matchedTransactionIds: [],
  });
}
function addFlow(row: ObservationRow) {
  const id = crypto.randomUUID();
  row.flows.push({
    id,
    economicObligationId: id,
    direction: 'outflow',
    amount: { minorUnits: '', currency: row.currency },
    includedInBalance: false,
    matchedTransactionIds: [],
    scheduleId: null,
    transferTransactionId: null,
    importedId: null,
    reconciled: false,
    provenance: 'manual_ledger',
  });
}
async function save() {
  if (busy.value || !props.configuration.canConfigure) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    const observations: PublicUserAttestedObservation[] = rows.value
      .filter((row) => row.enabled)
      .map((row) => ({
        accountId: row.accountId,
        ...(row.kind ? { kind: row.kind } : {}),
        ...(row.currency ? { currency: row.currency } : {}),
        ...(row.owned !== null ? { owned: row.owned } : {}),
        ...(row.holds !== '' ? { holds: { minorUnits: row.holds, currency: row.currency } } : {}),
        ...(row.confirmed ? { currentLedgerConfirmed: true as const } : {}),
        ...(row.includeCredit && row.kind === 'credit'
          ? {
              credit: {
                ...row.credit,
                authorizationAvailable: {
                  ...row.credit.authorizationAvailable,
                  currency: row.currency,
                },
                reservedCash: { ...row.credit.reservedCash, currency: row.currency },
                dueAt: new Date(`${row.credit.dueAt}Z`).toISOString(),
              },
            }
          : {}),
        ...(row.obligations.length
          ? {
              obligations: row.obligations.map((item) => ({
                ...item,
                amount: { ...item.amount, currency: row.currency },
                dueAt:
                  item.dueAt.length === 10 ? item.dueAt : new Date(`${item.dueAt}Z`).toISOString(),
              })),
            }
          : {}),
        ...(row.flows.length
          ? {
              unsettledFlows: row.flows.map((flow) => ({
                ...flow,
                amount: { ...flow.amount, currency: row.currency },
              })),
            }
          : {}),
      }));
    const configuration = await liquidityRequest<PublicLiquidityConfiguration>(
      '/api/liquidity/observations',
      'PUT',
      {
        expectedVersion: props.configuration.observationVersion,
        expiresAt: new Date(`${expiresAt.value}Z`).toISOString(),
        observations,
      },
    );
    saved.value = true;
    emit('saved', configuration);
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
</script>
