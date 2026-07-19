/**
 * Framework-neutral responsive review surface/controller for BalanceFrame.
 *
 * Consumes the shared review contract (@balanceframe/workflow-store) without
 * duplicating persistence.  Exposes a prioritised attention queue,
 * evidence-rich detail, keyboard/touch action bindings with identical
 * semantics, grouping of homogeneous evidence, bulk actions with conflict
 * results, immediate progression, and deterministic metrics hooks.
 *
 * No UI framework dependency — this is pure TypeScript that any UI layer
 * can adapt by subscribing to state changes and calling action bindings.
 */

import type {
  WorkflowStore,
  ReviewItem,
  ReviewStatus,
  TransitionReviewResult,
  TransitionReviewInput,
} from '@balanceframe/workflow-store';

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Historical classification entry for a merchant. */
export interface ClassificationHistoryEntry {
  readonly categoryId: string;
  readonly count: number;
  readonly lastClassified: string;
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
  readonly provenance: string;
  readonly freshness: string | null;
  readonly changePreview: ChangePreview;
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

/** Kinds of metric events recorded. */
export type MetricEventType =
  | 'view'
  | 'approve'
  | 'correct'
  | 'reject'
  | 'skip'
  | 'undo'
  | 'supersede'
  | 'bulk_action'
  | 'load_error';

/** A single recorded metric event. */
export interface MetricEvent {
  readonly type: MetricEventType;
  readonly itemId: string | null;
  readonly timestamp: string;
  readonly latencyMs: number;
}

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

// ---------------------------------------------------------------------------
// Action bindings — shared interface for keyboard and touch
// ---------------------------------------------------------------------------

/**
 * Actions that can be bound to keyboard shortcuts or touch gestures.
 *
 * Every binding has identical semantics regardless of input modality.
 * The caller maps input events to these method calls.
 */
export interface ReviewActionBindings {
  /** Approve the current item (one-action). */
  approve(): Promise<void>;

  /** Correct the current item to the given category (few-action). */
  correct(categoryId: string): Promise<void>;

  /** Reject the current item. */
  reject(): Promise<void>;

  /** Skip the current item. */
  skip(): Promise<void>;

  /** Undo the last reversible transition on the current item. */
  undo(): Promise<void>;

  /** Move focus to the next item in the queue. */
  selectNext(): void;

  /** Move focus to the previous item in the queue. */
  selectPrevious(): void;

  /** Toggle selection of the item at the given index. */
  toggleSelection(index: number): void;

  /** Clear the current selection. */
  clearSelection(): void;

  /** Bulk-approve all selected items (must be homogeneous). */
  bulkApprove(): Promise<TransitionReviewResult[]>;

  /** Bulk-correct all selected items to the given category. */
  bulkCorrect(categoryId: string): Promise<TransitionReviewResult[]>;

  /** Bulk-reject all selected items. */
  bulkReject(): Promise<TransitionReviewResult[]>;

  /** Bulk-skip all selected items. */
  bulkSkip(): Promise<TransitionReviewResult[]>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReviewConfig {
  /** Actor identity for audit trail. */
  readonly actorId: string;

  /** Number of items to load per page (default 50). */
  readonly pageSize?: number;

  /**
   * Optional enrichment function that merges externally-provided data
   * (e.g. transaction details from the ledger) into the evidence object.
   */
  readonly enrichEvidence?: (
    item: ReviewItem,
  ) => Partial<ReviewEvidence> | Promise<Partial<ReviewEvidence>>;
}

/** Callback invoked whenever the controller's state changes. */
export type StateListener = (state: ReviewSurfaceState) => void;

// ---------------------------------------------------------------------------
// Metrics collector
// ---------------------------------------------------------------------------

class MetricsCollector {
  private events: MetricEvent[] = [];
  private duplicatesAvoided: number = 0;
  private loadedCount: number = 0;

  record(event: Omit<MetricEvent, 'latencyMs'>): void {
    this.events.push({
      ...event,
      latencyMs: event.timestamp
        ? Date.now() - new Date(event.timestamp).getTime()
        : 0,
    });
  }

