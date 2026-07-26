/**
 * Resolve the bootstrap operator secret from environment configuration.
 *
 * Priority:
 *  1. `BALANCEFRAME_BOOTSTRAP_SECRET_FILE` — path to a file containing the secret
 *  2. `BALANCEFRAME_BOOTSTRAP_SECRET` — inline environment variable
 *
 * Exactly one source must be set.  An error is thrown when both are set, the
 * file is unreadable, or the resolved secret is shorter than 32 characters.
 * Only one terminal newline is trimmed from file content — embedded newlines
 * or multiple trailing blanks are preserved.
 *
 * Safe to import without triggering native module loading (better-sqlite3),
 * so it may be used in tests and server routes alike.
 */

import { readFileSync } from 'node:fs';

export interface ResolveBootstrapSecretResult {
  /** The resolved secret value (never persisted or exposed). */
  secret: string;
  /** Which configuration source produced the secret. */
  source: 'file' | 'env';
}

/**
 * Thrown when bootstrap-secret resolution fails.
 * The message is safe for logging — it enumerates the problem without
 * revealing the secret or its value.
 */
export class BootstrapSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapSecretError';
  }
}

export function resolveBootstrapSecret(): ResolveBootstrapSecretResult {
  const filePath = process.env.BALANCEFRAME_BOOTSTRAP_SECRET_FILE;
  const direct = process.env.BALANCEFRAME_BOOTSTRAP_SECRET;

  // --- exactly-one validation ---
  if (filePath && direct) {
    throw new BootstrapSecretError(
      'Both BALANCEFRAME_BOOTSTRAP_SECRET_FILE and BALANCEFRAME_BOOTSTRAP_SECRET ' +
        'are set.  Configure exactly one.',
    );
  }

  let secret: string;
  let source: 'file' | 'env';

  if (filePath) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new BootstrapSecretError(
        `Cannot read BALANCEFRAME_BOOTSTRAP_SECRET_FILE at "${filePath}": ` +
          `${(err as Error).message}`,
      );
    }

    // Trim only one terminal newline (including \r\n as a single newline).
    if (raw.endsWith('\n')) {
      raw = raw.slice(0, -1);
      // If this was \r\n, strip the \r too.
      if (raw.endsWith('\r')) {
        raw = raw.slice(0, -1);
      }
    }

    secret = raw;
    source = 'file';
  } else if (direct) {
    secret = direct;
    source = 'env';
  } else {
    throw new BootstrapSecretError(
      'Neither BALANCEFRAME_BOOTSTRAP_SECRET_FILE nor ' +
        'BALANCEFRAME_BOOTSTRAP_SECRET is set.  Configure exactly one.',
    );
  }

  // --- minimum length ---
  if (secret.length < 32) {
    throw new BootstrapSecretError(
      `Bootstrap secret from ${source} must be at least 32 characters ` +
        `(got ${secret.length}).`,
    );
  }

  return { secret, source };
}

/**
 * Validate bootstrap-secret configuration for server startup.
 *
 * Unlike {@link resolveBootstrapSecret}, this function treats a missing
 * source (neither env var set) as acceptable — the instance may already
 * be bootstrapped. All other configuration errors (ambiguous sources,
 * unreadable file, too-short secret) still throw {@link BootstrapSecretError},
 * causing the server to fail closed during initialization.
 *
 * Safe to call at server startup — has no side effects and does not
 * require native module loading.
 */
export function validateBootstrapSecretConfig(): void {
  try {
    resolveBootstrapSecret();
  } catch (err) {
    if (err instanceof BootstrapSecretError && err.message.includes('Neither')) {
      // Missing source is acceptable — instance may already be bootstrapped.
      return;
    }
    throw err;
  }
}
