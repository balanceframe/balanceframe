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
// Parse result — stable error envelope data, never throws
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; cmd: CliCommand }
  | { ok: false; error: { code: string; message: string } };

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
 * Returns a `ParseResult` – never throws. Caller inspects `.ok` to decide
 * whether the command can be dispatched.
 */
export function parseArgs(argv: string[]): ParseResult {
  const normalized = argv.filter(a => a !== '');

  // Reject dangerous commands
  for (const pat of REJECTED_PATTERNS) {
    if (normalized[0] === pat) {
      return {
        ok: false,
        error: {
          code: 'rejected_command',
          message: `Command rejected: "${pat}" is not supported.`,
        },
      };
    }
  }

  if (normalized.length < 1) {
    return {
      ok: false,
      error: { code: 'no_command', message: 'No command provided. Use --help for usage.' },
    };
  }

  // Validate flags — only --json is recognised
  const unknownFlags = normalized.filter(a => a.startsWith('--') && a !== '--json');
  if (unknownFlags.length > 0) {
    return {
      ok: false,
      error: {
        code: 'unknown_flags',
        message: `Unknown flags: ${unknownFlags.join(', ')}`,
      },
    };
  }

  const hasJson = normalized.includes('--json');
  const format = hasJson ? 'json' : 'json'; // always JSON in this phase
  const cleanArgs = normalized.filter(a => a !== '--json');

  // Extract command path
  if (
    cleanArgs[0] === 'transactions' &&
    cleanArgs[1] === 'pending-review'
  ) {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'transactions pending-review': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'transactions.pending-review',
        format,
        args: normalized,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'show') {
    const reviewId = cleanArgs[2];
    if (!reviewId || reviewId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_review_id', message: 'reviews show requires a REVIEW_ID argument.' },
      };
    }
    if (cleanArgs.length > 3) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after review ID: ${cleanArgs.slice(3).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'reviews.show',
        format,
        args: normalized,
        reviewId,
      },
    };
  }

  if (cleanArgs[0] === 'budget' && cleanArgs[1] === 'summary') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'budget summary': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'budget.summary',
        format,
        args: normalized,
      },
    };
  }

  if (cleanArgs[0] === 'export') {
    if (cleanArgs.length > 1) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'export': ${cleanArgs.slice(1).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'export',
        format,
        args: normalized,
      },
    };
  }

  if (cleanArgs[0] === 'disconnect') {
    if (cleanArgs.length > 1) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'disconnect': ${cleanArgs.slice(1).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'disconnect',
        format,
        args: normalized,
      },
    };
  }

  if (cleanArgs[0] === 'remove-connection') {
    if (cleanArgs.length > 1) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'remove-connection': ${cleanArgs.slice(1).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'remove-connection',
        format,
        args: normalized,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'unknown_command',
      message: `Unknown command: ${normalized.join(' ')}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/**
 * Build an `AuthorizationContext` for a lifecycle operation.
 *
 * Destructive operations (remove-connection) are denied in Observe mode.
 * Read-lifecycle operations (export, disconnect) proceed in any mode, but
 * the returned context reflects the operation name so callers can audit it.
 */
function modeAuthorization(mode: ConnectionMode, actorId: string, operation: string): AuthorizationContext {
  if (operation === 'remove-connection' && mode === 'observe') {
    return AuthorizationContext.denied(actorId, operation);
  }
  return { actorId, capability: operation, allowed: true };
}

// ---------------------------------------------------------------------------
// Main dispatcher (called from bin script or tests)
// ---------------------------------------------------------------------------

/**
 * Execute a CLI command and return a JSON envelope.
 *
 * @param argv CLI argument vector (excluding node/binary).
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
  const mode: ConnectionMode = opts?.mode ?? 'observe';
  const actorId = opts?.actorId ?? 'usr_cli';
  const requestId = opts?.requestId ?? `req_${Date.now().toString(36)}`;
  const ledger = opts?.ledger ?? null;
  const freshness: DataFreshness | null = opts?.freshness ?? null;

  // Handle parse errors as stable JSON error envelopes — never throw
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    const info = new ErrorInfo({
      code: parsed.error.code,
      message: parsed.error.message,
      retryable: false,
      reasonCodes: ['cli_error'],
    });
    return JSON.stringify(errorResponse(requestId, info), null, 2);
  }
  const cmd = parsed.cmd;

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
          const envelope = okResponse(requestId, freshness, modeAuthorization(mode, actorId, 'export'), result);
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
          const envelope = okResponse(requestId, null, modeAuthorization(mode, actorId, 'disconnect'), result);
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
        // Enforce mode authorization — destructive operation blocked in Observe
        if (mode === 'observe') {
          const info = new ErrorInfo({
            code: 'write_rejected',
            message: 'remove-connection requires write authorization and is not available in observe mode.',
            retryable: false,
            reasonCodes: ['observe_mode_write_blocked'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        try {
          const result = await callbacks.doRemoveConnection(ledger);
          const envelope = okResponse(requestId, null, modeAuthorization(mode, actorId, 'remove-connection'), result);
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
