import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ReviewRuleSetReference, ReviewRuleSetScope } from './types.js';
import type { MerchantNativeRuleBlock, MerchantNativeRulePart, MerchantNativeRuleSet } from '@balanceframe/protocol-generated';
import { validateNativeRuleTables } from '@balanceframe/protocol-generated/validators';
import { canonicalProposalJson } from './proposal.js';

/** Rust string order compares Unicode scalar values, not JavaScript UTF-16 units. */
function compareRuleIds(left: string, right: string): number {
  let l = 0, r = 0;
  while (l < left.length && r < right.length) {
    const a = left.codePointAt(l)!, b = right.codePointAt(r)!;
    if (a !== b) return a - b;
    l += a > 0xffff ? 2 : 1;
    r += b > 0xffff ? 2 : 1;
  }
  return (l < left.length ? 1 : 0) - (r < right.length ? 1 : 0);
}

export function assertReviewRuleSetScope(scope: ReviewRuleSetScope): void {
  if (!scope || [scope.spaceId, scope.budgetId, scope.connectionId].some((id) => typeof id !== 'string' || !id.trim()))
    throw new Error('Native Review requires a trusted selected source scope');
}

type PreparedBlock = { id: string; json: string };
type PreparedPart = { id: string; json: string; blockIndexes: number[] };
type PreparedSet = { ref: Extract<ReviewRuleSetReference, { kind: 'scoped' }>; json: string; partIndexes: number[] };

function contentId(domain: 'review-rule-block' | 'review-rule-part' | 'review-rule-set', ref: ReviewRuleSetReference, json: string): string {
  const namespace = ref.kind === 'scoped'
    ? [domain, ref.kind, ref.scope.spaceId, ref.scope.budgetId, ref.scope.connectionId]
    : [domain, ref.kind, null, ref.budgetId, null];
  return createHash('sha256').update(JSON.stringify(namespace)).update(json).digest('hex');
}

/** Validate/hash source postings once, then retain only constant-size literal descriptors. */
export function prepareReviewRuleSets(scope: ReviewRuleSetScope | undefined, values: MerchantNativeRuleBlock[], partValues: MerchantNativeRulePart[], setValues: MerchantNativeRuleSet[], usedSetIndexes: readonly number[]): { blocks: PreparedBlock[]; parts: PreparedPart[]; groups: PreparedSet[] } {
  const { nativeRuleBlocks, nativeRuleParts, nativeRuleSets } = validateNativeRuleTables(values, partValues, setValues, usedSetIndexes);
  if (nativeRuleBlocks.length || nativeRuleParts.length || nativeRuleSets.length) assertReviewRuleSetScope(scope!);
  const ref: Extract<ReviewRuleSetReference, { kind: 'scoped' }> = { kind: 'scoped', scope: scope!, id: '' };
  const blocks = nativeRuleBlocks.map((block) => {
    const json = JSON.stringify(block.ruleIds);
    return { id: contentId('review-rule-block', ref, json), json };
  });
  const parts = nativeRuleParts.map((part) => {
    const json = JSON.stringify(part.blockIndexes.map((index) => blocks[index]!.id).sort());
    return { id: contentId('review-rule-part', ref, json), json, blockIndexes: part.blockIndexes };
  });
  const groups = nativeRuleSets.map((group) => {
    const ids = (indexes: number[]) => [...new Set(indexes.map((index) => parts[index]!.id))].sort();
    const expression = {
      orPartIds: ids(group.orPartIndexes), andPartIds: group.andPartIndexes.map(ids), categoryPartId: parts[group.categoryPartIndex]!.id,
    };
    const json = JSON.stringify(expression);
    const partIndexes = [...new Set([...group.orPartIndexes, ...group.andPartIndexes.flat(), group.categoryPartIndex])];
    return { ref: { ...ref, scope: { ...scope! }, id: contentId('review-rule-set', ref, json) }, json, partIndexes };
  });
  return { blocks, parts, groups };
}

/** Pre-v26 IDs have no recoverable predicate partition or current-source limits. */
function historicalRuleIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((id: unknown) => typeof id !== 'string' || !id))
    throw new Error('Invalid historical native Review rule IDs');
  return [...new Set(value as string[])].sort(compareRuleIds);
}

type RetainedReviewRow = {
  id: string; evidence: string; transaction_id: string; category_id: string;
  source_transaction_json: string | null;
};

