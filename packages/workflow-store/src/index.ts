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
export { SpaceGovernance } from './governance.js';
export type * from './governance-types.js';
export {
  canonicalProposalHash,
  canonicalProposalJson,
  deriveActualRuleCategoryGroupReferences,
  deriveProposalAuthorizationFacts,
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
  requiredProposalApprovers,
} from './proposal.js';
export type { ProposalAuthorizationFacts } from './proposal.js';
export type {
  Suggestion,
  SaveSuggestionInput,
  CandidateJob,
  JobStatus,
  FailureRecord,
  EnqueueJobInput,
  WorkflowStore,
  LifecycleScope,
  RuleOverrideScope,
  RuleOverride,
  GetRuleOverrideInput,
  SetRuleOverrideInput,
  RemoveRuleOverrideInput,
  ReviewItem,
  ReviewStatus,
  ReviewAction,
  CreateReviewItemInput,
  TransitionReviewInput,
  AuthorizedReviewTransitionInput,
  ReviewActionAuthorization,
  DiscardProposalAuthorization,
  TransitionReviewResult,
  ReviewListOptions,
  ListProposalsOptions,
  ActionProposal,
  SessionCompletionProposal,
  SessionCompletionPayload,
  SessionCompletionState,
  SessionCompletionPhase,
  SessionCompletionOutcome,
  SessionCompletionMoney,
  SessionCompletionManualInput,
  SessionCompletionSplit,
  SessionCompletionCategoryCharge,
  ProposalOperation,
  GenericProposalOperation,
  CategoryActionPayload,
  RuleActionPayload,
  UpdateRuleActionPayload,
  DeleteRuleActionPayload,
  GenericProposalComposite,
  ProposalJsonValue,
  ProposalJsonObject,
  CanonicalProposalEnvelope,
  ProposalAcquisitionReasonCode,
  AcquireProposalExecutionInput,
  ProposalExecutionAcquisition,
  GenericActionProposal,
  CurrentHumanApproval,
  GetProposalApprovalSummaryInput,
  ProposalApprovalSummary,
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyStatus,
  AuditRecord,
  AuditClassification,
  CreateProposalInput,
  CreateApprovalInput,
  CreateApprovalsInput,
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
  InvitationControlInput,
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
  CreateOrGetNotificationEventInput,
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
  SavedViewAuthority,
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
export { LiquidityWorkflow } from './liquidity.js';
export type * from './liquidity-types.js';
