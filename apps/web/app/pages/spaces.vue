<template>
  <UContainer class="mx-auto max-w-6xl space-y-6 px-4 py-8">
    <header>
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">Spaces and governance</h1>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Manage access and approval policy for the explicitly selected space. Financial access remains separately granted.
      </p>
    </header>

    <p v-if="error" role="alert" class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {{ error }}
    </p>
    <p v-if="success" role="status" class="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
      {{ success }}
    </p>

    <section class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Create a space</h2>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">New spaces start unbound. Binding an Actual budget is a separate owner-only connection action.</p>
      <form class="mt-4 grid gap-3 sm:grid-cols-[1fr_12rem_auto]" @submit.prevent="createSpace">
        <label class="space-y-1 text-sm">
          <span class="block font-medium">Name</span>
          <input v-model="createName" required maxlength="120" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" />
        </label>
        <label class="space-y-1 text-sm">
          <span class="block font-medium">Type</span>
          <select v-model="createKind" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
            <option value="personal">Personal</option>
            <option value="shared">Shared</option>
          </select>
        </label>
        <button type="submit" :disabled="busy" class="self-end rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          Create unbound space
        </button>
      </form>
    </section>

    <section class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900" aria-live="polite">
      <h2 class="text-lg font-semibold">Selected space</h2>
      <p v-if="loading" class="mt-2 text-sm text-gray-500">Loading current membership…</p>
      <template v-else-if="space">
        <p class="mt-2 font-medium">{{ space.name }} <span class="text-sm font-normal text-gray-500">· {{ space.kind }}</span></p>
        <p class="mt-1 text-sm text-gray-500">Membership began {{ space.membership.validFrom }}. Use the space picker above to change scope.</p>
      </template>
      <p v-else class="mt-2 text-sm text-gray-600">Select a space from the header picker before managing governance.</p>
    </section>

    <section class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Fresh human confirmation</h2>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{{ demoMode
        ? 'Type CONFIRM to explicitly confirm the current disposable-demo persona. Fictional account passwords remain private.'
        : 'Control changes require your current account password. The password is sent only to the reauthentication endpoint and cleared immediately.' }}</p>
      <div class="mt-3 flex flex-wrap items-end gap-3">
        <label for="governance-password" class="space-y-1 text-sm">
          <span class="block font-medium">{{ demoMode ? 'Disposable-demo confirmation (type CONFIRM)' : 'Account password' }}</span>
          <input id="governance-password" v-model="password" type="password" autocomplete="current-password" class="rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" />
        </label>
        <button type="button" :disabled="reauthenticating || !password" aria-label="Reauthenticate for space changes" class="rounded border px-4 py-2 text-sm disabled:opacity-50" @click="reauthenticate">
          {{ reauthenticating ? 'Verifying…' : 'Reauthenticate for changes' }}
        </button>
        <span v-if="reauthenticated" role="status" class="text-sm text-green-700 dark:text-green-300">Fresh confirmation is ready.</span>
      </div>
    </section>

    <p v-if="!loading && space && !hasControls" class="rounded-md bg-gray-100 p-4 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
      This membership has no governance-control grants. Financial data and control history are not shown without their separate current grants.
    </p>

    <section v-if="memberships" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Membership periods</h2>
      <form class="mt-4 grid gap-3 sm:grid-cols-[1fr_15rem_15rem_auto]" @submit.prevent="addMembership">
        <label class="space-y-1 text-sm"><span class="block font-medium">Human account ID</span><input id="member-actor-id" v-model="membershipActorId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Valid from</span><input id="member-valid-from" v-model="membershipFrom" type="datetime-local" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Valid until (optional)</span><input v-model="membershipUntil" type="datetime-local" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <button type="submit" :disabled="busy" aria-label="Add membership period" class="self-end rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Add member</button>
      </form>
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead><tr class="border-b text-gray-500"><th class="p-2">Account</th><th class="p-2">Valid from</th><th class="p-2">Valid until</th><th class="p-2">Status</th><th class="p-2">Action</th></tr></thead>
          <tbody><tr v-for="membership in memberships" :key="membership.id" class="border-b border-gray-100 dark:border-gray-800">
            <td class="p-2">{{ membership.actorId }}</td><td class="p-2">{{ membership.validFrom }}</td><td class="p-2">{{ membership.validUntil ?? 'Open' }}</td>
            <td class="p-2">{{ membership.revokedAt ? `Revoked ${membership.revokedAt}` : 'Retained' }}</td>
            <td class="p-2"><button v-if="!membership.revokedAt" type="button" :disabled="busy" :aria-label="`Revoke membership ${membership.id}`" class="text-red-700 underline disabled:opacity-50" @click="revokeMembership(membership)">Revoke period</button></td>
          </tr></tbody>
        </table>
      </div>
    </section>

    <section v-if="policyView" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Governance approval policy</h2>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">Version {{ policyView.policy?.version ?? 'none' }} · separate from financial policy.</p>
      <form class="mt-4 space-y-3" @submit.prevent="savePolicy">
        <label class="block max-w-xs space-y-1 text-sm"><span class="font-medium">Minimum approvers</span><input v-model.number="minimumApprovers" type="number" min="1" step="1" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="block space-y-1 text-sm"><span class="font-medium">Gross-outgoing thresholds (JSON array)</span><textarea v-model="thresholdsJson" rows="3" spellcheck="false" class="w-full rounded border px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="block space-y-1 text-sm"><span class="font-medium">Operation approver counts (JSON object)</span><textarea v-model="operationApproversJson" rows="3" spellcheck="false" class="w-full rounded border px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" /></label>
        <button type="submit" :disabled="busy" class="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save policy version</button>
      </form>
      <h3 class="mt-5 font-medium">Policy history</h3>
      <ul class="mt-2 space-y-1 text-sm"><li v-for="version in policyView.history" :key="version.version">Version {{ version.version }} · {{ version.createdAt }} · {{ version.actorId }}</li></ul>
    </section>

    <section v-if="grants" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Exact resource grants</h2>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">Grants are scoped to one membership period and resource; wildcards are rejected.</p>
      <form class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" @submit.prevent="saveGrant">
        <label class="space-y-1 text-sm"><span class="block font-medium">Membership period</span><select v-model="grantMembershipId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950"><option v-for="membership in memberships ?? []" :key="membership.id" :value="membership.id">{{ membership.actorId }} · {{ membership.id.slice(0, 8) }}</option></select></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Capability</span><input v-model="grantCapability" required pattern="[^*]+" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Resource kind</span><select v-model="grantResourceKind" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950"><option v-for="kind in resourceKinds" :key="kind" :value="kind">{{ kind }}</option></select></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Exact resource ID</span><input v-model="grantResourceId" required pattern="[^*]+" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Restrictions (JSON object)</span><textarea v-model="grantRestrictionsJson" rows="2" spellcheck="false" class="w-full rounded border px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="flex items-center gap-2 self-end py-2 text-sm"><input v-model="grantGranted" type="checkbox" /> Grant enabled</label>
        <button type="submit" :disabled="busy || !memberships?.length" class="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save exact grant</button>
      </form>
      <div class="mt-4 overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr class="border-b text-gray-500"><th class="p-2">Member</th><th class="p-2">Capability</th><th class="p-2">Resource</th><th class="p-2">Restrictions</th><th class="p-2">State</th><th class="p-2">Action</th></tr></thead>
        <tbody><tr v-for="grant in grants" :key="grant.id" class="border-b border-gray-100 dark:border-gray-800"><td class="p-2">{{ grant.actorId }}</td><td class="p-2">{{ grant.capability }}</td><td class="p-2">{{ grant.resourceKind }} · {{ grant.resourceId }}</td><td class="max-w-xs truncate p-2 font-mono text-xs">{{ JSON.stringify(grant.restrictions) }}</td><td class="p-2">{{ grant.granted && !grant.revokedAt ? 'Active' : 'Revoked' }}</td><td class="p-2"><button v-if="grant.granted && !grant.revokedAt && grant.membershipId" type="button" :disabled="busy" class="text-red-700 underline disabled:opacity-50" @click="revokeGrant(grant)">Revoke</button></td></tr></tbody>
      </table></div>
    </section>

    <section v-if="agents" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Independent agents</h2>
      <form class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="registerAgent">
        <label class="space-y-1 text-sm"><span class="block font-medium">Agent ID</span><input v-model="agentId" required class="rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <button type="submit" :disabled="busy" class="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Register agent</button>
      </form>
      <ul class="mt-4 divide-y divide-gray-100 dark:divide-gray-800"><li v-for="agent in agents" :key="agent.agentId" class="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span>{{ agent.agentId }} · {{ agent.status }}</span><span class="flex gap-3"><button v-if="agent.status === 'active'" type="button" :disabled="busy" class="underline" @click="setAgentStatus(agent, 'disconnected')">Disconnect</button><button v-if="agent.status !== 'revoked'" type="button" :disabled="busy" class="text-red-700 underline" @click="setAgentStatus(agent, 'revoked')">Revoke agent</button></span></li></ul>
    </section>

    <section v-if="delegations" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Bounded agent delegations</h2>
      <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="createDelegation">
        <label class="space-y-1 text-sm"><span class="block font-medium">Registered agent</span><select v-model="delegationAgentId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950"><option v-for="agent in agents ?? []" :key="agent.agentId" :value="agent.agentId">{{ agent.agentId }}</option></select></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Issuer membership</span><select v-model="issuerMembershipId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950"><option v-for="membership in memberships ?? []" :key="membership.id" :value="membership.id">{{ membership.actorId }} · {{ membership.id.slice(0, 8) }}</option></select></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Valid from</span><input v-model="delegationFrom" type="datetime-local" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Valid until (optional)</span><input v-model="delegationUntil" type="datetime-local" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm sm:col-span-2"><span class="block font-medium">Exact delegated rights (JSON array)</span><textarea v-model="delegationRightsJson" rows="4" spellcheck="false" class="w-full rounded border px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950" /></label>
        <button type="submit" :disabled="busy || !agents?.length || !memberships?.length" class="w-fit rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Issue delegation</button>
      </form>
      <div class="mt-4 overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr class="border-b text-gray-500"><th class="p-2">Agent</th><th class="p-2">Version</th><th class="p-2">Period</th><th class="p-2">Rights</th><th class="p-2">Action</th></tr></thead><tbody><tr v-for="delegation in delegations" :key="`${delegation.id}:${delegation.version}`" class="border-b border-gray-100 dark:border-gray-800"><td class="p-2">{{ delegation.agentId }}</td><td class="p-2">{{ delegation.version }}</td><td class="p-2">{{ delegation.validFrom }} – {{ delegation.validUntil ?? 'Open' }}</td><td class="max-w-sm truncate p-2 font-mono text-xs">{{ JSON.stringify(delegation.rights) }}</td><td class="p-2"><button v-if="!delegation.revokedAt" type="button" :disabled="busy" class="text-red-700 underline" @click="revokeDelegation(delegation)">Revoke version</button></td></tr></tbody></table></div>
    </section>

    <section v-if="credentials" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Credential bindings</h2>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">Only credential IDs verified as owned by your current human account can be bound. Raw keys are never accepted or displayed.</p>
      <form class="mt-4 grid gap-3 sm:grid-cols-2" @submit.prevent="registerCredential">
        <label class="space-y-1 text-sm"><span class="block font-medium">Verified API key ID</span><input v-model="credentialId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Principal type</span><select v-model="credentialPrincipalType" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950"><option value="human">Human</option><option value="agent">Agent</option></select></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Principal ID</span><input v-model="credentialPrincipalId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <template v-if="credentialPrincipalType === 'agent'">
          <label class="space-y-1 text-sm"><span class="block font-medium">Current delegation ID</span><input v-model="credentialDelegationId" required class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
          <label class="space-y-1 text-sm"><span class="block font-medium">Delegation version</span><input v-model="credentialDelegationVersion" required pattern="[1-9][0-9]*" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        </template>
        <button type="submit" :disabled="busy" class="w-fit rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Bind verified credential</button>
      </form>
      <ul class="mt-4 divide-y divide-gray-100 dark:divide-gray-800"><li v-for="credential in credentials" :key="credential.id" class="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span>{{ credential.credentialId }} · {{ credential.principalType }} {{ credential.principalId }} · {{ credential.revokedAt ? 'Revoked' : 'Active' }}</span><button v-if="!credential.revokedAt" type="button" :disabled="busy" class="text-red-700 underline" @click="revokeCredential(credential)">Revoke binding</button></li></ul>
    </section>

    <section v-if="connectionControl" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Actual connection</h2>
      <p v-if="connectionControl.budgetBound" class="mt-1 text-sm text-gray-600 dark:text-gray-400">This space already has its immutable budget binding.</p>
      <template v-else>
        <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">Only the registered connection owner can bind a budget. Discovery and binding both require fresh human confirmation.</p>
        <button v-if="!budgets.length" type="button" :disabled="busy" class="mt-3 rounded border px-4 py-2 text-sm disabled:opacity-50" @click="discoverBudgets">Discover available Actual budgets</button>
        <template v-else>
          <label class="mt-3 block max-w-xl space-y-1 text-sm"><span class="block font-medium">Available Actual budget</span><select v-model="budgetId" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950"><option value="" disabled>Choose an Actual budget</option><option v-for="budget in budgets" :key="budget.id || budget.groupId" :value="budget.id || budget.groupId">{{ budget.name }}{{ budget.encrypted ? ' · Encrypted' : '' }}</option></select></label>
          <button type="button" :disabled="busy || !budgetId" class="mt-3 rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="bindBudget">Connect and bind selected budget</button>
        </template>
      </template>
    </section>

    <section v-if="audit" class="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 class="text-lg font-semibold">Governance audit</h2>
      <form class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" @submit.prevent="filterAudit">
        <label class="space-y-1 text-sm"><span class="block font-medium">Actor ID</span><input v-model="auditActorId" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Entity ID</span><input v-model="auditEntityId" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">Action</span><input v-model="auditAction" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">From</span><input v-model="auditFrom" type="datetime-local" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <label class="space-y-1 text-sm"><span class="block font-medium">To</span><input v-model="auditTo" type="datetime-local" class="w-full rounded border px-3 py-2 dark:border-gray-700 dark:bg-gray-950" /></label>
        <button type="submit" :disabled="busy" class="w-fit rounded border px-4 py-2 text-sm disabled:opacity-50">Filter audit</button>
      </form>
      <p class="mt-3 text-xs text-gray-500">{{ audit.total }} matching classified events. Private detail payloads are withheld.</p>
      <ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-800"><li v-for="record in audit.records" :key="record.id" class="py-2 text-sm"><time :datetime="record.timestamp">{{ record.timestamp }}</time> · {{ record.actorId }} · {{ record.action }}<span v-if="record.entityId"> · {{ record.entityId }}</span></li></ul>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import { z } from 'zod';
