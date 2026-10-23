import { describe, expect, it } from 'vitest';

import { startDemoServer, stopDemoServer, type DemoServer } from '../src/demo-server.js';

type DemoState = {
  status: 'loading' | 'ready' | 'failed';
  scenarioId: string;
  generation: number;
  csrfToken: string | null;
  personaId: string | null;
  personaIds: string[];
  failureCode?: string;
};

type Document = {
  id: string;
  scope: { spaceId: string; budgetId: string; connectionId: string };
  connectorId: string;
  sourceId: string;
};

const families = [
  { id: 'evidence-receipt-intake', count: 4, foreignWrite: '/api/evidence/allocation' },
  { id: 'evidence-plural-allocation', count: 1, foreignWrite: '/api/evidence/receipt-review' },
  { id: 'evidence-return-lifecycle', count: 6, foreignWrite: '/api/evidence/wallet-statements' },
  { id: 'evidence-wallet-statement', count: 1, foreignWrite: '/api/evidence/rules' },
  { id: 'evidence-categorization', count: 2, foreignWrite: '/api/evidence/extract-photo' },
] as const;

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

function mergeCookies(...values: string[]): string {
  const cookies = new Map<string, string>();
  for (const pair of values.flatMap((value) => value.split('; '))) {
    const separator = pair.indexOf('=');
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function api(
  demo: DemoServer,
  path: string,
  cookie: string,
  method = 'GET',
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${demo.url}${path}`, {
    method,
    headers: {
      cookie,
      origin: demo.url,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
}

async function state(demo: DemoServer, cookie: string): Promise<DemoState> {
  const response = await api(demo, '/__demo/state', cookie);
  expect(response.status).toBe(200);
  return response.json() as Promise<DemoState>;
}

async function control(
  demo: DemoServer,
  path: string,
  cookie: string,
  current: DemoState,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${demo.url}${path}`, {
    method: 'POST',
    headers: {
      origin: demo.url,
      cookie,
      'content-type': 'application/json',
      'x-balanceframe-demo-csrf': current.csrfToken!,
      ...headers,
    },
    body: JSON.stringify({ expectedGeneration: current.generation, ...body }),
    signal: AbortSignal.timeout(180_000),
  });
}

async function documents(demo: DemoServer, cookie: string, count: number): Promise<Document[]> {
  const response = await api(demo, '/api/evidence', cookie);
  const body = (await response.json()) as { result: { documents: Document[] } };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.result.documents).toHaveLength(count);
  expect(new Set(body.result.documents.map(({ id }) => id)).size).toBe(count);
  expect(
    new Set(
      body.result.documents.map(({ connectorId, sourceId }) =>
        JSON.stringify([connectorId, sourceId]),
      ),
    ).size,
  ).toBe(count);
  return body.result.documents;
}

async function selectedSpace(demo: DemoServer, cookie: string): Promise<string> {
  const response = await api(demo, '/api/spaces', cookie);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { selectedSpaceId: string; spaces: { id: string }[] };
  };
  expect(body.result.spaces).toHaveLength(1);
  expect(body.result.selectedSpaceId).toBe(body.result.spaces[0]!.id);
  return body.result.selectedSpaceId;
}

