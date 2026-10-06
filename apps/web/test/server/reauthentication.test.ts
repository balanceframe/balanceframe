/** Behavioral contract for human reauthentication and Better Auth control-plane guards. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetCookie,
  mockGetHeader,
  mockGetRequestHeaders,
  mockGetRequestMethod,
  mockGetRequestPath,
  mockReadBody,
  mockSetCookie,
  mockSetHeader,
  mockSetResponseStatus,
  mockGetSession,
  mockVerifyPassword,
  mockVerifyApiKey,
  mockAuthHandler,
  mockGetWorkflowStore,
  mockResolveCredentialPrincipal,
  mockRequireAuthorization,
  mockGetActorMembership,
  mockGetCurrentMembership,
  mockRequireRegisteredOwner,
} = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockGetHeader: vi.fn(),
  mockGetRequestHeaders: vi.fn(),
  mockGetRequestMethod: vi.fn(),
  mockGetRequestPath: vi.fn(),
  mockReadBody: vi.fn(),
  mockSetCookie: vi.fn(),
  mockSetHeader: vi.fn(),
  mockSetResponseStatus: vi.fn(),
  mockGetSession: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockVerifyApiKey: vi.fn(),
  mockAuthHandler: vi.fn(),
  mockGetWorkflowStore: vi.fn(),
  mockResolveCredentialPrincipal: vi.fn(),
  mockRequireAuthorization: vi.fn(),
  mockGetActorMembership: vi.fn(),
  mockGetCurrentMembership: vi.fn(),
  mockRequireRegisteredOwner: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getCookie: mockGetCookie,
  getHeader: mockGetHeader,
  getMethod: mockGetRequestMethod,
  getRequestHeaders: mockGetRequestHeaders,
  getRequestPath: mockGetRequestPath,
  readBody: mockReadBody,
  setCookie: mockSetCookie,
  setHeader: mockSetHeader,
  setResponseStatus: mockSetResponseStatus,
  toWebRequest: (event: unknown) => event,
}));

vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));

vi.mock('../../server/utils/demo-boundary', () => ({ enforceDemoBoundary: () => null }));
vi.mock('../../server/utils/auth-migration-status', () => ({
  authMigrationFailed: false,
  authMigrationMessage: null,
}));
vi.mock('../../lib/auth', () => ({
  auth: {
    api: {
      getSession: mockGetSession,
      verifyPassword: mockVerifyPassword,
      verifyApiKey: mockVerifyApiKey,
    },
    handler: mockAuthHandler,
  },
}));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  getActorId: vi.fn(),
  errorEnvelope: vi.fn(),
  requireAuthorization: mockRequireAuthorization,
}));
vi.mock('../../server/utils/legacy-financial-read', () => ({
  requireRegisteredOwner: mockRequireRegisteredOwner,
}));

import authMiddleware from '../../server/middleware/auth';
import authCatchall from '../../server/api/auth/[...all]';
import reauthenticationRoute from '../../server/api/reauth.post';
import {
  getHumanControlAuth,
  hasRecentReauthentication,
  issueReauthentication,
  REAUTH_COOKIE_NAME,
} from '../../server/utils/reauthentication';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';

interface MockEvent {
  node: { req: { headers: Record<string, string> } };
  context: {
    runtimeConfig?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    selectedSpaceId?: string;
  };
  path?: string;
  method?: string;
  body?: unknown;
}

interface CurrentSession {
  user: { id: string; email?: string };
  session: { id: string; userId: string; expiresAt: Date; impersonatedBy?: string | null };
}

let currentSession: CurrentSession | null;
let reauthCookie: string | undefined;
let actorIdentityStatus: 'active' | 'suspended' = 'active';
let currentSpaceMembership = true;
let spaceGrantCapabilities: string[] = [];

const middleware = authMiddleware as (event: MockEvent) => Promise<unknown>;
const betterAuthRoute = authCatchall as (event: MockEvent) => Promise<unknown>;
const reauthenticate = reauthenticationRoute as (event: MockEvent) => Promise<unknown>;

function hasRecent(request: MockEvent): Promise<boolean> {
  return hasRecentReauthentication(request as unknown as ReauthenticationEvent);
}

function issueProof(request: MockEvent, password: string): Promise<boolean> {
  return issueReauthentication(request as unknown as ReauthenticationEvent, password);
}

function session(userId = 'human-1', sessionId = 'session-1'): CurrentSession {
  return {
    user: { id: userId, email: `${userId}@example.test` },
    session: { id: sessionId, userId, expiresAt: new Date('2026-10-03T12:00:00.000Z') },
  };
}

function humanContext(userId = 'human-1', sessionId = 'session-1'): Record<string, unknown> {
  return {
    authenticated: true,
    actorId: userId,
    user: { id: userId },
    method: 'session',
    sessionId,
    principalType: 'human',
  };
}

function event(
  path = '/api/reauth',
  auth: Record<string, unknown> = humanContext(),
  body: Record<string, unknown> = { password: 'correct-password' },
): MockEvent {
  return {
    context: { runtimeConfig: {}, auth, selectedSpaceId: 'control-space' },
    node: { req: { headers: {
      cookie: 'better-auth.session_token=authoritative-session-cookie',
      host: 'balanceframe.example.test',
    } } },
    path,
    method: 'POST',
    body,
  };
}

function issuedCookie(): { value: string; options: Record<string, unknown> } {
  const call = mockSetCookie.mock.calls.find((args: unknown[]) => args[1] === REAUTH_COOKIE_NAME);
  expect(call).toBeDefined();
  return { value: call![2] as string, options: call![3] as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'reauth-test-signing-secret');
  vi.stubEnv('NUXT_BETTER_AUTH_SECRET', 'reauth-test-signing-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
  currentSession = session();
  reauthCookie = undefined;
  mockGetCookie.mockImplementation((_event: unknown, name: string) =>
    name === REAUTH_COOKIE_NAME ? reauthCookie : undefined,
  );
  mockGetHeader.mockReturnValue(undefined);
  mockGetRequestHeaders.mockReturnValue({
    cookie: 'better-auth.session_token=authoritative-session-cookie',
    host: 'balanceframe.example.test',
  });
  mockGetRequestMethod.mockImplementation((request: MockEvent) => request.method ?? 'GET');
  mockGetRequestPath.mockImplementation((request: MockEvent) => request.path ?? '');
  mockReadBody.mockImplementation((request: MockEvent) => request.body);
  mockGetSession.mockImplementation(async () => currentSession);
  mockVerifyPassword.mockResolvedValue({ status: true });
  mockVerifyApiKey.mockResolvedValue({ valid: false, error: 'invalid_key', key: null });
  actorIdentityStatus = 'active';
  currentSpaceMembership = true;
  spaceGrantCapabilities = [];
  mockGetActorMembership.mockImplementation(async (actorId: string) => ({
    actorId,
    status: actorIdentityStatus,
    capabilities: ['*'],
    scope: '*',
  }));
  mockGetCurrentMembership.mockImplementation(
    async ({ spaceId, actorId }: { spaceId: string; actorId: string }) =>
      currentSpaceMembership ? { id: 'membership-current', spaceId, actorId } : null,
  );
  mockGetWorkflowStore.mockImplementation(() => ({
    store: {
      governance: {
        resolveCredentialPrincipal: mockResolveCredentialPrincipal,
        getCurrentMembership: mockGetCurrentMembership,
      },
      getActorMembership: mockGetActorMembership,
    },
  }));
  mockResolveCredentialPrincipal.mockResolvedValue({
    principalType: 'human',
    actorId: 'human-1',
    credentialId: 'key-1',
    credentialOwnerId: 'human-1',
  });
  mockRequireAuthorization.mockImplementation(async (request: MockEvent, capability: string) => {
    const auth = request.context.auth ?? {};
    const user = auth.user as { id?: string } | undefined;
    const actorId = user?.id ?? (typeof auth.actorId === 'string' ? auth.actorId : '');
    const [identity, membership] = await Promise.all([
      mockGetActorMembership(actorId),
      mockGetCurrentMembership({
        spaceId: request.context.selectedSpaceId ?? 'control-space',
        actorId,
        now: new Date().toISOString(),
      }),
    ]);
    const allowed =
      identity?.status === 'active' &&
      membership !== null &&
      spaceGrantCapabilities.includes(capability);
    return allowed
      ? { ok: true, info: { actorId, capability, allowed: true } }
      : { ok: false, response: { status: 'error' } };
  });
  mockRequireRegisteredOwner.mockResolvedValue({
    ok: false,
    response: { status: 'error' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('reauthentication route and proof', () => {
  it.each(['https://attacker.example', 'https://evil.balanceframe.example.test', 'null'])(
    'rejects cookie-backed password proof from foreign origin %s before verifying credentials',
    async (origin) => {
      const request = event();
      request.node.req.headers.origin = origin;
      expect(await issueProof(request, 'correct-password')).toBe(false);
      expect(mockVerifyPassword).not.toHaveBeenCalled();
      expect(mockSetCookie).not.toHaveBeenCalled();
    },
  );

  it('cannot use an otherwise current human proof for a foreign-origin control request', async () => {
    const request = event();
    await reauthenticate(request);
    reauthCookie = issuedCookie().value;
    request.node.req.headers.origin = 'https://evil.balanceframe.example.test';
    expect(await getHumanControlAuth(request as unknown as ReauthenticationEvent)).toBeNull();
  });

  it('verifies the current Better Auth session password and sets a short-lived, HttpOnly SameSite proof cookie', async () => {
    const request = event('/api/reauth', humanContext(), {
      password: 'correct-password',
      actorId: 'attacker-selected-actor',
      sessionId: 'attacker-selected-session',
      verifiedAt: '2099-01-01T00:00:00.000Z',
    });

    const response = await reauthenticate(request);

    expect(mockGetSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    expect(mockVerifyPassword).toHaveBeenCalledWith({
      body: { password: 'correct-password' },
      headers: expect.any(Headers),
    });
    const verificationHeaders = mockVerifyPassword.mock.calls[0]![0].headers as Headers;
    expect(verificationHeaders.get('cookie')).toBe(
      'better-auth.session_token=authoritative-session-cookie',
    );
    expect(mockGetSession.mock.calls[0]![0].headers.get('cookie')).toBe(
      'better-auth.session_token=authoritative-session-cookie',
    );

    const proof = issuedCookie();
    expect(proof.value).toBeTruthy();
    expect(proof.options.httpOnly).toBe(true);
    expect(['lax', 'strict']).toContain(proof.options.sameSite);
    expect(proof.options.maxAge).toEqual(expect.any(Number));
    expect(proof.options.maxAge as number).toBeGreaterThan(0);
    expect(proof.options.maxAge as number).toBeLessThanOrEqual(300);
    expect(JSON.stringify(response)).not.toContain('correct-password');
    expect(JSON.stringify(response)).not.toContain('authoritative-session-cookie');
    expect(JSON.stringify(response)).not.toContain(proof.value);

    reauthCookie = proof.value;
    mockGetSession.mockClear();
    expect(await hasRecent(request)).toBe(true);
    expect(mockGetSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
  });

  it('rejects an oversized password before credential verification', async () => {
    const request = event();
    request.body = { password: 'p'.repeat(129) };
    const response = await reauthenticate(request);
    expect(response).toMatchObject({ status: 'error' });
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it('does not issue proof after Better Auth rejects the password', async () => {
    mockVerifyPassword.mockRejectedValueOnce(new Error('invalid password'));

    const response = await reauthenticate(event());

    expect(mockVerifyPassword).toHaveBeenCalledOnce();
    expect(mockSetCookie).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('correct-password');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 401);
  });

  it.each([
    ['API key', { ...humanContext(), method: 'api-key' }],
    ['legacy token', { ...humanContext(), method: 'legacy-token' }],
    ['development bypass', { ...humanContext(), method: 'development' }],
    ['agent principal', { ...humanContext(), principalType: 'agent' }],
  ] as const)(
    'does not reauthenticate a %s, even when Better Auth returns a session',
    async (_label, auth) => {
      const response = await reauthenticate(event('/api/reauth', auth));

      expect(mockVerifyPassword).not.toHaveBeenCalled();
      expect(mockSetCookie).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain('correct-password');
    },
  );

  it('rejects impersonated Better Auth sessions even when the password is correct', async () => {
    currentSession = {
      ...session(),
      session: { ...session().session, impersonatedBy: 'admin-user' },
    };

    await reauthenticate(event());

    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it('binds proof to the authoritative actor and session, not request-supplied identity', async () => {
    const request = event('/api/reauth', humanContext(), {
      password: 'correct-password',
      actorId: 'other-human',
      sessionId: 'other-session',
    });
    expect(await issueProof(request, 'correct-password')).toBe(true);
    reauthCookie = issuedCookie().value;

    expect(await hasRecent(request)).toBe(true);
    expect(
      await hasRecent(event('/api/approve', humanContext('other-human', 'session-2'))),
    ).toBe(false);
    expect(
      await hasRecent(event('/api/approve', humanContext('human-1', 'different-session'))),
    ).toBe(false);
    currentSession = session('human-1', 'session-2');
    expect(
      await hasRecent(event('/api/approve', humanContext('human-1', 'session-2'))),
    ).toBe(false);
  });

  it.each(['Bearer invalid-explicit-key', 'bearer invalid-explicit-key', 'Basic dGVzdA=='])(
    'rejects cookie consent when an explicit credential %s is supplied',
    async (authorization) => {
    const request = event();
    await reauthenticate(request);
    reauthCookie = issuedCookie().value;
    mockGetSession.mockClear();
    request.node.req.headers.authorization = authorization;

    expect(await hasRecent(request)).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('rejects expired and future-dated proofs; client timestamps cannot extend trusted expiry', async () => {
    const request = event('/api/reauth', humanContext(), {
      password: 'correct-password',
      verifiedAt: '2099-01-01T00:00:00.000Z',
    });
    await reauthenticate(request);
    reauthCookie = issuedCookie().value;

    vi.setSystemTime(new Date('2026-10-02T12:06:00.000Z'));
    expect(await hasRecent(request)).toBe(false);

    vi.setSystemTime(new Date('2026-10-02T11:59:59.000Z'));
    expect(await hasRecent(request)).toBe(false);
  });

  it('rejects malformed and signature-tampered proofs', async () => {
    const request = event();
    await reauthenticate(request);
    const validProof = issuedCookie().value;

    reauthCookie = 'not-a-signed-proof';
    expect(await hasRecent(request)).toBe(false);

    const changedAt = Math.floor(validProof.length / 2);
    const replacement = validProof[changedAt] === 'A' ? 'B' : 'A';
    reauthCookie = `${validProof.slice(0, changedAt)}${replacement}${validProof.slice(changedAt + 1)}`;
    expect(await hasRecent(request)).toBe(false);
  });
  it('returns the signed password-verification time for guarded control-plane calls', async () => {
    const request = event();
    await reauthenticate(request);
    reauthCookie = issuedCookie().value;
    expect(await getHumanControlAuth(request as unknown as ReauthenticationEvent)).toEqual({
      method: 'human-session',
      actorId: 'human-1',
      sessionId: 'session-1',
      reauthenticatedAt: '2026-10-02T12:00:00.000Z',
    });
  });
});

describe('authentication context and Better Auth control plane', () => {
  it('records the authoritative human session ID and authentication method in middleware context', async () => {
    const request = event('/api/proposal/one/approve');

    await middleware(request);

    expect(request.context.auth).toMatchObject({
      authenticated: true,
      actorId: 'human-1',
      method: 'session',
      sessionId: 'session-1',
      principalType: 'human',
    });
  });

  it('derives a current human session for auth handlers when middleware context is absent', async () => {
    await reauthenticate(event());
    reauthCookie = issuedCookie().value;
    const request = event('/api/auth/api-key/create', {}, { name: 'control-key' });
    delete request.context.auth;

    expect(await hasRecent(request)).toBe(true);
    expect(request.context.auth).toMatchObject({
      method: 'session',
      actorId: 'human-1',
      sessionId: 'session-1',
    });
  });

  it('denies impersonated sessions on governed routes', async () => {
    currentSession = {
      ...session(),
      session: { ...session().session, impersonatedBy: 'admin-user' },
    };
    const request = event('/api/proposal/one/approve');

    await middleware(request);

    const deniedInContext = request.context.auth?.authenticated === false;
    const deniedWithStatus = mockSetResponseStatus.mock.calls.some(
      (call: unknown[]) => call[0] === request && call[1] === 403,
    );
    expect(deniedInContext || deniedWithStatus).toBe(true);
  });

  it.each(['Bearer', 'bEaReR'])('gives a verified %s key precedence over cookies', async (scheme) => {
    mockGetHeader.mockReturnValue(`${scheme} verified-api-key`);
    mockVerifyApiKey.mockResolvedValueOnce({
      valid: true,
      error: null,
      key: { id: 'key-1', referenceId: 'human-1', expiresAt: null },
    });
    const request = event('/api/proposal/one/approve');

    await middleware(request);

    expect(mockVerifyApiKey).toHaveBeenCalledWith({
      body: { key: 'verified-api-key' },
      headers: expect.any(Headers),
    });
    expect(mockResolveCredentialPrincipal).toHaveBeenCalledWith({
      credentialId: 'key-1',
      referenceId: 'human-1',
      now: expect.any(String),
    });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(request.context.auth).toMatchObject({
      actorId: 'human-1',
      credentialId: 'key-1',
      credentialOwnerId: 'human-1',
      method: 'api-key',
      principalType: 'human',
    });
    expect(request.context.auth?.sessionId).toBeUndefined();
  });
  it('attributes a verified API key to its bound agent, not its human credential owner', async () => {
    mockGetHeader.mockReturnValue('Bearer agent-api-key');
    mockVerifyApiKey.mockResolvedValueOnce({
      valid: true,
      error: null,
      key: { id: 'key-1', referenceId: 'human-1', expiresAt: null },
    });
    mockResolveCredentialPrincipal.mockResolvedValueOnce({
      principalType: 'agent',
      actorId: 'agent-7',
      credentialId: 'key-1',
      credentialOwnerId: 'human-1',
      delegationId: 'delegation-3',
      delegationVersion: '2',
    });
    const request = event('/api/review', humanContext(), {
      actorId: 'attacker-selected-human',
      delegationId: 'attacker-selected-delegation',
    });

    await middleware(request);

    expect(mockResolveCredentialPrincipal).toHaveBeenCalledWith({
      credentialId: 'key-1',
      referenceId: 'human-1',
      now: expect.any(String),
    });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(request.context.auth).toMatchObject({
      actorId: 'agent-7',
      credentialOwnerId: 'human-1',
      delegationId: 'delegation-3',
      delegationVersion: '2',
      method: 'api-key',
      principalType: 'agent',
    });
    expect(request.context.auth?.user).toBeUndefined();
  });

  it('denies a verified key whose server-owned principal binding is revoked', async () => {
    mockGetHeader.mockReturnValue('Bearer revoked-agent-key');
    mockVerifyApiKey.mockResolvedValueOnce({
      valid: true,
      error: null,
      key: { id: 'key-1', referenceId: 'human-1', expiresAt: null },
    });
    mockResolveCredentialPrincipal.mockResolvedValueOnce(null);
    const request = event('/api/review');

    await middleware(request);

    expect(request.context.auth).toBeUndefined();
    expect(mockGetSession).not.toHaveBeenCalled();
  });


  it('fails closed when credential principal authority is unavailable', async () => {
    mockGetHeader.mockReturnValue('Bearer verified-api-key');
    mockVerifyApiKey.mockResolvedValueOnce({
      valid: true,
      error: null,
      key: { id: 'key-1', referenceId: 'human-1', expiresAt: null },
    });
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'private store error' });
    const request = event('/api/proposal/one/approve');

    await middleware(request);

    expect(request.context.auth).toBeUndefined();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSetResponseStatus).toHaveBeenCalledWith(request, 503);
  });

  it('does not fall back to a valid session cookie when an explicit Bearer key is invalid', async () => {
    mockGetHeader.mockReturnValue('Bearer invalid-explicit-key');
    mockVerifyApiKey.mockResolvedValueOnce({
      valid: false,
      error: 'invalid_key',
      key: null,
    });
    const request = event('/api/proposal/one/approve');

    await middleware(request);

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(request.context.auth).toBeUndefined();
  });

  it('leaves ordinary sign-in reachable while blocking raw admin, key-management, and impersonation mutations without proof', async () => {
    const signIn = event('/api/auth/sign-in/email', {}, { email: 'human@example.test' });
    await betterAuthRoute(signIn);
    expect(mockAuthHandler).toHaveBeenCalledOnce();

    for (const path of [
      '/api/auth/admin/set-role',
      '/api/auth/admin/set-user-password',
      '/api/auth/api-key/create',
      '/api/auth/admin/impersonate-user',
    ]) {
      mockAuthHandler.mockClear();
      await betterAuthRoute(event(path, humanContext(), { userId: 'victim' }));
      expect(mockAuthHandler, path).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['/api/auth/admin/list-users', 'GET'],
    ['/api/auth/api-key/list', 'GET'],
    ['/api/auth/update-user', 'POST'],
    ['/api/auth/change-password', 'POST'],
  ])('does not expose or change controlled identity data at %s without consent', async (path, method) => {
    mockAuthHandler.mockResolvedValueOnce({
      status: 'success',
      users: [{ email: 'private-member@example.test' }],
    });
    const request = event(path);
    request.method = method;
    const response = await betterAuthRoute(request);
    expect(response).toMatchObject({ status: 'error' });
    expect(JSON.stringify(response)).not.toContain('private-member@example.test');
  });

  it('blocks a stale proof after Better Auth rotates the current session', async () => {
    await reauthenticate(event());
    reauthCookie = issuedCookie().value;
    currentSession = session('human-1', 'session-2');
    mockAuthHandler.mockClear();

    await betterAuthRoute(
      event('/api/auth/api-key/create', humanContext('human-1', 'session-2'), { name: 'test-key' }),
    );

    expect(mockAuthHandler).not.toHaveBeenCalled();
  });

  it.each([
    [
      'admin mutation for a suspended identity',
      '/api/auth/admin/set-role',
      'identity:manage',
      'suspended',
      true,
    ],
    [
      'admin mutation after membership expires or is revoked',
      '/api/auth/admin/set-role',
      'identity:manage',
      'active',
      false,
    ],
    [
      'API-key creation for a suspended identity',
      '/api/auth/api-key/create',
      'credential:manage',
      'suspended',
      true,
    ],
    [
      'API-key creation after membership expires or is revoked',
      '/api/auth/api-key/create',
      'credential:manage',
      'active',
      false,
    ],
  ] as const)(
    'blocks %s despite fresh reauthentication and the matching space grant',
    async (_label, path, capability, identityStatus, membershipCurrent) => {
      await reauthenticate(event());
      reauthCookie = issuedCookie().value;
      actorIdentityStatus = identityStatus;
      currentSpaceMembership = membershipCurrent;
      spaceGrantCapabilities = [capability];
      mockAuthHandler.mockClear();
      mockRequireAuthorization.mockClear();
      mockGetActorMembership.mockClear();
      mockGetCurrentMembership.mockClear();

      const request = event(path, humanContext(), {
        userId: 'another-human',
        name: 'test-key',
        role: 'admin',
      });
      await betterAuthRoute(request);

      expect(mockAuthHandler).not.toHaveBeenCalled();
    },
  );
  it('does not treat actor-wide wildcard identity capabilities as a space control grant', async () => {
    await reauthenticate(event());
    reauthCookie = issuedCookie().value;
    actorIdentityStatus = 'active';
    currentSpaceMembership = true;
    spaceGrantCapabilities = [];
    mockAuthHandler.mockClear();

    const request = event('/api/auth/admin/set-role', humanContext(), {
      userId: 'another-human',
      role: 'admin',
    });
    await betterAuthRoute(request);

    expect(mockAuthHandler).not.toHaveBeenCalled();
  });



  it.each([
    ['API key', { ...humanContext(), method: 'api-key' }],
    ['legacy token', { ...humanContext(), method: 'legacy-token' }],
    ['development bypass', { ...humanContext(), method: 'development' }],
    ['agent principal', { ...humanContext(), principalType: 'agent' }],
  ] as const)(
    'does not let a %s use a proof for Better Auth control-plane mutations',
    async (_label, auth) => {
      const issueRequest = event();
      await reauthenticate(issueRequest);
      reauthCookie = issuedCookie().value;

      const request = event('/api/auth/api-key/create', auth, { name: 'test-key' });
      await betterAuthRoute(request);

      expect(mockAuthHandler).not.toHaveBeenCalled();
    },
  );

  it('always blocks Better Auth impersonation and raw physical deletion, even for a reauthenticated administrator', async () => {
    const issueRequest = event();
    await reauthenticate(issueRequest);
    reauthCookie = issuedCookie().value;
    mockAuthHandler.mockClear();

    for (const path of [
      '/api/auth/admin/impersonate-user',
      '/api/auth/admin/remove-user',
      '/api/auth/delete-user',
      '/api/auth/delete-user/callback',
    ]) {
      const request = event(path, humanContext(), { userId: 'victim' });
      if (path.endsWith('/callback')) request.method = 'GET';
      await betterAuthRoute(request);
      expect(mockAuthHandler, path).not.toHaveBeenCalled();
    }
  });

  it('limits Better Auth password checks per authoritative human after five attempts', async () => {
    mockVerifyPassword.mockRejectedValue(new Error('invalid password'));
    const request = event();

    for (let attempt = 0; attempt < 6; attempt++) {
      await issueProof(request, 'invalid-password');
    }

    expect(mockVerifyPassword).toHaveBeenCalledTimes(5);
    expect(mockSetCookie).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-10-02T12:05:00.000Z'));
    await issueProof(request, 'invalid-password');
    expect(mockVerifyPassword).toHaveBeenCalledTimes(6);
  });
});
