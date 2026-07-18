/**
 * Command routing for the application layer.
 *
 * Parses raw argument arrays into structured commands, validates them
 * against the current access mode, and dispatches to the appropriate handler.
 *
 * No model invocation — all analysis uses injected adapter/protocol.
 */

import type { ResponseEnvelope, DataFreshness } from './envelope';
import { ApplicationError, ObserveWriteError, ReasonCodes } from './errors';
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

  // Lifecycle commands
  { args: ['disconnect'], command: 'disconnect', route: 'lifecycle' },
  { args: ['export'], command: 'export', route: 'export' },
  { args: ['remove-connection'], command: 'remove-connection', route: 'lifecycle' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