describe('evidence demo reset and isolation through normal sessions', () => {
  for (const family of families) {
    it(`${family.id} rotates its owned workspace and fences stale and restricted access`, async () => {
      const demo = await startDemoServer({ scenarioId: family.id, port: 0 });
      try {
        const page = await fetch(`${demo.url}/demo`);
        expect(page.status).toBe(200);
        const originalCookie = cookieHeader(page);
        expect(originalCookie).toContain('bf_demo=');
        const current = await state(demo, originalCookie);
        expect(current, current.failureCode).toMatchObject({
          status: 'ready',
          scenarioId: family.id,
          personaId: 'owner',
          personaIds: ['owner', 'coapprover', 'approver', 'restricted'],
        });
        expect(current.csrfToken).toEqual(expect.any(String));
        const entry = await api(
          demo,
          `/__demo/entry?generation=${current.generation}`,
          originalCookie,
        );
        expect(entry.status).toBe(200);
        expect(await entry.json()).toEqual({ generation: current.generation, path: '/review#transaction-evidence' });
        const evidencePage = await api(demo, '/review', originalCookie);
        expect(evidencePage.status).toBe(200);
        const originalSpace = await selectedSpace(demo, originalCookie);
        const original = await documents(demo, originalCookie, family.count);
        expect(original.every(({ scope }) => scope.spaceId === originalSpace)).toBe(true);
        const originalBudget = original[0]!.scope.budgetId;
        expect(originalBudget).toEqual(expect.any(String));
        for (const document of original) {
          const detail = await api(
            demo,
            `/api/evidence/${encodeURIComponent(document.id)}`,
            originalCookie,
          );
          expect(detail.status).toBe(200);
          expect(await detail.json()).toMatchObject({ result: { document } });
        }

        const forgedOrigin = await control(
          demo,
          '/__demo/reset',
          originalCookie,
          current,
          {},
          { origin: 'https://attacker.example' },
        );
        expect(forgedOrigin.status).toBe(403);
        const forgedCsrf = await control(
          demo,
          '/__demo/reset',
          originalCookie,
          current,
          {},
          { 'x-balanceframe-demo-csrf': 'invalid-csrf' },
        );
        expect(forgedCsrf.status).toBe(403);
        expect((await state(demo, originalCookie)).generation).toBe(current.generation);

        const reset = await control(demo, '/__demo/reset', originalCookie, current);
        expect(reset.status, await reset.clone().text()).toBe(200);
        let freshCookie = mergeCookies(originalCookie, cookieHeader(reset));
        const fresh = await state(demo, freshCookie);
        expect(fresh).toMatchObject({
          status: 'ready',
          scenarioId: family.id,
          generation: current.generation + 1,
          personaId: 'owner',
        });
        expect(fresh.csrfToken).toEqual(expect.any(String));
        expect(fresh.csrfToken).not.toBe(current.csrfToken);
        const freshSpace = await selectedSpace(demo, freshCookie);
        expect(freshSpace).not.toBe(originalSpace);
        const replacement = await documents(demo, freshCookie, family.count);
        expect(
          replacement.every(
            ({ scope }) => scope.spaceId === freshSpace && scope.budgetId !== originalBudget,
          ),
        ).toBe(true);
        expect(
          replacement.every(({ id }) => original.every((document) => document.id !== id)),
        ).toBe(true);
        expect(
          replacement.map(({ connectorId, sourceId }) => [connectorId, sourceId]).sort(),
        ).toEqual(original.map(({ connectorId, sourceId }) => [connectorId, sourceId]).sort());
        expect(await documents(demo, freshCookie, family.count)).toEqual(replacement);

        const staleControl = await control(demo, '/__demo/persona', originalCookie, current, {
          personaId: 'restricted',
        });
        expect(staleControl.status).toBe(409);
        const staleEntry = await api(
          demo,
          `/__demo/entry?generation=${current.generation}`,
          originalCookie,
        );
        expect(staleEntry.status).toBe(409);
        // Missing old documents stay unavailable under the fresh actor's real grants.
        for (const document of original) {
          const oldSource = await api(
            demo,
            `/api/evidence/${encodeURIComponent(document.id)}`,
            freshCookie,
          );
          expect(oldSource.status).toBe(200);
          expect(await oldSource.json()).toMatchObject({ result: { document: null } });
        }

        const proof = await control(demo, '/__demo/reauth', freshCookie, fresh);
        expect(proof.status).toBe(200);
        freshCookie = mergeCookies(freshCookie, cookieHeader(proof));
        const staleHeaders = { 'x-balanceframe-space': originalSpace };
        const staleRead = await api(
          demo,
          '/api/evidence',
          freshCookie,
          'GET',
          undefined,
          staleHeaders,
        );
        expect(staleRead.status).toBe(403);
        const staleWrite = await api(demo, '/api/evidence', freshCookie, 'POST', {}, staleHeaders);
        expect(staleWrite.status).toBe(403);
        const foreignWrite = await api(demo, family.foreignWrite, freshCookie, 'POST', {});
        expect(foreignWrite.status).toBe(403);
        expect(await documents(demo, freshCookie, family.count)).toEqual(replacement);

        const switched = await control(demo, '/__demo/persona', freshCookie, fresh, {
          personaId: 'restricted',
        });
        expect(switched.status).toBe(200);
        const restrictedCookie = mergeCookies(freshCookie, cookieHeader(switched));
        expect(await state(demo, restrictedCookie)).toMatchObject({
          personaId: 'restricted',
          generation: fresh.generation,
        });
        expect(await selectedSpace(demo, restrictedCookie)).toBe(freshSpace);
        const denied = await api(
          demo,
          `/api/evidence/${encodeURIComponent(replacement[0]!.id)}`,
          restrictedCookie,
        );
        expect(denied.status).toBe(403);
        expect(await denied.json()).not.toHaveProperty('result.document');
      } finally {
        await stopDemoServer(demo);
      }
    }, 300_000);
  }
});
