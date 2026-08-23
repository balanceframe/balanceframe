<template>
  <UCard
    as="article"
    class="finding-card"
    :aria-label="`Finding: ${finding.title}`"
    :data-finding-status="finding.status"
  >
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
            v-if="findingName"
            class="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
            :aria-label="findingNameAriaLabel"
          >
            {{ findingName }}
          </p>
        </div>
      </div>
      <div v-if="finding.amount" class="shrink-0">
        <SemanticAmount :amount="finding.amount" />
      </div>
    </div>

    <div
      v-if="finding.classification || primaryIssueMetadata.length"
      class="mt-3 flex flex-wrap items-center gap-1.5 text-xs"
    >
      <span v-if="finding.classification" class="font-medium text-gray-700 dark:text-gray-300">
        {{ formatIdentifier(finding.classification) }}
      </span>
      <div
        v-if="primaryIssueMetadata.length"
        class="flex flex-wrap items-center gap-1.5"
        :aria-label="issueMetadataAriaLabel"
      >
        <span
          v-for="metadata in primaryIssueMetadata"
          :key="metadata"
          class="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300"
        >
          {{ metadata }}
        </span>
      </div>
    </div>

    <div v-if="finding.issue || finding.reasonCodes?.length" class="mt-3">
      <ReasonCodeList v-if="finding.issue" :issues="[finding.issue]" :scope-labels="scopeLabels" />
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

    <div
      v-if="hasTechnicalProvenance"
      class="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700"
    >
      <UButton
        variant="ghost"
        size="xs"
        :icon="technicalOpen ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
        :aria-label="technicalOpen ? 'Hide technical provenance' : 'Show technical provenance'"
        :aria-expanded="String(technicalOpen)"
        :aria-controls="technicalContentId"
        @click="technicalOpen = !technicalOpen"
      >
        Technical provenance
      </UButton>

      <div
        v-if="technicalOpen"
        :id="technicalContentId"
        role="region"
        aria-label="Technical provenance"
        class="mt-2"
      >
        <dl class="grid gap-1.5 text-xs text-gray-500 dark:text-gray-400 sm:grid-cols-2">
          <div v-if="technicalScope">
            <dt class="inline font-medium">
              {{ formatIdentifier(technicalScope.kind) }} reference:
            </dt>
            {{ ' ' }}
            <dd class="inline break-all font-mono">{{ technicalScope.id }}</dd>
          </div>
          <div v-if="finding.snapshotId">
            <dt class="inline font-medium">Snapshot:</dt>
            {{ ' ' }}
            <dd class="inline break-all font-mono">{{ finding.snapshotId }}</dd>
          </div>
          <div v-if="finding.policyVersion">
            <dt class="inline font-medium">Policy:</dt>
            {{ ' ' }}
            <dd class="inline break-all font-mono">{{ finding.policyVersion }}</dd>
          </div>
          <div v-if="finding.revision">
            <dt class="inline font-medium">Revision:</dt>
            {{ ' ' }}
            <dd class="inline break-all font-mono">{{ finding.revision }}</dd>
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
        </dl>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { DecisionIssue } from '@balanceframe/protocol-generated';
import { computed, ref, useId } from 'vue';
import type { Amount, DecisionScopeLabelMap } from './types';

interface Finding {
  title: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  category?: string;
  scopeLabel?: string;
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

const technicalOpen = ref(false);
const technicalContentId = `finding-provenance-${useId()}`;

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

const findingName = computed(
  () =>
    props.finding.scopeLabel ??
    props.finding.category ??
    (props.finding.entityType ? formatIdentifier(props.finding.entityType) : undefined),
);

const findingScopeKind = computed(() => {
  const scope = props.finding.issue?.scope;
  if (scope && scope.kind !== 'global') return scope.kind;
  return props.finding.entityType ?? 'category';
});

const findingNameAriaLabel = computed(() =>
  findingName.value
    ? `${formatIdentifier(findingScopeKind.value)}: ${findingName.value}`
    : undefined,
);

const primaryIssueMetadata = computed(() => {
  const metadata: string[] = [];
  if (props.finding.issue) {
    metadata.push(formatIdentifier(props.finding.issue.severity));
    metadata.push(formatIdentifier(props.finding.issue.effect));
  }
  if (props.finding.status) metadata.push(formatIdentifier(props.finding.status));
  return metadata;
});

const issueMetadataAriaLabel = computed(() => {
  const metadata: string[] = [];
  if (props.finding.issue) {
    metadata.push(formatIdentifier(props.finding.issue.severity));
    metadata.push(formatIdentifier(props.finding.issue.effect).toLowerCase());
  }
  if (props.finding.status) {
    metadata.push(formatIdentifier(props.finding.status).toLowerCase());
  }
  return `Issue metadata: ${metadata.join(', ')}`;
});

const scopeLabels = computed<DecisionScopeLabelMap>(() => {
  const scope = props.finding.issue?.scope;
  if (!findingName.value || !scope || scope.kind === 'global') return {};
  return { [scope.id]: findingName.value };
});

const technicalScope = computed(() => {
  const scope = props.finding.issue?.scope;
  if (!scope || scope.kind === 'global' || !scopeLabels.value[scope.id]) return null;
  return scope;
});

const hasTechnicalProvenance = computed(
  () =>
    technicalScope.value !== null ||
    Boolean(props.finding.snapshotId) ||
    Boolean(props.finding.policyVersion) ||
    Boolean(props.finding.revision) ||
    props.finding.findingVersion !== undefined ||
    Boolean(props.finding.firstObservedAt) ||
    Boolean(props.finding.lastObservedAt) ||
    Boolean(props.finding.expiresAt),
);

function formatIdentifier(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ');
  if (!words) return 'Unspecified';
  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}
</script>
