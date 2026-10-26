import { z } from 'zod';
import { TransactionEvidenceRequestSchema } from '@balanceframe/protocol-generated/validators';
import type { TransactionEvidenceRequest } from '@balanceframe/protocol-generated';
import {
  evidenceFixture,
  evidenceGrant,
  evidencePost,
  evidenceResult,
  evidenceString,
  type EvidenceScenarioSetup,
} from './evidence-scenario-support.js';

const importedDocument = z.object({ document: z.object({ id: z.string().min(1), parseStatus: z.literal('parsed') }) });

function observations(rows: TransactionEvidenceRequest['observations']) {
  return rows.map(({ provenance: _provenance, ...row }) => row);
}

async function importSource(options: EvidenceScenarioSetup, connectorId: string, sourceId: string, sourceKind: 'wallet' | 'retail', extraction: unknown): Promise<string> {
  const receipt = importedDocument.parse(await evidencePost(options, '/api/evidence', {
    connectorId, sourceId, sourceKind, mediaType: 'application/json',
    sourceTimestamp: options.scenario.anchor, content: JSON.stringify(extraction),
    visibility: 'shared', retentionDays: 7,
  }));
  const documentId = receipt.document.id;
  await evidenceGrant(options, 'owner', 'evidence', documentId, ['evidence', 'normalized-evidence', 'raw-document', 'resolve', 'source']);
  return documentId;
}

/** Import canonical wallet activity or two independent receipt originals; review and financial execution remain explicit. */
export async function initializeWalletCategorizationEvidence(options: EvidenceScenarioSetup): Promise<Readonly<Record<string, string>>> {
  if (options.scenario.id === 'evidence-wallet-statement') {
    const owner = options.clients.owner;
    const persona = options.personas.owner;
    if (!owner || !persona) throw new Error('Wallet scenario owner is unavailable');
    const budgetId = evidenceString(options.seeded.budgetId, 'wallet scenario budget');
    const accountId = evidenceString(options.seeded.accountIds['acct-checking'], 'wallet scenario native Checking account');
    if (!options.seeded.readResources.some((resource) => resource.resourceKind === 'account' && resource.resourceId === accountId))
      throw new Error('Wallet scenario Checking source is outside the seeded Actual budget');
    const path = `/api/spaces/${persona.spaceId}/policy`;
    const current = z.object({ policy: z.object({ version: z.string(), approvalThresholds: z.array(z.unknown()).optional(), operationApprovers: z.record(z.string(), z.number()).optional() }) }).parse(evidenceResult(await owner.get(path), 'wallet scenario governance policy')).policy;
    await owner.reauthenticate(persona.password);
    evidenceResult(await owner.put(path, {
      expectedVersion: current.version,
      policy: { minimumApprovers: 2, assistanceMaximum: 'execute_approved_actions',
        ...(current.approvalThresholds === undefined ? {} : { approvalThresholds: current.approvalThresholds }),
        ...(current.operationApprovers === undefined ? {} : { operationApprovers: current.operationApprovers }),
      },
    }), 'wallet scenario governed execution policy');
    const fixture = TransactionEvidenceRequestSchema.parse(evidenceFixture('wallet-statement'));
    const walletStatementDocumentId = await importSource(options, 'demo-wallet-statement', 'synthetic-wallet-october-statement', 'wallet', {
      templateVersion: 'wallet-v1', observations: observations(fixture.observations),
      relationships: fixture.relationships,
      // These printed claims stay untrusted: normal ingestion strips balance authority.
      wallets: fixture.wallets.map((wallet) => ({ ...wallet, openingBalance: fixture.statementProofs![0]!.openingBalance, closingBalance: fixture.statementProofs![0]!.closingBalance, completeActivity: true })),
      receipts: fixture.receipts,
    });
    const currentWallets = z.object({ wallets: z.tuple([z.object({ walletId: z.string().min(1) })]) }).parse(evidenceResult(await owner.get('/api/evidence/wallet-statements'), 'wallet scenario current source identity'));
    const walletId = currentWallets.wallets[0].walletId;
    await evidenceGrant(options, 'owner', 'evidence', walletStatementDocumentId, ['full-read']);
    await evidenceGrant(options, 'owner', 'wallet', walletId, ['existence', 'history', 'name', 'full-read', 'wallet_materialization:propose', 'wallet_materialization:execute']);
    // Wallet opening's current source closure is this statement, wallet and existing Checking observation.
    for (const reviewer of ['coapprover', 'approver']) {
      await evidenceGrant(options, reviewer, 'budget', budgetId, ['observe', 'source', 'wallet_materialization:approve']);
      await evidenceGrant(options, reviewer, 'account', accountId, ['existence', 'history', 'name', 'source', 'full-read']);
      await evidenceGrant(options, reviewer, 'wallet', walletId, ['existence', 'history', 'name', 'full-read', 'wallet_materialization:approve']);
      await evidenceGrant(options, reviewer, 'evidence', walletStatementDocumentId, ['evidence', 'normalized-evidence', 'source', 'full-read']);
    }
    return { walletStatementDocumentId, walletId, walletLabel: 'wallet', connectorId: 'demo-wallet-statement' };
  }
  if (options.scenario.id !== 'evidence-categorization') return {};
  const fixture = z.object({ evidence: TransactionEvidenceRequestSchema }).parse(evidenceFixture('transaction-evidence-item-learning'));
  const accountId = evidenceString(options.seeded.accountIds['acct-checking'], 'categorization native Checking account');
  const categoryId = evidenceString(options.seeded.categoryIds['cat-groceries'], 'categorization native Groceries category');
  await evidenceGrant(options, 'owner', 'account', accountId, ['existence', 'transaction']);
  await evidenceGrant(options, 'owner', 'category', categoryId, ['category']);
  const connectorId = 'demo-receipt-items';
  const documentIds: string[] = [];
  for (const [index, receipt] of fixture.evidence.receipts.entries()) {
    const row = fixture.evidence.observations.find((observation) => observation.id === receipt.observationId);
    if (!row || row.kind === 'ledger_transaction') throw new Error('Canonical receipt source observation required');
    documentIds.push(await importSource(options, connectorId, `synthetic-market-basket-visit-${index + 1}`, 'retail', {
      templateVersion: 'retail-v1', observations: observations([row]), relationships: [], wallets: [],
      receipts: [{
        ...receipt,
        lines: receipt.lines.map((line) => ({
          ...line, rawDescription: 'Market Basket pantry granola multipack',
          normalizedDescription: 'pantry granola multipack',
          categoryId: line.categoryId === null ? null : categoryId,
        })),
        tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })),
      }],
    }));
  }
  return {
    connectorId, accountId, categoryId,
    firstDocumentId: evidenceString(documentIds[0], 'first receipt document'),
    secondDocumentId: evidenceString(documentIds[1], 'second receipt document'),
    firstReceiptId: fixture.evidence.receipts[0]!.id,
    firstLineId: fixture.evidence.receipts[0]!.lines[0]!.id,
    secondReceiptId: fixture.evidence.receipts[1]!.id,
    secondLineId: fixture.evidence.receipts[1]!.lines[0]!.id,
  };
}
