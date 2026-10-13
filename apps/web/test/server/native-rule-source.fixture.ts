import { vi } from 'vitest';
import { z } from 'zod';
import type { RuleEntity } from '@actual-app/core/types/models';
import { normalizeActualMerchantSource } from '../../../../packages/actual-adapter/src/merchant-normalizer';
import type { ActualMerchantCaptureOptions, ActualMerchantSource, LedgerSnapshotResult } from '@balanceframe/actual-adapter';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import type { SqliteWorkflowStore, ResourceGrantRestrictions } from '@balanceframe/workflow-store';

/** The synthetic SDK fixture supplies every namespace and every account's entire stored history. */
export function completeNativeRuleSourceAvailability(snapshot: ProtocolSnapshot): NonNullable<LedgerSnapshotResult['rulePlanningSourceAvailability']> {
  return {
    accounts:'complete',payees:'complete',categories:'complete',categoryGroups:'complete',rules:'complete',
    history:snapshot.accounts.map((account) => ({accountId:account.id,state:'complete',startDate:'0001-01-01',endDate:'9999-12-31'})),
  };
}

/** SDK source I/O only; the real normalizer, governance and merchant service remain exercised. */
export function nativeRuleSource(read: () => ProtocolSnapshot) {
  return {
    sourceCurrency: 'USD',
    captureMerchantSource: vi.fn(async <T>(options: ActualMerchantCaptureOptions, consume: (source: ActualMerchantSource) => T | Promise<T>): Promise<T> => {
      const snapshot = read();
      const leaves = (rows: ProtocolSnapshot['transactions']): ProtocolSnapshot['transactions'] => rows.flatMap((row) => row.subtransactions.length ? leaves(row.subtransactions) : [row]);
      const transactions = leaves(snapshot.transactions);
      const groupNames = [...new Set(snapshot.categories.flatMap((category) => category.groupName === null ? [] : [category.groupName]))];
      return consume(normalizeActualMerchantSource({
        ...options, capturedAt: new Date().toISOString(), currency: 'USD',
        accounts: snapshot.accounts.map((a) => ({ id: a.id, name: a.name, offbudget: a.offBudget, closed: a.isClosed })),
        payees: { state: 'complete', items: snapshot.payees.map((p) => ({ id: p.id, name: p.name, transfer_acct: p.transferAccountId })) },
        categories: { state: 'complete', items: snapshot.categories.map((c) => ({
          id:c.id,name:c.name,group_id:`fixture-group:${c.groupName ?? 'ungrouped'}`,is_income:c.isIncome,tombstone:c.deleted,
        })) },
        categoryGroups: groupNames.map((name) => ({id:`fixture-group:${name}`,name,is_income:false,hidden:false})),
        rules: { state: 'complete', items: snapshot.rules.map((r) => {
          const trigger = z.object({ conditions: z.array(z.unknown()).default([]), stage: z.enum(['pre','post']).nullable().default(null), conditionsOp: z.enum(['and','or']).default('and') }).parse(r.trigger);
          return { id: r.id, ...trigger, actions: r.actions, order: r.order, tombstone: r.inactive };
        }) as unknown as RuleEntity[] },
        schedules: { state: 'complete', items: [] },
        transactions: snapshot.accounts.filter((a) => options.admission.accountIds.includes(a.id)).map((a) => ({
          accountId: a.id, startDate: '0001-01-01', endDate: '9999-12-31',
          read: { state: 'complete' as const, items: transactions.filter((t) => t.accountId === a.id).map((t) => ({
            id: t.id, account: t.accountId, date: t.date, amount: Number(t.amount.minorUnits), payee: t.payeeId,
            category: t.categoryId, cleared: t.cleared, reconciled: t.reconciled, notes: t.notes, imported_id: t.importedId, imported_payee: t.importedPayee,
          })) },
        })),
      }));
    }),
  };
}

export function grantNativeRuleSources(store: SqliteWorkflowStore, input: {spaceId:string;budgetId:string;actorId:string;membershipId:string;now:string}, snapshot: ProtocolSnapshot, restrictions?: ResourceGrantRestrictions) {
  const grant = (resourceKind: 'budget'|'account'|'category'|'transaction'|'rule', resourceId: string, capability: string) => store.governance.provisionResourceGrant({
    ...input, resourceKind, resourceId, capability, granted: true, ...(restrictions && resourceKind === 'budget' ? { restrictions } : {}),
  });
  for (const capability of ['observe','full-read','source','merchant:analyze','rule:view']) grant('budget', input.budgetId, capability);
  for (const a of snapshot.accounts) for (const capability of ['existence','history','name','source']) grant('account',a.id,capability);
  for (const c of snapshot.categories) for (const capability of ['existence','name']) grant('category',c.id,capability);
  const visit = (rows: ProtocolSnapshot['transactions']) => { for (const t of rows) { for (const capability of ['transaction.view','source']) grant('transaction',t.id,capability); if (t.subtransactions.length) visit(t.subtransactions); } };
  visit(snapshot.transactions);
  for (const r of snapshot.rules) grant('rule',r.id,'rule:view');
}
