import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Loads the separate raw-evidence key; corrupt keys must never be replaced. */
export function loadEvidenceEncryptionKey(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, randomBytes(32));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0)
      throw new Error('Invalid key');
    const key = readFileSync(descriptor);
    if (key.length !== 32) throw new Error('Invalid key');
    return key;
  } catch {
    throw new Error('Evidence encryption key unavailable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
