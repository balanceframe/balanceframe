import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../..');
const scripts = [
  {
    caller: 'scenario runtime',
    path: 'packages/scenario-kit/src/process-runtime.ts',
    extract: (text: string) => text.match(/function expectScript\(\): string \{\s*return `([\s\S]*?)`;/)?.[1]?.replaceAll('\\\\', '\\'),
  },
  {
    caller: 'integration setup',
    path: 'tests/actual-integration/setup-fixture-server.sh',
    extract: (text: string) => text.match(/if ! expect <<'EXPECT'\n([\s\S]*?)\nEXPECT/)?.[1],
  },
];

// Actual's raw input handler dispatches on key[0]. Model a legal PTY delivery
// that buffers a bulk password until Enter, then supplies both in one chunk.
const cli = `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.PASSWORD_TEST_MODE;
if (mode === 'nonzero') process.exit(7);
process.stdin.setRawMode(true);
process.stdin.resume();
process.on('SIGHUP', () => process.exit(0));
let phase = 0, value = '', first = '', pending;
const prompt = () => process.stdout.write(phase ? 'Enter the password again, then press enter:' : 'Enter a password, then press enter:');
prompt();
if (mode === 'eof') process.exit(0);
const deadline = setTimeout(() => process.exit(8), 2500);
process.stdin.on('data', chunk => {
  if (mode === 'coalesced' && chunk.length > 1 && !pending && !chunk.includes(13)) {
    pending = chunk;
    return;
  }
  if (pending) { chunk = Buffer.concat([pending, chunk]); pending = undefined; }
  if (chunk[0] !== 13) {
    value += chunk;
    if (mode !== 'no-echo') process.stdout.write('*');
    return;
  }
  if (!phase++) { first = value; value = ''; prompt(); return; }
  clearTimeout(deadline);
  if (mode === 'mismatch' || first !== value || value !== process.env.ACTUAL_SECRET_KEY) {
    process.stdout.write('Passwords do not match.'); process.exit(1);
  }
  fs.writeFileSync(process.env.PASSWORD_TEST_MARKER, 'accepted');
  process.stdout.write('Password set!');
  process.exit(0);
});
`;

describe.each(scripts)('$caller password handshake', ({ path, extract }) => {
  it.each(['coalesced', 'eof', 'nonzero', 'no-echo', 'mismatch'])(
    'handles %s terminal delivery without exposing the password', async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'balanceframe-password-handshake-'));
      const secret = randomBytes(32).toString('hex');
      const marker = join(root, 'accepted');
      try {
        const command = join(root, 'actual-server');
        writeFileSync(command, cli);
        chmodSync(command, 0o700);
        const script = extract(readFileSync(resolve(repository, path), 'utf8'));
        if (!script) throw new Error('Checked-in password reset script was not found');
        const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
          const child = spawn('expect', [], {
            env: { ...process.env, PATH: root + ':' + process.env.PATH, ACTUAL_SECRET_KEY: secret, PASSWORD_TEST_MODE: mode, PASSWORD_TEST_MARKER: marker },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let output = '';
          child.stdout.on('data', (data) => { output += String(data); });
          child.stderr.on('data', (data) => { output += String(data); });
          const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('close', (code) => { clearTimeout(timer); done({ code, output }); });
          // Bound this terminal fixture only; production's 30-second limit is unchanged.
          child.stdin.end(script.replace('set timeout 30', 'set timeout 1'));
        });
        // Assert booleans so even a failing privacy assertion cannot print the secret.
        expect(result.output.includes(secret)).toBe(false);
        if (mode === 'coalesced') {
          expect(result.code).toBe(0);
          expect(existsSync(marker)).toBe(true);
        } else {
          expect(result.code).not.toBe(0);
          expect(existsSync(marker)).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
