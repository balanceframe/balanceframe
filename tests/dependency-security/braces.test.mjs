import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
const nitroRequire = createRequire(nuxtRequire.resolve('nitropack/package.json'));
const globbyRequire = createRequire(nitroRequire.resolve('globby'));
const globRequire = createRequire(globbyRequire.resolve('fast-glob'));
const matcherRequire = createRequire(globRequire.resolve('micromatch'));
// Isolated copies support regression-first checks without altering the installed graph.
const packagePath = process.env.BALANCEFRAME_BRACES_TEST_PACKAGE
  ? resolve(process.env.BALANCEFRAME_BRACES_TEST_PACKAGE)
  : dirname(matcherRequire.resolve('braces/package.json'));
const require = createRequire(join(packagePath, 'package.json'));
const braces = require('./index.js');
const depthError = /^(?:SyntaxError: Input|RangeError: AST) depth \(\d+\), exceeds max depth \(-?[\d.]+\)$/;

function nested(depth, open = '{', close = '}') {
  return open.repeat(depth) + 'x' + close.repeat(depth);
}

function ast(depth) {
  const root = { type: 'root', nodes: [] };
  let node = root;
  for (let i = 0; i < depth; i++) {
    const child = { type: 'paren', parent: node, nodes: [] };
    node.nodes.push(child);
    node = child;
  }
  node.nodes.push({ type: 'text', value: 'x', parent: node });
  return root;
}

