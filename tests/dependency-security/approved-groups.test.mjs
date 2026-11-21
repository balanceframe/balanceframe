import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'node_modules/.pnpm/node_modules/_security-test.cjs'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));

function bounded(script, args = []) {
  return execFileSync(process.execPath, [...args, '--input-type=commonjs', '-e', script], {
    cwd: root, timeout: 3000, stdio: 'pipe', maxBuffer: 64 * 1024,
  });
}

function childRequire() {
  return `var require = require('node:module').createRequire(${JSON.stringify(join(root, 'node_modules/.pnpm/node_modules/_security-test.cjs'))});`;
}

test('fast-uri rejects ambiguous backslash authorities and port injection', () => {
  const uri = require('fast-uri');
  for (const input of ['http://evil.example\\@allowed.example', 'http:\\\\evil.example/path']) {
    assert.match(uri.parse(input).error, /backslash/i);
  }
  assert.throws(() => uri.serialize({ scheme: 'http', host: 'allowed.example', port: '80@evil.example' }));
  assert.equal(uri.parse('https://example.com/budget').host, 'example.com');
});

test('brace-expansion bounds total output and nested parsing without losing ordinary globs', () => {
  const { expand } = require('brace-expansion');
  const result = expand('{aa,bb,cc}{dd,ee,ff}', { maxLength: 8 });
  assert.ok(result.join('').length <= 8);
  assert.deepEqual(expand('file-{a,b}.{js,ts}'), ['file-a.js', 'file-a.ts', 'file-b.js', 'file-b.ts']);
  bounded(`${childRequire()} const {expand}=require('brace-expansion'); expand('{'.repeat(600)+'a,b'+'}'.repeat(600),{max:2,maxLength:32});`, ['--stack-size=256']);
});

test('PostCSS nanoid custom generators terminate for size zero', () => {
  const vueRequire = createRequire(webRequire.resolve('vue/package.json'));
  const compilerRequire = createRequire(vueRequire.resolve('@vue/compiler-sfc/package.json'));
  const postcssRequire = createRequire(compilerRequire.resolve('postcss/package.json'));
  const path = postcssRequire.resolve('nanoid');
  bounded(`const assert=require('node:assert/strict');const {customAlphabet,customRandom}=require(${JSON.stringify(path)});assert.equal(customAlphabet('ab',0)(),'');assert.equal(customRandom('ab',0,n=>Buffer.alloc(n))(),'');`);
  assert.match(postcssRequire('nanoid').customAlphabet('ab', 8)(), /^[ab]{8}$/);
});

test('tar member selection handles deep paths on a bounded stack', () => {
  const ownerRequire = createRequire(require.resolve('@mapbox/node-pre-gyp/package.json'));
  const path = join(dirname(ownerRequire.resolve('tar')), 'list.js');
  bounded(`const assert=require('node:assert/strict'); const {filesFilter}=require(${JSON.stringify(path)});const o={};filesFilter(o,['budget']);assert.equal(o.filter('budget/data.json'),true);assert.equal(o.filter('other'),false);assert.equal(o.filter('a/'.repeat(1500)+'other'),false);`, ['--stack-size=128']);
});

test('Browserslist ignores inherited browser names in custom statistics', () => {
  const browserslist = require('browserslist');
  for (const key of ['toString', 'constructor', '__proto__']) {
    assert.deepEqual(browserslist('chrome 100', { stats: JSON.parse(`{"${key}":{"one":5}}`) }), ['chrome 100']);
  }
  assert.deepEqual(browserslist('chrome 100'), ['chrome 100']);
});

test('source-map-js rejects excessive and invalid indexed offsets before generating output', () => {
  const { SourceMapConsumer } = require('source-map-js');
  const section = { version: 3, sources: ['budget.ts'], names: [], mappings: 'AAAA' };
  const indexed = line => ({ version: 3, sections: [{ offset: { line, column: 0 }, map: section }] });
  // Construct only: never flatten the large-offset map on an affected version.
  for (const line of [10_000_001, Infinity, 0.5, '2']) {
    assert.throws(() => new SourceMapConsumer(indexed(line)), /offset/i);
  }
  assert.equal(new SourceMapConsumer(section).originalPositionFor({ line: 1, column: 0 }).source, 'budget.ts');
});

test('SVGO removeScripts strips namespace and control-character executable links', () => {
  let owner;
  try { owner = require.resolve('postcss-svgo/package.json'); }
  catch (error) {
    assert.equal(error.code, 'MODULE_NOT_FOUND');
    // Nuxt 4.6's cssnano 9 no longer contains the SVGO integration.
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    assert.doesNotMatch(lock, /^  (?:postcss-svgo|svgo)@/m);
    assert.match(require('cssnano/package.json').version, /^9\./);
    return;
  }
  const ownerRequire = createRequire(owner);
  const { optimize } = ownerRequire('svgo');
  for (const source of [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:a href="javascript:MARKER"><text>Budget</text></s:a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#9;script:MARKER"><text>Budget</text></a></svg>',
  ]) {
    const result = optimize(source, { plugins: ['removeScripts'] }).data;
    assert.doesNotMatch(result, /MARKER/);
    assert.match(result, /Budget/);
  }
  const ordinary = optimize('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><circle r="2"/></a></svg>', { plugins: ['removeScripts'] }).data;
  assert.match(ordinary, /https:\/\/example.com/);
  assert.match(ordinary, /circle/);
});

