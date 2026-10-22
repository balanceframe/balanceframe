import { mkdirSync } from 'node:fs';
import { join, parse, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActualConnector } from '../src/connector.js';

const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  return {
    ...path,
    resolve: (...paths: string[]) => (platform.windows ? path.win32 : path).resolve(...paths),
    dirname: (value: string) => (platform.windows ? path.win32 : path).dirname(value),
  };
});
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: vi.fn(),
}));

type CacheSubject = { cacheDirFor(key: string): string };

describe.each([
  {
    name: 'native temporary directory',
    base: join(tmpdir(), 'bf-cache-containment'),
    windows: false,
  },
  { name: 'native filesystem root', base: parse(tmpdir()).root, windows: false },
  { name: 'Windows directory', base: 'C:\\bf-cache-containment', windows: true },
  { name: 'Windows drive root', base: 'C:\\', windows: true },
  { name: 'Windows share root', base: '\\\\server\\share\\', windows: true },
])('cache containment in $name', ({ base, windows }) => {
  let subject: CacheSubject;
  const child = (name: string) => (windows ? win32.join(base, name) : join(base, name));

  beforeEach(() => {
    platform.windows = windows;
    vi.mocked(mkdirSync).mockClear();
    // Exercise the actual guard without constructing a connector or touching any filesystem root.
    subject = Object.create(ActualConnector.prototype) as CacheSubject;
    Object.defineProperty(subject, 'baseCacheDir', { value: base });
  });

  it.each([
    ['http://localhost:5006', 'http___localhost_5006'],
    ['http://test:5006', 'http___test_5006'],
    ['budget-123.group_id', 'budget-123.group_id'],
  ])('admits the sanitized direct child for %s', (key, safeName) => {
    expect(subject.cacheDirFor(key)).toBe(child(safeName));
    expect(mkdirSync).toHaveBeenCalledExactlyOnceWith(child(safeName), {
      recursive: true,
      mode: 0o700,
    });
  });

  it.each(['', '.', '..'])('rejects a key resolving to the base or its parent: %j', (key) => {
    expect(() => subject.cacheDirFor(key)).toThrow(/Cache path traversal blocked/);
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('keeps separator-bearing traversal aliases inside the base', () => {
    for (const key of ['../outside', '..\\outside'])
      expect(subject.cacheDirFor(key)).toBe(child('.._outside'));
    expect(subject.cacheDirFor('../bf-cache-containment-sibling/budget')).toBe(
      child('.._bf-cache-containment-sibling_budget'),
    );
    expect(subject.cacheDirFor('/outside')).toBe(child('_outside'));
    expect(subject.cacheDirFor('C:\\outside')).toBe(child('C__outside'));
  });

  it('keeps distinct budget and sibling-prefix keys isolated', () => {
    const budget = subject.cacheDirFor('budget');
    const siblingPrefix = subject.cacheDirFor('budget-other');
    expect(budget).toBe(child('budget'));
    expect(siblingPrefix).toBe(child('budget-other'));
    expect(budget).not.toBe(siblingPrefix);
  });
});
