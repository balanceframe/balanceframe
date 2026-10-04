import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/index';

describe('review command parsing', () => {
  it('keeps individual actions scoped to their explicit review ID', () => {
    const cases: Array<{ args: string[]; command: string; reviewId?: string; categoryId?: string }> = [
      { args: ['reviews', 'show', 'rev_1'], command: 'reviews.show', reviewId: 'rev_1' },
      { args: ['reviews', 'approve', 'rev_1'], command: 'reviews.approve', reviewId: 'rev_1' },
      { args: ['reviews', 'correct', 'rev_1', 'cat_1'], command: 'reviews.correct', reviewId: 'rev_1', categoryId: 'cat_1' },
      { args: ['reviews', 'reject', 'rev_1'], command: 'reviews.reject', reviewId: 'rev_1' },
      { args: ['reviews', 'skip', 'rev_1'], command: 'reviews.skip', reviewId: 'rev_1' },
      { args: ['reviews', 'undo', 'rev_1'], command: 'reviews.undo', reviewId: 'rev_1' },
    ];

    for (const item of cases) {
      const result = parseArgs([...item.args, '--json']);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.cmd.command).toBe(item.command);
      expect(result.cmd.reviewId).toBe(item.reviewId);
      expect(result.cmd.categoryId).toBe(item.categoryId);
    }
  });

  it('requires an exact hash-map entry for each unique bulk review ID', () => {
    const result = parseArgs([
      'reviews',
      'approve-bulk',
      'rev_a',
      'rev_b',
      '--payload-hashes',
      '{"rev_a":"opaque-a","rev_b":"opaque-b"}',
      '--json',
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.approve-bulk');
    expect(result.cmd.ids).toEqual(['rev_a', 'rev_b']);
    expect(result.cmd.options?.['payload-hashes']).toBe('{"rev_a":"opaque-a","rev_b":"opaque-b"}');
  });

  it('rejects malformed or ambiguous bulk approval input', () => {
    const cases: string[][] = [
      ['reviews', 'approve-bulk', 'rev_a'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '{"rev_b":"opaque"}'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '{"rev_a":""}'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '[]'],
      ['reviews', 'approve-bulk', 'rev_a', 'rev_a', '--payload-hashes', '{"rev_a":"opaque"}'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '{"rev_a":"one"}', '--payload-hashes', '{"rev_a":"two"}'],
    ];

    for (const args of cases) expect(parseArgs(args).ok).toBe(false);
  });

  it('allows grouping unique review IDs without treating grouping as approval', () => {
    const result = parseArgs(['reviews', 'group', 'rev_a', 'rev_b', '--json']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.group');
    expect(result.cmd.ids).toEqual(['rev_a', 'rev_b']);
  });
});
