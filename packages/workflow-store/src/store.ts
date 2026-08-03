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
  ReviewItem,
  ReviewStatus,
  ReviewAction,
  ReviewListOptions,
  TransitionReviewInput,
  CreateReviewItemInput,
  TransitionReviewResult,
  CategorizationProposal,
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
  CreateIdempotencyInput,
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
  CreateInvitationResult,
  ClaimInvitationInput,
  ClaimInvitationResult,
  CreateNotificationEventInput,
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
} from './types.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current UTC time as ISO-8601 string. */
function nowISO(): string {
  return new Date().toISOString();
}

/** Returns true if the ISO-8601 string is invalid or represents a moment <= now. */
function isExpired(isoString: string): boolean {
  const parsed = new Date(isoString);
  return isNaN(parsed.getTime()) || parsed <= new Date();
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

/** Map a raw DB row to a typed CategorizationProposal. */
function rowToProposal(row: ProposalRow): CategorizationProposal {
  return {
    id: row.id,
    operation: row.operation as ProposalOperation,
    budgetId: row.budget_id,
    transactionId: row.transaction_id,
    categoryId: row.category_id,
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

/** Map a raw DB row to a typed SavedViewResult. */
function rowToSavedViewResult(row: SavedViewRow): SavedViewResult {
  return {
    viewId: row.view_id,
    name: row.name,
    viewType: row.view_type,
    scope: JSON.parse(row.scope) as Record<string, unknown>,
    sort: row.sort,
    actorId: row.actor_id,
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
const TERMINAL_STATUSES: ReviewStatus[] = ['applied', 'apply_failed', 'rejected', 'skipped', 'superseded'];

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
}

interface ReviewItemRow {
  id: string;
  suggestion_id: string | null;
  budget_id: string;
  transaction_id: string;
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
  transaction_id: string;
  category_id: string;
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

interface ApprovalRow {
  id: string;
  proposal_id: string;
  payload_hash: string;
  actor_id: string;
  status: string;
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
  recipient_id: string | null;
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
    selectCorrectionByReviewTransition: null as unknown as ReturnType<DatabaseType['prepare']>,
    upsertRuleOverride: null as unknown as ReturnType<DatabaseType['prepare']>,
    getAllRuleOverrides: null as unknown as ReturnType<DatabaseType['prepare']>,
    removeRuleOverride: null as unknown as ReturnType<DatabaseType['prepare']>,
    countReviewItems: null as unknown as ReturnType<DatabaseType['prepare']>,
    countReviewItemsByStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
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
    selectStrandedClaims: null as unknown as ReturnType<DatabaseType['prepare']>,
    // ── Notification events ──
    insertNotificationEvent: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectNotificationEvent: null as unknown as ReturnType<DatabaseType['prepare']>,
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
    insertSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    listSavedViewsByActor: null as unknown as ReturnType<DatabaseType['prepare']>,
    countSavedViewsByActor: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    deleteSavedView: null as unknown as ReturnType<DatabaseType['prepare']>,
    recordSavedViewUsage: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSavedViewByActorViewType: null as unknown as ReturnType<DatabaseType['prepare']>,
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
  ];

  private getCurrentSchemaVersion(): number {
    const row = this.db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined;
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
        this.db.prepare(
          'INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (@version, @appliedAt)'
        ).run({ version: v, appliedAt: new Date().toISOString() });
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
      INSERT INTO candidate_jobs (id, job_type, candidate_id, status,
                                  claim_token, claimed_at,
                                  claim_expires_at, created_at, updated_at)
      VALUES (@id, @jobType, @candidateId, 'pending',
              NULL, NULL, NULL, @now, @now)
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
                                updated_at)
      VALUES (@id, @suggestionId, @budgetId, @transactionId,
              @categoryId, @classifier, @promptVersion,
              @transactionVersion, @status, @correlationId,
              @assignedReviewerId, @approvedBy,
              @reviewersRequired, @priority, @evidence,
              @provenance, @supersededBy, @supersededReason,
              @freshnessExpiresAt, @version, @createdAt,
              @updatedAt)
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
      INSERT OR IGNORE INTO categorization_proposals (id, operation, budget_id, transaction_id,
                                            category_id, payload_hash, policy_version,
                                            preconditions, expires_at, actor_id,
                                            provenance, provider_model, correlation_id,
                                            superseded_at, created_at)
      VALUES (@id, @operation, @budgetId, @transactionId,
              @categoryId, @payloadHash, @policyVersion,
              @preconditions, @expiresAt, @actorId,
              @provenance, @providerModel, @correlationId,
              @supersededAt, @createdAt)
      RETURNING *
    `);

    this.stmt.selectProposal = this.db.prepare(`
      SELECT * FROM categorization_proposals WHERE id = ?
    `);

    this.stmt.selectActiveProposal = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND operation = @operation
         AND superseded_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
    `);

    this.stmt.selectProposalByExactKey = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND operation = @operation
         AND payload_hash = @payloadHash
       LIMIT 1
    `);

    this.stmt.supersedeProposalStmt = this.db.prepare(`
      UPDATE categorization_proposals
         SET superseded_at = @now
       WHERE id = @id
    `);

    // ── Approvals ─────────────────────────────────────────────────────

    this.stmt.insertApproval = this.db.prepare(`
      INSERT OR IGNORE INTO proposal_approvals (id, proposal_id, payload_hash, actor_id,
                                      status, expires_at, consumed_at,
                                      superseded_at, created_at)
      VALUES (@id, @proposalId, @payloadHash, @actorId,
              'active', @expiresAt, NULL,
              NULL, @createdAt)
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
      SELECT superseded_at FROM categorization_proposals WHERE id = ?
    `);

    this.stmt.listProposals = this.db.prepare(`
      SELECT * FROM categorization_proposals
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsActive = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsByBudget = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsByBudgetActive = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsSuperseded = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE superseded_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsSupersededByBudget = this.db.prepare(`
      SELECT * FROM categorization_proposals
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

    this.stmt.completeIdempotencyStmt = this.db.prepare(`
      UPDATE idempotency_records
         SET completed = 1,
             idempotency_status = @status,
             error_message = @errorMessage,
             updated_at = @now
       WHERE idempotency_key = @key
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
                                      category_id, category_name, actor,
                                      from_status, to_status, source_review_id,
                                      created_at)
      VALUES (@id, @reviewItemId, @transactionId,
              @transactionVersion, @merchant, @importedPayee,
              @accountId, @direction, @amount, @date,
              @categoryId, @categoryName, @actor,
              @fromStatus, @toStatus, @sourceReviewId,
              @createdAt)
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
      DELETE FROM candidate_jobs WHERE status = 'pending'
    `);

    this.stmt.deleteMembershipStmt = this.db.prepare(`
      DELETE FROM actor_memberships WHERE actor_id = ?
    `);

    this.stmt.insertExportRecordStmt = this.db.prepare(`
      DELETE FROM export_records
    `);
    // Re-insert as single-row tracking table
    this.stmt.insertExportRecordStmt = this.db.prepare(`
      INSERT INTO export_records (id, budget_name, export_path,
                                   account_count, transaction_count,
                                   exported_at)
      VALUES (@id, @budgetName, @exportPath,
              @accountCount, @transactionCount,
              @exportedAt)
    `);

    this.stmt.selectLastExportStmt = this.db.prepare(`
      SELECT * FROM export_records ORDER BY exported_at DESC LIMIT 1
    `);

    // ── Rule overrides ─────────────────────────────────────────────────

    this.stmt.upsertRuleOverride = this.db.prepare(`
      INSERT INTO rule_overrides (rule_id, inactive, created_at, updated_at)
      VALUES (@ruleId, @inactive, @now, @now)
      ON CONFLICT(rule_id) DO UPDATE SET
        inactive = @inactive,
        updated_at = @now
    `);

    this.stmt.getAllRuleOverrides = this.db.prepare(`
      SELECT rule_id, inactive FROM rule_overrides
    `);

    this.stmt.removeRuleOverride = this.db.prepare(`
      DELETE FROM rule_overrides WHERE rule_id = @ruleId
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

    this.stmt.countProposals = this.db.prepare(`
      SELECT COUNT(*) AS count FROM categorization_proposals
    `);

    this.stmt.countProposalsActive = this.db.prepare(`
      SELECT COUNT(*) AS count FROM categorization_proposals
       WHERE superseded_at IS NULL
    `);

    this.stmt.countProposalsByBudget = this.db.prepare(`
      SELECT COUNT(*) AS count FROM categorization_proposals
       WHERE budget_id = @budgetId
    `);

    this.stmt.countProposalsByBudgetActive = this.db.prepare(`
      SELECT COUNT(*) AS count FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NULL
    `);

    this.stmt.countProposalsSuperseded = this.db.prepare(`
      SELECT COUNT(*) AS count FROM categorization_proposals
       WHERE superseded_at IS NOT NULL
    `);

    this.stmt.countProposalsSupersededByBudget = this.db.prepare(`
      SELECT COUNT(*) AS count FROM categorization_proposals
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
      INSERT INTO invitations (id, token_digest, status, created_by_user_id, expires_at, created_at)
      VALUES (@id, @tokenDigest, 'active', @createdByUserId, @expiresAt, @createdAt)
    `);

    this.stmt.selectInvitation = this.db.prepare(`
      SELECT * FROM invitations WHERE id = ?
    `);

    this.stmt.selectInvitationByDigest = this.db.prepare(`
      SELECT * FROM invitations WHERE token_digest = ?
    `);

    this.stmt.selectAllInvitations = this.db.prepare(`
      SELECT * FROM invitations ORDER BY created_at DESC
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
         AND status = 'active'
    `);

    this.stmt.updateInvitationExpired = this.db.prepare(`
      UPDATE invitations
         SET status = 'expired'
       WHERE id = @id
         AND status = 'active'
         AND expires_at < @now
    `);

    this.stmt.updateInvitationRedeemed = this.db.prepare(`
      UPDATE invitations
         SET status = 'redeemed',
             redeemed_user_id = @userId,
             redeemed_at = @redeemedAt
       WHERE claim_id = @claimId
         AND status = 'claimed'
    `);

    this.stmt.selectStrandedClaims = this.db.prepare(`
      SELECT * FROM invitations
       WHERE status = 'claimed'
         AND redeemed_user_id IS NULL
    `);

    // ── Notification events ────────────────────────────────────────────

    this.stmt.insertNotificationEvent = this.db.prepare(`
      INSERT INTO notification_events (id, event_version, budget_id, classification,
                                       recipient_id, scope, redaction_class,
                                       channel_config_version, policy_version,
                                       correlation_id, payload, created_at)
      VALUES (@id, @eventVersion, @budgetId, @classification,
              @recipientId, @scope, @redactionClass,
              @channelConfigVersion, @policyVersion,
              @correlationId, @payload, @createdAt)
    `);

    this.stmt.selectNotificationEvent = this.db.prepare(`
      SELECT * FROM notification_events WHERE id = ?
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

    this.stmt.insertSavedView = this.db.prepare(`
      INSERT INTO saved_views (view_id, name, view_type, scope, sort, actor_id, created_at)
      VALUES (@viewId, @name, @viewType, @scope, @sort, @actorId, @createdAt)
    `);

    this.stmt.selectSavedView = this.db.prepare(`
      SELECT * FROM saved_views WHERE view_id = @viewId
    `);

    this.stmt.listSavedViewsByActor = this.db.prepare(`
      SELECT * FROM saved_views
       WHERE actor_id = @actorId
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.countSavedViewsByActor = this.db.prepare(`
      SELECT COUNT(*) AS count FROM saved_views WHERE actor_id = @actorId
    `);

    this.stmt.updateSavedView = this.db.prepare(`
      UPDATE saved_views
         SET name = COALESCE(@name, name),
             scope = COALESCE(@scope, scope),
             sort = @sort,
             last_used_at = COALESCE(@lastUsedAt, last_used_at)
       WHERE view_id = @viewId
    `);

    this.stmt.deleteSavedView = this.db.prepare(`
      DELETE FROM saved_views WHERE view_id = ?
    `);

    this.stmt.recordSavedViewUsage = this.db.prepare(`
      UPDATE saved_views SET last_used_at = @now WHERE view_id = @viewId
    `);

    this.stmt.selectSavedViewByActorViewType = this.db.prepare(`
      SELECT * FROM saved_views
       WHERE actor_id = @actorId AND view_type = @viewType
       ORDER BY created_at DESC
       LIMIT 1
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
      budgetId, transactionId, classifier, promptVersion,
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
    const id = randomUUID();
    const now = nowISO();

    // ON CONFLICT DO NOTHING RETURNING * returns undefined on duplicate
    const row = this.stmt.upsertJob.get({
      id,
      jobType: input.jobType,
      candidateId: input.candidateId,
      now,
    }) as JobRow | undefined;

    if (!row) {
      // Row already existed — fetch the existing record unchanged
      // (no updated_at modification, true no-op).
      const existing = this.stmt.selectJobByCandidate.get({
        jobType: input.jobType, candidateId: input.candidateId,
      }) as JobRow | undefined;
      if (!existing) throw new Error('Failed to enqueue or retrieve job');
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

  async getJobByCandidateId(
    jobType: string,
    candidateId: string,
  ): Promise<CandidateJob | null> {
    const row = this.stmt.selectJobByCandidate.get({ jobType, candidateId }) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  // ── Review lifecycle ──────────────────────────────────────────────

  async createReviewItem(input: CreateReviewItemInput): Promise<ReviewItem> {
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
        // Not newer — return existing (idempotent)
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
  }

  async getReviewItem(id: string): Promise<ReviewItem | null> {
    const row = this.stmt.selectReviewItem.get(id) as ReviewItemRow | undefined;
    return row ? rowToReviewItem(row) : null;
  }

  async findReviewByIssue(
    budgetId: string,
    transactionId: string,
    categoryId: string,
    classifier: string,
  ): Promise<ReviewItem | null> {
    const row = this.stmt.selectReviewByIssue.get({
      budgetId, transactionId, categoryId, classifier,
    }) as ReviewItemRow | undefined;
    return row ? rowToReviewItem(row) : null;
  }

  async listReviewItems(options?: ReviewListOptions): Promise<ReviewItem[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

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
    if (options?.status) {
      const row = this.stmt.countReviewItemsByStatus.get({ status: options.status }) as { count: number };
      return row.count;
    }
    const row = this.stmt.countReviewItems.get({}) as { count: number };
    return row.count;
  }

  async listReviewItemsByCorrelation(correlationId: string): Promise<ReviewItem[]> {
    const rows = this.stmt.listReviewItemsByCorrelation.all({ correlationId }) as ReviewItemRow[];
    return rows.map(rowToReviewItem);
  }

  async transitionReviewItem(
    id: string,
    input: TransitionReviewInput,
  ): Promise<ReviewItem> {
    const now = nowISO();
    const current = this.stmt.selectReviewItemStatus.get(id) as { id: string; status: string; version: number; approved_by: string } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);

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
      throw new Error(
        `Cannot transition review item ${id} from '${fromStatus}' to '${toStatus}'`,
      );
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
            throw new Error(`Version conflict on review item ${id}: expected ${input.expectedVersion}`);
          }

          // Record action for the approval step (even though status didn't change)
          this.stmt.insertReviewAction.run({
            id: randomUUID(),
            reviewItemId: id,
            fromStatus: fromStatus,
            toStatus: fromStatus, // stayed same
            actor: input.actor,
            reason: input.reason ?? `Approved by ${input.actor} (${approvedByArr!.length}/${needed} reviewers)`,
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

  async transitionReviewItems(
    ids: string[],
    toStatus: ReviewStatus,
    actor: string,
    reason?: string,
  ): Promise<TransitionReviewResult[]> {
    if (ids.length === 0) return [];

    // Read current statuses for all items, tracking found/missing per index
    const items: ({ id: string; status: ReviewStatus; version: number } | null)[] = ids.map(id => {
      const row = this.stmt.selectReviewItemsByIds.get(id) as { id: string; status: string; version: number } | undefined;
      return row ? { id: row.id, status: row.status as ReviewStatus, version: row.version } : null;
    });

    // Collect only found items for validation
    const foundItems = items.filter((x): x is NonNullable<typeof x> => x !== null);

    if (foundItems.length === 0) {
      // All IDs are missing
      return ids.map(id => ({
        itemId: id,
        success: false,
        item: null,
        error: 'Not found',
      }));
    }

    // Heterogeneous group check: all found items must share the same current status
    const firstStatus = foundItems[0].status;
    if (!foundItems.every(i => i.status === firstStatus)) {
      throw new Error(
        `Heterogeneous group: all items must have the same current status ` +
        `(found items with statuses: ${[...new Set(foundItems.map(i => i.status))].join(', ')})`,
      );
    }

    // Validate the transition for this status group
    const allowed = REVIEW_TRANSITIONS[firstStatus];
    if (!allowed.includes(toStatus)) {
      throw new Error(
        `Cannot transition from '${firstStatus}' to '${toStatus}'`,
      );
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
        const transitioned = await this.transitionReviewItem(item.id, {
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
    reason?: string,
    expectedVersion?: number,
  ): Promise<ReviewItem> {
    const current = this.stmt.selectReviewItemStatus.get(id) as { id: string; status: string; version: number } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);

    const fromStatus = current.status as ReviewStatus;

    // Only approved -> pending_review and correcting -> pending_review are reversible
    if (!UNDO_SOURCES.includes(fromStatus)) {
      throw new Error(
        `Cannot undo from '${fromStatus}': only ${UNDO_SOURCES.join(', ')} support undo`,
      );
    }

    const version = expectedVersion ?? current.version;

    return this.transitionReviewItem(id, {
      toStatus: 'pending_review',
      actor,
      reason: reason ?? `Undo from '${fromStatus}'`,
      metadata: { undo: true, previousStatus: fromStatus },
      expectedVersion: version,
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
      rows = this.stmt.selectCorrectionsByReview.all({ reviewItemId: options.reviewItemId }) as CorrectionRow[];
    } else if (options?.merchant) {
      rows = this.stmt.selectCorrectionsByMerchant.all({ merchant: options.merchant, limit, offset }) as CorrectionRow[];
    } else if (options?.transactionId) {
      rows = this.stmt.selectCorrectionsByTransaction.all({ transactionId: options.transactionId, limit, offset }) as CorrectionRow[];
    } else if (options?.actor) {
      rows = this.stmt.selectCorrectionsByActor.all({ actor: options.actor, limit, offset }) as CorrectionRow[];
    } else {
      rows = this.stmt.selectAllCorrections.all({ limit, offset }) as CorrectionRow[];
    }

    return rows.map(rowToCorrection);
  }

  async findCorrectionConflicts(limit: number = 50): Promise<CorrectionConflict[]> {
    const rows = this.stmt.selectCorrectionConflicts.all({ limit }) as {
      field: string;
      merchant: string;
      values_json: string;
      correction_ids: string;
    }[];

    return rows.map(r => ({
      field: r.field as 'account' | 'direction' | 'category',
      merchant: r.merchant,
      values: r.values_json.split(',').filter((v, i, a) => a.indexOf(v) === i), // dedupe
      correctionIds: r.correction_ids.split(','),
    }));
  }
  // ── Categorization proposal lifecycle ─────────────────────────────


  async createProposal(input: CreateProposalInput): Promise<CategorizationProposal> {
    const id = randomUUID();

    // Validate expiresAt
    const expiresAtDate = new Date(input.expiresAt);
    if (isNaN(expiresAtDate.getTime())) {
      throw new Error(`Invalid expiresAt: '${input.expiresAt}' is not a valid ISO-8601 timestamp`);
    }
    if (expiresAtDate <= new Date()) {
      throw new Error(`expiresAt '${input.expiresAt}' is in the past`);
    }
    const now = nowISO();

    const row = this.stmt.insertProposal.get({
      id,
      operation: input.operation,
      budgetId: input.budgetId,
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      payloadHash: input.payloadHash,
      policyVersion: input.policyVersion,
      preconditions: input.preconditions,
      expiresAt: input.expiresAt,
      actorId: input.actorId,
      provenance: input.provenance,
      providerModel: input.providerModel ?? null,
      correlationId: input.correlationId ?? null,
      supersededAt: null,
      createdAt: now,
    }) as ProposalRow | undefined;

    if (!row) {
      // Duplicate (same target + payload_hash) — fetch existing by exact key
      const existing = this.stmt.selectProposalByExactKey.get({
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        operation: input.operation,
        payloadHash: input.payloadHash,
      }) as ProposalRow | undefined;
      if (existing) return rowToProposal(existing);
      throw new Error('Failed to create or retrieve proposal');
    }

    return rowToProposal(row);
  }

  async getProposal(id: string): Promise<CategorizationProposal | null> {
    const row = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async findActiveProposal(
    budgetId: string,
    transactionId: string,
    operation: ProposalOperation,
  ): Promise<CategorizationProposal | null> {
    const row = this.stmt.selectActiveProposal.get({
      budgetId, transactionId, operation,
    }) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async supersedeProposal(id: string): Promise<CategorizationProposal> {
    const existing = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
    if (!existing) throw new Error(`Proposal ${id} not found`);
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

  async listProposals(options?: ListProposalsOptions): Promise<CategorizationProposal[]> {
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
    const hasBudget = options?.budgetId != null;
    let row: { count: number };

    if (hasBudget) {
      if (options?.superseded === false) {
        row = this.stmt.countProposalsByBudgetActive.get({ budgetId: options.budgetId }) as { count: number };
      } else if (options?.superseded === true) {
        row = this.stmt.countProposalsSupersededByBudget.get({ budgetId: options.budgetId }) as { count: number };
      } else {
        row = this.stmt.countProposalsByBudget.get({ budgetId: options.budgetId }) as { count: number };
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
    // Validate proposal exists and is not superseded
    const proposalRow = this.stmt.selectProposal.get(input.proposalId) as ProposalRow | undefined;
    if (!proposalRow) throw new Error(`Proposal ${input.proposalId} not found`);
    if (proposalRow.superseded_at) throw new Error(`Proposal ${input.proposalId} is superseded`);

    // Validate proposal has not expired
    if (isExpired(proposalRow.expires_at)) {
      throw new Error(`Proposal ${input.proposalId} expired at ${proposalRow.expires_at}`);
    }

    // Validate payload hash matches proposal
    if (input.payloadHash !== proposalRow.payload_hash) {
      throw new Error(`Payload hash mismatch: approval hash ${input.payloadHash} does not match proposal hash ${proposalRow.payload_hash}`);
    }

    // Validate approval expiry is in the future
    if (isExpired(input.expiresAt)) {
      throw new Error(`Approval expiry ${input.expiresAt} is in the past`);
    }

    const id = randomUUID();
    const now = nowISO();

    const row = this.stmt.insertApproval.get({
      id,
      proposalId: input.proposalId,
      payloadHash: input.payloadHash,
      actorId: input.actorId,
      expiresAt: input.expiresAt,
      createdAt: now,
    }) as ApprovalRow | undefined;

    if (!row) {
      // Check if any approval (in any state) already exists for this (proposalId, actorId)
      const existingAny = this.stmt.selectApprovalByProposalActor.get({
        proposalId: input.proposalId,
        actorId: input.actorId,
      }) as ApprovalRow | undefined;

      if (existingAny) {
        if (existingAny.status === 'active') {
          // Check if the existing active approval has actually expired
          if (isExpired(existingAny.expires_at)) {
            throw new Error(
              `Approval for proposal ${input.proposalId} by actor ${input.actorId} ` +
              `already exists with status 'active' (expired at ${existingAny.expires_at}) and cannot be re-issued`,
            );
          }
          // Active and not expired — idempotent return
          return rowToApproval(existingAny);
        }
        // Reject re-issuance — a consumed/expired/superseded approval already exists
        throw new Error(
          `Approval for proposal ${input.proposalId} by actor ${input.actorId} ` +
          `already exists with status '${existingAny.status}' and cannot be re-issued`,
        );
      }

      throw new Error('Failed to create approval');
    }

    return rowToApproval(row);
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

  async consumeApproval(id: string): Promise<ProposalApproval> {
    const existing = this.stmt.selectApproval.get(id) as ApprovalRow | undefined;
    if (!existing) throw new Error(`Approval ${id} not found`);

    if (existing.consumed_at) throw new Error(`Approval ${id} already consumed at ${existing.consumed_at}`);
    if (existing.superseded_at) throw new Error(`Approval ${id} is superseded`);

    // Check proposal is not superseded
    const proposalRow = this.stmt.selectProposal.get(existing.proposal_id) as ProposalRow | undefined;
    if (!proposalRow) throw new Error(`Proposal ${existing.proposal_id} not found`);
    if (proposalRow.superseded_at) throw new Error(`Proposal ${existing.proposal_id} is superseded — cannot consume its approval`);

    // Check proposal has not expired
    if (isExpired(proposalRow.expires_at)) {
      throw new Error(`Proposal ${existing.proposal_id} expired at ${proposalRow.expires_at} — cannot consume its approval`);
    }

    // Check expiry
    const now = nowISO();
    if (isExpired(existing.expires_at)) {
      throw new Error(`Approval ${id} expired at ${existing.expires_at}`);
    }

    const result = this.stmt.consumeApprovalStmt.run({ id, now });
    if (result.changes === 0) {
      throw new Error(`Approval ${id} could not be consumed (concurrent state change)`);
    }

    const updated = this.stmt.selectApproval.get(id) as ApprovalRow;
    return rowToApproval(updated);
  }

  async verifyApprovalForExecution(
    proposalId: string,
    payloadHash: string,
  ): Promise<string | null> {
    // Check proposal exists
    const proposalRow = this.stmt.selectProposal.get(proposalId) as ProposalRow | undefined;
    if (!proposalRow) return `Proposal ${proposalId} not found`;

    // Check proposal is not superseded
    if (proposalRow.superseded_at) return `Proposal ${proposalId} was superseded at ${proposalRow.superseded_at}`;

    // Check proposal has not expired
    if (isExpired(proposalRow.expires_at)) {
      return `Proposal ${proposalId} expired at ${proposalRow.expires_at}`;
    }

    // Check payload hash matches
    if (payloadHash !== proposalRow.payload_hash) {
      return `Payload hash mismatch: expected ${proposalRow.payload_hash}, got ${payloadHash}`;
    }

    // Find active approvals
    const now = nowISO();
    this.stmt.markExpiredApprovals.run({ now });
    const activeApprovals = this.stmt.selectActiveApprovals.all({ proposalId, now }) as ApprovalRow[];

    if (activeApprovals.length === 0) {
      return `No active approvals found for proposal ${proposalId}`;
    }

    return null;
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
  ): Promise<IdempotencyRecord> {
    const now = nowISO();
    const status: IdempotencyStatus =
      errorMessage
        ? (isRetryable ? 'retryable_failed' : 'terminal_failed')
        : 'succeeded';
    this.stmt.completeIdempotencyStmt.run({ key, status, errorMessage: errorMessage ?? null, now });
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

  async queryAuditRecordsByProposal(
    proposalId: string,
    limit?: number,
  ): Promise<AuditRecord[]> {
    const rows = this.stmt.selectAuditByProposal.all({
      proposalId,
      limit: limit ?? 50,
    }) as AuditRow[];
    return rows.map(rowToAudit);
  }

  // ── Authorization ─────────────────────────────────────────────────

  async evaluateAuthorization(
    actorId: string,
    capability: string,
    scope: string,
    policyVersion: string,
  ): Promise<AuthorizationResult> {
    const row = this.stmt.selectActorMembership.get(actorId) as ActorMembershipRow | undefined;

    if (!row) {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: 'Actor not found in membership registry' },
        actorId,
        membershipStatus: 'unknown',
        capability,
        scope,
        policyVersion,
        reason: 'Actor is not a registered member',
      };
    }

    if (row.status !== 'active') {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: `Member status is '${row.status}', not 'active'` },
        actorId,
        membershipStatus: row.status as MembershipStatus,
        capability,
        scope,
        policyVersion,
        reason: `Member is ${row.status}, requires active membership`,
      };
    }

    const capabilities = JSON.parse(row.capabilities) as string[];
    if (!capabilities.includes(capability)) {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: `Missing capability '${capability}'` },
        actorId,
        membershipStatus: 'active',
        capability,
        scope,
        policyVersion,
        reason: `Actor lacks required capability '${capability}'`,
      };
    }

    if (row.scope !== '*' && row.scope !== scope) {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: `Scope '${row.scope}' does not cover required scope '${scope}'` },
        actorId,
        membershipStatus: 'active',
        capability,
        scope,
        policyVersion,
        reason: `Actor scope '${row.scope}' does not include '${scope}'`,
      };
    }

    return {
      allowed: true,
      disposition: { kind: 'authorized_without_approval' },
      actorId,
      membershipStatus: 'active',
      capability,
      scope,
      policyVersion,
      reason: 'Authorized',
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

  async cancelPendingJobs(): Promise<number> {
    const result = this.stmt.cancelPendingJobsStmt.run({});
    return result.changes;
  }

  async deleteActorMembership(actorId: string): Promise<boolean> {
    const result = this.stmt.deleteMembershipStmt.run(actorId);
    return result.changes > 0;
  }

  async recordExport(input: {
    budgetName: string;
    exportPath: string;
    accountCount: number;
    transactionCount: number;
  }): Promise<void> {
    const id = randomUUID();
    const now = nowISO();
    // Clear previous record then insert fresh one (single-row tracking)
    this.db.prepare(`DELETE FROM export_records`).run();
    this.stmt.insertExportRecordStmt.run({
      id,
      budgetName: input.budgetName,
      exportPath: input.exportPath,
      accountCount: input.accountCount,
      transactionCount: input.transactionCount,
      exportedAt: now,
    });
  }

  async getLastExport(): Promise<{
    exportedAt: string;
    budgetName: string;
    exportPath: string;
    accountCount: number;
    transactionCount: number;
  } | null> {
    const row = this.stmt.selectLastExportStmt.get({}) as {
      id: string;
      budget_name: string;
      export_path: string;
      account_count: number;
      transaction_count: number;
      exported_at: string;
    } | undefined;
    if (!row) return null;
    return {
      exportedAt: row.exported_at,
      budgetName: row.budget_name,
      exportPath: row.export_path,
      accountCount: row.account_count,
      transactionCount: row.transaction_count,
    };
  }

  async deleteScopeData(
    scope: string,
    options?: { actorId?: string },
  ): Promise<{
    deleted: Record<string, number>;
    retained: { count: number; reasons: string[] };
  }> {
    const deleted: Record<string, number> = {};
    const reasons: string[] = [];
    const db = this.db;

    switch (scope) {
      case 'connection':
      case 'space':
        deleted.corrections = db.prepare('DELETE FROM review_corrections').run().changes;
        deleted.reviewActions = db.prepare('DELETE FROM review_actions').run().changes;
        deleted.reviewItems = db.prepare('DELETE FROM review_items').run().changes;
        deleted.failures = db.prepare('DELETE FROM failure_records').run().changes;
        deleted.suggestions = db.prepare('DELETE FROM suggestions').run().changes;
        deleted.idempotency = db.prepare('DELETE FROM idempotency_records').run().changes;
        deleted.approvals = db.prepare('DELETE FROM proposal_approvals').run().changes;
        deleted.proposals = db.prepare('DELETE FROM categorization_proposals').run().changes;
        deleted.auditRecords = db.prepare('DELETE FROM audit_records').run().changes;
        deleted.memberships = db.prepare('DELETE FROM actor_memberships').run().changes;
        deleted.exports = db.prepare('DELETE FROM export_records').run().changes;
        deleted.jobs = db.prepare('DELETE FROM candidate_jobs').run().changes;
        deleted.deliveryAttempts = db.prepare('DELETE FROM delivery_attempts').run().changes;
        deleted.outboxRecords = db.prepare('DELETE FROM notification_outbox').run().changes;
        deleted.notificationEvents = db.prepare('DELETE FROM notification_events').run().changes;
        deleted.policyVersions = db.prepare('DELETE FROM policy_versions').run().changes;
        deleted.savedFilters = db.prepare('DELETE FROM saved_filters').run().changes;
        deleted.reportRecords = db.prepare('DELETE FROM report_records').run().changes;
        break;

      case 'user':
        if (options?.actorId) {
          const a = options.actorId;
          deleted.memberships = db.prepare('DELETE FROM actor_memberships WHERE actor_id = ?').run(a).changes;
        } else {
          reasons.push('No actorId provided for user-scope deletion');
        }
        break;

      case 'workflow':
        deleted.corrections = db.prepare('DELETE FROM review_corrections').run().changes;
        deleted.reviewActions = db.prepare('DELETE FROM review_actions').run().changes;
        deleted.reviewItems = db.prepare('DELETE FROM review_items').run().changes;
        deleted.failures = db.prepare('DELETE FROM failure_records').run().changes;
        deleted.suggestions = db.prepare('DELETE FROM suggestions').run().changes;
        deleted.idempotency = db.prepare('DELETE FROM idempotency_records').run().changes;
        deleted.approvals = db.prepare('DELETE FROM proposal_approvals').run().changes;
        deleted.proposals = db.prepare('DELETE FROM categorization_proposals').run().changes;
        deleted.jobs = db.prepare('DELETE FROM candidate_jobs').run().changes;
        deleted.deliveryAttempts = db.prepare('DELETE FROM delivery_attempts').run().changes;
        deleted.outboxRecords = db.prepare('DELETE FROM notification_outbox').run().changes;
        deleted.notificationEvents = db.prepare('DELETE FROM notification_events').run().changes;
        deleted.policyVersions = db.prepare('DELETE FROM policy_versions').run().changes;
        deleted.savedFilters = db.prepare('DELETE FROM saved_filters').run().changes;
        deleted.reportRecords = db.prepare('DELETE FROM report_records').run().changes;
        break;

      case 'provider':
        deleted.approvals = db.prepare('DELETE FROM proposal_approvals').run().changes;
        deleted.proposals = db.prepare('DELETE FROM categorization_proposals').run().changes;
        break;

      case 'notification':
        deleted.deliveryAttempts = db.prepare('DELETE FROM delivery_attempts').run().changes;
        deleted.outboxRecords = db.prepare('DELETE FROM notification_outbox').run().changes;
        deleted.notificationEvents = db.prepare('DELETE FROM notification_events').run().changes;
        break;

      default:
        reasons.push(`Unknown scope "${scope}": no data deleted`);
    }

    // Count retained records still present
    let retainedCount = 0;
    try {
      const row = db.prepare('SELECT COUNT(*) as c FROM suggestions').get() as { c: number } | undefined;
      if (row) retainedCount += row.c;
    } catch { /* table may not exist */ }
    try {
      const row = db.prepare('SELECT COUNT(*) as c FROM candidate_jobs').get() as { c: number } | undefined;
      if (row) retainedCount += row.c;
    } catch { /* table may not exist */ }

    return {
      deleted,
      retained: { count: retainedCount, reasons },
    };
  }

  // ── Rule overrides ──────────────────────────────────────────────────

  async setRuleOverride(ruleId: string, inactive: boolean): Promise<void> {
    const now = nowISO();
    this.stmt.upsertRuleOverride.run({ ruleId, inactive: inactive ? 1 : 0, now });
  }

  async getRuleOverrides(): Promise<Map<string, boolean>> {
    const rows = this.stmt.getAllRuleOverrides.all({}) as Array<{ rule_id: string; inactive: number }>;
    const map = new Map<string, boolean>();
    for (const row of rows) {
      map.set(row.rule_id, row.inactive === 1);
    }
    return map;
  }

  async removeRuleOverride(ruleId: string): Promise<void> {
    this.stmt.removeRuleOverride.run({ ruleId });
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
        { owner_user_id: string | null; claim_id: string | null; claimed_email: string | null } | undefined;

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
        { owner_user_id: string | null; claim_id: string | null; bootstrapped_at: string | null } | undefined;

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

  async createInvitation(creatorUserId: string, auditContext?: { requestId?: string; correlationId?: string }): Promise<CreateInvitationResult> {
    const id = randomUUID();
    const rawToken = randomBytes(32).toString('hex');
    const tokenDigest = createHash('sha256').update(rawToken).digest('hex');
    const now = nowISO();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    this.stmt.insertInvitation.run({
      id,
      tokenDigest,
      createdByUserId: creatorUserId,
      expiresAt,
      createdAt: now,
    });

    this.stmt.insertAudit.run({
      id: randomUUID(),
      classification: 'invitation_created',
      timestamp: now,
      actorId: creatorUserId,
      operation: 'create_invitation',
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
      correlationId: auditContext?.correlationId ?? null,
      requestId: auditContext?.requestId ?? null,
      result: `Invitation ${id} created`,
      isError: 0,
    });

    const base = (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
    return {
      invitation: { id, expiresAt, status: 'active' as InvitationStatus },
      inviteUrl: `${base}/invite#token=${rawToken}`,
    };
  }

  async revokeInvitation(invitationId: string, actorId?: string, requestId?: string): Promise<void> {
    const now = nowISO();
    const result = this.stmt.updateInvitationRevoke.run({ id: invitationId });
    if (result.changes === 0) {
      const row = this.stmt.selectInvitation.get(invitationId) as InvitationRow | undefined;
      if (!row) throw new Error('Invitation not found');
      if (row.status === 'revoked') return;
      throw new Error(`Cannot revoke invitation in '${row.status}' state`);
    }
    this.stmt.insertAudit.run({
      id: randomUUID(),
      classification: 'invitation_revoked',
      timestamp: now,
      actorId: actorId ?? 'system',
      operation: 'revoke_invitation',
      proposalId: invitationId,
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
      requestId: requestId ?? null,
      result: `Invitation ${invitationId} revoked`,
      isError: 0,
    });
  }

  async listInvitations(): Promise<InvitationMetadata[]> {
    const rows = this.stmt.selectAllInvitations.all({}) as InvitationRow[];
    return rows.map(rowToInvitationMetadata);
  }

  async claimInvitation(input: ClaimInvitationInput): Promise<ClaimInvitationResult> {
    const digest = createHash('sha256').update(input.token).digest('hex');
    const claimId = randomUUID();
    const now = nowISO();

    // First, look up the invitation outside the transaction.
    // If it's expired, update status + audit outside the transaction
    // so the status transition commits even though we throw.
    const row = this.stmt.selectInvitationByDigest.get(digest) as InvitationRow | undefined;
    if (!row) throw new Error('Invalid invitation');

    if (isExpired(row.expires_at)) {
      this.stmt.updateInvitationExpired.run({ id: row.id, now });
      this.stmt.insertAudit.run({
        id: randomUUID(),
        classification: 'invitation_expired',
        timestamp: now,
        actorId: input.email,
        operation: 'claim_invitation',
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
        correlationId: input.correlationId ?? null,
        requestId: input.requestId ?? null,
        result: `Invitation ${row.id} expired`,
        isError: 1,
      });
      throw new Error('Invitation has expired');
    }

    // Normal claim flow inside a transaction for atomicity
    const txn = this.db.transaction(() => {
      // Re-read within transaction for consistency under concurrent writes
      const freshRow = this.stmt.selectInvitationByDigest.get(digest) as InvitationRow | undefined;

      if (freshRow!.status === 'claimed') {
        if (freshRow!.claimed_email === input.email) {
          return { claimId: freshRow!.claim_id!, email: freshRow!.claimed_email };
        }
        throw new Error('Invitation already claimed by a different email');
      }

      if (freshRow!.status !== 'active') {
        throw new Error(`Invitation is ${freshRow!.status}`);
      }

      const updateResult = this.stmt.updateInvitationClaim.run({
        id: freshRow!.id,
        email: input.email,
        claimId,
        claimedAt: now,
      });

      if (updateResult.changes === 0) {
        throw new Error('Invitation claim failed');
      }
      this.stmt.insertAudit.run({
        id: randomUUID(),
        classification: 'invitation_claimed',
        timestamp: now,
        actorId: input.email,
        operation: 'claim_invitation',
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
        correlationId: input.correlationId ?? null,
        requestId: input.requestId ?? null,
        result: `Invitation ${freshRow!.id} claimed by ${input.email}`,
        isError: 0,
      });

      return { claimId, email: input.email };
    });

    return txn() as ClaimInvitationResult;
  }

  async completeInvitationRedemption(claimId: string, userId: string, requestId?: string): Promise<void> {
    const now = nowISO();
    const result = this.stmt.updateInvitationRedeemed.run({
      claimId,
      userId,
      redeemedAt: now,
    });
    if (result.changes === 0) {
      throw new Error(`Claim ${claimId} not found or not in claimed state`);
    }
    this.stmt.insertAudit.run({
      id: randomUUID(),
      classification: 'invitation_redeemed',
      timestamp: now,
      actorId: userId,
      operation: 'redeem_invitation',
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
      requestId: requestId ?? null,
      result: `Invitation redeemed for user ${userId}`,
      isError: 0,
    });
  }

  async reconcileClaimedInvitations(): Promise<number> {
    const rows = this.stmt.selectStrandedClaims.all({}) as InvitationRow[];
    return rows.length;
  }

  // ── Notification event lifecycle ──────────────────────────────────

  async createNotificationEvent(input: CreateNotificationEventInput): Promise<NotificationEvent> {
    const id = randomUUID();
    const now = nowISO();
    const payloadJson = JSON.stringify(input.payload);

    this.stmt.insertNotificationEvent.run({
      id,
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
    });

    const row = this.stmt.selectNotificationEvent.get(id) as NotificationEventRow | undefined;
    if (!row) throw new Error('Failed to read back notification event');
    return rowToNotificationEvent(row);
  }

  async getNotificationEvent(id: string): Promise<NotificationEvent | null> {
    const row = this.stmt.selectNotificationEvent.get(id) as NotificationEventRow | undefined;
    return row ? rowToNotificationEvent(row) : null;
  }

  // ── Notification outbox lifecycle ─────────────────────────────────

  async enqueueNotification(input: EnqueueNotificationInput): Promise<NotificationOutboxRecord> {
    // Verify the referenced event exists (persist-before-dispatch)
    const event = this.stmt.selectNotificationEvent.get(input.eventId) as NotificationEventRow | undefined;
    if (!event) throw new Error(`event does not exist: ${input.eventId}`);

    // Check for duplicate delivery key for this (eventId, channelType)
    const existing = this.stmt.selectOutboxByEventChannel.get({
      eventId: input.eventId,
      channelType: input.channelType,
      deliveryKey: input.deliveryKey,
    }) as NotificationOutboxRow | undefined;
    if (existing) {
      throw new Error(`deliveryKey already exists for this eventId+channelType: ${input.deliveryKey}`);
    }

    const id = randomUUID();
    const now = nowISO();
    const maxAttempts = input.maxAttempts ?? 3;

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
    const claimedRow = this.stmt.selectClaimedOutbox.get({ outboxId, claimToken }) as NotificationOutboxRow | undefined;
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
      throw new Error(`Cannot complete delivery: claim token mismatch or invalid state for outbox ${outboxId}`);
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
      throw new Error(`Cannot fail delivery: claim token mismatch or invalid state for outbox ${outboxId}`);
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
      rows = this.stmt.selectPendingOutboxByChannel.all({ limit, channelType }) as NotificationOutboxRow[];
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
      rows = this.stmt.selectRetryableOutboxByChannel.all({ limit, channelType, now }) as NotificationOutboxRow[];
    } else {
      rows = this.stmt.selectRetryableOutbox.all({ limit, now }) as NotificationOutboxRow[];
    }
    return rows.map(rowToOutbox);
  }

  async getDeliveryAttempts(outboxId: string): Promise<DeliveryAttempt[]> {
    const rows = this.stmt.selectDeliveryAttempts.all({ outboxId }) as DeliveryAttemptRow[];
    return rows.map(rowToDeliveryAttempt);
  }

  async listOutboxRecords(
    options?: ListOutboxRecordsOptions,
  ): Promise<NotificationOutboxRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const status = options?.status;
    const channelType = options?.channelType;

    let rows: NotificationOutboxRow[];
    if (status && channelType) {
      rows = this.stmt.selectListOutboxByStatusChannel.all({ limit, offset, status, channelType }) as NotificationOutboxRow[];
    } else if (status) {
      rows = this.stmt.selectListOutboxByStatus.all({ limit, offset, status }) as NotificationOutboxRow[];
    } else if (channelType) {
      rows = this.stmt.selectListOutboxByChannel.all({ limit, offset, channelType }) as NotificationOutboxRow[];
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
    const maxRow = this.db.prepare(
      'SELECT MAX(version) AS mv FROM policy_versions WHERE policy_key = ?'
    ).get(input.policyKey) as { mv: number | null } | undefined;
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
    const row = this.stmt.selectActivePolicyVersion.get({ policyKey }) as PolicyVersionRow | undefined;
    return row ? rowToPolicyVersion(row) : null;
  }

  async listPolicyVersions(
    policyKey: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<PolicyVersion[]> {
    const rows = this.stmt.listPolicyVersions.all({ policyKey, limit, offset }) as PolicyVersionRow[];
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

  async updateSavedFilter(
    id: string,
    input: UpdateSavedFilterInput,
  ): Promise<SavedFilter> {
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
        viewConfig: input.viewConfig !== undefined ? (input.viewConfig ? JSON.stringify(input.viewConfig) : null) : null,
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
      rows = this.stmt.listSavedFiltersByBudget.all({ budgetId: options.budgetId, limit, offset }) as SavedFilterRow[];
    } else if (options?.scope) {
      rows = this.stmt.listSavedFiltersByScope.all({ scope: options.scope, limit, offset }) as SavedFilterRow[];
    } else if (options?.actorId) {
      rows = this.stmt.listSavedFiltersByActor.all({ actorId: options.actorId, limit, offset }) as SavedFilterRow[];
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
      rows = this.stmt.listReportRecordsByBudget.all({ budgetId: options.budgetId, limit, offset }) as ReportRecordRow[];
    } else if (options?.reportType) {
      rows = this.stmt.listReportRecordsByType.all({ reportType: options.reportType, limit, offset }) as ReportRecordRow[];
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

  // ── Saved views ───────────────────────────────────────────────────

  async listSavedViews(actorId: string): Promise<SavedViewResult[]> {
    const limit = 100;
    const offset = 0;
    const rows = this.stmt.listSavedViewsByActor.all({ actorId, limit, offset }) as SavedViewRow[];
    return rows.map(rowToSavedViewResult);
  }

  async createSavedView(input: CreateSavedViewInput): Promise<SavedViewResult> {
    const viewId = randomUUID();
    const now = nowISO();
    const scopeJson = JSON.stringify(input.scope);

    this.stmt.insertSavedView.run({
      viewId,
      name: input.name,
      viewType: input.viewType,
      scope: scopeJson,
      sort: input.sort ?? null,
      actorId: input.actorId,
      createdAt: now,
    });

    const row = this.stmt.selectSavedView.get({ viewId }) as SavedViewRow;
    if (!row) throw new Error('Failed to read back saved view');
    return rowToSavedViewResult(row);
  }

  async getSavedView(viewId: string): Promise<SavedViewResult | null> {
    const row = this.stmt.selectSavedView.get({ viewId }) as SavedViewRow | undefined;
    return row ? rowToSavedViewResult(row) : null;
  }

  async updateSavedView(viewId: string, input: UpdateSavedViewInput): Promise<SavedViewResult> {
    const existing = this.stmt.selectSavedView.get({ viewId }) as SavedViewRow | undefined;
    if (!existing) throw new Error(`Saved view ${viewId} not found`);

    const scopeJson = input.scope !== undefined ? JSON.stringify(input.scope) : undefined;

    this.stmt.updateSavedView.run({
      viewId,
      name: input.name ?? null,
      scope: scopeJson ?? null,
      sort: input.sort !== undefined ? input.sort : null,
      lastUsedAt: existing.last_used_at,
    });

    const row = this.stmt.selectSavedView.get({ viewId }) as SavedViewRow;
    if (!row) throw new Error('Failed to read back updated saved view');
    return rowToSavedViewResult(row);
  }

  async duplicateSavedView(input: DuplicateSavedViewInput): Promise<SavedViewResult> {
    const source = this.stmt.selectSavedView.get({ viewId: input.sourceViewId }) as SavedViewRow | undefined;
    if (!source) throw new Error(`Source saved view ${input.sourceViewId} not found`);

    const newViewId = randomUUID();
    const now = nowISO();

    this.stmt.insertSavedView.run({
      viewId: newViewId,
      name: input.name,
      viewType: source.view_type,
      scope: source.scope,
      sort: source.sort,
      actorId: input.actorId,
      createdAt: now,
    });

    const row = this.stmt.selectSavedView.get({ viewId: newViewId }) as SavedViewRow;
    if (!row) throw new Error('Failed to read back duplicated saved view');
    return rowToSavedViewResult(row);
  }

  async deleteSavedView(viewId: string): Promise<boolean> {
    const result = this.stmt.deleteSavedView.run(viewId);
    return result.changes > 0;
  }

  async recordSavedViewUsage(viewId: string): Promise<SavedViewResult> {
    const existing = this.stmt.selectSavedView.get({ viewId }) as SavedViewRow | undefined;
    if (!existing) throw new Error(`Saved view ${viewId} not found`);

    const now = nowISO();
    this.stmt.recordSavedViewUsage.run({ viewId, now });

    const row = this.stmt.selectSavedView.get({ viewId }) as SavedViewRow;
    return rowToSavedViewResult(row);
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
      rows = this.stmt.listFindingsByBudgetStatus.all({ budgetId: options.budgetId, status: options.status, limit, offset }) as FindingRow[];
    } else if (options?.status) {
      rows = this.stmt.listFindingsByStatus.all({ status: options.status, limit, offset }) as FindingRow[];
    } else if (options?.budgetId) {
      rows = this.stmt.listFindingsByBudget.all({ budgetId: options.budgetId, limit, offset }) as FindingRow[];
    } else if (options?.classification) {
      rows = this.stmt.listFindingsByClassification.all({ classification: options.classification, limit, offset }) as FindingRow[];
    } else if (options?.severity) {
      rows = this.stmt.listFindingsBySeverity.all({ severity: options.severity, limit, offset }) as FindingRow[];
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
      throw new Error(`Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to acknowledged`);
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
      throw new Error(`Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to corrected`);
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
      throw new Error(`Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to dismissed`);
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
      throw new Error(`Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to reopened`);
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
      throw new Error(`Finding ${input.findingId} version conflict or invalid transition from ${existing.status} to superseded`);
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

  async saveNotificationPolicy(input: SaveNotificationPolicyInput): Promise<NotificationPolicyRecord> {
    const existing = this.stmt.selectNotificationPolicy.get({ spaceId: input.spaceId, policyKey: input.policyKey }) as NotificationPolicyRow | undefined;

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

    const row = this.stmt.selectNotificationPolicy.get({ spaceId: input.spaceId, policyKey: input.policyKey }) as NotificationPolicyRow;
    if (!row) throw new Error('Failed to read back notification policy');
    return rowToNotificationPolicy(row);
  }

  async getNotificationPolicy(spaceId: string, policyKey: string): Promise<NotificationPolicyRecord | null> {
    const row = this.stmt.selectNotificationPolicy.get({ spaceId, policyKey }) as NotificationPolicyRow | undefined;
    return row ? rowToNotificationPolicy(row) : null;
  }

  async listNotificationPolicies(options?: ListNotificationPoliciesOptions): Promise<NotificationPolicyRecord[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: NotificationPolicyRow[];
    if (options?.spaceId) {
      rows = this.stmt.listNotificationPoliciesBySpace.all({ spaceId: options.spaceId, limit, offset }) as NotificationPolicyRow[];
    } else {
      rows = this.stmt.listNotificationPolicies.all({ limit, offset }) as NotificationPolicyRow[];
    }
    return rows.map(rowToNotificationPolicy);
  }

  async resolveRecipients(spaceId: string, classification: string, severity: string): Promise<RecipientResolution> {
    // Look up active delivery/notification policies for the space to extract recipient configuration
    const rows = this.stmt.listNotificationPoliciesBySpace.all({ spaceId, limit: 100, offset: 0 }) as NotificationPolicyRow[];

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
        if (parsed.classifications && typeof parsed.classifications === 'object' && !Array.isArray(parsed.classifications)) {
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
        if (parsed.severities && typeof parsed.severities === 'object' && !Array.isArray(parsed.severities)) {
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

  async getReportHistory(budgetId?: string, limit?: number, offset?: number): Promise<ReportHistoryEntry[]> {
    const lim = limit ?? 50;
    const off = offset ?? 0;

    const rows = budgetId
      ? this.stmt.listReportHistoryByBudget.all({ budgetId, limit: lim, offset: off }) as ReportRecordRow[]
      : this.stmt.listReportHistory.all({ limit: lim, offset: off }) as ReportRecordRow[];

    const now = nowISO();
    return rows.map(r => ({
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
