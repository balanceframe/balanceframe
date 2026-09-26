import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/store.js';
import type { ClaimValidationContext } from '../src/liquidity-types.js';
import type {
  DecisionScope,
  LiquidityPolicy,
  Money,
  ProspectiveClaim,
  TransferPlan,
} from '@balanceframe/protocol-generated';

const now = '2098-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const afterExpiry = '2100-01-01T00:00:00.000Z';
const budgetId = 'budget';
const actorId = 'holder';
const categoryId = 'food';
const accountId = 'checking';
const privateAccountId = 'savings';
const policyVersion = 'policy-1';
const snapshotId = 'snapshot-1';
const money = (minorUnits: string): Money => ({ minorUnits, currency: 'USD' });

type ClaimMode = 'inform' | 'block';
type StoredClaim = ProspectiveClaim & { mode: ClaimMode };
type GovernedLiquidityPolicy = LiquidityPolicy & { reservationMode: ClaimMode };

function liquidityPolicy(
  reservationMode: ClaimMode,
  version = policyVersion,
  policyExpiresAt = expiresAt,
): GovernedLiquidityPolicy {
  return {
    version,
    policyHash: version === policyVersion ? 'policy-hash' : `${version}-hash`,
    expiresAt: policyExpiresAt,
    accounts: [],
    transferRoutes: [],
    reservationMode,
  } as unknown as GovernedLiquidityPolicy;
}
type ClaimValidator = (context: ClaimValidationContext) => {
  valid: boolean;
  reason?: string;
};

const capabilities = [
  'conclusion',
  'existence',
  'name',
  'balance',
  'history',
  'liquidity',
  'source',
  'category',
  'proposal',
  'approval',
  'initiation-report',
  'confirmation',
  'audit',
  'policy',
  'session',
] as const;

function prospectiveClaim(
  overrides: Partial<ProspectiveClaim> & { mode?: ClaimMode } = {},
): StoredClaim {
  return {
    claimId: 'claim-food',
    kind: 'reservation',
    sourceId: 'obligation:food',
    scope: { kind: 'category', id: categoryId },
    amount: money('20'),
    status: 'active',
    effectiveFrom: now,
    expiresAt,
    visibility: 'visible',
    policyVersion,
    snapshotId,
    mode: 'block',
    ...overrides,
  };
}

/** The store must hand the native validator the candidate and current shared claim set. */
function permit(): ClaimValidator {
  return () => ({ valid: true });
}

/** Capacity is deliberately supplied by the trusted callback, not calculated by this test. */
function capacity(limit: bigint): ClaimValidator {
  return ({ claimSet, proposedClaim }) => {
    const existing = claimSet.bundles
      .flatMap((bundle) => bundle.effects)
      .filter((effect) => !effect.includedInBalance)
      .reduce((total, effect) => total + BigInt(effect.amount.minorUnits), 0n);
    const incoming =
      proposedClaim?.effects
        .filter((effect) => !effect.includedInBalance)
        .reduce((total, effect) => total + BigInt(effect.amount.minorUnits), 0n) ?? 0n;
    return existing + incoming <= limit
      ? { valid: true }
      : { valid: false, reason: 'capacity_exceeded' };
  };
}

