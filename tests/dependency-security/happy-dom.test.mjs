import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const webRequire = createRequire(resolve(import.meta.dirname, '../../apps/web/package.json'));

test('web resolves the fixed Happy DOM release', () => {
  assert.equal(webRequire('happy-dom/package.json').version, '21.0.4');
});

for (const scenario of ['import-binding', 'ordinary-module', 'default-resources', 'opaque-iframe', 'inherited-iframe']) {
  test(`Happy DOM preserves ${scenario} security and compatibility`, () => {
    const child = spawnSync(process.execPath, [
      '--max-old-space-size=128', resolve(import.meta.dirname, 'fixtures/happy-dom.mjs'),
      webRequire.resolve('happy-dom'), scenario,
    ], { timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), `${scenario}: passed`);
  });
}
