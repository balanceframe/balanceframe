/**
 * Focused tests for the API-backed ReviewControllerAdapter.
 *
 * Verifies:
 * - Session credential header propagation
 * - Malformed / non-JSON envelope rejection
 * - Exact proposal snapshots retained without consuming pending queue items
 * - Failed transitions preserve queue items; confirmed reject/skip refresh state
 *
 * All tests mock fetch; no Nitro runtime or WorkflowStore needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { effectScope } from 'vue';

import { useApiReviewController } from '../composables/useApiReviewController';
import type { ApiReviewControllerAdapter, ReviewControllerAdapter } from '../types/review-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal review queue item shape that the surface state expects. */
function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewItem: {
      id: 'item-001',
      budgetId: 'budget-test',
      transactionId: 'txn-001',
      categoryId: 'cat-food',
      classifier: 'test',
      provenance: 'test',
      status: 'pending_review',
      version: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      ...overrides,
    },
    evidence: {
      amount: 5000,
      currency: 'USD',
      description: 'Test transaction',
      history: [],
      provenance: 'test',
      freshness: null,
      changePreview: { field: null, oldValue: null, newValue: null },
      correlationId: null,
      promptVersion: '1',
    },
    homogeneity: {
      homogeneous: true,
      commonStatus: 'pending_review',
      commonCategory: 'cat-food',
      commonClassifier: 'test',
      groupSize: 1,
      conflictReason: null,
    },
    actionable: true,
  };
}

/** A valid ok envelope wrapping any result payload. */
function okEnvelope(result: unknown) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  };
}

/** A valid error envelope. */
function errorEnvelope(code: string, message: string, retryable = false) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message, retryable },
  };
}

/** A valid SingleActionResult for a successful action. */
function successResult(itemId: string): { itemId: string; success: true; error: null } {
  return { itemId, success: true, error: null };
}

