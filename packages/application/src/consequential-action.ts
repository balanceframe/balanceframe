import { createHash, randomUUID } from 'node:crypto';
import { loadNativeBindings } from './composition.js';
import type { NativeBindingShim } from './composition.js';
import { z } from 'zod';
import { ApplicationError } from './errors.js';
import type {
  AtomicConsequentialActionIntent,
  ConsequentialActionEvidence,
  ConsequentialActionIntent,
  ConsequentialActionLedger,
  ConsequentialActionPlan,
  EconomicEventLedgerEffect,
  TransferSettlementRecord,
  ConsequentialActionVerification,
  DecisionCardRequest,
  FinancialSnapshot,
  PlanConsequentialActionRequest,
  VerifyConsequentialActionRequest,
} from '@balanceframe/protocol-generated';
import {
  consequentialActionIntentSchema,
  consequentialActionPlanSchema,
  consequentialActionVerificationSchema,
  decisionCardAdjustmentSchema,
  decisionCardItemSchema,
  decisionCardRequestSchema,
  decisionCardWarningThresholdSchema,
  planConsequentialActionRequestSchema,
  verifyConsequentialActionRequestSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  ActionProposal,
  AssistanceMaximum,
  GenericActionProposal,
  LiquidityActor,
  ProposalApprovalSummary,
  ResourceCapability,
  ResourceKind,
  SupplementalFactsRecord,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import { GENERIC_MUTATION_POLICY_VERSION, canonicalProposalJson } from '@balanceframe/workflow-store';
import {
  issueConsequentialActionInvalidationToken,
  issueConsequentialActionVerificationToken,
} from '@balanceframe/workflow-store/internal';
import type {
  BudgetAssignmentPrecondition,
  BudgetLedger,
  BudgetAssignmentResult,
  LedgerTransferInput,
  LedgerTransferResult,
  ManualTransactionInput,
  ManualTransactionResult,
  WalletAccountInput,
  WalletAccountResult,
} from '@balanceframe/actual-adapter';
import type { ConnectedBudget } from './connection-manager.js';
import type { ConsequentialActionCapture, ConsequentialActionDecision, LiquidityService } from './liquidity-service.js';
import { spendSessionInputSchema } from './liquidity-inputs.js';
import type { SpendSession } from '@balanceframe/workflow-store';

export interface ConsequentialActionNative {
  planConsequentialAction(input: string): string;
  verifyConsequentialAction(input: string): string;
}

export interface ConsequentialActionServiceOptions {
  liquidity: LiquidityService;
  store: WorkflowStore;
  native: ConsequentialActionNative;
  clock?: () => Date;
}

type StoredConsequentialActionProposal = Extract<GenericActionProposal, { operation: 'consequential_action' }>;
type ConsequentialActionState = StoredConsequentialActionProposal['state'];
export interface ConsequentialActionDecisionItem extends Pick<
  DecisionCardRequest['items'][number],
  'id' | 'categoryId' | 'amount' | 'purchaseAt' | 'requiredBy' | 'priority' | 'quantity' | 'categoryAllocations'
> {
  readonly accountId: string | null;
}
export interface ConsequentialActionDecisionContext {
  readonly horizon: DecisionCardRequest['context']['horizon'];
  readonly validUntil: string;
  readonly items: readonly ConsequentialActionDecisionItem[];
  readonly adjustments?: NonNullable<DecisionCardRequest['adjustments']>;
  readonly warningThresholds?: NonNullable<DecisionCardRequest['warningThresholds']>;
}
export interface ConsequentialActionPublicSource {
  readonly snapshotReference: string;
  readonly policyVersion: string;
  readonly financialPolicyVersion: string;
  readonly claimSetRevision: string;
}
export type ConsequentialActionPublicEvidenceReference = Pick<
  ConsequentialActionPlan['evidenceReferences'][number],
  'evidenceId' | 'subjectId' | 'state'
>;
export type ConsequentialActionPublicPlan = Omit<
  ConsequentialActionPlan,
  'source' | 'idempotencyKey' | 'actionHash' | 'evidenceReferences' | 'dispatchPreconditions'
> & {
  readonly source: ConsequentialActionPublicSource;
  readonly evidenceReferences: readonly ConsequentialActionPublicEvidenceReference[];
};
export type ConsequentialActionProposal = Pick<
  StoredConsequentialActionProposal,
  'id' | 'budgetId' | 'spaceId' | 'policyVersion' | 'expiresAt' | 'supersededAt' | 'createdAt' | 'version'
> & {
  readonly operation: 'consequential_action';
  readonly requesterActorId: string;
  readonly governancePolicyVersion: string | null;
  readonly currentGovernancePolicyVersion: string;
  readonly payloadHash: string;
  readonly financialPolicyVersion: string;
  readonly currentFinancialPolicyVersion: string | null;
  readonly requiredApprovers: number;
  readonly decisionContext: ConsequentialActionDecisionContext | null;
  readonly payload: { readonly kind: 'consequential_action'; readonly plan: ConsequentialActionPublicPlan };
  readonly state: Pick<ConsequentialActionState, 'phase' | 'outcome'>;
};
export interface ConsequentialActionExecution {
  readonly id: string;
  readonly phase: ConsequentialActionState['phase'];
  readonly outcome: string | null;
}

type ResourceRef = { readonly resourceKind: ResourceKind; readonly resourceId: string };
type ActionPhase = 'propose' | 'approve' | 'execute';
type ActionDecision = ConsequentialActionDecision;
type ActionDecisionCart = Extract<ActionDecision, { readonly accountId: string | null }>;
type ActionDecisionItems = ActionDecisionCart['items'];
type ActionPreconditions = {
  readonly version: 1;
  readonly sourceReference: string;
  readonly nativeActionHash: string;
  readonly nativeSource: ConsequentialActionPlan['source'];
  readonly decisionCardPolicyHash: string;
  readonly financialApprovalPolicy: { readonly version: string; readonly policyHash: string };
  readonly supplemental: SupplementalFactsRecord | null;
  readonly supplementalHash: string;
  readonly decision: ActionDecision | null;
  readonly sessionCart: PinnedDecision | null;
  readonly recoveryDecision: PinnedDecision | null;
  readonly sessionCartHash: string | null;
  readonly decisionHorizon: DecisionCardRequest['context']['horizon'];
  readonly decisionValidUntil: string;
  readonly decisionContext: ConsequentialActionDecisionContext | null;
};
type ProposalState = ConsequentialActionState;
type ActionAtom = AtomicConsequentialActionIntent;
type PostconditionAuthorization = {
  readonly plan: ConsequentialActionPlan;
  readonly preconditions: ActionPreconditions;
};
type ActionDispatchPrecondition = ConsequentialActionPlan['dispatchPreconditions'][number];

const assistanceLevels: Record<AssistanceMaximum, number> = {
  analysis_only: 0,
  recommend_actions: 1,
  create_approval_proposal: 2,
  execute_approved_actions: 3,
};
const idSchema = z.string().trim().min(1).max(256);
const sessionSelectorSchema = z.object({
  sessionId: idSchema,
  sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const pinnedDecisionSchema = z.object({
  accountId: idSchema.nullable(),
  items: spendSessionInputSchema.shape.items,
  adjustments: spendSessionInputSchema.shape.adjustments,
  warningThresholds: spendSessionInputSchema.shape.warningThresholds,
  expiresAt: spendSessionInputSchema.shape.expiresAt,
}).strict();
type PinnedDecision = z.infer<typeof pinnedDecisionSchema>;
const publicActionCartSchema = pinnedDecisionSchema.extend({
  expiresAt: spendSessionInputSchema.shape.expiresAt.optional(),
});
const actionDecisionSchema = z.union([
  z.object({ origin: sessionSelectorSchema }).strict(),
  publicActionCartSchema,
]);
const proposeInputSchema = z.object({
  action: consequentialActionIntentSchema,
  decision: actionDecisionSchema.optional(),
}).strict();
const publicDecisionItemSchema = decisionCardItemSchema.pick({
  id: true,
  categoryId: true,
  amount: true,
  purchaseAt: true,
  requiredBy: true,
  priority: true,
  quantity: true,
  categoryAllocations: true,
}).extend({ accountId: idSchema.nullable() }).strict();
const decisionContextSchema = z.object({
  horizon: z.object({ startsAt: z.string(), endsAt: z.string() }).strict(),
  validUntil: z.string(),
  items: z.array(publicDecisionItemSchema),
  adjustments: z.array(decisionCardAdjustmentSchema).optional(),
  warningThresholds: z.array(decisionCardWarningThresholdSchema).optional(),
}).strict().nullable();
const storedPreconditionsSchema = z.object({
  version: z.literal(1),
  sourceReference: z.string().uuid(),
  nativeActionHash: z.string().regex(/^[0-9a-f]{64}$/),
  nativeSource: consequentialActionPlanSchema.shape.source,
  decisionCardPolicyHash: z.string().min(1),
  financialApprovalPolicy: z.object({
    version: z.string().min(1),
    policyHash: z.string().min(1),
  }).strict(),
  supplemental: z.unknown(),
  supplementalHash: z.string().regex(/^[0-9a-f]{64}$/),
  decision: actionDecisionSchema.nullable(),
  sessionCart: pinnedDecisionSchema.nullable(),
  recoveryDecision: pinnedDecisionSchema.nullable(),
  sessionCartHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  decisionHorizon: z.object({ startsAt: z.string(), endsAt: z.string() }).strict(),
  decisionValidUntil: z.string(),
  decisionContext: decisionContextSchema,
}).strict();
function capturedDecisionContext(request: DecisionCardRequest): ConsequentialActionDecisionContext | null {
  if (!request.items.length && !request.adjustments?.length && !request.warningThresholds?.length) return null;
  return {
    horizon: request.context.horizon,
    validUntil: request.validUntil,
    items: request.items.map((item) => ({
      id: item.id,
      categoryId: item.categoryId,
      accountId: item.routeSelection.explicitAccountId ??
        item.routeSelection.sessionAccountId ??
        item.routeSelection.approvedPreference?.accountId ??
        item.routeSelection.historicalRoute?.accountId ??
        null,
      amount: item.amount,
      purchaseAt: item.purchaseAt,
      requiredBy: item.requiredBy,
      priority: item.priority,
      ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
      ...(item.categoryAllocations === undefined ? {} : { categoryAllocations: item.categoryAllocations }),
    })),
    ...(request.adjustments === undefined ? {} : { adjustments: jsonClone(request.adjustments) }),
    ...(request.warningThresholds === undefined ? {} : { warningThresholds: jsonClone(request.warningThresholds) }),
  };
}
type SupplementalObservationProjection = PlanConsequentialActionRequest['supplementalObservations'][number];
function supplementalObservationProjections(
  capture: ConsequentialActionCapture,
): SupplementalObservationProjection[] {
  const supplemental = capture.supplemental;
  const now = Date.parse(capture.now);
  if (
    !supplemental || Date.parse(supplemental.expiresAt) <= now ||
    Date.parse(supplemental.createdAt) > now
  ) return [];
  const facts = capture.snapshot.liquidity?.accounts ?? [];
  const output: SupplementalObservationProjection[] = [];
  for (const observation of supplemental.observations) {
    if (Date.parse(observation.expiresAt) <= now || Date.parse(observation.observedAt) > now) continue;
    const account = facts.find((entry) => entry.accountId === observation.accountId);
    if (!account) continue;
    const fields: SupplementalObservationProjection['fields'][number][] = [];
    const baselineTransactionIds = new Set(account.baselineTransactionIds);
    if (observation.currency !== undefined && account.currencyEvidence.source === 'user_attested')
      fields.push('currency');
    if (observation.kind !== undefined && account.kindEvidence.source === 'user_attested')
      fields.push('kind');
    if (observation.owned !== undefined && account.ownershipEvidence.source === 'user_attested')
      fields.push('owned');
    if (
      observation.currentLedgerConfirmed === true &&
      account.freshnessEvidence.source === 'user_attested'
    ) fields.push('currentLedgerConfirmed');
    if (observation.holds !== undefined && account.holdsEvidence.source === 'user_attested')
      fields.push('holds');
    const reportedFlowIds = new Set((observation.unsettledFlows ?? []).map((flow) => flow.id));
    const flowIds = account.unsettledFlows
      .filter((flow) => reportedFlowIds.has(flow.id) && flow.provenance === 'manual_ledger' &&
        flow.matchedTransactionIds.every((id) => !baselineTransactionIds.has(id)))
      .map((flow) => flow.id)
      .sort();
    if (observation.unsettledFlows !== undefined) fields.push('unsettledFlows');
    const reportedObligationIds = new Set((observation.obligations ?? []).map((obligation) => obligation.id));
    const obligationIds = account.obligations
      .filter((obligation) => reportedObligationIds.has(obligation.id) &&
        obligation.matchedTransactionIds.every((id) => !baselineTransactionIds.has(id)))
      .map((obligation) => obligation.id)
      .sort();
    if (observation.obligations !== undefined) fields.push('obligations');
    if (
      observation.credit !== undefined &&
      (account.credit === null || account.credit?.evidence.source === 'user_attested')
    ) fields.push('credit');
    if (fields.length) output.push({ accountId: account.accountId, fields, flowIds, obligationIds });
  }
  return output;
}

const SHA256 = /^[0-9a-f]{64}$/;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function atoms(action: ConsequentialActionIntent): ActionAtom[] {
  return action.kind === 'composite' ? action.actions : [action];
}
function actionCapability(kind: ActionAtom['kind'], phase: ActionPhase): ResourceCapability {
  const prefix = kind === 'reallocation' ? 'reallocation'
    : kind === 'manual_transaction' ? 'transaction'
    : kind === 'evidence_projection' ? 'ledger_projection'
    : kind === 'wallet_materialization' ? 'wallet_materialization'
    : 'transfer';
  return `${prefix}:${phase}`;
}
function actionResources(atom: ActionAtom, budgetId: string): ResourceRef[] {
  const resources = new Map<string, ResourceRef>();
  const add = (resourceKind: ResourceKind, resourceId: string | null | undefined) => {
    if (resourceId) resources.set(`${resourceKind}:${resourceId}`, { resourceKind, resourceId });
  };
  add('budget', budgetId);
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
      add('ledger_effect', atom.transaction.parentId);
      add('category', atom.transaction.categoryId);
      for (const split of atom.transaction.splits) add('category', split.categoryId);
      if (atom.kind === 'evidence_projection')
        for (const evidenceId of atom.evidenceIds) add('evidence', evidenceId);
      break;
    case 'wallet_materialization':
      add('wallet', atom.walletId);
      break;
    case 'transfer':
      add('account', atom.sourceAccountId);
      add('account', atom.destinationAccountId);
      add('transfer', atom.transferId);
      break;
  }
  return [...resources.values()];
}
function sessionCart(session: SpendSession): Record<string, unknown> {
  return {
    accountId: session.accountId,
    items: session.items,
    ...(session.adjustments === undefined ? {} : { adjustments: session.adjustments }),
    ...(session.warningThresholds === undefined ? {} : { warningThresholds: session.warningThresholds }),
    expiresAt: session.expiresAt,
  };
}
function manualDebits(action: ConsequentialActionIntent, evaluatedAt: string): ActionDecisionItems {
  const result: ActionDecisionItems = [];
  for (const atom of atoms(action)) {
    if (atom.kind !== 'manual_transaction' && atom.kind !== 'evidence_projection') continue;
    const transaction = atom.transaction;
    const purchaseAt = evaluatedAt;
    const add = (categoryId: string, amount: { minorUnits: string; currency: string }, id: string) => {
      if (!/^-([1-9][0-9]*)$/.test(amount.minorUnits))
        throw new Error('Manual transaction debit must be a negative exact amount');
      result.push({
        id,
        categoryId,
        accountId: transaction.accountId,
        amount: { minorUnits: amount.minorUnits.slice(1), currency: amount.currency },
        purchaseAt,
        requiredBy: purchaseAt,
      });
    };
    if (transaction.splits.length) {
      transaction.splits.forEach((split, index) => add(split.categoryId, split.amount, `${transaction.parentId}:split:${index}`));
    } else if (transaction.categoryId) {
      add(transaction.categoryId, transaction.amount, transaction.parentId);
    } else {
      throw new Error('Manual debit requires a category or category splits');
    }
  }
  return result;
}
function mergeManualDebits(
  action: ConsequentialActionIntent,
  decision: ActionDecisionCart,
  evaluatedAt: string,
): ActionDecisionCart {
  const trustedDebits = decision.items.flatMap((item) =>
    (item.categoryAllocations ?? [{ categoryId: item.categoryId, amount: item.amount }])
      .map((allocation) => ({
        accountId: item.accountId ?? decision.accountId,
        categoryId: allocation.categoryId,
        amount: allocation.amount,
        date: item.purchaseAt.slice(0, 10),
      })),
  );
  const usedDebits = new Set<number>();
  const unmatched = manualDebits(action, evaluatedAt).filter((debit) => {
    const index = trustedDebits.findIndex((trusted, candidate) =>
      !usedDebits.has(candidate) &&
      trusted.accountId === debit.accountId &&
      trusted.categoryId === debit.categoryId &&
      trusted.date === debit.purchaseAt.slice(0, 10) &&
      canonical(trusted.amount) === canonical(debit.amount),
    );
    if (index < 0) return true;
    usedDebits.add(index);
    return false;
  });
  return { ...decision, items: [...decision.items, ...unmatched] };
}
function savedDecision(
  action: ConsequentialActionIntent,
  decision: ActionDecision | null,
  store: WorkflowStore,
  actor: LiquidityActor,
  now: string,
): ActionDecision {
  if (decision && 'origin' in decision) {
    const debits = manualDebits(action, now);
    if (debits.length === 0) return decision;
    const session = store.liquidity.getSpendSession({
      ...actor, id: decision.origin.sessionId, now,
    });
    if (!session || session.version !== decision.origin.sessionVersion || Date.parse(session.expiresAt) <= Date.parse(now))
      throw new Error('Saved session unavailable or changed');
    return mergeManualDebits(action, {
      accountId: session.accountId,
      items: session.items,
      ...(session.adjustments === undefined ? {} : { adjustments: session.adjustments }),
      ...(session.warningThresholds === undefined ? {} : { warningThresholds: session.warningThresholds }),
      expiresAt: session.expiresAt,
    }, now);
  }
  if (decision) return mergeManualDebits(action, decision, now);
  return { accountId: null, items: manualDebits(action, now) };
}
function moneyNumber(value: { readonly minorUnits: string; readonly currency: string }): number {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value.minorUnits)) throw new Error('Invalid canonical minor units');
  const number = Number(value.minorUnits);
  if (!Number.isSafeInteger(number)) throw new Error('Amount exceeds the Actual safe integer range');
  return number;
}
function requirePositiveMoney(value: { readonly minorUnits: string; readonly currency: string }): number {
  if (!/^[1-9][0-9]*$/.test(value.minorUnits)) throw new Error('Amount must be positive');
  return moneyNumber(value);
}
function financialPolicyVersion(capture: ConsequentialActionCapture): string {
  const version = capture.policy?.policy.version;
  if (!version || !version.trim()) throw new Error('Current financial policy version unavailable');
  return version;
}
function nativeVerification(
  native: ConsequentialActionNative,
  input: VerifyConsequentialActionRequest,
): ConsequentialActionVerification {
  const request = verifyConsequentialActionRequestSchema.parse(input);
  const response = consequentialActionVerificationSchema.parse(
    JSON.parse(native.verifyConsequentialAction(JSON.stringify(request))) as unknown,
  );
  if (response.actionHash !== request.plan.actionHash) throw new Error('Native action hash mismatch');
  return response;
}
function requireCurrentSession(
  store: WorkflowStore,
  actor: LiquidityActor,
  preconditions: ActionPreconditions,
  now: string,
): void {
  if (!preconditions.decision || !('origin' in preconditions.decision)) return;
  const session = store.liquidity.getSpendSession({
    ...actor,
    id: preconditions.decision.origin.sessionId,
    now,
  });
  if (
    !session || session.version !== preconditions.decision.origin.sessionVersion ||
    Date.parse(session.expiresAt) <= Date.parse(now) ||
    preconditions.sessionCart === null ||
    canonical(sessionCart(session)) !== canonical(preconditions.sessionCart) ||
    hash(sessionCart(session)) !== preconditions.sessionCartHash
  ) throw new Error('Saved session changed');
}
function currentDecisionRequest(
  capture: ConsequentialActionCapture,
  action: ConsequentialActionIntent,
  preconditions: ActionPreconditions,
  store: WorkflowStore,
  actor: LiquidityActor,
  recoverSavedSession = false,
): DecisionCardRequest {
  const decision = recoverSavedSession && preconditions.decision && 'origin' in preconditions.decision
    ? preconditions.recoveryDecision
    : savedDecision(action, preconditions.decision, store, actor, capture.now);
  if (!decision) throw new Error('Saved-session recovery cart unavailable');
  const request = capture.decisionCardRequest(decision);
  const approvedItems = preconditions.decisionContext?.items;
  if (!approvedItems) return decisionCardRequestSchema.parse({
    ...request,
    context: { ...request.context, horizon: preconditions.decisionHorizon },
    validUntil: preconditions.decisionValidUntil,
  });
  const approvedById = new Map(approvedItems.map((item) => [item.id, item]));
  if (request.items.length !== approvedById.size || request.items.some((item) => !approvedById.has(item.id)))
    throw new Error('Captured decision cart changed');
  return decisionCardRequestSchema.parse({
    ...request,
    items: request.items.map((item) => {
      const approved = approvedById.get(item.id);
      if (!approved) throw new Error('Captured decision item unavailable');
      return { ...item, purchaseAt: approved.purchaseAt, requiredBy: approved.requiredBy };
    }),
    context: { ...request.context, horizon: preconditions.decisionHorizon },
    validUntil: preconditions.decisionValidUntil,
  });
}
function actualCaptureClockObservation(
  snapshot: FinancialSnapshot,
  observation: FinancialSnapshot['observations'][number],
): boolean {
  if (
    snapshot.source.ledgerBackend !== 'actual' ||
    !snapshot.sourceNormalizationVersion.startsWith('actual-normalizer/') ||
    observation.scope.kind !== 'account' ||
    observation.observedAt !== snapshot.capturedAt ||
    observation.contentHash !== undefined ||
    observation.version !== undefined ||
    observation.ledgerEffect !== undefined ||
    observation.evidence.length !== 1
  ) return false;
  const reference = observation.evidence[0];
  if (!reference?.authorized || reference.redaction !== 'visible') return false;
  switch (observation.kind) {
    case 'account_coverage':
    case 'account_type':
    case 'account_balance':
      return observation.state === 'complete' &&
        reference.kind === 'account' && reference.evidenceId === observation.scope.id;
    case 'pending_activity':
    case 'uncleared_activity':
      return observation.state === 'included' && reference.kind === 'transaction';
    default:
      return false;
  }
}
function resolvedEvidence(snapshot: FinancialSnapshot, capture: ConsequentialActionCapture): ConsequentialActionEvidence[] {
  const output = new Map<string, ConsequentialActionEvidence>();
  const add = (evidence: ConsequentialActionEvidence): void => {
    const prior = output.get(evidence.evidenceId);
    if (prior && prior.subjectId !== evidence.subjectId)
      throw new Error('Source evidence is bound to multiple subjects');
    if (!prior) output.set(evidence.evidenceId, evidence);
  };
  for (const observation of snapshot.observations) {
    if (observation.kind === 'economic_event_resolution' && observation.scope.kind === 'transaction') {
      if (
        observation.state !== 'resolved' || !observation.contentHash?.trim() ||
        !observation.version?.trim() || !observation.observedAt || !observation.ledgerEffect
      ) continue;
      for (const reference of observation.evidence) {
        if (
          reference.kind !== 'economic_event_resolution' || !reference.authorized || reference.redaction !== 'visible' ||
          !capture.projector.allowed('evidence', reference.evidenceId, 'source')
        ) continue;
        add({
          evidenceId: reference.evidenceId,
          subjectId: observation.scope.id,
          state: 'resolved',
          contentHash: observation.contentHash,
          version: observation.version,
        });
      }
      continue;
    }
    if (
      (observation.scope.kind !== 'account' && observation.scope.kind !== 'category') ||
      !capture.projector.allowed(observation.scope.kind, observation.scope.id, 'history')
    ) continue;
    for (const reference of observation.evidence) {
      if (!reference.authorized || reference.redaction !== 'visible') continue;
      const readable = reference.kind === 'bank_sync' ||
        (reference.kind === 'account' && observation.scope.kind === 'account' &&
          reference.evidenceId === observation.scope.id)
        ? capture.projector.allowed(observation.scope.kind, observation.scope.id, 'source')
        : capture.projector.allowed(
            'evidence',
            reference.evidenceId,
            reference.kind === 'transaction' ? 'ledger-effect'
              : reference.kind === 'receipt' ? 'raw-document'
                : reference.kind === 'normalized_receipt' ? 'normalized-evidence' : 'source',
          );
      if (!readable) continue;
      const observedAt = actualCaptureClockObservation(snapshot, observation)
        ? null
        : observation.observedAt;
      add({
        evidenceId: reference.evidenceId,
        subjectId: observation.scope.id,
        state: 'resolved',
        contentHash: hash({
          kind: observation.kind,
          scope: observation.scope,
          observedAt,
          state: observation.state,
          contentHash: observation.contentHash ?? null,
          version: observation.version ?? null,
          reference: {
            evidenceId: reference.evidenceId,
            kind: reference.kind,
            authorized: reference.authorized,
            redaction: reference.redaction,
          },
        }),
        ...(observation.version === undefined ? {} : { version: observation.version }),
      });
    }
  }
  return [...output.values()];
}
function economicEventForEvidence(
  snapshot: FinancialSnapshot,
  capture: ConsequentialActionCapture,
  evidenceId: string,
): { readonly subjectId: string; readonly effect: EconomicEventLedgerEffect } {
  const observations = snapshot.observations.filter((observation) =>
    observation.kind === 'economic_event_resolution' &&
    observation.scope.kind === 'transaction' &&
    observation.evidence.some((reference) => reference.evidenceId === evidenceId),
  );
  const observation = observations[0];
  const reference = observation?.evidence.find((entry) => entry.evidenceId === evidenceId);
  if (
    observations.length !== 1 || !observation || observation.scope.kind !== 'transaction' ||
    observation.state !== 'resolved' || !observation.observedAt ||
    !observation.contentHash?.trim() || !observation.version?.trim() || !observation.ledgerEffect ||
    !reference || reference.kind !== 'economic_event_resolution' ||
    !reference.authorized || reference.redaction !== 'visible' ||
    !capture.projector.allowed('evidence', evidenceId, 'source')
  ) throw new Error('Current resolved economic-event evidence unavailable');
  return { subjectId: observation.scope.id, effect: observation.ledgerEffect };
}
function sourceBoundAction(
  action: ConsequentialActionIntent,
  snapshot: FinancialSnapshot,
  capture: ConsequentialActionCapture,
): ConsequentialActionIntent {
  const bindAtom = (atom: ActionAtom): ActionAtom => {
    if (atom.kind !== 'evidence_projection') return atom;
    const events = atom.evidenceIds.map((id) => economicEventForEvidence(snapshot, capture, id));
    const source = events[0];
    if (!source || events.some((event) => canonical(event) !== canonical(source)))
      throw new Error('Evidence projection must bind one exact source economic event');
    const { effect } = source;
    const transaction = atom.transaction;
    if (
      transaction.accountId !== effect.accountId ||
      canonical(transaction.amount) !== canonical(effect.amount) ||
      transaction.date !== effect.date ||
      transaction.categoryId !== effect.categoryId ||
      transaction.payeeName !== effect.payeeName ||
      transaction.notes !== effect.notes ||
      canonical(transaction.splits) !== canonical(effect.splits)
    ) throw new Error('Proposed transaction differs from the source economic ledger effect');
    return {
      ...atom,
      transaction: {
        ...transaction,
        accountId: effect.accountId,
        amount: effect.amount,
        date: effect.date,
        categoryId: effect.categoryId,
        payeeName: effect.payeeName,
        notes: effect.notes,
        splits: effect.splits,
      },
    };
  };
  return action.kind === 'composite'
    ? { ...action, actions: action.actions.map(bindAtom) }
    : bindAtom(action);
}
function requireResolvedEvidence(action: ConsequentialActionIntent, evidence: readonly ConsequentialActionEvidence[]): void {
  const available = new Set(evidence.map((entry) => entry.evidenceId));
  for (const atom of atoms(action))
    if (atom.kind === 'evidence_projection')
      for (const evidenceId of atom.evidenceIds)
        if (!available.has(evidenceId)) throw new Error('Current resolved economic-event evidence unavailable');
}

