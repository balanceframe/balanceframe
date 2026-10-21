import { createHash } from 'node:crypto';
import type { TransactionEntity } from '@actual-app/core/types/models';
import type { APICategoryEntity } from '@actual-app/api/models';
import type { ActualClient } from './connector.js';
import type {
  EvidenceTransactionSource,
  ManualTransactionInput,
  ManualTransactionPrecondition,
  ManualTransactionResult,
} from './types.js';
import {
  normalizeTransactions,
  normalizePayees,
  normalizeCategories,
  buildPayeeNameMap,
  buildCategoryInfoMap,
  buildTransferAcctMap,
} from './normalizer.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function rawChildren(parent: TransactionEntity, rows: TransactionEntity[]): TransactionEntity[] {
  const children = new Map<string, TransactionEntity>();
  for (const child of [
    ...(parent.subtransactions ?? []),
    ...rows.filter((row) => row.parent_id === parent.id),
  ]) {
    if (
      !child.id ||
      (children.has(child.id) && canonical(children.get(child.id)) !== canonical(child))
    )
      throw new Error('Ambiguous split child metadata');
    children.set(child.id, child);
  }
  return [...children.values()];
}
export async function captureEvidenceSource(
  client: ActualClient,
  currency: string,
  input: { budgetId: string; accountId: string; transactionId: string },
): Promise<EvidenceTransactionSource> {
  await client.sync();
  const [accounts, payees, categories, groups, rows] = await Promise.all([
    client.getAccounts(),
    client.getPayees(),
    client.getCategories(),
    client.getCategoryGroups(),
    client.getTransactions(input.accountId, '0001-01-01', '9999-12-31'),
  ]);
  if (!accounts.some((account) => account.id === input.accountId && !account.closed))
    throw new Error('Settlement account is unavailable');
  const parents = rows.filter((row) => row.id === input.transactionId && !row.is_child);
  if (parents.length !== 1) throw new Error('Settlement parent is missing or ambiguous');
  const parent = parents[0]!;
  if (parent.parent_id != null || parent.is_child === true || parent.account !== input.accountId)
    throw new Error('Contradictory settlement parent identity');
  const children = rawChildren(parent, rows);
  if (
    children.some(
      (child) =>
        child.parent_id !== parent.id ||
        child.account !== parent.account ||
        child.date !== parent.date ||
        child.is_child !== true ||
        child.is_parent !== false,
    )
  )
    throw new Error('Contradictory settlement child identity');
  if (children.length > 0 !== (parent.is_parent === true))
    throw new Error('Contradictory settlement split parent structure');
  for (const row of [parent, ...children]) {
    const raw = row as TransactionEntity & { tombstone?: boolean; transfer_id?: string | null };
    if (raw.reconciled) throw new Error('Reconciled settlements cannot be amended');
    if (raw.transfer_id || payees.some((payee) => payee.id === row.payee && payee.transfer_acct))
      throw new Error('Transfer settlements cannot be amended');
    if (raw.tombstone || raw.error || !Number.isSafeInteger(raw.amount) || raw.amount === 0)
      throw new Error('Unsupported settlement metadata');
  }
  const normalizedPayees = normalizePayees(payees);
  const transaction = normalizeTransactions(
    [{ ...parent, subtransactions: children }],
    buildPayeeNameMap(normalizedPayees),
    buildCategoryInfoMap(normalizeCategories(categories as APICategoryEntity[], groups)),
    buildTransferAcctMap(normalizedPayees),
    currency,
  )[0];
  if (
    !transaction ||
    transaction.id !== input.transactionId ||
    transaction.accountId !== input.accountId
  )
    throw new Error('Settlement normalization failed');
  const source = {
    budgetId: input.budgetId,
    accountId: input.accountId,
    transactionId: input.transactionId,
    parent: clone(parent) as unknown as Record<string, unknown>,
    children: clone(children) as unknown as Record<string, unknown>[],
    transaction,
  };
  return { ...source, fingerprint: hash(source) };
}
function immutableMetadata(row: Record<string, unknown>, parent: boolean): Record<string, unknown> {
  const allowed = parent
    ? new Set(['category', 'subtransactions', 'is_parent', 'is_child', 'parent_id', 'error'])
    : new Set(['category']);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !allowed.has(key)));
}
function amendmentChildren(
  expected: EvidenceTransactionSource,
  transaction: ManualTransactionInput,
): Record<string, unknown>[] | null {
  const splits = transaction.splits;
  const children: Record<string, unknown>[] = [];
  if (expected.children.length && (!splits || expected.children.length !== splits.length))
    return null;
  // Actual's existing-parent update inherits these fields and drops null child payees.
  if (
    expected.children.some(
      (child) =>
        (child.payee == null && expected.parent.payee != null) ||
        ['cleared', 'reconciled', 'starting_balance_flag'].some(
          (field) => (child[field] ?? null) !== (expected.parent[field] ?? null),
        ),
    )
  )
    return null;
  const unused = [...expected.transaction.subtransactions]
    .map((child) => expected.children.find((raw) => raw.id === child.id)!)
    .filter(Boolean);
  if (
    expected.children.length &&
    splits?.some((split, index) => unused[index]?.amount !== split.amount)
  )
    return null;
  for (const [index, split] of (splits ?? []).entries()) {
    const originalIndex = unused.length ? 0 : -1;
    if (expected.children.length && originalIndex < 0) return null;
    if (originalIndex >= 0) {
      children.push({ ...unused.splice(originalIndex, 1)[0]!, category: split.categoryId });
      continue;
    }
    children.push({
      id: `bf-evidence-${hash([transaction.parentId, transaction.correlationId, index]).slice(0, 32)}`,
      account: transaction.accountId,
      date: transaction.date,
      amount: split.amount,
      category: split.categoryId,
      parent_id: transaction.parentId,
      is_child: true,
      is_parent: false,
      cleared: expected.parent.cleared ?? false,
      reconciled: false,
      starting_balance_flag: expected.parent.starting_balance_flag ?? null,
      sort_order: -(index + 1),
      tombstone: false,
      schedule: null,
      raw_synced_data: null,
      payee: null,
      notes: null,
      imported_id: null,
      imported_payee: null,
      transfer_id: null,
      error: null,
    });
  }
  return children;
}
export function evidenceAmendmentMatches(
  expected: EvidenceTransactionSource,
  transaction: ManualTransactionInput,
  after: EvidenceTransactionSource,
): boolean {
  const { fingerprint, ...payload } = expected;
  const children = amendmentChildren(expected, transaction);
  if (fingerprint !== hash(payload) || !children) return false;
  return (
    canonical(immutableMetadata(after.parent, true)) ===
      canonical(immutableMetadata(expected.parent, true)) &&
    after.transaction.categoryId === (transaction.categoryId ?? null) &&
    after.children.length === children.length &&
    after.children.every((child) => {
      const wanted = children.find((row) => row.id === child.id);
      return (
        !!wanted &&
        canonical(immutableMetadata(child, false)) ===
          canonical(immutableMetadata(wanted, false)) &&
        child.category === wanted.category
      );
    })
  );
}
export async function amendEvidenceSource(
  client: ActualClient,
  currency: string,
  input: { expected: EvidenceTransactionSource; transaction: ManualTransactionInput },
  precondition: ManualTransactionPrecondition,
): Promise<ManualTransactionResult> {
  const { expected, transaction } = input;
  const fail = (
    code:
      | 'INVALID_INPUT'
      | 'SOURCE_PRECONDITION_FAILED'
      | 'CATEGORY_PRECONDITION_FAILED'
      | 'WRITE_UNCERTAIN'
      | 'VERIFICATION_FAILED',
    error: string,
  ): ManualTransactionResult => ({
    success: false,
    parentId: transaction.parentId,
    correlationId: transaction.correlationId,
    code,
    error,
    reviewRequired: true,
    verified: false,
  });
  const { fingerprint, ...payload } = expected;
  if (
    fingerprint !== hash(payload) ||
    expected.budgetId !== precondition.budgetId ||
    transaction.parentId !== expected.transactionId ||
    transaction.accountId !== expected.accountId ||
    transaction.date !== expected.transaction.date ||
    !Number.isSafeInteger(transaction.amount) ||
    BigInt(transaction.amount).toString() !== expected.transaction.amount.minorUnits ||
    (transaction.payeeName ?? null) !== expected.transaction.payeeName ||
    (transaction.notes ?? null) !== expected.transaction.notes
  )
    return fail(
      'INVALID_INPUT',
      'Amendment must preserve the exact settlement identity, payee, and notes',
    );
  const splits = transaction.splits;
  if (
    (splits &&
      (splits.length === 0 ||
        transaction.categoryId != null ||
        splits.some(
          (split) =>
            !Number.isSafeInteger(split.amount) ||
            split.amount === 0 ||
            Math.sign(split.amount) !== Math.sign(transaction.amount) ||
            split.accountId !== transaction.accountId ||
            split.date !== transaction.date,
        ) ||
        splits.reduce((sum, split) => sum + BigInt(split.amount), 0n) !==
          BigInt(transaction.amount))) ||
    (!splits && !transaction.categoryId)
  )
    return fail('INVALID_INPUT', 'Amendment requires a category or exact conserving splits');
  let current: EvidenceTransactionSource;
  try {
    current = await captureEvidenceSource(client, currency, {
      budgetId: precondition.budgetId,
      accountId: expected.accountId,
      transactionId: expected.transactionId,
    });
  } catch {
    return fail('SOURCE_PRECONDITION_FAILED', 'Current settlement cannot be proven');
  }
  if (current.fingerprint !== expected.fingerprint)
    return fail('SOURCE_PRECONDITION_FAILED', 'Settlement metadata changed after approval');
  const categories = await client.getCategories();
  const categoryIds = splits ? splits.map((split) => split.categoryId) : [transaction.categoryId];
  if (
    categoryIds.some((id) => !categories.some((category) => category.id === id && !category.hidden))
  )
    return fail('CATEGORY_PRECONDITION_FAILED', 'Requested category is unavailable');
  const children = amendmentChildren(expected, transaction);
  if (!children)
    return fail(
      'INVALID_INPUT',
      'Existing split child identity or metadata cannot be preserved by this SDK update',
    );
  const update = {
    ...expected.parent,
    category: transaction.categoryId ?? null,
    ...(splits ? { subtransactions: children, is_parent: true, is_child: false } : {}),
    error: null,
  };
  // The final authority callback deliberately remains outside the uncertain-write catch.
  precondition.assertExecutionCurrent();
  try {
    await client.updateTransaction(transaction.parentId, update);
  } catch {
    return fail(
      'WRITE_UNCERTAIN',
      'Settlement update outcome is uncertain; inspect Actual before retrying',
    );
  }
  let after: EvidenceTransactionSource;
  try {
    after = await captureEvidenceSource(client, currency, {
      budgetId: precondition.budgetId,
      accountId: expected.accountId,
      transactionId: expected.transactionId,
    });
  } catch {
    return fail('WRITE_UNCERTAIN', 'Settlement could not be re-read after update');
  }
  if (!evidenceAmendmentMatches(expected, transaction, after))
    return fail(
      'VERIFICATION_FAILED',
      'Settlement update did not preserve exact metadata and requested categories',
    );
  return {
    success: true,
    parentId: transaction.parentId,
    transactionId: transaction.parentId,
    correlationId: transaction.correlationId,
    verified: true,
  };
}
