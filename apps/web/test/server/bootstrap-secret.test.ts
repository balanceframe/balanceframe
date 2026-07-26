/**
 * Configuration-contract tests for bootstrap-secret resolution.
 *
 * The resolution logic lives in `lib/resolve-bootstrap-secret.ts` (a pure
 * function with no native-module dependencies) and enforces:
 *   - exactly one of BALANCEFRAME_BOOTSTRAP_SECRET_FILE or
 *     BALANCEFRAME_BOOTSTRAP_SECRET must be set
 *   - file content is trimmed of exactly one terminal newline (LF or CRLF)
 *   - the resolved value is at least 32 characters
 *   - error messages never reveal the secret value
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBootstrapSecret, BootstrapSecretError, validateBootstrapSecretConfig } from '../../lib/resolve-bootstrap-secret';

/** A valid-length secret (32 'a's). */
const VALID_SECRET = 'a'.repeat(32);

/** A too-short secret (31 'b's). */
const SHORT_SECRET = 'b'.repeat(31);

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bootstrap-secret-test-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Env source
// ---------------------------------------------------------------------------

describe('BALANCEFRAME_BOOTSTRAP_SECRET (env source)', () => {
  it('resolves a valid-length secret from the env var', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', VALID_SECRET);

    const result = resolveBootstrapSecret();

    expect(result).toEqual({ secret: VALID_SECRET, source: 'env' });
  });

  it('rejects a secret shorter than 32 characters', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', SHORT_SECRET);

    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);
    expect(() => resolveBootstrapSecret()).toThrow(
      'Bootstrap secret from env must be at least 32 characters',
    );
  });

  it('rejects exactly 31 characters and accepts exactly 32', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', 'x'.repeat(31));
    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);

    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', 'x'.repeat(32));
    expect(resolveBootstrapSecret().secret).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// File source
// ---------------------------------------------------------------------------

describe('BALANCEFRAME_BOOTSTRAP_SECRET_FILE (file source)', () => {
  it('resolves content from a readable file', () => {
    const fp = join(tmpDir, 'valid');
    writeFileSync(fp, VALID_SECRET);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    const result = resolveBootstrapSecret();

    expect(result).toEqual({ secret: VALID_SECRET, source: 'file' });
  });

  it('trims exactly one trailing LF from file content', () => {
    const fp = join(tmpDir, 'lf-trim');
    writeFileSync(fp, `${VALID_SECRET}\n`);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    expect(resolveBootstrapSecret().secret).toBe(VALID_SECRET);
  });

  it('trims exactly one trailing CRLF from file content', () => {
    const fp = join(tmpDir, 'crlf-trim');
    writeFileSync(fp, `${VALID_SECRET}\r\n`);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    expect(resolveBootstrapSecret().secret).toBe(VALID_SECRET);
  });

  it('preserves embedded newlines within file content', () => {
    const fp = join(tmpDir, 'embedded-lf');
    const embedded = `${VALID_SECRET.slice(0, 16)}\n${VALID_SECRET.slice(16)}`;
    writeFileSync(fp, embedded);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    // Embedded newline is part of the content, not trimmed.
    expect(resolveBootstrapSecret().secret).toBe(embedded);
  });

  it('preserves trailing spaces and other non-newline whitespace', () => {
    const fp = join(tmpDir, 'trailing-space');
    const content = `${VALID_SECRET}  \t`;
    writeFileSync(fp, content);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    expect(resolveBootstrapSecret().secret).toBe(content);
  });

  it('trims only one of multiple trailing newlines', () => {
    const fp = join(tmpDir, 'multi-lf');
    // Two trailing LFs → first is trimmed, second is preserved.
    const content = `${VALID_SECRET}\n\n`;
    writeFileSync(fp, content);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    expect(resolveBootstrapSecret().secret).toBe(`${VALID_SECRET}\n`);
  });

  it('trims only one CRLF when multiple CRLF pairs trail', () => {
    const fp = join(tmpDir, 'multi-crlf');
    const content = `${VALID_SECRET}\r\n\r\n`;
    writeFileSync(fp, content);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    // First \r\n is fully consumed.  Remaining \r\n is preserved.
    expect(resolveBootstrapSecret().secret).toBe(`${VALID_SECRET}\r\n`);
  });

  it('rejects file content shorter than 32 characters', () => {
    const fp = join(tmpDir, 'short-file');
    writeFileSync(fp, SHORT_SECRET);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);

    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);
    expect(() => resolveBootstrapSecret()).toThrow(
      'Bootstrap secret from file must be at least 32 characters',
    );
  });

  it('rejects a missing file', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', '/nonexistent/bootstrap/secret.txt');

    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);
    expect(() => resolveBootstrapSecret()).toThrow(/Cannot read BALANCEFRAME_BOOTSTRAP_SECRET_FILE/);
  });

  it('rejects a directory used as a file path', () => {
    const dirPath = join(tmpDir, 'adir');
    mkdirSync(dirPath, { recursive: true });
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', dirPath);

    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);
    expect(() => resolveBootstrapSecret()).toThrow(/Cannot read BALANCEFRAME_BOOTSTRAP_SECRET_FILE/);
  });
});

