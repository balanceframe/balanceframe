/**
 * Command routing for the application layer.
 *
 * Parses raw argument arrays into structured commands, validates them
 * against the current access mode, and dispatches to the appropriate handler.
 *
 * No model invocation — all analysis uses injected adapter/protocol.
 */

import type { ResponseEnvelope, DataFreshness } from './envelope.js';
import { ApplicationError, ObserveWriteError, ReasonCodes } from './errors.js';
import type {
  DecisionContext,
  DecisionIssue,
  Money,
  ProspectiveClaim,
  ProspectiveDecisionEnvelope,
  PurchaseEvaluation,
  RedactionState,
} from '@balanceframe/protocol-generated';
import type { FindingStatus, WorkflowStore } from '@balanceframe/workflow-store';

// ---------------------------------------------------------------------------
// Analysis protocol — Rust-backed analysis interface
// ---------------------------------------------------------------------------

/**
 * Protocol interface for Rust-backed analysis operations.
 *
 * Implementations bridge to the Rust protocol (via node-binding or the
 * injected adapter). This ensures the application layer never duplicates
 * Rust-owned calculations (categorization, money arithmetic, normalization).
 *
 * Each method receives the opaque `ledger` handle — the implementation casts
 * it to the concrete ledger/adapter type it expects.
 */
// ---------------------------------------------------------------------------
// Review action options
// ---------------------------------------------------------------------------

/**
 * Options for a review action submitted via CLI or web.
 * Provides optional context (message, reason) for the transition.
 */
export interface ReviewActionOptions {
  /** User-provided message or note for the action. */
  message?: string;
  /** Reason code or text (e.g. 'wrong_category', 'duplicate'). */
  reason?: string;
  /** Actor ID for provenance tracking. */
  actorId?: string;
  /** Request ID for correlation. */
  requestId?: string;
  /** Correlation ID for audit trail. */
  correlationId?: string;
  /** Category ID for proposal create or review correct. */
  categoryId?: string;
  /** Transaction ID for proposal create. */
  transactionId?: string;
  /** Operation type for proposal create (e.g. 'set_category'). */
  operation?: string;
}

export interface AnalysisProtocol {
  /** Analyze pending uncategorized transactions from the ledger snapshot. */
  pendingReview(ledger: unknown, freshness: DataFreshness | null): Promise<PendingReviewResult>;
  /** Show a specific review by ID. */
  reviewShow(ledger: unknown, reviewId: string): Promise<ReviewDetailResult>;
  /** Generate a budget summary from ledger data. */
  budgetSummary(ledger: unknown): Promise<BudgetSummaryResult>;

  // -----------------------------------------------------------------------
  // Review action methods — lifecycle transitions for review items
  // -----------------------------------------------------------------------

  /** Approve a pending review item. */
  reviewApprove?(
    ledger: unknown,
    reviewId: string,
    options?: ReviewActionOptions,
  ): Promise<ReviewActionResult>;

  /** Correct a review item with a specific category. */
  reviewCorrect?(
    ledger: unknown,
    reviewId: string,
    categoryId: string,
    options?: ReviewActionOptions,
  ): Promise<ReviewActionResult>;

  /** Reject a pending review item's suggestion. */
  reviewReject?(
    ledger: unknown,
    reviewId: string,
    options?: ReviewActionOptions,
  ): Promise<ReviewActionResult>;

  /** Skip a review item for later. */
  reviewSkip?(
    ledger: unknown,
    reviewId: string,
    options?: ReviewActionOptions,
  ): Promise<ReviewActionResult>;

  /** Undo the last transition on a review item (where reversible). */
  reviewUndo?(
    ledger: unknown,
    reviewId: string,
    options?: ReviewActionOptions,
  ): Promise<ReviewActionResult>;

  /** Approve multiple review items in bulk. */
  reviewApproveBulk?(
    ledger: unknown,
    reviewIds: string[],
    options?: ReviewActionOptions,
  ): Promise<ReviewBulkActionResult>;

  /** Group homogeneous review evidence. */
  reviewGroup?(
    ledger: unknown,
    reviewIds: string[],
    options?: ReviewActionOptions,
  ): Promise<ReviewGroupResult>;

  // -----------------------------------------------------------------------
  // Proposal and audit methods
  // -----------------------------------------------------------------------

  /** Create a new proposal. */
  proposalCreate?(ledger: unknown, options?: ReviewActionOptions): Promise<ProposalCreateResult>;

  /** Show a proposal by ID. */
  proposalShow?(ledger: unknown, proposalId: string): Promise<ProposalDetailResult>;

  /** Approve a proposal. */
  proposalApprove?(
    ledger: unknown,
    proposalId: string,
    options?: ReviewActionOptions,
  ): Promise<ProposalActionResult>;

  /** Execute an approved proposal. */
  proposalExecute?(
    ledger: unknown,
    proposalId: string,
    options?: ReviewActionOptions,
  ): Promise<ProposalActionResult>;

  /** List pending proposals. */
  proposalList?(ledger: unknown): Promise<ProposalListResult>;

  /** Query the audit trail. */
  auditQuery?(ledger: unknown, query?: AuditQueryOptions): Promise<AuditQueryResult>;

  /** List automation rules. */
  ruleList?(ledger: unknown): Promise<RuleListResult>;

  /** Show a single rule by ID. */
  ruleShow?(ledger: unknown, ruleId: string): Promise<RuleShowResult>;

  /** Update a rule via proposal. */
  ruleUpdate?(ledger: unknown, options?: ReviewActionOptions): Promise<RuleCreateResult>;
  /** Create a new rule proposal. */
  ruleCreate?(ledger: unknown, options?: ReviewActionOptions): Promise<RuleCreateResult>;

