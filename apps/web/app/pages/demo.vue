<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <header class="mb-6 max-w-3xl">
      <p
        class="text-sm font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400"
      >
        BalanceFrame demo
      </p>
      <h1 class="mt-1 text-3xl font-semibold text-gray-900 dark:text-white">
        Explore feature scenarios
      </h1>
      <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
        These scenarios use the real authenticated application and fictional shared data. Choose a
        story, then follow its suggested actions in the normal BalanceFrame screens.
      </p>
    </header>

    <section
      v-if="!demoEnabled"
      class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
      role="alert"
      data-testid="demo-unavailable"
    >
      <h2 class="text-lg font-semibold">Demo mode is unavailable</h2>
      <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
        This deployment does not have an interactive demo configured.
      </p>
    </section>

    <template v-else>
      <section
        class="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-100"
        aria-labelledby="demo-shared-heading"
      >
        <h2 id="demo-shared-heading" class="font-semibold">Shared fictional workspace</h2>
        <p class="mt-1 text-sm">
          Fictional data — changes affect this shared demo instance. Resetting replaces the current
          scenario for everyone using this demo.
        </p>
      </section>

      <div
        class="mb-6 grid gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:grid-cols-2 sm:items-end"
      >
        <label for="demo-persona" class="grid gap-1 text-sm">
          <span class="font-medium">Fictional persona</span>
          <select
            id="demo-persona"
            v-model="personaSelection"
            aria-label="Fictional persona"
            class="rounded-md border border-gray-300 bg-transparent p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-700"
            :disabled="
              operationBusy !== null || state?.status !== 'ready' || availablePersonas.length < 2
            "
            @change="changePersona"
          >
            <option v-for="persona in availablePersonas" :key="persona.id" :value="persona.id">
              {{ persona.label }}
            </option>
          </select>
          <span class="text-xs text-gray-500 dark:text-gray-400"
            >Switching persona reloads the authenticated fictional account.</span
          >
        </label>

        <div class="flex flex-wrap items-center justify-end gap-3">
          <p v-if="state?.status === 'loading'" role="status" aria-live="polite" class="text-sm">
            Loading the shared scenario…
          </p>
          <p v-else-if="state?.status === 'ready'" role="status" aria-live="polite" class="text-sm">
            Scenario ready
          </p>
          <button
            v-if="state?.status === 'ready'"
            type="button"
            data-action="open-scenario"
            class="rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="operationBusy !== null"
            @click="openScenario"
          >
            Open active scenario
          </button>
          <button
            type="button"
            ref="resetButton"
            data-action="reset"
            class="rounded-md border border-amber-700 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400 dark:text-amber-100 dark:hover:bg-amber-900/50"
            :disabled="operationBusy !== null || state?.status === 'loading'"
            @click="confirmReset = true"
          >
            Reset shared demo
          </button>
        </div>
      </div>

      <p v-if="catalogLoading" role="status" aria-live="polite" class="mb-4">
        Loading demo scenarios…
      </p>
      <p v-if="catalogError" role="alert" class="mb-4 text-red-700 dark:text-red-300">
        {{ catalogError }}
        <button
          type="button"
          class="ml-2 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
          @click="loadCatalog"
        >
          Retry
        </button>
      </p>
      <p v-if="stateError" role="alert" class="mb-4 text-red-700 dark:text-red-300">
        {{ stateError }}
        <button
          type="button"
          class="ml-2 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
          @click="loadState"
        >
          Retry
        </button>
      </p>
      <p v-if="operationError" role="alert" class="mb-4 text-red-700 dark:text-red-300">
        {{ operationError }}
      </p>
      <p v-if="operationMessage" role="status" aria-live="polite" class="mb-4 text-sm">
        {{ operationMessage }}
      </p>

      <div
        v-if="confirmReset"
        class="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="demo-reset-heading"
        aria-describedby="demo-reset-description"
      >
        <h2 id="demo-reset-heading" class="font-semibold">Reset the shared demo?</h2>
        <p id="demo-reset-description" class="mt-1 text-sm">
          This replaces the active fictional scenario and signs the demo back into its owner
          persona. Anyone currently using the demo will see the new scenario.
        </p>
        <div class="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            ref="resetConfirmButton"
            data-action="confirm-reset"
            class="rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-50"
            :disabled="operationBusy !== null"
            @click="resetDemo"
          >
            Confirm reset
          </button>
          <button
            type="button"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-700"
            :disabled="operationBusy !== null"
            @click="confirmReset = false"
          >
            Cancel
          </button>
        </div>
      </div>

      <div v-if="groups.length" class="space-y-8">
        <section
          v-for="group in groups"
          :key="group.featureGroup"
          :data-testid="`demo-feature-${group.featureGroup}`"
          :aria-labelledby="`demo-feature-heading-${group.featureGroup}`"
        >
          <h2
            :id="`demo-feature-heading-${group.featureGroup}`"
            class="mb-3 text-xl font-semibold text-gray-900 dark:text-white"
          >
            {{ group.featureGroup }}
          </h2>
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <article
              v-for="scenario in group.scenarios"
              :key="scenario.id"
              class="flex h-full flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
              :class="{ 'ring-2 ring-primary-500': scenario.id === state?.scenarioId }"
            >
              <div class="flex-1">
                <p
                  v-if="scenario.id === state?.scenarioId"
                  class="text-xs font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400"
                >
                  Active scenario
                </p>
                <h3 class="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
                  {{ scenario.title }}
                </h3>
                <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">{{ scenario.summary }}</p>
                <div class="mt-3">
                  <p
                    class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                  >
                    Suggested actions
                  </p>
                  <ul
                    class="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300"
                  >
                    <li v-for="action in scenario.suggestedActions" :key="action">{{ action }}</li>
                  </ul>
                </div>
              </div>
              <div class="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  :data-scenario-id="scenario.id"
                  data-action="load"
                  class="rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="
                    operationBusy !== null ||
                    state?.status === 'loading' ||
                    (scenario.id === state?.scenarioId && state?.status === 'ready')
                  "
                  @click="loadScenario(scenario.id)"
                >
                  {{
                    scenario.id === state?.scenarioId && state?.status === 'ready'
                      ? 'Started'
                      : 'Start scenario'
                  }}
                </button>
                <button
                  v-for="eventId in scenario.supportedEventIds"
                  :key="eventId"
                  type="button"
                  :data-event-id="eventId"
                  class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                  :disabled="
                    operationBusy !== null ||
                    state?.status !== 'ready' ||
                    scenario.id !== state?.scenarioId
                  "
                  :title="
                    scenario.id !== state?.scenarioId
                      ? 'Start this scenario before applying its fixture event.'
                      : undefined
                  "
                  @click="triggerEvent(eventId, scenario.id)"
                >
                  {{ eventLabel(eventId) }}
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>
      <p
        v-else-if="!catalogLoading"
        class="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
      >
        No demo scenarios are available.
      </p>
    </template>
  </main>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted } from 'vue';