import { reauthenticateHuman } from '../utils/reauthentication';

const Space = z.object({ id: z.string(), name: z.string(), kind: z.enum(['personal', 'shared']) }).passthrough();
const Directory = z.object({ spaces: z.array(Space), selectedSpaceId: z.string().nullable() });
const Membership = z.object({
  id: z.string(), actorId: z.string(), validFrom: z.string(), validUntil: z.string().nullable(),
  revokedAt: z.string().nullable(), origin: z.string(),
}).passthrough();
const MembershipList = z.object({ memberships: z.array(Membership) });
const VersionedPolicy = z.object({
  minimumApprovers: z.number(), approvalThresholds: z.array(z.object({ currency: z.string(), amountMinorUnits: z.string(), requiredApprovers: z.number() })),
  operationApprovers: z.record(z.string(), z.number()).optional(), spaceId: z.string(), version: z.string(), actorId: z.string(), createdAt: z.string(),
}).passthrough();
const PolicyView = z.object({ policy: VersionedPolicy.nullable(), history: z.array(VersionedPolicy) });
const Grant = z.object({
  id: z.string(), membershipId: z.string().nullable(), actorId: z.string(), capability: z.string(), resourceKind: z.string(), resourceId: z.string(),
  granted: z.boolean(), restrictions: z.unknown(), revokedAt: z.string().nullable(),
}).passthrough();
const GrantList = z.object({ grants: z.array(Grant) });
const Agent = z.object({ agentId: z.string(), registeredSpaceId: z.string(), status: z.enum(['active', 'disconnected', 'revoked']) }).passthrough();
const AgentList = z.object({ agents: z.array(Agent) });
const Delegation = z.object({
  id: z.string(), agentId: z.string(), issuerMembershipId: z.string(), version: z.string(), rights: z.array(z.unknown()),
  validFrom: z.string(), validUntil: z.string().nullable(), revokedAt: z.string().nullable(),
}).passthrough();
const DelegationList = z.object({ delegations: z.array(Delegation) });
const Credential = z.object({
  id: z.string(), credentialId: z.string(), principalType: z.enum(['human', 'agent']), principalId: z.string(), revokedAt: z.string().nullable(),
}).passthrough();
const CredentialList = z.object({ credentials: z.array(Credential) });
const Audit = z.object({
  records: z.array(z.object({ id: z.string(), actorId: z.string(), action: z.string(), entityId: z.string().nullable(), timestamp: z.string() })),
  total: z.number(), limit: z.number(), offset: z.number(),
});
const ConnectionStatus = z.object({ budgetBound: z.boolean() });
const BudgetList = z.object({ budgets: z.array(z.object({ id: z.string(), groupId: z.string(), name: z.string(), encrypted: z.boolean() })) });
const ApiEnvelope = z.object({
  status: z.enum(['ok', 'error']),
  result: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
}).passthrough();
const ResourceKinds = z.enum([
  'space', 'budget', 'account', 'category', 'transaction', 'rule', 'evidence', 'wallet', 'receipt', 'commitment',
  'scenario', 'reservation', 'purchase', 'transfer', 'ledger_effect', 'session', 'proposal',
]);
type ResourceKind = z.infer<typeof ResourceKinds>;
type SpaceRecord = z.infer<typeof Space>;
type MembershipRecord = z.infer<typeof Membership>;
type GrantRecord = z.infer<typeof Grant>;
type AgentRecord = z.infer<typeof Agent>;
type DelegationRecord = z.infer<typeof Delegation>;
type CredentialRecord = z.infer<typeof Credential>;
type AuditRecord = z.infer<typeof Audit>;
type PolicyRecord = z.infer<typeof VersionedPolicy>;
type RequestOptions = { method?: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown>; query?: Record<string, string | number | undefined> };

class ApiRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const demoMode = typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true;

const spaces = ref<SpaceRecord[]>([]);
const selectedSpaceId = ref<string | null>(null);
const space = ref<{ id: string; name: string; kind: 'personal' | 'shared'; membership: MembershipRecord } | null>(null);
const memberships = ref<MembershipRecord[] | null>(null);
const grants = ref<GrantRecord[] | null>(null);
const policyView = ref<{ policy: PolicyRecord | null; history: PolicyRecord[] } | null>(null);
const agents = ref<AgentRecord[] | null>(null);
const delegations = ref<DelegationRecord[] | null>(null);
const credentials = ref<CredentialRecord[] | null>(null);
const audit = ref<AuditRecord | null>(null);
const connectionControl = ref<{ budgetBound: boolean } | null>(null);
const budgets = ref<{ id: string; groupId: string; name: string; encrypted: boolean }[]>([]);
const budgetId = ref('');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const success = ref('');
const password = ref('');
const reauthenticated = ref(false);
const reauthenticating = ref(false);
const createName = ref('');
const createKind = ref<'personal' | 'shared'>('personal');
const membershipActorId = ref('');
const membershipFrom = ref('');
const membershipUntil = ref('');
const grantMembershipId = ref('');
const grantCapability = ref('');
const grantResourceKind = ref<ResourceKind>('space');
const grantResourceId = ref('');
const grantRestrictionsJson = ref('{}');
const grantGranted = ref(true);
const minimumApprovers = ref(1);
const thresholdsJson = ref('[]');
const operationApproversJson = ref('{}');
const agentId = ref('');
const delegationAgentId = ref('');
const issuerMembershipId = ref('');
const delegationFrom = ref('');
const delegationUntil = ref('');
const delegationRightsJson = ref('[]');
const credentialId = ref('');
const credentialPrincipalType = ref<'human' | 'agent'>('agent');
const credentialPrincipalId = ref('');
const credentialDelegationId = ref('');
const credentialDelegationVersion = ref('');
const auditActorId = ref('');
const auditEntityId = ref('');
const auditAction = ref('');
const auditFrom = ref('');
const auditTo = ref('');
const resourceKinds: readonly ResourceKind[] = ResourceKinds.options;
const hasControls = computed(() => !!(memberships.value || grants.value || policyView.value || agents.value || delegations.value || credentials.value || audit.value || connectionControl.value));
const base = computed(() => `/api/spaces/${encodeURIComponent(selectedSpaceId.value ?? '')}`);

