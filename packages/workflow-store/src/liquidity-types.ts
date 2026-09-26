import type {
  AccountLiquidityFact,
  BackingAllocation,
  DecisionCardAdjustment,
  DecisionCardCategoryPolicy,
  DecisionCardItem,
  DecisionCardPriceProvenance,
  DecisionCardPriority,
  DecisionCardWarningThreshold,
  LiquidityClaimBundle,
  LiquidityClaimSet,
  LiquidityFacts,
  LiquidityPolicy,
  LiquidityPurchaseItem,
  ProspectiveClaim,
  TransferPlan,
  TransferSettlementResult,
  TrustedRoute,
} from '@balanceframe/protocol-generated';
import type { ActionProposal, SessionCompletionPayload, SessionCompletionProposal } from './types.js';

export type ResourceCapability =
  | 'conclusion'
  | 'existence'
  | 'name'
  | 'balance'
  | 'history'
  | 'liquidity'
  | 'source'
  | 'category'
  | 'proposal'
  | 'approval'
  | 'initiation-report'
  | 'confirmation'
  | 'audit'
  | 'policy'
  | 'session'
  | 'full-read';
export type ResourceKind = 'budget' | 'account' | 'category' | 'session';
export interface ResourceRef {
  resourceKind: ResourceKind;
  resourceId: string;
}
export interface LiquidityActor {
  actorId: string;
  budgetId: string;
}
export interface ResourceGrant extends LiquidityActor, ResourceRef {
  capability: ResourceCapability;
  granted: boolean;
  now: string;
}
export interface TransferState {
  phase: 'proposed' | 'awaiting_approval' | 'approved' | 'initiated' | 'confirmed' | 'closed';
  sourceObserved: boolean;
  destinationObserved: boolean;
  reconciled: boolean;
  outcome:
    | null
    | 'expired'
    | 'superseded'
    | 'cancelled'
    | 'source_insufficient'
    | 'delayed'
    | 'amount_mismatch'
    | 'duplicate_candidate'
    | 'reconciliation_required';
}
export interface TransferApprovalPolicy {
  minimumApprovers: number;
  thresholds?: Array<{ minimumMinorUnits: string; currency: string; minimumApprovers: number }>;
}
export type ProspectiveClaimMode = 'inform' | 'block';
/** Workflow policy may govern whether reservations inform or block competing decisions. */
export type GovernedCategoryPolicy = DecisionCardCategoryPolicy & {
  cooldownMinutes?: number;
};
export type GovernedLiquidityPolicy = LiquidityPolicy & {
  reservationMode?: ProspectiveClaimMode;
  categoryPolicies?: GovernedCategoryPolicy[];
};

export interface LiquidityPolicyRecord {
  budgetId: string;
  policy: GovernedLiquidityPolicy;
  approvalPolicy: TransferApprovalPolicy;
  createdAt: string;
  actorId: string;
}
/**
 * Editable session intent. Unlike the canonical DecisionCard item, this wire
 * shape stores only user input and the selected account; route alternatives are
 * resolved when a card is evaluated.
 */
export type SpendSessionItem = Omit<
  DecisionCardItem,
  'routeSelection' | 'priority' | 'priceProvenance'
