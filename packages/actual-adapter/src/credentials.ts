/**
 * Credential storage for Actual server credentials.
 *
 * Supports: environment-variable injection, secret-file loading,
 * runtime injection, rotation, and deletion.
 * Credentials are encrypted at rest using AES-256-GCM.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
} from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActualCredentials {
  /** Actual server URL (e.g. http://localhost:5006). */
  serverUrl: string;
  /** Secret key / password for the Actual server. */
  secretKey: string;
  /** Optional E2E password for encrypted budgets. */
  budgetPassword?: string;
}

export interface CredentialStore {
  /** Store credentials, encrypting them at rest. */
  store(credentials: ActualCredentials): Promise<void>;
  /** Retrieve stored credentials, decrypting them. */
  load(): Promise<ActualCredentials | null>;
  /** Check if credentials exist. */
  has(): boolean;
  /** List stored credential identifiers (server URLs). */
  list(): string[];
  /** Rotate credentials — store new values (replaces existing). */
  rotate(credentials: ActualCredentials): Promise<void>;
  /** Delete stored credentials and associated encryption material. */
  delete(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Encryption constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ITERATIONS = 600_000;
const DIGEST = 'sha512';

// ---------------------------------------------------------------------------
// Key derivation (stateless helpers)
// ---------------------------------------------------------------------------

function deriveKey(password: Buffer, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

function deriveMachineSecret(): string {
  const hostname = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'unknown';
  const fallback = process.env.BALANCEFRAME_CREDENTIAL_SECRET ?? '';
  const machinePart = hostname + fallback;
  return machinePart || randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { ciphertext: encrypted, iv: iv.toString('hex'), tag };
}

function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// File layout
// ---------------------------------------------------------------------------

interface StoredCredential {
  serverUrl: string;
  secretKey: EncryptedPayload;
  budgetPassword?: EncryptedPayload;
  salt: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export const CREDENTIAL_DIR_ENV = 'BALANCEFRAME_CREDENTIAL_DIR';

function credentialDir(): string {
  if (process.env[CREDENTIAL_DIR_ENV]) {
    return resolve(process.env[CREDENTIAL_DIR_ENV]);
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return resolve(home, '.balanceframe', 'credentials');
}

function credentialFilePath(serverUrl: string, dir?: string): string {
  const base = dir ?? credentialDir();
  const safeName = serverUrl
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/:(\d+)/, '_$1');
  return resolve(base, `${safeName}.enc`);
}

// ---------------------------------------------------------------------------
// EncryptedCredentialStore
// ---------------------------------------------------------------------------

export class EncryptedCredentialStore implements CredentialStore {
  private readonly _dir: string;
  private _machineSecret: string | undefined;
  private _derivedKey: Buffer | null = null;
  private _keySalt: Buffer | null = null;

  constructor(opts?: { credentialDir?: string; machineSecret?: string }) {
    this._dir = opts?.credentialDir ?? credentialDir();
    this._machineSecret = opts?.machineSecret;
  }

  private getOrDeriveKey(saltIn?: Buffer): Buffer {
    if (this._derivedKey && !saltIn) return this._derivedKey;
    const secret = this._machineSecret ?? deriveMachineSecret();
    const salt = saltIn ?? randomBytes(SALT_LENGTH);
    this._keySalt = salt;
    this._derivedKey = deriveKey(Buffer.from(secret), salt);
    return this._derivedKey;
  }

  private ensureDir(): void {
    mkdirSync(this._dir, { recursive: true });
  }

  async store(credentials: ActualCredentials): Promise<void> {
    this.ensureDir();
    const key = this.getOrDeriveKey();

    const stored: StoredCredential = {
      serverUrl: credentials.serverUrl,
      secretKey: encrypt(credentials.secretKey, key),
      salt: this._keySalt?.toString('hex') ?? '',
    };
    if (credentials.budgetPassword) {
      stored.budgetPassword = encrypt(credentials.budgetPassword, key);
    }

    const filePath = credentialFilePath(credentials.serverUrl, this._dir);
    writeFileSync(filePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  async load(): Promise<ActualCredentials | null> {
    if (process.env.ACTUAL_SERVER_URL && process.env.ACTUAL_SECRET_KEY) {
      return {
        serverUrl: process.env.ACTUAL_SERVER_URL,
        secretKey: process.env.ACTUAL_SECRET_KEY,
        budgetPassword: process.env.ACTUAL_BUDGET_PASSWORD || undefined,
      };
    }

    try {
      const files = readdirSync(this._dir).filter(f => f.endsWith('.enc'));
      if (files.length === 0) return null;
      return this.loadFromFile(resolve(this._dir, files[0]));
    } catch {
      return null;
    }
  }

  private loadFromFile(filePath: string): ActualCredentials | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const stored: StoredCredential = JSON.parse(raw);
      const salt = Buffer.from(stored.salt, 'hex');
      const key = this.getOrDeriveKey(salt);
      return {
        serverUrl: stored.serverUrl,
        secretKey: decrypt(stored.secretKey, key),
        budgetPassword: stored.budgetPassword
          ? decrypt(stored.budgetPassword, key)
          : undefined,
      };
    } catch {
      return null;
    }
  }

  has(): boolean {
    if (process.env.ACTUAL_SERVER_URL && process.env.ACTUAL_SECRET_KEY) return true;
    try {
      const files = readdirSync(this._dir).filter(f => f.endsWith('.enc'));
      return files.length > 0;
    } catch {
      return false;
    }
  }

  list(): string[] {
    const urls: string[] = [];
    if (process.env.ACTUAL_SERVER_URL) urls.push(process.env.ACTUAL_SERVER_URL);
    try {
      const files = readdirSync(this._dir).filter(f => f.endsWith('.enc'));
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(this._dir, file), 'utf-8');
          const stored: StoredCredential = JSON.parse(raw);
          if (stored.serverUrl) urls.push(stored.serverUrl);
        } catch {
          // skip
        }
      }
    } catch {
      // directory may not exist
    }
    return [...new Set(urls)];
  }

  async rotate(credentials: ActualCredentials): Promise<void> {
    await this.delete();
    this._derivedKey = null;
    this._keySalt = null;
    await this.store(credentials);
  }

  async delete(): Promise<void> {
    try {
      const files = readdirSync(this._dir).filter(f => f.endsWith('.enc'));
      for (const file of files) {
        rmSync(resolve(this._dir, file), { force: true });
      }
    } catch {
      // nothing to clean
    }
  }
}

// ---------------------------------------------------------------------------
// Environment-variable injected store (no persistence)
// ---------------------------------------------------------------------------

export class EnvCredentialStore implements CredentialStore {
  async store(_credentials: ActualCredentials): Promise<void> {
    // No-op: environment variables are the source of truth
  }