async function apiRequest<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  const response = ApiEnvelope.parse(await $fetch<unknown>(path, { ...options, ignoreResponseError: true }));
  if (response.status !== 'ok' || response.result === null) {
    throw new ApiRequestError(response.error?.code ?? 'INVALID_RESPONSE', response.error?.message ?? 'The server request failed.');
  }
  return schema.parse(response.result);
}

function showError(cause: unknown): string {
  return cause instanceof ApiRequestError ? cause.message : 'The server response could not be used. Check the selected space and try again.';
}

function isDenied(cause: unknown): boolean {
  return cause instanceof ApiRequestError && ['FORBIDDEN', 'AUTHORIZATION_REQUIRED'].includes(cause.code);
}

async function controlData<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return await apiRequest(path, schema);
  } catch (cause) {
    if (isDenied(cause)) return null;
    throw cause;
  }
}

async function loadDirectory(): Promise<void> {
  const directory = await apiRequest('/api/spaces', Directory);
  spaces.value = directory.spaces;
  selectedSpaceId.value = directory.selectedSpaceId;
}

async function loadControls(): Promise<void> {
  if (!selectedSpaceId.value) return;
  const selected = base.value;
  const [memberResult, grantResult, policyResult, agentResult, delegationResult, credentialResult, auditResult, connectionResult] = await Promise.all([
    controlData(`${selected}/memberships`, MembershipList),
    controlData(`${selected}/grants`, GrantList),
    controlData(`${selected}/policy`, PolicyView),
    controlData(`${selected}/agents`, AgentList),
    controlData(`${selected}/delegations`, DelegationList),
    controlData(`${selected}/credentials`, CredentialList),
    controlData(`${selected}/audit`, Audit),
    controlData(`${selected}/connection`, ConnectionStatus),
  ]);
  memberships.value = memberResult?.memberships ?? null;
  grants.value = grantResult?.grants ?? null;
  policyView.value = policyResult;
  agents.value = agentResult?.agents ?? null;
  delegations.value = delegationResult?.delegations ?? null;
  credentials.value = credentialResult?.credentials ?? null;
  audit.value = auditResult;
  connectionControl.value = connectionResult;
  if (policyResult?.policy) {
    minimumApprovers.value = policyResult.policy.minimumApprovers;
    thresholdsJson.value = JSON.stringify(policyResult.policy.approvalThresholds, null, 2);
    operationApproversJson.value = JSON.stringify(policyResult.policy.operationApprovers ?? {}, null, 2);
  }
  grantMembershipId.value ||= memberships.value?.find((member) => !member.revokedAt)?.id ?? '';
  issuerMembershipId.value ||= space.value?.membership.id ?? '';
  delegationAgentId.value ||= agents.value?.find((agent) => agent.status === 'active')?.agentId ?? '';
}

