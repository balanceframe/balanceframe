import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  EvidenceObservationSchema,
  ReceiptEvidenceSchema,
} from '@balanceframe/protocol-generated/validators';
import type { EvidenceParseResult } from './transaction-evidence.js';

const nullableReference = EvidenceObservationSchema.shape.counterparty;
const receiptFacts = ReceiptEvidenceSchema.omit({
  id: true,
  observationId: true,
  version: true,
  supersedesId: true,
  fulfillmentGroupId: true,
});
/** User-entered photo claims carry neither source authentication nor ledger authority. */
export const manualReceiptPhotoExtractionSchema = z
  .object({
    kind: z.enum(['purchase', 'refund']).default('purchase'),
    date: EvidenceObservationSchema.shape.date,
    total: EvidenceObservationSchema.shape.amount.refine((value) => value.minorUnits !== '0'),
    merchant: nullableReference,
    fundingInstrumentId: nullableReference,
    receipt: receiptFacts.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.receipt ||
      (value.receipt.total.currency === value.total.currency &&
        value.receipt.total.minorUnits === value.total.minorUnits &&
        value.receipt.tenders.every((tender) => tender.observationId === null)),
    'Receipt total must match its entered summary and tenders cannot claim other source observations',
  );

/** Keep exact source claims; Rust alone checks conservation and financial consequences. */
export function parseManualReceiptPhoto(
  value: unknown,
  sourceIdentity: string,
): EvidenceParseResult {
  const parsed = manualReceiptPhotoExtractionSchema.safeParse(value);
  const parserVersion = 'retail-photo-user-v1';
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(sourceIdentity))
    return {
      parserVersion,
      parseStatus: 'malformed',
      quality: ['invalid_photo_review'],
      extraction: {},
    };
  const input = parsed.data;
  const scopedId = (kind: 'line' | 'tender', identity: string): string =>
    `photo:${createHash('sha256')
      .update(JSON.stringify([sourceIdentity, kind, identity]))
      .digest('hex')}:${kind}`;
  const observation = {
    id: `photo:${sourceIdentity}:payment`,
    kind: 'receipt',
    sourceId: 'receipt-photo',
    externalEventId: null,
    date: input.date,
    amount: input.total,
    direction: input.kind === 'refund' ? 'inflow' : 'outflow',
    status: 'completed',
    eventType: input.kind,
    counterparty: input.merchant,
    fundingInstrumentId: input.fundingInstrumentId,
    walletId: null,
    ledgerTransactionId: null,
    ledgerEffect: null,
    reviewedLedgerEffect: false,
    reliability: 0,
  };
  const receipts = input.receipt
    ? [
        {
          ...input.receipt,
          id: `photo:${sourceIdentity}:receipt`,
          observationId: observation.id,
          version: 1,
          supersedesId: null,
          fulfillmentGroupId: null,
          lines: input.receipt.lines.map((line) => ({
            ...line,
            id: scopedId('line', line.id),
            evidenceStrength: 0,
          })),
          tenders: input.receipt.tenders.map((tender) => ({
            ...tender,
            id: scopedId('tender', tender.id),
          })),
        },
      ]
    : [];
  return {
    parserVersion,
    parseStatus: 'parsed',
    quality: [
      'user_photo_entry',
      'normalized_not_verified',
      ...(input.receipt ? [] : ['receipt_lines_unavailable']),
    ],
    extraction: {
      templateVersion: 'retail-v1',
      observations: [observation],
      relationships: [],
      wallets: [],
      receipts,
    },
  };
}
