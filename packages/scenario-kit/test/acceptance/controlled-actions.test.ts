import {
  createCategory,
  downloadBudget,
  getAccountBalance,
  getAccounts,
  getBudgetMonth,
  getCategories,
  getPayees,
  getTransactions,
  init,
  setBudgetAmount,
  shutdown,
  sync,
} from '@actual-app/api';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteWorkflowStore, type GovernanceResourceKind } from '@balanceframe/workflow-store';
import {
  deriveProposalAuthorizationFacts,
  deriveProposalSourceReadFacts,
} from '../../../workflow-store/src/proposal.js';

import type { LoadedScenario } from '../../src/loader.js';
import { scenarioRequest, withScenario } from './support.js';

const TEST_TIMEOUT = 180_000;

type Money = { minorUnits: string; currency: string };
type Envelope<T> = { status: string; result?: T; error?: { code?: string; reasonCodes?: string[] } | null };
type Card = {
  outcome: string;
  fundingPaths: Array<Record<string, unknown>>;
  selectedAccountId?: string | null;
  cart?: { total: Money; categoryCharges: Array<{ categoryId: string; amount: Money }> };
  [key: string]: unknown;
};
type PurchaseInput = {
  categoryId: string;
  accountId?: string | null;
  amount: Money;
  purchaseAt?: string;
  requiredBy?: string;
};
type SessionItem = PurchaseInput & {
  id: string;
  priority?: 'required' | 'planned' | 'optional';
  quantity?: number;
  categoryAllocations?: Array<{ categoryId: string; amount: Money }>;
  barcode?: string;
  priceProvenance?: Record<string, unknown> | null;
};
type Session = {
  id: string;
  version: number;
  expiresAt: string;
  items: SessionItem[];
  card: Card;
  [key: string]: unknown;
};
type PublicActionPlan = {
  version: string;
  action: Record<string, unknown>;
  source: {
    snapshotReference: string;
    policyVersion: string;
    financialPolicyVersion: string;
    claimSetRevision: string;
  };
  expiresAt: string;
  reasonCodes: string[];
  impacts: Array<Record<string, unknown>>;
  expectedPostconditions: Array<Record<string, unknown>>;
};
type Proposal = {
  id: string;
  operation: string;
  payloadHash: string;
  requesterActorId: string;
  governancePolicyVersion: string | null;
  currentGovernancePolicyVersion: string;
  financialPolicyVersion: string;
  currentFinancialPolicyVersion: string | null;
  requiredApprovers: number;
  approvers: Array<{ actorId: string }>;
  canExecute: boolean;
  payload: { kind: string; plan: PublicActionPlan };
};
type ActualRow = Record<string, unknown> & { id?: string; account?: string };
type ActualSnapshot = {
  assignments: Record<string, number | undefined>;
  cash: Record<string, number>;
  accounts: Array<{ id: string; name?: string; offbudget?: boolean; closed?: boolean; balance_current: number }>;
  transactions: ActualRow[];
};
type Reallocation = {
  kind: 'reallocation';
  assignments: Array<{
    sourceCategoryId: string;
    sourceAsOfMonth: string;
    destinationCategoryId: string;
    destinationAsOfMonth: string;
    amount: Money;
  }>;
};
type Decision = {
  accountId: string | null;
  items: SessionItem[];
  expiresAt?: string;
  adjustments?: unknown[];
  warningThresholds?: unknown[];
};
type ActionResource = {
  resourceKind: 'budget' | 'account' | 'category' | 'wallet' | 'transfer' | 'transaction' | 'ledger_effect' | 'evidence';
  resourceId: string;
};

function resultOf<T>(response: { status: number; body: unknown }, label: string): T {
  expect(response.status, `${label} HTTP status: ${JSON.stringify(response.body)}`).toBe(200);
  const envelope = response.body as Envelope<T>;
  expect(envelope.status, `${label} envelope`).toBe('ok');
  expect(envelope.result, `${label} result`).toBeDefined();
  return envelope.result as T;
}

function expectSafePublicProposal(proposal: Proposal): void {
  const { plan } = proposal.payload;
  expect(proposal.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(proposal.currentGovernancePolicyVersion).toEqual(expect.any(String));
  expect(proposal.financialPolicyVersion).toBe(plan.source.financialPolicyVersion);
  expect(proposal.currentFinancialPolicyVersion).toBe(plan.source.financialPolicyVersion);
  expect(proposal).toHaveProperty('governancePolicyVersion');
  expect(proposal).not.toHaveProperty('actionHash');
  expect(proposal).not.toHaveProperty('preconditions');
  expect(plan.source).toMatchObject({
    snapshotReference: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    policyVersion: expect.any(String),
    financialPolicyVersion: expect.any(String),
    claimSetRevision: expect.any(String),
  });
  expect(plan).not.toHaveProperty('actionHash');
  expect(plan).not.toHaveProperty('idempotencyKey');
  for (const privateField of ['snapshotId', 'contentHash', 'preconditionsHash', 'invariantsHash'])
    expect(plan.source).not.toHaveProperty(privateField);
}

function expectRejected(response: { status: number; body: unknown }, label: string): void {
  expect(response.status, `${label} HTTP status: ${JSON.stringify(response.body)}`).toBeGreaterThanOrEqual(400);
  expect((response.body as Envelope<unknown>).status, `${label} envelope`).toBe('error');
}

function purchaseInput(handle: LoadedScenario): PurchaseInput {
  if (handle.initialized.entry.kind !== 'purchase')
    throw new Error('Expected a purchase scenario entry');
  const input = handle.initialized.entry.input;
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  return { ...input, purchaseAt: input.purchaseAt ?? future, requiredBy: input.requiredBy ?? future };
}

function purchaseDecision(input: PurchaseInput, id = 'phase9-reallocation-purchase'): Decision {
  if (!input.accountId || !input.purchaseAt || !input.requiredBy)
    throw new Error('Reallocation decision requires a pinned account and purchase window');
  return {
    accountId: input.accountId,
    items: [{
      id,
      categoryId: input.categoryId,
      accountId: input.accountId,
      amount: input.amount,
      purchaseAt: input.purchaseAt,
      requiredBy: input.requiredBy,
      priority: 'required',
    }],
  };
}

async function evaluatePurchase(handle: LoadedScenario, input: PurchaseInput): Promise<Card> {
  const query = new URLSearchParams({
    categoryId: input.categoryId,
    amount: input.amount.minorUnits,
    currency: input.amount.currency,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.purchaseAt ? { purchaseAt: input.purchaseAt } : {}),
    ...(input.requiredBy ? { requiredBy: input.requiredBy } : {}),
  });
  return resultOf<{ card: Card }>(
    await scenarioRequest<Envelope<{ card: Card }>>(handle, `/api/purchase/evaluate?${query}`),
    'purchase evaluation',
  ).card;
}

