/**
 * Tests for fail-closed credential key recovery/storage.
 *
 * Distinguishes missing vs corrupt key. Avoids unsafe replacement.
 * Prefers externally supplied/OS-backed secret when available.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EncryptedCredentialStore,
  EnvCredentialStore,
  NullCredentialStore,
} from '../src/credentials';
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  rmSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MASTER_KEY_FILENAME = 'master.key';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf-cred-test-'));
}

// File persistence and POSIX mode bits apply only where the store is supported.
if (process.platform !== 'win32') describe('POSIX EncryptedCredentialStore — corrupt vs missing', () => {
  it('persists encrypted credentials across instances with private directory and files', async () => {
    const dir = tempDir();
    const credentials = {
      serverUrl: 'http://posix-fixture:5006',
      secretKey: 'test-only-persistent-secret',
      budgetPassword: 'test-only-budget-password',
    };
    try {
      await new EncryptedCredentialStore({ credentialDir: dir }).store(credentials);
      expect(await new EncryptedCredentialStore({ credentialDir: dir }).load()).toEqual(credentials);
      expect(statSync(dir).mode & 0o077).toBe(0);
      const files = readdirSync(dir);
      expect(files).toHaveLength(3);
      expect(files).toContain('master.key');
      expect(files).toContain('current.txt');
      const encryptedFiles = files.filter((file) => file.endsWith('.enc'));
      expect(encryptedFiles).toHaveLength(1);
      for (const file of files) {
        expect(statSync(join(dir, file)).mode & 0o177).toBe(0);
      }
      const persisted = readFileSync(join(dir, encryptedFiles[0]), 'utf8');
      expect(persisted).not.toContain(credentials.secretKey);
      expect(persisted).not.toContain(credentials.budgetPassword);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no credential file exists (missing case)', async () => {
    const dir = tempDir();
    const store = new EncryptedCredentialStore({ credentialDir: dir });
    const result = await store.load();
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when master.key exists but no .enc file exists', async () => {
    const dir = tempDir();
    // Create a master key file so the store can encrypt
    const keyBuf = Buffer.alloc(32, 'a');
    writeFileSync(join(dir, MASTER_KEY_FILENAME), keyBuf.toString('hex'));
    const store = new EncryptedCredentialStore({ credentialDir: dir });
    const result = await store.load();
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on corrupt credential file (corrupt case, not throw)', async () => {
    const dir = tempDir();
    // Create a master key
    const keyBuf = Buffer.alloc(32, 'a');
    writeFileSync(join(dir, MASTER_KEY_FILENAME), keyBuf.toString('hex'));
    // Write a corrupt .enc file
    writeFileSync(join(dir, 'deadbeef.enc'), 'this-is-not-valid-json');
    const store = new EncryptedCredentialStore({ credentialDir: dir });
    const result = await store.load();
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on tampered payload (corrupt case, GCM will reject)', async () => {
    const dir = tempDir();
    const store = new EncryptedCredentialStore({ credentialDir: dir });
    await store.store({
      serverUrl: 'http://localhost:5006',
      secretKey: 'my-secret',
    });
    // Find and corrupt the .enc file specifically
    const files = readdirSync(dir).filter((f) => f.endsWith('.enc') && f !== MASTER_KEY_FILENAME);
    if (files.length > 0) {
      const filePath = join(dir, files[0]);
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const lastCharacter = raw.payload.ciphertext.at(-1);
      raw.payload.ciphertext = `${raw.payload.ciphertext.slice(0, -1)}${lastCharacter === '0' ? '1' : '0'}`;
      writeFileSync(filePath, JSON.stringify(raw));
    }

    const store2 = new EncryptedCredentialStore({ credentialDir: dir });
    const result = await store2.load();
    // Must return null on corruption, NOT throw
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not overwrite or replace master.key on load when corrupt', async () => {
    const dir = tempDir();
    // Create a known master key
    const knownKey = Buffer.alloc(32, 'a').toString('hex');
    writeFileSync(join(dir, MASTER_KEY_FILENAME), knownKey);
    // Write a corrupt .enc
    writeFileSync(join(dir, 'deadbeef.enc'), 'corrupt-data');
    const store = new EncryptedCredentialStore({ credentialDir: dir });
    const result = await store.load();
    expect(result).toBeNull();
    // Master key must remain intact
    const persistedKey = readFileSync(join(dir, MASTER_KEY_FILENAME), 'utf-8');
    expect(persistedKey).toBe(knownKey);
    rmSync(dir, { recursive: true, force: true });
  });

  it('successfully loads valid credentials after storing them', async () => {
    const dir = tempDir();
    const store = new EncryptedCredentialStore({ credentialDir: dir });
    await store.store({
      serverUrl: 'http://localhost:5006',
      secretKey: 'correct-secret',
    });

    const result = await store.load();
    expect(result).not.toBeNull();
    expect(result!.serverUrl).toBe('http://localhost:5006');
    expect(result!.secretKey).toBe('correct-secret');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('native Windows refusal preserves existing files — on every host', () => {
  it('leaves the key, active pointer, credential, and unrelated file unchanged', () => {
    const dir = tempDir();
    const files = new Map([
      ['master.key', Buffer.alloc(32, 0x42)],
      ['current.txt', Buffer.from('http://preserved-fixture:5006')],
      ['existing.enc', Buffer.from('existing encrypted fixture')],
      ['unrelated.txt', Buffer.from('leave this file alone')],
    ]);
    try {
      for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      expect(() => new EncryptedCredentialStore({ credentialDir: dir })).toThrow(
        /unsupported on native Windows/,
      );
      expect(readdirSync(dir).sort()).toEqual([...files.keys()].sort());
      for (const [name, bytes] of files) expect(readFileSync(join(dir, name))).toEqual(bytes);
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EnvCredentialStore — prefers OS-backed secrets', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('loads credentials from environment variables', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_SECRET_KEY = 'env-secret';
    const store = new EnvCredentialStore();
    const result = await store.load();
    expect(result).not.toBeNull();
    expect(result!.serverUrl).toBe('http://localhost:5006');
    expect(result!.secretKey).toBe('env-secret');
  });

  it('returns null when environment variables are not set', async () => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_SECRET_KEY;
    const store = new EnvCredentialStore();
    const result = await store.load();
    expect(result).toBeNull();
  });

  it('has() matches load() availability', async () => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_SECRET_KEY;
    const store = new EnvCredentialStore();
    expect(store.has()).toBe(false);

    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_SECRET_KEY = 'secret';
    expect(store.has()).toBe(true);
  });

  it('store() is a no-op that does not persist to env', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_SECRET_KEY = 'secret';
    const store = new EnvCredentialStore();
    await store.store({ serverUrl: 'http://new-url', secretKey: 'new-secret' });
    // Environment is unchanged
    expect(process.env.ACTUAL_SERVER_URL).toBe('http://localhost:5006');
    expect(process.env.ACTUAL_SECRET_KEY).toBe('secret');
  });
});

describe('NullCredentialStore — deterministic testing', () => {
  it('returns null when empty', async () => {
    const store = new NullCredentialStore();
    expect(await store.load()).toBeNull();
    expect(store.has()).toBe(false);
  });

  it('round-trips credentials', async () => {
    const store = new NullCredentialStore();
    await store.store({ serverUrl: 'http://test', secretKey: 'test-key' });
    const result = await store.load();
    expect(result).not.toBeNull();
    expect(result!.serverUrl).toBe('http://test');
  });
});
