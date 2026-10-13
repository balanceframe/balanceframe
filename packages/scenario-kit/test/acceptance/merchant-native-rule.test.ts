import { downloadBudget, getAccounts, getPayees, getRules, getTransactions, init, shutdown } from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { moneySchema } from '@balanceframe/protocol-generated/validators';
import { merchantSuggestionSchema, merchantTextFieldSchema } from '../../../protocol-generated/src/merchant-validators.js';
import type { LoadedScenario } from '../../src/loader.js';
import { applyScenarioEvent } from '../../src/events.js';
import { refreshScenarioMerchantReadGrants } from '../../src/workflow-setup.js';
import { journal, noPrivateValues, resultOf, testTimeout } from './merchant-research-support.js';
import type { Envelope } from './merchant-research-support.js';
import { scenarioRequest, withScenario } from './support.js';

const transactionSchema = z.object({
  id: z.string(), account: z.string(), date: z.string(), amount: z.number().int(),
  payee: z.string().nullish(), category: z.string().nullish(), imported_id: z.string().nullish(),
  imported_payee: z.string().nullish(), notes: z.string().nullish(), cleared: z.boolean(), reconciled: z.boolean(),
});
const conditionSchema = z.object({ field: z.literal('payee'), op: z.literal('is'), value: z.string() });
const actionSchema = z.object({ op: z.literal('set'), field: z.literal('category'), value: z.string() });
const portableRuleSchema = z.object({ stage: z.literal('post'), conditionsOp: z.literal('and'), conditions: z.tuple([conditionSchema]), actions: z.tuple([actionSchema]) }).strict();
const nativeRuleSchema = z.object({ id: z.string(), stage: z.string().nullable(), conditionsOp: z.string(), conditions: z.array(z.unknown()), actions: z.array(z.unknown()) }).passthrough();
const simulationSchema = z.object({
  name: z.string(), transactionsMatched: z.number().int(), transactionsAffected: z.array(z.string()),
  categoryDistribution: z.record(z.number().int()), conflicts: z.array(z.string()),
  examples: z.array(z.object({ txId: z.string(), payee: z.string().nullable(), amount: moneySchema, currentCategory: z.string().nullable(), wouldChange: z.boolean() })),
}).passthrough();
const proposalSchema = z.object({
  id: z.string(), operation: z.literal('create_rule'), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  requesterActorId: z.string(), requiredApprovers: z.number().int(), approvers: z.array(z.object({ actorId: z.string() }).passthrough()),
  privateEnvelopeVisible: z.boolean(), canApprove: z.boolean(), canExecute: z.boolean(),
  payload: z.object({ kind: z.literal('create_rule'), transactionId: z.string(), categoryId: z.string(), rule: portableRuleSchema }).passthrough(),
  preconditions: z.object({ nativeRule: portableRuleSchema, reviewedSimulation: simulationSchema, reviewContext: z.object({ sourceFactsHash: z.string() }).passthrough(), sourceDependencies: z.array(z.object({ resourceKind: z.string(), resourceId: z.string() })) }).passthrough(),
}).passthrough();
const detailSchema = z.object({ proposal: proposalSchema, simulation: simulationSchema, simulationStatus: z.string(), stale: z.boolean() });
const sourceSchema = z.object({ id: z.string(), accountId: z.string(), payeeId: z.string().nullable(), categoryId: z.string().nullable(), amount: moneySchema, importedPayee: merchantTextFieldSchema, notes: merchantTextFieldSchema }).passthrough();
const suggestionSchema = merchantSuggestionSchema.extend({ sourceTransaction: sourceSchema, evidenceKey: z.string(), aliasDecisions: z.array(z.unknown()), reviewContext: z.unknown() });
const queueSchema = z.object({ items: z.array(z.object({ reviewItem: z.object({ id: z.string(), transactionId: z.string() }).passthrough(), evidence: z.object({ suggestedCategory: z.string(), money: moneySchema.optional(), merchantEvidence: suggestionSchema.optional() }).passthrough() }).passthrough()) });

