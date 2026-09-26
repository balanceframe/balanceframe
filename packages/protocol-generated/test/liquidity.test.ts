import { describe, expect, it } from 'vitest';
import * as validators from '../src/validators';
import fs from 'node:fs';

const evidence = {
  state: 'unknown',
  source: 'actual_ledger',
  observedAt: null,
  expiresAt: null,
  reasons: ['missing'],
};
const category = {
  categoryId: 'card-payment',
  cashBucketId: 'card-payment:2026-09',
  asOfMonth: '2026-09',
  kind: 'credit_payment',
  periodKind: 'future',
  availability: { minorUnits: '0', currency: 'USD' },
  evidence,
};

describe('account-aware liquidity trust boundary', () => {
  it('preserves future credit-payment semantics and unknown evidence without completing it', () => {
    expect(validators.categoryLiquidityFactSchema.parse(category)).toEqual(category);
    expect(
      validators.categoryLiquidityFactSchema.safeParse({ ...category, kind: 'future' }).success,
    ).toBe(false);
    expect(validators.factEvidenceSchema.safeParse({ state: 'known' }).success).toBe(false);
  });

  it.each(['9223372036854775808', '-9223372036854775809', '01', '-0', '1.5'])(
    'rejects invalid liquidity Money %s',
    (minorUnits) => {
      expect(
        validators.categoryLiquidityFactSchema.safeParse({
          ...category,
          availability: { minorUnits, currency: 'USD' },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects unknown object fields and malformed source month rather than stripping facts', () => {
    expect(
      validators.categoryLiquidityFactSchema.safeParse({ ...category, available: true }).success,
    ).toBe(false);
    expect(
      validators.categoryLiquidityFactSchema.safeParse({ ...category, asOfMonth: '2026-13' })
        .success,
    ).toBe(false);
    expect(
      validators.categoryLiquidityFactSchema.safeParse({
        ...category,
        availability: { ...category.availability, bankConfirmed: true },
      }).success,
    ).toBe(false);
  });

  it('preserves source date precision for Actual settlement without accepting impossible dates', () => {
    const record = {
      id: 'import-side',
      accountId: 'cash',
      amount: { minorUnits: '-100', currency: 'USD' },
      observedAt: '2026-09-06T12:00:00Z',
      occurredAt: '2026-09-06',
      importedId: 'source-import',
      providerReference: null,
      pairId: 'pair',
      reconciled: true,
      reversed: false,
      provenance: 'actual_import',
    };
    expect(validators.transferSettlementRecordSchema.parse(record).occurredAt).toBe('2026-09-06');
    expect(
      validators.transferSettlementRecordSchema.safeParse({ ...record, occurredAt: '2026-02-30' })
        .success,
    ).toBe(false);
    expect(
      validators.transferSettlementRecordSchema.safeParse({ ...record, observedAt: '2026-09-06' })
        .success,
    ).toBe(false);
  });

  it('requires explicit source coverage without treating absent or string values as complete', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        new URL('../../../protocol/fixtures/account-aware-liquidity.json', import.meta.url),
        'utf8',
      ),
    );
    const incomplete = { ...fixture, sourceCoverageComplete: false };
    expect(validators.liquidityInputSchema.parse(incomplete).sourceCoverageComplete).toBe(false);
    const missing = { ...fixture };
    delete missing.sourceCoverageComplete;
    expect(validators.liquidityInputSchema.safeParse(missing).success).toBe(false);
    expect(
      validators.liquidityInputSchema.safeParse({ ...fixture, sourceCoverageComplete: 'true' })
        .success,
    ).toBe(false);
  });

  it('reads old canonical snapshots without asserting liquidity facts', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        new URL('../../../protocol/fixtures/financial-decision-foundation.json', import.meta.url),
        'utf8',
      ),
    );
    expect(validators.financialSnapshotSchema.parse(fixture.full)).not.toHaveProperty('liquidity');
    expect(
      validators.financialSnapshotSchema.parse({ ...fixture.full, liquidity: null }).liquidity,
    ).toBeNull();
  });
  it('accepts an explicit source obligation on a scoped claim without accepting non-string links', () => {
    const effect = {
      kind: 'category',
      resourceId: 'food',
      amount: { minorUnits: '1000', currency: 'USD' },
      economicObligationId: 'schedule:shared:category:food',
      sourceEconomicObligationId: 'schedule:shared',
      categoryId: 'food',
      includedInBalance: false,
      matchedTransactionIds: [],
    };
    expect(validators.liquidityClaimEffectSchema.parse(effect)).toEqual(effect);
    expect(validators.liquidityClaimEffectSchema.safeParse({
      ...effect, sourceEconomicObligationId: 1000,
    }).success).toBe(false);
  });
});
