<template>
  <section class="space-y-4" aria-labelledby="prospective-claims-heading">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="prospective-claims-heading" class="text-xl font-semibold">
          Reservations and commitments
        </h2>
        <p class="text-sm text-gray-500">
          These are BalanceFrame workflow claims for this saved session, not ledger transactions.
        </p>
      </div>
      <button
        type="button"
        class="rounded border px-3 py-2 text-sm"
        :disabled="loading"
        aria-label="Refresh shared claims"
        data-testid="refresh-claims"
        @click="loadClaims"
      >
        Refresh shared claims
      </button>
    </div>

    <p v-if="loading" role="status">Loading shared claims…</p>
    <p v-if="error" role="alert" class="text-red-600">
      {{ error }}
      <button
        type="button"
        class="ml-2 underline"
        data-testid="retry-claims"
        @click="loadClaims"
      >
        Retry loading claims
      </button>
    </p>

    <article v-if="cardCart" class="rounded border p-4" aria-labelledby="create-claim-heading">
      <h3 id="create-claim-heading" class="font-semibold">Create a reservation or commitment</h3>
      <p class="mt-1 text-sm text-gray-600">
        Choose one category or payment account charge from the current Card. The server derives the
        claim amount from that native charge; this form never accepts or calculates an amount.
      </p>
      <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="createClaim">
        <label class="grid gap-1 text-sm" for="claim-kind">
          Kind
          <select
            id="claim-kind"
            v-model="kind"
            class="rounded border bg-transparent p-2"
            data-testid="claim-kind"
          >
            <option value="reservation">Reservation</option>
            <option value="commitment">Commitment</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm" for="claim-scope">
          Card scope
          <select
            id="claim-scope"
            v-model="scopeKey"
            class="rounded border bg-transparent p-2"
            data-testid="claim-scope"
            required
          >
            <option value="">Choose a category or account</option>
            <option v-for="option in scopeOptions" :key="option.key" :value="option.key">
              {{ option.label }} — {{ option.amount.minorUnits }} minor units {{ option.amount.currency }}
            </option>
          </select>
        </label>
        <div v-if="selectedScope" class="text-sm sm:col-span-2" data-testid="selected-scope">
          Selected {{ selectedScope.label }}:
          <SemanticAmount :amount="selectedScope.amount" />
        </div>
        <button
          type="submit"
          class="rounded border px-3 py-2 text-sm sm:col-span-2 sm:w-fit"
          :disabled="creating || !selectedScope"
          data-testid="create-claim"
        >
          {{ creating ? 'Creating claim…' : `Create ${kind}` }}
        </button>
      </form>
      <p v-if="creating" role="status" class="mt-2">Saving the workflow claim…</p>
      <p v-if="actionError" role="alert" class="mt-2 text-red-600">{{ actionError }}</p>
      <p v-if="actionStatus" role="status" class="mt-2 text-green-700">{{ actionStatus }}</p>
    </article>
    <p v-else role="status">
      This saved session has no current native Card charges available for a claim scope.
    </p>

    <section aria-labelledby="shared-claims-heading" class="space-y-3">
      <h3 id="shared-claims-heading" class="font-semibold">Shared claims</h3>
      <p v-if="!loading && !claims.length" class="text-sm">No shared reservations or commitments.</p>
      <ul v-else class="space-y-3">
        <li
          v-for="(claim, index) in claims"
          :key="claim.claimId ?? `restricted-${index}`"
          :data-testid="isVisibleClaim(claim) ? `claim-${claim.claimId}` : 'restricted-claim'"
          class="rounded border p-3"
        >
          <template v-if="isVisibleClaim(claim)">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="font-medium">
                  {{ claim.kind }} · {{ scopeLabel(claim.scope) }}
                </p>
                <p :data-testid="`claim-${claim.claimId}-status`" class="text-sm">
                  Status: {{ lifecycleLabel(claim.lifecycleState) }}
                </p>
              </div>
              <button
                v-if="canRelease(claim)"
                type="button"
                class="rounded border px-2 py-1 text-sm"
                :disabled="releasingClaimId === claim.claimId"
                :data-testid="`release-claim-${claim.claimId}`"
                @click="releaseClaim(claim)"
              >
                {{ releasingClaimId === claim.claimId ? 'Releasing…' : 'Release claim' }}
              </button>
            </div>
            <dl class="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <div>
                <dt class="font-medium">Mode</dt>
                <dd>{{ claim.mode }}</dd>
              </div>
              <div>
                <dt class="font-medium">Source</dt>
                <dd>{{ claim.sourceId }}</dd>
              </div>
              <div>
                <dt class="font-medium">Amount</dt>
                <dd><SemanticAmount :amount="claim.amount" /></dd>
              </div>
              <div>
                <dt class="font-medium">Effective from</dt>
                <dd>{{ claim.effectiveFrom }}</dd>
              </div>
              <div>
                <dt class="font-medium">Expires</dt>
                <dd>{{ claim.expiresAt ?? 'No expiry' }}</dd>
              </div>
            </dl>
            <p class="mt-2 text-xs text-gray-600">Workflow state only; not a ledger transaction or settlement.</p>
          </template>
          <template v-else>
            <p class="font-medium">Restricted shared claim — details hidden</p>
            <p class="text-sm text-gray-600">
              This shared claim contributes only to authorized aggregate results. Its identity,
              source, scope, and amount are not available to this user.
            </p>
          </template>
        </li>
      </ul>
    </section>

    <aside class="rounded border border-dashed p-3 text-sm" aria-label="Claim lifecycle notice">
      <p>
        A claim can be active, released, consumed, or expired, but it is never itself a ledger
        transaction. Consumed state is shown only from the workflow response after trusted ledger
        evidence; this panel has no consume control.
      </p>
    </aside>
  </section>
