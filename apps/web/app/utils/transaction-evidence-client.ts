import { z } from 'zod';
import {
  ReceiptEvidenceSchema,
  WalletStatementCoverageSchema,
} from '@balanceframe/protocol-generated/validators';
import type { ReceiptEvidence, WalletStatementCoverage } from '@balanceframe/protocol-generated';

/** Metadata deliberately excludes extracted private content and encrypted source bytes. */
export const evidenceDocumentViewSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  sourceId: z.string(),
  sourceTimestamp: z.string(),
  receivedAt: z.string(),
  mediaType: z.string(),
  parserVersion: z.string(),
  contentHash: z.string(),
  parseStatus: z.enum(['parsed', 'malformed', 'unsupported_template', 'source_conflict']),
  retentionUntil: z.string(),
  quality: z.array(z.string()),
  extraction: z
    .object({
      observations: z.array(z.unknown()).optional(),
      receipts: z
        .array(z.custom<ReceiptEvidence>((value) => ReceiptEvidenceSchema.safeParse(value).success))
        .optional(),
    })
    .optional(),
});
export const evidenceTargetsSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), name: z.string() })),
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const evidenceListViewSchema = z.object({ documents: z.array(evidenceDocumentViewSchema) });
export const evidenceHealthViewSchema = z.object({
  connectors: z.array(
    z.object({
      connectorId: z.string(),
      latestReceivedAt: z.string(),
      latestParsedAt: z.string().nullable(),
      documentCount: z.number().int().nonnegative(),
      unsupportedCount: z.number().int().nonnegative(),
      malformedCount: z.number().int().nonnegative(),
      duplicateCount: z.number().int().nonnegative().nullable().optional(),
      statementCoverage: z
        .object({
          authorityKind: z.literal('human_attested_statement'),
          state: z.enum(['evaluated', 'unavailable']),
          wallets: z.array(
            z.object({
              walletId: z.string(),
              balanceState: z.string(),
              reasonCodes: z.array(z.string()),
              coverage: z.custom<WalletStatementCoverage>(
                (value) => WalletStatementCoverageSchema.safeParse(value).success,
              ),
            }),
          ),
          reasonCodes: z.array(z.string()),
        })
        .nullable()
        .optional(),
    }),
  ),
});
const envelopeSchema = z.object({
  status: z.enum(['ok', 'error']),
  result: z.unknown(),
  error: z.object({ message: z.string() }).nullable(),
});

/** Send same-origin evidence intent and validate the exact returned public shape. */
export async function evidenceRequest<T>(
  url: string,
  schema: { parse(value: unknown): T },
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const envelope = envelopeSchema.parse(await response.json());
  if (!response.ok || envelope.status !== 'ok')
    throw new Error(
      'Evidence unavailable. Refresh current sources and permissions before retrying.',
    );
  return schema.parse(envelope.result);
}
