import type {
  AccountRole,
  BudgetFundingStatus,
  CategoryPeriodKind,
  DecisionCard,
  DecisionCardCategoryPolicy,
  DecisionCardAdjustment,
  DecisionCardWarningThreshold,
  DecisionCardCategoryReallocationPath,
  DecisionCardConflict,
  DecisionCardItemOutcome,
  DecisionCardOpportunityCost,
  DecisionCardState,
  EvidenceReference,
  FactSource,
  FactState,
  LiquidityHorizon,
  Money,
  PaymentLiquidityStatus,
  AccountLiquidityPolicy,
  TransferTimingRoute,
} from '@balanceframe/protocol-generated';
import type {
  ResourceCapability,
  GovernedLiquidityPolicy,
  ResourceKind,
  TransferApprovalPolicy,
  TransferState,
  SpendSessionItem,
  UserAttestedLiquidityObservation,
} from '@balanceframe/workflow-store';

/** Financial detail on an authorized card, without internal evidence and integrity hashes. */
export interface PublicDecisionCardState
  extends Pick<DecisionCardState, 'categories' | 'goals' | 'obligations' | 'runway'> {
  accounts: Array<Omit<DecisionCardState['accounts'][number], 'deductions'> & {
    deductions: { reason: string; amount: Money; affectsBacking: boolean }[];
  }>;
  backing: {
    feasible: boolean;
    lines: { accountId: string; categoryId: string; cashBucketId: string; amount: Money }[];
    reasons: string[];
  };
}

export type PublicDecisionCardFundingPath =
  | (Pick<
      DecisionCard['fundingPaths'][number] & { kind: 'account_transfer' },
      'kind' | 'minimumAmount' | 'itemIds' | 'expiresAt'
    > & {
      legs: {
        sourceAccountId: string;
        destinationAccountId: string;
        amount: Money;
        requiredBy: string;
        estimatedArrival: string;
        sourceBefore: Money;
        destinationBefore: Money;
        sourceAfter: Money;
        destinationAfter: Money;
      }[];
    })
  | DecisionCardCategoryReallocationPath;

/** Allowlisted public response; restricted scopes receive only generic readiness. */
export interface PublicDecisionCard {
  outcome: DecisionCard['outcome'];
  budgetFundingStatus: BudgetFundingStatus;
  paymentLiquidityStatus: PaymentLiquidityStatus;
  selectedAccountId: string | null;
  before: PublicDecisionCardState | null;
  after: PublicDecisionCardState | null;
  fundingPaths: PublicDecisionCardFundingPath[];
  evidence: EvidenceReference[];
  blockers: string[];
  cart: DecisionCard['cart'];
  warnings: DecisionCard['warnings'];
  trimAlternatives: DecisionCard['trimAlternatives'];
  intentHash?: string;
  selectionSource?: string | null;
  opportunityCosts?: DecisionCardOpportunityCost[];
  conflicts?: DecisionCardConflict[];
  authorizationRequirements?: string[];
  reasons?: string[];
  assumptions?: string[];
  earliestExpiry?: string;
  expiresAt?: string;
  readiness?: DecisionCard['readiness'];
  items?: Array<Omit<DecisionCardItemOutcome, 'before' | 'after'> & {
    before: PublicDecisionCardState['accounts'][number] | null;
    after: PublicDecisionCardState['accounts'][number] | null;
  }>;
}