  // -----------------------------------------------------------------------
  // Budget Intelligence — read-only deterministic analysis
  // -----------------------------------------------------------------------

  /** Evaluate a proposed purchase against budget limits. */
  purchaseEvaluation?(
    ledger: unknown,
    params: PurchaseEvaluationParams,
  ): Promise<PurchaseEvaluationResult>;

  /** Project future cash flow based on schedules and budgets. */
  cashFlowProjection?(
    ledger: unknown,
    params: CashFlowProjectionParams,
  ): Promise<CashFlowProjectionResult>;

  /** Evaluate target/sinking-fund health. */
  targetHealth?(ledger: unknown): Promise<TargetHealthResult>;

  /** Evaluate sinking fund health specifically. */
  sinkingFundHealth?(ledger: unknown): Promise<SinkingFundHealthResult>;

  /** Generate a report with persisted scope/filters. */
  generateReport?(ledger: unknown, params: ReportGenerationParams): Promise<ReportGenerationResult>;

  /** List saved views. */
  listSavedViews?(ledger: unknown): Promise<SavedViewsListResult>;

  /** Create a saved view. */
  createSavedView?(ledger: unknown, params: CreateSavedViewParams): Promise<CreateSavedViewResult>;

  /** Get prioritized attention/home dashboard. */
  attentionHome?(ledger: unknown, params: AttentionHomeParams): Promise<AttentionHomeResult>;

  /** Evaluate overall financial state (comprehensive). */
  financialState?(ledger: unknown): Promise<FinancialStateResult>;

  // -----------------------------------------------------------------------
  // Phase 8 — Additional Budget Intelligence methods
  // -----------------------------------------------------------------------

  /** Compute composite data-quality report from snapshot data. */
  dataQuality?(ledger: unknown): Promise<DataQualityResult>;

  /** Compute liquidity coverage for upcoming obligations. */
  liquidityCoverage?(ledger: unknown, currentMonth: string): Promise<LiquidityCoverageResult>;

  /** Compute the bill/obligation calendar. */
  billCalendar?(ledger: unknown, referenceDate: string): Promise<BillCalendarResult>;

  /** Compute budget variance and trends. */
  budgetVariance?(ledger: unknown, referenceDate: string): Promise<BudgetVarianceResult>;

  /** Detect irregular obligations from schedules. */
  irregularObligations?(ledger: unknown): Promise<IrregularObligationsResult>;

  /** Compute income reliability assessment. */
  incomeReliability?(ledger: unknown): Promise<IncomeReliabilityResult>;

  /** Compute forecast calibration by comparing projections to actuals. */
  forecastCalibration?(ledger: unknown): Promise<ForecastCalibrationResult>;

  /** Compare two immutable scenarios. */
  scenarioComparison?(
    ledger: unknown,
    params: ScenarioComparisonParams,
  ): Promise<ScenarioComparisonResult>;

  /** Compute multidimensional health assessment. */
  multidimensionalHealth?(
    ledger: unknown,
    currentMonth: string,
  ): Promise<MultidimensionalHealthResult>;
}

// ---------------------------------------------------------------------------
// Lifecycle callbacks — CLI-level operations
// ---------------------------------------------------------------------------

/**
 * Callbacks for lifecycle CLI commands (export, disconnect, remove-connection).
 *
 * Injected by the CLI main function and invoked when the corresponding
 * command is routed. The ledger handle is passed through for the
 * implementation to use.
 */
export interface LifecycleCallbacks {
  /** Export the connected budget to a file. */
  doExport(ledger: unknown): Promise<ExportResult>;
  /** Disconnect: remove application cache and credentials without altering the server. */
  doDisconnect(ledger: unknown): Promise<DisconnectResult>;
  /** Remove connection: like disconnect but also removes all cached data. */
  doRemoveConnection(ledger: unknown): Promise<RemovalResult>;
  /** Delete project data scoped to a specific domain. */
  doDeleteData(ledger: unknown, scope: string): Promise<DeletionResult>;
}

// ---------------------------------------------------------------------------
// Connection mode (mirrors actual-adapter types without importing)
// ---------------------------------------------------------------------------

export type ConnectionMode =
  'observe' | 'reviewAndApply' | 'managedAutomation' | 'disposableSandbox';

// ---------------------------------------------------------------------------
// Command route
// ---------------------------------------------------------------------------

export type CommandRoute = 'analysis' | 'lifecycle' | 'export';

// ---------------------------------------------------------------------------
// Command input
// ---------------------------------------------------------------------------

/**
 * Raw input parsed from CLI arguments.
 * The `ledger` field is an injected adapter/protocol analysis handle.
 */
export interface CommandInput {
  /** Raw argument tokens (e.g. ['transactions', 'pending-review', '--json']). */
  args: string[];
  /** Current connection mode. */
  mode: ConnectionMode;
  /** Stable actor identifier. */
  actorId: string;
  /** Request ID (deterministic or generated). */
  requestId: string;
  /** Injected ledger/adapter handle, or null if not connected. */
  ledger: unknown | null;
  /** Current data freshness metadata, or null if none. */
  freshness: DataFreshness | null;
  /** Rust-backed analysis protocol, or undefined if not available. */
  analysisProtocol?: AnalysisProtocol;
  /** Lifecycle callbacks for export/disconnect/remove-connection. */
  lifecycleCallbacks?: LifecycleCallbacks;
  /** Workflow store for persistence operations (web routes). */
  workflowStore?: WorkflowStore;
}

// ---------------------------------------------------------------------------
// Command result
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** Dot-separated command path (e.g. 'transactions.pending-review'). */
  command: string;
  /** High-level route category. */
  route: CommandRoute;
}

// ---------------------------------------------------------------------------
// CommandError
// ---------------------------------------------------------------------------

