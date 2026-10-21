import type { EvidenceRuleProposal } from '@balanceframe/protocol-generated';
/** Rank only native-validated matches; this does not infer categories or match source content. */
export function evidenceItemRulePriority(rule: EvidenceRuleProposal): number {
  if (!rule.criterion) return rule.sku === null ? 1 : 0;
  return { retailer_mapping: 2, department: 3, product_family: 4, historical_similarity: 5 }[
    rule.criterion.kind
  ];
}
type Suggestion = {
  receiptId: string;
  lineId: string;
  categoryId: string;
  state: 'suggested' | 'conflicting_rules';
  reasonCodes: string[];
};
/** Keep the most specific approved native matches and abstain when their categories conflict. */
export function prioritizeEvidenceItemSuggestions<T extends Suggestion>(
  matches: Array<{ rule: EvidenceRuleProposal; suggestion: T }>,
): T[] {
  const key = (item: Suggestion) => JSON.stringify([item.receiptId, item.lineId]);
  const best = new Map<string, number>();
  for (const { rule, suggestion } of matches)
    best.set(
      key(suggestion),
      Math.min(best.get(key(suggestion)) ?? Infinity, evidenceItemRulePriority(rule)),
    );
  const chosen = matches
    .filter(({ rule, suggestion }) => evidenceItemRulePriority(rule) === best.get(key(suggestion)))
    .map(({ suggestion }) => ({ ...suggestion, reasonCodes: [...suggestion.reasonCodes] }));
  for (const suggestion of chosen)
    if (
      chosen.some(
        (other) => key(other) === key(suggestion) && other.categoryId !== suggestion.categoryId,
      )
    ) {
      suggestion.state = 'conflicting_rules';
      suggestion.reasonCodes.push('approved_rule_category_conflict');
    }
  return chosen;
}
