<template>
  <section class="space-y-3 rounded border p-3" aria-label="Categorization preview">
    <h5 class="font-medium">Preview categorization</h5>
    <p class="text-sm">
      Connecting to Actual may upload pending changes or archives, run migrations, or post
      configured scheduled transactions, including during shutdown. This preview does not submit the
      proposed categorization. Execution and independent human approvals remain separate.
    </p>
    <button
      type="button"
      class="underline disabled:opacity-50"
      :disabled="busy || disabled || !active || !identity"
      @click="preview"
    >
      {{ busy ? 'Preparing local observations…' : 'Synchronize source and preview' }}
    </button>
    <p v-if="error" role="alert" class="text-sm">{{ error }}</p>
    <div v-if="result" role="status" class="space-y-2 text-sm">
      <p class="font-medium">{{ statusLabel }}</p>
      <p v-if="result.status !== 'blocked'">
        Locally observed {{ result.source.startedAt }} – {{ result.source.completedAt }}; not atomic
        or server-confirmed. This result is not execution authority.
      </p>
      <p v-else>
        Preview attempt {{ result.source.startedAt }} – {{ result.source.completedAt }}; no usable
        locally observed assessment was produced. Actual may have synchronized.
      </p>
      <p v-if="result.plan">
        Transaction {{ result.plan.transactionId }}:
        {{ result.plan.currentCategoryId ?? 'Uncategorized' }} →
        {{ result.plan.proposedCategoryId }}
      </p>
      <p v-if="result.requiredApprovers !== null">
        Required independent human approvers: {{ result.requiredApprovers }}.
      </p>
      <p v-else>Human approval requirement: unavailable.</p>
      <p v-if="result.reasonCodes.length">{{ result.reasonCodes.join(', ') }}</p>
      <p>{{ result.disclosure }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { z } from 'zod';
import { authClient } from '../../lib/auth-client';

const props = withDefaults(
  defineProps<{ proposalId: string; payloadHash: string; active?: boolean; disabled?: boolean }>(),
  {
    active: true,
    disabled: false,
  },
);
const reportSchema = z
  .object({
    simulationOnly: z.literal(true),
    status: z.enum(['eligible_on_captured_inputs', 'approval_required', 'blocked']),
    proposalId: z.string().min(1),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    reasonCodes: z.array(z.string()),
    requiredApprovers: z.number().int().nonnegative().nullable(),
    disclosure: z.string(),
    source: z.object({
      kind: z.literal('locally_observed'),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime(),
      atomic: z.literal(false),
      serverConfirmed: z.literal(false),
      maySynchronize: z.literal(true),
    }),
    plan: z
      .object({
        planId: z.string().min(1),
        transactionId: z.string().min(1),
        currentCategoryId: z.string().min(1).nullable(),
        proposedCategoryId: z.string().min(1),
      })
      .nullable(),
  })
  .refine(
    (report) => (report.status === 'blocked') === (report.plan === null),
    'Preview status and plan disagree',
  )
  .refine(
    (report) => Date.parse(report.source.completedAt) >= Date.parse(report.source.startedAt),
    'Invalid observation interval',
  );
const session = authClient.useSession();
const identity = computed(() => {
  const current = session.value?.data;
  return current?.user?.id ? `${current.user.id}:${current.session?.id ?? ''}` : null;
});
const result = ref<z.infer<typeof reportSchema> | null>(null);
const error = ref('');
const busy = ref(false);
let lifetime = 0;
let controller: AbortController | null = null;
function clear() {
  lifetime += 1;
  controller?.abort();
  controller = null;
  result.value = null;
  error.value = '';
  busy.value = false;
}
watch(
  () => [props.proposalId, props.payloadHash, props.active, props.disabled, identity.value],
  clear,
  { flush: 'sync' },
);
onScopeDispose(clear);
const statusLabel = computed(() =>
  result.value?.status === 'eligible_on_captured_inputs'
    ? 'Eligible on captured inputs'
    : result.value?.status === 'approval_required'
      ? 'Human approval required'
      : 'Blocked',
);

async function preview() {
  if (busy.value || props.disabled || !props.active || !identity.value) return;
  clear();
  const requestLifetime = lifetime;
  busy.value = true;
  controller = new AbortController();
  try {
    const response = await fetch(`/api/proposal/${encodeURIComponent(props.proposalId)}/preview`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    const envelope: unknown = await response.json();
    if (requestLifetime !== lifetime) return;
    if (
      !response.ok ||
      !envelope ||
      typeof envelope !== 'object' ||
      !('status' in envelope) ||
      envelope.status !== 'ok' ||
      !('result' in envelope)
    )
      throw new Error('Preview unavailable');
    const parsed = reportSchema.safeParse(envelope.result);
    if (
      !parsed.success ||
      parsed.data.proposalId !== props.proposalId ||
      parsed.data.payloadHash !== props.payloadHash
    )
      throw new Error('Preview unavailable');
    result.value = parsed.data;
  } catch {
    if (requestLifetime === lifetime)
      error.value =
        'Preview unavailable. Actual may have synchronized; refresh the proposal before trying again.';
  } finally {
    if (requestLifetime === lifetime) {
      busy.value = false;
      controller = null;
    }
  }
}
</script>