function transferPlan(hash = 'a'.repeat(64)): TransferPlan {
  const before = (id: string) => ({
    accountId: id,
    recordedBalance: money('100'),
    signedHeadroom: money('100'),
    backingCapacity: money('100'),
    baselineTransactionIds: [],
  });
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId,
    contentHash: 'ledger',
    policyVersion,
    policyHash: 'policy-hash',
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt,
    minimumAmount: money('20'),
    payloadHash: hash,
    legs: [
      {
        id: 'leg',
        sourceAccountId: accountId,
        destinationAccountId: privateAccountId,
        amount: money('20'),
        requiredBy: expiresAt,
        estimatedArrival: now,
        timingRouteId: 'route',
        sourceBefore: before(accountId),
        destinationBefore: before(privateAccountId),
        sourceAfter: money('80'),
        destinationAfter: money('120'),
      },
    ],
    reservations: [
      {
        kind: 'account_debit',
        resourceId: accountId,
        amount: money('20'),
        economicObligationId: `transfer:${hash}`,
        categoryId: null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
    backingAfter: {
      version: '1',
      snapshotId,
      contentHash: 'ledger',
      policyVersion,
      policyHash: 'policy-hash',
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}

describe('prospective commitment and reservation lifecycle', () => {
  let store: SqliteWorkflowStore;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'prospective-claims-'));
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    await store.upsertActorMembership(
      actorId,
      'active',
      capabilities.map((capability) => `liquidity:${capability}`),
      `budget:${budgetId}`,
    );
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['category', categoryId],
        ['account', accountId],
        ['account', privateAccountId],
      ] as const) {
        store.liquidity.setResourceGrant({
          actorId,
          budgetId,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });
      }
    store.liquidity.savePolicy({
      actorId,
      budgetId,
      expectedVersion: null,
      now,
      policy: liquidityPolicy('block'),
      approvalPolicy: { minimumApprovers: 1 },
    });
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function save(
    claim: StoredClaim,
    expectedClaimSetRevision: string,
    idempotencyKey: string,
    validator: ClaimValidator = permit(),
  ) {
    return store.liquidity.saveProspectiveClaim(
      {
        actorId,
        budgetId,
        claim,
        expectedClaimSetRevision,
        idempotencyKey,
        now,
      },
      validator,
    );
  }

  function currentClaims(at = now) {
    return store.liquidity.getClaimSet({ actorId, budgetId, now: at });
  }

  it('admits category and account scopes atomically under one shared claim revision', () => {
    const seen: ClaimValidationContext[] = [];
    save(
      prospectiveClaim({
        claimId: 'rent-category',
        sourceId: 'obligation:rent:2029-01',
        amount: money('30'),
        scope: { kind: 'category', id: categoryId },
      }),
      '0',
      'claim:category',
      (context) => {
        seen.push(context);
        return { valid: true };
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      budgetId,
      claimSet: { revision: '0', bundles: [] },
      proposedClaim: {
        id: 'rent-category',
        effects: [
          expect.objectContaining({
            kind: 'category',
            resourceId: categoryId,
            economicObligationId: 'obligation:rent:2029-01:category:food',
            amount: money('30'),
          }),
        ],
      },
      policy: { policy: { version: policyVersion } },
    });

    expect(currentClaims()).toMatchObject({
      revision: '1',
      bundles: [
        expect.objectContaining({
          id: 'rent-category',
          creationSnapshotId: snapshotId,
          creationPolicyVersion: policyVersion,
          state: 'active',
          effects: [
            expect.objectContaining({
              kind: 'category',
              resourceId: categoryId,
              economicObligationId: 'obligation:rent:2029-01:category:food',
              amount: money('30'),
            }),
          ],
        }),
      ],
    });

    save(
      prospectiveClaim({
        claimId: 'rent-account',
        sourceId: 'obligation:rent:2029-01',
        amount: money('30'),
        scope: { kind: 'account', id: accountId },
        snapshotId: 'snapshot-2',
      }),
      '1',
      'claim:account',
      capacity(100n),
    );

    expect(currentClaims()).toMatchObject({
      revision: '2',
      bundles: expect.arrayContaining([
        expect.objectContaining({
          id: 'rent-account',
          // A refreshed snapshot is provenance, not permission to erase an active claim.
          creationSnapshotId: 'snapshot-2',
          effects: [
            expect.objectContaining({
              kind: 'account_debit',
              resourceId: accountId,
              economicObligationId: 'obligation:rent:2029-01:account:checking',
            }),
          ],
        }),
      ]),
    });
  });

  it('records policy version, actor and idempotency identity in an append-only claim audit', async () => {
    save(
      prospectiveClaim({ claimId: 'audited-claim', sourceId: 'schedule:audit' }),
      '0',
      'claim:audit',
    );

    const records = await store.queryAuditRecords();
    expect(
      records.some(
        (record) =>
          record.actorId === actorId &&
          record.budgetId === budgetId &&
          record.policyVersion === policyVersion &&
          record.idempotencyKey === 'claim:audit' &&
          /prospective.*claim|claim.*prospective/i.test(record.operation ?? ''),
      ),
    ).toBe(true);
  });

  it('accepts independent obligations sharing a scope but rejects only a real capacity conflict atomically', () => {
    save(
      prospectiveClaim({ claimId: 'food-a', sourceId: 'obligation:a', amount: money('60') }),
      '0',
      'claim:a',
      capacity(100n),
    );
    save(
      prospectiveClaim({ claimId: 'food-b', sourceId: 'obligation:b', amount: money('40') }),
      '1',
      'claim:b',
      capacity(100n),
    );

    expect(currentClaims().bundles.map((bundle) => bundle.id)).toEqual(['food-a', 'food-b']);
    expect(() =>
      save(
        prospectiveClaim({ claimId: 'food-c', sourceId: 'obligation:c', amount: money('1') }),
        '2',
        'claim:c',
        capacity(100n),
      ),
    ).toThrow(/capacity|insufficient|conflict/i);
    expect(currentClaims()).toMatchObject({
      revision: '2',
      bundles: [
        expect.objectContaining({ id: 'food-a' }),
        expect.objectContaining({ id: 'food-b' }),
      ],
    });
  });
  it('rejects duplicate economic commitments within one scope but permits distinct scoped effects', () => {
    const obligation = 'obligation:logical:rent:2029-01';
    save(
      prospectiveClaim({
        claimId: 'logical-category',
        kind: 'commitment',
        sourceId: obligation,
        amount: money('30'),
        scope: { kind: 'category', id: categoryId },
      }),
      '0',
      'claim:logical:category',
    );
    expect(() =>
      save(
        prospectiveClaim({
          claimId: 'logical-category-duplicate',
          kind: 'commitment',
          sourceId: obligation,
          amount: money('30'),
          scope: { kind: 'category', id: categoryId },
        }),
        '1',
        'claim:logical:category:duplicate',
      ),
    ).toThrow(/duplicate|obligation|claim|conflict/i);
    expect(currentClaims()).toMatchObject({
      revision: '1',
      bundles: [expect.objectContaining({ id: 'logical-category' })],
    });

    save(
      prospectiveClaim({
        claimId: 'logical-account',
        kind: 'commitment',
        sourceId: obligation,
        amount: money('30'),
        scope: { kind: 'account', id: accountId },
      }),
      '1',
      'claim:logical:account',
    );
    expect(currentClaims().bundles.map((bundle) => bundle.id)).toEqual([
      'logical-account',
      'logical-category',
    ]);
    expect(() =>
      save(
        prospectiveClaim({
          claimId: 'logical-account-duplicate',
          kind: 'commitment',
          sourceId: obligation,
          amount: money('30'),
          scope: { kind: 'account', id: accountId },
        }),
        '2',
        'claim:logical:account:duplicate',
      ),
    ).toThrow(/duplicate|obligation|claim|conflict/i);
    expect(currentClaims().revision).toBe('2');
  });
  it('rejects a duplicate of a pre-upgrade prospective effect with an unsuffixed source ID', () => {
    const sourceId = 'obligation:historical';
    save(prospectiveClaim({ claimId: 'historical', sourceId, amount: money('30') }),
      '0', 'legacy-create');
    const db = new Database(join(directory, 'workflow.sqlite'));
    const row = db.prepare('SELECT bundle FROM liquidity_claims WHERE budget_id=? AND id=?')
      .get(budgetId, 'historical') as { bundle: string };
    const bundle = JSON.parse(row.bundle) as { effects: Array<{ economicObligationId: string }> };
    bundle.effects[0]!.economicObligationId = sourceId;
    db.prepare('UPDATE liquidity_claims SET bundle=? WHERE budget_id=? AND id=?')
      .run(JSON.stringify(bundle), budgetId, 'historical');
    db.close();
    expect(() => save(prospectiveClaim({
      claimId: 'historical-duplicate', sourceId, amount: money('30'),
    }), '1', 'legacy-duplicate', capacity(100n))).toThrow(/Duplicate economic obligation/);
    expect(currentClaims().bundles.map((claim) => claim.id)).toEqual(['historical']);
  });

  it('normalizes legacy same-source scopes when upgrading a persisted workflow database', () => {
    const sourceId = 'obligation:legacy-split';
    save(prospectiveClaim({ claimId: 'old-category', sourceId,
      scope: { kind: 'category', id: categoryId }, amount: money('30') }),
    '0', 'old-category-save');
    save(prospectiveClaim({ claimId: 'old-account', sourceId,
      scope: { kind: 'account', id: accountId }, amount: money('30') }),
    '1', 'old-account-save', capacity(100n));
    store.close();
    const db = new Database(join(directory, 'workflow.sqlite'));
    for (const id of ['old-category', 'old-account']) {
      const row = db.prepare('SELECT bundle FROM liquidity_claims WHERE budget_id=? AND id=?')
        .get(budgetId, id) as { bundle: string };
      const bundle = JSON.parse(row.bundle) as {
        effects: Array<{ economicObligationId: string; sourceEconomicObligationId?: string }>;
      };
      if (id === 'old-category') bundle.effects[0]!.economicObligationId = sourceId;
      delete bundle.effects[0]!.sourceEconomicObligationId;
      db.prepare('UPDATE liquidity_claims SET bundle=? WHERE budget_id=? AND id=?')
        .run(JSON.stringify(bundle), budgetId, id);
    }
    db.prepare('DELETE FROM schema_version WHERE version=(SELECT MAX(version) FROM schema_version)').run();
    db.close();
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    const claims = currentClaims();
    expect(claims.bundles.map((bundle) => bundle.effects[0]?.economicObligationId).sort())
      .toEqual([`${sourceId}:account:${accountId}`, `${sourceId}:category:${categoryId}`]);
    expect(claims.bundles.map((bundle) => bundle.effects[0]?.sourceEconomicObligationId))
      .toEqual([sourceId, sourceId]);
    expect(claims.revision).toBe('3');
  });

  it('keeps a future-effective reservation out of current capacity until its start revision', () => {
    const effectiveAt = '2098-06-01T00:00:00.000Z';
    save(
      prospectiveClaim({
        claimId: 'future-effective',
        sourceId: 'obligation:future-effective',
        effectiveFrom: effectiveAt,
      }),
      '0',
      'claim:future-effective',
    );

    expect(currentClaims()).toEqual({ revision: '1', bundles: [] });
    expect(store.liquidity.listProspectiveClaims({ actorId, budgetId, now })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimId: 'future-effective',
          lifecycleState: 'active',
          effectiveFrom: effectiveAt,
        }),
      ]),
    );

    expect(currentClaims(effectiveAt)).toMatchObject({
      revision: '2',
      bundles: [expect.objectContaining({ id: 'future-effective', state: 'active' })],
    });
    expect(currentClaims(effectiveAt).revision).toBe('2');
  });

  it('projects a policy-clamped expiry when a claim omits its own expiry', () => {
    const clampedPolicyVersion = 'policy-clamped-expiry';
    const clampedExpiry = '2098-06-15T00:00:00.000Z';
    store.liquidity.savePolicy({
      actorId,
      budgetId,
      expectedVersion: policyVersion,
      now,
      policy: liquidityPolicy('block', clampedPolicyVersion, clampedExpiry),
      approvalPolicy: { minimumApprovers: 1 },
    });
    const result = save(
      prospectiveClaim({
        claimId: 'policy-clamped-expiry',
        sourceId: 'obligation:policy-clamped-expiry',
        policyVersion: clampedPolicyVersion,
        expiresAt: null,
      }),
      '0',
      'claim:policy-clamped-expiry',
    );

    expect(result).toMatchObject({
      claimId: 'policy-clamped-expiry',
      expiresAt: clampedExpiry,
    });
    expect(store.liquidity.listProspectiveClaims({ actorId, budgetId, now })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimId: 'policy-clamped-expiry',
          expiresAt: clampedExpiry,
        }),
      ]),
    );
    expect(currentClaims()).toMatchObject({
      bundles: [expect.objectContaining({ id: 'policy-clamped-expiry', expiresAt: clampedExpiry })],
    });
  });

  it('keeps informing reservations factual and visible without admitting them to decision capacity', () => {
    const informPolicyVersion = 'policy-inform';
    store.liquidity.savePolicy({
      actorId,
      budgetId,
      expectedVersion: policyVersion,
      now,
      policy: liquidityPolicy('inform', informPolicyVersion),
      approvalPolicy: { minimumApprovers: 1 },
    });
    save(
      prospectiveClaim({
        claimId: 'informing-food',
        sourceId: 'obligation:informing',
        amount: money('80'),
        policyVersion: informPolicyVersion,
        mode: 'inform',
      }),
      '0',
      'claim:informing',
      () => ({ valid: false, reason: 'capacity_exceeded' }),
    );
    expect(currentClaims()).toEqual({ revision: '1', bundles: [] });

    const persisted = store['db']
      .prepare(
        "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='prospective' AND owner_id=?",
      )
      .get(budgetId, 'informing-food') as { bundle: string };
    expect(JSON.parse(persisted.bundle)).toMatchObject({
      id: 'informing-food',
      state: 'active',
      effects: [expect.objectContaining({ includedInBalance: false, amount: money('80') })],
    });
    expect(store.liquidity.listProspectiveClaims({ actorId, budgetId, now })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimId: 'informing-food',
          mode: 'inform',
          lifecycleState: 'active',
          amount: money('80'),
        }),
      ]),
    );

    const blockPolicyVersion = 'policy-block';
    store.liquidity.savePolicy({
      actorId,
      budgetId,
      expectedVersion: informPolicyVersion,
      now,
      policy: liquidityPolicy('block', blockPolicyVersion),
      approvalPolicy: { minimumApprovers: 1 },
    });
    save(
      prospectiveClaim({
        claimId: 'blocking-food',
        sourceId: 'obligation:blocking',
        amount: money('100'),
        policyVersion: blockPolicyVersion,
        mode: 'block',
      }),
      '1',
      'claim:blocking',
      capacity(100n),
    );
    expect(currentClaims()).toMatchObject({
      revision: '2',
      bundles: [expect.objectContaining({ id: 'blocking-food', state: 'active' })],
    });

    expect(() =>
      save(
        prospectiveClaim({
          claimId: 'over-capacity',
          sourceId: 'obligation:over-capacity',
          amount: money('1'),
          policyVersion: blockPolicyVersion,
          mode: 'block',
        }),
        '2',
        'claim:over-capacity',
        capacity(100n),
      ),
    ).toThrow(/capacity|insufficient|conflict/i);
    expect(currentClaims().revision).toBe('2');
  });
  it('does not let a claimant downgrade a policy-blocking reservation to informative', () => {
    expect(() =>
      save(
        prospectiveClaim({
          claimId: 'claimant-downgrade',
          sourceId: 'obligation:required-block',
          amount: money('80'),
          mode: 'inform',
        }),
        '0',
        'claim:claimant-downgrade',
        () => ({ valid: false, reason: 'capacity_exceeded' }),
      ),
    ).toThrow(/capacity|insufficient|conflict/i);
    expect(currentClaims()).toEqual({ revision: '0', bundles: [] });
    expect(store.liquidity.listProspectiveClaims({ actorId, budgetId, now })).toEqual([]);
  });

  it('expires, releases and consumes claims while restoring capacity and retaining lifecycle history', () => {
    save(
      prospectiveClaim({
        claimId: 'expiring',
        sourceId: 'obligation:expiring',
        amount: money('25'),
      }),
      '0',
      'claim:expiring',
      capacity(100n),
    );
    expect(currentClaims()).toMatchObject({ revision: '1', bundles: [expect.any(Object)] });

    expect(currentClaims(afterExpiry)).toEqual({ revision: '2', bundles: [] });

    save(
      prospectiveClaim({
        claimId: 'released',
        sourceId: 'obligation:released',
        amount: money('25'),
      }),
      '2',
      'claim:released',
      capacity(25n),
    );
    store.liquidity.transitionProspectiveClaim({
      actorId,
      budgetId,
      claimId: 'released',
      transition: 'release',
      expectedClaimSetRevision: '3',
      idempotencyKey: 'claim:release',
      now,
    });
    expect(currentClaims()).toMatchObject({ revision: '4', bundles: [] });

    save(
      prospectiveClaim({
        claimId: 'consumed',
        sourceId: 'obligation:consumed',
        amount: money('25'),
      }),
      '4',
      'claim:consumed',
      capacity(25n),
    );
    expect(() =>
      store.liquidity.transitionProspectiveClaim({
        actorId,
        budgetId,
        claimId: 'consumed',
        transition: 'consume',
        expectedClaimSetRevision: '5',
        idempotencyKey: 'claim:consume:no-evidence',
        now,
      }),
    ).toThrow(/evidence|confirmation/i);
    expect(currentClaims().revision).toBe('5');
    expect(() =>
      store.liquidity.transitionProspectiveClaim({
        actorId: 'outsider',
        budgetId,
        claimId: 'consumed',
        transition: 'release',
        expectedClaimSetRevision: '5',
        idempotencyKey: 'claim:unauthorized-transition',
        now,
      }),
    ).toThrow(/authoriz|member/i);
    store.liquidity.transitionProspectiveClaim(
      {
        actorId,
        budgetId,
        claimId: 'consumed',
        transition: 'consume',
        expectedClaimSetRevision: '5',
        idempotencyKey: 'claim:consume',
        consumptionEvidenceId: 'evidence:consumed',
        now,
      },
      () => ({ valid: true }),
    );
    expect(currentClaims()).toMatchObject({ revision: '6', bundles: [] });

    const history = store.liquidity.listProspectiveClaims({ actorId, budgetId, now });
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimId: 'released', status: 'released' }),
        expect.objectContaining({ claimId: 'consumed', status: 'released' }),
      ]),
    );
  });
  it('consumes each canonical account/source evidence identity at most once', () => {
    save(
      prospectiveClaim({
        claimId: 'evidence-checking',
        sourceId: 'obligation:evidence:checking',
        scope: { kind: 'account', id: accountId },
      }),
      '0',
      'claim:evidence:checking',
    );
    save(
      prospectiveClaim({
        claimId: 'evidence-food',
        sourceId: 'obligation:evidence:food',
        scope: { kind: 'category', id: categoryId },
      }),
      '1',
      'claim:evidence:food',
    );
    save(
      prospectiveClaim({
        claimId: 'evidence-savings',
        sourceId: 'obligation:evidence:savings',
        scope: { kind: 'account', id: privateAccountId },
      }),
      '2',
      'claim:evidence:savings',
    );

    const checkingEvidence = 'actual:checking:source-a:txn-7';
    const savingsEvidence = 'actual:savings:source-b:txn-7';
    const verify = () => ({ valid: true });
    store.liquidity.transitionProspectiveClaim(
      {
        actorId,
        budgetId,
        claimId: 'evidence-checking',
        transition: 'consume',
        expectedClaimSetRevision: '3',
        idempotencyKey: 'claim:evidence:consume:checking',
        consumptionEvidenceId: checkingEvidence,
        now,
      },
      verify,
    );
    expect(currentClaims().revision).toBe('4');

    expect(() =>
      store.liquidity.transitionProspectiveClaim(
        {
          actorId,
          budgetId,
          claimId: 'evidence-food',
          transition: 'consume',
          expectedClaimSetRevision: '4',
          idempotencyKey: 'claim:evidence:consume:food',
          consumptionEvidenceId: checkingEvidence,
          now,
        },
        verify,
      ),
    ).toThrow(/evidence|consum|already|duplicate/i);
    expect(currentClaims().revision).toBe('4');

    store.liquidity.transitionProspectiveClaim(
      {
        actorId,
        budgetId,
        claimId: 'evidence-savings',
        transition: 'consume',
        expectedClaimSetRevision: '4',
        idempotencyKey: 'claim:evidence:consume:savings',
        consumptionEvidenceId: savingsEvidence,
        now,
      },
      verify,
    );
    expect(currentClaims()).toMatchObject({
      revision: '5',
      bundles: [expect.objectContaining({ id: 'evidence-food', state: 'active' })],
    });
  });

  it('uses the shared revision as CAS and replays save/transition idempotently', () => {
    const input = {
      actorId,
      budgetId,
      claim: prospectiveClaim({ claimId: 'retryable', sourceId: 'obligation:retryable' }),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'claim:retry',
      now,
    };
    const first = store.liquidity.saveProspectiveClaim(input, permit());
    const replay = store.liquidity.saveProspectiveClaim(input, () => {
      throw new Error('idempotent save replay must not invoke validation');
    });
    expect(replay).toEqual(first);
    expect(currentClaims().revision).toBe('1');

    const transition = {
      actorId,
      budgetId,
      claimId: 'retryable',
      transition: 'release' as const,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'claim:retry-release',
      now,
    };
    const released = store.liquidity.transitionProspectiveClaim(transition);
    expect(store.liquidity.transitionProspectiveClaim(transition)).toEqual(released);
    expect(currentClaims().revision).toBe('2');

    expect(() =>
      store.liquidity.transitionProspectiveClaim({
        ...transition,
        idempotencyKey: 'claim:stale-release',
      }),
    ).toThrow(/revision|conflict/i);

    expect(() =>
      store.liquidity.listProspectiveClaims({ actorId, budgetId: 'other-budget', now }),
    ).toThrow(/authoriz|budget/i);
    expect(() =>
      store.liquidity.saveProspectiveClaim(
        {
          ...input,
          budgetId: 'other-budget',
          idempotencyKey: 'claim:wrong-budget',
        },
        permit(),
      ),
    ).toThrow(/authoriz|budget/i);

    expect(() =>
      save(
        prospectiveClaim({ claimId: 'wrong-policy', policyVersion: 'policy-2' }),
        '2',
        'claim:wrong-policy',
      ),
    ).toThrow(/policy|version/i);
    expect(() =>
      save(
        prospectiveClaim({
          claimId: 'global-scope',
          scope: { kind: 'global' } as DecisionScope,
        }),
        '2',
        'claim:global-scope',
      ),
    ).toThrow(/scope|category|account/i);
    expect(() =>
      save(
        prospectiveClaim({ claimId: 'missing-source', sourceId: '' }),
        '2',
        'claim:missing-source',
      ),
    ).toThrow(/source|obligation|economic/i);
  });
  it('does not replay a sensitive transition result after its scope grant is revoked', () => {
    save(
      prospectiveClaim({
        claimId: 'revoked-replay',
        sourceId: 'private:source:replay',
        scope: { kind: 'account', id: privateAccountId },
        amount: money('777'),
      }),
      '0',
      'claim:revoked-replay:save',
    );
    const transition = {
      actorId,
      budgetId,
      claimId: 'revoked-replay',
      transition: 'release' as const,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'claim:revoked-replay:transition',
      now,
    };
    const first = store.liquidity.transitionProspectiveClaim(transition);
    expect(first).toMatchObject({
      claimId: 'revoked-replay',
      sourceId: 'private:source:replay',
      amount: money('777'),
      visibility: 'visible',
    });

    store.liquidity.setResourceGrant({
      actorId,
      budgetId,
      capability: 'liquidity',
      resourceKind: 'account',
      resourceId: privateAccountId,
      granted: false,
      now,
    });
    expect(() => store.liquidity.transitionProspectiveClaim(transition)).toThrow(
      /authoriz|scope|grant/i,
    );
  });

  it('serializes a transfer against prospective admission through the same shared claim revision', () => {
    const transfer = store.liquidity.admitTransferProposal(
      {
        actorId,
        budgetId,
        plan: transferPlan(),
        expectedClaimSetRevision: '0',
        idempotencyKey: 'transfer:first',
        now,
      },
      permit(),
    );
    expect(transfer.id).toBeTypeOf('string');
    expect(currentClaims().revision).toBe('1');

    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          actorId,
          budgetId,
          plan: { ...transferPlan('b'.repeat(64)), claimSetRevision: '0' },
          expectedClaimSetRevision: '0',
          idempotencyKey: 'transfer:stale',
          now,
        },
        permit(),
      ),
    ).toThrow(/revision|conflict/i);

    expect(() =>
      save(
        prospectiveClaim({ claimId: 'stale-after-transfer', sourceId: 'obligation:transfer' }),
        '0',
        'claim:stale-after-transfer',
        permit(),
      ),
    ).toThrow(/revision|conflict/i);
  });

  it('lists shared authorized claims without revealing hidden claim existence or lifecycle', async () => {
    save(
      prospectiveClaim({
        claimId: 'shared-food',
        sourceId: 'obligation:shared',
        amount: money('20'),
        scope: { kind: 'category', id: categoryId },
      }),
      '0',
      'claim:shared',
    );
    save(
      prospectiveClaim({
        claimId: 'private-account',
        sourceId: 'private:source:777',
        amount: money('777'),
        scope: { kind: 'account', id: privateAccountId },
      }),
      '1',
      'claim:private',
    );

    const readerId = 'reader';
    await store.upsertActorMembership(
      readerId,
      'active',
      ['liquidity:conclusion', 'liquidity:liquidity'],
      `budget:${budgetId}`,
    );
    for (const capability of ['conclusion', 'liquidity'] as const)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['category', categoryId],
      ] as const)
        store.liquidity.setResourceGrant({
          actorId: readerId,
          budgetId,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });

    const visible = store.liquidity.listProspectiveClaims({
      actorId: readerId,
      budgetId,
      now,
    });
    expect(visible).toEqual([
      expect.objectContaining({
        claimId: 'shared-food',
        visibility: 'visible',
        amount: money('20'),
        scope: { kind: 'category', id: categoryId },
      }),
    ]);
    store.liquidity.transitionProspectiveClaim({
      actorId,
      budgetId,
      claimId: 'private-account',
      transition: 'release',
      expectedClaimSetRevision: '2',
      idempotencyKey: 'claim:private-release',
      now,
    });
    expect(store.liquidity.listProspectiveClaims({ actorId: readerId, budgetId, now })).toEqual(
      visible,
    );

    for (const capability of ['conclusion', 'liquidity', 'proposal'] as const)
      store.liquidity.setResourceGrant({
        actorId,
        budgetId,
        capability,
        resourceKind: 'category',
        resourceId: categoryId,
        granted: false,
        now,
      });
    expect(() =>
      save(
        prospectiveClaim({ claimId: 'unauthorized-category', sourceId: 'obligation:denied' }),
        '3',
        'claim:denied',
      ),
    ).toThrow(/authoriz|scope/i);

    expect(() =>
      store.liquidity.listProspectiveClaims({ actorId: 'outsider', budgetId, now }),
    ).toThrow(/authoriz|member/i);
  });
});