  recordDuplicateAvoidance(): void {
    this.duplicatesAvoided++;
  }

  recordLoad(count: number): void {
    this.loadedCount = count;
  }

  snapshot(
    backlogCount: number,
    backlogAgesMs: number[],
  ): ReviewMetricsSnapshot {
    const approveEvents = this.events.filter(e => e.type === 'approve');
    const correctEvents = this.events.filter(e => e.type === 'correct');
    const rejectEvents = this.events.filter(e => e.type === 'reject');
    const skipEvents = this.events.filter(e => e.type === 'skip');
    const totalResolved =
      approveEvents.length +
      correctEvents.length +
      rejectEvents.length +
      skipEvents.length;

    const allActions = this.events.filter(e =>
      ['approve', 'correct', 'reject', 'skip', 'undo', 'bulk_action'].includes(
        e.type,
      ),
    );

    const reviewTimesMs = [
      ...approveEvents.map(e => e.latencyMs),
      ...correctEvents.map(e => e.latencyMs),
      ...rejectEvents.map(e => e.latencyMs),
      ...skipEvents.map(e => e.latencyMs),
    ].filter(t => t >= 0);

    const sorted = [...reviewTimesMs].sort((a, b) => a - b);
    const n = sorted.length;
    const medianReviewTimeMs =
      n > 0
        ? n % 2 === 1
          ? sorted[Math.floor(n / 2)]
          : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        : 0;

    const totalAccepted = approveEvents.length + correctEvents.length;
    const totalDecided = totalResolved;

    const acceptanceRate = totalDecided > 0 ? totalAccepted / totalDecided : 0;
    const correctionRate =
      totalDecided > 0 ? correctEvents.length / totalDecided : 0;
    const rejectionRate =
      totalDecided > 0 ? rejectEvents.length / totalDecided : 0;

    const interactionsPerAction =
      totalDecided > 0 ? allActions.length / totalDecided : 0;

    const backlogMeanAgeMs =
      backlogAgesMs.length > 0
        ? backlogAgesMs.reduce((s, a) => s + a, 0) / backlogAgesMs.length
        : 0;
    const backlogMaxAgeMs =
      backlogAgesMs.length > 0 ? Math.max(...backlogAgesMs) : 0;

    const totalCreated = this.loadedCount + this.duplicatesAvoided;
    const coverage = totalCreated > 0 ? totalResolved / totalCreated : 0;

    const latencies = allActions.map(e => e.latencyMs).filter(l => l >= 0);
    const interactionLatencyMs =
      latencies.length > 0
        ? latencies.reduce((s, l) => s + l, 0) / latencies.length
        : 0;

    const recurrenceCount = this.events.filter(e => e.type === 'supersede').length;

    return {
      medianReviewTimeMs,
      interactionsPerAction,
      acceptanceRate,
      correctionRate,
      rejectionRate,
      backlogCount,
      backlogMaxAgeMs,
      backlogMeanAgeMs,
      coverage,
      interactionLatencyMs,
      recurrenceCount,
      duplicatesAvoided: this.duplicatesAvoided,
      createdCount: totalCreated,
      resolvedCount: totalResolved,
    };
  }

