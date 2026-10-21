import { z } from 'zod';
import {
  WalletStatementProofSchema,
  WalletStatementPreviewSchema,
  TransactionEvidenceResultSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  WalletStatementProof,
  WalletStatementPreview,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const proof = z.custom<WalletStatementProof>(
  (value) => WalletStatementProofSchema.safeParse(value).success,
);
const resolution = z.custom<TransactionEvidenceResult>(
  (value) => TransactionEvidenceResultSchema.safeParse(value).success,
);
/** Validate authorized statement metadata separately from private original bytes. */
export const walletStatementContextSchema = z.object({
  foldHash: hash,
  proofs: z.array(proof),
  documents: z.array(
    z.object({
      id,
      connectorId: id,
      sourceId: id,
      contentHash: hash,
      parserVersion: id,
      mediaType: z.string(),
      retentionUntil: z.string(),
    }),
  ),
  wallets: z.array(z.object({ walletId: id, currency: z.string().regex(/^[A-Z]{3}$/) })),
  resolution,
});
/** Native preview amounts and manifests remain exact values; the browser performs no balance inference. */
export const walletStatementPreviewSchema = z.object({
  previewHash: hash,
  proofFoldHash: hash,
  proof,
  native: z.custom<WalletStatementPreview>(
    (value) => WalletStatementPreviewSchema.safeParse(value).success,
  ),
  resolution,
});
export const walletStatementStateSchema = z.object({ foldHash: hash, proofs: z.array(proof) });
export type WalletStatementContext = z.infer<typeof walletStatementContextSchema>;
export type WalletStatementPreviewView = z.infer<typeof walletStatementPreviewSchema>;