</template>

<script setup lang="ts">
import type { PublicLiquidityView, PublicSpendSession } from '@balanceframe/application';
import type {
  StoredProspectiveClaim,
  VisibleStoredProspectiveClaim,
} from '@balanceframe/workflow-store';
import SemanticAmount from './SemanticAmount.vue';
import { liquidityError, liquidityRequest } from '../utils/liquidity-client';

type ClaimKind = 'reservation' | 'commitment';
type ClaimScope =
  | { kind: 'category'; id: string }
  | { kind: 'account'; id: string };
type ScopeOption = {
  key: string;
  scope: ClaimScope;
  amount: { minorUnits: string; currency: string };
  label: string;
};

const props = defineProps<{
  session: PublicSpendSession;
  catalog?: PublicLiquidityView;
}>();

const claims = ref<StoredProspectiveClaim[]>([]);
const loading = ref(false);
const error = ref('');
const creating = ref(false);
const actionError = ref('');
const actionStatus = ref('');
const releasingClaimId = ref<string | null>(null);
const kind = ref<ClaimKind>('reservation');
const scopeKey = ref('');
const createKey = ref<string | null>(null);
const releaseKeys = new Map<string, string>();

const cardCart = computed(() => props.session.card.cart);

function catalogCategoryName(id: string): string {
  return props.catalog?.categories.find((category) => category.id === id)?.name ?? 'Authorized category';
}

function catalogAccountName(id: string): string {
  return props.catalog?.accounts.find((account) => account.id === id)?.name ?? 'Authorized account';
}

const scopeOptions = computed<ScopeOption[]>(() => {
  const cart = cardCart.value;
  if (!cart) return [];
  return [
    ...cart.categoryCharges.map((charge) => ({
      key: `category:${charge.categoryId}`,
      scope: { kind: 'category' as const, id: charge.categoryId },
      amount: charge.amount,
      label: `Category: ${catalogCategoryName(charge.categoryId)}`,
    })),
    ...cart.accountCharges.map((charge) => ({
      key: `account:${charge.accountId}`,
      scope: { kind: 'account' as const, id: charge.accountId },
      amount: charge.amount,
      label: `Account: ${catalogAccountName(charge.accountId)}`,
    })),
  ];
});

