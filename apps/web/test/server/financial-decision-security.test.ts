import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionManager } from '@balanceframe/application';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import representative from '../../../../protocol/fixtures/representative.json';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';

const mocks = vi.hoisted(() => ({
  manager: null as unknown,
  loadConfig: vi.fn(),
  withConnection: vi.fn(async (operation: (connected: unknown) => Promise<unknown>) => operation({})),
  attentionHome: vi.fn(),
  createNativeAnalysisProtocol: vi.fn(),
}));

vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
// The hoisted package mock loads Source application code; only Actual/native I/O is replaced.
vi.mock('@balanceframe/application', async () => {
  const application = await import('../../../../packages/application/src/index');
  return {
    ...application,
    createDefaultConnectionManager: () => mocks.manager as ConnectionManager,
    createNativeAnalysisProtocol: () => mocks.createNativeAnalysisProtocol(),
  };
});

import attentionHandler from '../../server/api/home/attention.get';
import inboxHandler from '../../server/api/notifications/inbox.get';

const OWNER = 'financial-security-owner';
const ACTOR = 'financial-security-human';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const HOME_SECRET = 'restricted-bank-source-secret-74c1';
const NOTIFICATION_SECRET = 'raw-notification-provider-secret-18ad';
const ownerAuth = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: `session:${OWNER}`,
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let budgetId = '';
let spaceId = '';
let membershipId = '';

function request(path: string) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'GET';
  req.headers = { 'x-balanceframe-space': spaceId, origin: ORIGIN };
  const res = new ServerResponse(req);
  return {
    path,
    node: { req, res },
    context: {
      auth: {
        authenticated: true,
        actorId: 'forged-legacy-actor',
        user: { id: ACTOR },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: `session:${ACTOR}`,
        impersonatedBy: null,
      },
      runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false },
    },
  } as unknown as H3.H3Event & EventWithContext;
}