// ---------------------------------------------------------------------------
// Exactly-one validation
// ---------------------------------------------------------------------------

describe('exactly-one-source enforcement', () => {
  it('rejects when both env vars are set', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', VALID_SECRET);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', '/some/path');

    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);
    expect(() => resolveBootstrapSecret()).toThrow(
      'Both BALANCEFRAME_BOOTSTRAP_SECRET_FILE and BALANCEFRAME_BOOTSTRAP_SECRET are set',
    );
  });

  it('rejects when neither env var is set', () => {
    // Both env vars are intentionally left unset.
    expect(() => resolveBootstrapSecret()).toThrow(BootstrapSecretError);
    expect(() => resolveBootstrapSecret()).toThrow(
      'Neither BALANCEFRAME_BOOTSTRAP_SECRET_FILE nor BALANCEFRAME_BOOTSTRAP_SECRET is set',
    );
  });
});

// ---------------------------------------------------------------------------
// Error safety — no secret value in messages
// ---------------------------------------------------------------------------

describe('error messages do not leak secret values', () => {
  it('does not include secret content in "both set" error', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', 'super-secret-value-here-12345678');
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', '/some/file');

    try {
      resolveBootstrapSecret();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('super-secret-value');
      // Only the env-var names appear.
      expect(msg).toContain('BALANCEFRAME_BOOTSTRAP_SECRET_FILE');
      expect(msg).toContain('BALANCEFRAME_BOOTSTRAP_SECRET');
    }
  });

  it('does not include secret content in "too short" error', () => {
    const weakSecret = 'short';
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', weakSecret);

    try {
      resolveBootstrapSecret();
    } catch (e) {
      const msg = (e as Error).message;
      // The word "secret" appears in the error message as part of the
      // env-var description, but the *actual value* must never appear.
      expect(msg).not.toContain(weakSecret);
      // Message mentions the length, not the content.
      expect(msg).toMatch(/at least 32 characters/);
    }
  });

  it('does not include secret content in file-related errors', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', '/nonexistent/file');

    try {
      resolveBootstrapSecret();
    } catch (e) {
      const msg = (e as Error).message;
      // The actual file path IS mentioned (for debugging), but no secret value.
      expect(msg).toContain('/nonexistent/file');
      expect(msg).toContain('BALANCEFRAME_BOOTSTRAP_SECRET_FILE');
    }
  });
});

// ---------------------------------------------------------------------------
// Startup validation — validates config at server init, missing source is OK
// ---------------------------------------------------------------------------

describe('validateBootstrapSecretConfig — startup validation', () => {
  it('does not throw when a valid env var is set', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', VALID_SECRET);
    expect(() => validateBootstrapSecretConfig()).not.toThrow();
  });

  it('does not throw when a valid file source is configured', () => {
    const fp = join(tmpDir, 'startup-valid-file');
    writeFileSync(fp, VALID_SECRET);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', fp);
    expect(() => validateBootstrapSecretConfig()).not.toThrow();
  });

  it('does not throw when neither source is set (instance may already be bootstrapped)', () => {
    expect(() => validateBootstrapSecretConfig()).not.toThrow();
  });

  it('throws when both sources are set (ambiguous configuration)', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', VALID_SECRET);
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', '/some/path');
    expect(() => validateBootstrapSecretConfig()).toThrow(BootstrapSecretError);
    expect(() => validateBootstrapSecretConfig()).toThrow(
      'Both BALANCEFRAME_BOOTSTRAP_SECRET_FILE and BALANCEFRAME_BOOTSTRAP_SECRET are set',
    );
  });

  it('throws when the configured file is unreadable', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', '/nonexistent/bootstrap/startup-secret.txt');
    expect(() => validateBootstrapSecretConfig()).toThrow(BootstrapSecretError);
    expect(() => validateBootstrapSecretConfig()).toThrow(/Cannot read BALANCEFRAME_BOOTSTRAP_SECRET_FILE/);
  });

  it('throws when the resolved secret is shorter than 32 characters', () => {
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET', SHORT_SECRET);
    expect(() => validateBootstrapSecretConfig()).toThrow(BootstrapSecretError);
    expect(() => validateBootstrapSecretConfig()).toThrow(
      'Bootstrap secret from env must be at least 32 characters',
    );
  });

  it('throws when a directory is used as a file source', () => {
    const dirPath = join(tmpDir, 'startup-isdir');
    mkdirSync(dirPath, { recursive: true });
    vi.stubEnv('BALANCEFRAME_BOOTSTRAP_SECRET_FILE', dirPath);
    expect(() => validateBootstrapSecretConfig()).toThrow(BootstrapSecretError);
    expect(() => validateBootstrapSecretConfig()).toThrow(/Cannot read BALANCEFRAME_BOOTSTRAP_SECRET_FILE/);
  });
});