type DemoStatus = 'loading' | 'ready' | 'failed';
type Operation = 'load' | 'reset' | 'persona' | 'event' | 'entry';

interface ScenarioSummary {
  id: string;
  featureGroup: string;
  title: string;
  summary: string;
  suggestedActions: string[];
  supportedEventIds: string[];
}

interface DemoState {
  status: DemoStatus;
  scenarioId: string;
  generation: number;
  anchor: string | null;
  shared: true;
  personaId: string | null;
  personaIds: string[];
  csrfToken: string | null;
  failureCode?: string;
}

interface DemoEntryError {
  data?: DemoEntryError;
  error?: { code?: string; failureCode?: string };
  code?: string;
  failureCode?: string;
  status?: number;
  statusCode?: number;
}

const personas = [
  { id: 'owner', label: 'Fictional owner' },
  { id: 'approver', label: 'Fictional independent approver' },
  { id: 'coapprover', label: 'Fictional co-approver' },
  { id: 'restricted', label: 'Fictional restricted viewer' },
] as const;

const configuredForDemo = () => {
  try {
    return typeof useRuntimeConfig === 'function' && useRuntimeConfig()?.public?.demoMode === true;
  } catch {
    return false;
  }
};

const demoEnabled = ref(configuredForDemo());
const scenarios = ref<ScenarioSummary[]>([]);
const state = ref<DemoState | null>(null);
const catalogLoading = ref(false);
const catalogError = ref('');
const stateError = ref('');
const operationError = ref('');
const operationMessage = ref('');
const operationBusy = ref<Operation | null>(null);
const confirmReset = ref(false);
const resetConfirmButton = ref<HTMLButtonElement | null>(null);
const resetButton = ref<HTMLButtonElement | null>(null);
const personaSelection = ref('owner');
let statePollTimer: ReturnType<typeof setInterval> | undefined;
let stateRequestRevision = 0;
let observedGeneration: number | null = null;

watch(confirmReset, (open) => {
  void nextTick(() => {
    (open ? resetConfirmButton : resetButton).value?.focus();
  });
});