export interface PublicLiquidityAccount {
  id: string;
  name?: string;
  currency?: string;
  role?: AccountRole;
  balance?: Money;
  safeSpendingBefore?: Money;
  safeSpendingAfter?: Money;
  safeTransfer?: Money;
  backingCapacity?: Money;
  signedHeadroom?: Money;
  deductions?: { reason: string; amount: Money }[];
  quality?: {
    state: FactState;
    source: FactSource;
    observedAt: string | null;
    expiresAt: string | null;
    reasons: string[];
  }[];
  reasons: string[];
}
export interface PublicCategoryBacking {
  id: string;
  name?: string;
  availabilityBefore?: Money;
  availabilityAfter?: Money;
  feasible: boolean | null;
  backing: {
    accountId: string;
    accountName?: string;
    amount: Money;
    asOfMonth: string;
    periodKind: CategoryPeriodKind;
  }[];
  reasons: string[];
}
export interface PublicTransferConclusion {
  minimumAmount: Money;
  requiredBy: string;
  estimatedArrival?: string;
  authorizedHolderRequired: boolean;
}
export interface PublicPurchaseLiquidity {
  id: string;
  categoryId: string;
  amount: Money;
  selectedAccountId: string | null;
  routeOrigin: string | null;
  fundingStatus: BudgetFundingStatus | null;
  paymentStatus: PaymentLiquidityStatus | null;
  safeCapacityBefore?: Money;
  safeCapacityAfter?: Money;
  alternatives: { accountId: string; accountName?: string; status: PaymentLiquidityStatus }[];
  transfer: PublicTransferConclusion | null;
  credit?: {
    authorizationBefore?: Money;
    authorizationAfter?: Money;
    paymentAccountId?: string;
    paymentAccountName?: string;
    paymentDueAt: string;
    paymentCashStatus: PaymentLiquidityStatus;
  };
  reasons: string[];
  canPlanTransfer: boolean;
}
export interface PublicLiquidityView {
  evaluatedAt: string;
  horizon: LiquidityHorizon;
  expiresAt: string;
  snapshotId?: string;
  policyVersion?: string;
  fundingStatus: BudgetFundingStatus | null;
  paymentStatus: PaymentLiquidityStatus | null;
  reasons: string[];
  assumptions: string[];
  accounts: PublicLiquidityAccount[];
  categories: PublicCategoryBacking[];
  purchases: PublicPurchaseLiquidity[];
  canConfigure: boolean;
  canManageGrants: boolean;
  canCreateSession: boolean;
}
export interface PublicTransferPlan {
  minimumAmount: Money;
  requiredBy: string;
  estimatedArrival: string;
  expiresAt: string;
  snapshotId: string;
  policyVersion: string;
  legs: {
    sourceAccountId: string;
    sourceAccountName?: string;
    destinationAccountId: string;
    destinationAccountName?: string;
    amount: Money;
    sourceCapacityBefore: Money;
    sourceCapacityAfter: Money;
    destinationCapacityBefore: Money;
    destinationCapacityAfter: Money;
  }[];
  reasons: string[];
  assumptions: string[];
}
export interface PublicTransferPreview {
  previewId: string;
  payloadHash: string;
  plan: PublicTransferPlan;
}
export interface PublicTransferDetail {
  id: string;
  version: number;
  payloadHash?: string;
  phase: TransferState['phase'];
  sourceObserved: boolean;
  destinationObserved: boolean;
  reconciled: boolean;
  outcome: TransferState['outcome'];
  requiredApprovals: number;
  approvalCount: number;
  plan: PublicTransferPlan | null;
  conclusion: PublicTransferConclusion | null;
  canApprove: boolean;
  canGetInstructions: boolean;
  canReportInitiated: boolean;
  canReconcile: boolean;
  canCancel: boolean;
  instructionsAvailable: boolean;
  reasons: string[];
}
export interface PublicSpendSession {
  id: string;
  version: number;
  accountId: string | null;
  expiresAt: string;
  createdAt: string;
  items: SpendSessionItem[];
  adjustments: DecisionCardAdjustment[];
  warningThresholds: DecisionCardWarningThreshold[];
  card: PublicDecisionCard;
  canEdit: boolean;
  linkedTransfers: {
    id: string;
    phase: TransferState['phase'];
    outcome: TransferState['outcome'];
  }[];
}
/** Scoped, server-approved view of one immutable session-completion proposal. */
export interface PublicSessionCompletion {
  id: string;
  version: number;
  phase: 'proposed' | 'approved' | 'write_intent' | 'verified' | 'review_required' | 'closed';
  outcome: string | null;
  expiresAt: string;
  cooldownUntil: string | null;
  payloadHash: string | null;
  requiredApprovals: number;
  approvalCount: number;
  canApprove: boolean;
  canExecute: boolean;
  debit: {
    accountId: string;
    amount: number;
    date: string;
    payeeName: string | null;
    notes: string | null;
    categoryCharges: { categoryId: string; amount: Money }[];
    splits: { categoryId: string; amount: number }[];
  } | null;
  manualTransactionId: string | null;
  importedTransactionId: string | null;
  reviewRequired: boolean;
}
export type PublicUserAttestedObservation = Omit<
  UserAttestedLiquidityObservation,
  'observedAt' | 'expiresAt' | 'ledgerConfirmationHash'
>;
export interface PublicLiquidityConfiguration {
  policy: GovernedLiquidityPolicy | null;
  approvalPolicy: TransferApprovalPolicy | null;
  observationVersion: number;
  observations: PublicUserAttestedObservation[];
  observationsExpiresAt: string | null;
  accounts: PublicLiquidityAccount[];
  categories: PublicCategoryBacking[];
  canConfigure: boolean;
}
export interface PublicLiquidityPolicyInput {
  expectedVersion: string | null;
  expiresAt: string;
  reservationMode?: 'inform' | 'block';
  accounts: Omit<AccountLiquidityPolicy, 'resourceScope'>[];
  transferRoutes: Omit<TransferTimingRoute, 'evidence'>[];
  categoryPolicies?: (DecisionCardCategoryPolicy & { cooldownMinutes?: number })[];
  approvalPolicy: TransferApprovalPolicy;
}
export interface PublicLiquidityObservationInput {
  expectedVersion: number;
  expiresAt: string;
  observations: PublicUserAttestedObservation[];
}
export interface PublicLiquidityGrant {
  actorId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  capability: ResourceCapability;
  granted: boolean;
}
export interface PublicLiquidityGrants {
  members: { actorId: string }[];
  resources: { resourceKind: ResourceKind; resourceId: string; name?: string }[];
  capabilities: ResourceCapability[];
  grants: PublicLiquidityGrant[];
}
export interface PublicLiquidityPreference {
  id: string;
  version: number;
  categoryId: string;
  accountId: string;
  expiresAt: string;
}
export interface PublicLiquidityPreferences {
  items: PublicLiquidityPreference[];
  canManage: boolean;
}
