import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseWorkflow = readFileSync(
  path.resolve(projectRoot, '.github/workflows/release.yml'),
  'utf-8',
);

function workflowStep(name: string): string {
  const lines = releaseWorkflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  if (start === -1) return '';

  const nextStep = lines.findIndex((line, index) => index > start && /^ {6}- name:/u.test(line));

  return lines.slice(start, nextStep === -1 ? undefined : nextStep).join('\n');
}

const maliciousTag = 'v1.2.3";touch${IFS}--${IFS}"${INJECTION_MARKER}";#';
const benignDigest = `sha256:${'0'.repeat(64)}`;

function expectGitValidTag(tag: string): void {
  const result = spawnSync('git', ['check-ref-format', `refs/tags/${tag}`]);

  expect(result.status).toBe(0);
}

describe('release recipe tag injection safety', () => {
  it('does not evaluate a release verification tag argument as shell source', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'balanceframe-release-tag-'));
    const marker = path.join(tempDir, 'verification-injected');

    try {
      expectGitValidTag(maliciousTag);

      spawnSync('just', ['release-verify', maliciousTag], {
        cwd: projectRoot,
        env: { ...process.env, INJECTION_MARKER: marker },
        stdio: 'ignore',
      });

      spawnSync('just', ['release-verify'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          INJECTION_MARKER: marker,
          RELEASE_TAG: maliciousTag,
        },
        stdio: 'ignore',
      });

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not evaluate a release assets tag argument as shell source', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'balanceframe-release-tag-'));
    const marker = path.join(tempDir, 'assets-injected');

    try {
      expectGitValidTag(maliciousTag);

      spawnSync('just', ['release-assets', maliciousTag, benignDigest], {
        cwd: projectRoot,
        env: { ...process.env, INJECTION_MARKER: marker },
        stdio: 'ignore',
      });

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('renders a Git-valid tag containing the sed delimiter literally', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'balanceframe-release-assets-'));
    const delimiterTag = 'v1.2.3-rc|1';
    const generatedCompose = path.join(tempDir, '_release', delimiterTag, 'compose.yaml');

    try {
      expectGitValidTag(delimiterTag);

      const result = spawnSync(
        path.resolve(projectRoot, 'scripts/release-assets.sh'),
        [delimiterTag, benignDigest],
        {
          cwd: tempDir,
          stdio: 'ignore',
        },
      );

      expect(result.status).toBe(0);
      const compose = readFileSync(generatedCompose, 'utf-8');
      expect(compose).toContain(delimiterTag);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes the GitHub tag through the environment to release verification', () => {
    const verificationStep = workflowStep('Tag/version policy verification');

    expect(verificationStep, 'release verification step must exist').not.toBe('');
    expect(verificationStep).toMatch(/^ {10}RELEASE_TAG: \$\{\{ github\.ref_name \}\}[ \t]*$/mu);
    expect(verificationStep).toMatch(
      /^[ \t]+(?:run:[ \t]+)?nix develop \.#release --command just release-verify[ \t]*$/mu,
    );
  });

  it('passes the release asset inputs through the environment', () => {
    const assetsStep = workflowStep('Generate release assets');

    expect(assetsStep, 'release assets step must exist').not.toBe('');
    expect(assetsStep).toMatch(/^ {10}TAG: \$\{\{ github\.ref_name \}\}[ \t]*$/mu);
    expect(assetsStep).toMatch(/^ {10}DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}[ \t]*$/mu);
    expect(assetsStep).toMatch(
      /^[ \t]+(?:run:[ \t]+)?nix develop \.#release --command just release-assets[ \t]*$/mu,
    );
  });
});