async function nativeState(handle: LoadedScenario) {
  const dataDir = mkdtempSync(join(handle.processes.root, 'merchant-rule-client-'));
  try {
    await init({ serverURL: handle.processes.actualUrl, password: handle.processes.actualSecretKey, dataDir });
    await downloadBudget(handle.seeded.groupId);
    const rows: z.infer<typeof transactionSchema>[] = [];
    for (const account of await getAccounts()) rows.push(...z.array(transactionSchema).parse(await getTransactions(account.id, '1900-01-01', '2999-12-31')));
    return {
      rows: rows.sort((a, b) => a.id.localeCompare(b.id)),
      rules: z.array(nativeRuleSchema).parse(await getRules()).sort((a, b) => a.id.localeCompare(b.id)),
      payees: z.array(z.object({ id: z.string(), name: z.string() })).parse(await getPayees()).sort((a, b) => a.id.localeCompare(b.id)),
    };
  } finally { try { await shutdown(); } finally { rmSync(dataDir, { recursive: true, force: true }); } }
}

async function detail(handle: LoadedScenario, id: string, personaId = 'owner') {
  const value = detailSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(id)}`, { personaId, freshProof: true })));
  noPrivateValues(handle, value);
  return value;
}

async function propose(handle: LoadedScenario) {
  const before = await nativeState(handle);
  const targetId = handle.seeded.transactionIds['synthetic-holdout-000-00'];
  const categoryId = handle.seeded.categoryIds['cat-groceries'];
  if (!targetId || !categoryId) throw new Error('Expected exact mapped native rule resources');
  const synced = resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/review/sync', { method: 'POST', body: {} }));
  expect(synced).toMatchObject({ synchronized: true, failed: 0 });
  const queue = queueSchema.parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/review')));
  const item = queue.items.find((row) => row.reviewItem.transactionId === targetId);
  expect(item?.evidence).toMatchObject({ suggestedCategory: 'Groceries', money: { minorUnits: '-74965', currency: 'USD' }, merchantEvidence: { transactionId: targetId, categoryId, tier: 'inferred', supportCount: 3 } });
  if (!item?.evidence.merchantEvidence) throw new Error('Required native rule Review evidence was not admitted');
  const response = z.object({ proposal: proposalSchema, simulationStatus: z.literal('present'), simulationWarning: z.null() }).parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, '/api/review/propose-rule', { method: 'POST', body: { reviewId: item.reviewItem.id, categoryId } })));
  const proposal = response.proposal;
  const current = await detail(handle, proposal.id);
  expect(current).toMatchObject({ stale: false, simulationStatus: 'present' });
  expect(current.proposal).toMatchObject({ id: proposal.id, payloadHash: proposal.payloadHash, requesterActorId: handle.initialized.personas.owner?.actorId, requiredApprovers: 2, approvers: [], canApprove: false, canExecute: false, privateEnvelopeVisible: true });
  const row = before.rows.find((candidate) => candidate.id === targetId);
  if (!row?.payee) throw new Error('Normal rule proposal requires a real stable native source payee, not a canned inferred identity');
  expect(row).toMatchObject({ payee: handle.seeded.payeeIds['pay-market'], amount: -74965, imported_id: 'synthetic-import-synthetic-holdout-000-00', imported_payee: null });
  expect(item.evidence.merchantEvidence.sourceTransaction).toMatchObject({ id: targetId, accountId: row.account, payeeId: handle.seeded.payeeIds['pay-market'], categoryId: null, amount: { minorUnits: '-74965', currency: 'USD' }, importedPayee: { state: 'absent', value: null } });
  const expectedRule = { stage: 'post', conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: row.payee }], actions: [{ op: 'set', field: 'category', value: categoryId }] };
  expect(proposal.payload).toMatchObject({ kind: 'create_rule', transactionId: targetId, categoryId, rule: expectedRule });
  expect(current.proposal.payload).toEqual(proposal.payload);
  expect(current.proposal.preconditions.nativeRule).toEqual(expectedRule);
  const matched = before.rows.filter((candidate) => candidate.payee === row.payee);
  expect([...current.simulation.transactionsAffected].sort()).toEqual(matched.map((candidate) => candidate.id).sort());
  expect(current.simulation).toMatchObject({ transactionsMatched: matched.length, categoryDistribution: { [categoryId]: matched.length }, conflicts: [] });
  expect(current.proposal.preconditions.reviewedSimulation).toEqual(current.simulation);
  const payeeName = before.payees.find((payee) => payee.id === row.payee)?.name;
  expect(current.simulation.name).toBe(`Auto-rule for ${payeeName}`);
  expect([...current.simulation.examples].sort((a, b) => a.txId.localeCompare(b.txId))).toEqual(matched.map((candidate) => ({ txId: candidate.id, payee: payeeName ?? null, amount: { minorUnits: String(candidate.amount), currency: 'USD' }, currentCategory: candidate.category ?? null, wouldChange: candidate.category !== categoryId })).sort((a, b) => a.txId.localeCompare(b.txId)));
  const sourceTransactions = current.proposal.preconditions.sourceDependencies.filter((source) => source.resourceKind === 'transaction').map((source) => source.resourceId).sort();
  expect(sourceTransactions).toEqual(before.rows.map((candidate) => candidate.id).sort());
  expect(await nativeState(handle)).toEqual(before);
  expect(journal(handle)).toEqual([]);
  return { before, proposal: current.proposal, targetId, categoryId, payeeId: row.payee };
}

async function approve(handle: LoadedScenario, proposal: z.infer<typeof proposalSchema>): Promise<void> {
  const actorIds = ['coapprover', 'approver'].map((id) => handle.initialized.personas[id]?.actorId);
  expect(new Set(actorIds).size).toBe(2);
  expect(actorIds).not.toContain(proposal.requesterActorId);
  const ownerAttempt = await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/approve`, { method: 'POST', body: { payloadHash: proposal.payloadHash } });
  expect(ownerAttempt.status).toBe(403);
  expect(ownerAttempt.body).toMatchObject({ status: 'error', error: { code: 'FORBIDDEN' } });
  for (const personaId of ['coapprover', 'approver']) {
    const displayed = await detail(handle, proposal.id, personaId);
    expect(displayed.proposal).toMatchObject({ payloadHash: proposal.payloadHash, payload: proposal.payload, requiredApprovers: 2, canApprove: true, canExecute: false, privateEnvelopeVisible: true });
    expect(displayed.simulation).toEqual(proposal.preconditions.reviewedSimulation);
    const deniedExecution = await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/execute`, { method: 'POST', personaId, body: {} });
    expect(deniedExecution.status).toBe(404);
    expect(deniedExecution.body).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } });
    const saved = resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/approve`, { method: 'POST', personaId, body: { payloadHash: displayed.proposal.payloadHash } }));
    expect(saved).toMatchObject({ proposalId: proposal.id, status: 'active' });
    if (personaId === 'coapprover') {
      const onlyOne = await detail(handle, proposal.id);
      expect(onlyOne.proposal.canExecute).toBe(false);
      expect(onlyOne.proposal.approvers.map((actor) => actor.actorId)).toEqual([actorIds[0]]);
    }
  }
  const authorized = await detail(handle, proposal.id);
  expect(authorized.proposal.canExecute).toBe(true);
  expect(authorized.proposal.payloadHash).toBe(proposal.payloadHash);
  expect(authorized.proposal.approvers.map((actor) => actor.actorId).sort()).toEqual([...actorIds].sort());
}