function reallocationPath(card: Card): NonNullable<Reallocation['assignments'][number]> {
  const path = card.fundingPaths.find(({ kind }) => kind === 'category_reallocation');
  if (!path) throw new Error('Native card has no category_reallocation funding path');
  return {
    sourceCategoryId: String(path.sourceCategoryId),
    sourceAsOfMonth: String(path.sourceAsOfMonth),
    destinationCategoryId: String(path.destinationCategoryId),
    destinationAsOfMonth: String(path.destinationAsOfMonth),
    amount: path.amount as Money,
  };
}

function reallocationIntent(card: Card): Reallocation {
  return { kind: 'reallocation', assignments: [reallocationPath(card)] };
}

function requireApprovers(handle: LoadedScenario): void {
  const owner = handle.initialized.personas.owner;
  const coapprover = handle.initialized.personas.coapprover;
  const approver = handle.initialized.personas.approver;
  if (!owner || !coapprover || !approver)
    throw new Error('The acceptance fixture must seed distinct owner, coapprover, and approver humans');
  expect(new Set([owner.actorId, coapprover.actorId, approver.actorId]).size).toBe(3);
}

type ReadGrant = { resourceKind: GovernanceResourceKind; resourceId: string; capability: string };

async function grantExactReads(handle: LoadedScenario, personaId: string, grants: readonly ReadGrant[]): Promise<void> {
  const persona = handle.initialized.personas[personaId];
  if (!persona) throw new Error(`Missing fictional persona ${personaId}`);
  const unique = new Map(grants.map((grant) => [
    `${grant.resourceKind}:${grant.resourceId}:${grant.capability}`, grant,
  ]));
  for (const grant of unique.values())
    resultOf(await scenarioRequest(handle, `/api/spaces/${encodeURIComponent(handle.initialized.spaceId)}/grants`, {
      method: 'PUT', body: { membershipId: persona.membershipId, ...grant, granted: true },
    }), `exact source read for ${personaId}`);
}

async function grantProposalReads(handle: LoadedScenario, proposalId: string, personaId: string): Promise<void> {
  const store = new SqliteWorkflowStore(handle.processes.workflowDbPath);
  let grants: ReadGrant[];
  try {
    const stored = await store.getProposal(proposalId);
    if (!stored || stored.operation !== 'consequential_action') throw new Error('Expected a stored action proposal');
    const preconditions = JSON.parse(stored.preconditions) as unknown;
    const source = deriveProposalSourceReadFacts(stored.operation, stored.payload, preconditions, stored.budgetId);
    if (!source) throw new Error('Expected the exact action source-read closure');
    const effect = deriveProposalAuthorizationFacts(stored.operation, stored.payload, preconditions);
    grants = [
      ...source.required.map(({ resourceKind, resourceId, capability }) => ({ resourceKind, resourceId, capability })),
      ...[...source.resources, ...effect.resources]
        .filter(({ resourceKind }) => resourceKind !== 'budget')
        .map((resource) => ({ ...resource, capability: 'full-read' })),
    ];
  } finally {
    store.close();
  }
  await grantExactReads(handle, personaId, grants);
}

async function configureAssistancePolicy(handle: LoadedScenario, minimumApprovers: number): Promise<void> {
  const path = `/api/spaces/${encodeURIComponent(handle.initialized.spaceId)}/policy`;
  const current = resultOf<{ policy: {
    version: string;
    minimumApprovers: number;
    approvalThresholds?: unknown[];
    operationApprovers?: Record<string, number>;
  } }>(await scenarioRequest<Envelope<{
    policy: {
      version: string;
      minimumApprovers: number;
      approvalThresholds?: unknown[];
      operationApprovers?: Record<string, number>;
    };
  }>>(handle, path), 'current governance policy').policy;
  resultOf(await scenarioRequest<Envelope<unknown>>(handle, path, {
    method: 'PUT',
    body: {
      expectedVersion: current.version,
      policy: {
        minimumApprovers,
        ...(current.approvalThresholds === undefined ? {} : { approvalThresholds: current.approvalThresholds }),
        ...(current.operationApprovers === undefined ? {} : { operationApprovers: current.operationApprovers }),
        assistanceMaximum: 'execute_approved_actions',
      },
    },
  }), 'versioned consequential-action assistance policy');
  await grantExactReads(handle, 'owner', [
    ...['observe', 'source'].map((capability) => ({
      resourceKind: 'budget' as const, resourceId: handle.seeded.budgetId, capability,
    })),
    ...handle.seeded.readResources
      .filter(({ resourceKind }) => resourceKind === 'account' || resourceKind === 'transaction')
      .flatMap(({ resourceId, resourceKind }) => [
        ...['evidence', 'normalized-evidence', 'full-read'].map((capability) => ({
          resourceKind: 'evidence' as const, resourceId, capability,
        })),
        ...(resourceKind === 'transaction'
          ? [{ resourceKind: 'evidence' as const, resourceId, capability: 'ledger-effect' }]
          : []),
      ]),
  ]);
}

