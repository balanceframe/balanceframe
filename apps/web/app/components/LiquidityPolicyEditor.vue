<template>
  <UCard
    ><template #header
      ><h2 class="font-semibold">Account policy and explicit transfer timing</h2></template
    >
    <p v-if="!configuration.policy" role="status">
      Setup required. Accounts are not assumed payment-ready until policy and required factual
      evidence are available.
    </p>
    <p class="text-sm">
      Policy sets eligibility and protected buffers; it cannot make missing account facts known. All
      money fields use exact minor units.
    </p>
    <form class="mt-4 space-y-4" @submit.prevent="save">
      <fieldset :disabled="busy || !configuration.canConfigure" class="space-y-4">
        <label class="grid gap-1 text-sm"
          >Policy expiry (UTC)<input
            v-model="expiresAt"
            type="datetime-local"
            required
            class="rounded border bg-transparent p-2"
        /></label>
        <fieldset v-for="account in accounts" :key="account.accountId" class="rounded border p-3">
          <legend class="px-1 font-semibold">{{ accountName(account.accountId) }}</legend>
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="grid gap-1 text-sm"
              >Account role<select v-model="account.role" class="rounded border bg-transparent p-2">
                <option v-for="role in roles" :key="role" :value="role">
                  {{ role.replaceAll('_', ' ') }}
                </option>
              </select></label
            ><label class="grid gap-1 text-sm"
              >Protected buffer (minor units)<input
                v-model="account.protectedBuffer.minorUnits"
                pattern="[0-9]+"
                inputmode="numeric"
                required
                class="rounded border bg-transparent p-2" /></label
            ><label class="grid gap-1 text-sm"
              >Currency<input
                v-model="account.protectedBuffer.currency"
                pattern="[A-Z]{3}"
                maxlength="3"
                required
                class="rounded border bg-transparent p-2"
            /></label>
          </div>
          <div class="my-3 flex flex-wrap gap-4 text-sm">
            <label
              ><input v-model="account.paymentEligible" type="checkbox" /> Payment eligible</label
            ><label
              ><input v-model="account.sourceEligible" type="checkbox" /> Transfer-source
              eligible</label
            ><label
              ><input v-model="account.backingEligible" type="checkbox" /> Category-backing
              eligible</label
            >
          </div>
          <label class="grid gap-1 text-sm"
            >Eligible categories (none selected means policy-wide eligibility)<select
              v-model="account.eligibleCategoryIds"
              multiple
              class="min-h-24 rounded border bg-transparent p-2"
            >
              <option
                v-for="category in configuration.categories"
                :key="category.id"
                :value="category.id"
              >
                {{ category.name ?? 'Authorized category' }}
              </option>
            </select></label
          >
          <label class="mt-3 grid gap-1 text-sm"
            >Restricted cash bucket references (comma-separated; empty means no explicit restricted
            bucket permission)<input
              :value="account.restrictedCashBucketIds.join(', ')"
              class="rounded border bg-transparent p-2"
              @input="
                account.restrictedCashBucketIds = split(($event.target as HTMLInputElement).value)
              "
          /></label>
        </fieldset>
        <label class="grid gap-1 text-sm">
          Reservation conflict policy
          <select v-model="reservationMode" class="rounded border bg-transparent p-2">
            <option value="inform">Inform about competing plans</option>
            <option value="block">Block plans that would reuse reserved funds</option>
          </select>
        </label>
        <p class="text-xs text-gray-600 dark:text-gray-400">
          Reservations are BalanceFrame workflow records, not Actual transactions or protected bank balances.
        </p>
        <h3 v-if="configuration.categories.length" class="font-semibold">
          Category spending policy
        </h3>
        <p v-if="configuration.categories.length" class="text-sm">
          Protected, goal, guilt-free, and discretionary categories keep their saved policy
          controls. A discretionary cooldown delays completion until the purchase is re-evaluated;
          it never promises that funds are held or reserved.
        </p>
        <label v-if="configuration.categories.length" class="grid gap-1 text-sm"
          >Add category policy<select
            v-model="categoryToAdd"
            class="rounded border bg-transparent p-2"
            @change="addCategoryPolicy"
          >
            <option value="">Choose an authorized category</option>
            <option
              v-for="category in availableCategoryPolicies"
              :key="category.id"
              :value="category.id"
            >
              {{ category.name ?? 'Authorized category' }}
            </option>
          </select></label
        >
        <fieldset
          v-for="categoryPolicy in categoryPolicies"
          :key="categoryPolicy.categoryId"
          class="rounded border p-3"
        >
          <legend class="px-1 font-semibold">{{ categoryName(categoryPolicy.categoryId) }}</legend>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label class="grid gap-1 text-sm"
              >Category kind<select
                v-model="categoryPolicy.kind"
                class="rounded border bg-transparent p-2"
              >
                <option v-for="kind in categoryKinds" :key="kind.value" :value="kind.value">
                  {{ kind.label }}
                </option>
              </select></label
            ><label class="grid gap-1 text-sm"
              >Minimum retained (minor units)<input
                v-model="categoryPolicy.minimumRetained.minorUnits"
                pattern="[0-9]+"
                inputmode="numeric"
                required
                class="rounded border bg-transparent p-2"
            /></label>
            <label class="grid gap-1 text-sm"
              >Retained currency<input
                v-model="categoryPolicy.minimumRetained.currency"
                pattern="[A-Z]{3}"
                maxlength="3"
                required
                class="rounded border bg-transparent p-2"
            /></label>
            <label class="grid gap-1 text-sm"
              >Projected remaining need (minor units)<input
                v-model="categoryPolicy.projectedRemainingNeed.minorUnits"
                pattern="[0-9]+"
                inputmode="numeric"
                required
                class="rounded border bg-transparent p-2"
            /></label>
            <label class="grid gap-1 text-sm"
              >Need currency<input
                v-model="categoryPolicy.projectedRemainingNeed.currency"
                pattern="[A-Z]{3}"
                maxlength="3"
                required
                class="rounded border bg-transparent p-2"
            /></label>
          </div>
          <label class="my-3 block text-sm"
            ><input v-model="categoryPolicy.donorEligible" type="checkbox" /> Donor eligible</label
          >
          <label v-if="categoryPolicy.kind === 'discretionary'" class="grid gap-1 text-sm"
            >Cooldown before completion (minutes, 0–10080)<input
              :value="categoryPolicy.cooldownMinutes ?? ''"
              type="number"
              min="0"
              max="10080"
              step="1"
              inputmode="numeric"
              :aria-describedby="cooldownHintId(categoryPolicy.categoryId)"
              class="rounded border bg-transparent p-2"
              @input="
                categoryPolicy.cooldownMinutes = optionalInteger(
                  ($event.target as HTMLInputElement).value,
                )
              "
          /></label>
          <p
            v-if="categoryPolicy.kind === 'discretionary'"
            :id="cooldownHintId(categoryPolicy.categoryId)"
            class="text-xs text-gray-500"
          >
            Completion waits this many minutes, then re-evaluates the same purchase. This delay
            does not hold or reserve funds.
          </p>
          <button
            v-if="newCategoryIds.includes(categoryPolicy.categoryId)"
            type="button"
            class="mt-3 text-sm text-red-600 underline"
            @click="removeCategoryPolicy(categoryPolicy.categoryId)"
          >
            Remove category policy
          </button>
        </fieldset>

        <h3 class="font-semibold">Transfer timing routes</h3>
        <p class="text-sm">
          No route timing is inferred. Supply either a known arrival instant or a complete calendar
          rule. Missing holiday coverage remains insufficient data.
        </p>
        <fieldset v-for="(route, index) in routes" :key="route.id" class="rounded border p-3">
          <legend class="px-1">Route {{ index + 1 }}</legend>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label class="grid gap-1 text-sm"
              >Source account<select
                v-model="route.sourceAccountId"
                required
                class="rounded border bg-transparent p-2"
              >
                <option value="">Choose source</option>
                <option
                  v-for="account in configuration.accounts"
                  :key="account.id"
                  :value="account.id"
                >
                  {{ account.name ?? 'Authorized account' }}
                </option>
              </select></label
            ><label class="grid gap-1 text-sm"
              >Destination account<select
                v-model="route.destinationAccountId"
                required
                class="rounded border bg-transparent p-2"
              >
                <option value="">Choose destination</option>
                <option
                  v-for="account in configuration.accounts"
                  :key="account.id"
                  :value="account.id"
                >
                  {{ account.name ?? 'Authorized account' }}
                </option>
              </select></label
            >
            <label class="grid gap-1 text-sm"
              >Known arrival (UTC, optional)<input
                :value="route.providerArrivalAt?.slice(0, 16) ?? ''"
                type="datetime-local"
                class="rounded border bg-transparent p-2"
                @input="
                  route.providerArrivalAt = utcOrNull(($event.target as HTMLInputElement).value)
                "
            /></label>
            <label class="grid gap-1 text-sm"
              >Calendar mode<select
                v-model="route.calendarMode"
                class="rounded border bg-transparent p-2"
              >
                <option :value="null">Unknown</option>
                <option value="instant">Instant</option>
                <option value="calendar_days">Calendar days</option>
                <option value="business_days">Business days</option>
              </select></label
            ><label class="grid gap-1 text-sm"
              >Delay (days)<input
                v-model.number="route.delayDays"
                type="number"
                min="0"
                required
                class="rounded border bg-transparent p-2"
            /></label>
            <label class="grid gap-1 text-sm"
              >UTC offset (minutes)<input
                :value="route.utcOffsetMinutes ?? ''"
                type="number"
                min="-840"
                max="840"
                class="rounded border bg-transparent p-2"
                @input="
                  route.utcOffsetMinutes = numberOrNull(($event.target as HTMLInputElement).value)
                " /></label
            ><label class="grid gap-1 text-sm"
              >Cutoff (minute of local day, 0–1439)<input
                :value="route.cutoffMinute ?? ''"
                type="number"
                min="0"
                max="1439"
                class="rounded border bg-transparent p-2"
                @input="
                  route.cutoffMinute = numberOrNull(($event.target as HTMLInputElement).value)
                "
            /></label>
            <label class="grid gap-1 text-sm"
              >Weekends available<select
                v-model="route.weekendsAvailable"
                class="rounded border bg-transparent p-2"
              >
                <option :value="null">Unknown</option>
                <option :value="true">Yes</option>
                <option :value="false">No</option>
              </select></label
            ><label class="grid gap-1 text-sm"
              >Holiday dates (YYYY-MM-DD, comma-separated)<input
                :value="route.holidays.join(', ')"
                class="rounded border bg-transparent p-2"
                @input="route.holidays = split(($event.target as HTMLInputElement).value)"
            /></label>
          </div>
          <label class="mt-3 block text-sm"
            ><input v-model="route.holidaysComplete" type="checkbox" /> Holiday calendar is complete
            for this policy horizon</label
          ><button
            type="button"
            class="mt-3 text-sm text-red-600 underline"
            @click="routes.splice(index, 1)"
          >
            Remove route {{ index + 1 }}
          </button>
        </fieldset>
        <button type="button" class="rounded border px-3 py-2 text-sm" @click="addRoute">
          Add transfer timing route
        </button>
        <fieldset class="rounded border p-3">
          <legend class="px-1 font-semibold">Transfer approval policy</legend>
          <label class="grid gap-1 text-sm"
            >Minimum distinct approvers<input
              v-model.number="approval.minimumApprovers"
              type="number"
              min="1"
              required
              class="rounded border bg-transparent p-2"
          /></label>
          <div
            v-for="(threshold, index) in approval.thresholds"
            :key="index"
            class="mt-3 grid gap-2 sm:grid-cols-4"
          >
            <label class="grid gap-1 text-sm"
              >Minimum amount (minor units)<input
                v-model="threshold.minimumMinorUnits"
                pattern="[0-9]+"
                required
                class="rounded border bg-transparent p-2" /></label
            ><label class="grid gap-1 text-sm"
              >Currency<input
                v-model="threshold.currency"
                pattern="[A-Z]{3}"
                required
                class="rounded border bg-transparent p-2" /></label
            ><label class="grid gap-1 text-sm"
              >Required approvers<input
                v-model.number="threshold.minimumApprovers"
                type="number"
                min="1"
                required
                class="rounded border bg-transparent p-2" /></label
            ><button
              type="button"
              class="text-sm underline"
              @click="approval.thresholds?.splice(index, 1)"
            >
              Remove threshold
            </button>
          </div>
          <button type="button" class="mt-3 text-sm underline" @click="addThreshold">
            Add approval threshold
          </button>
        </fieldset>
        <UButton :disabled="busy" @click="save">{{
          busy ? 'Saving policy…' : 'Save account policy and timing'
        }}</UButton>
      </fieldset>
    </form>
    <p v-if="error" role="alert" class="mt-3 text-red-600">{{ error }}</p>
    <p v-if="saved" role="status" class="mt-3">
      Policy saved. Reevaluate any open purchase or session.
    </p>
  </UCard>
