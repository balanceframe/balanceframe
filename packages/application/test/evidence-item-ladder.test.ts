import { describe, expect, it } from 'vitest';
import { prioritizeEvidenceItemSuggestions } from '../src/evidence-item-ladder.js';
import type { EvidenceRuleProposal } from '@balanceframe/protocol-generated';
const rule = (criterion?: {
  kind: 'department' | 'product_family' | 'historical_similarity' | 'retailer_mapping';
  value: string;
}): EvidenceRuleProposal => ({
  id: 'rule',
  sourceId: 'source',
  counterparty: 'Retailer',
  fundingInstrumentId: 'card',
  sku: criterion ? null : 'sku',
  normalizedDescription: null,
  categoryId: 'food',
  ...(criterion ? { criterion } : {}),
});
const match = (rule: EvidenceRuleProposal, categoryId: string) => ({
  rule,
  suggestion: {
    receiptId: 'receipt',
    lineId: 'line',
    categoryId,
    state: 'suggested' as 'suggested' | 'conflicting_rules',
    reasonCodes: [] as string[],
  },
});
describe('native-match categorization precedence', () => {
  it('keeps exact matches before contextual choices and preserves the original source suggestions', () => {
    const exact = match(rule(), 'food'),
      broad = match(rule({ kind: 'department', value: 'produce' }), 'other');
    expect(prioritizeEvidenceItemSuggestions([broad, exact])).toEqual([exact.suggestion]);
    expect(broad.suggestion.state).toBe('suggested');
  });
  it('uses retailer mapping then department then family then approved historical text matches', () => {
    const matches = [
      'retailer_mapping',
      'department',
      'product_family',
      'historical_similarity',
    ].map((kind) => match(rule({ kind: kind as 'department', value: 'produce' }), 'food'));
    for (let start = 0; start < matches.length; start++)
      expect(prioritizeEvidenceItemSuggestions(matches.slice(start).reverse())).toEqual([
        matches[start]!.suggestion,
      ]);
    const exactItem = match(
      { ...rule(), sku: null, normalizedDescription: 'approved item' },
      'food',
    );
    expect(prioritizeEvidenceItemSuggestions([...matches, exactItem])).toEqual([
      exactItem.suggestion,
    ]);
    expect(prioritizeEvidenceItemSuggestions([])).toEqual([]);
  });
  it('abstains on conflicting categories only at the best matching tier and keeps unrelated items', () => {
    const left = match(rule({ kind: 'department', value: 'produce' }), 'food'),
      right = match(rule({ kind: 'department', value: 'produce' }), 'other');
    const unrelated = match(rule(), 'food');
    unrelated.suggestion.lineId = 'different';
    const result = prioritizeEvidenceItemSuggestions([left, right, unrelated]);
    expect(result.slice(0, 2).every((item) => item.state === 'conflicting_rules')).toBe(true);
    expect(result[0]!.reasonCodes).toContain('approved_rule_category_conflict');
    expect(result[2]!.state).toBe('suggested');
    expect(left.suggestion.state).toBe('suggested');
  });
});