async function grantActionPhase(
  handle: LoadedScenario,
  personaId: string,
  actionKind: 'reallocation' | 'transaction' | 'ledger_projection' | 'wallet_materialization' | 'transfer',
  phase: 'propose' | 'approve' | 'execute',
  resources: readonly ActionResource[],
): Promise<void> {
  const persona = handle.initialized.personas[personaId];
  if (!persona) throw new Error(`Missing fictional persona ${personaId}`);
  for (const resource of resources) {
    resultOf(await scenarioRequest<Envelope<unknown>>(
      handle,
      `/api/spaces/${encodeURIComponent(handle.initialized.spaceId)}/grants`,
      {
        method: 'PUT',
        body: {
          membershipId: persona.membershipId,
          ...resource,
          capability: `${actionKind}:${phase}`,
          granted: true,
        },
      },
    ), `${actionKind}:${phase} grant for ${personaId}`);
  }
  if (phase === 'propose') {
    const capabilities: Partial<Record<GovernanceResourceKind, readonly string[]>> = {
      transaction: ['transaction.view', 'history', 'source', 'full-read'],
      ledger_effect: ['full-read'],
      wallet: ['existence', 'history', 'name', 'full-read'],
      transfer: ['transfer.view', 'source', 'full-read'],
    };
    await grantExactReads(handle, personaId, resources.flatMap((resource) =>
      (capabilities[resource.resourceKind] ?? []).map((capability) => ({ ...resource, capability }))));
  }
}

function categoryResources(handle: LoadedScenario, categoryIds: readonly string[]): ActionResource[] {
  return [
    { resourceKind: 'budget', resourceId: handle.seeded.budgetId },
    ...categoryIds.map((resourceId) => ({ resourceKind: 'category' as const, resourceId })),
  ];
}

async function configureReallocationActors(
  handle: LoadedScenario,
  categoryIds: readonly string[],
  minimumApprovers: number,
): Promise<void> {
  const resources = categoryResources(handle, categoryIds);
  await configureAssistancePolicy(handle, minimumApprovers);
  await grantActionPhase(handle, 'owner', 'reallocation', 'propose', resources);
  await grantActionPhase(handle, 'owner', 'reallocation', 'execute', resources);
  for (const personaId of ['coapprover', 'approver']) {
    if (handle.initialized.personas[personaId])
      await grantActionPhase(handle, personaId, 'reallocation', 'approve', resources);
  }
}

async function configureTransactionActors(
  handle: LoadedScenario,
  accountId: string,
  categoryIds: readonly string[],
  parentId: string,
): Promise<void> {
  const resources: ActionResource[] = [
    { resourceKind: 'budget', resourceId: handle.seeded.budgetId },
    { resourceKind: 'account', resourceId: accountId },
    ...categoryIds.map((resourceId) => ({ resourceKind: 'category' as const, resourceId })),
    { resourceKind: 'transaction', resourceId: parentId },
    { resourceKind: 'ledger_effect', resourceId: parentId },
  ];
  await configureAssistancePolicy(handle, 2);
  await grantActionPhase(handle, 'owner', 'transaction', 'propose', resources);
  await grantActionPhase(handle, 'owner', 'transaction', 'execute', resources);
  for (const personaId of ['coapprover', 'approver'])
    await grantActionPhase(handle, personaId, 'transaction', 'approve', resources);
}

async function configureWalletActors(handle: LoadedScenario, walletId: string): Promise<void> {
  const resources: ActionResource[] = [
    { resourceKind: 'budget', resourceId: handle.seeded.budgetId },
    { resourceKind: 'wallet', resourceId: walletId },
  ];
  await configureAssistancePolicy(handle, 2);
  await grantActionPhase(handle, 'owner', 'wallet_materialization', 'propose', resources);
  await grantActionPhase(handle, 'owner', 'wallet_materialization', 'execute', resources);
  for (const personaId of ['coapprover', 'approver'])
    await grantActionPhase(handle, personaId, 'wallet_materialization', 'approve', resources);
}

