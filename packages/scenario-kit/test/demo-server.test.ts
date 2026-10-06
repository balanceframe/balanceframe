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

function mergeCookies(...values: string[]): string {
  const cookies = new Map<string, string>();
  for (const pair of values.flatMap((value) => value.split('; '))) {
    const separator = pair.indexOf('=');
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function api(path: string, cookie: string, method = 'GET', body?: Record<string, unknown>, extraHeaders: Record<string, string> = {}, timeoutMs = 10_000): Promise<Response> {
  if (!demo) throw new Error('Demo server has not started');
  return fetch(`${demo.url}${path}`, {
    method,
    headers: { cookie, origin: demo.url, ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function selectedSpace(cookie: string): Promise<string> {
  const response = await api('/api/spaces', cookie);
  expect(response.status).toBe(200);
  const result = await response.json() as { result: { selectedSpaceId: string; spaces: { id: string }[] } };
  expect(result.result.spaces.map((space) => space.id)).toContain(result.result.selectedSpaceId);
  return result.result.selectedSpaceId;
}

async function prove(cookie: string, current: DemoState): Promise<string> {
  const proof = await control('/__demo/reauth', cookie, current.csrfToken!, { expectedGeneration: current.generation });
  expect(proof.status).toBe(200);
  return mergeCookies(cookie, cookieHeader(proof));
}

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
  timeoutMs = 180_000,
): Promise<Response> {
  if (!demo) throw new Error('Demo server has not started');
  return fetch(`${demo.url}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
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
    expect(catalog.scenarios.map((entry) => entry.id)).toContain('funded-purchase');
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
    // Exercise the cooldown immediately; later proxy calls may outlive its ten-second window.
    const tooSoon = await control('/__demo/reset', cookieHeader(reset), fresh.csrfToken!, {
      expectedGeneration: fresh.generation,
    });
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.headers.get('retry-after')).toEqual(expect.any(String));
    expect(tooSoon.headers.get('set-cookie')).toBeNull();
    expect(await state(cookieHeader(reset))).toMatchObject({
      status: 'ready',
      scenarioId: fresh.scenarioId,
      generation: fresh.generation,
    });


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

  it('uses the real limited human session, enforces fresh grant proof and rejects other-space or forged writes', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'governance-scoped-access', port: 0 });
    try {
      const page = await fetch(`${demo.url}/demo`);
      let ownerCookie = cookieHeader(page);
      const current = await state(ownerCookie);
      expect(current).toMatchObject({ status: 'ready', personaIds: ['owner', 'limited'] });
      const spaceId = await selectedSpace(ownerCookie);
      const entry = await api(`/__demo/entry?generation=${current.generation}`, ownerCookie);
      expect(await entry.json()).toMatchObject({ generation: current.generation, path: '/spaces' });
      const membershipsResponse = await api(`/api/spaces/${spaceId}/memberships`, ownerCookie);
      expect(membershipsResponse.status).toBe(200);
      const memberships = await membershipsResponse.json() as {
        result: { memberships: { id: string; actorId: string; revokedAt: string | null }[] };
      };
      const switched = await control('/__demo/persona', ownerCookie, current.csrfToken!, {
        expectedGeneration: current.generation, personaId: 'limited',
      });
      expect(switched.status).toBe(200);
      const limitedCookie = cookieHeader(switched);
      const session = await api('/api/auth/get-session', limitedCookie);
      expect(session.status).toBe(200);
      const identity = await session.json() as { user: { id: string } };
      const selectedMembershipResponse = await api(`/api/spaces/${spaceId}`, limitedCookie);
      expect(selectedMembershipResponse.status).toBe(200);
      const selectedMembership = await selectedMembershipResponse.json() as {
        result: { space: { membership: { id: string; actorId: string; revokedAt: string | null } } };
      };
      expect(selectedMembership.result.space.membership).toMatchObject({
        actorId: identity.user.id, revokedAt: null,
      });
      const limitedMembership = memberships.result.memberships.find((member) =>
        member.id === selectedMembership.result.space.membership.id && member.actorId === identity.user.id)!;
      expect(limitedMembership).toBeDefined();
      const grantsResponse = await api(`/api/spaces/${spaceId}/grants`, ownerCookie);
      expect(grantsResponse.status).toBe(200);
      const grants = await grantsResponse.json() as { result: { grants: { membershipId: string; resourceKind: string; resourceId: string; capability: string; granted: boolean }[] } };
      const limitedGrants = grants.result.grants.filter((grant) => grant.membershipId === limitedMembership.id && grant.granted);
      expect(limitedGrants.map((grant) => grant.capability).sort()).toEqual(['existence', 'name']);
      expect(new Set(limitedGrants.map((grant) => grant.resourceId)).size).toBe(1);
      const accountId = limitedGrants[0]!.resourceId;
      const mutation = { membershipId: limitedMembership.id, resourceKind: 'account', resourceId: accountId, capability: 'name', granted: false };
      const unproved = await api(`/api/spaces/${spaceId}/grants`, ownerCookie, 'PUT', mutation);
      expect(unproved.status).toBe(403);
      expect(await unproved.json()).toMatchObject({ error: { code: 'REAUTHENTICATION_REQUIRED' } });
      const forbidden = await api('/api/merchant', limitedCookie);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.text()).not.toContain('minorUnits');
      const limitedWrite = await api(`/api/spaces/${spaceId}/grants`, limitedCookie, 'PUT', mutation);
      expect(limitedWrite.status).toBe(403);
      const forgedActor = await api(`/api/spaces/${spaceId}/grants`, limitedCookie, 'PUT', mutation, {
        'x-balanceframe-actor': memberships.result.memberships.find((member) => member.actorId !== identity.user.id)!.actorId,
        'x-balanceframe-capability': 'grant:manage',
        'x-balanceframe-membership': limitedMembership.id,
      });
      expect(forgedActor.status).toBe(403);
      ownerCookie = await prove(ownerCookie, current);
      for (const [path, method, headers] of [
        [`/api/spaces/unrelated-space/grants`, 'PUT', {}],
        [`/api/spaces/${spaceId}/grants`, 'POST', {}],
        [`/api/spaces/${spaceId}/grants`, 'PUT', { 'x-balanceframe-space': 'unrelated-space' }],
        [`/api/spaces/${spaceId}/grants`, 'PUT', { origin: 'https://attacker.example', 'x-forwarded-host': new URL(demo.url).host }],
        [`/api/spaces/${spaceId}/grants`, 'PUT', { 'x-balanceframe-demo-internal': 'forged-secret' }],
      ] as const) {
        const denied = await api(path, ownerCookie, method, mutation, headers);
        expect(denied.status).toBe(403);
      }
      const unchangedGrantsResponse = await api(`/api/spaces/${spaceId}/grants`, ownerCookie);
      expect(unchangedGrantsResponse.status).toBe(200);
      const unchangedGrants = await unchangedGrantsResponse.json() as typeof grants;
      expect(unchangedGrants.result.grants).toEqual(grants.result.grants);
      const revoked = await api(`/api/spaces/${spaceId}/grants`, ownerCookie, 'PUT', mutation);
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ status: 'ok' });
      const after = await api(`/api/spaces/${spaceId}/grants`, ownerCookie);
      const afterBody = await after.json() as { result: { grants: { membershipId: string; resourceId: string; capability: string; granted: boolean }[] } };
      expect(afterBody.result.grants.some((grant) => grant.membershipId === limitedMembership.id &&
        grant.resourceId === accountId && grant.capability === 'name' && grant.granted)).toBe(false);
    } finally {
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);

  it('publishes an invitee only after real redemption, retains old membership and never inherits its grant on rejoin', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'governance-invitation-lifecycle', port: 0 });
    try {
      const page = await fetch(`${demo.url}/demo`);
      let ownerCookie = cookieHeader(page);
      const current = await state(ownerCookie);
      expect(current).toMatchObject({ status: 'ready', personaIds: ['owner'] });
      const spaceId = await selectedSpace(ownerCookie);
      ownerCookie = await prove(ownerCookie, current);
      const pending = await api('/api/invitations', ownerCookie);
      expect(pending.status).toBe(200);
      const pendingBody = await pending.json() as { result: { items: { status: string; claimedEmail: string | null; redeemedUserId: string | null; redeemedAt: string | null }[]; count: number } };
      expect(pendingBody.result).toMatchObject({
        count: 1, items: [{ status: 'active', claimedEmail: null, redeemedUserId: null, redeemedAt: null }],
      });
      expect(JSON.stringify(pendingBody)).not.toMatch(/"token"|"password"|"cookieHeader"|"apiKey"/);
      const notYetHuman = await control('/__demo/persona', ownerCookie, current.csrfToken!, {
        expectedGeneration: current.generation, personaId: 'invitee',
      });
      expect(notYetHuman.status).toBe(400);
      expect(notYetHuman.headers.get('set-cookie')).toBeNull();
      const redeem = await control('/__demo/event', ownerCookie, current.csrfToken!, {
        expectedGeneration: current.generation, eventId: 'invite-redeem',
      });
      expect(redeem.status).toBe(200);
      expect(await redeem.text()).not.toMatch(/"token"|"password"|"cookieHeader"|"apiKey"/);
      expect((await state(ownerCookie)).personaIds).toEqual(['owner', 'invitee']);
      const switched = await control('/__demo/persona', ownerCookie, current.csrfToken!, {
        expectedGeneration: current.generation, personaId: 'invitee',
      });
      expect(switched.status).toBe(200);
      const inviteeCookie = cookieHeader(switched);
      const identity = await (await api('/api/auth/get-session', inviteeCookie)).json() as { user: { id: string } };
      const members = await (await api(`/api/spaces/${spaceId}/memberships`, ownerCookie)).json() as {
        result: { memberships: { id: string; actorId: string; revokedAt: string | null }[] };
      };
      const selectedMembershipResponse = await api(`/api/spaces/${spaceId}`, inviteeCookie);
      expect(selectedMembershipResponse.status).toBe(200);
      const selectedMembership = await selectedMembershipResponse.json() as {
        result: { space: { membership: { id: string; actorId: string; revokedAt: string | null } } };
      };
      const oldMember = members.result.memberships.find((member) =>
        member.id === selectedMembership.result.space.membership.id && member.actorId === identity.user.id)!;
      expect(oldMember).toMatchObject({ actorId: identity.user.id, revokedAt: null });
      ownerCookie = await prove(ownerCookie, current);
      const priorGrants = await (await api(`/api/spaces/${spaceId}/grants`, ownerCookie)).json() as {
        result: { grants: { resourceKind: string; resourceId: string; capability: string; granted: boolean }[] };
      };
      const accountId = priorGrants.result.grants.find((record) => record.resourceKind === 'account' && record.capability === 'name' && record.granted)!.resourceId;
      const grant = { membershipId: oldMember.id, resourceKind: 'account', resourceId: accountId, capability: 'name', granted: true };
      const granted = await api(`/api/spaces/${spaceId}/grants`, ownerCookie, 'PUT', grant);
      expect(granted.status).toBe(200);
      expect(await granted.json()).toMatchObject({ result: { grant } });
      const revoked = await control('/__demo/event', ownerCookie, current.csrfToken!, { expectedGeneration: current.generation, eventId: 'invite-revoke' });
      expect(revoked.status).toBe(200);
      expect((await state(ownerCookie)).personaIds).toEqual(['owner']);
      const revokedCookieAccess = await api(`/api/spaces/${spaceId}`, inviteeCookie);
      expect(revokedCookieAccess.ok).toBe(false);
      expect(await revokedCookieAccess.json()).toMatchObject({ status: 'error', result: null });
      const rejoined = await control('/__demo/event', ownerCookie, current.csrfToken!, { expectedGeneration: current.generation, eventId: 'invite-rejoin' });
      expect(rejoined.status).toBe(200);
      expect((await state(ownerCookie)).personaIds).toEqual(['owner', 'invitee']);
      const history = await (await api(`/api/spaces/${spaceId}/memberships`, ownerCookie)).json() as {
        result: { memberships: { id: string; actorId: string; revokedAt: string | null }[] };
      };
      const retained = history.result.memberships.filter((member) => member.actorId === identity.user.id);
      expect(retained).toEqual(expect.arrayContaining([expect.objectContaining({ id: oldMember.id, revokedAt: expect.any(String) })]));
      const freshSwitch = await control('/__demo/persona', ownerCookie, current.csrfToken!, {
        expectedGeneration: current.generation, personaId: 'invitee',
      });
      expect(freshSwitch.status).toBe(200);
      const freshMembershipResponse = await api(`/api/spaces/${spaceId}`, cookieHeader(freshSwitch));
      expect(freshMembershipResponse.status).toBe(200);
      const freshMembership = await freshMembershipResponse.json() as {
        result: { space: { membership: { id: string; actorId: string; revokedAt: string | null } } };
      };
      expect(freshMembership.result.space.membership).toMatchObject({
        actorId: identity.user.id, revokedAt: null,
      });
      const freshMember = retained.find((member) =>
        member.id === freshMembership.result.space.membership.id && member.actorId === identity.user.id)!;
      expect(freshMember).toBeDefined();
      expect(freshMember.id).not.toBe(oldMember.id);
      expect(freshMember.revokedAt).toBeNull();
      const grants = await (await api(`/api/spaces/${spaceId}/grants`, ownerCookie)).json() as {
        result: { grants: { membershipId: string; resourceId: string; granted: boolean }[] };
      };
      expect(grants.result.grants.filter((record) => record.membershipId === freshMember.id && record.resourceId === grant.resourceId && record.granted)).toEqual([]);
      const publicOutputs = JSON.stringify(await state(ownerCookie)) + await (await fetch(`${demo.url}/__demo/catalog`)).text();
      expect(publicOutputs).not.toMatch(/"token"|"password"|"cookieHeader"|"apiKey"|"internalSecret"|"actorId"|"membershipId"/);
    } finally {
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);

  it.each(['research-release', 'research-cancel', 'reset'] as const)(
    'settles held real research without draining its own HTTP request during %s',
    async (action) => {
      const previous = demo;
      demo = await startDemoServer({ scenarioId: 'merchant-research-lifecycle', port: 0 });
      let first: Promise<Response> | undefined;
      let duplicate: Promise<Response> | undefined;
      try {
        const page = await fetch(`${demo.url}/demo`);
        const cookie = cookieHeader(page);
        const current = await state(cookie);
        expect(current.status, current.failureCode).toBe('ready');
        const analyzed = await api('/api/merchant', cookie);
        expect(analyzed.status).toBe(200);
        const analysis = await analyzed.json() as {
          result: { suggestions: { evidenceKey: string; evidenceRevision: string }[] };
        };
        const target = analysis.result.suggestions.find((suggestion) => suggestion.evidenceKey.startsWith('merchant:transaction:'))!;
        expect(target).toBeDefined();
        const query = {
          evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision,
          merchant: 'Aster Atelier', locale: null, publicBusiness: true,
        };
        const unauthenticated = await api('/api/merchant/research/preview', '', 'POST', query);
        expect(unauthenticated.ok).toBe(false);
        expect(await unauthenticated.json()).toMatchObject({
          status: 'error', result: null,
          error: { reasonCodes: expect.arrayContaining([expect.stringMatching(/^auth\./)]) },
        });
        const entry = await api(`/__demo/entry?generation=${current.generation}`, cookie);
        expect(await entry.json()).toMatchObject({ generation: current.generation, path: '/review' });
        const preview = await api('/api/merchant/research/preview', cookie, 'POST', query);
        expect(preview.status).toBe(200);
        const previewBody = await preview.json() as {
          result: { status: string; previewToken: string; fieldsSent: string[]; providerVersion: string };
        };
        expect(previewBody.result).toMatchObject({ status: 'ready', fieldsSent: ['merchant', 'locale'] });
        expect(previewBody.result.providerVersion).toMatch(/fixture/);
        const request = { ...query, previewToken: previewBody.result.previewToken, consent: true, idempotencyKey: 'demo-held-research' };
        const withoutConsent = await api('/api/merchant/research', cookie, 'POST', { ...request, consent: false });
        expect(await withoutConsent.json()).toMatchObject({ result: { status: 'denied', code: 'invalid_request', billing: 'not_dispatched' } });
        first = api('/api/merchant/research', cookie, 'POST', request, {}, 120_000);
        duplicate = api('/api/merchant/research', cookie, 'POST', request, {}, 120_000);
        const pending = await Promise.race([first, duplicate]);
        expect(pending.status).toBe(200);
        expect(await pending.clone().json()).toMatchObject({ result: { status: 'pending' } });
        const controlOnly = cookie.split('; ').find((pair) => pair.startsWith('bf_demo='))!;
        const wrongActor = await control('/__demo/event', controlOnly, current.csrfToken!, {
          expectedGeneration: current.generation, eventId: 'research-release',
        }, undefined, 5_000);
        expect(wrongActor.status).toBe(401);
        expect(wrongActor.headers.get('set-cookie')).toBeNull();

        for (const [generation, csrfToken, origin, expectedStatus] of [
          [current.generation - 1, current.csrfToken!, demo.url, 409],
          [current.generation, 'forged-csrf', demo.url, 403],
          [current.generation, current.csrfToken!, 'https://attacker.example', 403],
          [current.generation, '', demo.url, 403],
          [current.generation, current.csrfToken!, '', 403],
          [current.generation, current.csrfToken!, 'null', 403],
        ] as const) {
          const denied = await control('/__demo/event', cookie, csrfToken, {
            expectedGeneration: generation, eventId: 'research-release',
          }, origin, 5_000);
          expect(denied.status).toBe(expectedStatus);
          expect(denied.headers.get('set-cookie')).toBeNull();
        }
        const result = action === 'reset'
          ? await control('/__demo/reset', cookie, current.csrfToken!, { expectedGeneration: current.generation }, undefined, 90_000)
          : await control('/__demo/event', cookie, current.csrfToken!, {
            expectedGeneration: current.generation, eventId: action,
          }, undefined, 5_000);
        expect(result.status).toBe(200);
        const responses = await Promise.all([first, duplicate]);
        const held = responses.find((response) => response !== pending)!;
        const heldBody = await held.json() as { result?: { status: string; enrichment?: { sources: { url: string }[] } } };
        if (action === 'research-release') {
          expect(held.status).toBe(200);
          expect(heldBody.result?.status).toBe('succeeded');
          expect(heldBody.result?.enrichment?.sources.every((source) => new URL(source.url).hostname.endsWith('.invalid'))).toBe(true);
          const cached = await api('/api/merchant/research/cache', cookie, 'POST', query);
          expect(await cached.json()).toMatchObject({ result: { enrichment: heldBody.result?.enrichment } });
        } else {
          expect(heldBody.result?.status).not.toBe('succeeded');
          expect(heldBody.result?.enrichment).toBeUndefined();
          expect(held.headers.get('set-cookie')).toBeNull();
        }
        if (action === 'reset') {
          const freshCookie = cookieHeader(result);
          const fresh = await state(freshCookie);
          expect(fresh).toMatchObject({ status: 'ready', generation: current.generation + 1, personaId: 'owner' });
          const staleRelease = await control('/__demo/event', cookie, current.csrfToken!, {
            expectedGeneration: current.generation, eventId: 'research-release',
          }, undefined, 5_000);
          expect(staleRelease.status).toBe(409);
          expect(staleRelease.headers.get('set-cookie')).toBeNull();
          expect((await state(freshCookie)).generation).toBe(fresh.generation);
        }
      } finally {
        // Bounded browser requests settle even if the old draining control deadlocks.
        await Promise.allSettled([first, duplicate].filter((request): request is Promise<Response> => request !== undefined));
        await stopDemoServer(demo);
        demo = previous;
      }
    },
    240_000,
  );
  it.each([
    ['merchant-local-sparse', '/review'],
    ['merchant-local-insufficient', '/review'],
    ['merchant-native-rule-lifecycle', '/rules'],
  ])('admits real review synchronization and page entry only for %s', async (scenarioId, path) => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId, port: 0 });
    try {
      const page = await fetch(`${demo.url}/demo`);
      const cookie = cookieHeader(page);
      const current = await state(cookie);
      expect(current.status, current.failureCode).toBe('ready');
      const entry = await api(`/__demo/entry?generation=${current.generation}`, cookie);
      expect(await entry.json()).toMatchObject({ generation: current.generation, path });
      const reviewBefore = await api('/api/review', cookie);
      expect(reviewBefore.status).toBe(200);
      const beforeSnapshot = await reviewBefore.json() as { result: { items: unknown[]; total: number } };
      expect(beforeSnapshot.result.total).toBe(beforeSnapshot.result.items.length);
      // Anonymous API auth may return a fail-closed 503 when no API-token fallback is configured.
      const unauthenticated = await api('/api/review/sync', '', 'POST', {});
      expect(unauthenticated.ok).toBe(false);
      expect(await unauthenticated.json()).toMatchObject({ status: 'error', result: null });
      const reviewAfter = await api('/api/review', cookie);
      expect(reviewAfter.status).toBe(200);
      const afterSnapshot = await reviewAfter.json() as { result: { items: unknown[]; total: number } };
      expect(afterSnapshot.result).toEqual(beforeSnapshot.result);
      const synced = await api('/api/review/sync', cookie, 'POST', {});
      expect(synced.status).toBe(200);
      expect(await synced.json()).toMatchObject({ status: 'ok', result: { synchronized: true, failed: 0 } });
      const queueAfterSyncResponse = await api('/api/review', cookie);
      expect(queueAfterSyncResponse.status).toBe(200);
      const queueAfterSync = await queueAfterSyncResponse.json() as {
        result: { items: { reviewItem: { id: string; transactionId: string } }[]; total: number };
      };
      expect(queueAfterSync.result.total).toBe(queueAfterSync.result.items.length);
      const repeated = await api('/api/review/sync', cookie, 'POST', {});
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ status: 'ok', result: { synchronized: true, failed: 0 } });
      const queueAfterRepeatResponse = await api('/api/review', cookie);
      expect(queueAfterRepeatResponse.status).toBe(200);
      const queueAfterRepeat = await queueAfterRepeatResponse.json() as typeof queueAfterSync;
      expect(queueAfterRepeat.result.total).toBe(queueAfterSync.result.total);
      expect(queueAfterRepeat.result.items.map(({ reviewItem }) => reviewItem))
        .toEqual(queueAfterSync.result.items.map(({ reviewItem }) => reviewItem));
      for (const [url, method, headers] of [
        ['/api/review/sync', 'PUT', {}],
        ['/api/review/sync', 'POST', { 'x-balanceframe-space': 'unrelated-space' }],
        ['/api/review/sync', 'POST', { 'x-balanceframe-demo-internal': 'forged-private-secret' }],
        ['/api/auth/api-key/create', 'POST', {}],
        ['/api/review/seed', 'POST', {}],
      ] as const) {
        const denied = await api(url, cookie, method, {}, headers);
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      }
    } finally {
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);

  it('supports shared assistant revocation without exposing its credential or offering it as a fictional human', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'governance-delegated-assistant', port: 0 });
    try {
      const page = await fetch(`${demo.url}/demo`);
      let cookie = cookieHeader(page);
      const current = await state(cookie);
      expect(current).toMatchObject({ status: 'ready', personaIds: ['owner'], personaId: 'owner' });
      const catalog = await fetch(`${demo.url}/__demo/catalog`);
      expect(JSON.stringify(current) + await catalog.text()).not.toMatch(/"apiKey"|"key"|"token"|"password"|"cookieHeader"|"internalSecret"|"actorId"|"membershipId"/);
      const assistant = await control('/__demo/persona', cookie, current.csrfToken!, {
        expectedGeneration: current.generation, personaId: 'assistant',
      });
      expect(assistant.status).toBe(400);
      expect(assistant.headers.get('set-cookie')).toBeNull();
      const wrongStory = await control('/__demo/event', cookie, current.csrfToken!, {
        expectedGeneration: current.generation, eventId: 'research-release',
      });
      expect(wrongStory.status).toBe(400);
      expect(wrongStory.headers.get('set-cookie')).toBeNull();
      for (const path of ['/api/auth/api-key/create', '/api/spaces/unrelated-space/delegations', '/api/connection']) {
        const denied = await api(path, cookie, 'POST', {});
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      }
      const spaceId = await selectedSpace(cookie);
      const delegationResponse = await api(`/api/spaces/${spaceId}/delegations`, cookie);
      expect(delegationResponse.status).toBe(200);
      const delegated = await delegationResponse.json() as {
        result: { delegations: { id: string; version: string; revokedAt: string | null; rights: { resourceKind: string; resourceId: string; capability: string }[] }[] };
      };
      expect(delegated.result.delegations).toHaveLength(1);
      const delegation = delegated.result.delegations[0]!;
      expect(delegation.revokedAt).toBeNull();
      const checking = delegation.rights.find((right) => right.resourceKind === 'account' && right.capability === 'name')!;
      expect(checking).toBeDefined();
      expect(delegation.rights.map(({ resourceKind, resourceId, capability }) => ({ resourceKind, resourceId, capability })).sort((left, right) => left.capability.localeCompare(right.capability))).toEqual([
        { resourceKind: 'account', resourceId: checking.resourceId, capability: 'existence' },
        { resourceKind: 'account', resourceId: checking.resourceId, capability: 'name' },
      ]);
      const credentialsResponse = await api(`/api/spaces/${spaceId}/credentials`, cookie);
      expect(credentialsResponse.status).toBe(200);
      const credentials = await credentialsResponse.json() as { result: { credentials: { credentialId: string; delegationId: string }[] } };
      expect(credentials.result.credentials).toHaveLength(1);
      expect(credentials.result.credentials[0]?.delegationId).toBe(delegation.id);
      const probe = await control('/__demo/event', cookie, current.csrfToken!, {
        expectedGeneration: current.generation, eventId: 'assistant-probe',
      });
      expect(probe.status).toBe(200);
      const allowedProbe: unknown = await probe.json();
      expect(allowedProbe).toMatchObject({
        generation: current.generation, eventId: 'assistant-probe',
        probe: {
          checking: { status: 200, resources: [{ resourceKind: 'account', resourceId: checking.resourceId }] },
          denials: [
            { operation: 'manage-grants', status: 403 },
            { operation: 'financial', status: 403 },
            { operation: 'full-history', status: 403 },
          ],
        },
      });
      cookie = await prove(cookie, current);
      const revoked = await control('/__demo/event', cookie, current.csrfToken!, {
        expectedGeneration: current.generation, eventId: 'assistant-revoke',
      });
      expect(revoked.status).toBe(200);
      const revokedBody: unknown = await revoked.json();
      expect(revokedBody).toEqual({ generation: current.generation, eventId: 'assistant-revoke' });
      const after = await api(`/api/spaces/${spaceId}/delegations`, cookie);
      expect(after.status).toBe(200);
      expect(await after.json()).toMatchObject({ result: { delegations: [{
        id: delegation.id, version: delegation.version, revokedAt: expect.any(String),
      }] } });
      const retainedCredentials = await api(`/api/spaces/${spaceId}/credentials`, cookie);
      expect(retainedCredentials.status).toBe(200);
      expect(await retainedCredentials.json()).toMatchObject({ result: {
        credentials: credentials.result.credentials.map(({ credentialId, delegationId }) => ({ credentialId, delegationId })),
      } });
      const repeated = await control('/__demo/event', cookie, current.csrfToken!, {
        expectedGeneration: current.generation, eventId: 'assistant-probe',
      });
      expect(repeated.status).toBe(200);
      const revokedProbe: unknown = await repeated.json();
      expect(revokedProbe).toEqual({
        generation: current.generation, eventId: 'assistant-probe',
        probe: {
          checking: { status: 401, resources: [] },
          denials: [
            { operation: 'manage-grants', status: 401 },
            { operation: 'financial', status: 401 },
            { operation: 'full-history', status: 401 },
          ],
        },
      });
      expect(JSON.stringify([allowedProbe, revokedBody, revokedProbe, await state(cookie)]))
        .not.toMatch(/"apiKey"|"key"|"token"|"password"|"cookieHeader"|"internalSecret"|"balance"|"transactions"|"minorUnits"/);
    } finally {
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);

  it('executes a shared alias correction through independent human approval and gives it explicit precedence', async () => {
    const previous = demo;
    demo = await startDemoServer({ scenarioId: 'merchant-alias-conflict', port: 0 });
    try {
      const page = await fetch(`${demo.url}/demo`);
      let ownerCookie = cookieHeader(page);
      let ownerState = await state(ownerCookie);
      expect(ownerState).toMatchObject({ status: 'ready', personaIds: ['owner', 'approver'], personaId: 'owner' });
      const spaceId = await selectedSpace(ownerCookie);
      const selected = { 'x-balanceframe-space': spaceId };
      const ownerSession = await api('/api/auth/get-session', ownerCookie);
      expect(ownerSession.status).toBe(200);
      const ownerIdentity = await ownerSession.json() as { user: { id: string } };
      type AliasView = {
        result: {
          categories: { id: string; name: string }[];
          suggestions: {
            transactionId: string; accountId: string; categoryId: string | null; tier: string; reasonCodes: string[];
            sourceTransaction: {
              id: string; accountId: string; categoryId: string | null; date: string; payeeId: string | null;
              amount: { minorUnits: string; currency: string }; importedPayee: { state: string; value: string };
            };
          }[];
        };
      };
      const analysisResponse = await api('/api/merchant', ownerCookie, 'GET', undefined, selected);
      expect(analysisResponse.status).toBe(200);
      const analysis = await analysisResponse.json() as AliasView;
      const target = analysis.result.suggestions.find((suggestion) => suggestion.sourceTransaction.importedPayee.value === '  Aster—Atelier  ')!;
      expect(target).toBeDefined();
      expect(target.sourceTransaction).toMatchObject({
        id: target.transactionId, accountId: target.accountId, categoryId: null, payeeId: null,
        amount: { minorUnits: '-34258', currency: 'USD' },
        importedPayee: { state: 'present', value: '  Aster—Atelier  ' },
      });
      const category = analysis.result.categories.find((candidate) => candidate.name === 'Other')!;
      const groceries = analysis.result.categories.find((candidate) => candidate.name === 'Groceries')!;
      expect(category).toBeDefined();
      expect(groceries).toBeDefined();
      expect(category.id).not.toBe(groceries.id);
      const synced = await api('/api/review/sync', ownerCookie, 'POST', {}, selected);
      expect(synced.status).toBe(200);
      expect(await synced.json()).toMatchObject({ result: { synchronized: true, failed: 0 } });
      const queueResponse = await api('/api/review', ownerCookie, 'GET', undefined, selected);
      expect(queueResponse.status).toBe(200);
      const queue = await queueResponse.json() as { result: { items: { reviewItem: { id: string; transactionId: string } }[] } };
      const review = queue.result.items.find((item) => item.reviewItem.transactionId === target.transactionId)!;
      expect(review).toBeDefined();
      ownerCookie = await prove(ownerCookie, ownerState);
      const corrected = await api('/api/review/correct', ownerCookie, 'POST', {
        reviewId: review.reviewItem.id, categoryId: category.id,
      }, selected);
      expect(corrected.status).toBe(200);
      const proposed = await corrected.json() as {
        result: { applied: boolean; verified: boolean; approvalRequired: boolean; proposal: { id: string; payloadHash: string; requiredApprovers: number } };
      };
      expect(proposed.result).toMatchObject({ applied: false, verified: false, approvalRequired: true, proposal: { requiredApprovers: 1 } });
      const proposalPath = `/api/proposal/${encodeURIComponent(proposed.result.proposal.id)}`;
      const beforeApproval = await api(`/api/merchant?transactionId=${encodeURIComponent(target.transactionId)}`, ownerCookie, 'GET', undefined, selected);
      expect(beforeApproval.status).toBe(200);
      const unchanged = await beforeApproval.json() as AliasView;
      expect(unchanged.result.suggestions.find((suggestion) => suggestion.transactionId === target.transactionId)?.sourceTransaction.categoryId).toBeNull();
      const switched = await control('/__demo/persona', ownerCookie, ownerState.csrfToken!, {
        expectedGeneration: ownerState.generation, personaId: 'approver',
      });
      expect(switched.status).toBe(200);
      let approverCookie = mergeCookies(ownerCookie, cookieHeader(switched));
      const approverState = await state(approverCookie);
      expect(approverState.personaId).toBe('approver');
      const approverSession = await api('/api/auth/get-session', approverCookie);
      expect(approverSession.status).toBe(200);
      const approverIdentity = await approverSession.json() as { user: { id: string } };
      expect(approverIdentity.user.id).not.toBe(ownerIdentity.user.id);
      expect(await selectedSpace(approverCookie)).toBe(spaceId);
      approverCookie = await prove(approverCookie, approverState);
      const detail = await api(proposalPath, approverCookie, 'GET', undefined, selected);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ result: { proposal: {
        payloadHash: proposed.result.proposal.payloadHash, requesterActorId: ownerIdentity.user.id, canApprove: true,
      } } });
      const approved = await api(`${proposalPath}/approve`, approverCookie, 'POST', {
        payloadHash: proposed.result.proposal.payloadHash,
      }, selected);
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ result: { proposalId: proposed.result.proposal.id, status: 'active' } });
      const returned = await control('/__demo/persona', approverCookie, approverState.csrfToken!, {
        expectedGeneration: approverState.generation, personaId: 'owner',
      });
      expect(returned.status).toBe(200);
      ownerCookie = mergeCookies(approverCookie, cookieHeader(returned));
      ownerState = await state(ownerCookie);
      expect(ownerState.personaId).toBe('owner');
      expect(await selectedSpace(ownerCookie)).toBe(spaceId);
      ownerCookie = await prove(ownerCookie, ownerState);
      const executable = await api(proposalPath, ownerCookie, 'GET', undefined, selected);
      expect(executable.status).toBe(200);
      expect(await executable.json()).toMatchObject({ result: { proposal: { canExecute: true } } });
      const executed = await api(`${proposalPath}/execute`, ownerCookie, 'POST', {}, selected);
      expect(executed.status).toBe(200);
      expect(await executed.json()).toMatchObject({ result: {
        proposalId: proposed.result.proposal.id, transactionId: target.transactionId, categoryId: category.id, verified: true,
      } });
      const reread = await api(`/api/merchant?transactionId=${encodeURIComponent(target.transactionId)}`, ownerCookie, 'GET', undefined, selected);
      expect(reread.status).toBe(200);
      const after = await reread.json() as AliasView;
      const explicit = after.result.suggestions.find((suggestion) => suggestion.transactionId === target.transactionId)!;
      expect(explicit.categoryId).toBe(category.id);
      expect(explicit.sourceTransaction).toMatchObject({
        id: target.transactionId, accountId: target.accountId, categoryId: category.id,
        date: target.sourceTransaction.date, payeeId: target.sourceTransaction.payeeId,
        amount: target.sourceTransaction.amount, importedPayee: target.sourceTransaction.importedPayee,
      });
    } finally {
      await stopDemoServer(demo);
      demo = previous;
    }
  }, 180_000);
});
