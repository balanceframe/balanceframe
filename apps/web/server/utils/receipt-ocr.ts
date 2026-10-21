import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { H3Event } from 'h3';
import { readBoundedJsonBody } from './bounded-json';
const sourceLimit = 5 * 1024 * 1024;
const responseLimit = 1024 * 1024;
export const receiptOcrInputSchema = z
  .object({
    mediaType: z.enum(['image/jpeg', 'image/png']),
    contentBase64: z
      .string()
      .min(1)
      .max(7 * 1024 * 1024),
  })
  .strict();
/** Bound the entire authenticated JSON request before allocating or decoding its image. */
export async function readReceiptPhotoBody(
  event: H3Event,
): Promise<z.infer<typeof receiptOcrInputSchema>> {
  return receiptOcrInputSchema.parse(await readBoundedJsonBody(event, 7 * 1024 * 1024));
}
const extraction = z
  .object({
    engine: z.literal('tesseract'),
    engineVersion: z.literal('5.5.3'),
    modelVersion: z.literal('4.1.0'),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z
      .string()
      .min(1)
      .max(responseLimit)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export type ReceiptOcrResult =
  | ({ state: 'extracted' } & z.infer<typeof extraction>)
  | {
      state: 'unavailable';
      reason: 'not_configured' | 'invalid_configuration' | 'unreachable' | 'invalid_result';
    };
function endpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['receipt-ocr', '127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return new URL('/v1/extract', url);
  } catch {
    return null;
  }
}
async function readResult(response: Response, aborted: Promise<never>): Promise<unknown> {
  if (!response.body) throw new Error('Missing extraction body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > responseLimit) throw new Error('Extraction response limit');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
/** Optional local processing: no startup probe, provider key, egress, persistence, or financial authority. */
export async function extractReceiptPhoto(
  value: unknown,
  options: { endpoint?: string; request?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReceiptOcrResult> {
  const input = receiptOcrInputSchema.parse(value);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64))
    throw new Error('Invalid photo encoding');
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (
    !bytes.length ||
    bytes.length > sourceLimit ||
    bytes.toString('base64') !== input.contentBase64 ||
    (input.mediaType === 'image/jpeg'
      ? !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  )
    throw new Error('Invalid photo source');
  const configured = options.endpoint?.trim();
  if (!configured) return { state: 'unavailable', reason: 'not_configured' };
  const target = endpoint(configured);
  if (!target) return { state: 'unavailable', reason: 'invalid_configuration' };
  const controller = new AbortController();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new Error('Extraction timed out'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(10000, Math.max(1, options.timeoutMs ?? 10000)),
  );
  try {
    const response = await Promise.race([
      (options.request ?? fetch)(target.toString(), {
        method: 'POST',
        headers: { 'content-type': input.mediaType },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (!response.ok) return { state: 'unavailable', reason: 'unreachable' };
    const parsed = extraction.safeParse(await readResult(response, aborted));
    if (
      !parsed.success ||
      parsed.data.contentHash !== createHash('sha256').update(bytes).digest('hex')
    )
      return { state: 'unavailable', reason: 'invalid_result' };
    return { state: 'extracted', ...parsed.data };
  } catch {
    return {
      state: 'unavailable',
      reason: controller.signal.aborted ? 'unreachable' : 'invalid_result',
    };
  } finally {
    clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
  }
}
