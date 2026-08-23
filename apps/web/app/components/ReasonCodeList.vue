<template>
  <ul v-if="displayItems.length" class="space-y-2" aria-label="Decision issues">
    <li
      v-for="item in displayItems"
      :key="item.code"
      :data-issue-code="item.code"
      class="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700"
    >
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs font-medium text-gray-900 dark:text-gray-100">
          {{ formatIdentifier(item.code) }}
        </span>
        <template v-if="item.issue">
          <span
            class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium"
            :class="severityClass(item.issue.severity)"
          >
            {{ formatIdentifier(item.issue.severity) }}
          </span>
          <span
            class="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300"
          >
            {{ formatIdentifier(item.issue.effect) }}
          </span>
        </template>
      </div>

      <template v-if="item.issue">
        <p class="mt-1 text-xs text-gray-600 dark:text-gray-400">
          {{ scopeLabel(item.issue.scope) }}
        </p>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Redaction: {{ formatIdentifier(item.issue.redaction) }}
        </p>
        <p
          v-if="item.issue.remediation?.action"
          class="mt-1 text-xs text-gray-700 dark:text-gray-300"
        >
          Remediation: {{ item.issue.remediation.action }}
        </p>
      </template>
    </li>
  </ul>
  <span v-else class="text-xs text-gray-400 dark:text-gray-500">No reason codes</span>
</template>

<script setup lang="ts">
import type {
  DecisionIssue,
  DecisionIssueSeverity,
  DecisionScope,
} from '@balanceframe/protocol-generated';
import type { DecisionScopeLabelMap } from './types';

const props = withDefaults(
  defineProps<{
    codes?: string[];
    issues?: DecisionIssue[];
    scopeLabels?: DecisionScopeLabelMap;
  }>(),
  {
    codes: () => [],
    issues: () => [],
    scopeLabels: () => ({}),
  },
);

const displayItems = computed(() => {
  if (props.issues.length) {
    return props.issues.map((issue) => ({ code: issue.code, issue }));
  }

  return props.codes.map((code) => ({ code, issue: null }));
});

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Unspecified issue';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}

function scopeLabel(scope: DecisionScope): string {
  if (scope.kind === 'global') return 'Global scope';
  const label = props.scopeLabels[scope.id] ?? scope.id;
  return `${formatIdentifier(scope.kind)}: ${label}`;
}

function severityClass(severity: DecisionIssueSeverity): string {
  const classes: Record<DecisionIssueSeverity, string> = {
    critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  };
  return classes[severity];
}
</script>
