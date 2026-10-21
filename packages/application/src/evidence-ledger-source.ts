import { createHash } from 'node:crypto';
import { canonicalProposalJson } from '@balanceframe/workflow-store';
import type { Transaction } from '@balanceframe/protocol-generated';
/** Identify authoritative financial settlement facts independently of their reviewed categorization. */
export function ledgerEvidenceHash(row: Transaction): string {
  return createHash('sha256')
    .update(
      canonicalProposalJson({
        id: row.id,
        accountId: row.accountId,
        date: row.date,
        amount: row.amount,
        transferAccountId: row.transferAccountId,
      }),
    )
    .digest('hex');
}
