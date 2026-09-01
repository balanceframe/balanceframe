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
const justfile = readFileSync(path.resolve(projectRoot, 'Justfile'), 'utf-8');
const releaseAssetsScript = readFileSync(
  path.resolve(projectRoot, 'scripts/release-assets.sh'),
  'utf-8',
);

function workflowStep(name: string): string {
  const lines = releaseWorkflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  if (start === -1) return '';

  const nextStep = lines.findIndex((line, index) => index > start && /^ {6}- name:/u.test(line));

  return lines.slice(start, nextStep === -1 ? undefined : nextStep).join('\n');
}

function justRecipe(name: string): string {
  const lines = justfile.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (start === -1) return '';

  const nextTopLevel = lines.findIndex(
    (line, index) => index > start && line !== '' && !/^[ \t]/u.test(line),
  );

  return lines.slice(start, nextTopLevel === -1 ? undefined : nextTopLevel).join('\n');
}

function expectParameterlessRecipe(name: string): string {
  const recipe = justRecipe(name);

  expect(recipe, `${name} recipe must exist`).not.toBe('');
  expect(recipe.split('\n')[0]).toBe(`${name}:`);
  expect(recipe).not.toMatch(/\{\{\s*TAG\s*\}\}/u);
  expect(recipe).not.toMatch(/\{\{\s*DIGEST\s*\}\}/u);

  return recipe;
}

function expectSafeSedReplacementDataFlow(): void {
  const lines = releaseAssetsScript.split(/\r?\n/u);
  const escapeFunctionStart = 'escape_sed_replacement() {';
  const escapedImageRef = `escaped_image_ref="$(printf '%s' "$image_ref" | escape_sed_replacement)"`;
  const escapedTag = `escaped_tag="$(printf '%s' "$TAG" | escape_sed_replacement)"`;
  const sedConstruction =
    'sed -i "s|IMAGE_REF_PLACEHOLDER|${escaped_image_ref}|; s|vTAG_PLACEHOLDER|${escaped_tag}|" "$out/compose.yaml"';
  const escapeStart = lines.indexOf(escapeFunctionStart);
  const escapedImageRefIndex = lines.indexOf(escapedImageRef);
  const escapedTagIndex = lines.indexOf(escapedTag);
  const sedConstructionIndex = lines.indexOf(sedConstruction);

  expect(lines.slice(escapeStart, escapeStart + 3)).toEqual([
    escapeFunctionStart,
    "  sed 's/[&|\\\\]/\\\\&/g'",
    '}',
  ]);
  expect(escapedImageRefIndex).toBeGreaterThan(escapeStart);
  expect(escapedTagIndex).toBeGreaterThan(escapedImageRefIndex);
  expect(sedConstructionIndex).toBeGreaterThan(escapedTagIndex);
}

const maliciousTag = 'v1.2.3";touch${IFS}--${IFS}"${INJECTION_MARKER}";#';
const benignDigest = `sha256:${'0'.repeat(64)}`;

function expectCommandAvailable(
  result: { error?: Error; status: number | null },
  command: string,
): void {
  expect(result.error, `${command} must be available`).toBeUndefined();
  expect(result.status, `${command} must exit normally`).not.toBeNull();
}

function expectGitValidTag(tag: string): void {
  const result = spawnSync('git', ['check-ref-format', `refs/tags/${tag}`]);

  expectCommandAvailable(result, 'git');
  expect(result.status).toBe(0);
}

describe('release recipe tag injection safety', () => {
  it('does not evaluate a release verification tag argument as shell source', () => {
    const recipe = expectParameterlessRecipe('release-verify');

    expect(recipe).toContain('ref="${RELEASE_TAG:?RELEASE_TAG is required}"');

    if (process.platform !== 'linux') return;

    const tempDir = mkdtempSync(path.join(tmpdir(), 'balanceframe-release-tag-'));
    const marker = path.join(tempDir, 'verification-injected');

    try {
      expectGitValidTag(maliciousTag);

      const argumentResult = spawnSync('just', ['release-verify', maliciousTag], {
        cwd: projectRoot,
        env: { ...process.env, INJECTION_MARKER: marker },
        stdio: 'ignore',
      });
      expectCommandAvailable(argumentResult, 'just');

      const environmentResult = spawnSync('just', ['release-verify'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          INJECTION_MARKER: marker,
          RELEASE_TAG: maliciousTag,
        },
        stdio: 'ignore',
      });
      expectCommandAvailable(environmentResult, 'just');

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not evaluate a release assets tag argument as shell source', () => {
    const recipe = expectParameterlessRecipe('release-assets');

    expect(recipe).toContain(': "${TAG:?TAG is required}"');
    expect(recipe).toContain(': "${DIGEST:?DIGEST is required}"');
    expect(recipe).toContain('scripts/release-assets.sh "$TAG" "$DIGEST"');

    if (process.platform !== 'linux') return;

    const tempDir = mkdtempSync(path.join(tmpdir(), 'balanceframe-release-tag-'));
    const marker = path.join(tempDir, 'assets-injected');

    try {
      expectGitValidTag(maliciousTag);

      const result = spawnSync('just', ['release-assets', maliciousTag, benignDigest], {
        cwd: projectRoot,
        env: { ...process.env, INJECTION_MARKER: marker },
        stdio: 'ignore',
      });
      expectCommandAvailable(result, 'just');

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('renders a Git-valid tag containing the sed delimiter literally', () => {
    expectSafeSedReplacementDataFlow();

    if (process.platform !== 'linux') return;

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

      expectCommandAvailable(result, 'scripts/release-assets.sh');
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
