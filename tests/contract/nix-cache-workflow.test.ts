import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_ACTION = 'nix-community/cache-nix-action';
const CACHE_ACTION_COMMIT = '7df957e333c1e5da7721f60227dbba6d06080569';

const workflows = [
  { filename: 'release.yml', expectedCacheSteps: 2 },
  { filename: 'test.yml', expectedCacheSteps: 1 },
].map((workflow) => ({
  ...workflow,
  source: fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github/workflows', workflow.filename),
    'utf-8',
  ),
}));

function actionReferences(source: string, action: string): string[] {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(
    source.matchAll(
      new RegExp(
        `^\\s*(?:-\\s*)?uses:\\s*(["']?)${escapedAction}@([^\\s#"']+)\\1\\s*(?:#.*)?$`,
        'gm',
      ),
    ),
    (match) => {
      const reference = match[2];
      if (reference === undefined) {
        throw new Error(`Could not read the ${action} reference`);
      }
      return reference;
    },
  );
}

function cacheActionSteps(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const usesPattern = new RegExp(
    `^(\\s*)(?:-\\s*)?uses:\\s*(["']?)${CACHE_ACTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@`,
  );
  const usesIndexes = lines.flatMap((line, index) => (usesPattern.test(line) ? [index] : []));

  return usesIndexes.map((usesIndex) => {
    const usesLine = lines[usesIndex];
    if (usesLine === undefined) {
      throw new Error(`Missing ${CACHE_ACTION} workflow step`);
    }
    const usesIndent = usesLine.match(/^\s*/)?.[0].length ?? 0;
    const isDirectStep = /^\s*-\s*uses:/.test(usesLine);
    let stepIndent = usesIndent;
    let startIndex = usesIndex;

    if (!isDirectStep) {
      for (let index = usesIndex - 1; index >= 0; index -= 1) {
        const line = lines[index];
        const stepMatch = line?.match(/^(\s*)-\s+\S/);
        const indent = stepMatch?.[1]?.length;
        if (indent !== undefined && indent < usesIndent) {
          stepIndent = indent;
          startIndex = index;
          break;
        }
      }
    }

    let endIndex = lines.length;
    for (let index = usesIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const nextItem = line?.match(/^(\s*)-\s+\S/);
      const indent = nextItem?.[1]?.length;
      if (indent !== undefined && indent <= stepIndent) {
        endIndex = index;
        break;
      }
    }

    return lines.slice(startIndex, endIndex).join('\n');
  });
}

function inputValue(step: string, input: string): string | undefined {
  const lines = step.split('\n');
  const withIndex = lines.findIndex((line) => /^\s*with:\s*(?:#.*)?$/.test(line));
  if (withIndex === -1) {
    return undefined;
  }

  const withIndent = lines[withIndex]?.match(/^\s*/)?.[0].length ?? 0;
  for (let index = withIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || /^\s*(?:#.*)?$/.test(line)) {
      continue;
    }

    const entry = line.match(/^(\s*)([^:#]+):\s*(.*?)\s*$/);
    if ((line.match(/^\s*/)?.[0].length ?? 0) <= withIndent) {
      break;
    }
    const value = entry?.[3];
    if (entry?.[2]?.trim() === input && value !== undefined) {
      return value;
    }
  }

  return undefined;
}

describe.each(workflows)('Nix cache contract for $filename', ({ source, expectedCacheSteps }) => {
  it('does not use the deprecated magic Nix cache action', () => {
    expect(source).not.toContain('DeterminateSystems/magic-nix-cache-action');
  });

  it('uses the required number of supported cache actions at the approved commit', () => {
    expect(actionReferences(source, CACHE_ACTION)).toEqual(
      Array.from({ length: expectedCacheSteps }, () => CACHE_ACTION_COMMIT),
    );
  });

  it('keys every cache step by runner OS and the flake files', () => {
    const steps = cacheActionSteps(source);
    expect(steps).toHaveLength(expectedCacheSteps);

    for (const step of steps) {
      const primaryKey = inputValue(step, 'primary-key');
      const restorePrefix = inputValue(step, 'restore-prefixes-first-match');

      expect(primaryKey).toBeDefined();
      expect(primaryKey).toMatch(
        /^(["']?)nix-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\([^)]*\)\s*\}\}\1$/,
      );
      const hashFilesArguments = primaryKey?.match(/\$\{\{\s*hashFiles\(([^)]*)\)\s*\}\}/)?.[1];
      expect(hashFilesArguments).toContain('flake.nix');
      expect(hashFilesArguments).toContain('flake.lock');
      expect(restorePrefix).toMatch(/^(["']?)nix-\$\{\{\s*runner\.os\s*\}\}-\1$/);
    }
  });
});
