import { downloadBudget, getAccountBalance, getAccounts, getRules, getTransactions, init, shutdown } from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TransactionEvidenceResultSchema } from '@balanceframe/protocol-generated/validators';
import { evidenceFixture, evidenceValue } from '../../src/evidence-scenario-support.js';
import type { LoadedScenario } from '../../src/loader.js';
import { scenarioRequest, withScenario } from './support.js';

const timeout = 180_000;
const object = z.record(z.unknown());
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const statementSelector = z.object({
  statementDocumentId: z.string(), wallet: z.object({ kind: z.literal('existing'), walletId: z.string() }),
  startDate: z.string(), endDate: z.string(), openingBalance: z.object({ minorUnits: z.string(), currency: z.string() }).nullable(),
  closingBalance: z.object({ minorUnits: z.string(), currency: z.string() }).nullable(),
});
const statementContext = z.object({
  foldHash: z.string(), proofs: z.array(z.object({ proofId: z.string(), authorityKind: z.string() }).passthrough()),
  wallets: z.array(z.object({ walletId: z.string() })), resolution: TransactionEvidenceResultSchema,
});
const previewSchema = z.object({
  previewHash: z.string(), proofFoldHash: z.string(),
  proof: z.object({ proofId: z.string(), authorityKind: z.string(), actorId: z.string(), statement: z.object({ documentId: z.string(), contentHash: z.string() }) }).passthrough(),
  native: z.object({ activityManifest: z.array(z.object({ observationId: z.string(), documentId: z.string() }).passthrough()), outflows: z.object({ minorUnits: z.string() }) }).passthrough(),
  resolution: TransactionEvidenceResultSchema,
});

async function api(handle: LoadedScenario, path: string, body?: unknown, personaId = 'owner'): Promise<unknown> {
  const response = await scenarioRequest(handle, path, { ...(body === undefined ? {} : { method: 'POST', body }), personaId });
  expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return evidenceValue(response.body, path);
}
function ids(handle: LoadedScenario) {
  if (!handle.initialized.evidence) throw new Error('Evidence scenario IDs unavailable');
  return handle.initialized.evidence;
}
async function context(handle: LoadedScenario) {
  return statementContext.parse(await api(handle, '/api/evidence/wallet-statements'));
}
async function selector(handle: LoadedScenario) {
  const fixture = z.object({ statementProofs: z.array(z.object({ startDate: z.string(), endDate: z.string(), openingBalance: z.object({ minorUnits: z.string(), currency: z.string() }), closingBalance: z.object({ minorUnits: z.string(), currency: z.string() }) })) }).parse(evidenceFixture('wallet-statement'));
  const proof = fixture.statementProofs[0]!;
  const current = await context(handle);
  return statementSelector.parse({ statementDocumentId: ids(handle).walletStatementDocumentId, wallet: { kind: 'existing', walletId: current.wallets[0]!.walletId }, startDate: proof.startDate, endDate: proof.endDate, openingBalance: proof.openingBalance, closingBalance: proof.closingBalance });
}
async function attest(handle: LoadedScenario, input: z.infer<typeof statementSelector>) {
  const preview = previewSchema.parse(await api(handle, '/api/evidence/wallet-statements/preview', input));
  await api(handle, '/api/evidence/wallet-statements', { ...input, previewHash: preview.previewHash, expectedProofFoldHash: preview.proofFoldHash, originalAcknowledged: true, completeActivityAcknowledged: true });
  return preview;
}
async function revoke(handle: LoadedScenario, proofId: string) {
  await api(handle, '/api/evidence/wallet-statements/revoke', { proofId, expectedProofFoldHash: (await context(handle)).foldHash });
}

async function nativeState(handle: LoadedScenario) {
  const dataDir = mkdtempSync(join(handle.processes.root, 'evidence-wallet-native-'));
  try {
    await init({ serverURL: handle.processes.actualUrl, password: handle.processes.actualSecretKey, dataDir });
    await downloadBudget(handle.seeded.groupId);
    const accounts = await getAccounts();
    const rows: Record<string, unknown>[] = [];
    const balances: Record<string, number> = {};
    for (const account of accounts) {
      balances[account.id] = await getAccountBalance(account.id);
      rows.push(...z.array(object).parse(await getTransactions(account.id, '1900-01-01', '2999-12-31')));
    }
    return { accounts: [...accounts].sort((a, b) => a.id.localeCompare(b.id)), rows: rows.sort((a, b) => String(a.id).localeCompare(String(b.id))), balances, rules: [...await getRules()].sort((a, b) => a.id.localeCompare(b.id)) };
  } finally { try { await shutdown(); } finally { rmSync(dataDir, { recursive: true, force: true }); } }
}

