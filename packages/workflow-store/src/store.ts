/**
 * SQLite-backed {@link WorkflowStore} implementation.
 *
 * Uses better-sqlite3 synchronously (the idiomatic Node binding) and wraps
 * results in Promises for interface compatibility.
 *
 * Schema determinism:
 * - All IDs are UUID v4 (via `crypto.randomUUID()`).
 * - Timestamps are ISO 8601 UTC strings.
 * - The `payload` field is stored as JSON text.
 */

import Database from 'better-sqlite3';
import { LiquidityWorkflow } from './liquidity.js';
import { SpaceGovernance, migrateGovernance } from './governance.js';
import { migrateScopedInvitations } from './scoped-invitations.js';
import { migrateNotificationGovernance } from './notification-governance.js';
import {
  migrateLiquidityWorkflow,
  migrateTransferPreviews,
  migrateSessionCompletion,
  migrateScopedProspectiveEffects,
} from './liquidity-migration.js';
import {
  canonicalProposalHash,
  canonicalProposalJson,
  deriveProposalAuthorizationFacts,
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
  requiredProposalApprovers,
} from './proposal.js';
import type { ProposalAuthorizationFacts } from './proposal.js';
import type {
  AcquireProposalExecutionInput,
  GetProposalApprovalSummaryInput,
  DiscardProposalAuthorization,
  GenericActionProposal,
  GenericProposalOperation,
  CategoryActionPayload,
  CreateIdempotencyInput,
  ProposalApprovalSummary,
  ProposalExecutionAcquisition,
  RuleActionPayload,
} from './types.js';
import type {
  GovernanceOperation,
  GovernanceResourceKind,
  GovernanceResourceRef,
  OperationalAuth,
  HumanControlContext,
} from './governance-types.js';
import { migrateProposalApprovals, migrateProposalOrigins } from './proposal-migration.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

import type {
  Suggestion,
  SaveSuggestionInput,
  CandidateJob,
  JobStatus,
  FailureRecord,
  EnqueueJobInput,
  WorkflowStore,
  GetRuleOverrideInput,
  RuleOverride,
  RuleOverrideScope,
  SetRuleOverrideInput,
  RemoveRuleOverrideInput,
  ReviewItem,
  ReviewStatus,
  ReviewAction,
  ReviewListOptions,
  TransitionReviewInput,
  AuthorizedReviewTransitionInput,
  ReviewActionAuthorization,
  CreateReviewItemInput,
  TransitionReviewResult,
  ActionProposal,
  ProposalOperation,
  ApprovalStatus,
  ProposalApproval,
  IdempotencyClaim,
  IdempotencyStatus,
  IdempotencyRecord,
  AuditRecord,
  AuditClassification,
  CreateProposalInput,
  CreateApprovalInput,
  CreateApprovalsInput,
  AppendAuditInput,
  ListProposalsOptions,
  AuthorizationDisposition,
  AuthorizationResult,
  MembershipStatus,
  CorrectionRecord,
  CorrectionConflict,
  CorrectionHistoryOptions,
  RegistrationState,
  RegistrationMode,
  BootstrapClaimInput,
  BootstrapClaimResult,
  FinalizeBootstrapInput,
  FinalizeBootstrapResult,
  InvitationStatus,
  Invitation,
  InvitationMetadata,
  InvitationControlInput,
  CreateInvitationResult,
  ClaimInvitationInput,
  ClaimInvitationResult,
  CreateNotificationEventInput,
  CreateOrGetNotificationEventInput,
  CreateReportRecordInput,
  CreateSavedFilterInput,
  CreateSavedViewInput,
  DeliveryAttempt,
  DeliveryAttemptStatus,
  EnqueueNotificationInput,
  NotificationEvent,
  NotificationOutboxRecord,
  OutboxStatus,
  PolicyVersion,
  RecordPolicyVersionInput,
  ReportListOptions,
  ReportRecord,
  SavedFilter,
  SavedFilterListOptions,
  SavedViewResult,
  SavedViewAuthority,
  UpdateSavedFilterInput,
  // Phase 8.5 types
  Finding,
  FindingStatus,
  CreateFindingInput,
  AcknowledgeFindingInput,
  CorrectFindingInput,
  DismissFindingInput,
  ReopenFindingInput,
  SupersedeFindingInput,
  ListFindingsOptions,
  UpdateSavedViewInput,
  DuplicateSavedViewInput,
  NotificationPolicyRecord,
  SaveNotificationPolicyInput,
  RecipientResolution,
  ListNotificationPoliciesOptions,
  ListOutboxRecordsOptions,
  ReportHistoryEntry,
  LifecycleScope,
} from './types.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current UTC time as ISO-8601 string. */
function nowISO(): string {
  return new Date().toISOString();
}

function isGenericProposalOperation(operation: string): operation is GenericProposalOperation {
  return operation === 'set_category' ||
    operation === 'create_rule' ||
    operation === 'update_rule' ||
    operation === 'delete_rule';
}

/** Returns true if the ISO-8601 string is invalid or represents a moment <= now. */
function isExpired(isoString: string): boolean {
  const parsed = new Date(isoString);
  return isNaN(parsed.getTime()) || parsed <= new Date();
}

