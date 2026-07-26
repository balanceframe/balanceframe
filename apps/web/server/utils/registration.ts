/**
 * Registration and invitation lifecycle helpers for self-hosted BalanceFrame.
 *
 * These utilities bridge the workflow-store and Better Auth layers.
 * The registration- and invitation- specific store methods are typed locally
 * here; they will be promoted to {@link WorkflowStore} in a future change.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import type { EventWithContext, ApiEnvelope, ApiError, AuthorizationInfo } from './workflow-store';
import { resolveBootstrapSecret, BootstrapSecretError } from '../../lib/resolve-bootstrap-secret';

// ---------------------------------------------------------------------------
// Registration state
// ---------------------------------------------------------------------------

/** The singleton registration state row. */
export interface RegistrationState {
  ownerUserId: string;
  bootstrappedAt: string;
}

/** Mode reported to the UI. */
export type RegistrationMode = 'bootstrap' | 'invite';

// ---------------------------------------------------------------------------
// Invitation types
// ---------------------------------------------------------------------------

/** Invitation status lifecycle. */
export type InvitationStatus = 'active' | 'claimed' | 'redeemed' | 'revoked' | 'expired';

/** Invitation record as stored and listed. */
export interface InvitationRecord {
  id: string;
  status: InvitationStatus;
  createdByUserId: string;
  expiresAt: string;
  claimedEmail: string | null;
  claimId: string | null;
  redeemedUserId: string | null;
  createdAt: string;
  claimedAt: string | null;
  redeemedAt: string | null;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise an email address: lowercase + trim. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Email regex matching Better Auth's built-in validation semantics. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate an email address with Better Auth-compatible semantics.
 * Must be called after normalizeEmail (lowercased, trimmed).
 * Returns true only for addresses that Better Auth's createUser would accept.
 */
export function validateEmail(email: string): boolean {
  if (!email || email.length < 3) return false;
  return EMAIL_REGEX.test(email);
}

/** Generate a 32-byte random token and return both raw and hex-encoded forms. */
export function generateInviteToken(): { raw: string; hex: string; digest: string } {
  const raw = randomBytes(32);
  const hex = raw.toString('hex');
  const digest = createHash('sha256').update(raw).digest('hex');
  return { raw: hex, hex, digest };
}

/** Compute the sha256 hex digest of a raw token string. */
export function tokenDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Build an invite URL using the BETTER_AUTH_URL base. */
export function buildInviteUrl(rawToken: string): string {
  const base = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
  const normalized = base.replace(/\/+$/, '');
  return `${normalized}/invite#token=${rawToken}`;
}

/** Default invitation lifetime in milliseconds (7 days). */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Bootstrap secret loading
// ---------------------------------------------------------------------------

export interface BootstrapSecretResult {
  available: true;
  secret: string;
}

export type BootstrapSecretLoad =
  | BootstrapSecretResult
  | { available: false; reason: string };

/**
 * Resolve the bootstrap operator secret.
 *
 * Precedence:
 *   1. BALANCEFRAME_BOOTSTRAP_SECRET_FILE  — read file, trim final newline
 *   2. BALANCEFRAME_BOOTSTRAP_SECRET       — inline env var
 * If both are set, return an error.
 * If neither is set, return available=false.
 * The secret MUST be at least 32 characters (best-effort entropy guard).
 */
export function loadBootstrapSecret(): BootstrapSecretLoad {
  try {
    const result = resolveBootstrapSecret();
    return { available: true, secret: result.secret };
  } catch (err) {
    if (err instanceof BootstrapSecretError) {
      return { available: false, reason: err.message };
    }
    return { available: false, reason: 'Unexpected error loading bootstrap secret' };
  }
}

/**
 * Timing-safe comparison of the provided secret against the loaded secret.
 */
export function verifyBootstrapSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Non-enumerating error for generic registration failures. */
export function registrationError(
  message: string,
  requestId: string,
  reasonCode: string,
): ApiEnvelope<null> {
  return {
    schemaVersion: '1',
    requestId,
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: {
      code: 'REGISTRATION_FAILED',
      message,
      retryable: false,
    },
  };
}
/** Non-enumerating error for invitation failures. */
export function invitationError(
  message: string,
  requestId: string,
  reasonCode: string,
): ApiEnvelope<null> {
  // reason codes starting with 'validation.' represent user-correctable field
  // errors; all others (token/store/identity failures) are terminal.
  const retryable = reasonCode.startsWith('validation.');
  return {
    schemaVersion: '1',
    requestId,
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: {
      code: 'INVITATION_FAILED',
      message,
      retryable,
    },
  };
}

// ---------------------------------------------------------------------------
// Owner check
// ---------------------------------------------------------------------------

/**
 * Check whether the authenticated actor in the event context is the owner.
 * Returns an error envelope (with status already set) when not owner.
 */
export function requireOwner(event: EventWithContext, ownerUserId: string): { ok: true } | { ok: false; response: ApiEnvelope<null> } {
  const ctx = event.context.auth;
  if (!ctx?.authenticated) {
    setResponseStatus(event as unknown as H3Event, 401);
    return {
      ok: false,
      response: {
        schemaVersion: '1',
        requestId: crypto.randomUUID(),
        status: 'error',
        dataFreshness: null,
        authorization: null,
        result: null,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          retryable: false,
        },
      },
    };
  }

  if (ctx.actorId !== ownerUserId) {
    setResponseStatus(event as unknown as H3Event, 403);
    return {
      ok: false,
      response: {
        schemaVersion: '1',
        requestId: crypto.randomUUID(),
        status: 'error',
        dataFreshness: null,
        authorization: null,
        result: null,
        error: {
          code: 'FORBIDDEN',
          message: 'Only the instance owner can perform this action',
          retryable: false,
        },
      },
    };
  }

  return { ok: true };
}
