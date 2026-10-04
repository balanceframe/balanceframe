/** Shared read-only DTOs for the API-backed review surface. */
import type { ReviewItem, ReviewStatus } from '@balanceframe/workflow-store';
export type { ReviewStatus };

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Historical classification entry for a merchant. */
export interface ClassificationHistoryEntry {
  readonly categoryId: string;
  readonly count: number;
  readonly lastClassified: string;
}

/** A candidate for automatic rule creation derived from classification history. */
export interface RuleCandidate {
  readonly merchant: string;
  readonly currentCategory: string;
  readonly matchCount: number;
  readonly consistency: number;
}

/** What accepting the suggested category would change. */
export interface ChangePreview {
  readonly fromCategory: string;
  readonly toCategory: string;
  readonly affectsEnvelope: boolean;
}

/** Rich evidence derived from a review item and its persisted data. */
export interface ReviewEvidence {
  readonly originalImportedName: string;
  readonly normalizedMerchant: string;
  readonly account: string;
  readonly amount: number;
  readonly currentCategory: string;
  readonly suggestedCategory: string;
  readonly alternatives: readonly string[];
  readonly history: readonly ClassificationHistoryEntry[];
  readonly ruleCandidates: readonly RuleCandidate[];
  readonly provenance: string;
  readonly freshness: string | null;
  readonly changePreview: ChangePreview;
  readonly correlationId: string | null;
  readonly categoryNames?: Record<string, string>;
  readonly promptVersion: string;
}

// ---------------------------------------------------------------------------
// Homogeneity
// ---------------------------------------------------------------------------

/** Describes whether a group of items shares common review properties. */
export interface HomogeneityInfo {
  readonly homogeneous: boolean;
  readonly commonStatus: ReviewStatus | null;
  readonly commonCategory: string | null;
  readonly commonClassifier: string | null;
  readonly groupSize: number;
  readonly conflictReason: string | null;
}

// ---------------------------------------------------------------------------
// Queue item
// ---------------------------------------------------------------------------

/** An item in the review queue, enriched with evidence and grouping info. */
export interface ReviewQueueItem {
  readonly reviewItem: ReviewItem;
  readonly evidence: ReviewEvidence;
  readonly homogeneity: HomogeneityInfo;
  readonly actionable: boolean;
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

/** Structured error surfaced by the controller. */
export interface ReviewError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Snapshot of the entire review surface state. */
export interface ReviewSurfaceState {
  readonly items: readonly ReviewQueueItem[];
  readonly currentIndex: number;
  readonly currentItem: ReviewQueueItem | null;
  readonly selectedIndices: readonly number[];
  readonly selectionHomogeneity: HomogeneityInfo;
  readonly metrics: ReviewMetricsSnapshot;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: ReviewError | null;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Deterministic metrics snapshot. */
export interface ReviewMetricsSnapshot {
  readonly medianReviewTimeMs: number;
  readonly interactionsPerAction: number;
  readonly acceptanceRate: number;
  readonly correctionRate: number;
  readonly rejectionRate: number;
  readonly backlogCount: number;
  readonly backlogMaxAgeMs: number;
  readonly backlogMeanAgeMs: number;
  readonly coverage: number;
  readonly interactionLatencyMs: number;
  readonly recurrenceCount: number;
  readonly duplicatesAvoided: number;
  readonly createdCount: number;
  readonly resolvedCount: number;
}
