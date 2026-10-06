// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), session: vi.fn(), setCookie: vi.fn(), appendHeader: vi.fn() }));
vi.mock('h3', () => ({ getCookie: () => undefined, setCookie: mocks.setCookie, appendResponseHeader: mocks.appendHeader }));
vi.mock('better-auth/node', () => ({ fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers) }));
vi.mock('../../lib/auth', () => ({ auth: { api: { signInEmail: mocks.signIn, getSession: mocks.session } } }));
import { authenticateInvitationHuman } from '../../server/utils/reauthentication';

const event = (): ReauthenticationEvent => ({
  context: { runtimeConfig: {} },
  node: { req: { headers: { origin: 'https://balanceframe.example.test' } } },
} as unknown as ReauthenticationEvent);
const guest = () => ({ user: { id: 'actual-guest', email: 'guest@example.test' }, session: { id: 'actual-session', userId: 'actual-guest', expiresAt: new Date('2098-01-02T12:00:00.000Z'), impersonatedBy: null } });

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'invited-human-test-secret');
  vi.useFakeTimers(); vi.setSystemTime('2098-01-01T12:00:00.000Z');
  mocks.signIn.mockResolvedValue(new Response('{}', { headers: { 'set-cookie': 'better-auth.session_token=verified-cookie; HttpOnly; Path=/' } }));
  mocks.session.mockResolvedValue(guest());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('fresh invited human identity', () => {
  it('uses only the actual signed-in user and session and issues a current human consent proof', async () => {
    const request = event();
    const result = await authenticateInvitationHuman(request, 'guest@example.test', 'correct-password');
    expect(result).toEqual({ email: 'guest@example.test', auth: { method: 'human-session', actorId: 'actual-guest', sessionId: 'actual-session', reauthenticatedAt: '2098-01-01T12:00:00.000Z', credentialExpiresAt: '2098-01-02T12:00:00.000Z', isCredentialValid: expect.any(Function) } });
    expect(request.context.auth).toMatchObject({ actorId: 'actual-guest', method: 'session', sessionId: 'actual-session', principalType: 'human' });
  });

  it.each(['api-key', 'legacy-token', 'development'] as const)('never converts %s into human invitation consent', async (method) => {
    const request = event();
    request.context.auth = { authenticated: true, actorId: 'actual-guest', method, principalType: 'human' };
    expect(await authenticateInvitationHuman(request, 'guest@example.test', 'correct-password')).toBeNull();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it.each(['foreign-origin', 'wrong-email', 'wrong-session-owner', 'impersonated', 'password-rejected', 'cookie-missing'] as const)('denies %s without issuing authenticated cookies or proof', async (failure) => {
    const request = event();
    const session = guest();
    if (failure === 'foreign-origin') request.node.req.headers.origin = 'https://attacker.example';
    if (failure === 'wrong-email') session.user.email = 'someone-else@example.test';
    if (failure === 'wrong-session-owner') session.session.userId = 'someone-else';
    if (failure === 'impersonated') Object.assign(session.session, { impersonatedBy: 'administrator' });
    if (failure === 'password-rejected') mocks.signIn.mockResolvedValue(new Response('{}', { status: 401 }));
    if (failure === 'cookie-missing') mocks.signIn.mockResolvedValue(new Response('{}'));
    mocks.session.mockResolvedValue(session);
    expect(await authenticateInvitationHuman(request, 'guest@example.test', 'correct-password')).toBeNull();
    expect(mocks.appendHeader).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});
