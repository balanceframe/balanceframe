import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/index';


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

  it('parses proposals approve with its exact displayed payload hash', () => {
    const result = parseArgs([
      'proposals',
      'approve',
      'prop_abc123',
      '--payload-hash',
      'hash-from-show',
      '--json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('proposals.approve');
    expect(result.cmd.proposalId).toBe('prop_abc123');
    expect(result.cmd.options?.['payload-hash']).toBe('hash-from-show');
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
      '--payee-id',
      'payee-Amazon',
      '--category-id',
      'cat-food',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('rules.create');
    expect(result.cmd.options).toBeDefined();
    expect(result.cmd.options!['name']).toBe('My Rule');
    expect(result.cmd.options!['payee-id']).toBe('payee-Amazon');
    expect(result.cmd.options!['category-id']).toBe('cat-food');
  });

  it('parses rules.create with all options', () => {
    const result = parseArgs([
      'rules',
      'create',
      '--name',
      'My Rule',
      '--payee-id',
      'payee-Amazon',
      '--category-id',
      'cat-food',
      '--transaction-id',
      'txn-001',
      '--operation',
      'create_rule',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('rules.create');
    expect(result.cmd.options!['name']).toBe('My Rule');
    expect(result.cmd.options!['payee-id']).toBe('payee-Amazon');
    expect(result.cmd.options!['category-id']).toBe('cat-food');
    expect(result.cmd.options!['transaction-id']).toBe('txn-001');
    expect(result.cmd.options!['operation']).toBe('create_rule');
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

  it('parses distinct purchase and settlement timing values', () => {
    const result = parseArgs([
      'purchase',
      'evaluate',
      '--category-id',
      'cat-food',
      '--amount',
      '5000',
      '--purchase-at',
      '2026-09-07T10:00:00Z',
      '--required-by',
      '2026-09-08T17:00:00Z',
    ]);
    expect(result).toMatchObject({
      ok: true,
      cmd: {
        command: 'purchase.evaluate',
        options: {
          'purchase-at': '2026-09-07T10:00:00Z',
          'required-by': '2026-09-08T17:00:00Z',
        },
      },
    });
  });

  it('rejects a missing purchase timing value before another flag', () => {
    const result = parseArgs([
      'purchase',
      'evaluate',
      '--category-id',
      'cat-food',
      '--amount',
      '5000',
      '--purchase-at',
      '--required-by',
      '2026-09-08T17:00:00Z',
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: 'missing_flag_value' } });
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

describe('parseArgs — audit numeric filters', () => {
  it('preserves finite non-negative integer spellings accepted by Number', () => {
    const result = parseArgs(['audit', 'query', '--limit', '1e1', '--offset', '0xA']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.options).toMatchObject({ limit: '1e1', offset: '0xA' });
  });

  it('rejects negative, fractional, and non-finite pagination values', () => {
    for (const [flag, value] of [['--limit', '-1'], ['--offset', '1.5'], ['--limit', 'Infinity']]) {
      const result = parseArgs(['audit', 'query', flag, value]);
      expect(result).toMatchObject({ ok: false, error: { code: flag === '--limit' ? 'invalid_limit' : 'invalid_offset' } });
    }
  });
});
