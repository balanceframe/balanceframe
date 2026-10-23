/** Human-reviewed local statements are claims, never provider-authenticated source authority. */
import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => new TextEncoder().encode(v).length <= 256 && !/\p{Cc}/u.test(v));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const money = z
  .object({
    minorUnits: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(19)
      .refine(
        (v) => /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 19 && BigInt(v) <= 9223372036854775807n,
      ),
    currency,
  })
  .strict();
export const WalletStatementSourceSchema = z
  .object({ documentId: id, contentHash: hash, parserVersion: id })
  .strict();
export const WalletStatementActivitySchema = WalletStatementSourceSchema.extend({
  observationId: id,
  normalizedFieldsHash: hash,
}).strict();
export const WalletStatementProofSchema = z
  .object({
    proofId: id,
    authorityKind: z.literal('human_attested_statement'),
    statement: WalletStatementSourceSchema,
    walletId: id,
    currency,
    calendarBasis: z.literal('statement_printed_date'),
    startDate: date,
    endDate: date,
    openingBalance: money.nullable(),
    closingBalance: money.nullable(),
    activityManifest: z.array(WalletStatementActivitySchema).max(10000),
    actorId: id,
    membershipId: id,
    policyVersion: id,
    reviewedAt: z
      .string()
      .datetime()
      .regex(/T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?Z$/),
  })
  .strict()
  .refine(
    (p) =>
      p.startDate <= p.endDate &&
      (p.openingBalance !== null || p.closingBalance !== null) &&
      [p.openingBalance, p.closingBalance].every((m) => m === null || m.currency === p.currency),
  );
export const WalletStatementBalanceAnchorSchema = z
  .object({
    walletId: id,
    amount: money,
    asOfDate: date,
    boundary: z.enum(['before_day_activity', 'after_day_activity']),
    proofIds: z.array(id).min(1),
    proofSetHash: hash,
    activityManifestHash: hash,
    evidenceIds: z.array(id).min(1),
  })
  .strict();
export const WalletStatementCoverageIntervalSchema = z
  .object({
    startDate: date,
    endDate: date,
    proofIds: z.array(id),
    evidenceIds: z.array(id),
    openingBalance: money.nullable(),
    closingBalance: money.nullable(),
    state: z.enum(['covered', 'invalid']),
    reasonCodes: z.array(id),
  })
  .strict();
export const WalletStatementCoverageSchema = z
  .object({
    intervals: z.array(WalletStatementCoverageIntervalSchema),
    uncoveredObservationIds: z.array(id),
    blockedObservationIds: z.array(id),
  })
  .strict();
export type WalletStatementSource = z.infer<typeof WalletStatementSourceSchema>;
export type WalletStatementActivity = z.infer<typeof WalletStatementActivitySchema>;
export type WalletStatementProof = z.infer<typeof WalletStatementProofSchema>;
export type WalletStatementBalanceAnchor = z.infer<typeof WalletStatementBalanceAnchorSchema>;
export type WalletStatementCoverageInterval = z.infer<typeof WalletStatementCoverageIntervalSchema>;
export type WalletStatementCoverage = z.infer<typeof WalletStatementCoverageSchema>;

const signedMoney = z
  .object({
    minorUnits: z
      .string()
      .regex(/^(?:0|-[1-9]\d*|[1-9]\d*)$/)
      .max(20)
      .refine(
        (v) =>
          /^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(v) &&
          v.length <= 20 &&
          BigInt(v) >= -9223372036854775808n &&
          BigInt(v) <= 9223372036854775807n,
      ),
    currency,
  })
  .strict();
export const WalletStatementPreviewSchema = z
  .object({
    contractVersion: z.literal('1'),
    walletId: id,
    currency,
    startDate: date,
    endDate: date,
    activityManifest: z.array(WalletStatementActivitySchema).max(10000),
    activityManifestHash: hash,
    netChange: signedMoney,
    inflows: money,
    outflows: money,
    excludedObservationIds: z.array(id),
    reasonCodes: z.array(id),
  })
  .strict();
export type WalletStatementPreview = z.infer<typeof WalletStatementPreviewSchema>;