function zipWithDeclaredSize(size) {
  const AdmZip = webRequire('adm-zip');
  const zip = new AdmZip();
  zip.addFile('budget.txt', Buffer.from('ordinary budget content'));
  const raw = zip.toBuffer();
  raw.writeUInt32LE(size, raw.indexOf(Buffer.from('PK\x03\x04', 'binary')) + 22);
  raw.writeUInt32LE(size, raw.indexOf(Buffer.from('PK\x01\x02', 'binary')) + 24);
  return new AdmZip(raw);
}

test('adm-zip rejects zero and undersized declared lengths with tiny real payloads', () => {
  for (const size of [0, 1]) assert.throws(() => zipWithDeclaredSize(size).readAsText('budget.txt'));
  const AdmZip = webRequire('adm-zip');
  const zip = new AdmZip();
  zip.addFile('budget.txt', Buffer.from('normal'));
  assert.equal(new AdmZip(zip.toBuffer()).readAsText('budget.txt'), 'normal');
});

test('adm-zip never preallocates attacker-declared output length', () => {
  const zip = zipWithDeclaredSize(100_000);
  const original = Buffer.alloc;
  Buffer.alloc = (size, ...args) => {
    assert.ok(size <= 1024, 'Untrusted declared size reached Buffer.alloc');
    return original(size, ...args);
  };
  try { assert.equal(zip.readAsText('budget.txt'), 'ordinary budget content'); }
  finally { Buffer.alloc = original; }
});

test('adm-zip refuses destination symlinks without overwriting their target', () => {
  const AdmZip = webRequire('adm-zip');
  const temp = mkdtempSync(join(tmpdir(), 'balanceframe-zip-security-'));
  try {
    const outside = join(temp, 'outside.txt');
    const destination = join(temp, 'destination');
    const zip = new AdmZip();
    zip.addFile('budget.txt', Buffer.from('replacement'));
    writeFileSync(outside, 'original');
    const { mkdirSync } = require('node:fs');
    mkdirSync(destination);
    symlinkSync(outside, join(destination, 'budget.txt'));
    assert.throws(() => zip.extractAllTo(destination, true));
    assert.equal(readFileSync(outside, 'utf8'), 'original');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('Tiptap attribute merges cannot create inherited DOM handlers', () => {
  const { mergeAttributes } = require('@tiptap/core');
  const attrs = mergeAttributes({ class: 'budget' }, JSON.parse('{"__proto__":{"onerror":"MARKER","src":"invalid"}}'));
  assert.equal(attrs.onerror, undefined);
  assert.equal(Object.getPrototypeOf(attrs), Object.prototype);
  assert.deepEqual(mergeAttributes({ class: 'budget' }, { class: 'selected', title: 'Plan' }), { class: 'budget selected', title: 'Plan' });
});

test('Tiptap block and inline Markdown parsers bound adversarial attribute work', () => {
  for (const [factory, source] of [
    ['createAtomBlockMarkdownSpec', ':::probe {' + '__QUOTED_0'.repeat(6400) + '__QUOTED_0__} :::\n'],
    ['createInlineMarkdownSpec', '[probe ' + '0'.repeat(65536) + ']'],
  ]) {
    bounded(`${childRequire()}const {${factory}:factory}=require('@tiptap/core');const spec=factory({nodeName:'probe',selfClosing:true}); const result=spec.markdownTokenizer.tokenize(${JSON.stringify(source)},[],{});if(!result)throw Error('Missing token');`);
  }
});

test('Vue SSR drops carriage-return attribute names and escapes ordinary values', () => {
  const vueRequire = createRequire(webRequire.resolve('vue/package.json'));
  const { ssrRenderAttrs } = vueRequire('@vue/server-renderer');
  assert.equal(ssrRenderAttrs({ 'x\rautofocus\ronfocus': 'MARKER' }), '');
  assert.equal(ssrRenderAttrs({ title: 'Budget <plan>' }), ' title="Budget &lt;plan&gt;"');
});

test('DevTools no longer owns either vulnerable Git package', () => {
  const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
  const devtoolsRequire = createRequire(nuxtRequire.resolve('@nuxt/devtools/package.json'));
  const pkg = devtoolsRequire('./package.json');
  assert.equal(pkg.dependencies['simple-git'], undefined);
  assert.equal(pkg.dependencies['@simple-git/argv-parser'], undefined);
  assert.ok(pkg.dependencies.tinyexec);
  assert.throws(() => devtoolsRequire.resolve('simple-git'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => devtoolsRequire.resolve('@simple-git/argv-parser'), { code: 'MODULE_NOT_FOUND' });
});


test('DevTools analysis names use fixed read-only Git commands', async () => {
  const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
  const devtoolsRequire = createRequire(nuxtRequire.resolve('@nuxt/devtools/package.json'));
  const source = readFileSync(join(dirname(devtoolsRequire.resolve('./package.json')), 'dist/chunks/module-main.mjs'), 'utf8');
  const start = source.indexOf('  async function git(...args) {');
  const end = source.indexOf('  return {', start);
  assert.ok(start > 0 && end > start);
  const { x } = devtoolsRequire('tinyexec');
  const commands = [];
  const generateName = new Function('x', 'nuxt', 'COLON_RE', source.slice(start, end) + '\nreturn generateAnalyzeBuildName;')(
    (command, args, options) => { commands.push([command, args]); return x(command, args, options); },
    { options: { rootDir: root } }, /:/g,
  );
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  assert.equal(await generateName(), `${branch}#${sha}${dirty ? '-dirty' : ''}`);
  assert.deepEqual(commands, [
    ['git', ['rev-parse', '--abbrev-ref', 'HEAD']],
    ['git', ['rev-parse', '--short', 'HEAD']],
    ['git', ['status', '--porcelain']],
  ]);
});