function grant(capability: string) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR,
    membershipId,
    budgetId,
    capability,
    resourceKind: 'budget',
    resourceId: budgetId,
    granted: true,
    now: NOW,
    auth: ownerAuth,
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  directory = mkdtempSync(join(tmpdir(), 'financial-decision-security-native-'));
  const req = new IncomingMessage(new Socket());
  req.url = '/api/home/attention';
  req.headers = { 'x-balanceframe-space': '' };
  const opened = getWorkflowStore({
    node: { req, res: new ServerResponse(req) },
    context: { runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite') } },
  } as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({
    name: 'Financial security owner',
    email: 'financial-security-owner@example.test',
    claimId: 'financial-decision-security-native-fixture',
  });
  await store.finalizeBootstrap({ claimId: 'financial-decision-security-native-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(ACTOR, 'active', [], '');
});

beforeEach(() => {
  vi.clearAllMocks();
  budgetId = `financial-security-budget-${++sequence}`;
  const baseSpace = store.governance.createSpace({
    actorId: OWNER,
    name: `Financial decision space ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = store.governance.bindBudget({
    spaceId: baseSpace.id,
    budgetId,
    now: NOW,
    auth: ownerAuth,
  }).id;
  if (!store.governance.getPolicy({ spaceId }))
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth: ownerAuth,
    });
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;
  grant('observe');
  grant('liquidity');
  grant('notification:receive');
  mocks.manager = {
    loadConfig: mocks.loadConfig,
    withConnection: mocks.withConnection,
  };
  const config = { version: 1, serverUrl: 'https://actual-financial-security.test', budgetId,
    budgetName: 'Financial attention fixture', groupId: 'financial-security-group' };
  const snapshot = canonicalProtocolSnapshotSchema.parse({
    ...representative, accounts: [], transactions: [], budgets: [], rules: [], schedules: [],
  });
  mocks.loadConfig.mockResolvedValue(config);
  mocks.withConnection.mockImplementation(async (operation) => operation({
    config, synchronization: { snapshot },
    budget: { id: budgetId },
    connector: { name: 'selected-budget-Actual-connector' },
  }));
  mocks.createNativeAnalysisProtocol.mockResolvedValue({
    attentionHome: (ledger: unknown, params: unknown) => mocks.attentionHome(ledger, params),
  });
  mocks.attentionHome.mockResolvedValue({
    blockers: [],
    alerts: [],
    recurrences: [],
    categoryRisks: [],
    targetProgress: {
      overallLabel: 'healthy',
      healthyCount: 0,
      atRiskCount: 0,
      sinkingFundsOnTrack: 0,
      totalSinkingFunds: 0,
    },
  });
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('financial attention selected-space privacy', () => {
  it('does not restore a private budget for an observer without independent full-read', async () => {
    const response = await attentionHandler(request('/api/home/attention'));

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({ blockers: [], alerts: [], recurrences: [], categoryRisks: [], scopeLimited: true });
    expect(mocks.loadConfig).toHaveBeenCalledOnce();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(mocks.createNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mocks.attentionHome).not.toHaveBeenCalled();
  });

  it('strips restricted canonical evidence from a full-read Native analysis DTO', async () => {
    grant('full-read');
    mocks.attentionHome.mockResolvedValueOnce({
      blockers: [{
        code: 'account_freshness_coverage',
        message: 'An account source is unavailable.',
        severity: 'critical',
        classification: 'evidence_connector_degradation',
        snapshotId: 'snapshot-financial-security',
        policyVersion: 'financial-attention-v1',
        revision: 'sha256:financial-security-revision',
        dedupKey: 'financial-decision:restricted',
        rawEvidence: { providerAccessToken: HOME_SECRET },
        issue: {
          code: 'account_freshness_coverage',
          severity: 'critical',
          effect: 'blocks',
          scope: { kind: 'account', id: 'account-restricted' },
          evidence: [{
            evidenceId: 'restricted-reference-1',
            kind: 'connector_error',
            authorized: false,
            redaction: 'redacted',
            rawPayload: { providerResponse: HOME_SECRET },
          }],
          remediation: { code: 'reconnect_source', action: 'Reconnect the account source.' },
          redaction: 'redacted',
        },
      }],
      alerts: [],
      recurrences: [],
      categoryRisks: [],
      targetProgress: {
        overallLabel: 'unknown',
        healthyCount: 0,
        atRiskCount: 1,
        sinkingFundsOnTrack: 0,
        totalSinkingFunds: 0,
      },
    });

    const response = await attentionHandler(request('/api/home/attention'));
    const serialized = JSON.stringify(response);
    const blocker = response.result.blockers[0];

    expect(response.status).toBe('ok');
    expect(mocks.withConnection).toHaveBeenCalledOnce();
    expect(serialized).not.toContain(HOME_SECRET);
    expect(blocker).not.toHaveProperty('rawEvidence');
    expect(blocker.issue.evidence[0]).toEqual({
      evidenceId: 'restricted-reference-1',
      kind: 'connector_error',
      authorized: false,
      redaction: 'redacted',
    });
    expect(blocker.issue.evidence[0]).not.toHaveProperty('rawPayload');
  });
});

describe('financial notification browser DTO', () => {
  it('strips secret containers from the real Native outbox projection', async () => {
    grant('full-read');
    grant('notification:admin');
    const event = await store.createNotificationEvent({
      budgetId,
      classification: 'budget_alert',
      recipientId: ACTOR,
      scope: `budget:${budgetId}`,
      redactionClass: 'restricted',
      policyVersion: 'notification-security-v1',
      payload: {
        title: 'Restricted finding',
        summary: 'Material evidence needs review.',
        rawEvidence: { providerToken: NOTIFICATION_SECRET },
        rawPayload: { providerResponse: NOTIFICATION_SECRET },
        secrets: { accessToken: NOTIFICATION_SECRET },
        details: { authorization: NOTIFICATION_SECRET, explanation: 'Safe public summary.' },
      },
      now: NOW,
    });
    await store.enqueueNotification({
      eventId: event.id,
      deliveryKey: `financial-security-delivery-${sequence}`,
      channelType: 'in_app',
    });

    const response = await inboxHandler(request('/api/notifications/inbox'));
    const serialized = JSON.stringify(response);
    const item = response.result.items[0];

    expect(response.status).toBe('ok');
    expect(item.redactedPayload).toEqual({
      title: 'Restricted finding',
      summary: 'Material evidence needs review.',
      details: { explanation: 'Safe public summary.' },
    });
    expect(item.redactedPayload).not.toHaveProperty('rawEvidence');
    expect(item.redactedPayload).not.toHaveProperty('rawPayload');
    expect(item.redactedPayload).not.toHaveProperty('secrets');
    expect(item.event).not.toHaveProperty('payload');
    expect(serialized).not.toContain(NOTIFICATION_SECRET);
  });
});
