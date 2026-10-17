import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decisionCardRequestSchema,
  planConsequentialActionRequestSchema,
  verifyConsequentialActionRequestSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  ConsequentialActionIntent,
  ConsequentialActionPlan,
  ConsequentialActionVerification,
  DecisionCardRequest,
  FinancialSnapshot,
  PlanConsequentialActionRequest,
  VerifyConsequentialActionRequest,
} from '@balanceframe/protocol-generated';
import {
  issueConsequentialActionInvalidationToken,
  issueConsequentialActionVerificationToken,
} from '../src/internal.js';
import type { GovernancePolicyInput, GovernanceResourceRef } from '../src/governance-types.js';
import type { ConsequentialActionExecutionIdentity } from '../src/types.js';
import {
  canonicalProposalHash,
  canonicalProposalJson,
  CONSEQUENTIAL_ACTION_CAPABILITY_MAP,
  deriveProposalAuthorizationFacts,
  deriveProposalDisclosureTotals,
  deriveProposalSourceReadFacts,
  GENERIC_MUTATION_POLICY_VERSION,
} from '../src/proposal.js';
import { SqliteWorkflowStore } from '../src/store.js';
import type { CreateProposalInput } from '../src/types.js';

const INITIAL_TIME = '2026-09-06T10:00:00.000Z';
const BUDGET_ID = 'budget-phase9-action';
const MONEY = (minorUnits: string | number) => ({ minorUnits: String(minorUnits), currency: 'USD' });
const capabilityPhases = ['propose', 'approve', 'execute'] as const;
type CapabilityPhase = (typeof capabilityPhases)[number];
type ActionAtom = Exclude<ConsequentialActionIntent, { kind: 'composite' }>;
type AssistanceMaximum =
  | 'analysis_only'
  | 'recommend_actions'
  | 'create_approval_proposal'
  | 'execute_approved_actions';
type Resource = GovernanceResourceRef;

interface LiquidityFixture {
  snapshotId: string;
  contentHash: string;
  evaluatedAt: string;
  horizon: DecisionCardRequest['context']['horizon'];
  facts: NonNullable<FinancialSnapshot['liquidity']>;
  liquidityPolicy: DecisionCardRequest['liquidityPolicy'];
  claimSet: DecisionCardRequest['claimSet'];
  scenario: { items: DecisionCardRequest['items'] };
  validUntil: string;
  maxBudgetSnapshotAgeMinutes: number;
}
interface FoundationFixture {
  full: FinancialSnapshot;
  claims: { context: DecisionCardRequest['context'] };
}
interface ActionFixture extends Pick<PlanConsequentialActionRequest,
  'intent' | 'currentLedger' | 'resolvedEvidence' | 'financialPolicyVersion' | 'evaluatedAt' | 'idempotencyKey'> {
  alternateDonorIntent: ConsequentialActionIntent;
  alternateDonorEligibility: Array<{ categoryId: string; donorEligible: boolean }>;
  compositeIntent: ConsequentialActionIntent;
  sourceObservation: DecisionCardRequest['financialSnapshot']['observations'][number];
  evidenceProjectionIntent: ConsequentialActionIntent;
  postconditions: {
    reallocation: {
      currentLedger: PlanConsequentialActionRequest['currentLedger'];
      financialSnapshot: { categoryAvailability: Array<{ categoryId: string; amount: { minorUnits: string; currency: string } }> };
    };
    composite: {
      currentLedger: PlanConsequentialActionRequest['currentLedger'];
      financialSnapshot: {
        accountBalances: Array<{ accountId: string; balance: { minorUnits: string; currency: string } }>;
        categoryAvailability: Array<{ categoryId: string; amount: { minorUnits: string; currency: string } }>;
      };
    };
  };
}
interface NativeConsequentialBindings {
  planConsequentialAction(request: string): string;
  verifyConsequentialAction(request: string): string;
}
interface StoredConsequentialProposal {
  id: string;
  operation: string;
  payloadHash: string;
  governancePolicyVersion: string;
  policyVersion: string;
  expiresAt: string;
  payload: { kind: 'consequential_action'; plan: ConsequentialActionPlan };
  preconditions: string;
}
interface StoredGenericProposal {
  id: string;
  operation: string;
  payloadHash: string;
  governancePolicyVersion: string;
  expiresAt: string;
  payload: unknown;
  preconditions: string;
}
interface AcquiredAction {
  proposal: StoredConsequentialProposal;
  input: Record<string, unknown>;
  acquisitionAuditId: string;
}
const readFixture = (name: string): unknown => JSON.parse(readFileSync(
  new URL(`../../../protocol/fixtures/${name}`, import.meta.url),
  'utf8',
));
const liquidityFixture = readFixture('account-aware-liquidity.json') as LiquidityFixture;
const foundationFixture = readFixture('financial-decision-foundation.json') as FoundationFixture;
const actionFixture = readFixture('consequential-action.json') as ActionFixture;
const native = createRequire(new URL('../../application/package.json', import.meta.url))(
  '@balanceframe/native',
) as NativeConsequentialBindings;
const ACTION_OPERATION = 'consequential_action' as unknown as Parameters<typeof deriveProposalAuthorizationFacts>[0];
const ownerAuth = (actorId: string, reauthenticatedAt = currentTime()) => ({
  method: 'human-session' as const,
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt,
});
const currentTime = () => new Date().toISOString();

function composeDecisionCardRequest(
  evaluatedAt = liquidityFixture.evaluatedAt,
  validUntil = liquidityFixture.validUntil,
  purchaseAt = '2026-09-06T12:00:00Z',
): DecisionCardRequest {
  const snapshot = structuredClone(foundationFixture.full);
  snapshot.snapshotId = liquidityFixture.snapshotId;
  snapshot.contentHash = liquidityFixture.contentHash;
  snapshot.capturedAt = evaluatedAt;
  snapshot.liquidity = structuredClone(liquidityFixture.facts);
  snapshot.coverage.accounts = 'complete';
  snapshot.coverage.categories = 'complete';
  snapshot.coverage.transactions = 'complete';
  snapshot.coverage.schedules = 'complete';
  snapshot.coverage.budgets = 'complete';
  snapshot.legacySnapshot.accounts = [];
  snapshot.legacySnapshot.transactions = [];
  snapshot.legacySnapshot.categories = [];
  snapshot.legacySnapshot.budgets = [];
  snapshot.legacySnapshot.schedules = [];
  snapshot.observations = [{
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'checking' },
    state: 'fresh',
    observedAt: evaluatedAt,
    evidence: [{
      evidenceId: 'checking-freshness',
      kind: 'bank_sync',
      authorized: true,
      redaction: 'visible',
    }],
  }];
  const facts = snapshot.liquidity;
  if (!facts) throw new Error('Canonical liquidity facts are required');
  const checking = facts.accounts.find((account) => account.accountId === 'checking');
  if (!checking) throw new Error('Canonical checking account is required');
  checking.recordedBalance = MONEY(13_000);
  facts.categories[0]!.availability = MONEY(0);
  const reserve = structuredClone(facts.categories[0]!);
  reserve.categoryId = 'reserve';
  reserve.cashBucketId = 'reserve';
  reserve.availability = MONEY(6_000);
  const reserveTwo = structuredClone(reserve);
  reserveTwo.categoryId = 'reserve-two';
  reserveTwo.cashBucketId = 'reserve-two';
  facts.categories.push(reserve, reserveTwo);

  const context = structuredClone(foundationFixture.claims.context);
  context.evaluatedAt = evaluatedAt;
  context.horizon = structuredClone(liquidityFixture.horizon);
  context.snapshotId = liquidityFixture.snapshotId;
  context.contentHash = liquidityFixture.contentHash;
  context.policyVersion = liquidityFixture.liquidityPolicy.version;
  context.policyHash = liquidityFixture.liquidityPolicy.policyHash;
  context.policy.maxBudgetSnapshotAgeMinutes = liquidityFixture.maxBudgetSnapshotAgeMinutes;
  context.policy.maxBankSyncAgeMinutes = null;
  const item = { ...structuredClone(liquidityFixture.scenario.items[0]!), priority: 'planned' as const };
  item.purchaseAt = purchaseAt;
  item.requiredBy = purchaseAt;
  return decisionCardRequestSchema.parse({
    financialSnapshot: snapshot,
    context,
    liquidityPolicy: structuredClone(liquidityFixture.liquidityPolicy),
    claimSet: structuredClone(liquidityFixture.claimSet),
    priorAllocation: null,
    items: [item],
    categoryPolicies: [
      { categoryId: 'food', kind: 'ordinary', donorEligible: false, minimumRetained: MONEY(0), projectedRemainingNeed: MONEY(0) },
      { categoryId: 'reserve', kind: 'ordinary', donorEligible: true, minimumRetained: MONEY(1_000), projectedRemainingNeed: MONEY(2_000) },
      { categoryId: 'reserve-two', kind: 'ordinary', donorEligible: false, minimumRetained: MONEY(1_000), projectedRemainingNeed: MONEY(2_000) },
    ],
    validUntil,
    requestId: 'request-consequential-action-1',
    correlationId: 'correlation-consequential-action-1',
    decisionId: 'decision-consequential-action-1',
  }) as DecisionCardRequest;
}

function makePlan(options: {
  intent?: ConsequentialActionIntent;
  evaluatedAt?: string;
  validUntil?: string;
  purchaseAt?: string;
  cartAmountMinorUnits?: number;
  multiDonorReallocation?: boolean;
  idempotencyKey?: string;
  afterReallocation?: boolean;
  sourceObservation?: ActionFixture['sourceObservation'];
  financialPolicyVersion?: string;
} = {}) {
  const evaluatedAt = options.evaluatedAt ?? actionFixture.evaluatedAt;
  const intent = structuredClone(options.intent ?? actionFixture.intent);
  const decisionCardRequest = composeDecisionCardRequest(
    evaluatedAt,
    options.validUntil ?? liquidityFixture.validUntil,
    options.purchaseAt,
  );
  if (options.cartAmountMinorUnits !== undefined) {
    const cartItem = decisionCardRequest.items[0];
    if (!cartItem) throw new Error('Canonical cart item is required');
    cartItem.amount = MONEY(options.cartAmountMinorUnits);
  }
  if (intent.kind === 'manual_transaction') {
    const cartItem = decisionCardRequest.items[0];
    if (!cartItem || intent.transaction.categoryId === null ||
        cartItem.categoryId !== intent.transaction.categoryId ||
        cartItem.amount.currency !== intent.transaction.amount.currency ||
        BigInt(cartItem.amount.minorUnits) !== -BigInt(intent.transaction.amount.minorUnits))
      throw new Error('Canonical manual cart amount and category must match the transaction');
  }
  if (intent.kind === 'reallocation' && intent.assignments.some((assignment) => assignment.sourceCategoryId === 'reserve-two')) {
    for (const eligibility of actionFixture.alternateDonorEligibility) {
      const category = decisionCardRequest.categoryPolicies.find(
        (candidate) => candidate.categoryId === eligibility.categoryId,
      );
      if (!category) throw new Error('Canonical alternate donor policy is required');
      category.donorEligible = eligibility.donorEligible;
    }
  }
  if (options.multiDonorReallocation) {
    const reserve = decisionCardRequest.categoryPolicies.find((candidate) => candidate.categoryId === 'reserve');
    const reserveTwo = decisionCardRequest.categoryPolicies.find((candidate) => candidate.categoryId === 'reserve-two');
    if (!reserve || !reserveTwo) throw new Error('Canonical multiple-donor policies are required');
    reserve.donorEligible = true;
    reserve.minimumRetained = MONEY(3_000);
    reserveTwo.donorEligible = true;
  }
  let currentLedger = structuredClone(actionFixture.currentLedger);
  if (options.afterReallocation) {
    currentLedger = structuredClone(actionFixture.postconditions.reallocation.currentLedger);
    const categoryFacts = decisionCardRequest.financialSnapshot.liquidity?.categories;
    if (!categoryFacts) throw new Error('Canonical post-reallocation category facts are required');
    for (const postcondition of actionFixture.postconditions.reallocation.financialSnapshot.categoryAvailability) {
      const category = categoryFacts.find((fact) => fact.categoryId === postcondition.categoryId);
      if (!category) throw new Error('Canonical post-reallocation category is required');
      category.availability = structuredClone(postcondition.amount);
    }
  }
  if (intent.kind === 'evidence_projection') {
    decisionCardRequest.financialSnapshot.observations.push(
      structuredClone(options.sourceObservation ?? actionFixture.sourceObservation),
    );
    const food = currentLedger.assignments.find((assignment) => assignment.categoryId === 'food');
    const foodFact = decisionCardRequest.financialSnapshot.liquidity?.categories.find(
      (category) => category.categoryId === 'food',
    );
    if (!food || !foodFact) throw new Error('Canonical food target is required');
    food.amount = MONEY(2_000);
    foodFact.availability = MONEY(2_000);
    decisionCardRequest.items[0].amount = {
      minorUnits: (-BigInt(intent.transaction.amount.minorUnits)).toString(),
      currency: intent.transaction.amount.currency,
    };
  }
  const request = planConsequentialActionRequestSchema.parse({
    decisionCardRequest,
    intent,
    currentLedger,
    resolvedEvidence: structuredClone(options.resolvedEvidence ?? actionFixture.resolvedEvidence),
    supplementalObservations: [],
    financialPolicyVersion: options.financialPolicyVersion ?? currentFinancialPolicy().policy.version,
    evaluatedAt,
    idempotencyKey: options.idempotencyKey ?? actionFixture.idempotencyKey,
  }) as PlanConsequentialActionRequest;
  const plan = JSON.parse(native.planConsequentialAction(JSON.stringify(request))) as ConsequentialActionPlan;
  return { request, plan };
}

