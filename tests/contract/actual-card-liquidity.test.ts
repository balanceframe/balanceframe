import { describe, expect, it } from 'vitest';
import { actualLiquidityRequest } from './fixtures/actual-liquidity.js';
import { mergeUserAttestedLiquidityObservations } from '../../packages/actual-adapter/src/normalizer.js';

const cardObservation = {
  accountId: 'card',
  observedAt: '2026-09-06T10:00:00Z',
  expiresAt: '2026-09-06T10:15:00Z',
  kind: 'credit' as const,
  currency: 'USD',
  credit: {
    authorizationAvailable: { minorUnits: '5000', currency: 'USD' },
    pendingIncludedInAuthorization: true,
    paymentAccountId: 'cash',
    paymentCategoryId: 'card-payment',
    dueAt: '2026-09-06T18:00:00Z',
    reservedCash: { minorUnits: '0', currency: 'USD' },
    economicObligationId: 'card-cycle',
  },
};

describe('governed Actual card payment category designation', () => {
  it('designates stable category purpose across existing periods without altering authoritative availability', () => {
    const plain = actualLiquidityRequest(false, true).financialSnapshot;
    const before = plain.liquidity!.categories.find(
      (category) => category.categoryId === 'card-payment',
    )!;
    const future = {
      ...before,
      cashBucketId: 'actual:category:card-payment:2026-10',
      asOfMonth: '2026-10',
      periodKind: 'future' as const,
      availability: { minorUnits: '500', currency: 'USD' },
    };
    plain.liquidity!.categories.push(future);
    const attested = mergeUserAttestedLiquidityObservations(plain, [cardObservation]);
    const after = attested.liquidity!.categories.find(
      (category) => category.categoryId === 'card-payment',
    )!;
    expect(before.kind).toBe('ordinary');
    expect(after).toEqual({ ...before, kind: 'credit_payment' });
    expect(after.availability).toEqual({ minorUnits: '0', currency: 'USD' });
    expect(after.evidence.source).toBe('actual_ledger');
    expect(
      attested.liquidity!.categories.find(
        (category) => category.cashBucketId === future.cashBucketId,
      ),
    ).toEqual({ ...future, kind: 'credit_payment' });
    expect(
      attested.liquidity!.accounts.find((account) => account.accountId === 'card')!.credit!
        .evidence,
    ).toMatchObject({
      source: 'user_attested',
      reasons: ['explicit_user_attestation_not_bank_sync'],
    });
  });

  it.each(['income', 'future', 'missing', 'incompatible', 'unavailable'] as const)(
    'rejects a %s payment reserve category',
    (invalid) => {
      const snapshot = actualLiquidityRequest(false, true).financialSnapshot;
      const category = snapshot.liquidity!.categories.find(
        (item) => item.categoryId === 'card-payment',
      )!;
      if (invalid === 'income') category.kind = 'income';
      if (invalid === 'future') {
        category.periodKind = 'future';
        category.asOfMonth = '2026-10';
      }
      if (invalid === 'missing')
        snapshot.liquidity!.categories = snapshot.liquidity!.categories.filter(
          (item) => item !== category,
        );
      if (invalid === 'incompatible') category.availability.currency = 'EUR';
      if (invalid === 'unavailable') category.evidence.state = 'unavailable';
      expect(() => mergeUserAttestedLiquidityObservations(snapshot, [cardObservation])).toThrow(
        /Credit payment category/,
      );
    },
  );
});