/**
 * Thrown when a command cannot be routed or executed.
 */
export class CommandError extends ApplicationError {
  constructor(opts: {
    code: string;
    message: string;
    reasonCodes?: string[];
    retryable?: boolean;
  }) {
    super(opts);
    this.name = 'CommandError';
  }
}

// ---------------------------------------------------------------------------
// Write operations known to be rejected in Observe mode
// ---------------------------------------------------------------------------

const WRITE_COMMAND_PREFIXES: Array<{ prefix: string[]; capability: string }> = [
  { prefix: ['categories', 'create'], capability: 'category.create' },
  { prefix: ['categories', 'update'], capability: 'category.update' },
  { prefix: ['categories', 'delete'], capability: 'category.delete' },
  { prefix: ['transactions', 'update'], capability: 'transaction.update' },
  { prefix: ['transactions', 'import'], capability: 'transaction.import' },
  { prefix: ['rules', 'create'], capability: 'rule.create' },
  { prefix: ['rules', 'update'], capability: 'rule.update' },
  { prefix: ['budget', 'set-amount'], capability: 'budget.set_amount' },
  { prefix: ['payees', 'rename'], capability: 'payee.rename' },

  // Review actions
  { prefix: ['reviews', 'approve'], capability: 'review.approve' },
  { prefix: ['reviews', 'correct'], capability: 'review.correct' },
  { prefix: ['reviews', 'reject'], capability: 'review.reject' },
  { prefix: ['reviews', 'skip'], capability: 'review.skip' },
  { prefix: ['reviews', 'undo'], capability: 'review.undo' },
  { prefix: ['reviews', 'approve-bulk'], capability: 'review.approve_bulk' },
  { prefix: ['reviews', 'group'], capability: 'review.group' },

  // Proposal actions
  { prefix: ['proposals', 'create'], capability: 'proposal.create' },
  { prefix: ['proposals', 'approve'], capability: 'proposal.approve' },
  { prefix: ['proposals', 'execute'], capability: 'proposal.execute' },
  { prefix: ['delete-data'], capability: 'data.delete' },
];

// ---------------------------------------------------------------------------
// Commands rejected outright (never valid)
// ---------------------------------------------------------------------------

const REJECTED_COMMANDS: Array<{ args: string[]; code: string; reason: string; rc: string }> = [
  {
    args: ['raw-query'],
    code: 'unknown_command',
    reason: 'raw-query is not supported',
    rc: ReasonCodes.UNSUPPORTED_RAW_QUERY,
  },
  {
    args: ['invoke-method'],
    code: 'unknown_command',
    reason: 'invoke-method is not supported',
    rc: ReasonCodes.UNSUPPORTED_RAW_QUERY,
  },
  {
    args: ['shell'],
    code: 'unknown_command',
    reason: 'shell is not supported',
    rc: ReasonCodes.UNSUPPORTED_RAW_QUERY,
  },
];

// ---------------------------------------------------------------------------
// Known command routes
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS: Array<{
  args: string[];
  command: string;
  route: CommandRoute;
}> = [
  // Analysis commands
  {
    args: ['transactions', 'pending-review'],
    command: 'transactions.pending-review',
    route: 'analysis',
  },
  { args: ['reviews', 'show'], command: 'reviews.show', route: 'analysis' },
  { args: ['budget', 'summary'], command: 'budget.summary', route: 'analysis' },

  // Review action commands
  { args: ['reviews', 'approve'], command: 'reviews.approve', route: 'analysis' },
  { args: ['reviews', 'correct'], command: 'reviews.correct', route: 'analysis' },
  { args: ['reviews', 'reject'], command: 'reviews.reject', route: 'analysis' },
  { args: ['reviews', 'skip'], command: 'reviews.skip', route: 'analysis' },
  { args: ['reviews', 'undo'], command: 'reviews.undo', route: 'analysis' },
  { args: ['reviews', 'group'], command: 'reviews.group', route: 'analysis' },
  { args: ['reviews', 'approve-bulk'], command: 'reviews.approve-bulk', route: 'analysis' },

  // Proposal commands
  { args: ['proposals', 'create'], command: 'proposals.create', route: 'analysis' },
  { args: ['proposals', 'show'], command: 'proposals.show', route: 'analysis' },
  { args: ['proposals', 'approve'], command: 'proposals.approve', route: 'analysis' },
  { args: ['proposals', 'execute'], command: 'proposals.execute', route: 'analysis' },
  { args: ['proposals', 'list'], command: 'proposals.list', route: 'analysis' },
  // Rule commands
  { args: ['rules', 'create'], command: 'rules.create', route: 'analysis' },

  { args: ['rules', 'list'], command: 'rules.list', route: 'analysis' },
  { args: ['rules', 'show'], command: 'rules.show', route: 'analysis' },
  { args: ['rules', 'update'], command: 'rules.update', route: 'analysis' },

  // Audit commands
  { args: ['audit', 'query'], command: 'audit.query', route: 'analysis' },

  // Budget Intelligence commands (read-only deterministic)
  { args: ['purchase', 'evaluate'], command: 'purchase.evaluate', route: 'analysis' },
  { args: ['cash-flow', 'project'], command: 'cash-flow.project', route: 'analysis' },
  { args: ['target', 'health'], command: 'target.health', route: 'analysis' },
  { args: ['sinking-fund', 'health'], command: 'sinking-fund.health', route: 'analysis' },
  { args: ['reports', 'generate'], command: 'reports.generate', route: 'analysis' },
  { args: ['views', 'list'], command: 'views.list', route: 'analysis' },
  { args: ['views', 'create'], command: 'views.create', route: 'analysis' },
  { args: ['home', 'attention'], command: 'home.attention', route: 'analysis' },

  // Lifecycle commands
  { args: ['disconnect'], command: 'disconnect', route: 'lifecycle' },
  { args: ['export'], command: 'export', route: 'export' },
  { args: ['remove-connection'], command: 'remove-connection', route: 'lifecycle' },
  { args: ['delete-data'], command: 'delete-data', route: 'lifecycle' },
];

