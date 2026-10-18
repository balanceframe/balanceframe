import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = process.env.BALANCEFRAME_SDK_TEST_ROOT || resolve(import.meta.dirname, '../..');
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const bundle = process.env.BALANCEFRAME_SDK_TEST_BUNDLE
  ? resolve(process.env.BALANCEFRAME_SDK_TEST_BUNDLE)
  : webRequire.resolve('@actual-app/api');

// Expose the embedded compiler in memory; no installed or production file is changed.
const sdk = new Module(bundle);
sdk.filename = bundle;
sdk.paths = Module._nodeModulePaths(dirname(bundle));
sdk._compile(readFileSync(bundle, 'utf8') + '\nmodule.exports.__securityHandlebars = require_handlebars();\n', bundle);
const Handlebars = sdk.exports.__securityHandlebars;

function untrustedAst() {
  const ast = Handlebars.parse('{{#missingHelper}}{{/missingHelper}}');
  ast.body[0].program.blockParams = { length: 'UNTRUSTED_AST_MARKER' };
  return ast;
}

test('the installed Actual Node SDK embeds the approved Handlebars version', () => {
  assert.equal(Handlebars.VERSION, '4.7.10');
});

test('the embedded compiler rejects type-confused AST blockParams during precompilation', () => {
  // Inspect code generation only; never render the untrusted AST.
  assert.throws(() => Handlebars.precompile(untrustedAst()), /blockParams|AST/i);
});

test('the embedded compiler rejects the same AST before lazy template initialization', () => {
  assert.throws(() => Handlebars.compile(untrustedAst())._setup({}), /blockParams|AST/i);
});

test('the embedded runtime hides prototype constructors when prototype methods are enabled', () => {
  // Look up/stringify the result only; never invoke a returned constructor.
  const template = Handlebars.compile('{{lookup (lookup fn "__proto__") "constructor"}}');
  assert.equal(template({ fn() {} }, { allowProtoMethodsByDefault: true }), '');
});

test('the embedded compiler preserves ordinary rule and trusted parsed templates', () => {
  assert.equal(Handlebars.compile('Payment to {{payee}}')({ payee: 'Local shop' }), 'Payment to Local shop');
  assert.equal(Handlebars.compile(Handlebars.parse('{{#if paid}}Paid{{else}}Due{{/if}}'))({ paid: true }), 'Paid');
  assert.match(Handlebars.precompile('Payment to {{payee}}'), /payee/);
});

test('embedded compiler validates path depth and the parts consumed by compiler options', () => {
  for (const options of [{}, { stringParams: true }, { trackIds: true }]) {
    for (const depth of [-1, 0.5, Infinity, NaN, '0']) {
      const ast = Handlebars.parse('{{helper value}}');
      ast.body[0].params[0].depth = depth;
      assert.throws(() => Handlebars.precompile(ast, options));
    }
    if (!options.stringParams) {
      for (const parts of [null, {}, 'value', [1], [null]]) {
        const ast = Handlebars.parse('{{helper value}}');
        ast.body[0].params[0].parts = parts;
        assert.throws(() => Handlebars.precompile(ast, options));
      }
    }
    for (const depth of [undefined, null, 0]) {
      const ast = Handlebars.parse('{{helper value}}');
      ast.body[0].params[0].depth = depth;
      assert.doesNotThrow(() => Handlebars.precompile(ast, options));
    }
    for (const parts of [[], ['value']]) {
      const ast = Handlebars.parse('{{helper value}}');
      ast.body[0].params[0].parts = parts;
      assert.doesNotThrow(() => Handlebars.precompile(ast, options));
    }
  }
});

test('embedded compiler rejects malformed literals, hashes and block parameters without rendering', () => {
  for (const options of [{}, { stringParams: true }, { trackIds: true }]) {
    for (const [index, value] of [[0, {}], [0, 1], [1, '1'], [1, null], [2, 'true'], [2, 0]]) {
      const ast = Handlebars.parse("{{helper 'text' 1 true}}");
      ast.body[0].params[index].value = value;
      assert.throws(() => Handlebars.precompile(ast, options));
    }
  }
  for (const value of [Infinity, NaN]) {
    const ast = Handlebars.parse('{{helper 1}}');
    ast.body[0].params[0].value = value;
    assert.doesNotThrow(() => Handlebars.precompile(ast));
  }
  const hash = Handlebars.parse("{{helper key='value'}}");
  hash.body[0].hash.pairs = {};
  assert.throws(() => Handlebars.precompile(hash));
  const key = Handlebars.parse("{{helper key='value'}}");
  key.body[0].hash.pairs[0].key = 1;
  assert.throws(() => Handlebars.precompile(key));
  const block = Handlebars.parse('{{#each items as |item|}}{{item}}{{/each}}');
  block.body[0].program.blockParams = [1];
  assert.throws(() => Handlebars.precompile(block));
});

