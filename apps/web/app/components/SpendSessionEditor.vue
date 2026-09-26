<template>
  <section class="space-y-4">
    <UCard>
      <template #header><h2 class="font-semibold">Manual Spend Session</h2></template>
      <p class="text-sm">
        The cart is evaluated jointly. This session alone does not reserve funds; active commitments
        and reservations appear in the Decision Card. A transfer needs separate approval.
      </p>
      <p v-if="expired" role="status" class="mt-2 text-amber-700">
        Session expired. Extend the expiry and evaluate again before planning.
      </p>
      <p v-if="!editable" role="status">Read-only session. Your current permissions do not allow edits.</p>
      <form class="mt-4 space-y-4" @submit.prevent="save">
        <fieldset :disabled="!editable || busy" class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="grid gap-1 text-sm">
              Default payment account
              <select v-model="draft.accountId" class="rounded border bg-transparent p-2">
                <option :value="null">No default selected</option>
                <option v-for="account in catalog.accounts" :key="account.id" :value="account.id">
                  {{ account.name ?? 'Authorized account' }}
                </option>
              </select>
            </label>
            <label class="grid gap-1 text-sm">
              Session expiry (UTC)
              <input v-model="draft.expiresAt" type="datetime-local" required class="rounded border bg-transparent p-2" />
            </label>
          </div>
          <fieldset v-for="(item, index) in draft.items" :key="item.id" class="rounded border p-3">
            <legend class="px-1 font-medium">Item {{ index + 1 }}</legend>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label class="grid gap-1 text-sm">
                Category
                <select v-model="item.categoryId" required class="rounded border bg-transparent p-2">
                  <option value="">Choose a category</option>
                  <option v-for="category in catalog.categories" :key="category.id" :value="category.id">
                    {{ category.name ?? 'Authorized category' }}
                  </option>
                </select>
              </label>
              <label class="grid gap-1 text-sm">
                Unit price (minor units)
                <input v-model="item.amount.minorUnits" :data-testid="`session-amount-${item.id}`"
                  inputmode="numeric" pattern="[0-9]+" required class="rounded border bg-transparent p-2" />
              </label>
              <label class="grid gap-1 text-sm">
                Currency
                <input v-model="item.amount.currency" maxlength="3" pattern="[A-Z]{3}" required
                  class="rounded border bg-transparent p-2" />
              </label>
              <label class="grid gap-1 text-sm">
                Quantity
                <input v-model.number="item.quantity" :data-testid="`session-quantity-${item.id}`"
                  type="number" min="1" step="1" required class="rounded border bg-transparent p-2" />
              </label>
              <label class="grid gap-1 text-sm">
                Priority
                <select v-model="item.priority" :data-testid="`session-priority-${item.id}`"
                  class="rounded border bg-transparent p-2">
                  <option value="required">Required</option>
                  <option value="planned">Planned</option>
                  <option value="optional">Optional</option>
                </select>
              </label>
              <label class="grid gap-1 text-sm">
                Payment account
                <select v-model="item.accountId" class="rounded border bg-transparent p-2">
                  <option :value="null">Use session default</option>
                  <option v-for="account in catalog.accounts" :key="account.id" :value="account.id">
                    {{ account.name ?? 'Authorized account' }}
                  </option>
                </select>
              </label>
              <label class="grid gap-1 text-sm">
                Purchase time (UTC)
                <input v-model="item.purchaseAt" type="datetime-local" required class="rounded border bg-transparent p-2" />
              </label>
              <label class="grid gap-1 text-sm">
                Required by (UTC)
                <input v-model="item.requiredBy" type="datetime-local" required class="rounded border bg-transparent p-2" />
              </label>
              <label class="grid gap-1 text-sm">
                Barcode (optional; not a price source)
                <input v-model="item.barcode" class="rounded border bg-transparent p-2" />
              </label>
            </div>
            <fieldset class="mt-3 rounded border p-3">
              <legend class="text-sm font-medium">Category split · line total across all units</legend>
              <div v-for="(allocation, allocationIndex) in item.categoryAllocations"
                :key="allocationIndex" class="mt-2 flex flex-wrap gap-2">
                <label class="grid gap-1 text-sm">
                  Category
                  <select v-model="allocation.categoryId"
                    :data-testid="`session-allocation-${item.id}-${allocationIndex}-category`"
                    class="rounded border bg-transparent p-2">
                    <option value="">Choose a category</option>
                    <option v-for="category in catalog.categories" :key="category.id" :value="category.id">
                      {{ category.name ?? 'Authorized category' }}
                    </option>
                  </select>
                </label>
                <label class="grid gap-1 text-sm">
                  Amount (minor units)
                  <input v-model="allocation.amount.minorUnits"
                    :data-testid="`session-allocation-${item.id}-${allocationIndex}-amount`"
                    inputmode="numeric" pattern="[0-9]+" required class="rounded border bg-transparent p-2" />
                </label>
                <button type="button" class="self-end text-sm underline"
                  @click="item.categoryAllocations.splice(allocationIndex, 1)">Remove split</button>
              </div>
              <button type="button" class="mt-2 text-sm underline" @click="addAllocation(item)">
                Add category split
              </button>
              <p class="text-xs text-gray-600 dark:text-gray-400">
                The native evaluation checks split conservation against unit price × quantity.
              </p>
            </fieldset>
            <fieldset class="mt-3 rounded border p-3">
              <legend class="text-sm font-medium">Price source</legend>
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="grid gap-1 text-sm">
                  Source
                  <select v-model="item.priceKind" class="rounded border bg-transparent p-2">
                    <option value="current_session_manual">Entered in this session</option>
                    <option value="outside_price">Observed elsewhere / estimate</option>
                  </select>
                </label>
                <label v-if="item.priceKind === 'outside_price'" class="grid gap-1 text-sm">
                  Source description
                  <input v-model="item.priceSource" :data-testid="`session-price-source-${item.id}`"
                    required class="rounded border bg-transparent p-2" />
                </label>
                <label v-if="item.priceKind === 'outside_price'" class="grid gap-1 text-sm">
                  Store (optional)
                  <input v-model="item.priceStore" :data-testid="`session-price-store-${item.id}`"
                    class="rounded border bg-transparent p-2" />
                </label>
                <label class="grid gap-1 text-sm">
                  Observed at (UTC)
                  <input v-model="item.priceObservedAt" type="datetime-local" required
                    class="rounded border bg-transparent p-2" />
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input v-model="item.priceEstimate" :data-testid="`session-price-estimate-${item.id}`"
                    type="checkbox" />
                  Estimated price
                </label>
              </div>
            </fieldset>
            <button type="button" class="mt-3 text-sm text-red-600 underline"
              :aria-label="`Remove item ${index + 1}`" @click="draft.items.splice(index, 1)">
              Remove item
            </button>
          </fieldset>
          <p v-if="!draft.items.length">Add an item to evaluate your session.</p>
          <button type="button" class="rounded border px-3 py-2 text-sm" @click="addItem">Add item</button>
          <fieldset class="rounded border p-3">
            <legend class="font-medium">Tax, fee, and discount assumptions</legend>
            <div v-for="(adjustment, index) in draft.adjustments" :key="index"
              class="mt-2 grid gap-2 sm:grid-cols-4">
              <label class="grid gap-1 text-sm">
                Type
                <select v-model="adjustment.kind" class="rounded border bg-transparent p-2">
                  <option value="tax">Tax</option><option value="fee">Fee</option><option value="discount">Discount</option>
                </select>
              </label>
              <label class="grid gap-1 text-sm">
                Category
                <select v-model="adjustment.categoryId" class="rounded border bg-transparent p-2">
                  <option value="">Choose a category</option>
                  <option v-for="category in catalog.categories" :key="category.id" :value="category.id">
                    {{ category.name ?? 'Authorized category' }}
                  </option>
                </select>
              </label>
              <label class="grid gap-1 text-sm">
                Amount (minor units)
                <input v-model="adjustment.amount.minorUnits" :data-testid="`session-adjustment-${index}-amount`"
                  inputmode="numeric" pattern="[0-9]+" required class="rounded border bg-transparent p-2" />
              </label>
              <button type="button" class="self-end text-sm underline"
                @click="draft.adjustments.splice(index, 1)">Remove adjustment</button>
            </div>
            <button type="button" class="mt-2 text-sm underline" @click="addAdjustment">Add assumption</button>
          </fieldset>
          <fieldset class="rounded border p-3">
            <legend class="font-medium">Cart warnings</legend>
            <div v-for="(threshold, index) in draft.warningThresholds" :key="threshold.id"
              class="mt-2 grid gap-2 sm:grid-cols-4">
              <label class="grid gap-1 text-sm">
                Threshold for
                <select v-model="threshold.basis" class="rounded border bg-transparent p-2">
                  <option value="cart_total">Total cart</option>
                  <option value="category_charge">Category charge</option>
                </select>
              </label>
              <label v-if="threshold.basis === 'category_charge'" class="grid gap-1 text-sm">
                Category
                <select v-model="threshold.categoryId" class="rounded border bg-transparent p-2">
                  <option value="">Choose a category</option>
                  <option v-for="category in catalog.categories" :key="category.id" :value="category.id">
                    {{ category.name ?? 'Authorized category' }}
                  </option>
                </select>
              </label>
              <label class="grid gap-1 text-sm">
                Maximum (minor units)
                <input v-model="threshold.maximum.minorUnits" :data-testid="`session-threshold-${index}-maximum`"
                  inputmode="numeric" pattern="[0-9]+" required class="rounded border bg-transparent p-2" />
              </label>
              <button type="button" class="self-end text-sm underline"
                @click="draft.warningThresholds.splice(index, 1)">Remove warning</button>
            </div>
            <button type="button" class="mt-2 text-sm underline" @click="addThreshold">Add warning threshold</button>
          </fieldset>
        </fieldset>
        <p v-if="dirty && current" role="status" class="text-amber-700">
          Cart or assumptions changed. The previous Card and transfer previews are invalid.
          Evaluate changes before relying on a plan.
        </p>
        <UButton v-if="editable" :disabled="busy || !draft.items.length" @click="save">
          {{ busy ? 'Evaluating jointly…' : current ? 'Evaluate changes' : 'Create and evaluate session' }}
        </UButton>
      </form>
    </UCard>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <div v-if="current && !dirty && current.card.cart" data-testid="session-running-total" class="mt-4 font-semibold">
      Evaluated final total: <SemanticAmount :amount="current.card.cart.total" />
    </div>
    <DecisionCardView v-if="current && !dirty" :card="current.card" :catalog="catalog"
      @plan-transfer="planTransfer" />
    <TransferPlanReview v-if="preview && !dirty" :key="preview.previewId" :preview="preview"
      @close="preview = null" />
    <section v-if="current?.linkedTransfers.length">
      <h2 class="font-semibold">Related transfer proposals</h2>
      <p class="text-sm">Edits invalidate uninitiated plans. Already initiated transfer holds remain until resolved.</p>
      <ul>
        <li v-for="transfer in current.linkedTransfers" :key="transfer.id">
          <NuxtLink :to="`/transfer/${encodeURIComponent(transfer.id)}`" class="underline">
            Transfer — {{ transfer.phase.replaceAll('_', ' ') }}
            <span v-if="transfer.outcome"> · {{ transfer.outcome.replaceAll('_', ' ') }}</span>
          </NuxtLink>
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

