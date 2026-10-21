import { z } from 'zod';
import { ReceiptEvidenceSchema } from '@balanceframe/protocol-generated/validators';
import type { ReceiptEvidence } from '@balanceframe/protocol-generated';
const id = z.string().min(1).max(256);
const source = z.object({
  documentId: id,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: id,
});
const annotation = source.extend({
  receiptId: id,
  actorId: id,
  membershipId: id,
  policyVersion: id,
  reviewedAt: z.string().datetime(),
  change: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('member'),
      lineId: id,
      member: z.object({ actorId: id, membershipId: id }).nullable(),
    }),
    z.object({
      kind: z.literal('return'),
      lineId: id,
      original: source.extend({ receiptId: id, lineId: id }).nullable(),
    }),
    z.object({
      kind: z.literal('fulfillment'),
      order: source.extend({ observationId: id }).nullable(),
    }),
  ]),
});
/** Validate the currently authorized receipt relationships and human review choices. */
export const receiptReviewContextSchema = z.object({
  resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
  receipts: z.array(
    z.object({
      documentId: id,
      receipt: z.custom<ReceiptEvidence>((v) => ReceiptEvidenceSchema.safeParse(v).success),
      kind: id,
      valid: z.boolean(),
    }),
  ),
  orders: z.array(
    z.object({
      documentId: id,
      observationId: id,
      date: z.string(),
      amount: z.object({ minorUnits: z.string().regex(/^-?\d+$/), currency: z.string() }),
      counterparty: z.string().nullable(),
    }),
  ),
  members: z.array(z.object({ actorId: id, membershipId: id, label: z.string() })),
  annotations: z.array(annotation),
});
export type ReceiptReviewContext = z.infer<typeof receiptReviewContextSchema>;
