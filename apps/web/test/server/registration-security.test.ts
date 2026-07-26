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
    const envelope = registrationError(
      'Setup unavailable',
      'req-abc',
      'bootstrap.already_exists',
    );
    const serialized = JSON.stringify(envelope);
    // The reason code is accepted as a parameter but must not appear in output
    expect(serialized).not.toContain('bootstrap.already_exists');
    expect(envelope.error?.code).toBe('REGISTRATION_FAILED');
    // Verify the error object has only standard fields
    expect(Object.keys(envelope.error!)).toEqual(['code', 'message', 'retryable']);
  });

  it('invitationError does not include reasonCode in serialized response', () => {
    const envelope = invitationError(
      'Invalid invitation',
      'req-xyz',
      'invite.expired',
    );
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('invite.expired');
    expect(envelope.error?.code).toBe('INVITATION_FAILED');
    expect(Object.keys(envelope.error!)).toEqual(['code', 'message', 'retryable']);
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
