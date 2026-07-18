import { z } from "zod";
import type {
  Transaction as TransactionType,
  Category as CategoryType,
  CategoryGroup as CategoryGroupType,
  ProtocolSnapshot as ProtocolSnapshotType,
  AnalysisRequest as AnalysisRequestType,
} from "./index.js";

// ── Primitives ──────────────────────────────────────────────────────────────

export const moneySchema = z.object({
  minorUnits: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO 4217 code"),
});

// ── Enums and leaf schemas (no forward references) ──────────────────────────

export const accountTypeSchema = z.enum([
  "checking",
  "savings",
  "creditCard",
  "investment",
  "mortgage",
  "loan",
  "other",
]);

export const clearStateSchema = z.enum(["cleared", "uncleared", "reconciled"]);

export const flagColorSchema = z.enum([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
]);

export const transactionTypeSchema = z.enum([
  "regular",
  "transfer",
  "parent",
  "sub",
]);

export const autoBudgetTypeSchema = z.enum([
  "none",
  "monthly",
  "weekly",
  "daily",
  "yearly",
  "byDate",
  "byDayOfMonth",
  "spending",
]);

export const ruleTriggerSchema = z.enum([
  "payee_is",
  "category_is",
  "notes_contain",
  "imported_payee_is",
  "amount_between",
]);

export const ruleActionKindSchema = z.enum([
  "set_category",
  "set_flag",
  "set_memo",
  "link_schedule",
]);

export const scheduleFrequencySchema = z.enum([
  "weekly",
  "biweekly",
  "monthly",
  "bimonthly",
  "quarterly",
  "yearly",
  "daily",
]);

export const findingSeveritySchema = z.enum(["info", "warning", "blocker"]);
export const postconditionTypeSchema = z.literal("category_exists");

// ── Non-recursive object schemas (no forward references) ────────────────────

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  on_budget: z.boolean(),
  closed: z.boolean(),
  note: z.string(),
  order: z.number().int(),
});

export const payeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  transfer_account_id: z.string().nullable(),
  mtid: z.string().nullable(),
  deleted: z.boolean(),
});

export const ruleActionSchema = z.object({
  action: ruleActionKindSchema,
  action_data: z.string(),
});

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: ruleTriggerSchema,
  trigger_value: z.string().nullable(),
  actions: ruleActionSchema.array(),
  inactive: z.boolean(),
  mtid: z.string().nullable(),
  order: z.number().int(),
});

export const scheduleSchema = z.object({
  id: z.string(),
  frequency: scheduleFrequencySchema,
  frequency_n: z.number().int(),
  next_expected: z.string().nullable(),
  bill: z.boolean(),
  deleted: z.boolean(),
});

export const budgetCategorySchema = z.object({
  category_id: z.string(),
  amount: z.number().int(),
  carryover: z.number().int(),
  carryover_from_previous: z.number().int(),
  carries_over: z.boolean(),
});

export const budgetMonthSchema = z.object({
  id: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Must be in YYYY-MM format"),
  categories: z.record(budgetCategorySchema),
});

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const analysisOptionsSchema = z.object({
  include_pending: z.boolean(),
  include_cleared: z.boolean(),
  max_results: z.number().int().min(1).nullable(),
});

export const findingSchema = z.object({
  finding_type: z.string(),
  severity: findingSeveritySchema,
  entity_id: z.string(),
  message: z.string(),
  drill_down: z.string().array(),
});

export const suggestionSchema = z.object({
  transaction_id: z.string(),
  proposed_category_id: z.string(),
  category_name: z.string(),
  confidence: z.number().min(0).max(1),
  reason_codes: z.string().array(),
  evidence: z.string().array(),
});

export const analysisResultSchema = z.object({
  result_code: z.number().int(),
  reason_codes: z.string().array(),
  findings: findingSchema.array(),
  suggestions: suggestionSchema.array(),
});

export const postconditionSchema = z.object({
  type: postconditionTypeSchema,
  category_id: z.string(),
});

export const mutationPlanSchema = z.object({
  plan_id: z.string(),
  transaction_id: z.string(),
  current_category_id: z.string(),
  proposed_category_id: z.string(),
  hash: z.string(),
  postconditions: postconditionSchema.array(),
});