const selectedScope = computed(() =>
  scopeOptions.value.find((option) => option.key === scopeKey.value) ?? null,
);

function isVisibleClaim(claim: StoredProspectiveClaim): claim is VisibleStoredProspectiveClaim {
  return claim.visibility === 'visible' && claim.claimId !== null && claim.sourceId !== null && claim.amount !== null;
}

function scopeLabel(scope: VisibleStoredProspectiveClaim['scope']): string {
  if (scope.kind === 'global') return 'Global';
  return scope.kind === 'category'
    ? `Category: ${catalogCategoryName(scope.id)}`
    : `Account: ${catalogAccountName(scope.id)}`;
}

function lifecycleLabel(state: VisibleStoredProspectiveClaim['lifecycleState']): string {
  switch (state) {
    case 'active':
      return 'Active';
    case 'released':
      return 'Released';
    case 'consumed':
      return 'Consumed';
    case 'expired':
      return 'Expired';
  }
}

function canRelease(claim: VisibleStoredProspectiveClaim): boolean {
  if (claim.lifecycleState !== 'active') return false;
  const sourcePrefix = `session:${props.session.id}:`;
  const sourceVersion = claim.sourceId.startsWith(sourcePrefix)
    ? claim.sourceId.slice(sourcePrefix.length)
    : '';
  return /^\d+$/.test(sourceVersion);
}

function claimKey(): string {
  if (!createKey.value) createKey.value = crypto.randomUUID();
  return createKey.value;
}

async function loadClaims() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    claims.value = await liquidityRequest<StoredProspectiveClaim[]>('/api/liquidity/claims');
  } catch (failure) {
    error.value = liquidityError(failure);
  } finally {
    loading.value = false;
  }
}

async function createClaim() {
  const selected = selectedScope.value;
  if (!selected || creating.value) return;
  creating.value = true;
  actionError.value = '';
  actionStatus.value = '';
  try {
    const created = await liquidityRequest<StoredProspectiveClaim>('/api/liquidity/claims', 'POST', {
      sessionId: props.session.id,
      expectedSessionVersion: props.session.version,
      kind: kind.value,
      scope: selected.scope,
      idempotencyKey: claimKey(),
    });
    claims.value = [created, ...claims.value.filter((claim) => claim.claimId !== created.claimId)];
    actionStatus.value = `${kind.value} created from the selected native Card charge.`;
    createKey.value = null;
  } catch (failure) {
    actionError.value = liquidityError(failure);
  } finally {
    creating.value = false;
  }
}

async function releaseClaim(claim: VisibleStoredProspectiveClaim) {
  if (!canRelease(claim) || releasingClaimId.value) return;
  releasingClaimId.value = claim.claimId;
  actionError.value = '';
  actionStatus.value = '';
  try {
    const key = releaseKeys.get(claim.claimId) ?? crypto.randomUUID();
    releaseKeys.set(claim.claimId, key);
    const released = await liquidityRequest<StoredProspectiveClaim>(
      `/api/liquidity/claims/${encodeURIComponent(claim.claimId)}/release`,
      'POST',
      { idempotencyKey: key },
    );
    claims.value = claims.value.map((current) =>
      current.claimId === released.claimId ? released : current,
    );
    actionStatus.value = 'Claim released. It is no longer active.';
    releaseKeys.delete(claim.claimId);
  } catch (failure) {
    actionError.value = liquidityError(failure);
  } finally {
    releasingClaimId.value = null;
  }
}

watch([kind, scopeKey], () => {
  createKey.value = null;
  actionError.value = '';
  actionStatus.value = '';
});

onMounted(loadClaims);
</script>
