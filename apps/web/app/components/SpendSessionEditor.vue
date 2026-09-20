<template>
  <section class="space-y-4">
    <UCard
      ><template #header
        ><h2 class="font-semibold">
          Manual Spend Session
          <span class="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">UNRESERVED</span>
        </h2></template
      >
      <p class="text-sm">
        All items are evaluated jointly against the same category funding and account capacity. This
        session does not reserve money. Transfer proposals separately hold source capacity.
      </p>
      <p v-if="expired" role="status" class="mt-2 text-amber-700">
        Session expired. Extend the expiry and evaluate again before planning.
      </p>
      <p v-if="!editable" role="status">
        Read-only session. Your current permissions do not allow edits.
      </p>
      <form class="mt-4 space-y-4" @submit.prevent="save">
        <fieldset :disabled="!editable || busy" class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="grid gap-1 text-sm"
              >Default payment account<select
                v-model="draft.accountId"
                class="rounded border bg-transparent p-2"
              >
                <option :value="null">No default selected</option>
                <option v-for="account in catalog.accounts" :key="account.id" :value="account.id">
                  {{ account.name ?? 'Authorized account' }}
                </option>
              </select></label
            ><label class="grid gap-1 text-sm"
              >Session expiry (UTC)<input
                v-model="draft.expiresAt"
                type="datetime-local"
                required
                class="rounded border bg-transparent p-2"
            /></label>
          </div>
          <fieldset v-for="(item, index) in draft.items" :key="item.id" class="rounded border p-3">
            <legend class="px-1 font-medium">Item {{ index + 1 }}</legend>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label class="grid gap-1 text-sm"
                >Category<select
                  v-model="item.categoryId"
                  required
                  class="rounded border bg-transparent p-2"
                >
                  <option value="">Choose a category</option>
                  <option
                    v-for="category in catalog.categories"
                    :key="category.id"
                    :value="category.id"
                  >
                    {{ category.name ?? 'Authorized category' }}
                  </option>
                </select></label
              >
              <label class="grid gap-1 text-sm"
                >Amount (minor units)<input
                  v-model="item.amount.minorUnits"
                  :data-testid="`session-amount-${item.id}`"
                  inputmode="numeric"
                  pattern="[0-9]+"
                  required
                  class="rounded border bg-transparent p-2"
              /></label>
              <label class="grid gap-1 text-sm"
                >Currency<input
                  v-model="item.amount.currency"
                  maxlength="3"
                  pattern="[A-Z]{3}"
                  required
                  class="rounded border bg-transparent p-2"
              /></label>
              <label class="grid gap-1 text-sm"
                >Payment account<select
                  v-model="item.accountId"
                  class="rounded border bg-transparent p-2"
                >
                  <option :value="null">Use session default</option>
                  <option v-for="account in catalog.accounts" :key="account.id" :value="account.id">
                    {{ account.name ?? 'Authorized account' }}
                  </option>
                </select></label
              >
              <label class="grid gap-1 text-sm"
                >Purchase time (UTC)<input
                  v-model="item.purchaseAt"
                  type="datetime-local"
                  required
                  class="rounded border bg-transparent p-2" /></label
              ><label class="grid gap-1 text-sm"
                >Required by (UTC)<input
                  v-model="item.requiredBy"
                  type="datetime-local"
                  required
                  class="rounded border bg-transparent p-2"
              /></label>
            </div>
            <button
              type="button"
              class="mt-3 text-sm text-red-600 underline"
              :aria-label="`Remove item ${index + 1}`"
              @click="draft.items.splice(index, 1)"
            >
              Remove item
            </button>
          </fieldset>
          <p v-if="!draft.items.length">Add an item to evaluate your session.</p>
          <button type="button" class="rounded border px-3 py-2 text-sm" @click="addItem">
            Add item
          </button>
        </fieldset>
        <p v-if="dirty && current" role="status" class="text-amber-700">
          Items changed. Previous evaluation and transfer previews are invalid. Evaluate changes
          before relying on a plan.
        </p>
        <UButton v-if="editable" :disabled="busy || !draft.items.length" @click="save">{{
          busy
            ? 'Evaluating jointly…'
            : current
              ? 'Evaluate changes'
              : 'Create and evaluate session'
        }}</UButton>
      </form>
    </UCard>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <LiquidityResult
      v-if="current && !dirty"
      :view="current.evaluation"
      selectable
      @select-route="selectRoute"
      @plan-transfer="planTransfer"
    />
    <TransferPlanReview
      v-if="preview && !dirty"
      :key="preview.previewId"
      :preview="preview"
      @close="preview = null"
    />
    <section v-if="current?.linkedTransfers.length">
      <h2 class="font-semibold">Related transfer proposals</h2>
      <p class="text-sm">
        Edits invalidate uninitiated plans. Already initiated transfer holds remain until resolved.
      </p>
      <ul>
        <li v-for="transfer in current.linkedTransfers" :key="transfer.id">
          <NuxtLink :to="`/transfer/${encodeURIComponent(transfer.id)}`" class="underline"
            >Transfer — {{ transfer.phase.replaceAll('_', ' ')
            }}<span v-if="transfer.outcome">
              · {{ transfer.outcome.replaceAll('_', ' ') }}</span
            ></NuxtLink
          >
        </li>
      </ul>
    </section>
  </section>
