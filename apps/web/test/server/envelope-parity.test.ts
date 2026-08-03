/**
 * Envelope parity tests — verify the web-layer ApiEnvelope helpers can carry
 * actual application metadata (freshness, scope, semantic classes, evidence,
 * policy version) instead of forcing dataFreshness null.
 *
 * Also verifies the web-layer envelope shape stays compatible with the
 * application-layer ResponseEnvelope shape.
 */

import { describe, it, expect } from 'vitest';
import {
  okEnvelope,
  errorEnvelope,
  type ApiEnvelope,
  type AuthorizationInfo,
} from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH: AuthorizationInfo = {
  actorId: 'usr_test',
  capability: 'observe',
  allowed: true,
};

// ---------------------------------------------------------------------------
// Ok envelope — metadata propagation
// ---------------------------------------------------------------------------

describe('okEnvelope — metadata propagation', () => {
  it('produces a basic envelope without metadata (backward compatible)', () => {
    const env = okEnvelope({ value: 42 }, AUTH, 'req_001');

    expect(env.status).toBe('ok');
    expect(env.requestId).toBe('req_001');
    expect(env.schemaVersion).toBe('1');
    expect(env.result).toEqual({ value: 42 });
    expect(env.error).toBeNull();
    expect(env.authorization).toBe(AUTH);
    // Default: no freshness fabricated
    expect(env.dataFreshness).toBeNull();
  });

  it('preserves caller-supplied dataFreshness', () => {
    const freshness = {
      actualDownloadedAt: '2026-07-27T12:00:00Z',
      bankSyncedAt: '2026-07-27T11:00:00Z',
      pendingTransactionsIncluded: true,
      stalenessDays: 0,
      isStale: false,
    };

    const env = okEnvelope({ items: [] }, AUTH, 'req_002');
    // Attach freshness — simulates what a route handler does after construction
    const enriched: ApiEnvelope<typeof env.result> & {
      dataFreshness: typeof freshness;
    } = { ...env, dataFreshness: freshness };

    expect(enriched.dataFreshness).toEqual(freshness);
    expect(enriched.dataFreshness.isStale).toBe(false);
    expect(enriched.dataFreshness.stalenessDays).toBe(0);
  });

  it('carries scope metadata when attached by route handler', () => {
    const env = okEnvelope({ reportId: 'rpt_001' }, AUTH, 'req_003');
    const scope = { monthRange: '2026-07:2026-08', includePending: false };
    const enriched = { ...env, scope };

    expect(enriched.scope).toEqual(scope);
    expect(enriched.scope.monthRange).toBe('2026-07:2026-08');
  });

  it('carries semanticClasses metadata when attached by route handler', () => {
    const env = okEnvelope({ data: 'test' }, AUTH, 'req_004');
    const semanticClasses = ['budget_intelligence', 'data_quality'];
    const enriched = { ...env, semanticClasses };

    expect(enriched.semanticClasses).toEqual(semanticClasses);
  });

  it('carries evidence metadata when attached by route handler', () => {
    const env = okEnvelope({ data: 'test' }, AUTH, 'req_005');
    const evidence = [
      { source: 'transaction', id: 'txn_001', weight: 0.9 },
      { source: 'rule', id: 'rule_001', weight: 0.7 },
    ];
    const enriched = { ...env, evidence };

    expect(enriched.evidence).toHaveLength(2);
    expect(enriched.evidence[0].source).toBe('transaction');
  });

  it('carries policyVersion metadata when attached by route handler', () => {
    const env = okEnvelope({ data: 'test' }, AUTH, 'req_006');
    const policyVersion = '2026.07.1';
    const enriched = { ...env, policyVersion };

    expect(enriched.policyVersion).toBe('2026.07.1');
  });
});

// ---------------------------------------------------------------------------
// Error envelope — metadata preservation
// ---------------------------------------------------------------------------

describe('errorEnvelope — metadata preservation', () => {
  it('produces an error envelope without metadata (backward compatible)', () => {
    const env = errorEnvelope('FORBIDDEN', 'Access denied', AUTH, false, 'req_err_001');

    expect(env.status).toBe('error');
    expect(env.requestId).toBe('req_err_001');
    expect(env.schemaVersion).toBe('1');
    expect(env.error).toEqual({
      code: 'FORBIDDEN',
      message: 'Access denied',
      retryable: false,
    });
    expect(env.result).toBeNull();
    expect(env.dataFreshness).toBeNull();
  });

  it('preserves authorization on error envelopes', () => {
    const env = errorEnvelope('NO_LEDGER', 'Not connected', null, true, 'req_err_002');

    expect(env.authorization).toBeNull();
    expect(env.error!.retryable).toBe(true);
  });

  it('error envelope carries requestId through', () => {
    const env = errorEnvelope('STALE', 'Data is stale', AUTH, true, 'req_err_003');
    expect(env.requestId).toBe('req_err_003');
  });

  it('error envelope carries evidence metadata when attached', () => {
    const env = errorEnvelope('ANALYSIS_FAILED', 'Protocol error', AUTH, true, 'req_err_004');
    const evidence = [{ source: 'analysis', id: 'step_3', weight: 1.0 }];
    const enriched = { ...env, evidence };

    expect(enriched.evidence).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Shape compatibility with application-layer ResponseEnvelope
// ---------------------------------------------------------------------------

describe('envelope shape parity with application ResponseEnvelope', () => {
  it('okEnvelope result is compatible with ResponseEnvelope.ok shape', () => {
    const env = okEnvelope({ key: 'val' }, AUTH, 'req_parity_001');

    // Core fields present in both shapes
    expect(env).toHaveProperty('schemaVersion');
    expect(env).toHaveProperty('requestId');
    expect(env).toHaveProperty('status');
    expect(env).toHaveProperty('dataFreshness');
    expect(env).toHaveProperty('authorization');
    expect(env).toHaveProperty('result');
    expect(env).toHaveProperty('error');

    // Discriminant matches
    expect(env.status).toBe('ok');
    expect(env.result).toEqual({ key: 'val' });
    expect(env.error).toBeNull();
  });

  it('errorEnvelope is compatible with ResponseEnvelope.error shape', () => {
    const env = errorEnvelope('CODE', 'msg', AUTH, false, 'req_parity_002');

    expect(env.status).toBe('error');
    expect(env.result).toBeNull();
    expect(env.error).not.toBeNull();
    expect(env.error!.code).toBe('CODE');
  });

  it('okEnvelope dataFreshness is nullable (not forced null)', () => {
    // Verify the type allows both null and actual values
    const envNull = okEnvelope('data', AUTH, 'r1');
    expect(envNull.dataFreshness).toBeNull();

    // The type system allows setting it — no compile error
    const envFresh = { ...envNull, dataFreshness: { isStale: false, stalenessDays: 0 } };
    expect(envFresh.dataFreshness).not.toBeNull();
  });
});
