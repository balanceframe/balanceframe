<template>
  <aside
    v-if="demoEnabled"
    class="border-b border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-100"
    data-testid="demo-banner"
    aria-live="polite"
  >
    <UContainer class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
      <p class="font-semibold">Demo mode</p>
      <p v-if="scenarioTitle">Scenario: {{ scenarioTitle }}</p>
      <p v-else-if="state?.status === 'loading'">Preparing the shared scenario…</p>
      <p v-else>Scenario unavailable</p>
      <p v-if="personaLabel">Persona: {{ personaLabel }}</p>
      <p class="font-medium">Fictional data — changes affect this shared demo instance</p>
      <p class="basis-full font-medium">
        For guarded actions as this fictional persona, type CONFIRM in the confirmation field.
        This is disposable-demo confirmation, not your account password; fictional passwords stay private.
      </p>
      <div v-if="activeScenario?.suggestedActions.length" class="basis-full">
        <p class="font-medium">Scenario walkthrough</p>
        <ul class="list-disc pl-5">
          <li v-for="action in activeScenario.suggestedActions" :key="action">{{ action }}</li>
        </ul>
      </div>
      <p v-if="state?.status === 'failed'" role="alert" class="basis-full">
        This demo scenario could not be prepared.
        <NuxtLink
          to="/demo"
          class="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
          >Open demo controls</NuxtLink
        >
      </p>
      <NuxtLink
        v-else
        to="/demo"
        class="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
        >Demo controls</NuxtLink
      >
    </UContainer>
  </aside>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
interface DemoState {
  status: 'loading' | 'ready' | 'failed';
  scenarioId: string;
  generation: number;
  anchor: string | null;
  shared: true;
  personaId: string | null;
  personaIds: string[];
  personas: { id: string; label: string }[];
  failureCode?: string;
}

interface DemoSummary {
  id: string;
  featureGroup: string;
  title: string;
  summary: string;
  suggestedActions: string[];
  supportedEventIds: string[];
}

const demoEnabled = ref(false);
const state = ref<DemoState | null>(null);
const summaries = ref<DemoSummary[]>([]);
let pollTimer: ReturnType<typeof setInterval> | undefined;
let redirecting = false;

const fallbackPersonas = [
  { id: 'owner', label: 'Fictional owner' },
  { id: 'approver', label: 'Fictional independent approver' },
  { id: 'coapprover', label: 'Fictional co-approver' },
  { id: 'restricted', label: 'Fictional restricted viewer' },
];
const personaIds = [...fallbackPersonas.map(({ id }) => id), 'limited', 'invitee'];
const activeScenario = computed(() =>
  summaries.value.find((scenario) => scenario.id === state.value?.scenarioId),
);

const scenarioTitle = computed(() => state.value?.scenarioId
  ? activeScenario.value?.title ?? 'Current scenario' : '');

const personaLabel = computed(() =>
  state.value?.personas.find(({ id }) => id === state.value?.personaId)?.label ?? '',
);

function configuredForDemo() {
  try {
    return typeof useRuntimeConfig === 'function' && useRuntimeConfig()?.public?.demoMode === true;
  } catch {
    return false;
  }
}

function parseState(value: unknown): DemoState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DemoState>;
  if (
    (candidate.status !== 'loading' && candidate.status !== 'ready' && candidate.status !== 'failed') ||
    typeof candidate.scenarioId !== 'string' ||
    typeof candidate.generation !== 'number' || !Number.isSafeInteger(candidate.generation) ||
    candidate.shared !== true || !Array.isArray(candidate.personaIds) ||
    !candidate.personaIds.every((id) => typeof id === 'string' && personaIds.includes(id)) ||
    new Set(candidate.personaIds).size !== candidate.personaIds.length
  ) return null;
  const declared = candidate.personas ?? fallbackPersonas.filter(({ id }) => candidate.personaIds!.includes(id));
  if (!Array.isArray(declared) || declared.length !== candidate.personaIds.length ||
    !declared.every((persona) => persona && typeof persona === 'object' &&
      candidate.personaIds!.includes(persona.id) && typeof persona.label === 'string' &&
      persona.label.trim().length > 0 && persona.label.length <= 160) ||
    new Set(declared.map(({ id }) => id)).size !== declared.length) return null;
  return {
    status: candidate.status,
    scenarioId: candidate.scenarioId,
    generation: candidate.generation,
    anchor: typeof candidate.anchor === 'string' ? candidate.anchor : null,
    shared: true,
    personaId: typeof candidate.personaId === 'string' && candidate.personaIds.includes(candidate.personaId)
      ? candidate.personaId : null,
    personaIds: candidate.personaIds,
    personas: declared.map(({ id, label }) => ({ id, label })),
  };
}

function validCatalog(value: unknown): value is { scenarios: DemoSummary[] } {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { scenarios?: unknown }).scenarios)
  ) {
    return false;
  }
  return (value as { scenarios: unknown[] }).scenarios.every((scenario) => {
    if (!scenario || typeof scenario !== 'object') return false;
    const candidate = scenario as Partial<DemoSummary>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.featureGroup === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.summary === 'string' &&
      Array.isArray(candidate.suggestedActions) &&
      candidate.suggestedActions.every((action) => typeof action === 'string') &&
      Array.isArray(candidate.supportedEventIds) &&
      candidate.supportedEventIds.every((eventId) => typeof eventId === 'string')
    );
  });
}

async function refresh() {
  if (!demoEnabled.value || redirecting) return;
  try {
    const [nextState, catalog] = await Promise.all([
      $fetch<unknown>('/__demo/state', { credentials: 'same-origin' }).then(parseState),
      $fetch<unknown>('/__demo/catalog', { credentials: 'same-origin' }),
    ]);
    if (nextState) {
      const previous = state.value;
      if (previous && nextState.generation < previous.generation) return;
      if (
        previous &&
        (nextState.generation !== previous.generation || nextState.status !== 'ready') &&
        typeof window !== 'undefined' &&
        window.location.pathname !== '/demo'
      ) {
        window.location.assign('/demo');
        redirecting = true;
        return;
      }
      state.value = nextState;
    }
    if (validCatalog(catalog)) summaries.value = catalog.scenarios;
  } catch {
    // The banner is supplementary. The controls page owns actionable failures.
  }
}

onMounted(() => {
  demoEnabled.value = configuredForDemo();
  if (!demoEnabled.value) return;
  void refresh();
  pollTimer = setInterval(() => void refresh(), 2000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>
