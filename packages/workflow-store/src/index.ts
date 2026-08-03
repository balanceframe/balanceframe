/**
 * @balanceframe/workflow-store — SQLite-backed immutable workflow persistence.
 *
 * Exports the public types and the {@link SqliteWorkflowStore} implementation.
 *
 * ## Usage
 *
 * ```ts
 * import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
 *
 * const store = new SqliteWorkflowStore(':memory:');      // tests
 * const store = new SqliteWorkflowStore('/path/to/db');   // production
 * ```
 *
 * ## Design invariants
 *
 * - Suggestions are immutable once persisted (content never changes).
 * - Supersession sets `supersededAt` without altering any other field.
 * - Jobs use a claim-token pattern for idempotent processing and crash recovery.
 * - All IDs are UUID v4; all timestamps are ISO 8601 UTC.
 */

export { SqliteWorkflowStore } from './store.js';
export type {
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
  CreateReviewItemInput,
  TransitionReviewInput,
  TransitionReviewResult,
  ReviewListOptions,
  ListProposalsOptions,
  CategorizationProposal,
  ProposalOperation,
  ProposalApproval,
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyStatus,
  AuditRecord,
  AuditClassification,
  CreateProposalInput,
  CreateRuleProposalInput,
  CreateApprovalInput,
  CreateIdempotencyInput,
  AppendAuditInput,
  AuthorizationDisposition,
  AuthorizationResult,
  MembershipStatus,
  RegistrationState,
  RegistrationMode,
  BootstrapClaimInput,
  InvitationStatus,
  Invitation,
  InvitationMetadata,
  CreateInvitationResult,
  ClaimInvitationInput,
  ClaimInvitationResult,
  BootstrapClaimResult,
  FinalizeBootstrapInput,
  FinalizeBootstrapResult,
  CompleteInvitationRedemptionInput,
  CompleteInvitationRedemptionResult,
  // Phase 8 — Budget Intelligence foundations
  NotificationEvent,
  CreateNotificationEventInput,
  OutboxStatus,
  NotificationOutboxRecord,
  EnqueueNotificationInput,
  DeliveryAttemptStatus,
  DeliveryAttempt,
  RecordDeliveryAttemptInput,
  PolicyVersion,
  RecordPolicyVersionInput,
  SavedFilter,
  CreateSavedFilterInput,
  UpdateSavedFilterInput,
  SavedFilterListOptions,
  ReportRecord,
  CreateReportRecordInput,
  ReportListOptions,
  SavedViewResult,
  CreateSavedViewInput,
  // Phase 8.5 — Saved view lifecycle
  UpdateSavedViewInput,
  DuplicateSavedViewInput,
  // Phase 8.5 — Finding lifecycle
  Finding,
  FindingStatus,
  CreateFindingInput,
  AcknowledgeFindingInput,
  CorrectFindingInput,
  DismissFindingInput,
  ReopenFindingInput,
  SupersedeFindingInput,
  ListFindingsOptions,
  // Phase 8.5 — Report history
  ReportHistoryEntry,
  // Phase 8.5 — Outbox listing
  ListOutboxRecordsOptions,
  // Phase 8.5 — Notification policy
  NotificationPolicyRecord,
  SaveNotificationPolicyInput,
  RecipientResolution,
  ListNotificationPoliciesOptions,
} from './types.js';
