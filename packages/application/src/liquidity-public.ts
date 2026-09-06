import type {
  AccountRole,
  BudgetFundingStatus,
  CategoryPeriodKind,
  FactSource,
  FactState,
  LiquidityHorizon,
  Money,
  PaymentLiquidityStatus,
  AccountLiquidityPolicy,
  TransferTimingRoute,
  LiquidityPolicy,
} from '@balanceframe/protocol-generated';
import type {
  ResourceCapability,
  ResourceKind,
  TransferApprovalPolicy,
  TransferState,
  UserAttestedLiquidityObservation,
} from '@balanceframe/workflow-store';

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
export interface PublicSpendSessionItem {
  id: string;
  categoryId: string;
  amount: Money;
  purchaseAt: string;
  requiredBy: string;
  accountId: string | null;
}
export interface PublicSpendSession {
  id: string;
  version: number;
  accountId: string | null;
  expiresAt: string;
  createdAt: string;
  items: PublicSpendSessionItem[];
  evaluation: PublicLiquidityView;
  canEdit: boolean;
  linkedTransfers: {
    id: string;
    phase: TransferState['phase'];
    outcome: TransferState['outcome'];
  }[];
}
export type PublicUserAttestedObservation = Omit<
  UserAttestedLiquidityObservation,
  'observedAt' | 'expiresAt' | 'ledgerConfirmationHash'
>;
export interface PublicLiquidityConfiguration {
  policy: LiquidityPolicy | null;
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
  accounts: Omit<AccountLiquidityPolicy, 'resourceScope'>[];
  transferRoutes: Omit<TransferTimingRoute, 'evidence'>[];
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
