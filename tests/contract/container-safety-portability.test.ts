import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const safetyTest = 'tests/deployment/container-safety.test.mjs';
const lineEndings = [
  { name: 'LF', value: '\n' },
  { name: 'CRLF', value: '\r\n' },
];

function runSafety(lineEnding: string, missingArtifact?: string) {
  const fixture = mkdtempSync(join(tmpdir(), 'balanceframe-container-portability-'));
  try {
    mkdirSync(dirname(resolve(fixture, safetyTest)), { recursive: true });
    for (const file of ['Dockerfile', '.dockerignore', 'docker-entrypoint.sh', safetyTest]) {
      let content = readFileSync(resolve(root, file), 'utf8').replace(/\r?\n/g, lineEnding);
      if (file === 'Dockerfile' && missingArtifact) {
        const instruction = `COPY --from=builder /app/crates/node-binding/${missingArtifact} ./node_modules/@balanceframe/native/${missingArtifact}`;
        expect(content).toContain(instruction);
        content = content.replace(instruction, '# Missing native artifact');
      }
      writeFileSync(resolve(fixture, file), content);
    }
    return spawnSync(process.execPath, ['--test', safetyTest], {
      cwd: fixture,
      encoding: 'utf8',
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe.each(lineEndings)('container safety with $name checkout', ({ value }) => {
  it('accepts the canonical production artifacts through the real test runner', () => {
    const result = runSafety(value);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(['balanceframe.node', 'index.js', 'index.d.ts'])('rejects a missing %s COPY', (artifact) => {
    const result = runSafety(value, artifact);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${artifact} is copied into the runtime native package`);
  });
});
