<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
          Rule Details
        </h2>
        <div class="flex items-center gap-2">
          <UBadge
            :color="rule.inactive ? 'neutral' : 'success'"
            variant="solid"
            size="sm"
          >
            {{ rule.inactive ? 'Inactive' : 'Active' }}
          </UBadge>
          <span class="text-xs text-gray-400">#{{ rule.order }}</span>
        </div>
      </div>
    </template>

    <div class="space-y-4">
      <!-- Name -->
      <div>
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Name</h3>
        <p class="text-base font-semibold">{{ rule.name }}</p>
      </div>

      <!-- ID -->
      <div>
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">ID</h3>
        <p class="text-sm font-mono text-gray-600 dark:text-gray-400 break-all">{{ rule.id }}</p>
      </div>

      <!-- Order -->
      <div>
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Order</h3>
        <p class="text-sm">{{ rule.order }}</p>
      </div>

      <!-- State badge -->
      <div v-if="proposalState">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Proposal State</h3>
        <UBadge
          :color="stateBadgeColor"
          variant="solid"
          size="sm"
          class="mt-1"
        >
          {{ proposalState }}
        </UBadge>
        <p v-if="stateDescription" class="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {{ stateDescription }}
        </p>
      </div>

      <!-- Trigger conditions -->
      <div v-if="rule.trigger">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Trigger</h3>
        <pre class="mt-1 text-xs bg-gray-50 dark:bg-gray-800 rounded-md p-3 overflow-x-auto font-mono">{{ formatJson(rule.trigger) }}</pre>
      </div>

      <!-- Actions -->
      <div v-if="rule.actions">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400">Actions</h3>
        <pre class="mt-1 text-xs bg-gray-50 dark:bg-gray-800 rounded-md p-3 overflow-x-auto font-mono">{{ formatJson(rule.actions) }}</pre>
      </div>

      <!-- Simulation evidence -->
      <template v-if="simulation">
        <hr class="border-gray-200 dark:border-gray-700" />
        <h3 class="font-semibold text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide">
          Simulation Evidence
        </h3>

        <!-- Overview -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="bg-gray-50 dark:bg-gray-800 rounded-md p-3 text-center">
            <p class="text-2xl font-bold text-primary-600 dark:text-primary-400">
              {{ simulation.transactionsMatched }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Transactions Matched</p>
          </div>
          <div class="bg-gray-50 dark:bg-gray-800 rounded-md p-3 text-center">
            <p class="text-2xl font-bold text-gray-700 dark:text-gray-300">
              {{ simulation.transactionsAffected.length }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Transactions Affected</p>
          </div>
          <div class="bg-gray-50 dark:bg-gray-800 rounded-md p-3 text-center">
            <p class="text-2xl font-bold" :class="conflictColor">
              {{ simulation.conflicts.length }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Conflicts</p>
          </div>
          <div class="bg-gray-50 dark:bg-gray-800 rounded-md p-3 text-center">
            <p class="text-2xl font-bold text-gray-700 dark:text-gray-300">
              {{ Object.keys(simulation.categoryDistribution).length }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Target Categories</p>
          </div>
        </div>

        <!-- Category distribution -->
        <div v-if="distributionItems.length > 0">
          <h4 class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Category Distribution
          </h4>
          <div class="space-y-1">
            <div
              v-for="d in distributionItems"
              :key="d.category"
              class="flex items-center gap-2 text-sm"
            >
              <span class="w-32 truncate text-gray-700 dark:text-gray-300">{{ d.category }}</span>
              <div class="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  class="bg-primary-500 dark:bg-primary-400 h-2 rounded-full transition-all"
                  :style="{ width: d.percent + '%' }"
                />
              </div>
              <span class="w-8 text-right text-xs text-gray-500">{{ d.count }}</span>
            </div>
          </div>
        </div>

        <!-- Conflicts -->
        <div v-if="simulation.conflicts.length > 0">
          <h4 class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Rule Overlap / Conflicts
          </h4>
          <ul class="space-y-1">
            <li
              v-for="(conflict, idx) in simulation.conflicts"
              :key="idx"
              class="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-md px-3 py-2"
            >
              {{ conflict }}
            </li>
          </ul>
        </div>

        <!-- Example transactions -->
        <div v-if="simulation.examples.length > 0">
          <h4 class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Example Matches
          </h4>
          <div class="space-y-2 max-h-64 overflow-y-auto">
            <div
              v-for="(ex, idx) in simulation.examples.slice(0, 5)"
              :key="idx"
              class="border border-gray-200 dark:border-gray-700 rounded-md p-2 text-xs"
            >
              <div class="flex justify-between">
                <span class="font-medium">{{ ex.payee ?? 'Unknown' }}</span>
                <span :class="ex.wouldChange ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500'">
                  {{ formatAmount(ex.amount) }}
                </span>
              </div>
              <div class="text-gray-500 dark:text-gray-400 mt-0.5">
                Current: {{ ex.currentCategory ?? 'uncategorized' }}
                <span v-if="ex.wouldChange" class="text-amber-600 dark:text-amber-400">
                  &rarr; will change
                </span>
              </div>
            </div>
            <p
              v-if="simulation.examples.length > 5"
              class="text-xs text-gray-400 text-center pt-1"
            >
              +{{ simulation.examples.length - 5 }} more
            </p>
          </div>
        </div>

        <!-- Simulated at timestamp -->
        <p class="text-xs text-gray-400">
          Simulated: {{ formatDate(simulation.simulatedAt) }}
        </p>
      </template>

      <!-- Missing simulation warning -->
      <template v-else-if="showSimulationMissing">
        <hr class="border-gray-200 dark:border-gray-700" />
        <UAlert
          title="No Simulation Evidence"
          description="This rule has not been simulated against historical transactions. Simulation is required before the rule can be approved."
          color="warning"
          variant="soft"
          icon="i-heroicons-exclamation-triangle"
        />
      </template>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export interface SimulationExample {
  readonly txId: string;
  readonly payee: string | null;
  readonly amount: { minorUnits: string; currency: string };
  readonly currentCategory: string | null;
  readonly wouldChange: boolean;
}

export interface SimulationEvidence {
  readonly transactionsMatched: number;
  readonly transactionsAffected: readonly string[];
  readonly categoryDistribution: Record<string, number>;
  readonly conflicts: readonly string[];
  readonly examples: readonly SimulationExample[];
  readonly simulatedAt: string;
}

export interface RuleShowResult {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly trigger: unknown;
  readonly actions: unknown;
  readonly inactive: boolean;
}

/**
 * Enriched rule detail with optional simulation evidence and proposal state.
 * When simulation is null and showSimulationMissing is true, a warning alert
 * is rendered instead of the evidence panel.
 */
export interface RuleDetailProps {
  rule: RuleShowResult;
  simulation?: SimulationEvidence | null;
  proposalState?: 'proposal' | 'approved' | 'executing' | 'verified' | 'failed' | 'stale' | null;
  showSimulationMissing?: boolean;
}

const props = withDefaults(defineProps<RuleDetailProps>(), {
  simulation: null,
  proposalState: null,
  showSimulationMissing: false,
});

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const distributionItems = computed(() => {
  if (!props.simulation) return [];
  const dist = props.simulation.categoryDistribution;
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return Object.entries(dist)
    .map(([category, count]) => ({
      category: category || '(uncategorized)',
      count,
      percent: Math.round((count / total) * 100),
    }))
    .sort((a, b) => b.count - a.count);
});

const conflictColor = computed(() => {
  const n = props.simulation?.conflicts.length ?? 0;
  return n > 0
    ? 'text-red-600 dark:text-red-400'
    : 'text-green-600 dark:text-green-400';
});

const stateBadgeColor = computed(() => {
  switch (props.proposalState) {
    case 'proposal': return 'primary';
    case 'approved': return 'success';
    case 'executing': return 'warning';
    case 'verified': return 'success';
    case 'failed': return 'error';
    case 'stale': return 'neutral';
    default: return 'neutral';
  }
});

const stateDescription = computed(() => {
  switch (props.proposalState) {
    case 'proposal': return 'Proposed — awaiting approval and execution.';
    case 'approved': return 'Approved — ready for execution.';
    case 'executing': return 'Currently being applied to the ledger.';
    case 'verified': return 'Applied and verified against the ledger snapshot.';
    case 'failed': return 'Execution failed — review the audit trail for details.';
    case 'stale': return 'The simulation evidence has expired. Re-run simulation before approving.';
    default: return null;
  }
});

function formatAmount(amount: { minorUnits: string; currency: string } | string): string {
  if (typeof amount === 'string') return amount;
  const value = Number(amount.minorUnits) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: amount.currency || 'USD',
  }).format(value);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
</script>
