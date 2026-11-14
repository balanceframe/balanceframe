import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sandbox = mkdtempSync(join(tmpdir(), 'balanceframe-password-reset-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));
const fakeServer = join(sandbox, 'actual-server');
writeFileSync(
  fakeServer,
  `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const stage = process.env.FAKE_RESET_STAGE;
const mark = (value) => writeFileSync(process.env.FAKE_RESET_TRACE, value);
const keepAlive = setInterval(() => {}, 1000);
mark('initial');
if (stage !== 'initial') {
  let input = '', lines = 0;
  process.stdin.setRawMode(true);
  process.stdin.on('data', (chunk) => {
    input += chunk;
    while (input.includes('\\r')) {
      input = input.slice(input.indexOf('\\r') + 1);
      lines += 1;
      if (lines === 1) {
        mark('confirmation');
        if (stage !== 'confirmation') process.stdout.write('Enter the password again, then press enter: ');
      } else {
        mark(stage === 'complete' ? 'complete' : stage === 'exit' ? 'exit' : 'success');
        if (stage !== 'success') process.stdout.write('Password set!\\n');
        if (stage === 'complete') { clearInterval(keepAlive); process.exit(0); }
      }
    }
  });
  process.stdout.write('Enter a password, then press enter: ');
}
`,
);
chmodSync(fakeServer, 0o755);

const fixture = readFileSync(
  join(root, 'tests/actual-integration/setup-fixture-server.sh'),
  'utf8',
);
const runtime = readFileSync(join(root, 'packages/scenario-kit/src/process-runtime.ts'), 'utf8');
const scripts = [
  ['fixture', fixture.match(/expect <<'EXPECT'\n([\s\S]*?)\nEXPECT/)?.[1]],
  [
    'scenario',
    runtime
      .match(/function expectScript\(\): string \{\s*return `([\s\S]*?)`;/)?.[1]
      ?.replaceAll('\\\\', '\\'),
  ],
];

for (const [name, source] of scripts) {
  assert.equal(typeof source, 'string', `${name} password-reset script must be found`);
  for (const stage of ['initial', 'confirmation', 'success', 'exit', 'complete']) {
    test(`${name} reset ${stage === 'complete' ? 'accepts acknowledged completion' : `fails closed at ${stage} timeout`}`, () => {
      const trace = join(sandbox, `${name}-${stage}.trace`);
      const result = spawnSync(
        'expect',
        ['-c', source.replace('set timeout 30', 'set timeout 1')],
        {
          env: {
            ...process.env,
            PATH: `${sandbox}:${process.env.PATH ?? ''}`,
            ACTUAL_SECRET_KEY: 'fixture-test-only',
            FAKE_RESET_STAGE: stage,
            FAKE_RESET_TRACE: trace,
          },
          encoding: 'utf8',
          timeout: 6_000,
        },
      );
      assert.equal(result.error, undefined, 'Expect must finish through its own bounded protocol');
      assert.equal(result.signal, null);
      assert.equal(
        readFileSync(trace, 'utf8'),
        stage,
        'The intended protocol stage must be reached',
      );
      if (stage === 'complete') assert.equal(result.status, 0);
      else assert.notEqual(result.status, 0, 'A timed-out reset must not report success');
    });
  }
}
