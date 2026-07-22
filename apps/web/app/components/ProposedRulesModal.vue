<template>
  <UModal :open="open" @close="onClose">
    <template #content>
      <UCard>
        <template #header>
          <h2 class="font-semibold text-lg">Proposed rules</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Review and manage automation rule proposals.
          </p>
        </template>

        <div v-if="proposals.length === 0" class="text-center py-8 text-gray-400">
          No active proposals.
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="prop in proposals"
            :key="prop.id"
            class="border border-gray-200 dark:border-gray-700 rounded-lg p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <!-- Merchant name (parsed from preconditions JSON) -->
                <p class="font-medium truncate">
                  {{ merchantFromPreconditions(prop.preconditions) }}
                </p>
                <!-- Category ID -->
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Category: <code class="font-mono text-xs">{{ prop.categoryId }}</code>
                </p>
                <!-- Dates -->
                <p class="text-xs text-gray-400 mt-0.5">
                  Created: {{ formatDate(prop.createdAt) }}
                  &middot; Expires: {{ formatDate(prop.expiresAt) }}
                </p>
              </div>
              <!-- Simulation status badge -->
              <div class="shrink-0">
                <UBadge
                  v-if="prop.simulationStatus === 'present'"
                  color="success"
                  variant="soft"
                  size="xs"
                  label="Simulated"
                />
                <UBadge
                  v-else-if="prop.simulationStatus === 'stale'"
                  color="warning"
                  variant="soft"
                  size="xs"
                  label="Stale"
                />
                <UBadge
                  v-else
                  color="neutral"
                  variant="soft"
                  size="xs"
                  label="No simulation"
                />
              </div>
            </div>
            <!-- Action buttons -->
            <div class="flex gap-2 mt-2">
              <UButton
                label="Accept &amp; activate"
                color="primary"
                variant="solid"
                size="xs"
                :loading="acceptingId === prop.id"
                :disabled="!!acceptingId"
                @click="onAccept(prop.id)"
              />
              <UButton
                label="Discard"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="!!acceptingId"
                @click="onDiscard(prop.id)"
              />
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end">
            <UButton
              label="Close"
              color="neutral"
              variant="ghost"
              @click="onClose"
            />
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref } from 'vue';

// ---------------------------------------------------------------------------
// Types — mirrors server/api/proposal/index.get.ts
// ---------------------------------------------------------------------------

export interface CategorizationProposalListItem {
  readonly id: string;
  readonly operation: string;
  readonly budgetId: string;
  readonly transactionId: string;
  readonly categoryId: string;
  readonly preconditions: string;
  readonly expiresAt: string;
  readonly actorId: string;
  readonly provenance: string;
  readonly providerModel: string | null;
  readonly correlationId: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;
  readonly simulationStatus: 'present' | 'missing' | 'stale';
}

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = defineProps<{
  open: boolean;
  proposals: CategorizationProposalListItem[];
}>();

const emit = defineEmits<{
  close: [];
  accepted: [proposalId: string];
  discarded: [proposalId: string];
}>();

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

const acceptingId = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function merchantFromPreconditions(preconditionsJson: string): string {
  try {
    const parsed = JSON.parse(preconditionsJson);
    return parsed.merchant ?? '—';
  } catch {
    return '—';
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function onAccept(proposalId: string) {
  if (acceptingId.value) return;
  acceptingId.value = proposalId;
  try {
    const res = await fetch(`/api/proposal/${proposalId}/execute`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message ?? `Failed to execute proposal (HTTP ${res.status})`;
      console.error(msg);
      return;
    }
    emit('accepted', proposalId);
  } catch (e) {
    console.error('Failed to accept proposal:', e);
  } finally {
    acceptingId.value = null;
  }
}

function onDiscard(proposalId: string) {
  emit('discarded', proposalId);
}

function onClose() {
  emit('close');
}
</script>