function argsMatch(pattern: string[], args: string[]): boolean {
  if (pattern.length > args.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== args[i]) return false;
  }
  return true;
}

function stripFlags(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('--'));
}

// ---------------------------------------------------------------------------
// routeCommand
// ---------------------------------------------------------------------------

/**
 * Route a raw CLI argument array to a structured command.
 *
 * Throws `CommandError` for unknown or rejected commands.
 * Throws `ObserveWriteError` for write operations in Observe mode.
 * Returns a `CommandResult` for valid read/lifecycle commands.
 */
export function routeCommand(input: CommandInput): CommandResult {
  const { args, mode } = input;
  const stripped = stripFlags(args);

  // 1. Check for rejected commands (raw-query, invoke-method, shell)
  for (const rejected of REJECTED_COMMANDS) {
    if (argsMatch(rejected.args, stripped)) {
      throw new CommandError({
        code: rejected.code,
        message: rejected.reason,
        reasonCodes: [rejected.rc],
      });
    }
  }

  // 2. Check for write commands in Observe mode
  if (mode === 'observe') {
    for (const writeCmd of WRITE_COMMAND_PREFIXES) {
      if (argsMatch(writeCmd.prefix, stripped)) {
        throw new ObserveWriteError(writeCmd.capability);
      }
    }
  }

  // 3. Match known commands
  for (const known of KNOWN_COMMANDS) {
    if (argsMatch(known.args, stripped)) {
      return { command: known.command, route: known.route };
    }
  }

  throw new CommandError({
    code: 'unknown_command',
    message: `Unknown command: ${args.join(' ')}`,
    reasonCodes: ['unknown_command'],
  });
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface CategorizationCandidate {
  transactionId: string;
  amount: Money;
  payeeName: string | null;
  date: string;
  reasons: Array<{ kind: string; details: string }>;
}

export interface Blocker {
  code: string;
  message: string;
  entityId: string;
}

export interface PendingReviewResult {
  uncategorizedCount: number;
  totalUncategorizedAmount: Money;
  candidates: CategorizationCandidate[];
  oldestUncategorizedDate: string | null;
  healthState: string;
  blockers: Blocker[];
}

export interface PendingReviewOutput {
  envelope: ResponseEnvelope<PendingReviewResult>;
}

export interface ReviewItem {
  transactionId: string;
  amount: Money;
  payeeName: string | null;
  date: string;
  categoryName: string | null;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  confidence: number;
  reasonCodes: string[];
}

export interface ReviewDetailResult {
  reviewId: string;
  generatedAt: string;
  status: string;
  description: string;
  totalAmount: Money;
  itemCount: number;
  items: ReviewItem[];
}

export interface ReviewShowOutput {
  envelope: ResponseEnvelope<ReviewDetailResult>;
}

export interface BudgetCategorySummary {
  categoryId: string;
  categoryName: string;
  budgeted: Money;
  spent: Money;
  remaining: Money;
}

export interface BudgetSummaryResult {
  month: string;
  totalBudgeted: Money;
  totalSpent: Money;
  totalRemaining: Money;
  categories: BudgetCategorySummary[];
}

export interface BudgetSummaryOutput {
  envelope: ResponseEnvelope<BudgetSummaryResult>;
}

export interface ExportResult {
  exportedAt: string;
  budgetName: string;
  exportPath: string;
  byteSize: number;
  sha256Hash: string;
  accountCount: number;
  transactionCount: number;
}

export interface ExportOutput {
  envelope: ResponseEnvelope<ExportResult>;
}

export interface DisconnectResult {
  disconnected: boolean;
  cacheRemoved: boolean;
  credentialsRemoved: boolean;
  message: string;
}

export interface DisconnectOutput {
  envelope: ResponseEnvelope<DisconnectResult>;
}

export interface RemovalResult {
  removed: boolean;
  cacheRemoved: boolean;
  credentialsRemoved: boolean;
  broadAccessCaveat: string;
}

export interface RemovalOutput {
  envelope: ResponseEnvelope<RemovalResult>;
}

export interface DeletionResult {
  actorId: string;
  scope: string;
  recordsDeleted: number;
  recordsRetained: number;
  retentionReasons: string[];
  revokedCredentials: number;
  revokedDelegations: number;
  cancelledJobs: number;
  backupRetentionStatus: string;
  actualNonMutation: boolean;
  correlationId: string;
  failures: string[];
}

export interface DeletionOutput {
  envelope: ResponseEnvelope<DeletionResult>;
}
// ---------------------------------------------------------------------------
// Review action result types
// ---------------------------------------------------------------------------

/**
 * Result of a single review action transition.
 */
export interface ReviewActionResult {
  reviewId: string;
  /** The action that was performed (approved, corrected, rejected, skipped, undone). */
  action: string;
  /** Status before the transition. */
  fromStatus: string;
  /** Status after the transition. */
  toStatus: string;
  /** ISO timestamp of the action. */
  timestamp: string;
  /** Correlation ID for audit/provenance. */
  correlationId: string;
  /** Actor who performed the action. */
  actorId: string;
  /** Whether this action can be undone. */
  reversible: boolean;
  /** Next review item ID for immediate progression, or null if end of queue. */
  nextItemId: string | null;
}

export interface ReviewActionOutput {
  envelope: ResponseEnvelope<ReviewActionResult>;
}

/**
 * Result of bulk-approving multiple review items.
 */
export interface ReviewBulkActionResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    reviewId: string;
    action: string;
    status: 'ok' | 'error';
    fromStatus?: string;
    toStatus?: string;
    error?: string;
  }>;
}