function atomsOf(action: ConsequentialActionIntent): readonly ActionAtom[] {
  return action.kind === 'composite' ? action.actions : [action];
}

function atomResources(atom: ActionAtom): Resource[] {
  const resources = new Map<string, Resource>();
  const add = (resourceKind: Resource['resourceKind'], resourceId: string) => {
    resources.set(`${resourceKind}:${resourceId}`, { resourceKind, resourceId });
  };
  add('budget', BUDGET_ID);
  switch (atom.kind) {
    case 'reallocation':
      for (const assignment of atom.assignments) {
        add('category', assignment.sourceCategoryId);
        add('category', assignment.destinationCategoryId);
      }
      break;
    case 'manual_transaction':
    case 'evidence_projection':
      add('account', atom.transaction.accountId);
      add('transaction', atom.transaction.parentId);
      add('category', atom.transaction.categoryId);
      for (const split of atom.transaction.splits) add('category', split.categoryId);
      break;
    case 'wallet_materialization':
      add('wallet', atom.walletId);
      break;
    case 'transfer':
      add('transfer', atom.transferId);
      add('account', atom.sourceAccountId);
      add('account', atom.destinationAccountId);
      break;
  }
  return [...resources.values()];
}

function manualTransactionIntent(parentId: string, correlationId: string, payeeName = 'Local shop'): ConsequentialActionIntent {
  const canonical = atomsOf(actionFixture.compositeIntent).find((atom) => atom.kind === 'manual_transaction');
  if (!canonical || canonical.kind !== 'manual_transaction')
    throw new Error('Canonical manual transaction intent is required');
  return {
    kind: 'manual_transaction',
    transaction: {
      ...structuredClone(canonical.transaction),
      parentId,
      correlationId,
      payeeName,
    },
  };
}

function proposalFacts(plan: ConsequentialActionPlan, preconditions: unknown = preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash)) {
  const payload = { kind: 'consequential_action' as const, plan };
  return deriveProposalAuthorizationFacts(ACTION_OPERATION, payload, preconditions);
}

let directory: string;
let databasePath: string;
let store: SqliteWorkflowStore;
let allStores: SqliteWorkflowStore[];
let spaceId: string;
let memberships: Record<string, string>;

function scoped(actorId = 'owner') {
  const member = store.governance.getCurrentMembership({ spaceId, actorId, now: currentTime() });
  const policy = store.governance.getPolicy({ spaceId });
  if (!member || !policy) throw new Error('Canonical governance membership and policy are required');
  return {
    actorId,
    budgetId: BUDGET_ID,
    spaceId,
    membershipId: member.id,
    governancePolicyVersion: policy.version,
    now: currentTime(),
    auth: ownerAuth(actorId),
  };
}

function currentFinancialPolicy() {
  const current = store.liquidity.getPolicy(scoped('owner'));
  if (!current) throw new Error('Canonical financial policy is required');
  return current as unknown as {
    policy: { version: string; policyHash: string; expiresAt: string };
    approvalPolicy: { minimumApprovers: number; thresholds?: Array<{ currency: string; minimumMinorUnits: string; minimumApprovers: number }> };
  };
}

function setGovernancePolicy(input: {
  minimumApprovers?: number;
  operationApprovers?: number;
  assistanceMaximum?: AssistanceMaximum | null;
} = {}) {
  const current = store.governance.getPolicy({ spaceId });
  if (!current) throw new Error('Current governance policy is required');
  const priorMaximum = (current as typeof current & { assistanceMaximum?: AssistanceMaximum }).assistanceMaximum;
  const policy = {
    minimumApprovers: input.minimumApprovers ?? current.minimumApprovers,
    approvalThresholds: current.approvalThresholds,
    operationApprovers: {
      ...(current.operationApprovers ?? {}),
      consequential_action: input.operationApprovers ?? current.operationApprovers?.consequential_action ?? 2,
    },
    ...(input.assistanceMaximum === null
      ? {}
      : { assistanceMaximum: input.assistanceMaximum ?? priorMaximum }),
  } as unknown as GovernancePolicyInput;
  return store.governance.setPolicy({
    spaceId,
    expectedVersion: current.version,
    policy,
    now: currentTime(),
    auth: ownerAuth('owner'),
  });
}

function setAssistanceMaximum(maximum: AssistanceMaximum) {
  return setGovernancePolicy({ assistanceMaximum: maximum });
}

function saveFinancialPolicy(
  version: string,
  policyHash: string,
  approvalPolicy = {
    minimumApprovers: 2,
    thresholds: [{ currency: 'USD', minimumMinorUnits: '2000', minimumApprovers: 3 }],
  },
) {
  const currentGovernance = store.governance.getPolicy({ spaceId });
  const previous = currentFinancialPolicy();
  if (!currentGovernance) throw new Error('Current governance policy is required');
  return store.liquidity.savePolicy({
    ...scoped('owner'),
    expectedVersion: previous.policy.version,
    expectedGovernancePolicyVersion: currentGovernance.version,
    policy: {
      version,
      policyHash,
      expiresAt: '2026-09-07T09:00:00.000Z',
      accounts: [],
      transferRoutes: [],
    } as never,
    approvalPolicy,
  });
}

function grant(actorId: string, capability: string, resource: Resource, restrictions?: unknown): void {
  const membershipId = memberships[actorId];
  if (!membershipId) throw new Error(`Missing test membership for ${actorId}`);
  store.governance.setResourceGrant({
    spaceId,
    actorId,
    budgetId: BUDGET_ID,
    membershipId,
    capability,
    ...resource,
    granted: true,
    ...(restrictions === undefined ? {} : { restrictions }),
    now: currentTime(),
    auth: ownerAuth('owner'),
  });
}

function grantVisibility(plan: ConsequentialActionPlan, actorIds: readonly string[], includeEvidence = true): void {
  const facts = proposalFacts(plan);
  const payload = { kind: 'consequential_action' as const, plan };
  const sourceReads = deriveProposalSourceReadFacts(
    ACTION_OPERATION,
    payload,
    preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash),
    BUDGET_ID,
  );
  const required = sourceReads.required.filter((entry) =>
    includeEvidence || entry.resourceKind !== 'evidence',
  );
  for (const actorId of actorIds) {
    for (const entry of required) grant(actorId, entry.capability, entry);
    for (const resource of facts.resources) {
      if (resource.resourceKind !== 'evidence') continue;
      if (includeEvidence) {
        grant(actorId, 'evidence', resource);
        grant(actorId, 'normalized-evidence', resource);
      }
    }
  }
}

function grantPhase(plan: ConsequentialActionPlan, actorId: string, phase: CapabilityPhase): void {
  for (const atom of atomsOf(plan.action)) {
    const capability = CONSEQUENTIAL_ACTION_CAPABILITY_MAP[atom.kind][phase];
    for (const resource of atomResources(atom)) grant(actorId, capability, resource);
  }
}

function grantActionActors(plan: ConsequentialActionPlan, proposer = 'proposer') {
  grantVisibility(plan, [proposer, 'approver-a', 'approver-b', 'approver-c', 'approver-d', 'executor']);
  grantPhase(plan, proposer, 'propose');
  for (const approver of ['approver-a', 'approver-b', 'approver-c', 'approver-d'])
    grantPhase(plan, approver, 'approve');
  grantPhase(plan, 'executor', 'execute');
}

function preconditionsFor(plan: ConsequentialActionPlan, decisionCardPolicyHash: string) {
  const financialPolicy = currentFinancialPolicy();
  return {
    nativeActionHash: plan.actionHash,
    nativeSource: plan.source,
    decisionCardPolicyHash,
    financialApprovalPolicy: {
      version: financialPolicy.policy.version,
      policyHash: financialPolicy.policy.policyHash,
    },
  };
}

function proposalInput(plan: ConsequentialActionPlan, actorId = 'proposer') {
  const preconditions = preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash);
  return {
    spaceId,
    operation: 'consequential_action',
    budgetId: BUDGET_ID,
    payload: { kind: 'consequential_action', plan },
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    expiresAt: plan.expiresAt,
    actorId,
    auth: ownerAuth(actorId),
    provenance: 'manual',
    correlationId: `phase9:${plan.idempotencyKey}`,
  };
}

async function createActionProposal(plan: ConsequentialActionPlan, actorId = 'proposer') {
  return await store.createProposal(proposalInput(plan, actorId) as unknown as CreateProposalInput) as unknown as StoredConsequentialProposal;
}

async function approve(proposal: StoredConsequentialProposal, actorId: string, expiresAt = proposal.expiresAt) {
  return store.createApproval({
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    actorId,
    expiresAt,
    auth: ownerAuth(actorId),
    now: currentTime(),
  });
}

function executionInput(proposal: StoredConsequentialProposal, idempotencyKey = proposal.payload.plan.idempotencyKey) {
  return {
    actorId: 'executor',
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    governancePolicyVersion: proposal.governancePolicyVersion,
    idempotencyKey,
    serialisedEffect: JSON.stringify({
      operation: proposal.operation,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions),
    }),
    auth: ownerAuth('executor'),
    now: currentTime(),
    requestId: `request:${idempotencyKey}`,
    correlationId: `phase9:${idempotencyKey}`,
  };
}

