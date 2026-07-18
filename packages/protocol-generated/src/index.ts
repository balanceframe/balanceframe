// Auto-generated TypeScript types matching protocol-v1.json schema
// Manual generation to ensure exact alignment with JSON Schema definitions

// ── Primitives ──────────────────────────────────────────────────────────────

export interface Money {
  minorUnits: string;
  currency: string; // ISO 4217, pattern: ^[A-Z]{3}$
}

// ── Core Entities ───────────────────────────────────────────────────────────

export type AccountType =
  | "checking"
  | "savings"
  | "creditCard"
  | "investment"
  | "mortgage"
  | "loan"
  | "other";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  on_budget: boolean;
  closed: boolean;
  note: string;
  order: number;
}

export type ClearState = "cleared" | "uncleared" | "reconciled";
export type FlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export type TransactionType = "regular" | "transfer" | "parent" | "sub";

export interface Transaction {
  id: string;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  payee_name: string | null;
  name: string;
  memo: string | null;
  cleared: ClearState;
  approved: boolean;
  flag_color: FlagColor | null;
  amount: number; // minor units (cents)
  date: string; // ISO date
  imported_payee: string | null;
  imported_id: string | null;
  import_date: string | null;
  deleted: boolean;
  type: TransactionType;
  transfer_id: string | null;
  sub_txns: Transaction[];
}

export type AutoBudgetType =
  | "none"
  | "monthly"
  | "weekly"
  | "daily"
  | "yearly"
  | "byDate"
  | "byDayOfMonth"
  | "spending";

export interface Category {
  id: string;
  name: string;
  group_id: string | null;
  deleted: boolean;
  calculated_auto_budget_amount: number | null;
  auto_budget_type: AutoBudgetType;
  auto_budget_frequency: string | null;
}

export interface CategoryGroup {
  id: string;
  name: string;
  deleted: boolean;
  hidden: boolean;
  is_in_report: boolean;
  categories: Category[];
}

export interface Payee {
  id: string;
  name: string;
  transfer_account_id: string | null;
  mtid: string | null;
  deleted: boolean;
}

export type RuleTrigger =
  | "payee_is"
  | "category_is"
  | "notes_contain"
  | "imported_payee_is"
  | "amount_between";

export type RuleActionKind = "set_category" | "set_flag" | "set_memo" | "link_schedule";

export interface RuleAction {
  action: RuleActionKind;
  action_data: string;
}

export interface Rule {
  id: string;
  name: string;
  trigger: RuleTrigger;
  trigger_value: string | null;
  actions: RuleAction[];
  inactive: boolean;
  mtid: string | null;
  order: number;
}

export type ScheduleFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "bimonthly"
  | "quarterly"
  | "yearly"
  | "daily";

export interface Schedule {
  id: string;
  frequency: ScheduleFrequency;
  frequency_n: number;
  next_expected: string | null; // ISO date
  bill: boolean;
  deleted: boolean;
}

export interface BudgetCategory {
  category_id: string;
  amount: number;
  carryover: number;
  carryover_from_previous: number;
  carries_over: boolean;
}

export interface BudgetMonth {
  id: string;
  month: string; // YYYY-MM
  categories: Record<string, BudgetCategory>;
}

export interface Tag {
  id: string;
  name: string;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface ProtocolSnapshot {
  schema_version: string;
  actual_version: string;
  snapshot_date: string; // ISO date-time
  accounts: Account[];
  transactions: Transaction[];
  categories: CategoryGroup[];
  payee_groups: CategoryGroup[];
  payees: Payee[];
  rules: Rule[];
  schedules: Schedule[];
  budgets: BudgetMonth[];
  tags: Tag[];
}

// ── Analysis Types ──────────────────────────────────────────────────────────

export interface AnalysisOptions {
  include_pending: boolean;
  include_cleared: boolean;
  max_results: number | null;
}

export interface AnalysisRequest {
  snapshot: ProtocolSnapshot;
  options: AnalysisOptions;
}

export type FindingSeverity = "info" | "warning" | "blocker";

export interface Finding {
  finding_type: string;
  severity: FindingSeverity;
  entity_id: string;
  message: string;
  drill_down: string[];
}

export interface Suggestion {
  transaction_id: string;
  proposed_category_id: string;
  category_name: string;
  confidence: number; // 0..1
  reason_codes: string[];
  evidence: string[];
}

export interface AnalysisResult {
  result_code: number;
  reason_codes: string[];
  findings: Finding[];
  suggestions: Suggestion[];
}

// ── Mutation Types ──────────────────────────────────────────────────────────

export type PostconditionType = "category_exists";

export interface Postcondition {
  type: PostconditionType;
  category_id: string;
}

export interface MutationPlan {
  plan_id: string;
  transaction_id: string;
  current_category_id: string;
  proposed_category_id: string;
  hash: string;
  postconditions: Postcondition[];
}

export interface RuleSimulationResult {
  rule_id: string;
  name: string;
  transactions_matched: number;
  transactions_affected: string[];
}

// ── Validation Types ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason_codes: string[];
}

export interface VerificationResult {
  verified: boolean;
  reason_codes: string[];
}
