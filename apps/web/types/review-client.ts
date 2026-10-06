/**
 * Narrow typed client boundary for the Nuxt review surface.
 *
 * Defines only the proposal/action result types that the web layer observes.
 * Never exposes Actual credentials, raw Actual methods, N-API calls, or
 * alternate mutation paths.  The framework-neutral ReviewController remains
 * the sole state authority.
 */

import type { ProposalApprovalView } from '../server/utils/proposal-approval-view';
import type { ReviewSurfaceState } from '../src/review.js';

/** A server-created proposal bound to the exact review item that produced it. */
export interface PendingProposalApproval {
  readonly reviewId: string;
  readonly proposal: ProposalApprovalView;
}

/** Runtime boundary check for exact proposal views received from the server. */
export function isProposalApprovalView(value: unknown): value is ProposalApprovalView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  const approvers = view.approvers;
  return (
    (view.operation === 'set_category' ||
      view.operation === 'create_rule' ||
      view.operation === 'update_rule' ||
      view.operation === 'delete_rule') &&
    typeof view.spaceId === 'string' &&
    typeof view.budgetId === 'string' &&
    typeof view.requesterActorId === 'string' &&
    typeof view.requesterMembershipId === 'string' &&
    typeof view.governancePolicyVersion === 'string' &&
    typeof view.currentGovernancePolicyVersion === 'string' &&
    typeof view.requesterMembershipCurrent === 'boolean' &&
    typeof view.policyVersion === 'string' &&
    typeof view.payloadHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(view.payloadHash) &&
    typeof view.privateEnvelopeVisible === 'boolean' &&
    (view.privateEnvelopeVisible
      ? view.payload !== null && typeof view.payload === 'object' && !Array.isArray(view.payload) &&
        view.preconditions !== null && typeof view.preconditions === 'object' && !Array.isArray(view.preconditions)
      : view.payload === null && view.preconditions === null && view.canApprove === false) &&
    typeof view.expiresAt === 'string' &&
    typeof view.requiredApprovers === 'number' &&
    Number.isInteger(view.requiredApprovers) &&
    view.requiredApprovers > 0 &&
    Array.isArray(approvers) &&
    approvers.every((approver) => {
      if (!approver || typeof approver !== 'object' || Array.isArray(approver)) return false;
      const vote = approver as Record<string, unknown>;
      return (
        typeof vote.actorId === 'string' &&
        typeof vote.issuedAt === 'string' &&
        typeof vote.expiresAt === 'string'
      );
    }) &&
    (view.disposition === 'authorized_without_approval' ||
      view.disposition === 'approval_required' ||
      view.disposition === 'denied') &&
    typeof view.canApprove === 'boolean' &&
    typeof view.canExecute === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Web-visible proposal result
// ---------------------------------------------------------------------------

/** Outcome of a single item action, as presented to the UI. */
export interface WebActionResult {
  readonly itemId: string;
  readonly success: boolean;
  readonly error: string | null;
  readonly approvalRequired?: boolean;
}

/** Result of a bulk action with per-item outcomes. */
export interface WebBulkActionResult {
  readonly results: readonly WebActionResult[];
  readonly consumedCount: number;
  readonly errorCount: number;
}

// ---------------------------------------------------------------------------
// Web-shell adapter — the contract between Nuxt and ReviewController
// ---------------------------------------------------------------------------

/**
 * Reactive adapter that bridges the framework-neutral ReviewController
 * to the Vue/Nuxt reactivity system.
 *
 * - Subscribes to controller state changes and surfaces them reactively.
 * - Exposes typed action methods that delegate to controller bindings.
 * - Never accesses the WorkflowStore or Actual API directly.
 */
export interface ReviewControllerAdapter {
  /** Reactive snapshot of the current review surface state. */
  readonly state: Readonly<ReviewSurfaceState>;

  readonly proposalApprovalViews?: readonly PendingProposalApproval[];

  /** True while an async load or transition is in flight. */
  readonly loading: boolean;

  /** Human-readable error message when the last operation failed, or null. */
  readonly error: string | null;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Load the next page of review items from the store. */
  loadNextPage(): Promise<void>;

  /** Reload the queue from scratch. */
  refresh(): Promise<void>;


  /** Remove one or all exact proposal views after discard or verified execution. */
  clearProposalApprovalViews?(proposalId?: string): void;
  // ── Single-item actions ────────────────────────────────────────────
  
  /** Approve the current item. Returns the action result. */
  approve(): Promise<WebActionResult>;
  
  /** Correct the current item to the given category. */
  correct(categoryId: string): Promise<WebActionResult>;
  
  /** Reject the current item. */
  reject(): Promise<WebActionResult>;
  
  /** Skip the current item. */
  skip(): Promise<WebActionResult>;
  
  /** Undo the last reversible transition. */
  undo(): Promise<WebActionResult>;
  
  // ── Rule creation ──────────────────────────────────────────────────
  
  /** Propose from current native source identity; the server owns simulation and payee authority. */
  proposeRule(reviewId: string, categoryId: string): Promise<WebActionResult>;
  
  // ── Bulk actions ───────────────────────────────────────────────────

  /** Bulk-approve all selected items. */
  bulkApprove(): Promise<WebBulkActionResult>;

  /** Bulk-correct all selected items to the given category. */
  bulkCorrect(categoryId: string): Promise<WebBulkActionResult>;

  /** Bulk-reject all selected items. */
  bulkReject(): Promise<WebBulkActionResult>;

  /** Bulk-skip all selected items. */
  bulkSkip(): Promise<WebBulkActionResult>;

  // ── Navigation ─────────────────────────────────────────────────────

  /** Move focus to the next item. */
  selectNext(): void;

  /** Move focus to the previous item. */
  selectPrevious(): void;
  /** Navigate to the item at the given index. */
  selectIndex(index: number): void;


  /** Toggle selection of the item at the given index. */
  toggleSelection(index: number): void;

  /** Clear the current selection. */
  clearSelection(): void;

  // ── Metrics ────────────────────────────────────────────────────────

  /** Reset all collected metrics. */
  resetMetrics(): void;

  // ── Error management ───────────────────────────────────────────────

  /** Surface an external error. */
  setError(code: string, message: string, retryable?: boolean): void;

  /** Clear the current error. */
  clearError(): void;
}

/** API-backed adapter that retains server proposal snapshots for explicit consent. */
export interface ApiReviewControllerAdapter extends ReviewControllerAdapter {
  readonly proposalApprovalViews: readonly PendingProposalApproval[];
  clearProposalApprovalViews(proposalId?: string): void;
}
