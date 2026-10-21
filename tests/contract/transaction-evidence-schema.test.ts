import { registerProtocolSchemas } from './src/schema-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { describe, it, expect } from 'vitest';
import {
  TransactionEvidenceRequestSchema,
  TransactionEvidenceResultSchema,
  EvidenceRuleSimulationRequestSchema,
} from '@balanceframe/protocol-generated/validators';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const fixture = read('protocol/fixtures/transaction-evidence.json');
const native = createRequire(import.meta.url)('../../crates/node-binding/balanceframe.node') as {
  resolveTransactionEvidence(input: string): string;
  simulateTransactionEvidenceRule(input: string): string;
};
const ajv = new Ajv({ strict: false });
registerProtocolSchemas(ajv);
const ref = (name: string) =>
  ajv.compile({
    $ref: `https://balanceframe.dev/schemas/transaction-evidence-v1.json#/$defs/${name}`,
  });
describe('transaction evidence Rust / Zod / JSON Schema contract', () => {
  it.each([
    ['lines', 1000],
    ['tenders', 100],
  ] as const)('bounds receipt %s consistently across every public boundary', (field, maximum) => {
    const invalid = read('protocol/fixtures/transaction-evidence-receipt.json');
    const item = invalid.receipts[0][field][0];
    invalid.receipts[0][field] = Array.from({ length: maximum + 1 }, (_, index) => ({
      ...item,
      id: `bounded-${index}`,
      ...(field === 'tenders' ? { observationId: null } : {}),
    }));
    expect(ref('TransactionEvidenceRequest')(invalid)).toBe(false);
    expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
    expect(() => native.resolveTransactionEvidence(JSON.stringify(invalid))).toThrow(
      /receipt_size/,
    );
  });
  it('round trips canonical request and native resolution', () => {
    expect(ref('TransactionEvidenceRequest')(fixture)).toBe(true);
    expect(TransactionEvidenceRequestSchema.parse(fixture)).toEqual(fixture);
    const result = JSON.parse(native.resolveTransactionEvidence(JSON.stringify(fixture)));
    expect(TransactionEvidenceResultSchema.parse(result)).toEqual(result);
    expect(ref('TransactionEvidenceResult')(result)).toBe(true);
    expect(result).toEqual(read('protocol/fixtures/transaction-evidence-result.json'));
  });
  it.each(['01', '-1', '1.1', '9223372036854775808'])(
    'rejects malformed monetary input %s in all boundaries',
    (amount) => {
      const invalid = structuredClone(fixture);
      invalid.observations[0].amount.minorUnits = amount;
      expect(ref('TransactionEvidenceRequest')(invalid)).toBe(false);
      expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
      expect(() => native.resolveTransactionEvidence(JSON.stringify(invalid))).toThrow();
    },
  );
  it('rejects missing nullable source identities, wrong versions, raw fields and impossible dates', () => {
    for (const field of ['externalEventId', 'walletId', 'ledgerEffect']) {
      const invalid = structuredClone(fixture);
      delete invalid.observations[0][field];
      expect(ref('TransactionEvidenceRequest')(invalid)).toBe(false);
      expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
      expect(() => native.resolveTransactionEvidence(JSON.stringify(invalid))).toThrow();
    }
    for (const change of [{ contractVersion: '2' }, { rawMailbox: 'private' }]) {
      const invalid = { ...fixture, ...change };
      expect(ref('TransactionEvidenceRequest')(invalid)).toBe(false);
      expect(TransactionEvidenceRequestSchema.safeParse(invalid).success).toBe(false);
      expect(() => native.resolveTransactionEvidence(JSON.stringify(invalid))).toThrow();
    }
  });
});

it('binds reviewed effects and explicit partial tender flags across all boundaries', () => {
  const approved = read('protocol/fixtures/transaction-evidence-projection.json');
  expect(ref('TransactionEvidenceRequest')(approved)).toBe(true);
  expect(TransactionEvidenceRequestSchema.safeParse(approved).success).toBe(true);
  const result = JSON.parse(native.resolveTransactionEvidence(JSON.stringify(approved)));
  expect(result).toEqual(read('protocol/fixtures/transaction-evidence-projection-result.json'));
  expect(ref('TransactionEvidenceResult')(result)).toBe(true);
  approved.observations[0].reviewedLedgerEffect = false;
  expect(() => native.resolveTransactionEvidence(JSON.stringify(approved))).toThrow(
    /unapproved_ledger_effect/,
  );
  const receipt = read('protocol/fixtures/transaction-evidence-receipt.json');
  receipt.receipts[0].tenders[0].partial = true;
  expect(ref('TransactionEvidenceRequest')(receipt)).toBe(true);
  expect(TransactionEvidenceRequestSchema.safeParse(receipt).success).toBe(true);
  expect(
    JSON.parse(native.resolveTransactionEvidence(JSON.stringify(receipt))).receipts[0].valid,
  ).toBe(true);
  receipt.receipts[0].tenders[0].partial = 'true';
  expect(ref('TransactionEvidenceRequest')(receipt)).toBe(false);
  expect(TransactionEvidenceRequestSchema.safeParse(receipt).success).toBe(false);
  expect(() => native.resolveTransactionEvidence(JSON.stringify(receipt))).toThrow();
});