// Potential overflows and parent loops always run with an external deadline and heap cap.
function bounded(method, mode) {
  const script = `
    const braces = require(${JSON.stringify(join(packagePath, 'index.js'))});
    const ast = ${ast.toString()};
    let input;
    if (${JSON.stringify(mode)} === 'deep') input = ast(15000);
    if (${JSON.stringify(mode)} === 'child-cycle') {
      input = { type: 'root', nodes: [] }; input.nodes.push(input);
    }
    if (${JSON.stringify(mode)} === 'parent-cycle-node') {
      input = ast(1); input.nodes[0].parent = input.nodes[0];
    }
    if (${JSON.stringify(mode)} === 'parent-cycle-parent') {
      const owner = { type: 'root', queue: [] };
      input = { type: 'paren', parent: owner, nodes: [] };
      // Rewire after the node-owner check to exercise the separate parent-owner check.
      input.nodes.push({ type: 'paren', nodes: [], get value() { input.parent = input; } });
    }
    try { braces[${JSON.stringify(method)}](input); console.log(JSON.stringify({ returned: true })); }
    catch (error) { console.log(JSON.stringify({ name: error.name, message: error.message })); }
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', script], {
    timeout: 3000, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('Nitro keeps the existing globby / fast-glob / micromatch / braces dependency chain', () => {
  assert.equal(require('./package.json').version, '3.0.3');
  assert.equal(matcherRequire('braces/package.json').version, '3.0.3');
  assert.equal(globRequire('micromatch/package.json').version, '4.0.8');
  assert.equal(globbyRequire('fast-glob/package.json').version, '3.3.3');
});

for (const method of ['compile', 'expand', 'stringify']) {
  test(`${method} rejects deep and cyclic child ASTs before stack exhaustion`, () => {
    for (const mode of ['deep', 'child-cycle']) {
      const result = bounded(method, mode);
      assert.equal(result.name, 'RangeError');
      assert.match(result.message, /^AST depth \(101\), exceeds max depth \(100\)$/);
    }
  });

  test(`${method} enforces direct and non-root AST depth boundaries`, () => {
    for (const depth of [0, 1, 99, 100]) assert.doesNotThrow(() => braces[method](ast(depth)));
    assert.throws(() => braces[method](ast(101)), depthError);
    assert.throws(() => braces[method](ast(2).nodes[0], { maxDepth: 1 }), depthError);
    const nonRoot = ast(1).nodes[0];
    delete nonRoot.parent;
    assert.doesNotThrow(() => braces[method](nonRoot, { maxDepth: 1 }));
    for (const maxDepth of [0, -1, 1.5]) {
      assert.throws(() => braces[method](ast(2), { maxDepth }), depthError);
    }
    for (const maxDepth of [101, 1000000, Infinity, -Infinity, NaN, false]) {
      assert.throws(() => braces[method](ast(101), { maxDepth }), depthError);
    }
    assert.doesNotThrow(() => braces[method](ast(1), { maxDepth: 1.5 }));
    assert.doesNotThrow(() => braces[method](ast(0), { maxDepth: 0 }));
  });
}

test('expand rejects cycles in both parent ownership traversals', () => {
  for (const mode of ['parent-cycle-node', 'parent-cycle-parent']) {
    assert.deepEqual(bounded('expand', mode), {
      name: 'RangeError', message: 'AST parent chain contains a cycle',
    });
  }
});

test('all string entry points bound combined brace and parenthesis nesting', () => {
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    for (const [open, close] of [['{', '}'], ['(', ')'], ['{(', ')}']]) {
      for (const depth of [0, 1, 99, 100]) {
        const count = open.length === 2 ? Math.floor(depth / 2) : depth;
        assert.doesNotThrow(() => braces[method](nested(count, open, close)));
      }
      assert.throws(() => braces[method](nested(101, open, close)), depthError);
      assert.throws(() => braces[method](open.repeat(101) + 'x'), depthError);
      for (const maxDepth of [0, -1, 1, 1.5]) {
        assert.throws(() => braces[method](nested(2, open, close), { maxDepth }), depthError);
      }
      for (const maxDepth of [101, 1000000, Infinity, -Infinity, NaN, false]) {
        assert.throws(() => braces[method](nested(101, open, close), { maxDepth }), depthError);
      }
    }
    assert.doesNotThrow(() => braces[method]('x', { maxDepth: 0 }));
    assert.doesNotThrow(() => braces[method]('{x}', { maxDepth: 1.5 }));
    assert.throws(() => braces[method]('x'.repeat(10001)), /exceeds max characters/);
  }
  assert.throws(() => braces(nested(101)), depthError);
  assert.throws(() => braces.create(nested(101), { expand: true }), depthError);
});

test('ordinary quoted, escaped, malformed, duplicate and range contracts remain exact', () => {
  const cases = [
    ['file-{a,b}.{js,ts}', {}, ['file-a.js', 'file-a.ts', 'file-b.js', 'file-b.ts']],
    ['{a,a}', { nodupes: true }, ['a']],
    ['{a,}', { noempty: true }, ['a']],
    ['{1..5..2}', {}, ['1', '3', '5']],
    ['{5..1..2}', {}, ['5', '3', '1']],
    ['{01..05..2}', {}, ['01', '03', '05']],
    ['a\\{b,c}', { keepEscaping: true }, ['a\\{b,c}']],
    ['"a,{b,c}"', {}, ['a,{b,c}']],
    ["'a,{b,c}", {}, ['a,{b,c}']],
    ['${a,b}', {}, ['${a,b}']],
    ['{a,{b,c}}', {}, ['a', 'b', 'c']],
    ['{{a,b}', {}, ['{a', '{b']],
  ];
  for (const [pattern, options, expected] of cases) {
    assert.deepEqual(braces.expand(pattern, options), expected, pattern);
  }
  assert.equal(braces.compile('a/{b,c}/**/*.{js,ts}'), 'a/(b|c)/**/*.(js|ts)');
  assert.equal(braces.stringify('a\\{b,c}', { keepEscaping: true }), 'a\\{b,c}');
  assert.equal(braces.stringify('{{a,b}', { escapeInvalid: true }), '{{a,b}');
  assert.throws(() => braces.expand('{1..1002}'), /expanded array length exceeds range limit/);
  assert.throws(() => braces.parse(null), TypeError);
});
