import { describe, it, expect } from 'vitest';
import { parseArgs, main, CliCommand, ParseResult } from '../src/index';

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
          return { reviewId: '', generatedAt: '', status: 'not_found', description: '', totalAmount: { minorUnits: '0', currency: 'USD' }, itemCount: 0, items: [] };
        },
        async budgetSummary() {
          return { month: '', totalBudgeted: { minorUnits: '0', currency: 'USD' }, totalSpent: { minorUnits: '0', currency: 'USD' }, totalRemaining: { minorUnits: '0', currency: 'USD' }, categories: [] };
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
    const result = parseArgs(['proposals', 'create', '--category-id', 'cat-food', '--transaction-id', 'txn-001', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.create');
    expect(result.cmd.format).toBe('json');
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
    const result = parseArgs(['audit', 'query', '--limit', '10', '--actor-id', 'usr_abc', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('audit.query');
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!['limit']).toBe('10');
    expect(result.cmd.options!['actor-id']).toBe('usr_abc');
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
      return { reviewId: '', generatedAt: '', status: 'not_found', description: '', totalAmount: { minorUnits: '0', currency: 'USD' }, itemCount: 0, items: [] };
    },
    async budgetSummary() {
      return { month: '', totalBudgeted: { minorUnits: '0', currency: 'USD' }, totalSpent: { minorUnits: '0', currency: 'USD' }, totalRemaining: { minorUnits: '0', currency: 'USD' }, categories: [] };
    },
    async proposalCreate() {
      return { proposalId: 'prop_new', status: 'pending', createdAt: '2026-07-20T00:00:00Z' };
    },
    async proposalShow() {
      return { proposalId: 'prop_abc', status: 'pending', createdAt: '2026-07-20T00:00:00Z', description: 'test', proposer: 'usr_test', totalAmount: { minorUnits: '0', currency: 'USD' }, itemCount: 0, items: [] };
    },
    async proposalApprove() {
      return { proposalId: 'prop_abc', action: 'approved', fromStatus: 'pending', toStatus: 'approved', timestamp: '2026-07-20T00:00:00Z' };
    },
    async proposalExecute() {
      return { proposalId: 'prop_abc', action: 'executed', fromStatus: 'approved', toStatus: 'executed', timestamp: '2026-07-20T00:00:00Z' };
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
