<template>
  <UCard
    ><template #header><h2 class="font-semibold">Member and resource access</h2></template>
    <p class="text-sm">
      Grants apply only while membership is current. Observe-only and invited users inherit no
      private-account access. A conclusion grant is separate from source, balance, approval and
      initiation-report permissions.
    </p>
    <p v-if="loading" role="status">Loading current member and resource catalog…</p>
    <p v-if="error" role="alert" class="mt-3 text-red-600">{{ error }}</p>
    <form v-if="catalog" class="mt-4 space-y-4" @submit.prevent="save">
      <fieldset :disabled="busy" class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid gap-1 text-sm"
            >Current member<select v-model="actorId" class="rounded border bg-transparent p-2">
              <option value="">Choose member</option>
              <option
                v-for="member in catalog.members"
                :key="member.actorId"
                :value="member.actorId"
              >
                {{ member.actorId }}
              </option>
            </select></label
          ><label class="grid gap-1 text-sm"
            >Resource<select v-model="resourceKey" class="rounded border bg-transparent p-2">
              <option value="">Choose resource</option>
              <option
                v-for="resource in catalog.resources"
                :key="key(resource)"
                :value="key(resource)"
              >
                {{ resource.resourceKind }} — {{ resource.name ?? resource.resourceId }}
              </option>
            </select></label
          >
        </div>
        <div
          v-if="actorId && selectedResource"
          class="grid gap-3 rounded border p-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <label
            v-for="capability in catalog.capabilities"
            :key="capability"
            class="flex items-start gap-2 text-sm"
            ><input
              type="checkbox"
              :checked="isGranted(capability)"
              @change="setGrant(capability, ($event.target as HTMLInputElement).checked)"
            /><span>{{
              capability === 'conclusion'
                ? 'Conclusion only (no private source or balance)'
                : capability.replaceAll('-', ' ')
            }}</span></label
          >
        </div>
        <p v-if="!catalog.members.length">No current members are available for scoped grants.</p>
        <label class="grid gap-1 text-sm">
          {{ demoMode ? 'Disposable-demo confirmation (type CONFIRM)' : 'Account password' }}
          <input v-model="password" type="password" autocomplete="current-password" required class="rounded border bg-transparent p-2" />
        </label>
        <UButton :disabled="busy || !changes.length || !password" @click="save">{{
          busy ? 'Saving access…' : 'Save scoped resource grants'
        }}</UButton>
      </fieldset>
    </form>
    <p v-if="saved" role="status" class="mt-3">
      Access updated. Existing result and action reads recheck current permissions.
    </p>
    <button v-if="error" type="button" class="mt-3 text-sm underline" @click="load">
      Reload access catalog
    </button>
  </UCard>
</template>
<script setup lang="ts">
import type { PublicLiquidityGrants, PublicLiquidityGrant } from '@balanceframe/application';
import { liquidityRequest, liquidityError } from '../utils/liquidity-client';
import { reauthenticateHuman } from '../utils/reauthentication';
const password = ref('');
const demoMode = useRuntimeConfig().public.demoMode === true;
const catalog = ref<PublicLiquidityGrants | null>(null);
const changes = ref<PublicLiquidityGrant[]>([]);
const actorId = ref('');
const resourceKey = ref('');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
function key(resource: { resourceKind: string; resourceId: string }) {
  return `${resource.resourceKind}:${resource.resourceId}`;
}
const selectedResource = computed(() =>
  catalog.value?.resources.find((resource) => key(resource) === resourceKey.value),
);
function isGranted(capability: PublicLiquidityGrant['capability']) {
  const matches = (grant: PublicLiquidityGrant) =>
    grant.actorId === actorId.value &&
    key(grant) === resourceKey.value &&
    grant.capability === capability;
  return (changes.value.find(matches) ?? catalog.value?.grants.find(matches))?.granted ?? false;
}
function setGrant(capability: PublicLiquidityGrant['capability'], granted: boolean) {
  const resource = selectedResource.value;
  if (!resource) return;
  const existing = changes.value.find(
    (grant) =>
      grant.actorId === actorId.value &&
      key(grant) === resourceKey.value &&
      grant.capability === capability,
  );
  if (existing) existing.granted = granted;
  else
    changes.value.push({
      actorId: actorId.value,
      resourceKind: resource.resourceKind,
      resourceId: resource.resourceId,
      capability,
      granted,
    });
  saved.value = false;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    catalog.value = await liquidityRequest<PublicLiquidityGrants>('/api/liquidity/grants');
    changes.value = [];
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (busy.value || !changes.value.length || !password.value) return;
  busy.value = true;
  error.value = '';
  let passwordSnapshot = password.value;
  password.value = '';
  try {
    await reauthenticateHuman(passwordSnapshot);
    passwordSnapshot = '';
    catalog.value = await liquidityRequest<PublicLiquidityGrants>('/api/liquidity/grants', 'PUT', {
      grants: changes.value,
    });
    changes.value = [];
    saved.value = true;
  } catch (e) {
    error.value = liquidityError(e);
  } finally {
    passwordSnapshot = '';
    busy.value = false;
  }
}
onMounted(load);
</script>
