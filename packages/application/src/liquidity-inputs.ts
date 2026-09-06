import { z } from 'zod';
import {
  accountLiquidityPolicySchema,
  transferTimingRouteSchema,
  moneySchema,
  factEvidenceSchema,
} from '@balanceframe/protocol-generated/validators';
import { userAttestedLiquidityObservationSchema } from '@balanceframe/actual-adapter';

const canonicalUtcTimestampSchema = factEvidenceSchema.shape.observedAt.unwrap();
const id = z.string().trim().min(1).max(256);
const positiveMoney = moneySchema
  .strict()
  .refine((value) => /^[1-9][0-9]*$/.test(value.minorUnits), 'Amount must be positive');
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(256);
export const liquidityPurchaseQuerySchema = z
  .object({
    categoryId: id,
    amount: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('USD'),
    accountId: id.optional(),
    purchaseAt: canonicalUtcTimestampSchema.optional(),
    requiredBy: canonicalUtcTimestampSchema.optional(),
  })
  .strict();
export const liquidityPurchaseInputSchema = z
  .object({
    kind: z.literal('purchase'),
    categoryId: id,
    amount: positiveMoney,
    accountId: id.optional(),
    purchaseAt: canonicalUtcTimestampSchema.optional(),
    requiredBy: canonicalUtcTimestampSchema.optional(),
  })
  .strict();
export const transferPreviewInputSchema = z.discriminatedUnion('kind', [
  liquidityPurchaseInputSchema.extend({ purchaseAt: canonicalUtcTimestampSchema }),
  z
    .object({
      kind: z.literal('session'),
      sessionId: id,
      expectedSessionVersion: version,
      purchaseItemId: id,
    })
    .strict(),
]);
export const transferProposalInputSchema = z
  .object({ previewId: id, payloadHash: hash, idempotencyKey: key })
  .strict();
export const transferActionInputSchema = z
  .object({ payloadHash: hash, expectedVersion: version, idempotencyKey: key })
  .strict();
const sessionItemSchema = z
  .object({
    id,
    categoryId: id,
    amount: positiveMoney,
    purchaseAt: canonicalUtcTimestampSchema,
    requiredBy: canonicalUtcTimestampSchema,
    accountId: id.nullable(),
  })
  .strict();
export const spendSessionInputSchema = z
  .object({
    accountId: id.nullable(),
    expiresAt: canonicalUtcTimestampSchema,
    items: z.array(sessionItemSchema).max(100),
  })
  .strict();
export const spendSessionUpdateInputSchema = spendSessionInputSchema
  .extend({ expectedVersion: version })
  .strict();
export const spendSessionCancelInputSchema = z
  .object({ expectedVersion: version, idempotencyKey: key })
  .strict();
export const liquidityReallocationInputSchema = z
  .object({
    moves: z
      .array(
        z
          .object({ id, sourceCategoryId: id, destinationCategoryId: id, amount: positiveMoney })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const liquidityObservationInputSchema = z
  .object({
    expectedVersion: version,
    expiresAt: canonicalUtcTimestampSchema,
    observations: z
      .array(
        userAttestedLiquidityObservationSchema
          .innerType()
          .omit({ observedAt: true, expiresAt: true })
          .strict(),
      )
      .max(1000),
  })
  .strict();
const approvalPolicySchema = z
  .object({
    minimumApprovers: z.number().int().min(1).max(100),
    thresholds: z
      .array(
        z
          .object({
            minimumMinorUnits: z
              .string()
              .regex(/^[1-9][0-9]*$/)
              .refine((value) => BigInt(value) <= 9223372036854775807n),
            currency: z.string().regex(/^[A-Z]{3}$/),
            minimumApprovers: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export const liquidityPolicyInputSchema = z
  .object({
    expectedVersion: id.nullable(),
    expiresAt: canonicalUtcTimestampSchema,
    accounts: z
      .array(
        accountLiquidityPolicySchema
          .omit({ resourceScope: true })
          .extend({
            accountId: id,
            protectedBuffer: moneySchema
              .strict()
              .refine((value) => !value.minorUnits.startsWith('-'), 'Buffer must be nonnegative'),
          })
          .strict(),
      )
      .max(1000),
    transferRoutes: z
      .array(
        transferTimingRouteSchema
          .omit({ evidence: true })
          .extend({ id, sourceAccountId: id, destinationAccountId: id })
          .strict(),
      )
      .max(1000),
    approvalPolicy: approvalPolicySchema,
  })
  .strict();
export const liquidityCapabilities = [
  'conclusion',
  'existence',
  'name',
  'balance',
  'history',
  'liquidity',
  'source',
  'category',
  'proposal',
  'approval',
  'initiation-report',
  'confirmation',
  'audit',
  'policy',
  'session',
  'full-read',
] as const;
export const liquidityGrantInputSchema = z
  .object({
    grants: z
      .array(
        z
          .object({
            actorId: id,
            resourceKind: z.enum(['budget', 'account', 'category', 'session']),
            resourceId: id,
            capability: z.enum(liquidityCapabilities),
            granted: z.boolean(),
          })
          .strict()
          .refine(
            (grant) => grant.capability !== 'full-read' || grant.resourceKind === 'budget',
            'Full-read discloses the whole budget and is budget-only',
          ),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export const liquidityPreferenceInputSchema = z
  .object({
    categoryId: id,
    accountId: id,
    expectedVersion: version,
    expiresAt: canonicalUtcTimestampSchema,
  })
  .strict();
export type LiquidityPurchaseIntent = z.infer<typeof liquidityPurchaseInputSchema>;
export type TransferPreviewIntent = z.infer<typeof transferPreviewInputSchema>;
export type SpendSessionIntent = z.infer<typeof spendSessionInputSchema>;