export interface ReviewBulkActionOutput {
  envelope: ResponseEnvelope<ReviewBulkActionResult>;
}

/**
 * Result of grouping review items with homogeneous evidence.
 */
export interface ReviewGroupResult {
  items: ReviewDetailResult[];
  homogeneous: boolean;
  totalAmount: Money;
  itemCount: number;
}

export interface ReviewGroupOutput {
  envelope: ResponseEnvelope<ReviewGroupResult>;
}

// ---------------------------------------------------------------------------
// Proposal result types
// ---------------------------------------------------------------------------

export interface ProposalActionOptions {
  /** User-provided message or note for the proposal action. */
  message?: string;
  /** Reason code or text (e.g. 'wrong_category', 'duplicate'). */
  reason?: string;
  /** Actor ID for provenance tracking. */
  actorId?: string;
  /** Request ID for correlation. */
  requestId?: string;
  /** Correlation ID for audit trail. */
  correlationId?: string;
}

/** Result of creating a proposal. */
export interface ProposalCreateResult {
  proposalId: string;
  status: string;
  createdAt: string;
  summary: string;
}

export interface ProposalCreateOutput {
  envelope: ResponseEnvelope<ProposalCreateResult>;
}

/** Detailed result of a proposal lookup. */
export interface ProposalDetailResult {
  proposalId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  /** Payload hash for integrity verification. */
  payloadHash: string;
  approvals: Array<{
    memberId: string;
    approvedAt: string;
    status: string;
  }>;
  /** Whether the current member has approved. */
  approvedByCurrentMember: boolean;
}

export interface ProposalShowOutput {
  envelope: ResponseEnvelope<ProposalDetailResult>;
}

/** Result of a proposal action (approve, execute). */
export interface ProposalActionResult {
  proposalId: string;
  action: string;
  fromStatus: string;
  toStatus: string;
  timestamp: string;
  actorId: string;
}

export interface ProposalActionOutput {
  envelope: ResponseEnvelope<ProposalActionResult>;
}

/** Result of listing proposals. */
export interface ProposalListItem {
  proposalId: string;
  status: string;
  createdAt: string;
  summary: string;
  approvalCount: number;
  requiredApprovals: number;
}

export interface ProposalListResult {
  proposals: ProposalListItem[];
  total: number;
}

export interface ProposalListOutput {
  envelope: ResponseEnvelope<ProposalListResult>;
}

// ---------------------------------------------------------------------------
// Rule result types
// ---------------------------------------------------------------------------

/** Result of creating a rule via proposal. */
export interface RuleCreateResult {
  ruleId: string;
  name: string;
  status: string;
  createdAt: string;
  correlationId: string;
}

/** List item for rule listing. */
export interface RuleListItem {
  id: string;
  name: string;
  order: number;
  inactive: boolean;
}

/** Result of listing rules. */
export interface RuleListResult {
  items: RuleListItem[];
}

export interface RuleListOutput {
  envelope: ResponseEnvelope<RuleListResult>;
}

/** Result of showing a rule detail. */
export interface RuleShowResult {
  id: string;
  name: string;
  order: number;
  trigger: unknown;
  actions: unknown;
  inactive: boolean;
}

export interface RuleShowOutput {
  envelope: ResponseEnvelope<RuleShowResult>;
}

/** Result of updating a rule via proposal. */
export interface RuleUpdateResult {
  ruleId: string;
  name: string;
  status: string;
  createdAt: string;
  correlationId: string;
}

export interface RuleUpdateOutput {
  envelope: ResponseEnvelope<RuleUpdateResult>;
}

// ---------------------------------------------------------------------------
// Audit result types
// ---------------------------------------------------------------------------

export interface AuditQueryOptions {
  limit?: number;
  offset?: number;
  actorId?: string;
  entityType?: string;
  entityId?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
}

