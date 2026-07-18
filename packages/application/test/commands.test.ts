import { describe, it, expect } from 'vitest';
import {
  RouteCommand,
  CommandInput,
  CommandResult,
  CommandError,
  PendingReviewOutput,
  ReviewShowOutput,
  BudgetSummaryOutput,
  ExportOutput,
  DisconnectOutput,
  RemovalOutput,
  routeCommand,
} from '../src/commands';
import { AuthorizationContext, DataFreshness } from '../src/envelope';

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

describe('routeCommand', () => {
  it('routes transactions pending-review --json', () => {
    const input: CommandInput = {
      args: ['transactions', 'pending-review', '--json'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_001',
      ledger: null,
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('transactions.pending-review');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews show REVIEW_ID --json', () => {
    const input: CommandInput = {
      args: ['reviews', 'show', 'rev_abc123', '--json'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_002',
      ledger: null,
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('reviews.show');
    expect(result.route).toBe('analysis');
  });

  it('routes budget summary --json', () => {
    const input: CommandInput = {
      args: ['budget', 'summary', '--json'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_003',
      ledger: null,
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('budget.summary');
    expect(result.route).toBe('analysis');
  });

  it('routes disconnect command', () => {
    const input: CommandInput = {
      args: ['disconnect'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_dc',
      ledger: null,
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('disconnect');
    expect(result.route).toBe('lifecycle');
  });

  it('routes export command', () => {
    const input: CommandInput = {
      args: ['export', '--json'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_exp',
      ledger: null,
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('export');
    expect(result.route).toBe('export');
  });

  it('routes removal command', () => {
    const input: CommandInput = {
      args: ['remove-connection'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_rem',
      ledger: null,
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('remove-connection');
    expect(result.route).toBe('lifecycle');
  });
});

// ---------------------------------------------------------------------------
// Unknown command rejection
// ---------------------------------------------------------------------------

describe('routeCommand — unknown/rejected commands', () => {
  it('rejects raw-query with CommandError', () => {
    const input: CommandInput = {
      args: ['raw-query', 'SELECT * FROM transactions'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_reject',
      ledger: null,
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow(CommandError);
    try {
      routeCommand(input);
    } catch (e) {
      const err = e as CommandError;
      expect(err.code).toBe('unknown_command');
      expect(err.reasonCodes).toContain('unsupported_raw_query');
    }
  });

  it('rejects invoke-method with CommandError', () => {
    const input: CommandInput = {
      args: ['invoke-method', 'createTransaction'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_reject',
      ledger: null,
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow(CommandError);
  });

  it('rejects shell with CommandError', () => {
    const input: CommandInput = {
      args: ['shell'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_reject',
      ledger: null,
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow(CommandError);
  });
});

// ---------------------------------------------------------------------------
// Observe mode rejects writes
// ---------------------------------------------------------------------------

describe('routeCommand — write rejection in Observe mode', () => {
  it('rejects category create in observe mode', () => {
    const input: CommandInput = {
      args: ['categories', 'create', '--name', 'Test'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_write',
      ledger: null,
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow();
    try {
      routeCommand(input);
    } catch (e) {
      const err = e as CommandError;
      expect(err.code).toBe('write_rejected');
      expect(err.reasonCodes).toContain('observe_mode_write_blocked');
    }
  });

  it('rejects transaction update in observe mode', () => {
    const input: CommandInput = {
      args: ['transactions', 'update', 'tx_001', '--category', 'cat_1'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_write',
      ledger: null,
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pending review result shape
// ---------------------------------------------------------------------------

describe('PendingReviewOutput — exact envelope fields', () => {
  it('produces envelope with schemaVersion, requestId, status, freshness, authorization, result', () => {
    const freshness: DataFreshness = {
      actualDownloadedAt: '2026-07-12T15:04:00Z',
      bankSyncedAt: null,
      pendingTransactionsIncluded: true,
      stalenessDays: 5,
      isStale: false,
    };
    const auth = AuthorizationContext.observe('usr_test');

    const output: PendingReviewOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_pending',
        status: 'ok',
        dataFreshness: freshness,
        authorization: auth,
        result: {
          uncategorizedCount: 12,
          totalUncategorizedAmount: { minorUnits: '45000', currency: 'USD' },
          candidates: [
            {
              transactionId: 'tx_001',
              amount: { minorUnits: '5000', currency: 'USD' },
              payeeName: 'Grocery Store',
              date: '2026-07-15',
              reasons: [{ kind: 'historical', details: 'Previously categorized as Food' }],
            },
          ],
          oldestUncategorizedDate: '2026-06-01',
          healthState: 'healthy',
          blockers: [],
        },
        error: null,
      },
    };

    expect(output.envelope.schemaVersion).toBe('1.0');
    expect(output.envelope.requestId).toBe('req_pending');
    expect(output.envelope.status).toBe('ok');
    expect(output.envelope.dataFreshness).toBeTruthy();
    expect(output.envelope.authorization).toBeTruthy();
    expect(output.envelope.result).toBeTruthy();
    expect(output.envelope.error).toBeNull();

    // Verify JSON serialization uses camelCase keys matching the Rust envelope
    const json = JSON.stringify(output);
    expect(json).toContain('"schemaVersion"');
    expect(json).toContain('"requestId"');
    expect(json).toContain('"status"');
    expect(json).toContain('"dataFreshness"');
    expect(json).toContain('"authorization"');
    expect(json).toContain('"result"');
    expect(json).toContain('"error":null');
  });

  it('includes reason codes and blockers when present', () => {
    const output: PendingReviewOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_blocked',
        status: 'ok',
        dataFreshness: null,
        authorization: AuthorizationContext.observe('usr_test'),
        result: {
          uncategorizedCount: 0,
          totalUncategorizedAmount: { minorUnits: '0', currency: 'USD' },
          candidates: [],
          oldestUncategorizedDate: null,
          healthState: 'degraded',
          blockers: [
            { code: 'stale_snapshot', message: 'No recent download', entityId: '_overview' },
          ],
        },
        error: null,
      },
    };

    expect(output.envelope.result.blockers).toHaveLength(1);
    expect(output.envelope.result.blockers[0].code).toBe('stale_snapshot');
    expect(output.envelope.result.healthState).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// Review show output
// ---------------------------------------------------------------------------

describe('ReviewShowOutput — exact envelope fields', () => {
  it('includes review detail in result', () => {
    const output: ReviewShowOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_rev',
        status: 'ok',
        dataFreshness: null,
        authorization: AuthorizationContext.observe('usr_test'),
        result: {
          reviewId: 'rev_abc123',
          generatedAt: '2026-07-15T12:00:00Z',
          status: 'pending_review',
          description: 'Review 12 uncategorized transactions',
          totalAmount: { minorUnits: '45000', currency: 'USD' },
          itemCount: 12,
          items: [
            {
              transactionId: 'tx_001',
              amount: { minorUnits: '5000', currency: 'USD' },
              payeeName: 'Grocery Store',
              date: '2026-07-15',
              categoryName: null,
              suggestedCategoryId: 'cat_2',
              suggestedCategoryName: 'Food & Dining',
              confidence: 0.85,
              reasonCodes: ['exact_payee_match'],
            },
          ],
        },
        error: null,
      },
    };

    expect(output.envelope.result.reviewId).toBe('rev_abc123');
    expect(output.envelope.result.items).toHaveLength(1);
    expect(output.envelope.result.items[0].suggestedCategoryName).toBe('Food & Dining');
  });

  it('review not found returns error status', () => {
    const output: ReviewShowOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_notfound',
        status: 'error',
        dataFreshness: null,
        authorization: null,
        result: null,
        error: {
          code: 'not_found',
          message: 'Review rev_nonexistent not found',
          retryable: false,
          reasonCodes: ['review_not_found'],
        },
      },
    };

    expect(output.envelope.status).toBe('error');
    expect(output.envelope.error!.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Budget summary output
// ---------------------------------------------------------------------------

describe('BudgetSummaryOutput — exact envelope fields', () => {
  it('includes budget summary with categories in result', () => {
    const output: BudgetSummaryOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_budget',
        status: 'ok',
        dataFreshness: null,
        authorization: AuthorizationContext.observe('usr_test'),
        result: {
          month: '2026-07',
          totalBudgeted: { minorUnits: '500000', currency: 'USD' },
          totalSpent: { minorUnits: '120000', currency: 'USD' },
          totalRemaining: { minorUnits: '380000', currency: 'USD' },
          categories: [
            {
              categoryId: 'cat_1',
              categoryName: 'Food & Dining',
              budgeted: { minorUnits: '200000', currency: 'USD' },
              spent: { minorUnits: '85000', currency: 'USD' },
              remaining: { minorUnits: '115000', currency: 'USD' },
            },
          ],
        },
        error: null,
      },
    };

    expect(output.envelope.result.month).toBe('2026-07');
    expect(output.envelope.result.categories).toHaveLength(1);
    expect(output.envelope.result.totalBudgeted.minorUnits).toBe('500000');
  });
});

// ---------------------------------------------------------------------------
// Export / Disconnect / Removal
// ---------------------------------------------------------------------------

describe('Export/Disconnect/Removal — safe behavior', () => {
  it('export returns success with metadata', () => {
    const output: ExportOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_export',
        status: 'ok',
        dataFreshness: null,
        authorization: AuthorizationContext.observe('usr_test'),
        result: {
          exportedAt: '2026-07-18T10:00:00Z',
          budgetName: 'My Budget',
          exportPath: '/tmp/balanceframe-export/my-budget.json',
          accountCount: 5,
          transactionCount: 250,
        },
        error: null,
      },
    };

    expect(output.envelope.status).toBe('ok');
    expect(output.envelope.result.exportedAt).toBeTruthy();
    expect(output.envelope.result.budgetName).toBe('My Budget');
  });

  it('disconnect returns cache/credentials removal confirmation', () => {
    const output: DisconnectOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_dc',
        status: 'ok',
        dataFreshness: null,
        authorization: AuthorizationContext.observe('usr_test'),
        result: {
          disconnected: true,
          cacheRemoved: true,
          credentialsRemoved: true,
          message: 'Connection removed. Actual server was not modified.',
        },
        error: null,
      },
    };

    expect(output.envelope.result.disconnected).toBe(true);
    expect(output.envelope.result.cacheRemoved).toBe(true);
    expect(output.envelope.result.credentialsRemoved).toBe(true);
    expect(output.envelope.result.message).toContain('Actual server was not modified');
  });

  it('removal confirmation with broad-access caveat', () => {
    const output: RemovalOutput = {
      envelope: {
        schemaVersion: '1.0',
        requestId: 'req_rem',
        status: 'ok',
        dataFreshness: null,
        authorization: AuthorizationContext.observe('usr_test'),
        result: {
          removed: true,
          cacheRemoved: true,
          credentialsRemoved: true,
          broadAccessCaveat:
            'The BalanceFrame connector accesses all budget data including bank-sync credentials ' +
            'stored on the Actual server (which are not protected by Actual E2E encryption). ' +
            'Project-side filtering does not reduce the broad access held by the connector. ' +
            'Ensure your Actual server and backups have appropriate security.',
        },
        error: null,
      },
    };

    expect(output.envelope.result.removed).toBe(true);
    expect(output.envelope.result.broadAccessCaveat).toBeTruthy();
  });
});
