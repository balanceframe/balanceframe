import type {
  MerchantAuthorize,
  MerchantCacheKey,
  MerchantDecisionPayload,
  MerchantEnrichment,
  MerchantEvidence,
  MerchantPolicyValue,
  MerchantQuotaBucket,
  MerchantResearchAttempt,
  MerchantScope,
  MerchantSourceRefs,
  MerchantTariff,
  MerchantViewAccess,
  MerchantVisibility,
} from '../src/merchant.js';
import type { ReviewActionAuthorization } from '../src/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../../protocol/fixtures/representative.json';
import { GENERIC_MUTATION_POLICY_VERSION } from '../src/proposal.js';
import { SqliteWorkflowStore } from '../src/store.js';
import { migrateMerchant } from '../src/merchant-migration.js';

// Real SQLite connections; all clocks are explicit server-side fixture inputs.
const NOW = '2026-01-15T12:00:00.000Z';
const SCOPE: MerchantScope = { spaceId: 'space-a', budgetId: 'budget-a', connectionId: 'actual-a' };
const VISIBILITY: MerchantVisibility = { hash: 'a'.repeat(64), privateActorId: null };
const REFS: MerchantSourceRefs = {
  accountIds: ['account-a', 'account-private'],
  categoryIds: ['category-a', 'category-private'],
  ruleIds: ['rule-a'],
  transactionIds: ['transaction-a', 'transaction-private'],
  factsHash: 'e'.repeat(64),
  required: [
    { resourceKind: 'account', resourceId: 'account-a', capability: 'account:history', version: '1' },
    { resourceKind: 'account', resourceId: 'account-private', capability: 'account:history', version: '2' },
    { resourceKind: 'category', resourceId: 'category-a', capability: 'category:name', version: '1' },
    { resourceKind: 'category', resourceId: 'category-private', capability: 'category:name', version: '2' },
    { resourceKind: 'rule', resourceId: 'rule-a', capability: 'rule:observe', version: '3' },
    { resourceKind: 'transaction', resourceId: 'transaction-a', capability: 'transaction:observe', version: '1' },
    { resourceKind: 'transaction', resourceId: 'transaction-private', capability: 'transaction:observe', version: '2' },
  ],
};
const ALIAS: MerchantDecisionPayload = {
  kind: 'alias', sourceText: 'PUBLIC MARKET', sourceField: 'importedPayee', normalizationVersion: 'merchant/2',
  targetPayeeId: 'payee-a', accountId: 'account-a', sourceTransactionIds: ['transaction-a'],
};
const POLICY: MerchantPolicyValue = {
  mode: 'external-allowed', allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20,
  maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 720,
};
const TARIFF: MerchantTariff = { version: 'fixture/1', billingCurrency: 'USD', costAtoms: '250000' };
const ALLOW: MerchantAuthorize = () => true;
const DENY: MerchantAuthorize = () => false;

function at(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString();
}

function buckets(cap = 100, daily = 20): MerchantQuotaBucket[] {
  return [
    { kind: 'installation', id: 'installation-a', maxSearchesPerDay: daily, maxSpendMinorUnitsPerMonth: cap },
    { kind: 'space', id: SCOPE.spaceId, maxSearchesPerDay: daily, maxSpendMinorUnitsPerMonth: cap },
    { kind: 'budget', id: `${SCOPE.spaceId}/${SCOPE.budgetId}`, maxSearchesPerDay: daily, maxSpendMinorUnitsPerMonth: cap },
    { kind: 'credential', id: 'credential-a', maxSearchesPerDay: daily, maxSpendMinorUnitsPerMonth: cap },
  ];
}

function key(scope = SCOPE, fingerprint = 'b'.repeat(64)): MerchantCacheKey {
  return {
    scope, queryFingerprint: fingerprint, locale: 'en-US', providerId: 'valueserp',
    providerVersion: '1', parametersHash: 'c'.repeat(64), normalizationVersion: 'merchant/2',
    egressPolicyVersion: 'egress/1', visibilityHash: VISIBILITY.hash,
  };
}