async function loadPage(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await loadDirectory();
    if (!selectedSpaceId.value) {
      space.value = null;
      return;
    }
    const selected = base.value;
    const detail = await apiRequest(selected, z.object({
      space: z.object({
        id: z.string(), name: z.string(), kind: z.enum(['personal', 'shared']), createdAt: z.string(), membership: Membership,
      }),
    }));
    space.value = detail.space;
    await loadControls();
  } catch (cause) {
    error.value = showError(cause);
  } finally {
    loading.value = false;
  }
}

async function reauthenticate(): Promise<void> {
  if (!password.value || reauthenticating.value) return;
  error.value = '';
  success.value = '';
  reauthenticating.value = true;
  const passwordSnapshot = password.value;
  password.value = '';
  try {
    await reauthenticateHuman(passwordSnapshot);
    reauthenticated.value = true;
    success.value = 'Fresh human confirmation is ready.';
  } catch (cause) {
    reauthenticated.value = false;
    error.value = demoMode && cause instanceof Error
      ? cause.message : 'Password confirmation failed. Check the current account password and try again.';
  } finally {
    password.value = '';
    reauthenticating.value = false;
  }
}

async function mutation<T>(path: string, schema: z.ZodType<T>, options: RequestOptions): Promise<T | null> {
  if (!reauthenticated.value) {
    error.value = demoMode
      ? 'Confirm the current disposable-demo persona before changing governance.'
      : 'Reauthenticate with your account password before changing governance.';
    return null;
  }
  if (busy.value) return null;
  busy.value = true;
  error.value = '';
  success.value = '';
  try {
    const result = await apiRequest(path, schema, options);
    reauthenticated.value = false;
    success.value = 'Governance change saved.';
    await loadControls();
    return result;
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.code === 'REAUTHENTICATION_REQUIRED') reauthenticated.value = false;
    error.value = showError(cause);
    return null;
  } finally {
    busy.value = false;
  }
}

