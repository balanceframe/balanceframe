/**
 * Build & executable smoke test.
 *
 * Verifies that the compiled CLI entrypoint (`bin/cli.js`) runs without
 * module-resolution failures after a clean build of its workspace dependencies.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const CLI_BIN = resolve(__dirname, '../bin/cli.js');

describe('CLI executable path', () => {
  // Build the application dependency and the CLI itself, then verify the
  // executable entrypoint produces a valid JSON envelope.
  it(
    'produces a JSON envelope from `transactions pending-review --json`',
    { timeout: 120_000 },
    () => {
      // 1. Build required workspace packages in dependency order
      execSync('pnpm --filter @balanceframe/application build', {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      execSync('pnpm --filter @balanceframe/cli build', {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      // 2. Run the CLI executable
      const stdout = execSync(
        `node "${CLI_BIN}" transactions pending-review --json`,
        { encoding: 'utf-8' },
      );

      // 3. Must be parseable JSON with envelope structure — not a
      //    module-resolution error or crash.
      const stdoutTrimmed = stdout.trim();
      expect(() => JSON.parse(stdoutTrimmed)).not.toThrow();
      const parsed = JSON.parse(stdoutTrimmed);
      expect(parsed).toHaveProperty('schemaVersion');
      expect(parsed).toHaveProperty('requestId');
      expect(parsed).toHaveProperty('status');
      // An error envelope is expected (no ledger connected), but the
      // important thing is that command handling was reached — not a
      // module-resolution failure.
      expect(parsed.status).toBe('error');
      expect(parsed.error).toHaveProperty('code');
    },
  );
});