type SessionItem = PublicSpendSession['items'][number];
type Priority = NonNullable<SessionItem['priority']>;
type Adjustment = PublicSpendSession['adjustments'][number];
type PriceKind = 'current_session_manual' | 'outside_price';
interface DraftItem {
  id: string;
  categoryId: string;
  amount: { minorUnits: string; currency: string };
  accountId: string | null;
  purchaseAt: string;
  requiredBy: string;
  quantity: number;
  priority: Priority;
  categoryAllocations: { categoryId: string; amount: { minorUnits: string; currency: string } }[];
  barcode: string;
  priceKind: PriceKind;
  priceSource: string;
  priceStore: string;
  priceObservedAt: string;
  priceEstimate: boolean;
}
interface DraftThreshold {
  id: string;
  basis: 'cart_total' | 'category_charge';
  categoryId: string;
  maximum: { minorUnits: string; currency: string };
}
interface DraftSession {
  accountId: string | null;
  expiresAt: string;
  items: DraftItem[];
  adjustments: Adjustment[];
  warningThresholds: DraftThreshold[];
}

const props = defineProps<{ session?: PublicSpendSession; catalog: PublicLiquidityView }>();
const emit = defineEmits<{ 'draft-state': [dirty: boolean]; saved: [session: PublicSpendSession] }>();
function draftFrom(session?: PublicSpendSession): DraftSession {
  return {
    accountId: session?.accountId ?? null,
    expiresAt: (session?.expiresAt ?? new Date(Date.now() + 3600000).toISOString()).slice(0, 16),
    items: session?.items.map((item) => ({
      id: item.id,
      categoryId: item.categoryId,
      amount: { ...item.amount },
      accountId: item.accountId,
      purchaseAt: item.purchaseAt.slice(0, 16),
      requiredBy: item.requiredBy.slice(0, 16),
      quantity: item.quantity ?? 1,
      priority: item.priority ?? 'planned',
      categoryAllocations: item.categoryAllocations?.map((part) => ({
        categoryId: part.categoryId,
        amount: { ...part.amount },
      })) ?? [],
      barcode: item.barcode ?? '',
      priceKind: item.priceProvenance?.kind ?? 'current_session_manual',
      priceSource: item.priceProvenance?.source ?? '',
      priceStore: item.priceProvenance?.store ?? '',
      priceObservedAt: (item.priceProvenance?.observedAt ?? new Date().toISOString()).slice(0, 16),
      priceEstimate: item.priceProvenance?.estimate ?? false,
    })) ?? [],
    adjustments: session?.adjustments.map((adjustment) => ({
      ...adjustment,
      amount: { ...adjustment.amount },
    })) ?? [],
    warningThresholds: session?.warningThresholds.map((threshold) => ({
      id: threshold.id,
      basis: threshold.basis,
      categoryId: threshold.basis === 'category_charge' ? threshold.categoryId : '',
      maximum: { ...threshold.maximum },
    })) ?? [],
  };
}
const current = ref<PublicSpendSession | null>(props.session ?? null);
const draft = ref<DraftSession>(draftFrom(props.session));
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
watch(dirty, (value) => emit('draft-state', value), { flush: 'sync' });
function addItem() {
  const time = new Date().toISOString().slice(0, 16);
  draft.value.items.push({
    id: crypto.randomUUID(),
    categoryId: '',
    amount: { minorUnits: '', currency: 'USD' },
    accountId: null,
    purchaseAt: time,
    requiredBy: time,
    quantity: 1,
    priority: 'planned',
    categoryAllocations: [],
    barcode: '',
    priceKind: 'current_session_manual',
    priceSource: '',
    priceStore: '',
    priceObservedAt: time,
    priceEstimate: false,
  });
}
if (!props.session) addItem();
function addAllocation(item: DraftItem) {
  item.categoryAllocations.push({
    categoryId: '',
    amount: { minorUnits: '', currency: item.amount.currency },
  });
}
function addAdjustment() {
  draft.value.adjustments.push({
    kind: 'tax',
    categoryId: '',
    amount: { minorUnits: '', currency: draft.value.items[0]?.amount.currency ?? 'USD' },
  });
}
function addThreshold() {
  draft.value.warningThresholds.push({
    id: crypto.randomUUID(),
    basis: 'cart_total',
    categoryId: '',
    maximum: { minorUnits: '', currency: draft.value.items[0]?.amount.currency ?? 'USD' },
  });
}
function utc(value: string): string {
  return new Date(`${value}Z`).toISOString();
}
function sessionItem(item: DraftItem): SessionItem {
  const observedAt = utc(item.priceObservedAt);
  const store = item.priceStore.trim();
  const priceProvenance: NonNullable<SessionItem['priceProvenance']> =
    item.priceKind === 'outside_price'
      ? {
          kind: 'outside_price',
          source: item.priceSource.trim(),
          ...(store ? { store } : {}),
          observedAt,
          estimate: item.priceEstimate,
        }
      : { kind: 'current_session_manual', observedAt, estimate: item.priceEstimate };
  return {
    id: item.id,
    categoryId: item.categoryId,
    amount: item.amount,
    accountId: item.accountId,
    purchaseAt: utc(item.purchaseAt),
    requiredBy: utc(item.requiredBy),
    quantity: item.quantity,
    priority: item.priority,
    ...(item.categoryAllocations.length ? { categoryAllocations: item.categoryAllocations } : {}),
    ...(item.barcode.trim() ? { barcode: item.barcode.trim() } : {}),
    priceProvenance,
  };
}
async function save() {
  if (!editable.value || busy.value || !draft.value.items.length) return;
  busy.value = true;
  error.value = '';
  preview.value = null;
  try {
    const body = {
      accountId: draft.value.accountId,
      expiresAt: utc(draft.value.expiresAt),
      items: draft.value.items.map(sessionItem),
      adjustments: draft.value.adjustments,
      warningThresholds: draft.value.warningThresholds.map(({ id, basis, categoryId, maximum }) =>
        basis === 'category_charge'
          ? { id, basis, categoryId, maximum }
          : { id, basis, maximum },
      ),
      ...(current.value ? { expectedVersion: current.value.version } : {}),
    };
    const created = !current.value;
    const saved = await liquidityRequest<PublicSpendSession>(
      current.value
        ? `/api/spend-sessions/${encodeURIComponent(current.value.id)}`
        : '/api/spend-sessions',
      current.value ? 'PUT' : 'POST',
      body,
    );
    current.value = saved;
    draft.value = draftFrom(saved);
    dirty.value = false;
    emit('saved', saved);
    if (created) await navigateTo(`/spend-sessions/${encodeURIComponent(saved.id)}`);
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    busy.value = false;
  }
}
async function planTransfer(purchaseItemId: string) {
  if (!current.value || dirty.value || busy.value || !purchaseItemId) return;
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
