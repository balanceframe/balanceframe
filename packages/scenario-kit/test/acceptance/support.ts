import { expect } from 'vitest';

import type { LoadedScenario } from '../../src/loader.js';
import { loadScenario, stopScenario } from '../../src/loader.js';
import { createOwnedScenarioRoot } from '../../src/process-runtime.js';
import { SCENARIO_CATALOG_VERSION } from '../../src/catalog.js';

const PUBLIC_ORIGIN = 'http://127.0.0.1:3003';

/** Runs an assertion against the real authenticated application and always removes its isolated Actual workspace. */
export async function withScenario<T>(
  id: string,
  assertion: (handle: LoadedScenario) => Promise<T>,
): Promise<T> {
  const root = createOwnedScenarioRoot();
  const handle = await loadScenario({
    scenarioId: id,
    root,
    anchor: new Date(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  try {
    const result = await assertion(handle);
    const { assertionCalls, currentTestName } = expect.getState();
    if (!currentTestName || assertionCalls < 1) {
      throw new Error('Scenario verification requires a named behavioral assertion');
    }
    console.log(
      JSON.stringify({
        type: 'scenario-verification',
        catalogVersion: SCENARIO_CATALOG_VERSION,
        scenarioId: handle.scenario.id,
        anchor: handle.scenario.anchor,
        status: 'passed',
        assertions: { name: currentTestName, count: assertionCalls },
        evidence: { backend: 'disposable-actual', auth: 'better-auth' },
      }),
    );
    return result;
  } finally {
    await stopScenario(handle);
  }
}

/** Calls Source in the persona's selected space, renewing human proof before each mutation. */
export async function scenarioRequest<T = unknown>(
  handle: LoadedScenario,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; personaId?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Expected an application-relative path');
  const persona = handle.initialized.personas[options.personaId ?? 'owner'];
  if (!persona) throw new Error('Unknown fictional persona');
  let cookieHeader = persona.cookieHeader;
  if (options.method && options.method !== 'GET') {
    const proof = await fetch(new URL('/api/reauth', handle.processes.webUrl), {
      method: 'POST',
      headers: {
        host: new URL(PUBLIC_ORIGIN).host,
        origin: PUBLIC_ORIGIN,
        cookie: cookieHeader,
        'x-balanceframe-space': persona.spaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: persona.password }),
    });
    if (!proof.ok) throw new Error(`Scenario human reauthentication failed with status ${proof.status}`);
    const cookies = new Map(cookieHeader.split('; ').map((pair) => {
      const separator = pair.indexOf('=');
      return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
    }));
    for (const value of proof.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!;
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const response = await fetch(new URL(path, handle.processes.webUrl), {
    method: options.method ?? 'GET',
    headers: {
      host: new URL(PUBLIC_ORIGIN).host,
      origin: PUBLIC_ORIGIN,
      cookie: cookieHeader,
      'x-balanceframe-space': persona.spaceId,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body: T = (await response.json()) as T;
  return { status: response.status, body };
}