const availablePersonas = computed(() =>
  personas.filter((persona) => state.value?.personaIds.includes(persona.id)),
);

const groups = computed(() => {
  const grouped: Array<{ featureGroup: string; scenarios: ScenarioSummary[] }> = [];
  for (const scenario of scenarios.value) {
    let group = grouped.find((candidate) => candidate.featureGroup === scenario.featureGroup);
    if (!group) {
      group = { featureGroup: scenario.featureGroup, scenarios: [] };
      grouped.push(group);
    }
    group.scenarios.push(scenario);
  }
  return grouped;
});

function validScenario(value: unknown): value is ScenarioSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ScenarioSummary>;
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
}

function parseCatalog(value: unknown): ScenarioSummary[] | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { scenarios?: unknown }).scenarios)
  ) {
    return null;
  }
  const entries = (value as { scenarios: unknown[] }).scenarios;
  return entries.every(validScenario) ? (entries as ScenarioSummary[]) : null;
}

function parseState(value: unknown): DemoState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DemoState>;
  if (
    (candidate.status !== 'loading' &&
      candidate.status !== 'ready' &&
      candidate.status !== 'failed') ||
    typeof candidate.scenarioId !== 'string' ||
    typeof candidate.generation !== 'number' ||
    !Number.isSafeInteger(candidate.generation) ||
    candidate.shared !== true ||
    !Array.isArray(candidate.personaIds) ||
    !candidate.personaIds.every(
      (id) => typeof id === 'string' && personas.some((persona) => persona.id === id),
    )
  ) {
    return null;
  }
  return {
    status: candidate.status,
    scenarioId: candidate.scenarioId,
    generation: candidate.generation,
    anchor: typeof candidate.anchor === 'string' ? candidate.anchor : null,
    shared: true,
    personaId: typeof candidate.personaId === 'string' ? candidate.personaId : null,
    personaIds: candidate.personaIds,
    csrfToken: typeof candidate.csrfToken === 'string' ? candidate.csrfToken : null,
    ...(typeof candidate.failureCode === 'string' ? { failureCode: candidate.failureCode } : {}),
  };
}

async function loadCatalog() {
  if (!demoEnabled.value) return;
  catalogLoading.value = true;
  catalogError.value = '';
  try {
    const parsed = parseCatalog(
      await $fetch<unknown>('/__demo/catalog', { credentials: 'same-origin' }),
    );
    if (!parsed) throw new Error('invalid catalog');
    scenarios.value = parsed;
  } catch {
    catalogError.value = 'Demo scenarios are unavailable. Try again.';
  } finally {
    catalogLoading.value = false;
  }
}

async function loadState() {
  if (!demoEnabled.value) return;
  const revision = ++stateRequestRevision;
  stateError.value = '';
  try {
    const parsed = parseState(
      await $fetch<unknown>('/__demo/state', { credentials: 'same-origin' }),
    );
    if (!parsed) throw new Error('invalid state');
    if (revision !== stateRequestRevision) return;
    const generationChanged =
      observedGeneration !== null && observedGeneration !== parsed.generation;
    observedGeneration = parsed.generation;
    state.value = parsed;
    if (generationChanged && operationBusy.value === null) {
      hardReload();
      return;
    }
    if (parsed.personaId && personas.some((persona) => persona.id === parsed.personaId)) {
      personaSelection.value = parsed.personaId;
    }
    if (parsed.status === 'failed') {
      stateError.value = 'The selected demo scenario could not be prepared. Try loading it again.';
    }
  } catch {
    if (revision === stateRequestRevision)
      stateError.value = 'Demo state is unavailable. Try again.';
  }
}

function startPolling() {
  if (statePollTimer) return;
  statePollTimer = setInterval(() => void loadState(), 1500);
}

function stopPolling() {
  if (!statePollTimer) return;
  clearInterval(statePollTimer);
  statePollTimer = undefined;
}

function demoErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as DemoEntryError;
  const nested = candidate.data;
  return (
    candidate.failureCode ??
    candidate.code ??
    candidate.error?.failureCode ??
    candidate.error?.code ??
    nested?.failureCode ??
    nested?.code ??
    nested?.error?.failureCode ??
    nested?.error?.code
  );
}

