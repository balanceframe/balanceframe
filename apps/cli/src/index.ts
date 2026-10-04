/**
 * @balanceframe/cli — BalanceFrame CLI tool.
 *
 * Parses CLI commands and sends governed operations to the authenticated
 * BalanceFrame server. Financial and governance authority remains server-side.
 *
 * Usage:
 *   balanceframe transactions pending-review --json
 *   balanceframe reviews show REVIEW_ID --json
 *   balanceframe proposals approve PROPOSAL_ID --payload-hash HASH --json
 *   balanceframe reviews approve-bulk REVIEW_ID... --payload-hashes JSON --json
 *   balanceframe spaces policy set --expected-version VERSION --policy JSON --json
 *   balanceframe export --json
 */

import { ErrorInfo, errorResponse } from '@balanceframe/application/envelope';
import { runServerCommand } from './transport.js';

// ---------------------------------------------------------------------------
// Parsed CLI command
// ---------------------------------------------------------------------------

/** Normalized command and options submitted to the server transport. */
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

/** Result of parsing command-line arguments. */
export type ParseResult =
  { ok: true; cmd: CliCommand } | { ok: false; error: { code: string; message: string } };

type FlagParseResult =
  | { ok: true; options: Record<string, string> }
  | { ok: false; error: { code: string; message: string } };

function readFlagOptions(args: string[], allowed: string[], command: string): FlagParseResult {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const key = token.startsWith('--') ? token.slice(2) : '';
    if (!key || !allowed.includes(key)) {
      return {
        ok: false,
        error: {
          code: 'unknown_flags',
          message: token.startsWith('--') ? `Unknown flag for ${command}: ${token}` : `Unexpected argument for ${command}: ${token}`,
        },
      };
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_flag_value', message: `${token} requires a value.` },
      };
    }
    if (options[key] !== undefined) {
      return {
        ok: false,
        error: { code: 'duplicate_flag', message: `${token} may be supplied only once.` },
      };
    }
    options[key] = value;
    i++;
  }
  return { ok: true, options };
}

function parseFlagCommand(
  command: string,
  format: string,
  normalized: string[],
  args: string[],
  allowed: string[],
  required: string[],
  extraOptions: Record<string, string> = {},
): ParseResult {
  const parsed = readFlagOptions(args, allowed, command);
  if (!parsed.ok) return parsed;
  for (const key of required) {
    if (!parsed.options[key]) {
      return {
        ok: false,
        error: { code: 'missing_flag_value', message: `${command} requires --${key}.` },
      };
    }
  }
  return {
    ok: true,
    cmd: {
      command,
      format,
      args: normalized,
      options: { ...parsed.options, ...extraOptions },
    },
  };
}

