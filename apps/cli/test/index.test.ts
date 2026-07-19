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
