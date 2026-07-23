/**
 * Tests for error sanitization across rule/proposal/review API routes.
 *
 * Verifies:
 * - sanitizeErrorMessage strips filesystem paths, source references,
 *   adapter-internal details, and stack frames
 * - sanitizeError logs full details with correlation ID
 * - Error responses from route handlers never contain internal paths
 *   or adapter internals in the error.message field
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sanitizeErrorMessage,
  sanitizeError,
  errorEnvelope,
} from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// Pure function: sanitizeErrorMessage
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage', () => {
  it('strips Unix filesystem paths from error messages', () => {
    const raw = 'ENOENT: no such file or directory, open \'/home/user/.config/balanceframe/data.db\'';
    expect(sanitizeErrorMessage(raw)).not.toMatch(/\/home\/user/);
    expect(sanitizeErrorMessage(raw)).not.toMatch(/\.config\/balanceframe/);
    expect(sanitizeErrorMessage(raw)).not.toMatch(/data\.db/);
    expect(sanitizeErrorMessage(raw)).not.toMatch(/\/[^\s]+\/[^\s]+/);
  });

  it('strips Windows filesystem paths from error messages', () => {
    const raw = 'Error: Cannot find module \'C:\\Users\\admin\\AppData\\Local\\balanceframe\\config.json\'';
    expect(sanitizeErrorMessage(raw)).not.toMatch(/C:\\Users/);
    expect(sanitizeErrorMessage(raw)).not.toMatch(/AppData/);
    expect(sanitizeErrorMessage(raw)).not.toMatch(/\\\\/);
  });

  it('removes V8 stack-frame trailers', () => {
    const raw = "Cannot read properties of undefined (reading 'name')\n    at Object.<anonymous> (/app/node_modules/something/index.js:42:10)";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain('at Object.<anonymous>');
    expect(sanitized).not.toContain('/app/node_modules');
    expect(sanitized).not.toContain('index.js:42');
  });

  it('removes inline source references like (file.ts:42)', () => {
    const raw = "BudgetLedger.deleteRule failed (ledger.ts:120)";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain('ledger.ts');
    expect(sanitized).not.toContain(':120');
  });

  it('strips error-type prefixes', () => {
    const raw = "TypeError: network connection refused";
    expect(sanitizeErrorMessage(raw)).not.toContain('TypeError:');
    expect(sanitizeErrorMessage(raw)).toContain('network connection refused');
  });

  it('removes internal adapter/component names in parens', () => {
    const raw = "Connection failed (ActualLedger)";
    expect(sanitizeErrorMessage(raw)).not.toContain('ActualLedger');
  });

  it('collapses internal class.method references', () => {
    const raw = "ActualLedger.deleteRule threw an unexpected error";
    expect(sanitizeErrorMessage(raw)).not.toMatch(/ActualLedger\.deleteRule/);
  });

  it('returns fallback for a completely sanitized-away message', () => {
    expect(sanitizeErrorMessage('/home/user/file.ts')).toBe('An unexpected error occurred.');
    expect(sanitizeErrorMessage('')).toBe('An unexpected error occurred.');
  });

  it('preserves user-safe text without paths or source details', () => {
    const raw = 'Rule not found: missing-id';
    expect(sanitizeErrorMessage(raw)).toBe('Rule not found: missing-id');
  });

  it('preserves version conflict messages (safe)', () => {
    const raw = 'Version conflict: expected version 3 but current version is 4';
    expect(sanitizeErrorMessage(raw)).toBe('Version conflict: expected version 3 but current version is 4');
  });
});

// ---------------------------------------------------------------------------
// Pure function: sanitizeError
// ---------------------------------------------------------------------------

describe('sanitizeError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns a SanitizedError with code, message, and retryable', () => {
    const result = sanitizeError(new Error('test error'), 'req-001', 'TEST_CODE', true);
    expect(result).toHaveProperty('code', 'TEST_CODE');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('retryable', true);
  });

  it('logs the full error details with correlation ID to console.error', () => {
    const spy = vi.spyOn(console, 'error');
    const err = new Error('something broke deep inside');
    sanitizeError(err, 'req-abc-123', 'RULE_DELETE_FAILED', true);

    expect(spy).toHaveBeenCalledTimes(1);
    const [logged] = spy.mock.calls[0];
    expect(logged).toContain('[req-abc-123]');
    expect(logged).toContain('RULE_DELETE_FAILED');
    expect(logged).toContain('something broke deep inside');
  });

  it('logs stack trace when the error has one', () => {
    const spy = vi.spyOn(console, 'error');
    const err = new Error('with stack');
    sanitizeError(err, 'req-2', 'CODE');

    expect(spy).toHaveBeenCalledTimes(1);
    const [logged] = spy.mock.calls[0];
    expect(logged).toContain(err.stack);
  });

  it('handles non-Error thrown values gracefully', () => {
    const result = sanitizeError('string error', 'req-3', 'CODE', false);
    expect(result.code).toBe('CODE');
    expect(result.message).toBeDefined();
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: error envelope + sanitizeError produce no leaking output
// ---------------------------------------------------------------------------

describe('error response contains no internal details', () => {
  it('errorEnvelope with sanitizeError output has no filesystem paths in message', () => {
    const err = new Error(
      "ENOENT: open '/var/data/balanceframe/budget.db' failed",
    );
    const safe = sanitizeError(err, 'req-int-1', 'LEDGER_UNAVAILABLE', true);
    // Build the envelope the same way handlers do
    const envelope = errorEnvelope(safe.code, safe.message, null, safe.retryable, 'req-int-1');

    // The error field in the envelope must not contain filesystem patterns
    expect(envelope.error?.message).toBeDefined();
    expect(envelope.error?.message).not.toMatch(/\/var\/data/);
    expect(envelope.error?.message).not.toMatch(/budget\.db/);
    expect(envelope.error?.message).not.toMatch(/\.json/);
  });

  it('errorEnvelope with sanitizeError output has no stack frames in message', () => {
    const err = new Error(
      "Cannot read properties of undefined\n    at BudgetLedger.deleteRule (/app/src/adapter/ledger.ts:42:10)",
    );
    const safe = sanitizeError(err, 'req-int-2', 'RULE_DELETE_FAILED', true);
    const envelope = errorEnvelope(safe.code, safe.message, null, safe.retryable, 'req-int-2');

    expect(envelope.error?.message).toBeDefined();
    expect(envelope.error?.message).not.toContain('at BudgetLedger.deleteRule');
    expect(envelope.error?.message).not.toContain('/app/src/adapter');
    expect(envelope.error?.message).not.toContain('ledger.ts');
    expect(envelope.error?.message).not.toContain(':42');
  });

  it('errorEnvelope with sanitizeError output has no adapter-internal references', () => {
    const err = new Error("ActualLedger.synchronize timed out after 30000ms (ActualLedger)");
    const safe = sanitizeError(err, 'req-int-3', 'SYNC_FAILED', true);
    const envelope = errorEnvelope(safe.code, safe.message, null, safe.retryable, 'req-int-3');

    expect(envelope.error?.message).not.toMatch(/ActualLedger/);
    expect(envelope.error?.message).not.toMatch(/[A-Z][a-z]+Ledger\./);
  });

  it('errorEnvelope retains the correlation requestId', () => {
    const err = new Error('test');
    const safe = sanitizeError(err, 'req-retain-42', 'RULE_UPDATE_FAILED', true);
    const envelope = errorEnvelope(safe.code, safe.message, null, safe.retryable, 'req-retain-42');

    expect(envelope.requestId).toBe('req-retain-42');
    expect(envelope.error?.code).toBe('RULE_UPDATE_FAILED');
  });
});