function parseSpaceCommand(cleanArgs: string[], normalized: string[], format: string): ParseResult | null {
  if (cleanArgs[0] !== 'spaces') return null;
  const resource = cleanArgs[1];
  const action = cleanArgs[2];
  const rest = cleanArgs.slice(3);
  const noArgs = (command: string, length = 2): ParseResult =>
    cleanArgs.length === length
      ? { ok: true, cmd: { command, format, args: normalized } }
      : {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected arguments after 'spaces ${resource} ${action ?? ''}'.`,
          },
        };
  const positionalId = (
    command: string,
    idKey: string,
    allowed: string[] = [],
    required: string[] = [],
  ): ParseResult => {
    const id = cleanArgs[3];
    if (!id || id.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_id', message: `spaces ${resource} ${action} requires an ID.` },
      };
    }
    const parsed = readFlagOptions(cleanArgs.slice(4), allowed, `spaces ${resource} ${action}`);
    if (!parsed.ok) return parsed;
    for (const key of required) {
      if (!parsed.options[key]) {
        return { ok: false, error: { code: 'missing_flag_value', message: `--${key} is required.` } };
      }
    }
    return {
      ok: true,
      cmd: {
        command,
        format,
        args: normalized,
        options: { ...parsed.options, [idKey]: id },
      },
    };
  };

  if (resource === 'list') return noArgs('spaces.list');
  if (resource === 'create') {
    const result = parseFlagCommand('spaces.create', format, normalized, cleanArgs.slice(2), ['name', 'kind'], ['name', 'kind']);
    if (result.ok && result.cmd.options?.kind !== 'personal' && result.cmd.options?.kind !== 'shared') {
      return { ok: false, error: { code: 'invalid_space_kind', message: '--kind must be personal or shared.' } };
    }
    return result;
  }
  if (resource === 'select') {
    const id = cleanArgs[2];
    if (!id || id.startsWith('--')) {
      return { ok: false, error: { code: 'missing_space_id', message: 'spaces select requires a SPACE_ID.' } };
    }
    return cleanArgs.length === 3
      ? { ok: true, cmd: { command: 'spaces.select', format, args: normalized, options: { spaceId: id } } }
      : { ok: false, error: { code: 'trailing_args', message: 'Unexpected arguments after SPACE_ID.' } };
  }
  if (resource === 'show') return cleanArgs.length === 2
    ? { ok: true, cmd: { command: 'spaces.show', format, args: normalized } }
    : { ok: false, error: { code: 'trailing_args', message: "Use 'spaces show' with BALANCEFRAME_SPACE_ID selected." } };
  if (resource === 'policy' && (action === 'get' || action === 'read')) return noArgs('spaces.policy.get', 3);
  if (resource === 'policy' && action === 'set') {
    return parseFlagCommand(
      'spaces.policy.set',
      format,
      normalized,
      rest,
      ['expected-version', 'policy'],
      ['expected-version', 'policy'],
    );
  }
  if ((resource === 'memberships' || resource === 'members') && (action === 'list' || action === 'history')) {
    return noArgs('spaces.memberships.list', 3);
  }
  if ((resource === 'memberships' || resource === 'members') && (action === 'create' || action === 'add')) {
    return parseFlagCommand(
      'spaces.memberships.create',
      format,
      normalized,
      rest,
      ['member-id', 'valid-from', 'valid-until'],
      ['member-id', 'valid-from'],
    );
  }
  if ((resource === 'memberships' || resource === 'members') && action === 'revoke') {
    return positionalId('spaces.memberships.revoke', 'membershipId');
  }
  if (resource === 'grants' && (action === 'list' || action === 'read')) return noArgs('spaces.grants.list', 3);
  if (resource === 'grants' && action === 'set') {
    const result = parseFlagCommand(
      'spaces.grants.set',
      format,
      normalized,
      rest,
      ['membership-id', 'capability', 'resource-kind', 'resource-id', 'granted', 'restrictions'],
      ['membership-id', 'capability', 'resource-kind', 'resource-id', 'granted'],
    );
    if (result.ok && result.cmd.options?.granted !== 'true' && result.cmd.options?.granted !== 'false') {
      return { ok: false, error: { code: 'invalid_granted', message: '--granted must be true or false.' } };
    }
    return result;
  }
  if (resource === 'grants' && action === 'revoke') {
    return parseFlagCommand(
      'spaces.grants.revoke',
      format,
      normalized,
      rest,
      ['membership-id', 'capability', 'resource-kind', 'resource-id', 'restrictions'],
      ['membership-id', 'capability', 'resource-kind', 'resource-id'],
    );
  }
  if (resource === 'delegations' && action === 'list') return noArgs('spaces.delegations.list', 3);
  if (resource === 'delegations' && action === 'create') {
    return parseFlagCommand(
      'spaces.delegations.create',
      format,
      normalized,
      rest,
      ['agent-id', 'issuer-membership-id', 'expected-version', 'rights', 'valid-from', 'valid-until'],
      ['agent-id', 'issuer-membership-id', 'expected-version', 'rights', 'valid-from'],
    );
  }
  if (resource === 'delegations' && action === 'revoke') {
    return positionalId(
      'spaces.delegations.revoke',
      'delegationId',
      ['expected-version'],
      ['expected-version'],
    );
  }
  if (resource === 'agents' && action === 'register') {
    return parseFlagCommand('spaces.agents.register', format, normalized, rest, ['agent-id'], ['agent-id']);
  }
  if (resource === 'credentials' && action === 'list') return noArgs('spaces.credentials.list', 3);
  if (resource === 'credentials' && action === 'register') {
    const result = parseFlagCommand(
      'spaces.credentials.register',
      format,
      normalized,
      rest,
      ['credential-id', 'principal-type', 'principal-id', 'delegation-id', 'expected-delegation-version'],
      ['credential-id', 'principal-type', 'principal-id'],
    );
    if (result.ok && result.cmd.options?.['principal-type'] !== 'human' && result.cmd.options?.['principal-type'] !== 'agent') {
      return { ok: false, error: { code: 'invalid_principal_type', message: '--principal-type must be human or agent.' } };
    }
    if (
      result.ok &&
      result.cmd.options?.['principal-type'] === 'agent' &&
      (!result.cmd.options['delegation-id'] ||
        !result.cmd.options['expected-delegation-version'] ||
        result.cmd.options['expected-delegation-version'] === 'null')
    ) {
      return {
        ok: false,
        error: {
          code: 'missing_delegation_binding',
          message: 'Agent credentials require an active --delegation-id and --expected-delegation-version.',
        },
      };
    }
    return result;
  }
  if (resource === 'credentials' && action === 'revoke') {
    return positionalId('spaces.credentials.revoke', 'credential-id');
  }
  return {
    ok: false,
    error: { code: 'unknown_command', message: `Unknown spaces command: ${cleanArgs.join(' ')}` },
  };
}

// ---------------------------------------------------------------------------
// Rejected command patterns
// ---------------------------------------------------------------------------

const REJECTED_PATTERNS = ['raw-query', 'invoke-method', 'shell'];

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
  const normalized = argv.filter((a) => a !== '');

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
    '--budget-id': true,
    '--months': true,
    '--start-month': true,
    '--amount': true,
    '--account-id': true,
    '--purchase-at': true,
    '--required-by': true,
    '--currency': true,
    '--report-type': true,
    '--month-range': true,
    '--label': true,
    '--tag': true,
    '--view-type': true,
    '--sort': true,
    '--detailed': true,
    '--category-group': true,
    '--payload-hashes': true,
    '--payload-hash': true,
    '--kind': true,
    '--expected-version': true,
    '--policy': true,
    '--member-id': true,
    '--valid-from': true,
    '--valid-until': true,
    '--membership-id': true,
    '--capability': true,
    '--resource-kind': true,
    '--resource-id': true,
    '--granted': true,
    '--restrictions': true,
    '--agent-id': true,
    '--issuer-membership-id': true,
    '--rights': true,
    '--credential-id': true,
    '--principal-type': true,
    '--principal-id': true,
    '--delegation-id': true,
    '--expected-delegation-version': true,
  };
  const unknownFlags = normalized.filter((a) => a.startsWith('--') && !KNOWN_FLAGS[a]);
  if (unknownFlags.length > 0) {
    return {
      ok: false,
      error: { code: 'unknown_flags', message: `Unknown flags: ${unknownFlags.join(', ')}` },
    };
  }

  const hasJson = normalized.includes('--json');
  const format = hasJson ? 'json' : 'json';
  const cleanArgs = normalized.filter((a) => a !== '--json');

  if (
    cleanArgs.includes('--actor-id') &&
    !(cleanArgs[0] === 'audit' && cleanArgs[1] === 'query')
  ) {
    return {
      ok: false,
      error: {
        code: 'actor_filter_only',
        message: '--actor-id is only an audit query filter; it never selects the caller.',
      },
    };
  }
  const spaceCommand = parseSpaceCommand(cleanArgs, normalized, format);
  if (spaceCommand) return spaceCommand;

  // Extract command path
  if (cleanArgs[0] === 'connect') {
    const budgetIndex = cleanArgs.indexOf('--budget-id');
    const budgetId = budgetIndex >= 0 ? cleanArgs[budgetIndex + 1] : undefined;
    if (!budgetId || budgetId.startsWith('--')) {
      return {
        ok: false,
        error: { code: 'missing_budget_id', message: 'connect requires --budget-id BUDGET_ID.' },
      };
    }
    return {
      ok: true,
      cmd: { command: 'connect', format, args: normalized, options: { budgetId } },
    };
  }

  if (cleanArgs[0] === 'transactions' && cleanArgs[1] === 'pending-review') {
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
        error: {
          code: 'missing_review_id',
          message: 'reviews show requires a REVIEW_ID argument.',
        },
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
        error: {
          code: 'missing_review_id',
          message: 'reviews approve requires a REVIEW_ID argument.',
        },
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
        error: {
          code: 'missing_review_id',
          message: 'reviews correct requires a REVIEW_ID argument.',
        },
      };
    }
    if (!categoryId) {
      return {
        ok: false,
        error: {
          code: 'missing_category_id',
          message:
            'reviews correct requires a CATEGORY_ID argument (provide it positionally or via --category-id).',
        },
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
        error: {
          code: 'missing_review_id',
          message: 'reviews reject requires a REVIEW_ID argument.',
        },
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
        error: {
          code: 'missing_review_id',
          message: 'reviews skip requires a REVIEW_ID argument.',
        },
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
        error: {
          code: 'missing_review_id',
          message: 'reviews undo requires a REVIEW_ID argument.',
        },
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
    const flags: string[] = [];
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const token = remaining[i]!;
      if (token.startsWith('--')) {
        flags.push(token);
        const value = remaining[i + 1];
        if (value && !value.startsWith('--')) {
          flags.push(value);
          i++;
        }
        continue;
      }
      if (!token.startsWith('rev_')) {
        return {
          ok: false,
          error: {
            code: 'invalid_review_id',
            message: `Invalid review ID: "${token}". Review IDs must start with "rev_".`,
          },
        };
      }
      ids.push(token);
    }
    if (ids.length < 1) {
      return {
        ok: false,
        error: { code: 'missing_review_ids', message: 'reviews approve-bulk requires at least one REVIEW_ID.' },
      };
    }
    if (new Set(ids).size !== ids.length) {
      return {
        ok: false,
        error: { code: 'duplicate_review_id', message: 'reviews approve-bulk requires unique REVIEW_ID values.' },
      };
    }
    const parsedFlags = readFlagOptions(flags, ['payload-hashes'], 'reviews approve-bulk');
    if (!parsedFlags.ok) return parsedFlags;
    const source = parsedFlags.options['payload-hashes'];
    if (!source) {
      return {
        ok: false,
        error: { code: 'payload_hashes_required', message: 'reviews approve-bulk requires --payload-hashes JSON.' },
      };
    }
    let hashMap: unknown;
    try {
      hashMap = JSON.parse(source);
    } catch {
      hashMap = null;
    }
    if (
      hashMap === null ||
      typeof hashMap !== 'object' ||
      Array.isArray(hashMap) ||
      Object.keys(hashMap).length !== ids.length ||
      ids.some((id) => typeof (hashMap as Record<string, unknown>)[id] !== 'string' ||
        (hashMap as Record<string, string>)[id]!.length === 0)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid_payload_hashes',
          message: '--payload-hashes must be an object with one non-empty displayed hash for each REVIEW_ID.',
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'reviews.approve-bulk',
        format,
        args: normalized,
        ids,
        options: { 'payload-hashes': source },
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
          error: {
            code: 'invalid_review_id',
            message: `Invalid review ID: "${a}". Review IDs must start with "rev_".`,
          },
        };
      }
      ids.push(a);
    }
    if (ids.length < 1) {
      return {
        ok: false,
        error: {
          code: 'missing_review_ids',
          message: 'reviews group requires at least one REVIEW_ID.',
        },
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

  if (cleanArgs[0] === 'budget' && cleanArgs[1] === 'list') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'budget list': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return {
      ok: true,
      cmd: {
        command: 'budget.list',
        format,
        args: normalized,
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
        error: {
          code: 'invalid_scope',
          message: `Invalid scope "${scopeValue}". Must be one of: connection, space, user, provider, workflow, notification.`,
        },
      };
    }
    // Check for unexpected extra arguments
    const cleanWithoutScope = cleanArgs.filter((_, i) => i !== scopeIndex && i !== scopeIndex + 1);
    if (cleanWithoutScope.length > 1) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'delete-data': ${cleanWithoutScope.slice(1).join(' ')}`,
        },
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
      if (a === '--category-id') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--category-id requires a value.' },
          };
        options['category-id'] = v;
        i++;
      } else if (a === '--transaction-id') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--transaction-id requires a value.' },
          };
        options['transaction-id'] = v;
        i++;
      } else if (a === '--message') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--message requires a value.' },
          };
        options.message = v;
        i++;
      } else if (a === '--reason') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--reason requires a value.' },
          };
        options.reason = v;
        i++;
      } else if (a === '--operation') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--operation requires a value.' },
          };
        options.operation = v;
        i++;
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'proposals create': ${a}`,
          },
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
        error: {
          code: 'missing_proposal_id',
          message: 'proposals show requires a PROPOSAL_ID argument.',
        },
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
        error: {
          code: 'missing_proposal_id',
          message: 'proposals approve requires a PROPOSAL_ID argument.',
        },
      };
    }
    const hashOptions = readFlagOptions(
      cleanArgs.slice(3),
      ['payload-hash'],
      'proposals approve',
    );
    if (!hashOptions.ok) return hashOptions;
    const payloadHash = hashOptions.options['payload-hash'];
    if (!payloadHash) {
      return {
        ok: false,
        error: {
          code: 'payload_hash_required',
          message: 'proposals approve requires the exact displayed --payload-hash.',
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
        options: { 'payload-hash': payloadHash },
      },
    };
  }

  if (cleanArgs[0] === 'proposals' && cleanArgs[1] === 'execute') {
    const proposalId = cleanArgs[2];
    if (!proposalId || proposalId.startsWith('--')) {
      return {
        ok: false,
        error: {
          code: 'missing_proposal_id',
          message: 'proposals execute requires a PROPOSAL_ID argument.',
        },
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
      if (a === '--limit') {
        const v = nextVal();
        if (v !== undefined) {
          options.limit = v;
          i++;
        }
      } else if (a === '--offset') {
        const v = nextVal();
        if (v !== undefined) {
          options.offset = v;
          i++;
        }
      } else if (a === '--actor-id') {
        const v = nextVal();
        if (v !== undefined) {
          options['actor-id'] = v;
          i++;
        }
      } else if (a === '--entity-id') {
        const v = nextVal();
        if (v !== undefined) {
          options['entity-id'] = v;
          i++;
        }
      } else if (a === '--action') {
        const v = nextVal();
        if (v !== undefined) {
          options.action = v;
          i++;
        }
      } else if (a === '--from') {
        const v = nextVal();
        if (v !== undefined) {
          options.from = v;
          i++;
        }
      } else if (a === '--to') {
        const v = nextVal();
        if (v !== undefined) {
          options.to = v;
          i++;
        }
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'audit query': ${a}`,
          },
        };
      }
    }
    // Validate numeric arguments
    if (options.limit !== undefined) {
      const n = Number(options.limit);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return {
          ok: false,
          error: {
            code: 'invalid_limit',
            message: `--limit must be a finite non-negative integer, got "${options.limit}"`,
          },
        };
      }
    }
    if (options.offset !== undefined) {
      const n = Number(options.offset);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return {
          ok: false,
          error: {
            code: 'invalid_offset',
            message: `--offset must be a finite non-negative integer, got "${options.offset}"`,
          },
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
      if (a === '--name') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--name requires a value.' },
          };
        options.name = v;
        i++;
      } else if (a === '--payee') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--payee requires a value.' },
          };
        options.payee = v;
        i++;
      } else if (a === '--category-id') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--category-id requires a value.' },
          };
        options['category-id'] = v;
        i++;
      } else if (a === '--transaction-id') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--transaction-id requires a value.' },
          };
        options['transaction-id'] = v;
        i++;
      } else if (a === '--operation') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--operation requires a value.' },
          };
        options.operation = v;
        i++;
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'rules create': ${a}`,
          },
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

  // -----------------------------------------------------------------------
  // Budget Intelligence commands
  // -----------------------------------------------------------------------

  // purchase evaluate --category-id CAT --amount AMT [--account-id ACC] [--currency CUR]
  if (cleanArgs[0] === 'purchase' && cleanArgs[1] === 'evaluate') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--category-id') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_category_value', message: '--category-id requires a value.' },
          };
        options['category-id'] = v;
        i++;
      } else if (a === '--amount') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--amount requires a value.' },
          };
        options.amount = v;
        i++;
      } else if (a === '--account-id') {
        const v = nextVal();
        if (v !== undefined) {
          options['account-id'] = v;
          i++;
        }
      } else if (a === '--currency') {
        const v = nextVal();
        if (v !== undefined) {
          options.currency = v;
          i++;
        }
      } else if (a === '--purchase-at' || a === '--required-by') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: `${a} requires a UTC timestamp.` },
          };
        options[a.slice(2)] = v;
        i++;
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'purchase evaluate': ${a}`,
          },
        };
      }
    }
    // Validate required params
    if (!options['category-id']) {
      return {
        ok: false,
        error: {
          code: 'missing_category_value',
          message: '--category-id is required for purchase evaluate.',
        },
      };
    }
    if (!options.amount) {
      return {
        ok: false,
        error: {
          code: 'missing_flag_value',
          message: '--amount is required for purchase evaluate.',
        },
      };
    }
    return { ok: true, cmd: { command: 'purchase.evaluate', format, args: normalized, options } };
  }

  // cash-flow project [--months N] [--start-month YYYY-MM]
  if (cleanArgs[0] === 'cash-flow' && cleanArgs[1] === 'project') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--months') {
        const v = nextVal();
        if (v !== undefined) {
          options.months = v;
          i++;
        }
      } else if (a === '--start-month') {
        const v = nextVal();
        if (v !== undefined) {
          options['start-month'] = v;
          i++;
        }
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'cash-flow project': ${a}`,
          },
        };
      }
    }
    return { ok: true, cmd: { command: 'cash-flow.project', format, args: normalized, options } };
  }

  // target health
  if (cleanArgs[0] === 'target' && cleanArgs[1] === 'health') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'target health': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return { ok: true, cmd: { command: 'target.health', format, args: normalized } };
  }

  // sinking-fund health
  if (cleanArgs[0] === 'sinking-fund' && cleanArgs[1] === 'health') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'sinking-fund health': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return { ok: true, cmd: { command: 'sinking-fund.health', format, args: normalized } };
  }

  // reports generate --report-type TYPE --month-range RANGE [--label LABEL] [--tag TAG]
  if (cleanArgs[0] === 'reports' && cleanArgs[1] === 'generate') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--report-type') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--report-type requires a value.' },
          };
        options['report-type'] = v;
        i++;
      } else if (a === '--month-range') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--month-range requires a value.' },
          };
        options['month-range'] = v;
        i++;
      } else if (a === '--label') {
        const v = nextVal();
        if (v !== undefined) {
          options.label = v;
          i++;
        }
      } else if (a === '--tag') {
        const v = nextVal();
        if (v !== undefined) {
          options['tag'] = v;
          i++;
        }
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'reports generate': ${a}`,
          },
        };
      }
    }
    // Validate required params
    if (!options['report-type']) {
      return {
        ok: false,
        error: {
          code: 'missing_flag_value',
          message: '--report-type is required for reports generate.',
        },
      };
    }
    if (!options['month-range']) {
      return {
        ok: false,
        error: {
          code: 'missing_flag_value',
          message: '--month-range is required for reports generate.',
        },
      };
    }
    return { ok: true, cmd: { command: 'reports.generate', format, args: normalized, options } };
  }

  // views list
  if (cleanArgs[0] === 'views' && cleanArgs[1] === 'list') {
    if (cleanArgs.length > 2) {
      return {
        ok: false,
        error: {
          code: 'trailing_args',
          message: `Unexpected arguments after 'views list': ${cleanArgs.slice(2).join(' ')}`,
        },
      };
    }
    return { ok: true, cmd: { command: 'views.list', format, args: normalized } };
  }

  // views create --name NAME --view-type TYPE [--scope JSON]
  if (cleanArgs[0] === 'views' && cleanArgs[1] === 'create') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--name') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--name requires a value.' },
          };
        options.name = v;
        i++;
      } else if (a === '--view-type') {
        const v = nextVal();
        if (!v)
          return {
            ok: false,
            error: { code: 'missing_flag_value', message: '--view-type requires a value.' },
          };
        options['view-type'] = v;
        i++;
      } else if (a === '--scope') {
        const v = nextVal();
        if (v !== undefined) {
          options.scope = v;
          i++;
        }
      } else if (a === '--sort') {
        const v = nextVal();
        if (v !== undefined) {
          options.sort = v;
          i++;
        }
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'views create': ${a}`,
          },
        };
      }
    }
    if (!options.name) {
      return {
        ok: false,
        error: { code: 'missing_flag_value', message: '--name is required for views create.' },
      };
    }
    if (!options['view-type']) {
      return {
        ok: false,
        error: { code: 'missing_flag_value', message: '--view-type is required for views create.' },
      };
    }
    return { ok: true, cmd: { command: 'views.create', format, args: normalized, options } };
  }

  // home attention [--detailed] [--category-group GROUP]
  if (cleanArgs[0] === 'home' && cleanArgs[1] === 'attention') {
    const options: Record<string, string> = {};
    const remaining = cleanArgs.slice(2);
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      const nextVal = (): string | undefined =>
        remaining[i + 1] && !remaining[i + 1].startsWith('--') ? remaining[i + 1] : undefined;
      if (a === '--detailed') {
        options.detailed = 'true';
      } else if (a === '--category-group') {
        const v = nextVal();
        if (v !== undefined) {
          options['category-group'] = v;
          i++;
        }
      } else if (!a.startsWith('--')) {
        return {
          ok: false,
          error: {
            code: 'trailing_args',
            message: `Unexpected argument after 'home attention': ${a}`,
          },
        };
      }
    }
    return { ok: true, cmd: { command: 'home.attention', format, args: normalized, options } };
  }

  return {
    ok: false,
    error: {
      code: 'unknown_command',
      message: `Unknown command: ${normalized.join(' ')}`,
    },
  };
}
/**
 * Execute a parsed CLI command against the authenticated server.
 *
 * @param argv CLI argument vector excluding the node executable and binary.
 */
export async function main(argv: string[]): Promise<string> {
  const requestId = `req_${Date.now().toString(36)}`;
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
  return runServerCommand(parsed.cmd, requestId);
}
