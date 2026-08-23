<template>
  <UCard as="article" class="finding-card" :aria-label="`Finding: ${finding.title}`">
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-start gap-2">
        <span
          class="mt-0.5 shrink-0"
          :class="[severityIcon, severityColorClass]"
          aria-hidden="true"
        />
        <div class="min-w-0">
          <h4 class="text-sm font-medium text-gray-900 dark:text-gray-100">
            {{ finding.title }}
          </h4>
          <p
            v-if="finding.category || finding.entityType"
            class="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
          >
            {{
              finding.classification
                ? (finding.category ?? finding.entityType)
                : (finding.entityType ?? finding.category)
            }}
          </p>
        </div>
      </div>
      <div v-if="finding.amount" class="shrink-0">
        <SemanticAmount :amount="finding.amount" />
      </div>
    </div>

    <dl
      v-if="hasFindingMetadata"
      class="mt-3 grid gap-1.5 text-xs text-gray-600 dark:text-gray-400 sm:grid-cols-2"
    >
      <div v-if="finding.classification">
        <dt class="inline font-medium">Classification:</dt>
        {{ ' ' }}
        <dd class="inline">{{ formatIdentifier(finding.classification) }}</dd>
      </div>
      <div v-if="finding.status">
        <dt class="inline font-medium">Finding status:</dt>
        {{ ' ' }}
        <dd class="inline">{{ formatIdentifier(finding.status) }}</dd>
      </div>
      <div v-if="finding.findingVersion !== undefined">
        <dt class="inline font-medium">Finding version:</dt>
        {{ ' ' }}
        <dd class="inline">{{ finding.findingVersion }}</dd>
      </div>
      <div v-if="finding.firstObservedAt">
        <dt class="inline font-medium">First observed:</dt>
        {{ ' ' }}
        <dd class="inline">
          <time :datetime="finding.firstObservedAt">{{ finding.firstObservedAt }}</time>
        </dd>
      </div>
      <div v-if="finding.lastObservedAt">
        <dt class="inline font-medium">Last observed:</dt>
        {{ ' ' }}
        <dd class="inline">
          <time :datetime="finding.lastObservedAt">{{ finding.lastObservedAt }}</time>
        </dd>
      </div>
      <div v-if="finding.expiresAt">
        <dt class="inline font-medium">Expires:</dt>
        {{ ' ' }}
        <dd class="inline">
          <time :datetime="finding.expiresAt">{{ finding.expiresAt }}</time>
        </dd>
      </div>
      <div v-if="finding.snapshotId">
        <dt class="inline font-medium">Snapshot:</dt>
        {{ ' ' }}
        <dd class="inline break-all">{{ finding.snapshotId }}</dd>
      </div>
      <div v-if="finding.policyVersion">
        <dt class="inline font-medium">Policy:</dt>
        {{ ' ' }}
        <dd class="inline break-all">{{ finding.policyVersion }}</dd>
      </div>
      <div v-if="finding.revision">
        <dt class="inline font-medium">Revision:</dt>
        {{ ' ' }}
        <dd class="inline break-all">{{ finding.revision }}</dd>
      </div>
    </dl>

    <div v-if="finding.issue || finding.reasonCodes?.length" class="mt-3">
      <ReasonCodeList v-if="finding.issue" :issues="[finding.issue]" />
      <ReasonCodeList v-else :codes="finding.reasonCodes" />
    </div>

    <p v-if="finding.detail" class="mt-3 text-xs text-gray-500 dark:text-gray-400">
      {{ finding.detail }}
    </p>

    <div v-if="finding.issue" class="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
      <EvidenceDrawer
        :references="finding.issue.evidence"
        :snapshot-id="finding.snapshotId"
        :policy-version="finding.policyVersion"
      />
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { DecisionIssue } from '@balanceframe/protocol-generated';
import type { Amount } from './types';

interface Finding {
  title: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  category?: string;
  entityType?: string;
  amount?: Amount;
  reasonCodes?: string[];
  detail?: string;
  classification?: string;
  status?: string;
  issue?: DecisionIssue;
  snapshotId?: string;
  policyVersion?: string;
  revision?: string;
  findingVersion?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  expiresAt?: string;
}

const props = defineProps<{
  finding: Finding;
}>();

const severityIcon = computed(() => {
  const map: Record<Finding['severity'], string> = {
    critical: 'i-heroicons-x-circle',
    warning: 'i-heroicons-exclamation-triangle',
    info: 'i-heroicons-information-circle',
    success: 'i-heroicons-check-circle',
  };
  return map[props.finding.severity];
});

const severityColorClass = computed(() => {
  const map: Record<Finding['severity'], string> = {
    critical: 'text-red-600 dark:text-red-400',
    warning: 'text-amber-600 dark:text-amber-400',
    info: 'text-blue-600 dark:text-blue-400',
    success: 'text-emerald-600 dark:text-emerald-400',
  };
  return map[props.finding.severity];
});

const hasFindingMetadata = computed(
  () =>
    Boolean(props.finding.classification) ||
    Boolean(props.finding.status) ||
    props.finding.findingVersion !== undefined ||
    Boolean(props.finding.firstObservedAt) ||
    Boolean(props.finding.lastObservedAt) ||
    Boolean(props.finding.expiresAt) ||
    Boolean(props.finding.snapshotId) ||
    Boolean(props.finding.policyVersion) ||
    Boolean(props.finding.revision),
);

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Unspecified';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}
</script>