</template>
<script setup lang="ts">
import type {
  PublicLiquidityConfiguration,
  PublicLiquidityPolicyInput,
} from '@balanceframe/application';
import type { AccountRole } from '@balanceframe/protocol-generated';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
const props = defineProps<{ configuration: PublicLiquidityConfiguration }>();
const emit = defineEmits<{ saved: [configuration: PublicLiquidityConfiguration] }>();
const roles: AccountRole[] = [
  'daily_spending',
  'bill_payment',
  'reserve',
  'savings',
  'restricted',
  'credit_payment',
  'cash',
  'excluded',
];
type CategoryPolicy = NonNullable<PublicLiquidityPolicyInput['categoryPolicies']>[number];
const categoryKinds = [
  { value: 'ordinary', label: 'Ordinary' },
  { value: 'protected', label: 'Protected' },
  { value: 'goal', label: 'Goal' },
  { value: 'guilt_free', label: 'Guilt-free' },
  { value: 'discretionary', label: 'Discretionary' },
] as const;

const accounts = ref<PublicLiquidityPolicyInput['accounts']>(
  props.configuration.accounts.map((account) => {
    const existing = props.configuration.policy?.accounts.find(
      (policy) => policy.accountId === account.id,
    );
    if (existing) {
      const { resourceScope: _scope, ...input } = existing;
      return {
        ...input,
        protectedBuffer: { ...input.protectedBuffer },
        eligibleCategoryIds: [...input.eligibleCategoryIds],
        restrictedCashBucketIds: [...input.restrictedCashBucketIds],
      };
    }
    return {
      accountId: account.id,
      role: 'excluded',
      protectedBuffer: { minorUnits: '', currency: account.currency ?? '' },
      paymentEligible: false,
      sourceEligible: false,
      backingEligible: false,
      eligibleCategoryIds: [],
      restrictedCashBucketIds: [],
      automationAllowed: false,
    };
  }),
);
const visibleCategoryIds = new Set(props.configuration.categories.map((category) => category.id));
const reservationMode = ref<'inform' | 'block'>(
  props.configuration.policy?.reservationMode ?? 'inform',
);
const categoryPolicies = ref<CategoryPolicy[]>(
  (props.configuration.policy?.categoryPolicies ?? [])
    .filter((policy) => visibleCategoryIds.has(policy.categoryId))
    .map((policy) => ({
      ...policy,
      minimumRetained: { ...policy.minimumRetained },
      projectedRemainingNeed: { ...policy.projectedRemainingNeed },
    })),
);
const newCategoryIds = ref<string[]>([]);
const categoryToAdd = ref('');
const availableCategoryPolicies = computed(() =>
  props.configuration.categories.filter(
    (category) =>
      !categoryPolicies.value.some((policy) => policy.categoryId === category.id) &&
      categoryCurrency(category.id) !== null,
  ),
);


