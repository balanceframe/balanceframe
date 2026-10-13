import { createHash } from 'node:crypto';
import type { CreateReviewItemInput, ReviewItem, ReviewRuleSetScope, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { Transaction } from '@balanceframe/protocol-generated';

/** Real shared group/Review rows; historical fixtures mirror the migration contract. */
export async function nativeReviewFixture(store: SqliteWorkflowStore, input: {
  scope: ReviewRuleSetScope;
  transaction: Pick<Transaction, 'id' | 'accountId' | 'categoryId' | 'amount'>;
  categoryId: string;
  classifier?: 'rule' | 'deterministic';
  historicalStatus?: 'rejected' | 'skipped';
  invalidReference?: 'missing' | 'malformed';
}): Promise<ReviewItem> {
  const signed = BigInt(input.transaction.amount.minorUnits);
  const item: CreateReviewItemInput = {
    budgetId: input.scope.budgetId, transactionId: input.transaction.id, categoryId: input.categoryId,
    classifier: 'rule', provenance: 'Actual synchronized snapshot deterministic analysis',
    sourceTransaction: {
      id: input.transaction.id, accountId: input.transaction.accountId, categoryId: input.transaction.categoryId,
      direction: signed < 0n ? 'outgoing' : 'incoming',
      amount: { currency: input.transaction.amount.currency, minorUnits: (signed < 0n ? -signed : signed).toString() },
    },
    evidence: {
      sourceRevision: 'native-review-fixture-source',
      ...(input.classifier === 'deterministic' ? { classifier: { type: 'rule' } } : {}),
    },
  };
  const ruleIds = ['fixture-native-rule-a', 'fixture-native-rule-z'];
  let row: ReviewItem;
  if (input.historicalStatus) {
    const namespace = ['historical-unattributed', null, input.scope.budgetId, null];
    const blockJson = JSON.stringify(ruleIds);
    const blockId = createHash('sha256').update(JSON.stringify(['review-rule-block', ...namespace])).update(blockJson).digest('hex');
    const partJson = JSON.stringify([blockId]);
    const partId = createHash('sha256').update(JSON.stringify(['review-rule-part', ...namespace])).update(partJson).digest('hex');
    const setJson = JSON.stringify({ orPartIds: [partId], andPartIds: [], categoryPartId: partId });
    const id = createHash('sha256').update(JSON.stringify(['review-rule-set', ...namespace])).update(setJson).digest('hex');
    const ref = { kind: 'historical-unattributed' as const, budgetId: input.scope.budgetId, id };
    store['db'].prepare(`INSERT INTO review_rule_blocks(kind,space_id,budget_id,connection_id,id,rule_ids_json)
      VALUES ('historical-unattributed',NULL,?,NULL,?,?)`).run(ref.budgetId, blockId, blockJson);
    store['db'].prepare(`INSERT INTO review_rule_parts(kind,space_id,budget_id,connection_id,id,block_ids_json)
      VALUES ('historical-unattributed',NULL,?,NULL,?,?)`).run(ref.budgetId, partId, partJson);
    store['db'].prepare(`INSERT INTO review_rule_sets(kind,space_id,budget_id,connection_id,id,expression_json)
      VALUES ('historical-unattributed',NULL,?,NULL,?,?)`).run(ref.budgetId, ref.id, setJson);
    if (!store.getReviewRuleSet(ref)) throw new Error('Historical native fixture closure unavailable');
    row = await store.createReviewItem({ ...item, evidence: { ...item.evidence, ruleSetRef: ref } });
    // The old database can retain terminal native history, never current attribution.
    store['db'].prepare('UPDATE review_items SET status=? WHERE id=?').run(input.historicalStatus, row.id);
  } else {
    const rows = await store.createReviewItems({
      scope: input.scope, nativeRuleBlocks: [{ ruleIds }], nativeRuleParts: [{ blockIndexes: [0] }],
      nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
      items: [{ ...item, ruleSetIndex: 0 }], authorize: () => true,
    });
    if (!rows[0]) throw new Error('Native scoped fixture was not persisted');
    row = rows[0];
    if (row.status === 'discovered')
      row = await store.transitionInternalReviewItem(row.id, { toStatus: 'suggestion_generated', actor: 'trusted-fixture', expectedVersion: row.version });
    if (row.status === 'suggestion_generated')
      row = await store.transitionInternalReviewItem(row.id, { toStatus: 'pending_review', actor: 'trusted-fixture', expectedVersion: row.version });
  }
  if (input.classifier === 'deterministic')
    store['db'].prepare('UPDATE review_items SET classifier=? WHERE id=?').run('deterministic', row.id);
  if (input.invalidReference) {
    const evidence = { ...row.evidence };
    if (input.invalidReference === 'missing') delete evidence.ruleSetRef;
    else evidence.ruleSetRef = { kind: 'scoped', scope: { ...input.scope, connectionId: '' }, id: 'malformed-native-ref' };
    // Exercise malformed retained data through the real reader, not a mocked projection.
    store['db'].prepare('UPDATE review_items SET evidence=? WHERE id=?').run(JSON.stringify(evidence), row.id);
  }
  const current = await store.getReviewItem(row.id);
  if (!current) throw new Error('Native fixture row unavailable');
  return current;
}