async function acquire(plan: ConsequentialActionPlan, proposer = 'proposer'): Promise<AcquiredAction> {
  const proposal = await createActionProposal(plan, proposer);
  for (const approver of ['approver-a', 'approver-b', 'approver-c']) await approve(proposal, approver);
  const input = executionInput(proposal);
  const result = await store.acquireProposalExecution(input as never);
  if (!result.auditRecord?.id) throw new Error('Acquired action must persist its execution audit token');
  if (result.claim.record.leaseExpiresAt !== proposal.expiresAt)
    throw new Error('Consequential-action lease must be bound to the immutable proposal expiry');
  if (proposalState(proposal.id).phase !== 'write_intent')
    throw new Error('Acquisition must durably persist the write-intent owner');
  return { proposal, input, acquisitionAuditId: result.auditRecord.id };
}
async function createGenericCategoryProposal(transactionId: string): Promise<StoredGenericProposal> {
  const payload = { kind: 'set_category' as const, transactionId, categoryId: 'food' };
  const preconditions = {
    transactionId,
    accountId: 'checking',
    amount: MONEY(1_000),
    direction: 'outgoing' as const,
    currentCategoryId: null,
    actualVersion: 'actual-v1',
  };
  const facts = deriveProposalAuthorizationFacts('set_category', payload, preconditions);
  const resources = [
    { resourceKind: 'budget' as const, resourceId: BUDGET_ID },
    ...facts.resources,
  ];
  for (const resource of resources) {
    grant('proposer', 'categorization:propose', resource);
    for (const actorId of ['approver-a', 'approver-b', 'approver-c'])
      grant(actorId, 'categorization:approve', resource);
    grant('executor', 'categorization:execute', resource);
  }
  const proposal = await store.createProposal({
    spaceId,
    operation: 'set_category',
    budgetId: BUDGET_ID,
    payload,
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    expiresAt: liquidityFixture.validUntil,
    actorId: 'proposer',
    auth: ownerAuth('proposer'),
    provenance: 'manual',
    correlationId: `categorization:${transactionId}`,
  } as unknown as CreateProposalInput) as unknown as StoredGenericProposal;
  for (const actorId of ['approver-a', 'approver-b', 'approver-c']) {
    await store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId,
      expiresAt: proposal.expiresAt,
      auth: ownerAuth(actorId),
      now: currentTime(),
    });
  }
  return proposal;
}

function genericExecutionInput(proposal: StoredGenericProposal, idempotencyKey: string) {
  return {
    actorId: 'executor',
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    governancePolicyVersion: proposal.governancePolicyVersion,
    idempotencyKey,
    serialisedEffect: JSON.stringify({
      operation: proposal.operation,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions),
    }),
    auth: ownerAuth('executor'),
    now: currentTime(),
    requestId: `request:${idempotencyKey}`,
    correlationId: `categorization:${idempotencyKey}`,
  };
}

async function budgetWriterScenario(prefix: string) {
  const { plan } = makePlan({ idempotencyKey: `${prefix}-action` });
  grantActionActors(plan);
  const actionProposal = await createActionProposal(plan);
  for (const actorId of ['approver-a', 'approver-b', 'approver-c'])
    await approve(actionProposal, actorId);

  const genericProposal = await createGenericCategoryProposal(`${prefix}-transaction`);
  const genericInput = genericExecutionInput(genericProposal, `${prefix}-generic`);
  const acquired = await store.acquireProposalExecution(genericInput as never);
  if (!acquired.auditRecord?.id) throw new Error('Generic writer must persist its acquisition audit');
  return {
    actionInput: executionInput(actionProposal),
    genericProposal,
    genericInput,
    acquisitionAuditId: acquired.auditRecord.id,
  };
}

async function recordGenericPreDispatchFailure(
  proposal: StoredGenericProposal,
  input: { idempotencyKey: string },
  acquisitionAuditId: string,
): Promise<void> {
  await store.completeIdempotencyRecord(input.idempotencyKey, 'Adapter rejected before dispatch', false);
  await store.appendAuditRecord({
    classification: 'execution_failed',
    actorId: 'executor',
    operation: proposal.operation,
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    budgetId: BUDGET_ID,
    idempotencyKey: input.idempotencyKey,
    observedResultState: canonicalProposalJson({
      kind: 'categorization_dispatch',
      acquisitionAuditId,
      dispatchStarted: false,
    }),
    result: 'pre_dispatch_failure',
    isError: true,
  });
}
function reopenStore(): void {
  const closed = store;
  closed.close();
  allStores = allStores.filter((candidate) => candidate !== closed);
  store = new SqliteWorkflowStore(databasePath);
  allStores.push(store);
}


function databaseRow<T>(sql: string, ...values: unknown[]): T {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare(sql).get(...values) as T;
  } finally {
    database.close();
  }
}

function proposalState(proposalId: string): Record<string, unknown> {
  const row = databaseRow<{ state: string }>('SELECT state FROM action_proposals WHERE id = ?', proposalId);
  return JSON.parse(row.state) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(INITIAL_TIME));
  directory = mkdtempSync(join(tmpdir(), 'workflow-consequential-action-'));
  databasePath = join(directory, 'workflow.sqlite');
  store = new SqliteWorkflowStore(databasePath);
  allStores = [store];
  const claimId = 'phase9-consequential-action-bootstrap';
  await store.claimBootstrap({ name: 'Owner', email: 'phase9-owner@example.com', claimId });
  await store.finalizeBootstrap({ claimId, ownerUserId: 'owner' });
  const actorIds = ['owner', 'proposer', 'proposer-2', 'approver-a', 'approver-b', 'approver-c', 'approver-d', 'executor', 'reader'];
  for (const actorId of actorIds) await store.upsertActorMembership(actorId, 'active', [], 'unscoped');
  const unboundSpace = store.governance.createSpace({
    actorId: 'owner',
    name: 'Phase 9 action budget',
    kind: 'shared',
    now: INITIAL_TIME,
    auth: ownerAuth('owner', INITIAL_TIME),
  });
  const boundSpace = store.governance.bindBudget({
    spaceId: unboundSpace.id,
    budgetId: BUDGET_ID,
    now: INITIAL_TIME,
    auth: ownerAuth('owner', INITIAL_TIME),
  });
  spaceId = boundSpace.id;
  memberships = {
    owner: store.governance.getCurrentMembership({ spaceId, actorId: 'owner', now: INITIAL_TIME })!.id,
  };
  for (const actorId of actorIds.slice(1)) {
    memberships[actorId] = store.governance.addMembership({
      spaceId,
      actorId,
      validFrom: INITIAL_TIME,
      now: INITIAL_TIME,
      auth: ownerAuth('owner', INITIAL_TIME),
    }).id;
  }
  grant('owner', 'policy', { resourceKind: 'budget', resourceId: BUDGET_ID });
  const current = store.governance.getPolicy({ spaceId });
  if (!current) throw new Error('New governance space has no policy');
  store.liquidity.savePolicy({
    ...scoped('owner'),
    expectedVersion: null,
    expectedGovernancePolicyVersion: current.version,
    policy: {
      version: actionFixture.financialPolicyVersion,
      policyHash: 'financial-policy-hash-1',
      expiresAt: '2026-09-07T09:00:00.000Z',
      accounts: [],
      transferRoutes: [],
    } as never,
    approvalPolicy: {
      minimumApprovers: 2,
      thresholds: [{ currency: 'USD', minimumMinorUnits: '2000', minimumApprovers: 3 }],
    },
  });
  setGovernancePolicy({ minimumApprovers: 1, operationApprovers: 2, assistanceMaximum: null });
});