  async load(): Promise<ActualCredentials | null> {
    const serverUrl = process.env.ACTUAL_SERVER_URL;
    const secretKey = process.env.ACTUAL_SECRET_KEY;
    if (!serverUrl || !secretKey) return null;
    return { serverUrl, secretKey, budgetPassword: process.env.ACTUAL_BUDGET_PASSWORD || undefined };
  }

  has(): boolean {
    return !!process.env.ACTUAL_SERVER_URL && !!process.env.ACTUAL_SECRET_KEY;
  }

  list(): string[] {
    return process.env.ACTUAL_SERVER_URL ? [process.env.ACTUAL_SERVER_URL] : [];
  }

  async rotate(_credentials: ActualCredentials): Promise<void> {
    // No-op: environment variables define the credentials
  }

  async delete(): Promise<void> {
    // No-op: environment variables are removed by the user
  }
}

// ---------------------------------------------------------------------------
// Null store (for deterministic testing)
// ---------------------------------------------------------------------------

export class NullCredentialStore implements CredentialStore {
  private creds: ActualCredentials | null = null;

  async store(credentials: ActualCredentials): Promise<void> {
    this.creds = credentials;
  }

  async load(): Promise<ActualCredentials | null> {
    return this.creds;
  }

  has(): boolean {
    return this.creds !== null;
  }

  list(): string[] {
    return this.creds ? [this.creds.serverUrl] : [];
  }

  async rotate(credentials: ActualCredentials): Promise<void> {
    this.creds = credentials;
  }

  async delete(): Promise<void> {
    this.creds = null;
  }
}
