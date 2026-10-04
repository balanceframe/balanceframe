import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import listHandler from '../../server/api/findings/index.get';
import detailHandler from '../../server/api/findings/[id].get';
import ackHandler from '../../server/api/findings/[id]/acknowledge.post';
import dismissHandler from '../../server/api/findings/[id]/dismiss.post';
import correctHandler from '../../server/api/findings/[id]/correct.post';
import reopenHandler from '../../server/api/findings/[id]/reopen.post';
import supersedeHandler from '../../server/api/findings/[id]/supersede.post';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({ budgetId: '' })),
}));

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: async (event: { body: unknown }) => event.body,
  getQuery: (event: { query?: unknown }) => event.query ?? {},
  getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
    event.context.params?.[name],
}));
// Load Source Native modules in Vitest's hoisted mock factories, not stale workspace dist exports.
vi.mock('@balanceframe/application', async () => ({
  ...(await import('../../../../packages/application/src/index')),
  createDefaultConnectionManager: () => ({ loadConfig: mocks.loadConfig }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

const OWNER = 'finding-space-owner';
const READER = 'finding-scope-reader';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const ownerControl = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: 'finding-owner-session',
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let budgetId = '';
let spaceId = '';
let readerMembershipId = '';

function request(options: {
  id?: string;
  body?: unknown;
  query?: unknown;
  selectedSpace?: string;
  actorId?: string;
} = {}) {
  const headers = new Map<string, string | number | readonly string[]>();
  const response = {
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
  };
  const actorId = options.actorId ?? READER;
  return {
    body: options.body,
    query: options.query,
    node: {
      req: {
        headers: {
          origin: ORIGIN,
          'x-balanceframe-space': options.selectedSpace ?? spaceId,
        },
      },
      res: response,
    },
    context: {
      params: options.id === undefined ? {} : { id: options.id },
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

function createScope(selectedBudget: string) {
  const created = store.governance.createSpace({
    actorId: OWNER,
    name: `Finding fixture ${sequence}`,
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

function grant(capability: string) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: READER,
    membershipId: readerMembershipId,
    budgetId,
    capability,
    resourceKind: 'budget',
    resourceId: budgetId,
    granted: true,
    now: NOW,
  });
}

async function createFinding(
  selectedBudget: string,
  input: { classification?: string; severity?: 'low' | 'medium' | 'high' | 'critical'; description: string; evidence?: Record<string, unknown> },
) {
  return store.createFinding({
    budgetId: selectedBudget,
    classification: input.classification ?? 'budget_alert',
    severity: input.severity ?? 'medium',
    description: input.description,
    evidence: input.evidence ?? { privateEvidence: 'stored-only-secret' },
    evidenceRefs: ['private-evidence-ref'],
    actorId: READER,
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'finding-lifecycle-'));
  const opened = getWorkflowStore(request({ selectedSpace: '' }) as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Finding owner', email: 'finding-owner@example.test', claimId: 'finding-lifecycle-fixture' });
  await store.finalizeBootstrap({ claimId: 'finding-lifecycle-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(READER, 'active', [], 'unscoped');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  budgetId = `finding-budget-${++sequence}`;
  mocks.loadConfig.mockResolvedValue({ budgetId });
  const selected = createScope(budgetId);
  spaceId = selected.spaceId;
  readerMembershipId = selected.membershipId;
  grant('observe');
  grant('history');
  grant('finding:transition');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('governed finding lifecycle routes', () => {
  it('filters selected-budget findings through current projection before assigning page positions', async () => {
    const first = await createFinding(budgetId, { description: 'private first narrative', severity: 'high' });
    const second = await createFinding(budgetId, { description: 'private second narrative', severity: 'medium' });
    const hiddenTransfer = await createFinding(budgetId, {
      classification: 'transfer_needs_attention',
      description: 'unprojectable transfer narrative',
      severity: 'critical',
      evidence: { transferId: 'not-a-current-proposal', rawEvidence: 'private transfer secret' },
    });
    const foreign = createScope(`finding-private-budget-${sequence}`);
    await createFinding(`finding-private-budget-${sequence}`, {
      description: 'other budget must not be disclosed',
      severity: 'critical',
    });

    const page = async (offset: number) => listHandler(request({ query: { limit: '1', offset: String(offset) } }));
    const firstPage = await page(0);
    const secondPage = await page(1);
    expect(firstPage.status).toBe('ok');
    expect(firstPage.result.map((finding: { id: string }) => finding.id)).toEqual([first.id]);
    expect(secondPage.status).toBe('ok');
    expect(secondPage.result.map((finding: { id: string }) => finding.id)).toEqual([second.id]);
    const serialized = JSON.stringify([firstPage, secondPage]);
    expect(serialized).not.toContain('private first narrative');
    expect(serialized).not.toContain('private second narrative');
    expect(serialized).not.toContain('private transfer secret');
    expect(serialized).not.toContain(hiddenTransfer.id);
    expect(serialized).not.toContain('other budget must not be disclosed');
    expect(serialized).not.toContain(foreign.spaceId);
  });

  it('returns allowlisted finding state and applies real versioned transitions without exposing stored evidence', async () => {
    const finding = await createFinding(budgetId, { description: 'secret original description' });
    const replacement = await createFinding(budgetId, { description: 'secret replacement description' });

    const detail = await detailHandler(request({ id: finding.id }));
    expect(detail.status).toBe('ok');
    expect(detail.result).toMatchObject({
      id: finding.id,
      budgetId,
      classification: 'budget_alert',
      status: 'open',
      description: 'A finding needs authorized review.',
    });
    expect(JSON.stringify(detail.result)).not.toContain('secret original description');
    expect(JSON.stringify(detail.result)).not.toContain('private-evidence-ref');

    const acknowledged = await ackHandler(request({ id: finding.id, body: { expectedVersion: 1 } }));
    expect(acknowledged.status).toBe('ok');
    expect(acknowledged.result).toMatchObject({ id: finding.id, status: 'acknowledged' });

    const staleDismiss = await dismissHandler(request({
      id: finding.id,
      body: { expectedVersion: 1, reason: 'stale transition' },
    }));
    expect(staleDismiss.status).toBe('error');
    expect(await store.getFinding(finding.id)).toMatchObject({ status: 'acknowledged', version: 2 });

    const dismissed = await dismissHandler(request({
      id: finding.id,
      body: { expectedVersion: 2, reason: 'No longer actionable' },
    }));
    expect(dismissed.status).toBe('ok');
    expect(dismissed.result).toMatchObject({ id: finding.id, status: 'dismissed' });
    expect(JSON.stringify(dismissed.result)).not.toContain('No longer actionable');

    const reopened = await reopenHandler(request({ id: finding.id, body: { expectedVersion: 3 } }));
    expect(reopened.status).toBe('ok');
    expect(reopened.result.status).toBe('reopened');

    const corrected = await correctHandler(request({
      id: finding.id,
      body: { expectedVersion: 4, correctionRef: 'private-correction-reference' },
    }));
    expect(corrected.status).toBe('ok');
    expect(corrected.result).toMatchObject({ id: finding.id, status: 'corrected' });
    expect(JSON.stringify(corrected.result)).not.toContain('private-correction-reference');

    const superseded = await supersedeHandler(request({
      id: finding.id,
      body: { expectedVersion: 5, supersededBy: replacement.id, reason: 'Replaced with a newer finding' },
    }));
    expect(superseded.status).toBe('ok');
    expect(superseded.result).toMatchObject({ id: finding.id, status: 'superseded' });
    expect(JSON.stringify(superseded.result)).not.toContain(replacement.id);
    expect(await store.getFinding(finding.id)).toMatchObject({
      status: 'superseded',
      supersededBy: replacement.id,
      supersededReason: 'Replaced with a newer finding',
      version: 6,
    });
  });

  it('hides a finding immediately when current history authority is revoked', async () => {
    const finding = await createFinding(budgetId, { description: 'revoked-private-description' });
    store.governance.setResourceGrant({
      spaceId,
      actorId: READER,
      membershipId: readerMembershipId,
      budgetId,
      capability: 'history',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: NOW,
      auth: ownerControl,
    });
    const response = await detailHandler(request({ id: finding.id }));
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('FINDING_NOT_FOUND');
    expect(JSON.stringify(response)).not.toContain('revoked-private-description');
  });

  it('rejects a stale selected-space membership before disclosing a finding', async () => {
    const finding = await createFinding(budgetId, { description: 'departed-reader-secret' });
    store.governance.revokeMembership({ spaceId, membershipId: readerMembershipId, now: NOW, auth: ownerControl });
    const response = await detailHandler(request({ id: finding.id }));
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain(finding.id);
    expect(JSON.stringify(response)).not.toContain('departed-reader-secret');
  });
});