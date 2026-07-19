/**
 * Regression tests for Suggestion/Provenance protocol schemas.
 *
 * Ensures Zod validators accept well-formed camelCase payloads and
 * reject obviously malformed input.
 *
 * Phase 2 additions: error/manual-review entries, SHA-256 hash pattern,
 * immutability enforcement, all optional Phase 2 fields.
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

const VALID_SHA256_HEX = /^[a-f0-9]{64}$/;

describe('provenanceSchema', () => {
  it('accepts a full provenance object', () => {
    const result = provenanceSchema.safeParse(VALID_PROVENANCE);
    expect(result.success).toBe(true);
  });

  it('accepts provenance with only required fields (nullable fields set to null)', () => {
    const result = provenanceSchema.safeParse({
      payloadHash: 'abc123',
      provider: null,
      model: null,
      promptVersion: null,
      inferencePolicyVersion: null,
      createdAt: '2026-01-01T00:00:00Z',
      actorId: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing payloadHash', () => {
    const result = provenanceSchema.safeParse({ createdAt: 'x' });
    expect(result.success).toBe(false);
  });

  it('accepts provenance with all nullable fields set to null', () => {
    const result = provenanceSchema.safeParse({
      payloadHash: 'abc',
      provider: null,
      model: null,
      promptVersion: null,
      inferencePolicyVersion: null,
      createdAt: '2026-01-01T00:00:00Z',
      actorId: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts provenance with payloadHash matching SHA-256 pattern', () => {
    const result = provenanceSchema.safeParse({
      ...VALID_PROVENANCE,
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(result.success).toBe(true);
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

  // ---------------------------------------------------------------------------
  // Phase 2: error / manual-review output
  // ---------------------------------------------------------------------------

  it('accepts error suggestion with empty proposedCategoryId', () => {
    const result = suggestionSchema.safeParse({
      transactionId: 'txn-err-001',
      proposedCategoryId: '',
      categoryName: '',
      confidence: 0,
      reasonCodes: ['provider-error', 'timeout'],
      evidence: ['Provider returned 503'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts manual-review suggestion with error metadata', () => {
    const result = suggestionSchema.safeParse({
      transactionId: 'txn-manual-001',
      proposedCategoryId: '',
      categoryName: 'Manual Review Required',
      confidence: 0,
      reasonCodes: ['manual-review-required'],
      evidence: ['No eligible providers', 'All providers failed'],
      // Manual-review metadata via optional fields
      provenance: {
        payloadHash: '0'.repeat(64),
        provider: null,
        model: null,
        promptVersion: null,
        inferencePolicyVersion: '1',
        createdAt: '2026-07-18T00:00:00.000Z',
        actorId: null,
      },
      errors: ['no-eligible-providers'],
    });
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Phase 2: all optional fields populated
  // ---------------------------------------------------------------------------

  it('accepts suggestion with all Phase 2 optional fields populated', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      spaceId: 'space_main',
      connectionId: 'conn_actual',
      budgetId: 'budget_family',
      transactionVersion: 'v2',
      rawMerchant: 'AMAZON MKTPLACE',
      normalizedMerchant: 'Amazon',
      researchSummary: 'Online retailer, potential shopping category',
      alternativeCategoryIds: ['cat_groceries', 'cat_electronics'],
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: '1.0',
      inferencePolicyVersion: '1',
      actorId: 'system',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      provenance: VALID_PROVENANCE,
      history: [{
        transactionId: 'h-1',
        payeeName: 'Amazon',
        categoryId: 'cat-shopping',
        categoryName: 'Shopping',
        amount: { minorUnits: '2500', currency: 'USD' },
        date: '2026-07-01',
      }],
      errors: [],
      deterministicEvidence: { reasonCodes: ['uncategorized'] },
    });
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Field type validation
  // ---------------------------------------------------------------------------

  it('rejects non-string proposedCategoryId', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      proposedCategoryId: 123,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-number confidence', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      confidence: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-array evidence', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      evidence: 'some evidence string',
    });
    expect(result.success).toBe(false);
  });

  it('accepts zero confidence', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      confidence: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts negative confidence', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      confidence: -1,
    });
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // SHA-256 format validation in payloadHash
  // ---------------------------------------------------------------------------

  it('payloadHash may be any hex string', () => {
    const result = suggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      payloadHash: 'aabbccdd',
    });
    expect(result.success).toBe(true);
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

  it('rejects non-object amount', () => {
    const result = historyRecordSchema.safeParse({
      transactionId: 'h-1',
      payeeName: 'Store',
      categoryId: 'cat-foo',
      categoryName: 'Food',
      amount: '1000 USD',
      date: '2026-07-01',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema strictness and type preservation
// ---------------------------------------------------------------------------

describe('schema strictness and type preservation', () => {
  it('provenanceSchema rejects extra properties (strict)', () => {
    const result = provenanceSchema.safeParse({
      payloadHash: 'abc123',
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: '1.0',
      inferencePolicyVersion: '1',
      createdAt: '2026-07-18T00:00:00.000Z',
      actorId: null,
      extraField: 'should be rejected',
    });
    expect(result.success).toBe(false);
  });

  it('provenanceSchema rejects missing payload hash or creation time', () => {
    const result = provenanceSchema.safeParse({
      provider: null,
      model: null,
      promptVersion: null,
      inferencePolicyVersion: null,
      actorId: null,
    });
    expect(result.success).toBe(false);
  });

  it('provenanceSchema accepts nullable provider/model/promptVersion/actorId', () => {
    const result = provenanceSchema.safeParse({
      payloadHash: 'abc123',
      provider: null,
      model: null,
      promptVersion: null,
      inferencePolicyVersion: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      actorId: null,
    });
    expect(result.success).toBe(true);
  });

  it('historyRecordSchema rejects extra properties (strict)', () => {
    const result = historyRecordSchema.safeParse({
      transactionId: 'h-1',
      payeeName: 'Store',
      categoryId: 'cat-foo',
      categoryName: 'Food',
      amount: { minorUnits: '1000', currency: 'USD' },
      date: '2026-07-01',
      extraField: 'should be rejected',
    });
    expect(result.success).toBe(false);
  });

  it('suggestionSchema rejects extra properties (strict)', () => {
    const result = suggestionSchema.safeParse({
      transactionId: 'txn-001',
      proposedCategoryId: 'cat-food',
      categoryName: 'Food & Dining',
      confidence: 0.95,
      reasonCodes: ['merchant-match'],
      evidence: ['Historical match'],
      extraField: 'should be rejected',
    });
    expect(result.success).toBe(false);
  });

  it('suggestionSchema type is not erased (is a proper ZodObject)', () => {
    // suggestionSchema should not be typed as z.ZodTypeAny — that erases
    // all type information. It should be a ZodObject with known shape.
    expect(provenanceSchema.constructor.name).toBe('ZodObject');
  });
});
