import { z } from 'zod';
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provider = z
  .object({
    id,
    version: id,
    model: id,
    locality: z.enum(['local', 'external']),
    configRevision: id,
  })
  .strict();
/** Public receipt suggestions contain no model-authored rationale or authority. */
export const receiptInferenceViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('manual'), reasonCode: id }).strict(),
  z
    .object({ state: z.literal('deterministic'), categoryId: id, receiptId: id, lineId: id })
    .strict(),
  z
    .object({
      state: z.literal('preview'),
      previewId: id,
      payloadHash: hash,
      expiresAt: z.string().datetime({ offset: true }),
      provider,
      payload: z
        .object({
          itemLabel: z.string().max(120),
          categories: z
            .array(
              z
                .object({ alias: z.string().regex(/^c[a-f0-9]{16}$/), label: z.string().max(120) })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      state: z.literal('suggested'),
      previewId: id,
      payloadHash: hash,
      receiptId: id,
      lineId: id,
      categoryId: id,
      provenance: provider,
      reasonCode: z.literal('receipt_model_suggestion'),
    })
    .strict(),
]);
export type ReceiptInferenceView = z.infer<typeof receiptInferenceViewSchema>;
export const receiptInferenceWithdrawnSchema = z
  .object({ state: z.enum(['rejected', 'revoked']) })
  .strict();