export interface AuditQueryOutput {
  envelope: ResponseEnvelope<AuditQueryResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Purchase Evaluation
// ---------------------------------------------------------------------------

/**
 * Parameters for evaluating a proposed purchase against budget limits.
 * Read-only deterministic analysis — no model or cloud invocation.
 */
export interface PurchaseEvaluationParams {
  /** Category identifier to evaluate against. */
  categoryId: string;
  /** Purchase amount to evaluate. */
  amount: Money;
  /** Optional account identifier for balance projection. */
  accountId?: string;
  /** Canonical decision context. Required when using prospective evaluation. */
  context?: DecisionContext;
  /** Existing reservations and commitments considered by the decision. */
  claims?: ProspectiveClaim[];
  /** Caller-supplied request identity for deterministic provenance. */
  requestId?: string;
  /** Caller-supplied correlation identity for deterministic provenance. */
  correlationId?: string;
  /** Caller-supplied decision identity. */
  decisionId?: string;
  /** Caller-supplied expiry for the decision. */
  validUntil?: string;
  /** Visibility of the resulting decision. */
  redaction?: RedactionState;
}

/**
 * Result of evaluating a proposed purchase against budget constraints.
 * Every monetary value is labeled with its semantics.
 */
export interface PurchaseEvaluationResult {
  /** Whether the purchase is allowable within budget constraints. */
  allowable: boolean;
  /** Machine-readable reason codes supporting the evaluation. */
  reasonCodes: string[];
  /** How much is budgeted for this category in the current month. */
  categoryBudget: Money;
  /** How much has been spent in this category so far. */
  categorySpent: Money;
  /** Remaining budget after accounting for this purchase. */
  categoryRemaining: Money;
  /** Projected account balance after purchase (null if account not tracked). */
  projectedBalance: Money | null;
  /** Whether an envelope budget exists for the category (vs cash-flow-only). */
  hasEnvelope: boolean;
  /** Full canonical decision, when evaluated by the prospective-decision path. */
  decision?: ProspectiveDecisionEnvelope<PurchaseEvaluation>;
}

export interface PurchaseEvaluationOutput {
  envelope: ResponseEnvelope<PurchaseEvaluationResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Cash-Flow Projection
// ---------------------------------------------------------------------------

/**
 * Parameters for projecting future cash flow.
 */
export interface CashFlowProjectionParams {
  /** Number of months to project (1-24). */
  months: number;
  /** Optional starting month (YYYY-MM). Defaults to current month. */
  startMonth?: string;
}

/** A single month's cash-flow projection. */
export interface MonthlyCashFlowProjection {
  /** The month in YYYY-MM format. */
  month: string;
  /** Total projected income for this month. */
  projectedIncome: Money;
  /** Total projected expenses for this month. */
  projectedExpenses: Money;
  /** Net change (income - expenses) for this month. */
  netChange: Money;
  /** Ending balance after this month. */
  endingBalance: Money;
  /** Number of scheduled income events. */
  scheduledIncomeCount: number;
  /** Number of scheduled expense events. */
  scheduledExpenseCount: number;
}

/**
 * Result of projecting future cash flow.
 */
export interface CashFlowProjectionResult {
  /** Number of months projected. */
  projectionMonths: number;
  /** Monthly projections, oldest first. */
  monthlyProjections: MonthlyCashFlowProjection[];
  /** Whether projections are based on sufficient data. */
  sufficientData: boolean;
  /** Warning if data is insufficient. */
  dataWarning: string | null;
}

export interface CashFlowProjectionOutput {
  envelope: ResponseEnvelope<CashFlowProjectionResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Target & Sinking-Fund Health
// ---------------------------------------------------------------------------

/**
 * Health status of a single budget category or target.
 */
export interface CategoryHealthResult {
  categoryId: string;
  categoryName: string;
  budgeted: Money;
  spent: Money;
  remaining: Money;
  /** One of: "healthy", "overspent", "underfunded", "at_risk". */
  healthLabel: string;
  /** Whether this is a sinking fund (carryover target). */
  isSinkingFund: boolean;
  /** Target amount for sinking funds, null for regular categories. */
  targetAmount: Money | null;
  /** Progress toward target (0.0-1.0), null for non-sinking-funds. */
  targetProgress: number | null;
}

/**
 * Result of evaluating budget target health.
 */
export interface TargetHealthResult {
  categories: CategoryHealthResult[];
  overallLabel: string;
  /** Number of healthy categories. */
  healthyCount: number;
  /** Number of categories at risk or overspent. */
  atRiskCount: number;
  /** Number of sinking funds tracked. */
  sinkingFundCount: number;
}

export interface TargetHealthOutput {
  envelope: ResponseEnvelope<TargetHealthResult>;
}

/**
 * Result of evaluating sinking fund health specifically.
 */
export interface SinkingFundHealthResult {
  /** Sinking funds only. */
  sinkingFunds: CategoryHealthResult[];
  /** Number fully funded (progress >= 1.0). */
  fullyFundedCount: number;
  /** Number partially funded. */
  partiallyFundedCount: number;
  /** Number with no funding started. */
  unfundedCount: number;
}

export interface SinkingFundHealthOutput {
  envelope: ResponseEnvelope<SinkingFundHealthResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Report Generation (persisted scope/filters)
// ---------------------------------------------------------------------------

/**
 * Scope definition for report generation.
 * Persisted alongside the report record for reproducibility.
 */
export interface ReportScope {
  /** Month range: single YYYY-MM or "YYYY-MM:YYYY-MM" inclusive. */
  monthRange: string;
  /** Optional category group filter. */
  categoryGroup?: string;
  /** Optional category IDs to include. */
  categoryIds?: string[];
  /** Optional account IDs to include. */
  accountIds?: string[];
  /** Include pending transactions. */
  includePending: boolean;
}

/**
 * Parameters for generating a report with persisted scope.
 */
export interface ReportGenerationParams {
  /** Report type: "spending" | "income" | "net_worth" | "category_breakdown" | "cash_flow". */
  reportType: string;
  /** Scope of the report — persisted with the report record. */
  scope: ReportScope;
  /** Optional human-readable label. */
  label?: string;
  /** Optional tags for categorization. */
  tags?: string[];
}

/**
 * Result of generating (and persisting) a report.
 */
export interface ReportGenerationResult {
  /** Stable report identifier for later retrieval. */
  reportId: string;
  /** Report type. */
  reportType: string;
  /** Persisted scope snapshot. */
  scope: ReportScope;
  /** Human-readable label. */
  label: string;
  /** Number of transactions included. */
  transactionCount: number;
  /** Total amount covered by the report. */
  totalAmount: Money;
  /** ISO timestamp of generation. */
  generatedAt: string;
  /** Tags. */
  tags: string[];
}

export interface ReportGenerationOutput {
  envelope: ResponseEnvelope<ReportGenerationResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Saved Views
// ---------------------------------------------------------------------------

/**
 * A saved view configuration.
 */
export interface SavedView {
  /** Stable view identifier. */
  viewId: string;
  /** Human-readable name. */
  name: string;
  /** View type: "pending_review" | "budget_summary" | "target_health" | "cash_flow" | "reports" | "attention". */
  viewType: string;
  /** Scope/filter configuration. */
  scope: Record<string, unknown>;
  /** Optional user-defined sort. */
  sort?: string;
  /** Creation timestamp. */
  createdAt: string;
}

/**
 * Parameters for creating a saved view.
 */
export interface CreateSavedViewParams {
  /** Human-readable name. */
  name: string;
  /** View type. */
  viewType: string;
  /** Scope/filter configuration. */
  scope: Record<string, unknown>;
  /** Optional user-defined sort. */
  sort?: string;
}

/**
 * Result of listing saved views.
 */
export interface SavedViewsListResult {
  views: SavedView[];
  total: number;
}

export interface SavedViewsListOutput {
  envelope: ResponseEnvelope<SavedViewsListResult>;
}

/**
 * Result of creating a saved view.
 */
export interface CreateSavedViewResult {
  view: SavedView;
}

export interface CreateSavedViewOutput {
  envelope: ResponseEnvelope<CreateSavedViewResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Financial State
// ---------------------------------------------------------------------------

/**
 * Overall financial state assessment combining target health, sinking funds,
 * budget adherence, and cash position.
 */
export interface FinancialStateResult {
  /** Overall label: 'healthy' | 'caution' | 'critical' | 'unknown'. */
  overallLabel: string;
  /** Net worth (assets minus liabilities). */
  netWorth: Money;
  /** Monthly net cash flow. */
  monthlyCashFlow: Money;
  /** Budget adherence as percentage 0-100. */
  budgetAdherencePercent: number;
  /** Number of categories at risk. */
  categoriesAtRisk: number;
  /** Number of sinking funds that are unfunded or underfunded. */
  sinkingFundsUnderfunded: number;
  /** Human-readable advice based on financial state. */
  advice: string[];
  /** Data freshness at evaluation time. */
  freshness: DataFreshness | null;
}

export interface FinancialStateOutput {
  envelope: ResponseEnvelope<FinancialStateResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Data Quality Center
// ---------------------------------------------------------------------------

/**
 * A single dimension of data quality with score and severity.
 * Fields match the shape returned by the analytics native addon.
 */
export interface QualityDimension {
  dimension: string;
  score: number | null;
  explanation: string;
  worstSeverity: string | null;
}

/**
 * Composite data-quality report.
 */
export interface DataQualityResult {
  overallScore: number | null;
  dimensions: QualityDimension[];
  recommendations: string[];
}

export interface DataQualityOutput {
  envelope: ResponseEnvelope<DataQualityResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Liquidity Coverage
// ---------------------------------------------------------------------------

/**
 * A single upcoming obligation.
 */
export interface UpcomingObligation {
  name: string;
  dueDate: string;
  amount: Money;
  categoryId: string | null;
  isRecurring: boolean;
}

/**
 * Coverage ratio against upcoming obligations. `null` means the window has no obligations.
 */
export interface CoverageRatio {
  ratio: number | null;
  label: string;
}

/**
 * Liquidity / obligation coverage assessment.
 */
export interface LiquidityCoverageResult {
  totalLiquid: Money | null;
  totalObligations: Money | null;
  coverage: CoverageRatio[];
  upcomingObligations: UpcomingObligation[];
}

export interface LiquidityCoverageOutput {
  envelope: ResponseEnvelope<LiquidityCoverageResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Bill Calendar
// ---------------------------------------------------------------------------

/**
 * Calendar entry for a single bill or obligation.
 */
export interface BillCalendarEntry {
  name: string;
  dueDate: string;
  amount: Money;
  categoryId: string | null;
  status: string;
}

/**
 * Calendar of upcoming bills/obligations.
 */
export interface BillCalendarResult {
  entries: BillCalendarEntry[];
  totalUnpaid: Money | null;
  unpaidCount: number;
}

export interface BillCalendarOutput {
  envelope: ResponseEnvelope<BillCalendarResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Budget Variance
// ---------------------------------------------------------------------------

/**
 * Variance for a single budget category.
 */
export interface CategoryVariance {
  categoryId: string;
  categoryName: string;
  budgeted: Money;
  actual: Money;
  variance: Money;
  variancePercent: number;
  label: string;
}

/**
 * Trend direction for a budget category.
 */
export type TrendDirection = 'increasing' | 'decreasing' | 'stable' | 'volatile';

/**
 * Trend information for a single category.
 */
export interface CategoryTrend {
  categoryId: string;
  categoryName: string;
  direction: TrendDirection;
  avgChange: Money;
  periodsAnalyzed: number;
  seasonalityDetected: boolean;
}

/**
 * Budget variance and trends report.
 */
export interface BudgetVarianceResult {
  categoryVariances: CategoryVariance[];
  trends: CategoryTrend[];
  totalBudgeted: Money | null;
  totalActual: Money | null;
  totalVariance: Money | null;
  overallVariancePercent: number | null;
}

export interface BudgetVarianceOutput {
  envelope: ResponseEnvelope<BudgetVarianceResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Irregular Obligations
// ---------------------------------------------------------------------------

/**
 * Type of irregularity detected for an obligation.
 */
export type IrregularityKind = 'nonMonthly' | 'seasonal' | 'oneOff' | 'variableAmount';

/**
 * An irregular obligation entry.
 */
export interface IrregularObligation {
  name: string;
  kind: IrregularityKind;
  typicalAmount: Money;
  frequency: string;
  categoryId: string | null;
  nextExpectedDate: string | null;
}

/**
 * Report of obligations that don't follow a regular monthly pattern.
 */
export interface IrregularObligationsResult {
  obligations: IrregularObligation[];
  totalEstimatedAnnual: Money | null;
}

export interface IrregularObligationsOutput {
  envelope: ResponseEnvelope<IrregularObligationsResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Income Reliability
// ---------------------------------------------------------------------------

/**
 * A single income source with reliability metrics.
 */
export interface IncomeSource {
  name: string;
  typicalMonthly: Money;
  reliabilityScore: number;
  variability: number;
  paymentCount: number;
  isRegular: boolean;
}

/**
 * Assessment of income reliability.
 */
export interface IncomeReliabilityResult {
  sources: IncomeSource[];
  totalMonthly: Money | null;
  overallScore: number | null;
  unreliableSourceCount: number;
}

export interface IncomeReliabilityOutput {
  envelope: ResponseEnvelope<IncomeReliabilityResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Forecast Calibration
// ---------------------------------------------------------------------------

/**
 * Calibration metric for a single forecast dimension.
 */
export interface CalibrationMetric {
  metricName: string;
  mape: number | null;
  bias: number | null;
  periodsCompared: number;
  isCalibrated: boolean;
}

/**
 * How well past forecasts matched actual outcomes.
 */
export interface ForecastCalibrationResult {
  metrics: CalibrationMetric[];
  overallCalibrated: boolean;
  recommendations: string[];
}

export interface ForecastCalibrationOutput {
  envelope: ResponseEnvelope<ForecastCalibrationResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Scenario Comparison (Immutable)
// ---------------------------------------------------------------------------

/**
 * Parameters for comparing two immutable scenarios.
 */
export interface ScenarioComparisonParams {
  /** Baseline scenario JSON payload. */
  baseline: Record<string, unknown>;
  /** Comparison scenario JSON payload. */
  comparison: Record<string, unknown>;
}

/**
 * Comparison delta between two scenarios for a single dimension.
 */
export interface ScenarioComparisonDelta {
  dimension: string;
  baselineValue: unknown;
  comparisonValue: unknown;
  change: string;
}

/**
 * Result of comparing two immutable scenarios.
 */
export interface ScenarioComparisonResult {
  deltas: ScenarioComparisonDelta[];
  summary: string;
}

export interface ScenarioComparisonOutput {
  envelope: ResponseEnvelope<ScenarioComparisonResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Multidimensional Health
// ---------------------------------------------------------------------------

/**
 * A single dimension of financial health.
 */
export interface HealthDimension {
  dimension: string;
  score: number;
  weight: number;
  explanation: string;
  severity: string;
}

/**
 * Explainable multidimensional health assessment.
 */
export interface MultidimensionalHealthResult {
  dimensions: HealthDimension[];
  compositeScore: number;
  summary: string;
  recommendations: string[];
}

export interface MultidimensionalHealthOutput {
  envelope: ResponseEnvelope<MultidimensionalHealthResult>;
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Attention / Home Dashboard
// ---------------------------------------------------------------------------

/** Fixed routing classifications for canonical financial attention findings. */
export type FinancialAttentionClassification =
  | 'account_readiness_blocker'
  | 'transfer_needs_attention'
  | 'reservation_conflict'
  | 'commitment_conflict'
  | 'evidence_connector_degradation'
  | 'unresolved_material_evidence';

/**
 * Canonical decision metadata carried by attention items when the source is a
 * financial snapshot. Fields remain optional so existing attention producers
 * and consumers retain their legacy contract.
 */
export interface AttentionDecisionMetadata {
  classification?: FinancialAttentionClassification;
  issue?: DecisionIssue;
  snapshotId?: string;
  policyVersion?: string;
  revision?: string;
  dedupKey?: string;
  findingId?: string;
  findingStatus?: FindingStatus;
  findingVersion?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  expiresAt?: string | null;
}

/**
 * A single blocker item for the attention dashboard.
 */
export interface AttentionBlocker extends AttentionDecisionMetadata {
  code: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  entityId?: string;
  entityType?: string;
}

/**
 * A single alert item.
 */
export interface AttentionAlert extends AttentionDecisionMetadata {
  code: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  categoryId?: string;
  categoryName?: string;
}

/**
 * A detected recurrence or duplicate pattern.
 */
export interface RecurrencePattern {
  payeeName: string;
  amount: Money;
  frequency: string;
  occurrences: number;
  lastOccurrence: string;
  isEstimated: boolean;
}

/**
 * Risk assessment for a category or cash-flow.
 */
export interface CategoryRisk {
  categoryId: string;
  categoryName: string;
  risk: 'low' | 'medium' | 'high';
  reasonCodes: string[];
  remainingBudget: Money;
  daysRemaining: number | null;
}

/**
 * Target progress summary for the attention view.
 */
export interface TargetProgressSummary {
  overallLabel: string;
  healthyCount: number;
  atRiskCount: number;
  sinkingFundsOnTrack: number;
  totalSinkingFunds: number;
}

/**
 * Parameters for fetching the attention/home dashboard.
 */
export interface AttentionHomeParams {
  /** Optional context to narrow results. */
  context?: {
    /** Focus on a specific category group. */
    categoryGroup?: string;
    /** Focus on a specific month (YYYY-MM). */
    month?: string;
    /** Include detailed breakdowns. */
    detailed?: boolean;
  };
}

/**
 * Combined attention/home dashboard result.
 * All blockers, alerts, recurrence patterns, category risks, and target
 * progress in one prioritized response.
 */
export interface AttentionHomeResult {
  /** Critical blockers that must be resolved first. */
  blockers: AttentionBlocker[];
  /** Alerts requiring attention. */
  alerts: AttentionAlert[];
  /** Detected recurrence or duplicate transaction patterns. */
  recurrences: RecurrencePattern[];
  /** Category and cash-flow risk assessments. */
  categoryRisks: CategoryRisk[];
  /** Target and sinking-fund progress. */
  targetProgress: TargetProgressSummary;
  /** Optional detailed breakdowns when context.detailed is true. */
  details?: {
    uncategorizedCount: number;
    totalUncategorizedAmount: Money;
    pendingReviewCount: number;
    overspentCategories: CategoryHealthResult[];
  };
}

export interface AttentionHomeOutput {
  envelope: ResponseEnvelope<AttentionHomeResult>;
}