const proposalSchema = z.object({ id: z.string(), payloadHash: z.string(), requiredApprovers: z.number(), requesterActorId: z.string(), canApprove: z.boolean(), canExecute: z.boolean(), payload: z.object({ plan: z.object({ action: object }).passthrough() }).passthrough() }).passthrough();
async function proposalDetail(handle: LoadedScenario, id: string, personaId = 'owner') {
  return proposalSchema.parse(z.object({ proposal: proposalSchema }).parse(await api(handle, `/api/proposal/${id}`, undefined, personaId)).proposal);
}

describe('wallet and receipt learning through authenticated public evidence APIs', () => {
  it('evidence-wallet-statement keeps imported wallet authority unknown, requires exact fresh acknowledgement, and exposes revocation, gaps and conflicts', { timeout }, async () => {
    await withScenario('evidence-wallet-statement', async (handle) => {
      const before = await nativeState(handle);
      const initial = await context(handle);
      expect(initial.proofs).toEqual([]);
      expect(initial.resolution.wallets[0]).toMatchObject({ balanceState: 'balance_unknown', openingBalance: null, closingBalance: null });
      const input = await selector(handle);
      const raw = z.object({ contentBase64: z.string() }).parse(await api(handle, `/api/evidence/${input.statementDocumentId}/raw`));
      const original = JSON.parse(Buffer.from(raw.contentBase64, 'base64').toString('utf8')) as unknown;
      expect(original).not.toHaveProperty('statementProofs');
      expect(original).toMatchObject({ wallets: [{ openingBalance: money('200'), closingBalance: money('100'), completeActivity: true }] });
      const preview = previewSchema.parse(await api(handle, '/api/evidence/wallet-statements/preview', input));
      expect(preview.proof).toMatchObject({ authorityKind: 'human_attested_statement', actorId: handle.initialized.personas.owner!.actorId, statement: { documentId: input.statementDocumentId } });
      expect(preview.native).toMatchObject({ outflows: { minorUnits: '100' }, activityManifest: [{ observationId: 'wallet-1', documentId: input.statementDocumentId }] });
      for (const change of [{ originalAcknowledged: false }, { completeActivityAcknowledged: false }, { previewHash: 'f'.repeat(64) }, { expectedProofFoldHash: 'f'.repeat(64) }, { authorityKind: 'provider_authenticated' }]) {
        const refused = await scenarioRequest(handle, '/api/evidence/wallet-statements', { method: 'POST', body: { ...input, previewHash: preview.previewHash, expectedProofFoldHash: preview.proofFoldHash, originalAcknowledged: true, completeActivityAcknowledged: true, ...change } });
        expect(refused.status).not.toBe(200);
      }
      expect((await context(handle)).proofs).toEqual([]);
      const valid = await attest(handle, input);
      const known = await context(handle);
      expect(known.resolution.wallets[0]).toMatchObject({ balanceState: 'known', openingBalance: money('200'), closingBalance: money('100') });
      expect(known.proofs).toMatchObject([{ authorityKind: 'human_attested_statement' }]);
      const health = z.object({ connectors: z.array(z.object({ connectorId: z.string(), statementCoverage: object.nullable() }).passthrough()) }).parse(await api(handle, '/api/evidence/health'));
      expect(health.connectors.find((row) => row.connectorId === ids(handle).connectorId)?.statementCoverage).toMatchObject({ authorityKind: 'human_attested_statement', state: 'evaluated' });
      const gap = await attest(handle, { ...input, startDate: '2026-10-18', endDate: '2026-10-19', openingBalance: money('100'), closingBalance: money('100') });
      expect((await context(handle)).resolution.wallets[0]).toMatchObject({ balanceState: 'balance_unknown', reasonCodes: expect.arrayContaining(['wallet_statement_coverage_gap']) });
      await revoke(handle, gap.proof.proofId);
      expect((await context(handle)).resolution.wallets[0]?.balanceState).toBe('known');
      const conflict = await attest(handle, { ...input, endDate: '2026-10-17', openingBalance: money('201'), closingBalance: money('101') });
      expect((await context(handle)).resolution.wallets[0]?.balanceAnchors).toEqual([]);
      await revoke(handle, conflict.proof.proofId);
      await revoke(handle, valid.proof.proofId);
      expect((await context(handle)).resolution.wallets[0]?.balanceState).toBe('balance_unknown');
      expect(await nativeState(handle)).toEqual(before);
    }, { branches: ['wallet.import-authority-unknown', 'wallet.fresh-statement-known', 'wallet.revocation-gap-conflict'] });
  });

  it('evidence-wallet-statement creates nonzero native starting equity through an independently approved ordinary proposal and replays read-only', { timeout }, async () => {
    await withScenario('evidence-wallet-statement', async (handle) => {
      const input = await selector(handle);
      await attest(handle, input);
      const current = await context(handle);
      const anchor = current.resolution.wallets[0]!.balanceAnchors!.find((row) => row.boundary === 'before_day_activity')!;
      expect(anchor.amount).toEqual(money('200'));
      expect(ids(handle).walletId).toBe(input.wallet.walletId);
      const before = await nativeState(handle);
      const proposed = z.object({ proposalId: z.string() }).parse(await api(handle, '/api/evidence/wallet-statements/proposal', { resolutionHash: current.resolution.resolutionHash, walletId: input.wallet.walletId, proofSetHash: anchor.proofSetHash, activityManifestHash: anchor.activityManifestHash, asOfDate: anchor.asOfDate, accountName: 'Synthetic Market Wallet' }));
      const detail = await proposalDetail(handle, proposed.proposalId);
      expect(detail.payload.plan.action).toMatchObject({ kind: 'wallet_materialization', opening: { amount: money('200'), date: input.startDate } });
      expect(detail).toMatchObject({ canExecute: false, requiredApprovers: 2, requesterActorId: handle.initialized.personas.owner!.actorId });
      const ownerAttempt = await scenarioRequest(handle, `/api/proposal/${detail.id}/approve`, { method: 'POST', body: { payloadHash: detail.payloadHash } });
      expect(ownerAttempt.status).toBe(403);
      const actorIds = ['owner', 'coapprover', 'approver'].map((id) => handle.initialized.personas[id]!.actorId);
      expect(new Set(actorIds).size).toBe(3);
      for (const personaId of ['coapprover', 'approver']) {
        const displayed = await proposalDetail(handle, detail.id, personaId);
        expect(displayed).toMatchObject({ payloadHash: detail.payloadHash, payload: detail.payload, canApprove: true, canExecute: false });
        const execution = await scenarioRequest(handle, `/api/proposal/${detail.id}/execute`, { method: 'POST', body: {}, personaId });
        expect(execution.status).not.toBe(200);
        await api(handle, `/api/proposal/${detail.id}/approve`, { payloadHash: displayed.payloadHash }, personaId);
      }
      expect(await nativeState(handle)).toEqual(before);
      expect((await proposalDetail(handle, detail.id)).canExecute).toBe(true);
      const execution = await api(handle, `/api/proposal/${detail.id}/execute`, {});
      expect(execution).toMatchObject({ id: detail.id, phase: 'verified' });
      const after = await nativeState(handle);
      const created = after.accounts.filter((account) => !before.accounts.some((prior) => prior.id === account.id));
      expect(created).toHaveLength(1);
      const accountId = created[0]!.id;
      expect(after.balances[accountId]).toBe(200);
      const starting = after.rows.filter((row) => row.account === accountId);
      expect(starting).toHaveLength(1);
      expect(starting[0]).toMatchObject({ date: input.startDate, amount: 200, starting_balance_flag: true, cleared: true, reconciled: false });
      expect(after.rows.filter((row) => row.account !== accountId)).toEqual(before.rows);
      expect(after.rules).toEqual(before.rules);
      expect(await api(handle, `/api/proposal/${detail.id}/execute`, {})).toEqual(execution);
      expect(await api(handle, `/api/proposal/${detail.id}/reconcile`, {})).toEqual(execution);
      expect(await nativeState(handle)).toEqual(after);
    }, { branches: ['wallet.native-opening-independent-approval-replay'] });
  });

  it('evidence-categorization learns only explicit manual outcomes with models disabled, then simulates, approves, suggests and revokes without native writes', { timeout }, async () => {
    await withScenario('evidence-categorization', async (handle) => {
      const keys = ids(handle);
      const before = await nativeState(handle);
      const scope = { connectorId: keys.connectorId, accountId: keys.accountId };
      const initialOutcomes = await api(handle, '/api/evidence/rules/outcomes', scope);
      expect(initialOutcomes).toEqual([]);
      const unreviewed = z.object({ candidates: z.array(z.unknown()) }).passthrough().parse(await api(handle, '/api/evidence/rules/candidates', scope));
      expect(unreviewed.candidates).toEqual([]);
      expect(await api(handle, '/api/evidence/rules/suggestions', { accountId: keys.accountId })).toEqual([]);
      for (const locality of ['local', 'external'])
        expect(await api(handle, '/api/evidence/inference/preview', { accountId: keys.accountId, receiptId: keys.firstReceiptId, lineId: keys.firstLineId, locality })).toEqual({ state: 'manual', reasonCode: 'inference_unavailable' });
      const resolution = TransactionEvidenceResultSchema.parse(await api(handle, '/api/evidence/resolve', {}));
      expect(resolution.receipts).toMatchObject([{ valid: true }, { valid: true }]);
      await api(handle, '/api/evidence/decision', { resolutionHash: resolution.resolutionHash, relationships: [], itemCategoryDecisions: [{ receiptId: keys.firstReceiptId, lineId: keys.firstLineId, accountId: keys.accountId, categoryId: keys.categoryId }, { receiptId: keys.secondReceiptId, lineId: keys.secondLineId, accountId: keys.accountId, categoryId: keys.categoryId }] });
      const outcomes = z.array(z.object({ documentId: z.string(), actorId: z.string(), membershipId: z.string(), categoryId: z.string().nullable() }).passthrough()).parse(await api(handle, '/api/evidence/rules/outcomes', scope));
      expect(outcomes).toHaveLength(2);
      expect(new Set(outcomes.map((row) => row.documentId))).toEqual(new Set([keys.firstDocumentId, keys.secondDocumentId]));
      expect(outcomes.every((row) => row.actorId === handle.initialized.personas.owner!.actorId && row.membershipId === handle.initialized.personas.owner!.membershipId && row.categoryId === keys.categoryId)).toBe(true);
      const learned = z.object({ candidates: z.array(z.object({ candidateHash: z.string(), rule: z.object({ sku: z.string().nullable(), fundingInstrumentId: z.string().nullable(), counterparty: z.string().nullable(), categoryId: z.string() }).passthrough() }).passthrough()), reviewedOutcomes: z.array(z.unknown()) }).passthrough().parse(await api(handle, '/api/evidence/rules/candidates', scope));
      expect(learned.reviewedOutcomes).toHaveLength(2);
      expect(learned.candidates.length).toBeGreaterThan(0);
      const canonicalRule = z.object({ rule: z.object({ sku: z.string(), fundingInstrumentId: z.string(), counterparty: z.string() }).passthrough() }).parse(evidenceFixture('transaction-evidence-rule')).rule;
      expect(learned.candidates[0]!.rule).toMatchObject({ sku: canonicalRule.sku, fundingInstrumentId: canonicalRule.fundingInstrumentId, counterparty: canonicalRule.counterparty, categoryId: keys.categoryId });
      const proposed = z.object({ id: z.string(), payloadHash: z.string(), state: z.string(), simulation: z.object({ matches: z.array(z.object({ receiptId: z.string(), lineId: z.string(), proposedCategoryId: z.string() }).passthrough()), conflicts: z.array(z.string()) }).passthrough() }).passthrough().parse(await api(handle, '/api/evidence/rules/from-candidate', { ...scope, candidateHash: learned.candidates[0]!.candidateHash }));
      expect(proposed.state).toBe('proposed');
      expect(proposed.simulation.matches).toHaveLength(2);
      expect(proposed.simulation.conflicts).toEqual([]);
      expect(await api(handle, '/api/evidence/rules/suggestions', { accountId: keys.accountId })).toEqual([]);
      const decision = { proposalId: proposed.id, payloadHash: proposed.payloadHash };
      await api(handle, '/api/evidence/rules/approve', decision);
      const suggestions = z.array(z.object({ receiptId: z.string(), lineId: z.string(), categoryId: z.string(), state: z.string(), reasonCodes: z.array(z.string()) }).passthrough()).parse(await api(handle, '/api/evidence/rules/suggestions', { accountId: keys.accountId }));
      expect(suggestions).toHaveLength(2);
      expect(suggestions.every((row) => row.categoryId === keys.categoryId && row.state === 'suggested' && row.reasonCodes.includes('approved_exact_sku_rule'))).toBe(true);
      for (const locality of ['local', 'external'])
        expect(await api(handle, '/api/evidence/inference/preview', { accountId: keys.accountId, receiptId: keys.firstReceiptId, lineId: keys.firstLineId, locality })).toEqual({ state: 'deterministic', categoryId: keys.categoryId, receiptId: keys.firstReceiptId, lineId: keys.firstLineId });
      expect(await nativeState(handle)).toEqual(before);
      await api(handle, '/api/evidence/rules/revoke', decision);
      expect(await api(handle, '/api/evidence/rules/suggestions', { accountId: keys.accountId })).toEqual([]);
      expect(await nativeState(handle)).toEqual(before);
    }, { branches: ['categorization.models-disabled-manual-baseline', 'categorization.reviewed-outcomes-candidate', 'categorization.rule-simulation-approval-suggestion-revoke'] });
  });
});
