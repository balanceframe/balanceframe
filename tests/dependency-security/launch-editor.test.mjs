import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, win32 } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const webRequire = createRequire(resolve(import.meta.dirname, '../../apps/web/package.json'));
const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
const devtoolsRequire = createRequire(nuxtRequire.resolve('@nuxt/devtools/package.json'));
const editorPath = devtoolsRequire.resolve('launch-editor');
const vitestRequire = createRequire(webRequire.resolve('vitest/package.json'));
const viteRoot = dirname(vitestRequire.resolve('vite/package.json'));
const chunks = join(viteRoot, 'dist/node/chunks');
const bundledModules = readdirSync(chunks).filter(name => name.endsWith('.js')).flatMap(name => {
  const source = readFileSync(join(chunks, name), 'utf8');
  return [...source.matchAll(/^\/\/#region [^\n]*\/launch-editor\/(get-args|parse-file|construct-windows-launch-command|index)\.js\n([\s\S]*?)^\/\/#endregion/gm)];
});
assert.equal(bundledModules.filter(match => match[1] === 'index').length, 1, 'find the actual Vite editor bundle');
assert.equal(bundledModules.filter(match => match[1] === 'get-args').length, 1, 'find the bundled editor argument builder');

// Evaluate installed code with Windows paths on every OS; no real process API enters the VM.
function harness(implementation, existing = []) {
  const calls = [];
  const checked = [];
  const errors = [];
  const child = { on() { return this; }, kill() { assert.fail('unexpected editor termination'); } };
  const modules = {
    fs: { existsSync(file) { checked.push(file); return existing.includes(win32.normalize(file)); } },
    path: win32,
    os: { release: () => 'Windows' },
    picocolors: { red: value => value },
    child_process: Object.fromEntries(['exec', 'spawn'].map(method => [method, (...args) => {
      calls.push({ method, args });
      return child;
    }])),
    './guess': editor => [editor],
  };
  const globals = { process: { platform: 'win32', env: {} }, console: { log() {} } };
  function load(file) {
    const module = { exports: {} };
    const require = name => {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith('./')) return load(join(dirname(file), `${name}.js`));
      assert.fail(`unexpected dependency in editor sandbox: ${name}`);
    };
    runInNewContext(readFileSync(file, 'utf8'), { ...globals, module, require }, { filename: file, timeout: 1000 });
    return module.exports;
  }
  let launch;
  if (implementation === 'standalone') {
    launch = load(editorPath);
  } else {
    const context = {
      ...globals,
      __require(name) {
        assert.ok(Object.hasOwn(modules, name), `unexpected bundled dependency: ${name}`);
        return modules[name];
      },
      __commonJSMin(callback) {
        let module;
        return () => {
          if (!module) { module = { exports: {} }; callback(module.exports, module); }
          return module.exports;
        };
      },
      require_picocolors: () => modules.picocolors,
      require_guess: () => modules['./guess'],
    };
    launch = runInNewContext(`${bundledModules.map(match => match[2]).join('\n')}\nrequire_launch_editor()`, context, {
      filename: 'installed-vite-launch-editor.js', timeout: 1000,
    });
  }
  return {
    calls, checked, errors,
    launch(file, editor = 'code') { launch(file, editor, (...args) => errors.push(args)); },
  };
}

for (const implementation of ['standalone', 'Vite bundle']) {
  test(`${implementation}: resolves the GHSA-587h-7wmj-h5pm parent-path bypass before checking and launching`, () => {
    const editor = harness(implementation, ['C:\\project']);
    // Windows accepts a nonexistent component followed by \\.. as its existing parent.
    editor.launch('C:\\project\\MARKER%CD%&\\..:7:11');
    assert.deepEqual(editor.checked, ['C:\\project']);
    assert.equal(editor.calls.length, 1);
    assert.equal(editor.calls[0].args[0], 'code -r -g C:\\project:7:11');
    assert.deepEqual(editor.errors, []);
  });

  for (const suffix of ['%MARKER%.vue', '%CD%.vue', '%CMDCMDLINE:~-38%MARKER', '%VAR:old=new%.vue', '100%.vue']) {
    test(`${implementation}: rejects GHSA-698v-4r3x-3vcv percent argument ${JSON.stringify(suffix)}`, () => {
      const file = `C:\\project\\${suffix}`;
      const editor = harness(implementation, [file]);
      editor.launch(`${file}:7:11`);
      assert.equal(editor.calls.length, 0, 'untrusted percent argument must never reach exec/spawn');
      assert.equal(editor.errors.length, 1);
      assert.match(editor.errors[0][1], /argument containing "%"/);
    });
  }

  for (const separator of ['\r', '\n']) {
    test(`${implementation}: rejects a Windows stream argument containing ${JSON.stringify(separator)}`, () => {
      const file = `C:\\project\\budget.vue:stream${separator}MARKER`;
      const editor = harness(implementation, [file]);
      editor.launch(file);
      assert.equal(editor.calls.length, 0);
      assert.equal(editor.errors.length, 1);
      assert.match(editor.errors[0][1], /argument containing a line break/);
    });
  }

  test(`${implementation}: preserves ordinary filenames, shell quoting, and line/column positions`, () => {
    for (const [file, position, expected] of [
      ['C:\\project\\budget.vue', '', 'code C:\\project\\budget.vue'],
      ['C:\\project\\budget file.vue', ':7:11', 'code -r -g "C:\\project\\budget file.vue:7:11"'],
      ['C:\\project\\(group)\\[slug]+$@.vue', ':7', 'code -r -g C:\\project\\(group)\\[slug]+$@.vue:7:1'],
      ['C:\\project\\a&b.vue', ':7:11', 'code -r -g ^"C:\\project\\a^&b.vue:7:11^"'],
    ]) {
      const editor = harness(implementation, [file]);
      editor.launch(file + position);
      assert.equal(editor.calls.length, 1);
      assert.equal(editor.calls[0].method, 'exec');
      assert.equal(editor.calls[0].args[0], expected);
      assert.equal(editor.calls[0].args[1].shell, true);
      assert.deepEqual(editor.errors, []);
    }
  });

  test(`${implementation}: does not launch a missing file or UNC path`, () => {
    const missing = harness(implementation);
    missing.launch('C:\\project\\missing.vue:7:11');
    assert.equal(missing.calls.length, 0);
    const unc = harness(implementation, ['\\\\server\\share\\budget.vue']);
    unc.launch('\\\\server\\share\\budget.vue:7:11');
    assert.equal(unc.calls.length, 0);
    assert.equal(unc.errors.length, 1);
    assert.match(unc.errors[0][1], /UNC paths are not supported/);
  });
}