  reset(): void {
    this.events = [];
    this.duplicatesAvoided = 0;
    this.loadedCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Homogeneity helper
// ---------------------------------------------------------------------------

function checkHomogeneity(items: ReviewQueueItem[]): HomogeneityInfo {
  if (items.length === 0) {
    return {
      homogeneous: true,
      commonStatus: null,
      commonCategory: null,
      commonClassifier: null,
      groupSize: 0,
      conflictReason: null,
    };
  }

  const first = items[0];
  const statuses = new Set(items.map(i => i.reviewItem.status));
  const categories = new Set(items.map(i => i.reviewItem.categoryId));
  const classifiers = new Set(items.map(i => i.reviewItem.classifier));

  const conflicts: string[] = [];
  if (statuses.size > 1) conflicts.push('mixed status');
  if (categories.size > 1) conflicts.push('mixed categories');
  if (classifiers.size > 1) conflicts.push('mixed classifiers');

  return {
    homogeneous: conflicts.length === 0,
    commonStatus: first.reviewItem.status,
    commonCategory: first.reviewItem.categoryId,
    commonClassifier: first.reviewItem.classifier,
    groupSize: items.length,
    conflictReason: conflicts.length > 0 ? conflicts.join('; ') : null,
  };
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

function extractEvidence(item: ReviewItem): ReviewEvidence {
  const pay = item.evidence as Record<string, unknown> | undefined;

  const originalImportedName =
    typeof pay?.originalName === 'string'
      ? pay.originalName
      : item.transactionId;

  const normalizedMerchant =
    typeof pay?.normalizedMerchant === 'string'
      ? pay.normalizedMerchant
      : item.transactionId;

  const account =
    typeof pay?.account === 'string' ? pay.account : '';

  const amount = typeof pay?.amount === 'number' ? pay.amount : 0;

  const alternativesList = Array.isArray(pay?.alternatives)
    ? (pay.alternatives as string[])
    : [];

  const historyList = Array.isArray(pay?.history)
    ? (pay.history as ClassificationHistoryEntry[])
    : [];

  const fromCategory =
    typeof pay?.currentCategory === 'string'
      ? pay.currentCategory
      : item.categoryId;

  return {
    originalImportedName,
    normalizedMerchant,
    account,
    amount,
    currentCategory: fromCategory,
    suggestedCategory: item.categoryId,
    alternatives: alternativesList,
    history: historyList,
    provenance: item.provenance,
    freshness: item.freshnessExpiresAt,
    changePreview: {
      fromCategory,
      toCategory: item.categoryId,
      affectsEnvelope: fromCategory !== item.categoryId,
    },
  };
}

// ---------------------------------------------------------------------------
// Statuses qualifying as action-needing
// ---------------------------------------------------------------------------

const ACTIONABLE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'pending_review',
  'discovered',
  'suggestion_generated',
]);

const TERMINAL_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'applied',
  'apply_failed',
  'rejected',
  'skipped',
  'superseded',
]);

function isActionable(status: ReviewStatus): boolean {
  return ACTIONABLE_STATUSES.has(status);
}

function isTerminal(status: ReviewStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// ReviewController
// ---------------------------------------------------------------------------

/**
 * Framework-neutral controller for the review surface.
 *
 * Manages a priority-sorted queue of review items, exposes action bindings
 * (approve/correct/reject/skip/undo) with shared semantics for keyboard and
 * touch, supports bulk operations with homogeneity verification, collects
 * deterministic metrics, and notifies listeners on every state change.
 */
export class ReviewController {
  private readonly store: WorkflowStore;
  private readonly config: {
    readonly actorId: string;
    readonly pageSize: number;
    readonly enrichEvidence: (
      item: ReviewItem,
    ) => Partial<ReviewEvidence> | Promise<Partial<ReviewEvidence>>;
  };

  private items: ReviewQueueItem[] = [];
  private currentIndex: number = 0;
  private selectedIndices: Set<number> = new Set();
  private hasMore: boolean = true;
  private offset: number = 0;
  private loading: boolean = false;
  private error: ReviewError | null = null;
  private metrics: MetricsCollector = new MetricsCollector();
  /** ID of the most recently consumed item, for undo when queue is empty. */
  private lastActedItemId: string | null = null;
  private listeners: Set<StateListener> = new Set();

  constructor(store: WorkflowStore, config: ReviewConfig) {
    this.store = store;
    this.config = {
      actorId: config.actorId,
      pageSize: config.pageSize ?? 50,
      enrichEvidence:
        config.enrichEvidence ??
        (() => ({} as Partial<ReviewEvidence>)),
    };
  }

  // ── Loading ──────────────────────────────────────────────────────────

  /** Load the next page of review items from the store. */
  async loadNextPage(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.notify();

    try {
      const rawItems = await this.store.listReviewItems({
        offset: this.offset,
        limit: this.config.pageSize,
      });

      const queueItems: ReviewQueueItem[] = [];
      for (const raw of rawItems) {
        queueItems.push(await this.buildQueueItem(raw));
      }

      // Exclude terminal items — they don't need attention
      const newItems = queueItems.filter(i => !isTerminal(i.reviewItem.status));

      this.items = [...this.items, ...newItems];

      this.offset += rawItems.length;
      this.hasMore = rawItems.length >= this.config.pageSize;

      // Ensure currentIndex is valid
      if (this.currentIndex >= this.items.length && this.items.length > 0) {
        this.currentIndex = this.items.length - 1;
      }

      this.error = null;
      this.metrics.recordLoad(this.items.length);
      this.metrics.record({
        type: 'view',
        itemId: null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error = { code: 'load_failed', message, retryable: true };
      this.metrics.record({
        type: 'load_error',
        itemId: null,
        timestamp: new Date().toISOString(),
      });
      throw err;
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  /** Reload the queue from scratch. */
  async refresh(): Promise<void> {
    this.items = [];
    this.currentIndex = 0;
    this.selectedIndices.clear();
    this.offset = 0;
    this.hasMore = true;
    this.error = null;
    await this.loadNextPage();
  }

  // ── State access ─────────────────────────────────────────────────────

  /** Return a snapshot of the current state. */
  getState(): ReviewSurfaceState {
    const currentItem =
      this.items.length > 0 && this.currentIndex < this.items.length
        ? this.items[this.currentIndex]
        : null;

    const selected = this.getSelectedItems();
    const selectionHomogeneity = checkHomogeneity(selected);

    const backlogAgesMs = this.items
      .filter(i => isActionable(i.reviewItem.status))
      .map(i => {
        const created = new Date(i.reviewItem.createdAt).getTime();
        return Date.now() - created;
      });

    return {
      items: this.items,
      currentIndex: this.currentIndex,
      currentItem,
      selectedIndices: [...this.selectedIndices].sort((a, b) => a - b),
      selectionHomogeneity,
      metrics: this.metrics.snapshot(this.items.length, backlogAgesMs),
      hasMore: this.hasMore,
      loading: this.loading,
      error: this.error,
    };
  }

  /** Get action bindings — shared for keyboard and touch. */
  getBindings(): ReviewActionBindings {
    return {
      approve: () => this.doApprove(),
      correct: (categoryId: string) => this.doCorrect(categoryId),
      reject: () => this.doReject(),
      skip: () => this.doSkip(),
      undo: () => this.doUndo(),
      selectNext: () => this.doSelectNext(),
      selectPrevious: () => this.doSelectPrevious(),
      toggleSelection: (index: number) => this.doToggleSelection(index),
      clearSelection: () => this.doClearSelection(),
      bulkApprove: () => this.doBulkApprove(),
      bulkCorrect: (categoryId: string) => this.doBulkCorrect(categoryId),
      bulkReject: () => this.doBulkReject(),
      bulkSkip: () => this.doBulkSkip(),
    };
  }

  /** Subscribe to state changes.  Returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  /** Get a snapshot of current metrics. */
  getMetricsSnapshot(): ReviewMetricsSnapshot {
    return this.getState().metrics;
  }

  /** Reset all collected metrics. */
  resetMetrics(): void {
    this.metrics.reset();
    this.notify();
  }

  // ── Manual error management ──────────────────────────────────────────

  /** Surface an external error (e.g. inaccessible provider). */
  setError(code: string, message: string, retryable: boolean = true): void {
    this.error = { code, message, retryable };
    this.notify();
  }

  /** Clear the current error state. */
  clearError(): void {
    this.error = null;
    this.notify();
  }

  // ── Single-item actions ──────────────────────────────────────────────

  private async doApprove(): Promise<void> {
    const item = this.requireCurrentItem();
    await this.transitionItem(item, 'approved', 'Looks correct');
    this.metrics.record({
      type: 'approve',
      itemId: item.reviewItem.id,
      timestamp: new Date().toISOString(),
    });
    this.advanceAfterAction();
  }

  private async doCorrect(categoryId: string): Promise<void> {
    const item = this.requireCurrentItem();
    const status = item.reviewItem.status;

    // Correction requires a two-step transition from pending_review:
    // pending_review -> approved -> correcting
    if (status === 'pending_review') {
      const approved = await this.store.transitionReviewItem(
        item.reviewItem.id,
        {
          toStatus: 'approved',
          actor: this.config.actorId,
          reason: `Correcting to ${categoryId}`,
          expectedVersion: item.reviewItem.version,
        },
      );
      const updated = await this.store.transitionReviewItem(
        item.reviewItem.id,
        {
          toStatus: 'correcting',
          actor: this.config.actorId,
          reason: `Corrected to ${categoryId}`,
          metadata: { correctedCategory: categoryId },
          expectedVersion: approved.version,
        },
      );
      this.replaceItem(item, updated);
    } else if (status === 'approved') {
      const updated = await this.store.transitionReviewItem(
        item.reviewItem.id,
        {
          toStatus: 'correcting',
          actor: this.config.actorId,
          reason: `Corrected to ${categoryId}`,
          metadata: { correctedCategory: categoryId },
          expectedVersion: item.reviewItem.version,
        },
      );
      this.replaceItem(item, updated);
    } else {
      throw new ReviewActionError(
        'invalid_status',
        `Cannot correct item with status '${status}'`,
        false,
      );
    }

    this.metrics.record({
      type: 'correct',
      itemId: item.reviewItem.id,
      timestamp: new Date().toISOString(),
    });
    this.advanceAfterAction();
  }

  private async doReject(): Promise<void> {
    const item = this.requireCurrentItem();
    await this.transitionItem(item, 'rejected', 'Not appropriate');
    this.metrics.record({
      type: 'reject',
      itemId: item.reviewItem.id,
      timestamp: new Date().toISOString(),
    });
    this.advanceAfterAction();
  }

  private async doSkip(): Promise<void> {
    const item = this.requireCurrentItem();
    await this.transitionItem(item, 'skipped', 'Deferred');
    this.metrics.record({
      type: 'skip',
      itemId: item.reviewItem.id,
      timestamp: new Date().toISOString(),
    });
    this.advanceAfterAction();
  }

  private async doUndo(): Promise<void> {
    let item: ReviewQueueItem | null = null;
    try {
      item = this.requireCurrentItem();
    } catch {
      // No current item — fall back to the last acted-upon item
      if (this.lastActedItemId) {
        const stored = await this.store.getReviewItem(this.lastActedItemId);
        if (stored) {
          item = this.buildQueueItemSync(stored);
        }
      }
    }

    if (!item) {
      throw new ReviewActionError(
        'no_current',
        'No current item to undo. Load the queue first.',
        false,
      );
    }

    const updated = await this.store.undoReviewTransition(
      item.reviewItem.id,
      this.config.actorId,
      'Reversed by reviewer',
      item.reviewItem.version,
    );
    this.lastActedItemId = null;
    this.metrics.record({
      type: 'undo',
      itemId: item.reviewItem.id,
      timestamp: new Date().toISOString(),
    });
    this.notify();
  }

  // ── Bulk actions ─────────────────────────────────────────────────────

  private async doBulkApprove(): Promise<TransitionReviewResult[]> {
    return this.doBulkStatusTransition('approved', 'Bulk approval');
  }

  private async doBulkReject(): Promise<TransitionReviewResult[]> {
    return this.doBulkStatusTransition('rejected', 'Bulk rejected');
  }

  private async doBulkSkip(): Promise<TransitionReviewResult[]> {
    return this.doBulkStatusTransition('skipped', 'Bulk skipped');
  }

  private async doBulkCorrect(
    categoryId: string,
  ): Promise<TransitionReviewResult[]> {
    const selected = this.getSelectedItems();

    if (selected.length === 0) {
      await this.doCorrect(categoryId);
      return [];
    }

    this.requireHomogeneous(selected);
    const ids = selected.map(i => i.reviewItem.id);

    // Two-step bulk correct: approve all first, then correct all.
    // The store's transitionReviewItems checks homogeneity on each call.
    const approveResults = await this.store.transitionReviewItems(
      ids,
      'approved',
      this.config.actorId,
      `Bulk correcting to ${categoryId}`,
    );

    const failedApprove = approveResults.filter(r => !r.success);
    if (failedApprove.length > 0) {
      // Some approvals failed; return the partial results.
      this.metrics.record({
        type: 'bulk_action',
        itemId: null,
        timestamp: new Date().toISOString(),
      });
      this.notify();
      return approveResults;
    }

    // All approved — now correct them
    const correctResults = await this.store.transitionReviewItems(
      ids,
      'correcting',
      this.config.actorId,
      `Bulk corrected to ${categoryId}`,
    );

    // Update local cache and remove consumed items
    const consumedIds = new Set<string>();
    for (const r of correctResults) {
      if (r.success && r.item) {
        consumedIds.add(r.itemId);
        this.replaceItemById(r.item);
      }
    }

    this.items = this.items.filter(i => !consumedIds.has(i.reviewItem.id));
    this.selectedIndices.clear();
    if (this.currentIndex >= this.items.length) {
      this.currentIndex = Math.max(0, this.items.length - 1);
    }

    this.metrics.record({
      type: 'bulk_action',
      itemId: null,
      timestamp: new Date().toISOString(),
    });
    this.notify();

    return correctResults;
  }

  private async doBulkStatusTransition(
    toStatus: ReviewStatus,
    reason: string,
  ): Promise<TransitionReviewResult[]> {
    const selected = this.getSelectedItems();

    if (selected.length === 0) {
      // Nothing selected — act on current item
      if (toStatus === 'approved') await this.doApprove();
      else if (toStatus === 'rejected') await this.doReject();
      else if (toStatus === 'skipped') await this.doSkip();
      else if (toStatus === 'correcting') {
        await this.doCorrect('corrected');
      }
      return [];
    }

    this.requireHomogeneous(selected);

    // Enforce that all selected items are in the expected starting status.
    // Bulk approve/reject/skip require pending_review; the store's
    // transitionReviewItems also rejects invalid transitions, but we check
    // eagerly here for a clearer error.
    const expectedStatus: ReviewStatus = 'pending_review';
    const badItems = selected.filter(
      i => i.reviewItem.status !== expectedStatus,
    );
    if (badItems.length > 0) {
      const badIds = badItems.map(i => i.reviewItem.id.slice(0, 8)).join(', ');
      throw new ReviewActionError(
        'heterogeneous_selection',
        `Bulk ${toStatus} requires all items to be ${expectedStatus}; ` +
          `${badItems.length} item(s) have different status (${badIds})`,
        false,
      );
    }

    const ids = selected.map(i => i.reviewItem.id);
    const results = await this.store.transitionReviewItems(
      ids,
      toStatus,
      this.config.actorId,
      reason,
    );

    // Update local cache for any items that were successfully transitioned
    const consumedIds = new Set<string>();
    for (const r of results) {
      if (r.success && r.item) {
        consumedIds.add(r.itemId);
        this.replaceItemById(r.item);
      }
    }

    // Remove consumed items from the queue
    this.items = this.items.filter(i => !consumedIds.has(i.reviewItem.id));
    this.selectedIndices.clear();

    // Clamp currentIndex
    if (this.currentIndex >= this.items.length) {
      this.currentIndex = Math.max(0, this.items.length - 1);
    }

    this.metrics.record({
      type: 'bulk_action',
      itemId: null,
      timestamp: new Date().toISOString(),
    });
    this.notify();

    return results;
  }

  // ── Navigation ───────────────────────────────────────────────────────

  private doSelectNext(): void {
    if (this.items.length === 0) return;
    if (this.currentIndex < this.items.length - 1) {
      this.currentIndex++;
      this.notify();
    }
  }

  private doSelectPrevious(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.notify();
    }
  }

  private doToggleSelection(index: number): void {
    if (this.selectedIndices.has(index)) {
      this.selectedIndices.delete(index);
    } else {
      this.selectedIndices.add(index);
    }
    this.notify();
  }

  private doClearSelection(): void {
    this.selectedIndices.clear();
    this.notify();
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private requireCurrentItem(): ReviewQueueItem {
    if (this.items.length === 0 || this.currentIndex >= this.items.length) {
      throw new ReviewActionError(
        'no_current',
        'No current item to act on. Load the queue first.',
        false,
      );
    }
    return this.items[this.currentIndex];
  }

  private requireHomogeneous(items: ReviewQueueItem[]): void {
    const info = checkHomogeneity(items);
    if (!info.homogeneous) {
      throw new ReviewActionError(
        'heterogeneous_selection',
        `Cannot bulk-act on heterogeneous selection: ${info.conflictReason}`,
        false,
      );
    }
  }

  private getSelectedItems(): ReviewQueueItem[] {
    return [...this.selectedIndices]
      .filter(i => i < this.items.length)
      .map(i => this.items[i]);
  }

  private async transitionItem(
    item: ReviewQueueItem,
    toStatus: ReviewStatus,
    reason: string,
  ): Promise<void> {
    const transitionInput: TransitionReviewInput = {
      toStatus,
      actor: this.config.actorId,
      reason,
      expectedVersion: item.reviewItem.version,
    };
    const updated = await this.store.transitionReviewItem(
      item.reviewItem.id,
      transitionInput,
    );
    this.replaceItem(item, updated);
  }

  private replaceItem(oldItem: ReviewQueueItem, updated: ReviewItem): void {
    const idx = this.items.indexOf(oldItem);
    if (idx !== -1) {
      this.items[idx] = this.buildQueueItemSync(updated);
    }
  }

  private replaceItemById(updated: ReviewItem): void {
    const idx = this.items.findIndex(i => i.reviewItem.id === updated.id);
    if (idx !== -1) {
      this.items[idx] = this.buildQueueItemSync(updated);
    }
  }

  /** Remove the current item from the queue and advance to the next. */
  private advanceAfterAction(): void {
    // Save the consumed item ID for potential undo
    if (this.currentIndex < this.items.length) {
      this.lastActedItemId = this.items[this.currentIndex].reviewItem.id;
    }
    this.items = this.items.filter((_, i) => i !== this.currentIndex);
    if (this.currentIndex >= this.items.length) {
      this.currentIndex = Math.max(0, this.items.length - 1);
    }
    this.notify();
  }

  // ── Queue item construction ──────────────────────────────────────────

  private async buildQueueItem(
    raw: ReviewItem,
  ): Promise<ReviewQueueItem> {
    const evidence = await this.buildEvidence(raw);
    const item: ReviewQueueItem = {
      reviewItem: raw,
      evidence,
      homogeneity: {
        homogeneous: true,
        commonStatus: raw.status,
        commonCategory: raw.categoryId,
        commonClassifier: raw.classifier,
        groupSize: 1,
        conflictReason: null,
      },
      actionable: isActionable(raw.status),
    };
    return item;
  }

  private buildQueueItemSync(raw: ReviewItem): ReviewQueueItem {
    const evidence = this.buildEvidenceSync(raw);
    return {
      reviewItem: raw,
      evidence,
      homogeneity: {
        homogeneous: true,
        commonStatus: raw.status,
        commonCategory: raw.categoryId,
        commonClassifier: raw.classifier,
        groupSize: 1,
        conflictReason: null,
      },
      actionable: isActionable(raw.status),
    };
  }

  private async buildEvidence(
    item: ReviewItem,
  ): Promise<ReviewEvidence> {
    const base = extractEvidence(item);
    const enrichment = this.config.enrichEvidence(item);
    if (enrichment instanceof Promise) {
      const resolved = await enrichment;
      return { ...base, ...resolved };
    }
    return { ...base, ...enrichment };
  }

  private buildEvidenceSync(item: ReviewItem): ReviewEvidence {
    const base = extractEvidence(item);
    const enrichment = this.config.enrichEvidence(item);
    if (enrichment instanceof Promise) {
      // Cannot await synchronously; enrichment may be async.
      // Return base evidence without enrichment in the sync path.
      return base;
    }
    return { ...base, ...enrichment };
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Swallow listener errors to keep the controller responsive
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown by the review controller for actionable failures. */
export class ReviewActionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ReviewActionError';
    this.code = code;
    this.retryable = retryable;
  }
}
