import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseWorkflow = fs.readFileSync(
  path.resolve(projectRoot, '.github/workflows/release.yml'),
  'utf-8',
);
const testWorkflow = fs.readFileSync(
  path.resolve(projectRoot, '.github/workflows/test.yml'),
  'utf-8',
);

function section(source: string, name: string, indentation: number): string {
  const lines = source.split(/\r?\n/u);
  const prefix = ' '.repeat(indentation);
  const start = lines.findIndex((line) => line === `${prefix}${name}:`);
  if (start === -1) return '';

  const end = lines.findIndex((line, index) => {
    if (index <= start || /^\s*(?:#.*)?$/u.test(line)) return false;
    const leadingWhitespace = line.match(/^\s*/u)?.[0].length ?? 0;
    return leadingWhitespace <= indentation;
  });

  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

const releasePermissions = section(releaseWorkflow, 'permissions', 0);
const verifyJob = section(releaseWorkflow, 'verify', 2);
const publishJob = section(releaseWorkflow, 'publish', 2);
const verifyPermissions = section(verifyJob, 'permissions', 4);
const publishPermissions = section(publishJob, 'permissions', 4);
const testPermissions = section(testWorkflow, 'permissions', 0);

describe('release workflow permissions', () => {
  it('keeps workflow-level permissions from granting writes to every job', () => {
    expect(releasePermissions, 'release workflow permissions must exist').not.toBe('');
    expect(releasePermissions).not.toMatch(/^ {2}[\w-]+:\s*write\s*$/mu);
    expect(releasePermissions).not.toMatch(/^ {2}id-token:/mu);
  });

  it('gives the verification job read-only repository access', () => {
    expect(verifyPermissions, 'jobs.verify.permissions must exist').not.toBe('');
    expect(verifyPermissions).toMatch(/^ {6}contents:\s*read\s*$/mu);
    expect(verifyPermissions).not.toMatch(/^ {6}[\w-]+:\s*write\s*$/mu);
    expect(verifyPermissions).not.toMatch(/^ {6}id-token:/mu);
  });

  it('grants publication credentials only to the publish job', () => {
    expect(publishPermissions, 'jobs.publish.permissions must exist').not.toBe('');
    expect(publishPermissions).toMatch(/^ {6}contents:\s*write\s*$/mu);
    expect(publishPermissions).toMatch(/^ {6}packages:\s*write\s*$/mu);
    expect(publishPermissions).toMatch(/^ {6}id-token:\s*write\s*$/mu);

    expect(releasePermissions).not.toMatch(/^ {2}(?:contents|packages|id-token):\s*write\s*$/mu);
    expect(verifyPermissions).not.toMatch(/^ {6}(?:contents|packages|id-token):\s*write\s*$/mu);
  });
});

describe('pull request workflow permissions', () => {
  it('retains read-only permissions without security-events write access', () => {
    expect(testPermissions, 'test workflow permissions must exist').not.toBe('');
    expect(testPermissions).toMatch(/^ {2}contents:\s*read\s*$/mu);
    expect(testPermissions).toMatch(/^ {2}actions:\s*read\s*$/mu);
    expect(testPermissions).not.toMatch(/^ {2}security-events:\s*write\s*$/mu);
  });
});