export const ruleSimulationResultSchema = z.object({
  rule_id: z.string(),
  name: z.string(),
  transactions_matched: z.number().int().min(0),
  transactions_affected: z.string().array(),
});

export const validationResultSchema = z.object({
  valid: z.boolean(),
  reason_codes: z.string().array(),
});

export const verificationResultSchema = z.object({
  verified: z.boolean(),
  reason_codes: z.string().array(),
});

// ── Recursive object schemas (factory pattern) ──────────────────────────────

function makeTransactionSchema(): z.ZodType<TransactionType> {
  const schema: z.ZodType<TransactionType> = z.object({
    id: z.string(),
    account_id: z.string(),
    payee_id: z.string().nullable(),
    category_id: z.string().nullable(),
    payee_name: z.string().nullable(),
    name: z.string(),
    memo: z.string().nullable(),
    cleared: clearStateSchema,
    approved: z.boolean(),
    flag_color: flagColorSchema.nullable(),
    amount: z.number().int(),
    date: z.string(),
    imported_payee: z.string().nullable(),
    imported_id: z.string().nullable(),
    import_date: z.string().nullable(),
    deleted: z.boolean(),
    type: transactionTypeSchema,
    transfer_id: z.string().nullable(),
    sub_txns: z.array(z.lazy(() => schema)),
  });
  return schema;
}

function makeCategorySchema(): z.ZodType<CategoryType> {
  return z.object({
    id: z.string(),
    name: z.string(),
    group_id: z.string().nullable(),
    deleted: z.boolean(),
    calculated_auto_budget_amount: z.number().int().nullable(),
    auto_budget_type: autoBudgetTypeSchema,
    auto_budget_frequency: z.string().nullable(),
  });
}

function makeCategoryGroupSchema(): z.ZodType<CategoryGroupType> {
  const schema: z.ZodType<CategoryGroupType> = z.object({
    id: z.string(),
    name: z.string(),
    deleted: z.boolean(),
    hidden: z.boolean(),
    is_in_report: z.boolean(),
    categories: z.array(z.lazy(() => makeCategorySchema())),
  });
  return schema;
}

function makeProtocolSnapshotSchema(): z.ZodType<ProtocolSnapshotType> {
  const schema: z.ZodType<ProtocolSnapshotType> = z.object({
    schema_version: z.literal("1"),
    actual_version: z.string(),
    snapshot_date: z.string(),
    accounts: z.array(z.lazy(() => accountSchema)),
    transactions: z.array(z.lazy(() => makeTransactionSchema())),
    categories: z.array(z.lazy(() => makeCategoryGroupSchema())),
    payee_groups: z.array(z.lazy(() => makeCategoryGroupSchema())),
    payees: z.array(z.lazy(() => payeeSchema)),
    rules: z.array(z.lazy(() => ruleSchema)),
    schedules: z.array(z.lazy(() => scheduleSchema)),
    budgets: z.array(z.lazy(() => budgetMonthSchema)),
    tags: z.array(z.lazy(() => tagSchema)),
  });
  return schema;
}

function makeAnalysisRequestSchema(): z.ZodType<AnalysisRequestType> {
  return z.object({
    snapshot: z.lazy(() => makeProtocolSnapshotSchema()),
    options: z.lazy(() => analysisOptionsSchema),
  });
}

// ── Exported schema instances ───────────────────────────────────────────────

export const transactionSchema = makeTransactionSchema();
export const categorySchema = makeCategorySchema();
export const categoryGroupSchema = makeCategoryGroupSchema();
export const protocolSnapshotSchema = makeProtocolSnapshotSchema();
export const analysisRequestSchema = makeAnalysisRequestSchema();

// ── Derived Types ───────────────────────────────────────────────────────────

export type Transaction = z.infer<typeof transactionSchema>;
export type Category = z.infer<typeof categorySchema>;
export type CategoryGroup = z.infer<typeof categoryGroupSchema>;
export type ProtocolSnapshot = z.infer<typeof protocolSnapshotSchema>;
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
