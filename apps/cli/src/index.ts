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
  reviewApproveAnalysis,
  reviewCorrectAnalysis,
  reviewRejectAnalysis,
  reviewSkipAnalysis,
  reviewUndoAnalysis,
  reviewApproveBulkAnalysis,
  reviewGroupAnalysis,
  budgetSummaryAnalysis,
  proposalCreateAnalysis,
  proposalShowAnalysis,
  proposalApproveAnalysis,
  proposalExecuteAnalysis,
  proposalListAnalysis,
  auditQueryAnalysis,
  ruleCreateAnalysis,
  ruleListAnalysis,
  ruleShowAnalysis,
  ruleUpdateAnalysis,
  type CommandInput,
  type ConnectionMode,
  type AnalysisProtocol,
  type LifecycleCallbacks,
  type AuditQueryOptions,
  type ReviewActionOptions,
  ApplicationError,
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
  /** Review ID for single-item review commands. */
  reviewId?: string;
  /** Category ID for 'correct' action. */
  categoryId?: string;
  /** Multiple review IDs for bulk/group commands. */
  ids?: string[];
  /** Proposal ID for proposal show/approve/execute commands. */
  proposalId?: string;
  /** Rule ID for rule show command. */
  ruleId?: string;
  /** Extra command options parsed from flags (proposals create, audit query). */
  options?: Record<string, string>;
}

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

  // Known flags accepted across all commands
  const KNOWN_FLAGS: Record<string, true> = {
    '--json': true,
    '--category-id': true,
    '--transaction-id': true,
    '--limit': true,
    '--offset': true,
    '--actor-id': true,
    '--entity-id': true,
    '--action': true,
    '--from': true,
    '--to': true,
    '--scope': true,
    '--operation': true,
    '--message': true,
    '--reason': true,
    '--name': true,
    '--payee': true,
    '--active': true,
    '--rule-id': true,
  };
  const unknownFlags = normalized.filter(a => a.startsWith('--') && !KNOWN_FLAGS[a]);
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

  // Review action commands
  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'approve') {
    const reviewId = cleanArgs[2];
    if (!reviewId || reviewId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_review_id', message: 'reviews approve requires a REVIEW_ID argument.' },
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
        command: 'reviews.approve',
        format,
        args: normalized,
        reviewId,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'correct') {
    // Review ID and optional category ID are positional; category can also
    // be provided via --category-id at any position.  Only known flags may
    // appear after the first positional value.
    let reviewId: string | undefined;
    let categoryId: string | undefined;
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      if (a === '--category-id') {
        if (!remaining[i + 1] || remaining[i + 1].startsWith('--')) {
          return {
            ok: false,
            error: { code: 'missing_category_value', message: '--category-id requires a value.' },
          };
        }
        categoryId = remaining[i + 1];
        remaining.splice(i, 2);
        i -= 1;
      } else if (!a.startsWith('--') && !reviewId) {
        reviewId = a;
        remaining.splice(i, 1);
        i -= 1;
      } else if (!a.startsWith('--') && !categoryId) {
        categoryId = a;
        remaining.splice(i, 1);
        i -= 1;
      }
    }

    if (!reviewId) {
      return {
        ok: false,
        error: { code: 'missing_review_id', message: 'reviews correct requires a REVIEW_ID argument.' },
      };
    }
    if (!categoryId) {
      return {
        ok: false,
        error: { code: 'missing_category_id', message: 'reviews correct requires a CATEGORY_ID argument (provide it positionally or via --category-id).' },
      };
    }
    if (remaining.length > 0) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments: ${remaining.join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'reviews.correct',
        format,
        args: normalized,
        reviewId,
        categoryId,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'reject') {
    const reviewId = cleanArgs[2];
    if (!reviewId || reviewId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_review_id', message: 'reviews reject requires a REVIEW_ID argument.' },
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
        command: 'reviews.reject',
        format,
        args: normalized,
        reviewId,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'skip') {
    const reviewId = cleanArgs[2];
    if (!reviewId || reviewId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_review_id', message: 'reviews skip requires a REVIEW_ID argument.' },
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
        command: 'reviews.skip',
        format,
        args: normalized,
        reviewId,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'undo') {
    const reviewId = cleanArgs[2];
    if (!reviewId || reviewId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_review_id', message: 'reviews undo requires a REVIEW_ID argument.' },
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
        command: 'reviews.undo',
        format,
        args: normalized,
        reviewId,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'approve-bulk') {
    const ids: string[] = [];
    for (const a of cleanArgs.slice(2)) {
      if (a.startsWith('--')) continue; // skip flags (already validated by KNOWN_FLAGS check)
      if (!a.startsWith('rev_')) {
        return {
          ok: false,
          error: { code: 'invalid_review_id', message: `Invalid review ID: "${a}". Review IDs must start with "rev_".` },
        };
      }
      ids.push(a);
    }
    if (ids.length < 1) {
      return {
        ok: false,
        error: { code: 'missing_review_ids', message: 'reviews approve-bulk requires at least one REVIEW_ID.' },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'reviews.approve-bulk',
        format,
        args: normalized,
        ids,
      },
    };
  }

  if (cleanArgs[0] === 'reviews' && cleanArgs[1] === 'group') {
    const ids: string[] = [];
    for (const a of cleanArgs.slice(2)) {
      if (a.startsWith('--')) continue;
      if (!a.startsWith('rev_')) {
        return {
          ok: false,
          error: { code: 'invalid_review_id', message: `Invalid review ID: "${a}". Review IDs must start with "rev_".` },
        };
      }
      ids.push(a);
    }
    if (ids.length < 1) {
      return {
        ok: false,
        error: { code: 'missing_review_ids', message: 'reviews group requires at least one REVIEW_ID.' },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'reviews.group',
        format,
        args: normalized,
        ids,
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

  if (cleanArgs[0] === 'delete-data') {
    const scopeIndex = cleanArgs.indexOf('--scope');
    if (scopeIndex === -1) {
      return {
        ok: false,
        error: { code: 'missing_scope', message: 'delete-data requires a --scope flag.' },
      };
    }
    const scopeValue = cleanArgs[scopeIndex + 1];
    if (!scopeValue || scopeValue.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_scope_value', message: '--scope requires a value.' },
      };
    }
    const VALID_SCOPES = ['connection', 'space', 'user', 'provider', 'workflow', 'notification'];
    if (!VALID_SCOPES.includes(scopeValue)) {
      return {
        ok: false,
        error: { code: 'invalid_scope', message: `Invalid scope "${scopeValue}". Must be one of: connection, space, user, provider, workflow, notification.` },
      };
    }
    // Check for unexpected extra arguments
    const cleanWithoutScope = cleanArgs.filter((_, i) => i !== scopeIndex && i !== scopeIndex + 1);
    if (cleanWithoutScope.length > 1) {
      return {
        ok: false,
        error: { code: 'trailing_args', message: `Unexpected arguments after 'delete-data': ${cleanWithoutScope.slice(1).join(' ')}` },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'delete-data',
        format,
        args: normalized,
        options: { scope: scopeValue },
      },
    };
  }

  // -----------------------------------------------------------------------
  // Proposal commands
  // -----------------------------------------------------------------------

  if (cleanArgs[0] === 'proposals' && cleanArgs[1] === 'create') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--category-id') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--category-id requires a value.' } }; options['category-id'] = v; i++; }
      else if (a === '--transaction-id') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--transaction-id requires a value.' } }; options['transaction-id'] = v; i++; }
      else if (a === '--message') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--message requires a value.' } }; options.message = v; i++; }
      else if (a === '--reason') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--reason requires a value.' } }; options.reason = v; i++; }
      else if (a === '--operation') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--operation requires a value.' } }; options.operation = v; i++; }
      else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: { code: 'trailing_args', message: `Unexpected argument after 'proposals create': ${a}` },
        };
      }
    }
    return {
      ok: true,
      cmd: {
        command: 'proposals.create',
        format,
        args: normalized,
        options,
      },
    };
  }

  if (cleanArgs[0] === 'proposals' && cleanArgs[1] === 'show') {
    const proposalId = cleanArgs[2];
    if (!proposalId || proposalId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_proposal_id', message: 'proposals show requires a PROPOSAL_ID argument.' },
      };
    }
    if (cleanArgs.length > 3) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after proposal ID: ${cleanArgs.slice(3).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'proposals.show',
        format,
        args: normalized,
        proposalId,
      },
    };
  }

  if (cleanArgs[0] === 'proposals' && cleanArgs[1] === 'approve') {
    const proposalId = cleanArgs[2];
    if (!proposalId || proposalId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_proposal_id', message: 'proposals approve requires a PROPOSAL_ID argument.' },
      };
    }
    if (cleanArgs.length > 3) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after proposal ID: ${cleanArgs.slice(3).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'proposals.approve',
        format,
        args: normalized,
        proposalId,
      },
    };
  }

  if (cleanArgs[0] === 'proposals' && cleanArgs[1] === 'execute') {
    const proposalId = cleanArgs[2];
    if (!proposalId || proposalId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_proposal_id', message: 'proposals execute requires a PROPOSAL_ID argument.' },
      };
    }
    if (cleanArgs.length > 3) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after proposal ID: ${cleanArgs.slice(3).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'proposals.execute',
        format,
        args: normalized,
        proposalId,
      },
    };
  }

  if (cleanArgs[0] === 'proposals' && cleanArgs[1] === 'list') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'proposals list': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'proposals.list',
        format,
        args: normalized,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Audit commands
  // -----------------------------------------------------------------------

  if (cleanArgs[0] === 'audit' && cleanArgs[1] === 'query') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--limit') { const v = nextVal(); if (v !== undefined) { options.limit = v; i++; } }
      else if (a === '--offset') { const v = nextVal(); if (v !== undefined) { options.offset = v; i++; } }
      else if (a === '--actor-id') { const v = nextVal(); if (v !== undefined) { options['actor-id'] = v; i++; } }
      else if (a === '--entity-id') { const v = nextVal(); if (v !== undefined) { options['entity-id'] = v; i++; } }
      else if (a === '--action') { const v = nextVal(); if (v !== undefined) { options.action = v; i++; } }
      else if (a === '--from') { const v = nextVal(); if (v !== undefined) { options.from = v; i++; } }
      else if (a === '--to') { const v = nextVal(); if (v !== undefined) { options.to = v; i++; } }
      else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: { code: 'trailing_args', message: `Unexpected argument after 'audit query': ${a}` },
        };
      }
    }
    // Validate numeric arguments
    if (options.limit !== undefined) {
      const n = Number(options.limit);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return {
          ok: false,
          error: { code: 'invalid_limit', message: `--limit must be a finite non-negative integer, got "${options.limit}"` },
        };
      }
    }
    if (options.offset !== undefined) {
      const n = Number(options.offset);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return {
          ok: false,
          error: { code: 'invalid_offset', message: `--offset must be a finite non-negative integer, got "${options.offset}"` },
        };
      }
    }
    return {
      ok: true,
      cmd: {
        command: 'audit.query',
        format,
        args: normalized,
        options,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Rule commands
  // -----------------------------------------------------------------------

  if (cleanArgs[0] === 'rules' && cleanArgs[1] === 'create') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--name') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--name requires a value.' } }; options.name = v; i++; }
      else if (a === '--payee') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--payee requires a value.' } }; options.payee = v; i++; }
      else if (a === '--category-id') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--category-id requires a value.' } }; options['category-id'] = v; i++; }
      else if (a === '--transaction-id') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--transaction-id requires a value.' } }; options['transaction-id'] = v; i++; }
      else if (a === '--operation') { const v = nextVal(); if (!v) return { ok: false, error: { code: 'missing_flag_value', message: '--operation requires a value.' } }; options.operation = v; i++; }
      else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: { code: 'trailing_args', message: `Unexpected argument after 'rules create': ${a}` },
        };
      }
    }
    return {
      ok: true,
      cmd: {
        command: 'rules.create',
        format,
        args: normalized,
        options,
      },
    };
  }

  if (cleanArgs[0] === 'rules' && cleanArgs[1] === 'list') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'rules list': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'rules.list',
        format,
        args: normalized,
      },
    };
  }

  if (cleanArgs[0] === 'rules' && cleanArgs[1] === 'show') {
    let ruleId: string | undefined;
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      if (a === '--rule-id') {
        if (!remaining[i + 1] || remaining[i + 1].startsWith('--')) {
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--rule-id requires a value.' },
          };
        }
        ruleId = remaining[i + 1];
        i++;
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: { code: 'trailing_args', message: `Unexpected argument after 'rules show': ${a}` },
        };
      }
    }
    if (!ruleId) {
      return {
        ok: false,
        error: { code: 'missing_rule_id', message: 'rules show requires --rule-id.' },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'rules.show',
        format,
        args: normalized,
        ruleId,
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
  if ((operation === 'remove-connection' || operation === 'delete-data') && mode === 'observe') {
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

      case 'reviews.approve': {
        const envelope = await reviewApproveAnalysis(commandInput, cmd.reviewId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.correct': {
        const envelope = await reviewCorrectAnalysis(commandInput, cmd.reviewId!, cmd.categoryId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.reject': {
        const envelope = await reviewRejectAnalysis(commandInput, cmd.reviewId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.skip': {
        const envelope = await reviewSkipAnalysis(commandInput, cmd.reviewId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.undo': {
        const envelope = await reviewUndoAnalysis(commandInput, cmd.reviewId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.approve-bulk': {
        const envelope = await reviewApproveBulkAnalysis(commandInput, cmd.ids!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'reviews.group': {
        const envelope = await reviewGroupAnalysis(commandInput, cmd.ids!);
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

      case 'delete-data': {
        const callbacks = commandInput.lifecycleCallbacks;
        if (!callbacks) {
          const info = new ErrorInfo({
            code: 'no_lifecycle_callbacks',
            message: 'Delete-data command requires lifecycle callbacks. Not connected?',
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
            message: 'delete-data requires write authorization and is not available in observe mode.',
            retryable: false,
            reasonCodes: ['observe_mode_write_blocked'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
        try {
          const scope = cmd.options?.scope;
          const result = await callbacks.doDeleteData(ledger, scope!);
          const envelope = okResponse(requestId, null, modeAuthorization(mode, actorId, 'delete-data'), result);
          return JSON.stringify(envelope, null, 2);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const info = new ErrorInfo({
            code: 'delete_data_failed',
            message,
            retryable: true,
            reasonCodes: ['delete_data_error'],
          });
          return JSON.stringify(errorResponse(requestId, info), null, 2);
        }
      }

      case 'proposals.create': {
        const proposalOptions: ReviewActionOptions = {};
        if (cmd.options?.['category-id']) proposalOptions.categoryId = cmd.options['category-id'];
        if (cmd.options?.['transaction-id']) proposalOptions.transactionId = cmd.options['transaction-id'];
        if (cmd.options?.message) proposalOptions.message = cmd.options.message;
        if (cmd.options?.reason) proposalOptions.reason = cmd.options.reason;
        if (cmd.options?.operation) proposalOptions.operation = cmd.options.operation;
        const envelope = await proposalCreateAnalysis(commandInput, proposalOptions);
        return JSON.stringify(envelope, null, 2);
      }

      case 'proposals.show': {
        const envelope = await proposalShowAnalysis(commandInput, cmd.proposalId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'proposals.approve': {
        const envelope = await proposalApproveAnalysis(commandInput, cmd.proposalId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'proposals.execute': {
        const envelope = await proposalExecuteAnalysis(commandInput, cmd.proposalId!);
        return JSON.stringify(envelope, null, 2);
      }

      case 'proposals.list': {
        const envelope = await proposalListAnalysis(commandInput);
        return JSON.stringify(envelope, null, 2);
      }

      case 'audit.query': {
        const queryOptions: Record<string, unknown> = {};
        if (cmd.options?.limit) queryOptions.limit = Number(cmd.options.limit);
        if (cmd.options?.offset) queryOptions.offset = Number(cmd.options.offset);
        if (cmd.options?.action) queryOptions.action = cmd.options.action;
        if (cmd.options?.['actor-id']) queryOptions.actorId = cmd.options['actor-id'];
        if (cmd.options?.['entity-id']) queryOptions.entityId = cmd.options['entity-id'];
        const envelope = await auditQueryAnalysis(commandInput, queryOptions as AuditQueryOptions);
        return JSON.stringify(envelope, null, 2);
      }

      case 'rules.create': {
        const ruleOptions: ReviewActionOptions = {};
        if (cmd.options?.['name']) ruleOptions.message = cmd.options['name'];
        if (cmd.options?.['payee']) ruleOptions.reason = cmd.options['payee'];
        if (cmd.options?.['category-id']) ruleOptions.categoryId = cmd.options['category-id'];
        if (cmd.options?.['transaction-id']) ruleOptions.transactionId = cmd.options['transaction-id'];
        if (cmd.options?.operation) ruleOptions.operation = cmd.options.operation;
        const envelope = await ruleCreateAnalysis(commandInput, ruleOptions);
        return JSON.stringify(envelope, null, 2);
      }

      case 'rules.list': {
        const envelope = await ruleListAnalysis(commandInput);
        return JSON.stringify(envelope, null, 2);
      }

      case 'rules.show': {
        if (!cmd.ruleId) {
          const info = new ErrorInfo({
            code: 'missing_rule_id',
            message: 'Rule ID is required. Use --rule-id or pass it as the first argument.',
            retryable: false,
            reasonCodes: ['missing_rule_id'],
          });
          return JSON.stringify(errorResponse(commandInput.requestId ?? 'cli', info), null, 2);
        }
        const envelope = await ruleShowAnalysis(commandInput, cmd.ruleId);
        return JSON.stringify(envelope, null, 2);
      }

      case 'rules.update': {
        const updateOptions: ReviewActionOptions = {};
        if (cmd.options?.['name']) updateOptions.message = cmd.options['name'];
        if (cmd.options?.['active']) updateOptions.reason = cmd.options['active'];
        if (cmd.options?.['category-id']) updateOptions.categoryId = cmd.options['category-id'];
        if (cmd.options?.['rule-id']) updateOptions.message = cmd.options['rule-id'];
        const envelope = await ruleUpdateAnalysis(commandInput, updateOptions);
        return JSON.stringify(envelope, null, 2);
      }

      default:
        throw new Error(`Unhandled command: ${routed.command}`);
    }
  } catch (err) {
    if (err instanceof ApplicationError) {
      const info = new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      });
      const envelope = errorResponse(requestId, info);
      return JSON.stringify(envelope, null, 2);
    }
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