function sourceLedger(
  snapshot: FinancialSnapshot,
  fallbackCurrencies: ReadonlyMap<string, string> = new Map(),
): Omit<ConsequentialActionLedger, 'wallets' | 'transfers'> {
  if (!['complete', 'empty'].includes(snapshot.coverage.transactions))
    throw new Error('Complete transaction coverage required');
  const accountFacts = new Map((snapshot.liquidity?.accounts ?? []).map((fact) => [fact.accountId, fact]));
  const accounts = snapshot.legacySnapshot.accounts.map((account) => {
    const fact = accountFacts.get(account.id);
    if (!fact || fact.balanceEvidence.state !== 'known')
      throw new Error('Current account currency and balance evidence required');
    const fallbackCurrency = fallbackCurrencies.get(account.id);
    const currency = fact.currencyEvidence.state === 'known' ? fact.currency : fallbackCurrency;
    if (
      !currency ||
      (fact.currencyEvidence.state !== 'known' &&
        (fact.currency !== currency || fact.recordedBalance.currency !== currency))
    ) throw new Error('Current account currency and balance evidence required');
    return {
      accountId: account.id,
      name: account.name,
      onBudget: !account.offBudget,
      closed: account.isClosed,
      currency,
      balance: fact.recordedBalance,
    };
  });
  const assignments = snapshot.legacySnapshot.budgets.flatMap((month) =>
    Object.values(month.categories).map((category) => ({
      categoryId: category.categoryId,
      asOfMonth: month.month,
      amount: category.amount,
    })),
  );
  const transactions = snapshot.legacySnapshot.transactions.map((transaction) => ({
    parentId: transaction.id,
    accountId: transaction.accountId,
    amount: transaction.amount,
    date: transaction.date,
    categoryId: transaction.categoryId,
    payeeName: transaction.payeeName,
    notes: transaction.notes,
    splits: transaction.subtransactions.map((split) => {
      if (!split.categoryId) throw new Error('Current transaction split category unavailable');
      return { categoryId: split.categoryId, amount: split.amount };
    }),
    transferAccountId: transaction.transferAccountId,
  }));
  return {
    accounts,
    categories: snapshot.legacySnapshot.categories.map(({ id }) => ({ categoryId: id })),
    assignments,
    transactions,
  };
}
type RecordedWallets = {
  readonly wallets: ConsequentialActionLedger['wallets'];
  readonly currencies: ReadonlyMap<string, string>;
};
function recordedWallets(
  proposals: readonly ActionProposal[],
  snapshot: FinancialSnapshot,
): RecordedWallets {
  const accounts = new Map(snapshot.legacySnapshot.accounts.map((account) => [account.id, account]));
  const wallets = new Map<string, { walletId: string; accountId: string }>();
  const currencies = new Map<string, string>();
  for (const proposal of proposals) {
    if (proposal.operation !== 'consequential_action') continue;
    const actionAtoms = atoms(proposal.payload.plan.action);
    for (const effect of proposal.state.effects) {
      const action = actionAtoms[effect.atomIndex];
      if (!action || action.kind !== 'wallet_materialization' || effect.actionKind !== action.kind) continue;
      const result = record(record(effect.result)?.result);
      if (
        result?.success !== true || result.verified !== true ||
        result.walletId !== action.walletId || typeof result.accountId !== 'string'
      ) continue;
      const actual = accounts.get(result.accountId);
      const fact = snapshot.liquidity?.accounts.find((value) => value.accountId === result.accountId);
      if (
        !actual || actual.name !== action.accountName || actual.offBudget || actual.isClosed ||
        !fact || fact.currency !== action.currency || fact.recordedBalance.minorUnits !== '0' ||
        fact.recordedBalance.currency !== action.currency
      ) continue;
      wallets.set(action.walletId, { walletId: action.walletId, accountId: result.accountId });
      currencies.set(result.accountId, action.currency);
    }
  }
  return { wallets: [...wallets.values()], currencies };
}
function postconditionCurrencyFallbacks(
  authorization: PostconditionAuthorization,
  proposals: readonly ActionProposal[],
  recorded: RecordedWallets,
): Map<string, string> {
  const currencies = new Map<string, string>();
  const invalidated = new Set(
    authorization.plan.source.invalidatedSupplementalFacts
      .filter((facts) => facts.fields.includes('currency') && facts.paths.includes('currencyEvidence'))
      .map((facts) => facts.accountId),
  );
  for (const observation of authorization.preconditions.supplemental?.observations ?? [])
    if (invalidated.has(observation.accountId) && observation.currency)
      currencies.set(observation.accountId, observation.currency);

  for (const proposal of proposals) {
    if (
      proposal.operation !== 'consequential_action' ||
      proposal.payload.plan.idempotencyKey !== authorization.plan.idempotencyKey
    ) continue;
    const actionAtoms = atoms(proposal.payload.plan.action);
    for (const effect of proposal.state.effects) {
      const action = actionAtoms[effect.atomIndex];
      if (!action || action.kind !== 'wallet_materialization' || effect.actionKind !== action.kind) continue;
      const result = record(record(effect.result)?.result);
      if (
        result?.success !== true || result.verified !== true || result.walletId !== action.walletId ||
        typeof result.accountId !== 'string'
      ) continue;
      if (
        recorded.wallets.some((wallet) =>
          wallet.walletId === action.walletId && wallet.accountId === result.accountId,
        ) &&
        recorded.currencies.get(result.accountId) === action.currency
      ) currencies.set(result.accountId, action.currency);
    }
  }
  return currencies;
}
function recordedTransfers(
  proposals: readonly ActionProposal[],
  snapshot: FinancialSnapshot,
  records: readonly TransferSettlementRecord[] | null,
): ConsequentialActionLedger['transfers'] {
  if (!records) return [];
  const rows = [...snapshot.legacySnapshot.transactions];
  const rawRows = new Map(records.map((entry) => [entry.id, entry]));
  const transfers = new Map<string, ConsequentialActionLedger['transfers'][number]>();
  for (const proposal of proposals) {
    if (proposal.operation !== 'consequential_action') continue;
    for (const [atomIndex, action] of atoms(proposal.payload.plan.action).entries()) {
      if (action.kind !== 'transfer') continue;
      const marker = `balanceframe:transfer:${action.transferId}:${action.correlationId}`;
      const sourceCandidates = rows.filter((row) =>
        row.accountId === action.sourceAccountId && row.transferAccountId === action.destinationAccountId &&
        row.date === action.date && row.amount.minorUnits === `-${action.amount.minorUnits}` &&
        row.amount.currency === action.amount.currency && row.notes === marker,
      );
      const destinationCandidates = rows.filter((row) =>
        row.accountId === action.destinationAccountId && row.transferAccountId === action.sourceAccountId &&
        row.date === action.date && row.amount.minorUnits === action.amount.minorUnits &&
        row.amount.currency === action.amount.currency && row.notes === marker,
      );
      if (sourceCandidates.length !== 1 || destinationCandidates.length !== 1) continue;
      const source = sourceCandidates[0]!;
      const destination = destinationCandidates[0]!;
      const sourceRecord = rawRows.get(source.id);
      const destinationRecord = rawRows.get(destination.id);
      const pairId = [source.id, destination.id].sort((left, right) => left.localeCompare(right)).join(':');
      if (
        !sourceRecord || !destinationRecord ||
        sourceRecord.provenance !== 'manual_ledger' || destinationRecord.provenance !== 'manual_ledger' ||
        sourceRecord.importedId !== null || destinationRecord.importedId !== null ||
        sourceRecord.pairId !== pairId || destinationRecord.pairId !== pairId ||
        sourceRecord.accountId !== source.accountId || destinationRecord.accountId !== destination.accountId ||
        sourceRecord.occurredAt !== action.date || destinationRecord.occurredAt !== action.date ||
        sourceRecord.amount.minorUnits !== source.amount.minorUnits ||
        destinationRecord.amount.minorUnits !== destination.amount.minorUnits ||
        sourceRecord.amount.currency !== action.amount.currency ||
        destinationRecord.amount.currency !== action.amount.currency
      ) continue;
      const effect = proposal.state.effects.find((entry) =>
        entry.atomIndex === atomIndex && entry.actionKind === 'transfer',
      );
      const observed = record(record(effect?.result)?.result);
      if (
        observed?.success === true &&
        (observed.transferId !== action.transferId ||
          observed.sourceTransactionId !== source.id ||
          observed.destinationTransactionId !== destination.id)
      ) continue;
      transfers.set(action.transferId, {
        transferId: action.transferId,
        correlationId: action.correlationId,
        marker,
        sourceTransactionId: source.id,
        destinationTransactionId: destination.id,
        sourceAccountId: action.sourceAccountId,
        destinationAccountId: action.destinationAccountId,
        amount: action.amount,
        date: action.date,
      });
    }
  }
  return [...transfers.values()];
}
function dispatchPrecondition(plan: ConsequentialActionPlan, atomIndex: number): ActionDispatchPrecondition {
  const precondition = plan.dispatchPreconditions.find((item) => item.atomIndex === atomIndex);
  if (!precondition) throw new Error('Native action dispatch precondition unavailable');
  return precondition;
}
function assignmentEffects(
  atom: Extract<ActionAtom, { kind: 'reallocation' }>,
  dispatch: ActionDispatchPrecondition,
): Array<{ categoryId: string; month: string; amount: number; expectedAmount: number; currency: string }> {
  const endpoints = new Set(atom.assignments.flatMap((assignment) => [
    `${assignment.sourceCategoryId}\0${assignment.sourceAsOfMonth}`,
    `${assignment.destinationCategoryId}\0${assignment.destinationAsOfMonth}`,
  ]));
  if (
    dispatch.accountBalances.length !== 0 || dispatch.assignments.length !== endpoints.size ||
    dispatch.assignments.some((assignment) => !endpoints.has(`${assignment.categoryId}\0${assignment.asOfMonth}`))
  ) throw new Error('Native assignment precondition endpoints do not match the action');
  const effects = dispatch.assignments.map((current) => {
    if (current.postAmount.currency !== current.amount.currency)
      throw new Error('Native assignment poststate currency changed');
    return {
      decreases: BigInt(current.postAmount.minorUnits) < BigInt(current.amount.minorUnits),
      effect: {
        categoryId: current.categoryId,
        month: current.asOfMonth,
        amount: moneyNumber(current.postAmount),
        expectedAmount: moneyNumber(current.amount),
        currency: current.amount.currency,
      },
    };
  });
  return effects
    .sort((left, right) => Number(right.decreases) - Number(left.decreases))
    .map(({ effect }) => effect);
}