function iso(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

async function createSpace(): Promise<void> {
  if (!reauthenticated.value) {
    error.value = 'Reauthenticate with your account password before creating a space.';
    return;
  }
  const created = await mutation('/api/spaces', z.object({ space: Space }), {
    method: 'POST', body: { name: createName.value, kind: createKind.value },
  });
  if (created) {
    createName.value = '';
    try {
      await loadDirectory();
      success.value = `Created unbound ${created.space.kind} space “${created.space.name}”. Select it from the header picker to continue.`;
      window.location.reload();
    } catch (cause) {
      error.value = showError(cause);
    }
  }
}

async function addMembership(): Promise<void> {
  try {
    const body = { actorId: membershipActorId.value, validFrom: iso(membershipFrom.value), ...(iso(membershipUntil.value) ? { validUntil: iso(membershipUntil.value) } : {}) };
    const added = await mutation(`${base.value}/memberships`, z.object({ membership: Membership }), { method: 'POST', body });
    if (added) {
      membershipActorId.value = '';
      membershipFrom.value = '';
      membershipUntil.value = '';
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Membership request is invalid.';
  }
}

async function revokeMembership(member: MembershipRecord): Promise<void> {
  await mutation(`${base.value}/memberships/${encodeURIComponent(member.id)}/revoke`, z.object({ revoked: z.boolean() }), { method: 'POST', body: {} });
}

async function saveGrant(): Promise<void> {
  try {
    await mutation(`${base.value}/grants`, z.object({ grant: Grant.nullable() }), {
      method: 'PUT',
      body: {
        membershipId: grantMembershipId.value,
        capability: grantCapability.value,
        resourceKind: grantResourceKind.value,
        resourceId: grantResourceId.value,
        granted: grantGranted.value,
        restrictions: parseJson(grantRestrictionsJson.value, 'Restrictions'),
      },
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Grant request is invalid.';
  }
}

async function revokeGrant(grant: GrantRecord): Promise<void> {
  if (!grant.membershipId) return;
  await mutation(`${base.value}/grants`, z.object({ grant: Grant.nullable() }), {
    method: 'PUT', body: {
      membershipId: grant.membershipId, capability: grant.capability, resourceKind: grant.resourceKind,
      resourceId: grant.resourceId, granted: false,
    },
  });
}

async function savePolicy(): Promise<void> {
  try {
    const current = policyView.value?.policy;
    await mutation(`${base.value}/policy`, z.object({ policy: VersionedPolicy }), {
      method: 'PUT',
      body: {
        expectedVersion: current?.version ?? null,
        policy: {
          minimumApprovers: minimumApprovers.value,
          approvalThresholds: parseJson(thresholdsJson.value, 'Approval thresholds'),
          operationApprovers: parseJson(operationApproversJson.value, 'Operation approvers'),
        },
      },
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Policy request is invalid.';
  }
}

async function registerAgent(): Promise<void> {
  const registered = await mutation(`${base.value}/agents`, z.object({ agent: Agent }), { method: 'POST', body: { agentId: agentId.value } });
  if (registered) {
    agentId.value = '';
    delegationAgentId.value ||= registered.agent.agentId;
  }
}

async function setAgentStatus(agent: AgentRecord, status: 'disconnected' | 'revoked'): Promise<void> {
  await mutation(`${base.value}/agents/${encodeURIComponent(agent.agentId)}`, z.object({ status: z.string() }), { method: 'PUT', body: { status } });
}

async function createDelegation(): Promise<void> {
  try {
    await mutation(`${base.value}/delegations`, z.object({ delegation: Delegation }), {
      method: 'POST', body: {
        agentId: delegationAgentId.value,
        issuerMembershipId: issuerMembershipId.value,
        expectedVersion: null,
        rights: parseJson(delegationRightsJson.value, 'Delegated rights'),
        validFrom: iso(delegationFrom.value),
        ...(iso(delegationUntil.value) ? { validUntil: iso(delegationUntil.value) } : {}),
      },
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Delegation request is invalid.';
  }
}

async function revokeDelegation(delegation: DelegationRecord): Promise<void> {
  await mutation(`${base.value}/delegations/${encodeURIComponent(delegation.id)}/revoke`, z.object({ revoked: z.boolean() }), {
    method: 'POST', body: { expectedVersion: delegation.version },
  });
}

async function registerCredential(): Promise<void> {
  const credential = await mutation(`${base.value}/credentials`, z.object({ credential: Credential }), {
    method: 'POST', body: {
      credentialId: credentialId.value,
      principalType: credentialPrincipalType.value,
      principalId: credentialPrincipalId.value,
      ...(credentialPrincipalType.value === 'agent' ? {
        delegationId: credentialDelegationId.value,
        expectedDelegationVersion: credentialDelegationVersion.value,
      } : {}),
    },
  });
  if (credential) {
    credentialId.value = '';
    credentialPrincipalId.value = '';
    credentialDelegationId.value = '';
    credentialDelegationVersion.value = '';
  }
}

async function revokeCredential(credential: CredentialRecord): Promise<void> {
  await mutation(`${base.value}/credentials/${encodeURIComponent(credential.credentialId)}/revoke`, z.object({ revoked: z.boolean() }), { method: 'POST', body: {} });
}

async function discoverBudgets(): Promise<void> {
  if (!reauthenticated.value) {
    error.value = 'Reauthenticate with your account password before discovering budgets.';
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    const listed = await apiRequest('/api/connection/budgets', BudgetList);
    budgets.value = listed.budgets;
    budgetId.value = '';
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.code === 'REAUTHENTICATION_REQUIRED') reauthenticated.value = false;
    error.value = showError(cause);
  } finally {
    busy.value = false;
  }
}

async function bindBudget(): Promise<void> {
  const connected = await mutation('/api/connection', z.object({ connected: z.boolean() }), {
    method: 'POST', body: { budgetId: budgetId.value },
  });
  if (connected) {
    connectionControl.value = { budgetBound: true };
    budgets.value = [];
  }
}

async function filterAudit(): Promise<void> {
  if (busy.value || !selectedSpaceId.value) return;
  error.value = '';
  try {
    audit.value = await apiRequest(`${base.value}/audit`, Audit, {
      query: {
        actorId: auditActorId.value || undefined,
        entityId: auditEntityId.value || undefined,
        action: auditAction.value || undefined,
        from: iso(auditFrom.value),
        to: iso(auditTo.value),
      },
    });
  } catch (cause) {
    error.value = showError(cause);
  }
}

onMounted(() => {
  void loadPage();
});
</script>
