/**
 * Regression tests for Suggestion/Provenance protocol schemas.
 *
 * Ensures Zod validators accept well-formed camelCase payloads and
 * reject obviously malformed input.
 */
import { describe, it, expect } from 'vitest';
import {
  provenanceSchema,
  suggestionSchema,
  historyRecordSchema,
} from '../src/validators.js';

const VALID_PROVENANCE = {
  payloadHash: 'abc123',
  provider: 'openai',
  model: 'gpt-4',
  promptVersion: '1.0',
  inferencePolicyVersion: '1',
  createdAt: '2026-07-18T00:00:00.000Z',
  actorId: null,
};

const VALID_SUGGESTION = {
  transactionId: 'txn-001',
  proposedCategoryId: 'cat-food',
  categoryName: 'Food & Dining',
  confidence: 0.95,
  reasonCodes: ['merchant-match'],
  evidence: ['Merchant "AMZN" mapped to shopping'],
  rationale: 'Historical match',
  createdAt: '2026-07-18T00:00:00.000Z',
};

describe('provenanceSchema', () => {
  it('accepts a full provenance object', () => {
    const result = provenanceSchema.safeParse(VALID_PROVENANCE);
    expect(result.success).toBe(true);
  });

  it('accepts minimal provenance (only required fields)', () => {
    const result = provenanceSchema.safeParse({
      payloadHash: 'abc',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing payloadHash', () => {
    const result = provenanceSchema.safeParse({ createdAt: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('suggestionSchema', () => {
  it('accepts a full suggestion object', () => {
    const result = suggestionSchema.safeParse(VALID_SUGGESTION);
    expect(result.success).toBe(true);
  });

  it('rejects missing required transactionId', () => {
    const { proposedCategoryId, categoryName, confidence, reasonCodes, evidence } = VALID_SUGGESTION;
    const result = suggestionSchema.safeParse({ proposedCategoryId, categoryName, confidence, reasonCodes, evidence });
    expect(result.success).toBe(false);
  });

  it('accepts suggestion with optional fields omitted', () => {
    const result = suggestionSchema.safeParse({
      transactionId: 'txn-002',
      proposedCategoryId: '',
      categoryName: 'Uncategorized',
      confidence: 0,
      reasonCodes: [],
      evidence: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts suggestion with nested provenance', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      provenance: VALID_PROVENANCE,
    });
    expect(result.success).toBe(true);
  });

  it('accepts suggestion with history records', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      history: [{
        transactionId: 'h-1',
        payeeName: 'Store',
        categoryId: 'cat-foo',
        categoryName: 'Food',
        amount: { minorUnits: '1000', currency: 'USD' },
        date: '2026-07-01',
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects history record missing required fields', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      history: [{ payeeName: 'Store' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('historyRecordSchema', () => {
  it('accepts valid history record', () => {
    const result = historyRecordSchema.safeParse({
      transactionId: 'h-1',
      payeeName: 'Amazon',
      categoryId: 'cat-shopping',
      categoryName: 'Shopping',
      amount: { minorUnits: '2500', currency: 'USD' },
      date: '2026-07-01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty object', () => {
    const result = historyRecordSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts history with extended fields (categoryName, amount, date)', () => {
    const result = historyRecordSchema.safeParse({
      transactionId: 'h-1',
      payeeName: 'Store',
      categoryId: 'cat-foo',
      categoryName: 'Food',
      amount: { minorUnits: '1000', currency: 'USD' },
      date: '2026-07-01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects history record missing amount field', () => {
    const result = historyRecordSchema.safeParse({
      transactionId: 'h-1',
      payeeName: 'Store',
      categoryId: 'cat-foo',
      categoryName: 'Food',
      date: '2026-07-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects history record missing date field', () => {
    const result = historyRecordSchema.safeParse({
      transactionId: 'h-1',
      payeeName: 'Store',
      categoryId: 'cat-foo',
      categoryName: 'Food',
      amount: { minorUnits: '1000', currency: 'USD' },
    });
    expect(result.success).toBe(false);
  });
});
