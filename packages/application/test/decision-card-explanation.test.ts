import { describe, expect, it } from 'vitest';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { decisionCardExplanationSource } from '../src/decision-card-explanation.js';

describe('explanation source binding clock ownership', () => {
  it('normalizes generated ledger capture metadata without changing the snapshot or bank evidence', () => {
    const first = actualLiquidityRequest(false).financialSnapshot;
    first.observations.push({ kind: 'account_coverage', scope: { kind: 'account', id: 'cash' }, state: 'complete', observedAt: first.capturedAt, evidence: [] });
    const original = structuredClone(first);
    const next = structuredClone(first);
    const capturedAt = '2026-09-06T10:00:01.000Z';
    next.capturedAt = capturedAt;
    next.snapshotId = 'new-read-id';
    next.contentHash = 'sha256:new-read-hash';
    next.legacySnapshot.snapshotDate = capturedAt;
    next.legacySnapshot.actualDownloadedAt = capturedAt;
    next.observations[0]!.observedAt = capturedAt;
    next.liquidity!.ledgerContentHash = 'sha256:new-ledger-read-hash';
    for (const category of next.liquidity!.categories) {
      if (category.evidence.state === 'known') category.evidence.observedAt = capturedAt;
    }
    for (const account of next.liquidity!.accounts) {
      for (const value of Object.values(account)) {
        if (value && typeof value === 'object' && 'source' in value && value.source === 'actual_ledger' &&
          'observedAt' in value && value.observedAt === first.capturedAt) value.observedAt = capturedAt;
      }
    }
    expect(decisionCardExplanationSource(next)).toEqual(decisionCardExplanationSource(first));
    expect(first).toEqual(original);
  });
  it('retains institution and human authority clocks even when they coincide with a read capture', () => {
    const first = actualLiquidityRequest(true).financialSnapshot;
    first.legacySnapshot.bankSyncedAt = first.capturedAt;
    first.observations.push({ kind: 'account_freshness', scope: { kind: 'account', id: 'cash' }, state: 'fresh', observedAt: first.capturedAt, evidence: [] });
    for (const change of ['bank', 'observation', 'expiry'] as const) {
      const next = structuredClone(first);
      if (change === 'bank') next.legacySnapshot.bankSyncedAt = '2026-09-06T10:00:01Z';
      if (change === 'observation') next.observations[0]!.observedAt = '2026-09-06T10:00:01Z';
      if (change === 'expiry') next.liquidity!.accounts[0]!.freshnessEvidence.expiresAt = '2026-09-06T10:10:00Z';
      expect(decisionCardExplanationSource(next)).not.toEqual(decisionCardExplanationSource(first));
    }
  });
});