> & {
  accountId: string | null;
  priority?: DecisionCardPriority;
  priceProvenance?: DecisionCardPriceProvenance | null;
};
/** Pre-8.6 normalized items remain accepted for replay and migration. */
export type SpendSessionItemInput = SpendSessionItem | LiquidityPurchaseItem;
export interface SpendSession extends LiquidityActor {
  id: string;
  version: number;
  items: SpendSessionItem[];
  adjustments?: DecisionCardAdjustment[];
  warningThresholds?: DecisionCardWarningThreshold[];
  accountId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
export type ProspectiveClaimLifecycle = 'active' | 'released' | 'consumed' | 'expired';
export type ValidatedClaimBundle = LiquidityClaimBundle & {
  mode?: ProspectiveClaimMode;
};
export type VisibleStoredProspectiveClaim = ProspectiveClaim & {
  mode: ProspectiveClaimMode;
  lifecycleState: ProspectiveClaimLifecycle;
};
export type RedactedProspectiveScope =
  { kind: 'category'; id: null } | { kind: 'account'; id: null };
export type RedactedStoredProspectiveClaim = Omit<
  ProspectiveClaim,
  'claimId' | 'sourceId' | 'scope' | 'amount' | 'visibility' | 'policyVersion' | 'snapshotId'
> & {
  claimId: null;
  sourceId: null;
  scope: RedactedProspectiveScope;
  amount: null;
  visibility: 'redacted';
  policyVersion: null;
  snapshotId: null;
  mode: ProspectiveClaimMode;
  lifecycleState: ProspectiveClaimLifecycle;
};
export type StoredProspectiveClaim = VisibleStoredProspectiveClaim | RedactedStoredProspectiveClaim;
export interface SaveProspectiveClaimInput extends LiquidityActor {
  claim: ProspectiveClaim & { mode?: ProspectiveClaimMode };
  expectedClaimSetRevision: string;
  idempotencyKey: string;
  now: string;
}
export interface TransitionProspectiveClaimInput extends LiquidityActor {
  claimId: string;
  transition: 'release' | 'consume';
  expectedClaimSetRevision: string;
  idempotencyKey: string;
  now: string;
  /** Opaque evidence identity supplied only after trusted native verification. */
  consumptionEvidenceId?: string;
}
export interface ProspectiveClaimConsumptionContext extends LiquidityActor {
  claim: ProspectiveClaim;
  evidenceId: string;
  /** Previously consumed canonical evidence identities in this budget. */
  consumedEvidenceIds: string[];
  now: string;
}
/** Trusted synchronous service verifier for a verified ledger postcondition. */
export type ProspectiveClaimConsumptionVerifier = (context: ProspectiveClaimConsumptionContext) => {
  valid: boolean;
  reason?: string;
};
export interface ClaimValidationContext {
  ownClaimId: string | null;
  budgetId: string;
  claimSet: LiquidityClaimSet;
  plan: TransferPlan | null;
  session: SpendSession | null;
  proposedClaim: ValidatedClaimBundle | null;
  policy: LiquidityPolicyRecord;
  now: string;
}
/**
 * Trusted synchronous native evaluation, never an HTTP-supplied result.
 * Invalid financial preconditions gate admission, approval and instructions; an authorized
 * report of an already-initiated external action retains them as diagnostic evidence and holds cash.
 */
export type ClaimValidator = (context: ClaimValidationContext) => {
  valid: boolean;
  reason?: string;
};
export interface AdmitTransferInput extends LiquidityActor {
  plan: TransferPlan;
  expectedClaimSetRevision: string;
  idempotencyKey: string;
  now: string;
  sessionId?: string;
}
export interface TransferCommand extends LiquidityActor {
  proposalId: string;
  payloadHash: string;
  expectedVersion: number;
  idempotencyKey: string;
  now: string;
}
export interface RecheckTransferCommand extends TransferCommand {
  expectedClaimSetRevision: string;
}
export type SessionCompletionApprovalStatus =
  | 'none'
  | 'active'
  | 'consumed'
  | 'expired'
  | 'superseded';
export type SessionCompletionProposalView = SessionCompletionProposal & {
  readonly approvalId: string | null;
  readonly approvalCount: number;
  readonly requiredApprovals: number;
  readonly approvalStatus: SessionCompletionApprovalStatus;
  readonly manualTransactionId: string | null;
  readonly importedTransactionId: string | null;
  readonly reconciliation: SessionCompletionReconciliation | null;
};
export interface AdmitSessionCompletionInput extends LiquidityActor {
  sessionId: string;
  expectedSessionVersion: number;
  payload: SessionCompletionPayload;
  payloadHash: string;
  claim: LiquidityClaimBundle;
  expectedClaimSetRevision: string;
  idempotencyKey: string;
  now: string;
}
export interface SessionCompletionCommand extends LiquidityActor {
  proposalId: string;
  payloadHash: string;
  expectedVersion: number;
  expectedClaimSetRevision: string;
  idempotencyKey: string;
  now: string;
}
export type ApproveSessionCompletionInput = SessionCompletionCommand;
export type BeginSessionCompletionWriteInput = SessionCompletionCommand;
export interface SessionCompletionWriteResult {
  readonly success: boolean;
  readonly verified: boolean;
  readonly parentId: string;
  readonly transactionId?: string;
  readonly code?: string;
  readonly reviewRequired?: boolean;
  readonly evidenceId?: string;
}
export interface FinishSessionCompletionWriteInput extends LiquidityActor {
  proposalId: string;
  payloadHash: string;
  expectedVersion: number;
  idempotencyKey: string;
  now: string;
  result: SessionCompletionWriteResult;
}
export type SessionCompletionEvidenceKind = 'manual_parent' | 'imported_link' | 'ambiguous';
export interface SessionCompletionReconciliation {
  readonly evidenceId: string;
  readonly kind: SessionCompletionEvidenceKind;
  readonly parentId: string;
  readonly accountId: string;
  readonly transactionId?: string;
  readonly verified: boolean;
  readonly reason?: string;
}
export interface ReconcileSessionCompletionInput extends SessionCompletionCommand {
  readonly evidence: SessionCompletionReconciliation;
}
export type SessionCompletionWriteIntentResult = {
  readonly proposal: SessionCompletionProposalView;
  readonly payload: SessionCompletionPayload | null;
  readonly acquiredWriteIntent: boolean;
};
export interface SettlementVerificationContext {
  plan: TransferPlan;
  evaluatedAt: string;
  consumedEvidenceIds: string[];
  previousEvidenceIds: string[];
}
/** Only the service holding the native verifier may supply this callback; it runs inside the transaction. */
export type SettlementVerifier = (
  context: SettlementVerificationContext,
) => TransferSettlementResult;
export interface SaveSpendSessionInput extends LiquidityActor {
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
  now: string;
  expiresAt: string;
  accountId: string | null;
  items: SpendSessionItemInput[];
  adjustments?: DecisionCardAdjustment[];
  warningThresholds?: DecisionCardWarningThreshold[];
  claim?: LiquidityClaimBundle;
  expectedClaimSetRevision?: string;
}
export interface SavePolicyInput extends LiquidityActor {
  expectedVersion: string | null;
  now: string;
  policy: GovernedLiquidityPolicy;
  approvalPolicy: TransferApprovalPolicy;
}
export type UserAttestedLiquidityObservation = Pick<AccountLiquidityFact, 'accountId'> &
  Partial<
    Pick<
      AccountLiquidityFact,
      'currency' | 'kind' | 'owned' | 'holds' | 'unsettledFlows' | 'obligations'
    >
  > & {
    observedAt: string;
    expiresAt: string;
    currentLedgerConfirmed?: true;
    ledgerConfirmationHash?: string;
    credit?: Omit<NonNullable<AccountLiquidityFact['credit']>, 'evidence'> | null;
  };
export interface SupplementalFactsRecord extends LiquidityActor {
  version: number;
  observations: UserAttestedLiquidityObservation[];
  expiresAt: string;
  createdAt: string;
}
export interface PaymentPreferenceRecord extends LiquidityActor {
  id: string;
  version: number;
  categoryId: string;
  route: TrustedRoute;
  expiresAt: string;
  approvedBy: string;
  createdAt: string;
}
export type TransferProposal = Extract<ActionProposal, { operation: 'transfer' }>;
export type {
  BackingAllocation,
  LiquidityClaimBundle,
  LiquidityClaimSet,
  LiquidityFacts,
  LiquidityPolicy,
  LiquidityPurchaseItem,
  ProspectiveClaim,
  TransferPlan,
  TransferSettlementResult,
  TrustedRoute,
};

export interface TransferPreview extends LiquidityActor {
  readonly id: string;
  readonly plan: TransferPlan;
  readonly createdAt: string;
  readonly sessionId: string | null;
  readonly sessionVersion: number | null;
}
export interface SaveTransferPreviewInput extends LiquidityActor {
  readonly id?: string;
  readonly plan: TransferPlan;
  readonly now: string;
  readonly sessionId?: string;
  readonly sessionVersion?: number;
}
