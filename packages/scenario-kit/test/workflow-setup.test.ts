import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { materializeScenario, type MaterializedScenario } from '../src/catalog.js';
import {
  seedActualBudget,
  type SeededActualBudget,
} from '../src/actual-seed.js';
import {
  createOwnedScenarioRoot,
  startScenarioActual,
  startScenarioShell,
  stopScenarioProcesses,
  type ScenarioProcesses,
} from '../src/process-runtime.js';
import {
  initializeScenarioWorkflow,
  type ScenarioInitialized,
} from '../src/workflow-setup.js';

const webEntry =
  process.env.SCENARIO_KIT_WEB_ENTRY ??
  fileURLToPath(new URL('../../../apps/web/.output/server/index.mjs', import.meta.url));
const publicOrigin = process.env.SCENARIO_KIT_PUBLIC_ORIGIN ?? 'http://127.0.0.1:43123';
const anchor = new Date();

type RuntimeContext = {
  scenario: MaterializedScenario;
  seeded: SeededActualBudget;
  processes: ScenarioProcesses;
  initialized: ScenarioInitialized;
};

function publicHeaders(cookieHeader?: string): Record<string, string> {
  const origin = new URL(publicOrigin);
  return {
    accept: 'application/json',
    host: origin.host,
    origin: publicOrigin,
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function request(
  context: RuntimeContext,
  path: string,
  init: RequestInit = {},
  persona = 'owner',
): Promise<{ response: Response; body: unknown }> {
  const cookieHeader = context.initialized.personas[persona]?.cookieHeader;
  const response = await fetch(`${context.processes.webUrl}${path}`, {
    ...init,
    headers: {
      ...publicHeaders(cookieHeader),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function result<T>(body: unknown): T {
  const envelope = asObject(body, 'API response');
  expect(envelope).toMatchObject({ status: 'ok', result: expect.anything() });
  return envelope.result as T;
}

type CardResult = {
  card: {
    outcome: unknown;
    budgetFundingStatus: unknown;
    paymentLiquidityStatus: unknown;
    after?: { categories?: readonly unknown[]; accounts?: readonly unknown[] };
  };
};

type GrantsResult = {
  members: readonly unknown[];
  grants: readonly unknown[];
};

async function load(id: MaterializedScenario['id']): Promise<RuntimeContext> {
  const root = createOwnedScenarioRoot();
  const processes = await startScenarioShell({
    root,
    publicOrigin,
    webEntry: webEntry!,
  });
  try {
    await startScenarioActual(processes);
    const scenario = materializeScenario(id, anchor);
    const seeded = await seedActualBudget({
      serverUrl: processes.actualUrl,
      secretKey: processes.actualSecretKey,
      clientDir: processes.seedClientDir,
      budgetName: `Scenario workflow ${id}`,
      ledger: scenario.ledger,
    });
    const initialized = await initializeScenarioWorkflow({
      scenario,
      seeded,
      webUrl: processes.webUrl,
      publicOrigin,
      bootstrapSecret: processes.bootstrapSecret,
      workflowDbPath: processes.workflowDbPath,
    });
    return { scenario, seeded, processes, initialized };
  } catch (error) {
    await stopScenarioProcesses(processes);
    throw error;
  }
}

let funded: RuntimeContext;
let coapproval: RuntimeContext;
let commitment: RuntimeContext;

describe('scenario workflow setup', () => {
  beforeAll(async () => {
    funded = await load('funded-purchase');
    coapproval = await load('coapproval-completion');
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      [funded, coapproval, commitment]
        .filter((context): context is RuntimeContext => Boolean(context))
        .map((context) => stopScenarioProcesses(context.processes)),
    );
  });

  it('bootstraps/signs in over the public origin and persists the exact Actual connection, policy, observations, and funded Card', async () => {
    const owner = funded.initialized.personas.owner;
    expect(owner.actorId).toMatch(/^[a-z0-9-]+$/i);
    expect(owner.password).toHaveLength(32);
    expect(owner.cookieHeader).toContain('=');
    expect(owner.cookieHeader).not.toMatch(/password|secret/i);

    const session = await request(funded, '/api/auth/get-session');
    expect(session.response.ok).toBe(true);
    const sessionBody = asObject(session.body, 'get-session response');
    const sessionUser = asObject(sessionBody.user ?? asObject(sessionBody.data, 'session data').user, 'session user');
    expect(sessionUser.id).toBe(owner.actorId);

    const connection = await request(funded, '/api/connection/budgets');
    const connectionResult = result<{
      budgets: readonly { id: string; groupId: string }[];
    }>(connection.body);
    expect(connectionResult.budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: funded.seeded.budgetId,
          groupId: funded.seeded.groupId,
        }),
      ]),
    );

    const policyResponse = await request(funded, '/api/liquidity/policy');


    const policy = result<Record<string, unknown>>(policyResponse.body);
    const storedPolicy = asObject(policy.policy, 'policy');
    expect(storedPolicy.version).toEqual(expect.any(String));
    expect(storedPolicy.policyHash).toEqual(expect.any(String));
    expect(policy.observationVersion).toEqual(expect.any(Number));
    expect(policy.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: funded.seeded.accountIds['acct-checking'] }),
      ]),
    );

    expect(funded.initialized.entry.kind).toBe('purchase');
    if (funded.initialized.entry.kind !== 'purchase') throw new Error('purchase entry expected');
    const entry = funded.initialized.entry.input;
    const query = new URLSearchParams({
      categoryId: entry.categoryId,
      amount: entry.amount.minorUnits,
      currency: entry.amount.currency,
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
    });
    if (entry.purchaseAt) query.set('purchaseAt', entry.purchaseAt);
    if (entry.requiredBy) query.set('requiredBy', entry.requiredBy);
    const evaluation = await request(funded, `/api/purchase/evaluate?${query}`);
    const card = result<CardResult>(evaluation.body).card;
    expect(card.outcome).toBe('funded_now');
    expect(card.budgetFundingStatus).toBe('funded');
    expect(card.paymentLiquidityStatus).toBe('ready');
    expect(card.after?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: funded.seeded.categoryIds['cat-groceries'],
          availability: expect.objectContaining({ minorUnits: '0', currency: 'USD' }),
        }),
      ]),
    );
    expect(card.after?.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: funded.seeded.accountIds['acct-checking'],
          safeSpendingCapacity: expect.objectContaining({ minorUnits: '3000', currency: 'USD' }),
        }),
      ]),
    );
  }, 120_000);

  it('initializes scoped peer/restricted memberships and keeps restricted financial data private', async () => {
    const peer = coapproval.initialized.personas.coapprover;
    const restricted = coapproval.initialized.personas.restricted;
    expect(peer.actorId).not.toBe(coapproval.initialized.personas.owner.actorId);
    expect(restricted.actorId).not.toBe(peer.actorId);

    const grantsResponse = await request(coapproval, '/api/liquidity/grants');
    const grants = result<GrantsResult>(grantsResponse.body);
    expect(grants.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: peer.actorId }),
        expect.objectContaining({ actorId: restricted.actorId }),
      ]),
    );
    expect(grants.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: peer.actorId,
          resourceKind: 'budget',
          resourceId: coapproval.seeded.budgetId,
          capability: 'approval',
          granted: true,
        }),
        expect.objectContaining({
          actorId: restricted.actorId,
          resourceKind: 'category',
          resourceId: coapproval.seeded.categoryIds['cat-groceries'],
          capability: 'existence',
          granted: true,
        }),
      ]),
    );

    const sessionId = coapproval.initialized.sessions.cart;
    const completionId = coapproval.initialized.completions.purchase;
    const peerSession = await request(coapproval, `/api/spend-sessions/${sessionId}`, {}, 'coapprover');
    expect(peerSession.response.status).toBe(403);
    const peerCompletion = await request(
      coapproval,
      `/api/spend-sessions/${sessionId}/completions/${completionId}`,
      {},
      'coapprover',
    );
    expect(peerCompletion.response.status, JSON.stringify(peerCompletion.body)).toBe(200);
    const peerView = result<{ id: string; canExecute: boolean; debit: unknown }>(peerCompletion.body);
    expect(peerView.id).toBe(completionId);
    expect(peerView.debit).toEqual(expect.objectContaining({ accountId: coapproval.seeded.accountIds['acct-checking'] }));
    expect(peerView.canExecute).toBe(false);
    const restrictedSession = await request(
      coapproval,
      `/api/spend-sessions/${coapproval.initialized.sessions.cart}`,
      {},
      'restricted',
    );
    expect(restrictedSession.response.status).toBe(403);
    expect(JSON.stringify(restrictedSession.body)).not.toContain('minorUnits');
    const restrictedCompletion = await request(
      coapproval,
      `/api/spend-sessions/${sessionId}/completions/${completionId}`,
      {},
      'restricted',
    );
    expect(restrictedCompletion.response.status).toBe(403);
    expect(JSON.stringify(restrictedCompletion.body)).not.toContain('minorUnits');
  }, 120_000);

  it('creates claims and completion stages from response IDs, versions, and hashes', async () => {
    commitment = await load('commitment-overlap');
    const claimsResponse = await request(commitment, '/api/liquidity/claims');
    const claims = result<readonly unknown[]>(claimsResponse.body);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimId: commitment.initialized.claims.categoryCommitment }),
        expect.objectContaining({ claimId: commitment.initialized.claims.accountCommitment }),
      ]),
    );

    const sessionId = commitment.initialized.sessions.origin;
    const sessionResponse = await request(commitment, `/api/spend-sessions/${sessionId}`);
    const session = result<Record<string, unknown>>(sessionResponse.body);
    expect(session.id).toBe(sessionId);
    expect(session.version).toEqual(expect.any(Number));

    const completionId = commitment.initialized.completions.originCompletion;
    const completionResponse = await request(
      commitment,
      `/api/spend-sessions/${sessionId}/completions/${completionId}`,
    );
    const completion = result<Record<string, unknown>>(completionResponse.body);
    expect(completion.id).toBe(completionId);
    expect(completion.phase).toBe('proposed');
    expect(completion.version).toEqual(expect.any(Number));
    expect(completion.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);
});
