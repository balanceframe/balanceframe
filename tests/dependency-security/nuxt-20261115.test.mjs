import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';
const root = process.env.BALANCEFRAME_RESIDUAL_TEST_ROOT || resolve(import.meta.dirname, '../..');
let result;
before(() => {
  const env = { ...process.env, NODE_ENV: 'development', CI: 'true', NUXT_TELEMETRY_DISABLED: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'fixtures/nuxt-20261115.mjs'), root],
    { timeout: 90000, encoding: 'utf8', maxBuffer: 1024 * 1024, env },
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find((value) => value.startsWith('SECURITY_PROBE_RESULT '));
  assert.ok(line, 'owned Nuxt fixture produced observations');
  result = JSON.parse(line.slice('SECURITY_PROBE_RESULT '.length));
});
test('Nuxt dev keeps a settings-only parent outside the file allowlist', () => {
  assert.equal(result.sibling.siblingMarker, false);
  assert.notEqual(result.sibling.status, 200);
});
test('Nuxt rejects raw dot-segment page paths before path-based server checks diverge', () => {
  for (const key of ['dot', 'parent']) {
    assert.notEqual(result[key].status, 200, key);
    assert.equal(result[key].protectedMarker, false, key);
  }
});
test('Nuxt does not reinterpret leading-slash page paths as a different URL', () => {
  for (const key of ['double', 'triple']) {
    assert.notEqual(result[key].status, 200, key);
    assert.equal(result[key].protectedMarker, false, key);
  }
});
test('Nuxt security fixture preserves ordinary pages and the direct middleware denial', () => {
  assert.equal(result.ordinary.status, 200);
  assert.equal(result.ordinary.ordinaryMarker, true);
  assert.equal(result.normal.status, 401);
});

test('Nuxt dev does not disclose its generated app secret', () => {
  assert.equal(result.generated.appSecretNonempty, true);
  assert.notEqual(result.appSecret.status, 200);
});
test('Nuxt dev does not serve the generated bundle containing private runtime config', () => {
  assert.equal(result.generated.devBundlePrivateMarker, true);
  assert.equal(result.devBundle.privateMarker, false);
  assert.notEqual(result.devBundle.status, 200);
});
test('Nuxt client-error reports disable filesystem fallback while retaining the error channel', () => {
  // GHSA-x287-wcfc-q46c: source contract; an HMR runtime exploit is not reproduced here.
  // https://github.com/nuxt/nuxt/security/advisories/GHSA-x287-wcfc-q46c
  const require = createRequire(
    realpathSync(join(root, 'apps/web/node_modules/nuxt/package.json')),
  );
  const source = readFileSync(require.resolve('@nuxt/vite-builder'), 'utf8');
  const start = source.indexOf('async function reportRuntimeError(');
  assert.notEqual(start, -1);
  const indentation = source.slice(0, start).match(/(?:^|\n)([\t ]*)$/)[1];
  const end = source.indexOf('\n' + indentation + '}', start);
  assert.notEqual(end, -1);
  assert.equal(
    /viteLoader\(server,\s*\{\s*fs:\s*false\s*\}\)/.test(source.slice(start, end)),
    true,
  );
  assert.ok(source.includes('"nuxt:dev:client-error"'));
});