/** A valid SingleActionResult for a failed action (result-level). */
function failureResult(
  itemId: string,
  errorMsg: string,
): { itemId: string; success: false; error: string } {
  return { itemId, success: false, error: errorMsg };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useApiReviewController', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Headers / credentials ───────────────────────────────────────

  describe('headers and credentials', () => {
    it('sends same-origin credentials by default', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.credentials).toBe('same-origin');
    });

    it('sets Authorization Bearer header when getSessionToken is provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local', {
        getSessionToken: () => 'test-token-abc',
      });
      await adapter.loadNextPage();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers).toBeInstanceOf(Object);
      expect(opts.headers['Authorization']).toBe('Bearer test-token-abc');
    });

    it('omits Authorization header when getSessionToken returns null', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local', {
        getSessionToken: () => null,
      });
      await adapter.loadNextPage();

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers?.['Authorization']).toBeUndefined();
    });

    it('never sends actorId in request body', async () => {
      // First load: seed an item into state
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      // Second call: action request that should NOT include actorId
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(failureResult('item-001', 'No exact proposal returned'))),
      });

      await adapter.approve();

      // Verify the action POST body does not contain actorId
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, opts] = fetchMock.mock.calls[1];
      const body = JSON.parse(opts.body as string);
      expect(body).not.toHaveProperty('actorId');
    });
  });

  // ── Malformed envelope handling ─────────────────────────────────

  describe('malformed envelopes', () => {
    it('rejects non-JSON response body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
      expect(adapter.error).toContain('non-JSON');
    });

    it('rejects empty body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(null),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
    });

    it('rejects envelope missing status field', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requestId: 'x' }),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
      expect(adapter.error).toContain('invalid');
    });

    it('rejects envelope with invalid status value', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'maybe', requestId: 'x', result: null, error: null }),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
    });
  });

  // ── Result-level failure propagation ────────────────────────────

  describe('result-level failure propagation', () => {
    async function setupWithItem(): Promise<ReviewControllerAdapter> {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      return adapter;
    }

    it('propagates result.success=false to error state and WebActionResult', async () => {
      const adapter = await setupWithItem();

      // Now seed the POST mock for an action that returns result-level failure
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(okEnvelope(failureResult('item-001', 'Workflow transition rejected'))),
      });

      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Workflow transition rejected');
      expect(adapter.error).toBe('Workflow transition rejected');
    });

    it('propagates envelope-level error to error state', async () => {
      const adapter = await setupWithItem();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve(errorEnvelope('INTERNAL', 'Server error occurred')),
      });

      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Server error');
      expect(adapter.error).toContain('Server error');
    });
  });
  describe('explicit proposal review', () => {
    const proposalApproval = {
      id: 'proposal-001',
      operation: 'set_category',
      spaceId: 'space-001',
      budgetId: 'budget-001',
      requesterActorId: 'requester-001',
      requesterMembershipId: 'membership-001',
      governancePolicyVersion: 'governance-4',
      currentGovernancePolicyVersion: 'governance-4',
      requesterMembershipCurrent: true,
      policyVersion: 'financial-7',
      payloadHash: 'a'.repeat(64),
      privateEnvelopeVisible: true,
      payload: { kind: 'set_category', transactionId: 'transaction-001', categoryId: 'cat-food' },
      preconditions: { transactionVersion: 3, currentCategoryId: 'cat-other' },
      expiresAt: '2026-10-03T12:00:00.000Z',
      requiredApprovers: 2,
      approvers: [{ actorId: 'reviewer-002', issuedAt: '2026-10-02T11:00:00.000Z', expiresAt: '2026-10-03T12:00:00.000Z' }],
      disposition: 'approval_required',
      canApprove: true,
      canExecute: true,
    };

    async function setupWithOneItem(): Promise<ApiReviewControllerAdapter> {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      return adapter;
    }

    it.each(['denied', 'malformed', 'offline'])('clears private queue, selection and proposal actions after a %s list reload', async (failure) => {
      const adapter = await setupWithOneItem();
      adapter.toggleSelection(0);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({
          itemId: 'item-001', success: false, disposition: 'approval_required',
          approvalRequired: true, applied: false, verified: false,
          categorizationExecuted: false, proposal: proposalApproval,
        })),
      });
      await adapter.approve();
      expect(adapter.proposalApprovalViews[0]?.proposal.payload).toEqual(proposalApproval.payload);
      expect(adapter.state.currentItem?.evidence.description).toBe('Test transaction');
      if (failure === 'offline') fetchMock.mockRejectedValueOnce(new Error('Offline'));
      else fetchMock.mockResolvedValueOnce({
        ok: failure !== 'denied', status: failure === 'denied' ? 403 : 200,
        json: () => Promise.resolve(failure === 'denied' ? errorEnvelope('DENIED', 'Queue denied') : okEnvelope(null)),
      });

      await adapter.loadNextPage();

      expect(adapter.state.items).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
      expect(adapter.state.currentIndex).toBe(-1);
      expect(adapter.state.selectedIndices).toEqual([]);
      expect(adapter.state.selectionHomogeneity.homogeneous).toBe(false);
      expect(adapter.proposalApprovalViews).toEqual([]);
      expect(adapter.error).not.toBeNull();
      expect(adapter.loading).toBe(false);
      const requests = fetchMock.mock.calls.length;
      expect((await adapter.approve()).success).toBe(false);
      expect((await adapter.correct('cat-other')).success).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(requests);
    });

    it('does not republish an earlier private list after a newer denied refresh clears it', async () => {
      const adapter = await setupWithOneItem();
      const { promise, resolve } = Promise.withResolvers<unknown>();
      fetchMock.mockReturnValueOnce(promise);
      const oldLoad = adapter.loadNextPage();
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 403,
        json: () => Promise.resolve(errorEnvelope('DENIED', 'Queue denied')),
      });
      await adapter.refresh();
      expect(adapter.state.items).toEqual([]);
      resolve({ ok: true, json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })) });
      await oldLoad;
      expect(adapter.state.items).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
      expect(adapter.error).toContain('Queue denied');
    });

    it.each([
      'approve', 'correct', 'proposeRule', 'bulkApprove', 'bulkCorrect',
      'reject', 'skip', 'bulkReject', 'bulkSkip', 'undo',
    ] as const)('discards a late %s completion after a denied list invalidates its private lifetime', async (action) => {
      const adapter = await setupWithOneItem();
      adapter.toggleSelection(0);
      if (action === 'undo') {
        fetchMock.mockResolvedValueOnce({
          ok: true, json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
        });
        await adapter.skip();
      }
      const { promise, resolve } = Promise.withResolvers<unknown>();
      fetchMock.mockReturnValueOnce(promise);
      const pending = action === 'correct' ? adapter.correct('cat-other')
        : action === 'bulkCorrect' ? adapter.bulkCorrect('cat-other')
        : action === 'proposeRule' ? adapter.proposeRule('item-001', 'cat-other')
        : adapter[action]();
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 403,
        json: () => Promise.resolve(errorEnvelope('DENIED', 'Queue denied')),
      });
      await adapter.loadNextPage();
      const requests = fetchMock.mock.calls.length;
      resolve({
        ok: true,
        json: () => Promise.resolve(okEnvelope(
          ['reject', 'skip', 'bulkReject', 'bulkSkip', 'undo'].includes(action)
            ? successResult('item-001')
            : {
                itemId: 'item-001', success: false, disposition: 'approval_required',
                approvalRequired: true, applied: false, verified: false,
                categorizationExecuted: false,
                proposal: action === 'proposeRule' ? { ...proposalApproval, operation: 'create_rule' } : proposalApproval,
              },
        )),
      });
      const result = await pending;
      if ('results' in result) {
        expect(result.results).toEqual([]);
        expect(result.consumedCount).toBe(0);
        expect(result.errorCount).toBe(1);
      } else {
        expect(result.approvalRequired).not.toBe(true);
        expect(result.success).toBe(false);
      }
      expect(fetchMock).toHaveBeenCalledTimes(requests);
      expect(adapter.proposalApprovalViews).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
    });

    it('cannot revive private review data after disposal for the selected-space full-page reload', async () => {
      const scope = effectScope();
      const adapter = scope.run(() => useApiReviewController('http://test.local'))!;
      fetchMock.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });
      await adapter.loadNextPage();
      expect(adapter.state.currentItem?.evidence.description).toBe('Test transaction');
      const { promise, resolve } = Promise.withResolvers<unknown>();
      fetchMock.mockReturnValueOnce(promise);
      const oldLoad = adapter.loadNextPage();
      scope.stop();
      expect(adapter.state.items).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
      resolve({ ok: true, json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })) });
      await oldLoad;
      expect(adapter.state.items).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
      expect(adapter.proposalApprovalViews).toEqual([]);
    });

    it('retains the exact proposal without consuming or resolving the pending review item', async () => {
      const adapter = await setupWithOneItem();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope({
              itemId: 'item-001',
              mutationStatus: 'approval_required',
              success: false,
              approvalRequired: true,
              applied: false,
              verified: false,
              categorizationExecuted: false,
              disposition: 'approval_required',
              proposal: proposalApproval,
            }),
          ),
      });
      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.approvalRequired).toBe(true);
      expect(adapter.state.items.map((item) => item.reviewItem.id)).toEqual(['item-001']);
      expect(adapter.state.currentItem?.reviewItem.id).toBe('item-001');
      expect(adapter.state.metrics.resolvedCount).toBe(0);
      expect(adapter.proposalApprovalViews).toEqual([{ reviewId: 'item-001', proposal: proposalApproval }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retains a category-correction proposal instead of recording an accepted correction', async () => {
      const adapter = await setupWithOneItem();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope({
              itemId: 'item-001',
              mutationStatus: 'approval_required',
              success: false,
              approvalRequired: true,
              applied: false,
              verified: false,
              categorizationExecuted: false,
              disposition: 'approval_required',
              proposal: { ...proposalApproval, payload: { ...proposalApproval.payload, categoryId: 'cat-new' } },
            }),
          ),
      });
      const result = await adapter.correct('cat-new');

      expect(result.success).toBe(false);
      expect(result.approvalRequired).toBe(true);
      expect(adapter.state.items.map((item) => item.reviewItem.id)).toEqual(['item-001']);
      expect(adapter.state.metrics.resolvedCount).toBe(0);
      expect(adapter.proposalApprovalViews[0]?.proposal.payload).toMatchObject({
        transactionId: 'transaction-001',
        categoryId: 'cat-new',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('starts bulk review proposals in selected order and retains every pending review item', async () => {
      const reviewIds = ['item-001', 'item-002'];
      const items = reviewIds.map((id) => makeItem({ id }));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items, total: items.length })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      adapter.toggleSelection(0);
      adapter.toggleSelection(1);
      const proposalViews = reviewIds.map((reviewId, index) => ({
        ...proposalApproval,
        id: `proposal-00${index + 1}`,
        payloadHash: String(index + 1).repeat(64),
        preconditions: { reviewId },
      }));
      for (const proposal of proposalViews) {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve(
              okEnvelope({
                itemId: proposal.preconditions.reviewId,
                success: false,
                approvalRequired: true,
                applied: false,
                verified: false,
                categorizationExecuted: false,
                disposition: 'approval_required',
                proposal,
              }),
            ),
        });
      }

      const result = await adapter.bulkApprove();

      expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
        'http://test.local/api/review/approve',
        'http://test.local/api/review/approve',
      ]);
      expect(fetchMock.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body as string))).toEqual([
        { reviewId: 'item-001' },
        { reviewId: 'item-002' },
      ]);
      expect(adapter.proposalApprovalViews).toEqual(
        proposalViews.map((proposal, index) => ({ reviewId: reviewIds[index]!, proposal })),
      );
      expect(adapter.state.items.map((item) => item.reviewItem.id)).toEqual(['item-001', 'item-002']);
      expect(adapter.state.metrics.resolvedCount).toBe(0);
      expect(result.consumedCount).toBe(0);
    });
    it('starts ordered bulk correction proposals without changing either pending review item', async () => {
      const reviewIds = ['item-001', 'item-002'];
      const items = reviewIds.map((id) => makeItem({ id }));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items, total: items.length })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      adapter.toggleSelection(1);
      adapter.toggleSelection(0);
      const selectedIds = [reviewIds[1]!, reviewIds[0]!];
      for (const [index, reviewId] of selectedIds.entries()) {
        const proposal = {
          ...proposalApproval,
          id: `correction-${index}`,
          payloadHash: `${index + 3}`.repeat(64),
          payload: { ...proposalApproval.payload, categoryId: 'cat-target' },
          preconditions: { reviewId },
        };
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve(
              okEnvelope({
                itemId: reviewId,
                success: false,
                approvalRequired: true,
                applied: false,
                verified: false,
                categorizationExecuted: false,
                disposition: 'approval_required',
                proposal,
              }),
            ),
        });
      }

      const result = await adapter.bulkCorrect('cat-target');

      expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
        'http://test.local/api/review/correct',
        'http://test.local/api/review/correct',
      ]);
      expect(fetchMock.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body as string))).toEqual([
        { reviewId: 'item-002', categoryId: 'cat-target' },
        { reviewId: 'item-001', categoryId: 'cat-target' },
      ]);
      expect(adapter.proposalApprovalViews.map((entry) => entry.reviewId)).toEqual([
        'item-002',
        'item-001',
      ]);
      expect(adapter.state.items.map((item) => item.reviewItem.id)).toEqual(['item-001', 'item-002']);
      expect(adapter.state.metrics.resolvedCount).toBe(0);
      expect(result.consumedCount).toBe(0);
    });

    describe('rule proposals', () => {
      const ruleProposal = Object.freeze({
        ...proposalApproval,
        id: 'rule-proposal-001',
        operation: 'create_rule',
        payload: Object.freeze({
          kind: 'create_rule',
          transactionId: 'transaction-001',
          categoryId: 'cat-server',
          rule: Object.freeze({
            name: 'Server-normalized merchant',
            conditions: Object.freeze([
              Object.freeze({ field: 'payee', operation: 'contains', value: 'Server merchant' }),
            ]),
          }),
        }),
        preconditions: Object.freeze({ transactionVersion: 3, actualVersion: 'actual-7' }),
        approvers: Object.freeze(proposalApproval.approvers.map((approver) => Object.freeze({ ...approver }))),
      });

      it('retains immutable server snapshots without deriving a rule from inputs or consuming the queue', async () => {
        const adapter = await setupWithOneItem();
        adapter.toggleSelection(0);
        adapter.setError('PREVIOUS', 'Previous request failed');
        const queue = adapter.state;
        const originalProposal = JSON.stringify(ruleProposal);
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(okEnvelope({
            proposal: ruleProposal,
            simulationStatus: 'complete',
          })),
        });

        const pending = adapter.proposeRule('item-001', 'cat-input');
        expect(adapter.loading).toBe(true);
        expect(adapter.error).toBeNull();
        expect(adapter.state).toBe(queue);
        const result = await pending;

        expect(result).toEqual({
          itemId: 'rule-proposal-001',
          success: true,
          error: null,
          approvalRequired: true,
          simulationStatus: 'complete',
          simulationWarning: null,
        });
        expect(adapter.proposalApprovalViews).toEqual([{ reviewId: 'item-001', proposal: ruleProposal }]);
        expect(adapter.proposalApprovalViews[0]?.proposal).toBe(ruleProposal);
        expect(adapter.proposalApprovalViews[0]?.proposal.payload).toBe(ruleProposal.payload);
        expect(JSON.stringify(ruleProposal)).toBe(originalProposal);
        expect(adapter.state).toBe(queue);
        expect(adapter.state.selectedIndices).toEqual([0]);
        expect(adapter.state.metrics.resolvedCount).toBe(0);
        expect(adapter.loading).toBe(false);
        expect(adapter.error).toBeNull();
        expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
          reviewId: 'item-001', categoryId: 'cat-input',
        });

        const previousViews = adapter.proposalApprovalViews;
        const replacement = Object.freeze({ ...ruleProposal, id: 'rule-proposal-002', payloadHash: 'b'.repeat(64) });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(okEnvelope({
            proposal: replacement,
            simulationStatus: 'unavailable',
            simulationWarning: 'Simulation data is stale',
          })),
        });
        const replacementResult = await adapter.proposeRule('item-001', 'cat-other');

        expect(replacementResult).toMatchObject({
          itemId: replacement.id,
          success: true,
          approvalRequired: true,
          simulationStatus: 'unavailable',
          simulationWarning: 'Simulation data is stale',
        });
        expect(adapter.proposalApprovalViews).toEqual([{ reviewId: 'item-001', proposal: replacement }]);
        expect(adapter.proposalApprovalViews[0]?.proposal).toBe(replacement);
        expect(previousViews).toEqual([{ reviewId: 'item-001', proposal: ruleProposal }]);
        expect(adapter.state).toBe(queue);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });

      const invalidProposalError = 'The server did not return an exact rule proposal for review.';
      const failures: { name: string; response?: unknown; rejection?: unknown; error: string }[] = [
        { name: 'envelope denial', response: errorEnvelope('DENIED', 'Rule creation denied'), error: 'Rule creation denied' },
        { name: 'missing result', response: okEnvelope(null), error: invalidProposalError },
        { name: 'missing exact proposal', response: okEnvelope({ proposal: { id: 'rule-summary' } }), error: invalidProposalError },
        { name: 'invalid payload hash', response: okEnvelope({ proposal: { ...ruleProposal, payloadHash: 'invalid' } }), error: invalidProposalError },
        { name: 'category proposal instead of rule', response: okEnvelope({ proposal: proposalApproval }), error: invalidProposalError },
        { name: 'denied rule proposal', response: okEnvelope({ proposal: { ...ruleProposal, disposition: 'denied' } }), error: invalidProposalError },
        { name: 'transport rejection', rejection: new Error('Connection lost'), error: 'Connection lost' },
      ];

      it.each(failures)('preserves the queue and prior exact proposal after $name', async ({ response, rejection, error }) => {
        const adapter = await setupWithOneItem();
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(okEnvelope({ proposal: ruleProposal })),
        });
        await adapter.proposeRule('item-001', 'cat-food');
        const queue = adapter.state;
        const retained = adapter.proposalApprovalViews;
        if (rejection !== undefined) {
          fetchMock.mockRejectedValueOnce(rejection);
        } else {
          fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(response),
          });
        }

        const pending = adapter.proposeRule('item-001', 'cat-new');
        expect(adapter.loading).toBe(true);
        expect(adapter.error).toBeNull();
        const result = await pending;

        expect(result).toEqual({ itemId: 'item-001', success: false, error });
        expect(adapter.error).toBe(error);
        expect(adapter.loading).toBe(false);
        expect(adapter.state).toBe(queue);
        expect(adapter.state.currentItem?.reviewItem.id).toBe('item-001');
        expect(adapter.proposalApprovalViews).toBe(retained);
        expect(adapter.proposalApprovalViews[0]?.proposal).toBe(ruleProposal);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    });

  });


  // ── No-current-item guard ───────────────────────────────────────

  describe('no-current-item guard', () => {
    it('returns failure when no current item exists', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toContain('No current item');
      expect(adapter.error).toContain('No current item');
    });

    it('returns failure for correct when no current item', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.correct('cat-office');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No current item');
    });

    it('returns failure for reject when no current item', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.reject();

      expect(result.success).toBe(false);
    });

    it('returns failure for skip when no current item', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.skip();

      expect(result.success).toBe(false);
    });
  });

  describe('bulk non-model review transitions', () => {
    it('refreshes after confirmed rejects and keeps failed items in the queue', async () => {
      const items = [makeItem({ id: 'item-001' }), makeItem({ id: 'item-002' })];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items, total: items.length })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      adapter.toggleSelection(0);
      adapter.toggleSelection(1);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(failureResult('item-002', 'Reject was denied'))),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(okEnvelope({ items: [items[1]], total: 1 })),
      });

      const result = await adapter.bulkReject();

      expect(result.consumedCount).toBe(1);
      expect(result.errorCount).toBe(1);
      expect(result.results).toEqual([
        { itemId: 'item-001', success: true, error: null },
        { itemId: 'item-002', success: false, error: 'Reject was denied' },
      ]);
      expect(adapter.state.items.map((item) => item.reviewItem.id)).toEqual(['item-002']);
    });

    it('consumes a skipped item only after its server transition succeeds', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      adapter.toggleSelection(0);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const result = await adapter.bulkSkip();

      expect(result.consumedCount).toBe(1);
      expect(result.errorCount).toBe(0);
      expect(adapter.state.items).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
    });
  });

  describe('undo state transitions', () => {
    const failures: { name: string; response?: unknown; rejection?: unknown; error: string }[] = [
      { name: 'envelope denial', response: errorEnvelope('DENIED', 'Undo denied'), error: 'Undo denied' },
      { name: 'malformed result', response: okEnvelope(null), error: 'Invalid undo result envelope' },
      { name: 'failed transition', response: okEnvelope(failureResult('item-001', 'Transition rejected')), error: 'Transition rejected' },
      { name: 'failure without details', response: okEnvelope({ success: false }), error: 'Undo failed' },
      { name: 'transport rejection', rejection: 'Offline', error: 'Offline' },
    ];

    it.each(failures)('preserves the remaining queue and permits retry after $name', async ({ response, rejection, error }) => {
      const items = [makeItem(), makeItem({ id: 'item-002', transactionId: 'txn-002' })];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items, total: 2 })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
      });
      await adapter.reject();
      const remaining = adapter.state;
      expect(remaining.items.map((item) => item.reviewItem.id)).toEqual(['item-002']);
      if (rejection !== undefined) {
        fetchMock.mockRejectedValueOnce(rejection);
      } else {
        fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(response) });
      }

      const pending = adapter.undo();
      expect(adapter.loading).toBe(true);
      expect(adapter.error).toBeNull();
      const failed = await pending;

      expect(failed).toEqual({ itemId: 'item-001', success: false, error });
      expect(adapter.error).toBe(error);
      expect(adapter.loading).toBe(false);
      expect(adapter.state).toBe(remaining);
      expect(adapter.state.currentItem?.reviewItem.id).toBe('item-002');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string)).toEqual({ reviewId: 'item-001' });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ itemId: null, success: true, error: null })),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items, total: 2 })),
      });
      const retry = adapter.undo();
      expect(adapter.loading).toBe(true);
      expect(adapter.error).toBeNull();
      expect(adapter.state).toBe(remaining);
      expect(await retry).toEqual({ itemId: 'item-001', success: true, error: null });
      expect(adapter.state.items.map((item) => item.reviewItem.id)).toEqual(['item-001', 'item-002']);
      expect(adapter.state.currentItem?.reviewItem.id).toBe('item-001');
      expect(adapter.state.currentIndex).toBe(0);
      expect(adapter.loading).toBe(false);
      expect(adapter.error).toBeNull();
      expect(fetchMock.mock.calls[4]![0]).toBe('http://test.local/api/review');

      const restored = adapter.state;
      expect(await adapter.undo()).toEqual({
        itemId: 'item-001',
        success: false,
        error: 'No item to undo. Act on an item first.',
      });
      expect(adapter.state).toBe(restored);
      expect(adapter.loading).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('restores the last consumed item from an empty queue and cannot replay it', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });
      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
      });
      await adapter.skip();
      expect(adapter.state.items).toEqual([]);
      expect(adapter.state.currentItem).toBeNull();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem({ version: 5 })], total: 1 })),
      });

      expect(await adapter.undo()).toEqual({ itemId: 'item-001', success: true, error: null });
      expect(adapter.state.currentItem?.reviewItem.version).toBe(5);
      expect(adapter.state.currentIndex).toBe(0);
      expect(adapter.state.items).toHaveLength(1);
      expect(adapter.loading).toBe(false);
      expect(adapter.error).toBeNull();
      const restored = adapter.state;
      expect((await adapter.undo()).success).toBe(false);
      expect(adapter.state).toBe(restored);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('undo without an acted item', () => {
    it('returns failure when no item has been acted on', async () => {
      const adapter = useApiReviewController('http://test.local');
      const result = await adapter.undo();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Act on an item first');
      expect(adapter.error).toContain('Act on an item first');
    });
  });
});
