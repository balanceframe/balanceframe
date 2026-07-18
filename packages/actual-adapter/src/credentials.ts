/**
 * Credential storage for Actual server credentials.
 *
 * Supports: environment-variable injection (EnvCredentialStore),
 * encrypted file persistence (EncryptedCredentialStore),
 * and in-memory testing (NullCredentialStore).
 * Credentials are encrypted at rest using AES-256-GCM with AAD binding
 * to the server URL to detect tampering.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  createHash,
} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
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

/** Name of the persistent master key file in the credential directory. */
const MASTER_KEY_FILENAME = 'master.key';
/** Name of the file tracking which server URL credential is active. */
const CURRENT_CREDENTIAL_FILENAME = 'current.txt';

// ---------------------------------------------------------------------------
// Key derivation (stateless helpers)
// ---------------------------------------------------------------------------

function deriveKey(password: Buffer, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM with optional AAD)
// ---------------------------------------------------------------------------

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

function encrypt(plaintext: string, key: Buffer, aad?: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { ciphertext: encrypted, iv: iv.toString('hex'), tag };
}

function decrypt(payload: EncryptedPayload, key: Buffer, aad?: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// Secure file helpers
// ---------------------------------------------------------------------------

/**
 * Atomically write data to a file: write to a .tmp sibling, then rename.
 * This prevents partial writes from being observed and avoids temporary
 * files surviving after a successful write.
 */
function writeFileAtomic(filePath: string, data: string | Buffer, mode?: number): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, data, { mode: mode ?? 0o600 });
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export const CREDENTIAL_DIR_ENV = 'BALANCEFRAME_CREDENTIAL_DIR';

function credentialDir(): string {
  if (process.env[CREDENTIAL_DIR_ENV]) {
    return resolve(process.env[CREDENTIAL_DIR_ENV]);
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error(
      `Cannot determine credential directory. ` +
      `Set ${CREDENTIAL_DIR_ENV} or ensure HOME/USERPROFILE is set.`,
    );
  }
  return resolve(home, '.balanceframe', 'credentials');
}

/**
 * Resolve the file path for a credential corresponding to the given server URL.
 * Uses a SHA-256 hash of the URL as the filename to prevent collisions,
 * path traversal, and filesystem encoding issues.
 */
function credentialFilePath(serverUrl: string, dir?: string): string {
  const base = dir ?? credentialDir();
  const hash = createHash('sha256').update(serverUrl).digest('hex');
  return resolve(base, `${hash}.enc`);
}

function masterKeyPath(dir: string): string {
  return resolve(dir, MASTER_KEY_FILENAME);
}

function currentUrlPath(dir: string): string {
  return resolve(dir, CURRENT_CREDENTIAL_FILENAME);
}

/**
 * Load the persistent master encryption key from disk, or generate a
 * cryptographically random one on first use. The key is stored atomically
 * with restrictive permissions (0o600) in the credential directory.
 * This replaces the previous predictable HOSTNAME-derived secret.
 */
function loadOrCreateMasterKey(dir: string): Buffer {
  const keyPath = masterKeyPath(dir);
  try {
    const raw = readFileSync(keyPath);
    if (raw.length === KEY_LENGTH) return raw;
    // Invalid key length — regenerate
  } catch {
    // File doesn't exist — will create below
  }
  const key = randomBytes(KEY_LENGTH);
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  writeFileAtomic(keyPath, key, 0o600);
  return key;
}

// ---------------------------------------------------------------------------
// Format detection helpers
// ---------------------------------------------------------------------------

function isV2Record(stored: Record<string, unknown>): boolean {
  return 'payload' in stored && stored.payload !== null && typeof stored.payload === 'object';
}

function isV1Record(stored: Record<string, unknown>): boolean {
  return 'secretKey' in stored && stored.secretKey !== null && typeof stored.secretKey === 'object';
}

// ---------------------------------------------------------------------------
// EncryptedCredentialStore
// ---------------------------------------------------------------------------

