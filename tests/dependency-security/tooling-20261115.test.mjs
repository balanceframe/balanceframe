import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = process.env.BALANCEFRAME_TOOLING_TEST_ROOT || resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'node_modules/.pnpm/node_modules/security-probe.cjs'));
const deepmergeDirectory = dirname(require.resolve('deepmerge/package.json'));

for (const entry of ['dist/cjs.js', 'dist/umd.js']) {
  const merge = require(join(deepmergeDirectory, entry));
  const hostile = () => JSON.parse('{"__proto__":{"securityMarker":true}}');
  const assertPlain = (value) => {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(value.securityMarker, undefined);
    assert.equal(Object.hasOwn(value, '__proto__'), false);
    assert.equal(Object.prototype.securityMarker, undefined);
  };

  test(`deepmerge ${entry} rejects prototype keys with a null-prototype target`, () => {
    assertPlain(merge(Object.create(null), hostile()));
  });

  test(`deepmerge ${entry} rejects prototype keys while cloning a null placeholder`, () => {
    assertPlain(merge({ session: null }, { session: hostile() }).session);
  });

  test(`deepmerge ${entry} rejects prototype keys in the target copy loop`, () => {
    assertPlain(merge(hostile(), { ordinary: true }));
  });

  test(`deepmerge ${entry} rejects prototype keys in cloned array elements`, () => {
    assertPlain(merge([], [hostile()])[0]);
  });

  test(`deepmerge ${entry} preserves ordinary keys, symbols, arrays and custom merges`, () => {
    const symbol = Symbol('ordinary');
    const merged = merge(
      { settings: { enabled: true }, sequence: [1], [symbol]: { left: true } },
      { settings: { count: 2 }, sequence: [2], [symbol]: { right: true } },
    );
    assert.deepEqual(merged.settings, { enabled: true, count: 2 });
    assert.deepEqual(merged.sequence, [1, 2]);
    assert.deepEqual(merged[symbol], { left: true, right: true });
    assert.deepEqual(merge({ session: null }, { session: { ordinary: true } }), {
      session: { ordinary: true },
    });
    assert.deepEqual(
      merge(
        { amount: 2 },
        { amount: 3 },
        {
          isMergeableObject: () => true,
          customMerge: (key) => (key === 'amount' ? (left, right) => left + right : undefined),
        },
      ),
      { amount: 5 },
    );
    const ordinaryNames = merge(Object.create(null), {
      constructor: { prototype: { ordinary: true } },
      prototype: { ordinary: true },
    });
    assert.equal(ordinaryNames.constructor.prototype.ordinary, true);
    assert.deepEqual(ordinaryNames.prototype, { ordinary: true });
    assert.equal(Object.getPrototypeOf(ordinaryNames), Object.prototype);
    assert.equal(Object.prototype.ordinary, undefined);
    const reference = { ordinary: true };
    assert.equal(merge({}, { reference }, { clone: false }).reference, reference);
    const sequence = [3];
    assert.equal(merge([1], sequence, { arrayMerge: (_left, right) => right }), sequence);
    assert.deepEqual(reference, { ordinary: true });
    assert.deepEqual(sequence, [3]);
  });
}

const estreeRequire = createRequire(
  require.resolve('@typescript-eslint/typescript-estree/package.json'),
);
const minimatchDirectory = dirname(estreeRequire.resolve('minimatch/package.json'));
for (const entry of ['dist/commonjs/index.js', 'dist/esm/index.js']) {
  const { Minimatch } = entry.includes('/commonjs/')
    ? require(join(minimatchDirectory, entry))
    : await import(pathToFileURL(join(minimatchDirectory, entry)).href);

  test(`minimatch ${entry} bounds parent-globstar preprocessing at the expansion limit`, () => {
    const pattern = Array(8).fill('**/../a/b').join('/');
    assert.throws(() => new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 8 }), {
      name: 'RangeError',
      message: /too many patterns/,
    });
  });

  test(`minimatch ${entry} avoids pairwise deduplication of large expanded sets`, () => {
    const matcher = new Minimatch('{x,*}/{0..599}', { optimizationLevel: 2 });
    assert.equal(matcher.set.length, 1200);
    assert.equal(matcher.match('x/599'), true);
    assert.equal(matcher.match('y/599'), true);
    assert.equal(matcher.match('x/600'), false);
  });

  test(`minimatch ${entry} bounds copied path cells before allocating split rows`, () => {
    const matcher = new Minimatch('ordinary', { optimizationLevel: 0 });
    const row = Array(8).fill(['**', '..', 'a', 'b']).flat().concat(Array(5000).fill('*'));
    assert.throws(() => matcher.firstPhasePreProcess([row]), {
      name: 'RangeError',
      message: /too many patterns/,
    });
  });

  test(`minimatch ${entry} bounds optional pairwise segment work`, () => {
    const matcher = new Minimatch('ordinary', { optimizationLevel: 0 });
    const rows = Array.from({ length: 100 }, (_, index) => [
      String(index),
      ...Array(29).fill('ordinary'),
    ]);
    let comparisons = 0;
    const compare = matcher.partsMatch.bind(matcher);
    matcher.partsMatch = (...args) => {
      comparisons++;
      return compare(...args);
    };
    assert.equal(matcher.secondPhasePreProcess(rows), rows);
    assert.equal(comparisons, 0);
  });

  test(`minimatch ${entry} preserves ordinary optimization and matching`, () => {
    const small = new Minimatch('{x,*}/{0..9}', { optimizationLevel: 2 });
    assert.equal(small.set.length, 10);
    assert.equal(small.match('x/5'), true);
    assert.equal(small.match('y/5'), true);
    assert.equal(small.match('x/10'), false);
    const parents = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
    assert.equal(parents.set.length, 4);
    assert.equal(parents.match('../a/b/../c/d'), true);
    assert.equal(parents.match('x/a/b/y/c/d'), true);
  });
}
