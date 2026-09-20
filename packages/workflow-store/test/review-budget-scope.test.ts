import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '../src/store.js';

describe('selected-budget review disclosure', () => {
  it('scopes list pagination and status counts before applying limits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-budget-scope-'));
    const store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    try {
      await store.createReviewItem({
        budgetId: 'private',
        transactionId: 'private',
        categoryId: 'food',
        classifier: 'deterministic',
        provenance: 'actual',
        priority: 100,
      });
      const first = await store.createReviewItem({
        budgetId: 'selected',
        transactionId: 'one',
        categoryId: 'food',
        classifier: 'deterministic',
        provenance: 'actual',
        priority: 10,
      });
      const second = await store.createReviewItem({
        budgetId: 'selected',
        transactionId: 'two',
        categoryId: 'food',
        classifier: 'deterministic',
        provenance: 'actual',
        priority: 5,
      });
      expect(
        (await store.listReviewItems({ budgetId: 'selected', limit: 1 })).map((item) => item.id),
      ).toEqual([first.id]);
      expect(
        (await store.listReviewItems({ budgetId: 'selected', limit: 1, offset: 1 })).map(
          (item) => item.id,
        ),
      ).toEqual([second.id]);
      expect(await store.countReviewItems({ budgetId: 'selected', status: 'discovered' })).toBe(2);
      expect(await store.countReviewItems({ budgetId: 'private' })).toBe(1);
      expect(await store.listReviewItems({ budgetId: 'missing' })).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
