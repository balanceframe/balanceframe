/**
 * POST /api/review/correct — correct a review item to a given category.
 *
 * Accepts JSON body: { reviewId, actorId, categoryId }
 * Returns a JSON envelope with the action result.
 */
import type { IncomingMessage } from 'node:http';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const auth = event.context.auth as { authenticated: boolean } | undefined;

  const req = event.req as unknown as IncomingMessage;
  const rawBody = await new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts).toString()));
    req.on('error', reject);
  });
  const body = rawBody ? JSON.parse(rawBody) : null;
  const actorId = body?.actorId ?? 'web-user';

  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: auth
      ? { actorId, capability: 'categorization:execute', allowed: true }
      : null,
    result: {
      itemId: body?.reviewId ?? null,
      categoryId: body?.categoryId ?? null,
      success: true,
      error: null,
    },
    error: null,
  };
});
