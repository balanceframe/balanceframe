<template>
  <section
    role="alert"
    aria-label="Insufficient Data"
    class="rounded-md border border-amber-200 bg-amber-50 px-4 py-5 text-left dark:border-amber-800 dark:bg-amber-900/20"
  >
    <div class="flex items-start gap-3">
      <span
        class="i-heroicons-chart-bar-square mt-0.5 shrink-0 text-xl text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-amber-900 dark:text-amber-100">Insufficient Data</h2>
        <p v-if="reason || !issue" class="mt-1 max-w-xl text-xs text-amber-800 dark:text-amber-200">
          {{ reason || 'Not enough transaction history is available for this analysis.' }}
        </p>

        <dl
          v-if="issue"
          class="mt-3 grid gap-2 text-xs text-gray-700 dark:text-gray-300 sm:grid-cols-2"
        >
          <div>
            <dt class="font-medium text-gray-500 dark:text-gray-400">Issue</dt>
            <dd>{{ formatIdentifier(issue.code) }}</dd>
          </div>
          <div>
            <dt class="font-medium text-gray-500 dark:text-gray-400">Severity</dt>
            <dd>{{ formatIdentifier(issue.severity) }}</dd>
          </div>
          <div>
            <dt class="font-medium text-gray-500 dark:text-gray-400">Effect</dt>
            <dd>{{ formatIdentifier(issue.effect) }}</dd>
          </div>
          <div>
            <dt class="font-medium text-gray-500 dark:text-gray-400">Scope</dt>
            <dd>{{ formatScope(issue.scope) }}</dd>
          </div>
          <div v-if="issue.remediation?.action" class="sm:col-span-2">
            <dt class="font-medium text-gray-500 dark:text-gray-400">Remediation</dt>
            <dd>{{ issue.remediation.action }}</dd>
          </div>
          <div v-if="snapshotId">
            <dt class="inline font-medium text-gray-500 dark:text-gray-400">Snapshot:</dt>
            <dd class="inline break-all">{{ ' ' }}{{ snapshotId }}</dd>
          </div>
          <div v-if="policyVersion">
            <dt class="inline font-medium text-gray-500 dark:text-gray-400">Policy:</dt>
            <dd class="inline break-all">{{ ' ' }}{{ policyVersion }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DecisionIssue, DecisionScope } from '@balanceframe/protocol-generated';

defineProps<{
  reason?: string;
  issue?: DecisionIssue;
  snapshotId?: string;
  policyVersion?: string;
}>();

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Unspecified issue';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatScope(scope: DecisionScope): string {
  if (scope.kind === 'global') return 'Global';
  return `${formatIdentifier(scope.kind)}: ${scope.id}`;
}
</script>