function timestampMillis(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Map a raw DB row to a typed Suggestion. */
function rowToSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    budgetId: row.budget_id,
    transactionId: row.transaction_id,
    categoryId: row.category_id,
    classifier: row.classifier,
    promptVersion: row.prompt_version,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    transactionVersion: row.transaction_version,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed CandidateJob. */
function rowToJob(row: JobRow): CandidateJob {
  return {
    id: row.id,
    jobType: row.job_type,
    candidateId: row.candidate_id,
    status: row.status as JobStatus,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed FailureRecord. */
function rowToFailure(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed ReviewItem. */
function rowToReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    id: row.id,
    suggestionId: row.suggestion_id,
    budgetId: row.budget_id,
    transactionId: row.transaction_id,
    sourceTransaction: row.source_transaction_json === null ? null
      : JSON.parse(row.source_transaction_json) as ReviewActionAuthorization['transaction'],
    categoryId: row.category_id,
    classifier: row.classifier,
    promptVersion: row.prompt_version,
    transactionVersion: row.transaction_version,
    status: row.status as ReviewStatus,
    correlationId: row.correlation_id,
    assignedReviewerId: row.assigned_reviewer_id,
    approvedBy: JSON.parse(row.approved_by) as string[],
    reviewersRequired: row.reviewers_required,
    priority: row.priority,
    evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    provenance: row.provenance,
    supersededBy: row.superseded_by,
    supersededReason: row.superseded_reason,
    freshnessExpiresAt: row.freshness_expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed ReviewAction. */
function rowToReviewAction(row: ReviewActionRow): ReviewAction {
  return {
    id: row.id,
    reviewItemId: row.review_item_id,
    fromStatus: row.from_status as ReviewStatus,
    toStatus: row.to_status as ReviewStatus,
    actor: row.actor,
    reason: row.reason,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed ActionProposal. */
function rowToProposal(row: ProposalRow): ActionProposal {
  return {
    id: row.id,
    operation: row.operation as ProposalOperation,
    budgetId: row.budget_id,
    spaceId: row.space_id,
    requesterMembershipId: row.requester_membership_id,
    governancePolicyVersion: row.governance_policy_version,
    payload: JSON.parse(row.payload),
    version: row.version,
    state: JSON.parse(row.state),
    payloadHash: row.payload_hash,
    policyVersion: row.policy_version,
    preconditions: row.preconditions,
    expiresAt: row.expires_at,
    actorId: row.actor_id,
    provenance: row.provenance,
    providerModel: row.provider_model,
    correlationId: row.correlation_id,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  } as ActionProposal;
}

function rowToRuleOverride(row: RuleOverrideRow): RuleOverride {
  if (row.inactive !== null && row.inactive !== 0 && row.inactive !== 1)
    throw new Error('Stored rule override has invalid inactive state');
  return {
    ruleId: row.rule_id,
    inactive: row.inactive === null ? null : row.inactive === 1,
    version: row.version,
  };
}

/** Map a raw DB row to a typed ProposalApproval. */
function rowToApproval(row: ApprovalRow): ProposalApproval {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    payloadHash: row.payload_hash,
    actorId: row.actor_id,
    status: row.status as ApprovalStatus,
    membershipId: row.issuer_membership_id,
    governancePolicyVersion: row.governance_policy_version,
    reauthenticatedSessionId: row.reauthenticated_session_id,
    reauthenticatedAt: row.reauthenticated_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed IdempotencyRecord. */
function rowToIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    idempotencyKey: row.idempotency_key,
    proposalId: row.proposal_id,
    operation: row.operation as ProposalOperation,
    executedAt: row.executed_at,
    completed: row.completed !== 0,
    status: row.idempotency_status as IdempotencyStatus,
    leaseExpiresAt: row.lease_expires_at,
    serialisedEffect: row.serialised_effect,
    serialisedResult: row.serialised_result,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed AuditRecord. */
function rowToAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    classification: row.classification as AuditClassification,
    timestamp: row.timestamp,
    actorId: row.actor_id,
    operation: row.operation as ProposalOperation | null,
    proposalId: row.proposal_id,
    payloadHash: row.payload_hash,
    budgetId: row.budget_id,
    backendIds: row.backend_ids,
    policyVersion: row.policy_version,
    authorizationDisposition: row.authorization_disposition
      ? (JSON.parse(row.authorization_disposition) as AuthorizationDisposition)
      : null,
    idempotencyKey: row.idempotency_key,
    expectedPriorState: row.expected_prior_state,
    observedResultState: row.observed_result_state,
    providerModel: row.provider_model,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    result: row.result,
    isError: row.is_error !== 0,
  };
}

/** Map a raw DB row to a typed CorrectionRecord. */
function rowToCorrection(row: CorrectionRow): CorrectionRecord {
  return {
    id: row.id,
    reviewItemId: row.review_item_id,
    transactionId: row.transaction_id,
    transactionVersion: row.transaction_version,
    merchant: row.merchant,
    importedPayee: row.imported_payee,
    accountId: row.account_id,
    direction: row.direction,
    amount: row.amount,
    date: row.date,
    categoryId: row.category_id,
    previousCategoryId: row.previous_category_id,
    proposalId: row.proposal_id,
    proposalActorId: row.proposal_actor_id,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
    verified: row.verified !== 0,
    categoryName: row.category_name,
    actor: row.actor,
    fromStatus: row.from_status as ReviewStatus,
    toStatus: row.to_status as ReviewStatus,
    sourceReviewId: row.source_review_id,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to InvitationMetadata (public, no digest). */
function rowToInvitationMetadata(row: InvitationRow): InvitationMetadata {
  return {
    id: row.id,
    status: row.status as InvitationStatus,
    createdByUserId: row.created_by_user_id,
    spaceId: row.space_id!,
    issuerMembershipId: row.issuer_membership_id!,
    governancePolicyVersion: row.governance_policy_version!,
    expiresAt: row.expires_at,
    claimedEmail: row.claimed_email,
    redeemedUserId: row.redeemed_user_id,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    redeemedAt: row.redeemed_at,
  };
}

/** Map a raw DB row to a typed NotificationEvent. */
function rowToNotificationEvent(row: NotificationEventRow): NotificationEvent {
  return {
    id: row.id,
    eventVersion: row.event_version,
    budgetId: row.budget_id,
    classification: row.classification,
    recipientId: row.recipient_id,
    spaceId: row.space_id,
    recipientMembershipId: row.recipient_membership_id,
    scope: row.scope,
    redactionClass: row.redaction_class,
    channelConfigVersion: row.channel_config_version,
    policyVersion: row.policy_version,
    correlationId: row.correlation_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed NotificationOutboxRecord. */
function rowToOutbox(row: NotificationOutboxRow): NotificationOutboxRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    deliveryKey: row.delivery_key,
    channelType: row.channel_type,
    channelConfigVersion: row.channel_config_version,
    status: row.status as OutboxStatus,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    lastAttemptedAt: row.last_attempted_at,
    nextAttemptAt: row.next_attempt_at,
    acknowledgedAt: row.acknowledged_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    suppressedAt: row.suppressed_at,
    suppressedReason: row.suppressed_reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed DeliveryAttempt. */
function rowToDeliveryAttempt(row: DeliveryAttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    attemptNumber: row.attempt_number,
    status: row.status as DeliveryAttemptStatus,
    responseCode: row.response_code,
    responseBody: row.response_body,
    errorMessage: row.error_message,
    attemptedAt: row.attempted_at,
  };
}

/** Map a raw DB row to a typed PolicyVersion. */
function rowToPolicyVersion(row: PolicyVersionRow): PolicyVersion {
  return {
    id: row.id,
    policyKey: row.policy_key,
    version: row.version,
    policyHash: row.policy_hash,
    description: row.description,
    isActive: row.is_active !== 0,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed SavedFilter. */
function rowToSavedFilter(row: SavedFilterRow): SavedFilter {
  return {
    id: row.id,
    name: row.name,
    budgetId: row.budget_id,
    filterConfig: row.filter_config,
    viewConfig: row.view_config,
    scope: row.scope,
    policyVersion: row.policy_version,
    isDefault: row.is_default !== 0,
    actorId: row.actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed ReportRecord. */
function rowToReportRecord(row: ReportRecordRow): ReportRecord {
  return {
    id: row.id,
    reportType: row.report_type,
    budgetId: row.budget_id,
    filterId: row.filter_id,
    config: row.config,
    policyVersion: row.policy_version,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    dataRef: row.data_ref,
  };
}

/** Decode persisted saved-view scope without allowing malformed legacy data to break listing. */
function parseSavedViewScope(scope: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(scope);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Map a raw DB row to a typed SavedViewResult. */
function rowToSavedViewResult(row: SavedViewRow): SavedViewResult {
  if (row.space_id === null || row.budget_id === null || row.membership_id === null)
    throw new Error('Saved view provenance is unavailable');
  return {
    viewId: row.view_id,
    name: row.name,
    viewType: row.view_type,
    scope: parseSavedViewScope(row.scope),
    sort: row.sort,
    actorId: row.actor_id,
    spaceId: row.space_id,
    budgetId: row.budget_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Map a raw DB row to a typed Finding. */
function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    budgetId: row.budget_id,
    classification: row.classification,
    description: row.description,
    evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    evidenceRefs: JSON.parse(row.evidence_refs) as string[],
    severity: row.severity as Finding['severity'],
    status: row.status as FindingStatus,
    actorId: row.actor_id,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    correctedAt: row.corrected_at,
    correctedBy: row.corrected_by,
    correctionRef: row.correction_ref,
    dismissedAt: row.dismissed_at,
    dismissedBy: row.dismissed_by,
    dismissedReason: row.dismissed_reason,
    reopenedAt: row.reopened_at,
    reopenedBy: row.reopened_by,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    supersededReason: row.superseded_reason,
    expiresAt: row.expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed NotificationPolicyRecord. */
function rowToNotificationPolicy(row: NotificationPolicyRow): NotificationPolicyRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    policyKey: row.policy_key,
    policyVersion: row.policy_version,
    policy: row.policy,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
/** Allowed transitions between review statuses. */
const REVIEW_TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  discovered: ['suggestion_generated', 'pending_review', 'superseded'],
  suggestion_generated: ['pending_review', 'skipped', 'superseded'],
  pending_review: ['approved', 'correcting', 'rejected', 'skipped', 'superseded'],
  approved: ['correcting', 'applying', 'pending_review', 'superseded'],
  applying: ['applied', 'apply_failed', 'superseded'],
  correcting: ['applying', 'pending_review', 'superseded', 'rejected', 'skipped', 'approved'],
  applied: ['superseded'],
  apply_failed: ['correcting', 'pending_review', 'superseded'],
  rejected: ['superseded', 'pending_review'],
  skipped: ['superseded', 'pending_review'],
  superseded: [],
};

/** Terminal statuses that cannot transition forward. */
const TERMINAL_STATUSES: ReviewStatus[] = [
  'applied',
  'apply_failed',
  'rejected',
  'skipped',
  'superseded',
];

/** Statuses for which `pending_review` is an undo, not a forward transition. */
const UNDO_SOURCES: ReviewStatus[] = ['approved', 'correcting', 'rejected', 'skipped'];

/** Allowed transitions between finding statuses. */
const FINDING_TRANSITIONS: Record<string, string[]> = {
  open: ['acknowledged', 'corrected', 'dismissed', 'superseded', 'expired'],
  acknowledged: ['corrected', 'dismissed', 'reopened', 'superseded', 'expired'],
  corrected: ['superseded', 'expired'],
  dismissed: ['reopened', 'superseded'],
  reopened: ['acknowledged', 'corrected', 'dismissed', 'superseded', 'expired'],
  expired: ['superseded'],
  superseded: [],
};

/** Terminal finding statuses that cannot transition forward (except supersede). */
const FINDING_TERMINAL_STATUSES: string[] = ['expired', 'superseded'];

// ---------------------------------------------------------------------------
// Row shapes (internal, matching DB schema)
// ---------------------------------------------------------------------------

interface SuggestionRow {
  id: string;
  budget_id: string;
  transaction_id: string;
  category_id: string;
  classifier: string;
  prompt_version: string;
  payload: string;
  transaction_version: number;
  superseded_at: string | null;
  created_at: string;
}

interface JobRow {
  id: string;
  job_type: string;
  candidate_id: string;
  status: string;
  claim_token: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  created_at: string;
  updated_at: string;
  space_id: string | null;
  budget_id: string | null;
  actor_id: string | null;
}

interface ReviewItemRow {
  id: string;
  suggestion_id: string | null;
  budget_id: string;
  transaction_id: string;
  source_transaction_json: string | null;
  category_id: string;
  classifier: string;
  prompt_version: string;
  transaction_version: number;
  status: string;
  correlation_id: string | null;
  assigned_reviewer_id: string | null;
  approved_by: string;
  reviewers_required: number;
  priority: number;
  evidence: string;
  provenance: string;
  superseded_by: string | null;
  superseded_reason: string | null;
  freshness_expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ReviewActionRow {
  id: string;
  review_item_id: string;
  from_status: string;
  to_status: string;
  actor: string;
  reason: string | null;
  metadata: string;
  created_at: string;
}

interface FailureRow {
  id: string;
  job_id: string;
  error_code: string;
  error_message: string;
  created_at: string;
}

interface ProposalRow {
  id: string;
  operation: string;
  budget_id: string;
  space_id: string | null;
  requester_membership_id: string | null;
  requester_delegation_id: string | null;
  requester_delegation_version: string | null;
  governance_policy_version: string | null;
  payload: string;
  version: number;
  state: string;
  payload_hash: string;
  policy_version: string;
  preconditions: string;
  expires_at: string;
  actor_id: string;
  provenance: string;
  provider_model: string | null;
  correlation_id: string | null;
  superseded_at: string | null;
  created_at: string;
}

interface RuleOverrideRow {
  rule_id: string;
  inactive: number | null;
  version: number;
}

interface ApprovalRow {
  id: string;
  proposal_id: string;
  payload_hash: string;
  actor_id: string;
  status: string;
  issuer_membership_id: string | null;
  governance_policy_version: string | null;
  reauthenticated_session_id: string | null;
  reauthenticated_at: string | null;
  expires_at: string;
  consumed_at: string | null;
  superseded_at: string | null;
  created_at: string;
}

interface IdempotencyRow {
  idempotency_key: string;
  proposal_id: string;
  operation: string;
  executed_at: string;
  completed: number;
  idempotency_status: string;
  lease_expires_at: string | null;
  serialised_effect: string;
  serialised_result: string | null;
  error_message: string | null;
  updated_at: string;
}

interface AuditRow {
  id: string;
  classification: string;
  timestamp: string;
  actor_id: string;
  operation: string | null;
  proposal_id: string | null;
  payload_hash: string | null;
  budget_id: string | null;
  backend_ids: string;
  policy_version: string | null;
  authorization_disposition: string | null;
  idempotency_key: string | null;
  expected_prior_state: string | null;
  observed_result_state: string | null;
  provider_model: string | null;
  correlation_id: string | null;
  request_id: string | null;
  result: string;
  is_error: number;
}

interface ActorMembershipRow {
  actor_id: string;
  status: string;
  capabilities: string;
  scope: string;
}

interface InvitationRow {
  id: string;
  token_digest: string;
  status: string;
  created_by_user_id: string;
  space_id: string | null;
  issuer_membership_id: string | null;
  governance_policy_version: string | null;
  expires_at: string;
  claimed_email: string | null;
  claim_id: string | null;
  redeemed_user_id: string | null;
  created_at: string;
  claimed_at: string | null;
  redeemed_at: string | null;
}

interface NotificationEventRow {
  id: string;
  event_version: number;
  budget_id: string;
  classification: string;
  dedup_key: string | null;
  recipient_id: string | null;
  space_id: string | null;
  recipient_membership_id: string | null;
  scope: string | null;
  redaction_class: string | null;
  channel_config_version: string | null;
  policy_version: string;
  correlation_id: string | null;
  payload: string;
  created_at: string;
}

interface NotificationOutboxRow {
  id: string;
  event_id: string;
  delivery_key: string;
  channel_type: string;
  channel_config_version: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  claim_token: string | null;
  claim_expires_at: string | null;
  last_attempted_at: string | null;
  next_attempt_at: string | null;
  acknowledged_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  suppressed_at: string | null;
  suppressed_reason: string | null;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryAttemptRow {
  id: string;
  outbox_id: string;
  attempt_number: number;
  status: string;
  response_code: string | null;
  response_body: string | null;
  error_message: string | null;
  attempted_at: string;
}

interface PolicyVersionRow {
  id: string;
  policy_key: string;
  version: number;
  policy_hash: string;
  description: string;
  is_active: number;
  superseded_at: string | null;
  created_at: string;
}

interface SavedFilterRow {
  id: string;
  name: string;
  budget_id: string | null;
  filter_config: string;
  view_config: string | null;
  scope: string;
  policy_version: string;
  is_default: number;
  actor_id: string;
  created_at: string;
  updated_at: string;
}

interface SavedViewRow {
  view_id: string;
  name: string;
  view_type: string;
  scope: string;
  sort: string | null;
  actor_id: string;
  space_id: string | null;
  budget_id: string | null;
  membership_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface FindingRow {
  id: string;
  budget_id: string;
  classification: string;
  description: string;
  evidence: string;
  evidence_refs: string;
  severity: string;
  status: string;
  actor_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  corrected_at: string | null;
  corrected_by: string | null;
  correction_ref: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  dismissed_reason: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  superseded_reason: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface NotificationPolicyRow {
  id: string;
  space_id: string;
  policy_key: string;
  policy_version: string;
  policy: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface ReportRecordRow {
  id: string;
  report_type: string;
  budget_id: string | null;
  filter_id: string | null;
  config: string;
  policy_version: string;
  generated_at: string;
  expires_at: string | null;
  data_ref: string | null;
}

interface CorrectionRow {
  id: string;
  review_item_id: string;
  transaction_id: string;
  transaction_version: number;
  merchant: string | null;
  imported_payee: string | null;
  account_id: string | null;
  direction: string | null;
  amount: number | null;
  date: string | null;
  category_id: string;
  category_name: string | null;
  previous_category_id: string | null;
  proposal_id: string | null;
  proposal_actor_id: string | null;
  payload_hash: string | null;
  idempotency_key: string | null;
  verified: number;
  actor: string;
  from_status: string;
  to_status: string;
  source_review_id: string;
  created_at: string;
}
// ---------------------------------------------------------------------------
// SqliteWorkflowStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed workflow store.
 *
 * @param filename  Path to the SQLite database file, or `:memory:` for an
 *                  in-memory database (useful in tests).
 */
export class SqliteWorkflowStore implements WorkflowStore {
  private readonly db: DatabaseType;

  /** Prepared statements cached for the lifetime of the store. */
  private readonly stmt = {
    insertSuggestion: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeMatch: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActiveSuggestion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSuggestion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectTransactionSuggestions: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeByVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    countSuperseded: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectMaxVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    upsertJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectJobByCandidate: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectJobById: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimJobPending: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimJobExpired: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectClaimedJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertFailure: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectLatestFailure: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectPendingJobs: null as unknown as ReturnType<DatabaseType['prepare']>,
    failJobStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertReviewItem: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewItem: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewByIssue: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItems: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItemsByStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItemsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItemsByCorrelation: null as unknown as ReturnType<DatabaseType['prepare']>,
    transitionReviewItemStale: null as unknown as ReturnType<DatabaseType['prepare']>,
    transitionReviewItemUpdate: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeReviewItem: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertReviewAction: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewActions: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateApprovedBy: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewItemStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewItemsByIds: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActiveProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectProposalByExactKey: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeProposalStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposals: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsActive: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsByBudgetActive: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsSuperseded: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsSupersededByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertApproval: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectApproval: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActiveApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    consumeApprovalStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectApprovalByProposalActor: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectProposalExecutionAcquisition: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertProposalExecutionAcquisition: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeProposalApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectProposalStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertIdempotency: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectIdempotency: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectIdempotencyByProposalOp: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeIdempotencyStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateIdempotencyStatusStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectStrandedIdempotencyStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateStrandedIdempotencyStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertAudit: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAuditByClassification: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAuditByProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAuditCount: null as unknown as ReturnType<DatabaseType['prepare']>,
    upsertActorMembershipStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActorMembership: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectExpiredApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    markExpiredApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    cancelPendingJobsStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    deleteMembershipStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertExportRecordStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectLastExportStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertCorrection: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionsByReview: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionsByMerchant: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionsByTransaction: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionsByActor: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAllCorrections: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionConflicts: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateReviewItemCategory: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeReviewCategorization: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionByIdempotencyKey: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectCorrectionByReviewTransition: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertRuleOverride: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateRuleOverride: null as unknown as ReturnType<DatabaseType['prepare']>,
    getRuleOverride: null as unknown as ReturnType<DatabaseType['prepare']>,
    getAllRuleOverrides: null as unknown as ReturnType<DatabaseType['prepare']>,
    removeRuleOverride: null as unknown as ReturnType<DatabaseType['prepare']>,
    countReviewItems: null as unknown as ReturnType<DatabaseType['prepare']>,
    countReviewItemsByStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    countReviewItemsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    countProposals: null as unknown as ReturnType<DatabaseType['prepare']>,
    countProposalsActive: null as unknown as ReturnType<DatabaseType['prepare']>,
    countProposalsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    countProposalsByBudgetActive: null as unknown as ReturnType<DatabaseType['prepare']>,
    countProposalsSuperseded: null as unknown as ReturnType<DatabaseType['prepare']>,
    countProposalsSupersededByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSchemaVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    upsertSchemaVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectRegistrationState: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertRegistrationClaim: null as unknown as ReturnType<DatabaseType['prepare']>,
    finalizeRegistration: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertInvitation: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectInvitation: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectInvitationByDigest: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAllInvitations: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateInvitationClaim: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateInvitationRevoke: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateInvitationExpired: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateInvitationRedeemed: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Notification events ──
    insertNotificationEvent: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertOrIgnoreNotificationEvent: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectNotificationEvent: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectNotificationEventByDedupIdentity: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Notification outbox ──
    insertOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectOutboxByEventChannel: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimOutboxPending: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimOutboxExpired: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimOutboxRetryable: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectClaimedOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    failOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    scheduleRetryOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    acknowledgeOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    suppressOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectPendingOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectPendingOutboxByChannel: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectRetryableOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectRetryableOutboxByChannel: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── List outbox ──
    selectListOutbox: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectListOutboxByStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectListOutboxByChannel: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectListOutboxByStatusChannel: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Delivery attempts ──
    insertDeliveryAttempt: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectDeliveryAttempts: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Policy versions ──
    insertPolicyVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectPolicyVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActivePolicyVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedePolicyVersions: null as unknown as ReturnType<DatabaseType['prepare']>,
    listPolicyVersions: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Saved filters ──
    insertSavedFilter: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSavedFilter: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateSavedFilter: null as unknown as ReturnType<DatabaseType['prepare']>,
    demoteDefaultFilter: null as unknown as ReturnType<DatabaseType['prepare']>,
    deleteSavedFilter: null as unknown as ReturnType<DatabaseType['prepare']>,
    listSavedFilters: null as unknown as ReturnType<DatabaseType['prepare']>,
    listSavedFiltersByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    listSavedFiltersByScope: null as unknown as ReturnType<DatabaseType['prepare']>,
    listSavedFiltersByActor: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Report records ──
    insertReportRecord: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReportRecord: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReportRecords: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReportRecordsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReportRecordsByType: null as unknown as ReturnType<DatabaseType['prepare']>,
    expireReportRecord: null as unknown as ReturnType<DatabaseType['prepare']>,
    validateSavedViewAuthority: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    listSavedViewsByAuthority: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    deleteSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    recordSavedViewUsage: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertFinding: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectFinding: null as unknown as ReturnType<DatabaseType['prepare']>,
    listFindings: null as unknown as ReturnType<DatabaseType['prepare']>,
    listFindingsByStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    listFindingsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    listFindingsByBudgetStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    listFindingsByClassification: null as unknown as ReturnType<DatabaseType['prepare']>,
    listFindingsBySeverity: null as unknown as ReturnType<DatabaseType['prepare']>,
    countFindings: null as unknown as ReturnType<DatabaseType['prepare']>,
    countFindingsFiltered: null as unknown as ReturnType<DatabaseType['prepare']>,
    transitionFinding: null as unknown as ReturnType<DatabaseType['prepare']>,
    expireFindingStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    expireFindingsByDate: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertNotificationPolicy: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateNotificationPolicy: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectNotificationPolicy: null as unknown as ReturnType<DatabaseType['prepare']>,
    listNotificationPolicies: null as unknown as ReturnType<DatabaseType['prepare']>,
    listNotificationPoliciesBySpace: null as unknown as ReturnType<DatabaseType['prepare']>,
    deleteNotificationPolicy: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReportHistory: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReportHistoryByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    countAllReportRecords: null as unknown as ReturnType<DatabaseType['prepare']>,
    countReportRecordsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
  };

  readonly governance: SpaceGovernance;
  readonly liquidity: LiquidityWorkflow;
  constructor(filename: string = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // (1) Create only the schema_version table first
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
    `);

    // (2-3) Run ordered transactional migrations
    this.runMigrations();

    // (4) Prepare runtime statements
    this.prepareStatements();
    this.governance = new SpaceGovernance(this.db);
    this.liquidity = new LiquidityWorkflow(this.db, (row) => rowToProposal(row as ProposalRow), this.governance);
  }
  /** Release the database connection. */
  close(): void {
    this.db.close();
  }

  // ── Schema migrations ─────────────────────────────────────────
  //
  // Each migration is a function that applies one or more DDL/DML changes
  // inside a single transaction.  The store's schema_version table tracks
  // which version has been applied; migrations are run sequentially.

  private static readonly MIGRATIONS: Array<(db: DatabaseType) => void> = [
    // Version 1: Initial schema
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS suggestions (
          id                  TEXT PRIMARY KEY,
          budget_id           TEXT NOT NULL,
          transaction_id      TEXT NOT NULL,
          category_id         TEXT NOT NULL,
          classifier          TEXT NOT NULL,
          prompt_version      TEXT NOT NULL,
          payload             TEXT NOT NULL,
          transaction_version INTEGER NOT NULL,
          superseded_at       TEXT,
          created_at          TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_active
          ON suggestions(budget_id, transaction_id, classifier, prompt_version)
          WHERE superseded_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_suggestions_transaction
          ON suggestions(transaction_id);

        CREATE TABLE IF NOT EXISTS candidate_jobs (
          id               TEXT PRIMARY KEY,
          job_type         TEXT NOT NULL,
          candidate_id     TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          claim_token      TEXT,
          claimed_at       TEXT,
          claim_expires_at TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          UNIQUE(job_type, candidate_id)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_status
          ON candidate_jobs(status);

        CREATE TABLE IF NOT EXISTS failure_records (
          id            TEXT PRIMARY KEY,
          job_id        TEXT NOT NULL REFERENCES candidate_jobs(id),
          error_code    TEXT NOT NULL,
          error_message TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_failures_job
          ON failure_records(job_id);

        CREATE TABLE IF NOT EXISTS review_items (
          id                   TEXT PRIMARY KEY,
          suggestion_id        TEXT,
          budget_id            TEXT NOT NULL,
          transaction_id       TEXT NOT NULL,
          category_id          TEXT NOT NULL,
          classifier           TEXT NOT NULL,
          prompt_version       TEXT NOT NULL DEFAULT '',
          transaction_version  INTEGER NOT NULL DEFAULT 0,
          status               TEXT NOT NULL DEFAULT 'discovered',
          correlation_id       TEXT,
          assigned_reviewer_id TEXT,
          approved_by          TEXT NOT NULL DEFAULT '[]',
          reviewers_required   INTEGER NOT NULL DEFAULT 1,
          priority             INTEGER NOT NULL DEFAULT 0,
          evidence             TEXT NOT NULL DEFAULT '{}',
          provenance           TEXT NOT NULL,
          superseded_by        TEXT,
          superseded_reason    TEXT,
          freshness_expires_at TEXT,
          version              INTEGER NOT NULL DEFAULT 1,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_review_items_status
          ON review_items(status);

        CREATE INDEX IF NOT EXISTS idx_review_items_correlation
          ON review_items(correlation_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_active_issue
          ON review_items(budget_id, transaction_id, category_id, classifier)
          WHERE status != 'superseded';

        CREATE TABLE IF NOT EXISTS review_actions (
          id               TEXT PRIMARY KEY,
          review_item_id   TEXT NOT NULL REFERENCES review_items(id),
          from_status      TEXT NOT NULL,
          to_status        TEXT NOT NULL,
          actor            TEXT NOT NULL,
          reason           TEXT,
          metadata         TEXT NOT NULL DEFAULT '{}',
          created_at       TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_review_actions_item
          ON review_actions(review_item_id);

        CREATE TABLE IF NOT EXISTS categorization_proposals (
          id               TEXT PRIMARY KEY,
          operation        TEXT NOT NULL,
          budget_id        TEXT NOT NULL,
          transaction_id   TEXT NOT NULL,
          category_id      TEXT NOT NULL,
          payload_hash     TEXT NOT NULL,
          policy_version   TEXT NOT NULL,
          preconditions    TEXT NOT NULL,
          expires_at       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          provenance       TEXT NOT NULL,
          provider_model   TEXT,
          correlation_id   TEXT,
          superseded_at    TEXT,
          created_at       TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_proposals_active_target
          ON categorization_proposals(budget_id, transaction_id, operation)
          WHERE superseded_at IS NULL;

        DROP INDEX IF EXISTS idx_proposals_payload_unique;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_payload_unique
          ON categorization_proposals(budget_id, transaction_id, operation, payload_hash)
          WHERE superseded_at IS NULL;

        CREATE TABLE IF NOT EXISTS proposal_approvals (
          id            TEXT PRIMARY KEY,
          proposal_id   TEXT NOT NULL REFERENCES categorization_proposals(id),
          payload_hash  TEXT NOT NULL,
          actor_id      TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'active',
          expires_at    TEXT NOT NULL,
          consumed_at   TEXT,
          superseded_at TEXT,
          created_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_approvals_proposal
          ON proposal_approvals(proposal_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_active_actor
          ON proposal_approvals(proposal_id, actor_id)
          WHERE status = 'active';

        DROP INDEX IF EXISTS idx_approvals_proposal_actor;

        CREATE TABLE IF NOT EXISTS rule_overrides (
          rule_id   TEXT PRIMARY KEY,
          inactive  INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS idempotency_records (
          idempotency_key   TEXT PRIMARY KEY,
          proposal_id       TEXT NOT NULL,
          operation         TEXT NOT NULL,
          executed_at       TEXT NOT NULL,
          completed         INTEGER NOT NULL DEFAULT 0,
          serialised_effect TEXT NOT NULL,
          error_message     TEXT,
          updated_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_records (
          id                       TEXT PRIMARY KEY,
          classification           TEXT NOT NULL,
          timestamp                TEXT NOT NULL,
          actor_id                 TEXT NOT NULL,
          operation                TEXT,
          proposal_id              TEXT,
          payload_hash             TEXT,
          budget_id                TEXT,
          backend_ids              TEXT NOT NULL DEFAULT '[]',
          policy_version           TEXT,
          authorization_disposition TEXT,
          idempotency_key          TEXT,
          expected_prior_state     TEXT,
          observed_result_state    TEXT,
          provider_model           TEXT,
          correlation_id           TEXT,
          request_id               TEXT,
          result                   TEXT NOT NULL,
          is_error                 INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS review_corrections (
          id                  TEXT PRIMARY KEY,
          review_item_id      TEXT NOT NULL REFERENCES review_items(id),
          transaction_id      TEXT NOT NULL,
          transaction_version INTEGER NOT NULL DEFAULT 0,
          merchant            TEXT,
          imported_payee      TEXT,
          account_id          TEXT,
          direction           TEXT,
          amount              INTEGER,
          date                TEXT,
          category_id         TEXT NOT NULL,
          category_name       TEXT,
          actor               TEXT NOT NULL,
          from_status         TEXT NOT NULL,
          to_status           TEXT NOT NULL,
          source_review_id    TEXT NOT NULL,
          created_at          TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_corrections_review
          ON review_corrections(review_item_id);

        CREATE INDEX IF NOT EXISTS idx_corrections_merchant
          ON review_corrections(merchant);

        CREATE INDEX IF NOT EXISTS idx_corrections_transaction
          ON review_corrections(transaction_id);

        CREATE INDEX IF NOT EXISTS idx_corrections_actor
          ON review_corrections(actor);

        CREATE INDEX IF NOT EXISTS idx_audit_classification
          ON audit_records(classification);

        CREATE INDEX IF NOT EXISTS idx_audit_proposal
          ON audit_records(proposal_id);

        CREATE TABLE IF NOT EXISTS actor_memberships (
          actor_id     TEXT PRIMARY KEY,
          status       TEXT NOT NULL DEFAULT 'active',
          capabilities TEXT NOT NULL DEFAULT '[]',
          scope        TEXT NOT NULL DEFAULT '*'
        );

        CREATE TABLE IF NOT EXISTS export_records (
          id               TEXT PRIMARY KEY,
          budget_name      TEXT NOT NULL,
          export_path      TEXT NOT NULL,
          account_count    INTEGER NOT NULL DEFAULT 0,
          transaction_count INTEGER NOT NULL DEFAULT 0,
          exported_at      TEXT NOT NULL
        );
      `);
    },
    // Version 2: Idempotency state machine — status field and lease expiration
    (db) => {
      db.exec(`
        ALTER TABLE idempotency_records ADD COLUMN idempotency_status TEXT NOT NULL DEFAULT 'in_progress';
        ALTER TABLE idempotency_records ADD COLUMN lease_expires_at TEXT;

        -- Backfill existing completed records to the correct terminal status
        UPDATE idempotency_records
           SET idempotency_status = 'succeeded'
         WHERE completed = 1
           AND error_message IS NULL;

        UPDATE idempotency_records
           SET idempotency_status = 'terminal_failed'
         WHERE completed = 1
           AND error_message IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_idempotency_status
          ON idempotency_records(idempotency_status);
      `);
    },
    // Version 3: Registration and invitation tables
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS registration_state (
          singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_user_id   TEXT UNIQUE,
          bootstrapped_at TEXT,
          claim_id        TEXT,
          claimed_email   TEXT,
          claimed_name    TEXT,
          claimed_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS invitations (
          id                 TEXT PRIMARY KEY,
          token_digest       TEXT UNIQUE NOT NULL,
          status             TEXT NOT NULL CHECK(status IN ('active','claimed','redeemed','revoked','expired')),
          created_by_user_id TEXT NOT NULL,
          expires_at         TEXT NOT NULL,
          claimed_email      TEXT,
          claim_id           TEXT,
          redeemed_user_id   TEXT,
          created_at         TEXT NOT NULL,
          claimed_at         TEXT,
          redeemed_at        TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_invitations_status
          ON invitations(status);

        CREATE INDEX IF NOT EXISTS idx_invitations_claim_id
          ON invitations(claim_id);
      `);
    },
    // Version 4: Notification outbox, policy versions, saved filters, report records
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notification_events (
          id                    TEXT PRIMARY KEY,
          event_version         INTEGER NOT NULL DEFAULT 1,
          budget_id             TEXT NOT NULL,
          classification        TEXT NOT NULL,
          recipient_id          TEXT,
          scope                 TEXT,
          redaction_class       TEXT,
          channel_config_version TEXT,
          policy_version        TEXT NOT NULL,
          correlation_id        TEXT,
          payload               TEXT NOT NULL,
          created_at            TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_notif_events_budget
          ON notification_events(budget_id);

        CREATE INDEX IF NOT EXISTS idx_notif_events_classification
          ON notification_events(classification);

        CREATE TABLE IF NOT EXISTS notification_outbox (
          id                    TEXT PRIMARY KEY,
          event_id              TEXT NOT NULL REFERENCES notification_events(id),
          delivery_key          TEXT NOT NULL,
          channel_type          TEXT NOT NULL,
          channel_config_version TEXT,
          status                TEXT NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','delivering','delivered','failed','suppressed')),
          attempt_count         INTEGER NOT NULL DEFAULT 0,
          max_attempts          INTEGER NOT NULL DEFAULT 3,
          claim_token           TEXT,
          claim_expires_at      TEXT,
          last_attempted_at     TEXT,
          next_attempt_at       TEXT,
          acknowledged_at       TEXT,
          failed_at             TEXT,
          failure_reason        TEXT,
          suppressed_at         TEXT,
          suppressed_reason     TEXT,
          correlation_id        TEXT,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          UNIQUE(event_id, channel_type, delivery_key)
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_status
          ON notification_outbox(status);

        CREATE INDEX IF NOT EXISTS idx_outbox_channel
          ON notification_outbox(channel_type);

        CREATE INDEX IF NOT EXISTS idx_outbox_next_attempt
          ON notification_outbox(next_attempt_at)
          WHERE next_attempt_at IS NOT NULL;

        CREATE TABLE IF NOT EXISTS delivery_attempts (
          id              TEXT PRIMARY KEY,
          outbox_id       TEXT NOT NULL REFERENCES notification_outbox(id),
          attempt_number  INTEGER NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('success','failed')),
          response_code   TEXT,
          response_body   TEXT,
          error_message   TEXT,
          attempted_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_delivery_attempts_outbox
          ON delivery_attempts(outbox_id);

        CREATE TABLE IF NOT EXISTS policy_versions (
          id            TEXT PRIMARY KEY,
          policy_key    TEXT NOT NULL,
          version       INTEGER NOT NULL,
          policy_hash   TEXT NOT NULL,
          description   TEXT NOT NULL,
          is_active     INTEGER NOT NULL DEFAULT 1,
          superseded_at TEXT,
          created_at    TEXT NOT NULL,
          UNIQUE(policy_key, version)
        );

        CREATE INDEX IF NOT EXISTS idx_policy_active
          ON policy_versions(policy_key)
          WHERE is_active = 1;

        CREATE TABLE IF NOT EXISTS saved_filters (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          budget_id       TEXT,
          filter_config   TEXT NOT NULL,
          view_config     TEXT,
          scope           TEXT NOT NULL,
          policy_version  TEXT NOT NULL,
          is_default      INTEGER NOT NULL DEFAULT 0,
          actor_id        TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_saved_filters_budget
          ON saved_filters(budget_id);

        CREATE INDEX IF NOT EXISTS idx_saved_filters_scope
          ON saved_filters(scope);

        CREATE INDEX IF NOT EXISTS idx_saved_filters_actor
          ON saved_filters(actor_id);

        CREATE TABLE IF NOT EXISTS report_records (
          id              TEXT PRIMARY KEY,
          report_type     TEXT NOT NULL,
          budget_id       TEXT,
          filter_id       TEXT REFERENCES saved_filters(id),
          config          TEXT NOT NULL,
          policy_version  TEXT NOT NULL,
          generated_at    TEXT NOT NULL,
          expires_at      TEXT,
          data_ref        TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_report_records_budget
          ON report_records(budget_id);

        CREATE INDEX IF NOT EXISTS idx_report_records_type
          ON report_records(report_type);
      `);
    },
    // Version 5: Saved views table for Phase 8
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_views (
          view_id     TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          view_type   TEXT NOT NULL,
          scope       TEXT NOT NULL,
          sort        TEXT,
          actor_id    TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_saved_views_actor
          ON saved_views(actor_id);
      `);
    },
    // Version 6: Findings, notification policies, last-used view tracking
    (db) => {
      db.exec(`
        -- Add last_used_at to existing saved_views
        ALTER TABLE saved_views ADD COLUMN last_used_at TEXT;

        CREATE TABLE IF NOT EXISTS findings (
          id                TEXT PRIMARY KEY,
          budget_id         TEXT NOT NULL,
          classification    TEXT NOT NULL,
          description       TEXT NOT NULL,
          evidence          TEXT NOT NULL DEFAULT '{}',
          evidence_refs     TEXT NOT NULL DEFAULT '[]',
          severity          TEXT NOT NULL DEFAULT 'medium'
                              CHECK(severity IN ('low','medium','high','critical')),
          status            TEXT NOT NULL DEFAULT 'open'
                              CHECK(status IN ('open','acknowledged','corrected',
                                               'dismissed','reopened','expired','superseded')),
          actor_id          TEXT,
          acknowledged_at   TEXT,
          acknowledged_by   TEXT,
          corrected_at      TEXT,
          corrected_by      TEXT,
          correction_ref    TEXT,
          dismissed_at      TEXT,
          dismissed_by      TEXT,
          dismissed_reason  TEXT,
          reopened_at       TEXT,
          reopened_by       TEXT,
          superseded_at     TEXT,
          superseded_by     TEXT,
          superseded_reason TEXT,
          expires_at        TEXT,
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_findings_budget
          ON findings(budget_id);
        CREATE INDEX IF NOT EXISTS idx_findings_status
          ON findings(status);
        CREATE INDEX IF NOT EXISTS idx_findings_classification
          ON findings(classification);
        CREATE INDEX IF NOT EXISTS idx_findings_severity
          ON findings(severity);

        CREATE TABLE IF NOT EXISTS notification_policies (
          id             TEXT PRIMARY KEY,
          space_id       TEXT NOT NULL,
          policy_key     TEXT NOT NULL,
          policy_version TEXT NOT NULL,
          policy         TEXT NOT NULL,
          is_active      INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          UNIQUE(space_id, policy_key)
        );

        CREATE INDEX IF NOT EXISTS idx_notif_policies_space
          ON notification_policies(space_id);
        CREATE INDEX IF NOT EXISTS idx_notif_policies_active
          ON notification_policies(is_active);
      `);
    },
    // Version 7: Durable, recipient- and scope-bound notification deduplication
    (db) => {
      db.exec(`
        ALTER TABLE notification_events ADD COLUMN dedup_key TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_events_dedup_identity
          ON notification_events(
            dedup_key,
            recipient_id IS NULL,
            COALESCE(recipient_id, ''),
            scope IS NULL,
            COALESCE(scope, '')
          )
          WHERE dedup_key IS NOT NULL;
      `);
    },
    // Version 8: Restore read-only access for members redeemed before observe was granted
    (db) => {
      db.exec(`
        UPDATE actor_memberships
           SET capabilities = '["observe"]'
         WHERE status = 'active'
           AND capabilities = '[]'
           AND actor_id IN (
             SELECT redeemed_user_id
               FROM invitations
              WHERE status = 'redeemed'
                AND redeemed_user_id IS NOT NULL
           );
      `);
    },
    // Version 9: Restore the current capability baseline for an active legacy owner
    (db) => {
      db.exec(`
        WITH required_owner_capabilities(capability, position) AS (
          VALUES
            ('observe', 0),
            ('finding:transition', 1),
            ('notification:receive', 2),
            ('notification:admin', 3),
            ('categorization:execute', 4),
            ('rule:execute', 5)
        )
        UPDATE actor_memberships
           SET capabilities = (
             SELECT json_group_array(capability)
               FROM (
                 SELECT value AS capability, 0 AS source, CAST(key AS INTEGER) AS position
                   FROM json_each(actor_memberships.capabilities)
                 UNION ALL
                 SELECT required.capability, 1 AS source, required.position
                   FROM required_owner_capabilities AS required
                  WHERE NOT EXISTS (
                    SELECT 1
                      FROM json_each(actor_memberships.capabilities)
                     WHERE value = required.capability
                  )
                 ORDER BY source, position
               )
           )
         WHERE status = 'active'
           AND json_valid(capabilities)
           AND actor_id = (
             SELECT owner_user_id
               FROM registration_state
              WHERE singleton = 1
           )
           AND EXISTS (
             SELECT 1
               FROM required_owner_capabilities AS required
              WHERE NOT EXISTS (
                SELECT 1
                  FROM json_each(actor_memberships.capabilities)
                 WHERE value = required.capability
              )
           );
      `);
    },
    migrateLiquidityWorkflow,
    migrateTransferPreviews,
    migrateSessionCompletion,
    migrateScopedProspectiveEffects,
    migrateGovernance,
    migrateProposalApprovals,
    migrateScopedInvitations,
    migrateNotificationGovernance,
    (db) => {
      db.exec(`
        ALTER TABLE rule_overrides RENAME TO unscoped_rule_overrides;

        CREATE TABLE rule_overrides (
          space_id   TEXT NOT NULL,
          budget_id  TEXT NOT NULL,
          rule_id    TEXT NOT NULL,
          inactive   INTEGER CHECK (inactive IS NULL OR inactive IN (0, 1)),
          version    INTEGER NOT NULL CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_id, budget_id, rule_id)
        );
      `);
    },
    migrateProposalOrigins,
    (db) => {
      db.exec(`
        ALTER TABLE saved_views ADD COLUMN space_id TEXT;
        ALTER TABLE saved_views ADD COLUMN budget_id TEXT;
        ALTER TABLE saved_views ADD COLUMN membership_id TEXT;
        CREATE INDEX idx_saved_views_scope
          ON saved_views(space_id, budget_id, actor_id, membership_id);
      `);
    },
    (db) => {
      db.exec(`
        ALTER TABLE idempotency_records ADD COLUMN serialised_result TEXT;
        ALTER TABLE review_corrections ADD COLUMN previous_category_id TEXT;
        ALTER TABLE review_corrections ADD COLUMN proposal_id TEXT;
        ALTER TABLE review_corrections ADD COLUMN proposal_actor_id TEXT;
        ALTER TABLE review_corrections ADD COLUMN payload_hash TEXT;
        ALTER TABLE review_corrections ADD COLUMN idempotency_key TEXT;
        ALTER TABLE review_corrections ADD COLUMN verified INTEGER NOT NULL DEFAULT 0
          CHECK (verified IN (0, 1));
        CREATE UNIQUE INDEX idx_review_corrections_idempotency
          ON review_corrections(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      `);
    },
    // Version 23: Exact lifecycle provenance for exports and candidate jobs
    (db) => {
      db.exec(`
        ALTER TABLE candidate_jobs ADD COLUMN space_id TEXT;
        ALTER TABLE candidate_jobs ADD COLUMN budget_id TEXT;
        ALTER TABLE candidate_jobs ADD COLUMN actor_id TEXT;
        ALTER TABLE export_records ADD COLUMN space_id TEXT;
        ALTER TABLE export_records ADD COLUMN budget_id TEXT;
        ALTER TABLE export_records ADD COLUMN actor_id TEXT;
        ALTER TABLE export_records ADD COLUMN sha256_hash TEXT;
        ALTER TABLE export_records ADD COLUMN byte_size INTEGER;
        ALTER TABLE review_items ADD COLUMN source_transaction_json TEXT;
        CREATE INDEX idx_jobs_lifecycle_scope
          ON candidate_jobs(space_id, budget_id, status);
        CREATE INDEX idx_exports_lifecycle_scope
          ON export_records(actor_id, space_id, budget_id, exported_at);
      `);
    },
  ];

  private getCurrentSchemaVersion(): number {
    const row = this.db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    return row?.version ?? 0;
  }
  private runMigrations(): void {
    const current = this.getCurrentSchemaVersion();
    const target = SqliteWorkflowStore.MIGRATIONS.length;

    if (current >= target) return;

    for (let v = current + 1; v <= target; v++) {
      const migration = SqliteWorkflowStore.MIGRATIONS[v - 1];
      if (!migration) continue;
      const runMigration = this.db.transaction(() => {
        migration(this.db);
        this.db
          .prepare(
            'INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (@version, @appliedAt)',
          )
          .run({ version: v, appliedAt: new Date().toISOString() });
      });
      runMigration();
    }
  }

  private prepareStatements(): void {
    // ── Suggestions ────────────────────────────────────────────────────

    this.stmt.insertSuggestion = this.db.prepare(`
      INSERT INTO suggestions (id, budget_id, transaction_id, category_id,
                               classifier, prompt_version, payload,
                               transaction_version, superseded_at, created_at)
      VALUES (@id, @budgetId, @transactionId, @categoryId,
              @classifier, @promptVersion, @payload,
              @transactionVersion, @supersededAt, @createdAt)
    `);

    this.stmt.supersedeMatch = this.db.prepare(`
      UPDATE suggestions
         SET superseded_at = @now
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND classifier = @classifier
         AND prompt_version = @promptVersion
         AND superseded_at IS NULL
    `);

    this.stmt.selectActiveSuggestion = this.db.prepare(`
      SELECT * FROM suggestions
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND classifier = @classifier
         AND prompt_version = @promptVersion
         AND superseded_at IS NULL
       LIMIT 1
    `);

    this.stmt.selectSuggestion = this.db.prepare(`
      SELECT * FROM suggestions WHERE id = ?
    `);

    this.stmt.selectTransactionSuggestions = this.db.prepare(`
      SELECT * FROM suggestions WHERE transaction_id = ? ORDER BY created_at DESC
    `);

    this.stmt.supersedeByVersion = this.db.prepare(`
      UPDATE suggestions
         SET superseded_at = @now
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND superseded_at IS NULL
         AND transaction_version < @newVersion
    `);

    this.stmt.countSuperseded = this.db.prepare(`
      SELECT changes() AS count
    `);

    this.stmt.selectMaxVersion = this.db.prepare(`
      SELECT MAX(transaction_version) AS max_version FROM suggestions
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND classifier = @classifier
         AND prompt_version = @promptVersion
    `);

    // ── Jobs ───────────────────────────────────────────────────────────

    this.stmt.upsertJob = this.db.prepare(`
      INSERT INTO candidate_jobs (
        id, job_type, candidate_id, status, claim_token, claimed_at,
        claim_expires_at, created_at, updated_at, space_id, budget_id, actor_id
      )
      VALUES (
        @id, @jobType, @candidateId, 'pending', NULL, NULL, NULL, @now, @now,
        @spaceId, @budgetId, @actorId
      )
      ON CONFLICT(job_type, candidate_id) DO NOTHING
      RETURNING *
    `);

    this.stmt.selectJobByCandidate = this.db.prepare(`
      SELECT * FROM candidate_jobs
       WHERE job_type = @jobType AND candidate_id = @candidateId
    `);

    this.stmt.selectJobById = this.db.prepare(`
      SELECT * FROM candidate_jobs WHERE id = ?
    `);

    this.stmt.claimJobPending = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'processing',
             claim_token = @claimToken,
             claimed_at = @now,
             claim_expires_at = @expiresAt,
             updated_at = @now
       WHERE id = @jobId
         AND status = 'pending'
    `);

    this.stmt.claimJobExpired = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'processing',
             claim_token = @claimToken,
             claimed_at = @now,
             claim_expires_at = @expiresAt,
             updated_at = @now
       WHERE id = @jobId
         AND status = 'processing'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < @now
    `);

    this.stmt.selectClaimedJob = this.db.prepare(`
      SELECT * FROM candidate_jobs WHERE id = @jobId AND claim_token = @claimToken
    `);

    this.stmt.completeJob = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'completed',
             updated_at = @now
       WHERE id = @jobId
         AND status = 'processing'
         AND claim_token = @claimToken
    `);

    this.stmt.insertFailure = this.db.prepare(`
      INSERT INTO failure_records (id, job_id, error_code, error_message, created_at)
      VALUES (@id, @jobId, @errorCode, @errorMessage, @createdAt)
    `);

    this.stmt.selectLatestFailure = this.db.prepare(`
      SELECT * FROM failure_records
       WHERE job_id = ?
       ORDER BY created_at DESC
       LIMIT 1
    `);

    this.stmt.failJobStatus = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'failed',
             updated_at = @now
       WHERE id = @jobId
         AND status = 'processing'
         AND claim_token = @claimToken
    `);

    this.stmt.selectPendingJobs = this.db.prepare(`
      SELECT * FROM candidate_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
    `);

    // ── Review items ───────────────────────────────────────────────────

    this.stmt.insertReviewItem = this.db.prepare(`
      INSERT INTO review_items (id, suggestion_id, budget_id, transaction_id,
                                category_id, classifier, prompt_version,
                                transaction_version, status, correlation_id,
                                assigned_reviewer_id, approved_by,
                                reviewers_required, priority, evidence,
                                provenance, superseded_by, superseded_reason,
                                freshness_expires_at, version, created_at,
                                updated_at, source_transaction_json)
      VALUES (@id, @suggestionId, @budgetId, @transactionId,
              @categoryId, @classifier, @promptVersion,
              @transactionVersion, @status, @correlationId,
              @assignedReviewerId, @approvedBy,
              @reviewersRequired, @priority, @evidence,
              @provenance, @supersededBy, @supersededReason,
              @freshnessExpiresAt, @version, @createdAt,
              @updatedAt, @sourceTransaction)
      ON CONFLICT(budget_id, transaction_id, category_id, classifier)
        WHERE status != 'superseded'
        DO NOTHING
      RETURNING *
    `);

    this.stmt.selectReviewItem = this.db.prepare(`
      SELECT * FROM review_items WHERE id = ?
    `);

    this.stmt.selectReviewByIssue = this.db.prepare(`
      SELECT * FROM review_items
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND category_id = @categoryId
         AND classifier = @classifier
         AND status != 'superseded'
       LIMIT 1
    `);

    this.stmt.listReviewItems = this.db.prepare(`
      SELECT * FROM review_items
       WHERE 1=1
       ORDER BY
         CASE WHEN status IN ('applied', 'apply_failed', 'rejected', 'skipped', 'superseded') THEN 1 ELSE 0 END ASC,
         priority DESC,
         created_at ASC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReviewItemsByStatus = this.db.prepare(`
      SELECT * FROM review_items
       WHERE status = @status
       ORDER BY priority DESC, created_at ASC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReviewItemsByBudget = this.db.prepare(`
      SELECT * FROM review_items
       WHERE budget_id = @budgetId AND (@status IS NULL OR status = @status)
       ORDER BY
         CASE WHEN status IN ('applied', 'apply_failed', 'rejected', 'skipped', 'superseded') THEN 1 ELSE 0 END ASC,
         priority DESC,
         created_at ASC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReviewItemsByCorrelation = this.db.prepare(`
      SELECT * FROM review_items
       WHERE correlation_id = @correlationId
       ORDER BY created_at ASC
    `);

    this.stmt.transitionReviewItemUpdate = this.db.prepare(`
      UPDATE review_items
         SET status = @toStatus,
             superseded_reason = @reason,
             superseded_by = CASE WHEN @toStatus = 'superseded' THEN @supersededBy ELSE superseded_by END,
             approved_by = CASE WHEN @toStatus = 'approved' THEN @approvedBy ELSE approved_by END,
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND status = @fromStatus
         AND version = @expectedVersion
    `);

    this.stmt.supersedeReviewItem = this.db.prepare(`
      UPDATE review_items
         SET status = 'superseded',
             superseded_by = @supersededBy,
             superseded_reason = @reason,
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND status = @oldStatus
         AND version = @oldVersion
    `);

    this.stmt.updateApprovedBy = this.db.prepare(`
      UPDATE review_items
         SET approved_by = @approvedBy,
             updated_at = @now,
             version = CASE WHEN @isNew THEN version + 1 ELSE version END
       WHERE id = @id
         AND version = @expectedVersion
    `);

    this.stmt.completeReviewCategorization = this.db.prepare(`
      UPDATE review_items
         SET category_id = @categoryId,
             status = 'applied',
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND budget_id = @budgetId
         AND transaction_id = @transactionId
         AND category_id = @previousCategoryId
         AND status = @fromStatus
         AND version = @expectedVersion
         AND superseded_by IS NULL
    `);

    this.stmt.updateReviewItemCategory = this.db.prepare(`
      UPDATE review_items
         SET category_id = @categoryId,
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND version = @expectedVersion
    `);
    this.stmt.insertReviewAction = this.db.prepare(`
      INSERT INTO review_actions (id, review_item_id, from_status, to_status,
                                  actor, reason, metadata, created_at)
      VALUES (@id, @reviewItemId, @fromStatus, @toStatus,
              @actor, @reason, @metadata, @createdAt)
    `);

    this.stmt.selectReviewActions = this.db.prepare(`
      SELECT * FROM review_actions
       WHERE review_item_id = ?
       ORDER BY created_at ASC
    `);

    this.stmt.selectReviewItemStatus = this.db.prepare(`
      SELECT id, status, version, approved_by FROM review_items WHERE id = ?
    `);

    this.stmt.selectReviewItemsByIds = this.db.prepare(`
      SELECT id, status, version, approved_by FROM review_items WHERE id = ?
    `);

    // ── Proposals ──────────────────────────────────────────────────────

    this.stmt.insertProposal = this.db.prepare(`
      INSERT OR IGNORE INTO action_proposals (id, operation, budget_id, space_id,
                                            requester_membership_id, requester_delegation_id,
                                            requester_delegation_version, governance_policy_version,
                                            payload, payload_hash, policy_version,
                                            preconditions, expires_at, actor_id,
                                            provenance, provider_model, correlation_id,
                                            superseded_at, created_at)
      VALUES (@id, @operation, @budgetId, @spaceId,
              @requesterMembershipId, @requesterDelegationId,
              @requesterDelegationVersion, @governancePolicyVersion,
              @payload, @payloadHash, @policyVersion,
              @preconditions, @expiresAt, @actorId,
              @provenance, @providerModel, @correlationId,
              @supersededAt, @createdAt)
      RETURNING *
    `);

    this.stmt.selectProposal = this.db.prepare(`
      SELECT * FROM action_proposals WHERE id = ?
    `);

    this.stmt.selectActiveProposal = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE budget_id = @budgetId
         AND json_extract(payload, '$.transactionId') IS @transactionId
         AND operation = @operation
         AND superseded_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
    `);

    this.stmt.selectProposalByExactKey = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE budget_id = @budgetId
         AND json_extract(payload, '$.transactionId') IS @transactionId
         AND operation = @operation
         AND payload_hash = @payloadHash
       LIMIT 1
    `);

    this.stmt.supersedeProposalStmt = this.db.prepare(`
      UPDATE action_proposals
         SET superseded_at = @now
       WHERE id = @id
    `);

    // ── Approvals ─────────────────────────────────────────────────────

    this.stmt.insertApproval = this.db.prepare(`
      INSERT OR IGNORE INTO proposal_approvals (id, proposal_id, payload_hash, actor_id,
                                      issuer_membership_id, governance_policy_version,
                                      reauthenticated_session_id, reauthenticated_at,
                                      status, expires_at, consumed_at, superseded_at, created_at)
      VALUES (@id, @proposalId, @payloadHash, @actorId,
              @issuerMembershipId, @governancePolicyVersion,
              @reauthenticatedSessionId, @reauthenticatedAt,
              'active', @expiresAt, NULL, NULL, @createdAt)
      RETURNING *
    `);

    this.stmt.selectApproval = this.db.prepare(`
      SELECT * FROM proposal_approvals WHERE id = ?
    `);

    this.stmt.selectActiveApprovals = this.db.prepare(`
      SELECT * FROM proposal_approvals
       WHERE proposal_id = @proposalId
         AND status = 'active'
         AND expires_at > @now
         AND consumed_at IS NULL
         AND superseded_at IS NULL
       ORDER BY created_at ASC
    `);

    this.stmt.consumeApprovalStmt = this.db.prepare(`
      UPDATE proposal_approvals
         SET status = 'consumed',
             consumed_at = @now
       WHERE id = @id
         AND status = 'active'
         AND consumed_at IS NULL
         AND expires_at > @now
    `);

    this.stmt.supersedeProposalApprovals = this.db.prepare(`
      UPDATE proposal_approvals
         SET status = 'superseded',
             superseded_at = @now
       WHERE proposal_id = @proposalId
         AND status = 'active'
    `);

    this.stmt.selectProposalStatus = this.db.prepare(`
      SELECT superseded_at FROM action_proposals WHERE id = ?
    `);

    this.stmt.listProposals = this.db.prepare(`
      SELECT * FROM action_proposals
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsActive = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsByBudget = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE budget_id = @budgetId
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsByBudgetActive = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsSuperseded = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE superseded_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsSupersededByBudget = this.db.prepare(`
      SELECT * FROM action_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.markExpiredApprovals = this.db.prepare(`
      UPDATE proposal_approvals
         SET status = 'expired'
       WHERE status = 'active'
         AND expires_at <= @now
    `);

    this.stmt.selectExpiredApprovals = this.db.prepare(`
      SELECT id FROM proposal_approvals
       WHERE status = 'active'
         AND expires_at <= @now
    `);

    this.stmt.selectApprovalByProposalActor = this.db.prepare(`
      SELECT * FROM proposal_approvals
       WHERE proposal_id = @proposalId AND actor_id = @actorId
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1
    `);

    // ── Idempotency ───────────────────────────────────────────────────

    this.stmt.insertIdempotency = this.db.prepare(`
      INSERT INTO idempotency_records (idempotency_key, proposal_id, operation,
                                       executed_at, completed, idempotency_status,
                                       lease_expires_at, serialised_effect,
                                       error_message, updated_at)
      VALUES (@idempotencyKey, @proposalId, @operation,
              @executedAt, 0, 'in_progress',
              @leaseExpiresAt, @serialisedEffect,
              NULL, @updatedAt)
      ON CONFLICT(idempotency_key) DO NOTHING
      RETURNING *
    `);

    this.stmt.selectIdempotency = this.db.prepare(`
      SELECT * FROM idempotency_records WHERE idempotency_key = ?
    `);

    this.stmt.selectIdempotencyByProposalOp = this.db.prepare(`
      SELECT * FROM idempotency_records WHERE proposal_id = @proposalId AND operation = @operation
    `);

    this.stmt.selectProposalExecutionAcquisition = this.db.prepare(`
      SELECT * FROM proposal_execution_acquisitions WHERE proposal_id = ?
    `);

    this.stmt.insertProposalExecutionAcquisition = this.db.prepare(`
      INSERT INTO proposal_execution_acquisitions (proposal_id, idempotency_key, actor_id, acquired_at)
      VALUES (@proposalId, @idempotencyKey, @actorId, @acquiredAt)
      ON CONFLICT DO NOTHING
      RETURNING proposal_id
    `);

    this.stmt.completeIdempotencyStmt = this.db.prepare(`
      UPDATE idempotency_records
         SET completed = 1,
             idempotency_status = @status,
             error_message = @errorMessage,
             serialised_result = CASE WHEN @status = 'succeeded' THEN @serialisedResult ELSE NULL END,
             updated_at = @now
       WHERE idempotency_key = @key
         AND idempotency_status IN ('in_progress', 'retryable_failed')
    `);
    this.stmt.updateIdempotencyStatusStmt = this.db.prepare(`
      UPDATE idempotency_records
         SET idempotency_status = @status,
             error_message = @errorMessage,
             updated_at = @now
       WHERE idempotency_key = @key
    `);

    this.stmt.selectStrandedIdempotencyStmt = this.db.prepare(`
      SELECT * FROM idempotency_records
       WHERE idempotency_status = 'in_progress'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= @now
    `);

    this.stmt.updateStrandedIdempotencyStmt = this.db.prepare(`
      UPDATE idempotency_records
         SET idempotency_status = 'retryable_failed',
             error_message = @errorMessage,
             updated_at = @now
       WHERE idempotency_status = 'in_progress'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= @now
    `);

    // ── Audit ─────────────────────────────────────────────────────────

    this.stmt.insertAudit = this.db.prepare(`
      INSERT INTO audit_records (id, classification, timestamp, actor_id,
                                 operation, proposal_id, payload_hash,
                                 budget_id, backend_ids, policy_version,
                                 authorization_disposition, idempotency_key,
                                 expected_prior_state, observed_result_state,
                                 provider_model, correlation_id, request_id,
                                 result, is_error)
      VALUES (@id, @classification, @timestamp, @actorId,
              @operation, @proposalId, @payloadHash,
              @budgetId, @backendIds, @policyVersion,
              @authorizationDisposition, @idempotencyKey,
              @expectedPriorState, @observedResultState,
              @providerModel, @correlationId, @requestId,
              @result, @isError)
    `);

    this.stmt.selectAuditByClassification = this.db.prepare(`
      SELECT * FROM audit_records
       WHERE (@classification IS NULL OR classification = @classification)
       ORDER BY timestamp DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectAuditByProposal = this.db.prepare(`
      SELECT * FROM audit_records
       WHERE proposal_id = @proposalId
       ORDER BY timestamp DESC
       LIMIT @limit
    `);

    this.stmt.selectAuditCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_records
    `);

    // ── Corrections ──────────────────────────────────────────────────────

    this.stmt.insertCorrection = this.db.prepare(`
      INSERT INTO review_corrections (id, review_item_id, transaction_id,
                                      transaction_version, merchant, imported_payee,
                                      account_id, direction, amount, date,
                                      category_id, category_name, previous_category_id,
                                      proposal_id, proposal_actor_id, payload_hash,
                                      idempotency_key, verified, actor,
                                      from_status, to_status, source_review_id,
                                      created_at)
      VALUES (@id, @reviewItemId, @transactionId,
              @transactionVersion, @merchant, @importedPayee,
              @accountId, @direction, @amount, @date,
              @categoryId, @categoryName, @previousCategoryId,
              @proposalId, @proposalActorId, @payloadHash,
              @idempotencyKey, @verified, @actor,
              @fromStatus, @toStatus, @sourceReviewId,
              @createdAt)
    `);

    this.stmt.selectCorrectionByIdempotencyKey = this.db.prepare(`
      SELECT * FROM review_corrections WHERE idempotency_key = ?
    `);


    this.stmt.selectCorrectionByReviewTransition = this.db.prepare(`
      SELECT * FROM review_corrections
       WHERE review_item_id = @reviewItemId
         AND from_status = @fromStatus
         AND to_status = @toStatus
       LIMIT 1
    `);

    this.stmt.selectCorrectionsByReview = this.db.prepare(`
      SELECT * FROM review_corrections
       WHERE review_item_id = @reviewItemId
       ORDER BY created_at ASC
    `);

    this.stmt.selectCorrectionsByMerchant = this.db.prepare(`
      SELECT * FROM review_corrections
       WHERE merchant = @merchant
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectCorrectionsByTransaction = this.db.prepare(`
      SELECT * FROM review_corrections
       WHERE transaction_id = @transactionId
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectCorrectionsByActor = this.db.prepare(`
      SELECT * FROM review_corrections
       WHERE actor = @actor
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectAllCorrections = this.db.prepare(`
      SELECT * FROM review_corrections
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectCorrectionConflicts = this.db.prepare(`
      WITH merchant_groups AS (
        SELECT merchant, category_id AS value, 'category' AS field, id AS cid
          FROM review_corrections
         WHERE merchant IS NOT NULL
         UNION ALL
        SELECT merchant, direction, 'direction', id
          FROM review_corrections
         WHERE merchant IS NOT NULL AND direction IS NOT NULL
         UNION ALL
        SELECT merchant, account_id, 'account', id
          FROM review_corrections
         WHERE merchant IS NOT NULL AND account_id IS NOT NULL
      )
      SELECT field, merchant,
             GROUP_CONCAT(DISTINCT value) AS values_json,
             GROUP_CONCAT(DISTINCT cid) AS correction_ids
        FROM merchant_groups
       GROUP BY field, merchant
      HAVING COUNT(DISTINCT value) > 1
       ORDER BY merchant, field
       LIMIT @limit
    `);
    // ── Actor memberships ──────────────────────────────────────────────

    this.stmt.upsertActorMembershipStmt = this.db.prepare(`
      INSERT INTO actor_memberships (actor_id, status, capabilities, scope)
      VALUES (@actorId, @status, @capabilities, @scope)
      ON CONFLICT(actor_id) DO UPDATE SET
        status = @status,
        capabilities = @capabilities,
        scope = @scope
    `);

    this.stmt.selectActorMembership = this.db.prepare(`
      SELECT * FROM actor_memberships WHERE actor_id = ?
    `);

    // ── Lifecycle ──────────────────────────────────────────────────────

    this.stmt.cancelPendingJobsStmt = this.db.prepare(`
      DELETE FROM candidate_jobs
       WHERE status = 'pending'
         AND space_id = @spaceId
         AND budget_id = @budgetId
         AND (@actorOnly = 0 OR actor_id = @actorId)
    `);

    this.stmt.deleteMembershipStmt = this.db.prepare(`
      DELETE FROM actor_memberships WHERE actor_id = ?
    `);

    this.stmt.insertExportRecordStmt = this.db.prepare(`
      INSERT INTO export_records (
        id, budget_name, export_path, account_count, transaction_count, exported_at,
        space_id, budget_id, actor_id, sha256_hash, byte_size
      )
      VALUES (
        @id, @budgetName, @exportPath, @accountCount, @transactionCount, @exportedAt,
        @spaceId, @budgetId, @actorId, @sha256Hash, @byteSize
      )
    `);

    this.stmt.selectLastExportStmt = this.db.prepare(`
      SELECT * FROM export_records
       WHERE space_id = @spaceId AND budget_id = @budgetId AND actor_id = @actorId
         AND sha256_hash IS NOT NULL AND byte_size IS NOT NULL
       ORDER BY exported_at DESC, id DESC
       LIMIT 1
    `);

    // ── Rule overrides ─────────────────────────────────────────────────

    this.stmt.insertRuleOverride = this.db.prepare(`
      INSERT INTO rule_overrides (
        space_id, budget_id, rule_id, inactive, version, created_at, updated_at
      )
      VALUES (@spaceId, @budgetId, @ruleId, @inactive, 1, @now, @now)
      ON CONFLICT(space_id, budget_id, rule_id) DO NOTHING
    `);

    this.stmt.updateRuleOverride = this.db.prepare(`
      UPDATE rule_overrides
         SET inactive = @inactive,
             version = version + 1,
             updated_at = @now
       WHERE space_id = @spaceId
         AND budget_id = @budgetId
         AND rule_id = @ruleId
         AND version = @expectedVersion
    `);

    this.stmt.getRuleOverride = this.db.prepare(`
      SELECT rule_id, inactive, version
        FROM rule_overrides
       WHERE space_id = @spaceId
         AND budget_id = @budgetId
         AND rule_id = @ruleId
    `);

    this.stmt.getAllRuleOverrides = this.db.prepare(`
      SELECT rule_id, inactive, version
        FROM rule_overrides
       WHERE space_id = @spaceId
         AND budget_id = @budgetId
         AND inactive IS NOT NULL
    `);

    this.stmt.removeRuleOverride = this.db.prepare(`
      UPDATE rule_overrides
         SET inactive = NULL,
             version = version + 1,
             updated_at = @now
       WHERE space_id = @spaceId
         AND budget_id = @budgetId
         AND rule_id = @ruleId
         AND version = @expectedVersion
    `);

    // ── Schema version ──────────────────────────────────────────────────

    this.stmt.selectSchemaVersion = this.db.prepare(`
      SELECT version FROM schema_version ORDER BY version DESC LIMIT 1
    `);

    this.stmt.upsertSchemaVersion = this.db.prepare(`
      INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (@version, @appliedAt)
    `);

    // ── Count queries (pagination totals) ───────────────────────────────

    this.stmt.countReviewItems = this.db.prepare(`
      SELECT COUNT(*) AS count FROM review_items WHERE 1=1
    `);

    this.stmt.countReviewItemsByStatus = this.db.prepare(`
      SELECT COUNT(*) AS count FROM review_items WHERE status = @status
    `);

    this.stmt.countReviewItemsByBudget = this.db.prepare(`
      SELECT COUNT(*) AS count FROM review_items
       WHERE budget_id = @budgetId AND (@status IS NULL OR status = @status)
    `);

    this.stmt.countProposals = this.db.prepare(`
      SELECT COUNT(*) AS count FROM action_proposals
    `);

    this.stmt.countProposalsActive = this.db.prepare(`
      SELECT COUNT(*) AS count FROM action_proposals
       WHERE superseded_at IS NULL
    `);

    this.stmt.countProposalsByBudget = this.db.prepare(`
      SELECT COUNT(*) AS count FROM action_proposals
       WHERE budget_id = @budgetId
    `);

    this.stmt.countProposalsByBudgetActive = this.db.prepare(`
      SELECT COUNT(*) AS count FROM action_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NULL
    `);

    this.stmt.countProposalsSuperseded = this.db.prepare(`
      SELECT COUNT(*) AS count FROM action_proposals
       WHERE superseded_at IS NOT NULL
    `);

    this.stmt.countProposalsSupersededByBudget = this.db.prepare(`
      SELECT COUNT(*) AS count FROM action_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NOT NULL
    `);

    // ── Registration ──────────────────────────────────────────────────

    this.stmt.selectRegistrationState = this.db.prepare(`
      SELECT * FROM registration_state WHERE singleton = 1
    `);
    this.stmt.insertRegistrationClaim = this.db.prepare(`
      INSERT INTO registration_state (singleton, claim_id, claimed_email, claimed_name, claimed_at)
      VALUES (1, @claimId, @email, @name, @claimedAt)
    `);

    this.stmt.finalizeRegistration = this.db.prepare(`
      UPDATE registration_state
         SET owner_user_id = @ownerUserId,
             bootstrapped_at = @bootstrappedAt
       WHERE singleton = 1
         AND claim_id = @claimId
         AND owner_user_id IS NULL
    `);

    // ── Invitations ─────────────────────────────────────────────────────

    this.stmt.insertInvitation = this.db.prepare(`
      INSERT INTO invitations (id, token_digest, status, created_by_user_id, expires_at, created_at,
        space_id, issuer_membership_id, governance_policy_version)
      VALUES (@id, @tokenDigest, 'active', @createdByUserId, @expiresAt, @createdAt,
        @spaceId, @issuerMembershipId, @governancePolicyVersion)
    `);

    this.stmt.selectInvitation = this.db.prepare(`
      SELECT * FROM invitations WHERE id = ?
    `);

    this.stmt.selectInvitationByDigest = this.db.prepare(`
      SELECT * FROM invitations WHERE token_digest = ?
    `);

    this.stmt.selectAllInvitations = this.db.prepare(`
      SELECT * FROM invitations WHERE space_id=@spaceId ORDER BY created_at DESC
    `);

    this.stmt.updateInvitationClaim = this.db.prepare(`
      UPDATE invitations
         SET status = 'claimed',
             claimed_email = @email,
             claim_id = @claimId,
             claimed_at = @claimedAt
       WHERE id = @id
         AND status = 'active'
    `);

    this.stmt.updateInvitationRevoke = this.db.prepare(`
      UPDATE invitations
         SET status = 'revoked'
       WHERE id = @id
         AND status IN ('active', 'claimed')
    `);

    this.stmt.updateInvitationExpired = this.db.prepare(`
      UPDATE invitations
         SET status = 'expired'
       WHERE id = @id
         AND status IN ('active', 'claimed')
         AND expires_at <= @now
    `);

    this.stmt.updateInvitationRedeemed = this.db.prepare(`
      UPDATE invitations
         SET status = 'redeemed',
             redeemed_user_id = @userId,
             redeemed_at = @redeemedAt
       WHERE claim_id = @claimId
         AND status = 'claimed'
    `);

    // ── Notification events ────────────────────────────────────────────

    this.stmt.insertNotificationEvent = this.db.prepare(`
      INSERT INTO notification_events (id, event_version, budget_id, classification,
                                       recipient_id, scope, redaction_class,
                                       channel_config_version, policy_version,
                                       correlation_id, payload, created_at, dedup_key,
                                       space_id, recipient_membership_id)
      VALUES (@id, @eventVersion, @budgetId, @classification,
              @recipientId, @scope, @redactionClass,
              @channelConfigVersion, @policyVersion,
              @correlationId, @payload, @createdAt, @dedupKey,
              @spaceId, @recipientMembershipId)
    `);

    this.stmt.insertOrIgnoreNotificationEvent = this.db.prepare(`
      INSERT OR IGNORE INTO notification_events (
        id, event_version, budget_id, classification, recipient_id, scope,
        redaction_class, channel_config_version, policy_version, correlation_id,
        payload, created_at, dedup_key, space_id, recipient_membership_id
      )
      VALUES (
        @id, @eventVersion, @budgetId, @classification, @recipientId, @scope,
        @redactionClass, @channelConfigVersion, @policyVersion, @correlationId,
        @payload, @createdAt, @dedupKey, @spaceId, @recipientMembershipId
      )
    `);

    this.stmt.selectNotificationEvent = this.db.prepare(`
      SELECT * FROM notification_events WHERE id = ?
    `);

    this.stmt.selectNotificationEventByDedupIdentity = this.db.prepare(`
      SELECT * FROM notification_events
       WHERE dedup_key = @dedupKey
         AND recipient_id IS @recipientId
         AND scope IS @scope
         AND budget_id = @budgetId
         AND space_id IS @spaceId
         AND recipient_membership_id IS @recipientMembershipId
    `);

    // ── Notification outbox ────────────────────────────────────────────

    this.stmt.insertOutbox = this.db.prepare(`
      INSERT INTO notification_outbox (id, event_id, delivery_key, channel_type,
                                       channel_config_version, status, attempt_count,
                                       max_attempts, claim_token, claim_expires_at,
                                       last_attempted_at, next_attempt_at,
                                       acknowledged_at, failed_at, failure_reason,
                                       suppressed_at, suppressed_reason,
                                       correlation_id, created_at, updated_at)
      VALUES (@id, @eventId, @deliveryKey, @channelType,
              @channelConfigVersion, 'pending', 0,
              @maxAttempts, NULL, NULL,
              NULL, NULL,
              NULL, NULL, NULL,
              NULL, NULL,
              @correlationId, @now, @now)
    `);

    this.stmt.selectOutbox = this.db.prepare(`
      SELECT * FROM notification_outbox WHERE id = ?
    `);

    this.stmt.selectOutboxByEventChannel = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE event_id = @eventId
         AND channel_type = @channelType
         AND delivery_key = @deliveryKey
       LIMIT 1
    `);

    this.stmt.claimOutboxPending = this.db.prepare(`
      UPDATE notification_outbox
         SET status = 'delivering',
             claim_token = @claimToken,
             claim_expires_at = @expiresAt,
             last_attempted_at = @now,
             attempt_count = attempt_count + 1,
             updated_at = @now
       WHERE id = @outboxId
         AND status = 'pending'
    `);

    this.stmt.claimOutboxExpired = this.db.prepare(`
      UPDATE notification_outbox
         SET status = 'delivering',
             claim_token = @claimToken,
             claim_expires_at = @expiresAt,
             last_attempted_at = @now,
             attempt_count = attempt_count + 1,
             updated_at = @now
       WHERE id = @outboxId
         AND status = 'delivering'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < @now
    `);

    this.stmt.claimOutboxRetryable = this.db.prepare(`
      UPDATE notification_outbox
         SET status = 'delivering',
             claim_token = @claimToken,
             claim_expires_at = @expiresAt,
             last_attempted_at = @now,
             attempt_count = attempt_count + 1,
             next_attempt_at = NULL,
             updated_at = @now
       WHERE id = @outboxId
         AND status = 'failed'
         AND next_attempt_at IS NOT NULL
         AND next_attempt_at <= @now
    `);

    this.stmt.selectClaimedOutbox = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE id = @outboxId AND claim_token = @claimToken
    `);

    this.stmt.completeOutbox = this.db.prepare(`
      UPDATE notification_outbox
         SET status = 'delivered',
             claim_token = NULL,
             claim_expires_at = NULL,
             updated_at = @now
       WHERE id = @outboxId
         AND status = 'delivering'
         AND claim_token = @claimToken
    `);

    this.stmt.failOutbox = this.db.prepare(`
      UPDATE notification_outbox
         SET status = 'failed',
             claim_token = NULL,
             claim_expires_at = NULL,
             failed_at = @now,
             failure_reason = @errorMessage,
             updated_at = @now
       WHERE id = @outboxId
         AND status = 'delivering'
         AND claim_token = @claimToken
    `);

    this.stmt.scheduleRetryOutbox = this.db.prepare(`
      UPDATE notification_outbox
         SET next_attempt_at = @nextAttemptAt,
             updated_at = @now
       WHERE id = @outboxId
    `);

    this.stmt.acknowledgeOutbox = this.db.prepare(`
      UPDATE notification_outbox
         SET acknowledged_at = @now,
             updated_at = @now
       WHERE id = @outboxId
         AND status = 'delivered'
    `);

    this.stmt.suppressOutbox = this.db.prepare(`
      UPDATE notification_outbox
         SET status = 'suppressed',
             suppressed_at = @now,
             suppressed_reason = @reason,
             updated_at = @now
       WHERE id = @outboxId
         AND status IN ('pending', 'delivering', 'failed')
    `);

    this.stmt.selectPendingOutbox = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT @limit
    `);

    this.stmt.selectPendingOutboxByChannel = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE status = 'pending'
         AND channel_type = @channelType
       ORDER BY created_at ASC
       LIMIT @limit
    `);

    this.stmt.selectRetryableOutbox = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE status = 'failed'
         AND next_attempt_at IS NOT NULL
         AND next_attempt_at <= @now
       ORDER BY next_attempt_at ASC
       LIMIT @limit
    `);

    this.stmt.selectRetryableOutboxByChannel = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE status = 'failed'
         AND channel_type = @channelType
         AND next_attempt_at IS NOT NULL
         AND next_attempt_at <= @now
       ORDER BY next_attempt_at ASC
       LIMIT @limit
    `);

    this.stmt.selectListOutbox = this.db.prepare(`
      SELECT * FROM notification_outbox
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectListOutboxByStatus = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE status = @status
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectListOutboxByChannel = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE channel_type = @channelType
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectListOutboxByStatusChannel = this.db.prepare(`
      SELECT * FROM notification_outbox
       WHERE status = @status
         AND channel_type = @channelType
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    // ── Delivery attempts ──────────────────────────────────────────────

    this.stmt.insertDeliveryAttempt = this.db.prepare(`
      INSERT INTO delivery_attempts (id, outbox_id, attempt_number, status,
                                     response_code, response_body, error_message,
                                     attempted_at)
      VALUES (@id, @outboxId, @attemptNumber, @status,
              @responseCode, @responseBody, @errorMessage,
            @attemptedAt)
    `);

    this.stmt.selectDeliveryAttempts = this.db.prepare(`
      SELECT * FROM delivery_attempts
       WHERE outbox_id = @outboxId
       ORDER BY attempt_number ASC
    `);

    // ── Policy versions ────────────────────────────────────────────────

    this.stmt.insertPolicyVersion = this.db.prepare(`
      INSERT INTO policy_versions (id, policy_key, version, policy_hash,
                                   description, is_active, superseded_at, created_at)
      VALUES (@id, @policyKey, @version, @policyHash,
              @description, 1, NULL, @createdAt)
    `);

    this.stmt.selectPolicyVersion = this.db.prepare(`
      SELECT * FROM policy_versions WHERE id = ?
    `);

    this.stmt.selectActivePolicyVersion = this.db.prepare(`
      SELECT * FROM policy_versions
       WHERE policy_key = @policyKey
         AND is_active = 1
       LIMIT 1
    `);

    this.stmt.supersedePolicyVersions = this.db.prepare(`
      UPDATE policy_versions
         SET is_active = 0,
             superseded_at = @now
       WHERE policy_key = @policyKey
         AND is_active = 1
    `);

    this.stmt.listPolicyVersions = this.db.prepare(`
      SELECT * FROM policy_versions
       WHERE policy_key = @policyKey
       ORDER BY version DESC
       LIMIT @limit OFFSET @offset
    `);

    // ── Saved filters ──────────────────────────────────────────────────

    this.stmt.insertSavedFilter = this.db.prepare(`
      INSERT INTO saved_filters (id, name, budget_id, filter_config,
                                 view_config, scope, policy_version,
                                 is_default, actor_id, created_at, updated_at)
      VALUES (@id, @name, @budgetId, @filterConfig,
              @viewConfig, @scope, @policyVersion,
              @isDefault, @actorId, @now, @now)
    `);

    this.stmt.selectSavedFilter = this.db.prepare(`
      SELECT * FROM saved_filters WHERE id = ?
    `);

    this.stmt.updateSavedFilter = this.db.prepare(`
      UPDATE saved_filters
         SET name = COALESCE(@name, name),
             filter_config = COALESCE(@filterConfig, filter_config),
             view_config = @viewConfig,
             scope = COALESCE(@scope, scope),
             policy_version = COALESCE(@policyVersion, policy_version),
             is_default = COALESCE(@isDefault, is_default),
             updated_at = @now
       WHERE id = @id
    `);

    this.stmt.demoteDefaultFilter = this.db.prepare(`
      UPDATE saved_filters
         SET is_default = 0,
             updated_at = @now
       WHERE is_default = 1
         AND (budget_id IS NULL OR budget_id = @budgetId)
         AND scope = @scope
    `);

    this.stmt.deleteSavedFilter = this.db.prepare(`
      DELETE FROM saved_filters WHERE id = ?
    `);

    this.stmt.listSavedFilters = this.db.prepare(`
      SELECT * FROM saved_filters
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listSavedFiltersByBudget = this.db.prepare(`
      SELECT * FROM saved_filters
       WHERE budget_id = @budgetId
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listSavedFiltersByScope = this.db.prepare(`
      SELECT * FROM saved_filters
       WHERE scope = @scope
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listSavedFiltersByActor = this.db.prepare(`
      SELECT * FROM saved_filters
       WHERE actor_id = @actorId
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    // ── Report records ─────────────────────────────────────────────────

    this.stmt.insertReportRecord = this.db.prepare(`
      INSERT INTO report_records (id, report_type, budget_id, filter_id,
                                  config, policy_version, generated_at,
                                  expires_at, data_ref)
      VALUES (@id, @reportType, @budgetId, @filterId,
              @config, @policyVersion, @generatedAt,
              @expiresAt, @dataRef)
    `);

    this.stmt.selectReportRecord = this.db.prepare(`
      SELECT * FROM report_records WHERE id = ?
    `);

    this.stmt.listReportRecords = this.db.prepare(`
      SELECT * FROM report_records
       ORDER BY generated_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReportRecordsByBudget = this.db.prepare(`
      SELECT * FROM report_records
       WHERE budget_id = @budgetId
       ORDER BY generated_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReportRecordsByType = this.db.prepare(`
      SELECT * FROM report_records
       WHERE report_type = @reportType
       ORDER BY generated_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.expireReportRecord = this.db.prepare(`
      UPDATE report_records
         SET expires_at = @now
       WHERE id = @id
    `);

    // ── Saved views ────────────────────────────────────────────────────

    this.stmt.validateSavedViewAuthority = this.db.prepare(`
      SELECT 1
        FROM space_memberships AS m
        JOIN spaces AS s ON s.id = m.space_id
       WHERE m.id = @membershipId
         AND m.space_id = @spaceId
         AND m.actor_id = @actorId
         AND m.valid_from <= @now
         AND (m.valid_until IS NULL OR @now < m.valid_until)
         AND m.revoked_at IS NULL
         AND s.budget_id = @budgetId
         AND s.deleted_at IS NULL
    `);

    this.stmt.insertSavedView = this.db.prepare(`
      INSERT INTO saved_views (
        view_id, name, view_type, scope, sort, actor_id,
        space_id, budget_id, membership_id, created_at
      )
      VALUES (
        @viewId, @name, @viewType, @scope, @sort, @actorId,
        @spaceId, @budgetId, @membershipId, @createdAt
      )
    `);

    this.stmt.selectSavedView = this.db.prepare(`
      SELECT v.*
        FROM saved_views AS v
        JOIN space_memberships AS m ON m.id = v.membership_id
        JOIN spaces AS s ON s.id = v.space_id
       WHERE v.view_id = @viewId
         AND v.actor_id = @actorId
         AND v.space_id = @spaceId
         AND v.budget_id = @budgetId
         AND v.membership_id = @membershipId
         AND m.space_id = @spaceId
         AND m.actor_id = @actorId
         AND m.valid_from <= @now
         AND (m.valid_until IS NULL OR @now < m.valid_until)
         AND m.revoked_at IS NULL
         AND s.budget_id = @budgetId
         AND s.deleted_at IS NULL
    `);

    this.stmt.listSavedViewsByAuthority = this.db.prepare(`
      SELECT v.*
        FROM saved_views AS v
        JOIN space_memberships AS m ON m.id = v.membership_id
        JOIN spaces AS s ON s.id = v.space_id
       WHERE v.actor_id = @actorId
         AND v.space_id = @spaceId
         AND v.budget_id = @budgetId
         AND v.membership_id = @membershipId
         AND m.space_id = @spaceId
         AND m.actor_id = @actorId
         AND m.valid_from <= @now
         AND (m.valid_until IS NULL OR @now < m.valid_until)
         AND m.revoked_at IS NULL
         AND s.budget_id = @budgetId
         AND s.deleted_at IS NULL
       ORDER BY v.created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.updateSavedView = this.db.prepare(`
      UPDATE saved_views
         SET name = COALESCE(@name, name),
             scope = COALESCE(@scope, scope),
             sort = @sort
       WHERE view_id = @viewId
         AND actor_id = @actorId
         AND space_id = @spaceId
         AND budget_id = @budgetId
         AND membership_id = @membershipId
         AND EXISTS (
           SELECT 1
             FROM space_memberships AS m
             JOIN spaces AS s ON s.id = m.space_id
            WHERE m.id = @membershipId
              AND m.space_id = @spaceId
              AND m.actor_id = @actorId
              AND m.valid_from <= @now
              AND (m.valid_until IS NULL OR @now < m.valid_until)
              AND m.revoked_at IS NULL
              AND s.budget_id = @budgetId
              AND s.deleted_at IS NULL
         )
    `);

    this.stmt.deleteSavedView = this.db.prepare(`
      DELETE FROM saved_views
       WHERE view_id = @viewId
         AND actor_id = @actorId
         AND space_id = @spaceId
         AND budget_id = @budgetId
         AND membership_id = @membershipId
         AND EXISTS (
           SELECT 1
             FROM space_memberships AS m
             JOIN spaces AS s ON s.id = m.space_id
            WHERE m.id = @membershipId
              AND m.space_id = @spaceId
              AND m.actor_id = @actorId
              AND m.valid_from <= @now
              AND (m.valid_until IS NULL OR @now < m.valid_until)
              AND m.revoked_at IS NULL
              AND s.budget_id = @budgetId
              AND s.deleted_at IS NULL
         )
    `);

    this.stmt.recordSavedViewUsage = this.db.prepare(`
      UPDATE saved_views
         SET last_used_at = @now
       WHERE view_id = @viewId
         AND actor_id = @actorId
         AND space_id = @spaceId
         AND budget_id = @budgetId
         AND membership_id = @membershipId
         AND EXISTS (
           SELECT 1
             FROM space_memberships AS m
             JOIN spaces AS s ON s.id = m.space_id
            WHERE m.id = @membershipId
              AND m.space_id = @spaceId
              AND m.actor_id = @actorId
              AND m.valid_from <= @now
              AND (m.valid_until IS NULL OR @now < m.valid_until)
              AND m.revoked_at IS NULL
              AND s.budget_id = @budgetId
              AND s.deleted_at IS NULL
         )
    `);

    // ── Findings ────────────────────────────────────────────────────────

    this.stmt.insertFinding = this.db.prepare(`
      INSERT INTO findings (id, budget_id, classification, description,
                            evidence, evidence_refs, severity, status,
                            actor_id, acknowledged_at, acknowledged_by,
                            corrected_at, corrected_by, correction_ref,
                            dismissed_at, dismissed_by, dismissed_reason,
                            reopened_at, reopened_by,
                            superseded_at, superseded_by, superseded_reason,
                            expires_at, version, created_at, updated_at)
      VALUES (@id, @budgetId, @classification, @description,
              @evidence, @evidenceRefs, @severity, @status,
              @actorId, @acknowledgedAt, @acknowledgedBy,
              @correctedAt, @correctedBy, @correctionRef,
              @dismissedAt, @dismissedBy, @dismissedReason,
              @reopenedAt, @reopenedBy,
              @supersededAt, @supersededBy, @supersededReason,
              @expiresAt, @version, @createdAt, @updatedAt)
    `);

    this.stmt.selectFinding = this.db.prepare(`
      SELECT * FROM findings WHERE id = ?
    `);

    this.stmt.listFindings = this.db.prepare(`
      SELECT * FROM findings
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listFindingsByStatus = this.db.prepare(`
      SELECT * FROM findings
       WHERE status = @status
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listFindingsByBudget = this.db.prepare(`
      SELECT * FROM findings
       WHERE budget_id = @budgetId
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listFindingsByBudgetStatus = this.db.prepare(`
      SELECT * FROM findings
       WHERE budget_id = @budgetId
         AND status = @status
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listFindingsByClassification = this.db.prepare(`
      SELECT * FROM findings
       WHERE classification = @classification
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listFindingsBySeverity = this.db.prepare(`
      SELECT * FROM findings
       WHERE severity = @severity
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.countFindings = this.db.prepare(`
      SELECT COUNT(*) AS count FROM findings
    `);

    this.stmt.countFindingsFiltered = this.db.prepare(`
      SELECT COUNT(*) AS count FROM findings
       WHERE (COALESCE(@status, '') = '' OR status = @status)
         AND (COALESCE(@budgetId, '') = '' OR budget_id = @budgetId)
         AND (COALESCE(@classification, '') = '' OR classification = @classification)
         AND (COALESCE(@severity, '') = '' OR severity = @severity)
    `);

    this.stmt.transitionFinding = this.db.prepare(`
      UPDATE findings
         SET status = @toStatus,
             acknowledged_at = @acknowledgedAt,
             acknowledged_by = @acknowledgedBy,
             corrected_at = @correctedAt,
             corrected_by = @correctedBy,
             correction_ref = @correctionRef,
             dismissed_at = @dismissedAt,
             dismissed_by = @dismissedBy,
             dismissed_reason = @dismissedReason,
             reopened_at = @reopenedAt,
             reopened_by = @reopenedBy,
             superseded_at = @supersededAt,
             superseded_by = @supersededBy,
             superseded_reason = @supersededReason,
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND status = @fromStatus
         AND version = @expectedVersion
    `);

    this.stmt.expireFindingStmt = this.db.prepare(`
      UPDATE findings
         SET status = 'expired',
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND status NOT IN ('expired', 'superseded')
    `);

    this.stmt.expireFindingsByDate = this.db.prepare(`
      UPDATE findings
         SET status = 'expired',
             updated_at = @now,
             version = version + 1
       WHERE expires_at IS NOT NULL
         AND expires_at <= @now
         AND status NOT IN ('expired', 'superseded')
    `);

    // ── Notification policies ───────────────────────────────────────────

    this.stmt.insertNotificationPolicy = this.db.prepare(`
      INSERT INTO notification_policies (id, space_id, policy_key, policy_version,
                                         policy, is_active, created_at, updated_at)
      VALUES (@id, @spaceId, @policyKey, @policyVersion,
              @policy, 1, @now, @now)
    `);

    this.stmt.updateNotificationPolicy = this.db.prepare(`
      UPDATE notification_policies
         SET policy_version = @policyVersion,
             policy = @policy,
             is_active = @isActive,
             updated_at = @now
       WHERE space_id = @spaceId
         AND policy_key = @policyKey
    `);

    this.stmt.selectNotificationPolicy = this.db.prepare(`
      SELECT * FROM notification_policies
       WHERE space_id = @spaceId AND policy_key = @policyKey
       LIMIT 1
    `);

    this.stmt.listNotificationPolicies = this.db.prepare(`
      SELECT * FROM notification_policies
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listNotificationPoliciesBySpace = this.db.prepare(`
      SELECT * FROM notification_policies
       WHERE space_id = @spaceId
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.deleteNotificationPolicy = this.db.prepare(`
      DELETE FROM notification_policies WHERE id = ?
    `);

    // ── Report history ──────────────────────────────────────────────────

    this.stmt.listReportHistory = this.db.prepare(`
      SELECT r.id, r.report_type, r.budget_id, r.generated_at, r.config, r.expires_at
        FROM report_records r
       ORDER BY r.generated_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReportHistoryByBudget = this.db.prepare(`
      SELECT r.id, r.report_type, r.budget_id, r.generated_at, r.config, r.expires_at
        FROM report_records r
       WHERE r.budget_id = @budgetId
       ORDER BY r.generated_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.countAllReportRecords = this.db.prepare(`
      SELECT COUNT(*) AS count FROM report_records
    `);

    this.stmt.countReportRecordsByBudget = this.db.prepare(`
      SELECT COUNT(*) AS count FROM report_records WHERE budget_id = @budgetId
    `);
  }

  // ── Suggestion lifecycle ───────────────────────────────────────────

  async saveSuggestion(input: SaveSuggestionInput): Promise<Suggestion> {
    const id = randomUUID();
    const now = nowISO();
    const payloadJson = JSON.stringify(input.payload);

    const txn = this.db.transaction(() => {
      // ── Stale-version detection ────────────────────────────────────
      // If a suggestion already exists (active or superseded) with a
      // higher transactionVersion for the same composite key, the
      // incoming suggestion is stale — save it but immediately supersede
      // so it never becomes the active suggestion (audit trail preserved).
      const versionRow = this.stmt.selectMaxVersion.get({
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        classifier: input.classifier,
        promptVersion: input.promptVersion,
      }) as { max_version: number | null } | undefined;

      const maxVersion = versionRow?.max_version ?? null;

      if (maxVersion !== null && maxVersion > input.transactionVersion) {
        // Stale incoming suggestion — save with supersededAt = now so
        // it is immediately inactive. The higher-version suggestion
        // remains the active one.
        this.stmt.insertSuggestion.run({
          id,
          budgetId: input.budgetId,
          transactionId: input.transactionId,
          categoryId: input.categoryId,
          classifier: input.classifier,
          promptVersion: input.promptVersion,
          payload: payloadJson,
          transactionVersion: input.transactionVersion,
          supersededAt: now,
          createdAt: now,
        });
        return;
      }

      // Fresh (or first) suggestion — supersede any existing active
      // suggestion for the same composite key, then insert as active.
      this.stmt.supersedeMatch.run({
        now,
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        classifier: input.classifier,
        promptVersion: input.promptVersion,
      });

      this.stmt.insertSuggestion.run({
        id,
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        categoryId: input.categoryId,
        classifier: input.classifier,
        promptVersion: input.promptVersion,
        payload: payloadJson,
        transactionVersion: input.transactionVersion,
        supersededAt: null,
        createdAt: now,
      });
    });

    txn();

    const row = this.stmt.selectSuggestion.get(id) as SuggestionRow | undefined;
    if (!row) throw new Error('Failed to read back saved suggestion');
    return rowToSuggestion(row);
  }

  async getActiveSuggestion(
    budgetId: string,
    transactionId: string,
    classifier: string,
    promptVersion: string,
  ): Promise<Suggestion | null> {
    const row = this.stmt.selectActiveSuggestion.get({
      budgetId,
      transactionId,
      classifier,
      promptVersion,
    }) as SuggestionRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  async getSuggestion(id: string): Promise<Suggestion | null> {
    const row = this.stmt.selectSuggestion.get(id) as SuggestionRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  async getTransactionSuggestions(transactionId: string): Promise<Suggestion[]> {
    const rows = this.stmt.selectTransactionSuggestions.all(transactionId) as SuggestionRow[];
    return rows.map(rowToSuggestion);
  }

  async supersedeSuggestions(
    budgetId: string,
    transactionId: string,
    newTransactionVersion: number,
  ): Promise<number> {
    const now = nowISO();
    const result = this.stmt.supersedeByVersion.run({
      now,
      budgetId,
      transactionId,
      newVersion: newTransactionVersion,
    });
    return result.changes;
  }

  // ── Job lifecycle ─────────────────────────────────────────────────

  async enqueueJob(input: EnqueueJobInput): Promise<CandidateJob> {
    const suppliedScope = [input.spaceId, input.budgetId, input.actorId].some(
      (value) => value !== undefined,
    );
    if (
      suppliedScope &&
      (typeof input.spaceId !== 'string' ||
        !input.spaceId.trim() ||
        typeof input.budgetId !== 'string' ||
        !input.budgetId.trim() ||
        typeof input.actorId !== 'string' ||
        !input.actorId.trim())
    )
      throw new Error('Scoped jobs require spaceId, budgetId, and actorId');
    const scope = suppliedScope
      ? { spaceId: input.spaceId!, budgetId: input.budgetId!, actorId: input.actorId! }
      : null;
    if (scope) this.assertLifecycleScope(scope);

    const id = randomUUID();
    const now = nowISO();
    const row = this.stmt.upsertJob.get({
      id,
      jobType: input.jobType,
      candidateId: input.candidateId,
      now,
      spaceId: scope?.spaceId ?? null,
      budgetId: scope?.budgetId ?? null,
      actorId: scope?.actorId ?? null,
    }) as JobRow | undefined;

    if (!row) {
      const existing = this.stmt.selectJobByCandidate.get({
        jobType: input.jobType,
        candidateId: input.candidateId,
      }) as JobRow | undefined;
      if (!existing) throw new Error('Failed to enqueue or retrieve job');
      if (
        existing.space_id !== (scope?.spaceId ?? null) ||
        existing.budget_id !== (scope?.budgetId ?? null) ||
        existing.actor_id !== (scope?.actorId ?? null)
      )
        throw new Error('Candidate job already exists in a different lifecycle scope');
      return rowToJob(existing);
    }

    return rowToJob(row);
  }

  async claimJob(
    jobId: string,
    claimToken: string,
    claimTimeoutMs: number = 60_000,
  ): Promise<CandidateJob | null> {
    const now = nowISO();
    const expiresAt = new Date(Date.now() + claimTimeoutMs).toISOString();

    // 1. Try to claim a pending job
    const pendingResult = this.stmt.claimJobPending.run({
      jobId,
      claimToken,
      now,
      expiresAt,
    });

    if (pendingResult.changes > 0) {
      const row = this.stmt.selectJobById.get(jobId) as JobRow | undefined;
      return row ? rowToJob(row) : null;
    }

    // 2. Try to claim an expired processing job (crash recovery)
    const expiredResult = this.stmt.claimJobExpired.run({
      jobId,
      claimToken,
      now,
      expiresAt,
    });

    if (expiredResult.changes > 0) {
      const row = this.stmt.selectJobById.get(jobId) as JobRow | undefined;
      return row ? rowToJob(row) : null;
    }

    // 3. Idempotent retry: if already claimed with this token, return it
    const claimedRow = this.stmt.selectClaimedJob.get({ jobId, claimToken }) as JobRow | undefined;
    if (claimedRow) {
      return rowToJob(claimedRow);
    }

    return null;
  }

  async completeJob(jobId: string, claimToken: string): Promise<void> {
    const now = nowISO();
    this.stmt.completeJob.run({ jobId, claimToken, now });
  }

  async failJob(
    jobId: string,
    claimToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<FailureRecord> {
    const now = nowISO();
    const failureId = randomUUID();

    // Transaction: update status AND insert failure record atomically.
    // The failure record is only inserted when the state transition
    // succeeds (job was 'processing' with matching claim_token).
    const txn = this.db.transaction(() => {
      const result = this.stmt.failJobStatus.run({ jobId, claimToken, now });

      if (result.changes === 0) {
        // State transition did not happen. This could mean the job is
        // already terminal or the claim token doesn't match.
        // We'll handle idempotency / errors after the transaction.
        return;
      }

      // Transition succeeded — insert failure record
      this.stmt.insertFailure.run({
        id: failureId,
        jobId,
        errorCode,
        errorMessage,
        createdAt: now,
      });
    });

    txn();

    // Determine outcome based on current job state
    const job = this.stmt.selectJobById.get(jobId) as JobRow | undefined;
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Idempotent retry or successful transition: return latest failure record
    if (job.status === 'failed') {
      const failureRow = this.stmt.selectLatestFailure.get(jobId) as FailureRow | undefined;
      if (failureRow) return rowToFailure(failureRow);
      // No failure record found — fall through to error
    }

    // Stale/expired worker: claim token doesn't match the current processing job
    if (job.status === 'processing' && job.claim_token !== claimToken) {
      throw new Error(
        `Cannot fail job ${jobId}: claim token mismatch (current token: ${job.claim_token})`,
      );
    }

    // Job is 'pending' (never claimed) or 'completed' (no failure record) —
    // the transition was rejected because the job wasn't in 'processing'
    // with the matching claim token.
    throw new Error(
      `Cannot fail job ${jobId}: status is '${job.status}', must be 'processing' with matching claim token`,
    );
  }

  // ── Queries ───────────────────────────────────────────────────────

  async getPendingJobs(): Promise<CandidateJob[]> {
    const rows = this.stmt.selectPendingJobs.all({}) as JobRow[];
    return rows.map(rowToJob);
  }

  async getJobByCandidateId(jobType: string, candidateId: string): Promise<CandidateJob | null> {
    const row = this.stmt.selectJobByCandidate.get({ jobType, candidateId }) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  // ── Review lifecycle ──────────────────────────────────────────────

  async createReviewItem(input: CreateReviewItemInput): Promise<ReviewItem> {
    const source = input.sourceTransaction;
    if (source && (
      source.id !== input.transactionId ||
      typeof source.accountId !== 'string' || !source.accountId.trim() ||
      (source.categoryId !== null && (typeof source.categoryId !== 'string' || !source.categoryId.trim())) ||
      (source.direction !== 'incoming' && source.direction !== 'outgoing') ||
      typeof source.amount?.minorUnits !== 'string' || !/^(0|[1-9]\d*)$/.test(source.amount.minorUnits) ||
      BigInt(source.amount.minorUnits) > 9_223_372_036_854_775_807n ||
      typeof source.amount.currency !== 'string' || !/^[A-Z]{3}$/.test(source.amount.currency)
    )) throw new Error('Invalid canonical review source authority');
    const sourceTransaction = source ? canonicalProposalJson({
      id: source.id, accountId: source.accountId, categoryId: source.categoryId,
      direction: source.direction,
      amount: { minorUnits: source.amount.minorUnits, currency: source.amount.currency },
    }) : null;
    return this.db.transaction(() => {
    const id = randomUUID();
    const now = nowISO();
    const inputVersion = input.transactionVersion ?? 1;

    // Check for existing active item for the same issue key
    const existingActive = this.stmt.selectReviewByIssue.get({
      budgetId: input.budgetId,
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      classifier: input.classifier,
    }) as ReviewItemRow | undefined;

    if (existingActive) {
      if (inputVersion <= existingActive.transaction_version) {
        if (sourceTransaction !== null && sourceTransaction !== existingActive.source_transaction_json) {
          this.db.prepare(`UPDATE review_items SET source_transaction_json=?, version=version+1, updated_at=?
            WHERE id=?`).run(sourceTransaction, now, existingActive.id);
          return rowToReviewItem(this.stmt.selectReviewItem.get(existingActive.id) as ReviewItemRow);
        }
        return rowToReviewItem(existingActive);
      }

      // Newer transactionVersion — supersede old item, create new one
      const actionId = randomUUID();

      const txn = this.db.transaction(() => {
        // Supersede the old active item
        this.stmt.supersedeReviewItem.run({
          id: existingActive.id,
          oldStatus: existingActive.status,
          oldVersion: existingActive.version,
          supersededBy: id,
          reason: `Superseded by newer classification (transactionVersion ${inputVersion})`,
          now,
        });

        // Record audit action for the supersession
        this.stmt.insertReviewAction.run({
          id: actionId,
          reviewItemId: existingActive.id,
          fromStatus: existingActive.status,
          toStatus: 'superseded',
          actor: 'system',
          reason: `Superseded by newer snapshot (version ${inputVersion})`,
          metadata: JSON.stringify({ newItemId: id }),
          createdAt: now,
        });

        // Create the new item
        this.stmt.insertReviewItem.run({
          id,
          suggestionId: input.suggestionId ?? null,
          budgetId: input.budgetId,
          transactionId: input.transactionId,
          sourceTransaction,
          categoryId: input.categoryId,
          classifier: input.classifier,
          promptVersion: input.promptVersion ?? '',
          transactionVersion: inputVersion,
          status: 'discovered',
          correlationId: input.correlationId ?? null,
          assignedReviewerId: input.assignedReviewerId ?? null,
          approvedBy: '[]',
          reviewersRequired: input.reviewersRequired ?? 1,
          priority: input.priority ?? 0,
          evidence: JSON.stringify(input.evidence ?? {}),
          provenance: input.provenance,
          supersededBy: null,
          supersededReason: null,
          freshnessExpiresAt: input.freshnessExpiresAt ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      });

      txn();

      const newRow = this.stmt.selectReviewItem.get(id) as ReviewItemRow | undefined;
      if (!newRow) throw new Error('Failed to read back created review item');
      return rowToReviewItem(newRow);
    }

    // No existing active item — insert normally (idempotent via unique partial index)
    const row = this.stmt.insertReviewItem.get({
      id,
      suggestionId: input.suggestionId ?? null,
      budgetId: input.budgetId,
      transactionId: input.transactionId,
      sourceTransaction,
      categoryId: input.categoryId,
      classifier: input.classifier,
      promptVersion: input.promptVersion ?? '',
      transactionVersion: inputVersion,
      status: 'discovered',
      correlationId: input.correlationId ?? null,
      assignedReviewerId: input.assignedReviewerId ?? null,
      approvedBy: '[]',
      reviewersRequired: input.reviewersRequired ?? 1,
      priority: input.priority ?? 0,
      evidence: JSON.stringify(input.evidence ?? {}),
      provenance: input.provenance,
      supersededBy: null,
      supersededReason: null,
      freshnessExpiresAt: input.freshnessExpiresAt ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }) as ReviewItemRow | undefined;

    if (!row) {
      // Rare race: another connection created it; fetch existing
      const existing = this.stmt.selectReviewByIssue.get({
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        categoryId: input.categoryId,
        classifier: input.classifier,
      }) as ReviewItemRow | undefined;
      if (!existing) throw new Error('Failed to create or retrieve review item');
      return rowToReviewItem(existing);
    }

    return rowToReviewItem(row);
    }).immediate();
  }

  async getReviewItem(id: string): Promise<ReviewItem | null> {
    const row = this.stmt.selectReviewItem.get(id) as ReviewItemRow | undefined;
    return row ? rowToReviewItem(row) : null;
  }

  async isProposalReviewProvenanceCurrent(proposalId: string): Promise<boolean> {
    const proposal = this.stmt.selectProposal.get(proposalId) as ProposalRow | undefined;
    return proposal !== undefined && this.proposalReviewProvenanceMatches(proposal);
  }

  private proposalReviewProvenanceMatches(
    row: Pick<ProposalRow, 'operation' | 'budget_id' | 'payload' | 'preconditions'>,
  ): boolean {
    if (row.operation !== 'set_category') return true;
    let payload: unknown;
    let preconditions: unknown;
    try {
      payload = JSON.parse(row.payload) as unknown;
      preconditions = JSON.parse(row.preconditions) as unknown;
    } catch {
      return false;
    }
    if (
      !isPlainRecord(payload) ||
      payload.kind !== 'set_category' ||
      typeof payload.transactionId !== 'string' ||
      !payload.transactionId
    )
      return false;
    if (!isPlainRecord(preconditions)) return false;
    const reviewId = preconditions.reviewId;
    const provenance = preconditions.reviewProvenance;
    if (reviewId === undefined && provenance === undefined) return true;
    if (typeof reviewId !== 'string' || !reviewId || !isPlainRecord(provenance)) return false;
    const fields = ['budgetId', 'transactionId', 'categoryId', 'status', 'version'] as const;
    if (
      Object.keys(provenance).length !== fields.length ||
      fields.some((field) => !(field in provenance)) ||
      typeof provenance.budgetId !== 'string' ||
      !provenance.budgetId ||
      typeof provenance.transactionId !== 'string' ||
      !provenance.transactionId ||
      typeof provenance.categoryId !== 'string' ||
      typeof provenance.version !== 'number' ||
      !Number.isSafeInteger(provenance.version) ||
      (provenance.status !== 'pending_review' && provenance.status !== 'correcting')
    )
      return false;
    const review = this.stmt.selectReviewItem.get(reviewId) as ReviewItemRow | undefined;
    return !!review &&
      review.id === reviewId &&
      review.budget_id === row.budget_id &&
      review.transaction_id === payload.transactionId &&
      provenance.budgetId === review.budget_id &&
      provenance.transactionId === review.transaction_id &&
      provenance.categoryId === review.category_id &&
      provenance.status === review.status &&
      provenance.version === review.version &&
      (review.status === 'pending_review' || review.status === 'correcting') &&
      review.superseded_by === null;
  }

  async findReviewByIssue(
    budgetId: string,
    transactionId: string,
    categoryId: string,
    classifier: string,
  ): Promise<ReviewItem | null> {
    const row = this.stmt.selectReviewByIssue.get({
      budgetId,
      transactionId,
      categoryId,
      classifier,
    }) as ReviewItemRow | undefined;
    return row ? rowToReviewItem(row) : null;
  }

  async listReviewItems(options?: ReviewListOptions): Promise<ReviewItem[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    if (options?.budgetId !== undefined) {
      const rows = this.stmt.listReviewItemsByBudget.all({
        budgetId: options.budgetId,
        status: options.status ?? null,
        limit,
        offset,
      }) as ReviewItemRow[];
      return rows.map(rowToReviewItem);
    }

    let rows: ReviewItemRow[];
    if (options?.status) {
      rows = this.stmt.listReviewItemsByStatus.all({
        status: options.status,
        limit,
        offset,
      }) as ReviewItemRow[];
    } else {
      rows = this.stmt.listReviewItems.all({ limit, offset }) as ReviewItemRow[];
    }
    return rows.map(rowToReviewItem);
  }

  async countReviewItems(options?: ReviewListOptions): Promise<number> {
    if (options?.budgetId !== undefined) {
      const row = this.stmt.countReviewItemsByBudget.get({
        budgetId: options.budgetId,
        status: options.status ?? null,
      }) as { count: number };
      return row.count;
    }
    if (options?.status) {
      const row = this.stmt.countReviewItemsByStatus.get({ status: options.status }) as {
        count: number;
      };
      return row.count;
    }
    const row = this.stmt.countReviewItems.get({}) as { count: number };
    return row.count;
  }

  async listReviewItemsByCorrelation(correlationId: string): Promise<ReviewItem[]> {
    const rows = this.stmt.listReviewItemsByCorrelation.all({ correlationId }) as ReviewItemRow[];
    return rows.map(rowToReviewItem);
  }

  async transitionReviewItem(id: string, input: AuthorizedReviewTransitionInput): Promise<ReviewItem> {
    if (
      !input ||
      !input.authorization ||
      (input.toStatus !== 'rejected' && input.toStatus !== 'skipped' && input.toStatus !== 'pending_review')
    ) {
      return this.db.transaction(() => {
        throw new Error('Review action authorization unavailable', { cause: 'authorization_denied' });
      }).immediate();
    }
    return this.transitionInternalReviewItem(id, input);
  }

  async transitionInternalReviewItem(id: string, input: TransitionReviewInput): Promise<ReviewItem> {
    return this.db.transaction(() => {
    const now = nowISO();
    const current = this.stmt.selectReviewItemStatus.get(id) as
      { id: string; status: string; version: number; approved_by: string } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);
    if (input.authorization) {
      const context = input.authorization;
      const full = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
      const operation = input.toStatus === 'rejected' ? 'reject_review'
        : input.toStatus === 'skipped' ? 'skip_review'
          : input.toStatus === 'pending_review' && UNDO_SOURCES.includes(current.status as ReviewStatus)
            ? 'undo_review' : null;
      const boundSpace = this.governance.getSpaceForBudget({ budgetId: full.budget_id });
      const human = context.auth.method === 'session' || context.auth.method === 'human-session' ||
        (context.auth.method === 'api-key' && context.auth.principalType === 'human');
      if (!operation || !human || context.auth.actorId !== input.actor ||
        boundSpace?.id !== context.spaceId || context.transaction.id !== full.transaction_id)
        throw new Error('Review action authorization unavailable', { cause: 'authorization_denied' });
      const refs: GovernanceResourceRef[] = [
        { resourceKind: 'budget', resourceId: full.budget_id },
        { resourceKind: 'transaction', resourceId: full.transaction_id },
        { resourceKind: 'account', resourceId: context.transaction.accountId },
      ];
      if (full.category_id) refs.push({ resourceKind: 'category', resourceId: full.category_id });
      if (context.transaction.categoryId && context.transaction.categoryId !== full.category_id)
        refs.push({ resourceKind: 'category', resourceId: context.transaction.categoryId });
      const result = this.governance.authorize({
        actorId: input.actor,
        auth: context.auth,
        spaceId: context.spaceId,
        expectedPolicyVersion: context.policyVersion,
        phase: 'read',
        operation,
        required: refs.map((ref) => ({ ...ref, capability: 'categorization:execute', visibility: 'resource' })),
        payload: {
          operations: [{
            operation,
            transactionId: full.transaction_id,
            accountId: context.transaction.accountId,
            direction: context.transaction.direction,
            amount: context.transaction.amount,
            ...(full.category_id ? { categoryId: full.category_id } : {}),
          }],
          currentTransaction: { categoryId: context.transaction.categoryId },
        },
        now,
      });
      if (!result.allowed) throw new Error('Review action authorization unavailable', { cause: 'authorization_denied' });
    }

    const fromStatus = current.status as ReviewStatus;
    const toStatus = input.toStatus;

    // Idempotent: already at target status
    if (fromStatus === toStatus) {
      const full = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
      return rowToReviewItem(full);
    }

    // Validate transition
    if (fromStatus === 'superseded') {
      throw new Error(`Cannot transition from superseded status`);
    }
    const allowed = REVIEW_TRANSITIONS[fromStatus];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Cannot transition review item ${id} from '${fromStatus}' to '${toStatus}'`);
    }

    // Track approvedBy for final approval persistence
    let approvedByArr: string[] | null = null;

    // Special handling for approval
    if (toStatus === 'approved') {
      approvedByArr = JSON.parse(current.approved_by) as string[];
      if (approvedByArr.includes(input.actor)) {
        // Same actor approving again — idempotent, return current item
        const full = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
        return rowToReviewItem(full);
      }
      approvedByArr.push(input.actor);

      // Need the full item to check reviewersRequired
      const fullRow = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
      const needed = fullRow.reviewers_required;

      if (approvedByArr.length < needed) {
        // Not enough reviewers yet — just record the approval, stay in current status
        const updatedBy = JSON.stringify(approvedByArr);

        // Atomic: update approvedBy AND insert audit action in one transaction
        const partialTxn = this.db.transaction(() => {
          const result = this.stmt.updateApprovedBy.run({
            id,
            approvedBy: updatedBy,
            now,
            expectedVersion: input.expectedVersion,
            isNew: 1, // increment version since we added a reviewer
          });

          if (result.changes === 0) {
            throw new Error(
              `Version conflict on review item ${id}: expected ${input.expectedVersion}`,
            );
          }

          // Record action for the approval step (even though status didn't change)
          this.stmt.insertReviewAction.run({
            id: randomUUID(),
            reviewItemId: id,
            fromStatus: fromStatus,
            toStatus: fromStatus, // stayed same
            actor: input.actor,
            reason:
              input.reason ??
              `Approved by ${input.actor} (${approvedByArr!.length}/${needed} reviewers)`,
            metadata: JSON.stringify(input.metadata ?? {}),
            createdAt: now,
          });
        });

        partialTxn();

        const updated = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
        return rowToReviewItem(updated);
      }
      // Else: enough reviewers — fall through to the full transition below
    }

    // Perform the transition atomically (status change + audit + optional field updates)
    const actionId = randomUUID();
    const approvedByJson = approvedByArr ? JSON.stringify(approvedByArr) : null;

    const txn = this.db.transaction(() => {
      const result = this.stmt.transitionReviewItemUpdate.run({
        id,
        fromStatus,
        toStatus,
        expectedVersion: input.expectedVersion,
        reason: toStatus === 'superseded' ? (input.reason ?? null) : null,
        supersededBy: input.supersededBy ?? null,
        approvedBy: approvedByJson,
        now,
      });

      if (result.changes === 0) {
        // Version conflict or state changed
        throw new Error(
          `Version conflict on review item ${id}: expected ${input.expectedVersion}, ` +
            `current version may have changed`,
        );
      }

      this.stmt.insertReviewAction.run({
        id: actionId,
        reviewItemId: id,
        fromStatus,
        toStatus,
        actor: input.actor,
        reason: input.reason ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        createdAt: now,
      });

      // Record structured correction evidence for approve/correct transitions
      // Each atomic status-changing transition produces exactly one correction
      // record (the version check above guarantees the transition is unique).
      if (toStatus === 'approved' || toStatus === 'correcting') {
        const correctionId = randomUUID();
        const fullRow = this.stmt.selectReviewItem.get(id) as ReviewItemRow;

        this.stmt.insertCorrection.run({
          id: correctionId,
          reviewItemId: id,
          transactionId: fullRow.transaction_id,
          transactionVersion: fullRow.transaction_version,
          merchant: input.merchant ?? null,
          importedPayee: input.importedPayee ?? null,
          accountId: input.accountId ?? null,
          direction: input.direction ?? null,
          amount: input.amount ?? null,
          date: input.date ?? null,
          categoryId: fullRow.category_id,
          categoryName: input.categoryName ?? null,
          previousCategoryId: null,
          proposalId: null,
          proposalActorId: null,
          payloadHash: null,
          idempotencyKey: null,
          verified: 0,
          actor: input.actor,
          fromStatus,
          toStatus,
          sourceReviewId: id,
          createdAt: now,
        });
      }
    });

    txn();

    const updated = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
    return rowToReviewItem(updated);
    }).immediate();
  }

  async updateReviewItemCategory(
    id: string,
    categoryId: string,
    expectedVersion: number,
  ): Promise<ReviewItem> {
    const now = nowISO();
    const result = this.stmt.updateReviewItemCategory.run({
      id,
      categoryId,
      expectedVersion,
      now,
    });

    if (result.changes === 0) {
      throw new Error(`Version conflict on review item ${id}: expected ${expectedVersion}`);
    }

    const updated = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
    return rowToReviewItem(updated);
  }

  async transitionInternalReviewItems(
    ids: string[],
    toStatus: ReviewStatus,
    actor: string,
    reason?: string,
  ): Promise<TransitionReviewResult[]> {
    if (ids.length === 0) return [];

    // Read current statuses for all items, tracking found/missing per index
    const items: ({ id: string; status: ReviewStatus; version: number } | null)[] = ids.map(
      (id) => {
        const row = this.stmt.selectReviewItemsByIds.get(id) as
          { id: string; status: string; version: number } | undefined;
        return row
          ? { id: row.id, status: row.status as ReviewStatus, version: row.version }
          : null;
      },
    );

    // Collect only found items for validation
    const foundItems = items.filter((x): x is NonNullable<typeof x> => x !== null);

    if (foundItems.length === 0) {
      // All IDs are missing
      return ids.map((id) => ({
        itemId: id,
        success: false,
        item: null,
        error: 'Not found',
      }));
    }

    // Heterogeneous group check: all found items must share the same current status
    const firstStatus = foundItems[0].status;
    if (!foundItems.every((i) => i.status === firstStatus)) {
      throw new Error(
        `Heterogeneous group: all items must have the same current status ` +
          `(found items with statuses: ${[...new Set(foundItems.map((i) => i.status))].join(', ')})`,
      );
    }

    // Validate the transition for this status group
    const allowed = REVIEW_TRANSITIONS[firstStatus];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Cannot transition from '${firstStatus}' to '${toStatus}'`);
    }

    // Transition each item atomically, collecting per-item results
    // (one result per requested ID, including missing IDs)
    const results: TransitionReviewResult[] = [];

    for (let i = 0; i < ids.length; i++) {
      const item = items[i];
      if (!item) {
        results.push({
          itemId: ids[i],
          success: false,
          item: null,
          error: 'Not found',
        });
        continue;
      }

      try {
        const transitioned = await this.transitionInternalReviewItem(item.id, {
          toStatus,
          actor,
          reason,
          expectedVersion: item.version,
        });
        results.push({
          itemId: item.id,
          success: true,
          item: transitioned,
          error: null,
        });
      } catch (err) {
        results.push({
          itemId: item.id,
          success: false,
          item: null,
          error: (err as Error).message,
        });
      }
    }

    return results;
  }

  async undoReviewTransition(
    id: string,
    actor: string,
    reason: string | undefined,
    expectedVersion: number | undefined,
    authorization: ReviewActionAuthorization,
  ): Promise<ReviewItem> {
    if (!authorization) {
      return this.db.transaction(() => {
        throw new Error('Review action authorization unavailable', { cause: 'authorization_denied' });
      }).immediate();
    }
    const current = this.stmt.selectReviewItemStatus.get(id) as
      { id: string; status: string; version: number } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);
    const fromStatus = current.status as ReviewStatus;
    if (!UNDO_SOURCES.includes(fromStatus)) {
      throw new Error(
        `Cannot undo from '${fromStatus}': only ${UNDO_SOURCES.join(', ')} support undo`,
      );
    }
    return this.transitionReviewItem(id, {
      toStatus: 'pending_review',
      actor,
      reason: reason ?? `Undo from '${fromStatus}'`,
      metadata: { undo: true, previousStatus: fromStatus },
      expectedVersion: expectedVersion ?? current.version,
      authorization,
    });
  }

  async undoInternalReviewTransition(
    id: string,
    actor: string,
    reason?: string,
    expectedVersion?: number,
    authorization?: ReviewActionAuthorization,
  ): Promise<ReviewItem> {
    const current = this.stmt.selectReviewItemStatus.get(id) as
      { id: string; status: string; version: number } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);

    const fromStatus = current.status as ReviewStatus;

    // Only approved -> pending_review and correcting -> pending_review are reversible
    if (!UNDO_SOURCES.includes(fromStatus)) {
      throw new Error(
        `Cannot undo from '${fromStatus}': only ${UNDO_SOURCES.join(', ')} support undo`,
      );
    }

    const version = expectedVersion ?? current.version;

    return this.transitionInternalReviewItem(id, {
      toStatus: 'pending_review',
      actor,
      reason: reason ?? `Undo from '${fromStatus}'`,
      metadata: { undo: true, previousStatus: fromStatus },
      expectedVersion: version,
      authorization,
    });
  }

  async getReviewActions(reviewItemId: string): Promise<ReviewAction[]> {
    const rows = this.stmt.selectReviewActions.all(reviewItemId) as ReviewActionRow[];
    return rows.map(rowToReviewAction);
  }

  // ── Correction history ──────────────────────────────────────────────

  async queryCorrectionHistory(options?: CorrectionHistoryOptions): Promise<CorrectionRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: CorrectionRow[];

    if (options?.reviewItemId) {
      rows = this.stmt.selectCorrectionsByReview.all({
        reviewItemId: options.reviewItemId,
      }) as CorrectionRow[];
    } else if (options?.merchant) {
      rows = this.stmt.selectCorrectionsByMerchant.all({
        merchant: options.merchant,
        limit,
        offset,
      }) as CorrectionRow[];
    } else if (options?.transactionId) {
      rows = this.stmt.selectCorrectionsByTransaction.all({
        transactionId: options.transactionId,
        limit,
        offset,
      }) as CorrectionRow[];
    } else if (options?.actor) {
      rows = this.stmt.selectCorrectionsByActor.all({
        actor: options.actor,
        limit,
        offset,
      }) as CorrectionRow[];
    } else {
      rows = this.stmt.selectAllCorrections.all({ limit, offset }) as CorrectionRow[];
    }

    return rows.map(rowToCorrection);
  }

  async completeVerifiedCategorizationReview(idempotencyKey: string): Promise<ReviewItem | null> {
    return this.db.transaction(() => {
      const idempotency = this.stmt.selectIdempotency.get(idempotencyKey) as IdempotencyRow | undefined;
      if (!idempotency || idempotency.idempotency_status !== 'succeeded' || !idempotency.serialised_result)
        throw new Error('Verified categorization result is unavailable');
      const proposalRow = this.stmt.selectProposal.get(idempotency.proposal_id) as ProposalRow | undefined;
      if (!proposalRow || proposalRow.operation !== 'set_category')
        throw new Error('Verified categorization proposal is unavailable');
      const proposal = rowToProposal(proposalRow);
      if (proposal.operation !== 'set_category' || proposal.id !== idempotency.proposal_id)
        throw new Error('Verified categorization proposal is invalid');
      const acquisition = this.stmt.selectProposalExecutionAcquisition.get(proposal.id) as {
        idempotency_key: string;
        actor_id: string;
      } | undefined;
      if (!acquisition || acquisition.idempotency_key !== idempotencyKey || !acquisition.actor_id)
        throw new Error('Verified categorization execution attribution is unavailable');

      let effect: unknown;
      let preconditions: unknown;
      let result: unknown;
      try {
        effect = JSON.parse(idempotency.serialised_effect) as unknown;
        preconditions = JSON.parse(proposal.preconditions) as unknown;
        result = JSON.parse(idempotency.serialised_result) as unknown;
      } catch {
        throw new Error('Verified categorization result envelope is invalid');
      }
      if (
        !isPlainRecord(effect) ||
        Object.keys(effect).length !== 3 ||
        effect.operation !== 'set_category' ||
        !isPlainRecord(effect.payload) ||
        !isPlainRecord(effect.preconditions) ||
        !isPlainRecord(preconditions) ||
        canonicalProposalJson(effect) !== canonicalProposalJson({
          operation: proposal.operation,
          payload: proposal.payload,
          preconditions,
        })
      )
        throw new Error('Verified categorization result does not match its acquired proposal');
      const resultFields = [
        'verified',
        'transactionId',
        'previousCategoryId',
        'newCategoryId',
        'planId',
      ] as const;
      if (
        !isPlainRecord(result) ||
        Object.keys(result).length !== resultFields.length ||
        resultFields.some((field) => !(field in result)) ||
        result.verified !== true ||
        typeof result.transactionId !== 'string' ||
        !result.transactionId ||
        !(result.previousCategoryId === null ||
          (typeof result.previousCategoryId === 'string' && !!result.previousCategoryId)) ||
        typeof result.newCategoryId !== 'string' ||
        !result.newCategoryId ||
        typeof result.planId !== 'string' ||
        !result.planId
      )
        throw new Error('Verified categorization result is malformed');

      const payload = effect.payload;
      const acquiredPreconditions = effect.preconditions;
      const plan = acquiredPreconditions.nativePlan;
      const reviewId = acquiredPreconditions.reviewId;
      const reviewProvenance = acquiredPreconditions.reviewProvenance;
      const reviewFields = ['budgetId', 'transactionId', 'categoryId', 'status', 'version'] as const;
      if (
        proposal.operation !== 'set_category' ||
        typeof reviewId !== 'string' ||
        !reviewId ||
        !isPlainRecord(reviewProvenance) ||
        Object.keys(reviewProvenance).length !== reviewFields.length ||
        reviewFields.some((field) => !(field in reviewProvenance)) ||
        !isPlainRecord(plan) ||
        typeof payload.transactionId !== 'string' ||
        !payload.transactionId ||
        typeof payload.categoryId !== 'string' ||
        !payload.categoryId ||
        result.transactionId !== payload.transactionId ||
        result.transactionId !== proposal.payload.transactionId ||
        result.newCategoryId !== payload.categoryId ||
        result.newCategoryId !== proposal.payload.categoryId ||
        result.planId !== plan.planId ||
        result.previousCategoryId !== plan.currentCategoryId ||
        plan.transactionId !== payload.transactionId ||
        plan.proposedCategoryId !== payload.categoryId ||
        reviewProvenance.budgetId !== proposal.budgetId ||
        reviewProvenance.transactionId !== payload.transactionId ||
        (reviewProvenance.categoryId !== null && typeof reviewProvenance.categoryId !== 'string') ||
        (reviewProvenance.status !== 'pending_review' && reviewProvenance.status !== 'correcting') ||
        typeof reviewProvenance.version !== 'number' ||
        !Number.isSafeInteger(reviewProvenance.version)
      )
        throw new Error('Verified categorization result does not match its review reference');

      const priorCorrection = this.stmt.selectCorrectionByIdempotencyKey.get(idempotencyKey) as
        CorrectionRow | undefined;
      const currentReview = this.stmt.selectReviewItem.get(reviewId) as ReviewItemRow | undefined;
      if (priorCorrection) {
        if (
          !currentReview ||
          priorCorrection.review_item_id !== reviewId ||
          priorCorrection.transaction_id !== proposal.payload.transactionId ||
          priorCorrection.previous_category_id !== result.previousCategoryId ||
          priorCorrection.category_id !== proposal.payload.categoryId ||
          priorCorrection.proposal_id !== proposal.id ||
          priorCorrection.proposal_actor_id !== proposal.actorId ||
          priorCorrection.payload_hash !== proposal.payloadHash ||
          priorCorrection.idempotency_key !== idempotencyKey ||
          priorCorrection.actor !== acquisition.actor_id ||
          priorCorrection.from_status !== reviewProvenance.status ||
          priorCorrection.to_status !== 'applied' ||
          priorCorrection.source_review_id !== reviewId ||
          priorCorrection.verified !== 1
        )
          throw new Error('Completed review correction does not match its verified execution');
        return rowToReviewItem(currentReview);
      }
      if (!this.proposalReviewProvenanceMatches(proposalRow) || !currentReview)
        throw new Error('Review provenance changed before verified completion');

      const now = nowISO();
      const update = this.stmt.completeReviewCategorization.run({
        id: reviewId,
        budgetId: proposal.budgetId,
        transactionId: proposal.payload.transactionId,
        categoryId: proposal.payload.categoryId,
        previousCategoryId: reviewProvenance.categoryId,
        fromStatus: currentReview.status,
        expectedVersion: currentReview.version,
        now,
      });
      if (update.changes !== 1)
        throw new Error('Review changed before verified completion');
      this.stmt.insertReviewAction.run({
        id: randomUUID(),
        reviewItemId: reviewId,
        fromStatus: currentReview.status,
        toStatus: 'applied',
        actor: acquisition.actor_id,
        reason: 'Verified categorization proposal',
        metadata: JSON.stringify({
          proposalId: proposal.id,
          payloadHash: proposal.payloadHash,
          idempotencyKey,
          verified: true,
        }),
        createdAt: now,
      });
      this.stmt.insertCorrection.run({
        id: randomUUID(),
        reviewItemId: reviewId,
        transactionId: currentReview.transaction_id,
        transactionVersion: currentReview.transaction_version,
        merchant: null,
        importedPayee: null,
        accountId: null,
        direction: null,
        amount: null,
        date: null,
        categoryId: proposal.payload.categoryId,
        categoryName: null,
        previousCategoryId: result.previousCategoryId,
        proposalId: proposal.id,
        proposalActorId: proposal.actorId,
        payloadHash: proposal.payloadHash,
        idempotencyKey,
        verified: 1,
        actor: acquisition.actor_id,
        fromStatus: currentReview.status,
        toStatus: 'applied',
        sourceReviewId: reviewId,
        createdAt: now,
      });
      const updatedReview = this.stmt.selectReviewItem.get(reviewId) as ReviewItemRow | undefined;
      if (!updatedReview) throw new Error('Completed review item is unavailable');
      return rowToReviewItem(updatedReview);
    }).immediate();
  }

  async findCorrectionConflicts(limit: number = 50): Promise<CorrectionConflict[]> {
    const rows = this.stmt.selectCorrectionConflicts.all({ limit }) as {
      field: string;
      merchant: string;
      values_json: string;
      correction_ids: string;
    }[];

    return rows.map((r) => ({
      field: r.field as 'account' | 'direction' | 'category',
      merchant: r.merchant,
      values: r.values_json.split(',').filter((v, i, a) => a.indexOf(v) === i), // dedupe
      correctionIds: r.correction_ids.split(','),
    }));
  }
  // ── Categorization proposal lifecycle ─────────────────────────────

  async createProposal(input: CreateProposalInput): Promise<GenericActionProposal> {
    return this.db.transaction(() => {
      if (
        input.operation !== input.payload.kind ||
        !isGenericProposalOperation(input.operation)
      )
        throw new Error('Unsupported proposal operation');
      if (input.policyVersion !== GENERIC_MUTATION_POLICY_VERSION)
        throw new ProposalAcquisitionError('policy_version_mismatch', 'Unsupported generic mutation policy version');

      const now = nowISO();
      const nowMillis = timestampMillis(now)!;
      const expiresAtMillis = timestampMillis(input.expiresAt);
      if (expiresAtMillis === null) throw new Error(`Invalid expiresAt: '${input.expiresAt}' is not ISO-8601`);
      if (expiresAtMillis <= nowMillis) throw new Error(`expiresAt '${input.expiresAt}' is in the past`);
      if (input.actorId !== input.auth.actorId || !this.operationalAuthMatches(input.auth, input.actorId, now))
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal actor does not match trusted credentials');

      const space = this.governance.getSpace({ spaceId: input.spaceId });
      const policy = this.governance.getPolicy({ spaceId: input.spaceId });
      if (!space || space.deletedAt !== null || space.budgetId !== input.budgetId || !policy)
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal budget is not bound to an active space');

      let preconditions: unknown;
      let payload: CreateProposalInput['payload'];
      try {
        preconditions = JSON.parse(input.preconditions) as unknown;
        canonicalProposalJson(preconditions);
        payload = JSON.parse(canonicalProposalJson(input.payload)) as CreateProposalInput['payload'];
      } catch {
        throw new Error('Proposal payload and preconditions must be canonical JSON values');
      }
      if (input.operation === 'create_rule') {
        const preconditionsRecord = isPlainRecord(preconditions) ? preconditions : null;
        const embeddedRule = preconditionsRecord && isPlainRecord(preconditionsRecord.nativeRule)
          ? preconditionsRecord.nativeRule
          : null;
        const flatRule = preconditionsRecord &&
          ['name', 'conditions', 'actions'].some((key) => key in preconditionsRecord)
          ? Object.fromEntries(
              ['name', 'conditions', 'actions', 'conditionsOp', 'stage']
                .filter((key) => key in preconditionsRecord)
                .map((key) => [key, preconditionsRecord[key]]),
            )
          : null;
        const preconditionRule = embeddedRule ?? flatRule;
        const rulePayload = payload as RuleActionPayload;
        const payloadRule = isPlainRecord(rulePayload.rule) ? rulePayload.rule : null;
        if (preconditionRule) {
          if (!payloadRule || Object.keys(payloadRule).length === 0)
            throw new ProposalAcquisitionError('payload_hash_mismatch', 'Proposal payload has no normalized rule');
          if (canonicalProposalJson(preconditionRule) !== canonicalProposalJson(payloadRule))
            throw new ProposalAcquisitionError('payload_hash_mismatch', 'Proposal rule differs from its native precondition');
        }
      }

      const facts = deriveProposalAuthorizationFacts(input.operation, payload, preconditions);
      if (!this.ruleOverrideSnapshotMatches(input.spaceId, input.budgetId, payload, preconditions))
        throw new ProposalAcquisitionError('authorization_denied', 'Current rule override state differs from the proposal');
      const authorization = this.authorizeGenericProposal({
        actorId: input.actorId,
        auth: input.auth,
        spaceId: input.spaceId,
        policyVersion: policy.version,
        phase: 'propose',
        capability: input.operation === 'set_category' ? 'categorization:propose' : 'rule:propose',
        operation: input.operation,
        budgetId: input.budgetId,
        facts,
        payload,
        now,
      });
      if (!authorization.allowed)
        throw new ProposalAcquisitionError('authorization_denied', authorization.reason);
      if (
        input.operation === 'set_category' &&
        !this.proposalReviewProvenanceMatches({
          operation: input.operation,
          budget_id: input.budgetId,
          payload: canonicalProposalJson(payload),
          preconditions: canonicalProposalJson(preconditions),
        })
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Review provenance does not match a current review item');

      const payloadHash = canonicalProposalHash({
        operation: input.operation,
        budgetId: input.budgetId,
        payload,
        preconditions,
        actorId: input.actorId,
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        expiresAt: input.expiresAt,
      });
      const id = randomUUID();
      const row = this.stmt.insertProposal.get({
        id,
        operation: input.operation,
        budgetId: input.budgetId,
        spaceId: input.spaceId,
        requesterMembershipId: authorization.membershipId,
        requesterDelegationId:
          input.auth.method === 'api-key' && input.auth.principalType === 'agent'
            ? input.auth.delegationId
            : null,
        requesterDelegationVersion:
          input.auth.method === 'api-key' && input.auth.principalType === 'agent'
            ? input.auth.delegationVersion
            : null,
        governancePolicyVersion: policy.version,
        payload: canonicalProposalJson(payload),
        payloadHash,
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: canonicalProposalJson(preconditions),
        expiresAt: input.expiresAt,
        actorId: input.actorId,
        provenance: input.provenance,
        providerModel: input.providerModel ?? null,
        correlationId: input.correlationId ?? null,
        supersededAt: null,
        createdAt: now,
      }) as ProposalRow | undefined;
      if (row) return rowToProposal(row) as GenericActionProposal;

      const transactionId = payload.kind === 'set_category' || payload.kind === 'create_rule'
        ? payload.transactionId
        : null;
      const existing = this.stmt.selectProposalByExactKey.get({
        budgetId: input.budgetId,
        transactionId,
        operation: input.operation,
        payloadHash,
      }) as ProposalRow | undefined;
      if (existing) return rowToProposal(existing) as GenericActionProposal;
      throw new ProposalAcquisitionError('authorization_denied', 'Failed to create or retrieve proposal');
    }).immediate();
  }

  async getProposal(id: string): Promise<ActionProposal | null> {
    const row = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async findActiveProposal(
    budgetId: string,
    transactionId: string | null,
    operation: ProposalOperation,
  ): Promise<ActionProposal | null> {
    const row = this.stmt.selectActiveProposal.get({
      budgetId,
      transactionId,
      operation,
    }) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async supersedeProposal(id: string): Promise<ActionProposal> {
    const existing = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
    if (!existing) throw new Error(`Proposal ${id} not found`);
    if (existing.operation === 'transfer' || existing.operation === 'session_completion')
      throw new Error('Specialized workflow transition required');
    if (existing.superseded_at) {
      // Already superseded — idempotent
      return rowToProposal(existing);
    }

    const now = nowISO();
    this.db.transaction(() => {
      this.stmt.supersedeProposalStmt.run({ id, now });
      this.stmt.supersedeProposalApprovals.run({ proposalId: id, now });
    })();

    const updated = this.stmt.selectProposal.get(id) as ProposalRow;
    return rowToProposal(updated);
  }

  /** Cancels an exact intent and its votes under current human authority in one transaction. */
  async discardProposal(
    id: string,
    actorId: string,
    context: DiscardProposalAuthorization,
  ): Promise<ActionProposal | null> {
    return this.db.transaction(() => {
      if (!context || context.auth?.method !== 'human-session' ||
          !this.freshHumanControl(context.auth, actorId, context.now) ||
          !this.operationalAuthMatches(context.auth, actorId, context.now)) return null;
      const proposal = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
      if (!proposal || !isGenericProposalOperation(proposal.operation) ||
          proposal.space_id !== context.spaceId || !this.proposalHashMatches(proposal)) return null;
      if (this.stmt.selectProposalExecutionAcquisition.get(id)) return null;
      const policy = this.governance.getPolicy({ spaceId: context.spaceId });
      if (!policy || policy.version !== context.governancePolicyVersion) return null;
      let payload: unknown;
      let facts: ProposalAuthorizationFacts;
      try {
        payload = JSON.parse(proposal.payload) as unknown;
        facts = deriveProposalAuthorizationFacts(proposal.operation, payload, JSON.parse(proposal.preconditions) as unknown);
      } catch {
        return null;
      }
      const authorization = this.authorizeGenericProposal({
        actorId, auth: context.auth, spaceId: context.spaceId, policyVersion: policy.version,
        phase: 'execute',
        capability: proposal.operation === 'set_category' ? 'categorization:execute' : 'rule:execute',
        operation: proposal.operation, budgetId: proposal.budget_id, facts, payload, now: context.now,
      });
      if (!authorization.allowed) return null;
      if (!proposal.superseded_at) {
        this.stmt.supersedeProposalStmt.run({ id, now: context.now });
        this.stmt.supersedeProposalApprovals.run({ proposalId: id, now: context.now });
        this.stmt.insertAudit.run({
          id: randomUUID(), classification: 'proposal_superseded', timestamp: context.now,
          actorId, operation: proposal.operation, proposalId: id, payloadHash: proposal.payload_hash,
          budgetId: proposal.budget_id, backendIds: '[]', policyVersion: policy.version,
          authorizationDisposition: JSON.stringify(authorization.disposition),
          idempotencyKey: null, expectedPriorState: null, observedResultState: 'superseded',
          providerModel: proposal.provider_model, correlationId: proposal.correlation_id, requestId: null,
          result: 'discarded', isError: 0,
        });
      }
      return rowToProposal(this.stmt.selectProposal.get(id) as ProposalRow);
    }).immediate();
  }

  async listProposals(options?: ListProposalsOptions): Promise<ActionProposal[]> {
    if (options?.operations) {
      const rows = this.db
        .prepare(
          `SELECT * FROM action_proposals WHERE operation IN (SELECT value FROM json_each(@operations)) AND (@budgetId IS NULL OR budget_id=@budgetId) AND (@superseded IS NULL OR (superseded_at IS NOT NULL)=@superseded) ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
        )
        .all({
          operations: JSON.stringify(options.operations),
          budgetId: options.budgetId ?? null,
          superseded: options.superseded === undefined ? null : Number(options.superseded),
          limit: options.limit ?? 50,
          offset: options.offset ?? 0,
        }) as ProposalRow[];
      return rows.map(rowToProposal);
    }
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const hasBudget = options?.budgetId != null;

    let rows: ProposalRow[];

    if (hasBudget) {
      if (options?.superseded === false) {
        rows = this.stmt.listProposalsByBudgetActive.all({
          budgetId: options.budgetId,
          limit,
          offset,
        }) as ProposalRow[];
      } else if (options?.superseded === true) {
        rows = this.stmt.listProposalsSupersededByBudget.all({
          budgetId: options.budgetId,
          limit,
          offset,
        }) as ProposalRow[];
      } else {
        rows = this.stmt.listProposalsByBudget.all({
          budgetId: options.budgetId,
          limit,
          offset,
        }) as ProposalRow[];
      }
    } else {
      if (options?.superseded === false) {
        rows = this.stmt.listProposalsActive.all({ limit, offset }) as ProposalRow[];
      } else if (options?.superseded === true) {
        rows = this.stmt.listProposalsSuperseded.all({ limit, offset }) as ProposalRow[];
      } else {
        rows = this.stmt.listProposals.all({ limit, offset }) as ProposalRow[];
      }
    }

    return rows.map(rowToProposal);
  }

  async countProposals(options?: ListProposalsOptions): Promise<number> {
    if (options?.operations) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM action_proposals WHERE operation IN (SELECT value FROM json_each(@operations)) AND (@budgetId IS NULL OR budget_id=@budgetId) AND (@superseded IS NULL OR (superseded_at IS NOT NULL)=@superseded)`,
        )
        .get({
          operations: JSON.stringify(options.operations),
          budgetId: options.budgetId ?? null,
          superseded: options.superseded === undefined ? null : Number(options.superseded),
        }) as { count: number };
      return row.count;
    }
    const hasBudget = options?.budgetId != null;
    let row: { count: number };

    if (hasBudget) {
      if (options?.superseded === false) {
        row = this.stmt.countProposalsByBudgetActive.get({ budgetId: options.budgetId }) as {
          count: number;
        };
      } else if (options?.superseded === true) {
        row = this.stmt.countProposalsSupersededByBudget.get({ budgetId: options.budgetId }) as {
          count: number;
        };
      } else {
        row = this.stmt.countProposalsByBudget.get({ budgetId: options.budgetId }) as {
          count: number;
        };
      }
    } else {
      if (options?.superseded === false) {
        row = this.stmt.countProposalsActive.get({}) as { count: number };
      } else if (options?.superseded === true) {
        row = this.stmt.countProposalsSuperseded.get({}) as { count: number };
      } else {
        row = this.stmt.countProposals.get({}) as { count: number };
      }
    }

    return row.count;
  }

  // ── Proposal approval lifecycle ───────────────────────────────────

  async createApproval(input: CreateApprovalInput): Promise<ProposalApproval> {
    return this.db.transaction(() => this.createApprovalSync(input)).immediate();
  }

  async createApprovals(input: CreateApprovalsInput): Promise<ProposalApproval[]> {
    return this.db.transaction(() => {
      const now = input?.now ?? nowISO();
      if (!input || typeof input.spaceId !== 'string' || !input.spaceId.trim() ||
          !input.auth || typeof input.auth.actorId !== 'string' ||
          !Array.isArray(input.approvals) || input.approvals.length === 0)
        throw new ProposalAcquisitionError('authorization_denied', 'Bulk approval request is invalid');
      const actorId = input.auth.actorId;
      const seen = new Set<string>();
      const approvals: ProposalApproval[] = [];
      for (const item of input.approvals) {
        if (!item || typeof item !== 'object' || typeof item.proposalId !== 'string' ||
            !item.proposalId.trim() || typeof item.payloadHash !== 'string')
          throw new ProposalAcquisitionError('authorization_denied', 'Bulk approval item is invalid');
        if (seen.has(item.proposalId))
          throw new ProposalAcquisitionError('authorization_denied', 'Duplicate proposal in bulk approvals');
        seen.add(item.proposalId);
        const proposal = this.stmt.selectProposal.get(item.proposalId) as ProposalRow | undefined;
        if (!proposal || proposal.space_id !== input.spaceId)
          throw new ProposalAcquisitionError('authorization_denied', 'Proposal unavailable in selected space');
        approvals.push(this.createApprovalSync({
          proposalId: item.proposalId,
          payloadHash: item.payloadHash,
          actorId,
          expiresAt: proposal.expires_at,
          auth: input.auth,
          now,
        }, { requestId: input.requestId, correlationId: input.correlationId }));
      }
      return approvals;
    }).immediate();
  }

  private createApprovalSync(
    input: CreateApprovalInput,
    auditContext: Pick<CreateApprovalsInput, 'requestId' | 'correlationId'> = {},
  ): ProposalApproval {
    const proposal = this.stmt.selectProposal.get(input.proposalId) as ProposalRow | undefined;
    if (!proposal || !isGenericProposalOperation(proposal.operation))
      throw new ProposalAcquisitionError('authorization_denied', 'Generic proposal not found');
    const operation = proposal.operation as GenericProposalOperation;
    const now = input.now;
    const nowMillis = timestampMillis(now);
    const proposalExpiry = timestampMillis(proposal.expires_at);
    const approvalExpiry = timestampMillis(input.expiresAt);
    if (nowMillis === null || proposalExpiry === null || approvalExpiry === null)
      throw new ProposalAcquisitionError('proposal_expired', 'Proposal or approval time is invalid');
    if (proposal.superseded_at)
      throw new ProposalAcquisitionError('proposal_superseded', 'Proposal is superseded');
    if (proposalExpiry <= nowMillis || approvalExpiry <= nowMillis || approvalExpiry > proposalExpiry)
      throw new ProposalAcquisitionError('proposal_expired', 'Proposal or approval expiry is invalid');
    if (
      proposal.policy_version !== GENERIC_MUTATION_POLICY_VERSION ||
      !this.proposalHashMatches(proposal) ||
      input.payloadHash !== proposal.payload_hash
    )
      throw new ProposalAcquisitionError('payload_hash_mismatch', 'Displayed proposal hash does not match');
    if (
      !this.freshHumanControl(input.auth, input.actorId, now) ||
      !this.operationalAuthMatches(input.auth, input.actorId, now)
    )
      throw new ProposalAcquisitionError('authorization_denied', 'Fresh human approval session required');
    if (!this.requesterMembershipCurrent(proposal, now))
      throw new ProposalAcquisitionError('authorization_denied', 'Proposal requester membership is no longer current');
    const spaceId = proposal.space_id;
    if (!spaceId || !proposal.requester_membership_id || !proposal.governance_policy_version)
      throw new ProposalAcquisitionError('authorization_denied', 'Proposal lacks trusted governance provenance');

    const space = this.governance.getSpace({ spaceId });
    const policy = this.governance.getPolicy({ spaceId });
    if (
      !space ||
      space.deletedAt !== null ||
      space.budgetId !== proposal.budget_id ||
      !policy ||
      policy.version !== proposal.governance_policy_version
    )
      throw new ProposalAcquisitionError('policy_version_mismatch', 'Current governance policy differs from proposal');

    let payload: unknown;
    let preconditions: unknown;
    let facts: ProposalAuthorizationFacts;
    try {
      payload = JSON.parse(proposal.payload) as unknown;
      preconditions = JSON.parse(proposal.preconditions) as unknown;
      facts = deriveProposalAuthorizationFacts(
        operation,
        payload,
        preconditions,
      );
    } catch {
      throw new ProposalAcquisitionError('payload_hash_mismatch', 'Stored proposal envelope is invalid');
    }
    if (!this.proposalOriginAuthorityCurrent(proposal, operation, facts, payload, policy.version, now))
      throw new ProposalAcquisitionError('authorization_denied', 'Proposal origin authority is no longer current');
    if (!this.ruleOverrideSnapshotMatches(spaceId, proposal.budget_id, payload, preconditions))
      throw new ProposalAcquisitionError('authorization_denied', 'Current rule override state differs from the proposal');
    const capability = operation === 'set_category' ? 'categorization:approve' : 'rule:approve';
    const authorization = this.authorizeGenericProposal({
      actorId: input.actorId,
      auth: input.auth,
      spaceId,
      policyVersion: policy.version,
      phase: 'approve',
      capability,
      operation: proposal.operation,
      budgetId: proposal.budget_id,
      facts,
      payload,
      now,
    });
    if (!authorization.allowed || !authorization.membershipId)
      throw new ProposalAcquisitionError('authorization_denied', authorization.reason);

    const id = randomUUID();
    const row = this.stmt.insertApproval.get({
      id,
      proposalId: input.proposalId,
      payloadHash: input.payloadHash,
      actorId: input.actorId,
      issuerMembershipId: authorization.membershipId,
      governancePolicyVersion: policy.version,
      reauthenticatedSessionId: input.auth.sessionId,
      reauthenticatedAt: input.auth.reauthenticatedAt,
      expiresAt: input.expiresAt,
      createdAt: now,
    }) as ApprovalRow | undefined;
    if (row) {
      const approval = rowToApproval(row);
      this.stmt.insertAudit.run({
        id: randomUUID(),
        classification: 'approval_granted',
        timestamp: now,
        actorId: input.actorId,
        operation: proposal.operation,
        proposalId: proposal.id,
        payloadHash: proposal.payload_hash,
        budgetId: proposal.budget_id,
        backendIds: '[]',
        policyVersion: proposal.policy_version,
        authorizationDisposition: JSON.stringify(authorization.disposition),
        idempotencyKey: null,
        expectedPriorState: null,
        observedResultState: 'active',
        providerModel: proposal.provider_model,
        correlationId: auditContext.correlationId ?? proposal.correlation_id,
        requestId: auditContext.requestId ?? null,
        result: JSON.stringify({
          approvalId: approval.id,
          spaceId,
          issuerMembershipId: authorization.membershipId,
          governancePolicyVersion: policy.version,
        }),
        isError: 0,
      });
      return approval;
    }

    const existing = this.stmt.selectApprovalByProposalActor.get({
      proposalId: input.proposalId,
      actorId: input.actorId,
    }) as ApprovalRow | undefined;
    const existingExpiry = existing ? timestampMillis(existing.expires_at) : null;
    if (
      existing?.status === 'active' &&
      existingExpiry !== null &&
      existingExpiry > nowMillis &&
      existing.payload_hash === proposal.payload_hash &&
      existing.issuer_membership_id === authorization.membershipId &&
      existing.governance_policy_version === policy.version &&
      existing.reauthenticated_session_id !== null &&
      existing.reauthenticated_at !== null
    )
      return rowToApproval(existing);
    throw new ProposalAcquisitionError('approval_consumed', 'Approval cannot be reissued');
  }

  async getProposalApprovalSummary(
    input: GetProposalApprovalSummaryInput,
  ): Promise<ProposalApprovalSummary> {
    return this.db.transaction(() => {
      const nowMillis = timestampMillis(input.now);
      if (nowMillis === null)
        throw new ProposalAcquisitionError('authorization_denied', 'Current governance context unavailable');
      const proposal = this.stmt.selectProposal.get(input.proposalId) as ProposalRow | undefined;
      if (
        !proposal ||
        !isGenericProposalOperation(proposal.operation) ||
        !proposal.space_id ||
        proposal.space_id !== input.spaceId ||
        !proposal.requester_membership_id ||
        !proposal.governance_policy_version
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal is unavailable in selected space');
      if (
        !input.auth ||
        input.actorId !== input.auth.actorId ||
        !this.operationalAuthMatches(input.auth, input.actorId, input.now)
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Summary reader credentials are unavailable');
      const agentPrincipal = input.auth.method === 'api-key' && input.auth.principalType === 'agent';
      const isProposalRequester = input.actorId === proposal.actor_id;
      if (
        isProposalRequester &&
        input.auth.method === 'api-key' &&
        input.auth.principalType === 'agent' &&
        (proposal.requester_delegation_id !== null || proposal.requester_delegation_version !== null) &&
        (proposal.requester_delegation_id !== input.auth.delegationId ||
          proposal.requester_delegation_version !== input.auth.delegationVersion)
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Agent proposal origin delegation differs');

      const space = this.governance.getSpace({ spaceId: input.spaceId });
      const policy = this.governance.getPolicy({ spaceId: input.spaceId });
      const membership = agentPrincipal
        ? null
        : this.governance.getCurrentMembership({
            spaceId: input.spaceId,
            actorId: input.actorId,
            now: input.now,
          });
      if (
        !space ||
        space.deletedAt !== null ||
        space.budgetId !== proposal.budget_id ||
        !policy ||
        (!membership && !agentPrincipal) ||
        !this.requesterMembershipCurrent(proposal, input.now)
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Current selected-space membership unavailable');
      if (proposal.policy_version !== GENERIC_MUTATION_POLICY_VERSION)
        throw new ProposalAcquisitionError('policy_version_mismatch', 'Generic mutation policy version changed');

      const operation = proposal.operation as GenericProposalOperation;
      const requesterCapability = operation === 'set_category' ? 'categorization:propose' : 'rule:propose';
      const approvalCapability = operation === 'set_category' ? 'categorization:approve' : 'rule:approve';
      const executionCapability = operation === 'set_category' ? 'categorization:execute' : 'rule:execute';

      let payload: unknown;
      let preconditions: unknown;
      let facts: ProposalAuthorizationFacts;
      try {
        payload = JSON.parse(proposal.payload) as unknown;
        preconditions = JSON.parse(proposal.preconditions) as unknown;
        if (canonicalProposalHash({
          operation,
          budgetId: proposal.budget_id,
          payload,
          preconditions,
          actorId: proposal.actor_id,
          policyVersion: proposal.policy_version,
          expiresAt: proposal.expires_at,
        }) !== proposal.payload_hash)
          throw new Error('Proposal hash mismatch');
        facts = deriveProposalAuthorizationFacts(operation, payload, preconditions);
      } catch {
        throw new ProposalAcquisitionError('payload_hash_mismatch', 'Stored proposal authorization facts are invalid');
      }
      if (!this.proposalOriginAuthorityCurrent(proposal, operation, facts, payload, policy.version, input.now))
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal origin authority is no longer current');
      const ruleOverrideCurrent = this.ruleOverrideSnapshotMatches(
        input.spaceId,
        proposal.budget_id,
        payload,
        preconditions,
      );

      const requesterRead = isProposalRequester
        ? this.authorizeGenericProposal({
            actorId: input.actorId,
            auth: input.auth,
            spaceId: input.spaceId,
            policyVersion: policy.version,
            phase: 'propose',
            capability: requesterCapability,
            operation,
            budgetId: proposal.budget_id,
            facts,
            payload,
            now: input.now,
            membershipId: proposal.requester_membership_id,
          })
        : null;
      const approvalRead = agentPrincipal
        ? null
        : this.authorizeGenericProposal({
            actorId: input.actorId,
            auth: input.auth,
            spaceId: input.spaceId,
            policyVersion: policy.version,
            phase: 'read',
            capability: approvalCapability,
            operation,
            budgetId: proposal.budget_id,
            facts,
            payload,
            now: input.now,
          });
      const executionRead = this.authorizeGenericProposal({
            actorId: input.actorId,
            auth: input.auth,
            spaceId: input.spaceId,
            policyVersion: policy.version,
            phase: 'read',
            capability: executionCapability,
            operation,
            budgetId: proposal.budget_id,
            facts,
            payload,
            now: input.now,
          });
      const fullReadResource = !agentPrincipal && membership
        ? this.governance.authorize({
            actorId: input.actorId,
            spaceId: input.spaceId,
            membershipId: membership.id,
            expectedPolicyVersion: policy.version,
            phase: 'read',
            operation,
            required: [
              {
                capability: 'full-read',
                resourceKind: 'budget',
                resourceId: proposal.budget_id,
                visibility: 'resource',
              },
              ...facts.resources
                .filter((resource) =>
                  resource.resourceKind !== 'account' &&
                  resource.resourceKind !== 'category' &&
                  resource.resourceKind !== 'transaction' &&
                  resource.resourceKind !== 'rule')
                .map((resource) => ({ ...resource, capability: 'full-read' })),
            ],
            payload: { operations: facts.operations, resources: facts.resources },
            now: input.now,
            auth: input.auth,
          })
        : null;
      const exactPrivateRead = !agentPrincipal && membership && facts.resources.length > 0
        ? this.governance.authorize({
            actorId: input.actorId,
            spaceId: input.spaceId,
            membershipId: membership.id,
            expectedPolicyVersion: policy.version,
            phase: 'read',
            operation,
            required: facts.resources.map((resource) => ({ ...resource, capability: 'full-read' })),
            payload: { operations: facts.operations, resources: facts.resources },
            now: input.now,
            auth: input.auth,
          })
        : null;
      const fullReadAllowed =
        fullReadResource?.allowed === true ||
        exactPrivateRead?.allowed === true;
      if (
        !fullReadAllowed &&
        !approvalRead?.allowed &&
        !executionRead?.allowed &&
        !requesterRead?.allowed
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Current exact proposal read authority unavailable');

      const eligible = ruleOverrideCurrent
        ? this.eligibleHumanApprovals({
            proposalId: proposal.id,
            payloadHash: proposal.payload_hash,
            spaceId: input.spaceId,
            policyVersion: policy.version,
            operation,
            budgetId: proposal.budget_id,
            facts,
            payload,
            now: input.now,
          })
        : [];
      const executionAdmission = this.authorizeGenericProposal({
        actorId: input.actorId,
        auth: input.auth,
        spaceId: input.spaceId,
        policyVersion: policy.version,
        phase: 'execute',
        capability: executionCapability,
        operation,
        budgetId: proposal.budget_id,
        facts,
        payload,
        now: input.now,
      });
      const requiredApprovers = requiredProposalApprovers(executionAdmission);
      const proposalExpiresAt = timestampMillis(proposal.expires_at);
      const proposalCurrent =
        proposal.governance_policy_version === policy.version &&
        proposal.superseded_at === null &&
        proposalExpiresAt !== null &&
        proposalExpiresAt > nowMillis &&
        ruleOverrideCurrent &&
        this.proposalReviewProvenanceMatches(proposal);
      const disposition = !proposalCurrent
        ? {
            kind: 'denied' as const,
            reason: proposal.governance_policy_version !== policy.version
              ? 'Current governance policy differs from proposal'
              : 'Proposal is no longer executable',
          }
        : eligible.length < requiredApprovers
          ? { kind: 'approval_required' as const }
          : { kind: 'authorized_without_approval' as const };
      const executionWithApprovals =
        proposalCurrent && eligible.length >= requiredApprovers
          ? this.authorizeGenericProposal({
              actorId: input.actorId,
              auth: input.auth,
              spaceId: input.spaceId,
              policyVersion: policy.version,
              phase: 'execute',
              capability: executionCapability,
              operation,
              budgetId: proposal.budget_id,
              facts,
              payload,
              now: input.now,
              verifiedHumanApproval: true,
            })
          : null;
      const canExecute =
        executionWithApprovals?.allowed === true &&
        executionWithApprovals.disposition.kind === 'authorized_without_approval';

      const canApprove = !agentPrincipal && proposalCurrent && approvalRead?.allowed === true;
      const requestId = input.requestId ?? randomUUID();
      const readAdmission = [fullReadResource, exactPrivateRead, approvalRead, executionRead, requesterRead]
        .find((authorization) => authorization?.allowed);
      this.stmt.insertAudit.run({
        id: randomUUID(),
        classification: 'authorization_check',
        timestamp: input.now,
        actorId: input.actorId,
        operation,
        proposalId: proposal.id,
        payloadHash: proposal.payload_hash,
        budgetId: proposal.budget_id,
        backendIds: '[]',
        policyVersion: policy.version,
        authorizationDisposition: JSON.stringify({ kind: 'authorized_without_approval' }),
        idempotencyKey: null,
        expectedPriorState: null,
        observedResultState: null,
        providerModel: null,
        correlationId: requestId,
        requestId,
        result: JSON.stringify({
          kind: 'proposal_read_admission',
          spaceId: input.spaceId,
          membershipId: readAdmission?.membershipId ?? null,
          delegationId: agentPrincipal && input.auth.method === 'api-key' ? input.auth.delegationId : null,
          delegationVersion: agentPrincipal && input.auth.method === 'api-key' ? input.auth.delegationVersion : null,
        }),
        isError: 0,
      });
      return {
        currentGovernancePolicyVersion: policy.version,
        requesterMembershipCurrent: true,
        privateEnvelopeVisible: fullReadAllowed,
        approvalAuthorized: approvalRead?.allowed === true,
        executionAuthorized: executionRead?.allowed === true,
        requiredApprovers,
        approvers: eligible.map((approval) => ({
          actorId: approval.actor_id,
          issuedAt: approval.created_at,
          expiresAt: approval.expires_at,
        })),
        disposition,
        canApprove,
        canExecute,
      };
    }).immediate();
  }



  async acquireProposalExecution(
    input: AcquireProposalExecutionInput,
  ): Promise<ProposalExecutionAcquisition> {
    return this.db.transaction(() => {
      const proposal = this.stmt.selectProposal.get(input.proposalId) as ProposalRow | undefined;
      if (!proposal || !isGenericProposalOperation(proposal.operation))
        throw new ProposalAcquisitionError('authorization_denied', 'Generic proposal not found');
      const operation = proposal.operation as GenericProposalOperation;
      const now = input.now ?? nowISO();
      const nowMillis = timestampMillis(now);
      const expiresAt = timestampMillis(proposal.expires_at);
      const existingAcquisition = this.stmt.selectProposalExecutionAcquisition.get(
        input.proposalId,
      ) as
        | { proposal_id: string; idempotency_key: string; actor_id: string; acquired_at: string }
        | undefined;
      const existingIdempotency =
        existingAcquisition?.idempotency_key === input.idempotencyKey
          ? (this.stmt.selectIdempotency.get(input.idempotencyKey) as IdempotencyRow | undefined)
          : undefined;
      const completedReplay =
        existingAcquisition?.actor_id === input.actorId &&
        existingIdempotency !== undefined &&
        existingIdempotency.proposal_id === input.proposalId &&
        existingIdempotency.operation === operation &&
        existingIdempotency.completed !== 0;
      if (
        nowMillis === null ||
        expiresAt === null ||
        (expiresAt <= nowMillis && !completedReplay)
      )
        throw new ProposalAcquisitionError('proposal_expired', 'Proposal is expired');
      if (proposal.superseded_at && !completedReplay)
        throw new ProposalAcquisitionError('proposal_superseded', 'Proposal is superseded');
      if (proposal.policy_version !== GENERIC_MUTATION_POLICY_VERSION)
        throw new ProposalAcquisitionError('policy_version_mismatch', 'Generic mutation policy version changed');
      if (!this.proposalHashMatches(proposal) || input.payloadHash !== proposal.payload_hash)
        throw new ProposalAcquisitionError('payload_hash_mismatch', 'Proposal hash does not match stored envelope');
      if (input.actorId !== input.auth.actorId || !this.operationalAuthMatches(input.auth, input.actorId, now))
        throw new ProposalAcquisitionError('authorization_denied', 'Executor does not match trusted credentials');
      if (
        input.auth.method === 'api-key' &&
        input.auth.principalType === 'agent' &&
        (proposal.requester_delegation_id !== null || proposal.requester_delegation_version !== null) &&
        (proposal.requester_delegation_id !== input.auth.delegationId ||
          proposal.requester_delegation_version !== input.auth.delegationVersion)
      )
        throw new ProposalAcquisitionError('authorization_denied', 'Agent proposal origin delegation differs');
      if (!input.idempotencyKey.trim())
        throw new ProposalAcquisitionError('idempotency_replay_mismatch', 'Idempotency key is required');

      const spaceId = proposal.space_id;
      const requesterMembershipId = proposal.requester_membership_id;
      const governancePolicyVersion = proposal.governance_policy_version;
      if (!spaceId || !requesterMembershipId || !governancePolicyVersion)
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal lacks trusted governance provenance');
      const space = this.governance.getSpace({ spaceId });
      const policy = this.governance.getPolicy({ spaceId });
      if (
        !space ||
        space.deletedAt !== null ||
        space.budgetId !== proposal.budget_id ||
        !policy ||
        policy.version !== governancePolicyVersion ||
        input.governancePolicyVersion !== governancePolicyVersion
      )
        throw new ProposalAcquisitionError('policy_version_mismatch', 'Current governance policy differs from proposal');
      if (!this.requesterMembershipCurrent(proposal, now))
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal requester membership is no longer current');

      let payload: unknown;
      let preconditions: unknown;
      try {
        payload = JSON.parse(proposal.payload) as unknown;
        preconditions = JSON.parse(proposal.preconditions) as unknown;
      } catch {
        throw new ProposalAcquisitionError('payload_hash_mismatch', 'Stored proposal envelope is invalid');
      }
      let facts: ProposalAuthorizationFacts;
      try {
        facts = deriveProposalAuthorizationFacts(operation, payload, preconditions);
      } catch {
        throw new ProposalAcquisitionError('payload_hash_mismatch', 'Stored proposal authorization facts are invalid');
      }
      if (!this.proposalOriginAuthorityCurrent(proposal, operation, facts, payload, policy.version, now))
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal origin authority is no longer current');
      const serializedProposal = JSON.stringify({ operation, payload, preconditions });
      if (serializedProposal !== input.serialisedEffect)
        throw new ProposalAcquisitionError('idempotency_replay_mismatch', 'Execution effect differs from proposal');
      const capability = operation === 'set_category' ? 'categorization:execute' : 'rule:execute';
      const authorization = this.authorizeGenericProposal({
        actorId: input.actorId,
        auth: input.auth,
        spaceId,
        policyVersion: policy.version,
        phase: 'propose',
        capability,
        operation,
        budgetId: proposal.budget_id,
        facts,
        payload,
        now,
      });
      if (!authorization.allowed)
        throw new ProposalAcquisitionError('authorization_denied', authorization.reason);

      if (existingAcquisition) {
        if (existingAcquisition.actor_id !== input.actorId)
          throw new ProposalAcquisitionError('authorization_denied', 'Execution replay is unavailable');
        if (existingAcquisition.idempotency_key !== input.idempotencyKey)
          throw new ProposalAcquisitionError('idempotency_in_progress', 'Proposal execution was already acquired');
        const existing = existingIdempotency;
        if (
          !existing ||
          existing.proposal_id !== input.proposalId ||
          existing.operation !== operation ||
          existing.serialised_effect !== input.serialisedEffect
        )
          throw new ProposalAcquisitionError('idempotency_replay_mismatch', 'Execution replay does not match its claim');
        return {
          claim: { record: rowToIdempotency(existing), isOwner: false },
          approvals: [],
          auditRecord: null,
        };
      }
      if (!this.proposalReviewProvenanceMatches(proposal))
        throw new ProposalAcquisitionError('authorization_denied', 'Proposal review provenance is no longer current');

      if (!this.ruleOverrideSnapshotMatches(spaceId, proposal.budget_id, payload, preconditions))
        throw new ProposalAcquisitionError('authorization_denied', 'Current rule override state differs from the proposal');
      const existingKey = this.stmt.selectIdempotency.get(input.idempotencyKey) as IdempotencyRow | undefined;
      if (existingKey)
        throw new ProposalAcquisitionError('idempotency_replay_mismatch', 'Idempotency key is already in use');
      const priorClaim = this.stmt.selectIdempotencyByProposalOp.get({
        proposalId: input.proposalId,
        operation,
      }) as IdempotencyRow | undefined;
      if (priorClaim)
        throw new ProposalAcquisitionError('idempotency_in_progress', 'Proposal execution was already claimed');

      const eligible = this.eligibleHumanApprovals({
        proposalId: input.proposalId,
        payloadHash: proposal.payload_hash,
        spaceId,
        policyVersion: policy.version,
        operation,
        budgetId: proposal.budget_id,
        facts,
        payload,
        now,
      });

      const requiredApprovers = requiredProposalApprovers(authorization);
      let selectedApprovals = eligible;
      if (input.approvalId) {
        const selected = eligible.find((approval) => approval.id === input.approvalId);
        if (!selected) {
          const hinted = this.stmt.selectApproval.get(input.approvalId) as ApprovalRow | undefined;
          throw new ProposalAcquisitionError(
            hinted?.status === 'consumed' ? 'approval_consumed' : 'approval_required',
            'Selected approval is not currently eligible',
          );
        }
        selectedApprovals = [selected, ...eligible.filter((approval) => approval.id !== selected.id)];
      }
      selectedApprovals = selectedApprovals.slice(0, requiredApprovers);
      if (selectedApprovals.length < requiredApprovers)
        throw new ProposalAcquisitionError('approval_required', 'Additional human approval is required');

      const executionAuthorization = this.authorizeGenericProposal({
        actorId: input.actorId,
        auth: input.auth,
        spaceId,
        policyVersion: policy.version,
        phase: 'execute',
        capability,
        operation,
        budgetId: proposal.budget_id,
        facts,
        payload,
        now,
        verifiedHumanApproval: true,
      });
      if (!executionAuthorization.allowed)
        throw new ProposalAcquisitionError('authorization_denied', executionAuthorization.reason);

      const leaseExpiresAt = new Date(nowMillis + 60_000).toISOString();
      const claim = this.stmt.insertIdempotency.get({
        idempotencyKey: input.idempotencyKey,
        proposalId: input.proposalId,
        operation,
        executedAt: now,
        serialisedEffect: input.serialisedEffect,
        leaseExpiresAt,
        updatedAt: now,
      }) as IdempotencyRow | undefined;
      if (!claim)
        throw new ProposalAcquisitionError('idempotency_replay_mismatch', 'Idempotency key is already in use');
      const acquired = this.stmt.insertProposalExecutionAcquisition.get({
        proposalId: input.proposalId,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        acquiredAt: now,
      }) as { proposal_id: string } | undefined;
      if (!acquired)
        throw new ProposalAcquisitionError('idempotency_in_progress', 'Proposal execution was already acquired');

      const consumedApprovals: ProposalApproval[] = [];
      for (const approval of selectedApprovals) {
        const result = this.stmt.consumeApprovalStmt.run({ id: approval.id, now });
        if (result.changes !== 1)
          throw new ProposalAcquisitionError('approval_consumed', 'Approval changed during execution acquisition');
        consumedApprovals.push(
          rowToApproval({ ...approval, status: 'consumed', consumed_at: now }),
        );
      }

      const auditId = randomUUID();
      const auditResult = JSON.stringify({
        proposalId: input.proposalId,
        approvalIds: consumedApprovals.map((approval) => approval.id),
      });
      this.stmt.insertAudit.run({
        id: auditId,
        classification: 'execution_started',
        timestamp: now,
        actorId: input.actorId,
        operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payload_hash,
        budgetId: proposal.budget_id,
        backendIds: '[]',
        policyVersion: proposal.policy_version,
        authorizationDisposition: JSON.stringify(executionAuthorization.disposition),
        idempotencyKey: input.idempotencyKey,
        expectedPriorState: null,
        observedResultState: 'acquired',
        providerModel: proposal.provider_model,
        correlationId: input.correlationId ?? proposal.correlation_id,
        requestId: input.requestId ?? null,
        result: auditResult,
        isError: 0,
      });
      const auditRecord: AuditRecord = {
        id: auditId,
        classification: 'execution_started',
        timestamp: now,
        actorId: input.actorId,
        operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payload_hash,
        budgetId: proposal.budget_id,
        backendIds: '[]',
        policyVersion: proposal.policy_version,
        authorizationDisposition: executionAuthorization.disposition,
        idempotencyKey: input.idempotencyKey,
        expectedPriorState: null,
        observedResultState: 'acquired',
        providerModel: proposal.provider_model,
        correlationId: input.correlationId ?? proposal.correlation_id,
        requestId: input.requestId ?? null,
        result: auditResult,
        isError: false,
      };
      return {
        claim: { record: rowToIdempotency(claim), isOwner: true },
        approvals: consumedApprovals,
        auditRecord,
      };
    }).immediate();
  }
  async getApproval(id: string): Promise<ProposalApproval | null> {
    const row = this.stmt.selectApproval.get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  async findActiveApprovals(proposalId: string): Promise<ProposalApproval[]> {
    // First mark any expired approvals
    const now = nowISO();
    this.stmt.markExpiredApprovals.run({ now });

    const rows = this.stmt.selectActiveApprovals.all({ proposalId, now }) as ApprovalRow[];
    return rows.map(rowToApproval);
  }


  // ── Idempotency records ───────────────────────────────────────────

  async createIdempotencyRecord(input: CreateIdempotencyInput): Promise<IdempotencyClaim> {
    const now = nowISO();
    const leaseMs = input.leaseDurationMs ?? 60_000;
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    // Atomic claim: INSERT with ON CONFLICT DO NOTHING — eliminates SELECT-then-INSERT race
    const row = this.stmt.insertIdempotency.get({
      idempotencyKey: input.idempotencyKey,
      proposalId: input.proposalId,
      operation: input.operation,
      executedAt: now,
      serialisedEffect: input.serialisedEffect,
      leaseExpiresAt,
      updatedAt: now,
    }) as IdempotencyRow | undefined;

    if (row) {
      // Fresh insert succeeded — we own the claim
      return { record: rowToIdempotency(row), isOwner: true };
    }

    // Key already exists — validate ownership against the existing record
    const existing = this.stmt.selectIdempotency.get(input.idempotencyKey) as IdempotencyRow;

    if (existing.proposal_id !== input.proposalId || existing.operation !== input.operation) {
      throw new Error(
        `Idempotency key ${input.idempotencyKey} replay mismatch: ` +
          `already recorded for proposal ${existing.proposal_id} (op: ${existing.operation}), ` +
          `cannot reuse with proposal ${input.proposalId} (op: ${input.operation})`,
      );
    }
    if (existing.serialised_effect !== input.serialisedEffect) {
      throw new Error(
        `Idempotency key ${input.idempotencyKey} replay mismatch: ` +
          `serialised effect differs from original`,
      );
    }

    return { record: rowToIdempotency(existing), isOwner: false };
  }

  async getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    const row = this.stmt.selectIdempotency.get(key) as IdempotencyRow | undefined;
    return row ? rowToIdempotency(row) : null;
  }

  async completeIdempotencyRecord(
    key: string,
    errorMessage?: string | null,
    isRetryable?: boolean,
    serialisedResult?: string | null,
  ): Promise<IdempotencyRecord> {
    const now = nowISO();
    const status: IdempotencyStatus = errorMessage
      ? isRetryable
        ? 'retryable_failed'
        : 'terminal_failed'
      : 'succeeded';
    this.stmt.completeIdempotencyStmt.run({
      key,
      status,
      errorMessage: errorMessage ?? null,
      serialisedResult: status === 'succeeded' ? (serialisedResult ?? null) : null,
      now,
    });
    const row = this.stmt.selectIdempotency.get(key) as IdempotencyRow;
    return rowToIdempotency(row);
  }

  async findStrandedIdempotencyRecords(): Promise<IdempotencyRecord[]> {
    const now = nowISO();
    const rows = this.stmt.selectStrandedIdempotencyStmt.all({ now }) as IdempotencyRow[];
    return rows.map(rowToIdempotency);
  }

  async reconcileStrandedIdempotencyRecords(): Promise<number> {
    const now = nowISO();
    const result = this.stmt.updateStrandedIdempotencyStmt.run({
      now,
      errorMessage: 'Lease expired — stranded in_progress record reconciled',
    });
    return result.changes;
  }

  // ── Audit records (append-only) ───────────────────────────────────

  async appendAuditRecord(input: AppendAuditInput): Promise<AuditRecord> {
    const id = randomUUID();
    const now = nowISO();

    const authDispositionJson = input.authorizationDisposition
      ? JSON.stringify(input.authorizationDisposition)
      : null;

    this.stmt.insertAudit.run({
      id,
      classification: input.classification,
      timestamp: now,
      actorId: input.actorId,
      operation: input.operation ?? null,
      proposalId: input.proposalId ?? null,
      payloadHash: input.payloadHash ?? null,
      budgetId: input.budgetId ?? null,
      backendIds: input.backendIds ?? '[]',
      policyVersion: input.policyVersion ?? null,
      authorizationDisposition: authDispositionJson,
      idempotencyKey: input.idempotencyKey ?? null,
      expectedPriorState: input.expectedPriorState ?? null,
      observedResultState: input.observedResultState ?? null,
      providerModel: input.providerModel ?? null,
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
      result: input.result,
      isError: input.isError ? 1 : 0,
    });

    // Actually, let's construct from what we have
    const resultRecord: AuditRecord = {
      id,
      classification: input.classification,
      timestamp: now,
      actorId: input.actorId,
      operation: input.operation ?? null,
      proposalId: input.proposalId ?? null,
      payloadHash: input.payloadHash ?? null,
      budgetId: input.budgetId ?? null,
      backendIds: input.backendIds ?? '[]',
      policyVersion: input.policyVersion ?? null,
      authorizationDisposition: input.authorizationDisposition ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      expectedPriorState: input.expectedPriorState ?? null,
      observedResultState: input.observedResultState ?? null,
      providerModel: input.providerModel ?? null,
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
      result: input.result,
      isError: input.isError ?? false,
    };
    return resultRecord;
  }

  async queryAuditRecords(
    classification?: AuditClassification,
    limit?: number,
    offset?: number,
  ): Promise<AuditRecord[]> {
    const rows = this.stmt.selectAuditByClassification.all({
      classification: classification ?? null,
      limit: limit ?? 50,
      offset: offset ?? 0,
    }) as AuditRow[];
    return rows.map(rowToAudit);
  }

  async queryAuditRecordsByProposal(proposalId: string, limit?: number): Promise<AuditRecord[]> {
    const rows = this.stmt.selectAuditByProposal.all({
      proposalId,
      limit: limit ?? 50,
    }) as AuditRow[];
    return rows.map(rowToAudit);
  }

  // ── Authorization ─────────────────────────────────────────────────

  private operationalAuthMatches(auth: OperationalAuth, actorId: string, now: string): boolean {
    if (auth.actorId !== actorId) return false;
    if (auth.method === 'session')
      return typeof auth.sessionId === 'string' && auth.sessionId.trim().length > 0;
    if (auth.method === 'human-session')
      return typeof auth.sessionId === 'string' && auth.sessionId.trim().length > 0;
    const principal = this.governance.resolveCredentialPrincipal({
      credentialId: auth.credentialId,
      referenceId: auth.credentialOwnerId,
      now,
    });
    return !!principal &&
      principal.actorId === auth.actorId &&
      principal.credentialId === auth.credentialId &&
      principal.credentialOwnerId === auth.credentialOwnerId &&
      principal.principalType === auth.principalType &&
      (auth.principalType === 'human' ||
        (principal.principalType === 'agent' &&
          principal.delegationId === auth.delegationId &&
          principal.delegationVersion === auth.delegationVersion));
  }

  private requesterMembershipCurrent(proposal: ProposalRow, now: string): boolean {
    if (!proposal.space_id || !proposal.requester_membership_id) return false;
    const membership = this.governance
      .listMembershipHistory({ spaceId: proposal.space_id })
      .find((candidate) => candidate.id === proposal.requester_membership_id);
    if (
      !membership ||
      this.governance.getCurrentMembership({
        spaceId: proposal.space_id,
        actorId: membership.actorId,
        now,
      })?.id !== membership.id
    )
      return false;
    if (!proposal.requester_delegation_id && !proposal.requester_delegation_version)
      return membership.actorId === proposal.actor_id;
    if (
      !proposal.requester_delegation_id ||
      !proposal.requester_delegation_version ||
      membership.actorId === proposal.actor_id
    )
      return false;

    const delegation = this.governance
      .listDelegations({ spaceId: proposal.space_id, agentId: proposal.actor_id })
      .find((candidate) =>
        candidate.id === proposal.requester_delegation_id &&
        candidate.version === proposal.requester_delegation_version);
    const agent = this.governance.getAgent({ agentId: proposal.actor_id });
    const nowMillis = timestampMillis(now);
    const validFrom = delegation ? timestampMillis(delegation.validFrom) : null;
    const validUntil = delegation?.validUntil === null || delegation?.validUntil === undefined
      ? null
      : timestampMillis(delegation.validUntil);
    return !!delegation &&
      delegation.revokedAt === null &&
      delegation.spaceId === proposal.space_id &&
      delegation.agentId === proposal.actor_id &&
      delegation.issuerActorId === membership.actorId &&
      delegation.issuerMembershipId === membership.id &&
      agent !== null &&
      agent.registeredSpaceId === proposal.space_id &&
      agent.status === 'active' &&
      nowMillis !== null &&
      validFrom !== null &&
      validFrom <= nowMillis &&
      (delegation.validUntil === null || validUntil !== null && nowMillis < validUntil);
  }

  private proposalOriginAuthorityCurrent(
    proposal: ProposalRow,
    operation: GenericProposalOperation,
    facts: ProposalAuthorizationFacts,
    payload: unknown,
    policyVersion: string,
    now: string,
  ): boolean {
    if (!proposal.space_id || !proposal.requester_membership_id)
      return false;
    const hasDelegationId = proposal.requester_delegation_id !== null;
    const hasDelegationVersion = proposal.requester_delegation_version !== null;
    if (hasDelegationId !== hasDelegationVersion)
      return false;
    const issuerMembership = this.governance
      .listMembershipHistory({ spaceId: proposal.space_id })
      .find((membership) => membership.id === proposal.requester_membership_id);
    if (
      !issuerMembership ||
      (hasDelegationId
        ? issuerMembership.actorId === proposal.actor_id
        : issuerMembership.actorId !== proposal.actor_id)
    )
      return false;
    const capability = operation === 'set_category' ? 'categorization:propose' : 'rule:propose';
    return this.authorizeGenericProposal({
      actorId: issuerMembership.actorId,
      spaceId: proposal.space_id,
      membershipId: issuerMembership.id,
      policyVersion,
      phase: 'propose',
      capability,
      operation,
      budgetId: proposal.budget_id,
      facts,
      payload,
      now,
    }).allowed;
  }

  private proposalHashMatches(proposal: ProposalRow): boolean {
    try {
      return canonicalProposalHash({
        operation: proposal.operation,
        budgetId: proposal.budget_id,
        payload: JSON.parse(proposal.payload) as unknown,
        preconditions: JSON.parse(proposal.preconditions) as unknown,
        actorId: proposal.actor_id,
        policyVersion: proposal.policy_version,
        expiresAt: proposal.expires_at,
      }) === proposal.payload_hash;
    } catch {
      return false;
    }
  }

  private freshHumanControl(auth: CreateApprovalInput['auth'], actorId: string, now: string): boolean {
    const current = timestampMillis(now);
    const reauthenticated = timestampMillis(auth.reauthenticatedAt);
    return auth.method === 'human-session' &&
      auth.actorId === actorId &&
      typeof auth.sessionId === 'string' &&
      auth.sessionId.trim().length > 0 &&
      current !== null &&
      reauthenticated !== null &&
      reauthenticated <= current &&
      current - reauthenticated <= 5 * 60_000;
  }

  private eligibleHumanApprovals(input: {
    readonly proposalId: string;
    readonly payloadHash: string;
    readonly spaceId: string;
    readonly policyVersion: string;
    readonly operation: GenericProposalOperation;
    readonly budgetId: string;
    readonly facts: ProposalAuthorizationFacts;
    readonly payload: unknown;
    readonly now: string;
  }): ApprovalRow[] {
    const activeApprovals = this.stmt.selectActiveApprovals.all({
      proposalId: input.proposalId,
      now: input.now,
    }) as ApprovalRow[];
    const eligible: ApprovalRow[] = [];
    const actors = new Set<string>();
    for (const approval of activeApprovals) {
      if (
        approval.payload_hash !== input.payloadHash ||
        approval.governance_policy_version !== input.policyVersion ||
        !approval.issuer_membership_id ||
        !approval.reauthenticated_session_id?.trim() ||
        !approval.reauthenticated_at
      )
        continue;
      const reauthenticatedAt = timestampMillis(approval.reauthenticated_at);
      const approvedAt = timestampMillis(approval.created_at);
      if (
        reauthenticatedAt === null ||
        approvedAt === null ||
        reauthenticatedAt > approvedAt ||
        approvedAt - reauthenticatedAt > 5 * 60_000
      )
        continue;
      const membership = this.governance
        .listMembershipHistory({ spaceId: input.spaceId, actorId: approval.actor_id })
        .find((candidate) => candidate.id === approval.issuer_membership_id);
      if (
        !membership ||
        this.governance.getCurrentMembership({
          spaceId: input.spaceId,
          actorId: approval.actor_id,
          now: input.now,
        })?.id !== membership.id
      )
        continue;
      const approvalAuthorization = this.authorizeGenericProposal({
        actorId: approval.actor_id,
        spaceId: input.spaceId,
        policyVersion: input.policyVersion,
        phase: 'execute',
        capability: input.operation === 'set_category' ? 'categorization:approve' : 'rule:approve',
        operation: input.operation,
        budgetId: input.budgetId,
        facts: input.facts,
        payload: input.payload,
        now: input.now,
        membershipId: approval.issuer_membership_id,
        verifiedHumanApproval: true,
      });
      if (!approvalAuthorization.allowed || actors.has(approval.actor_id)) continue;
      actors.add(approval.actor_id);
      eligible.push(approval);
    }
    return eligible;
  }

  private authorizeGenericProposal(input: {
    readonly actorId: string;
    readonly auth?: OperationalAuth;
    readonly spaceId: string;
    readonly policyVersion: string;
    readonly phase: 'read' | 'propose' | 'approve' | 'execute';
    readonly capability: string;
    readonly operation: string;
    readonly budgetId: string;
    readonly facts: ProposalAuthorizationFacts;
    readonly payload: unknown;
    readonly now: string;
    readonly membershipId?: string;
    readonly verifiedHumanApproval?: true;
  }) {
    const required: Record<string, GovernanceResourceRef & { readonly capability: string }> = {};
    const addRequired = (resource: GovernanceResourceRef, capability: string): void => {
      required[`${resource.resourceKind}:${resource.resourceId}:${capability}`] = { ...resource, capability };
    };
    addRequired({ resourceKind: 'budget', resourceId: input.budgetId }, input.capability);
    for (const resource of input.facts.resources) addRequired(resource, input.capability);
    const agent = input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
      ? input.auth
      : null;
    return this.governance.authorize({
      actorId: input.actorId,
      spaceId: input.spaceId,
      ...(input.membershipId ? { membershipId: input.membershipId } : {}),
      expectedPolicyVersion: input.policyVersion,
      phase: input.phase,
      operation: input.operation,
      required: Object.values(required),
      payload: {
        operations: input.facts.operations,
        proposal: input.payload,
        resources: input.facts.resources,
      },
      now: input.now,
      ...(input.auth ? { auth: input.auth } : {}),
      ...(agent
        ? {
            agentId: agent.actorId,
            delegationId: agent.delegationId,
            delegationVersion: agent.delegationVersion,
          }
        : {}),
      ...(input.verifiedHumanApproval ? { verifiedHumanApproval: true as const } : {}),
    });
  }

  private ruleOverrideSnapshotMatches(
    spaceId: string,
    budgetId: string,
    payload: unknown,
    preconditions: unknown,
  ): boolean {
    const proposal = isPlainRecord(payload) ? payload : null;
    if (!proposal || (proposal.kind !== 'update_rule' && proposal.kind !== 'delete_rule')) return true;
    const before = isPlainRecord(preconditions) ? preconditions : null;
    if (
      !before ||
      !Object.prototype.hasOwnProperty.call(before, 'override') ||
      typeof proposal.ruleId !== 'string'
    )
      return false;
    const row = this.stmt.getRuleOverride.get({
      spaceId,
      budgetId,
      ruleId: proposal.ruleId,
    }) as RuleOverrideRow | undefined;
    const current = row ? rowToRuleOverride(row) : null;
    return canonicalProposalJson(current) === canonicalProposalJson(before.override);
  }


  async evaluateAuthorization(
    actorId: string,
    capability: string,
    scope: string,
    policyVersion: string,
  ): Promise<AuthorizationResult> {
    return this.evaluateAuthorizationSync(actorId, capability, scope, policyVersion);
  }

  private evaluateAuthorizationSync(
    actorId: string,
    capability: string,
    scope: string,
    policyVersion: string,
  ): AuthorizationResult {
    const identity = this.stmt.selectActorMembership.get(actorId) as ActorMembershipRow | undefined;
    const budgetId = scope.startsWith('budget:') ? scope.slice('budget:'.length) : scope;
    const space = budgetId && budgetId !== '*' ? this.governance.getSpaceForBudget({ budgetId }) : null;
    const policy = space ? this.governance.getPolicy({ spaceId: space.id }) : null;
    const now = nowISO();
    const membership = space
      ? this.governance.getCurrentMembership({ spaceId: space.id, actorId, now })
      : null;
    const phase =
      capability.endsWith(':approve') || capability.endsWith('.approve')
        ? 'approve'
        : capability.includes(':propose') || capability.endsWith('.create')
          ? 'propose'
          : capability === 'observe' || capability.startsWith('read:')
            ? 'read'
            : 'execute';
    const result = space && policy
      ? this.governance.authorize({
          actorId,
          spaceId: space.id,
          ...(membership ? { membershipId: membership.id } : {}),
          expectedPolicyVersion: policyVersion,
          phase,
          operation: capability,
          required: [{
            capability,
            resourceKind: 'budget',
            resourceId: budgetId,
          }],
          payload: { operations: [] },
          now,
        })
      : null;
    const allowed = result?.allowed ?? false;
    const reason = result?.reason ?? (
      !identity ? 'Actor is not registered'
        : !space ? 'Budget is not bound to a governed space'
          : !policy ? 'Current governance policy unavailable'
            : 'Authorization denied'
    );
    return {
      allowed,
      disposition: result?.disposition ?? { kind: 'denied', reason },
      actorId,
      membershipStatus: (identity?.status as MembershipStatus | undefined) ?? 'unknown',
      capability,
      scope,
      policyVersion: result?.policyVersion ?? policyVersion,
      reason,
    };
  }

  async upsertActorMembership(
    actorId: string,
    status: MembershipStatus,
    capabilities: string[],
    scope: string,
  ): Promise<void> {
    this.stmt.upsertActorMembershipStmt.run({
      actorId,
      status,
      capabilities: JSON.stringify(capabilities),
      scope,
    });
  }

  async getActorMembership(actorId: string): Promise<{
    actorId: string;
    status: MembershipStatus;
    capabilities: string[];
    scope: string;
  } | null> {
    const row = this.stmt.selectActorMembership.get(actorId) as ActorMembershipRow | undefined;
    if (!row) return null;
    return {
      actorId: row.actor_id,
      status: row.status as MembershipStatus,
      capabilities: JSON.parse(row.capabilities) as string[],
      scope: row.scope,
    };
  }

  // ── Lifecycle operations ──────────────────────────────────────────

  async cancelPendingJobs(
    scope: LifecycleScope,
    options?: { actorOnly?: boolean },
  ): Promise<number> {
    this.assertLifecycleScope(scope);
    const result = this.stmt.cancelPendingJobsStmt.run({
      spaceId: scope.spaceId,
      budgetId: scope.budgetId,
      actorId: scope.actorId,
      actorOnly: options?.actorOnly ? 1 : 0,
    });
    return result.changes;
  }

  async deleteActorMembership(actorId: string): Promise<boolean> {
    const result = this.stmt.deleteMembershipStmt.run(actorId);
    return result.changes > 0;
  }

  async recordExport(input: LifecycleScope & {
    budgetName: string;
    exportPath: string;
    sha256Hash: string;
    byteSize: number;
    accountCount: number;
    transactionCount: number;
  }): Promise<void> {
    this.assertLifecycleScope(input);
    if (
      !input.budgetName.trim() ||
      !input.exportPath.trim() ||
      !/^[a-f0-9]{64}$/i.test(input.sha256Hash) ||
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 0 ||
      !Number.isSafeInteger(input.accountCount) ||
      input.accountCount < 0 ||
      !Number.isSafeInteger(input.transactionCount) ||
      input.transactionCount < 0
    )
      throw new Error('Export record has invalid provenance');

    this.stmt.insertExportRecordStmt.run({
      id: randomUUID(),
      budgetName: input.budgetName,
      exportPath: input.exportPath,
      accountCount: input.accountCount,
      transactionCount: input.transactionCount,
      exportedAt: nowISO(),
      spaceId: input.spaceId,
      budgetId: input.budgetId,
      actorId: input.actorId,
      sha256Hash: input.sha256Hash,
      byteSize: input.byteSize,
    });
  }

  async getLastExport(scope: LifecycleScope): Promise<{
    exportedAt: string;
    budgetName: string;
    exportPath: string;
    sha256Hash: string;
    byteSize: number;
    accountCount: number;
    transactionCount: number;
  } | null> {
    this.assertLifecycleScope(scope);
    const row = this.stmt.selectLastExportStmt.get(scope) as
      | {
          budget_name: string;
          export_path: string;
          sha256_hash: string;
          byte_size: number;
          account_count: number;
          transaction_count: number;
          exported_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      exportedAt: row.exported_at,
      budgetName: row.budget_name,
      exportPath: row.export_path,
      sha256Hash: row.sha256_hash,
      byteSize: row.byte_size,
      accountCount: row.account_count,
      transactionCount: row.transaction_count,
    };
  }

  async deleteScopeData(
    dataScope: string,
    scope: LifecycleScope,
  ): Promise<{
    deleted: Record<string, number>;
    retained: { count: number; reasons: string[] };
  }> {
    this.assertLifecycleScope(scope);
    if (
      !['connection', 'space', 'user', 'provider', 'workflow', 'notification'].includes(
        dataScope,
      )
    )
      throw new Error(`Unknown lifecycle data scope "${dataScope}"`);

    const db = this.db;
    const deleted: Record<string, number> = {};
    const reasons: string[] = [];
    const actorOnly = dataScope === 'user';
    const params = { budgetId: scope.budgetId, spaceId: scope.spaceId, actorId: scope.actorId };
    const run = (sql: string): number => db.prepare(sql).run(params).changes;
    const transaction = db.transaction(() => {

      if (['connection', 'space', 'workflow', 'user'].includes(dataScope)) {
        const targetJobs = `
          SELECT id FROM candidate_jobs
           WHERE space_id = @spaceId AND budget_id = @budgetId
             ${actorOnly ? 'AND actor_id = @actorId' : ''}
        `;
        if (!actorOnly) {
          deleted.corrections = run(`
            DELETE FROM review_corrections
             WHERE review_item_id IN (SELECT id FROM review_items WHERE budget_id = @budgetId)
          `);
          deleted.reviewActions = run(`
            DELETE FROM review_actions
             WHERE review_item_id IN (SELECT id FROM review_items WHERE budget_id = @budgetId)
          `);
          deleted.reviewItems = run('DELETE FROM review_items WHERE budget_id = @budgetId');
          deleted.suggestions = run('DELETE FROM suggestions WHERE budget_id = @budgetId');
        }
        deleted.failures = run(`
          DELETE FROM failure_records WHERE job_id IN (${targetJobs})
        `);
        deleted.jobs = run(`
          DELETE FROM candidate_jobs WHERE id IN (${targetJobs}) AND status != 'processing'
        `);
      }

      if (['connection', 'space', 'workflow', 'provider'].includes(dataScope)) {
        deleted.findings = run('DELETE FROM findings WHERE budget_id = @budgetId');
      } else if (actorOnly) {
        deleted.findings = run(
          'DELETE FROM findings WHERE budget_id = @budgetId AND actor_id = @actorId',
        );
      }

      if (['connection', 'space', 'workflow', 'user'].includes(dataScope)) {
        const filters = actorOnly
          ? 'budget_id = @budgetId AND actor_id = @actorId'
          : 'budget_id = @budgetId';
        const reportScope = actorOnly
          ? `filter_id IN (SELECT id FROM saved_filters WHERE ${filters})`
          : `budget_id = @budgetId OR filter_id IN (SELECT id FROM saved_filters WHERE ${filters})`;
        deleted.reports = run(`DELETE FROM report_records WHERE ${reportScope}`);
        deleted.savedFilters = run(`DELETE FROM saved_filters WHERE ${filters}`);
        deleted.savedViews = run(
          actorOnly
            ? 'DELETE FROM saved_views WHERE space_id = @spaceId AND budget_id = @budgetId AND actor_id = @actorId'
            : 'DELETE FROM saved_views WHERE space_id = @spaceId AND budget_id = @budgetId',
        );
      }

      if (['connection', 'space', 'notification'].includes(dataScope)) {
        const selectedOutbox = `
          SELECT id FROM notification_outbox
           WHERE event_id IN (
             SELECT id FROM notification_events WHERE budget_id = @budgetId
           )
        `;
        deleted.deliveryAttempts = run(`
          DELETE FROM delivery_attempts WHERE outbox_id IN (${selectedOutbox})
        `);
        deleted.outboxRecords = run(`DELETE FROM notification_outbox WHERE id IN (${selectedOutbox})`);
        deleted.notificationEvents = run(`
          DELETE FROM notification_events WHERE budget_id = @budgetId
        `);
      }
    });
    transaction();

    const unscopedJobs = db
      .prepare(`
        SELECT COUNT(*) AS count FROM candidate_jobs
         WHERE status = 'pending'
           AND (space_id IS NULL OR budget_id IS NULL OR actor_id IS NULL)
      `)
      .get() as { count: number };
    let retainedCount = unscopedJobs.count;
    if (unscopedJobs.count > 0)
      reasons.push(`${unscopedJobs.count} legacy unscoped pending job(s) retained`);

    const activeJobs = db
      .prepare(`
        SELECT COUNT(*) AS count FROM candidate_jobs
         WHERE space_id = @spaceId AND budget_id = @budgetId
           AND status = 'processing'${actorOnly ? ' AND actor_id = @actorId' : ''}
      `)
      .get(params) as { count: number };
    retainedCount += activeJobs.count;
    if (activeJobs.count > 0)
      reasons.push(`${activeJobs.count} processing job(s) retained until completion`);

    const auditRecords = db
      .prepare('SELECT COUNT(*) AS count FROM audit_records WHERE budget_id = @budgetId')
      .get(params) as { count: number };
    retainedCount += auditRecords.count;
    if (auditRecords.count > 0)
      reasons.push(`${auditRecords.count} financial audit record(s) retained with attribution`);

    const identityRecords = db
      .prepare('SELECT COUNT(*) AS count FROM actor_memberships WHERE actor_id = @actorId')
      .get(params) as { count: number };
    retainedCount += identityRecords.count;
    if (identityRecords.count > 0)
      reasons.push(`${identityRecords.count} actor identity record(s) retained`);

    const governanceHistory = db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM spaces WHERE id = @spaceId) +
          (SELECT COUNT(*) FROM space_memberships WHERE space_id = @spaceId) +
          (SELECT COUNT(*) FROM governance_policies WHERE space_id = @spaceId) +
          (SELECT COUNT(*) FROM resource_grants WHERE space_id = @spaceId) +
          (SELECT COUNT(*) FROM governance_agents WHERE registered_space_id = @spaceId) +
          (SELECT COUNT(*) FROM agent_delegations WHERE space_id = @spaceId) +
          (SELECT COUNT(*) FROM credential_bindings WHERE space_id = @spaceId) +
          (SELECT COUNT(*) FROM space_governance_audit WHERE space_id = @spaceId) +
          (SELECT COUNT(*) FROM notification_policies WHERE space_id = @spaceId) AS count
      `)
      .get(params) as { count: number };
    retainedCount += governanceHistory.count;
    if (governanceHistory.count > 0)
      reasons.push(
        `${governanceHistory.count} space identity, membership, grant, delegation, policy and audit record(s) retained`,
      );
    const economicRecords = db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM action_proposals WHERE space_id = @spaceId AND budget_id = @budgetId) +
          (SELECT COUNT(*) FROM proposal_approvals a JOIN action_proposals p ON p.id = a.proposal_id
            WHERE p.space_id = @spaceId AND p.budget_id = @budgetId) +
          (SELECT COUNT(*) FROM idempotency_records i JOIN action_proposals p ON p.id = i.proposal_id
            WHERE p.space_id = @spaceId AND p.budget_id = @budgetId) +
          (SELECT COUNT(*) FROM transfer_previews WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM spend_sessions WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM payment_preferences WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM liquidity_claim_revisions WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM liquidity_claims WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM liquidity_claim_metadata WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM liquidity_allocations WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM liquidity_supplemental_facts WHERE budget_id = @budgetId) +
          (SELECT COUNT(*) FROM transfer_evidence WHERE budget_id = @budgetId) AS count
      `)
      .get(params) as { count: number };
    retainedCount += economicRecords.count;
    if (economicRecords.count > 0)
      reasons.push(`${economicRecords.count} economic claim, proposal and idempotency record(s) retained`);

    const exportRecords = db
      .prepare(`
        SELECT COUNT(*) AS count FROM export_records
         WHERE actor_id = @actorId AND space_id = @spaceId AND budget_id = @budgetId
      `)
      .get(params) as { count: number };
    retainedCount += exportRecords.count;
    if (exportRecords.count > 0)
      reasons.push(`${exportRecords.count} export provenance record(s) retained`);

    return { deleted, retained: { count: retainedCount, reasons } };
  }

  private assertLifecycleScope(scope: LifecycleScope): void {
    if (
      !scope ||
      typeof scope.spaceId !== 'string' ||
      !scope.spaceId.trim() ||
      typeof scope.budgetId !== 'string' ||
      !scope.budgetId.trim() ||
      typeof scope.actorId !== 'string' ||
      !scope.actorId.trim()
    )
      throw new Error('Lifecycle operations require an exact actor, space, and budget scope');
    const space = this.governance.getSpaceForBudget({ budgetId: scope.budgetId });
    if (!space || space.id !== scope.spaceId)
      throw new Error('Lifecycle scope does not match the current space/budget binding');
  }

  private assertRuleOverrideScope(scope: RuleOverrideScope): void {
    if (
      !scope ||
      typeof scope.spaceId !== 'string' ||
      !scope.spaceId.trim() ||
      typeof scope.budgetId !== 'string' ||
      !scope.budgetId.trim()
    )
      throw new Error('Rule override requires an exact space and budget scope');
    const space = this.governance.getSpaceForBudget({ budgetId: scope.budgetId });
    if (!space || space.id !== scope.spaceId)
      throw new Error('Rule override scope does not match the current space/budget binding');
  }

  private assertRuleOverrideId(ruleId: string): void {
    if (typeof ruleId !== 'string' || !ruleId.trim())
      throw new Error('Rule override requires a non-empty rule ID');
  }

  async setRuleOverride(input: SetRuleOverrideInput): Promise<RuleOverride> {
    this.assertRuleOverrideId(input.ruleId);
    if (typeof input.inactive !== 'boolean')
      throw new Error('Rule override inactive state must be a boolean');
    if (
      input.expectedVersion !== null &&
      (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    )
      throw new Error('Rule override expected version must be a positive integer or null');

    return this.db.transaction(() => {
      this.assertRuleOverrideScope(input);
      const now = nowISO();
      const parameters = {
        spaceId: input.spaceId,
        budgetId: input.budgetId,
        ruleId: input.ruleId,
        inactive: input.inactive ? 1 : 0,
        now,
      };
      const result = input.expectedVersion === null
        ? this.stmt.insertRuleOverride.run(parameters)
        : this.stmt.updateRuleOverride.run({
            ...parameters,
            expectedVersion: input.expectedVersion,
          });
      if (result.changes !== 1)
        throw new Error('Rule override version conflict');
      const row = this.stmt.getRuleOverride.get(input) as RuleOverrideRow | undefined;
      if (!row) throw new Error('Rule override write did not persist');
      return rowToRuleOverride(row);
    }).immediate();
  }

  async getRuleOverrides(scope: RuleOverrideScope): Promise<Map<string, RuleOverride>> {
    return this.db.transaction(() => {
      this.assertRuleOverrideScope(scope);
      const rows = this.stmt.getAllRuleOverrides.all(scope) as RuleOverrideRow[];
      const overrides = new Map<string, RuleOverride>();
      for (const row of rows) {
        const override = rowToRuleOverride(row);
        if (override.inactive !== null) overrides.set(override.ruleId, override);
      }
      return overrides;
    })();
  }

  async getRuleOverride(input: GetRuleOverrideInput): Promise<RuleOverride | null> {
    this.assertRuleOverrideId(input.ruleId);
    return this.db.transaction(() => {
      this.assertRuleOverrideScope(input);
      const row = this.stmt.getRuleOverride.get(input) as RuleOverrideRow | undefined;
      return row ? rowToRuleOverride(row) : null;
    })();
  }

  async removeRuleOverride(input: RemoveRuleOverrideInput): Promise<void> {
    this.assertRuleOverrideId(input.ruleId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new Error('Rule override expected version must be a positive integer');

    this.db.transaction(() => {
      this.assertRuleOverrideScope(input);
      const result = this.stmt.removeRuleOverride.run({
        spaceId: input.spaceId,
        budgetId: input.budgetId,
        ruleId: input.ruleId,
        expectedVersion: input.expectedVersion,
        now: nowISO(),
      });
      if (result.changes !== 1)
        throw new Error('Rule override version conflict');
    }).immediate();
  }

  // ── Registration and invitations ─────────────────────────────────

  async getRegistrationState(): Promise<RegistrationState> {
    const row = this.stmt.selectRegistrationState.get({}) as
      { owner_user_id: string | null; bootstrapped_at: string | null } | undefined;
    if (!row || !row.owner_user_id) {
      return { mode: 'bootstrap', ownerUserId: null, bootstrappedAt: null };
    }
    return {
      mode: 'complete',
      ownerUserId: row.owner_user_id,
      bootstrappedAt: row.bootstrapped_at,
    };
  }

  async claimBootstrap(input: BootstrapClaimInput): Promise<BootstrapClaimResult> {
    const now = nowISO();

    const txn = this.db.transaction(() => {
      const row = this.stmt.selectRegistrationState.get({}) as
        | { owner_user_id: string | null; claim_id: string | null; claimed_email: string | null }
        | undefined;

      if (row?.owner_user_id) {
        throw new Error('Bootstrap already completed');
      }

      if (row?.claim_id) {
        if (row.claimed_email === input.email) {
          return { claimId: row.claim_id };
        }
        throw new Error('Bootstrap already claimed');
      }

      this.stmt.insertRegistrationClaim.run({
        claimId: input.claimId,
        email: input.email,
        name: input.name,
        claimedAt: now,
      });
      this.stmt.insertAudit.run({
        id: randomUUID(),
        classification: 'bootstrap_claimed',
        timestamp: now,
        actorId: input.email,
        operation: 'claim_bootstrap',
        proposalId: null,
        payloadHash: null,
        budgetId: null,
        backendIds: '[]',
        policyVersion: null,
        authorizationDisposition: null,
        idempotencyKey: null,
        expectedPriorState: null,
        observedResultState: null,
        providerModel: null,
        correlationId: null,
        requestId: null,
        result: `Bootstrap claimed for ${input.email}`,
        isError: 0,
      });

      return { claimId: input.claimId };
    });

    return txn() as BootstrapClaimResult;
  }

  async finalizeBootstrap(input: FinalizeBootstrapInput): Promise<FinalizeBootstrapResult> {
    const now = nowISO();

    const txn = this.db.transaction(() => {
      const row = this.stmt.selectRegistrationState.get({}) as
        | { owner_user_id: string | null; claim_id: string | null; bootstrapped_at: string | null }
        | undefined;

      if (!row?.claim_id) {
        throw new Error('No bootstrap claim found');
      }
      if (row.claim_id !== input.claimId) {
        throw new Error('Claim ID mismatch');
      }

      if (row.owner_user_id) {
        return { ownerUserId: row.owner_user_id, bootstrappedAt: row.bootstrapped_at! };
      }

      const result = this.stmt.finalizeRegistration.run({
        claimId: input.claimId,
        ownerUserId: input.ownerUserId,
        bootstrappedAt: now,
      });
      if (result.changes === 0) {
        throw new Error('Bootstrap finalization failed');
      }

      this.stmt.upsertActorMembershipStmt.run({
        actorId: input.ownerUserId,
        status: 'active',
        capabilities: JSON.stringify([
          'observe',
          'finding:transition',
          'notification:receive',
          'notification:admin',
          'categorization:execute',
          'rule:execute',
        ]),
        scope: '*',
      });

      this.stmt.insertAudit.run({
        id: randomUUID(),
        classification: 'bootstrap_completed',
        timestamp: now,
        actorId: input.ownerUserId,
        operation: 'bootstrap',
        proposalId: null,
        payloadHash: null,
        budgetId: null,
        backendIds: '[]',
        policyVersion: null,
        authorizationDisposition: null,
        idempotencyKey: null,
        expectedPriorState: null,
        observedResultState: null,
        providerModel: null,
        correlationId: null,
        requestId: null,
        result: 'Owner created',
        isError: 0,
      });

      return { ownerUserId: input.ownerUserId, bootstrappedAt: now };
    });

    return txn() as FinalizeBootstrapResult;
  }

  private invitationControl(input: InvitationControlInput, operation: string) {
    const now = input.now ?? nowISO();
    const space = this.governance.getSpace({ spaceId: input.spaceId });
    const policy = space && this.governance.getPolicy({ spaceId: space.id });
    if (!space || !policy) throw new Error('Invitation control authorization denied');
    const authorization = this.governance.authorize({
      actorId: input.auth.actorId, spaceId: space.id, expectedPolicyVersion: policy.version,
      phase: 'approve', operation, auth: input.auth, now,
      required: [{ capability: 'membership:manage', resourceKind: 'space', resourceId: space.id }],
      payload: { operations: [{ operation, resourceKind: 'space', resourceId: space.id }] },
    });
    if (!authorization.allowed || !authorization.membershipId)
      throw new Error('Invitation control authorization denied');
    return { space, policy, membershipId: authorization.membershipId, now };
  }

  private invitationIssuer(row: InvitationRow, now: string): void {
    if (!row.space_id || !row.issuer_membership_id || !row.governance_policy_version ||
        Date.parse(row.expires_at) <= Date.parse(now)) throw new Error('Invalid invitation');
    const membership = this.governance.getCurrentMembership({
      spaceId: row.space_id, actorId: row.created_by_user_id, now,
    });
    if (membership?.id !== row.issuer_membership_id) throw new Error('Invalid invitation');
    const authorization = this.governance.authorize({
      actorId: row.created_by_user_id, spaceId: row.space_id, membershipId: membership.id,
      expectedPolicyVersion: row.governance_policy_version, phase: 'read', operation: 'invitation.create', now,
      required: [{ capability: 'membership:manage', resourceKind: 'space', resourceId: row.space_id }],
      payload: { operations: [{ operation: 'invitation.create', resourceKind: 'space', resourceId: row.space_id }] },
    });
    if (!authorization.allowed) throw new Error('Invalid invitation');
  }

  private invitationAudit(input: {
    id: string; spaceId: string; actorId: string; action: string; now: string;
    policyVersion: string; issuerMembershipId: string; requestId?: string; correlationId?: string;
  }): void {
    this.stmt.insertAudit.run({
      id: randomUUID(), classification: `invitation_${input.action}`, timestamp: input.now,
      actorId: input.actorId, operation: `invitation.${input.action}`, proposalId: input.id,
      payloadHash: null, budgetId: this.governance.getSpace({ spaceId: input.spaceId })?.budgetId ?? null,
      backendIds: '[]', policyVersion: input.policyVersion,
      authorizationDisposition: 'authorized_without_approval', idempotencyKey: null,
      expectedPriorState: JSON.stringify({ spaceId: input.spaceId, issuerMembershipId: input.issuerMembershipId }),
      observedResultState: null, providerModel: null, correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null, result: input.action, isError: 0,
    });
  }

  /** Creates one membership-only invitation with immutable original issuer consent. */
  async createInvitation(input: InvitationControlInput): Promise<CreateInvitationResult> {
    return this.db.transaction(() => {
      const context = this.invitationControl(input, 'invitation.create');
      const id = randomUUID();
      const rawToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.parse(context.now) + 7 * 24 * 60 * 60 * 1000).toISOString();
      this.stmt.insertInvitation.run({
        id, tokenDigest: createHash('sha256').update(rawToken).digest('hex'),
        createdByUserId: input.auth.actorId, expiresAt, createdAt: context.now,
        spaceId: context.space.id, issuerMembershipId: context.membershipId,
        governancePolicyVersion: context.policy.version,
      });
      this.invitationAudit({
        ...input, id, actorId: input.auth.actorId, action: 'created', now: context.now,
        policyVersion: context.policy.version, issuerMembershipId: context.membershipId,
      });
      const base = (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
      return { invitation: { id, expiresAt, status: 'active' as const }, inviteUrl: `${base}/invite#token=${rawToken}` };
    }).immediate();
  }

  /** Revokes selected-space invitations without deleting original attribution. */
  async revokeInvitation(input: InvitationControlInput & { readonly invitationId: string }): Promise<void> {
    this.db.transaction(() => {
      const context = this.invitationControl(input, 'invitation.revoke');
      const row = this.stmt.selectInvitation.get(input.invitationId) as InvitationRow | undefined;
      if (!row || row.space_id !== input.spaceId) throw new Error('Invitation unavailable');
      if (row.status === 'revoked') return;
      if (this.stmt.updateInvitationRevoke.run({ id: row.id }).changes !== 1)
        throw new Error('Invitation cannot be revoked');
      this.invitationAudit({
        ...input, id: row.id, actorId: input.auth.actorId, action: 'revoked', now: context.now,
        policyVersion: context.policy.version, issuerMembershipId: context.membershipId,
      });
    }).immediate();
  }

  /** Lists only token-free invitation metadata in the authorized selected space. */
  async listInvitations(input: InvitationControlInput): Promise<InvitationMetadata[]> {
    this.invitationControl(input, 'invitation.list');
    const rows = this.stmt.selectAllInvitations.all({ spaceId: input.spaceId }) as InvitationRow[];
    return rows.map(rowToInvitationMetadata);
  }

  /** Claims a canonical scoped invitation only while its original issuer authority is current. */
  async claimInvitation(input: ClaimInvitationInput): Promise<ClaimInvitationResult> {
    if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token) ||
        typeof input.email !== 'string' || !input.email.trim()) throw new Error('Invalid invitation');
    const digest = createHash('sha256').update(input.token).digest('hex');
    const email = input.email.trim().toLowerCase();
    const result = this.db.transaction(() => {
      const now = nowISO();
      const row = this.stmt.selectInvitationByDigest.get(digest) as InvitationRow | undefined;
      if (!row || (row.status !== 'active' && row.status !== 'claimed')) throw new Error('Invalid invitation');
      if (Date.parse(row.expires_at) <= Date.parse(now)) {
        this.stmt.updateInvitationExpired.run({ id: row.id, now });
        if (row.space_id && row.issuer_membership_id && row.governance_policy_version)
          this.invitationAudit({
            id: row.id, spaceId: row.space_id, actorId: 'system', action: 'expired', now,
            policyVersion: row.governance_policy_version, issuerMembershipId: row.issuer_membership_id,
          });
        return null;
      }
      this.invitationIssuer(row, now);
      if (row.status === 'claimed') {
        if (row.claimed_email !== email || !row.claim_id) throw new Error('Invalid invitation');
        return { claimId: row.claim_id, email, spaceId: row.space_id! };
      }
      const claimId = randomUUID();
      if (this.stmt.updateInvitationClaim.run({ id: row.id, email, claimId, claimedAt: now }).changes !== 1)
        throw new Error('Invalid invitation');
      this.invitationAudit({
        ...input, id: row.id, spaceId: row.space_id!, actorId: 'system', action: 'claimed', now,
        policyVersion: row.governance_policy_version!, issuerMembershipId: row.issuer_membership_id!,
      });
      return { claimId, email, spaceId: row.space_id! };
    }).immediate();
    // Commit terminal expiry and its audit before rejecting the unauthenticated claim.
    if (!result) throw new Error('Invalid invitation');
    return result;
  }

  /** Completes verified human redemption and membership together, granting no financial rights. */
  async completeInvitationRedemption(
    claimId: string,
    userId: string,
    options: { readonly auth: HumanControlContext; readonly email: string; readonly now?: string; readonly requestId?: string },
  ): Promise<void> {
    this.db.transaction(() => {
      const now = options.now ?? nowISO();
      if (options.auth.actorId !== userId) throw new Error('Invitation target identity mismatch');
      const row = this.db.prepare('SELECT * FROM invitations WHERE claim_id=?').get(claimId) as InvitationRow | undefined;
      if (!row || row.status !== 'claimed' || row.claimed_email !== options.email.trim().toLowerCase())
        throw new Error('Invalid invitation');
      this.invitationIssuer(row, now);
      const identity = this.stmt.selectActorMembership.get(userId) as ActorMembershipRow | undefined;
      if (identity && identity.status !== 'active') throw new Error('Invitation identity is inactive');
      if (!identity) this.stmt.upsertActorMembershipStmt.run({
        actorId: userId, status: 'active', capabilities: '[]', scope: '',
      });
      this.governance.acceptInvitedMembership({ claimId, email: options.email, auth: options.auth, now });
      if (this.stmt.updateInvitationRedeemed.run({ claimId, userId, redeemedAt: now }).changes !== 1)
        throw new Error('Invitation redemption failed');
      this.invitationAudit({
        ...options, id: row.id, spaceId: row.space_id!, actorId: userId, action: 'redeemed', now,
        policyVersion: row.governance_policy_version!, issuerMembershipId: row.issuer_membership_id!,
      });
    }).immediate();
  }

  // ── Notification event lifecycle ──────────────────────────────────

  private notificationProvenance(input: CreateNotificationEventInput, now: string) {
    const space = this.governance.getSpaceForBudget({ budgetId: input.budgetId });
    const membership = space && input.recipientId
      ? this.governance.getCurrentMembership({ spaceId: space.id, actorId: input.recipientId, now })
      : null;
    return { spaceId: space?.id ?? null, recipientMembershipId: membership?.id ?? null };
  }

  async createNotificationEvent(input: CreateNotificationEventInput): Promise<NotificationEvent> {
    const id = randomUUID();
    const now = input.now ?? nowISO();
    const payloadJson = JSON.stringify(input.payload);

    this.stmt.insertNotificationEvent.run({
      id,
      ...this.notificationProvenance(input, now),
      eventVersion: 1,
      budgetId: input.budgetId,
      classification: input.classification,
      recipientId: input.recipientId ?? null,
      scope: input.scope ?? null,
      redactionClass: input.redactionClass ?? null,
      channelConfigVersion: input.channelConfigVersion ?? null,
      policyVersion: input.policyVersion,
      correlationId: input.correlationId ?? null,
      payload: payloadJson,
      createdAt: now,
      dedupKey: null,
    });

    const row = this.stmt.selectNotificationEvent.get(id) as NotificationEventRow | undefined;
    if (!row) throw new Error('Failed to read back notification event');
    return rowToNotificationEvent(row);
  }

  async createOrGetNotificationEvent(
    input: CreateOrGetNotificationEventInput,
  ): Promise<NotificationEvent> {
    const recipientId = input.recipientId ?? null;
    const scope = input.scope ?? null;
    const now = input.now ?? nowISO();
    const provenance = this.notificationProvenance(input, now);
    const identity = { dedupKey: input.dedupKey, recipientId, scope, budgetId: input.budgetId, ...provenance };
    const id = randomUUID();

    this.stmt.insertOrIgnoreNotificationEvent.run({
      id,
      ...provenance,
      eventVersion: 1,
      budgetId: input.budgetId,
      classification: input.classification,
      recipientId,
      scope,
      redactionClass: input.redactionClass ?? null,
      channelConfigVersion: input.channelConfigVersion ?? null,
      policyVersion: input.policyVersion,
      correlationId: input.correlationId ?? null,
      payload: JSON.stringify(input.payload),
      createdAt: now,
      dedupKey: input.dedupKey,
    });

    const row = this.stmt.selectNotificationEventByDedupIdentity.get(identity) as
      NotificationEventRow | undefined;
    if (!row) throw new Error('Failed to read back deduplicated notification event');
    return rowToNotificationEvent(row);
  }

  async getNotificationEvent(id: string): Promise<NotificationEvent | null> {
    const row = this.stmt.selectNotificationEvent.get(id) as NotificationEventRow | undefined;
    return row ? rowToNotificationEvent(row) : null;
  }

  // ── Notification outbox lifecycle ─────────────────────────────────

  async enqueueNotification(input: EnqueueNotificationInput): Promise<NotificationOutboxRecord> {
    // Verify the referenced event exists (persist-before-dispatch)
    const event = this.stmt.selectNotificationEvent.get(input.eventId) as
      NotificationEventRow | undefined;
    if (!event) throw new Error(`event does not exist: ${input.eventId}`);

    // Check for duplicate delivery key for this (eventId, channelType)
    const existing = this.stmt.selectOutboxByEventChannel.get({
      eventId: input.eventId,
      channelType: input.channelType,
      deliveryKey: input.deliveryKey,
    }) as NotificationOutboxRow | undefined;
    if (existing) {
      if (event.dedup_key !== null) {
        return rowToOutbox(existing);
      }
      throw new Error(
        `deliveryKey already exists for this eventId+channelType: ${input.deliveryKey}`,
      );
    }

    const id = randomUUID();
    const now = nowISO();
    const maxAttempts = input.maxAttempts ?? 3;

    try {
      this.stmt.insertOutbox.run({
        id,
        eventId: input.eventId,
        deliveryKey: input.deliveryKey,
        channelType: input.channelType,
        channelConfigVersion: input.channelConfigVersion ?? null,
        maxAttempts,
        correlationId: input.correlationId ?? null,
        now,
      });
    } catch (error) {
      if (event.dedup_key !== null) {
        const concurrentlyCreated = this.stmt.selectOutboxByEventChannel.get({
          eventId: input.eventId,
          channelType: input.channelType,
          deliveryKey: input.deliveryKey,
        }) as NotificationOutboxRow | undefined;
        if (concurrentlyCreated) {
          return rowToOutbox(concurrentlyCreated);
        }
      }
      throw error;
    }

    const row = this.stmt.selectOutbox.get(id) as NotificationOutboxRow | undefined;
    if (!row) throw new Error('Failed to read back outbox record');
    return rowToOutbox(row);
  }

  async claimNotificationDelivery(
    outboxId: string,
    claimToken: string,
    claimTimeoutMs: number = 60_000,
  ): Promise<NotificationOutboxRecord | null> {
    const now = nowISO();
    const expiresAt = new Date(Date.now() + claimTimeoutMs).toISOString();

    // 1. Try to claim a pending record
    const pendingResult = this.stmt.claimOutboxPending.run({
      outboxId,
      claimToken,
      now,
      expiresAt,
    });

    if (pendingResult.changes > 0) {
      const row = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow | undefined;
      return row ? rowToOutbox(row) : null;
    }

    // 2. Try to claim an expired delivering record (crash recovery)
    const expiredResult = this.stmt.claimOutboxExpired.run({
      outboxId,
      claimToken,
      now,
      expiresAt,
    });

    if (expiredResult.changes > 0) {
      const row = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow | undefined;
      return row ? rowToOutbox(row) : null;
    }

    // 3. Try to claim a retryable failed record (retry scheduling)
    const retryableResult = this.stmt.claimOutboxRetryable.run({
      outboxId,
      claimToken,
      now,
      expiresAt,
    });

    if (retryableResult.changes > 0) {
      const row = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow | undefined;
      return row ? rowToOutbox(row) : null;
    }

    // 4. Idempotent retry: if already claimed with this token, return it
    const claimedRow = this.stmt.selectClaimedOutbox.get({ outboxId, claimToken }) as
      NotificationOutboxRow | undefined;
    if (claimedRow) {
      return rowToOutbox(claimedRow);
    }

    return null;
  }

  async completeNotificationDelivery(
    outboxId: string,
    claimToken: string,
    response?: { code?: string; body?: string },
  ): Promise<NotificationOutboxRecord> {
    const now = nowISO();

    const result = this.stmt.completeOutbox.run({ outboxId, claimToken, now });
    if (result.changes === 0) {
      throw new Error(
        `Cannot complete delivery: claim token mismatch or invalid state for outbox ${outboxId}`,
      );
    }

    // Read the outbox to get the current attempt count
    const current = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow;

    // Record successful delivery attempt
    const attemptId = randomUUID();
    this.stmt.insertDeliveryAttempt.run({
      id: attemptId,
      outboxId,
      attemptNumber: current.attempt_count,
      status: 'success',
      responseCode: response?.code ?? null,
      responseBody: response?.body ?? null,
      errorMessage: null,
      attemptedAt: now,
    });

    return rowToOutbox(current);
  }

  async failNotificationDelivery(
    outboxId: string,
    claimToken: string,
    errorMessage: string,
    retryable: boolean = false,
  ): Promise<NotificationOutboxRecord> {
    const now = nowISO();

    // Atomically fail the outbox record
    const result = this.stmt.failOutbox.run({ outboxId, claimToken, errorMessage, now });
    if (result.changes === 0) {
      throw new Error(
        `Cannot fail delivery: claim token mismatch or invalid state for outbox ${outboxId}`,
      );
    }

    // Read current attempt count
    const current = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow;

    // Record failed delivery attempt
    const attemptId = randomUUID();
    this.stmt.insertDeliveryAttempt.run({
      id: attemptId,
      outboxId,
      attemptNumber: current.attempt_count,
      status: 'failed',
      responseCode: null,
      responseBody: null,
      errorMessage,
      attemptedAt: now,
    });

    // Schedule retry if retryable and attempts remain
    if (retryable && current.attempt_count < current.max_attempts) {
      this.stmt.scheduleRetryOutbox.run({ outboxId, nextAttemptAt: now, now });
    }

    const row = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow;
    return rowToOutbox(row);
  }

  async acknowledgeNotification(outboxId: string): Promise<NotificationOutboxRecord> {
    const now = nowISO();

    const result = this.stmt.acknowledgeOutbox.run({ outboxId, now });
    if (result.changes === 0) {
      throw new Error(`Cannot acknowledge: outbox ${outboxId} is not in delivered status`);
    }

    const row = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow;
    return rowToOutbox(row);
  }

  async suppressNotification(outboxId: string, reason: string): Promise<NotificationOutboxRecord> {
    const now = nowISO();

    const result = this.stmt.suppressOutbox.run({ outboxId, reason, now });
    if (result.changes === 0) {
      throw new Error(`Cannot suppress: outbox ${outboxId} is not in a suppressible state`);
    }

    const row = this.stmt.selectOutbox.get(outboxId) as NotificationOutboxRow;
    return rowToOutbox(row);
  }

  async getOutboxRecord(id: string): Promise<NotificationOutboxRecord | null> {
    const row = this.stmt.selectOutbox.get(id) as NotificationOutboxRow | undefined;
    return row ? rowToOutbox(row) : null;
  }

  async getPendingNotifications(
    limit: number = 50,
    channelType?: string,
  ): Promise<NotificationOutboxRecord[]> {
    let rows: NotificationOutboxRow[];
    if (channelType) {
      rows = this.stmt.selectPendingOutboxByChannel.all({
        limit,
        channelType,
      }) as NotificationOutboxRow[];
    } else {
      rows = this.stmt.selectPendingOutbox.all({ limit }) as NotificationOutboxRow[];
    }
    return rows.map(rowToOutbox);
  }

  async getRetryableNotifications(
    limit: number = 50,
    channelType?: string,
  ): Promise<NotificationOutboxRecord[]> {
    const now = nowISO();
    let rows: NotificationOutboxRow[];
    if (channelType) {
      rows = this.stmt.selectRetryableOutboxByChannel.all({
        limit,
        channelType,
        now,
      }) as NotificationOutboxRow[];
    } else {
      rows = this.stmt.selectRetryableOutbox.all({ limit, now }) as NotificationOutboxRow[];
    }
    return rows.map(rowToOutbox);
  }

  async getDeliveryAttempts(outboxId: string): Promise<DeliveryAttempt[]> {
    const rows = this.stmt.selectDeliveryAttempts.all({ outboxId }) as DeliveryAttemptRow[];
    return rows.map(rowToDeliveryAttempt);
  }

  async listOutboxRecords(options?: ListOutboxRecordsOptions): Promise<NotificationOutboxRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const status = options?.status;
    const channelType = options?.channelType;

    let rows: NotificationOutboxRow[];
    if (status && channelType) {
      rows = this.stmt.selectListOutboxByStatusChannel.all({
        limit,
        offset,
        status,
        channelType,
      }) as NotificationOutboxRow[];
    } else if (status) {
      rows = this.stmt.selectListOutboxByStatus.all({
        limit,
        offset,
        status,
      }) as NotificationOutboxRow[];
    } else if (channelType) {
      rows = this.stmt.selectListOutboxByChannel.all({
        limit,
        offset,
        channelType,
      }) as NotificationOutboxRow[];
    } else {
      rows = this.stmt.selectListOutbox.all({ limit, offset }) as NotificationOutboxRow[];
    }
    return rows.map(rowToOutbox);
  }

  // ── Policy version lifecycle ──────────────────────────────────────

  async recordPolicyVersion(input: RecordPolicyVersionInput): Promise<PolicyVersion> {
    const id = randomUUID();
    const now = nowISO();

    // Determine next version number for this policy key
    const maxRow = this.db
      .prepare('SELECT MAX(version) AS mv FROM policy_versions WHERE policy_key = ?')
      .get(input.policyKey) as { mv: number | null } | undefined;
    const nextVersion = (maxRow?.mv ?? 0) + 1;

    const txn = this.db.transaction(() => {
      // Supersede any previously active version
      this.stmt.supersedePolicyVersions.run({ policyKey: input.policyKey, now });

      // Insert the new version as active
      this.stmt.insertPolicyVersion.run({
        id,
        policyKey: input.policyKey,
        version: nextVersion,
        policyHash: input.policyHash,
        description: input.description,
        createdAt: now,
      });
    });

    txn();

    const row = this.stmt.selectPolicyVersion.get(id) as PolicyVersionRow | undefined;
    if (!row) throw new Error('Failed to read back policy version');
    return rowToPolicyVersion(row);
  }

  async getPolicyVersion(id: string): Promise<PolicyVersion | null> {
    const row = this.stmt.selectPolicyVersion.get(id) as PolicyVersionRow | undefined;
    return row ? rowToPolicyVersion(row) : null;
  }

  async getActivePolicyVersion(policyKey: string): Promise<PolicyVersion | null> {
    const row = this.stmt.selectActivePolicyVersion.get({ policyKey }) as
      PolicyVersionRow | undefined;
    return row ? rowToPolicyVersion(row) : null;
  }

  async listPolicyVersions(
    policyKey: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<PolicyVersion[]> {
    const rows = this.stmt.listPolicyVersions.all({
      policyKey,
      limit,
      offset,
    }) as PolicyVersionRow[];
    return rows.map(rowToPolicyVersion);
  }

  // ── Saved filter / view lifecycle ─────────────────────────────────

  async createSavedFilter(input: CreateSavedFilterInput): Promise<SavedFilter> {
    const id = randomUUID();
    const now = nowISO();
    const filterConfigJson = JSON.stringify(input.filterConfig);
    const viewConfigJson = input.viewConfig ? JSON.stringify(input.viewConfig) : null;
    const isDefault = input.isDefault ? 1 : 0;

    const txn = this.db.transaction(() => {
      // Demote existing default if this one becomes default
      if (input.isDefault) {
        this.stmt.demoteDefaultFilter.run({
          budgetId: input.budgetId ?? null,
          scope: input.scope,
          now,
        });
      }

      this.stmt.insertSavedFilter.run({
        id,
        name: input.name,
        budgetId: input.budgetId ?? null,
        filterConfig: filterConfigJson,
        viewConfig: viewConfigJson,
        scope: input.scope,
        policyVersion: input.policyVersion,
        isDefault,
        actorId: input.actorId,
        now,
      });
    });

    txn();

    const row = this.stmt.selectSavedFilter.get(id) as SavedFilterRow | undefined;
    if (!row) throw new Error('Failed to read back saved filter');
    return rowToSavedFilter(row);
  }

  async updateSavedFilter(id: string, input: UpdateSavedFilterInput): Promise<SavedFilter> {
    const existing = this.stmt.selectSavedFilter.get(id) as SavedFilterRow | undefined;
    if (!existing) throw new Error(`Saved filter ${id} not found`);

    const now = nowISO();

    const txn = this.db.transaction(() => {
      // Demote existing default if this one becomes default
      if (input.isDefault) {
        this.stmt.demoteDefaultFilter.run({
          budgetId: existing.budget_id,
          scope: input.scope ?? existing.scope,
          now,
        });
      }

      this.stmt.updateSavedFilter.run({
        id,
        name: input.name ?? null,
        filterConfig: input.filterConfig ? JSON.stringify(input.filterConfig) : null,
        viewConfig:
          input.viewConfig !== undefined
            ? input.viewConfig
              ? JSON.stringify(input.viewConfig)
              : null
            : null,
        scope: input.scope ?? null,
        policyVersion: input.policyVersion ?? null,
        isDefault: input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : null,
        now,
      });
    });

    txn();

    const row = this.stmt.selectSavedFilter.get(id) as SavedFilterRow;
    return rowToSavedFilter(row);
  }

  async getSavedFilter(id: string): Promise<SavedFilter | null> {
    const row = this.stmt.selectSavedFilter.get(id) as SavedFilterRow | undefined;
    return row ? rowToSavedFilter(row) : null;
  }

  async listSavedFilters(options?: SavedFilterListOptions): Promise<SavedFilter[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: SavedFilterRow[];
    if (options?.budgetId) {
      rows = this.stmt.listSavedFiltersByBudget.all({
        budgetId: options.budgetId,
        limit,
        offset,
      }) as SavedFilterRow[];
    } else if (options?.scope) {
      rows = this.stmt.listSavedFiltersByScope.all({
        scope: options.scope,
        limit,
        offset,
      }) as SavedFilterRow[];
    } else if (options?.actorId) {
      rows = this.stmt.listSavedFiltersByActor.all({
        actorId: options.actorId,
        limit,
        offset,
      }) as SavedFilterRow[];
    } else {
      rows = this.stmt.listSavedFilters.all({ limit, offset }) as SavedFilterRow[];
    }
    return rows.map(rowToSavedFilter);
  }

  async deleteSavedFilter(id: string): Promise<void> {
    this.stmt.deleteSavedFilter.run(id);
  }

  // ── Report record lifecycle ───────────────────────────────────────

  async createReportRecord(input: CreateReportRecordInput): Promise<ReportRecord> {
    const id = randomUUID();
    const now = nowISO();
    const configJson = JSON.stringify(input.config);

    this.stmt.insertReportRecord.run({
      id,
      reportType: input.reportType,
      budgetId: input.budgetId ?? null,
      filterId: input.filterId ?? null,
      config: configJson,
      policyVersion: input.policyVersion,
      generatedAt: now,
      expiresAt: input.expiresAt ?? null,
      dataRef: input.dataRef ?? null,
    });

    const row = this.stmt.selectReportRecord.get(id) as ReportRecordRow | undefined;
    if (!row) throw new Error('Failed to read back report record');
    return rowToReportRecord(row);
  }

  async getReportRecord(id: string): Promise<ReportRecord | null> {
    const row = this.stmt.selectReportRecord.get(id) as ReportRecordRow | undefined;
    return row ? rowToReportRecord(row) : null;
  }

  async listReportRecords(options?: ReportListOptions): Promise<ReportRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: ReportRecordRow[];
    if (options?.budgetId) {
      rows = this.stmt.listReportRecordsByBudget.all({
        budgetId: options.budgetId,
        limit,
        offset,
      }) as ReportRecordRow[];
    } else if (options?.reportType) {
      rows = this.stmt.listReportRecordsByType.all({
        reportType: options.reportType,
        limit,
        offset,
      }) as ReportRecordRow[];
    } else {
      rows = this.stmt.listReportRecords.all({ limit, offset }) as ReportRecordRow[];
    }
    return rows.map(rowToReportRecord);
  }

  async expireReportRecord(id: string): Promise<ReportRecord> {
    const existing = this.stmt.selectReportRecord.get(id) as ReportRecordRow | undefined;
    if (!existing) throw new Error(`Report record ${id} not found`);

    const now = nowISO();
    this.stmt.expireReportRecord.run({ id, now });

    const row = this.stmt.selectReportRecord.get(id) as ReportRecordRow;
    return rowToReportRecord(row);
  }

  async listSavedViews(authority: SavedViewAuthority): Promise<SavedViewResult[]> {
    const rows = this.stmt.listSavedViewsByAuthority.all({
      ...authority,
      now: nowISO(),
      limit: 100,
      offset: 0,
    }) as SavedViewRow[];
    return rows.map(rowToSavedViewResult);
  }

  async createSavedView(input: CreateSavedViewInput): Promise<SavedViewResult> {
    const { authority } = input;
    const now = nowISO();
    const create = this.db.transaction(() => {
      if (!this.stmt.validateSavedViewAuthority.get({ ...authority, now }))
        throw new Error('Saved view authority is not current');

      const viewId = randomUUID();
      this.stmt.insertSavedView.run({
        viewId,
        name: input.name,
        viewType: input.viewType,
        scope: JSON.stringify(input.scope),
        sort: input.sort ?? null,
        actorId: authority.actorId,
        spaceId: authority.spaceId,
        budgetId: authority.budgetId,
        membershipId: authority.membershipId,
        createdAt: now,
      });

      const row = this.stmt.selectSavedView.get({ ...authority, viewId, now }) as
        | SavedViewRow
        | undefined;
      if (!row) throw new Error('Failed to read back saved view');
      return rowToSavedViewResult(row);
    });
    return create.immediate();
  }

  async getSavedView(
    viewId: string,
    authority: SavedViewAuthority,
  ): Promise<SavedViewResult | null> {
    const row = this.stmt.selectSavedView.get({
      ...authority,
      viewId,
      now: nowISO(),
    }) as SavedViewRow | undefined;
    return row ? rowToSavedViewResult(row) : null;
  }

  async updateSavedView(viewId: string, input: UpdateSavedViewInput): Promise<SavedViewResult> {
    const { authority } = input;
    const now = nowISO();
    const update = this.db.transaction(() => {
      const query = { ...authority, viewId, now };
      const existing = this.stmt.selectSavedView.get(query) as SavedViewRow | undefined;
      if (!existing) throw new Error(`Saved view ${viewId} not found`);

      this.stmt.updateSavedView.run({
        ...query,
        name: input.name ?? null,
        scope: input.scope !== undefined ? JSON.stringify(input.scope) : null,
        sort: input.sort !== undefined ? input.sort : existing.sort,
      });

      const row = this.stmt.selectSavedView.get(query) as SavedViewRow | undefined;
      if (!row) throw new Error(`Saved view ${viewId} not found`);
      return rowToSavedViewResult(row);
    });
    return update.immediate();
  }

  async duplicateSavedView(input: DuplicateSavedViewInput): Promise<SavedViewResult> {
    const { authority } = input;
    const now = nowISO();
    const duplicate = this.db.transaction(() => {
      const source = this.stmt.selectSavedView.get({
        ...authority,
        viewId: input.sourceViewId,
        now,
      }) as SavedViewRow | undefined;
      if (!source) throw new Error(`Source saved view ${input.sourceViewId} not found`);

      const viewId = randomUUID();
      this.stmt.insertSavedView.run({
        viewId,
        name: input.name,
        viewType: source.view_type,
        scope: source.scope,
        sort: source.sort,
        actorId: authority.actorId,
        spaceId: authority.spaceId,
        budgetId: authority.budgetId,
        membershipId: authority.membershipId,
        createdAt: now,
      });

      const row = this.stmt.selectSavedView.get({ ...authority, viewId, now }) as
        | SavedViewRow
        | undefined;
      if (!row) throw new Error('Failed to read back duplicated saved view');
      return rowToSavedViewResult(row);
    });
    return duplicate.immediate();
  }

  async deleteSavedView(viewId: string, authority: SavedViewAuthority): Promise<boolean> {
    const now = nowISO();
    const remove = this.db.transaction(() =>
      this.stmt.deleteSavedView.run({ ...authority, viewId, now }).changes > 0,
    );
    return remove.immediate();
  }

  async recordSavedViewUsage(
    viewId: string,
    authority: SavedViewAuthority,
  ): Promise<SavedViewResult> {
    const now = nowISO();
    const recordUsage = this.db.transaction(() => {
      const query = { ...authority, viewId, now };
      if (!this.stmt.selectSavedView.get(query))
        throw new Error(`Saved view ${viewId} not found`);
      this.stmt.recordSavedViewUsage.run(query);
      const row = this.stmt.selectSavedView.get(query) as SavedViewRow | undefined;
      if (!row) throw new Error(`Saved view ${viewId} not found`);
      return rowToSavedViewResult(row);
    });
    return recordUsage.immediate();
  }

  // ── Finding lifecycle ────────────────────────────────────────────

  async createFinding(input: CreateFindingInput): Promise<Finding> {
    const id = randomUUID();
    const now = nowISO();
    const evidenceJson = JSON.stringify(input.evidence);
    const evidenceRefsJson = JSON.stringify(input.evidenceRefs ?? []);

    this.stmt.insertFinding.run({
      id,
      budgetId: input.budgetId,
      classification: input.classification,
      description: input.description,
      evidence: evidenceJson,
      evidenceRefs: evidenceRefsJson,
      severity: input.severity ?? 'medium',
      status: 'open',
      actorId: input.actorId ?? null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      correctedAt: null,
      correctedBy: null,
      correctionRef: null,
      dismissedAt: null,
      dismissedBy: null,
      dismissedReason: null,
      reopenedAt: null,
      reopenedBy: null,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
      expiresAt: input.expiresAt ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const row = this.stmt.selectFinding.get(id) as FindingRow | undefined;
    if (!row) throw new Error('Failed to read back finding');
    return rowToFinding(row);
  }

  async getFinding(id: string): Promise<Finding | null> {
    const row = this.stmt.selectFinding.get(id) as FindingRow | undefined;
    return row ? rowToFinding(row) : null;
  }

  async listFindings(options?: ListFindingsOptions): Promise<Finding[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: FindingRow[];
    if (options?.status && options?.budgetId) {
      rows = this.stmt.listFindingsByBudgetStatus.all({
        budgetId: options.budgetId,
        status: options.status,
        limit,
        offset,
      }) as FindingRow[];
    } else if (options?.status) {
      rows = this.stmt.listFindingsByStatus.all({
        status: options.status,
        limit,
        offset,
      }) as FindingRow[];
    } else if (options?.budgetId) {
      rows = this.stmt.listFindingsByBudget.all({
        budgetId: options.budgetId,
        limit,
        offset,
      }) as FindingRow[];
    } else if (options?.classification) {
      rows = this.stmt.listFindingsByClassification.all({
        classification: options.classification,
        limit,
        offset,
      }) as FindingRow[];
    } else if (options?.severity) {
      rows = this.stmt.listFindingsBySeverity.all({
        severity: options.severity,
        limit,
        offset,
      }) as FindingRow[];
    } else {
      rows = this.stmt.listFindings.all({ limit, offset }) as FindingRow[];
    }
    return rows.map(rowToFinding);
  }

  async countFindings(options?: ListFindingsOptions): Promise<number> {
    if (options?.status || options?.budgetId || options?.classification || options?.severity) {
      const row = this.stmt.countFindingsFiltered.get({
        status: options.status ?? '',
        budgetId: options.budgetId ?? '',
        classification: options.classification ?? '',
        severity: options.severity ?? '',
      }) as { count: number };
      return row.count;
    }
    const row = this.stmt.countFindings.get({}) as { count: number };
    return row.count;
  }

  async acknowledgeFinding(input: AcknowledgeFindingInput): Promise<Finding> {
    const existing = this.stmt.selectFinding.get(input.findingId) as FindingRow | undefined;
    if (!existing) throw new Error(`Finding ${input.findingId} not found`);
    if (existing.status === 'acknowledged') {
      return rowToFinding(existing);
    }

    const allowedTargets = FINDING_TRANSITIONS[existing.status];
    if (!allowedTargets || !allowedTargets.includes('acknowledged')) {
      throw new Error(`Cannot acknowledge finding in status ${existing.status}`);
    }

    const now = nowISO();
    const result = this.stmt.transitionFinding.run({
      id: input.findingId,
      fromStatus: existing.status,
      toStatus: 'acknowledged',
      expectedVersion: input.expectedVersion,
      now,
      acknowledgedAt: now,
      acknowledgedBy: input.actorId,
      correctedAt: null,
      correctedBy: null,
      correctionRef: null,
      dismissedAt: null,
      dismissedBy: null,
      dismissedReason: null,
      reopenedAt: null,
      reopenedBy: null,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    });

    if (result.changes === 0) {
      throw new Error(
        `Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to acknowledged`,
      );
    }

    const row = this.stmt.selectFinding.get(input.findingId) as FindingRow;
    return rowToFinding(row);
  }

  async correctFinding(input: CorrectFindingInput): Promise<Finding> {
    const existing = this.stmt.selectFinding.get(input.findingId) as FindingRow | undefined;
    if (!existing) throw new Error(`Finding ${input.findingId} not found`);
    if (existing.status === 'corrected') {
      return rowToFinding(existing);
    }

    const allowedTargets = FINDING_TRANSITIONS[existing.status];
    if (!allowedTargets || !allowedTargets.includes('corrected')) {
      throw new Error(`Cannot correct finding in status ${existing.status}`);
    }

    const now = nowISO();
    const result = this.stmt.transitionFinding.run({
      id: input.findingId,
      fromStatus: existing.status,
      toStatus: 'corrected',
      expectedVersion: input.expectedVersion,
      now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      correctedAt: now,
      correctedBy: input.actorId,
      correctionRef: input.correctionRef,
      dismissedAt: null,
      dismissedBy: null,
      dismissedReason: null,
      reopenedAt: null,
      reopenedBy: null,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    });

    if (result.changes === 0) {
      throw new Error(
        `Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to corrected`,
      );
    }

    const row = this.stmt.selectFinding.get(input.findingId) as FindingRow;
    return rowToFinding(row);
  }

  async dismissFinding(input: DismissFindingInput): Promise<Finding> {
    const existing = this.stmt.selectFinding.get(input.findingId) as FindingRow | undefined;
    if (!existing) throw new Error(`Finding ${input.findingId} not found`);
    if (existing.status === 'dismissed') {
      return rowToFinding(existing);
    }

    const allowedTargets = FINDING_TRANSITIONS[existing.status];
    if (!allowedTargets || !allowedTargets.includes('dismissed')) {
      throw new Error(`Cannot dismiss finding in status ${existing.status}`);
    }

    const now = nowISO();
    const result = this.stmt.transitionFinding.run({
      id: input.findingId,
      fromStatus: existing.status,
      toStatus: 'dismissed',
      expectedVersion: input.expectedVersion,
      now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      correctedAt: null,
      correctedBy: null,
      correctionRef: null,
      dismissedAt: now,
      dismissedBy: input.actorId,
      dismissedReason: input.reason,
      reopenedAt: null,
      reopenedBy: null,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    });

    if (result.changes === 0) {
      throw new Error(
        `Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to dismissed`,
      );
    }

    const row = this.stmt.selectFinding.get(input.findingId) as FindingRow;
    return rowToFinding(row);
  }

  async reopenFinding(input: ReopenFindingInput): Promise<Finding> {
    const existing = this.stmt.selectFinding.get(input.findingId) as FindingRow | undefined;
    if (!existing) throw new Error(`Finding ${input.findingId} not found`);
    if (existing.status === 'reopened') {
      return rowToFinding(existing);
    }

    const allowedTargets = FINDING_TRANSITIONS[existing.status];
    if (!allowedTargets || !allowedTargets.includes('reopened')) {
      throw new Error(`Cannot reopen finding in status ${existing.status}`);
    }

    const now = nowISO();
    const result = this.stmt.transitionFinding.run({
      id: input.findingId,
      fromStatus: existing.status,
      toStatus: 'reopened',
      expectedVersion: input.expectedVersion,
      now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      correctedAt: null,
      correctedBy: null,
      correctionRef: null,
      dismissedAt: null,
      dismissedBy: null,
      dismissedReason: null,
      reopenedAt: now,
      reopenedBy: input.actorId,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    });

    if (result.changes === 0) {
      throw new Error(
        `Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to reopened`,
      );
    }

    const row = this.stmt.selectFinding.get(input.findingId) as FindingRow;
    return rowToFinding(row);
  }

  async supersedeFinding(input: SupersedeFindingInput): Promise<Finding> {
    const existing = this.stmt.selectFinding.get(input.findingId) as FindingRow | undefined;
    if (!existing) throw new Error(`Finding ${input.findingId} not found`);
    if (existing.status === 'superseded') {
      return rowToFinding(existing);
    }

    const allowedTargets = FINDING_TRANSITIONS[existing.status];
    if (!allowedTargets || !allowedTargets.includes('superseded')) {
      throw new Error(`Cannot supersede finding in status ${existing.status}`);
    }

    const now = nowISO();
    const result = this.stmt.transitionFinding.run({
      id: input.findingId,
      fromStatus: existing.status,
      toStatus: 'superseded',
      expectedVersion: input.expectedVersion,
      now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      correctedAt: null,
      correctedBy: null,
      correctionRef: null,
      dismissedAt: null,
      dismissedBy: null,
      dismissedReason: null,
      reopenedAt: null,
      reopenedBy: null,
      supersededAt: now,
      supersededBy: input.supersededBy,
      supersededReason: input.reason,
    });

    if (result.changes === 0) {
      throw new Error(
        `Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to superseded`,
      );
    }

    const row = this.stmt.selectFinding.get(input.findingId) as FindingRow;
    return rowToFinding(row);
  }

  async expireFinding(id: string): Promise<Finding> {
    const existing = this.stmt.selectFinding.get(id) as FindingRow | undefined;
    if (!existing) throw new Error(`Finding ${id} not found`);
    if (existing.status === 'expired') {
      return rowToFinding(existing);
    }

    const now = nowISO();
    const result = this.stmt.expireFindingStmt.run({ id, now });

    if (result.changes === 0) {
      throw new Error(`Finding ${id} cannot be expired from status ${existing.status}`);
    }

    const row = this.stmt.selectFinding.get(id) as FindingRow;
    return rowToFinding(row);
  }

  // ── Notification policy lifecycle ────────────────────────────────

  async saveNotificationPolicy(
    input: SaveNotificationPolicyInput,
  ): Promise<NotificationPolicyRecord> {
    const existing = this.stmt.selectNotificationPolicy.get({
      spaceId: input.spaceId,
      policyKey: input.policyKey,
    }) as NotificationPolicyRow | undefined;

    const now = nowISO();
    const policyJson = JSON.stringify(input.policy);

    if (existing) {
      this.stmt.updateNotificationPolicy.run({
        spaceId: input.spaceId,
        policyKey: input.policyKey,
        policyVersion: input.policyVersion,
        policy: policyJson,
        isActive: existing.is_active,
        now,
      });
    } else {
      const id = randomUUID();
      this.stmt.insertNotificationPolicy.run({
        id,
        spaceId: input.spaceId,
        policyKey: input.policyKey,
        policyVersion: input.policyVersion,
        policy: policyJson,
        now,
      });
    }

    const row = this.stmt.selectNotificationPolicy.get({
      spaceId: input.spaceId,
      policyKey: input.policyKey,
    }) as NotificationPolicyRow;
    if (!row) throw new Error('Failed to read back notification policy');
    return rowToNotificationPolicy(row);
  }

  async getNotificationPolicy(
    spaceId: string,
    policyKey: string,
  ): Promise<NotificationPolicyRecord | null> {
    const row = this.stmt.selectNotificationPolicy.get({ spaceId, policyKey }) as
      NotificationPolicyRow | undefined;
    return row ? rowToNotificationPolicy(row) : null;
  }

  async listNotificationPolicies(
    options?: ListNotificationPoliciesOptions,
  ): Promise<NotificationPolicyRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: NotificationPolicyRow[];
    if (options?.spaceId) {
      rows = this.stmt.listNotificationPoliciesBySpace.all({
        spaceId: options.spaceId,
        limit,
        offset,
      }) as NotificationPolicyRow[];
    } else {
      rows = this.stmt.listNotificationPolicies.all({ limit, offset }) as NotificationPolicyRow[];
    }
    return rows.map(rowToNotificationPolicy);
  }

  async resolveRecipients(
    spaceId: string,
    classification: string,
    severity: string,
  ): Promise<RecipientResolution> {
    // Look up active delivery/notification policies for the space to extract recipient configuration
    const rows = this.stmt.listNotificationPoliciesBySpace.all({
      spaceId,
      limit: 100,
      offset: 0,
    }) as NotificationPolicyRow[];

    // Collect actor IDs and channels from active policy configurations
    const actorIds = new Set<string>();
    const channels = new Set<string>();

    for (const row of rows) {
      if (!row.is_active) continue;

      try {
        const parsed = JSON.parse(row.policy) as Record<string, unknown>;

        // Extract actor IDs if present in the policy
        if (Array.isArray(parsed.actorIds)) {
          for (const id of parsed.actorIds) {
            if (typeof id === 'string') actorIds.add(id);
          }
        }

        // Extract channels if present
        if (Array.isArray(parsed.channels)) {
          for (const ch of parsed.channels) {
            if (typeof ch === 'string') channels.add(ch);
          }
        }

        // Extract classification/severity-specific recipients
        if (
          parsed.classifications &&
          typeof parsed.classifications === 'object' &&
          !Array.isArray(parsed.classifications)
        ) {
          const classMap = parsed.classifications as Record<string, unknown>;
          const match = classMap[classification];
          if (match && typeof match === 'object' && !Array.isArray(match)) {
            const matchObj = match as Record<string, unknown>;
            if (Array.isArray(matchObj.actorIds)) {
              for (const id of matchObj.actorIds) {
                if (typeof id === 'string') actorIds.add(id);
              }
            }
            if (Array.isArray(matchObj.channels)) {
              for (const ch of matchObj.channels) {
                if (typeof ch === 'string') channels.add(ch);
              }
            }
          }
        }

        // Extract severity-specific recipients
        if (
          parsed.severities &&
          typeof parsed.severities === 'object' &&
          !Array.isArray(parsed.severities)
        ) {
          const sevMap = parsed.severities as Record<string, unknown>;
          const match = sevMap[severity];
          if (match && typeof match === 'object' && !Array.isArray(match)) {
            const matchObj = match as Record<string, unknown>;
            if (Array.isArray(matchObj.actorIds)) {
              for (const id of matchObj.actorIds) {
                if (typeof id === 'string') actorIds.add(id);
              }
            }
            if (Array.isArray(matchObj.channels)) {
              for (const ch of matchObj.channels) {
                if (typeof ch === 'string') channels.add(ch);
              }
            }
          }
        }
      } catch {
        // Malformed policy JSON — skip
      }
    }

    return {
      spaceId,
      actorIds: [...actorIds],
      channels: [...channels],
      resolvedAt: nowISO(),
    };
  }

  async deleteNotificationPolicy(id: string): Promise<boolean> {
    const result = this.stmt.deleteNotificationPolicy.run(id);
    return result.changes > 0;
  }

  // ── Report history (Phase 8.5) ───────────────────────────────────

  async getReportHistory(
    budgetId?: string,
    limit?: number,
    offset?: number,
  ): Promise<ReportHistoryEntry[]> {
    const lim = limit ?? 50;
    const off = offset ?? 0;

    const rows = budgetId
      ? (this.stmt.listReportHistoryByBudget.all({
          budgetId,
          limit: lim,
          offset: off,
        }) as ReportRecordRow[])
      : (this.stmt.listReportHistory.all({ limit: lim, offset: off }) as ReportRecordRow[]);

    const now = nowISO();
    return rows.map((r) => ({
      id: r.id,
      reportType: r.report_type,
      budgetId: r.budget_id,
      generatedAt: r.generated_at,
      label: this.deriveReportLabel(r),
      isExpired: r.expires_at !== null && r.expires_at <= now,
    }));
  }

  async countReportRecords(budgetId?: string): Promise<number> {
    if (budgetId) {
      const row = this.stmt.countReportRecordsByBudget.get({ budgetId }) as { count: number };
      return row.count;
    }
    const row = this.stmt.countAllReportRecords.get({}) as { count: number };
    return row.count;
  }

  /** Derive a human-readable label from a report record row. */
  private deriveReportLabel(row: ReportRecordRow): string {
    try {
      const config = JSON.parse(row.config) as Record<string, unknown>;
      if (typeof config.label === 'string' && config.label) return config.label;
    } catch {
      // fall through
    }
    return `${row.report_type} report`;
  }
}
