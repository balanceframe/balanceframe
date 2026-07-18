#!/usr/bin/env node
/**
 * @balanceframe/cli — BalanceFrame CLI tool.
 *
 * Entry point for the CLI. Parses arguments, routes commands through the
 * application layer, and prints versioned JSON envelopes to stdout.
 *
 * Usage:
 *   balanceframe transactions pending-review --json
 *   balanceframe reviews show REVIEW_ID --json
 *   balanceframe budget summary --json
 *   balanceframe disconnect
 *   balanceframe export --json
 *   balanceframe remove-connection
 */

import {
  routeCommand,
  pendingReviewAnalysis,
  reviewShowAnalysis,
  budgetSummaryAnalysis,
  type CommandInput,
  type ConnectionMode,
  type AnalysisProtocol,
  type LifecycleCallbacks,
  okResponse,
  errorResponse,
  ErrorInfo,
  type DataFreshness,
  AuthorizationContext,
} from '@balanceframe/application';

// ---------------------------------------------------------------------------
// Parsed CLI command
// ---------------------------------------------------------------------------

export interface CliCommand {
  /** Dot-separated command path (e.g. 'transactions.pending-review'). */
  command: string;
  /** Output format (always 'json' in this phase). */
  format: string;
  /** Raw argument tokens. */
  args: string[];
  /** Review ID for 'reviews show' commands. */
  reviewId?: string;
}

// ---------------------------------------------------------------------------
// Rejected command patterns
// ---------------------------------------------------------------------------

const REJECTED_PATTERNS = [
  'raw-query',
  'invoke-method',
  'shell',
];

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Parse raw CLI argument vector into a structured CliCommand.
 *
 * Throws if the command is rejected or malformed.
 */
