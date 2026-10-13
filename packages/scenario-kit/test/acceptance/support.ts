import { request } from 'node:http';
import { expect } from 'vitest';

import type { LoadedScenario } from '../../src/loader.js';
import { loadScenario, stopScenario } from '../../src/loader.js';
import { createOwnedScenarioRoot } from '../../src/process-runtime.js';
import { SCENARIO_CATALOG_VERSION } from '../../src/catalog.js';

const PUBLIC_ORIGIN = 'http://127.0.0.1:3003';

interface ScenarioHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly cookies: readonly string[];
  readonly json: () => Promise<unknown>;
}

/** Node's HTTP transport preserves the public Host on the private loopback connection. */
export function normalScenarioResponse(
  url: URL,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<ScenarioHttpResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<ScenarioHttpResponse>();
  const outgoing = request(url, options, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const cookies: string[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index]!.toLowerCase() === 'set-cookie')
          cookies.push(response.rawHeaders[index + 1]!);
      }
      const status = response.statusCode!;
      resolve({
        status, ok: status >= 200 && status < 300, cookies,
        json: async () => JSON.parse(bytes.toString('utf8')) as unknown,
      });
    });
  });
  outgoing.on('error', reject);
  outgoing.end(options.body);
  return promise;
}

/** Runs an assertion against the real authenticated application and always removes its isolated Actual workspace. */
export async function withScenario<T>(
  id: string,
  assertion: (handle: LoadedScenario) => Promise<T>,
  options: { branches?: readonly string[] } = {},
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
        ...(options.branches ? { branches: options.branches } : {}),
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
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    personaId?: string;
    body?: unknown;
    /** Some normal human governance reads, including invitation listing, require fresh proof. */
    freshProof?: boolean;
  } = {},
): Promise<{ status: number; body: T }> {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Expected an application-relative path');
  const persona = handle.initialized.personas[options.personaId ?? 'owner'];
  if (!persona) throw new Error('Unknown fictional persona');
  const publicOrigin = handle.processes.publicOrigin;
  let cookieHeader = persona.cookieHeader;
  if (options.freshProof || (options.method && options.method !== 'GET')) {
    const proof = await normalScenarioResponse(new URL('/api/reauth', handle.processes.webUrl), {
      method: 'POST',
      headers: {
        host: new URL(publicOrigin).host,
        origin: publicOrigin,
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
    for (const value of proof.cookies) {
      const pair = value.split(';', 1)[0]!;
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const response = await normalScenarioResponse(new URL(path, handle.processes.webUrl), {
    method: options.method ?? 'GET',
    headers: {
      host: new URL(publicOrigin).host,
      origin: publicOrigin,
      cookie: cookieHeader,
      'x-balanceframe-space': persona.spaceId,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body: T = (await response.json()) as T;
  return { status: response.status, body };
}
