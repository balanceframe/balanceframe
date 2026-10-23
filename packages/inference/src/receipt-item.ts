import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/\p{C}/u.test(v));
const label = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => !/\p{C}/u.test(v))
  .transform((v) => v.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .refine(
    (v) =>
      v.length > 0 &&
      Buffer.byteLength(v) <= 480 &&
      /^[\p{L}\p{M} &'’().-]+$/u.test(v) &&
      !/\b(?:ignore|instructions?|system|assistant|prompt|account|acct|iban|swift|routing|reference|payment|transaction|member|sku|upc|https?|www|email|password|secret|token)\b/iu.test(
        v,
      ) &&
      !/\b[\p{L}]+\.[\p{L}]{2,}\b/u.test(v),
  );
const alias = z.string().regex(/^c[a-f0-9]{16}$/);
/** Strict data-only provider input; identifiers and financial context stay outside this type. */
export const receiptInferencePayloadSchema = z
  .object({
    itemLabel: label,
    categories: z.array(z.object({ alias, label }).strict()).min(1).max(100),
  })
  .strict()
  .refine((v) => new Set(v.categories.map((c) => c.alias)).size === v.categories.length);
export type ReceiptInferencePayload = z.infer<typeof receiptInferencePayloadSchema>;
/** Identity and configuration bound to every preview. */
export const receiptInferenceProviderInfoSchema = z
  .object({
    id,
    version: id,
    model: id,
    locality: z.enum(['local', 'external']),
    configRevision: id,
  })
  .strict();
export type ReceiptInferenceProviderInfo = z.infer<typeof receiptInferenceProviderInfoSchema>;
/** Only an alias or abstention may cross back from a model. */
export const receiptInferenceResponseSchema = z
  .object({
    categoryAlias: alias.nullable(),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
export type ReceiptInferenceResponse = z.infer<typeof receiptInferenceResponseSchema>;
/** Adapters must await dispatchGuard after preparation, immediately before provider I/O. */
export interface ReceiptItemInferenceProvider {
  readonly info: ReceiptInferenceProviderInfo;
  infer(
    payload: ReceiptInferencePayload,
    context: { signal: AbortSignal; dispatchGuard: () => Promise<void> },
  ): Promise<unknown>;
}
/** Validate labels equally for local and external providers and replace category IDs with nonce-bound aliases. */
export function createReceiptInferencePayload(value: unknown): {
  payload: ReceiptInferencePayload;
  aliasMapping: Record<string, string>;
  nonce: string;
} {
  const input = z
    .object({
      itemLabel: label,
      categories: z
        .array(z.object({ categoryId: id, label }).strict())
        .min(1)
        .max(100),
      nonce: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
      sensitiveValues: z.array(z.string().max(512)).max(10000).optional(),
    })
    .strict()
    .parse(value);
  if (new Set(input.categories.map((c) => c.categoryId)).size !== input.categories.length)
    throw Error('Duplicate category');
  const labels = [input.itemLabel, ...input.categories.map((c) => c.label)].map((v) =>
    v.toLocaleLowerCase(),
  );
  if (
    input.sensitiveValues?.some(
      (v) =>
        v.trim().length > 0 &&
        labels.some((l) => l.includes(v.normalize('NFKC').trim().toLocaleLowerCase())),
    )
  )
    throw Error('Sensitive label');
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const aliasMapping: Record<string, string> = {};
  const categories = input.categories.map((c, i) => {
    const alias = 'c' + createHash('sha256').update(`${nonce}:${i}`).digest('hex').slice(0, 16);
    aliasMapping[alias] = c.categoryId;
    return { alias, label: c.label };
  });
  return {
    payload: receiptInferencePayloadSchema.parse({ itemLabel: input.itemLabel, categories }),
    aliasMapping,
    nonce,
  };
}
/** Hash the exact validated minimized payload. */
export function receiptInferencePayloadHash(payload: ReceiptInferencePayload): string {
  return createHash('sha256')
    .update(JSON.stringify(receiptInferencePayloadSchema.parse(payload)))
    .digest('hex');
}
export type ReceiptItemInferenceOutcome =
  | { status: 'suggestion'; result: ReceiptInferenceResponse }
  | {
      status: 'manual';
      code:
        | 'unavailable'
        | 'invalid_request'
        | 'invalid_response'
        | 'dispatch_guard_missing'
        | 'failed'
        | 'timeout';
    };
/** Run bounded inference and require one successful dispatch guard before accepting a strict response. */
export async function runReceiptItemInference(
  provider: ReceiptItemInferenceProvider | undefined,
  payload: ReceiptInferencePayload,
  guard: () => void | Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<ReceiptItemInferenceOutcome> {
  if (!provider) return { status: 'manual', code: 'unavailable' };
  const parsed = receiptInferencePayloadSchema.safeParse(payload);
  const info = receiptInferenceProviderInfoSchema.safeParse(provider.info);
  if (
    !parsed.success ||
    !info.success ||
    !Number.isInteger(options.timeoutMs ?? 5000) ||
    (options.timeoutMs ?? 5000) < 1 ||
    (options.timeoutMs ?? 5000) > 30000
  )
    return { status: 'manual', code: 'invalid_request' };
  const abort = new AbortController();
  let calls = 0,
    guarded = false,
    closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.infer(structuredClone(parsed.data), {
        signal: abort.signal,
        dispatchGuard: async () => {
          if (closed || abort.signal.aborted || ++calls !== 1)
            throw Error('Invalid dispatch guard');
          await guard();
          if (closed || abort.signal.aborted) throw Error('Dispatch expired');
          guarded = true;
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          closed = true;
          abort.abort();
          reject(Error('receipt-timeout'));
        }, options.timeoutMs ?? 5000);
      }),
    ]);
    if (!guarded || calls !== 1) return { status: 'manual', code: 'dispatch_guard_missing' };
    const response = receiptInferenceResponseSchema.safeParse(result);
    if (
      !response.success ||
      (response.data.categoryAlias !== null &&
        !parsed.data.categories.some((c) => c.alias === response.data.categoryAlias))
    )
      return { status: 'manual', code: 'invalid_response' };
    return { status: 'suggestion', result: response.data };
  } catch (error) {
    return {
      status: 'manual',
      code: error instanceof Error && error.message === 'receipt-timeout' ? 'timeout' : 'failed',
    };
  } finally {
    closed = true;
    abort.abort();
    if (timer) clearTimeout(timer);
  }
}
