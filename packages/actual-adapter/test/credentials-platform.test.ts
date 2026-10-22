/** Platform refusal is exercised on every host; no disk encryption is needed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { EncryptedCredentialStore, EnvCredentialStore } from '../src/credentials';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));
vi.mock('node:path', () => ({ resolve: vi.fn() }));

const unsupportedPlatform =
  /EncryptedCredentialStore is unsupported on native Windows.*EnvCredentialStore.*Linux.*Docker/;

describe('native Windows credential storage — on every host', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['default options', undefined],
    ['explicit directory', { credentialDir: 'unused-directory' }],
    ['supplied master key', { credentialDir: 'unused-directory', masterKey: Buffer.alloc(32) }],
    ['invalid master key', { credentialDir: 'unused-directory', masterKey: Buffer.alloc(1) }],
  ])('rejects %s before any filesystem or path access', (_name, options) => {
    expect(() => new EncryptedCredentialStore(options)).toThrow(unsupportedPlatform);
    expect(resolve).not.toHaveBeenCalled();
    for (const operation of Object.values(fs)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('rejects before reading options or directory configuration', () => {
    const readOption = vi.fn((): never => {
      throw new Error('must not inspect options');
    });
    const options = {
      get credentialDir(): string { return readOption(); },
      get masterKey(): Buffer { return readOption(); },
    };
    const originalEnv = process.env;
    const readConfig = vi.fn();
    process.env = new Proxy(originalEnv, {
      get(target, key) {
        if (['BALANCEFRAME_CREDENTIAL_DIR', 'HOME', 'USERPROFILE'].includes(String(key))) {
          readConfig();
          throw new Error('must not inspect credential directory configuration');
        }
        return Reflect.get(target, key);
      },
    });
    let defaultError: unknown;
    let optionsError: unknown;
    try {
      try { new EncryptedCredentialStore(); } catch (error) { defaultError = error; }
      try { new EncryptedCredentialStore(options); } catch (error) { optionsError = error; }
    } finally {
      process.env = originalEnv;
    }
    expect(defaultError).toBeInstanceOf(Error);
    expect((defaultError as Error).message).toMatch(unsupportedPlatform);
    expect(optionsError).toBeInstanceOf(Error);
    expect((optionsError as Error).message).toMatch(unsupportedPlatform);
    expect(readOption).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    for (const operation of Object.values(fs)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('keeps the explicitly selected environment store usable without file access', async () => {
    vi.stubEnv('ACTUAL_SERVER_URL', 'http://windows-fixture:5006');
    vi.stubEnv('ACTUAL_SECRET_KEY', 'test-only-environment-secret');
    vi.stubEnv('ACTUAL_BUDGET_PASSWORD', 'test-only-budget-password');
    const credentials = {
      serverUrl: 'http://windows-fixture:5006',
      secretKey: 'test-only-environment-secret',
      budgetPassword: 'test-only-budget-password',
    };
    expect(() => new EncryptedCredentialStore()).toThrow(unsupportedPlatform);
    const store = new EnvCredentialStore();
    expect(await store.load()).toEqual(credentials);
    expect(store.has()).toBe(true);
    expect(store.list()).toEqual([credentials.serverUrl]);
    await store.store({ serverUrl: 'http://unused', secretKey: 'unused' });
    await store.rotate({ serverUrl: 'http://unused', secretKey: 'unused' });
    await store.delete();
    expect(await store.load()).toEqual(credentials);
    expect(resolve).not.toHaveBeenCalled();
    for (const operation of Object.values(fs)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
});
