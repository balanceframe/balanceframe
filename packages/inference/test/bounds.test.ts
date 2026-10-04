/**
 * Tests for strict model output bounds.
 *
 * Provider output is validated against bounded Zod schemas after parsing.
 */
import { describe, it, expect } from 'vitest';

// Exercise the bounded schemas exported by validators.
import { classificationResultSchema, alternativeSchema } from '../src/validators';

describe('provider output bounds', () => {
  describe('alternative bounds', () => {
    it('accepts valid alternative', () => {
      const result = alternativeSchema.safeParse({
        categoryId: 'cat_food',
        reason: 'Looks like groceries',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty categoryId', () => {
      const result = alternativeSchema.safeParse({
        categoryId: '',
        reason: 'Empty',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty reason', () => {
      const result = alternativeSchema.safeParse({
        categoryId: 'cat_food',
        reason: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('classification result bounds', () => {
    it('accepts valid classification result', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_food',
        confidence: 0.85,
        alternatives: [{ categoryId: 'cat_dining', reason: 'Dining out' }],
        rationale: 'Matched restaurant pattern',
        model: 'gpt-4',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty categoryId', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: '',
        confidence: 0.5,
        alternatives: [],
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('rejects confidence > 1', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: 1.5,
        alternatives: [],
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('rejects confidence < 0', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: -0.1,
        alternatives: [],
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('accepts null confidence', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: null,
        alternatives: [],
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(true);
      expect(result.data?.confidence).toBeNull();
    });

    it('rejects empty rationale string', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: 0.5,
        alternatives: [],
        rationale: '',
        model: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty model string', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: 0.5,
        alternatives: [],
        rationale: 'test',
        model: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-number confidence', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: 'high',
        alternatives: [],
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('rejects overly large alternatives array', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: 0.5,
        alternatives: new Array(50).fill(null).map((_, i) => ({
          categoryId: `cat_${i}`,
          reason: `Reason ${i}`,
        })),
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('accepts max allowed alternatives', () => {
      const result = classificationResultSchema.safeParse({
        categoryId: 'cat_x',
        confidence: 0.5,
        alternatives: new Array(10).fill(null).map((_, i) => ({
          categoryId: `cat_${i}`,
          reason: `Reason ${i}`,
        })),
        rationale: 'test',
        model: 'test',
      });
      expect(result.success).toBe(true);
    });
  });
});
