import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DecisionContext,
  FinancialSnapshot,
  ProspectiveClaim,
  ProspectiveDecisionEnvelope,
  PurchaseEvaluation,
} from '@balanceframe/protocol-generated';
import { describe, it, expect } from 'vitest';
import { parseArgs, main, CliCommand, ParseResult } from '../src/index';

type FinancialDecisionFixture = {
  full: FinancialSnapshot;
  claims: {
    context: DecisionContext;
    items: ProspectiveClaim[];
  };
  decisions: {
    blocked: ProspectiveDecisionEnvelope<PurchaseEvaluation>;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINANCIAL_DECISION_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../protocol/fixtures/financial-decision-foundation.json'),
    'utf8',
  ),
) as FinancialDecisionFixture;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses transactions pending-review --json', () => {
    const result = parseArgs(['transactions', 'pending-review', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('transactions.pending-review');
    expect(result.cmd.format).toBe('json');
    expect(result.cmd.args).toEqual(['transactions', 'pending-review', '--json']);
  });

  it('parses reviews show REVIEW_ID --json', () => {
    const result = parseArgs(['reviews', 'show', 'rev_abc123', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.show');
    expect(result.cmd.reviewId).toBe('rev_abc123');
    expect(result.cmd.format).toBe('json');
  });

  it('parses budget summary --json', () => {
    const result = parseArgs(['budget', 'summary', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('budget.summary');
    expect(result.cmd.format).toBe('json');
  });

  it('parses budget list --json', () => {
    const result = parseArgs(['budget', 'list', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('budget.list');
  });

  it('parses export --json', () => {
    const result = parseArgs(['export', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('export');
    expect(result.cmd.format).toBe('json');
  });

  it('parses disconnect', () => {
    const result = parseArgs(['disconnect']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('disconnect');
  });

  it('parses remove-connection', () => {
    const result = parseArgs(['remove-connection']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('remove-connection');
  });
});

// ---------------------------------------------------------------------------
// CLI rejects dangerous commands — stable error envelopes, no throws
// ---------------------------------------------------------------------------

describe('parseArgs — rejection', () => {
  it('rejects raw-query', () => {
    const result = parseArgs(['raw-query', 'SELECT * FROM transactions']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rejected_command');
  });

  it('rejects invoke-method', () => {
    const result = parseArgs(['invoke-method', 'createTransaction']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rejected_command');
  });

  it('rejects shell', () => {
    const result = parseArgs(['shell']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rejected_command');
  });
});

// ---------------------------------------------------------------------------
// Reject trailing positional arguments and unknown flags
// ---------------------------------------------------------------------------

describe('parseArgs — arity', () => {
  it('rejects trailing args after transactions pending-review', () => {
    const result = parseArgs(['transactions', 'pending-review', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after reviews show REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'show', 'rev_abc', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after budget summary', () => {
    const result = parseArgs(['budget', 'summary', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after export', () => {
    const result = parseArgs(['export', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after disconnect', () => {
    const result = parseArgs(['disconnect', 'extra']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after remove-connection', () => {
    const result = parseArgs(['remove-connection', 'extra']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });
});

describe('parseArgs — unknown flags', () => {
  it('rejects --unknown flag', () => {
    const result = parseArgs(['transactions', 'pending-review', '--unknown']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_flags');
  });

  it('rejects --verbose flag', () => {
    const result = parseArgs(['export', '--verbose']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_flags');
  });

  it('allows --json alongside commands', () => {
    const result = parseArgs(['transactions', 'pending-review', '--json']);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI output format
// ---------------------------------------------------------------------------

describe('CliCommand — output semantics', () => {
  it('defaults format to json when --json is present', () => {
    const result = parseArgs(['transactions', 'pending-review', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.format).toBe('json');
  });

  it('provides reviewId for reviews show', () => {
    const result = parseArgs(['reviews', 'show', 'rev_xyz', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.reviewId).toBe('rev_xyz');
  });

  it('reviewId is undefined for non-review commands', () => {
    const result = parseArgs(['budget', 'summary', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.reviewId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Executable routing — main() produces a JSON envelope for valid commands
// ---------------------------------------------------------------------------

describe('main — executable routing', () => {
  it('returns a JSON envelope for a valid command', async () => {
    const result = await main(['transactions', 'pending-review', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_route',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: {
        async pendingReview() {
          return {
            uncategorizedCount: 0,
            totalUncategorizedAmount: { minorUnits: '0', currency: 'USD' },
            candidates: [],
            oldestUncategorizedDate: null,
            healthState: 'unknown',
            blockers: [],
          };
        },
        async reviewShow() {
          return {
            reviewId: '',
            generatedAt: '',
            status: 'not_found',
            description: '',
            totalAmount: { minorUnits: '0', currency: 'USD' },
            itemCount: 0,
            items: [],
          };
        },
        async budgetSummary() {
          return {
            month: '',
            totalBudgeted: { minorUnits: '0', currency: 'USD' },
            totalSpent: { minorUnits: '0', currency: 'USD' },
            totalRemaining: { minorUnits: '0', currency: 'USD' },
            categories: [],
          };
        },
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_route');
    expect(parsed.status).toBe('ok');
  });
  it('returns error envelope for rejected command', async () => {
    const result = await main(['raw-query', 'SELECT 1'], {
      actorId: 'usr_test',
      requestId: 'req_err',
      mode: 'observe',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('rejected_command');
  });

  it('returns error envelope for unknown command', async () => {
    const result = await main(['nonexistent'], {
      actorId: 'usr_test',
      requestId: 'req_unk',
      mode: 'observe',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('unknown_command');
  });
});

// ---------------------------------------------------------------------------
// Proposal command parsing
// ---------------------------------------------------------------------------

describe('parseArgs — proposal commands', () => {
  it('parses proposals create --category-id CAT --transaction-id TXN --json', () => {
    const result = parseArgs([
      'proposals',
      'create',
      '--category-id',
      'cat-food',
      '--transaction-id',
      'txn-001',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.create');
    expect(result.cmd.format).toBe('json');
  });

  it('parses proposals create flags into options', () => {
    const result = parseArgs([
      'proposals',
      'create',
      '--category-id',
      'cat-food',
      '--transaction-id',
      'txn-001',
      '--message',
      'test proposal',
      '--reason',
      'monthly',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.create');
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!['category-id']).toBe('cat-food');
    expect(result.cmd.options!['transaction-id']).toBe('txn-001');
    expect(result.cmd.options!.message).toBe('test proposal');
    expect(result.cmd.options!.reason).toBe('monthly');
  });

  it('parses proposals create with --operation flag', () => {
    const result = parseArgs(['proposals', 'create', '--operation', 'set_category', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.operation).toBe('set_category');
  });

  it('parses proposals show PROPOSAL_ID --json', () => {
    const result = parseArgs(['proposals', 'show', 'prop_abc123', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.show');
    expect(result.cmd.proposalId).toBe('prop_abc123');
  });

  it('parses proposals approve PROPOSAL_ID --json', () => {
    const result = parseArgs(['proposals', 'approve', 'prop_abc123', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.approve');
    expect(result.cmd.proposalId).toBe('prop_abc123');
  });

  it('parses proposals execute PROPOSAL_ID --json', () => {
    const result = parseArgs(['proposals', 'execute', 'prop_abc123', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.execute');
    expect(result.cmd.proposalId).toBe('prop_abc123');
  });

  it('parses proposals list --json', () => {
    const result = parseArgs(['proposals', 'list', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.list');
    expect(result.cmd.format).toBe('json');
  });
});

// ---------------------------------------------------------------------------
// Audit command parsing
// ---------------------------------------------------------------------------

describe('parseArgs — audit command', () => {
  it('parses audit query --json', () => {
    const result = parseArgs(['audit', 'query', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('audit.query');
    expect(result.cmd.format).toBe('json');
  });

  it('parses audit query with flags --json', () => {
    const result = parseArgs([
      'audit',
      'query',
      '--limit',
      '10',
      '--actor-id',
      'usr_abc',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('audit.query');
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!['limit']).toBe('10');
    expect(result.cmd.options!['actor-id']).toBe('usr_abc');
  });

  it('rejects audit query with negative --limit', () => {
    const result = parseArgs(['audit', 'query', '--limit', '-5', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_limit');
  });

  it('rejects audit query with non-numeric --limit', () => {
    const result = parseArgs(['audit', 'query', '--limit', 'abc', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_limit');
  });

  it('rejects audit query with negative --offset', () => {
    const result = parseArgs([
      'audit',
      'query',
      '--offset',
      '-1',
      '--actor-id',
      'usr_abc',
      '--json',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_offset');
  });

  it('rejects audit query with trailing positional args', () => {
    const result = parseArgs(['audit', 'query', '--actor-id', 'usr_abc', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('parses audit query with valid --limit and --offset', () => {
    const result = parseArgs([
      'audit',
      'query',
      '--limit',
      '50',
      '--offset',
      '10',
      '--actor-id',
      'usr_abc',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.limit).toBe('50');
    expect(result.cmd.options!.offset).toBe('10');
    expect(result.cmd.options!['actor-id']).toBe('usr_abc');
  });

  it('parses audit query with --entity-id', () => {
    const result = parseArgs(['audit', 'query', '--entity-id', 'txn_001', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!['entity-id']).toBe('txn_001');
  });

  it('rejects audit without subcommand', () => {
    const result = parseArgs(['audit']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_command');
  });

  it('rejects audit unknown subcommand', () => {
    const result = parseArgs(['audit', 'list']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_command');
  });

  it('parses audit query --limit with exponent notation (1e1)', () => {
    const result = parseArgs(['audit', 'query', '--limit', '1e1', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.limit).toBe('1e1');
  });

  it('parses audit query --offset with hex notation (0xA)', () => {
    const result = parseArgs([
      'audit',
      'query',
      '--offset',
      '0xA',
      '--actor-id',
      'usr_test',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.offset).toBe('0xA');
  });

  it('parses audit query --limit 0x10 (hex)', () => {
    const result = parseArgs(['audit', 'query', '--limit', '0x10', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.limit).toBe('0x10');
  });

  it('rejects audit query --limit decimal (1.5)', () => {
    const result = parseArgs(['audit', 'query', '--limit', '1.5', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_limit');
  });

  it('rejects audit query --offset decimal (3.14)', () => {
    const result = parseArgs([
      'audit',
      'query',
      '--offset',
      '3.14',
      '--actor-id',
      'usr_test',
      '--json',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_offset');
  });
});

// ---------------------------------------------------------------------------
// Proposal argument arity and errors
// ---------------------------------------------------------------------------

describe('parseArgs — proposal arity', () => {
  it('rejects proposals show without PROPOSAL_ID', () => {
    const result = parseArgs(['proposals', 'show', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_proposal_id');
  });

  it('rejects proposals approve without PROPOSAL_ID', () => {
    const result = parseArgs(['proposals', 'approve', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_proposal_id');
  });

  it('rejects proposals execute without PROPOSAL_ID', () => {
    const result = parseArgs(['proposals', 'execute', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_proposal_id');
  });

  it('rejects trailing args after proposals show PROPOSAL_ID', () => {
    const result = parseArgs(['proposals', 'show', 'prop_abc', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after proposals list', () => {
    const result = parseArgs(['proposals', 'list', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects unknown proposals subcommand', () => {
    const result = parseArgs(['proposals', 'delete', 'prop_abc', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_command');
  });

  it('rejects proposals create with trailing positional argument', () => {
    const result = parseArgs([
      'proposals',
      'create',
      '--category-id',
      'cat-food',
      'extra',
      '--json',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects proposals create with missing flag value', () => {
    const result = parseArgs(['proposals', 'create', '--category-id', '--json']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing_flag_value');
    }
  });
});

// ---------------------------------------------------------------------------
// Executable routing — main() produces a JSON envelope for proposal/audit
// ---------------------------------------------------------------------------

describe('main — proposal and audit routing', () => {
  const mockAnalysisProtocol = {
    async pendingReview() {
      return {
        uncategorizedCount: 0,
        totalUncategorizedAmount: { minorUnits: '0', currency: 'USD' },
        candidates: [],
        oldestUncategorizedDate: null,
        healthState: 'unknown',
        blockers: [],
      };
    },
    async reviewShow() {
      return {
        reviewId: '',
        generatedAt: '',
        status: 'not_found',
        description: '',
        totalAmount: { minorUnits: '0', currency: 'USD' },
        itemCount: 0,
        items: [],
      };
    },
    async budgetSummary() {
      return {
        month: '',
        totalBudgeted: { minorUnits: '0', currency: 'USD' },
        totalSpent: { minorUnits: '0', currency: 'USD' },
        totalRemaining: { minorUnits: '0', currency: 'USD' },
        categories: [],
      };
    },
    async proposalCreate() {
      return { proposalId: 'prop_new', status: 'pending', createdAt: '2026-07-20T00:00:00Z' };
    },
    async proposalShow() {
      return {
        proposalId: 'prop_abc',
        status: 'pending',
        createdAt: '2026-07-20T00:00:00Z',
        description: 'test',
        proposer: 'usr_test',
        totalAmount: { minorUnits: '0', currency: 'USD' },
        itemCount: 0,
        items: [],
      };
    },
    async proposalApprove() {
      return {
        proposalId: 'prop_abc',
        action: 'approved',
        fromStatus: 'pending',
        toStatus: 'approved',
        timestamp: '2026-07-20T00:00:00Z',
      };
    },
    async proposalExecute() {
      return {
        proposalId: 'prop_abc',
        action: 'executed',
        fromStatus: 'approved',
        toStatus: 'executed',
        timestamp: '2026-07-20T00:00:00Z',
      };
    },
    async proposalList() {
      return { proposals: [], total: 0 };
    },
    async auditQuery() {
      return { entries: [], total: 0 };
    },
  };

  it('routes proposals list and returns json envelope', async () => {
    const result = await main(['proposals', 'list', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_prop_list',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_prop_list');
    expect(parsed.status).toBe('ok');
  });

  it('routes proposals show and returns json envelope', async () => {
    const result = await main(['proposals', 'show', 'prop_abc', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_prop_show',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_prop_show');
    expect(parsed.status).toBe('ok');
  });

  it('routes audit query and returns json envelope', async () => {
    const result = await main(['audit', 'query', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_audit',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_audit');
    expect(parsed.status).toBe('ok');
  });

  it('routes audit query with exponent/hex limit and offset and forwards as numbers', async () => {
    const capturedOptions: unknown[] = [];
    const result = await main(['audit', 'query', '--limit', '1e1', '--offset', '0xA', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_audit_num',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: {
        ...mockAnalysisProtocol,
        async auditQuery(_ledger, opts) {
          capturedOptions.push(opts);
          return { entries: [], total: 0 };
        },
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(capturedOptions).toHaveLength(1);
    const opts = capturedOptions[0] as Record<string, unknown>;
    expect(opts.limit).toBe(10);
    expect(opts.offset).toBe(10);
  });

  it('routes proposals create and forwards options to analysis', async () => {
    const capturedOptions: unknown[] = [];
    const result = await main(
      [
        'proposals',
        'create',
        '--category-id',
        'cat-food',
        '--transaction-id',
        'txn-001',
        '--message',
        'test',
        '--json',
      ],
      {
        actorId: 'usr_test',
        requestId: 'req_create_fwd',
        mode: 'reviewAndApply',
        ledger: { mockLedger: true },
        analysisProtocol: {
          ...mockAnalysisProtocol,
          async proposalCreate(_ledger, opts) {
            capturedOptions.push(opts);
            return { proposalId: 'prop_new', status: 'pending', createdAt: '2026-07-20T00:00:00Z' };
          },
        },
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.proposalId).toBe('prop_new');
    expect(capturedOptions).toHaveLength(1);
    const opts = capturedOptions[0] as Record<string, unknown>;
    expect(opts.categoryId).toBe('cat-food');
    expect(opts.transactionId).toBe('txn-001');
    expect(opts.message).toBe('test');
    expect(opts.actorId).toBe('usr_test');
  });

  it('rejects proposals create in observe mode', async () => {
    const result = await main(['proposals', 'create', '--category-id', 'cat-food', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_create_obs',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: {
        ...mockAnalysisProtocol,
        async proposalCreate() {
          return { proposalId: 'prop_new', status: 'pending', createdAt: '2026-07-20T00:00:00Z' };
        },
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('write_rejected');
    expect(parsed.requestId).toBe('req_create_obs');
  });

  it('rejects proposals approve in observe mode', async () => {
    const result = await main(['proposals', 'approve', 'prop_abc', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_appr_obs',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('write_rejected');
  });

  it('rejects proposals execute in observe mode', async () => {
    const result = await main(['proposals', 'execute', 'prop_abc', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_exec_obs',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('write_rejected');
  });
});

// ---------------------------------------------------------------------------
// Rule command parsing
// ---------------------------------------------------------------------------

describe('parseArgs — rule commands', () => {
  it('parses rules.list correctly', () => {
    const result = parseArgs(['rules', 'list']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('rules.list');
    expect(result.cmd.format).toBe('json');
  });

  it('parses rules.create with options', () => {
    const result = parseArgs([
      'rules',
      'create',
      '--name',
      'My Rule',
      '--payee',
      'Amazon',
      '--category-id',
      'cat-food',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('rules.create');
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!['name']).toBe('My Rule');
    expect(result.cmd.options!['payee']).toBe('Amazon');
    expect(result.cmd.options!['category-id']).toBe('cat-food');
  });

  it('parses rules.create with all options', () => {
    const result = parseArgs([
      'rules',
      'create',
      '--name',
      'My Rule',
      '--payee',
      'Amazon',
      '--category-id',
      'cat-food',
      '--transaction-id',
      'txn-001',
      '--operation',
      'categorize',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('rules.create');
    expect(result.cmd.options!['name']).toBe('My Rule');
    expect(result.cmd.options!['payee']).toBe('Amazon');
    expect(result.cmd.options!['category-id']).toBe('cat-food');
    expect(result.cmd.options!['transaction-id']).toBe('txn-001');
    expect(result.cmd.options!['operation']).toBe('categorize');
  });

  it('parses rules.show with ruleId flag', () => {
    const result = parseArgs(['rules', 'show', '--rule-id', 'rule_abc']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('rules.show');
    expect(result.cmd.ruleId).toBe('rule_abc');
  });

  it('rejects rules.show without ruleId', () => {
    const result = parseArgs(['rules', 'show']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_rule_id');
  });
});

// ---------------------------------------------------------------------------
// Executable routing — main() produces a JSON envelope for rule commands
// ---------------------------------------------------------------------------

describe('main — rule routing', () => {
  const mockRuleProtocol = {
    async ruleCreate() {
      return {
        ruleId: 'rule_new',
        name: 'My Rule',
        status: 'pending',
        createdAt: '2026-07-20T00:00:00Z',
        correlationId: 'corr_001',
      };
    },
    async ruleList() {
      return { items: [] };
    },
    async ruleShow() {
      return {
        id: 'rule_abc',
        name: 'Test Rule',
        order: 1,
        trigger: {},
        actions: {},
        inactive: false,
      };
    },
  };

  const rulesCreateLedger = { mockLedger: true, listRules: async () => [] };
  const rulesListLedger = { mockLedger: true, listRules: async () => [] };
  const rulesShowLedger = {
    mockLedger: true,
    listRules: async () => [
      { id: 'rule_abc', name: 'Test Rule', order: 1, trigger: {}, actions: {}, inactive: false },
    ],
  };

  it('routes rules.create and returns ok envelope', async () => {
    const capturedOptions: unknown[] = [];
    const result = await main(
      ['rules', 'create', '--name', 'My Rule', '--payee', 'Amazon', '--json'],
      {
        actorId: 'usr_test',
        requestId: 'req_rule_create',
        mode: 'reviewAndApply',
        ledger: rulesCreateLedger,
        analysisProtocol: {
          ...mockRuleProtocol,
          async ruleCreate(_ledger: unknown, opts: unknown) {
            capturedOptions.push(opts);
            return {
              ruleId: 'rule_new',
              name: 'My Rule',
              status: 'pending',
              createdAt: '2026-07-20T00:00:00Z',
              correlationId: 'corr_001',
            };
          },
        },
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_rule_create');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.ruleId).toBe('rule_new');
    expect(capturedOptions).toHaveLength(1);
    const opts = capturedOptions[0] as Record<string, unknown>;
    expect(opts.message).toBe('My Rule');
    expect(opts.reason).toBe('Amazon');
  });

  it('routes rules.list and returns list envelope', async () => {
    const result = await main(['rules', 'list', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_rule_list',
      mode: 'observe',
      ledger: rulesListLedger,
      analysisProtocol: mockRuleProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_rule_list');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.items).toEqual([]);
  });

  it('routes rules.show and forwards ruleId', async () => {
    const result = await main(['rules', 'show', '--rule-id', 'rule_abc', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_rule_show',
      mode: 'observe',
      ledger: rulesShowLedger,
      analysisProtocol: mockRuleProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_rule_show');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.id).toBe('rule_abc');
  });

  it('rejects rules.show missing ruleId', async () => {
    const result = await main(['rules', 'show', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_rule_show_missing',
      mode: 'observe',
      ledger: rulesListLedger,
      analysisProtocol: mockRuleProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('missing_rule_id');
  });
});

// ---------------------------------------------------------------------------
// Composition integration — main() produces dispatch without manual opts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Budget Intelligence command parsing
// ---------------------------------------------------------------------------

describe('parseArgs — purchase evaluate', () => {
  it('parses purchase evaluate --category-id CAT --amount AMT --json', () => {
    const result = parseArgs([
      'purchase',
      'evaluate',
      '--category-id',
      'cat-food',
      '--amount',
      '5000',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('purchase.evaluate');
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!['category-id']).toBe('cat-food');
    expect(result.cmd.options!.amount).toBe('5000');
  });

  it('parses purchase evaluate with --account-id and --currency', () => {
    const result = parseArgs([
      'purchase',
      'evaluate',
      '--category-id',
      'cat-food',
      '--amount',
      '5000',
      '--account-id',
      'acc_checking',
      '--currency',
      'EUR',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!['account-id']).toBe('acc_checking');
    expect(result.cmd.options!.currency).toBe('EUR');
  });

  it('rejects purchase evaluate without --category-id', () => {
    const result = parseArgs(['purchase', 'evaluate', '--amount', '5000', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_category_value');
  });

  it('rejects purchase evaluate without --amount', () => {
    const result = parseArgs(['purchase', 'evaluate', '--category-id', 'cat-food', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_flag_value');
  });

  it('rejects purchase evaluate with trailing positional args', () => {
    const result = parseArgs([
      'purchase',
      'evaluate',
      '--category-id',
      'cat-food',
      '--amount',
      '5000',
      'extra',
      '--json',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });
});

describe('parseArgs — cash-flow project', () => {
  it('parses cash-flow project --json (default options)', () => {
    const result = parseArgs(['cash-flow', 'project', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('cash-flow.project');
  });

  it('parses cash-flow project --months 6 --start-month 2026-01 --json', () => {
    const result = parseArgs([
      'cash-flow',
      'project',
      '--months',
      '6',
      '--start-month',
      '2026-01',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!.months).toBe('6');
    expect(result.cmd.options!['start-month']).toBe('2026-01');
  });

  it('rejects cash-flow project with trailing positional args', () => {
    const result = parseArgs(['cash-flow', 'project', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });
});

describe('parseArgs — target health', () => {
  it('parses target health --json', () => {
    const result = parseArgs(['target', 'health', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('target.health');
  });

  it('rejects trailing args after target health', () => {
    const result = parseArgs(['target', 'health', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects unknown subcommand under target', () => {
    const result = parseArgs(['target', 'list', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_command');
  });
});

describe('parseArgs — sinking-fund health', () => {
  it('parses sinking-fund health --json', () => {
    const result = parseArgs(['sinking-fund', 'health', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('sinking-fund.health');
  });

  it('rejects trailing args after sinking-fund health', () => {
    const result = parseArgs(['sinking-fund', 'health', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });
});

describe('parseArgs — reports generate', () => {
  it('parses reports generate --report-type spending --month-range 2026-01:2026-03 --json', () => {
    const result = parseArgs([
      'reports',
      'generate',
      '--report-type',
      'spending',
      '--month-range',
      '2026-01:2026-03',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reports.generate');
    expect(result.cmd.options!['report-type']).toBe('spending');
    expect(result.cmd.options!['month-range']).toBe('2026-01:2026-03');
  });

  it('parses reports generate with --label and --tag', () => {
    const result = parseArgs([
      'reports',
      'generate',
      '--report-type',
      'income',
      '--month-range',
      '2026-02',
      '--label',
      'Feb Income',
      '--tag',
      'income',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.label).toBe('Feb Income');
    expect(result.cmd.options!['tag']).toBe('income');
  });

  it('rejects reports generate without --report-type', () => {
    const result = parseArgs(['reports', 'generate', '--month-range', '2026-01', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_flag_value');
  });

  it('rejects reports generate without --month-range', () => {
    const result = parseArgs(['reports', 'generate', '--report-type', 'spending', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_flag_value');
  });

  it('rejects reports generate with trailing positional args', () => {
    const result = parseArgs([
      'reports',
      'generate',
      '--report-type',
      'spending',
      '--month-range',
      '2026-01',
      'extra',
      '--json',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });
});

describe('parseArgs — views commands', () => {
  it('parses views list --json', () => {
    const result = parseArgs(['views', 'list', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('views.list');
  });

  it('parses views create --name MyView --view-type target_health --json', () => {
    const result = parseArgs([
      'views',
      'create',
      '--name',
      'MyView',
      '--view-type',
      'target_health',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('views.create');
    expect(result.cmd.options!.name).toBe('MyView');
    expect(result.cmd.options!['view-type']).toBe('target_health');
  });

  it('parses views create with optional --scope', () => {
    const result = parseArgs([
      'views',
      'create',
      '--name',
      'MyView',
      '--view-type',
      'cash_flow',
      '--scope',
      '{"months":3}',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.name).toBe('MyView');
    expect(result.cmd.options!['view-type']).toBe('cash_flow');
    expect(result.cmd.options!.scope).toBe('{"months":3}');
  });

  it('parses views create with --sort', () => {
    const result = parseArgs([
      'views',
      'create',
      '--name',
      'MyView',
      '--view-type',
      'target_health',
      '--sort',
      'amount:desc',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.sort).toBe('amount:desc');
  });

  it('parses views create with --sort and --scope together', () => {
    const result = parseArgs([
      'views',
      'create',
      '--name',
      'N',
      '--view-type',
      'T',
      '--scope',
      '{}',
      '--sort',
      'amount:desc',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.name).toBe('N');
    expect(result.cmd.options!['view-type']).toBe('T');
    expect(result.cmd.options!.scope).toBe('{}');
    expect(result.cmd.options!.sort).toBe('amount:desc');
  });

  it('parses views create with --sort at different position', () => {
    const result = parseArgs([
      'views',
      'create',
      '--name',
      'N',
      '--view-type',
      'T',
      '--sort',
      'date:asc',
      '--scope',
      '{}',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.sort).toBe('date:asc');
    expect(result.cmd.options!.scope).toBe('{}');
  });

  it('rejects views create without --name', () => {
    const result = parseArgs(['views', 'create', '--view-type', 'target_health', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_flag_value');
  });

  it('rejects views create without --view-type', () => {
    const result = parseArgs(['views', 'create', '--name', 'MyView', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_flag_value');
  });

  it('rejects trailing args after views create', () => {
    const result = parseArgs([
      'views',
      'create',
      '--name',
      'MyView',
      '--view-type',
      'target_health',
      'extra',
      '--json',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects trailing args after views list', () => {
    const result = parseArgs(['views', 'list', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects unknown views subcommand', () => {
    const result = parseArgs(['views', 'delete', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_command');
  });
});

describe('parseArgs — home attention', () => {
  it('parses home attention --json', () => {
    const result = parseArgs(['home', 'attention', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('home.attention');
  });

  it('parses home attention with --detailed and --category-group', () => {
    const result = parseArgs([
      'home',
      'attention',
      '--detailed',
      '--category-group',
      'essentials',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options!.detailed).toBe('true');
    expect(result.cmd.options!['category-group']).toBe('essentials');
  });

  it('rejects trailing args after home attention', () => {
    const result = parseArgs(['home', 'attention', 'extra', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects unknown subcommand under home', () => {
    const result = parseArgs(['home', 'dashboard', '--json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_command');
  });
});

// ---------------------------------------------------------------------------
// Executable routing — main() produces a JSON envelope for budget intelligence
// ---------------------------------------------------------------------------

const mockAnalysisProtocol = {
  async pendingReview() {
    return {
      uncategorizedCount: 0,
      totalUncategorizedAmount: { minorUnits: '0', currency: 'USD' },
      candidates: [],
      oldestUncategorizedDate: null,
      healthState: 'unknown',
      blockers: [],
    };
  },
  async reviewShow() {
    return {
      reviewId: '',
      generatedAt: '',
      status: 'not_found',
      description: '',
      totalAmount: { minorUnits: '0', currency: 'USD' },
      itemCount: 0,
      items: [],
    };
  },
  async budgetSummary() {
    return {
      month: '',
      totalBudgeted: { minorUnits: '0', currency: 'USD' },
      totalSpent: { minorUnits: '0', currency: 'USD' },
      totalRemaining: { minorUnits: '0', currency: 'USD' },
      categories: [],
    };
  },
  async purchaseEvaluation() {
    return {
      allowable: true,
      reasonCodes: ['sufficient_budget'],
      categoryBudget: { minorUnits: '0', currency: 'USD' },
      categorySpent: { minorUnits: '0', currency: 'USD' },
      categoryRemaining: { minorUnits: '0', currency: 'USD' },
      projectedBalance: null,
      hasEnvelope: true,
    };
  },
  async cashFlowProjection() {
    return { projectionMonths: 3, monthlyProjections: [], sufficientData: true, dataWarning: null };
  },
  async targetHealth() {
    return {
      categories: [],
      overallLabel: 'healthy',
      healthyCount: 0,
      atRiskCount: 0,
      sinkingFundCount: 0,
    };
  },
  async sinkingFundHealth() {
    return { sinkingFunds: [], fullyFundedCount: 0, partiallyFundedCount: 0, unfundedCount: 0 };
  },
  async generateReport() {
    return {
      reportId: 'rpt_001',
      reportType: 'spending',
      scope: { monthRange: '2026-01', includePending: false },
      label: '',
      transactionCount: 0,
      totalAmount: { minorUnits: '0', currency: 'USD' },
      generatedAt: '',
      tags: [],
    };
  },
  async listSavedViews() {
    return { views: [], total: 0 };
  },
  async createSavedView() {
    return {
      view: {
        viewId: 'view_001',
        name: 'MyView',
        viewType: 'target_health',
        scope: {},
        createdAt: '',
      },
    };
  },
  async attentionHome() {
    return {
      blockers: [],
      alerts: [],
      recurrences: [],
      categoryRisks: [],
      targetProgress: {
        overallLabel: 'healthy',
        healthyCount: 0,
        atRiskCount: 0,
        sinkingFundsOnTrack: 0,
        totalSinkingFunds: 0,
      },
    };
  },
};

describe('main — budget intelligence routing', () => {
  const testLedger = { mockLedger: true };

  it('routes purchase evaluate and returns ok envelope', async () => {
    const result = await main(
      ['purchase', 'evaluate', '--category-id', 'cat-food', '--amount', '5000', '--json'],
      {
        actorId: 'usr_test',
        requestId: 'req_purch',
        mode: 'observe',
        ledger: testLedger,
        analysisProtocol: mockAnalysisProtocol,
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_purch');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.allowable).toBe(true);
  });

  it('routes cash-flow project and returns ok envelope', async () => {
    const result = await main(['cash-flow', 'project', '--months', '6', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_cf',
      mode: 'observe',
      ledger: testLedger,
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_cf');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.projectionMonths).toBe(3);
  });

  it('routes target health and returns ok envelope', async () => {
    const result = await main(['target', 'health', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_th',
      mode: 'observe',
      ledger: testLedger,
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_th');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.overallLabel).toBe('healthy');
  });

  it('routes sinking-fund health and returns ok envelope', async () => {
    const result = await main(['sinking-fund', 'health', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_sfh',
      mode: 'observe',
      ledger: testLedger,
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_sfh');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.fullyFundedCount).toBe(0);
  });

  it('routes reports generate and returns ok envelope', async () => {
    const result = await main(
      [
        'reports',
        'generate',
        '--report-type',
        'spending',
        '--month-range',
        '2026-01:2026-03',
        '--json',
      ],
      {
        actorId: 'usr_test',
        requestId: 'req_rpt',
        mode: 'observe',
        ledger: testLedger,
        analysisProtocol: mockAnalysisProtocol,
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_rpt');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.reportId).toBe('rpt_001');
  });

  it('routes views list and returns ok envelope', async () => {
    const result = await main(['views', 'list', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_vlist',
      mode: 'observe',
      ledger: testLedger,
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_vlist');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.views).toEqual([]);
  });

  it('routes views create and returns ok envelope', async () => {
    const result = await main(
      ['views', 'create', '--name', 'MyView', '--view-type', 'target_health', '--json'],
      {
        actorId: 'usr_test',
        requestId: 'req_vcreate',
        mode: 'observe',
        ledger: testLedger,
        analysisProtocol: mockAnalysisProtocol,
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_vcreate');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.view.viewId).toBe('view_001');
  });

  it('routes views create with --sort and forwards sort param', async () => {
    const capturedParams: unknown[] = [];
    const result = await main(
      [
        'views',
        'create',
        '--name',
        'MyView',
        '--view-type',
        'target_health',
        '--sort',
        'amount:desc',
        '--json',
      ],
      {
        actorId: 'usr_test',
        requestId: 'req_vcreate_sort',
        mode: 'observe',
        ledger: testLedger,
        analysisProtocol: {
          ...mockAnalysisProtocol,
          async createSavedView(_ledger: unknown, params: unknown) {
            capturedParams.push(params);
            return {
              view: {
                viewId: 'view_001',
                name: 'MyView',
                viewType: 'target_health',
                scope: {},
                sort: 'amount:desc',
                createdAt: '',
              },
            };
          },
        },
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    expect(params.sort).toBe('amount:desc');
  });

  it('routes home attention and returns ok envelope', async () => {
    const result = await main(['home', 'attention', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_home',
      mode: 'observe',
      ledger: testLedger,
      analysisProtocol: mockAnalysisProtocol,
    });
    const parsed = JSON.parse(result);
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.requestId).toBe('req_home');
    expect(parsed.status).toBe('ok');
    expect(parsed.result.targetProgress.overallLabel).toBe('healthy');
  });

  it('returns error when ledger is missing for purchase evaluate', async () => {
    const result = await main(
      ['purchase', 'evaluate', '--category-id', 'cat-food', '--amount', '5000', '--json'],
      {
        actorId: 'usr_test',
        requestId: 'req_purch_err',
        mode: 'observe',
        ledger: null,
        analysisProtocol: mockAnalysisProtocol,
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('not_connected');
  });

  it('returns error for unknown command under home', async () => {
    const result = await main(['home', 'dashboard', '--json'], {
      actorId: 'usr_test',
      mode: 'observe',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('unknown_command');
  });

  it('returns error for unknown command under views', async () => {
    const result = await main(['views', 'delete', '--json'], {
      actorId: 'usr_test',
      mode: 'observe',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('unknown_command');
  });
});

describe('main — financial decision JSON parity', () => {
  it('preserves canonical snapshot, policy, semantic states, blockers, remediation, redaction, expiry, and unknown codes on purchase evaluate', async () => {
    const decision = structuredClone(FINANCIAL_DECISION_FIXTURE.decisions.blocked);
    const futureIssue = decision.issues.find(({ code }) => code === 'fd_future_safety_code');
    expect(futureIssue).toBeDefined();
    futureIssue!.remediation = {
      code: 'review_future_safety',
      action: 'Review the qualified future-safety finding before purchase.',
    };
    const purchaseResult = {
      ...decision.payload,
      hasEnvelope: true,
      decision,
    };

    const output = await main(
      [
        'purchase',
        'evaluate',
        '--category-id',
        'fd-category-groceries',
        '--account-id',
        'fd-account-checking',
        '--amount',
        '5500',
        '--currency',
        'USD',
        '--json',
      ],
      {
        actorId: 'usr_financial_decision',
        requestId: 'fd-request-cli-2026-08-23',
        mode: 'observe',
        ledger: { canonical: true },
        freshness: {
          actualDownloadedAt: '2026-08-23T12:00:00Z',
          bankSyncedAt: '2026-08-23T11:58:00Z',
          pendingTransactionsIncluded: true,
          stalenessDays: 0,
          isStale: false,
        },
        analysisProtocol: {
          ...mockAnalysisProtocol,
          async purchaseEvaluation() {
            return purchaseResult;
          },
        },
      },
    );
    const parsed = JSON.parse(output);

    expect(parsed.status).toBe('ok');
    expect(parsed.result).toEqual(purchaseResult);
    expect(parsed.result.decision.metadata.context).toEqual(
      FINANCIAL_DECISION_FIXTURE.claims.context,
    );
    expect(parsed.result.decision.metadata.context).toMatchObject({
      snapshotId: FINANCIAL_DECISION_FIXTURE.full.snapshotId,
      contentHash: FINANCIAL_DECISION_FIXTURE.full.contentHash,
      policy: FINANCIAL_DECISION_FIXTURE.claims.context.policy,
      policyVersion: 'fd-policy-v1',
      policyHash: 'sha256:fd-policy-v1',
    });
    expect(parsed.result.decision.readiness).toBe('blocked');
    expect(parsed.result.decision.before).toEqual(decision.before);
    expect(parsed.result.decision.after).toEqual(decision.after);
    expect(parsed.result.decision.issues).toContainEqual(
      expect.objectContaining({
        code: 'reservation_conflict',
        effect: 'blocks',
      }),
    );
    expect(parsed.result.decision.issues).toContainEqual(
      expect.objectContaining({
        code: 'fd_future_safety_code',
        remediation: {
          code: 'review_future_safety',
          action: 'Review the qualified future-safety finding before purchase.',
        },
      }),
    );
    expect(parsed.result.decision.redaction).toBe('visible');
    expect(parsed.result.decision.expiresAt).toBe('2026-08-23T12:05:00Z');
    expect(parsed.result.reasonCodes).toContain('fd_future_reason_code');
  });

  it('preserves typed finding classifications and lifecycle metadata on the existing home attention command', async () => {
    const classifications = [
      'account_readiness_blocker',
      'transfer_needs_attention',
      'reservation_conflict',
      'commitment_conflict',
      'evidence_connector_degradation',
      'unresolved_material_evidence',
    ];
    const blockers = classifications.map((classification, index) => ({
      findingId: `fd-finding-${index + 1}`,
      code: index === classifications.length - 1 ? 'fd_future_safety_code' : classification,
      classification,
      message: `Fixture finding ${index + 1}`,
      severity: index === 0 ? 'critical' : 'warning',
      scope: {
        kind: index === 0 ? 'account' : 'global',
        ...(index === 0 ? { id: 'fd-account-card' } : {}),
      },
      blocksConclusion: index === 0,
      snapshotId: FINANCIAL_DECISION_FIXTURE.full.snapshotId,
      policyVersion: FINANCIAL_DECISION_FIXTURE.claims.context.policyVersion,
      remediation: {
        code: 'refresh_evidence',
        action: 'Refresh authorized evidence and evaluate again.',
      },
      evidence: [
        {
          evidenceId: 'fd-bank-sync-card-119',
          kind: 'bank_sync',
          authorized: true,
          redaction: 'redacted',
        },
      ],
      redaction: 'redacted',
      firstObservedAt: '2026-08-23T11:58:00Z',
      lastObservedAt: '2026-08-23T12:00:00Z',
      expiresAt: '2026-08-23T12:05:00Z',
    }));
    const homeResult = {
      blockers,
      alerts: [],
      recurrences: [],
      categoryRisks: [],
      targetProgress: {
        overallLabel: 'blocked',
        healthyCount: 0,
        atRiskCount: 1,
        sinkingFundsOnTrack: 0,
        totalSinkingFunds: 0,
      },
    };

    const output = await main(['home', 'attention', '--detailed', '--json'], {
      actorId: 'usr_financial_decision',
      requestId: 'fd-request-home-2026-08-23',
      mode: 'observe',
      ledger: { canonical: true },
      freshness: {
        actualDownloadedAt: '2026-08-23T12:00:00Z',
        bankSyncedAt: '2026-08-23T11:58:00Z',
        pendingTransactionsIncluded: true,
        stalenessDays: 0,
        isStale: false,
      },
      analysisProtocol: {
        ...mockAnalysisProtocol,
        async attentionHome() {
          return homeResult as never;
        },
      },
    });
    const parsed = JSON.parse(output);

    expect(parsed.status).toBe('ok');
    expect(parsed.result).toEqual(homeResult);
    expect(
      parsed.result.blockers.map(
        ({ classification }: { classification: string }) => classification,
      ),
    ).toEqual(classifications);
    expect(parsed.result.blockers[0]).toMatchObject({
      findingId: 'fd-finding-1',
      classification: 'account_readiness_blocker',
      scope: { kind: 'account', id: 'fd-account-card' },
      blocksConclusion: true,
      snapshotId: 'fd-snapshot-2026-08-23',
      policyVersion: 'fd-policy-v1',
      remediation: {
        code: 'refresh_evidence',
        action: 'Refresh authorized evidence and evaluate again.',
      },
      evidence: [
        expect.objectContaining({
          evidenceId: 'fd-bank-sync-card-119',
          authorized: true,
          redaction: 'redacted',
        }),
      ],
      redaction: 'redacted',
      firstObservedAt: '2026-08-23T11:58:00Z',
      lastObservedAt: '2026-08-23T12:00:00Z',
      expiresAt: '2026-08-23T12:05:00Z',
    });
    expect(parsed.result.blockers.at(-1).code).toBe('fd_future_safety_code');
  });
});

describe('main — composition integration', () => {
  it('dispatches pending-review when composition-aligned opts provided', async () => {
    const result = await main(['transactions', 'pending-review', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_comp_001',
      mode: 'observe',
      ledger: { mockLedger: true },
      analysisProtocol: {
        async pendingReview() {
          return {
            uncategorizedCount: 7,
            totalUncategorizedAmount: { minorUnits: '42000', currency: 'USD' },
            candidates: [
              {
                transactionId: 'tx_comp_001',
                amount: { minorUnits: '6000', currency: 'USD' },
                payeeName: 'Composition Store',
                date: '2026-07-21',
                reasons: [{ kind: 'uncategorized', details: 'No category' }],
              },
            ],
            oldestUncategorizedDate: '2026-06-01',
            healthState: 'healthy',
            blockers: [],
          };
        },
        async reviewShow() {
          return {
            reviewId: '',
            generatedAt: '',
            status: 'not_found',
            description: '',
            totalAmount: { minorUnits: '0', currency: 'USD' },
            itemCount: 0,
            items: [],
          };
        },
        async budgetSummary() {
          return {
            month: '',
            totalBudgeted: { minorUnits: '0', currency: 'USD' },
            totalSpent: { minorUnits: '0', currency: 'USD' },
            totalRemaining: { minorUnits: '0', currency: 'USD' },
            categories: [],
          };
        },
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.requestId).toBe('req_comp_001');
    expect(parsed.result.uncategorizedCount).toBe(7);
  });

  it('returns error for not_connected when ledger is null with protocol', async () => {
    const result = await main(['transactions', 'pending-review', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_no_ledger',
      mode: 'observe',
      ledger: null,
      analysisProtocol: {
        async pendingReview() {
          return {
            uncategorizedCount: 0,
            totalUncategorizedAmount: { minorUnits: '0', currency: 'USD' },
            candidates: [],
            oldestUncategorizedDate: null,
            healthState: 'unknown',
            blockers: [],
          };
        },
        async reviewShow() {
          return {
            reviewId: '',
            generatedAt: '',
            status: 'not_found',
            description: '',
            totalAmount: { minorUnits: '0', currency: 'USD' },
            itemCount: 0,
            items: [],
          };
        },
        async budgetSummary() {
          return {
            month: '',
            totalBudgeted: { minorUnits: '0', currency: 'USD' },
            totalSpent: { minorUnits: '0', currency: 'USD' },
            totalRemaining: { minorUnits: '0', currency: 'USD' },
            categories: [],
          };
        },
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error!.code).toBe('not_connected');
  });
});
