<template>
  <details class="rounded border p-3" data-testid="receipt-version-review">
    <summary>Review receipt or invoice versions</summary>
    <p>
      Select a newer receipt and the older version it replaces. This records your interpretation of
      local evidence.
    </p>
    <button type="button" :disabled="busy" data-testid="receipt-version-load" @click="load">
      Load readable receipt versions
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <fieldset v-if="context" class="space-y-3" :disabled="busy">
      <label class="block"
        >Review action<select v-model="mode" data-testid="receipt-version-mode">
          <option value="replace">Review a replacement</option>
          <option value="revoke">Remove a reviewed relationship</option>
        </select></label
      >
      <template v-if="mode === 'replace'">
        <p v-if="!context.children.length">
          No receipts with item facts are available. Summary-only photos cannot be versioned here.
        </p>
        <label class="block"
          >Newer receipt<select v-model="childKey" data-testid="receipt-version-child">
            <option value="">Choose a current receipt</option>
            <option v-for="entry in context.children" :key="key(entry)" :value="key(entry)">
              {{ entry.label }} · {{ entry.merchant }} · {{ entry.date }} ·
              {{ entry.total.minorUnits }} {{ entry.total.currency }} minor units
            </option>
          </select></label
        >
        <label class="block"
          >Older receipt<select v-model="parentKey" data-testid="receipt-version-parent">
            <option value="">Choose the exact older receipt</option>
            <option v-for="entry in predecessors" :key="key(entry)" :value="key(entry)">
              {{ entry.label }} · {{ entry.merchant }} · {{ entry.date }} ·
              {{ entry.total.minorUnits }} {{ entry.total.currency }} minor units
            </option>
          </select></label
        >
        <button
          type="button"
          :disabled="busy || !selection"
          data-testid="receipt-version-preview"
          @click="prepare"
        >
          Preview version relationship
        </button>
        <div v-if="preview" data-testid="receipt-version-proof">
          <p>
            The newer receipt becomes version {{ preview.version }} and replaces version
            {{ preview.predecessorVersion }}.
          </p>
          <p>
            Identity:
            {{
              preview.identityBasis === 'matching_external_id'
                ? 'matching source receipt identifier, subject to your review'
                : 'your explicit confirmation of the same logical receipt'
            }}.
          </p>
          <p v-for="source in preview.sourceClosure" :key="key(source)">
            {{ source.documentId }} · {{ source.receiptId }} · {{ source.parserVersion }} · SHA-256
            {{ source.contentHash }}
          </p>
        </div>
      </template>
      <template v-else>
        <p>
          Removing a reviewed relationship does not recover deleted photos or grant access to older
          sources.
        </p>
        <label class="block"
          >Reviewed newer receipt<select
            v-model="revokeKey"
            data-testid="receipt-version-revoke-child"
          >
            <option value="">Choose an owned relationship</option>
            <option v-for="entry in revocable" :key="key(entry)" :value="key(entry)">
              {{ entry.documentId }} · {{ entry.receiptId }}
            </option>
          </select></label
        >
      </template>
      <label class="block"
        ><input v-model="confirmed" type="checkbox" data-testid="receipt-version-confirm" />{{
          mode === 'replace'
            ? 'I reviewed both sources and confirm that these are versions of the same receipt or invoice, not two separate purchases or refunds.'
            : 'I explicitly want to remove this reviewed version relationship.'
        }}</label
      >
      <label class="block"
        >{{ confirmationLabel
        }}<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          data-testid="receipt-version-password"
      /></label>
      <button
        v-if="mode === 'replace'"
        type="button"
        :disabled="busy || !preview || !selection || !confirmed || !password"
        data-testid="receipt-version-save"
        @click="save"
      >
        Save reviewed version relationship
      </button>
      <button
        v-else
        type="button"
        :disabled="busy || !revocation || !confirmed || !password"
        data-testid="receipt-version-revoke"
        @click="revoke"
      >
        Remove reviewed relationship
      </button>
    </fieldset>
  </details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { evidenceRequest } from '../utils/transaction-evidence-client';
import { reauthenticateHuman } from '../utils/reauthentication';
import {
  receiptVersionContextSchema,
  receiptVersionPreviewSchema,
  receiptVersionSavedSchema,
  receiptVersionRevokedSchema,
  type ReceiptVersionContext,
  type ReceiptVersionPreview,
} from '../utils/evidence-receipt-version-client';
const props = defineProps<{ sourceVersion: string }>();
const emit = defineEmits<{ saved: [] }>();
const context = ref<ReceiptVersionContext | null>(null),
  preview = ref<ReceiptVersionPreview | null>(null),
  mode = ref<'replace' | 'revoke'>('replace'),
  childKey = ref(''),
  parentKey = ref(''),
  revokeKey = ref(''),
  confirmed = ref(false),
  password = ref(''),
  busy = ref(false),
  error = ref('');