/**
 * Credential store backed by an encrypted file on disk.
 *
 * - A randomly generated 32-byte master key is stored once in `master.key`
 *   and reused across restarts.
 * - Per-credential PBKDF2 salt provides forward secrecy and isolation.
 * - The server URL is authenticated as GCM additional authenticated data (AAD),
 *   so any tampering with the stored URL causes decryption to fail.
 * - The active credential is tracked via `current.txt` to avoid arbitrary
 *   file selection when multiple credential files exist.
 * - Files are written atomically with restrictive permissions (0o600).
 */
export class EncryptedCredentialStore implements CredentialStore {
  private readonly _dir: string;
  private _masterKey: Buffer | null = null;
  private _derivedKey: Buffer | null = null;
  private _keySalt: Buffer | null = null;
  /** Cached active server URL to avoid redundant file reads. */
  private _activeUrl: string | null = null;

  constructor(opts?: { credentialDir?: string; masterKey?: Buffer }) {
    this._dir = opts?.credentialDir ?? credentialDir();
    if (opts?.masterKey) {
      if (opts.masterKey.length !== KEY_LENGTH) {
        throw new Error(
          `masterKey must be exactly ${KEY_LENGTH} bytes (got ${opts.masterKey.length})`,
        );
      }
      this._masterKey = opts.masterKey;
    }
  }

  private getOrCreateMasterKey(): Buffer {
    if (this._masterKey) return this._masterKey;
    this._masterKey = loadOrCreateMasterKey(this._dir);
    return this._masterKey;
  }

  /**
   * Derive an encryption key from the master key and an optional salt.
   * When `saltIn` is provided (loading path), it re-derives from the stored salt.
   * When `saltIn` is omitted (storing path), a new random salt is generated.
   */
  private getOrDeriveKey(saltIn?: Buffer): Buffer {
    if (this._derivedKey && saltIn === undefined) return this._derivedKey;
    const masterKey = this.getOrCreateMasterKey();
    const salt = saltIn ?? randomBytes(SALT_LENGTH);
    this._keySalt = salt;
    this._derivedKey = deriveKey(masterKey, salt);
    return this._derivedKey;
  }

  private ensureDir(): void {
    mkdirSync(this._dir, { recursive: true });
    try {
      chmodSync(this._dir, 0o700);
    } catch {
      // best-effort: directory exists regardless
    }
  }

