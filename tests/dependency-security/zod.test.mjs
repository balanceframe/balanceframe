import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const webRequire = createRequire(resolve(import.meta.dirname, '../../apps/web/package.json'));
const apiKeyRequire = createRequire(webRequire.resolve('@better-auth/api-key'));

const consumers = [
  ['web', webRequire], ['api-key', apiKeyRequire],
  ...['packages/protocol-generated', 'packages/workflow-store', 'packages/application',
    'packages/actual-adapter', 'packages/inference', 'apps/cli', 'packages/scenario-kit',
    'tests/contract'].map((consumer) => [consumer, createRequire(resolve(import.meta.dirname, `../../${consumer}/package.json`))]),
];

for (const [consumer, require] of consumers) {
  const { z } = require('zod');

  test(`${consumer} resolves the fixed Zod 4 release`, () => {
    assert.equal(require('zod/package.json').version, '4.6.6');
  });

  // Count work rather than relying on timing or constructing a memory-exhaustion payload.
  for (const [kind, collection, values, bounds] of [
    ['array', (item) => z.array(item), (items) => items, ['max', 'length']],
    ['set', (item) => z.set(item), (items) => new Set(items), ['max', 'size']],
    ['map', (item) => z.map(item, item), (items) => new Map(items.map((v) => [v, v])), ['max', 'size']],
  ]) {
    test(`${consumer} rejects oversized ${kind} before parsing items or refining the collection`, () => {
      for (const bound of bounds) {
        let parsed = 0;
        let refined = 0;
        const item = z.preprocess((value) => { parsed++; return value; }, z.string());
        const schema = collection(item)[bound](2, 'collection limit').refine(() => { refined++; return true; });
        const result = z.object({ items: schema }).safeParse({ items: values(Array.from({ length: 128 }, (_, i) => i)) });
        assert.equal(result.success, false);
        assert.equal(parsed, 0, `${bound} must precede all item validation`);
        assert.equal(refined, 0);
        assert.equal(result.error.issues.length, 1);
        assert.equal(result.error.issues[0].code, 'too_big');
        assert.equal(result.error.issues[0].message, 'collection limit');
        assert.deepEqual(result.error.issues[0].path, ['items']);
      }
    });

    test(`${consumer} preserves ${kind} boundaries, item errors and input type checks`, () => {
      const schema = collection(z.string()).min(1).max(2);
      for (const items of [['a'], ['a', 'b']]) assert.deepEqual(schema.parse(values(items)), values(items));
      assert.equal(schema.safeParse(values([])).error.issues[0].code, 'too_small');
      assert.equal(schema.safeParse(values(['a', 1])).error.issues[0].code, 'invalid_type');
      assert.equal(schema.safeParse(null).error.issues[0].code, 'invalid_type');
      assert.equal(collection(z.string())[bounds[1]](2).safeParse(values(['a'])).error.issues[0].code, 'too_small');
      // Unbounded collections still report their item failures.
      assert.equal(collection(z.string()).safeParse(values([1, 2])).error.issues.length, kind === 'map' ? 4 : 2);
    });
  }

  test(`${consumer} preserves checks that rewrite the array before enforcing its limit`, () => {
    assert.deepEqual(z.array(z.number()).overwrite((items) => items.slice(0, 2)).max(2).parse([1, 2, 3]), [1, 2]);
  });
}
