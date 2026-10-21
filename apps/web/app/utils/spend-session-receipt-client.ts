import { z } from 'zod';
import {
  CompareSpendSessionReceiptResultSchema,
  SessionReceiptSnapshotSchema,
  moneySchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  CompareSpendSessionReceiptResult,
  SessionReceiptSnapshot,
  Money,
} from '@balanceframe/protocol-generated';
const snapshot = z.custom<SessionReceiptSnapshot>(
  (value) => SessionReceiptSnapshotSchema.safeParse(value).success,
);
const comparison = z.custom<CompareSpendSessionReceiptResult>(
  (value) => CompareSpendSessionReceiptResultSchema.safeParse(value).success,
);
const amount = z.custom<Money>((value) => moneySchema.safeParse(value).success);
/** Comparison choices disclose only currently authorized archived intent and receipt details. */
export const spendSessionReceiptContextSchema = z.object({
  snapshot,
  receipts: z.array(
    z.object({
      documentId: z.string().min(1),
      receiptId: z.string().min(1),
      counterparty: z.string().nullable(),
      date: z.string(),
      amount,
      lines: z.array(z.object({ id: z.string().min(1), description: z.string() })),
    }),
  ),
  associations: z.array(z.object({ result: comparison })),
  completionReferences: z.array(
    z.object({
      proposalId: z.string().min(1),
      manualTransactionId: z.string().nullable(),
      importedTransactionId: z.string().nullable(),
    }),
  ),
});
export const spendSessionReceiptSavedSchema = z.object({ result: comparison });
