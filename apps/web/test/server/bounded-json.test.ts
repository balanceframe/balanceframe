// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { H3Event } from 'h3';
import {
  BoundedJsonBodyError,
  readBoundedJsonBody,
  readEvidenceBody,
} from '../../server/utils/bounded-json';
const event = (chunks: Buffer[], headers: Record<string, string> = {}) =>
  ({ node: { req: Object.assign(Readable.from(chunks), { headers }) } }) as unknown as H3Event;
describe('complete evidence JSON body limit', () => {
  it('caps the complete evidence operation payload, including claims outside the source string', async () => {
    await expect(
      readEvidenceBody(event([], { 'content-length': String(16 * 1024 * 1024 + 1) })),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(
      await readEvidenceBody(
        event([Buffer.from('{"content":"tiny","userExtraction":{"lines":[]}}')]),
      ),
    ).toEqual({ content: 'tiny', userExtraction: { lines: [] } });
  });
  it('reads chunked UTF-8 JSON within its byte limit', async () => {
    const body = Buffer.from(JSON.stringify({ merchant: '店', amount: '1234' }));
    expect(
      await readBoundedJsonBody(event([body.subarray(0, 15), body.subarray(15)]), body.length),
    ).toEqual({ merchant: '店', amount: '1234' });
  });
  it('rejects declared and streamed oversize before JSON parsing or source extraction', async () => {
    await expect(
      readBoundedJsonBody(event([], { 'content-length': '101' }), 100),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      readBoundedJsonBody(event([Buffer.alloc(60), Buffer.alloc(41)]), 100),
    ).rejects.toMatchObject({ statusCode: 413 });
  });
  it('rejects malformed length, invalid UTF-8, truncated JSON and invalid limits with safe errors', async () => {
    for (const request of [
      event([], { 'content-length': 'untrusted' }),
      event([Buffer.from([0xff])]),
      event([Buffer.from('{')]),
    ]) {
      await expect(readBoundedJsonBody(request, 100)).rejects.toBeInstanceOf(BoundedJsonBodyError);
    }
    await expect(readBoundedJsonBody(event([]), 0)).rejects.toThrow();
  });
});
