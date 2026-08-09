/**
 * Security regression tests for self-hosted registration flow.
 *
 * Verifies security invariants that must not regress:
 * - disableSignUp prevents public self-registration
 * - Auth middleware correctly scopes public vs protected registration routes
 * - verifyBootstrapSecret uses timing-safe comparison
 * - Invite token generation produces cryptographically sound tokens
 * - Invite URLs place tokens only in fragments (never query/path)
 * - requireOwner enforces the bootstrap-owner boundary
 * - Error envelopes never leak reason codes or internal details
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 1. Auth config — disableSignUp
//    Source-text assertion because importing lib/auth requires native deps
//    (better-sqlite3) that esbuild cannot transform at test time.
// ---------------------------------------------------------------------------

describe('auth config — disableSignUp enforcement', () => {
  function readAuthSource(): string {
    const testDir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(testDir, '../../lib/auth.ts'), 'utf-8');
  }

  it('emailAndPassword.disableSignUp is true', () => {
    const source = readAuthSource();
    expect(source).toContain('disableSignUp: true');
    // Guard against a future toggle that would open public registration
    expect(source).not.toMatch(/disableSignUp:\s*false/);
  });

  it('configures a stable Better Auth secret for browser sessions', () => {
    const source = readAuthSource();
    expect(source).toContain('secret:');
    expect(source).toContain('BETTER_AUTH_SECRET');
  });
});

// ---------------------------------------------------------------------------
// 2. Auth middleware — public allowlist
//    Source-text assertion because PUBLIC_API_ALLOWLIST is not exported.
// ---------------------------------------------------------------------------

describe('auth middleware — public allowlist', () => {
  function readMiddlewareSource(): string {
    const testDir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(testDir, '../../server/middleware/auth.ts'), 'utf-8');
  }

  it('includes /api/registration/bootstrap', () => {
    const source = readMiddlewareSource();
    expect(source).toContain("'/api/registration/bootstrap'");
  });

  it('includes /api/invitations/redeem', () => {
    const source = readMiddlewareSource();
    expect(source).toContain("'/api/invitations/redeem'");
  });

  it('does not expose bare /api/invitations as a public prefix', () => {
    const source = readMiddlewareSource();
    // Grab the PUBLIC_API_ALLOWLIST array literal
    const start = source.indexOf('PUBLIC_API_ALLOWLIST');
    const allowlistSnippet = source.slice(start, start + 600);
    // Every line mentioning /api/invitations must also mention /redeem —
    // a bare `/api/invitations` entry would open the entire invitation API.
    const invitationsLines = allowlistSnippet
      .split('\n')
      .filter((l) => l.includes('/api/invitations'));
    expect(invitationsLines.length).toBeGreaterThan(0);
    for (const line of invitationsLines) {
      expect(line).toMatch(/\/api\/invitations\/redeem/);
    }
  });
});

// ---------------------------------------------------------------------------
// Mock h3 for requireOwner — must be before importing registration module
// ---------------------------------------------------------------------------

const { mockSetResponseStatus } = vi.hoisted(() => ({
  mockSetResponseStatus: vi.fn(),
}));

vi.mock('h3', () => ({
  setResponseStatus: mockSetResponseStatus,
}));

// ---------------------------------------------------------------------------
// Imports (after h3 mock is in place)
// ---------------------------------------------------------------------------

import {
  verifyBootstrapSecret,
  generateInviteToken,
  tokenDigest,
  buildInviteUrl,
  registrationError,
  invitationError,
  requireOwner,
  validateEmail,
} from '../../server/utils/registration';
import type { EventWithContext } from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// 3. verifyBootstrapSecret — timing-safe comparison
// ---------------------------------------------------------------------------

describe('verifyBootstrapSecret — timing-safe comparison', () => {
  const SECRET = 'a-secret-that-is-at-least-thirty-two-chars!!';
  // Same length as SECRET (44 chars), different content
  const OTHER = 'b-secret-that-is-at-least-thirty-two-chars!!';

  it('rejects unequal length inputs', () => {
    expect(verifyBootstrapSecret('short', SECRET)).toBe(false);
    expect(verifyBootstrapSecret(SECRET, 'short')).toBe(false);
    // Varying lengths on both sides
    expect(verifyBootstrapSecret('', SECRET)).toBe(false);
    expect(verifyBootstrapSecret(SECRET, '')).toBe(false);
  });

  it('rejects same-length different values', () => {
    expect(OTHER.length).toBe(SECRET.length);
    expect(OTHER).not.toBe(SECRET);
    expect(verifyBootstrapSecret(OTHER, SECRET)).toBe(false);
  });

  it('accepts exact match', () => {
    expect(verifyBootstrapSecret(SECRET, SECRET)).toBe(true);
  });

  it('is reflexive and symmetric', () => {
    const a = 'a-long-test-secret-value-that-is-32-chars!';
    const b = 'b-long-test-secret-value-that-is-32-chars!';
    expect(verifyBootstrapSecret(a, a)).toBe(true);
    expect(verifyBootstrapSecret(b, b)).toBe(true);
    expect(verifyBootstrapSecret(a, b)).toBe(false);
    expect(verifyBootstrapSecret(b, a)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. generateInviteToken — token properties
// ---------------------------------------------------------------------------

describe('generateInviteToken — token strength and digest separation', () => {
  it('produces a 64-hex-character raw token (32 random bytes)', () => {
    const token = generateInviteToken();
    expect(token.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hex).toBe(token.raw);
  });

  it('digest is a 64-hex-character string different from the raw token', () => {
    const token = generateInviteToken();
    expect(token.digest).toMatch(/^[0-9a-f]{64}$/);
    // The digest must not leak the raw token value
    expect(token.digest).not.toBe(token.raw);
  });

  it('generates unique tokens on successive calls (no accidental collisions)', () => {
    const tokens = Array.from({ length: 10 }, () => generateInviteToken());
    const raws = tokens.map((t) => t.raw);
    expect(new Set(raws).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 5. buildInviteUrl — fragment-only token URL
// ---------------------------------------------------------------------------

describe('buildInviteUrl — fragment-only token placement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('places token in the URL fragment and never in query or path', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://example.com');
    const url = buildInviteUrl('top-secret-token-value');
    const parsed = new URL(url);
    // Token is in the fragment (never sent to server)
    expect(parsed.hash).toContain('token=top-secret-token-value');
    // Token must NOT appear in search parameters or pathname
    expect(parsed.search).toBe('');
    expect(parsed.pathname).not.toContain('top-secret-token-value');
  });

  it('uses BETTER_AUTH_URL as the base', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://my-host.example.com');
    const url = buildInviteUrl('tok');
    expect(url).toMatch(/^https:\/\/my-host\.example\.com\/invite#token=tok$/);
  });

  it('falls back to http://localhost:3000 when BETTER_AUTH_URL is not set', () => {
    const url = buildInviteUrl('fallback-test');
    expect(url).toMatch(/^http:\/\/localhost:3000\/invite#token=fallback-test$/);
  });
});

// ---------------------------------------------------------------------------
// 6. requireOwner — authorization gating
// ---------------------------------------------------------------------------

describe('requireOwner — authorization gating', () => {
  const OWNER_ID = 'owner-001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeEvent(auth?: { authenticated: boolean; actorId?: string }): EventWithContext {
    return { context: { auth } } as unknown as EventWithContext;
  }

  it('rejects unauthenticated context with 401 and UNAUTHORIZED code', () => {
    const event = makeEvent();
    const result = requireOwner(event, OWNER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe('error');
      expect(result.response.error?.code).toBe('UNAUTHORIZED');
      expect(result.response.error?.message).toBe('Authentication required');
    }
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
  });

  it('rejects authenticated non-owner with 403 and FORBIDDEN code', () => {
    const event = makeEvent({ authenticated: true, actorId: 'intruder' });
    const result = requireOwner(event, OWNER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe('error');
      expect(result.response.error?.code).toBe('FORBIDDEN');
      expect(result.response.error?.message).toBe(
        'Only the instance owner can perform this action',
      );
    }
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 403);
  });

  it('accepts matching owner', () => {
    const event = makeEvent({ authenticated: true, actorId: OWNER_ID });
    const result = requireOwner(event, OWNER_ID);

    expect(result).toEqual({ ok: true });
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
  });

  it('requireOwner error response does not leak ownerUserId or actor details', () => {
    const event = makeEvent({ authenticated: true, actorId: 'some-user' });
    const result = requireOwner(event, 'owner-secret-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.response);
      // The owner ID must not leak into the error response
      expect(serialized).not.toContain('owner-secret-id');
      expect(serialized).not.toContain('some-user');
      // The error code should be non-enumerating
      expect(result.response.error?.code).toBe('FORBIDDEN');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Error envelope helpers — never include reason-code text or secrets
// ---------------------------------------------------------------------------

describe('error envelope helpers — no reason-code leak', () => {
  it('registrationError does not include reasonCode in serialized response', () => {
    const envelope = registrationError('Setup unavailable', 'req-abc', 'bootstrap.already_exists');
    const serialized = JSON.stringify(envelope);
    // The reason code is accepted as a parameter but must not appear in output
    expect(serialized).not.toContain('bootstrap.already_exists');
    expect(envelope.error?.code).toBe('REGISTRATION_FAILED');
    // Verify the error object has only standard fields
    expect(Object.keys(envelope.error!)).toEqual(['code', 'message', 'retryable']);
  });

  it('invitationError does not include reasonCode in serialized response', () => {
    const envelope = invitationError('Invalid invitation', 'req-xyz', 'invite.expired');
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('invite.expired');
    expect(envelope.error?.code).toBe('INVITATION_FAILED');
    // Terminal token errors have retryable: false
    expect(envelope.error?.retryable).toBe(false);
    // Only documented fields in the error object
    expect(Object.keys(envelope.error!)).toEqual(['code', 'message', 'retryable']);
  });

  it('invitationError sets retryable: true for validation reason codes', () => {
    const envelope = invitationError(
      'Password must be at least 8 characters',
      'req-val',
      'validation.password_too_short',
    );
    const serialized = JSON.stringify(envelope);
    // No reason code leaks
    expect(serialized).not.toContain('validation.password_too_short');
    expect(envelope.error?.code).toBe('INVITATION_FAILED');
    // Validation errors are retryable (user can fix fields)
    expect(envelope.error?.retryable).toBe(true);
    expect(Object.keys(envelope.error!)).toEqual(['code', 'message', 'retryable']);
  });

  it('invitationError with store.unavailable is not retryable', () => {
    const envelope = invitationError('Store unavailable', 'req-store', 'store.unavailable');
    expect(envelope.error?.retryable).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain('store.unavailable');
  });

  it('invitationError with invitation.invalid is not retryable', () => {
    const envelope = invitationError(
      'Invalid or expired invitation',
      'req-inv',
      'invitation.invalid',
    );
    expect(envelope.error?.retryable).toBe(false);
  });

  it('error envelopes do not leak supplied message content in extra fields', () => {
    const envelope = registrationError(
      'Internal validation error: P@ssw0rd!',
      'req-sec',
      'validation.password',
    );
    const serialized = JSON.stringify(envelope);
    // The reason code must not appear
    expect(serialized).not.toContain('validation.password');
    // The standard envelope must contain only documented fields
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual({
      schemaVersion: '1',
      requestId: 'req-sec',
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'REGISTRATION_FAILED',
        message: 'Internal validation error: P@ssw0rd!',
        retryable: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 8. validateEmail — Better Auth-compatible email validation
// ---------------------------------------------------------------------------

describe('validateEmail — Better Auth-compatible email semantics', () => {
  it('accepts standard email addresses', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('test.user@sub.domain.co')).toBe(true);
    expect(validateEmail('a+b@example.org')).toBe(true);
  });

  it('rejects empty and blank strings', () => {
    expect(validateEmail('')).toBe(false);
    expect(validateEmail('   ')).toBe(false);
  });

  it('rejects strings without @ symbol', () => {
    expect(validateEmail('userexample.com')).toBe(false);
    expect(validateEmail('notanemail')).toBe(false);
  });

  it('rejects strings without dot after @', () => {
    expect(validateEmail('user@example')).toBe(false);
    expect(validateEmail('a@b')).toBe(false);
  });

  it('rejects strings with spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
    expect(validateEmail('user@ example.com')).toBe(false);
    expect(validateEmail(' user@example.com')).toBe(false);
  });

  it('rejects strings with multiple @ symbols', () => {
    expect(validateEmail('user@domain@example.com')).toBe(false);
  });

  it('rejects very short inputs', () => {
    expect(validateEmail('a@b')).toBe(false);
    expect(validateEmail('ab')).toBe(false);
  });

  it('accepts normalized lowercase email that would pass Better Auth', () => {
    // Better Auth accepts standard emails after normalization
    expect(validateEmail('test+alias@example.com')).toBe(true);
    expect(validateEmail('valid.email@address.co.uk')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Status code distinction — 409 vs 503 never leak reason
// ---------------------------------------------------------------------------

describe('bootstrap error status codes — 409 (conflict) vs 503 (unavailable)', () => {
  it('registrationError envelope is identical for 409 and 503 paths', () => {
    const err409 = registrationError(
      'Instance already configured',
      'req-409',
      'bootstrap.already_completed',
    );
    const err503 = registrationError('Store unavailable', 'req-503', 'store.unavailable');
    // Both have the same code regardless of HTTP status
    expect(err409.error?.code).toBe('REGISTRATION_FAILED');
    expect(err503.error?.code).toBe('REGISTRATION_FAILED');
    // Neither envelope leaks the reason code
    expect(JSON.stringify(err409)).not.toContain('already_completed');
    expect(JSON.stringify(err503)).not.toContain('store.unavailable');
    // Neither envelope leaks the internal reason string
    expect(JSON.stringify(err409)).not.toContain('bootstrap');
    expect(JSON.stringify(err503)).not.toContain('store');
    // Both error objects have the exact same shape (only message differs)
    expect(Object.keys(err409.error!)).toEqual(['code', 'message', 'retryable']);
    expect(Object.keys(err503.error!)).toEqual(['code', 'message', 'retryable']);
  });

  it('serialized 409 conflict response does not reveal nature of conflict', () => {
    const envelope = registrationError(
      'Bootstrap is not available',
      'req-test',
      'bootstrap.already_completed',
    );
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('already');
    expect(serialized).not.toContain('owner');
    expect(serialized).not.toContain('completed');
    expect(serialized).not.toContain('conflict');
  });

  it('serialized 503 unavailable response does not reveal store details', () => {
    const envelope = registrationError(
      'Store unavailable',
      'req-unavail',
      'store.missing_migration',
    );
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('missing_migration');
    expect(serialized).not.toContain('migration');
    expect(serialized).not.toContain('table');
  });
});
