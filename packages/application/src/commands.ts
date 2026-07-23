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
import type { Money } from '@balanceframe/protocol-generated';

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
  pendingReview(
    ledger: unknown,
    freshness: DataFreshness | null,
  ): Promise<PendingReviewResult>;
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
  proposalCreate?(
    ledger: unknown,
    options?: ReviewActionOptions,
  ): Promise<ProposalCreateResult>;

  /** Show a proposal by ID. */
  proposalShow?(
    ledger: unknown,
    proposalId: string,
  ): Promise<ProposalDetailResult>;

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
  proposalList?(
    ledger: unknown,
  ): Promise<ProposalListResult>;

  /** Query the audit trail. */
  auditQuery?(
    ledger: unknown,
    query?: AuditQueryOptions,
  ): Promise<AuditQueryResult>;


  /** List automation rules. */
  ruleList?(
    ledger: unknown,
  ): Promise<RuleListResult>;

  /** Show a single rule by ID. */
  ruleShow?(
    ledger: unknown,
    ruleId: string,
  ): Promise<RuleShowResult>;

  /** Update a rule via proposal. */
  ruleUpdate?(
    ledger: unknown,
    options?: ReviewActionOptions,
  ): Promise<RuleCreateResult>;
  /** Create a new rule proposal. */
  ruleCreate?(
    ledger: unknown,
    options?: ReviewActionOptions,
  ): Promise<RuleCreateResult>;
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

export type ConnectionMode = 'observe' | 'reviewAndApply' | 'managedAutomation' | 'disposableSandbox';

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
  { args: ['raw-query'], code: 'unknown_command', reason: 'raw-query is not supported', rc: ReasonCodes.UNSUPPORTED_RAW_QUERY },
  { args: ['invoke-method'], code: 'unknown_command', reason: 'invoke-method is not supported', rc: ReasonCodes.UNSUPPORTED_RAW_QUERY },
  { args: ['shell'], code: 'unknown_command', reason: 'shell is not supported', rc: ReasonCodes.UNSUPPORTED_RAW_QUERY },
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
  { args: ['transactions', 'pending-review'], command: 'transactions.pending-review', route: 'analysis' },
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
  return args.filter(a => !a.startsWith('--'));
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