async function execute(handle: LoadedScenario, proposal: z.infer<typeof proposalSchema>) {
  const receipt = z.object({ proposalId: z.string(), ruleId: z.string(), verified: z.literal(true) }).strict().parse(resultOf(await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/execute`, { method: 'POST', body: {} })));
  expect(receipt.proposalId).toBe(proposal.id);
  return receipt;
}

function eventOptions(handle: LoadedScenario, eventId: 'import-match' | 'merchant-source-change') {
  return { scenario: handle.scenario, seeded: handle.seeded, root: handle.processes.root, actualServerUrl: handle.processes.actualUrl, actualSecretKey: handle.processes.actualSecretKey, eventId };
}

describe('real governed native rule lifecycle', () => {
  it('merchant-native-rule-lifecycle requires two independent human approvals, writes exactly one Actual rule and replays without writes', async () => {
    await withScenario('merchant-native-rule-lifecycle', async (handle) => {
      const prepared = await propose(handle);
      await approve(handle, prepared.proposal);
      expect(await nativeState(handle)).toEqual(prepared.before);
      const receipt = await execute(handle, prepared.proposal);
      const after = await nativeState(handle);
      expect(after.rows).toEqual(prepared.before.rows);
      expect(after.payees).toEqual(prepared.before.payees);
      expect(after.rules.filter((rule) => rule.id !== receipt.ruleId)).toEqual(prepared.before.rules);
      expect(after.rules.filter((rule) => rule.id === receipt.ruleId)).toMatchObject([{ id: receipt.ruleId, ...prepared.proposal.payload.rule }]);
      expect(await execute(handle, prepared.proposal)).toEqual(receipt);
      expect(await nativeState(handle)).toEqual(after);
      expect(journal(handle)).toEqual([]);
    }, { branches: ['native-rule-execution'] });
  }, testTimeout);

  it('merchant-native-rule-lifecycle lets Actual alone classify one future Savings import and leaves every prior row unchanged', async () => {
    await withScenario('merchant-native-rule-lifecycle', async (handle) => {
      const prepared = await propose(handle);
      await approve(handle, prepared.proposal);
      const receipt = await execute(handle, prepared.proposal);
      await refreshScenarioMerchantReadGrants(handle, { ruleIds: [receipt.ruleId] });
      const before = await nativeState(handle);
      const recipe = handle.scenario.events['import-match'];
      if (!recipe || recipe.kind !== 'import-match') throw new Error('Expected declared direct native future import');
      expect(recipe.candidate.accountId).toBe('acct-savings');
      expect(prepared.before.rows.find((row) => row.id === prepared.targetId)?.account).toBe(handle.seeded.accountIds['acct-checking']);
      const first = await applyScenarioEvent(eventOptions(handle, 'import-match'));
      const second = await applyScenarioEvent(eventOptions(handle, 'import-match'));
      const after = await nativeState(handle);
      const imported = after.rows.filter((row) => row.imported_id === recipe.candidate.importedId);
      expect(imported).toEqual([expect.objectContaining({
        account: handle.seeded.accountIds['acct-savings'], date: recipe.candidate.date,
        amount: -34607, imported_id: 'scenario-native-future-import', imported_payee: 'aster atelier',
        payee: prepared.payeeId, category: prepared.categoryId, cleared: true,
      })]);
      expect(after.rows.filter((row) => row.imported_id !== recipe.candidate.importedId)).toEqual(before.rows);
      expect(after.rules).toEqual(before.rules);
      expect(first).toMatchObject({ kind: 'import-match', transactionIds: [imported[0]?.id], importedIds: ['scenario-native-future-import'], amounts: [-34607] });
      expect(second).toEqual(first);
      expect(journal(handle)).toEqual([]);
    }, { branches: ['native-future-import'] });
  }, testTimeout);

  it('merchant-native-rule-lifecycle refuses a fresh unexecuted proposal after a real source event with no rule or financial write', async () => {
    await withScenario('merchant-native-rule-lifecycle', async (handle) => {
      const prepared = await propose(handle);
      await approve(handle, prepared.proposal);
      expect(await nativeState(handle)).toEqual(prepared.before);
      const event = handle.scenario.events['merchant-source-change'];
      if (!event || event.kind !== 'merchant-source-change') throw new Error('Expected declared merchant source event');
      const changedTransactionId = handle.seeded.transactionIds['synthetic-holdout-000-02'];
      expect(changedTransactionId).not.toBe(prepared.targetId);
      expect(await applyScenarioEvent(eventOptions(handle, 'merchant-source-change'))).toEqual({ kind: 'merchant-source-change', eventId: 'merchant-source-change', transactionId: changedTransactionId, payeeId: handle.seeded.payeeIds['pay-market'] });
      const changed = await nativeState(handle);
      expect(changed.rows).toEqual(prepared.before.rows.map((row) => row.id === changedTransactionId ? { ...row, imported_payee: 'Aster Atelier Revised', notes: 'Source changed for stale proposal' } : row));
      expect(changed.payees).toEqual(prepared.before.payees.map((payee) => payee.id === handle.seeded.payeeIds['pay-market'] ? { ...payee, name: 'Aster Atelier Revised' } : payee));
      expect(changed.rules).toEqual(prepared.before.rules);
      const refused = await scenarioRequest<Envelope<unknown>>(handle, `/api/proposal/${encodeURIComponent(prepared.proposal.id)}/execute`, { method: 'POST', body: {} });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ status: 'error', result: null, error: { code: 'PRECONDITION_FAILED' } });
      expect(await nativeState(handle)).toEqual(changed);
      const immutable = await detail(handle, prepared.proposal.id);
      expect(immutable.proposal.payloadHash).toBe(prepared.proposal.payloadHash);
      expect(immutable.proposal.payload).toEqual(prepared.proposal.payload);
      expect(immutable.proposal.preconditions).toEqual(prepared.proposal.preconditions);
      expect(journal(handle)).toEqual([]);
    }, { branches: ['stale-native-proposal'] });
  }, testTimeout);
});
