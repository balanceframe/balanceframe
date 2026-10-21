import { z } from 'zod';
import type { Money } from '@balanceframe/protocol-generated';
import { ReceiptEvidenceSchema } from '@balanceframe/protocol-generated/validators';
const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  version = z.number().int().min(1).max(4294967295);
const source = z
  .object({ documentId: id, receiptId: id, contentHash: hash, parserVersion: id })
  .strict();
const identityBasis = z.enum(['matching_external_id', 'human_attested_same_receipt']);
const link = z
  .object({
    child: source,
    predecessor: source,
    predecessorVersion: version,
    version,
    predecessorLineageHash: hash,
    identityBasis,
    actorId: id,
    membershipId: id,
    policyVersion: id,
    reviewedAt: z.string().datetime(),
  })
  .strict();
const choice = source
  .extend({
    label: z.string(),
    date: z.string(),
    merchant: z.string().min(1),
    total: z.custom<Money>((v) => ReceiptEvidenceSchema.shape.total.safeParse(v).success),
    direction: z.enum(['inflow', 'outflow']),
    version,
    familyKey: hash,
  })
  .strict();
/** Validate only separately authorized source metadata and reviewed relationships, never raw photo content. */
export const receiptVersionContextSchema = z
  .object({
    resolutionHash: hash,
    foldHash: hash,
    children: z.array(choice).max(1000),
    predecessors: z.array(choice).max(1000),
    links: z.array(link).max(1000),
    blockedChildren: z
      .array(
        z
          .object({ child: source, reasonCode: z.literal('reviewed_receipt_history_unavailable') })
          .strict(),
      )
      .max(1000),
  })
  .strict();
/** A preview is an exact native-checked relationship plan, not authority to change the ledger. */
export const receiptVersionPreviewSchema = z
  .object({
    previewHash: hash,
    foldHash: hash,
    resolutionHash: hash,
    child: source,
    predecessor: source,
    predecessorVersion: version,
    version,
    identityBasis,
    sourceClosure: z.array(source).max(1000),
    nativeResolutionHash: hash,
  })
  .strict();
export const receiptVersionSavedSchema = z
  .object({ saved: z.literal(true), child: source, version })
  .strict();
export const receiptVersionRevokedSchema = z
  .object({ revoked: z.literal(true), childDocumentId: id, childReceiptId: id })
  .strict();
export type ReceiptVersionContext = z.infer<typeof receiptVersionContextSchema>;
export type ReceiptVersionPreview = z.infer<typeof receiptVersionPreviewSchema>;
