import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type * as Workflow from '../../server/utils/workflow-store';
import type * as H3 from 'h3';
import fixture from '../../../../protocol/fixtures/representative.json';

vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));

const actor = 'reviewer';
const transaction = fixture.transactions[0]!;
const category = fixture.transactions[1]!.categoryId!;
const routes = ['approve', 'correct', 'reject', 'skip', 'undo'] as const;
type Route = (typeof routes)[number];
let workflow: typeof Workflow;
let store: SqliteWorkflowStore;
interface RequestEvent {
  body: unknown;
  node: { res: { statusCode: number; statusMessage: string } };
  context: {
    auth: { authenticated: boolean; user: { id: string }; actorId: string };
    runtimeConfig: { workflowDbPath: string; reviewAndApply: boolean };
  };
}
let handlers: Record<
  Route,
  (event: RequestEvent) => Promise<Workflow.ApiEnvelope<Record<string, unknown>>>
>;
function event(body: unknown, actorId = actor, reviewAndApply = false) {
  return {
    body,
    node: { res: { statusCode: 200, statusMessage: '' } },
    context: {
      auth: { authenticated: true, user: { id: actorId }, actorId: 'spoofed-legacy' },
      runtimeConfig: { workflowDbPath: ':memory:', reviewAndApply },
    },
  };
}
async function pending(reviewersRequired = 1) {
  let item = await store.createReviewItem({
    transactionId: transaction.id,
    budgetId: 'fixture-budget',
    categoryId: transaction.categoryId!,
    classifier: 'fixture',
    provenance: 'test',
    reviewersRequired,
    evidence: { normalizedMerchant: transaction.payeeName, amount: transaction.amount },
  });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const) {
    vi.setSystemTime(Date.now() + 1000);
    item = await store.transitionReviewItem(item.id, {
      toStatus,
      actor,
      expectedVersion: item.version,
    });
  }
  vi.setSystemTime(Date.now() + 1000);
  return item;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  // Reloading intentionally isolates the module-owned SQLite singleton between cases.
  vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
  workflow = await import('../../server/utils/workflow-store');
  const result = workflow.getWorkflowStore(event({}));
  if ('error' in result) throw new Error(result.error);
  store = result.store;
  await store.upsertActorMembership(actor, 'active', ['categorization:execute'], '*');
  handlers = Object.fromEntries(
    await Promise.all(
      routes.map(async (route) => [
        route,
        (await import(`../../server/api/review/${route}.post.ts`)).default,
      ]),
    ),
  ) as typeof handlers;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  store.close();
});

describe.each(routes)('POST review/%s boundary', (route) => {
  it('rejects malformed JSON without changing an existing review', async () => {
    const item = await pending();
    const request = event(new SyntaxError('malformed body'));
    const response = await handlers[route](request);
    expect(request.node.res.statusCode).toBe(400);
    expect(response.error.code).toBe('INVALID_JSON');
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });
  it('rejects blank review identifiers before workflow action', async () => {
    const request = event({ reviewId: '  ', categoryId: category });
    expect((await handlers[route](request)).error.code).toBe('MISSING_REVIEW_ID');
    expect(request.node.res.statusCode).toBe(422);
  });
  it('reports a missing review without a successful action', async () => {
    const request = event({ reviewId: 'absent', categoryId: category });
    expect((await handlers[route](request)).error.code).toBe('NOT_FOUND');
    expect(request.node.res.statusCode).toBe(404);
  });
  it('rechecks current membership and rejects a revoked reviewer', async () => {
    const item = await pending();
    await store.upsertActorMembership(actor, 'revoked', ['categorization:execute'], '*');
    const request = event({ reviewId: item.id, categoryId: category }, actor, true);
    const executor = vi.fn();
    workflow.setReviewMutationExecutor(executor);
    const response = await handlers[route](request);
    expect(request.node.res.statusCode).toBe(403);
    expect(response.error.code).toBe('FORBIDDEN');
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect(executor).not.toHaveBeenCalled();
  });
  it('does not accept an authenticated identity from the request body', async () => {
    const item = await pending();
    const request = event({ reviewId: item.id, categoryId: category, actorId: actor });
    request.context.auth.authenticated = false;
    expect((await handlers[route](request)).error.code).toBe('AUTHORIZATION_REQUIRED');
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });
  it('reports unavailable workflow storage after authorization', async () => {
    vi.spyOn(workflow, 'getWorkflowStore').mockReturnValue({ error: 'Store unavailable' });
    const request = event({ reviewId: 'review', categoryId: category });
    expect((await handlers[route](request)).error.code).toBe('STORE_UNAVAILABLE');
    expect(request.node.res.statusCode).toBe(503);
  });
  it('does not turn an irreversible superseded review into a success', async () => {
    const item = await pending();
    await store.transitionReviewItem(item.id, {
      toStatus: 'superseded',
      actor,
      expectedVersion: item.version,
    });
    const request = event({ reviewId: item.id, categoryId: category });
    const response = await handlers[route](request);
    expect(response.error.code).toBe('ACTION_FAILED');
    expect(request.node.res.statusCode).toBe(500);
    expect((await store.getReviewItem(item.id))?.status).toBe('superseded');
  });
});

