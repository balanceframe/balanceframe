import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const webRequire = createRequire(resolve(import.meta.dirname, '../../apps/web/package.json'));
const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
const packagePath = nuxtRequire.resolve('undici');

test('Nuxt resolves the fixed compatible npm Undici release', () => {
  assert.equal(nuxtRequire('undici/package.json').version, '8.12.2');
});

for (const scenario of ['excess-early-close', 'ordinary']) {
  test(`npm Undici fetch survives ${scenario} response handling`, () => {
    // A vulnerable release can emit an unhandled stream error; contain it in an owned child.
    const child = spawnSync(process.execPath, [
      '--max-old-space-size=128', resolve(import.meta.dirname, 'fixtures/undici-fetch.mjs'), packagePath, scenario,
    ], { timeout: 5000, encoding: 'utf8', maxBuffer: 64 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), `${scenario}: passed`);
  });
}