</template>
<script setup lang="ts">
import type {
  PublicLiquidityView,
  PublicSpendSession,
  PublicTransferPreview,
} from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
const props = defineProps<{ session?: PublicSpendSession; catalog: PublicLiquidityView }>();
const current = ref(props.session ?? null);
const draft = ref({
  accountId: props.session?.accountId ?? (null as string | null),
  expiresAt: (props.session?.expiresAt ?? new Date(Date.now() + 3600000).toISOString()).slice(
    0,
    16,
  ),
  items:
    props.session?.items.map((item) => ({
      ...item,
      amount: { ...item.amount },
      purchaseAt: item.purchaseAt.slice(0, 16),
      requiredBy: item.requiredBy.slice(0, 16),
    })) ?? [],
});
const dirty = ref(false);
const busy = ref(false);
const error = ref('');
const preview = ref<PublicTransferPreview | null>(null);
const editable = computed(() =>
  current.value ? current.value.canEdit : props.catalog.canCreateSession,
);
const expired = computed(() =>
  current.value ? Date.parse(current.value.expiresAt) <= Date.now() : false,
);
watch(
  draft,
  () => {
    dirty.value = true;
    preview.value = null;
  },
  { deep: true, flush: 'sync' },
);
function addItem() {
  const time = new Date().toISOString().slice(0, 16);
  draft.value.items.push({
    id: crypto.randomUUID(),
    categoryId: '',
    amount: { minorUnits: '', currency: 'USD' },
    accountId: null,
    purchaseAt: time,
    requiredBy: time,
  });
}
if (!props.session) addItem();
function selectRoute(accountId: string, itemId: string) {
  const item = draft.value.items.find((item) => item.id === itemId);
  if (item) item.accountId = accountId;
}
async function save() {
  if (!editable.value || busy.value) return;
  busy.value = true;
  error.value = '';
  preview.value = null;
  try {
    const body = {
      accountId: draft.value.accountId,
      expiresAt: new Date(`${draft.value.expiresAt}Z`).toISOString(),
      items: draft.value.items.map((item) => ({
        ...item,
        purchaseAt: new Date(`${item.purchaseAt}Z`).toISOString(),
        requiredBy: new Date(`${item.requiredBy}Z`).toISOString(),
      })),
      ...(current.value ? { expectedVersion: current.value.version } : {}),
    };
    const created = !current.value;
    current.value = await liquidityRequest<PublicSpendSession>(
      current.value
        ? `/api/spend-sessions/${encodeURIComponent(current.value.id)}`
        : '/api/spend-sessions',
      current.value ? 'PUT' : 'POST',
      body,
    );
    dirty.value = false;
    if (created) await navigateTo(`/spend-sessions/${encodeURIComponent(current.value.id)}`);
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
async function planTransfer(purchaseItemId: string) {
  if (!current.value || dirty.value || busy.value) return;
  busy.value = true;
  error.value = '';
  preview.value = null;
  const version = current.value.version;
  try {
    const result = await liquidityRequest<PublicTransferPreview>('/api/transfer/preview', 'POST', {
      kind: 'session',
      sessionId: current.value.id,
      expectedSessionVersion: version,
      purchaseItemId,
    });
    if (!dirty.value && current.value.version === version) preview.value = result;
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
</script>
