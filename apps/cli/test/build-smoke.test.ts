/**
 * Build & executable smoke test.
 *
 * Verifies that the compiled CLI entrypoint (`bin/cli.js`) runs without
 * module-resolution failures after a clean build of its workspace dependencies.
 */
import { describe, it, expect } from 'vitest';
import { execSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
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
      // The smoke environment need not have a trusted authenticated server;
      // command handling must still return the standard error envelope.
      expect(parsed.status).toBe('error');
      expect(parsed.error).toHaveProperty('code');
    },
  );

  it('dispatches merchant evidence from the executable with exact Money and server identity', async () => {
    const money = { minorUnits: '9223372036854775807', currency: 'JPY' };
    const requests: Array<{ url: string | undefined; space: string | string[] | undefined; credential: string | undefined }> = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, space: req.headers['x-balanceframe-space'], credential: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ schemaVersion: '1', requestId: 'merchant-process', status: 'ok', dataFreshness: null, authorization: { actorId: 'server-actor', capability: 'merchant:analyze', allowed: true }, result: { money }, error: null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server');
      const result = await promisify(execFile)(process.execPath, [CLI_BIN, 'merchant', 'evidence', '--transaction-id', 'tx-leaf', '--json'], {
        env: { ...process.env, BALANCEFRAME_SERVER_URL: `http://127.0.0.1:${address.port}`, BALANCEFRAME_SPACE_ID: 'selected-space', BALANCEFRAME_API_KEY: 'process-key', BALANCEFRAME_ACTOR_ID: 'forged-actor', BALANCEFRAME_SESSION_COOKIE: '' },
      });
      const output = JSON.parse(result.stdout);
      expect(output.result.money).toEqual(money);
      expect(output.authorization.actorId).toBe('server-actor');
      expect(requests).toEqual([{ url: '/api/merchant?transactionId=tx-leaf', space: 'selected-space', credential: 'Bearer process-key' }]);
      expect(result.stderr).toBe('');
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it('keeps preview, consented send and human space policy separate across real executable invocations', async () => {
    const revision = 'a'.repeat(64);
    const token = 'b'.repeat(64);
    const requests: Array<{ url: string | undefined; method: string | undefined; origin: string | undefined; auth: string | undefined; cookie: string | undefined; space: string | undefined; body: unknown }> = [];
    const preview = { status: 'ready', previewToken: token, merchant: 'Northstar Public Bakery', locale: null, providerId: 'valueserp', providerVersion: 'valueserp-search/1', evidenceKey: 'merchant:transaction:tx-leaf', evidenceRevision: revision, expiresAt: '2026-10-04T12:05:00.000Z', fieldsSent: ['merchant', 'locale'], disclosure: 'Separate external search; provider retention unknown; sent requests cannot be recalled.', maxCostAtoms: '125000', billingCurrency: 'USD' };
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      requests.push({ url: req.url, method: req.method, origin: req.headers.origin, auth: req.headers.authorization, cookie: req.headers.cookie, space: String(req.headers['x-balanceframe-space']), body: body ? JSON.parse(body) : undefined });
      const result = req.url === '/api/merchant/research/preview' ? preview : { status: 'failed', code: 'timeout', billing: 'uncertain' };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ schemaVersion: '1', requestId: 'research-process', status: 'ok', dataFreshness: null, authorization: { actorId: 'server-actor', capability: 'merchant:research', allowed: true }, result, error: null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server');
      const origin = `http://127.0.0.1:${address.port}`;
      const env = { ...process.env, BALANCEFRAME_SERVER_URL: origin, BALANCEFRAME_SPACE_ID: 'selected-space', BALANCEFRAME_API_KEY: 'process-key', BALANCEFRAME_ACTOR_ID: 'forged-actor', BALANCEFRAME_SESSION_COOKIE: '' };
      const query = ['--evidence-key', preview.evidenceKey, '--evidence-revision', revision, '--merchant', preview.merchant, '--public-business', 'true'];
      const invoke = async (args: string[]) => {
        const output = await promisify(execFile)(process.execPath, [CLI_BIN, ...args, '--json'], { env });
        expect(output.stderr).toBe('');
        return JSON.parse(output.stdout);
      };
      expect((await invoke(['merchant', 'research', 'preview', ...query])).result).toEqual(preview);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: '/api/merchant/research/preview', method: 'POST', origin, auth: 'Bearer process-key', space: 'selected-space', body: { merchant: preview.merchant, locale: null, publicBusiness: true, evidenceKey: preview.evidenceKey, evidenceRevision: revision } });
      expect((await invoke(['merchant', 'research', 'send', ...query, '--preview-token', token, '--idempotency-key', 'operation-one'])).status).toBe('error');
      expect((await invoke(['merchant', 'research', 'preview', ...query, '--provider-id', 'forged'])).status).toBe('error');
      expect((await invoke(['merchant', 'space-policy', 'set', '--expected-version', '0', '--policy', '{}'])).error.code).toBe('human_session_required');
      expect(requests).toHaveLength(1);
      expect((await invoke(['merchant', 'research', 'send', ...query, '--preview-token', token, '--consent', 'true', '--idempotency-key', 'operation-one'])).result).toEqual({ status: 'failed', code: 'timeout', billing: 'uncertain' });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ url: '/api/merchant/research', method: 'POST', origin, body: { previewToken: token, consent: true, idempotencyKey: 'operation-one' } });
      expect(JSON.stringify(requests)).not.toContain('forged-actor');
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it('shows separate research consent and human policy usage without credentials or contacting a server', async () => {
    const result = await promisify(execFile)(process.execPath, [CLI_BIN, 'merchant', '--help'], {
      env: { ...process.env, BALANCEFRAME_SERVER_URL: '', BALANCEFRAME_API_KEY: '', BALANCEFRAME_SESSION_COOKIE: '', BALANCEFRAME_SPACE_ID: '' },
    });
    expect(result.stdout).toContain('merchant research preview');
    expect(result.stdout).toContain('merchant research send');
    expect(result.stdout).toContain('--public-business true');
    expect(result.stdout).toContain('--preview-token TOKEN --consent true --idempotency-key ID');
    expect(result.stdout).toContain('merchant space-policy set');
    expect(result.stdout).toContain('fresh human session');
    expect(result.stderr).toBe('');
  });
});