export class ConsequentialActionService {
  private readonly clock: () => Date;
  constructor(private readonly options: ConsequentialActionServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async propose(actor: LiquidityActor, value: unknown): Promise<ConsequentialActionProposal> {
    const input = proposeInputSchema.parse(value);
    const now = this.clock().toISOString();
    const currentActor = this.currentActor(actor, now);
    this.requireAssistance(currentActor, 'propose');
    this.requireAction(currentActor, input.action, 'propose');
    const containsReallocation = atoms(input.action).some((atom) => atom.kind === 'reallocation');
    if (containsReallocation !== (input.decision !== undefined))
      throw new Error(containsReallocation
        ? 'Reallocation decision intent required'
        : 'Decision intent is only accepted for a reallocation');
    return this.options.liquidity.withConsequentialActionCapture(currentActor, async (capture) => {
      const action = sourceBoundAction(input.action, capture.snapshot, capture);
      this.requireAction(currentActor, action, 'propose');
      const decision = input.decision ?? null;
      const sessionCartBefore = decision && 'origin' in decision
        ? this.sessionCart(currentActor, decision, capture.now)
        : null;
      const debits = manualDebits(action, capture.now);
      const resolvedDecision = containsReallocation
        ? savedDecision(action, decision, this.options.store, currentActor, capture.now)
        : { accountId: null, items: debits };
      const decisionCardRequest = capture.decisionCardRequest(resolvedDecision);
      const actionEvidence = resolvedEvidence(capture.snapshot, capture);
      requireResolvedEvidence(action, actionEvidence);
      this.requirePrivateSource(currentActor, capture, action, actionEvidence);
      const ledger = await this.currentLedger(currentActor, capture.snapshot, capture.transferSettlementRecords);
      const sessionCart = decision && 'origin' in decision
        ? this.sessionCart(currentActor, decision, capture.now)
        : null;
      if (canonical(sessionCart) !== canonical(sessionCartBefore))
        throw new Error('Saved session changed during consequential capture');
      const recoveryDecision = sessionCart
        ? pinnedDecisionSchema.parse({
          ...sessionCart,
          items: decisionCardRequest.items.map(({ routeSelection, ...item }) => ({
            ...item,
            accountId: routeSelection.explicitAccountId,
          })),
        })
        : null;
      const policyVersion = financialPolicyVersion(capture);
      const policyHash = capture.policy?.policy.policyHash;
      if (!policyHash?.trim()) throw new Error('Current financial policy hash unavailable');
      const request: PlanConsequentialActionRequest = planConsequentialActionRequestSchema.parse({
        decisionCardRequest,
        intent: action,
        currentLedger: ledger,
        resolvedEvidence: actionEvidence,
        supplementalObservations: supplementalObservationProjections(capture),
        financialPolicyVersion: policyVersion,
        evaluatedAt: capture.now,
        idempotencyKey: randomUUID(),
      });
      const plan = consequentialActionPlanSchema.parse(
        JSON.parse(this.options.native.planConsequentialAction(JSON.stringify(request))) as unknown,
      );
      if (canonical(plan.action) !== canonical(action)) throw new Error('Native action intent changed');
      if (!SHA256.test(plan.actionHash) || Date.parse(plan.expiresAt) <= Date.parse(capture.now))
        throw new Error('Native action plan is invalid or expired');
      this.requireAction(currentActor, plan.action, 'propose');
      const supplemental = capture.supplemental === null ? null : jsonClone(capture.supplemental);
      const preconditions: ActionPreconditions = {
        version: 1,
        sourceReference: randomUUID(),
        nativeActionHash: plan.actionHash,
        nativeSource: plan.source,
        decisionCardPolicyHash: policyHash,
        financialApprovalPolicy: { version: policyVersion, policyHash },
        supplemental,
        supplementalHash: hash(supplemental),
        decision,
        sessionCart,
        recoveryDecision,
        sessionCartHash: sessionCart === null ? null : hash(sessionCart),
        decisionHorizon: decisionCardRequest.context.horizon,
        decisionValidUntil: decisionCardRequest.validUntil,
        decisionContext: capturedDecisionContext(decisionCardRequest),
      };
      const stored = storedPreconditionsSchema.parse(preconditions);
      const created = await this.options.store.createProposal({
        operation: 'consequential_action',
        budgetId: currentActor.budgetId,
        spaceId: currentActor.spaceId ?? this.requireSpace(currentActor),
        payload: { kind: 'consequential_action', plan },
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: canonicalProposalJson(stored),
        expiresAt: plan.expiresAt,
        actorId: currentActor.actorId,
        auth: this.requireAuth(currentActor),
        provenance: 'manual',
        correlationId: plan.idempotencyKey,
      });
      if (created.operation !== 'consequential_action') throw new Error('Consequential action proposal unavailable');
      try {
        const reads = this.options.store.getProposalApprovalReads({
          proposalIds: await this.disclosureCollectionIds(currentActor),
          spaceId: this.requireSpace(currentActor),
          actorId: currentActor.actorId,
          auth: this.requireAuth(currentActor),
          now: capture.now,
          privateProjection: 'detail',
        });
        const read = reads.find((entry) => entry.proposal.id === created.id);
        if (!read || read.proposal.operation !== 'consequential_action' || !read.summary.privateEnvelopeVisible)
          throw new Error('Current financial detail publication authority unavailable');
        return this.projectProposal(read.proposal, capture, read.summary);
      } catch (cause) {
        throw Object.assign(new ApplicationError({
          code: 'PROPOSAL_CREATED_DETAILS_WITHHELD',
          message: 'Proposal persisted; current financial details disclosure is unavailable',
          retryable: false,
        }), { cause });
      }
    });
  }
  async getProposal(actor: LiquidityActor, proposalId: string): Promise<ConsequentialActionProposal | null> {
    return (await this.getProposals(actor, [proposalId]))[0] ?? null;
  }
  async getProposals(actor: LiquidityActor, proposalIds: readonly string[]): Promise<ConsequentialActionProposal[]> {
    if (!proposalIds.length) return [];
    const requested = new Set(proposalIds);
    const currentActor = this.currentActor(actor, this.clock().toISOString());
    return this.options.liquidity.withConsequentialActionCapture(currentActor, async (capture) => {
      const current = this.currentActor(currentActor, capture.now);
      const reads = this.options.store.getProposalApprovalReads({
        proposalIds: await this.disclosureCollectionIds(current),
        spaceId: this.requireSpace(current),
        actorId: current.actorId,
        auth: this.requireAuth(current),
        now: capture.now,
        privateProjection: 'detail',
      });
      return reads.flatMap((read) =>
        requested.has(read.proposal.id) &&
        read.proposal.operation === 'consequential_action' &&
        read.summary.privateEnvelopeVisible
          ? [this.projectProposal(read.proposal, capture, read.summary)]
          : [],
      );
    });
  }
  // The detailed response must fit the same whole-collection limits as the proposal list.
  private async disclosureCollectionIds(actor: LiquidityActor): Promise<string[]> {
    const proposals = await this.options.store.listProposals({
      budgetId: actor.budgetId,
      operations: ['set_category', 'create_rule', 'update_rule', 'delete_rule', 'consequential_action'],
      superseded: false,
      limit: -1,
    });
    return proposals
      .filter((proposal) => proposal.spaceId === this.requireSpace(actor))
      .map((proposal) => proposal.id);
  }

  async execute(actor: LiquidityActor, proposalId: string): Promise<ConsequentialActionExecution> {
    const now = this.clock().toISOString();
    const initialActor = this.currentActor(actor, now);
    const stored = await this.options.store.getProposal(proposalId);
    if (!stored || stored.operation !== 'consequential_action' || stored.budgetId !== actor.budgetId)
      throw new Error('Consequential action proposal unavailable');
    const plan = stored.payload.plan;
    const action = plan.action;
    if (
      stored.state.phase === 'verified' ||
      stored.state.phase === 'invalidated_no_dispatch' ||
      stored.state.phase === 'review_required' ||
      stored.state.phase === 'write_intent'
    ) {
      // Recovery needs current action-read authority, not permission to publish its financial details.
      const [read] = this.options.store.getProposalApprovalReads({
        proposalIds: [stored.id],
        spaceId: this.requireSpace(initialActor),
        actorId: initialActor.actorId,
        auth: this.requireAuth(initialActor),
        now,
        privateProjection: 'detail',
      });
      if (
        !read ||
        !(
          read.summary.privateEnvelopeVisible ||
          read.summary.approvalAuthorized ||
          read.summary.executionAuthorized
        )
      ) throw new Error('Current consequential-action read authority required');
      if (stored.state.phase === 'verified' || stored.state.phase === 'invalidated_no_dispatch')
        return this.execution(stored.id, stored.state);
      const preconditions = this.parsePreconditions(stored.preconditions);
      this.requirePreconditionsForPlan(plan, preconditions);
      return this.recover(initialActor, stored, preconditions);
    }
    this.requireAssistance(initialActor, 'execute');
    this.requireAction(initialActor, action, 'execute', 'read');
    const storedPreconditions = JSON.parse(stored.preconditions) as unknown;
    const preconditions = this.parsePreconditions(storedPreconditions);
    this.requirePreconditionsForPlan(plan, preconditions);
    if (stored.state.phase !== 'approved') throw new Error('Approved consequential action required');
    const auth = this.requireHuman(initialActor);
    const serialisedEffect = JSON.stringify({
      operation: stored.operation,
      payload: stored.payload,
      preconditions: storedPreconditions,
    });
    const acquisition = await this.options.store.acquireProposalExecution({
      actorId: initialActor.actorId,
      proposalId: stored.id,
      payloadHash: stored.payloadHash,
      governancePolicyVersion: stored.governancePolicyVersion ?? '',
      idempotencyKey: plan.idempotencyKey,
      serialisedEffect,
      auth,
      now,
      correlationId: plan.idempotencyKey,
    });
    if (!acquisition.claim.isOwner) {
      const latest = await this.options.store.getProposal(stored.id);
      return latest?.operation === 'consequential_action'
        ? this.execution(latest.id, latest.state)
        : this.execution(stored.id, stored.state);
    }
    const acquisitionAuditId = acquisition.auditRecord?.id;
    if (!acquisitionAuditId) throw new Error('Acquired consequential action audit identity unavailable');
    const identity = {
      proposalId: stored.id,
      payloadHash: stored.payloadHash,
      actorId: initialActor.actorId,
      idempotencyKey: plan.idempotencyKey,
      acquisitionAuditId,
    };
    const acquired = {
      identity,
      serialisedEffect,
      auth,
      governancePolicyVersion: stored.governancePolicyVersion ?? '',
    };
    let dispatchCount = 0;
    let effectIndex = 0;
    try {
      await this.options.liquidity.withConsequentialActionCapture(
        initialActor,
        async (capture, connected) => {
          const actorNow = this.currentActor(initialActor, capture.now);
          this.requireAssistance(actorNow, 'execute');
          this.requireAction(actorNow, action, 'execute', 'read');
          requireCurrentSession(this.options.store, actorNow, preconditions, capture.now);
          this.requireSupplemental(preconditions, capture.supplemental);
          const ledger = await this.currentLedger(actorNow, capture.snapshot, capture.transferSettlementRecords);
          const evidence = resolvedEvidence(capture.snapshot, capture);
          requireResolvedEvidence(action, evidence);
          this.requirePrivateSource(actorNow, capture, action, evidence);
          const request = currentDecisionRequest(capture, action, preconditions, this.options.store, actorNow);
          const verificationRequest = verifyConsequentialActionRequestSchema.parse({
            plan,
            phase: 'preconditions',
            decisionCardRequest: request,
            currentLedger: ledger,
            resolvedEvidence: evidence,
            evaluatedAt: capture.now,
            financialPolicyVersion: financialPolicyVersion(capture),
          });
          const verification = nativeVerification(this.options.native, verificationRequest);
          if (!verification.valid)
            throw new Error(`Consequential action precondition failed: ${verification.reason}`);
          const assertExecutionCurrent = () => {
            this.assertAcquiredExecutionCurrent(
              initialActor, action, plan, preconditions, identity, serialisedEffect, auth,
              acquired.governancePolicyVersion,
            );
            dispatchCount += 1;
          };
          for (const [atomIndex, atom] of atoms(action).entries()) {
            let fenceCount = 0;
            let persistenceAttempted = false;
            let persisted = false;
            const persistEffect = async (result: unknown) => {
              if (persistenceAttempted) throw new Error('Consequential-action atom result already recorded');
              persistenceAttempted = true;
              await this.options.store.recordConsequentialActionEffect({
                ...identity,
                effectIndex,
                atomIndex,
                dispatchIndex: 0,
                result: { kind: atom.kind, atomIndex, dispatchIndex: 0, result },
              });
              effectIndex += 1;
              persisted = true;
            };
            const assertAtomCurrent = () => {
              assertExecutionCurrent();
              fenceCount += 1;
            };
            try {
              await this.dispatchAtom(
                atom, atomIndex, plan, ledger, connected, actorNow, assertAtomCurrent, persistEffect,
              );
            } catch (error) {
              if (!persistenceAttempted && fenceCount > 0)
                await persistEffect({ outcome: 'dispatch_outcome_unknown' });
              throw error;
            }
            if (!persisted) throw new Error('Consequential-action atom has no durable observed result');
          }
        },
        { mutation: true },
      );
    } catch (error) {
      if (dispatchCount === 0) {
        await this.invalidate(acquired, 0);
        throw error;
      }
      const observed = await this.readbackLedger(initialActor, { plan, preconditions });
      const state = await this.finalizeReview(acquired, error, observed);
      return this.execution(stored.id, state);
    }
    try {
      return await this.options.liquidity.withConsequentialActionCapture(
        initialActor,
        async (capture) => {
          const actorNow = this.currentActor(initialActor, capture.now);
          this.requireAssistance(actorNow, 'execute');
          this.requireAction(actorNow, action, 'execute', 'read');
          requireCurrentSession(this.options.store, actorNow, preconditions, capture.now);
          this.requireSupplemental(preconditions, capture.supplemental);
          const ledger = await this.currentLedger(
            actorNow, capture.snapshot, capture.transferSettlementRecords, { plan, preconditions },
          );
          const evidence = resolvedEvidence(capture.snapshot, capture);
          requireResolvedEvidence(action, evidence);
          this.requirePrivateSource(actorNow, capture, action, evidence);
          const verificationRequest = verifyConsequentialActionRequestSchema.parse({
            plan,
            phase: 'postconditions',
            decisionCardRequest: currentDecisionRequest(
              capture, action, preconditions, this.options.store, actorNow,
            ),
            currentLedger: ledger,
            resolvedEvidence: evidence,
            evaluatedAt: capture.now,
            financialPolicyVersion: financialPolicyVersion(capture),
          });
          const verification = nativeVerification(this.options.native, verificationRequest);
          if (!verification.valid)
            return this.execution(stored.id, await this.finalizeReview(
              acquired, verification.reason ?? 'postcondition_mismatch', ledger,
            ));
          this.assertAcquiredExecutionCurrent(
            initialActor, action, plan, preconditions, identity, serialisedEffect, auth,
            acquired.governancePolicyVersion,
          );
          const verificationToken = issueConsequentialActionVerificationToken({
            ...identity,
            verification,
            verifyRequest: verificationRequest,
            observedState: ledger,
          });
          const state = await this.options.store.finalizeConsequentialActionExecution({
            ...identity,
            outcome: { kind: 'verified', verificationToken },
          });
          return this.execution(stored.id, state);
        },
        { mutation: true },
      );
    } catch (error) {
      const observed = await this.readbackLedger(initialActor, { plan, preconditions });
      const state = await this.finalizeReview(acquired, error, observed);
      return this.execution(stored.id, state);
    }
  }

  private async dispatchAtom(
    atom: ActionAtom,
    atomIndex: number,
    plan: ConsequentialActionPlan,
    ledger: ConsequentialActionLedger,
    connected: ConnectedBudget,
    actor: LiquidityActor,
    assertExecutionCurrent: () => void,
    persistEffect: (result: unknown) => Promise<void>,
  ): Promise<void> {
    const writer = connected.connector as unknown as Pick<
      BudgetLedger,
      'setBudgetAmount' | 'createManualTransaction' | 'createWalletAccount' | 'createLedgerTransfer'
    >;
    switch (atom.kind) {
      case 'reallocation': {
        const dispatch = dispatchPrecondition(plan, atomIndex);
        const effects = assignmentEffects(atom, dispatch);
        const results: Array<Record<string, unknown>> = [];
        for (const effect of effects) {
          let fenced = false;
          const precondition: BudgetAssignmentPrecondition = {
            budgetId: actor.budgetId,
            expectedAmount: effect.expectedAmount,
            currency: effect.currency,
            assertExecutionCurrent: () => {
              assertExecutionCurrent();
              fenced = true;
            },
          };
          let result: BudgetAssignmentResult;
          try {
            result = await writer.setBudgetAmount(effect.month, effect.categoryId, effect.amount, precondition);
          } catch (error) {
            if (results.length || fenced)
              await persistEffect({
                status: 'partial',
                results,
                ...(fenced ? {
                  uncertainWrite: {
                    categoryId: effect.categoryId,
                    month: effect.month,
                    amount: effect.amount,
                    expectedAmount: effect.expectedAmount,
                  },
                } : {}),
              });
            throw error;
          }
          if (!result.success) {
            if (results.length || fenced) {
              results.push({
                categoryId: effect.categoryId,
                month: effect.month,
                amount: effect.amount,
                expectedAmount: effect.expectedAmount,
                result,
              });
              await persistEffect({ status: 'partial', results });
            }
            throw new Error(result.error);
          }
          results.push({
            categoryId: effect.categoryId,
            month: effect.month,
            amount: effect.amount,
            expectedAmount: effect.expectedAmount,
            result,
          });
        }
        await persistEffect({ status: 'complete', results });
        return;
      }
      case 'manual_transaction':
      case 'evidence_projection': {
        const transaction = atom.transaction;
        const input: ManualTransactionInput = {
          parentId: transaction.parentId,
          correlationId: transaction.correlationId,
          accountId: transaction.accountId,
          amount: moneyNumber(transaction.amount),
          date: transaction.date,
          ...(transaction.categoryId === null ? { categoryId: null } : { categoryId: transaction.categoryId }),
          ...(transaction.payeeName === null ? {} : { payeeName: transaction.payeeName }),
          ...(transaction.notes === null ? {} : { notes: transaction.notes }),
          ...(transaction.splits.length ? {
            splits: transaction.splits.map((split) => ({
              accountId: transaction.accountId,
              date: transaction.date,
              categoryId: split.categoryId,
              amount: moneyNumber(split.amount),
            })),
          } : {}),
        };
        let fenced = false;
        let result: ManualTransactionResult;
        try {
          result = await writer.createManualTransaction(input, {
            budgetId: actor.budgetId,
            assertExecutionCurrent: () => {
              assertExecutionCurrent();
              fenced = true;
            },
          });
        } catch (error) {
          if (fenced) await persistEffect({ outcome: 'dispatch_outcome_unknown' });
          throw error;
        }
        if (!result.success) {
          if (fenced) await persistEffect(result);
          throw new Error(result.error);
        }
        if (!fenced) throw new Error('Manual transaction returned success without crossing its dispatch fence');
        await persistEffect(result);
        return;
      }
      case 'wallet_materialization': {
        const input: WalletAccountInput = {
          walletId: atom.walletId,
          accountName: atom.accountName,
          currency: atom.currency,
        };
        let fenced = false;
        let result: WalletAccountResult;
        try {
          result = await writer.createWalletAccount(input, {
            budgetId: actor.budgetId,
            assertExecutionCurrent: () => {
              assertExecutionCurrent();
              fenced = true;
            },
          });
        } catch (error) {
          if (fenced) await persistEffect({ outcome: 'dispatch_outcome_unknown' });
          throw error;
        }
        if (!result.success) {
          if (fenced) await persistEffect(result);
          throw new Error(result.error);
        }
        if (!fenced) throw new Error('Wallet creation returned success without crossing its dispatch fence');
        await persistEffect(result);
        return;
      }
      case 'transfer': {
        const source = ledger.accounts.find((account) => account.accountId === atom.sourceAccountId);
        const destination = ledger.accounts.find((account) => account.accountId === atom.destinationAccountId);
        const dispatch = dispatchPrecondition(plan, atomIndex);
        const sourceBalance = dispatch.accountBalances.find((account) => account.accountId === atom.sourceAccountId);
        const destinationBalance = dispatch.accountBalances.find((account) => account.accountId === atom.destinationAccountId);
        if (
          !source || !destination || source.currency !== atom.amount.currency || destination.currency !== atom.amount.currency ||
          dispatch.accountBalances.length !== 2 || dispatch.assignments.length !== 0 ||
          !sourceBalance || !destinationBalance ||
          sourceBalance.balance.currency !== atom.amount.currency ||
          destinationBalance.balance.currency !== atom.amount.currency
        ) throw new Error('Transfer account source unavailable');
        const input: LedgerTransferInput = {
          transferId: atom.transferId,
          correlationId: atom.correlationId,
          sourceAccountId: atom.sourceAccountId,
          destinationAccountId: atom.destinationAccountId,
          amount: requirePositiveMoney(atom.amount),
          date: atom.date,
        };
        let fenced = false;
        let result: LedgerTransferResult;
        try {
          result = await writer.createLedgerTransfer(input, {
            budgetId: actor.budgetId,
            sourceBalance: moneyNumber(sourceBalance.balance),
            destinationBalance: moneyNumber(destinationBalance.balance),
            currency: atom.amount.currency,
            assertExecutionCurrent: () => {
              assertExecutionCurrent();
              fenced = true;
            },
          });
        } catch (error) {
          if (fenced) await persistEffect({ outcome: 'dispatch_outcome_unknown' });
          throw error;
        }
        if (!result.success) {
          if (fenced) await persistEffect(result);
          throw new Error(result.error);
        }
        if (!fenced) throw new Error('Transfer returned success without crossing its dispatch fence');
        await persistEffect(result);
        return;
      }
    }
  }

  private async currentLedger(
    actor: LiquidityActor,
    snapshot: FinancialSnapshot,
    transferSettlementRecords: readonly TransferSettlementRecord[] | null,
    authorization?: PostconditionAuthorization,
  ): Promise<ConsequentialActionLedger> {
    const proposals = await this.listActionProposals(actor.budgetId);
    const wallets = recordedWallets(proposals, snapshot);
    const fallbackCurrencies = authorization
      ? postconditionCurrencyFallbacks(authorization, proposals, wallets)
      : new Map<string, string>();
    return {
      ...sourceLedger(snapshot, fallbackCurrencies),
      wallets: wallets.wallets,
      transfers: recordedTransfers(proposals, snapshot, transferSettlementRecords),
    };
  }
  private async readbackLedger(
    actor: LiquidityActor,
    authorization: PostconditionAuthorization,
  ): Promise<ConsequentialActionLedger | null> {
    try {
      return await this.options.liquidity.withConsequentialActionCapture(
        actor,
        async (capture) => this.currentLedger(
          this.currentActor(actor, capture.now),
          capture.snapshot,
          capture.transferSettlementRecords,
          authorization,
        ),
        { mutation: true },
      );
    } catch {
      return null;
    }
  }
  private async listActionProposals(budgetId: string): Promise<ActionProposal[]> {
    const proposals: ActionProposal[] = [];
    for (let offset = 0; ; offset += 250) {
      const page = await this.options.store.listProposals({
        budgetId,
        operations: ['consequential_action'],
        limit: 250,
        offset,
      });
      proposals.push(...page);
      if (page.length < 250) return proposals;
    }
  }
  private sessionCart(actor: LiquidityActor, decision: ActionDecision, now: string): PinnedDecision {
    if (!('origin' in decision)) throw new Error('Saved session selector required');
    const session = this.options.store.liquidity.getSpendSession({
      ...actor,
      id: decision.origin.sessionId,
      now,
    });
    if (
      !session || session.version !== decision.origin.sessionVersion ||
      Date.parse(session.expiresAt) <= Date.parse(now)
    ) throw new Error('Saved session unavailable or changed');
    return pinnedDecisionSchema.parse(sessionCart(session));
  }
  private parsePreconditions(value: unknown): ActionPreconditions {
    const preconditions = storedPreconditionsSchema.parse(
      typeof value === 'string' ? JSON.parse(value) as unknown : value,
    ) as ActionPreconditions;
    if (hash(preconditions.supplemental) !== preconditions.supplementalHash)
      throw new Error('Stored supplemental source binding is invalid');
    const hasOrigin = preconditions.decision !== null && 'origin' in preconditions.decision;
    if (
      hasOrigin !== (preconditions.sessionCart !== null) ||
      hasOrigin !== (preconditions.recoveryDecision !== null) ||
      hasOrigin !== (preconditions.sessionCartHash !== null) ||
      (preconditions.sessionCart !== null && hash(preconditions.sessionCart) !== preconditions.sessionCartHash)
    ) throw new Error('Stored saved-session cart binding is invalid');
    return preconditions;
  }
  private requirePreconditionsForPlan(plan: ConsequentialActionPlan, preconditions: ActionPreconditions): void {
    const hasOrigin = preconditions.decision !== null && 'origin' in preconditions.decision;
    if (
      preconditions.nativeActionHash !== plan.actionHash ||
      canonical(preconditions.nativeSource) !== canonical(plan.source) ||
      preconditions.financialApprovalPolicy.version !== plan.source.financialPolicyVersion ||
      preconditions.decisionCardPolicyHash !== preconditions.financialApprovalPolicy.policyHash ||
      hasOrigin !== (preconditions.sessionCart !== null) ||
      hasOrigin !== (preconditions.recoveryDecision !== null) ||
      hasOrigin !== (preconditions.sessionCartHash !== null) ||
      (preconditions.sessionCart !== null && hash(preconditions.sessionCart) !== preconditions.sessionCartHash)
    ) throw new Error('Stored consequential-action source envelope is invalid');
  }
  private requireSupplemental(
    preconditions: ActionPreconditions,
    current: SupplementalFactsRecord | null,
  ): void {
    if (
      hash(current) !== preconditions.supplementalHash ||
      canonical(current) !== canonical(preconditions.supplemental)
    ) throw new Error('Supplemental source changed during consequential execution');
  }
  private assertAcquiredExecutionCurrent(
    actor: LiquidityActor,
    action: ConsequentialActionIntent,
    plan: ConsequentialActionPlan,
    preconditions: ActionPreconditions,
    identity: {
      readonly proposalId: string;
      readonly payloadHash: string;
      readonly actorId: string;
      readonly idempotencyKey: string;
      readonly acquisitionAuditId: string;
    },
    serialisedEffect: string,
    auth: NonNullable<LiquidityActor['auth']>,
    governancePolicyVersion: string,
  ): void {
    const now = this.clock().toISOString();
    const current = this.currentActor(actor, now);
    this.requireAssistance(current, 'execute');
    this.requireAction(current, action, 'execute', 'read');
    requireCurrentSession(this.options.store, current, preconditions, now);
    const policy = this.options.store.liquidity.getPolicy(current);
    if (
      !policy ||
      policy.policy.version !== plan.source.financialPolicyVersion ||
      policy.policy.policyHash !== preconditions.financialApprovalPolicy.policyHash ||
      policy.policy.policyHash !== preconditions.decisionCardPolicyHash
    ) throw new Error('Financial policy changed during consequential execution');
    const evaluation = this.options.store.liquidity.loadEvaluationState({ ...current, now });
    this.requireSupplemental(preconditions, evaluation.supplemental);
    if (evaluation.claimSet.revision !== plan.source.claimSetRevision)
      throw new Error('Liquidity claims changed during consequential execution');
    this.options.store.validateAcquiredProposalExecution({
      ...identity,
      governancePolicyVersion,
      serialisedEffect,
      auth,
    });
  }
  private currentActor(actor: LiquidityActor, now: string): LiquidityActor {
    const policy = this.governancePolicy(actor);
    if (!policy) throw new Error('Current governance policy unavailable');
    return { ...actor, governancePolicyVersion: policy.version, now };
  }
  private requireSpace(actor: LiquidityActor): string {
    if (!actor.spaceId) throw new Error('Current governance space unavailable');
    return actor.spaceId;
  }
  private governancePolicy(actor: LiquidityActor) {
    return this.options.store.governance.getPolicy({ spaceId: this.requireSpace(actor) });
  }
  private requireAssistance(actor: LiquidityActor, phase: 'propose' | 'execute'): void {
    const policy = this.governancePolicy(actor);
    const maximum = policy?.assistanceMaximum;
    const ceiling = typeof maximum === 'string' && Object.hasOwn(assistanceLevels, maximum)
      ? assistanceLevels[maximum as AssistanceMaximum]
      : assistanceLevels.analysis_only;
    if (ceiling < (phase === 'propose' ? 2 : 3))
      throw new Error('Governance assistance maximum does not permit this action');
  }
  private requireBudgetProposal(actor: LiquidityActor): void {
    this.options.store.liquidity.requireResource({
      ...actor,
      resourceKind: 'budget',
      resourceId: actor.budgetId,
      capability: 'proposal',
    });
  }
  private requireAction(
    actor: LiquidityActor,
    action: ConsequentialActionIntent,
    capabilityPhase: ActionPhase,
    authorizationPhase: ActionPhase | 'read' = capabilityPhase,
  ): void {
    for (const atom of atoms(action)) {
      const capability = actionCapability(atom.kind, capabilityPhase);
      for (const resource of actionResources(atom, actor.budgetId))
        this.options.store.liquidity.requireResource({
          ...actor, ...resource, capability, phase: authorizationPhase,
        });
    }
  }
  private requirePrivateSource(
    actor: LiquidityActor,
    capture: ConsequentialActionCapture,
    action: ConsequentialActionIntent,
    evidence: readonly ConsequentialActionEvidence[],
  ): void {
    for (const atom of atoms(action)) {
      if (atom.kind === 'reallocation') {
        for (const assignment of atom.assignments)
          for (const categoryId of [assignment.sourceCategoryId, assignment.destinationCategoryId])
            this.options.store.liquidity.requireResource({
              ...actor, resourceKind: 'category', resourceId: categoryId, capability: 'liquidity',
            });
      } else if (atom.kind === 'manual_transaction' || atom.kind === 'evidence_projection') {
        this.options.store.liquidity.requireResource({
          ...actor, resourceKind: 'account', resourceId: atom.transaction.accountId, capability: 'liquidity',
        });
        if (atom.transaction.categoryId)
          this.options.store.liquidity.requireResource({
            ...actor, resourceKind: 'category', resourceId: atom.transaction.categoryId, capability: 'liquidity',
          });
        for (const split of atom.transaction.splits)
          this.options.store.liquidity.requireResource({
            ...actor, resourceKind: 'category', resourceId: split.categoryId, capability: 'liquidity',
          });
        if (atom.kind === 'evidence_projection') {
          for (const evidenceId of atom.evidenceIds) {
            if (!evidence.some((entry) => entry.evidenceId === evidenceId))
              throw new Error('Current resolved economic-event evidence unavailable');
            this.options.store.liquidity.requireResource({
              ...actor, resourceKind: 'evidence', resourceId: evidenceId, capability: 'source',
            });
          }
        }
      } else if (atom.kind === 'transfer') {
        for (const accountId of [atom.sourceAccountId, atom.destinationAccountId])
          this.options.store.liquidity.requireResource({
            ...actor, resourceKind: 'account', resourceId: accountId, capability: 'balance',
          });
      }
    }
  }
  private requireAuth(actor: LiquidityActor) {
    const auth = actor.auth;
    if (!auth || auth.actorId !== actor.actorId) throw new Error('Authenticated action principal required');
    return auth;
  }
  private requireHuman(actor: LiquidityActor) {
    const auth = actor.auth;
    if (auth?.method !== 'human-session' || auth.actorId !== actor.actorId)
      throw new Error('Fresh human-session authorization required');
    return auth;
  }
  private projectProposal(
    proposal: StoredConsequentialActionProposal,
    capture: ConsequentialActionCapture,
    summary: ProposalApprovalSummary,
  ): ConsequentialActionProposal {
    const plan = jsonClone(proposal.payload.plan);
    const projectAtom = (atom: ActionAtom): ActionAtom => {
      if (atom.kind !== 'manual_transaction' && atom.kind !== 'evidence_projection') return atom;
      const visible = capture.projector.allowed('transaction', atom.transaction.parentId, 'history') &&
        capture.projector.allowed('account', atom.transaction.accountId, 'history');
      const transaction = {
        ...atom.transaction,
        ...(visible ? {} : { payeeName: null, notes: null }),
      };
      if (atom.kind === 'manual_transaction') return { ...atom, transaction };
      const evidenceIds = atom.evidenceIds.filter((id) => capture.projector.allowed('evidence', id, 'source'));
      return { ...atom, transaction, evidenceIds };
    };
    const action: ConsequentialActionIntent = plan.action.kind === 'composite'
      ? { ...plan.action, actions: plan.action.actions.map(projectAtom) }
      : projectAtom(plan.action);
    const evidenceReferences = plan.evidenceReferences
      .filter((evidence) => capture.projector.allowed('evidence', evidence.evidenceId, 'source'))
      .map(({ evidenceId, subjectId, state }) => ({ evidenceId, subjectId, state }));
    const impacts = plan.impacts.filter((impact) => {
      if (impact.kind === 'evidence_resolution') return capture.projector.allowed('evidence', impact.evidenceId, 'source');
      if (impact.kind === 'account_readiness' || impact.kind === 'payment_route' || impact.kind === 'transfer_need')
        return capture.projector.allowed('account', impact.accountId, 'liquidity');
      if (impact.kind === 'reservation_commitment')
        return capture.projector.allowed('category', impact.categoryId, 'liquidity');
      if (impact.kind === 'category_reallocation')
        return capture.projector.allowed('category', impact.sourceCategoryId, 'liquidity') &&
          capture.projector.allowed('category', impact.destinationCategoryId, 'liquidity');
      return true;
    });
    const actionAuthorized = (
      resourceKind: ResourceKind,
      resourceId: string,
      prefix: 'wallet_materialization' | 'transfer',
    ) => (['propose', 'approve', 'execute'] as const).some((phase) =>
      capture.projector.allowed(resourceKind, resourceId, `${prefix}:${phase}` as ResourceCapability),
    );
    const expectedPostconditions = plan.expectedPostconditions.filter((condition) => {
      if (condition.kind === 'account_balance')
        return capture.projector.allowed('account', condition.accountId, 'balance');
      if (condition.kind === 'assignment')
        return capture.projector.allowed('category', condition.categoryId, 'liquidity');
      if (condition.kind === 'transaction')
        return capture.projector.allowed('transaction', condition.parentId, 'history') &&
          capture.projector.allowed('account', condition.accountId, 'history');
      if (condition.kind === 'wallet_mapping')
        return actionAuthorized('wallet', condition.walletId, 'wallet_materialization');
      if (condition.kind === 'transfer_ledger_entry')
        return actionAuthorized('transfer', condition.transferId, 'transfer') &&
          actionAuthorized('account', condition.sourceAccountId, 'transfer') &&
          actionAuthorized('account', condition.destinationAccountId, 'transfer');
      return true;
    });
    const impactForReason: Record<ConsequentialActionPlan['reasonCodes'][number], ConsequentialActionPlan['impacts'][number]['kind']> = {
      safe_reallocation: 'category_reallocation',
      account_readiness: 'account_readiness',
      payment_route: 'payment_route',
      transfer_need: 'transfer_need',
      reservation_commitment: 'reservation_commitment',
      evidence_resolution: 'evidence_resolution',
    };
    const reasonCodes = plan.reasonCodes.filter((reason) =>
      impacts.some((impact) => impact.kind === impactForReason[reason]),
    );
    const preconditions = this.parsePreconditions(proposal.preconditions);
    const context = preconditions.decisionContext;
    const categoryVisible = (categoryId: string) =>
      capture.projector.allowed('category', categoryId, 'liquidity');
    const decisionContext = context === null ? null : {
      ...context,
      items: context.items
        .filter((item) => categoryVisible(item.categoryId))
        .map((item) => ({
          ...item,
          accountId: item.accountId !== null &&
            capture.projector.allowed('account', item.accountId, 'balance')
            ? item.accountId : null,
          ...(item.categoryAllocations === undefined ? {} : {
            categoryAllocations: item.categoryAllocations.filter((allocation) =>
              categoryVisible(allocation.categoryId),
            ),
          }),
        })),
      ...(context.adjustments === undefined ? {} : {
        adjustments: context.adjustments.filter((adjustment) => categoryVisible(adjustment.categoryId)),
      }),
      ...(context.warningThresholds === undefined ? {} : {
        warningThresholds: context.warningThresholds.filter((threshold) =>
          threshold.basis === 'cart_total' || categoryVisible(threshold.categoryId),
        ),
      }),
    };
    const publicSource: ConsequentialActionPublicSource = {
      snapshotReference: preconditions.sourceReference,
      policyVersion: plan.source.policyVersion,
      financialPolicyVersion: plan.source.financialPolicyVersion,
      claimSetRevision: plan.source.claimSetRevision,
    };
    const publicPlan: ConsequentialActionPublicPlan = {
      version: plan.version,
      action,
      evidenceReferences,
      expiresAt: plan.expiresAt,
      reasonCodes,
      impacts,
      expectedPostconditions,
      source: publicSource,
    };
    return {
      id: proposal.id,
      operation: 'consequential_action',
      budgetId: proposal.budgetId,
      spaceId: proposal.spaceId,
      policyVersion: proposal.policyVersion,
      requesterActorId: proposal.actorId,
      governancePolicyVersion: proposal.governancePolicyVersion,
      currentGovernancePolicyVersion: summary.currentGovernancePolicyVersion,
      payloadHash: proposal.payloadHash,
      financialPolicyVersion: plan.source.financialPolicyVersion,
      currentFinancialPolicyVersion: capture.policy?.policy.version ?? null,
      requiredApprovers: summary.requiredApprovers,
      decisionContext,
      expiresAt: proposal.expiresAt,
      supersededAt: proposal.supersededAt,
      createdAt: proposal.createdAt,
      version: proposal.version,
      payload: { kind: 'consequential_action', plan: publicPlan },
      state: {
        phase: proposal.state.phase,
        outcome: proposal.state.phase === 'review_required' ? 'review_required' : proposal.state.outcome,
      },
    };
  }
  private execution(id: string, state: ProposalState): ConsequentialActionExecution {
    return {
      id,
      phase: state.phase,
      outcome: state.phase === 'review_required' ? 'review_required' : state.outcome,
    };
  }
  private async invalidate(
    acquired: {
      identity: { proposalId: string; payloadHash: string; actorId: string; idempotencyKey: string; acquisitionAuditId: string };
    },
    dispatchCount: number,
  ): Promise<ConsequentialActionState> {
    if (dispatchCount !== 0) throw new Error('Cannot invalidate after adapter dispatch');
    const invalidationToken = issueConsequentialActionInvalidationToken({
      ...acquired.identity,
      dispatchCount: 0,
      staleWorkerFenced: true,
    });
    return this.options.store.finalizeConsequentialActionExecution({
      ...acquired.identity,
      outcome: { kind: 'invalidated_no_dispatch', invalidationToken },
    });
  }
  private async finalizeReview(
    acquired: {
      identity: { proposalId: string; payloadHash: string; actorId: string; idempotencyKey: string; acquisitionAuditId: string };
    },
    reason: unknown,
    observedState: unknown,
  ): Promise<ConsequentialActionState> {
    const message = reason instanceof Error ? reason.message : String(reason);
    return this.options.store.finalizeConsequentialActionExecution({
      ...acquired.identity,
      outcome: {
        kind: 'review_required',
        reason: message.slice(0, 512),
        ...(observedState === null ? {} : { observedState }),
      },
    });
  }
  private async recover(
    actor: LiquidityActor,
    proposal: StoredConsequentialActionProposal,
    preconditions: ActionPreconditions,
  ): Promise<ConsequentialActionExecution> {
    const acquisition = proposal.state.acquisition;
    if (
      !acquisition || actor.actorId !== acquisition.actorId ||
      Date.parse(this.clock().toISOString()) <= Date.parse(proposal.expiresAt)
    ) return this.execution(proposal.id, proposal.state);
    const identity = {
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: acquisition.actorId,
      idempotencyKey: acquisition.idempotencyKey,
      acquisitionAuditId: acquisition.acquisitionAuditId,
    };
    try {
      return await this.options.liquidity.withConsequentialActionCapture(actor, async (capture) => {
        const current = this.currentActor(actor, capture.now);
        const action = proposal.payload.plan.action;
        const ledger = await this.currentLedger(
          current, capture.snapshot, capture.transferSettlementRecords,
          { plan: proposal.payload.plan, preconditions },
        );
        const evidence = resolvedEvidence(capture.snapshot, capture);
        const verificationRequest = verifyConsequentialActionRequestSchema.parse({
          plan: proposal.payload.plan,
          phase: 'postconditions',
          decisionCardRequest: currentDecisionRequest(
            capture, action, preconditions, this.options.store, current, true,
          ),
          currentLedger: ledger,
          resolvedEvidence: evidence,
          evaluatedAt: capture.now,
          financialPolicyVersion: financialPolicyVersion(capture),
        });
        const verification = nativeVerification(this.options.native, verificationRequest);
        if (!verification.valid) return this.execution(proposal.id, proposal.state);
        const verificationToken = issueConsequentialActionVerificationToken({
          ...identity,
          verification,
          verifyRequest: verificationRequest,
          observedState: ledger,
        });
        const state = await this.options.store.finalizeConsequentialActionExecution({
          ...identity,
          outcome: { kind: 'verified', verificationToken },
        });
        return this.execution(proposal.id, state);
      });
    } catch {
      return this.execution(proposal.id, proposal.state);
    }
  }
}
export async function loadConsequentialActionNative(
  override?: () => Promise<NativeBindingShim>,
): Promise<ConsequentialActionNative> {
  const native = await loadNativeBindings(override);
  if (!native.planConsequentialAction || !native.verifyConsequentialAction)
    throw new Error('Native consequential-action capabilities unavailable');
  return {
    planConsequentialAction: (input) => native.planConsequentialAction!(input),
    verifyConsequentialAction: (input) => native.verifyConsequentialAction!(input),
  };
}

export interface ConsequentialActionCompositionOptions extends Omit<ConsequentialActionServiceOptions, 'native'> {
  nativeBindings?: () => Promise<NativeBindingShim>;
}

export async function createConsequentialActionService(
  options: ConsequentialActionCompositionOptions,
): Promise<ConsequentialActionService> {
  const { nativeBindings, ...dependencies } = options;
  return new ConsequentialActionService({
    ...dependencies,
    native: await loadConsequentialActionNative(nativeBindings),
  });
}
