import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import policyGet from '../../server/api/notifications/policy.get';
import historyGet from '../../server/api/reports/history.get';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({ budgetId: '' })),
}));
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  getQuery: (event: { query?: unknown }) => event.query ?? {},
}));
// Load Source Native modules in Vitest's hoisted mock factories, not stale workspace dist exports.
vi.mock('@balanceframe/application', async () => ({
  ...(await import('../../../../packages/application/src/index')),
  createDefaultConnectionManager: () => ({ loadConfig: mocks.loadConfig }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

const OWNER = 'policy-history-owner';
const READER = 'report-history-reader';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const ownerControl = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: 'policy-history-owner-session',
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let selectedBudgetId = '';
let selectedSpaceId = '';
let readerMembershipId = '';
let privateBudgetId = '';
let privateSpaceId = '';

function request(options: {
  actorId?: string;
  selectedSpace?: string;
  query?: unknown;
} = {}) {
  const headers = new Map<string, string | number | readonly string[]>();
  const actorId = options.actorId ?? READER;
  return {
    query: options.query,
    node: {
      req: {
        headers: {
          origin: ORIGIN,
          'x-balanceframe-space': options.selectedSpace ?? selectedSpaceId,
        },
      },
      res: {
        statusCode: 200,
        statusMessage: '',
        headersSent: false,
        setHeader(name: string, value: string | number | readonly string[]) {
          headers.set(name.toLowerCase(), value);
        },
        getHeader(name: string) {
          return headers.get(name.toLowerCase());
        },
        removeHeader(name: string) {
          headers.delete(name.toLowerCase());
        },
      },
    },
    context: {
      auth: {
        authenticated: true,
        actorId,
        user: { id: actorId },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: `session:${actorId}`,
        impersonatedBy: null,
      },
      runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false },
    },
  } as unknown as H3.H3Event & EventWithContext;
}

function createScope(selectedBudget: string, name: string) {
  const created = store.governance.createSpace({
    actorId: OWNER,
    name,
    kind: 'shared',
    now: NOW,
    auth: ownerControl,
  });
  const space = store.governance.bindBudget({
    spaceId: created.id,
    budgetId: selectedBudget,
    now: NOW,
    auth: ownerControl,
  });
  const reader = store.governance.addMembership({
    spaceId: space.id,
    actorId: READER,
    validFrom: NOW,
    now: NOW,
    auth: ownerControl,
  });
  return { spaceId: space.id, membershipId: reader.id };
}

function grant(capability: string, granted = true) {
  store.governance.provisionResourceGrant({
    spaceId: selectedSpaceId,
    actorId: READER,
    membershipId: readerMembershipId,
    budgetId: selectedBudgetId,
    capability,
    resourceKind: 'budget',
    resourceId: selectedBudgetId,
    granted,
    now: NOW,
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'notification-policy-history-'));
  const opened = getWorkflowStore(request({ selectedSpace: '' }) as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Policy history owner', email: 'policy-history@example.test', claimId: 'notification-policy-history-fixture' });
  await store.finalizeBootstrap({ claimId: 'notification-policy-history-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(READER, 'active', [], 'unscoped');
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  selectedBudgetId = `report-history-selected-${++sequence}`;
  privateBudgetId = `report-history-private-${sequence}`;
  mocks.loadConfig.mockResolvedValue({ budgetId: selectedBudgetId });
  const selected = createScope(selectedBudgetId, `Selected policy/report space ${sequence}`);
  selectedSpaceId = selected.spaceId;
  readerMembershipId = selected.membershipId;
  const privateScope = createScope(privateBudgetId, `Private policy/report space ${sequence}`);
  privateSpaceId = privateScope.spaceId;
  grant('observe');
  grant('full-read');
  await store.saveNotificationPolicy({
    spaceId: selectedSpaceId,
    policyKey: 'notification',
    policyVersion: `selected-policy-${sequence}`,
    policy: { label: 'selected-space notification policy' },
  });
  await store.saveNotificationPolicy({
    spaceId: privateSpaceId,
    policyKey: 'notification',
    policyVersion: `private-policy-${sequence}`,
    policy: { label: 'private-space policy secret' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GET /api/notifications/policy', () => {
  it('reads the current policy from the explicitly selected space', async () => {
    const response = await policyGet(request({ actorId: OWNER, query: {} }));
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      spaceId: selectedSpaceId,
      policyKey: 'notification',
      policyVersion: `selected-policy-${sequence}`,
    });
    expect(JSON.parse(response.result.policy)).toEqual({ label: 'selected-space notification policy' });
    expect(JSON.stringify(response)).not.toContain('private-space policy secret');
  });

  it('does not use a query-selected foreign space or an implicit missing selection', async () => {
    const foreign = await policyGet(request({ actorId: OWNER, query: { spaceId: privateSpaceId } }));
    expect(foreign.status).toBe('error');
    expect(foreign.error?.code).toBe('INVALID_POLICY_QUERY');
    expect(JSON.stringify(foreign)).not.toContain('private-space policy secret');

    const missing = await policyGet(request({ actorId: OWNER, selectedSpace: '', query: {} }));
    expect(missing.status).toBe('error');
    expect(missing.error?.code).toBe('SPACE_SELECTION_REQUIRED');
  });
});

describe('GET /api/reports/history', () => {
  it('paginates and counts only the exact selected budget while returning no metadata after revocation', async () => {
    const first = await store.createReportRecord({
      budgetId: selectedBudgetId,
      reportType: 'spending',
      config: { label: 'Selected first report' },
      policyVersion: '1',
    });
    vi.setSystemTime(new Date(Date.parse(NOW) + 1_000));
    const second = await store.createReportRecord({
      budgetId: selectedBudgetId,
      reportType: 'spending',
      config: { label: 'Selected second report' },
      policyVersion: '1',
    });
    vi.setSystemTime(new Date(Date.parse(NOW) + 2_000));
    const foreign = await store.createReportRecord({
      budgetId: privateBudgetId,
      reportType: 'spending',
      config: { label: 'private-report-count-and-label-secret' },
      policyVersion: '1',
    });
    expect(foreign.budgetId).toBe(privateBudgetId);

    const firstPage = await historyGet(request({ query: { limit: '1', offset: '0' } }));
    const secondPage = await historyGet(request({ query: { limit: '1', offset: '1' } }));
    expect(firstPage.status).toBe('ok');
    expect(firstPage.result).toMatchObject({ total: 2, entries: [{ id: second.id, budgetId: selectedBudgetId, label: 'Selected second report' }] });
    expect(secondPage.status).toBe('ok');
    expect(secondPage.result).toMatchObject({ total: 2, entries: [{ id: first.id, budgetId: selectedBudgetId, label: 'Selected first report' }] });

    const foreignBudgetQuery = await historyGet(request({ query: { budgetId: privateBudgetId } }));
    expect(foreignBudgetQuery.status).toBe('error');
    expect(foreignBudgetQuery.error?.code).toBe('FORBIDDEN');
    expect(JSON.stringify([firstPage, secondPage, foreignBudgetQuery])).not.toContain('private-report-count-and-label-secret');
    expect(JSON.stringify([firstPage, secondPage])).not.toContain(privateSpaceId);

    store.governance.setResourceGrant({
      spaceId: selectedSpaceId,
      actorId: READER,
      membershipId: readerMembershipId,
      budgetId: selectedBudgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: selectedBudgetId,
      granted: false,
      now: new Date().toISOString(),
      auth: ownerControl,
    });
    const revoked = await historyGet(request());
    expect(revoked.status).toBe('error');
    expect(revoked.error?.code).toBe('FORBIDDEN');
    expect(JSON.stringify(revoked)).not.toContain('Selected first report');
    expect(JSON.stringify(revoked)).not.toContain('Selected second report');
  });
});