import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createEvent } from 'h3';
import { canonicalProtocolSnapshotSchema, merchantSourceAdmissionSchema } from '@balanceframe/protocol-generated/validators';
import { SqliteWorkflowStore } from '../../../../packages/workflow-store/src/store';
import representative from '../../../../protocol/fixtures/representative.json';
import merchantFixture from '../../../../protocol/fixtures/merchant-intelligence.json';
import type * as Application from '@balanceframe/application';
import type * as Workflow from '@balanceframe/workflow-store';
import type * as WorkflowUtils from '../../server/utils/workflow-store';
import handler from '../../server/api/review/sync.post';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import type { CanonicalReviewSource, MerchantActor, MerchantAnalysisView } from '@balanceframe/application';

const boundary = vi.hoisted(() => ({
  config: { version: 1 as const, serverUrl: 'https://actual.test', budgetId: 'sync-authority-budget', budgetName: 'Canonical Sync fixture', groupId: 'sync-authority-group' },
  snapshot: undefined as ProtocolSnapshot | undefined,
  store: undefined as SqliteWorkflowStore | undefined,
  afterNative: undefined as (() => void | Promise<void>) | undefined,
  afterConnection: undefined as (() => void | Promise<void>) | undefined,
  afterHumanAuth: undefined as (() => void | Promise<void>) | undefined,
}));

vi.mock('@balanceframe/workflow-store', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflow>()), SqliteWorkflowStore,
}));
vi.mock('@balanceframe/application', async (importOriginal) => {
  const application = await importOriginal<typeof Application>();
  return {
    ...application,
    createDefaultConnectionManager: () => ({
      loadConfig: async () => boundary.config,
      withConnection: async (operation: (connected: {
        config: typeof boundary.config; budget: { id: string };
        synchronization: { snapshot: ProtocolSnapshot | undefined };
      }) => Promise<unknown>) => {
        const result = await operation({ config: { ...boundary.config }, budget: { id: boundary.config.budgetId }, synchronization: { snapshot: boundary.snapshot } });
        await boundary.afterConnection?.();
        return result;
      },
    }),
    createNativeAnalysisProtocol: async () => {
      const protocol = await application.createNativeAnalysisProtocol();
      return {
        ...protocol,
        pendingReview: async (...args: Parameters<typeof protocol.pendingReview>) => {
          const result = await protocol.pendingReview(...args);
          await boundary.afterNative?.();
          return result;
        },
      };
    },
    // Keep the real native producer, SQL publication and full-read governance; replace only merchant SDK capture.
    createMerchantIntelligenceService: async () => ({
      withAnalysis: async (
        _actor: MerchantActor,
        _request: unknown,
        operation: (
          view: Pick<MerchantAnalysisView, 'scope' | 'sourceAdmission' | 'localReview' | 'nativeRuleBlocks' | 'nativeRuleParts' | 'nativeRuleSets'>,
          source: CanonicalReviewSource,
          authorize: (operations?: readonly Workflow.GovernanceOperation[]) => boolean,
        ) => Promise<unknown>,
      ) => {
        const protocol = await application.createNativeAnalysisProtocol();
        const { nativeRuleBlocks, nativeRuleParts, nativeRuleSets, ...localReview } = await protocol.pendingReview(boundary.snapshot!, null, {
          store: boundary.store!, scope: { spaceId, budgetId: boundary.config.budgetId },
        });
        return operation({
          localReview,
          nativeRuleBlocks, nativeRuleParts, nativeRuleSets,
          sourceAdmission: merchantSourceAdmissionSchema.parse(merchantFixture.result.sourceAdmission),
          scope: { spaceId, budgetId: boundary.config.budgetId, connectionId: application.merchantConnectionId(boundary.config) },
        }, boundary.snapshot!, () => true);
      },
    }),
  };
});
vi.mock('../../server/utils/workflow-store', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowUtils>()),
  getWorkflowStore: () => ({ store: boundary.store! }),
}));
vi.mock('../../server/utils/reauthentication', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHumanControlAuth: async () => { await boundary.afterHumanAuth?.(); return null; },
}));
vi.mock('../../server/utils/review-category-catalog', () => ({ updateReviewCategoryCatalog: () => {} }));