export function parseArgs(argv: string[]): CliCommand {
  const normalized = argv.filter(a => a !== '');

  // Reject dangerous commands
  for (const pat of REJECTED_PATTERNS) {
    if (normalized[0] === pat) {
      throw new Error(`Command rejected: "${pat}" is not supported.`);
    }
  }

  if (normalized.length < 1) {
    throw new Error('No command provided. Use --help for usage.');
  }

  const hasJson = normalized.includes('--json');
  const format = hasJson ? 'json' : 'json'; // always JSON in this phase
  const cleanArgs = normalized.filter(a => a !== '--json');

  // Extract command path
  if (
    cleanArgs[0] === 'transactions' &&
    cleanArgs[1] === 'pending-review'
  ) {
    return {
      command: 'transactions.pending-review',
      format,
      args: normalized,
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'show') {
    const reviewId = cleanArgs[2];
    if (!reviewId || reviewId.startsWith('--')) {
      throw new Error('reviews show requires a REVIEW_ID argument.');
    }
    return {
      command: 'reviews.show',
      format,
      args: normalized,
      reviewId,
    };
  }

  if (cleanArgs[0] === 'budget' && cleanArgs[1] === 'summary') {
    return {
      command: 'budget.summary',
      format,
      args: normalized,
    };
  }

  if (cleanArgs[0] === 'export') {
    return {
      command: 'export',
      format,
      args: normalized,
    };
  }

  if (cleanArgs[0] === 'disconnect') {
    return {
      command: 'disconnect',
      format,
      args: normalized,
    };
  }

  if (cleanArgs[0] === 'remove-connection') {
    return {
      command: 'remove-connection',
      format,
      args: normalized,
    };
  }

  throw new Error(`Unknown command: ${normalized.join(' ')}`);
}

// ---------------------------------------------------------------------------
// Main dispatcher (called from bin script or tests)
// ---------------------------------------------------------------------------

/**
 * Execute a CLI command and return a JSON envelope.
 *
 * @param argv CLi argument vector (excluding node/binary).
 * @param opts Optional injected services for testing.
 */
export async function main(
  argv: string[],
  opts?: {
    actorId?: string;
    requestId?: string;
    mode?: ConnectionMode;
    ledger?: unknown;
    freshness?: DataFreshness | null;
    analysisProtocol?: AnalysisProtocol;
    lifecycleCallbacks?: LifecycleCallbacks;
  },
): Promise<string> {
  const cmd = parseArgs(argv);

  const mode: ConnectionMode = opts?.mode ?? 'observe';
  const actorId = opts?.actorId ?? 'usr_cli';
  const requestId = opts?.requestId ?? `req_${Date.now().toString(36)}`;
  const ledger = opts?.ledger ?? null;
  const freshness: DataFreshness | null = opts?.freshness ?? null;

  const commandInput: CommandInput = {
    args: cmd.args,
    mode,
    actorId,
    requestId,
    ledger,
    freshness,
    analysisProtocol: opts?.analysisProtocol,
    lifecycleCallbacks: opts?.lifecycleCallbacks,
  };

  try {
    const routed = routeCommand(commandInput);

    // Dispatch to handlers based on route
    switch (routed.command) {
      case 'transactions.pending-review': {
        const envelope = await pendingReviewAnalysis(commandInput);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.show': {
        const envelope = await reviewShowAnalysis(commandInput, cmd.reviewId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'budget.summary': {
        const envelope = await budgetSummaryAnalysis(commandInput);
        return JSON.stringify(envelope, null, 2);
      }

      case 'export': {
        const callbacks = commandInput.lifecycleCallbacks;
        if (!callbacks) {
          const info = new ErrorInfo({
            code: 'no_lifecycle_callbacks',
            message: 'Export command requires lifecycle callbacks. Not connected?',
            retryable: true,
            reasonCodes: ['missing_ledger_config'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        if (!ledger) {
          const info = new ErrorInfo({
            code: 'not_connected',
            message: 'No ledger connected. Use a connect command first.',
            retryable: true,
            reasonCodes: ['missing_ledger_config'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        try {
          const result = await callbacks.doExport(ledger);
          const envelope = okResponse(requestId, freshness, AuthorizationContext.observe(actorId), result);
          return JSON.stringify(envelope, null, 2);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const info = new ErrorInfo({
            code: 'export_failed',
            message,
            retryable: true,
            reasonCodes: ['export_error'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
      }

      case 'disconnect': {
        const callbacks = commandInput.lifecycleCallbacks;
        if (!callbacks) {
          const info = new ErrorInfo({
            code: 'no_lifecycle_callbacks',
            message: 'Disconnect command requires lifecycle callbacks. Not connected?',
            retryable: true,
            reasonCodes: ['missing_ledger_config'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        if (!ledger) {
          const info = new ErrorInfo({
            code: 'not_connected',
            message: 'No ledger connected. Use a connect command first.',
            retryable: true,
            reasonCodes: ['missing_ledger_config'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        try {
          const result = await callbacks.doDisconnect(ledger);
          const envelope = okResponse(requestId, null, AuthorizationContext.observe(actorId), result);
          return JSON.stringify(envelope, null, 2);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const info = new ErrorInfo({
            code: 'disconnect_failed',
            message,
            retryable: true,
            reasonCodes: ['disconnect_error'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
      }

      case 'remove-connection': {
        const callbacks = commandInput.lifecycleCallbacks;
        if (!callbacks) {
          const info = new ErrorInfo({
            code: 'no_lifecycle_callbacks',
            message: 'Remove-connection command requires lifecycle callbacks. Not connected?',
            retryable: true,
            reasonCodes: ['missing_ledger_config'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        if (!ledger) {
          const info = new ErrorInfo({
            code: 'not_connected',
            message: 'No ledger connected. Use a connect command first.',
            retryable: true,
            reasonCodes: ['missing_ledger_config'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        try {
          const result = await callbacks.doRemoveConnection(ledger);
          const envelope = okResponse(requestId, null, AuthorizationContext.observe(actorId), result);
          return JSON.stringify(envelope, null, 2);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const info = new ErrorInfo({
            code: 'remove_connection_failed',
            message,
            retryable: true,
            reasonCodes: ['remove_connection_error'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
      }

      default:
        throw new Error(`Unhandled command: ${routed.command}`);
    }
  } catch (err) {
    if (err instanceof Error) {
      const info = new ErrorInfo({
        code: 'cli_error',
        message: err.message,
        retryable: false,
        reasonCodes: ['cli_error'],
      });
      const envelope = errorResponse(requestId, info);
      return JSON.stringify(envelope, null, 2);
    }
    throw err;
  }
}
