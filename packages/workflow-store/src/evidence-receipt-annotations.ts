import { z } from 'zod';
const id = z.string().trim().min(1).max(256);
const source = z.object({
  documentId: id,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: id,
});
/** Explicit receipt relationships and member claims carry immutable human and source provenance. */
export const evidenceReceiptAnnotationSchema = source
  .extend({
    receiptId: id,
    actorId: id,
    membershipId: id,
    policyVersion: id,
    reviewedAt: z.string().datetime(),
    change: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('member'),
          lineId: id,
          member: z.object({ actorId: id, membershipId: id }).strict().nullable(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('return'),
          lineId: id,
          original: source.extend({ receiptId: id, lineId: id }).strict().nullable(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('fulfillment'),
          order: source.extend({ observationId: id }).strict().nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
export type EvidenceReceiptAnnotation = z.infer<typeof evidenceReceiptAnnotationSchema>;
/** Identify the independently revocable reviewed field, not the transient source collection. */
export function receiptAnnotationKey(entry: EvidenceReceiptAnnotation): string {
  return JSON.stringify([
    entry.documentId,
    entry.receiptId,
    entry.change.kind,
    'lineId' in entry.change ? entry.change.lineId : null,
  ]);
}