it.each([undefined, null, '', '   ', 'Store\nA'])(
  'rejects unscoped or blank merchant item rules at all three boundaries: %s',
  (counterparty) => {
    const invalid = read('protocol/fixtures/transaction-evidence-rule.json');
    if (counterparty === undefined) delete invalid.rule.counterparty;
    else invalid.rule.counterparty = counterparty;
    expect(ref('EvidenceRuleSimulationRequest')(invalid)).toBe(false);
    expect(EvidenceRuleSimulationRequestSchema.safeParse(invalid).success).toBe(false);
    expect(() => native.simulateTransactionEvidenceRule(JSON.stringify(invalid))).toThrow();
  },
);
it('preserves an explicit exact merchant criterion in the rule contract', () => {
  const request = read('protocol/fixtures/transaction-evidence-rule.json');
  request.rule.counterparty = 'person-1';
  expect(ref('EvidenceRuleSimulationRequest')(request)).toBe(true);
  expect(EvidenceRuleSimulationRequestSchema.parse(request).rule.counterparty).toBe('person-1');
  expect(
    JSON.parse(native.simulateTransactionEvidenceRule(JSON.stringify(request))).matches,
  ).toHaveLength(1);
});

it('round trips explicit reviewed line outcomes and native repeated candidates without accepting imported training', async () => {
  const { EvidenceItemRuleLearningRequestSchema, EvidenceItemRuleLearningResultSchema } =
    await import('@balanceframe/protocol-generated/validators');
  const binding = native as typeof native & {
    learnTransactionEvidenceItemRules(input: string): string;
  };
  const request = read('protocol/fixtures/transaction-evidence-item-learning.json');
  expect(ref('EvidenceItemRuleLearningRequest')(request)).toBe(true);
  expect(EvidenceItemRuleLearningRequestSchema.parse(request)).toEqual(request);
  const result = JSON.parse(binding.learnTransactionEvidenceItemRules(JSON.stringify(request)));
  expect(EvidenceItemRuleLearningResultSchema.parse(result)).toEqual(result);
  expect(ref('EvidenceItemRuleLearningResult')(result)).toBe(true);
  expect(result.candidates).toHaveLength(1);
  for (const field of ['categoryId', 'sourceIdentity', 'documentId', 'policyVersion']) {
    const invalid = structuredClone(request);
    delete invalid.outcomes[0][field];
    expect(ref('EvidenceItemRuleLearningRequest')(invalid)).toBe(false);
    expect(EvidenceItemRuleLearningRequestSchema.safeParse(invalid).success).toBe(false);
    expect(() => binding.learnTransactionEvidenceItemRules(JSON.stringify(invalid))).toThrow();
  }
  request.outcomes = [];
  expect(
    JSON.parse(binding.learnTransactionEvidenceItemRules(JSON.stringify(request))).candidates,
  ).toEqual([]);
});

it('round trips contextual rule criteria and broader risk across all three boundaries without upgrading exact rules', () => {
  const fixture = read('protocol/fixtures/transaction-evidence-rule-context.json');
  for (const [kind, value, field] of [
    ['retailer_mapping', 'two items', 'rawDescription'],
    ['department', 'produce', 'department'],
    ['product_family', 'fruit', 'productFamily'],
    ['historical_similarity', 'fresh green apples', 'normalizedDescription'],
  ]) {
    const request = structuredClone(fixture);
    request.rule.criterion = { kind, value };
    request.evidence.receipts[0].lines[0][field] = value;
    expect(ref('EvidenceRuleSimulationRequest')(request)).toBe(true);
    expect(EvidenceRuleSimulationRequestSchema.parse(request)).toEqual(request);
    const result = JSON.parse(native.simulateTransactionEvidenceRule(JSON.stringify(request)));
    expect(result.falsePositiveRisk).toBe('broader_scope_review_required');
    expect(ref('EvidenceRuleSimulationResult')(result)).toBe(true);
  }
  for (const change of [
    { criterion: null },
    { sku: 'also-exact' },
    { criterion: { kind: 'department', value: ' ' } },
    { criterion: { kind: 'opaque_model', value: 'produce' } },
  ]) {
    const invalid = { ...fixture, rule: { ...fixture.rule, ...change } };
    expect(ref('EvidenceRuleSimulationRequest')(invalid)).toBe(false);
    expect(EvidenceRuleSimulationRequestSchema.safeParse(invalid).success).toBe(false);
    expect(() => native.simulateTransactionEvidenceRule(JSON.stringify(invalid))).toThrow();
  }
});
