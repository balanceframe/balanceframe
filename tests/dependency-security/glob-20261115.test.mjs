import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.BALANCEFRAME_GLOB_TEST_ROOT || resolve(import.meta.dirname, '../..');
const require = createRequire(
  join(root, 'node_modules/.pnpm/node_modules/glob-security-probe.cjs'),
);
const consumerRequire = createRequire(require.resolve('js-beautify/package.json'));
const directory = dirname(consumerRequire.resolve('glob/package.json'));
const metadata = consumerRequire('glob/package.json');
const surfaces = [
  ['default CJS', consumerRequire('glob')],
  ['raw CJS', consumerRequire('glob/raw')],
  [
    'default ESM',
    await import(pathToFileURL(join(directory, metadata.exports['.'].import.default))),
  ],
  [
    'raw ESM',
    await import(pathToFileURL(join(directory, metadata.exports['./raw'].import.default))),
  ],
];

function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'balanceframe-glob-cancellation-')));
  for (const path of ['a/one.txt', 'a/deeper/two.txt', 'b/three.txt']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), 'fictional traversal fixture');
  }
  return cwd;
}

test('js-beautify CLI preserves literal/glob input and excludes dependency and Git directories', () => {
  const cwd = fixture();
  const previousDirectory = process.cwd();
  const input = 'const value={left:1,right:2};';
  const expected = 'const value = {\n  left: 1,\n  right: 2\n};';
  try {
    const cli = join(dirname(require.resolve('js-beautify/package.json')), 'js/lib/cli.js');
    const consumerRequire = createRequire(cli);
    assert.equal(
      dirname(consumerRequire.resolve('glob/package.json')),
      directory,
      'the actual CLI must resolve the glob package under test',
    );
    const { interpret } = require(cli);
    process.chdir(cwd);
    const files = [
      'literal.js',
      'src/main.js',
      'src/nested/other.js',
      'node_modules/ignored.js',
      '.git/ignored.js',
    ];
    for (const [pattern, selected] of [
      ['literal.js', ['literal.js']],
      ['src/[mn]*.js', ['src/main.js']],
      ['src/**/@(other).js', ['src/nested/other.js']],
      ['**/*.js', ['literal.js', 'src/main.js', 'src/nested/other.js']],
      ['missing/**/*.js', []],
    ]) {
      for (const file of files) {
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        writeFileSync(join(cwd, file), input);
      }
      interpret(
        ['node', 'js-beautify', '--type', 'js', '--indent-size', '2', '--replace', pattern],
        2,
      );
      for (const file of files) {
        assert.equal(
          readFileSync(join(cwd, file), 'utf8').trimEnd(),
          selected.includes(file) ? expected : input,
          `${pattern} must format only its own selected files`,
        );
      }
    }
  } finally {
    process.chdir(previousDirectory);
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [surface, glob] of surfaces) {
  for (const method of ['glob', 'globStream']) {
    test(`glob ${surface} ${method} stops traversal after cancellation`, async () => {
      const cwd = fixture();
      const controller = new AbortController();
      const reason = new Error('fixture traversal cancelled');
      let reads = 0;
      let readsAfterAbort = 0;
      const fs = {
        readdir(path, options, callback) {
          reads++;
          if (controller.signal.aborted) readsAfterAbort++;
          const entries = readdirSync(path, options);
          // Controlled callbacks make all pending traversal work drain without a sleep.
          queueMicrotask(() => {
            if (!controller.signal.aborted) controller.abort(reason);
            callback(null, entries);
          });
        },
      };
      try {
        await assert.rejects(
          async () => {
            const result = glob[method]('**/*.txt', { cwd, fs, signal: controller.signal });
            await (method === 'globStream' ? result.collect() : result);
          },
          (error) => error === reason,
        );
        await setImmediate();
        assert.equal(reads, 1, 'only the already-started root directory read is allowed');
        assert.equal(readsAfterAbort, 0, 'cancellation must stop subsequent filesystem work');
      } finally {
        await setImmediate();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  test(`glob ${surface} preserves ordinary async, stream and sync matching`, async () => {
    const cwd = fixture();
    const expected = ['a/deeper/two.txt', 'a/one.txt', 'b/three.txt'];
    const options = { cwd, posix: true };
    try {
      assert.deepEqual((await glob.glob('**/*.txt', options)).sort(), expected);
      assert.deepEqual(
        [...(await glob.globStream('**/*.txt', options).collect())].sort(),
        expected,
      );
      assert.deepEqual(glob.globSync('**/*.txt', options).sort(), expected);
      assert.deepEqual([...glob.globStreamSync('**/*.txt', options)].sort(), expected);
      const controller = new AbortController();
      const reason = new Error('fixture cancelled before sync traversal');
      controller.abort(reason);
      assert.throws(
        () => glob.globSync('**/*.txt', { ...options, signal: controller.signal }),
        (error) => error === reason,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