/** Rebind saved financial facts, never a set-wide historical provenance token. */
function rebindRetainedFinancialRevision(review: RetainedReviewRow, evidence: Record<string, unknown>, ref: ReviewRuleSetReference): void {
  if (ref.kind !== 'scoped') return;
  delete evidence.sourceRevision;
  if (review.source_transaction_json === null) return;
  try {
    const value: unknown = JSON.parse(review.source_transaction_json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const source = value as Record<string, unknown>;
    if (typeof source.amount !== 'object' || source.amount === null || Array.isArray(source.amount)) return;
    const amount = source.amount as Record<string, unknown>;
    if (source.id !== review.transaction_id ||
      typeof source.accountId !== 'string' || !source.accountId.trim() ||
      (source.categoryId !== null && (typeof source.categoryId !== 'string' || !source.categoryId.trim())) ||
      (source.direction !== 'incoming' && source.direction !== 'outgoing') ||
      typeof amount.minorUnits !== 'string' || !/^(0|[1-9]\d*)$/.test(amount.minorUnits) ||
      BigInt(amount.minorUnits) > (source.direction === 'outgoing' ? 9_223_372_036_854_775_808n : 9_223_372_036_854_775_807n) ||
      typeof amount.currency !== 'string' || !/^[A-Z]{3}$/.test(amount.currency) ||
      typeof review.category_id !== 'string' || !review.category_id.trim()) return;
    evidence.sourceRevision = createHash('sha256').update(canonicalProposalJson([
      [source.id, source.accountId, source.categoryId, evidence.sourcePayeeId ?? null, evidence.payeeName ?? null, evidence.date ?? null, evidence.money ?? source.amount],
      review.category_id, ref.scope, ref.id,
    ])).digest('hex');
  } catch {
    // Opaque source history remains intact, but cannot acquire financial authority.
  }
}

/** Preserve all old native IDs without inventing historical space/connection facts. */
export function migrateReviewRuleSets(db: Database): void {
  db.exec(`
    CREATE TABLE review_rule_sets (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT,
      budget_id TEXT NOT NULL,
      connection_id TEXT,
      rule_ids_json TEXT NOT NULL CHECK(json_valid(rule_ids_json) AND json_type(rule_ids_json)='array'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
    CREATE INDEX idx_review_rule_sets_scope ON review_rule_sets(budget_id,space_id,connection_id);
    DROP INDEX idx_review_items_active_issue;
    CREATE UNIQUE INDEX idx_review_items_active_issue ON review_items(budget_id,transaction_id,category_id,classifier)
      WHERE status!='superseded' AND (classifier!='rule' OR json_extract(evidence,'$.ruleSetRef.kind') IS NULL);
    CREATE UNIQUE INDEX idx_review_items_native_issue ON review_items(budget_id,transaction_id,category_id,classifier,
      json_extract(evidence,'$.ruleSetRef.scope.spaceId'),json_extract(evidence,'$.ruleSetRef.scope.connectionId'))
      WHERE status!='superseded' AND classifier='rule' AND json_extract(evidence,'$.ruleSetRef.kind')='scoped';
  `);
  const select = db.prepare("SELECT id,budget_id,status,evidence FROM review_items WHERE id>? AND json_type(evidence,'$.ruleIds')='array' ORDER BY id LIMIT 1");
  const insert = db.prepare('INSERT INTO review_rule_sets(id,kind,space_id,budget_id,connection_id,rule_ids_json) VALUES (?,?,NULL,?,NULL,?) ON CONFLICT(id) DO NOTHING');
  const update = db.prepare('UPDATE review_items SET evidence=? WHERE id=?');
  const supersede = db.prepare("UPDATE review_items SET status='superseded',superseded_reason=?,version=version+1,updated_at=? WHERE id=?");
  const action = db.prepare('INSERT INTO review_actions(id,review_item_id,from_status,to_status,actor,reason,created_at) VALUES (?,?,?,?,?,?,?)');
  const actionable: Record<string, true> = { discovered: true, suggestion_generated: true, pending_review: true, approved: true, correcting: true, applying: true, apply_failed: true };
  const now = new Date().toISOString();
  const reason = 'Historical native rule scope is unattributed; synchronize current source before review';
  let after = '';
  for (;;) {
    const row = select.get(after) as { id: string; budget_id: string; status: string; evidence: string } | undefined;
    if (!row) break;
    after = row.id;
    const evidence = JSON.parse(row.evidence) as Record<string, unknown>;
    const json = JSON.stringify(historicalRuleIds(evidence.ruleIds));
    const id = createHash('sha256').update(JSON.stringify(['historical-unattributed', row.budget_id])).update(json).digest('hex');
    insert.run(id, 'historical-unattributed', row.budget_id, json);
    delete evidence.ruleIds;
    evidence.ruleSetRef = { kind: 'historical-unattributed', budgetId: row.budget_id, id };
    update.run(JSON.stringify(evidence), row.id);
    if (actionable[row.status]) {
      supersede.run(reason, now, row.id);
      action.run(randomUUID(), row.id, row.status, 'superseded', 'system', reason, now);
    }
  }
}

/** v26 upgrades retained v25 databases without changing the historical v25 format. */
export function migrateReviewRuleBlocks(db: Database): void {
  db.exec(`
    ALTER TABLE review_rule_sets RENAME TO review_rule_sets_v25;
    DROP INDEX idx_review_rule_sets_scope;
    CREATE TABLE review_rule_blocks (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      rule_ids_json TEXT NOT NULL CHECK(json_valid(rule_ids_json) AND json_type(rule_ids_json)='array'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
    CREATE INDEX idx_review_rule_blocks_scope ON review_rule_blocks(budget_id,space_id,connection_id);
    CREATE TABLE review_rule_sets (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      block_ids_json TEXT NOT NULL CHECK(json_valid(block_ids_json) AND json_type(block_ids_json)='array'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
    CREATE INDEX idx_review_rule_sets_scope ON review_rule_sets(budget_id,space_id,connection_id);
    CREATE INDEX idx_review_items_v26_reference ON review_items(budget_id,json_extract(evidence,'$.ruleSetRef.id'),id);
  `);
  const select = db.prepare('SELECT * FROM review_rule_sets_v25 WHERE id>? ORDER BY id LIMIT 1');
  const putBlock = db.prepare('INSERT INTO review_rule_blocks VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const putSet = db.prepare('INSERT INTO review_rule_sets VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const selected = db.prepare("SELECT id,evidence,transaction_id,category_id,source_transaction_json FROM review_items WHERE id>? AND budget_id=? AND json_extract(evidence,'$.ruleSetRef.id')=? ORDER BY id LIMIT 1");
  const update = db.prepare('UPDATE review_items SET evidence=?,version=version+1 WHERE id=?');
  let after = '';
  for (;;) {
    const row = select.get(after) as { id: string; kind: string; space_id: string | null; budget_id: string; connection_id: string | null; rule_ids_json: string } | undefined;
    if (!row) break;
    after = row.id;
    const oldRef: ReviewRuleSetReference = row.kind === 'scoped'
      ? { kind: 'scoped', scope: { spaceId: row.space_id!, budgetId: row.budget_id, connectionId: row.connection_id! }, id: row.id }
      : { kind: 'historical-unattributed', budgetId: row.budget_id, id: row.id };
    if (oldRef.kind === 'scoped') assertReviewRuleSetScope(oldRef.scope);
    const blockJson = JSON.stringify(historicalRuleIds(JSON.parse(row.rule_ids_json)));
    const blockId = contentId('review-rule-block', oldRef, blockJson);
    const setJson = JSON.stringify([blockId]);
    const ref: ReviewRuleSetReference = { ...oldRef, id: contentId('review-rule-set', oldRef, setJson) };
    putBlock.run(blockId, row.kind, row.space_id, row.budget_id, row.connection_id, blockJson);
    putSet.run(ref.id, row.kind, row.space_id, row.budget_id, row.connection_id, setJson);
    let reviewAfter = '';
    for (;;) {
      const review = selected.get(reviewAfter, row.budget_id, row.id) as RetainedReviewRow | undefined;
      if (!review) break;
      reviewAfter = review.id;
      const evidence = JSON.parse(review.evidence) as Record<string, unknown>;
      const stored = evidence.ruleSetRef as ReviewRuleSetReference | undefined;
      if (!stored || stored.kind !== oldRef.kind ||
        (stored.kind === 'scoped' && oldRef.kind === 'scoped' && (stored.scope.spaceId !== oldRef.scope.spaceId || stored.scope.budgetId !== oldRef.scope.budgetId || stored.scope.connectionId !== oldRef.scope.connectionId)) ||
        (stored.kind === 'historical-unattributed' && stored.budgetId !== row.budget_id))
        throw new Error('Historical native Review reference attribution mismatch');
      evidence.ruleSetRef = ref;
      rebindRetainedFinancialRevision(review, evidence, ref);
      update.run(JSON.stringify(evidence), review.id);
    }
  }
  db.exec('DROP INDEX idx_review_items_v26_reference; DROP TABLE review_rule_sets_v25');
}

/** v27 freezes every old complete v26 set as one literal union/filter, not inferred predicates. */
export function migrateReviewRuleParts(db: Database): void {
  db.exec(`
    ALTER TABLE review_rule_sets RENAME TO review_rule_sets_v26;
    DROP INDEX idx_review_rule_sets_scope;
    CREATE TABLE review_rule_parts (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      block_ids_json TEXT NOT NULL CHECK(json_valid(block_ids_json) AND json_type(block_ids_json)='array'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
    CREATE INDEX idx_review_rule_parts_scope ON review_rule_parts(budget_id,space_id,connection_id);
    CREATE TABLE review_rule_sets (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scoped','historical-unattributed')),
      space_id TEXT, budget_id TEXT NOT NULL, connection_id TEXT,
      expression_json TEXT NOT NULL CHECK(json_valid(expression_json) AND json_type(expression_json)='object'),
      CHECK((kind='scoped' AND space_id IS NOT NULL AND length(trim(space_id))>0 AND connection_id IS NOT NULL AND length(trim(connection_id))>0)
        OR (kind='historical-unattributed' AND space_id IS NULL AND connection_id IS NULL))
    );
    CREATE INDEX idx_review_rule_sets_scope ON review_rule_sets(budget_id,space_id,connection_id);
    CREATE INDEX idx_review_items_v27_reference ON review_items(budget_id,json_extract(evidence,'$.ruleSetRef.id'),id);
  `);
  const select = db.prepare('SELECT * FROM review_rule_sets_v26 WHERE id>? ORDER BY id LIMIT 1');
  const putPart = db.prepare('INSERT INTO review_rule_parts VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const putSet = db.prepare('INSERT INTO review_rule_sets VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const selected = db.prepare("SELECT id,evidence,transaction_id,category_id,source_transaction_json FROM review_items WHERE id>? AND budget_id=? AND json_extract(evidence,'$.ruleSetRef.id')=? ORDER BY id LIMIT 1");
  const update = db.prepare('UPDATE review_items SET evidence=?,version=version+1 WHERE id=?');
  let after = '';
  for (;;) {
    const row = select.get(after) as { id: string; kind: string; space_id: string | null; budget_id: string; connection_id: string | null; block_ids_json: string } | undefined;
    if (!row) break;
    after = row.id;
    const oldRef: ReviewRuleSetReference = row.kind === 'scoped'
      ? { kind: 'scoped', scope: { spaceId: row.space_id!, budgetId: row.budget_id, connectionId: row.connection_id! }, id: row.id }
      : { kind: 'historical-unattributed', budgetId: row.budget_id, id: row.id };
    if (oldRef.kind === 'scoped') assertReviewRuleSetScope(oldRef.scope);
    const ids = parseContentIds(JSON.parse(row.block_ids_json));
    if (!ids.length || contentId('review-rule-set', oldRef, JSON.stringify(ids)) !== row.id)
      throw new Error('Invalid retained v26 native Review set identity');
    const partJson = JSON.stringify(ids);
    const partId = contentId('review-rule-part', oldRef, partJson);
    const expression = { orPartIds: [partId], andPartIds: [] as string[][], categoryPartId: partId };
    const json = JSON.stringify(expression);
    const ref: ReviewRuleSetReference = { ...oldRef, id: contentId('review-rule-set', oldRef, json) };
    putPart.run(partId, row.kind, row.space_id, row.budget_id, row.connection_id, partJson);
    putSet.run(ref.id, row.kind, row.space_id, row.budget_id, row.connection_id, json);
    let reviewAfter = '';
    for (;;) {
      const review = selected.get(reviewAfter, row.budget_id, row.id) as RetainedReviewRow | undefined;
      if (!review) break;
      reviewAfter = review.id;
      const evidence = JSON.parse(review.evidence) as Record<string, unknown>;
      const stored = evidence.ruleSetRef as ReviewRuleSetReference | undefined;
      if (!stored || stored.kind !== oldRef.kind ||
        (stored.kind === 'scoped' && oldRef.kind === 'scoped' && (stored.scope.spaceId !== oldRef.scope.spaceId || stored.scope.budgetId !== oldRef.scope.budgetId || stored.scope.connectionId !== oldRef.scope.connectionId)) ||
        (stored.kind === 'historical-unattributed' && stored.budgetId !== row.budget_id))
        throw new Error('Retained native Review reference attribution mismatch');
      evidence.ruleSetRef = ref;
      rebindRetainedFinancialRevision(review, evidence, ref);
      update.run(JSON.stringify(evidence), review.id);
    }
  }
  db.exec('DROP INDEX idx_review_items_v27_reference; DROP TABLE review_rule_sets_v26');
}

function parseContentIds(value: unknown, maximum = Number.MAX_SAFE_INTEGER): string[] {
  if (!Array.isArray(value) || value.length > maximum ||
    value.some((id, index) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || (index > 0 && value[index - 1] >= id)))
    throw new Error('Invalid canonical native content references');
  return value as string[];
}

/** Explicit single-set resolution only. Retained legacy blocks keep all historical IDs. */
export function resolveReviewRuleSet(db: Database, ref: ReviewRuleSetReference): string[] | null {
  try {
    if (!ref || typeof ref.id !== 'string' || !/^[a-f0-9]{64}$/.test(ref.id)) return null;
    let namespace: [string, string | null, string, string | null];
    if (ref.kind === 'scoped') {
      assertReviewRuleSetScope(ref.scope);
      namespace = [ref.kind, ref.scope.spaceId, ref.scope.budgetId, ref.scope.connectionId];
    } else if (ref.kind === 'historical-unattributed' && typeof ref.budgetId === 'string' && ref.budgetId.trim()) {
      namespace = [ref.kind, null, ref.budgetId, null];
    } else return null;
    const row = db.prepare('SELECT expression_json FROM review_rule_sets WHERE id=? AND kind=? AND space_id IS ? AND budget_id=? AND connection_id IS ?')
      .get(ref.id, ...namespace) as { expression_json: string } | undefined;
    if (!row) return null;
    const raw: unknown = JSON.parse(row.expression_json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || !Array.isArray(value.andPartIds) ||
      (value.andPartIds.length !== 0 && value.andPartIds.length !== 4) ||
      typeof value.categoryPartId !== 'string' || !/^[a-f0-9]{64}$/.test(value.categoryPartId)) return null;
    const orPartIds = parseContentIds(value.orPartIds, 4);
    const andPartIds = value.andPartIds.map((operand: unknown) => {
      const ids = parseContentIds(operand, 2);
      if (!ids.length) throw new Error('Noncanonical empty native AND contribution');
      return ids;
    });
    const expression = { orPartIds, andPartIds, categoryPartId: value.categoryPartId };
    if (contentId('review-rule-set', ref, JSON.stringify(expression)) !== ref.id) return null;
    const selectPart = db.prepare('SELECT block_ids_json FROM review_rule_parts WHERE id=? AND kind=? AND space_id IS ? AND budget_id=? AND connection_id IS ?');
    const parts = new Map<string, Set<string>>();
    const allBlocks = new Set<string>();
    for (const id of new Set([...orPartIds, ...andPartIds.flat(), expression.categoryPartId])) {
      const part = selectPart.get(id, ...namespace) as { block_ids_json: string } | undefined;
      if (!part || contentId('review-rule-part', ref, part.block_ids_json) !== id) return null;
      const blockIds = parseContentIds(JSON.parse(part.block_ids_json));
      if (!blockIds.length) return null;
      parts.set(id, new Set(blockIds));
      for (const blockId of blockIds) allBlocks.add(blockId);
    }
    const selectBlock = db.prepare('SELECT rule_ids_json FROM review_rule_blocks WHERE id=? AND kind=? AND space_id IS ? AND budget_id=? AND connection_id IS ?');
    const blocks = new Map<string, string[]>();
    const allIds = new Set<string>();
    for (const id of allBlocks) {
      const block = selectBlock.get(id, ...namespace) as { rule_ids_json: string } | undefined;
      if (!block || contentId('review-rule-block', ref, block.rule_ids_json) !== id) return null;
      const values: unknown = JSON.parse(block.rule_ids_json);
      if (!Array.isArray(values) || !values.length || values.some((item, index) => typeof item !== 'string' || !item ||
        (index > 0 && compareRuleIds(values[index - 1], item) >= 0))) return null;
      for (const item of values as string[]) {
        if (allIds.has(item)) return null;
        allIds.add(item);
      }
      blocks.set(id, values as string[]);
    }
    const ids: string[] = [];
    for (const id of parts.get(expression.categoryPartId)!) {
      const inOr = orPartIds.some((part) => parts.get(part)!.has(id));
      const inAnd = andPartIds.length === 4 && andPartIds.every((operand) => operand.some((part) => parts.get(part)!.has(id)));
      if (inOr || inAnd) for (const ruleId of blocks.get(id)!) ids.push(ruleId);
    }
    return ids.length ? ids.sort(compareRuleIds) : null;
  } catch { return null; }
}
