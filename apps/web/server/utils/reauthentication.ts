import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendResponseHeader, getCookie, setCookie } from 'h3';
import { fromNodeHeaders } from 'better-auth/node';
import type { H3Event } from 'h3';
import { auth } from '../../lib/auth';
import type { EventWithContext } from './workflow-store';

export const REAUTH_COOKIE_NAME = 'balanceframe_reauth';
const REAUTH_TTL_SECONDS = 300;
const REAUTH_ATTEMPT_WINDOW_MS = REAUTH_TTL_SECONDS * 1000;
const MAX_PASSWORD_ATTEMPTS = 5;
const MAX_TRACKED_REAUTH_USERS = 10_000;

interface PasswordAttemptWindow {
  startedAt: number;
  attempts: number;
}

const passwordAttemptWindows = new Map<string, PasswordAttemptWindow>();

export type AuthMethod = 'session' | 'api-key' | 'legacy-token' | 'development';
export type PrincipalType = 'human' | 'agent';

export interface TrustedAuthContext {
  authenticated: boolean;
  actorId?: string;
  user?: Record<string, unknown>;
  method?: AuthMethod;
  sessionId?: string;
  principalType?: PrincipalType;
  impersonatedBy?: string | null;
  credentialId?: string;
  credentialOwnerId?: string;
  delegationId?: string;
  delegationVersion?: string;
}

export type ReauthenticationEvent = H3Event & EventWithContext & {
  context: EventWithContext['context'] & { auth?: TrustedAuthContext };
};

interface CurrentSession {
  user?: { id?: unknown; email?: unknown };
  session?: { id?: unknown; userId?: unknown; impersonatedBy?: unknown };
}