describe('real review transitions through route handlers', () => {
  it.each([
    ['approve', 'approved'],
    ['correct', 'correcting'],
    ['reject', 'rejected'],
    ['skip', 'skipped'],
  ] as const)(
    '%s persists a workflow-only transition under the session identity',
    async (route, status) => {
      const item = await pending();
      const executor = vi.fn();
      workflow.setReviewMutationExecutor(executor);
      const request = event(
        { reviewId: ` ${item.id} `, categoryId: ` ${category} `, actorId: 'forged' },
        actor,
        route === 'reject' || route === 'skip',
      );
      const response = await handlers[route](request);
      expect(response.status).toBe('ok');
      expect(response.result).toMatchObject({ categorizationExecuted: false, applied: false });
      const persisted = await store.getReviewItem(item.id);
      expect(persisted?.status).toBe(status);
      if (route === 'approve') expect(persisted?.approvedBy).toEqual([actor]);
      if (route === 'correct') expect(persisted?.categoryId).toBe(category);
      expect(executor).not.toHaveBeenCalled();
    },
  );
  it('undo restores a skipped review to the queue without invoking a ledger mutation', async () => {
    const item = await pending();
    await handlers.skip(event({ reviewId: item.id }));
    vi.setSystemTime(Date.now() + 1000);
    const executor = vi.fn();
    workflow.setReviewMutationExecutor(executor);
    const response = await handlers.undo(event({ reviewId: item.id }, actor, true));
    expect(response.status).toBe('ok');
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
    expect(executor).not.toHaveBeenCalled();
  });
  it('requires a correction category before changing workflow state', async () => {
    const item = await pending();
    const request = event({ reviewId: item.id, categoryId: '  ' });
    expect((await handlers.correct(request)).error.code).toBe('MISSING_CATEGORY_ID');
    expect(request.node.res.statusCode).toBe(422);
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });
  it('partial approval cannot execute a mutation and repeated approval cannot supply quorum', async () => {
    const item = await pending(2);
    const executor = vi.fn();
    workflow.setReviewMutationExecutor(executor);
    for (let i = 0; i < 2; i++) {
      const response = await handlers.approve(event({ reviewId: item.id }, actor, true));
      expect(response.result).toMatchObject({
        status: 'pending_review',
        categorizationExecuted: false,
      });
    }
    expect((await store.getReviewItem(item.id))?.approvedBy).toEqual([actor]);
    expect(executor).not.toHaveBeenCalled();
  });
  it.each(['approve', 'correct'] as const)(
    '%s fails closed when apply composition is missing',
    async (route) => {
      const item = await pending();
      const request = event({ reviewId: item.id, categoryId: category }, actor, true);
      const response = await handlers[route](request);
      expect(response.status).toBe('error');
      expect(response.error.code).toBe(
        route === 'approve' ? 'NOT_IMPLEMENTED' : 'EXECUTOR_UNAVAILABLE',
      );
      expect(request.node.res.statusCode).toBe(route === 'approve' ? 501 : 503);
      expect((await store.getReviewItem(item.id))?.status).not.toBe('applied');
    },
  );
  it.each(['approve', 'correct'] as const)(
    '%s persists failed external execution rather than applied state',
    async (route) => {
      const item = await pending();
      workflow.setReviewMutationExecutor(async () => {
        throw new Error('Ledger unavailable');
      });
      const response = await handlers[route](
        event({ reviewId: item.id, categoryId: category }, actor, true),
      );
      expect(response.result).toMatchObject({
        success: false,
        applied: false,
        finalStatus: 'apply_failed',
      });
      expect((await store.getReviewItem(item.id))?.status).toBe('apply_failed');
    },
  );
  it.each(['approve', 'correct'] as const)(
    '%s reports a competing live execution claim without executing twice',
    async (route) => {
      const item = await pending();
      await store.createIdempotencyRecord({
        idempotencyKey: `review-apply:${item.id}:${actor}`,
        proposalId: item.id,
        operation: 'review_apply',
        serialisedEffect: '{}',
        leaseDurationMs: 60000,
      });
      const executor = vi.fn();
      workflow.setReviewMutationExecutor(executor);
      const request = event({ reviewId: item.id, categoryId: category }, actor, true);
      expect((await handlers[route](request)).error.code).toBe('MUTATION_FAILED');
      expect(request.node.res.statusCode).toBe(500);
      expect(executor).not.toHaveBeenCalled();
      expect((await store.getReviewItem(item.id))?.status).not.toBe('applied');
    },
  );
  it.each(['approve', 'correct', 'reject', 'skip'] as const)(
    '%s exposes optimistic conflict and preserves the competing edit',
    async (route) => {
      const item = await pending();
      const transition = store.transitionReviewItem.bind(store);
      vi.spyOn(store, 'transitionReviewItem').mockImplementationOnce(async (id, input) => {
        await store.updateReviewItemCategory(id, category, input.expectedVersion);
        return transition(id, input);
      });
      const request = event({ reviewId: item.id, categoryId: category });
      expect((await handlers[route](request)).error.code).toBe('VERSION_CONFLICT');
      expect(request.node.res.statusCode).toBe(409);
      expect(await store.getReviewItem(item.id)).toMatchObject({
        status: 'pending_review',
        categoryId: category,
      });
    },
  );
});
