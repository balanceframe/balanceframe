import { registerProtocolSchemas } from './src/schema-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  CompareSpendSessionReceiptRequestSchema,
  CompareSpendSessionReceiptResultSchema,
} from '@balanceframe/protocol-generated/validators';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const fixture = read('protocol/fixtures/spend-session-receipt.json');
const ajv = new Ajv({ strict: false });
registerProtocolSchemas(ajv);
const validate = (name: string) =>
  ajv.compile({
    $ref: `https://balanceframe.dev/schemas/spend-session-receipt-v1.json#/$defs/${name}`,
  });
describe('saved session receipt comparison boundary', () => {
  it('preserves exact canonical saved metadata at schema and Zod boundaries', () => {
    expect(validate('CompareSpendSessionReceiptRequest')(fixture)).toBe(true);
    expect(CompareSpendSessionReceiptRequestSchema.parse(fixture)).toEqual(fixture);
  });
  it('rejects forged authority, missing nullable fields, invalid integer quantities and unsafe money', () => {
    for (const pointer of ['authority', 'quantity', 'money', 'missing']) {
      const invalid = structuredClone(fixture);
      if (pointer === 'authority') invalid.sessionSnapshot.authenticated = true;
      if (pointer === 'quantity') invalid.sessionSnapshot.intent.items[0].quantity = 1.5;
      if (pointer === 'money')
        invalid.sessionSnapshot.intent.items[0].amount.minorUnits = '9223372036854775808';
      if (pointer === 'missing') delete invalid.sessionSnapshot.intent.items[0].priceProvenance;
      expect(validate('CompareSpendSessionReceiptRequest')(invalid), pointer).toBe(false);
      expect(CompareSpendSessionReceiptRequestSchema.safeParse(invalid).success, pointer).toBe(
        false,
      );
    }
  });
  it('round trips native comparison and rejects stale intent or duplicate consumption', () => {
    const native = createRequire(import.meta.url)(
      '../../crates/node-binding/balanceframe.node',
    ) as { compareSpendSessionReceipt(input: string): string };
    const result = JSON.parse(native.compareSpendSessionReceipt(JSON.stringify(fixture)));
    expect(CompareSpendSessionReceiptResultSchema.parse(result)).toEqual(result);
    expect(validate('CompareSpendSessionReceiptResult')(result)).toBe(true);
    expect(result).toEqual(read('protocol/fixtures/spend-session-receipt-result.json'));
    for (const change of ['stale', 'duplicate', 'untrusted']) {
      const input = structuredClone(fixture);
      if (change === 'stale') input.sessionSnapshot.intent.items[0].amount.minorUnits = '1';
      if (change === 'duplicate') input.review.pairs.push(input.review.pairs[0]);
      if (change === 'untrusted') input.authority = 'trusted';
      expect(() => native.compareSpendSessionReceipt(JSON.stringify(input))).toThrow();
    }
  });
});