const confirmationLabel =
  typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true
    ? 'Disposable-demo confirmation (type CONFIRM)'
    : 'Account password';
const key = (source: { documentId: string; receiptId: string }) =>
  JSON.stringify([source.documentId, source.receiptId]);
const child = computed(() => context.value?.children.find((e) => key(e) === childKey.value));
const predecessors = computed(
  () =>
    context.value?.predecessors.filter(
      (e) => e.familyKey === child.value?.familyKey && e.documentId !== child.value?.documentId,
    ) ?? [],
);
const selection = computed(() => {
  const parent = predecessors.value.find((e) => key(e) === parentKey.value);
  return child.value && parent
    ? {
        resolutionHash: context.value!.resolutionHash,
        child: { documentId: child.value.documentId, receiptId: child.value.receiptId },
        predecessor: { documentId: parent.documentId, receiptId: parent.receiptId },
      }
    : null;
});
const revocable = computed(() => [
  ...new Map(
    [
      ...(context.value?.links.map((e) => e.child) ?? []),
      ...(context.value?.blockedChildren.map((e) => e.child) ?? []),
    ].map((e) => [key(e), e]),
  ).values(),
]);
const revocation = computed(() => revocable.value.find((e) => key(e) === revokeKey.value));
let generation = 0;
function invalidate() {
  generation++;
  preview.value = null;
  confirmed.value = false;
  password.value = '';
  busy.value = false;
  error.value = '';
}
watch([childKey, parentKey, mode, revokeKey], invalidate);
watch(childKey, () => {
  parentKey.value = '';
});
watch(
  () => props.sourceVersion,
  () => {
    invalidate();
    context.value = null;
    childKey.value = '';
    parentKey.value = '';
    revokeKey.value = '';
  },
);
onUnmounted(invalidate);
function unavailable(current: number) {
  if (current === generation)
    error.value =
      'Receipt version review unavailable. Refresh current sources, relationships and permissions.';
}
async function load() {
  if (busy.value) return;
  invalidate();
  const current = ++generation;
  busy.value = true;
  try {
    const value = await evidenceRequest(
      '/api/evidence/receipt-versions',
      receiptVersionContextSchema,
    );
    if (current !== generation) return;
    context.value = value;
  } catch {
    unavailable(current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function prepare() {
  if (busy.value || !selection.value) return;
  invalidate();
  const current = ++generation,
    body = selection.value;
  busy.value = true;
  try {
    const value = await evidenceRequest(
      '/api/evidence/receipt-versions/preview',
      receiptVersionPreviewSchema,
      'POST',
      body,
    );
    if (current !== generation) return;
    if (
      value.resolutionHash !== context.value?.resolutionHash ||
      value.foldHash !== context.value?.foldHash ||
      key(value.child) !== key(body.child) ||
      key(value.predecessor) !== key(body.predecessor)
    )
      throw new Error('Preview changed');
    preview.value = value;
  } catch {
    unavailable(current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function save() {
  if (busy.value || !selection.value || !preview.value || !confirmed.value || !password.value)
    return;
  const current = ++generation,
    body = {
      ...selection.value,
      previewHash: preview.value.previewHash,
      expectedFoldHash: preview.value.foldHash,
      sameReceiptAcknowledged: true,
    },
    secret = password.value;
  password.value = '';
  busy.value = true;
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    const result = await evidenceRequest(
      '/api/evidence/receipt-versions/save',
      receiptVersionSavedSchema,
      'POST',
      body,
    );
    if (current !== generation) return;
    if (key(result.child) !== key(body.child)) throw new Error('Saved source changed');
    invalidate();
    context.value = null;
    emit('saved');
  } catch {
    unavailable(current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function revoke() {
  if (busy.value || !revocation.value || !context.value || !confirmed.value || !password.value)
    return;
  const current = ++generation,
    body = {
      childDocumentId: revocation.value.documentId,
      childReceiptId: revocation.value.receiptId,
      expectedFoldHash: context.value.foldHash,
    },
    secret = password.value;
  password.value = '';
  busy.value = true;
  try {
    await reauthenticateHuman(secret);
    if (current !== generation) return;
    const result = await evidenceRequest(
      '/api/evidence/receipt-versions/revoke',
      receiptVersionRevokedSchema,
      'POST',
      body,
    );
    if (current !== generation) return;
    if (
      result.childDocumentId !== body.childDocumentId ||
      result.childReceiptId !== body.childReceiptId
    )
      throw new Error('Revoked source changed');
    invalidate();
    context.value = null;
    emit('saved');
  } catch {
    unavailable(current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
