import { describe, it, expect } from 'vitest';
import {
  createRequestEnvelope,
  okResponse,
  errorResponse,
  AuthorizationContext,
  DataFreshness,
  ErrorInfo,
  ResponseEnvelope,
} from '../src/envelope';

// ---------------------------------------------------------------------------
// RequestEnvelope
// ---------------------------------------------------------------------------

describe('RequestEnvelope', () => {
  it('creates with schema version 1.0 and given request ID', () => {
    const req = createRequestEnvelope('req_test');
    expect(req.schemaVersion).toBe('1.0');
    expect(req.requestId).toBe('req_test');
    expect(req.timestamp).toBeTruthy();
  });

  it('contains ISO timestamp on creation', () => {
    const req = createRequestEnvelope('req_ts');
    expect(req.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// ErrorInfo
// ---------------------------------------------------------------------------

describe('ErrorInfo', () => {
  it('constructs from code, message, retryable, and reason codes', () => {
    const err = new ErrorInfo({
      code: 'stale_snapshot',
      message: 'Snapshot is older than 90 days',
      retryable: true,
      reasonCodes: ['stale_snapshot', 'stale_bank_sync'],
    });
    expect(err.code).toBe('stale_snapshot');
    expect(err.retryable).toBe(true);
    expect(err.reasonCodes).toEqual(['stale_snapshot', 'stale_bank_sync']);
  });

  it('defaults to empty reason codes', () => {
    const err = new ErrorInfo({ code: 'unknown', message: 'Something went wrong', retryable: false });
    expect(err.reasonCodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AuthorizationContext
// ---------------------------------------------------------------------------

describe('AuthorizationContext', () => {
  it('creates observe authorization', () => {
    const auth = AuthorizationContext.observe('usr_test');
    expect(auth.actorId).toBe('usr_test');
    expect(auth.capability).toBe('observe');
    expect(auth.allowed).toBe(true);
  });

  it('creates denied authorization for a specific capability', () => {
    const auth = AuthorizationContext.denied('usr_test', 'classification.approve');
    expect(auth.actorId).toBe('usr_test');
    expect(auth.capability).toBe('classification.approve');
    expect(auth.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DataFreshness
// ---------------------------------------------------------------------------

describe('DataFreshness', () => {
  it('includes all freshness fields', () => {
    const freshness = {
      actualDownloadedAt: '2026-07-12T15:04:00Z',
      bankSyncedAt: '2026-07-12T14:58:00Z',
      pendingTransactionsIncluded: true,
    };
    expect(freshness.actualDownloadedAt).toBeTruthy();
    expect(freshness.bankSyncedAt).toBeTruthy();
    expect(freshness.pendingTransactionsIncluded).toBe(true);
  });

  it('computed staleness when no download timestamp', () => {
    const freshness: DataFreshness = {
      actualDownloadedAt: null,
      bankSyncedAt: null,
      pendingTransactionsIncluded: false,
      stalenessDays: 0,
      isStale: true,
    };
    expect(freshness.isStale).toBe(true);
  });

  it('computed freshness determines isStale based on stalenessDays threshold', () => {
    const freshness: DataFreshness = {
      actualDownloadedAt: '2026-07-12T15:04:00Z',
      bankSyncedAt: null,
      pendingTransactionsIncluded: true,
      stalenessDays: 5,
      isStale: false,
    };
    expect(freshness.isStale).toBe(false);
    expect(freshness.stalenessDays).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ResponseEnvelope — exact envelope fields
// ---------------------------------------------------------------------------

describe('ResponseEnvelope', () => {
  it('ok response has schemaVersion 1.0 and status ok', () => {
    const res = okResponse('req_001', null, null, { items: [] });
    expect(res.schemaVersion).toBe('1.0');
    expect(res.requestId).toBe('req_001');
    expect(res.status).toBe('ok');
    expect(res.result).toEqual({ items: [] });
    expect(res.error).toBeNull();
  });

  it('ok response carries dataFreshness and authorization when provided', () => {
    const freshness: DataFreshness = {
      actualDownloadedAt: '2026-07-12T15:04:00Z',
      bankSyncedAt: '2026-07-12T14:58:00Z',
      pendingTransactionsIncluded: true,
      stalenessDays: 0,
      isStale: false,
    };
    const auth = AuthorizationContext.observe('usr_abc');
    const res = okResponse('req_002', freshness, auth, { count: 42 });

    expect(res.dataFreshness).toEqual(freshness);
    expect(res.authorization).toEqual(auth);
    expect(res.status).toBe('ok');
  });

  it('error response has status error and no result', () => {
    const err = new ErrorInfo({
      code: 'unauthorized',
      message: 'Mutation not allowed in Observe mode',
      retryable: false,
      reasonCodes: ['observe_mode_write_blocked'],
    });
    const res = errorResponse('req_003', err);

    expect(res.schemaVersion).toBe('1.0');
    expect(res.requestId).toBe('req_003');
    expect(res.status).toBe('error');
    expect(res.result).toBeNull();
    expect(res.error).toEqual(err);
    expect(res.dataFreshness).toBeNull();
    expect(res.authorization).toBeNull();
  });

  it('deterministic request IDs via injection', () => {
    const res1 = okResponse('req_deterministic_1', null, null, {});
    const res2 = okResponse('req_deterministic_1', null, null, {});
    expect(res1.requestId).toBe(res2.requestId);
  });

  it('unauthorized mutation returns status error with reason code', () => {
    const err = new ErrorInfo({
      code: 'write_rejected',
      message: 'Write operations are not permitted in Observe mode',
      retryable: false,
      reasonCodes: ['observe_mode_write_blocked'],
    });
    const res = errorResponse('req_mut_001', err);

    expect(res.status).toBe('error');
    expect(res.error!.code).toBe('write_rejected');
    expect(res.error!.reasonCodes).toContain('observe_mode_write_blocked');
  });

  it('blocked result when snapshot is stale', () => {
    const freshness: DataFreshness = {
      actualDownloadedAt: null,
      bankSyncedAt: null,
      pendingTransactionsIncluded: false,
      stalenessDays: 0,
      isStale: true,
    };
    const err = new ErrorInfo({
      code: 'stale_snapshot',
      message: 'No snapshot data available',
      retryable: true,
      reasonCodes: ['stale_snapshot'],
    });
    const res = errorResponse('req_stale', err);

    expect(res.status).toBe('error');
    expect(res.error!.code).toBe('stale_snapshot');
    expect(res.error!.retryable).toBe(true);
    expect(res.dataFreshness).toBeNull();
  });

  it('envelope serializes to stable JSON camelCase keys', () => {
    const auth = AuthorizationContext.observe('usr_test');
    const res = okResponse('req_json', null, auth, { items: [1, 2, 3] });

    const json = JSON.stringify(res);
    // Must use camelCase keys matching the Rust ResponseEnvelope serialization
    expect(json).toContain('"schemaVersion"');
    expect(json).toContain('"requestId"');
    expect(json).toContain('"status"');
    expect(json).toContain('"authorization"');
    expect(json).toContain('"result"');
    expect(json).toContain('"actorId"');
    expect(json).toContain('"allowed"');

    const parsed: ResponseEnvelope = JSON.parse(json);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.status).toBe('ok');
  });
});