  private readActiveUrl(): string | null {
    try {
      const content = readFileSync(currentUrlPath(this._dir), 'utf-8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  private writeActiveUrl(url: string): void {
    writeFileAtomic(currentUrlPath(this._dir), url, 0o600);
  }

  async store(credentials: ActualCredentials): Promise<void> {
    this.ensureDir();
    const key = this.getOrDeriveKey();

    const payloadData = JSON.stringify({
      secretKey: credentials.secretKey,
      budgetPassword: credentials.budgetPassword ?? undefined,
    });

    // Encrypt payload with serverUrl as AAD — binds plaintext URL to ciphertext
    const payload = encrypt(payloadData, key, credentials.serverUrl);

    const stored = {
      serverUrl: credentials.serverUrl,
      payload,
      salt: this._keySalt?.toString('hex') ?? '',
    };

    const filePath = credentialFilePath(credentials.serverUrl, this._dir);
    writeFileAtomic(filePath, JSON.stringify(stored), 0o600);
    this.writeActiveUrl(credentials.serverUrl);
    this._activeUrl = credentials.serverUrl;
  }

  async load(): Promise<ActualCredentials | null> {
    // 1. Try the active URL (from current.txt or in-memory cache)
    const activeUrl = this._activeUrl ?? this.readActiveUrl();
    if (activeUrl) {
      const creds = this.loadFromFile(credentialFilePath(activeUrl, this._dir));
      if (creds) return creds;
    }

    // 2. Fallback: scan all .enc files (legacy support when current.txt is absent)
    try {
      const files = readdirSync(this._dir).filter(
        f => f.endsWith('.enc') && f !== MASTER_KEY_FILENAME,
      );
      for (const file of files) {
        const creds = this.loadFromFile(resolve(this._dir, file));
        if (creds) return creds;
      }
    } catch {
      // directory may not exist
    }

    return null;
  }

  /**
   * Attempt to load and decrypt credentials from a single file.
   * Returns null if the file is corrupt, tampered, or otherwise unreadable.
   * Supports both V2 (AAD-bound payload) and V1 (legacy per-field) formats.
   */
  private loadFromFile(filePath: string): ActualCredentials | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const stored: Record<string, unknown> = JSON.parse(raw);

      // V2 format — unified payload with AAD binding
      if (isV2Record(stored)) {
        const salt = Buffer.from(stored.salt as string, 'hex');
        const key = this.getOrDeriveKey(salt);
        const payload = stored.payload as EncryptedPayload;
        // If serverUrl was tampered, GCM auth check will throw here
        const decrypted = decrypt(payload, key, stored.serverUrl as string);
        const data = JSON.parse(decrypted) as {
          secretKey: string;
          budgetPassword?: string;
        };
        return {
          serverUrl: stored.serverUrl as string,
          secretKey: data.secretKey,
          budgetPassword: data.budgetPassword ?? undefined,
        };
      }

      // V1 legacy format — backward compatible, no AAD
      if (isV1Record(stored)) {
        const salt = Buffer.from(stored.salt as string, 'hex');
        const key = this.getOrDeriveKey(salt);
        const sk = stored.secretKey as EncryptedPayload;
        return {
          serverUrl: stored.serverUrl as string,
          secretKey: decrypt(sk, key),
          budgetPassword: stored.budgetPassword
            ? decrypt(stored.budgetPassword as EncryptedPayload, key)
            : undefined,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  has(): boolean {
    try {
      const files = readdirSync(this._dir).filter(
        f => f.endsWith('.enc') && f !== MASTER_KEY_FILENAME,
      );
      return files.length > 0;
    } catch {
      return false;
    }
  }

  list(): string[] {
    const urls: string[] = [];
    try {
      const files = readdirSync(this._dir).filter(
        f => f.endsWith('.enc') && f !== MASTER_KEY_FILENAME,
      );
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(this._dir, file), 'utf-8');
          const stored: Record<string, unknown> = JSON.parse(raw);
          if (stored.serverUrl && typeof stored.serverUrl === 'string') {
            urls.push(stored.serverUrl);
          }
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // directory may not exist
    }
    return [...new Set(urls)];
  }

  async rotate(credentials: ActualCredentials): Promise<void> {
    // Write-new-then-delete-old: store the new credential first so the old
    // remains accessible if the new write fails.
    this._derivedKey = null;
    this._keySalt = null;
    await this.store(credentials);

    // Remove old credential files (keep only master.key and the new file)
    const newFilePath = credentialFilePath(credentials.serverUrl, this._dir);
    try {
      const files = readdirSync(this._dir).filter(
        f => f.endsWith('.enc') && f !== MASTER_KEY_FILENAME,
      );
      for (const file of files) {
        const filePath = resolve(this._dir, file);
        if (filePath !== newFilePath) {
          rmSync(filePath, { force: true });
        }
      }
    } catch {
      // Non-fatal: old files remain but new credential is active
    }
  }

  async delete(): Promise<void> {
    const files = readdirSync(this._dir).filter(
      f => f.endsWith('.enc') && f !== MASTER_KEY_FILENAME,
    );
    for (const file of files) {
      rmSync(resolve(this._dir, file), { force: true });
    }
    // Remove the active-URL tracker
    try {
      unlinkSync(currentUrlPath(this._dir));
    } catch {
      // file may not exist
    }
    this._activeUrl = null;
    this._derivedKey = null;
    this._keySalt = null;
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
    return {
      serverUrl,
      secretKey,
      budgetPassword: process.env.ACTUAL_BUDGET_PASSWORD || undefined,
    };
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
