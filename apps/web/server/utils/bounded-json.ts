import type { H3Event } from 'h3';

/** Safe request failure without including any private evidence in its message. */
export class BoundedJsonBodyError extends Error {
  constructor(readonly statusCode: 400 | 413) {
    super(statusCode === 413 ? 'Evidence request exceeds its size limit' : 'Invalid evidence JSON');
  }
}

/** Bound every evidence operation, including manual claims outside the original source bytes. */
export function readEvidenceBody(event: H3Event): Promise<unknown> {
  return readBoundedJsonBody(event, 16 * 1024 * 1024);
}

/** Bound complete UTF-8 JSON bytes before parsing image and extracted claims together. */
export async function readBoundedJsonBody(event: H3Event, limit: number): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid request size limit');
  const declared = event.node.req.headers['content-length'];
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) throw new BoundedJsonBodyError(400);
    if (Number(declared) > limit) throw new BoundedJsonBodyError(413);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of event.node.req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > limit) throw new BoundedJsonBodyError(413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)),
    ) as unknown;
  } catch {
    throw new BoundedJsonBodyError(400);
  }
}