describe('merchant intelligence persistence and admission', () => {
  let directory: string;
  let filename: string;
  let store: SqliteWorkflowStore;
  let peer: SqliteWorkflowStore;
  let cachePublications: number;

  function access(owner = store, scope = SCOPE, now = NOW, authorize = ALLOW): MerchantViewAccess {
    return {
      scope, now, expectedGeneration: owner.merchant.generation(scope), authorize,
      visibility: VISIBILITY, actorId: 'actor-a',
    };
  }

  function configure(owner = store, scope = SCOPE, value = POLICY, now = NOW): void {
    const previous = owner.merchant.policy(access(owner, scope, now));
    const saved = owner.merchant.setPolicy({
      ...access(owner, scope, now), value, expectedVersion: previous?.version ?? 0,
    });
    expect(saved).not.toBeNull();
  }

  function evidenceValue(overrides: Partial<Omit<MerchantEvidence, 'scope' | 'generation'>> = {}): Omit<MerchantEvidence, 'scope' | 'generation'> {
    return {
      key: 'merchant-pattern-a', revision: 'd'.repeat(64), snapshotId: 'snapshot-a',
      factsHash: 'e'.repeat(64), normalizationVersion: 'merchant/2', calendarVersion: 'holidays/1',
      policyVersion: 1, capturedAt: NOW, expiresAt: at(3600), visibility: VISIBILITY,
      sourceRefs: REFS, ...overrides,
    };
  }

  function cacheValue(overrides: Partial<Omit<MerchantEnrichment, 'generation'>> = {}): Omit<MerchantEnrichment, 'generation'> {
    return {
      key: key(), sources: [{ url: 'https://merchant.example/about', title: 'Public Market', snippet: 'A public retailer.' }],
      fieldsSent: ['merchant', 'locale'], retrievedAt: NOW, expiresAt: at(3600),
      policyVersion: 1, evidenceRevision: 'd'.repeat(64), confidence: 'uncalibrated',
      visibility: VISIBILITY, sourceRefs: REFS, ...overrides,
    };
  }

  function reserve(
    idempotencyKey: string,
    overrides: Partial<Parameters<SqliteWorkflowStore['merchant']['reserveAttempt']>[0]> = {},
    owner = store,
  ) {
    return owner.merchant.reserveAttempt({
      ...access(owner), idempotencyKey, key: key(), sourceRefs: REFS, policyVersion: 1,
      tariff: TARIFF, buckets: buckets(), ...overrides,
    });
  }

  function admitted(
    id: string,
    overrides: Partial<Parameters<SqliteWorkflowStore['merchant']['reserveAttempt']>[0]> = {},
    owner = store,
  ): MerchantResearchAttempt {
    const result = reserve(id, overrides, owner);
    expect(result.status).toBe('admitted');
    if (result.status !== 'admitted') throw new Error('Expected an admitted fixture attempt');
    return result.attempt;
  }

  function claimed(attempt: MerchantResearchAttempt, owner = store, now = NOW): MerchantResearchAttempt & { claimToken: string } {
    const result = owner.merchant.claimAttempt({ ...access(owner, attempt.scope, now), visibility: attempt.visibility, id: attempt.id });
    expect(result?.claimToken).toBeTypeOf('string');
    if (!result?.claimToken) throw new Error('Expected a claimed fixture attempt');
    return { ...result, claimToken: result.claimToken };
  }

  function dispatch(attempt: MerchantResearchAttempt, owner = store, now = NOW): MerchantResearchAttempt & { claimToken: string } {
    const claim = claimed(attempt, owner, now);
    expect(owner.merchant.dispatchAttempt({ ...access(owner, attempt.scope, now), visibility: attempt.visibility, id: attempt.id, claimToken: claim.claimToken })).toBe(true);
    return claim;
  }

  function publishCache(input: Omit<Parameters<SqliteWorkflowStore['merchant']['putCache']>[0], 'attemptId' | 'claimToken'>): MerchantEnrichment | null {
    const now = at(cachePublications++);
    const policy = store.merchant.policy(access(store, input.scope, now))!;
    const attempt = admitted(`cache-fixture-${cachePublications}`, {
      ...access(store, input.scope, now), key: input.value.key,
      sourceRefs: input.value.sourceRefs, policyVersion: policy.version,
    });
    const claim = dispatch(attempt, store, now);
    try {
      return store.merchant.putCache({ ...input, now, attemptId: attempt.id, claimToken: claim.claimToken });
    } finally {
      // A successful provider response can be unbilled; fixture accounting stays explicit.
      store.merchant.settleAttempt({
        ...access(store, input.scope, now), id: attempt.id, claimToken: claim.claimToken,
        outcome: { phase: 'succeeded', costAtoms: '0' },
      });
    }
  }

  beforeEach(() => {
    cachePublications = 0;
    directory = mkdtempSync(join(tmpdir(), 'merchant-store-'));
    filename = join(directory, 'workflow.sqlite');
    store = new SqliteWorkflowStore(filename);
    peer = new SqliteWorkflowStore(filename);
    configure();
  });

  afterEach(() => {
    peer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe('scoped attributed decisions and evidence', () => {
    it('separates all scope coordinates, alias/pattern kinds, and paginates without duplicates', () => {
      for (const id of ['alias-a', 'alias-b', 'alias-c']) {
        expect(store.merchant.decide({ ...access(), id, payload: ALIAS, state: 'accepted', sourceRefs: REFS, expectedVersion: 0 })).toMatchObject({ id, version: 1, actorId: 'actor-a', payload: { kind: 'alias' } });
      }
      store.merchant.decide({ ...access(), id: 'pattern-a', payload: { kind: 'pattern', patternId: 'stable-pattern' }, state: 'rejected', sourceRefs: REFS, expectedVersion: 0 });
      const first = store.merchant.decisions({ ...access(), kind: 'alias', limit: 2 });
      expect(first.records).toHaveLength(2);
      expect(first.nextCursor).toBeTypeOf('string');
      const second = store.merchant.decisions({ ...access(), kind: 'alias', limit: 2, cursor: first.nextCursor! });
      expect(new Set([...first.records, ...second.records].map((record) => record.id)).size).toBe(3);
      expect(second.nextCursor).toBeNull();
      expect(store.merchant.decisions({ ...access(), kind: 'pattern', limit: 10 }).records).toMatchObject([{ state: 'rejected', payload: { patternId: 'stable-pattern' } }]);
      for (const scope of [
        { ...SCOPE, spaceId: 'space-b' }, { ...SCOPE, budgetId: 'budget-b' }, { ...SCOPE, connectionId: 'actual-b' },
      ]) expect(peer.merchant.decisions({ ...access(peer, scope), limit: 10 })).toEqual({ records: [], nextCursor: null });
    });

    it('optimistically conflicts across connections and explicitly attributes rejection/revocation', () => {
      const input = { ...access(), id: 'alias-a', payload: ALIAS, state: 'accepted' as const, sourceRefs: REFS, expectedVersion: 0 };
      expect(store.merchant.decide(input)?.version).toBe(1);
      expect(peer.merchant.decide({ ...input, ...access(peer), actorId: 'actor-b' })).toBeNull();
      expect(peer.merchant.decide({ ...input, ...access(peer), actorId: 'actor-b', state: 'rejected', expectedVersion: 1 })).toMatchObject({ version: 2, actorId: 'actor-b', state: 'rejected' });
      expect(store.merchant.decide({ ...input, state: 'revoked', expectedVersion: 1 })).toBeNull();
      expect(store.merchant.decide({ ...input, state: 'revoked', expectedVersion: 2 })).toMatchObject({ version: 3, actorId: 'actor-a', state: 'revoked' });
    });

    it('never turns private decisions into shared learning or reveals hidden dependency counts', () => {
      const visibility = { hash: 'f'.repeat(64), privateActorId: 'actor-a' };
      store.merchant.decide({ ...access(), visibility, id: 'private-alias', payload: ALIAS, state: 'accepted', sourceRefs: REFS, expectedVersion: 0 });
      expect(store.merchant.decisions({ ...access(), limit: 10 })).toEqual({ records: [], nextCursor: null });
      expect(store.merchant.decisions({ ...access(), visibility, actorId: 'actor-b', limit: 10 })).toEqual({ records: [], nextCursor: null });
      const seen: MerchantSourceRefs[] = [];
      const authorize: MerchantAuthorize = (context) => {
        seen.push(context.sourceRefs);
        return !context.sourceRefs.accountIds.includes('account-private');
      };
      expect(store.merchant.decisions({ ...access(), visibility, authorize, limit: 10 })).toEqual({ records: [], nextCursor: null });
      expect(seen).toContainEqual(REFS);
      expect(store.merchant.decisions({ ...access(), visibility, limit: 10 }).records).toHaveLength(1);
    });

    it('stores complete source dependencies and separates explanation refresh from rejected user intent', () => {
      store.merchant.decide({ ...access(), id: 'pattern-a', payload: { kind: 'pattern', patternId: 'stable-pattern' }, state: 'rejected', sourceRefs: REFS, expectedVersion: 0 });
      const original = store.merchant.putEvidence({ ...access(), value: evidenceValue(), expectedRevision: null });
      expect(original?.sourceRefs).toEqual(REFS);
      const refreshed = evidenceValue({ revision: '1'.repeat(64), calendarVersion: 'holidays/2', snapshotId: 'snapshot-b', capturedAt: at(1) });
      expect(peer.merchant.putEvidence({ ...access(peer, SCOPE, at(1)), value: refreshed, expectedRevision: original!.revision })).toMatchObject({ revision: refreshed.revision, calendarVersion: 'holidays/2' });
      expect(store.merchant.putEvidence({ ...access(), value: evidenceValue(), expectedRevision: original!.revision })).toBeNull();
      expect(store.merchant.decisions({ ...access(), limit: 10 }).records).toMatchObject([{ version: 1, state: 'rejected', payload: { patternId: 'stable-pattern' } }]);
    });

    it('refreshes provenance without changing a stable evidence revision and misses at exact expiry', () => {
      store.merchant.putEvidence({ ...access(), value: evidenceValue(), expectedRevision: null });
      expect(store.merchant.putEvidence({ ...access(), value: evidenceValue({ capturedAt: at(1), snapshotId: 'snapshot-b' }), expectedRevision: 'd'.repeat(64) })).toMatchObject({ revision: 'd'.repeat(64), snapshotId: 'snapshot-b' });
      expect(store.merchant.evidence({ ...access(store, SCOPE, at(3599)), key: 'merchant-pattern-a' })).not.toBeNull();
      expect(store.merchant.evidence({ ...access(store, SCOPE, at(3600)), key: 'merchant-pattern-a' })).toBeNull();
      expect(store.merchant.evidence({ ...access(store, SCOPE, NOW, DENY), key: 'merchant-pattern-a' })).toBeNull();
    });

    it('keeps admitted views independent even when pattern/source keys are identical', () => {
      store.merchant.putEvidence({ ...access(), value: evidenceValue(), expectedRevision: null });
      const visibility = { hash: '9'.repeat(64), privateActorId: null };
      const sourceRefs = {
        ...REFS, accountIds: ['account-a'], categoryIds: ['category-a'], transactionIds: ['transaction-a'],
        required: REFS.required.filter((ref) => !ref.resourceId.endsWith('-private')),
      };
      store.merchant.putEvidence({ ...access(), visibility, value: evidenceValue({ visibility, revision: '8'.repeat(64), sourceRefs }), expectedRevision: null });
      expect(store.merchant.evidence({ ...access(), key: 'merchant-pattern-a' })?.revision).toBe('d'.repeat(64));
      expect(store.merchant.evidence({ ...access(), visibility, key: 'merchant-pattern-a' })?.revision).toBe('8'.repeat(64));
    });
  });

  describe('policy, cache and atomic current authority', () => {
    it('increments generation on successful policy update only and rejects stale optimistic writers', () => {
      const current = store.merchant.policy(access())!;
      const old = access();
      expect(peer.merchant.setPolicy({ ...access(peer), value: { ...POLICY, mode: 'local-only' }, expectedVersion: current.version })).toMatchObject({ version: 2, generation: current.generation + 1 });
      expect(store.merchant.setPolicy({ ...old, value: POLICY, expectedVersion: current.version })).toBeNull();
      expect(store.merchant.generation(SCOPE)).toBe(current.generation + 1);
      expect(store.merchant.policy(access())?.mode).toBe('local-only');
    });

    it.each(['disabled', 'local-only'] as const)('does not serve external cache or admit dispatch under %s', (mode) => {
      publishCache({ ...access(), value: cacheValue() });
      configure(store, SCOPE, { ...POLICY, mode });
      expect(store.merchant.cache({ ...access(), key: key() })).toBeNull();
      expect(reserve('disabled-request', { policyVersion: 2 })).toEqual({ status: 'denied', reason: 'policy' });
    });

    it('requires exact cache scope, versions, locale, parameters, visibility and unexpired provenance', () => {
      expect(publishCache({ ...access(), value: cacheValue() })).toMatchObject({ confidence: 'uncalibrated', sourceRefs: REFS });
      expect(peer.merchant.cache({ ...access(peer), key: key() })).not.toBeNull();
      for (const other of [
        { ...key(), locale: 'en-CA' }, { ...key(), providerVersion: '2' },
        { ...key(), parametersHash: '2'.repeat(64) }, { ...key(), normalizationVersion: 'merchant/3' },
        { ...key(), egressPolicyVersion: 'egress/2' }, { ...key(), visibilityHash: '3'.repeat(64) },
      ]) expect(store.merchant.cache({ ...access(), key: other })).toBeNull();
      for (const scope of [{ ...SCOPE, budgetId: 'other' }, { ...SCOPE, connectionId: 'other' }, { ...SCOPE, spaceId: 'other' }]) {
        expect(store.merchant.cache({ ...access(store, scope), key: key(scope) })).toBeNull();
      }
      expect(store.merchant.cache({ ...access(store, SCOPE, at(3600)), key: key() })).toBeNull();
      expect(store.merchant.cache({ ...access(store, SCOPE, NOW, DENY), key: key() })).toBeNull();
    });

    it('rechecks complete cached dependencies against current SQL authority, including after revocation', () => {
      store['db'].exec('CREATE TABLE test_merchant_grants(account_id TEXT PRIMARY KEY, admitted INTEGER NOT NULL)');
      store['db'].prepare('INSERT INTO test_merchant_grants VALUES (?, 1)').run('account-private');
      const authorize: MerchantAuthorize = ({ sourceRefs }) => {
        const grant = store['db'].prepare('SELECT admitted FROM test_merchant_grants WHERE account_id=?').get('account-private') as { admitted: number } | undefined;
        return !sourceRefs.required.some((ref) => ref.resourceKind === 'account' && ref.resourceId === 'account-private' && ref.capability === 'account:history') || grant?.admitted === 1;
      };
      publishCache({ ...access(), authorize, value: cacheValue() });
      expect(store.merchant.cache({ ...access(), authorize, key: key() })).not.toBeNull();
      peer['db'].prepare('UPDATE test_merchant_grants SET admitted=0 WHERE account_id=?').run('account-private');
      expect(store.merchant.cache({ ...access(), authorize, key: key() })).toBeNull();
      expect(store.merchant.putEvidence({ ...access(), authorize, value: evidenceValue(), expectedRevision: null })).toBeNull();
    });

    it('executes publication authorization under an IMMEDIATE write lock, before checking generation', () => {
      peer['db'].pragma('busy_timeout = 0');
      const contexts: Parameters<MerchantAuthorize>[0][] = [];
      const authorize: MerchantAuthorize = (context) => {
        contexts.push(context);
        expect(store['db'].inTransaction).toBe(true);
        // A second writer cannot revoke authority between the final check and publication.
        expect(() => peer['db'].prepare('UPDATE schema_version SET applied_at=?').run(at(1))).toThrow(/locked|busy/i);
        return true;
      };
      expect(store.merchant.putEvidence({ ...access(), authorize, value: evidenceValue(), expectedRevision: null })).not.toBeNull();
      expect(contexts).toEqual([{ scope: SCOPE, now: NOW, generation: store.merchant.generation(SCOPE), visibility: VISIBILITY, sourceRefs: REFS }]);
      contexts.length = 0;
      expect(publishCache({ ...access(), expectedGeneration: 0, authorize, value: cacheValue() })).toBeNull();
      expect(contexts).toHaveLength(1);
    });

    it('does not commit when the authorization callback throws, denies, or is asynchronous at runtime', () => {
      const throws: MerchantAuthorize = () => { throw new Error('authority withdrawn'); };
      expect(() => store.merchant.putEvidence({ ...access(), authorize: throws, value: evidenceValue(), expectedRevision: null })).toThrow('authority withdrawn');
      expect(publishCache({ ...access(), authorize: DENY, value: cacheValue() })).toBeNull();
      const asynchronous = (() => Promise.resolve(true)) as unknown as MerchantAuthorize;
      expect(() => store.merchant.putEvidence({ ...access(), authorize: asynchronous, value: evidenceValue(), expectedRevision: null })).toThrow();
      expect(store.merchant.evidence({ ...access(), key: 'merchant-pattern-a' })).toBeNull();
      expect(store.merchant.cache({ ...access(), key: key() })).toBeNull();
    });

    it('cache hits do not consume search or spending reservations', () => {
      publishCache({ ...access(), value: cacheValue() });
      for (let i = 0; i < 10; i++) expect(peer.merchant.cache({ ...access(peer), key: key() })).not.toBeNull();
      expect(reserve('first-paid', { buckets: buckets(1, 2) }).status).toBe('admitted');
    });
  });

  describe('persistent request and worker identity', () => {
    it('deduplicates active requests across connections and preserves exact idempotent identity on reopen', () => {
      const first = admitted('request-a');
      expect(reserve('request-b', {}, peer)).toMatchObject({ status: 'pending', attempt: { id: first.id } });
      expect(reserve('request-a', {}, peer)).toMatchObject({ status: 'admitted', attempt: { id: first.id, reservedCostAtoms: '250000' } });
      expect(() => reserve('request-a', { key: key(SCOPE, '4'.repeat(64)) }, peer)).toThrow();
      peer.close();
      peer = new SqliteWorkflowStore(filename);
      expect(reserve('request-a', {}, peer)).toMatchObject({ status: 'admitted', attempt: { id: first.id } });
      expect(reserve('next-charge', { key: key(SCOPE, '5'.repeat(64)), buckets: buckets(100, 1) }, peer)).toEqual({ status: 'denied', reason: 'daily_cap' });
    });

    it('grants only one live claim and rejects wrong-token, expired-token and duplicate dispatch', () => {
      const first = admitted('request-a');
      const claim = claimed(first);
      expect(peer.merchant.claimAttempt({ ...access(peer), id: first.id })).toBeNull();
      expect(peer.merchant.dispatchAttempt({ ...access(peer), id: first.id, claimToken: 'wrong-worker' })).toBe(false);
      expect(store.merchant.dispatchAttempt({ ...access(), id: first.id, claimToken: claim.claimToken })).toBe(true);
      expect(peer.merchant.dispatchAttempt({ ...access(peer, SCOPE, at(1)), id: first.id, claimToken: claim.claimToken })).toBe(false);
      expect(peer.merchant.claimAttempt({ ...access(peer, SCOPE, at(31)), id: first.id })).toBeNull();
      expect(peer.merchant.putCache({ ...access(peer, SCOPE, at(31)), attemptId: first.id, claimToken: claim.claimToken, value: cacheValue({ expiresAt: at(3600) }) })).toBeNull();
    });

    it.each([false, true])('reconciles expired reserved crash-before-dispatch without stranding daily searches or exact cost (claimed=%s)', (owned) => {
      const originalInput = { ...access(), idempotencyKey: 'crash-before-dispatch', key: key(), sourceRefs: REFS,
        policyVersion: 1, tariff: { ...TARIFF, costAtoms: '1000000' }, buckets: buckets(1, 1) };
      const original = store.merchant.reserveAttempt(originalInput);
      expect(original.status).toBe('admitted');
      if (original.status !== 'admitted') throw new Error('Expected durable crash fixture reservation');
      const claim = owned ? claimed(original.attempt) : null;
      peer.close(); peer = new SqliteWorkflowStore(filename);
      expect(peer.merchant.reserveAttempt({ ...originalInput, ...access(peer, SCOPE, at(29)), idempotencyKey: 'live-overlap' }))
        .toMatchObject({ status: 'pending', attempt: { id: original.attempt.id, phase: 'reserved' } });
      expect(reserve('live-quota-full', { now: at(29), key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1, 1) }, peer))
        .toEqual({ status: 'denied', reason: 'daily_cap' });
      const replayInput = { ...originalInput, ...access(peer, SCOPE, at(31)) };
      const replay = peer.merchant.reserveAttempt(replayInput);
      expect(replay).toMatchObject({ status: 'admitted', attempt: { id: original.attempt.id, phase: 'known_failed',
        reservedCostAtoms: '1000000', settledCostAtoms: '0', claimToken: null, dispatchedAt: null } });
      expect(peer.merchant.claimAttempt({ ...access(peer, SCOPE, at(31)), id: original.attempt.id })).toBeNull();
      if (claim) expect(store.merchant.dispatchAttempt({ ...access(store, SCOPE, at(31)), id: claim.id, claimToken: claim.claimToken })).toBe(false);
      expect(peer.merchant.reserveAttempt(replayInput)).toEqual(replay);
      expect(peer['db'].prepare("SELECT COUNT(*) AS count FROM merchant_research_attempts WHERE phase!='known_failed'").get()).toEqual({ count: 0 });
      expect(peer['db'].prepare('SELECT phase,reserved_atoms,settled_atoms,dispatched_at,claim_token FROM merchant_research_attempts WHERE id=?').get(original.attempt.id))
        .toEqual({ phase: 'known_failed', reserved_atoms: '1000000', settled_atoms: '0', dispatched_at: null, claim_token: null });
      const fresh = admitted('explicit-fresh-after-crash', { now: at(31), key: key(SCOPE, '4'.repeat(64)),
        buckets: buckets(1, 1), tariff: { ...TARIFF, costAtoms: '1000000' } }, peer);
      expect(fresh.id).not.toBe(original.attempt.id);
      expect(peer.merchant.reserveAttempt(replayInput)).toEqual(replay);
      expect(peer.merchant.attempt({ ...access(peer, SCOPE, at(31)), id: fresh.id })).toMatchObject({ phase: 'reserved', reservedCostAtoms: '1000000' });
    });

    it('cannot publish with another claim/key or after settlement even when authority and generation still hold', () => {
      const claim = dispatch(admitted('publication'));
      const input = { ...access(), attemptId: claim.id, claimToken: claim.claimToken, value: cacheValue() };
      expect(store.merchant.putCache({ ...input, claimToken: 'wrong-worker' })).toBeNull();
      expect(store.merchant.putCache({ ...input, value: cacheValue({ key: key(SCOPE, '4'.repeat(64)) }) })).toBeNull();
      expect(store.merchant.cache({ ...access(), key: key() })).toBeNull();
      expect(store.merchant.putCache(input)).not.toBeNull();
      expect(store.merchant.settleAttempt({ ...access(), id: claim.id, claimToken: claim.claimToken, outcome: { phase: 'succeeded', costAtoms: '250000' } })).toBe(true);
      expect(peer.merchant.putCache({ ...input, ...access(peer, SCOPE, at(1)), value: cacheValue({ retrievedAt: at(1), expiresAt: at(3601) }) })).toBeNull();
      expect(peer.merchant.cache({ ...access(peer), key: key() })).toMatchObject({ retrievedAt: NOW, expiresAt: at(3600) });
    });

    it('fences an expired undispatched claim, safely abandons only unclaimed work, and never abandons sent work', () => {
      const first = admitted('request-a');
      const claim = claimed(first);
      expect(peer.merchant.abandonAttempt({ ...access(peer), id: first.id })).toBe(false);
      expect(peer.merchant.abandonAttempt({ ...access(peer, SCOPE, at(30)), id: first.id })).toBe(true);
      expect(store.merchant.dispatchAttempt({ ...access(store, SCOPE, at(30)), id: first.id, claimToken: claim.claimToken })).toBe(false);
      const sent = admitted('sent', { key: key(SCOPE, '4'.repeat(64)), now: at(30) });
      dispatch(sent, store, at(30));
      expect(peer.merchant.abandonAttempt({ ...access(peer, SCOPE, at(60)), id: sent.id })).toBe(false);
    });

    it('releases a live undispatched reservation only for its current authorized owner, never a sent attempt', () => {
      const claim = claimed(admitted('owned-release'));
      const input = { ...access(peer), id: claim.id, claimToken: claim.claimToken };
      expect(peer.merchant.abandonAttempt({ ...input, claimToken: 'wrong-worker' })).toBe(false);
      expect(peer.merchant.abandonAttempt({ ...input, authorize: DENY })).toBe(false);
      expect(peer.merchant.abandonAttempt({ ...input, expectedGeneration: input.expectedGeneration + 1 })).toBe(false);
      expect(peer.merchant.attempt({ ...access(peer), id: claim.id })).toMatchObject({ phase: 'reserved', claimToken: claim.claimToken, settledCostAtoms: null });
      expect(peer.merchant.abandonAttempt(input)).toBe(true);
      expect(store.merchant.attempt({ ...access(), id: claim.id })).toMatchObject({ phase: 'known_failed', claimToken: null, settledCostAtoms: '0', dispatchedAt: null });
      expect(store.merchant.dispatchAttempt({ ...access(), id: claim.id, claimToken: claim.claimToken })).toBe(false);
      const sent = dispatch(admitted('sent-owner-release', { key: key(SCOPE, '4'.repeat(64)) }));
      expect(peer.merchant.abandonAttempt({ ...access(peer), id: sent.id, claimToken: sent.claimToken })).toBe(false);
      expect(peer.merchant.abandonAttempt({ ...access(peer, SCOPE, at(31)), id: sent.id, claimToken: sent.claimToken })).toBe(false);
      expect(peer.merchant.attempt({ ...access(peer, SCOPE, at(31)), id: sent.id })).toMatchObject({ phase: 'uncertain', reservedCostAtoms: '250000', settledCostAtoms: null });
    });

    it.each(['policy', 'purge'] as const)('settles live-owner proven-unsent marked work after %s without financial rights or content resurrection', (change) => {
      const claim = dispatch(admitted('marked-unsent', { tariff: { ...TARIFF, costAtoms: '1000000' }, buckets: buckets(1, 1) }));
      const originalAccess = access();
      const owner = { scope: SCOPE, now: NOW, expectedGeneration: claim.generation, id: claim.id, claimToken: claim.claimToken };
      if (change === 'policy') configure(store, SCOPE, { ...POLICY, mode: 'disabled' });
      else store.merchant.purge(originalAccess);
      expect(store.merchant.attempt({ ...access(store, SCOPE, NOW, DENY), id: claim.id })).toBeNull();
      expect(peer.merchant.releaseUnsentAttempt({ ...owner, claimToken: 'wrong-worker' })).toBe(false);
      expect(peer.merchant.releaseUnsentAttempt(owner)).toBe(true);
      expect(peer['db'].prepare('SELECT phase,settled_atoms,claim_token,content_deleted,generation FROM merchant_research_attempts WHERE id=?').get(claim.id))
        .toEqual({ phase: 'known_failed', settled_atoms: '0', claim_token: null, content_deleted: change === 'purge' ? 1 : 0, generation: claim.generation });
      expect(store.merchant.putCache({ ...originalAccess, attemptId: claim.id, claimToken: claim.claimToken, value: cacheValue() })).toBeNull();
      expect(peer.merchant.releaseUnsentAttempt(owner)).toBe(false);
      configure(store, SCOPE, POLICY, at(1));
      const policy = store.merchant.policy(access(store, SCOPE, at(1)))!;
      const fresh = admitted('explicit-after-unsent-cleanup', { now: at(1), policyVersion: policy.version, key: key(SCOPE, '4'.repeat(64)),
        tariff: { ...TARIFF, costAtoms: '1000000' }, buckets: buckets(1, 1) }, peer);
      expect(fresh.id).not.toBe(claim.id);
    });

    it('rejects wrong-scope, wrong-generation and expired unsent owner proof without refunding marked billing', () => {
      const claim = dispatch(admitted('guarded-unsent-proof', { tariff: { ...TARIFF, costAtoms: '1000000' }, buckets: buckets(1, 1) }));
      const owner = { scope: SCOPE, now: NOW, expectedGeneration: claim.generation, id: claim.id, claimToken: claim.claimToken };
      expect(peer.merchant.releaseUnsentAttempt({ ...owner, scope: { ...SCOPE, connectionId: 'wrong-connection' } })).toBe(false);
      expect(peer.merchant.releaseUnsentAttempt({ ...owner, expectedGeneration: claim.generation + 1 })).toBe(false);
      expect(peer.merchant.releaseUnsentAttempt({ ...owner, claimToken: 'wrong-worker' })).toBe(false);
      expect(peer.merchant.releaseUnsentAttempt({ ...owner, now: at(30) })).toBe(false);
      expect(peer.merchant.attempt({ ...access(peer, SCOPE, at(30)), id: claim.id })).toMatchObject({ phase: 'uncertain', reservedCostAtoms: '1000000', settledCostAtoms: null });
      expect(reserve('cannot-spend-expired-owner-charge', { now: at(30), key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1, 1) }, peer))
        .toEqual({ status: 'denied', reason: 'daily_cap' });
    });

    it('persists never-invoked worker proof across reopen without erasing dispatch markers or promoting provider billing evidence', () => {
      const unsent = dispatch(admitted('worker-never-invoked'));
      expect(store.merchant.releaseUnsentAttempt({ scope: SCOPE, now: NOW, expectedGeneration: unsent.generation,
        id: unsent.id, claimToken: unsent.claimToken })).toBe(true);
      const provider = dispatch(admitted('provider-not-billed', { now: at(1), key: key(SCOPE, '4'.repeat(64)) }), store, at(1));
      const forgedOutcome = { phase: 'known_failed' as const, costAtoms: '0' as const, providerEvidence: 'not_billed' as const, workerEvidence: 'not_invoked' };
      expect(() => store.merchant.settleAttempt({ ...access(store, SCOPE, at(1)), id: provider.id, claimToken: provider.claimToken, outcome: forgedOutcome })).toThrow();
      expect(store.merchant.settleAttempt({ ...access(store, SCOPE, at(1)), id: provider.id, claimToken: provider.claimToken,
        outcome: { phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' } })).toBe(true);
      peer.close(); peer = new SqliteWorkflowStore(filename);
      expect(reserve('worker-never-invoked', { now: at(31) }, peer)).toMatchObject({ status: 'admitted', attempt: {
        id: unsent.id, phase: 'known_failed', settledCostAtoms: '0', dispatchedAt: NOW, invocationEvidence: 'not_invoked', claimToken: null,
      } });
      expect(reserve('provider-not-billed', { now: at(31), key: key(SCOPE, '4'.repeat(64)) }, peer)).toMatchObject({ status: 'admitted', attempt: {
        id: provider.id, phase: 'known_failed', settledCostAtoms: '0', dispatchedAt: at(1), invocationEvidence: null,
      } });
    });

    it('atomically settles once using stored dependencies, retained claim identity and maximum reserved atoms', () => {
      const first = dispatch(admitted('request-a'));
      const authorize: MerchantAuthorize = ({ sourceRefs }) => { expect(sourceRefs).toEqual(REFS); return true; };
      const input = { ...access(peer), authorize, id: first.id, claimToken: first.claimToken, outcome: { phase: 'succeeded' as const, costAtoms: '200000' } };
      expect(peer.merchant.settleAttempt({ ...input, claimToken: 'wrong-worker' })).toBe(false);
      expect(() => peer.merchant.settleAttempt({ ...input, outcome: { phase: 'succeeded', costAtoms: '250001' } })).toThrow();
      expect(peer.merchant.settleAttempt(input)).toBe(true);
      expect(store.merchant.settleAttempt({ ...input, ...access() })).toBe(true);
      expect(store.merchant.settleAttempt({ ...input, ...access(), outcome: { phase: 'succeeded', costAtoms: '1' } })).toBe(false);
      expect(store.merchant.attempt({ ...access(), id: first.id })).toMatchObject({ phase: 'succeeded', settledCostAtoms: '200000' });
      expect(store.merchant.attempt({ ...access(store, { ...SCOPE, connectionId: 'elsewhere' }), id: first.id })).toBeNull();
    });

    it('only evidenced zero-charge failure releases cost; unknown failure remains charged and dedup expiry never retries', () => {
      const first = dispatch(admitted('request-a', { buckets: buckets(1), tariff: { ...TARIFF, costAtoms: '1000000' } }));
      expect(peer.merchant.settleAttempt({ ...access(peer), id: first.id, claimToken: first.claimToken, outcome: { phase: 'uncertain' } })).toBe(true);
      expect(reserve('new-request', { now: at(31), buckets: buckets(1), key: key(SCOPE, '4'.repeat(64)) })).toEqual({ status: 'denied', reason: 'monthly_cap' });
      expect(reserve('request-a', { now: at(31), buckets: buckets(1), tariff: { ...TARIFF, costAtoms: '1000000' } })).toMatchObject({ status: 'admitted', attempt: { id: first.id, phase: 'uncertain' } });
      expect(peer.merchant.claimAttempt({ ...access(peer, SCOPE, at(31)), id: first.id })).toBeNull();
    });

    it('ends dedup/concurrency leases without retransmitting or releasing crashed dispatch charges', () => {
      const one = dispatch(admitted('crashed-one', { buckets: buckets(1) }));
      dispatch(admitted('crashed-two', { now: at(1), key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1) }), peer, at(1));
      const explicit = admitted('explicit-after-expiry', { now: at(31), buckets: buckets(1) }, peer);
      expect(explicit.id).not.toBe(one.id);
      dispatch(explicit, peer, at(31));
      expect(store.merchant.dispatchAttempt({ ...access(store, SCOPE, at(31)), id: one.id, claimToken: one.claimToken })).toBe(false);
      expect(store.merchant.attempt({ ...access(store, SCOPE, at(31)), id: one.id })?.phase).toBe('uncertain');
      admitted('fourth-quarter', { now: at(31), key: key(SCOPE, '5'.repeat(64)), buckets: buckets(1) });
      expect(reserve('fifth-retained-charge', { now: at(31), key: key(SCOPE, '6'.repeat(64)), buckets: buckets(1) })).toEqual({ status: 'denied', reason: 'monthly_cap' });
    });

    it.each([null, 'actor-a'] as const)('removes merchant-derived attempt fingerprints at 30 days for visibility %s without losing an unresolved charge', (privateActorId) => {
      const first = dispatch(admitted('retention-boundary', {
        visibility: { ...VISIBILITY, privateActorId },
      }));
      const inspection = new Database(filename, { readonly: true });
      try {
        const retained = inspection.prepare('SELECT key_hash,intent_hash,source_refs,visibility,content_deleted,phase,reserved_atoms,settled_atoms FROM merchant_research_attempts WHERE id=?');
        store.merchant.prune({ now: at(30 * 86400 - 1) });
        expect(retained.get(first.id)).not.toMatchObject({ key_hash: '0'.repeat(64) });
        store.merchant.prune({ now: at(30 * 86400) });
        const row = retained.get(first.id);
        expect(row).toMatchObject({
          key_hash: '0'.repeat(64), intent_hash: '0'.repeat(64), content_deleted: 1,
          visibility: JSON.stringify({ hash: '0'.repeat(64), privateActorId: null }),
          phase: 'uncertain', reserved_atoms: TARIFF.costAtoms, settled_atoms: null,
        });
        expect(JSON.stringify(row)).not.toContain('account-private');
        expect(store.merchant.attempt({ ...access(store, SCOPE, at(30 * 86400)), visibility: { ...VISIBILITY, privateActorId }, id: first.id })).toBeNull();
        expect(reserve('retention-boundary', { now: at(30 * 86400), visibility: { ...VISIBILITY, privateActorId } }))
          .toEqual({ status: 'denied', reason: 'unauthorized' });
      } finally { inspection.close(); }
    });

    it('retains crash-ambiguous charges beyond operational and billing retention without automatic retransmission', () => {
      const first = dispatch(admitted('crashed', { buckets: buckets(1), tariff: { ...TARIFF, costAtoms: '1000000' } }));
      peer.close();
      peer = new SqliteWorkflowStore(filename);
      peer.merchant.prune({ now: at(31) });
      expect(peer.merchant.attempt({ ...access(peer, SCOPE, at(31)), id: first.id })?.phase).toBe('uncertain');
      expect(reserve('after-crash', { now: at(31), key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1) }, peer)).toEqual({ status: 'denied', reason: 'monthly_cap' });
      peer.merchant.prune({ now: '2026-06-01T00:00:00.000Z' });
      expect(peer.merchant.attempt({ ...access(peer, SCOPE, '2026-06-01T00:00:00.000Z'), id: first.id })).toBeNull();
      const inspection = new Database(filename, { readonly: true });
      try {
        expect(inspection.prepare('SELECT phase,reserved_atoms,content_deleted FROM merchant_research_attempts WHERE id=?').get(first.id))
          .toEqual({ phase: 'uncertain', reserved_atoms: '1000000', content_deleted: 1 });
      } finally { inspection.close(); }
    });
  });

  describe('exact atoms, shared scopes and UTC windows', () => {
    it('accumulates fractional minor-unit charges exactly and atomically denies the fifth quarter-cent', () => {
      for (let i = 0; i < 4; i++) admitted(`quarter-${i}`, { key: key(SCOPE, String(i).repeat(64)), buckets: buckets(1) }, i % 2 ? peer : store);
      expect(reserve('fifth', { key: key(SCOPE, '6'.repeat(64)), buckets: buckets(1) }, peer)).toEqual({ status: 'denied', reason: 'monthly_cap' });
    });

    it('handles atom values beyond Number safe integer without rounding', () => {
      configure(store, SCOPE, { ...POLICY, maxSpendMinorUnitsPerMonth: Number.MAX_SAFE_INTEGER });
      const costAtoms = '9007199254740993';
      expect(admitted('large-exact', { policyVersion: 2, tariff: { ...TARIFF, costAtoms }, buckets: buckets(Number.MAX_SAFE_INTEGER) }).reservedCostAtoms).toBe(costAtoms);
    });

    it('shares budget counters across connection replacement and actor changes', () => {
      admitted('original', { buckets: buckets(1, 1) });
      const scope = { ...SCOPE, connectionId: 'replacement' };
      configure(peer, scope);
      expect(reserve('replacement', { ...access(peer, scope), actorId: 'actor-b', key: key(scope), buckets: buckets(1, 1) }, peer)).toEqual({ status: 'denied', reason: 'daily_cap' });
    });

    it.each(['installation', 'space', 'credential'] as const)('shares %s caps across otherwise independent budgets', (kind) => {
      const originalBuckets = buckets().map((bucket) => bucket.kind === kind ? { ...bucket, maxSearchesPerDay: 1 } : bucket);
      admitted('first-budget', { buckets: originalBuckets });
      const scope = { ...SCOPE, budgetId: 'budget-b', connectionId: 'actual-b' };
      configure(peer, scope);
      const nextBuckets = originalBuckets.map((bucket) => bucket.kind === 'budget' ? { ...bucket, id: `${scope.spaceId}/${scope.budgetId}` } : bucket);
      expect(reserve('second-budget', { ...access(peer, scope), key: key(scope), buckets: nextBuckets }, peer)).toEqual({ status: 'denied', reason: 'daily_cap' });
    });

    it('enforces every configured delegation cap without permitting actor replacement to reset it', () => {
      const delegated: MerchantQuotaBucket[] = [
        ...buckets(),
        { kind: 'delegation', id: 'delegation-parent', maxSearchesPerDay: 2, maxSpendMinorUnitsPerMonth: 100 },
        { kind: 'delegation', id: 'delegation-child', maxSearchesPerDay: 1, maxSpendMinorUnitsPerMonth: 100 },
      ];
      admitted('delegated-first', { buckets: delegated });
      expect(reserve('delegated-second', { actorId: 'actor-b', key: key(SCOPE, '4'.repeat(64)), buckets: delegated }, peer)).toEqual({ status: 'denied', reason: 'daily_cap' });
      expect(() => reserve('duplicate-delegation', { buckets: [...delegated, delegated[4]!] })).toThrow();
    });

    it('rolls daily/monthly counters at UTC boundaries, not elapsed duration or budget time zone', () => {
      const before = '2026-01-31T23:59:59.999Z';
      const after = '2026-02-01T00:00:00.000Z';
      admitted('january', { now: before, buckets: buckets(1, 1), tariff: { ...TARIFF, costAtoms: '1000000' } });
      const february = admitted('february', { now: after, key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1, 1), tariff: { ...TARIFF, costAtoms: '1000000' } }, peer);
      expect(february.createdAt).toBe(after);
      expect(reserve('february-second', { now: after, key: key(SCOPE, '5'.repeat(64)), buckets: buckets(1, 1) })).toMatchObject({ status: 'denied' });
    });

    it('resets daily searches without resetting fractional monthly spend on ordinary UTC midnights', () => {
      for (let day = 16; day < 20; day++) {
        const now = `2026-01-${day}T00:00:00.000Z`;
        const charge = dispatch(admitted(`utc-day-${day}`, { now, key: key(SCOPE, String(day - 16).repeat(64)), buckets: buckets(1, 1) }), store, now);
        expect(store.merchant.settleAttempt({ ...access(store, SCOPE, now), id: charge.id, claimToken: charge.claimToken,
          outcome: { phase: 'succeeded', costAtoms: TARIFF.costAtoms } })).toBe(true);
      }
      expect(reserve('utc-new-day-month-full', { now: '2026-01-20T00:00:00.000Z', key: key(SCOPE, '5'.repeat(64)), buckets: buckets(1, 1) })).toEqual({ status: 'denied', reason: 'monthly_cap' });
    });

    it('releases known-not-billed cost/search in original window without reducing new-window charges', () => {
      const january = dispatch(admitted('january', { buckets: buckets(1, 1), tariff: { ...TARIFF, costAtoms: '1000000' } }));
      admitted('february', { now: '2026-02-01T00:00:00.000Z', key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1, 1), tariff: { ...TARIFF, costAtoms: '1000000' } });
      expect(peer.merchant.settleAttempt({ ...access(peer, SCOPE, '2026-02-01T00:00:01.000Z'), id: january.id, claimToken: january.claimToken, outcome: { phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' } })).toBe(true);
      expect(reserve('february-still-full', { now: '2026-02-01T00:00:02.000Z', key: key(SCOPE, '5'.repeat(64)), buckets: buckets(1, 1) })).toMatchObject({ status: 'denied' });
    });

    it('persists one launch/sec credential limit and two installation/credential concurrency slots', () => {
      const one = dispatch(admitted('one'));
      const two = claimed(admitted('two', { key: key(SCOPE, '4'.repeat(64)) }), peer);
      expect(peer.merchant.dispatchAttempt({ ...access(peer, SCOPE, at(0.999)), id: two.id, claimToken: two.claimToken })).toBe(false);
      expect(peer.merchant.dispatchAttempt({ ...access(peer, SCOPE, at(1)), id: two.id, claimToken: two.claimToken })).toBe(true);
      peer.close();
      peer = new SqliteWorkflowStore(filename);
      const three = claimed(admitted('three', { key: key(SCOPE, '5'.repeat(64)), now: at(2) }), peer, at(2));
      expect(peer.merchant.dispatchAttempt({ ...access(peer, SCOPE, at(2)), id: three.id, claimToken: three.claimToken })).toBe(false);
      expect(store.merchant.settleAttempt({ ...access(store, SCOPE, at(2)), id: one.id, claimToken: one.claimToken, outcome: { phase: 'succeeded', costAtoms: '250000' } })).toBe(true);
      expect(peer.merchant.dispatchAttempt({ ...access(peer, SCOPE, at(2)), id: three.id, claimToken: three.claimToken })).toBe(true);
    });

    it.each(['actor-proof', 'budget-proof', 'actor-expiry', 'budget-expiry'] as const)('keeps deleted unsettled owner slots occupied across peer budget dispatch until %s release', async (change) => {
      await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'quota-slot-lifecycle' });
      await store.finalizeBootstrap({ claimId: 'quota-slot-lifecycle', ownerUserId: 'actor-a' });
      const auth = { method: 'human-session' as const, actorId: 'actor-a', sessionId: 'quota-slot-owner', reauthenticatedAt: NOW };
      const space = store.governance.createSpace({ actorId: 'actor-a', name: 'Quota slots', kind: 'shared', now: NOW, auth });
      store.governance.bindBudget({ spaceId: space.id, budgetId: SCOPE.budgetId, now: NOW, auth });
      const ownerScope = { ...SCOPE, spaceId: space.id };
      configure(store, ownerScope);
      const ownerBuckets = buckets().map((bucket) => bucket.kind === 'space' ? { ...bucket, id: ownerScope.spaceId }
        : bucket.kind === 'budget' ? { ...bucket, id: `${ownerScope.spaceId}/${ownerScope.budgetId}` } : bucket);
      const visibility = { ...VISIBILITY, privateActorId: 'actor-a' };
      const one = dispatch(admitted('deleted-live-one', { ...access(store, ownerScope), visibility, key: key(ownerScope), buckets: ownerBuckets }));
      const two = dispatch(admitted('deleted-live-two', { ...access(store, ownerScope, at(1)), visibility, key: key(ownerScope, '4'.repeat(64)), buckets: ownerBuckets }), store, at(1));
      const peerSpace = store.governance.createSpace({ actorId: 'actor-a', name: 'Peer quota slots', kind: 'shared', now: NOW, auth });
      const peerScope = { ...SCOPE, spaceId: peerSpace.id, budgetId: 'budget-peer', connectionId: 'actual-peer' };
      store.governance.bindBudget({ spaceId: peerSpace.id, budgetId: peerScope.budgetId, now: NOW, auth });
      configure(peer, peerScope);
      if (change.startsWith('actor')) await store.deleteScopeData('user', { spaceId: ownerScope.spaceId, budgetId: ownerScope.budgetId, actorId: 'actor-a' });
      else store.merchant.purgeBudget(access(store, ownerScope));
      expect(store['db'].prepare('SELECT phase,outcome,claim_token,settled_atoms FROM merchant_research_attempts WHERE id IN (?,?) ORDER BY created_at').all(one.id, two.id))
        .toEqual([{ phase: 'uncertain', outcome: null, claim_token: one.claimToken, settled_atoms: null },
          { phase: 'uncertain', outcome: null, claim_token: two.claimToken, settled_atoms: null }]);
      const peerBuckets = ownerBuckets.map((bucket) => bucket.kind === 'space' ? { ...bucket, id: peerScope.spaceId }
        : bucket.kind === 'budget' ? { ...bucket, id: `${peerScope.spaceId}/${peerScope.budgetId}` } : bucket);
      const third = claimed(admitted('peer-third-slot', { ...access(peer, peerScope, at(2)), key: key(peerScope, '5'.repeat(64)), buckets: peerBuckets }, peer), peer, at(2));
      expect(peer.merchant.dispatchAttempt({ ...access(peer, peerScope, at(2)), id: third.id, claimToken: third.claimToken })).toBe(false);
      if (change.endsWith('proof')) {
        expect(store.merchant.releaseUnsentAttempt({ scope: ownerScope, now: at(2), expectedGeneration: one.generation, id: one.id, claimToken: one.claimToken })).toBe(true);
        expect(peer.merchant.dispatchAttempt({ ...access(peer, peerScope, at(2)), id: third.id, claimToken: third.claimToken })).toBe(true);
      } else {
        expect(peer.merchant.dispatchAttempt({ ...access(peer, peerScope, at(31)), id: third.id, claimToken: third.claimToken })).toBe(true);
        expect(store['db'].prepare('SELECT phase,settled_atoms FROM merchant_research_attempts WHERE id IN (?,?) ORDER BY created_at').all(one.id, two.id))
          .toEqual([{ phase: 'uncertain', settled_atoms: null }, { phase: 'uncertain', settled_atoms: null }]);
      }
    });

    it('distinguishes terminal uncertain settlement from deleted unsettled live concurrency occupancy', () => {
      dispatch(admitted('still-live-owner'));
      const terminal = dispatch(admitted('finished-uncertain-owner', { now: at(1), key: key(SCOPE, '4'.repeat(64)) }), store, at(1));
      expect(store.merchant.settleAttempt({ ...access(store, SCOPE, at(1)), id: terminal.id, claimToken: terminal.claimToken, outcome: { phase: 'uncertain' } })).toBe(true);
      store.merchant.purgeBudget(access());
      const peerScope = { ...SCOPE, budgetId: 'budget-peer', connectionId: 'actual-peer' };
      configure(peer, peerScope);
      const peerBuckets = buckets().map((bucket) => bucket.kind === 'budget' ? { ...bucket, id: `${peerScope.spaceId}/${peerScope.budgetId}` } : bucket);
      dispatch(admitted('peer-available-slot', { ...access(peer, peerScope, at(2)), key: key(peerScope, '5'.repeat(64)), buckets: peerBuckets }, peer), peer, at(2));
      const fourth = claimed(admitted('peer-fourth-slot', { ...access(peer, peerScope, at(3)), key: key(peerScope, '6'.repeat(64)), buckets: peerBuckets }, peer), peer, at(3));
      expect(peer.merchant.dispatchAttempt({ ...access(peer, peerScope, at(3)), id: fourth.id, claimToken: fourth.claimToken })).toBe(false);
    });

    it.each(['installation', 'credential'] as const)('enforces the independent %s concurrency bucket', (shared) => {
      for (let index = 0; index < 3; index++) {
        const caps = buckets().map((bucket) => (bucket.kind === 'installation' || bucket.kind === 'credential') && bucket.kind !== shared
          ? { ...bucket, id: `${bucket.id}-${index}` } : bucket);
        const attempt = admitted(`independent-slot-${index}`, { now: at(index), key: key(SCOPE, String(index).repeat(64)), buckets: caps });
        const claim = claimed(attempt, store, at(index));
        expect(store.merchant.dispatchAttempt({ ...access(store, SCOPE, at(index)), id: attempt.id, claimToken: claim.claimToken })).toBe(index < 2);
      }
    });
  });

  describe('strict malformed boundary and fail-closed configuration', () => {
    it.each([
      { maxSearchesPerDay: -1 }, { maxSearchesPerDay: 0.5 }, { maxSearchesPerDay: Infinity },
      { maxSearchesPerDay: Number.MAX_SAFE_INTEGER + 1 }, { maxSpendMinorUnitsPerMonth: NaN },
      { maxSpendMinorUnitsPerMonth: -1 }, { cacheTtlHours: 0 }, { cacheTtlHours: 721 },
      { billingCurrency: '' }, { billingCurrency: 'usd' },
    ])('rejects invalid policy without changing revision or generation: %j', (invalid) => {
      const current = store.merchant.policy(access())!;
      expect(() => store.merchant.setPolicy({ ...access(), expectedVersion: current.version, value: { ...POLICY, ...invalid } })).toThrow();
      expect(store.merchant.policy(access())).toEqual(current);
    });

    it.each([{ maxSearchesPerDay: 0 }, { maxSpendMinorUnitsPerMonth: 0 }])('zero caps forbid paid dispatch: %j', (zero) => {
      configure(store, SCOPE, { ...POLICY, ...zero });
      expect(reserve('zero', { policyVersion: 2 }).status).toBe('denied');
    });

    it('denies absent opt-in, unknown tariff, provider mismatch and billing currency mismatch', () => {
      const scope = { ...SCOPE, connectionId: 'not-opted-in' };
      expect(reserve('no-policy', { ...access(store, scope), key: key(scope) }).status).toBe('denied');
      expect(reserve('unknown-pricing', { tariff: null })).toEqual({ status: 'denied', reason: 'unknown_pricing' });
      expect(reserve('wrong-provider', { key: { ...key(), providerId: 'unreviewed' } })).toEqual({ status: 'denied', reason: 'policy' });
      expect(reserve('wrong-currency', { tariff: { ...TARIFF, billingCurrency: 'CAD' } }).status).toBe('denied');
    });

    it.each(['-1', '0', '1.5', 'NaN', 'Infinity', '01', '1e6', ''])('rejects noncanonical positive tariff atoms %j', (costAtoms) => {
      expect(() => reserve('invalid-atoms', { tariff: { ...TARIFF, costAtoms } })).toThrow();
      expect(reserve('valid-after-invalid', { buckets: buckets(1, 1) }).status).toBe('admitted');
    });

    it('rejects missing/duplicate quota buckets and cross-scope bucket/cache identities', () => {
      expect(() => reserve('missing-credential', { buckets: buckets().filter((bucket) => bucket.kind !== 'credential') })).toThrow();
      expect(() => reserve('duplicate', { buckets: [...buckets(), buckets()[0]!] })).toThrow();
      expect(() => reserve('wrong-budget', { buckets: buckets().map((bucket) => bucket.kind === 'budget' ? { ...bucket, id: 'unrelated-budget' } : bucket) })).toThrow();
      expect(() => reserve('wrong-cache-scope', { key: key({ ...SCOPE, budgetId: 'other' }) })).toThrow();
    });

    it('rejects extra sensitive fields, unsafe links, oversized strings and unsupported evidence facts', () => {
      expect(() => publishCache({ ...access(), value: { ...cacheValue(), query: 'SENTINEL_PRIVATE_QUERY', apiKey: 'SENTINEL_SECRET' } as unknown as Omit<MerchantEnrichment, 'generation'> })).toThrow();
      for (const url of ['javascript:alert(1)', 'data:text/html,secret', 'https://user:secret@merchant.example/']) {
        expect(() => publishCache({ ...access(), value: cacheValue({ sources: [{ url, title: 'x', snippet: 'x' }] }) })).toThrow();
      }
      expect(() => publishCache({ ...access(), value: cacheValue({ sources: [{ url: 'https://merchant.example', title: 'x'.repeat(257), snippet: 'x' }] }) })).toThrow();
      expect(() => publishCache({ ...access(), value: cacheValue({ sources: Array.from({ length: 11 }, () => ({ url: 'https://merchant.example', title: 'x', snippet: 'x' })) }) })).toThrow();
      expect(() => store.merchant.putEvidence({ ...access(), now: 'not-a-date', value: evidenceValue(), expectedRevision: null })).toThrow();
      expect(() => store.merchant.decide({ ...access(), id: 'bad-deps', payload: ALIAS, sourceRefs: { ...REFS, transactionIds: [] }, state: 'accepted', expectedVersion: 0 })).toThrow();
      expect(store.merchant.cache({ ...access(), key: key() })).toBeNull();
      const withoutNormalizer = { ...ALIAS };
      if (withoutNormalizer.kind !== 'alias') throw new Error('Expected alias fixture');
      const { normalizationVersion: omitted, ...oldPayload } = withoutNormalizer;
      expect(omitted).toBe('merchant/2');
      expect(() => store.merchant.decide({ ...access(), id: 'unknown-normalizer', payload: oldPayload as MerchantDecisionPayload, sourceRefs: REFS, state: 'accepted', expectedVersion: 0 })).toThrow();
      expect(() => store.merchant.putEvidence({ ...access(), value: evidenceValue({ sourceRefs: { ...REFS, required: [] } }), expectedRevision: null })).toThrow();
    });
  });

  describe('merchant-derived Review and projection copy privacy', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => vi.useRealTimers());

    function derived(label: string, scope: MerchantScope, privateActorId: string | null, capturedAt = NOW, expiresAt = at(3600)) {
      return {
        merchantDerivation: { scope, privateActorId, capturedAt, expiresAt },
        sourceRevision: 'd'.repeat(64),
        merchantProof: {
          transactionId: label, accountId: fixture.transactions[0]!.accountId,
          payeeId: fixture.transactions[0]!.payeeId, categoryId: fixture.transactions[1]!.categoryId!,
          tier: 'inferred', evidenceRevision: 'd'.repeat(64),
          reviewContext: { scope },
        },
        merchantEvidence: { explanation: label },
        merchantAnalysis: { explanation: label },
        merchantIntelligence: { explanation: label },
        merchantEnrichment: { explanation: label },
        merchantResearch: { explanation: label },
        merchantRecurrences: [{ explanation: label }],
        merchantSuggestions: [{ explanation: label }],
      };
    }

    async function selectedScope(): Promise<MerchantScope> {
      await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'derived-copy-privacy' });
      await store.finalizeBootstrap({ claimId: 'derived-copy-privacy', ownerUserId: 'actor-a' });
      const auth = { method: 'human-session' as const, actorId: 'actor-a', sessionId: 'derived-copy-owner', reauthenticatedAt: NOW };
      const space = store.governance.createSpace({ actorId: 'actor-a', name: 'Derived copy privacy', kind: 'shared', now: NOW, auth });
      store.governance.bindBudget({ spaceId: space.id, budgetId: SCOPE.budgetId, now: NOW, auth });
      await store.upsertActorMembership('actor-b', 'active', [], 'unscoped');
      store.governance.addMembership({ spaceId: space.id, actorId: 'actor-b', validFrom: NOW, now: NOW, auth });
      const scope = { ...SCOPE, spaceId: space.id };
      configure(store, scope);
      return scope;
    }

    it.each([
      ['original expiry', 3600, at(3600)],
      ['maximum 30-day capture age', 30 * 86400, at(40 * 86400)],
    ] as const)('retires Review and nested projection copies inclusively at %s without using row age', async (_boundary, seconds, expiresAt) => {
      const scope = await selectedScope();
      const expired = derived('EXPIRED_PRIVATE_DERIVATION', scope, 'actor-a', NOW, expiresAt);
      const liveCapture = at(Math.min(seconds - 1, 86400));
      const live = derived('LIVE_PRIVATE_DERIVATION', scope, 'actor-b', liveCapture, at(41 * 86400));
      vi.setSystemTime(new Date(liveCapture));
      const money = { ...fixture.transactions[0]!.amount };
      const ids: string[] = [];
      for (const [index, rowTime] of [at(-40 * 86400), at(60 * 86400)].entries()) {
        const { merchantEvidence: _merchantEvidence, ...proofOnly } = expired;
        const item = await store.createReviewItem({
          budgetId: scope.budgetId, transactionId: `expiring-copy-${index}`,
          categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant',
          evidence: { ...(index === 0 ? expired : proofOnly), money, sourcePayeeId: fixture.transactions[0]!.payeeId },
          provenance: 'merchant-inferred',
        });
        store['db'].prepare('UPDATE review_items SET created_at=?,updated_at=? WHERE id=?').run(rowTime, rowTime, item.id);
        ids.push(item.id);
      }
      const nested = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'live-target-with-expiring-child',
        categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant',
        evidence: { ...live, money, related: [{ ...expired, note: 'ordinary nested content' }] },
        provenance: 'merchant-inferred',
      });
      const report = await store.createReportRecord({
        budgetId: scope.budgetId, reportType: 'merchant-review', policyVersion: 'fixture/1',
        config: { ...expired, money, related: [{ ...live, note: 'protected child' }] },
      });
      const before = await Promise.all(ids.map((id) => store.getReviewItem(id)));
      store.merchant.prune({ now: at(seconds - 0.001) });
      expect(await Promise.all(ids.map((id) => peer.getReviewItem(id)))).toEqual(before);
      expect(await peer.getReviewItem(nested.id)).toEqual(nested);
      expect(await peer.getReportRecord(report.id)).toEqual(report);

      store.merchant.prune({ now: at(seconds) });
      for (const id of ids) {
        expect(await peer.getReviewItem(id)).toMatchObject({
          categoryId: '', status: 'superseded', supersededReason: 'merchant_derived_content_deleted',
          evidence: { money, sourcePayeeId: fixture.transactions[0]!.payeeId },
        });
        expect((await peer.getReviewItem(id))?.evidence).toEqual({ money, sourcePayeeId: fixture.transactions[0]!.payeeId });
      }
      const retainedTarget = await peer.getReviewItem(nested.id);
      expect(retainedTarget).toMatchObject({ categoryId: nested.categoryId, status: nested.status });
      expect(retainedTarget?.evidence).toEqual({ ...live, money, related: [{ note: 'ordinary nested content' }] });
      const cleanedReport = await peer.getReportRecord(report.id);
      expect(cleanedReport).not.toBeNull();
      expect(JSON.parse(cleanedReport!.config)).toEqual({ money, related: [{ ...live, note: 'protected child' }] });
    });

    it.each(['actor deletion', 'connection purge'] as const)('preserves known foreign legacy namespaces during %s while retiring selected unattributed copies', async (operation) => {
      const scope = await selectedScope();
      const foreignScope = operation === 'actor deletion'
        ? { ...scope, spaceId: 'historical-foreign-space' }
        : { ...scope, connectionId: 'historical-foreign-connection' };
      const { merchantDerivation: _selectedMarker, ...selectedLegacy } = derived('SELECTED_LEGACY', scope, 'actor-a');
      const { merchantDerivation: _foreignMarker, ...foreignLegacy } = derived('FOREIGN_LEGACY', foreignScope, 'actor-b');
      const money = { ...fixture.transactions[0]!.amount };
      const selected = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'selected-legacy', categoryId: fixture.transactions[1]!.categoryId!,
        classifier: 'merchant', assignedReviewerId: 'actor-b', evidence: { ...selectedLegacy, money }, provenance: 'legacy merchant',
      });
      const foreign = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'foreign-legacy', categoryId: fixture.transactions[1]!.categoryId!,
        classifier: 'merchant', assignedReviewerId: 'actor-a',
        evidence: { ...foreignLegacy, money, related: [{ ...derived('SELECTED_CHILD', scope, 'actor-a'), note: 'canonical child note' }] },
        provenance: 'legacy merchant',
      });
      if (operation === 'actor deletion') await store.deleteScopeData('user', { ...scope, actorId: 'actor-a' });
      else store.merchant.purge(access(store, scope));
      expect(await peer.getReviewItem(selected.id)).toMatchObject({
        categoryId: '', status: 'superseded', supersededReason: 'merchant_derived_content_deleted', evidence: { money },
      });
      expect((await peer.getReviewItem(selected.id))?.evidence).toEqual({ money });
      const retained = await peer.getReviewItem(foreign.id);
      expect(retained).toMatchObject({ categoryId: foreign.categoryId, status: foreign.status, version: foreign.version });
      expect(retained?.evidence).toEqual({ ...foreignLegacy, money, related: [{ note: 'canonical child note' }] });
    });

    it('deletes private derivation owners rather than assigned reviewers and preserves exact financial history', async () => {
      const scope = await selectedScope();
      const auth = { method: 'human-session' as const, actorId: 'actor-a', sessionId: 'derived-copy-owner', reauthenticatedAt: NOW };
      const otherSpace = store.governance.createSpace({ actorId: 'actor-a', name: 'Other copy scope', kind: 'shared', now: NOW, auth });
      store.governance.bindBudget({ spaceId: otherSpace.id, budgetId: 'budget-other', now: NOW, auth });
      const otherScope = { ...scope, spaceId: otherSpace.id, budgetId: 'budget-other' };
      const privateA = derived('PRIVATE_ACTOR_A', scope, 'actor-a');
      const privateB = derived('PRIVATE_ACTOR_B', scope, 'actor-b');
      const shared = derived('EXPLICITLY_SHARED', scope, null);
      const historical = derived('PRIVATE_ACTOR_A_HISTORICAL_CONNECTION', { ...scope, connectionId: 'actual-historical' }, 'actor-a');
      const foreignSpace = derived('OTHER_SPACE_PRIVATE_ACTOR_A', { ...scope, spaceId: otherSpace.id }, 'actor-a');
      const otherBudget = derived('OTHER_BUDGET_PRIVATE_ACTOR_A', otherScope, 'actor-a');
      const transaction = fixture.transactions[0]!;
      const amount = BigInt(transaction.amount.minorUnits);
      const source: ReviewActionAuthorization['transaction'] = {
        id: transaction.id, accountId: transaction.accountId, categoryId: transaction.categoryId ?? null,
        direction: amount < 0n ? 'outgoing' : 'incoming',
        amount: { minorUnits: (amount < 0n ? -amount : amount).toString(), currency: transaction.amount.currency },
      };
      const financialEvidence = { money: transaction.amount, sourcePayeeId: transaction.payeeId, date: transaction.date };
      const unassigned = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: source.id, sourceTransaction: source,
        categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant',
        evidence: { ...privateA, ...financialEvidence }, provenance: 'merchant-inferred',
      });
      const preserved = [];
      for (const [name, bundle, assignedReviewerId] of [
        ['private-b', privateB, 'actor-a'],
        ['shared', shared, 'actor-a'],
        ['other-budget', otherBudget, 'actor-a'],
        ['other-space', foreignSpace, 'actor-a'],
      ] as const) {
        preserved.push(await store.createReviewItem({
          budgetId: bundle.merchantDerivation.scope.budgetId, transactionId: name,
          categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant', assignedReviewerId,
          evidence: { ...bundle, ...financialEvidence }, provenance: 'merchant-inferred',
        }));
      }
      const oldConnection = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'historical-copy',
        categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant', assignedReviewerId: 'actor-b',
        evidence: { ...historical, ...financialEvidence }, provenance: 'merchant-inferred',
      });
      const mixed = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'mixed-private-owners',
        categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant', assignedReviewerId: 'actor-a',
        evidence: { ...privateB, related: [{ ...privateA, note: 'preserved note' }], ...financialEvidence },
        provenance: 'merchant-inferred',
      });
      let confirmed = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'human-confirmed-merchant',
        categoryId: fixture.transactions[1]!.categoryId!, classifier: 'merchant',
        evidence: { ...privateA, ...financialEvidence }, provenance: 'merchant-inferred',
      });
      for (const toStatus of ['pending_review', 'approved'] as const) {
        confirmed = await store.transitionInternalReviewItem(confirmed.id, {
          toStatus, actor: toStatus === 'approved' ? 'actor-b' : 'system', expectedVersion: confirmed.version,
          reason: toStatus === 'approved' ? 'Human confirmed the exact category' : 'Ready for human review',
        });
      }
      const humanActions = await store.getReviewActions(confirmed.id);
      const ordinary = await store.createReviewItem({
        budgetId: scope.budgetId, transactionId: 'ordinary-canonical-review',
        categoryId: fixture.transactions[1]!.categoryId!, classifier: 'fixture', assignedReviewerId: 'actor-a',
        evidence: { ...financialEvidence, sourceRevision: 'c'.repeat(64) }, provenance: 'canonical-fixture',
      });
      const report = await store.createReportRecord({
        budgetId: scope.budgetId, reportType: 'merchant-review', policyVersion: 'fixture/1',
        config: {
          ...privateA, ...financialEvidence,
          container: {
            merchantResearch: { explanation: 'INHERITED_PRIVATE_ACTOR_A' }, sourceRevision: 'd'.repeat(64),
            related: [{ ...privateB, note: 'nested protected B' }], note: 'ordinary container',
          },
          related: [{ ...privateB, note: 'private B' }, { ...shared, note: 'shared' },
            { ...foreignSpace, note: 'other space' }, { ...otherBudget, note: 'other budget' },
            { ...historical, note: 'historical selected connection' }],
        },
      });
      const ownerMembership = store.governance.getCurrentMembership({ spaceId: scope.spaceId, actorId: 'actor-a', now: NOW })!;
      for (const resource of [
        { resourceKind: 'budget', resourceId: scope.budgetId },
        { resourceKind: 'transaction', resourceId: source.id },
        { resourceKind: 'account', resourceId: source.accountId },
        { resourceKind: 'category', resourceId: fixture.transactions[1]!.categoryId! },
        ...(source.categoryId ? [{ resourceKind: 'category' as const, resourceId: source.categoryId }] : []),
      ] as const) {
        store.governance.setResourceGrant({
          spaceId: scope.spaceId, budgetId: scope.budgetId, actorId: 'actor-a', membershipId: ownerMembership.id,
          capability: 'categorization:propose', ...resource, granted: true, now: NOW, auth,
        });
      }
      const proposal = await store.createProposal({
        spaceId: scope.spaceId, budgetId: scope.budgetId, operation: 'set_category',
        payload: { kind: 'set_category', transactionId: source.id, categoryId: fixture.transactions[1]!.categoryId! },
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: JSON.stringify({
          transactionId: source.id, accountId: source.accountId, amount: source.amount,
          direction: source.direction, currentCategoryId: source.categoryId, actualVersion: fixture.actualVersion,
        }),
        expiresAt: at(3600), actorId: 'actor-a', auth, provenance: JSON.stringify(privateA),
      });
      if (proposal.operation !== 'set_category') throw new Error('Expected the exact category proposal fixture');
      const effect = JSON.stringify({ payload: proposal.payload, preconditions: proposal.preconditions, merchantEvidence: privateA.merchantEvidence });
      const execution = await store.createIdempotencyRecord({
        idempotencyKey: 'private-copy-exact-execution', proposalId: proposal.id, operation: proposal.operation,
        serialisedEffect: effect,
      });
      const audit = await store.appendAuditRecord({
        classification: 'execution_completed', actorId: 'actor-a', proposalId: proposal.id,
        payloadHash: proposal.payloadHash, budgetId: scope.budgetId, operation: proposal.operation,
        idempotencyKey: execution.record.idempotencyKey, expectedPriorState: effect,
        observedResultState: JSON.stringify({ ...privateA, categoryId: proposal.payload.categoryId }),
        result: 'Exact financial execution history', isError: false,
      });

      await store.deleteScopeData('user', { ...scope, actorId: 'actor-a' });
      for (const id of [unassigned.id, oldConnection.id]) {
        const retired = await peer.getReviewItem(id);
        expect(retired).toMatchObject({ categoryId: '', status: 'superseded', supersededReason: 'merchant_derived_content_deleted' });
        expect(retired?.evidence).toEqual(financialEvidence);
      }
      expect((await peer.getReviewItem(unassigned.id))?.sourceTransaction).toEqual(source);
      for (const item of preserved) expect(await peer.getReviewItem(item.id)).toEqual(item);
      const retainedMixed = await peer.getReviewItem(mixed.id);
      expect(retainedMixed).toMatchObject({ categoryId: mixed.categoryId, status: mixed.status });
      expect(retainedMixed?.evidence).toEqual({ ...privateB, related: [{ note: 'preserved note' }], ...financialEvidence });
      const retainedConfirmation = await peer.getReviewItem(confirmed.id);
      expect(retainedConfirmation).toMatchObject({
        categoryId: confirmed.categoryId, status: 'approved', approvedBy: ['actor-b'],
      });
      expect(retainedConfirmation?.evidence).toEqual(financialEvidence);
      expect(await peer.getReviewActions(confirmed.id)).toEqual(humanActions);
      expect(await peer.getReviewItem(ordinary.id)).toEqual(ordinary);
      const cleanedReport = await peer.getReportRecord(report.id);
      expect(cleanedReport).not.toBeNull();
      expect(JSON.parse(cleanedReport!.config)).toEqual({
        ...financialEvidence,
        container: { related: [{ ...privateB, note: 'nested protected B' }], note: 'ordinary container' },
        related: [{ ...privateB, note: 'private B' }, { ...shared, note: 'shared' },
          { ...foreignSpace, note: 'other space' }, { ...otherBudget, note: 'other budget' },
          { note: 'historical selected connection' }],
      });
      expect(await peer.getProposal(proposal.id)).toEqual(proposal);
      expect(await peer.getIdempotencyRecord(execution.record.idempotencyKey)).toEqual(execution.record);
      expect(await peer.queryAuditRecordsByProposal(proposal.id)).toContainEqual(audit);
    });
  });

  describe('generation, deletion, upgrade and actual backup restore', () => {
    it.each(['scope', 'budget', 'actor', 'restore'] as const)('retires every merchant-derived attempt fingerprint on %s cleanup while preserving its charge', async (operation) => {
      await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'fingerprint-lifecycle' });
      await store.finalizeBootstrap({ claimId: 'fingerprint-lifecycle', ownerUserId: 'actor-a' });
      const auth = { method: 'human-session' as const, actorId: 'actor-a', sessionId: 'fingerprint-owner', reauthenticatedAt: NOW };
      const space = store.governance.createSpace({ actorId: 'actor-a', name: 'Fingerprint lifecycle', kind: 'shared', now: NOW, auth });
      store.governance.bindBudget({ spaceId: space.id, budgetId: SCOPE.budgetId, now: NOW, auth });
      const scope = { ...SCOPE, spaceId: space.id };
      configure(store, scope);
      const quota = buckets().map((bucket) => bucket.kind === 'space' ? { ...bucket, id: scope.spaceId }
        : bucket.kind === 'budget' ? { ...bucket, id: `${scope.spaceId}/${scope.budgetId}` } : bucket);
      const first = dispatch(admitted('cleanup-fingerprint', {
        ...access(store, scope), key: key(scope), buckets: quota,
        visibility: { ...VISIBILITY, privateActorId: 'actor-a' },
      }));
      let destination = store;
      try {
        if (operation === 'scope') store.merchant.purge(access(store, scope));
        else if (operation === 'budget') store.merchant.purgeBudget(access(store, scope));
        else if (operation === 'actor') await store.deleteScopeData('user', { ...scope, actorId: 'actor-a' });
        else {
          store['db'].pragma('wal_checkpoint(TRUNCATE)');
          const backupPath = join(directory, 'fingerprint-backup.sqlite');
          copyFileSync(filename, backupPath);
          destination = SqliteWorkflowStore.restoreFromBackup({
            backupPath, destinationPath: join(directory, 'fingerprint-restored.sqlite'),
            now: at(1), authorize: () => true,
          });
        }
        const row = destination['db'].prepare('SELECT key_hash,intent_hash,visibility,source_refs,content_deleted,phase,reserved_atoms,settled_atoms FROM merchant_research_attempts WHERE id=?').get(first.id);
        expect(row).toMatchObject({
          key_hash: '0'.repeat(64), intent_hash: '0'.repeat(64), content_deleted: 1,
          visibility: JSON.stringify({ hash: '0'.repeat(64), privateActorId: null }),
          phase: 'uncertain', reserved_atoms: TARIFF.costAtoms, settled_atoms: null,
        });
        expect(JSON.stringify(row)).not.toContain('account-private');
      } finally { if (destination !== store) destination.close(); }
    });

    it('fences late writes and dispatch after policy change, deletion or current authority withdrawal', () => {
      const first = admitted('late', { key: key(SCOPE, '4'.repeat(64)) });
      const claim = claimed(first);
      const old = access();
      store.merchant.putEvidence({ ...old, value: evidenceValue(), expectedRevision: null });
      publishCache({ ...old, value: cacheValue() });
      const generation = peer.merchant.purge(access(peer));
      expect(generation).toBe(old.expectedGeneration + 1);
      expect(store.merchant.dispatchAttempt({ ...old, id: first.id, claimToken: claim.claimToken })).toBe(false);
      expect(publishCache({ ...old, value: cacheValue() })).toBeNull();
      expect(store.merchant.putEvidence({ ...old, value: evidenceValue(), expectedRevision: null })).toBeNull();
      expect(store.merchant.cache({ ...access(), key: key() })).toBeNull();
      expect(store.merchant.evidence({ ...access(), key: 'merchant-pattern-a' })).toBeNull();
      expect(reserve('revoked', { authorize: DENY })).toEqual({ status: 'denied', reason: 'unauthorized' });
    });

    it('rechecks current authority and policy even with a still-live same-generation worker claim', () => {
      const claim = claimed(admitted('authorized-at-admission'));
      expect(peer.merchant.dispatchAttempt({ ...access(peer, SCOPE, NOW, DENY), id: claim.id, claimToken: claim.claimToken })).toBe(false);
      configure(peer, SCOPE, { ...POLICY, mode: 'local-only' }, at(1));
      expect(store.merchant.dispatchAttempt({ ...access(store, SCOPE, at(1)), id: claim.id, claimToken: claim.claimToken })).toBe(false);
      expect(store.merchant.putCache({ ...access(store, SCOPE, at(1)), attemptId: claim.id, claimToken: claim.claimToken, value: cacheValue() })).toBeNull();
    });

    it('content deletion cannot reset dispatched charges or shared launch limits', () => {
      dispatch(admitted('sent-before-delete', { buckets: buckets(1), tariff: { ...TARIFF, costAtoms: '1000000' } }));
      store.merchant.purge(access());
      configure(store);
      expect(reserve('after-delete', { policyVersion: 2, key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1) })).toEqual({ status: 'denied', reason: 'monthly_cap' });
    });

    it('purges only exact scope content and retains independent decisions', () => {
      store.merchant.decide({ ...access(), id: 'alias-a', payload: ALIAS, state: 'accepted', sourceRefs: REFS, expectedVersion: 0 });
      const other = { ...SCOPE, connectionId: 'other' };
      store.merchant.decide({ ...access(store, other), id: 'alias-a', payload: ALIAS, state: 'accepted', sourceRefs: REFS, expectedVersion: 0 });
      store.merchant.purge(access());
      expect(store.merchant.decisions({ ...access(), limit: 10 }).records).toEqual([]);
      expect(peer.merchant.decisions({ ...access(peer, other), limit: 10 }).records).toHaveLength(1);
    });
    it('budget lifecycle purge fences every historical connection while preserving other budgets and spaces', () => {
      const scopes = [
        SCOPE, { ...SCOPE, connectionId: 'historical-origin' },
        { ...SCOPE, budgetId: 'budget-b' }, { ...SCOPE, spaceId: 'space-b' },
      ];
      for (const scope of scopes) {
        configure(store, scope);
        store.merchant.decide({ ...access(store, scope), id: 'alias-a', payload: ALIAS,
          state: 'accepted', sourceRefs: REFS, expectedVersion: 0 });
      }
      const captured = scopes.map((scope) => access(store, scope));
      expect(store.merchant.purgeBudget(captured[0]!)).toBe(captured[0]!.expectedGeneration + 1);
      for (const prior of captured.slice(0, 2)) {
        expect(store.merchant.generation(prior.scope)).toBe(prior.expectedGeneration + 1);
        expect(store.merchant.decisions({ ...access(peer, prior.scope), limit: 10 }).records).toEqual([]);
        expect(store.merchant.putEvidence({ ...prior, value: evidenceValue(), expectedRevision: null })).toBeNull();
      }
      for (const prior of captured.slice(2)) {
        expect(store.merchant.generation(prior.scope)).toBe(prior.expectedGeneration);
        expect(store.merchant.decisions({ ...access(peer, prior.scope), limit: 10 }).records[0])
          .toMatchObject({ id: 'alias-a', state: 'accepted' });
      }
    });

    it('upgrades a populated pre-merchant database append-only without learning historical suggestions', async () => {
      const legacyPath = join(directory, 'legacy.sqlite');
      const legacy = new Database(legacyPath);
      const migrations = SqliteWorkflowStore['MIGRATIONS'];
      const merchantMigration = migrations.indexOf(migrateMerchant);
      if (merchantMigration < 0) throw new Error('Merchant migration is not registered');
      legacy.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
      legacy.transaction(() => {
        for (const [index, migration] of migrations.slice(0, merchantMigration).entries()) {
          migration(legacy);
          legacy.prepare('INSERT INTO schema_version VALUES (?,?)').run(index + 1, NOW);
        }
        legacy.prepare('INSERT INTO suggestions(id,budget_id,transaction_id,category_id,classifier,prompt_version,payload,transaction_version,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('legacy-suggestion', SCOPE.budgetId, 'transaction-a', 'category-a', 'legacy-model', '1', '{"confidence":0.99}', 1, null, NOW);
      })();
      legacy.close();
      const upgraded = new SqliteWorkflowStore(legacyPath);
      try {
        expect(await upgraded.getSuggestion('legacy-suggestion')).toMatchObject({ transactionId: 'transaction-a', payload: { confidence: 0.99 } });
        expect(upgraded.merchant.decisions({ ...access(upgraded), limit: 10 }).records).toEqual([]);
        expect(upgraded.merchant.policy(access(upgraded))).toBeNull();
        expect(reserve('pre-opt-in', { ...access(upgraded) }, upgraded).status).toBe('denied');
        expect(upgraded['db'].prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: migrations.length });
      } finally { upgraded.close(); }
    });

    it('reconciles an actual restored backup fail-closed, requiring fresh acknowledgment and new consent', async () => {
      await store.saveSuggestion({ transactionId: 'transaction-financial', budgetId: SCOPE.budgetId, categoryId: 'category-a', classifier: 'local', promptVersion: '1', transactionVersion: 1, payload: { explanation: 'Financial intent retained' } });
      store.merchant.decide({ ...access(), id: 'restored-alias', payload: ALIAS, state: 'accepted', sourceRefs: REFS, expectedVersion: 0 });
      store.merchant.putEvidence({ ...access(), value: evidenceValue(), expectedRevision: null });
      publishCache({ ...access(), value: cacheValue() });
      dispatch(admitted('backup-dispatched', { now: at(1), buckets: buckets(1), tariff: { ...TARIFF, costAtoms: '1000000' } }), store, at(1));
      const oldGeneration = store.merchant.generation(SCOPE);
      store['db'].pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = join(directory, 'backup.sqlite');
      copyFileSync(filename, backupPath);
      // A revocation after this backup must not be undone by restoring it.
      store.merchant.decide({ ...access(), id: 'restored-alias', payload: ALIAS, state: 'revoked', sourceRefs: REFS, expectedVersion: 1 });
      const destinationPath = join(directory, 'restored.sqlite');
      const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath, now: at(2), authorize: () => true });
      try {
        expect(restored.merchant.generation(SCOPE)).toBeGreaterThan(oldGeneration);
        expect(restored.merchant.decisions({ ...access(restored, SCOPE, at(2)), limit: 10 }).records).toEqual([]);
        expect(restored.merchant.evidence({ ...access(restored, SCOPE, at(2)), key: 'merchant-pattern-a' })).toBeNull();
        expect(restored.merchant.cache({ ...access(restored, SCOPE, at(2)), key: key() })).toBeNull();
        expect(reserve('restore-blocked', { ...access(restored, SCOPE, at(2)), key: key(SCOPE, '4'.repeat(64)) }, restored)).toEqual({ status: 'denied', reason: 'restore_pending' });
        expect(restored.merchant.acknowledgeRestore({ ...access(restored, SCOPE, at(2)), authorize: DENY, actorId: 'actor-a' })).toBe(false);
        expect(restored.merchant.acknowledgeRestore({ ...access(restored, SCOPE, at(2)), actorId: 'actor-a' })).toBe(true);
        expect(restored.merchant.policy(access(restored, SCOPE, at(2)))?.mode).toBe('local-only');
        expect(reserve('restore-no-consent', { ...access(restored, SCOPE, at(2)), key: key(SCOPE, '4'.repeat(64)) }, restored)).toEqual({ status: 'denied', reason: 'policy' });
        const restoredPolicy = restored.merchant.policy(access(restored, SCOPE, at(2)))!;
        configure(restored, SCOPE, POLICY, at(2));
        expect(reserve('restore-retained-charge', { ...access(restored, SCOPE, at(2)), policyVersion: restoredPolicy.version + 1, key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1) }, restored)).toEqual({ status: 'denied', reason: 'restore_billing_hold' });
        expect(reserve('restore-unresolved-after-window', { ...access(restored, SCOPE, '2026-02-01T00:00:00.000Z'), policyVersion: restoredPolicy.version + 1, key: key(SCOPE, '5'.repeat(64)), buckets: buckets(1) }, restored)).toEqual({ status: 'denied', reason: 'restore_billing_hold' });
        expect(restored['db'].prepare('SELECT COUNT(*) AS count FROM suggestions WHERE transaction_id=?').get('transaction-financial')).toEqual({ count: 1 });
      } finally { restored.close(); }
    });

    it('does not regain rolled-back monthly quota merely by acknowledging and re-enabling policy', () => {
      store['db'].pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = join(directory, 'before-later-spend.sqlite');
      copyFileSync(filename, backupPath);
      // This paid request is absent from the restored database.
      const paid = dispatch(admitted('post-backup-spend', { buckets: buckets(1), tariff: { ...TARIFF, costAtoms: '1000000' } }));
      expect(store.merchant.settleAttempt({ ...access(), id: paid.id, claimToken: paid.claimToken, outcome: { phase: 'succeeded', costAtoms: '1000000' } })).toBe(true);
      const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath, destinationPath: join(directory, 'lost-billing.sqlite'), now: at(1), authorize: () => true });
      try {
        expect(restored.merchant.acknowledgeRestore({ ...access(restored, SCOPE, at(1)), actorId: 'actor-a' })).toBe(true);
        configure(restored, SCOPE, POLICY, at(1));
        const policy = restored.merchant.policy(access(restored, SCOPE, at(1)))!;
        expect(reserve('lost-billing-new-policy', { ...access(restored, SCOPE, at(2)), policyVersion: policy.version, key: key(SCOPE, '4'.repeat(64)), buckets: buckets(1) }, restored)).toEqual({ status: 'denied', reason: 'restore_billing_hold' });
      } finally { restored.close(); }
    });

    it('refuses a database whose schema is newer than this binary before serving merchant content', () => {
      const futurePath = join(directory, 'future-schema.sqlite');
      const future = new Database(futurePath);
      future.exec('CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
      future.prepare('INSERT INTO schema_version VALUES (?,?)').run(SqliteWorkflowStore['MIGRATIONS'].length + 1, NOW);
      future.close();
      expect(() => new SqliteWorkflowStore(futurePath)).toThrow(/newer|unsupported.*schema|schema.*version/i);
    });

    it('does not copy or overwrite a backup destination when restore authority is denied', () => {
      const destinationPath = join(directory, 'denied-restore.sqlite');
      expect(() => SqliteWorkflowStore.restoreFromBackup({ backupPath: filename, destinationPath, now: NOW, authorize: () => false })).toThrow();
      expect(existsSync(destinationPath)).toBe(false);
    });
  });

  it('persists explicit budget and account calendars without accepting invalid time zones', () => {
    const calendar = {
      budget: { jurisdiction: 'GB', subdivision: 'SCT', timeZone: 'Europe/London' },
      accounts: [{ accountId: 'account-a', selection: null }],
    };
    const expectedVersion = store.merchant.policy(access())!.version;
    const saved = store.merchant.setPolicy({
      ...access(), expectedVersion, value: { ...POLICY, calendar },
    });
    expect(saved).not.toBeNull();
    expect(peer.merchant.policy(access(peer))).toMatchObject({ calendar });
    expect(() => store.merchant.setPolicy({
      ...access(), expectedVersion: saved!.version,
      value: { ...POLICY, calendar: { ...calendar, budget: { ...calendar.budget, timeZone: 'Not/A_Time_Zone' } } },
    })).toThrow();
    expect(peer.merchant.policy(access(peer))!.version).toBe(saved!.version);
  });
});
