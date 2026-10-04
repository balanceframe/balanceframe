import { afterAll, describe, expect, it, vi } from 'vitest';

import { startDemoServer, stopDemoServer, type DemoServer } from '../src/demo-server.js';

let demo: DemoServer | undefined;

type DemoState = {
  status: 'loading' | 'ready' | 'failed';
  scenarioId: string;
  generation: number;
  shared: true;
  csrfToken: string | null;
  personaId: string | null;
  personaIds: string[];
  failureCode?: string;
};

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

async function state(cookie = ''): Promise<DemoState> {
  if (!demo) throw new Error('Demo server has not started');
  const response = await fetch(`${demo.url}/__demo/state`, {
    headers: cookie ? { cookie } : {},
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<DemoState>;
}

async function control(
  path: string,
  cookie: string,
  csrfToken: string,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  if (!demo) throw new Error('Demo server has not started');
  return fetch(`${demo.url}${path}`, {
    method: 'POST',
    headers: {
      origin: origin ?? demo.url,
      cookie,
      'content-type': 'application/json',
      'x-balanceframe-demo-csrf': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

describe('owned demo supervisor', () => {
  afterAll(async () => {
    if (demo) await stopDemoServer(demo);
  });

  it('serves the full catalog, requires a signed control and origin, and rotates workspace on reset', async () => {
    demo = await startDemoServer({ scenarioId: 'funded-purchase', port: 0 });
    const catalogResponse = await fetch(`${demo.url}/__demo/catalog`);
    const catalog = (await catalogResponse.json()) as { scenarios: { id: string }[] };
    expect(catalogResponse.status).toBe(200);
    expect(catalog.scenarios).toHaveLength(29);
    expect(catalog.scenarios.map((entry) => entry.id)).toContain('coapproval-completion');

    const page = await fetch(`${demo.url}/demo`);
    expect(page.status).toBe(200);
    const cookie = cookieHeader(page);
    expect(cookie).toContain('bf_demo=');
    const catalogRead = await fetch(`${demo.url}/api/liquidity/spendability`, {
      headers: { cookie },
    });
    expect(catalogRead.status).toBe(200);
    const current = await state(cookie);
    expect(current).toMatchObject({
      status: 'ready',
      scenarioId: 'funded-purchase',
      shared: true,
      personaId: 'owner',
      personaIds: ['owner'],
    });
    expect(current.csrfToken).toEqual(expect.any(String));

    const forged = await control(
      '/__demo/reset',
      cookie,
      current.csrfToken!,
      {
        expectedGeneration: current.generation,
      },
      'https://attacker.example',
    );
    expect(forged.status).toBe(403);
    expect((await state(cookie)).generation).toBe(current.generation);
    const missingCsrf = await fetch(`${demo.url}/__demo/reset`, {
      method: 'POST',
      headers: { origin: demo.url, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedGeneration: current.generation }),
    });
    expect(missingCsrf.status).toBe(403);

    const missingOrigin = await fetch(`${demo.url}/__demo/reset`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-balanceframe-demo-csrf': current.csrfToken!,
      },
      body: JSON.stringify({ expectedGeneration: current.generation }),
    });
    expect(missingOrigin.status).toBe(403);
    expect(
      (
        await control(
          '/__demo/reset',
          cookie,
          current.csrfToken!,
          {
            expectedGeneration: current.generation,
          },
          'null',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await control('/__demo/load', cookie, current.csrfToken!, {
          expectedGeneration: current.generation,
          scenarioId: '/tmp/foreign-budget',
        })
      ).status,
    ).toBe(400);

    const reset = await control('/__demo/reset', cookie, current.csrfToken!, {
      expectedGeneration: current.generation,
    });
    expect(reset.status).toBe(200);
    const fresh = await state(cookieHeader(reset));
    expect(fresh).toMatchObject({
      status: 'ready',
      scenarioId: 'funded-purchase',
      generation: current.generation + 1,
    });
    expect(fresh.csrfToken).toEqual(expect.any(String));
    expect(fresh.csrfToken).not.toBe(current.csrfToken);

    const stale = await control('/__demo/event', cookie, current.csrfToken!, {
      expectedGeneration: current.generation,
      eventId: 'import-match',
    });
    expect(stale.status).toBe(409);
    const staleEntry = await fetch(`${demo.url}/__demo/entry?generation=${current.generation}`, {
      headers: { cookie },
    });
    expect(staleEntry.status).toBe(409);
    const stalePersona = await control('/__demo/persona', cookie, current.csrfToken!, {
      expectedGeneration: current.generation,
      personaId: 'owner',
    });
    expect(stalePersona.status).toBe(409);

    const anonymousEntry = await fetch(`${demo.url}/__demo/entry?generation=${fresh.generation}`);
    expect(anonymousEntry.status).toBe(401);
    const blockedAuth = await fetch(`${demo.url}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        origin: demo.url,
        cookie: cookieHeader(reset),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'attacker@example.test', password: 'ignored' }),
    });
    expect(blockedAuth.status).toBe(403);
    expect(await blockedAuth.json()).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
    for (const path of ['/api/auth/api-key/create', '/api/invitations']) {
      const blocked = await fetch(`${demo.url}${path}`, {
        method: 'POST',
        headers: {
          origin: demo.url,
          cookie: cookieHeader(reset),
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(blocked.status).toBe(403);
    }

    const blockedConnection = await fetch(`${demo.url}/api/connection`, {
      method: 'POST',
      headers: {
        origin: demo.url,
        cookie: cookieHeader(reset),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(blockedConnection.status).toBe(403);
    const blockedReview = await fetch(`${demo.url}/api/review/seed`, {
      method: 'POST',
      headers: {
        origin: demo.url,
        cookie: cookieHeader(reset),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(blockedReview.status).toBe(403);
    const signOut = await fetch(`${demo.url}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        origin: demo.url,
        cookie: cookieHeader(reset),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(signOut.status).toBe(200);
    const reentry = await fetch(`${demo.url}/demo`, { headers: { cookie: cookieHeader(reset) } });
    expect(reentry.status).toBe(200);
    const restoredRead = await fetch(`${demo.url}/api/liquidity/spendability`, {
      headers: { cookie: cookieHeader(reentry) },
    });
    expect(restoredRead.status).toBe(200);
    const tooSoon = await control('/__demo/reset', cookieHeader(reset), fresh.csrfToken!, {
      expectedGeneration: fresh.generation,
    });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers.get('retry-after')).toEqual(expect.any(String));
  }, 180_000);

  it('requires an explicit generation-guarded browser proof before scoped persona approval', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'coapproval-completion', port: 0 });
    try {
      const page = await fetch(`${demo.url}/demo`);
      const ownerCookie = cookieHeader(page);
      const ownerState = await state(ownerCookie);
      expect(ownerState.status, ownerState.failureCode).toBe('ready');
      expect(ownerState.personaId).toBe('owner');
      const entry = await fetch(`${demo.url}/__demo/entry?generation=${ownerState.generation}`, {
        headers: { cookie: ownerCookie },
      });
      const entryBody = await entry.json() as { path: string };
      expect(entry.status, JSON.stringify(entryBody)).toBe(200);
      expect(entryBody.path).toMatch(/^\/spend-sessions\/[^/]+\/completions\/[^/]+$/);
      const switched = await control('/__demo/persona', ownerCookie, ownerState.csrfToken!, {
        expectedGeneration: ownerState.generation, personaId: 'coapprover',
      });
      expect(switched.status).toBe(200);
      const peerCookie = cookieHeader(switched);
      const peerState = await state(peerCookie);
      const proposal = await fetch(`${demo.url}/api${entryBody.path}`, { headers: { cookie: peerCookie } });
      expect(proposal.status).toBe(200);
      const detail = await proposal.json() as {
        result: { payloadHash: string; version: number; phase: string; canApprove: boolean };
      };
      const approvalBody = JSON.stringify({
        payloadHash: detail.result.payloadHash,
        expectedVersion: detail.result.version,
        idempotencyKey: 'demo-explicit-human-approval',
      });
      const unproved = await fetch(`${demo.url}/api${entryBody.path}/approve`, {
        method: 'POST',
        headers: { origin: demo.url, cookie: peerCookie, 'content-type': 'application/json' },
        body: approvalBody,
      });
      expect(unproved.status).toBe(403);
      expect(await unproved.json()).toMatchObject({ error: { code: 'REAUTHENTICATION_REQUIRED' } });
      const mismatchedCookies = new Map(peerCookie.split('; ').map((pair) => {
        const separator = pair.indexOf('=');
        return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
      }));
      const ownerControl = ownerCookie.split('; ').find((pair) => pair.startsWith('bf_demo='));
      if (!ownerControl) throw new Error('Owner signed demo control was not issued');
      mismatchedCookies.set('bf_demo', ownerControl.slice('bf_demo='.length));
      const wrongIdentity = await control(
        '/__demo/reauth',
        [...mismatchedCookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ownerState.csrfToken!,
        { expectedGeneration: ownerState.generation },
      );
      expect(wrongIdentity.status).toBe(401);
      expect(wrongIdentity.headers.get('set-cookie')).toBeNull();
      const rejected = await control('/__demo/reauth', peerCookie, 'wrong-csrf', {
        expectedGeneration: peerState.generation,
      });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get('set-cookie')).toBeNull();
      mismatchedCookies.set('bf_demo', peerCookie.split('; ')
        .find((pair) => pair.startsWith('bf_demo='))!.slice('bf_demo='.length));
      mismatchedCookies.set('balanceframe_space', 'unavailable-space');
      const wrongSpace = await control(
        '/__demo/reauth',
        [...mismatchedCookies].map(([name, value]) => `${name}=${value}`).join('; '),
        peerState.csrfToken!,
        { expectedGeneration: peerState.generation },
      );
      expect(wrongSpace.status).toBe(403);
      expect(wrongSpace.headers.get('set-cookie')).toBeNull();
      const renewed = await control('/__demo/reauth', peerCookie, peerState.csrfToken!, {
        expectedGeneration: peerState.generation,
      });
      expect(renewed.status).toBe(200);
      expect(await renewed.json()).toEqual({ generation: peerState.generation, reauthenticated: true });
      expect(renewed.headers.getSetCookie()).toHaveLength(1);
      const cookies = new Map([...peerCookie.split('; '), cookieHeader(renewed)].map((pair) => {
        const separator = pair.indexOf('=');
        return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
      }));
      const proved = await fetch(`${demo.url}/api${entryBody.path}/approve`, {
        method: 'POST',
        headers: {
          origin: demo.url,
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          'content-type': 'application/json',
        },
        body: approvalBody,
      });
      expect(proved.status).toBe(200);
      const provedBody = await proved.json();
      expect(provedBody).toMatchObject({ result: { approvalCount: 1, canExecute: false } });
      const stale = await control('/__demo/reauth', peerCookie, peerState.csrfToken!, {
        expectedGeneration: peerState.generation - 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.headers.get('set-cookie')).toBeNull();
    } finally {
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);

  it('does not relay a stale persona session when a shared reset races sign-in', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'coapproval-completion', port: 0 });
    let releaseSignIn = () => {};
    try {
      const page = await fetch(`${demo.url}/demo`);
      const cookie = cookieHeader(page);
      const current = await state(cookie);
      expect(current).toMatchObject({
        status: 'ready',
        personaIds: ['owner', 'coapprover', 'restricted', 'approver'],
      });
      const baselineSwitch = await control('/__demo/persona', cookie, current.csrfToken!, {
        expectedGeneration: current.generation,
        personaId: 'coapprover',
      });
      expect(baselineSwitch.status).toBe(200);

      let reachedSignIn!: () => void;
      const signInReached = new Promise<void>((resolve) => {
        reachedSignIn = resolve;
      });
      const signInReleased = new Promise<void>((resolve) => {
        releaseSignIn = resolve;
      });
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const result = await realFetch(input, init);
        if (String(input).endsWith('/api/auth/get-session')) {
          reachedSignIn();
          await signInReleased;
        }
        return result;
      });
      const changingPersona = control('/__demo/persona', cookie, current.csrfToken!, {
        expectedGeneration: current.generation,
        personaId: 'coapprover',
      });
      await Promise.race([
        signInReached,
        changingPersona.then((response) => {
          throw new Error(`Persona request returned ${response.status} before authentication`);
        }),
      ]);
      const resetting = control('/__demo/load', cookie, current.csrfToken!, {
        expectedGeneration: current.generation,
        scenarioId: 'funded-purchase',
      });
      try {
        const deadline = Date.now() + 10_000;
        while ((await state(cookie)).status !== 'loading') {
          if (Date.now() > deadline)
            throw new Error('Shared reset did not begin while persona sign-in was pending');
        }
        releaseSignIn();
        const stalePersona = await changingPersona;
        expect(stalePersona.status).toBe(409);
        expect(stalePersona.headers.get('set-cookie')).toBeNull();
        expect((await resetting).status).toBe(200);
        const fresh = await state(cookie);
        expect(fresh).toMatchObject({
          scenarioId: 'funded-purchase',
          generation: current.generation + 1,
        });
        expect(fresh.csrfToken).toBeNull();
      } finally {
        releaseSignIn();
        await Promise.allSettled([changingPersona, resetting]);
      }
    } finally {
      vi.restoreAllMocks();
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);

  it('withholds browser auto-sign-in cookies when a reset begins during session lookup', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'funded-purchase', port: 0 });
    let releaseSession = () => {};
    try {
      const page = await fetch(`${demo.url}/demo`);
      const cookie = cookieHeader(page);
      const current = await state(cookie);
      expect(current.status).toBe('ready');

      let reachedSession!: () => void;
      const sessionReached = new Promise<void>((resolve) => {
        reachedSession = resolve;
      });
      const sessionReleased = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const result = await realFetch(input, init);
        if (String(input).endsWith('/api/auth/get-session')) {
          reachedSession();
          await sessionReleased;
        }
        return result;
      });
      const openingPage = fetch(`${demo.url}/demo`, { headers: { cookie } });
      await Promise.race([
        sessionReached,
        openingPage.then((response) => {
          throw new Error(`Demo page returned ${response.status} before session lookup`);
        }),
      ]);
      const resetting = control('/__demo/load', cookie, current.csrfToken!, {
        expectedGeneration: current.generation,
        scenarioId: 'rich-cart',
      });
      try {
        const deadline = Date.now() + 10_000;
        while ((await state(cookie)).status !== 'loading') {
          if (Date.now() > deadline)
            throw new Error('Shared reset did not begin while page session lookup was pending');
        }
        releaseSession();
        const stalePage = await openingPage;
        expect(stalePage.status).toBe(409);
        expect(stalePage.headers.get('set-cookie')).toBeNull();
        expect((await resetting).status).toBe(200);
      } finally {
        releaseSession();
        await Promise.allSettled([openingPage, resetting]);
      }
    } finally {
      vi.restoreAllMocks();
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);
  it('withholds a renewed browser proof when reset races Source password verification', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'funded-purchase', port: 0 });
    let releaseProof = () => {};
    try {
      const page = await fetch(`${demo.url}/demo`);
      const cookie = cookieHeader(page);
      const current = await state(cookie);
      expect(current.status).toBe('ready');
      let reachedProof!: () => void;
      const proofReached = new Promise<void>((resolve) => { reachedProof = resolve; });
      const proofReleased = new Promise<void>((resolve) => { releaseProof = resolve; });
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const result = await realFetch(input, init);
        if (String(input).endsWith('/api/reauth')) {
          reachedProof();
          await proofReleased;
        }
        return result;
      });
      const renewing = control('/__demo/reauth', cookie, current.csrfToken!, {
        expectedGeneration: current.generation,
      });
      await Promise.race([
        proofReached,
        renewing.then((response) => {
          throw new Error(`Proof request returned ${response.status} before Source verification`);
        }),
      ]);
      const resetting = control('/__demo/load', cookie, current.csrfToken!, {
        expectedGeneration: current.generation, scenarioId: 'rich-cart',
      });
      try {
        const deadline = Date.now() + 10_000;
        while ((await state(cookie)).status !== 'loading') {
          if (Date.now() > deadline) throw new Error('Reset did not begin while Source proof was pending');
        }
        releaseProof();
        const staleProof = await renewing;
        expect(staleProof.status).toBe(409);
        expect(staleProof.headers.get('set-cookie')).toBeNull();
        expect((await resetting).status).toBe(200);
      } finally {
        releaseProof();
        await Promise.allSettled([renewing, resetting]);
      }
    } finally {
      vi.restoreAllMocks();
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);
});