const now = '2098-01-01T12:00:00.000Z';
const ownerAuth = { method: 'human-session' as const, actorId: 'sync-owner', sessionId: 'sync-owner-session', reauthenticatedAt: now };
let store: SqliteWorkflowStore;
let spaceId: string;
let membershipId: string;
let socket: Socket;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  boundary.config.serverUrl = 'https://actual.test';
  boundary.afterNative = boundary.afterConnection = boundary.afterHumanAuth = undefined;
  store = new SqliteWorkflowStore(':memory:');
  boundary.store = store;
  await store.claimBootstrap({ name: 'Sync owner', email: 'sync-owner@example.test', claimId: 'sync-authority-fixture' });
  await store.finalizeBootstrap({ claimId: 'sync-authority-fixture', ownerUserId: 'sync-owner' });
  const space = store.governance.createSpace({ actorId: 'sync-owner', name: 'Disposable Sync authority', kind: 'shared', now, auth: ownerAuth });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId: boundary.config.budgetId, now, auth: ownerAuth });
  await store.upsertActorMembership('sync-reader', 'active', [], '');
  const membership = store.governance.addMembership({ spaceId, actorId: 'sync-reader', validFrom: now,
    validUntil: new Date(Date.parse(now) + 1000).toISOString(), now, auth: ownerAuth });
  membershipId = membership.id;
  for (const capability of ['observe', 'full-read']) store.governance.provisionResourceGrant({
    spaceId, membershipId, actorId: 'sync-reader', budgetId: boundary.config.budgetId,
    capability, resourceKind: 'budget', resourceId: boundary.config.budgetId, granted: true, now,
  });
  const snapshot = canonicalProtocolSnapshotSchema.parse(structuredClone(representative));
  const transaction = snapshot.transactions[0]!;
  if (!transaction.payeeId || transaction.subtransactions.length !== 0)
    throw new Error('Canonical fixture lacks the stable-payee leaf source');
  transaction.categoryId = null;
  transaction.categoryName = null;
  const native = structuredClone(merchantFixture.request.rules[0]!);
  native.inactive = false;
  native.trigger.conditions[0]!.value = transaction.payeeId!;
  native.actions[0]!.value = snapshot.categories[0]!.id;
  snapshot.rules = [native];
  boundary.snapshot = snapshot;
});
afterEach(() => { socket?.destroy(); store?.close(); vi.useRealTimers(); });

function request() {
  socket = new Socket();
  const incoming = new IncomingMessage(socket);
  incoming.method = 'POST'; incoming.url = '/api/review/sync';
  incoming.headers = { origin: 'http://localhost:3000', host: 'localhost:3000', 'x-balanceframe-space': spaceId };
  const event = createEvent(incoming, new ServerResponse(incoming));
  event.context.auth = { authenticated: true, actorId: 'sync-reader', principalType: 'human', method: 'session',
    sessionId: 'sync-reader-session', user: { id: 'sync-reader' } };
  event.context.runtimeConfig = { workflowDbPath: ':memory:', devBypassAuth: false };
  return event;
}
function revoke() {
  store.governance.setResourceGrant({ spaceId, membershipId, actorId: 'sync-reader', budgetId: boundary.config.budgetId,
    capability: 'full-read', resourceKind: 'budget', resourceId: boundary.config.budgetId,
    granted: false, now, auth: ownerAuth });
}