test('embedded compiler and visitor reject inherited dispatch names', () => {
  assert.throws(() => new Handlebars.Compiler().accept({ type: 'toString' }));
  assert.throws(() => new Handlebars.Visitor().accept({ type: 'toString' }));
});

test('embedded code generation escapes script delimiters and preserves valid string contents', () => {
  for (const value of ['</script>', '<script>', '<!--', '\u0000\u0001', '\u2028\u2029', '\ud800', '\udfff', '\ud800\udfff']) {
    // A valid literal-only AST isolates code generation from the template lexer's input limits.
    const ast = Handlebars.parse('placeholder');
    ast.body[0].value = value;
    const generated = Handlebars.precompile(ast);
    assert.doesNotMatch(generated, /<\/script|<script|<!--|\u0000|\u0001|\u2028|\u2029/i);
    assert.doesNotMatch(generated, /[\ud800-\udfff]/);
    assert.equal(Handlebars.compile(ast)({}), value);
  }
});

test('embedded partials accept strings and functions while rejecting AST and call-shaped objects', () => {
  const hb = Handlebars.create();
  hb.registerPartial('item', hb.parse('Trusted AST partial'));
  assert.throws(() => hb.compile('{{> item}}')({}));
  let calls = 0;
  hb.registerPartial('item', { call() { calls++; return 'unexpected'; } });
  assert.throws(() => hb.compile('{{> item}}')({}));
  assert.equal(calls, 0);
  const dynamic = { call() { calls++; return 'unexpected'; } };
  assert.throws(() => hb.compile('{{> (lookup this "partial")}}')({ partial: dynamic }));
  assert.equal(calls, 0);
  hb.registerPartial('item', () => undefined);
  assert.throws(() => hb.compile('{{> item}}')({}));
  hb.registerPartial('item', 'Hello {{name}}');
  assert.equal(hb.compile('{{> item}}')({ name: 'Local shop' }), 'Hello Local shop');
  hb.registerPartial('item', () => 'Function partial');
  assert.equal(hb.compile('{{> item}}')({}), 'Function partial');
  hb.registerPartial('item', 'one\ntwo');
  assert.equal(hb.compile('  {{> item}}\n')({}), '  one\n  two');
});

test('embedded escaping keeps trusted HTML and own constructor labels working', () => {
  assert.equal(Handlebars.Utils.escapeExpression({ toHTML: 'ignored', toString: () => '<safe>' }), '&lt;safe&gt;');
  assert.equal(Handlebars.Utils.escapeExpression({ toHTML: () => '<b>trusted</b>' }), '<b>trusted</b>');
  assert.equal(Handlebars.compile('{{value}}')({ value: new Handlebars.SafeString('<b>trusted</b>') }), '<b>trusted</b>');
  assert.equal(Handlebars.compile('{{constructor}}')({ constructor: 'Own label' }), 'Own label');
  assert.equal(Handlebars.compile('A {{~! comment ~}} B')({}), 'AB');
});

test('embedded iteration preserves array, object, generator and empty rendering', () => {
  const render = Handlebars.compile('{{#each items}}{{@index}}={{this}};{{else}}empty{{/each}}');
  assert.equal(render({ items: ['one', 'two'] }), '0=one;1=two;');
  assert.equal(render({ items: { a: 'one', b: 'two' } }), '0=one;1=two;');
  function* items() { yield 'one'; yield 'two'; }
  assert.equal(render({ items: items() }), '0=one;1=two;');
  assert.equal(render({ items: [] }), 'empty');
});

test('embedded iteration closes unfinished iterators and preserves the original render error', () => {
  for (const mode of ['function', 'throwing-function', 'throwing-getter', 'nonfunction']) {
    const hb = Handlebars.create();
    const original = new Error('controlled-render-failure');
    hb.registerHelper('fail', () => { throw original; });
    let index = 0, getterReads = 0, closeCalls = 0;
    const iterator = { next() { return { value: index, done: index++ >= 3 }; } };
    Object.defineProperty(iterator, 'return', { get() {
      getterReads++;
      if (mode === 'throwing-getter') throw new Error('controlled-cleanup-failure');
      if (mode === 'nonfunction') return false;
      return () => {
        closeCalls++;
        if (mode === 'throwing-function') throw new Error('controlled-cleanup-failure');
        return { done: true };
      };
    } });
    const items = { [Symbol.iterator]() { return iterator; } };
    assert.throws(() => hb.compile('{{#each items}}{{fail}}{{/each}}')({ items }), error => error === original);
    assert.equal(getterReads, 1);
    assert.equal(closeCalls, mode === 'function' || mode === 'throwing-function' ? 1 : 0);
  }
});
