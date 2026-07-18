import { z } from "zod";

export const moneySchema = z.object({
  minorUnits: z.string().regex(/^-?\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const accountTypeSchema = z.enum([
  "checking",
  "savings",
  "creditCard",
  "cash",
  "investment",
  "mortgage",
  "loan",
  "other",
]);

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountType: accountTypeSchema,
  offBudget: z.boolean(),
  isClosed: z.boolean(),
  clearedBalance: moneySchema,
  importedBalance: moneySchema,
  mtid: z.string().nullable(),
});

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  groupName: z.string().nullable(),
  isIncome: z.boolean(),
  mtid: z.string().nullable(),
  deleted: z.boolean(),
});

export const payeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  transferAccountId: z.string().nullable(),
  mtid: z.string().nullable(),
});

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().nonnegative(),
  trigger: z.unknown(),
  actions: z.unknown(),
  inactive: z.boolean(),
});

export const scheduleSchema = z.object({
  id: z.string(),
  frequency: z.string(),
  amount: moneySchema,
  payeeName: z.string().nullable(),
  accountId: z.string(),
  nextExpected: z.string(),
});

export const budgetCategorySchema = z.object({
  categoryId: z.string(),
  amount: moneySchema,
  carryover: moneySchema,
  carryoverFromPrevious: moneySchema,
  carriesOver: z.boolean(),
});

export const budgetMonthSchema = z.object({
  id: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  categories: z.record(budgetCategorySchema),
});

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const canonicalTransactionSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    id: z.string(),
    accountId: z.string(),
    date: z.string(),
    payeeId: z.string().nullable(),
    payeeName: z.string().nullable(),
    categoryId: z.string().nullable(),
    categoryName: z.string().nullable(),
    amount: moneySchema,
    cleared: z.boolean(),
    reconciled: z.boolean(),
    importedId: z.string().nullable(),
    importedPayee: z.string().nullable(),
    notes: z.string().nullable(),
    tags: z.string().array(),
    transferAccountId: z.string().nullable(),
    subtransactions: z.array(canonicalTransactionSchema),
  }),
);

export const canonicalProtocolSnapshotSchema = z.object({
  schemaVersion: z.literal("1"),
  actualVersion: z.string(),
  snapshotDate: z.string(),
  accounts: accountSchema.array(),
  transactions: z.array(canonicalTransactionSchema),
  categories: categorySchema.array(),
  payees: payeeSchema.array(),
  rules: ruleSchema.array(),
  schedules: scheduleSchema.array(),
  budgets: budgetMonthSchema.array(),
  tags: tagSchema.array(),
});

export type Money = z.infer<typeof moneySchema>;
export type Account = z.infer<typeof accountSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Payee = z.infer<typeof payeeSchema>;
export type Transaction = z.infer<typeof canonicalTransactionSchema>;
export type ProtocolSnapshot = z.infer<typeof canonicalProtocolSnapshotSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type BudgetCategory = z.infer<typeof budgetCategorySchema>;
export type BudgetMonth = z.infer<typeof budgetMonthSchema>;
export type Tag = z.infer<typeof tagSchema>;