function controlError(error: unknown): string {
  const failure = error as DemoEntryError;
  const code = demoErrorCode(error);
  if (code === 'DEMO_OPERATION_DISABLED')
    return 'This operation is unavailable for the active scenario (DEMO_OPERATION_DISABLED).';
  if (failure.status === 401 || failure.statusCode === 401)
    return 'Sign in to the fictional persona again and retry.';
  if (failure.status === 409 || failure.statusCode === 409)
    return 'The shared demo changed. Refresh the controls and try again.';
  return 'The shared demo could not complete that action. Try again.';
}

async function postControl(path: string, body: Record<string, unknown>, operation: Operation) {
  const currentState = state.value;
  if (!currentState || !currentState.csrfToken || currentState.status === 'loading') {
    operationError.value = 'Demo controls are not ready. Refresh the page and try again.';
    operationMessage.value = '';
    return false;
  }
  const expectedGeneration = currentState.generation;
  operationBusy.value = operation;
  operationError.value = '';
  operationMessage.value = 'Updating the shared demo…';
  try {
    const response = await $fetch<unknown>(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-BalanceFrame-Demo-CSRF': currentState.csrfToken,
      },
      body,
    });
    const responseCode = demoErrorCode(response);
    if (responseCode) throw { data: response, code: responseCode };
    if (state.value?.generation !== expectedGeneration) {
      throw new Error('The shared demo changed while this action was in flight.');
    }
    state.value = state.value ? { ...state.value, status: 'loading' } : state.value;
    return true;
  } catch (error) {
    operationError.value = controlError(error);
    operationMessage.value = '';
    return false;
  } finally {
    operationBusy.value = null;
  }
}

async function openScenario() {
  const current = state.value;
  if (!current || current.status !== 'ready' || operationBusy.value !== null) return;
  operationBusy.value = 'entry';
  operationError.value = '';
  try {
    const entry = await $fetch<unknown>(`/__demo/entry?generation=${current.generation}`, {
      credentials: 'same-origin',
    });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid entry');
    const { generation, path } = entry as { generation?: unknown; path?: unknown };
    if (
      generation !== current.generation ||
      typeof path !== 'string' ||
      (path !== '/purchase-check' &&
        path !== '/liquidity' &&
        !/^\/spend-sessions\/[a-zA-Z0-9_-]+(?:\/completions\/[a-zA-Z0-9_-]+)?$/.test(path)) ||
      state.value?.generation !== current.generation
    )
      throw new Error('Stale or unauthorized entry');
    await navigateTo(path);
  } catch (error) {
    operationError.value = controlError(error);
  } finally {
    operationBusy.value = null;
  }
}

function hardReload() {
  if (typeof window !== 'undefined') window.location.reload();
}

async function loadScenario(scenarioId: string) {
  if (!scenarios.value.some((scenario) => scenario.id === scenarioId)) return;
  const success = await postControl(
    '/__demo/load',
    {
      scenarioId,
      expectedGeneration: state.value?.generation,
    },
    'load',
  );
  if (!success) return;
  operationMessage.value = `Loading ${scenarios.value.find((scenario) => scenario.id === scenarioId)?.title ?? 'scenario'}…`;
  hardReload();
}

async function resetDemo() {
  confirmReset.value = false;
  const success = await postControl(
    '/__demo/reset',
    {
      expectedGeneration: state.value?.generation,
    },
    'reset',
  );
  if (!success) return;
  operationMessage.value = 'Resetting the shared demo…';
  hardReload();
}

async function changePersona() {
  const personaId = personaSelection.value;
  if (!personas.some((persona) => persona.id === personaId) || personaId === state.value?.personaId)
    return;
  const success = await postControl(
    '/__demo/persona',
    {
      personaId,
      expectedGeneration: state.value?.generation,
    },
    'persona',
  );
  if (success) hardReload();
}

function eventLabel(eventId: string) {
  switch (eventId) {
    case 'categorize-uncategorized':
      return 'Apply fixture correction';
    case 'import-match':
    case 'import-ambiguous':
      return 'Simulate fixture import';
    default:
      return 'Apply fixture event';
  }
}

async function triggerEvent(eventId: string, scenarioId: string) {
  const activeScenario = scenarios.value.find((scenario) => scenario.id === scenarioId);
  if (
    !activeScenario?.supportedEventIds.includes(eventId) ||
    scenarioId !== state.value?.scenarioId
  )
    return;
  const success = await postControl(
    '/__demo/event',
    {
      eventId,
      expectedGeneration: state.value?.generation,
    },
    'event',
  );
  if (success) hardReload();
}

onMounted(() => {
  if (!demoEnabled.value) return;
  void Promise.all([loadCatalog(), loadState()]);
  startPolling();
});

onBeforeUnmount(stopPolling);
</script>
