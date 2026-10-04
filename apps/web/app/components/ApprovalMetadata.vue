<template>
  <section
    data-testid="approval-metadata"
    aria-label="Captured proposal authority and current eligible approvers"
    class="mt-3 rounded border p-3 text-sm"
  >
    <h3 class="font-semibold">Captured proposal authority</h3>
    <dl class="mt-2 grid gap-2 sm:grid-cols-2">
      <div>
        <dt>Requester actor</dt>
        <dd data-testid="approval-requester-actor">{{ metadata.requesterActorId }}</dd>
      </div>
      <div>
        <dt>Requester membership period</dt>
        <dd data-testid="approval-requester-membership">
          {{ metadata.requesterMembershipId ?? 'Unavailable' }}
        </dd>
      </div>
      <div>
        <dt>Captured governance policy</dt>
        <dd data-testid="approval-governance-policy">
          {{ metadata.governancePolicyVersion ?? 'Unavailable' }}
        </dd>
      </div>
      <div>
        <dt>Captured financial policy</dt>
        <dd data-testid="approval-financial-policy">{{ metadata.financialPolicyVersion }}</dd>
      </div>
    </dl>

    <h4 class="mt-3 font-medium">Current eligible approvers ({{ metadata.approvers.length }})</h4>
    <p v-if="metadata.approvers.length === 0" data-testid="approval-current-approvers-empty">
      None currently available.
    </p>
    <ul v-else class="mt-1 space-y-1">
      <li
        v-for="approval in metadata.approvers"
        :key="`${approval.actorId}:${approval.issuedAt}`"
        data-testid="approval-current-approver"
      >
        <span data-testid="approval-current-approver-actor">{{ approval.actorId }}</span>
        · issued <time :datetime="approval.issuedAt">{{ approval.issuedAt }}</time>
        · expires <time :datetime="approval.expiresAt">{{ approval.expiresAt }}</time>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { PublicApprovalMetadata } from '@balanceframe/application';

defineProps<{ metadata: PublicApprovalMetadata }>();
</script>