const routes = ref<PublicLiquidityPolicyInput['transferRoutes']>(
  (props.configuration.policy?.transferRoutes ?? []).map(({ evidence: _evidence, ...route }) => ({
    ...route,
    holidays: [...route.holidays],
  })),
);
const approval = ref<PublicLiquidityPolicyInput['approvalPolicy']>({
  minimumApprovers: props.configuration.approvalPolicy?.minimumApprovers ?? 1,
  thresholds:
    props.configuration.approvalPolicy?.thresholds?.map((threshold) => ({ ...threshold })) ?? [],
});
const expiresAt = ref(
  (props.configuration.policy?.expiresAt ?? new Date(Date.now() + 86400000).toISOString()).slice(
    0,
    16,
  ),
);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
function accountName(id: string) {
  return (
    props.configuration.accounts.find((account) => account.id === id)?.name ?? 'Authorized account'
  );
}
function categoryName(id: string) {
  return (
    props.configuration.categories.find((category) => category.id === id)?.name ??
    'Authorized category'
  );
}
function categoryCurrency(id: string) {
  const category = props.configuration.categories.find((item) => item.id === id);
  return (
    category?.availabilityBefore?.currency ??
    category?.availabilityAfter?.currency ??
    category?.backing[0]?.amount.currency ??
    null
  );
}