// This uses the real native producer, canonical fixtures, SQL writer, and governance admission.
// Only asynchronous I/O boundaries are replaced so revocation timing is deterministic.
describe('Sync current authority and selected source publication', () => {
  it('publishes complete native Review provenance under an atomic current full-read fence', async () => {
    const response = await handler(request());
    expect(response.status).toBe('ok');
    const native = (await store.listReviewItems({ budgetId: boundary.config.budgetId, limit: -1 })).filter((row) => row.classifier === 'rule');
    expect(native.map((row) => row.categoryId)).toContain(boundary.snapshot!.categories[0]!.id);
    expect(store.getReviewRuleSet(native[0]!.evidence.ruleSetRef as Workflow.ReviewRuleSetReference)).toEqual([boundary.snapshot!.rules[0]!.id]);
  });
  it.each([['baseline', 1], ['baseline', 2], ['merchant', 1], ['merchant', 2]] as const)(
    'admits the exact complete %s Sync Money-slot boundary %s', async (mode, maxOperationCount) => {
    if (mode === 'merchant') store.governance.provisionResourceGrant({
      spaceId, membershipId, actorId: 'sync-reader', budgetId: boundary.config.budgetId,
      capability: 'merchant:analyze', resourceKind: 'budget', resourceId: boundary.config.budgetId,
      granted: true, now,
    });
    boundary.snapshot!.transactions = [boundary.snapshot!.transactions[0]!];
    store.governance.setResourceGrant({
      spaceId, membershipId, actorId: 'sync-reader', budgetId: boundary.config.budgetId,
      capability: 'full-read', resourceKind: 'budget', resourceId: boundary.config.budgetId,
      granted: true, restrictions: { maxOperationCount }, now, auth: ownerAuth,
    });
    const event = request();
    const response = await handler(event);
    if (maxOperationCount === 1) {
      expect(event.node.res.statusCode).toBe(403);
      expect(response.error?.code).toBe('FORBIDDEN');
      expect(response.result).toBeNull();
      expect(await store.listReviewItems({ budgetId: boundary.config.budgetId, limit: -1 })).toEqual([]);
    } else {
      expect(response.status).toBe('ok');
      expect(response.result).toMatchObject({ result: { candidates: [{
        transactionId: boundary.snapshot!.transactions[0]!.id,
        amount: { minorUnits: '-1500', currency: 'USD' },
      }], totalUncategorizedAmount: { minorUnits: '1500', currency: 'USD' } } });
      expect(await store.listReviewItems({ budgetId: boundary.config.budgetId, limit: -1 })).toHaveLength(1);
    }
  });
  it.each(['baseline', 'merchant'] as const)('withholds %s Sync when the complete source exceeds an otherwise admissible output gross ceiling', async (mode) => {
    if (mode === 'merchant') store.governance.provisionResourceGrant({
      spaceId, membershipId, actorId: 'sync-reader', budgetId: boundary.config.budgetId,
      capability: 'merchant:analyze', resourceKind: 'budget', resourceId: boundary.config.budgetId,
      granted: true, now,
    });
    const transaction = boundary.snapshot!.transactions[0]!;
    boundary.snapshot!.transactions = [transaction, {
      ...structuredClone(transaction), id: 'sync-source-categorized-companion',
      categoryId: boundary.snapshot!.categories[0]!.id,
      categoryName: boundary.snapshot!.categories[0]!.name,
    }];
    store.governance.setResourceGrant({
      spaceId, membershipId, actorId: 'sync-reader', budgetId: boundary.config.budgetId,
      capability: 'full-read', resourceKind: 'budget', resourceId: boundary.config.budgetId,
      granted: true, restrictions: { maxGrossOutgoing: [{ minorUnits: '1500', currency: 'USD' }] },
      now, auth: ownerAuth,
    });
    const event = request();
    const response = await handler(event);
    expect(event.node.res.statusCode).toBe(403);
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
    expect(await store.listReviewItems({ budgetId: boundary.config.budgetId, limit: -1 })).toEqual([]);
  });
  it('does not publish any Review rows after authority is revoked during native analysis', async () => {
    boundary.snapshot!.rules = [];
    boundary.afterNative = revoke;
    const event = request();
    const response = await handler(event);
    expect(event.node.res.statusCode).toBe(403);
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
    expect(await store.listReviewItems({ budgetId: boundary.config.budgetId, limit: -1 })).toEqual([]);
  });
  it.each(['connection', 'human-auth', 'queue-read'] as const)('withholds source results after %s revokes current financial authority', async (point) => {
    boundary.snapshot!.rules = [];
    if (point === 'connection') boundary.afterConnection = revoke;
    else if (point === 'human-auth') boundary.afterHumanAuth = revoke;
    else {
      const list = store.listReviewItems.bind(store);
      vi.spyOn(store, 'listReviewItems').mockImplementation(async (filter) => { const result = await list(filter); revoke(); return result; });
    }
    const event = request();
    const response = await handler(event);
    expect(event.node.res.statusCode).toBe(403);
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
    expect(response.authorization?.allowed).toBe(false);
  });
  it('withholds source results when membership expires during the last human-auth read', async () => {
    boundary.snapshot!.rules = [];
    boundary.afterHumanAuth = () => { vi.setSystemTime(new Date(Date.parse(now) + 1000)); };
    const event = request();
    const response = await handler(event);
    expect(event.node.res.statusCode).toBe(403);
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
  });
  it('withholds source results when the same budget is rebound to another server during cleanup', async () => {
    boundary.snapshot!.rules = [];
    boundary.afterConnection = () => { boundary.config.serverUrl = 'https://replacement-actual.test'; };
    const event = request();
    const response = await handler(event);
    expect(event.node.res.statusCode).toBe(409);
    expect(response.error?.code).toBe('SPACE_CONNECTION_MISMATCH');
    expect(response.result).toBeNull();
  });
});