async function configureTransferActors(
  handle: LoadedScenario,
  transferId: string,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<void> {
  const resources: ActionResource[] = [
    { resourceKind: 'budget', resourceId: handle.seeded.budgetId },
    { resourceKind: 'account', resourceId: sourceAccountId },
    { resourceKind: 'account', resourceId: destinationAccountId },
    { resourceKind: 'transfer', resourceId: transferId },
  ];
  await configureAssistancePolicy(handle, 2);
  await grantActionPhase(handle, 'owner', 'transfer', 'propose', resources);
  await grantActionPhase(handle, 'owner', 'transfer', 'execute', resources);
  for (const personaId of ['coapprover', 'approver']) {
    if (handle.initialized.personas[personaId])
      await grantActionPhase(handle, personaId, 'transfer', 'approve', resources);
  }
  resultOf(await scenarioRequest<Envelope<unknown>>(
    handle,
    `/api/spaces/${encodeURIComponent(handle.initialized.spaceId)}/grants`,
    {
      method: 'PUT',
      body: {
        membershipId: handle.initialized.personas.owner!.membershipId,
        resourceKind: 'transfer',
        resourceId: transferId,
        capability: 'proposal',
        granted: true,
      },
    },
  ), 'Phase 8.7 transfer-read control');
}

async function actualClient<T>(handle: LoadedScenario, operation: () => Promise<T>): Promise<T> {
  const dataDir = mkdtempSync(join(handle.processes.root, 'controlled-actions-actual-'));
  let initialized = false;
  try {
    await init({
      serverURL: handle.processes.actualUrl,
      password: handle.processes.actualSecretKey,
      dataDir,
    });
    initialized = true;
    return await operation();
  } finally {
    try {
      if (initialized) await shutdown();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

function transactionRows(rows: readonly ActualRow[]): ActualRow[] {
  return rows
    .filter((row) => typeof row.id === 'string')
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function actualSnapshot(
  handle: LoadedScenario,
  months: readonly string[],
  categoryIds: readonly string[],
): Promise<ActualSnapshot> {
  return actualClient(handle, async () => {
    await downloadBudget(handle.seeded.groupId);
    const accounts = (await getAccounts()) as unknown as Array<{
      id?: string;
      name?: string;
      offbudget?: boolean;
      closed?: boolean;
    }>;
    const accountsReadback: ActualSnapshot['accounts'] = [];
    for (const { id, name, offbudget, closed } of accounts) {
      if (typeof id !== 'string') throw new Error('Actual account ID missing');
      const balance_current = await getAccountBalance(id);
      expect(Number.isSafeInteger(balance_current), `Actual cash for ${id}`).toBe(true);
      accountsReadback.push({ id, name, offbudget, closed, balance_current });
    }
    accountsReadback.sort((left, right) => left.id.localeCompare(right.id));
    const cash = Object.fromEntries(accountsReadback.map((account) => [account.id, account.balance_current]));
    const transactions: ActualRow[] = [];
    for (const account of accounts) {
      if (typeof account.id !== 'string') continue;
      transactions.push(...((await getTransactions(account.id, '1900-01-01', '2999-12-31')) as unknown as ActualRow[]));
    }
    const assignments: Record<string, number | undefined> = {};
    for (const month of months) {
      const budget = await getBudgetMonth(month) as unknown as {
        categoryGroups?: Array<{ categories?: Array<{ id: string; budgeted?: number }> }>;
      };
      const categories = (budget.categoryGroups ?? []).flatMap((group) => group.categories ?? []);
      for (const categoryId of categoryIds) {
        assignments[`${month}:${categoryId}`] = categories.find(({ id }) => id === categoryId)?.budgeted;
      }
    }
    return { assignments, cash, accounts: accountsReadback, transactions: transactionRows(transactions) };
  });
}

async function actualPayees(handle: LoadedScenario): Promise<Array<{ id: string; transfer_acct?: string | null }>> {
  return actualClient(handle, async () => {
    await downloadBudget(handle.seeded.groupId);
    return (await getPayees()) as unknown as Array<{ id: string; transfer_acct?: string | null }>;
  });
}

async function setExternalAssignment(
  handle: LoadedScenario,
  month: string,
  categoryId: string,
  amount: number,
): Promise<void> {
  await actualClient(handle, async () => {
    await downloadBudget(handle.seeded.groupId);
    await setBudgetAmount(month, categoryId, amount);
    await sync();
  });
}

async function proposeAction(
  handle: LoadedScenario,
  action: object,
  decision?: Decision,
): Promise<Proposal> {
  const proposal = resultOf<{ proposal: Proposal }>(await scenarioRequest<Envelope<{ proposal: Proposal }>>(
    handle,
    '/api/proposal/action',
    { method: 'POST', body: { action, ...(decision ? { decision } : {}) } },
  ), 'consequential-action proposal').proposal;
  expectSafePublicProposal(proposal);
  return proposal;
}

async function proposalDetail(handle: LoadedScenario, id: string, personaId = 'owner'): Promise<Proposal> {
  const proposal = resultOf<{ proposal: Proposal }>(await scenarioRequest<Envelope<{ proposal: Proposal }>>(
    handle,
    `/api/proposal/${encodeURIComponent(id)}`,
    { personaId },
  ), 'consequential-action detail').proposal;
  expectSafePublicProposal(proposal);
  return proposal;
}

async function approve(handle: LoadedScenario, proposal: Proposal, personaId: string): Promise<void> {
  await grantProposalReads(handle, proposal.id, personaId);
  resultOf(await scenarioRequest<Envelope<unknown>>(
    handle,
    `/api/proposal/${encodeURIComponent(proposal.id)}/approve`,
    { method: 'POST', personaId, body: { payloadHash: proposal.payloadHash } },
  ), `approval by ${personaId}`);
}

function assignMonth(intent: Reallocation): string[] {
  return [...new Set(intent.assignments.flatMap(({ sourceAsOfMonth, destinationAsOfMonth }) => [
    sourceAsOfMonth,
    destinationAsOfMonth,
  ]))];
}

function assignCategories(intent: Reallocation): string[] {
  return [...new Set(intent.assignments.flatMap(({ sourceCategoryId, destinationCategoryId }) => [
    sourceCategoryId,
    destinationCategoryId,
  ]))];
}

function sessionDecision(session: Session): Decision {
  return {
    accountId: typeof session.accountId === 'string' ? session.accountId : null,
    items: session.items,
    expiresAt: session.expiresAt,
    ...(Array.isArray(session.adjustments) ? { adjustments: session.adjustments } : {}),
    ...(Array.isArray(session.warningThresholds) ? { warningThresholds: session.warningThresholds } : {}),
  };
}

async function readSession(handle: LoadedScenario, key: string): Promise<Session> {
  const id = handle.initialized.sessions[key];
  if (!id) throw new Error(`Missing initialized session ${key}`);
  const path = `/api/spend-sessions/${encodeURIComponent(id)}`;
  const session = resultOf<Session>(await scenarioRequest<Envelope<Session>>(handle, path), `session ${key}`);
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  expect(Date.parse(future)).toBeLessThan(Date.parse(session.expiresAt));
  return resultOf<Session>(await scenarioRequest<Envelope<Session>>(handle, path, {
    method: 'PUT',
    body: {
      expectedVersion: session.version,
      accountId: typeof session.accountId === 'string' ? session.accountId : null,
      expiresAt: session.expiresAt,
      items: session.items.map((item) => ({ ...item, purchaseAt: future, requiredBy: future })),
      ...(Array.isArray(session.adjustments) ? { adjustments: session.adjustments } : {}),
      ...(Array.isArray(session.warningThresholds) ? { warningThresholds: session.warningThresholds } : {}),
    },
  }), `future session ${key}`);
}

async function approveWithTwoHumans(handle: LoadedScenario, proposal: Proposal): Promise<void> {
  requireApprovers(handle);
  expect(proposal.requesterActorId).toBe(handle.initialized.personas.owner!.actorId);
  expect(proposal.requiredApprovers).toBe(2);
  await approve(handle, proposal, 'coapprover');
  const one = await proposalDetail(handle, proposal.id);
  expect(one.approvers.map(({ actorId }) => actorId)).toEqual([handle.initialized.personas.coapprover!.actorId]);
  expect(one.canExecute).toBe(false);
  await approve(handle, proposal, 'approver');
  const two = await proposalDetail(handle, proposal.id);
  expect(two.approvers.map(({ actorId }) => actorId).sort()).toEqual([
    handle.initialized.personas.approver!.actorId,
    handle.initialized.personas.coapprover!.actorId,
  ].sort());
  expect(two.canExecute).toBe(true);
}

describe('authenticated Actual-backed consequential action scenarios', () => {
  it('donor-reallocation proposes the exact native path, requires independent quorum, executes explicitly, and replays without extra effects',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('donor-reallocation', async (handle) => {
        const input = purchaseInput(handle);
        const beforePathMonth = input.purchaseAt!.slice(0, 7);
        const donorId = handle.seeded.categoryIds['cat-donor']!;
        const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
        await configureReallocationActors(handle, [donorId, groceriesId], 2);
        const before = await actualSnapshot(handle, [beforePathMonth], [donorId, groceriesId]);
        const card = await evaluatePurchase(handle, input);
        expect(card.outcome).toBe('safe_with_reallocation');
        const action = reallocationIntent(card);
        const assignment = action.assignments[0]!;
        expect(assignment).toMatchObject({
          sourceCategoryId: donorId,
          destinationCategoryId: groceriesId,
          amount: { minorUnits: '2000', currency: 'USD' },
        });
        expect(assignMonth(action)).toEqual([beforePathMonth]);
        expect(await actualSnapshot(handle, assignMonth(action), assignCategories(action))).toEqual(before);

        const decision = purchaseDecision(input);
        const proposed = await proposeAction(handle, action, decision);
        expect(proposed).toMatchObject({
          operation: 'consequential_action',
          requesterActorId: handle.initialized.personas.owner!.actorId,
          requiredApprovers: 2,
          approvers: [],
          payload: { kind: 'consequential_action', plan: { action } },
        });
        const listed = resultOf<{ proposals: Array<{ id: string; operation: string }>; total: number }>(
          await scenarioRequest<Envelope<{ proposals: Array<{ id: string; operation: string }>; total: number }>>(
            handle, '/api/proposal',
          ),
          'ordinary proposal list',
        );
        expect(listed.proposals).toContainEqual(expect.objectContaining({
          id: proposed.id,
          operation: 'consequential_action',
        }));
        expect((await proposalDetail(handle, proposed.id)).payload.plan.action).toEqual(action);
        expect(await actualSnapshot(handle, assignMonth(action), assignCategories(action))).toEqual(before);

        const requesterApproval = await scenarioRequest<Envelope<unknown>>(
          handle,
          `/api/proposal/${encodeURIComponent(proposed.id)}/approve`,
          { method: 'POST', body: { payloadHash: proposed.payloadHash } },
        );
        expect(requesterApproval.status).toBe(403);
        await approveWithTwoHumans(handle, proposed);
        expect(await actualSnapshot(handle, assignMonth(action), assignCategories(action))).toEqual(before);

        const execution = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'explicit reallocation execution',
        );
        const after = await actualSnapshot(handle, assignMonth(action), assignCategories(action));
        expect(after.assignments).toEqual({
          [`${assignment.sourceAsOfMonth}:${donorId}`]: 2000,
          [`${assignment.destinationAsOfMonth}:${groceriesId}`]: 2000,
        });
        expect(after.cash).toEqual(before.cash);
        expect(after.transactions).toEqual(before.transactions);
        expect(execution).toMatchObject({ id: proposed.id, phase: 'verified' });

        const replay = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'replayed reallocation execution',
        );
        expect(replay).toEqual(execution);
        expect(await actualSnapshot(handle, assignMonth(action), assignCategories(action))).toEqual(after);
      }, { branches: ['independent-human-reallocation-quorum'] });
    });
  it('proposes and executes an exact server-derived split manual debit through the same quorum lifecycle',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('coapproval-completion', async (handle) => {
        requireApprovers(handle);
        const session = await readSession(handle, 'cart');
        const cart = session.card.cart;
        const firstItem = session.items[0];
        if (!cart || !firstItem?.requiredBy)
          throw new Error('The native coapproval cart did not provide its split debit intent');
        const accountId = handle.seeded.accountIds['acct-checking']!;
        const categoryIds = cart.categoryCharges.map(({ categoryId }) => categoryId);
        const parentId = randomUUID();
        const correlationId = randomUUID();
        await configureTransactionActors(handle, accountId, categoryIds, parentId);
        const month = firstItem.requiredBy.slice(0, 7);
        const before = await actualSnapshot(handle, [month], categoryIds);
        const amount = { minorUnits: (-BigInt(cart.total.minorUnits)).toString(), currency: cart.total.currency };
        const action = {
          kind: 'manual_transaction',
          transaction: {
            parentId,
            correlationId,
            accountId,
            amount,
            date: firstItem.requiredBy.slice(0, 10),
            categoryId: null,
            payeeName: null,
            notes: null,
            splits: cart.categoryCharges.map(({ categoryId, amount: splitAmount }) => ({
              categoryId,
              amount: {
                minorUnits: (-BigInt(splitAmount.minorUnits)).toString(),
                currency: splitAmount.currency,
              },
            })),
          },
        };
        const source = before.transactions.find((row) => row.account === accountId && typeof row.id === 'string');
        if (!source?.id) throw new Error('Expected current Actual transaction evidence');
        const projection = { kind: 'evidence_projection', evidenceIds: [source.id], transaction: action.transaction };
        const forged = await scenarioRequest<Envelope<unknown>>(handle, '/api/proposal/action', {
          method: 'POST',
          body: {
            action: projection,
            resolvedEvidence: [{
              evidenceId: source.id,
              subjectId: source.id,
              state: 'resolved',
              contentHash: 'client-asserted-content',
              version: 'client-asserted-version',
              observedAt: new Date().toISOString(),
            }],
          },
        });
        expect(forged.status).toBe(400);
        expect(forged.body.status).toBe('error');
        expect(forged.body.error?.code).toBe('INVALID_BODY');
        expect(await actualSnapshot(handle, [month], categoryIds)).toEqual(before);

        await grantActionPhase(handle, 'owner', 'ledger_projection', 'propose', [
          { resourceKind: 'budget', resourceId: handle.seeded.budgetId },
          { resourceKind: 'account', resourceId: accountId },
          ...categoryIds.map((resourceId) => ({ resourceKind: 'category' as const, resourceId })),
          { resourceKind: 'transaction', resourceId: parentId },
          { resourceKind: 'ledger_effect', resourceId: parentId },
          { resourceKind: 'evidence', resourceId: source.id },
        ]);
        await grantExactReads(handle, 'owner', [
          { resourceKind: 'evidence', resourceId: source.id, capability: 'source' },
        ]);
        const absentResolution = await scenarioRequest<Envelope<unknown>>(handle, '/api/proposal/action', {
          method: 'POST', body: { action: projection },
        });
        expect(absentResolution.status).toBe(409);
        expect(absentResolution.body.status).toBe('error');
        expect(absentResolution.body.error?.code).toBe('ACTION_STATE_CHANGED');
        expect(await actualSnapshot(handle, [month], categoryIds)).toEqual(before);

        const proposed = await proposeAction(handle, action);
        expect(proposed.operation).toBe('consequential_action');
        expect(proposed.payload.plan.action).toEqual(action);
        expect(await actualSnapshot(handle, [month], categoryIds)).toEqual(before);
        await approveWithTwoHumans(handle, proposed);
        expect(await actualSnapshot(handle, [month], categoryIds)).toEqual(before);

        const execution = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'explicit split transaction execution',
        );
        const after = await actualSnapshot(handle, [month], categoryIds);
        const parent = after.transactions.find(({ id }) => id === action.transaction.parentId);
        expect(parent).toMatchObject({
          id: action.transaction.parentId,
          account: accountId,
          amount: Number(amount.minorUnits),
          date: action.transaction.date,
          is_parent: true,
        });
        expect(parent?.subtransactions).toEqual(expect.arrayContaining(
          action.transaction.splits.map((split) => expect.objectContaining({
            account: accountId,
            amount: Number(split.amount.minorUnits),
            category: split.categoryId,
            is_child: true,
            parent_id: action.transaction.parentId,
          })),
        ));
        expect(after.transactions).toHaveLength(before.transactions.length + 1);
        expect(after.assignments).toEqual(before.assignments);
        expect(after.cash[accountId]).toBe(before.cash[accountId]! + Number(amount.minorUnits));
        expect(execution).toMatchObject({ id: proposed.id, phase: 'verified' });
      }, { branches: [
        'caller-resolved-evidence-rejected',
        'economic-event-resolution-required',
        'split-manual-debit-approved-executed',
      ] });
    });


  it('holds a shared donor and recipient against a competing safe card without changing Actual',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('donor-competition', async (handle) => {
        const donorId = handle.seeded.categoryIds['cat-donor']!;
        const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
        await configureReallocationActors(handle, [donorId, groceriesId], 1);
        const first = await readSession(handle, 'first');
        const second = await readSession(handle, 'second');
        const firstAction = reallocationIntent(first.card);
        const secondAction = reallocationIntent(second.card);
        expect(firstAction.assignments[0]).toEqual(secondAction.assignments[0]);
        const targets = assignCategories(firstAction);
        const months = assignMonth(firstAction);
        const before = await actualSnapshot(handle, months, targets);

        const proposed = await proposeAction(handle, firstAction, sessionDecision(first));
        expect(proposed.operation).toBe('consequential_action');
        expect(await actualSnapshot(handle, months, targets)).toEqual(before);
        const competing = await scenarioRequest<Envelope<unknown>>(handle, '/api/proposal/action', {
          method: 'POST',
          body: { action: secondAction, decision: sessionDecision(second) },
        });
        expectRejected(competing, 'same-donor / same-recipient proposal');
        expect(await actualSnapshot(handle, months, targets)).toEqual(before);
      });
    });

  it('rejects an attempted transfer from a protected category despite a caller-supplied assignment',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('protected-category', async (handle) => {
        const input = purchaseInput(handle);
        const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
        const destinationId = await actualClient(handle, async () => {
          await downloadBudget(handle.seeded.groupId);
          const categories = await getCategories();
          const protectedCategory = categories.find((category) => category.id === groceriesId);
          if (!protectedCategory?.group_id) throw new Error('Protected category group is missing');
          const id = await createCategory({ name: 'Controlled action destination', group_id: protectedCategory.group_id });
          if (typeof id !== 'string') throw new Error('Destination category ID is missing');
          await sync();
          return id;
        });
        await grantExactReads(handle, 'owner', ['existence', 'balance', 'history', 'liquidity', 'name', 'full-read'].map((capability) => ({
          resourceKind: 'category', resourceId: destinationId, capability,
        })));
        const month = input.purchaseAt!.slice(0, 7);
        await configureReallocationActors(handle, [groceriesId, destinationId], 1);
        const before = await actualSnapshot(handle, [month], [groceriesId, destinationId]);
        const card = await evaluatePurchase(handle, input);
        expect(card.outcome, JSON.stringify(card)).toBe('plan_breaking');
        expect(card.fundingPaths.some(({ kind }) => kind === 'category_reallocation')).toBe(false);
        const response = await scenarioRequest<Envelope<unknown>>(handle, '/api/proposal/action', {
          method: 'POST',
          body: {
            action: {
              kind: 'reallocation',
              assignments: [{
                sourceCategoryId: groceriesId,
                sourceAsOfMonth: month,
                destinationCategoryId: destinationId,
                destinationAsOfMonth: month,
                amount: { minorUnits: '1000', currency: 'USD' },
              }],
            },
            decision: purchaseDecision(input),
          },
        });
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(response.body.error?.code).toBe('ACTION_STATE_CHANGED');
        expect(await actualSnapshot(handle, [month], [groceriesId, destinationId])).toEqual(before);
      });
    });

  it('rejects stale execution after an external Actual assignment edit without overwriting it',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('donor-reallocation', async (handle) => {
        const input = purchaseInput(handle);
        const donorId = handle.seeded.categoryIds['cat-donor']!;
        const groceriesId = handle.seeded.categoryIds['cat-groceries']!;
        await configureReallocationActors(handle, [donorId, groceriesId], 2);
        const card = await evaluatePurchase(handle, input);
        const action = reallocationIntent(card);
        const months = assignMonth(action);
        const categories = assignCategories(action);
        const before = await actualSnapshot(handle, months, categories);
        const proposed = await proposeAction(handle, action, purchaseDecision(input));
        await approveWithTwoHumans(handle, proposed);
        expect(await actualSnapshot(handle, months, categories)).toEqual(before);

        const assignment = action.assignments[0]!;
        await setExternalAssignment(handle, assignment.sourceAsOfMonth, donorId, 3500);
        const externallyEdited = await actualSnapshot(handle, months, categories);
        expect(externallyEdited.assignments).toMatchObject({
          [`${assignment.sourceAsOfMonth}:${donorId}`]: 3500,
          [`${assignment.destinationAsOfMonth}:${groceriesId}`]: 0,
        });
        const execution = await scenarioRequest<Envelope<unknown>>(
          handle,
          `/api/proposal/${encodeURIComponent(proposed.id)}/execute`,
          { method: 'POST', body: {} },
        );
        expectRejected(execution, 'stale reallocation execution');
        expect(await actualSnapshot(handle, months, categories)).toEqual(externallyEdited);
      }, { branches: ['stale-actual-assignment-rejected'] });
    });
  it('binds a generated wallet account ID to its stable wallet ID and does not rematerialize on replay',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('coapproval-completion', async (handle) => {
        requireApprovers(handle);
        const walletId = `scenario-wallet-${randomUUID()}`;
        const accountName = `Scenario Cash Envelope ${randomUUID()}`;
        await configureWalletActors(handle, walletId);
        const before = await actualSnapshot(handle, [], []);
        const action = { kind: 'wallet_materialization', walletId, accountName, currency: 'USD' };
        const proposed = await proposeAction(handle, action);
        expect(proposed.payload.plan.action).toEqual(action);
        expect(await actualSnapshot(handle, [], [])).toEqual(before);
        await approveWithTwoHumans(handle, proposed);
        expect(await actualSnapshot(handle, [], [])).toEqual(before);

        const execution = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'explicit wallet materialization',
        );
        const after = await actualSnapshot(handle, [], []);
        const created = after.accounts.filter(({ id }) => !Object.hasOwn(before.cash, id));
        expect(created).toHaveLength(1);
        const generated = created[0]!;
        expect(generated).toMatchObject({ name: accountName, offbudget: false, closed: false, balance_current: 0 });
        expect(generated.id).not.toBe(walletId);
        expect(execution).toMatchObject({ id: proposed.id, phase: 'verified' });
        const workflow = new SqliteWorkflowStore(handle.processes.workflowDbPath);
        try {
          const stored = await workflow.getProposal(proposed.id);
          if (!stored || stored.operation !== 'consequential_action')
            throw new Error('Persisted wallet action is unavailable');
          expect(stored.state.effects).toMatchObject([{
            actionKind: 'wallet_materialization',
            result: {
              kind: 'wallet_materialization',
              result: { success: true, verified: true, walletId, accountId: generated.id },
            },
          }]);
        } finally {
          workflow.close();
        }
        expect(after.transactions).toEqual(before.transactions);
        expect(after.assignments).toEqual(before.assignments);
        expect(after.cash[generated.id]).toBe(0);

        const replay = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'replayed wallet materialization',
        );
        expect(replay).toEqual(execution);
        expect(await actualSnapshot(handle, [], [])).toEqual(after);
      }, { branches: ['wallet-materialization-replay-safe'] });
    });

  it('writes a reciprocal Actual transfer pair without creating or settling a Phase 8.7 transfer',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('account-transfer', async (handle) => {
        const input = purchaseInput(handle);
        const card = await evaluatePurchase(handle, input);
        const path = card.fundingPaths.find(({ kind }) => kind === 'account_transfer');
        if (!path) throw new Error('Expected the native account-transfer funding path');
        const leg = (path.legs as Array<Record<string, unknown>>)[0];
        if (!leg) throw new Error('Native transfer path omitted its exact leg');
        const transferId = `scenario-ledger-transfer-${randomUUID()}`;
        const correlationId = randomUUID();
        const sourceAccountId = String(leg.sourceAccountId);
        const destinationAccountId = String(leg.destinationAccountId);
        const amount = leg.amount as Money;
        // The transfer posts now; the purchase deadline can be on the following UTC date.
        const date = handle.scenario.anchor.slice(0, 10);
        await configureTransferActors(handle, transferId, sourceAccountId, destinationAccountId);
        const before = await actualSnapshot(handle, [], []);
        const legacyPath = `/api/transfer/${encodeURIComponent(transferId)}`;
        const settlementBefore = await scenarioRequest<Envelope<unknown>>(handle, legacyPath);
        expectRejected(settlementBefore, 'preexisting Phase 8.7 transfer');

        const action = {
          kind: 'transfer',
          transferId,
          correlationId,
          sourceAccountId,
          destinationAccountId,
          amount,
          date,
        };
        const proposed = await proposeAction(handle, action);
        expect(proposed.payload.plan.action).toEqual(action);
        expect(await actualSnapshot(handle, [], [])).toEqual(before);
        await approveWithTwoHumans(handle, proposed);
        expect(await actualSnapshot(handle, [], [])).toEqual(before);

        const execution = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'explicit ledger-only transfer execution',
        );
        expect(execution).toMatchObject({ id: proposed.id, phase: 'verified' });
        expect(execution).not.toHaveProperty('settled');
        expect(execution).not.toHaveProperty('settlement');
        const after = await actualSnapshot(handle, [], []);
        const priorIds = new Set(before.transactions.map(({ id }) => String(id)));
        const added = after.transactions.filter(({ id }) => !priorIds.has(String(id)));
        expect(added).toHaveLength(2);
        const source = added.find(({ account }) => account === sourceAccountId)!;
        const destination = added.find(({ account }) => account === destinationAccountId)!;
        const minorUnits = Number(amount.minorUnits);
        const marker = `balanceframe:transfer:${transferId}:${correlationId}`;
        expect(source).toMatchObject({
          amount: -minorUnits,
          date,
          notes: marker,
          transfer_id: destination.id,
        });
        expect(destination).toMatchObject({
          amount: minorUnits,
          date,
          notes: marker,
          transfer_id: source.id,
        });
        const payees = new Map((await actualPayees(handle)).map(({ id, transfer_acct }) => [id, transfer_acct] as const));
        expect(payees.get(String(source.payee))).toBe(destinationAccountId);
        expect(payees.get(String(destination.payee))).toBe(sourceAccountId);
        expect(after.cash[sourceAccountId]).toBe(before.cash[sourceAccountId]! - minorUnits);
        expect(after.cash[destinationAccountId]).toBe(before.cash[destinationAccountId]! + minorUnits);
        expect(after.cash[sourceAccountId]! + after.cash[destinationAccountId]!)
          .toBe(before.cash[sourceAccountId]! + before.cash[destinationAccountId]!);
        const settlementAfter = await scenarioRequest<Envelope<unknown>>(handle, legacyPath);
        expectRejected(settlementAfter, 'Phase 8.7 settlement lookup after ledger transfer');
        expect(settlementAfter.status).toBe(settlementBefore.status);
        expect((settlementAfter.body as Envelope<unknown>).error?.code)
          .toBe((settlementBefore.body as Envelope<unknown>).error?.code);

        const replay = resultOf<Record<string, unknown>>(
          await scenarioRequest<Envelope<Record<string, unknown>>>(
            handle, `/api/proposal/${encodeURIComponent(proposed.id)}/execute`, { method: 'POST', body: {} },
          ),
          'replayed ledger-only transfer',
        );
        expect(replay).toEqual(execution);
        expect(await actualSnapshot(handle, [], [])).toEqual(after);
      }, { branches: ['ledger-only-reciprocal-transfer'] });
    });

});
