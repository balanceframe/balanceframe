import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  TransactionEvidenceRequestSchema,
  TransactionEvidenceResultSchema,
} from '../src/validators.ts';
const fixture = JSON.parse(
  fs.readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence.json', import.meta.url),
    'utf8',
  ),
);
const result = JSON.parse(
  fs.readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-result.json', import.meta.url),
    'utf8',
  ),
);
describe('canonical transaction evidence', () => {
  it('accepts canonical request and native resolution', () => {
    expect(TransactionEvidenceRequestSchema.parse(fixture)).toEqual(fixture);
    expect(TransactionEvidenceResultSchema.parse(result)).toEqual(result);
  });
  it.each(['2', '', null])('rejects unsupported version %s', (version) => {
    expect(
      TransactionEvidenceRequestSchema.safeParse({ ...fixture, contractVersion: version }).success,
    ).toBe(false);
  });
  it.each(['01', '-1', '1.1', '9223372036854775808'])(
    'rejects noncanonical or overflow amounts %s',
    (amount) => {
      const invalid = structuredClone(fixture);
      invalid.observations[0].amount.minorUnits = amount;
      expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
    },
  );
  it('rejects partial, malformed and unexpected source payloads', () => {
    for (const change of [
      { kind: 'raw_mailbox' },
      { date: '2026-02-30' },
      { reliability: 101 },
      { amount: { minorUnits: '10', currency: 'usd' } },
      { raw: 'private' },
    ]) {
      const invalid = structuredClone(fixture);
      Object.assign(invalid.observations[0], change);
      expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
    }
    const invalid = structuredClone(fixture);
    delete invalid.observations[0].externalEventId;
    expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
  });
});

it('validates approved projection evidence and scoped rule simulation inputs', async () => {
  const { createRequire } = await import('node:module');
  const { EvidenceRuleSimulationRequestSchema, EvidenceRuleSimulationResultSchema } =
    await import('../src/validators.ts');
  const native = createRequire(import.meta.url)(
    '../../../crates/node-binding/balanceframe.node',
  ) as {
    resolveTransactionEvidence(input: string): string;
    simulateTransactionEvidenceRule(input: string): string;
  };
  const projection = JSON.parse(
    fs.readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-projection.json', import.meta.url),
      'utf8',
    ),
  );
  expect(TransactionEvidenceRequestSchema.safeParse(projection).success).toBe(true);
  const projected = JSON.parse(native.resolveTransactionEvidence(JSON.stringify(projection)));
  expect(projected.events[0].projectionObservation).not.toBeNull();
  expect(TransactionEvidenceResultSchema.safeParse(projected).success).toBe(true);
  const rule = JSON.parse(
    fs.readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-rule.json', import.meta.url),
      'utf8',
    ),
  );
  expect(EvidenceRuleSimulationRequestSchema.safeParse(rule).success).toBe(true);
  expect(
    EvidenceRuleSimulationResultSchema.safeParse(
      JSON.parse(native.simulateTransactionEvidenceRule(JSON.stringify(rule))),
    ).success,
  ).toBe(true);
  rule.rule.sku = null;
  expect(EvidenceRuleSimulationRequestSchema.safeParse(rule).success).toBe(false);
});

it('accepts explicit contextual criteria while preserving legacy rule shape and rejecting mixed or forged scopes', async () => {
  const { EvidenceRuleProposalSchema } = await import('../src/validators.ts');
  const bundle = JSON.parse(
    fs.readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-rule.json', import.meta.url),
      'utf8',
    ),
  );
  expect(EvidenceRuleProposalSchema.parse(bundle.rule)).toEqual(bundle.rule);
  for (const kind of [
    'retailer_mapping',
    'department',
    'product_family',
    'historical_similarity',
  ]) {
    const rule = {
      ...bundle.rule,
      sku: null,
      normalizedDescription: null,
      criterion: { kind, value: 'fresh green apples' },
    };
    expect(EvidenceRuleProposalSchema.parse(rule)).toEqual(rule);
    expect(EvidenceRuleProposalSchema.safeParse({ ...rule, sku: 'also-exact' }).success).toBe(
      false,
    );
  }
  for (const criterion of [
    null,
    { kind: 'opaque_model', value: 'produce' },
    { kind: 'department', value: '   ' },
    { kind: 'department', value: 'fruit', threshold: 1 },
    { kind: 'historical_similarity', value: 'apple' },
  ])
    expect(
      EvidenceRuleProposalSchema.safeParse({ ...bundle.rule, sku: null, criterion }).success,
    ).toBe(false);
});
