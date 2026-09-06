import fs from 'node:fs';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  liquidityInputSchema,
  financialSnapshotSchema,
} from '@balanceframe/protocol-generated/validators';

const load = (relative: string) =>
  JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));
const fixture = load('../../protocol/fixtures/account-aware-liquidity.json');
const ajv = new Ajv({ allErrors: true, strict: false });
for (const name of [
  'protocol-v1',
  'financial-snapshot-v1',
  'prospective-decision-v1',
  'prospective-claim-v1',
  'account-aware-liquidity-v1',
]) {
  ajv.addSchema(load(`../../protocol/json-schema/${name}.json`));
}
const validateInput = ajv.compile({
  $ref: 'https://balanceframe.dev/schemas/account-aware-liquidity-v1.json#/$defs/LiquidityInput',
});
const validateSnapshot = ajv.getSchema(
  'https://balanceframe.dev/schemas/financial-snapshot-v1.json',
)!;

describe('canonical Rust liquidity fixture boundaries', () => {
  it('accepts the same immutable fixture in TypeScript and independent JSON Schema', () => {
    expect(liquidityInputSchema.parse(fixture)).toEqual(fixture);
    expect(validateInput(fixture), JSON.stringify(validateInput.errors)).toBe(true);
    const snapshot = load('../../protocol/fixtures/financial-decision-foundation.json').full;
    snapshot.liquidity = fixture.facts;
    expect(financialSnapshotSchema.parse(snapshot).liquidity).toEqual(fixture.facts);
    expect(validateSnapshot(snapshot), JSON.stringify(validateSnapshot.errors)).toBe(true);
  });

  it('rejects overflow and unrecognized factual claims at both boundaries', () => {
    const overflowing = structuredClone(fixture);
    overflowing.facts.accounts[0].recordedBalance.minorUnits = '9223372036854775808';
    expect(liquidityInputSchema.safeParse(overflowing).success).toBe(false);
    expect(validateInput(overflowing)).toBe(false);
    const forged = structuredClone(fixture);
    forged.facts.accounts[0].bankVerified = true;
    expect(liquidityInputSchema.safeParse(forged).success).toBe(false);
    expect(validateInput(forged)).toBe(false);
  });

  it('rejects impossible calendar dates and malformed instants at both temporal boundaries', () => {
    const mutations = [
      (input: typeof fixture) => {
        input.evaluatedAt = '2026-02-30T10:00:00Z';
      },
      (input: typeof fixture) => {
        input.scenario.items[0].requiredBy = '2026-09-06T25:00:00Z';
      },
      (input: typeof fixture) => {
        input.validUntil = 'not-an-expiry';
      },
      (input: typeof fixture) => {
        input.facts.accounts[0].balanceEvidence.expiresAt = '2026-13-06T10:00:00Z';
      },
      (input: typeof fixture) => {
        input.facts.accounts[0].obligations = [
          {
            id: 'bill',
            economicObligationId: 'bill',
            categoryId: null,
            amount: { minorUnits: '100', currency: 'USD' },
            dueAt: '2026-02-30',
            paid: false,
            includedInBalance: false,
            matchedTransactionIds: [],
          },
        ];
      },
    ];
    for (const mutate of mutations) {
      const malformed = structuredClone(fixture);
      mutate(malformed);
      expect(liquidityInputSchema.safeParse(malformed).success).toBe(false);
      expect(validateInput(malformed), JSON.stringify(malformed)).toBe(false);
    }
  });

  it('preserves unavailable evidence and independent future semantic kinds', () => {
    const unknown = structuredClone(fixture);
    unknown.facts.categories[0].kind = 'credit_payment';
    unknown.facts.categories[0].periodKind = 'future';
    unknown.facts.categories[0].evidence = {
      state: 'unavailable',
      source: 'actual_ledger',
      observedAt: null,
      expiresAt: null,
      reasons: ['not_exposed'],
    };
    expect(liquidityInputSchema.parse(unknown)).toEqual(unknown);
    expect(validateInput(unknown), JSON.stringify(validateInput.errors)).toBe(true);
  });
});
