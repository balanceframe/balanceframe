// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEvidenceEncryptionKey } from '../../server/utils/evidence-key';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balanceframe-evidence-key-'));
  directories.push(directory);
  return join(directory, 'keys', 'evidence.key');
}
describe('raw evidence encryption key persistence', () => {
  it('creates a private random key once and returns the same key after restart', () => {
    const location = path();
    const key = loadEvidenceEncryptionKey(location);
    expect(key.length).toBe(32);
    expect(statSync(location).mode & 0o777).toBe(0o600);
    expect(loadEvidenceEncryptionKey(location)).toEqual(key);
    expect(loadEvidenceEncryptionKey(path())).not.toEqual(key);
  });
  it('fails closed on corrupt or broadly readable keys without replacing them', () => {
    const location = path();
    loadEvidenceEncryptionKey(location);
    writeFileSync(location, 'corrupt');
    expect(() => loadEvidenceEncryptionKey(location)).toThrow(
      'Evidence encryption key unavailable',
    );
    expect(readFileSync(location, 'utf8')).toBe('corrupt');
    writeFileSync(location, Buffer.alloc(32));
    chmodSync(location, 0o644);
    expect(() => loadEvidenceEncryptionKey(location)).toThrow(
      'Evidence encryption key unavailable',
    );
  });
  it('refuses symbolic links instead of following a replacement key', () => {
    const location = path();
    loadEvidenceEncryptionKey(location);
    const link = join(directories[0]!, 'link');
    symlinkSync(location, link);
    expect(() => loadEvidenceEncryptionKey(link)).toThrow('Evidence encryption key unavailable');
  });
});