function addCategoryPolicy() {
  const categoryId = categoryToAdd.value;
  const currency = categoryCurrency(categoryId);
  if (
    !categoryId ||
    !currency ||
    categoryPolicies.value.some((policy) => policy.categoryId === categoryId)
  ) {
    categoryToAdd.value = '';
    return;
  }
  categoryPolicies.value.push({
    categoryId,
    kind: 'ordinary',
    donorEligible: false,
    minimumRetained: { minorUnits: '0', currency },
    projectedRemainingNeed: { minorUnits: '0', currency },
  });
  newCategoryIds.value = [...newCategoryIds.value, categoryId];
  categoryToAdd.value = '';
}

function removeCategoryPolicy(categoryId: string) {
  if (!newCategoryIds.value.includes(categoryId)) return;
  const index = categoryPolicies.value.findIndex((policy) => policy.categoryId === categoryId);
  if (index >= 0) categoryPolicies.value.splice(index, 1);
  newCategoryIds.value = newCategoryIds.value.filter((id) => id !== categoryId);
}


function optionalInteger(value: string) {
  return value === '' ? undefined : Number(value);
}

function cooldownHintId(categoryId: string) {
  return `category-cooldown-${categoryId}`;
}

function split(value: string) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
function numberOrNull(value: string) {
  return value === '' ? null : Number(value);
}
function utcOrNull(value: string) {
  return value ? new Date(`${value}Z`).toISOString() : null;
}
function addRoute() {
  routes.value.push({
    id: crypto.randomUUID(),
    sourceAccountId: '',
    destinationAccountId: '',
    providerArrivalAt: null,
    calendarMode: null,
    delayDays: 0,
    utcOffsetMinutes: null,
    cutoffMinute: null,
    weekendsAvailable: null,
    holidaysComplete: false,
    holidays: [],
  });
}
function addThreshold() {
  (approval.value.thresholds ??= []).push({
    minimumMinorUnits: '',
    currency: 'USD',
    minimumApprovers: 1,
  });
}
function categoryPolicyForSave(policy: CategoryPolicy): CategoryPolicy {
  const copy = {
    ...policy,
    minimumRetained: { ...policy.minimumRetained },
    projectedRemainingNeed: { ...policy.projectedRemainingNeed },
  };
  if (copy.kind === 'discretionary' && copy.cooldownMinutes !== undefined) return copy;
  const { cooldownMinutes: _cooldown, ...withoutCooldown } = copy;
  return withoutCooldown;
}

async function save() {
  if (busy.value || !props.configuration.canConfigure) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    const input: PublicLiquidityPolicyInput = {
      expectedVersion: props.configuration.policy?.version ?? null,
      expiresAt: new Date(`${expiresAt.value}Z`).toISOString(),
      reservationMode: reservationMode.value,
      accounts: accounts.value,
      transferRoutes: routes.value,
      ...(props.configuration.policy?.categoryPolicies !== undefined || categoryPolicies.value.length
        ? { categoryPolicies: categoryPolicies.value.map(categoryPolicyForSave) }
        : {}),
      approvalPolicy: approval.value,
    };
    const configuration = await liquidityRequest<PublicLiquidityConfiguration>(
      '/api/liquidity/policy',
      'PUT',
      { ...input },
    );
    newCategoryIds.value = [];
    saved.value = true;
    emit('saved', configuration);
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
</script>
