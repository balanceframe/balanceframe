import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ENGINE_VERSION = '5.5.3';
export const MODEL_VERSION = '4.1.0';
export const MODEL_SHA256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2';
const COMMAND = '/opt/ocr/bin/tesseract';
const TESSDATA = '/opt/ocr/share/tessdata';
const failure = (code) => Object.assign(new Error(code), { code });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Wait for process close after killing it so cleanup cannot race an image reader.
function runBounded(command, args, { signal, timeoutMs = 10000, outputLimit = 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(failure('extraction_aborted'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '',
        OMP_THREAD_LIMIT: '1',
        LANG: 'C.UTF-8',
        HOME: '/tmp',
      },
    });
    const chunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let errorCode;
    const stop = (code) => {
      errorCode ??= code;
      child.kill('SIGKILL');
    };
    const abort = () => stop('extraction_aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('extraction_timeout'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop('extraction_failed');
      else chunks.push(chunk);
    });
    // Drain diagnostics without storing or logging source-derived stderr.
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) stop('extraction_failed');
    });
    child.on('error', () => {
      errorCode ??= 'extraction_failed';
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (errorCode || code !== 0) reject(failure(errorCode ?? 'extraction_failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    if (signal?.aborted) abort();
  });
}

/** Refuse a different installed engine/library/model before accepting images. */
export async function verifyRuntime({
  command = COMMAND,
  tessdata = TESSDATA,
  expectedModelHash = MODEL_SHA256,
} = {}) {
  try {
    const version = await runBounded(command, ['--version'], {
      timeoutMs: 5000,
      outputLimit: 8192,
    });
    const model = await readFile(join(tessdata, 'eng.traineddata'));
    const modelVersion = await readFile(join(tessdata, 'MODEL_VERSION'), 'utf8');
    if (
      !/^tesseract 5\.5\.3\r?\n/.test(version) ||
      !/\bleptonica-1\.87\.0\b/.test(version) ||
      modelVersion.trim() !== MODEL_VERSION ||
      hash(model) !== expectedModelHash
    )
      throw failure('engine_unavailable');
  } catch {
    throw failure('engine_unavailable');
  }
}

/** Extract local English text from a private, temporary image; always delete it. */
export function createExtractor({
  command = COMMAND,
  tessdata = TESSDATA,
  tempRoot = tmpdir(),
  timeoutMs = 10000,
  outputLimit = 1024 * 1024,
} = {}) {
  return async (image, { signal } = {}) => {
    let directory;
    try {
      if (signal?.aborted) throw failure('extraction_aborted');
      directory = await mkdtemp(join(tempRoot, 'receipt-'));
      await chmod(directory, 0o700);
      const file = join(directory, 'image');
      await writeFile(file, image, { mode: 0o600, flag: 'wx' });
      const text = await runBounded(
        command,
        [file, 'stdout', '-l', 'eng', '--tessdata-dir', tessdata, '--psm', '6'],
        { signal, timeoutMs, outputLimit },
      );
      return {
        engine: 'tesseract',
        engineVersion: ENGINE_VERSION,
        modelVersion: MODEL_VERSION,
        text,
        contentHash: hash(image),
      };
    } catch (error) {
      throw failure(error.code?.startsWith('extraction_') ? error.code : 'extraction_failed');
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