interface Proof {
  version: 1;
  actorId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface HumanControlAuth {
  method: 'human-session';
  actorId: string;
  sessionId: string;
  reauthenticatedAt: string;
}

function getSecret(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.NUXT_BETTER_AUTH_SECRET;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

/** Rejects foreign browser origins; authenticated non-browser clients may omit Origin. */
export function hasTrustedRequestOrigin(event: ReauthenticationEvent): boolean {
  try {
    const headers = fromNodeHeaders(event.node.req.headers);
    const origin = headers.get('origin');
    return origin === null ||
      origin === new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000').origin;
  } catch {
    return false;
  }
}

async function currentHumanSession(
  event: ReauthenticationEvent,
): Promise<{ actorId: string; sessionId: string; headers: Headers } | null> {
  const context = event.context.auth;
  if (
    context &&
    (!context.authenticated ||
      context.method !== 'session' ||
      context.principalType !== 'human' ||
      (typeof context.impersonatedBy === 'string' && context.impersonatedBy.length > 0))
    || !hasTrustedRequestOrigin(event)
  ) return null;
  if (
    event.context.runtimeConfig?.devBypassAuth === true ||
    process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true'
  ) return null;
  try {
    const runtimeConfig = useRuntimeConfig(event) as Record<string, unknown>;
    if (runtimeConfig.devBypassAuth === true) return null;
  } catch {
    if (process.env.NODE_ENV !== 'test') return null;
  }

  try {
    const headers = fromNodeHeaders(event.node.req.headers);
    if (headers.has('authorization')) return null;
    const current = (await auth.api.getSession({ headers })) as CurrentSession | null;
    const actorId = current?.user?.id;
    const sessionId = current?.session?.id;
    if (
      typeof actorId !== 'string' ||
      actorId.length === 0 ||
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      current?.session?.userId !== actorId ||
      (typeof current?.session?.impersonatedBy === 'string' &&
        current.session.impersonatedBy.length > 0) ||
      (context &&
        (context.actorId !== actorId ||
          context.sessionId !== sessionId ||
          context.user?.id !== actorId))
    ) return null;
    if (!context) {
      event.context.auth = {
        authenticated: true,
        actorId,
        user: { id: actorId },
        method: 'session',
        sessionId,
        principalType: 'human',
        impersonatedBy: null,
      };
    }
    return { actorId, sessionId, headers };
  } catch {
    return null;
  }
}

function reservePasswordAttempt(actorId: string, now: number): boolean {
  const current = passwordAttemptWindows.get(actorId);
  if (current && now - current.startedAt < REAUTH_ATTEMPT_WINDOW_MS) {
    if (current.attempts >= MAX_PASSWORD_ATTEMPTS) return false;
    current.attempts++;
    return true;
  }

  for (const [userId, window] of passwordAttemptWindows) {
    if (now - window.startedAt >= REAUTH_ATTEMPT_WINDOW_MS) {
      passwordAttemptWindows.delete(userId);
    }
  }
  if (passwordAttemptWindows.size >= MAX_TRACKED_REAUTH_USERS) return false;
  passwordAttemptWindows.set(actorId, { startedAt: now, attempts: 1 });
  return true;
}

// ponytail: process-local cap; use shared auth storage when multiple workers need a shared limit.

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeProof(proof: Proof, secret: string): string {
  const payload = Buffer.from(JSON.stringify(proof)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function verifyProof(
  value: string,
  secret: string,
  actorId: string,
  sessionId: string,
): Proof | null {
  if (value.length > 4096) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;

  const expected = Buffer.from(sign(encoded, secret));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const proof = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<Proof>;
    const now = Math.floor(Date.now() / 1000);
    if (
      proof.version !== 1 ||
      proof.actorId !== actorId ||
      proof.sessionId !== sessionId ||
      !Number.isSafeInteger(proof.issuedAt) ||
      !Number.isSafeInteger(proof.expiresAt) ||
      (proof.issuedAt as number) > now ||
      (proof.expiresAt as number) <= now ||
      (proof.expiresAt as number) - (proof.issuedAt as number) > REAUTH_TTL_SECONDS
    ) return null;
    return proof as Proof;
  } catch {
    return null;
  }
}

/** Verifies the password for the request's current Better Auth human session and issues its proof. */
export async function issueReauthentication(
  event: ReauthenticationEvent,
  password: string,
): Promise<boolean> {
  const secret = getSecret();
  if (!secret || typeof password !== 'string' || password.length === 0) return false;

  const session = await currentHumanSession(event);
  if (!session || !reservePasswordAttempt(session.actorId, Date.now())) return false;

  try {
    const result = await auth.api.verifyPassword({ body: { password }, headers: session.headers });
    if (result?.status !== true) return false;
    passwordAttemptWindows.delete(session.actorId);
  } catch {
    return false;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const value = encodeProof({
    version: 1,
    actorId: session.actorId,
    sessionId: session.sessionId,
    issuedAt,
    expiresAt: issuedAt + REAUTH_TTL_SECONDS,
  }, secret);
  setCookie(event, REAUTH_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REAUTH_TTL_SECONDS,
  });
  return true;
}

/** Returns verified proof provenance for a current human session, or null. */
export async function getHumanControlAuth(
  event: ReauthenticationEvent,
): Promise<HumanControlAuth | null> {
  const secret = getSecret();
  if (!secret) return null;
  const session = await currentHumanSession(event);
  if (!session) return null;
  const value = getCookie(event, REAUTH_COOKIE_NAME);
  if (typeof value !== 'string') return null;
  const proof = verifyProof(value, secret, session.actorId, session.sessionId);
  if (!proof) return null;
  return {
    method: 'human-session',
    actorId: session.actorId,
    sessionId: session.sessionId,
    reauthenticatedAt: new Date(proof.issuedAt * 1000).toISOString(),
  };
}

/** Revalidates the Better Auth session before accepting its signed, session-bound proof. */
export async function hasRecentReauthentication(event: ReauthenticationEvent): Promise<boolean> {
  return (await getHumanControlAuth(event)) !== null;
}

/** Authenticates an invitation recipient with a verified Better Auth password session. */
export async function authenticateInvitationHuman(
  event: ReauthenticationEvent,
  email: string,
  password: string,
): Promise<{ auth: HumanControlAuth; email: string } | null> {
  const secret = getSecret();
  const context = event.context.auth;
  if (!secret || !hasTrustedRequestOrigin(event) ||
      (context && (context.method !== 'session' || context.principalType !== 'human' || context.impersonatedBy)) ||
      typeof email !== 'string' || typeof password !== 'string' ||
      password.length < 8 || password.length > 128) return null;
  const canonicalEmail = email.trim().toLowerCase();
  const attemptId = `invitation:${canonicalEmail}`;
  try {
    const headers = fromNodeHeaders(event.node.req.headers);
    if (headers.has('authorization') || event.context.runtimeConfig?.devBypassAuth === true ||
        process.env.BALANCEFRAME_DEV_BYPASS_AUTH === 'true' ||
        !reservePasswordAttempt(attemptId, Date.now())) return null;
    const result = await auth.api.signInEmail({
      body: { email: canonicalEmail, password }, headers, asResponse: true,
    });
    if (!result.ok) return null;
    const cookies = result.headers.getSetCookie();
    if (cookies.length === 0) return null;
    const sessionHeaders = new Headers(headers);
    sessionHeaders.set('cookie', cookies.map((cookie) => cookie.split(';', 1)[0]).join('; '));
    const session = (await auth.api.getSession({ headers: sessionHeaders })) as CurrentSession | null;
    const actorId = session?.user?.id;
    const sessionId = session?.session?.id;
    const verifiedEmail = session?.user?.email;
    if (typeof actorId !== 'string' || !actorId || typeof sessionId !== 'string' || !sessionId ||
        session?.session?.userId !== actorId || session.session.impersonatedBy ||
        typeof verifiedEmail !== 'string' || verifiedEmail.trim().toLowerCase() !== canonicalEmail) return null;
    const issuedAt = Math.floor(Date.now() / 1000);
    const proof: Proof = { version: 1, actorId, sessionId, issuedAt, expiresAt: issuedAt + REAUTH_TTL_SECONDS };
    for (const cookie of cookies) appendResponseHeader(event, 'set-cookie', cookie);
    setCookie(event, REAUTH_COOKIE_NAME, encodeProof(proof, secret), {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', maxAge: REAUTH_TTL_SECONDS,
    });
    event.context.auth = {
      authenticated: true, actorId, sessionId, user: { id: actorId, email: verifiedEmail },
      method: 'session', principalType: 'human', impersonatedBy: null,
    };
    passwordAttemptWindows.delete(attemptId);
    return {
      email: canonicalEmail,
      auth: { method: 'human-session', actorId, sessionId, reauthenticatedAt: new Date(issuedAt * 1000).toISOString() },
    };
  } catch {
    return null;
  }
}