afterEach(() => {
  for (const current of allStores) current.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('consequential_action workflow-store lifecycle', () => {
  it('counts nested Money without treating currency-only account metadata as an amount', () => {
    const { plan } = makePlan();
    const payload = { kind: 'consequential_action' as const, plan };
    const preconditions = preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash);
    const baseline = deriveProposalDisclosureTotals(ACTION_OPERATION, payload, preconditions, 'detail');
    const disclosure = deriveProposalDisclosureTotals(ACTION_OPERATION, payload, {
      ...preconditions,
      supplemental: { accounts: [liquidityFixture.facts.accounts[0]] },
    }, 'detail');
    expect(disclosure).toEqual({
      operationCount: baseline.operationCount + 2,
      grossOutgoing: baseline.grossOutgoing,
    });
  });

  it.each([
    { minorUnits: '1' },
    { minorUnits: 'invalid', currency: 'USD' },
    { minorUnits: '9223372036854775808', currency: 'USD' },
    { ...MONEY('1'), accountId: 'unexpected-money-field' },
  ])('fails closed on malformed financial amount %j', (amount) => {
    expect(() => deriveProposalDisclosureTotals(
      ACTION_OPERATION, null, { amount }, 'preconditions',
    )).toThrow();
  });

  it('plans the canonical atomic and composite actions natively and hashes the full immutable envelope', () => {
    const atomic = makePlan();
    const composite = makePlan({ intent: actionFixture.compositeIntent, idempotencyKey: 'composite-hash-test' });
    expect(atomic.plan.actionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(composite.plan.action.kind).toBe('composite');
    expect(composite.plan.actionHash).not.toBe(atomic.plan.actionHash);

    const preconditions = preconditionsFor(composite.plan, atomic.request.decisionCardRequest.liquidityPolicy.policyHash);
    const facts = proposalFacts(composite.plan, preconditions);
    expect(new Set(facts.operations.map(({ operation }) => operation)).size).toBe(2);
    expect(facts.operations).toHaveLength(2);
    expect(facts.resources).toEqual(expect.arrayContaining([
      { resourceKind: 'category', resourceId: 'reserve' },
      { resourceKind: 'category', resourceId: 'food' },
      { resourceKind: 'account', resourceId: 'checking' },
      { resourceKind: 'transaction', resourceId: 'manual-parent-composite-1' },
      { resourceKind: 'evidence', resourceId: 'checking-freshness' },
    ]));

    const base = {
      operation: 'consequential_action',
      budgetId: BUDGET_ID,
      payload: { kind: 'consequential_action', plan: composite.plan },
      preconditions,
      actorId: 'proposer',
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt: composite.plan.expiresAt,
    };
    const baseHash = canonicalProposalHash(base as never);
    const changedAction = structuredClone(base);
    const action = changedAction.payload.plan.action;
    if (action.kind !== 'composite') throw new Error('Native composite action is required');
    const manualAtom = action.actions[1];
    if (!manualAtom || manualAtom.kind !== 'manual_transaction')
      throw new Error('Native manual transaction atom is required');
    manualAtom.transaction.notes = 'changed intent';
    const changedEvidence = structuredClone(base);
    changedEvidence.payload.plan.evidenceReferences[0]!.contentHash = 'changed evidence';
    const changedPostcondition = structuredClone(base);
    const assignment = changedPostcondition.payload.plan.expectedPostconditions.find(
      (condition) => condition.kind === 'assignment' && condition.categoryId === 'reserve',
    );
    if (!assignment || assignment.kind !== 'assignment') throw new Error('Native assignment postcondition is required');
    assignment.amount.minorUnits = '999';
    const changedPolicyHash = {
      ...base,
      preconditions: { ...preconditions, decisionCardPolicyHash: 'changed-policy-hash' },
    };
    for (const variant of [changedAction, changedEvidence, changedPostcondition, changedPolicyHash])
      expect(canonicalProposalHash(variant as never)).not.toBe(baseHash);
  });

  it('defaults absent assistance maximum to analysis_only for the new operation only', async () => {
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Current governance policy is required');
    expect((policy as typeof policy & { assistanceMaximum?: AssistanceMaximum }).assistanceMaximum ?? 'analysis_only')
      .toBe('analysis_only');
    const { plan } = makePlan();
    expect(plan.action.kind).toBe('reallocation');
    grantVisibility(plan, ['proposer']);
    grantPhase(plan, 'proposer', 'propose');
    await expect(createActionProposal(plan)).rejects.toThrow();
    expect(await store.listProposals()).toHaveLength(0);
  });

  it.each([
    ['analysis_only', false],
    ['recommend_actions', false],
    ['create_approval_proposal', true],
  ] as const)('enforces the %s ceiling at proposal creation', async (maximum, canPropose) => {
    setAssistanceMaximum(maximum);
    const { plan } = makePlan({ idempotencyKey: `assistance-${maximum}` });
    grantVisibility(plan, ['proposer']);
    grantPhase(plan, 'proposer', 'propose');
    if (canPropose) {
      const proposal = await createActionProposal(plan);
      expect(proposal.operation).toBe('consequential_action');
    } else {
      await expect(createActionProposal(plan)).rejects.toThrow();
      expect(await store.listProposals()).toHaveLength(0);
    }
  });

  it('requires reallocation-specific rights at proposal, approval, and execution', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'reallocation-specific-capability' });
    const refs = atomResources(atomsOf(plan.action)[0]!);
    grantVisibility(plan, ['proposer', 'approver-a', 'approver-b', 'approver-c', 'executor']);
    for (const resource of refs) grant('proposer', 'categorization:propose', resource);
    await expect(createActionProposal(plan)).rejects.toThrow();

    for (const resource of refs) grant('proposer', 'reallocation:propose', resource);
    const proposal = await createActionProposal(plan);
    for (const resource of refs) grant('approver-a', 'categorization:approve', resource);
    await expect(approve(proposal, 'approver-a')).rejects.toThrow();
    for (const approver of ['approver-a', 'approver-b', 'approver-c'])
      for (const resource of refs) grant(approver, 'reallocation:approve', resource);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');
    for (const resource of refs) grant('executor', 'categorization:execute', resource);
    await expect(store.acquireProposalExecution(executionInput(proposal) as never)).rejects.toThrow();
    for (const resource of refs) grant('executor', 'reallocation:execute', resource);
    expect((await store.acquireProposalExecution(executionInput(proposal) as never)).claim.isOwner).toBe(true);
  });

  it('does not execute an approved proposal above a create_approval_proposal ceiling', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const { plan } = makePlan({ idempotencyKey: 'creation-only-assistance' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');
    const read = await store.getProposalApprovalSummary({
      proposalId: proposal.id,
      spaceId,
      actorId: 'approver-a',
      auth: ownerAuth('approver-a'),
      now: currentTime(),
    });
    expect(read.approvers).toHaveLength(3);
    expect(read.canExecute).toBe(false);
    await expect(store.acquireProposalExecution(executionInput(proposal) as never)).rejects.toThrow();
  });
  it('retains independently authorized detail reads after lowering assistance to analysis_only', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const { plan } = makePlan({ idempotencyKey: 'read-after-assistance-downgrade' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    const payload = { kind: 'consequential_action' as const, plan };
    const preconditions = preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash);
    const sourceReads = deriveProposalSourceReadFacts(ACTION_OPERATION, payload, preconditions, BUDGET_ID);
    if (!sourceReads) throw new Error('Canonical consequential-action source reads are required');
    const disclosure = deriveProposalDisclosureTotals(ACTION_OPERATION, payload, preconditions, 'detail');
    const readRestrictions = {
      maxOperationCount: disclosure.operationCount,
      maxGrossOutgoing: Object.entries(disclosure.grossOutgoing)
        .map(([currency, minorUnits]) => ({ currency, minorUnits: minorUnits.toString() })),
    };
    grantVisibility(plan, ['reader']);
    const privateResources = new Map<string, Resource>();
    for (const resource of [
      ...proposalFacts(plan, preconditions).resources,
      ...sourceReads.resources,
      { resourceKind: 'budget' as const, resourceId: BUDGET_ID },
    ])
      privateResources.set(`${resource.resourceKind}:${resource.resourceId}`, resource);
    for (const resource of privateResources.values())
      grant('reader', 'full-read', resource, readRestrictions);
    setAssistanceMaximum('analysis_only');

    const [read] = store.getProposalApprovalReads({
      proposalIds: [proposal.id],
      spaceId,
      actorId: 'reader',
      auth: ownerAuth('reader'),
      now: currentTime(),
      privateProjection: 'detail',
    });
    expect(read?.preconditions).toMatchObject({ nativeActionHash: plan.actionHash });
    expect(read?.summary.privateEnvelopeVisible).toBe(true);
    expect(read?.summary.approvalAuthorized).toBe(false);
    expect(read?.summary.executionAuthorized).toBe(false);
    expect(read?.summary.canExecute).toBe(false);
    if (disclosure.operationCount <= 1)
      throw new Error('Canonical detail disclosure must include source and action amounts');
    for (const resource of privateResources.values())
      grant('reader', 'full-read', resource, {
        ...readRestrictions,
        maxOperationCount: disclosure.operationCount - 1,
      });
    const [boundedRead] = store.getProposalApprovalReads({
      proposalIds: [proposal.id],
      spaceId,
      actorId: 'reader',
      auth: ownerAuth('reader'),
      now: currentTime(),
      privateProjection: 'detail',
    });
    expect(boundedRead?.summary.privateEnvelopeVisible).toBe(false);
    expect(boundedRead?.preconditions).toBeNull();
  });


  it('requires each composite atom capability only on that atom closure and no generic fallback', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const { plan } = makePlan({ intent: actionFixture.compositeIntent, idempotencyKey: 'atom-capabilities' });
    const [reallocationAtom, manualAtom] = atomsOf(plan.action);
    if (reallocationAtom?.kind !== 'reallocation' || manualAtom?.kind !== 'manual_transaction')
      throw new Error('Canonical composite action must contain reallocation then manual transaction');
    grantVisibility(plan, ['proposer']);
    for (const resource of atomResources(reallocationAtom)) grant('proposer', 'reallocation:propose', resource);
    for (const resource of atomResources(manualAtom)) grant('proposer', 'manual_transaction:propose', resource);
    await expect(createActionProposal(plan)).rejects.toThrow();

    for (const resource of atomResources(manualAtom)) grant('proposer', 'transaction:propose', resource);
    const proposal = await createActionProposal(plan);
    expect(proposal.payload.plan.action.kind).toBe('composite');
  });
  it('uses transfer execute only for its ledger atom, without settlement confirmation rights', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const intent: ConsequentialActionIntent = {
      kind: 'transfer',
      transferId: 'ledger-transfer-no-settlement',
      correlationId: 'ledger-transfer-correlation',
      sourceAccountId: 'checking',
      destinationAccountId: 'savings',
      amount: MONEY(1_000),
      date: '2026-09-06',
    };
    const { plan } = makePlan({ intent, idempotencyKey: 'ledger-transfer-only' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');
    expect((await store.acquireProposalExecution(executionInput(proposal) as never)).claim.isOwner).toBe(true);
  });



  it('requires independently scoped evidence visibility for private plan reads', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const { plan } = makePlan({
      intent: actionFixture.evidenceProjectionIntent,
      idempotencyKey: 'source-visibility',
    });
    const payload = { kind: 'consequential_action' as const, plan };
    const preconditions = preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash);
    const sourceFacts = deriveProposalSourceReadFacts(ACTION_OPERATION, payload, preconditions, BUDGET_ID);
    grantPhase(plan, 'proposer', 'propose');
    for (const required of sourceFacts.required) {
      if (required.resourceKind === 'evidence') continue;
      grant('proposer', required.capability, required);
    }
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Current governance policy is required');
    const denied = store.governance.authorize({
      actorId: 'proposer',
      spaceId,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'consequential_action',
      required: sourceFacts.required,
      payload: { operations: sourceFacts.operations },
      now: currentTime(),
      auth: ownerAuth('proposer'),
    });
    expect(denied.allowed).toBe(false);
    for (const required of sourceFacts.required)
      if (required.resourceKind === 'evidence') grant('proposer', required.capability, required);
    const allowed = store.governance.authorize({
      actorId: 'proposer',
      spaceId,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation: 'consequential_action',
      required: sourceFacts.required,
      payload: { operations: sourceFacts.operations },
      now: currentTime(),
      auth: ownerAuth('proposer'),
    });
    expect(allowed.allowed).toBe(true);
  });

  it('uses the higher current financial quorum at the exact threshold without summing it with governance quorum', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'financial-floor-three' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    expect(proposalState(proposal.id).phase).toBe('proposed');
    await approve(proposal, 'approver-a');
    expect(proposalState(proposal.id).phase).toBe('proposed');
    await approve(proposal, 'approver-b');
    expect(proposalState(proposal.id).phase).toBe('proposed');
    await expect(store.acquireProposalExecution(executionInput(proposal) as never)).rejects.toThrow();
    await approve(proposal, 'approver-c');
    expect(proposalState(proposal.id).phase).toBe('approved');
    expect((await store.acquireProposalExecution(executionInput(proposal) as never)).claim.isOwner).toBe(true);
    expect(proposalState(proposal.id).phase).toBe('write_intent');
  });
  it('demotes an approved action when a vote loses current approval authority', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'approval-authority-demotion' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    for (const actorId of ['approver-a', 'approver-b', 'approver-c']) await approve(proposal, actorId);
    expect(proposalState(proposal.id).phase).toBe('approved');

    for (const resource of atomResources(atomsOf(plan.action)[0]!))
      store.governance.setResourceGrant({
        spaceId,
        actorId: 'approver-c',
        budgetId: BUDGET_ID,
        membershipId: memberships['approver-c']!,
        capability: CONSEQUENTIAL_ACTION_CAPABILITY_MAP.reallocation.approve,
        ...resource,
        granted: false,
        now: currentTime(),
        auth: ownerAuth('owner'),
      });
    const [read] = store.getProposalApprovalReads({
      proposalIds: [proposal.id],
      spaceId,
      actorId: 'approver-a',
      auth: ownerAuth('approver-a'),
      now: currentTime(),
      privateProjection: 'envelope',
    });
    expect(read?.summary.approvers).toHaveLength(2);
    expect(read?.proposal.state).toMatchObject({ phase: 'proposed' });
    expect(proposalState(proposal.id).phase).toBe('proposed');
    await expect(store.acquireProposalExecution(executionInput(proposal) as never)).rejects.toThrow();
  });
  it('requires only the financial minimum below its multi-digit amount threshold', async () => {
    saveFinancialPolicy('financial-policy-boundary', 'financial-policy-boundary-hash', {
      minimumApprovers: 2,
      thresholds: [{ currency: 'USD', minimumMinorUnits: '2001', minimumApprovers: 3 }],
    });
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({
      idempotencyKey: 'financial-floor-below-threshold',
      financialPolicyVersion: 'financial-policy-boundary',
    });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    expect((await store.acquireProposalExecution(executionInput(proposal) as never)).claim.isOwner).toBe(true);
  });

  it('uses the higher current governance quorum than the financial quorum', async () => {
    setAssistanceMaximum('execute_approved_actions');
    setGovernancePolicy({ minimumApprovers: 4, operationApprovers: 4, assistanceMaximum: 'execute_approved_actions' });
    const { plan } = makePlan({ idempotencyKey: 'governance-floor-four' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');
    await expect(store.acquireProposalExecution(executionInput(proposal) as never)).rejects.toThrow();
    await approve(proposal, 'approver-d');
    expect((await store.acquireProposalExecution(executionInput(proposal) as never)).claim.isOwner).toBe(true);
  });

  it('preserves assistance maximum when liquidity policy changes and reads legacy empty financial quorum from governance', async () => {
    setAssistanceMaximum('analysis_only');
    saveFinancialPolicy('financial-policy-2', 'financial-policy-hash-2', { minimumApprovers: 3 });
    const afterSave = store.governance.getPolicy({ spaceId });
    expect((afterSave as typeof afterSave & { assistanceMaximum?: AssistanceMaximum })?.assistanceMaximum)
      .toBe('analysis_only');
    expect(currentFinancialPolicy().approvalPolicy.minimumApprovers).toBe(3);

    setGovernancePolicy({ minimumApprovers: 2, operationApprovers: 2, assistanceMaximum: 'analysis_only' });
    const db = new Database(databasePath);
    try {
      db.prepare('UPDATE liquidity_policy_versions SET approval_policy = ? WHERE budget_id = ? AND version = ?')
        .run('{}', BUDGET_ID, 'financial-policy-2');
    } finally {
      db.close();
    }
    expect(currentFinancialPolicy().approvalPolicy.minimumApprovers).toBe(2);
  });

  it('rejects an invalid assistance maximum instead of treating it as permissive', () => {
    const current = store.governance.getPolicy({ spaceId });
    if (!current) throw new Error('Current governance policy is required');
    const invalid = {
      minimumApprovers: current.minimumApprovers,
      approvalThresholds: current.approvalThresholds,
      operationApprovers: current.operationApprovers,
      assistanceMaximum: 'write_anything',
    } as unknown as GovernancePolicyInput;
    expect(() => store.governance.setPolicy({
      spaceId,
      expectedVersion: current.version,
      policy: invalid,
      now: currentTime(),
      auth: ownerAuth('owner'),
    })).toThrow();
  });

  it('rejects expired plans and payload/effect/key replay mismatches', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const expired = makePlan({ idempotencyKey: 'already-expired' });
    grantActionActors(expired.plan);
    vi.setSystemTime(new Date(Date.parse(expired.plan.expiresAt) + 1_000));
    await expect(createActionProposal(expired.plan)).rejects.toThrow();

    vi.setSystemTime(new Date(INITIAL_TIME));
    const { plan } = makePlan({ idempotencyKey: 'replay-fences' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');
    const input = executionInput(proposal);
    const mismatched = {
      ...input,
      serialisedEffect: JSON.stringify({
        ...JSON.parse(input.serialisedEffect as string),
        payload: { ...proposal.payload, plan: { ...plan, actionHash: 'f'.repeat(64) } },
      }),
    };
    await expect(store.acquireProposalExecution(mismatched as never)).rejects.toThrow();
    const acquired = await store.acquireProposalExecution(input as never);
    expect(acquired.claim.isOwner).toBe(true);
    const replay = await store.acquireProposalExecution(input as never);
    expect(replay.claim.isOwner).toBe(false);
    await expect(store.acquireProposalExecution({ ...input, idempotencyKey: 'different-execution-key' } as never))
      .rejects.toThrow();
    expect(() => store.validateAcquiredProposalExecution({
      ...input,
      acquisitionAuditId: acquired.auditRecord!.id,
      payloadHash: 'different-payload-hash',
    } as never)).toThrow();
  });

  it('rejects expired approvals while the action plan remains live', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'approval-expiry-fence' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    const approvalExpiry = new Date(Date.parse(currentTime()) + 60_000).toISOString();
    await approve(proposal, 'approver-a', approvalExpiry);
    await approve(proposal, 'approver-b', approvalExpiry);
    await approve(proposal, 'approver-c', approvalExpiry);
    vi.setSystemTime(new Date(Date.parse(approvalExpiry) + 1_000));
    expect(currentTime() < plan.expiresAt).toBe(true);
    await expect(store.acquireProposalExecution(executionInput(proposal) as never)).rejects.toThrow();
  });

  it('rejects current financial-policy hash drift at the final execution fence', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'financial-policy-hash-fence' });
    grantActionActors(plan);
    const proposal = await createActionProposal(plan);
    await approve(proposal, 'approver-a');
    await approve(proposal, 'approver-b');
    await approve(proposal, 'approver-c');
    const input = executionInput(proposal);
    const acquired = await store.acquireProposalExecution(input as never);
    const db = new Database(databasePath);
    try {
      const row = db.prepare('SELECT policy FROM liquidity_policy_versions WHERE budget_id = ? AND version = ?')
        .get(BUDGET_ID, actionFixture.financialPolicyVersion) as { policy: string };
      const policy = JSON.parse(row.policy) as Record<string, unknown>;
      policy.policyHash = 'changed-policy-hash-without-version-change';
      db.prepare('UPDATE liquidity_policy_versions SET policy = ? WHERE budget_id = ? AND version = ?')
        .run(JSON.stringify(policy), BUDGET_ID, actionFixture.financialPolicyVersion);
    } finally {
      db.close();
    }
    expect(() => store.validateAcquiredProposalExecution({
      ...input,
      acquisitionAuditId: acquired.auditRecord!.id,
    } as never)).toThrow();
  });

  it('holds a stable manual parent identity even when a new proposal changes its correlation and payee', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const first = makePlan({
      intent: manualTransactionIntent('manual-parent-stable', 'manual-correlation-first'),
      afterReallocation: true,
      idempotencyKey: 'manual-parent-first',
    });
    const second = makePlan({
      intent: manualTransactionIntent('manual-parent-stable', 'manual-correlation-second', 'Renamed shop'),
      afterReallocation: true,
      idempotencyKey: 'manual-parent-second',
    });
    grantActionActors(first.plan);
    grantActionActors(second.plan);
    await createActionProposal(first.plan);
    await expect(createActionProposal(second.plan)).rejects.toThrow();
  });

  it('holds an evidence economic effect across a new parent and additional evidence references', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const evidenceIntent = actionFixture.evidenceProjectionIntent;
    if (evidenceIntent.kind !== 'evidence_projection')
      throw new Error('Canonical resolved evidence projection intent is required');
    const makeEvidenceProjection = (parentId: string, correlationId: string): ConsequentialActionIntent => ({
      ...structuredClone(evidenceIntent),
      transaction: {
        ...structuredClone(evidenceIntent.transaction),
        parentId,
        correlationId,
      },
    });
    const first = makePlan({
      intent: makeEvidenceProjection('manual-parent-evidence-1', 'evidence-correlation-first'),
      idempotencyKey: 'evidence-effect-first',
    });
    const secondEvidenceIds = ['fd-transaction-followup-2', 'fd-transaction-followup-3'];
    const secondEvidence = structuredClone(actionFixture.resolvedEvidence);
    const sameSubject = secondEvidence.find((reference) => reference.evidenceId === evidenceIntent.evidenceIds[0]);
    if (!sameSubject) throw new Error('Canonical evidence subject reference is required');
    for (const evidenceId of secondEvidenceIds) {
      secondEvidence.push({
        ...sameSubject,
        evidenceId,
        contentHash: 'fd-transaction-revised-content-2',
        version: 'fd-resolution/2',
      });
    }
    const changedSourceObservation = structuredClone(actionFixture.sourceObservation);
    if (!changedSourceObservation.ledgerEffect)
      throw new Error('Canonical economic event effect is required');
    changedSourceObservation.contentHash = 'fd-transaction-revised-content-2';
    changedSourceObservation.version = 'fd-resolution/2';
    changedSourceObservation.ledgerEffect = {
      ...changedSourceObservation.ledgerEffect,
      amount: MONEY(-400),
    };
    changedSourceObservation.evidence = secondEvidenceIds.map((evidenceId) => ({
      evidenceId,
      kind: 'economic_event_resolution' as const,
      authorized: true,
      redaction: 'visible',
    }));
    const secondIntent = makeEvidenceProjection('manual-parent-evidence-2', 'evidence-correlation-second');
    if (secondIntent.kind !== 'evidence_projection')
      throw new Error('Canonical evidence projection intent is required');
    secondIntent.evidenceIds = secondEvidenceIds;
    secondIntent.transaction.amount = MONEY(-400);
    const second = makePlan({
      intent: secondIntent,
      resolvedEvidence: secondEvidence,
      idempotencyKey: 'evidence-effect-second',
      sourceObservation: changedSourceObservation,
    });
    grantActionActors(first.plan);
    grantActionActors(second.plan);
    await createActionProposal(first.plan);
    await expect(createActionProposal(second.plan)).rejects.toThrow();
  });

  it('holds stable walletId and transferId identities independently of new proposal keys', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const wallet = (accountName: string): ConsequentialActionIntent => ({
      kind: 'wallet_materialization',
      walletId: 'wallet-stable-phase9',
      accountName,
      currency: 'USD',
    });
    const firstWallet = makePlan({ intent: wallet('Emergency savings'), idempotencyKey: 'wallet-first' });
    const secondWallet = makePlan({ intent: wallet('Emergency savings renamed'), idempotencyKey: 'wallet-second' });
    grantActionActors(firstWallet.plan);
    grantActionActors(secondWallet.plan);
    await createActionProposal(firstWallet.plan);
    await expect(createActionProposal(secondWallet.plan)).rejects.toThrow();

    const transfer = (correlationId: string): ConsequentialActionIntent => ({
      kind: 'transfer',
      transferId: 'ledger-transfer-stable-phase9',
      correlationId,
      sourceAccountId: 'checking',
      destinationAccountId: 'savings',
      amount: MONEY(1_000),
      date: '2026-09-06',
    });
    const firstTransfer = makePlan({ intent: transfer('transfer-correlation-first'), idempotencyKey: 'transfer-first' });
    const secondTransfer = makePlan({ intent: transfer('transfer-correlation-second'), idempotencyKey: 'transfer-second' });
    grantActionActors(firstTransfer.plan);
    grantActionActors(secondTransfer.plan);
    await createActionProposal(firstTransfer.plan);
    await expect(createActionProposal(secondTransfer.plan)).rejects.toThrow();
  });

  it('allows distinct wallet proposals but grants only one durable acquired budget writer across connections', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const wallet = (walletId: string, accountName: string): ConsequentialActionIntent => ({
      kind: 'wallet_materialization',
      walletId,
      accountName,
      currency: 'USD',
    });
    const first = makePlan({ intent: wallet('wallet-owner-one', 'Emergency savings one'), idempotencyKey: 'budget-owner-one' });
    const second = makePlan({ intent: wallet('wallet-owner-two', 'Emergency savings two'), idempotencyKey: 'budget-owner-two' });
    grantActionActors(first.plan);
    grantActionActors(second.plan);
    const firstProposal = await createActionProposal(first.plan);
    const secondProposal = await createActionProposal(second.plan);
    for (const proposal of [firstProposal, secondProposal]) {
      await approve(proposal, 'approver-a');
      await approve(proposal, 'approver-b');
      await approve(proposal, 'approver-c');
    }
    await store.acquireProposalExecution(executionInput(firstProposal) as never);
    const peer = new SqliteWorkflowStore(databasePath);
    allStores.push(peer);
    await expect(peer.acquireProposalExecution(executionInput(secondProposal) as never)).rejects.toThrow();
  });
  it('fences concurrent categorization and rule acquisition and final dispatch against a budget action owner', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'cross-operation-budget-owner' });
    grantActionActors(plan);
    const { proposal: actionProposal, input: actionInput, acquisitionAuditId } = await acquire(plan);

    const transactionId = 'phase9-competing-category-transaction';
    const categoryPayload = { kind: 'set_category' as const, transactionId, categoryId: 'food' };
    const categoryPreconditions = {
      transactionId,
      accountId: 'checking',
      amount: MONEY(1_000),
      direction: 'outgoing' as const,
      currentCategoryId: null,
      actualVersion: 'actual-v1',
    };
    const categoryFacts = deriveProposalAuthorizationFacts(
      'set_category',
      categoryPayload,
      categoryPreconditions,
    );
    const categoryResources = [
      { resourceKind: 'budget' as const, resourceId: BUDGET_ID },
      ...categoryFacts.resources,
    ];
    for (const resource of categoryResources) {
      grant('proposer', 'categorization:propose', resource);
      grant('approver-a', 'categorization:approve', resource);
      grant('executor', 'categorization:execute', resource);
    }
    const categoryProposal = await store.createProposal({
      spaceId,
      operation: 'set_category',
      budgetId: BUDGET_ID,
      payload: categoryPayload,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify(categoryPreconditions),
      expiresAt: plan.expiresAt,
      actorId: 'proposer',
      auth: ownerAuth('proposer'),
      provenance: 'manual',
    } as unknown as CreateProposalInput);
    const approval = await store.createApproval({
      proposalId: categoryProposal.id,
      payloadHash: categoryProposal.payloadHash,
      actorId: 'approver-a',
      expiresAt: categoryProposal.expiresAt,
      auth: ownerAuth('approver-a'),
      now: currentTime(),
    });
    const categoryEffect = JSON.stringify({
      operation: categoryProposal.operation,
      payload: categoryProposal.payload,
      preconditions: JSON.parse(categoryProposal.preconditions),
    });
    const categoryExecution = {
      actorId: 'executor',
      proposalId: categoryProposal.id,
      payloadHash: categoryProposal.payloadHash,
      governancePolicyVersion: categoryProposal.governancePolicyVersion,
      idempotencyKey: 'category-blocked-by-action-owner',
      serialisedEffect: categoryEffect,
      auth: ownerAuth('executor'),
      now: currentTime(),
    };
    const peer = new SqliteWorkflowStore(databasePath);
    allStores.push(peer);
    const ruleId = 'phase9-competing-rule';
    const rulePayload = { kind: 'update_rule' as const, ruleId, inactive: true };
    const rulePreconditions = {
      rule: {
        id: ruleId,
        name: 'Competing rule',
        order: 1,
        trigger: [{ field: 'account', op: 'is', value: 'checking' }],
        actions: [{ op: 'set', field: 'category', value: 'food' }],
        inactive: false,
        stage: 'pre',
        conditionsOp: 'or',
      },
      override: null,
    };
    const ruleFacts = deriveProposalAuthorizationFacts('update_rule', rulePayload, rulePreconditions);
    const ruleResources = [
      { resourceKind: 'budget' as const, resourceId: BUDGET_ID },
      ...ruleFacts.resources,
    ];
    for (const resource of ruleResources) {
      grant('proposer', 'rule:propose', resource);
      grant('approver-a', 'rule:approve', resource);
      grant('executor', 'rule:execute', resource);
    }
    const ruleProposal = await store.createProposal({
      spaceId,
      operation: 'update_rule',
      budgetId: BUDGET_ID,
      payload: rulePayload,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify(rulePreconditions),
      expiresAt: plan.expiresAt,
      actorId: 'proposer',
      auth: ownerAuth('proposer'),
      provenance: 'manual',
    } as unknown as CreateProposalInput);
    await approve(ruleProposal as unknown as StoredConsequentialProposal, 'approver-a');
    const ruleExecution = {
      actorId: 'executor',
      proposalId: ruleProposal.id,
      payloadHash: ruleProposal.payloadHash,
      governancePolicyVersion: ruleProposal.governancePolicyVersion,
      idempotencyKey: 'rule-blocked-by-action-owner',
      serialisedEffect: JSON.stringify({
        operation: ruleProposal.operation,
        payload: ruleProposal.payload,
        preconditions: JSON.parse(ruleProposal.preconditions),
      }),
      auth: ownerAuth('executor'),
      now: currentTime(),
    };
    await expect(peer.acquireProposalExecution(ruleExecution as never))
      .rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });

    expect(approval.actorId).toBe('approver-a');
    await expect(peer.acquireProposalExecution(categoryExecution as never))
      .rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });

    await peer.createIdempotencyRecord({
      idempotencyKey: 'legacy-category-write-fence',
      proposalId: categoryProposal.id,
      operation: categoryProposal.operation,
      serialisedEffect: categoryEffect,
    });
    expect(() => store.validateAcquiredProposalExecution({
      ...actionInput,
      acquisitionAuditId,
    } as never)).toThrow();
    expect(proposalState(actionProposal.id).phase).toBe('write_intent');
  });
  it('retains a reconciled uncertain generic writer as the budget owner', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const scenario = await budgetWriterScenario('reconciled-writer');
    const leaseExpiredAt = new Date(Date.parse(currentTime()) + 61_000).toISOString();
    vi.setSystemTime(new Date(leaseExpiredAt));
    expect(await store.reconcileStrandedIdempotencyRecords()).toBe(1);
    expect((await store.getIdempotencyRecord(scenario.genericInput.idempotencyKey))?.status)
      .toBe('retryable_failed');
    await expect(store.acquireProposalExecution({
      ...scenario.actionInput,
      now: leaseExpiredAt,
      auth: ownerAuth('executor', leaseExpiredAt),
    } as never)).rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });
  });

  it('retains a terminal generic failure without exact no-dispatch proof', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const scenario = await budgetWriterScenario('failed-writer-no-proof');
    await store.completeIdempotencyRecord(
      scenario.genericInput.idempotencyKey,
      'Dispatch outcome is uncertain',
      false,
    );
    await expect(store.acquireProposalExecution(scenario.actionInput as never))
      .rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });
  });

  it('releases a terminal generic writer only with its exact acquisition-bound no-dispatch proof', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const scenario = await budgetWriterScenario('failed-writer-proven');
    await recordGenericPreDispatchFailure(
      scenario.genericProposal,
      scenario.genericInput,
      scenario.acquisitionAuditId,
    );
    expect((await store.acquireProposalExecution(scenario.actionInput as never)).claim.isOwner).toBe(true);
  });

  it('keeps a generic writer held when a no-dispatch proof names another acquisition', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const scenario = await budgetWriterScenario('failed-writer-wrong-proof');
    await recordGenericPreDispatchFailure(
      scenario.genericProposal,
      scenario.genericInput,
      'unrelated-execution-started-audit',
    );
    await expect(store.acquireProposalExecution(scenario.actionInput as never))
      .rejects.toMatchObject({ reasonCode: 'idempotency_in_progress' });
  });


  it('serializes distinct donors competing for the same recipient across two SQLite connections', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const first = makePlan({ idempotencyKey: 'recipient-owner-reserve' });
    const second = makePlan({
      intent: actionFixture.alternateDonorIntent,
      idempotencyKey: 'recipient-owner-reserve-two',
    });
    grantActionActors(first.plan);
    grantActionActors(second.plan, 'proposer-2');
    const peer = new SqliteWorkflowStore(databasePath);
    allStores.push(peer);
    const attempts = await Promise.allSettled([
      createActionProposal(first.plan, 'proposer'),
      peer.createProposal(proposalInput(second.plan, 'proposer-2') as unknown as CreateProposalInput),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('serializes same-donor proposal admission across two SQLite connections', async () => {
    setAssistanceMaximum('create_approval_proposal');
    const first = makePlan({ idempotencyKey: 'same-donor-connection-one' });
    const second = makePlan({ idempotencyKey: 'same-donor-connection-two' });
    grantActionActors(first.plan);
    grantActionActors(second.plan, 'proposer-2');
    const peer = new SqliteWorkflowStore(databasePath);
    allStores.push(peer);
    const attempts = await Promise.allSettled([
      createActionProposal(first.plan, 'proposer'),
      peer.createProposal(proposalInput(second.plan, 'proposer-2') as unknown as CreateProposalInput),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('recovers native-verified readback after result persistence interruption and expiry without another write', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { request, plan } = makePlan({ idempotencyKey: 'verified-after-expiry' });
    grantActionActors(plan);
    const { proposal, input, acquisitionAuditId } = await acquire(plan);
    const identity: ConsequentialActionExecutionIdentity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    expect(proposalState(proposal.id).effects).toEqual([]);
    const readPayload = { kind: 'consequential_action' as const, plan };
    grantVisibility(plan, ['reader']);
    const sourceReads = deriveProposalSourceReadFacts(
      ACTION_OPERATION,
      readPayload,
      preconditionsFor(plan, liquidityFixture.liquidityPolicy.policyHash),
      BUDGET_ID,
    );
    if (!sourceReads) throw new Error('Canonical source reads are required');
    for (const resource of [...proposalFacts(plan).resources, ...sourceReads.resources])
      grant('reader', 'full-read', resource);
    setAssistanceMaximum('analysis_only');
    const sourceGrant = sourceReads.required[0];
    if (!sourceGrant) throw new Error('Canonical source grant is required');
    const { capability, resourceKind, resourceId } = sourceGrant;
    store.governance.setResourceGrant({
      spaceId,
      actorId: 'reader',
      budgetId: BUDGET_ID,
      membershipId: memberships.reader!,
      capability,
      resourceKind,
      resourceId,
      granted: false,
      now: currentTime(),
      auth: ownerAuth('owner'),
    });
    await expect(store.getProposalApprovalSummary({
      proposalId: proposal.id,
      spaceId,
      actorId: 'reader',
      auth: ownerAuth('reader'),
      now: currentTime(),
    })).rejects.toThrow();
    grant('reader', capability, { resourceKind, resourceId });
    for (const actorId of ['approver-a', 'reader']) {
      const [read] = store.getProposalApprovalReads({
        proposalIds: [proposal.id],
        spaceId,
        actorId,
        auth: ownerAuth(actorId),
        now: currentTime(),
        privateProjection: 'envelope',
      });
      expect(read?.proposal.id).toBe(proposal.id);
    }
    const [privateRead] = store.getProposalApprovalReads({
      proposalIds: [proposal.id],
      spaceId,
      actorId: 'reader',
      auth: ownerAuth('reader'),
      now: currentTime(),
      privateProjection: 'envelope',
    });
    expect(privateRead?.summary.privateEnvelopeVisible).toBe(true);
    const recoveryAt = new Date(Date.parse(plan.expiresAt) + 120_000).toISOString();
    const observedLedger = structuredClone(actionFixture.postconditions.reallocation.currentLedger);
    const verifiedCard = structuredClone(request.decisionCardRequest);
    const verifiedCategories = verifiedCard.financialSnapshot.liquidity?.categories;
    if (!verifiedCategories) throw new Error('Canonical postcondition category facts are required');
    for (const postcondition of actionFixture.postconditions.reallocation.financialSnapshot.categoryAvailability) {
      const category = verifiedCategories.find((fact) => fact.categoryId === postcondition.categoryId);
      if (!category) throw new Error('Canonical postcondition category is required');
      category.availability = structuredClone(postcondition.amount);
    }
    const verifyRequest: VerifyConsequentialActionRequest = {
      plan,
      phase: 'postconditions',
      decisionCardRequest: verifiedCard,
      currentLedger: observedLedger,
      resolvedEvidence: structuredClone(actionFixture.resolvedEvidence),
      evaluatedAt: recoveryAt,
      financialPolicyVersion: request.financialPolicyVersion,
    };
    expect(verifyRequest).toMatchObject({
      currentLedger: observedLedger,
      financialPolicyVersion: request.financialPolicyVersion,
    });
    const verification = JSON.parse(native.verifyConsequentialAction(
      JSON.stringify(verifyConsequentialActionRequestSchema.parse(verifyRequest)),
    )) as ConsequentialActionVerification;
    expect(verification).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });
    const verificationToken = issueConsequentialActionVerificationToken({
      ...identity,
      verification,
      verifyRequest,
      observedState: observedLedger,
    });
    await expect(store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: {
        kind: 'verified',
        verificationToken: { verification, verifyRequest, observedState: observedLedger } as never,
      },
    })).rejects.toThrow();

    vi.setSystemTime(new Date(recoveryAt));
    expect(() => store.validateAcquiredProposalExecution({ ...input, acquisitionAuditId } as never)).toThrow();
    expect(proposalState(proposal.id)).toMatchObject({ phase: 'write_intent' });
    expect(databaseRow<{ idempotency_status: string }>(
      'SELECT idempotency_status FROM idempotency_records WHERE idempotency_key = ?', plan.idempotencyKey,
    ).idempotency_status).toBe('in_progress');
    await store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: { kind: 'verified', verificationToken },
    });
    expect(proposalState(proposal.id)).toMatchObject({ phase: 'verified' });
    const effects = proposalState(proposal.id).effects as unknown[];
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      effectIndex: 0,
      atomIndex: 0,
      actionKind: 'reallocation',
      stableIdentity: {
        assignments: [{
          sourceCategoryId: 'reserve',
          sourceAsOfMonth: '2026-09',
          destinationCategoryId: 'food',
          destinationAsOfMonth: '2026-09',
          amount: MONEY(2_000),
        }],
      },
      result: {
        kind: 'reallocation',
        atomIndex: 0,
        dispatchIndex: 0,
        result: {
          status: 'complete',
          results: expect.arrayContaining([
            {
              categoryId: 'reserve',
              month: '2026-09',
              amount: 4_000,
              expectedAmount: 6_000,
              currency: 'USD',
              result: { success: true, id: 'reserve', verified: true },
            },
            {
              categoryId: 'food',
              month: '2026-09',
              amount: 2_000,
              expectedAmount: 0,
              currency: 'USD',
              result: { success: true, id: 'food', verified: true },
            },
          ]),
        },
      },
    });
    const recoveredEffect = effects[0];
    if (!recoveredEffect || typeof recoveredEffect !== 'object' || !('result' in recoveredEffect))
      throw new Error('Recovered effect result is required');
    const actionResult = recoveredEffect.result;
    if (!actionResult || typeof actionResult !== 'object' || !('result' in actionResult))
      throw new Error('Recovered reallocation result is required');
    const executionResult = actionResult.result;
    if (!executionResult || typeof executionResult !== 'object' ||
        !('results' in executionResult) || !Array.isArray(executionResult.results))
      throw new Error('Recovered reallocation dispatch results are required');
    expect(executionResult.results).toHaveLength(2);
    setAssistanceMaximum('execute_approved_actions');
    expect(databaseRow<{ idempotency_status: string }>(
      'SELECT idempotency_status FROM idempotency_records WHERE idempotency_key = ?', plan.idempotencyKey,
    ).idempotency_status).toBe('succeeded');
    expect(() => store.validateAcquiredProposalExecution({ ...input, acquisitionAuditId } as never)).toThrow();

    const nextDonorIntent = structuredClone(actionFixture.alternateDonorIntent);
    if (nextDonorIntent.kind !== 'reallocation') throw new Error('Canonical alternate donor intent is required');
    nextDonorIntent.assignments[0]!.amount = MONEY(1_000);
    const sameCategoryMonth = makePlan({
      intent: nextDonorIntent,
      idempotencyKey: 'same-category-month-after-verified',
      evaluatedAt: recoveryAt,
      validUntil: new Date(Date.parse(recoveryAt) + 7_200_000).toISOString(),
      purchaseAt: new Date(Date.parse(recoveryAt) + 1_800_000).toISOString(),
      cartAmountMinorUnits: 3_000,
      afterReallocation: true,
    });
    grantActionActors(sameCategoryMonth.plan);
    await createActionProposal(sameCategoryMonth.plan);

    const next = makePlan({
      intent: { kind: 'wallet_materialization', walletId: 'wallet-after-verified', accountName: 'Verified wallet', currency: 'USD' },
      idempotencyKey: 'budget-owner-after-verified',
      evaluatedAt: recoveryAt,
      validUntil: new Date(Date.parse(recoveryAt) + 7_200_000).toISOString(),
      purchaseAt: new Date(Date.parse(recoveryAt) + 1_800_000).toISOString(),
      afterReallocation: true,
    });
    grantActionActors(next.plan);
    const nextProposal = await createActionProposal(next.plan);
    await approve(nextProposal, 'approver-a');
    await approve(nextProposal, 'approver-b');
    await approve(nextProposal, 'approver-c');
    expect((await store.acquireProposalExecution(executionInput(nextProposal) as never)).claim.isOwner).toBe(true);
  });
  it('recovers a missing manual result from the exact observed ledger transaction', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { request, plan } = makePlan({
      intent: manualTransactionIntent('manual-parent-composite-1', 'manual-correlation-composite-1'),
      idempotencyKey: 'verified-manual-result-recovery',
      afterReallocation: true,
    });
    grantActionActors(plan);
    const { proposal, acquisitionAuditId } = await acquire(plan);
    const identity: ConsequentialActionExecutionIdentity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    expect(proposalState(proposal.id).effects).toEqual([]);

    const observedLedger = structuredClone(actionFixture.postconditions.composite.currentLedger);
    const verifiedCard = structuredClone(request.decisionCardRequest);
    const checking = verifiedCard.financialSnapshot.liquidity?.accounts.find(
      (account) => account.accountId === 'checking',
    );
    const postBalance = actionFixture.postconditions.composite.financialSnapshot.accountBalances.find(
      (account) => account.accountId === 'checking',
    );
    if (!checking || !postBalance) throw new Error('Canonical manual poststate balance is required');
    checking.recordedBalance = structuredClone(postBalance.balance);
    const categories = verifiedCard.financialSnapshot.liquidity?.categories;
    if (!categories) throw new Error('Canonical manual poststate categories are required');
    for (const postcondition of actionFixture.postconditions.composite.financialSnapshot.categoryAvailability) {
      const category = categories.find((fact) => fact.categoryId === postcondition.categoryId);
      if (!category) throw new Error('Canonical manual poststate category is required');
      category.availability = structuredClone(postcondition.amount);
    }
    const verifyRequest: VerifyConsequentialActionRequest = {
      plan,
      phase: 'postconditions',
      decisionCardRequest: verifiedCard,
      currentLedger: observedLedger,
      resolvedEvidence: structuredClone(request.resolvedEvidence),
      evaluatedAt: request.evaluatedAt,
      financialPolicyVersion: request.financialPolicyVersion,
    };
    const verification = JSON.parse(native.verifyConsequentialAction(
      JSON.stringify(verifyConsequentialActionRequestSchema.parse(verifyRequest)),
    )) as ConsequentialActionVerification;
    expect(verification).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });
    const verificationToken = issueConsequentialActionVerificationToken({
      ...identity,
      verification,
      verifyRequest,
      observedState: observedLedger,
    });

    await store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: { kind: 'verified', verificationToken },
    });
    const recovered = proposalState(proposal.id);
    expect(recovered.phase).toBe('verified');
    expect(recovered.effects).toMatchObject([{
      effectIndex: 0,
      atomIndex: 0,
      actionKind: 'manual_transaction',
      result: {
        kind: 'manual_transaction',
        atomIndex: 0,
        dispatchIndex: 0,
        result: {
          success: true,
          parentId: 'manual-parent-composite-1',
          transactionId: 'manual-parent-composite-1',
          correlationId: 'manual-correlation-composite-1',
          verified: true,
        },
      },
    }]);
    expect(databaseRow<{ idempotency_status: string }>(
      'SELECT idempotency_status FROM idempotency_records WHERE idempotency_key = ?', plan.idempotencyKey,
    ).idempotency_status).toBe('succeeded');
    const replay = await store.acquireProposalExecution(executionInput(proposal) as never);
    expect(replay.claim.isOwner).toBe(false);
  });

  it('recovers a missing multi-donor result with one repeated recipient from native readback', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const intent: ConsequentialActionIntent = {
      kind: 'reallocation',
      assignments: [
        {
          sourceCategoryId: 'reserve',
          sourceAsOfMonth: '2026-09',
          destinationCategoryId: 'food',
          destinationAsOfMonth: '2026-09',
          amount: MONEY(1_000),
        },
        {
          sourceCategoryId: 'reserve-two',
          sourceAsOfMonth: '2026-09',
          destinationCategoryId: 'food',
          destinationAsOfMonth: '2026-09',
          amount: MONEY(1_000),
        },
      ],
    };
    const { request, plan } = makePlan({
      intent,
      idempotencyKey: 'verified-multidonor-result-recovery',
      multiDonorReallocation: true,
    });
    grantActionActors(plan);
    const { proposal, acquisitionAuditId } = await acquire(plan);
    const identity: ConsequentialActionExecutionIdentity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    expect(proposalState(proposal.id).effects).toEqual([]);

    const observedLedger = structuredClone(request.currentLedger);
    const verifiedCard = structuredClone(request.decisionCardRequest);
    const categories = verifiedCard.financialSnapshot.liquidity?.categories;
    if (!categories) throw new Error('Canonical multi-donor poststate categories are required');
    for (const [categoryId, minorUnits] of [
      ['food', 2_000],
      ['reserve', 5_000],
      ['reserve-two', 5_000],
    ] as const) {
      const assignment = observedLedger.assignments.find((entry) => entry.categoryId === categoryId);
      const category = categories.find((entry) => entry.categoryId === categoryId);
      if (!assignment || !category) throw new Error('Canonical multi-donor category is required');
      assignment.amount = MONEY(minorUnits);
      category.availability = MONEY(minorUnits);
    }
    const verifyRequest: VerifyConsequentialActionRequest = {
      plan,
      phase: 'postconditions',
      decisionCardRequest: verifiedCard,
      currentLedger: observedLedger,
      resolvedEvidence: structuredClone(request.resolvedEvidence),
      evaluatedAt: request.evaluatedAt,
      financialPolicyVersion: request.financialPolicyVersion,
    };
    const verification = JSON.parse(native.verifyConsequentialAction(
      JSON.stringify(verifyConsequentialActionRequestSchema.parse(verifyRequest)),
    )) as ConsequentialActionVerification;
    expect(verification).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });
    const verificationToken = issueConsequentialActionVerificationToken({
      ...identity,
      verification,
      verifyRequest,
      observedState: observedLedger,
    });

    await store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: { kind: 'verified', verificationToken },
    });
    const effectList = proposalState(proposal.id).effects;
    if (!Array.isArray(effectList) || effectList.length !== 1)
      throw new Error('Native readback must recover exactly one reallocation effect');
    const effects: unknown[] = effectList;
    const recoveredEffect = effects[0];
    if (!recoveredEffect || typeof recoveredEffect !== 'object' || !('result' in recoveredEffect))
      throw new Error('Native readback must recover the effect result');
    const actionResult = recoveredEffect.result;
    if (!actionResult || typeof actionResult !== 'object' || !('result' in actionResult))
      throw new Error('Native readback must recover the action result');
    const executionResult = actionResult.result;
    if (!executionResult || typeof executionResult !== 'object' ||
        !('results' in executionResult) || !Array.isArray(executionResult.results))
      throw new Error('Native readback must recover the reallocation result list');
    const results: unknown[] = executionResult.results;
    expect(results).toHaveLength(3);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryId: 'food', month: '2026-09', amount: 2_000, expectedAmount: 0 }),
      expect.objectContaining({ categoryId: 'reserve', month: '2026-09', amount: 5_000, expectedAmount: 6_000 }),
      expect.objectContaining({ categoryId: 'reserve-two', month: '2026-09', amount: 5_000, expectedAmount: 6_000 }),
    ]));
  });

  it('keeps verified transaction parent identities consumed after native readback', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { request, plan } = makePlan({
      intent: actionFixture.compositeIntent,
      idempotencyKey: 'verified-composite-parent',
    });
    grantActionActors(plan);
    const { proposal, acquisitionAuditId } = await acquire(plan);
    const identity: ConsequentialActionExecutionIdentity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    await store.recordConsequentialActionEffect({
      ...identity,
      effectIndex: 0,
      atomIndex: 0,
      dispatchIndex: 0,
      result: {
        kind: 'reallocation',
        atomIndex: 0,
        dispatchIndex: 0,
        result: {
          status: 'complete',
          results: [
            {
              categoryId: 'reserve',
              month: '2026-09',
              amount: 4_000,
              expectedAmount: 6_000,
              currency: 'USD',
              result: { success: true, id: 'reserve', verified: true },
            },
            {
              categoryId: 'food',
              month: '2026-09',
              amount: 2_000,
              expectedAmount: 0,
              currency: 'USD',
              result: { success: true, id: 'food', verified: true },
            },
          ],
        },
      },
    });
    const observedLedger = structuredClone(actionFixture.postconditions.composite.currentLedger);
    const atoms = atomsOf(plan.action);
    const manualAtomIndex = atoms.findIndex((atom) => atom.kind === 'manual_transaction');
    const manualAtom = atoms[manualAtomIndex];
    if (manualAtomIndex < 0 || manualAtom?.kind !== 'manual_transaction')
      throw new Error('Canonical composite manual atom is required');
    const observedManual = observedLedger.transactions.find(
      (transaction) => transaction.parentId === manualAtom.transaction.parentId,
    );
    if (!observedManual) throw new Error('Canonical composite manual readback is required');
    await store.recordConsequentialActionEffect({
      ...identity,
      effectIndex: manualAtomIndex,
      atomIndex: manualAtomIndex,
      dispatchIndex: 0,
      result: {
        kind: 'manual_transaction',
        atomIndex: manualAtomIndex,
        dispatchIndex: 0,
        result: {
          success: true,
          parentId: observedManual.parentId,
          transactionId: observedManual.parentId,
          correlationId: manualAtom.transaction.correlationId,
          verified: true,
        },
      },
    });
    const verifiedCard = structuredClone(request.decisionCardRequest);
    const categories = verifiedCard.financialSnapshot.liquidity?.categories;
    if (!categories) throw new Error('Canonical composite postcondition category facts are required');
    for (const [categoryId, minorUnits] of [['food', '0'], ['reserve', '4000']] as const) {
      const category = categories.find((fact) => fact.categoryId === categoryId);
      if (!category) throw new Error(`Canonical ${categoryId} postcondition is required`);
      category.availability = MONEY(minorUnits);
    }
    const poststateBalance = actionFixture.postconditions.composite.financialSnapshot.accountBalances
      .find((account) => account.accountId === 'checking');
    const checkingFact = verifiedCard.financialSnapshot.liquidity?.accounts
      .find((account) => account.accountId === 'checking');
    if (!poststateBalance || !checkingFact)
      throw new Error('Canonical post-composite checking balance is required');
    checkingFact.recordedBalance = structuredClone(poststateBalance.balance);
    const verifyRequest: VerifyConsequentialActionRequest = {
      plan,
      phase: 'postconditions',
      decisionCardRequest: verifiedCard,
      currentLedger: observedLedger,
      resolvedEvidence: structuredClone(actionFixture.resolvedEvidence),
      evaluatedAt: request.evaluatedAt,
      financialPolicyVersion: request.financialPolicyVersion,
    };
    const verification = JSON.parse(native.verifyConsequentialAction(
      JSON.stringify(verifyConsequentialActionRequestSchema.parse(verifyRequest)),
    )) as ConsequentialActionVerification;
    expect(verification).toEqual({ valid: true, reason: null, actionHash: plan.actionHash });
    const verificationToken = issueConsequentialActionVerificationToken({
      ...identity,
      verification,
      verifyRequest,
      observedState: observedLedger,
    });
    await store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: { kind: 'verified', verificationToken },
    });
    const completed = proposalState(proposal.id);
    const effects = completed.effects as unknown[];
    expect(completed.phase).toBe('verified');
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({
      effectIndex: 0,
      atomIndex: 0,
      actionKind: 'reallocation',
      result: {
        kind: 'reallocation',
        atomIndex: 0,
        dispatchIndex: 0,
        result: { status: 'complete', results: [{ categoryId: 'reserve' }, { categoryId: 'food' }] },
      },
    });
    expect(effects[1]).toMatchObject({
      effectIndex: 1,
      atomIndex: 1,
      actionKind: 'manual_transaction',
      result: {
        kind: 'manual_transaction',
        atomIndex: 1,
        dispatchIndex: 0,
        result: {
          success: true,
          parentId: 'manual-parent-composite-1',
          transactionId: 'manual-parent-composite-1',
          correlationId: 'manual-correlation-composite-1',
          verified: true,
        },
      },
    });
    const duplicateIntent = structuredClone(actionFixture.compositeIntent);
    if (duplicateIntent.kind !== 'composite')
      throw new Error('Canonical composite action intent is required');
    const duplicateTransaction = duplicateIntent.actions.find((atom) => atom.kind === 'manual_transaction');
    if (!duplicateTransaction || duplicateTransaction.kind !== 'manual_transaction')
      throw new Error('Canonical composite manual-transaction atom is required');
    duplicateTransaction.transaction.parentId = 'manual-parent-composite-1';
    duplicateTransaction.transaction.correlationId = 'verified-parent-replay';
    duplicateTransaction.transaction.payeeName = 'Renamed verified transaction';
    const duplicate = makePlan({
      intent: duplicateIntent,
      idempotencyKey: 'verified-parent-replay',
    });
    grantActionActors(duplicate.plan);
    await expect(createActionProposal(duplicate.plan)).rejects.toThrow();
  });
  it('releases the acquired owner only with exact fenced no-dispatch proof', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'fenced-no-dispatch' });
    grantActionActors(plan);
    const { proposal, acquisitionAuditId } = await acquire(plan);
    const identity: ConsequentialActionExecutionIdentity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    const invalidationToken = issueConsequentialActionInvalidationToken({
      ...identity,
      dispatchCount: 0,
      staleWorkerFenced: true,
    });
    await expect(store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: {
        kind: 'invalidated_no_dispatch',
        invalidationToken: { ...identity, dispatchCount: 0, staleWorkerFenced: true } as never,
      },
    })).rejects.toThrow();
    expect(proposalState(proposal.id).phase).toBe('write_intent');
    await store.finalizeConsequentialActionExecution({
      ...identity,
      outcome: { kind: 'invalidated_no_dispatch', invalidationToken },
    });
    expect(proposalState(proposal.id)).toMatchObject({ phase: 'invalidated_no_dispatch', outcome: 'invalidated_no_dispatch' });
    expect(databaseRow<{ idempotency_status: string }>(
      'SELECT idempotency_status FROM idempotency_records WHERE idempotency_key = ?', plan.idempotencyKey,
    ).idempotency_status).toBe('terminal_failed');
    expect(await store.queryAuditRecords('execution_failed')).toHaveLength(1);

    const next = makePlan({ idempotencyKey: 'after-fenced-no-dispatch' });
    grantActionActors(next.plan);
    const nextProposal = await createActionProposal(next.plan);
    await approve(nextProposal, 'approver-a');
    await approve(nextProposal, 'approver-b');
    await approve(nextProposal, 'approver-c');
    expect((await store.acquireProposalExecution(executionInput(nextProposal) as never)).claim.isOwner).toBe(true);
  });



  it('keeps an ambiguous acquired donor held past expiry, lease reconciliation, close, and reopen', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'ambiguous-donor-hold' });
    grantActionActors(plan);
    const { proposal, acquisitionAuditId } = await acquire(plan);
    await store.finalizeConsequentialActionExecution({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
      outcome: { kind: 'review_required', reason: 'partial_or_ambiguous_write', observedState: { dispatchMayHaveOccurred: true } },
    });
    expect(proposalState(proposal.id)).toMatchObject({ phase: 'review_required' });

    const afterExpiry = new Date(Date.parse(plan.expiresAt) + 120_000).toISOString();
    vi.setSystemTime(new Date(afterExpiry));
    reopenStore();
    expect(await store.reconcileStrandedIdempotencyRecords()).toBe(0);
    const state = proposalState(proposal.id);
    expect(state.phase).toBe('review_required');
    const idempotency = databaseRow<{ idempotency_status: string }>(
      'SELECT idempotency_status FROM idempotency_records WHERE idempotency_key = ?', plan.idempotencyKey,
    );
    expect(idempotency.idempotency_status).not.toBe('retryable_failed');

    const later = new Date(Date.parse(afterExpiry) + 1_000).toISOString();
    const liveCompetitor = makePlan({
      idempotencyKey: 'same-donor-after-restart',
      evaluatedAt: later,
      validUntil: new Date(Date.parse(later) + 3_600_000).toISOString(),
      purchaseAt: new Date(Date.parse(later) + 1_800_000).toISOString(),
    });
    grantActionActors(liveCompetitor.plan);
    await expect(createActionProposal(liveCompetitor.plan)).rejects.toThrow();
  });

  it('persists ordered composite atom results and rejects changed or stale replays', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ intent: actionFixture.compositeIntent, idempotencyKey: 'ordered-composite-results' });
    grantActionActors(plan);
    const { proposal, acquisitionAuditId } = await acquire(plan);
    const token: ConsequentialActionExecutionIdentity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'executor',
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    const firstResult = {
      kind: 'reallocation',
      dispatches: [
        { categoryId: 'reserve', adapterResult: { success: true } },
        { categoryId: 'food', adapterResult: { success: true } },
      ],
    };
    await expect(store.recordConsequentialActionEffect({
      ...token,
      effectIndex: 0,
      atomIndex: 1,
      dispatchIndex: 0,
      result: firstResult,
    })).rejects.toThrow();
    await store.recordConsequentialActionEffect({
      ...token,
      effectIndex: 0,
      atomIndex: 0,
      dispatchIndex: 0,
      result: firstResult,
    });
    expect(proposalState(proposal.id).effects).toEqual([
      expect.objectContaining({ effectIndex: 0, atomIndex: 0, dispatchIndex: 0, actionKind: 'reallocation', result: firstResult }),
    ]);
    reopenStore();
    const firstPersisted = proposalState(proposal.id).effects;
    await store.recordConsequentialActionEffect({
      ...token,
      effectIndex: 0,
      atomIndex: 0,
      dispatchIndex: 0,
      result: firstResult,
    });
    expect(proposalState(proposal.id).effects).toEqual(firstPersisted);
    const secondResult = {
      kind: 'manual_transaction',
      parentId: 'manual-parent-composite-1',
      transactionIds: ['actual-generated-manual-transaction-1'],
    };
    await store.recordConsequentialActionEffect({
      ...token,
      effectIndex: 1,
      atomIndex: 1,
      dispatchIndex: 0,
      result: secondResult,
    });
    expect(proposalState(proposal.id).effects).toEqual([
      expect.objectContaining({ effectIndex: 0, atomIndex: 0, dispatchIndex: 0, actionKind: 'reallocation', result: firstResult }),
      expect.objectContaining({
        effectIndex: 1,
        atomIndex: 1,
        dispatchIndex: 0,
        actionKind: 'manual_transaction',
        stableIdentity: { parentId: 'manual-parent-composite-1' },
        result: secondResult,
      }),
    ]);
    await expect(store.recordConsequentialActionEffect({
      ...token,
      effectIndex: 1,
      atomIndex: 1,
      dispatchIndex: 0,
      result: { ...secondResult, transactionIds: ['other-generated-id'] },
    })).rejects.toThrow();
    await expect(store.recordConsequentialActionEffect({
      ...token,
      acquisitionAuditId: 'stale-acquisition-audit',
      effectIndex: 1,
      atomIndex: 1,
      dispatchIndex: 0,
      result: secondResult,
    })).rejects.toThrow();
    expect(proposalState(proposal.id)).toMatchObject({ phase: 'write_intent' });
  });

  it('fences the acquired writer when the current assistance ceiling is reduced', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'assistance-reduced-after-acquire' });
    grantActionActors(plan);
    const { proposal, input, acquisitionAuditId } = await acquire(plan);
    setAssistanceMaximum('analysis_only');
    expect(() => store.validateAcquiredProposalExecution({ ...input, acquisitionAuditId } as never)).toThrow();
    expect(proposalState(proposal.id).phase).toBe('write_intent');
  });

  it('fences a revoked action-specific execute grant after acquisition', async () => {
    setAssistanceMaximum('execute_approved_actions');
    const { plan } = makePlan({ idempotencyKey: 'execute-right-revoked' });
    grantActionActors(plan);
    const { proposal, input, acquisitionAuditId } = await acquire(plan);
    const executeCapability = CONSEQUENTIAL_ACTION_CAPABILITY_MAP.reallocation.execute;
    for (const resource of atomResources(atomsOf(plan.action)[0]!)) {
      store.governance.setResourceGrant({
        spaceId,
        actorId: 'executor',
        budgetId: BUDGET_ID,
        membershipId: memberships.executor!,
        capability: executeCapability,
        ...resource,
        granted: false,
        now: currentTime(),
        auth: ownerAuth('owner'),
      });
    }
    expect(() => store.validateAcquiredProposalExecution({ ...input, acquisitionAuditId } as never)).toThrow();
    expect(proposalState(proposal.id).phase).toBe('write_intent');
  });
});
