import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MerchantAnalysisView, MerchantPolicyView, MerchantResearchPreview } from '@balanceframe/application';
import { deriveProposalAuthorizationFacts, type GovernanceResourceGrant, type GovernanceResourceRef } from '@balanceframe/workflow-store';

import { materializeScenario, type MaterializedScenario } from '../src/catalog.js';
import type { SeededActualBudget, SeededEntityIds } from '../src/actual-seed.js';
import {
  createOwnedScenarioRoot,
  startScenarioShell,
  stopScenarioProcesses,
  type ScenarioProcesses,
} from '../src/process-runtime.js';
import {
  mapPolicy,
  mapObservations,
  mapSession,
  type ScenarioInitialized,
} from '../src/workflow-setup.js';
import { initializeScenarioShell } from '../src/loader.js';
import { journal, telemetry } from './acceptance/merchant-research-support.js';
import { normalScenarioResponse, scenarioRequest, withScenario } from './acceptance/support.js';

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
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  persona = 'owner',
) {
  const credential = context.initialized.personas[persona];
  if (!credential) throw new Error('Unknown scenario persona');
  const cookieHeader = credential.cookieHeader;
  const response = await normalScenarioResponse(new URL(path, context.processes.webUrl), {
    method: init.method ?? 'GET',
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: {
      ...publicHeaders(cookieHeader),
      'x-balanceframe-space': credential.spaceId,
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

async function load(id: string): Promise<RuntimeContext> {
  const scenario = materializeScenario(id, anchor);
  const root = createOwnedScenarioRoot();
  const processes = await startScenarioShell({
    root,
    publicOrigin,
    webEntry: webEntry!,
  });
  try {
    const { seeded, initialized } = await initializeScenarioShell(processes, scenario);
    return { scenario, seeded, processes, initialized };
  } catch (error) {
    await stopScenarioProcesses(processes);
    throw error;
  }
}

const TEMPORAL_IDS: SeededEntityIds = {
  accountIds: { 'acct-checking': 'actual-checking' },
  categoryGroupIds: {},
  categoryIds: { 'cat-groceries': 'actual-groceries' },
  payeeIds: {},
  ruleIds: {},
  transactionIds: {},
};

describe('workflow submission temporal materialization', () => {
  const anchor = new Date('2026-09-06T12:00:00.000Z');
  const submittedAt = Date.parse('2026-09-06T18:30:00.000Z');

  it('rebases policy validity from its fixture anchor at real submission time', () => {
    const scenario = materializeScenario('funded-purchase', anchor);
    const source = structuredClone(scenario.policy);
    const submittedAt = Date.parse('2026-10-06T12:00:00.000Z');

    const payload = mapPolicy(scenario.policy, TEMPORAL_IDS, scenario.anchor, submittedAt);

    expect(Date.parse(source.expiresAt)).toBeLessThan(submittedAt);
    expect(Date.parse(payload.expiresAt) - submittedAt).toBe(
      Date.parse(source.expiresAt) - Date.parse(scenario.anchor),
    );
    expect(payload.accounts[0]?.accountId).toBe('actual-checking');
    expect(scenario.policy).toEqual(source);
  });

  it.each([-2_000, 0])('does not renew policy validity with expiry offset %i', (offset) => {
    const scenario = materializeScenario('funded-purchase', anchor);
    const policy = { ...scenario.policy, expiresAt: new Date(anchor.getTime() + offset).toISOString() };
    const payload = mapPolicy(policy, TEMPORAL_IDS, scenario.anchor, submittedAt);
    expect(Date.parse(payload.expiresAt)).toBeLessThanOrEqual(submittedAt);
    expect(Date.parse(payload.expiresAt) - submittedAt).toBe(offset);
  });

  it('rebases account observations to preserve their expiry offset without changing the recipe', () => {
    const scenario = materializeScenario('expired-account-evidence', anchor);
    const source = structuredClone(scenario.observations);

    const payload = mapObservations(
      scenario.observations,
      TEMPORAL_IDS,
      scenario.anchor,
      submittedAt,
    );

    expect(Date.parse(payload.expiresAt) - submittedAt).toBe(2_000);
    expect(payload.observations[0]).toEqual({
      ...source.observations[0],
      accountId: 'actual-checking',
    });
    expect(scenario.observations).toEqual(source);
  });

  it('rebases a session expiry while preserving ordinary fixture timestamps', () => {
    const scenario = materializeScenario('expired-session', anchor);
    const source = structuredClone(scenario.sessions.expired);
    if (!source) throw new Error('Expired session recipe is unavailable');

    const payload = mapSession(source, TEMPORAL_IDS, scenario.anchor, submittedAt);

    expect(Date.parse(payload.expiresAt) - submittedAt).toBe(2_000);
    expect(payload.items[0]?.purchaseAt).toBe(source.items[0]?.purchaseAt);
    expect(payload.items[0]?.requiredBy).toBe(source.items[0]?.requiredBy);
    expect(scenario.sessions.expired).toEqual(source);
  });
});


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
    expect(owner.spaceId).toBe(funded.initialized.spaceId);
    expect(owner.membershipId).toEqual(expect.any(String));
    expect(owner.cookieHeader).not.toMatch(/password|secret/i);

    const session = await request(funded, '/api/auth/get-session');
    expect(session.response.ok).toBe(true);
    const sessionBody = asObject(session.body, 'get-session response');
    const sessionUser = asObject(sessionBody.user ?? asObject(sessionBody.data, 'session data').user, 'session user');
    expect(sessionUser.id).toBe(owner.actorId);

    const connectionDiscovery = await request(funded, '/api/connection/budgets');
    expect(connectionDiscovery.response.status).toBe(403);
    expect(connectionDiscovery.body).not.toHaveProperty('result.budgets');
    const persistedConfig = JSON.parse(await readFile(funded.processes.connectionPath, 'utf8')) as Record<string, unknown>;
    expect({
      version: persistedConfig.version, serverUrl: persistedConfig.serverUrl,
      budgetId: persistedConfig.budgetId, budgetName: persistedConfig.budgetName,
      groupId: persistedConfig.groupId,
    }).toEqual({
      version: 1, serverUrl: funded.processes.actualUrl, budgetId: funded.seeded.budgetId,
      budgetName: funded.seeded.budgetName, groupId: funded.seeded.groupId,
    });

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
    expect(funded.seeded.readResources).toEqual(expect.arrayContaining([
      { resourceKind: 'account', resourceId: funded.seeded.accountIds['acct-checking'] },
    ]));
    const realTransactions = funded.seeded.readResources.filter(({ resourceKind }) => resourceKind === 'transaction');
    expect(realTransactions.length).toBeGreaterThan(0);
  }, 120_000);

  it('initializes scoped peer/restricted memberships and keeps restricted financial data private', async () => {
    const peer = coapproval.initialized.personas.coapprover;
    const restricted = coapproval.initialized.personas.restricted;
    expect(peer.actorId).not.toBe(coapproval.initialized.personas.owner.actorId);
    expect(restricted.actorId).not.toBe(peer.actorId);
    expect(peer.password === coapproval.initialized.personas.owner.password).toBe(false);
    expect(peer.password === restricted.password).toBe(false);
    expect(peer.spaceId).toBe(coapproval.initialized.spaceId);
    expect(peer.membershipId).not.toBe(coapproval.initialized.personas.owner.membershipId);
    const membershipsResponse = await request(
      coapproval, `/api/spaces/${coapproval.initialized.spaceId}/memberships`,
    );
    expect(result<{ memberships: readonly unknown[] }>(membershipsResponse.body).memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: peer.membershipId, actorId: peer.actorId, revokedAt: null }),
        expect.objectContaining({ id: restricted.membershipId, actorId: restricted.actorId, revokedAt: null }),
      ]),
    );

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

describe('Governance story initialization through real authenticated workflows', () => {
  it('leaves an invitation pending with no fabricated actor, membership or session', async () => {
    const context = await load('governance-invitation-lifecycle');
    try {
      expect(Object.keys(context.initialized.personas)).toEqual(['owner']);
      expect(context.initialized.personas.invitee).toBeUndefined();
      const initialized = asObject(context.initialized, 'initialized invitation workflow');
      const governance = asObject(initialized.governance, 'private governance state');
      const pending = asObject(governance.pendingInvitations, 'private pending invitations');
      const invitee = asObject(pending.invitee, 'private invitee state');
      expect(invitee.invitationId).toEqual(expect.any(String));
      expect(invitee.token).toEqual(expect.any(String));
      for (const key of ['actorId', 'membershipId', 'cookieHeader', 'password'])
        expect(invitee).not.toHaveProperty(key);
      const owner = context.initialized.personas.owner;
      const session = await request(context, '/api/auth/get-session');
      expect(session.response.status).toBe(200);
      const sessionBody = asObject(session.body, 'owner real session');
      const user = asObject(sessionBody.user ?? asObject(sessionBody.data, 'session data').user, 'session user');
      expect(user.id).toBe(owner.actorId);
      const memberships = await request(context, `/api/spaces/${context.initialized.spaceId}/memberships`);
      expect(memberships.response.status).toBe(200);
      expect(result<{ memberships: readonly unknown[] }>(memberships.body).memberships).toEqual([
        expect.objectContaining({ id: owner.membershipId, actorId: owner.actorId, revokedAt: null }),
      ]);
      const invitations = await request(context, '/api/invitations');
      expect(invitations.response.status).toBe(200);
      const listed = result<{ items: readonly unknown[] }>(invitations.body).items;
      expect(listed).toEqual([
        expect.objectContaining({
          id: invitee.invitationId, spaceId: context.initialized.spaceId, status: 'active',
          claimedEmail: null, redeemedUserId: null, claimedAt: null, redeemedAt: null,
        }),
      ]);
      expect(JSON.stringify(invitations.body)).not.toContain(String(invitee.token));
      expect(context.initialized.entry).toEqual({ kind: 'page', path: '/spaces' });
    } finally {
      await stopScenarioProcesses(context.processes);
    }
  }, 180_000);

  it('gives the scoped member a separate real human session and exact narrow grants, never private merchant source', async () => {
    const context = await load('governance-scoped-access');
    try {
      const owner = context.initialized.personas.owner;
      const limited = context.initialized.personas.limited;
      expect(limited.actorId).not.toBe(owner.actorId);
      expect(limited.membershipId).not.toBe(owner.membershipId);
      expect(limited.cookieHeader).not.toBe(owner.cookieHeader);
      expect(limited.password).not.toBe(owner.password);
      expect(limited.spaceId).toBe(context.initialized.spaceId);
      const session = await request(context, '/api/auth/get-session', {}, 'limited');
      expect(session.response.status).toBe(200);
      const sessionBody = asObject(session.body, 'limited real session');
      const user = asObject(sessionBody.user ?? asObject(sessionBody.data, 'session data').user, 'session user');
      expect(user.id).toBe(limited.actorId);
      const grantsResponse = await request(context, '/api/liquidity/grants');
      const grants = result<{ grants: readonly Record<string, unknown>[] }>(grantsResponse.body).grants;
      expect(grants.filter(({ actorId, granted }) => actorId === limited.actorId && granted)
        .map(({ resourceKind, resourceId, capability }) => ({ resourceKind, resourceId, capability }))
        .sort((left, right) => String(left.capability).localeCompare(String(right.capability)))).toEqual([
        { resourceKind: 'account', resourceId: context.seeded.accountIds['acct-checking'], capability: 'existence' },
        { resourceKind: 'account', resourceId: context.seeded.accountIds['acct-checking'], capability: 'name' },
      ]);
      const merchant = await request(context, '/api/merchant', {}, 'limited');
      expect(merchant.response.status).toBe(403);
      expect(JSON.stringify(merchant.body)).not.toContain('minorUnits');
      expect(JSON.stringify(merchant.body)).not.toContain(context.seeded.accountIds['acct-savings']);
      expect(context.initialized.entry).toEqual({ kind: 'page', path: '/spaces' });
    } finally {
      await stopScenarioProcesses(context.processes);
    }
  }, 180_000);

  it('provisions exact native source-closure grants for owner and independent reviewer, including Actual-generated rows', async () => {
    const context = await load('merchant-native-rule-lifecycle');
    try {
      const grantResponse = await request(context, `/api/spaces/${context.initialized.spaceId}/grants`);
      expect(grantResponse.response.status).toBe(200);
      const grants = result<{ grants: readonly Record<string, unknown>[] }>(grantResponse.body).grants;
      const transactionIds = context.seeded.readResources
        .filter(({ resourceKind }) => resourceKind === 'transaction').map(({ resourceId }) => resourceId).sort();
      const ruleIds = context.seeded.readResources
        .filter(({ resourceKind }) => resourceKind === 'rule').map(({ resourceId }) => resourceId).sort();
      for (const personaId of ['owner', 'approver']) {
        const persona = context.initialized.personas[personaId];
        expect(persona).toBeDefined();
        const current = grants.filter(({ membershipId, granted, revokedAt }) =>
          membershipId === persona.membershipId && granted && revokedAt === null,
        );
        for (const capability of ['transaction.view', 'source']) {
          expect(current.filter((grant) => grant.resourceKind === 'transaction' && grant.capability === capability)
            .map(({ resourceId }) => resourceId).sort()).toEqual(transactionIds);
        }
        expect(current.filter((grant) => grant.resourceKind === 'rule' && grant.capability === 'rule:view')
          .map(({ resourceId }) => resourceId).sort()).toEqual(ruleIds);
        expect(current).toEqual(expect.arrayContaining([
          expect.objectContaining({
            resourceKind: 'budget', resourceId: context.seeded.budgetId, capability: 'rule:view',
          }),
          expect.objectContaining({
            resourceKind: 'account', resourceId: context.seeded.accountIds['acct-checking'], capability: 'source',
          }),
        ]));
      }
      const reviewer = context.initialized.personas.approver;
      expect(reviewer.actorId).not.toBe(context.initialized.personas.owner.actorId);
      expect(reviewer.cookieHeader).not.toBe(context.initialized.personas.owner.cookieHeader);
      expect(grants.filter(({ membershipId, granted }) =>
        membershipId === reviewer.membershipId && granted,
      ).some(({ capability, resourceKind }) =>
        (capability === 'full-read' && resourceKind === 'budget') ||
        ['session:execute', 'rule:execute', 'categorization:execute', 'grant:manage', 'policy:manage'].includes(String(capability)),
      )).toBe(false);
      expect(context.initialized.entry).toEqual({ kind: 'page', path: '/rules' });
    } finally {
      await stopScenarioProcesses(context.processes);
    }
  }, 180_000);

  it('registers a real bounded assistant delegation and credential without making it a human persona', async () => {
    const context = await load('governance-delegated-assistant');
    try {
      expect(context.initialized.personas.assistant).toBeUndefined();
      const owner = context.initialized.personas.owner;
      const path = `/api/spaces/${context.initialized.spaceId}`;
      const agentsResponse = await request(context, `${path}/agents`);
      const agents = result<{ agents: readonly Record<string, unknown>[] }>(agentsResponse.body).agents;
      expect(agents).toEqual([
        expect.objectContaining({ registeredSpaceId: context.initialized.spaceId, status: 'active', createdBy: owner.actorId }),
      ]);
      const agent = agents[0]!;
      expect(agent.agentId).not.toBe(owner.actorId);
      const delegationsResponse = await request(context, `${path}/delegations`);
      const delegations = result<{ delegations: readonly Record<string, unknown>[] }>(delegationsResponse.body).delegations;
      expect(delegations).toEqual([
        expect.objectContaining({
          agentId: agent.agentId, spaceId: context.initialized.spaceId,
          issuerActorId: owner.actorId, issuerMembershipId: owner.membershipId, revokedAt: null,
        }),
      ]);
      const delegation = delegations[0]!;
      const rights = z.array(z.object({
        resourceKind: z.string(), resourceId: z.string(), capability: z.string(),
      })).parse(delegation.rights).sort((a, b) => a.capability.localeCompare(b.capability));
      expect(rights).toEqual([
        { resourceKind: 'account', resourceId: context.seeded.accountIds['acct-checking'], capability: 'existence' },
        { resourceKind: 'account', resourceId: context.seeded.accountIds['acct-checking'], capability: 'name' },
      ]);
      expect(JSON.stringify(delegation.rights)).not.toContain(context.seeded.accountIds['acct-savings']);
      const credentialsResponse = await request(context, `${path}/credentials`);
      const credentials = result<{ credentials: readonly Record<string, unknown>[] }>(credentialsResponse.body).credentials;
      expect(credentials).toEqual([
        expect.objectContaining({
          principalType: 'agent', principalId: agent.agentId, delegationId: delegation.id,
          delegationVersion: delegation.version, issuerMembershipId: owner.membershipId, revokedAt: null,
        }),
      ]);
      expect(credentials[0]!.credentialId).toEqual(expect.any(String));
      for (const credential of credentials) {
        for (const key of ['apiKey', 'keySecret', 'token', 'password', 'cookieHeader'])
          expect(credential).not.toHaveProperty(key);
      }
    } finally {
      await stopScenarioProcesses(context.processes);
    }
  }, 180_000);
});

describe('Published merchant subject initialization', () => {
  it.each(['merchant-research-success', 'merchant-research-outage', 'merchant-research-lifecycle'])(
    '%s persists independent fixture opt-ins and exact compiled-subject rights without dispatch before consent',
    async (id) => {
      const context = await load(id);
      try {
        const owner = context.initialized.personas.owner!;
        for (const endpoint of ['/api/merchant/policy', '/api/merchant/space-policy']) {
          const response = await request(context, endpoint);
          expect(response.response.status).toBe(200);
          const policy = result<MerchantPolicyView>(response.body);
          expect(policy.scope.spaceId).toBe(owner.spaceId);
          expect(policy.scope.budgetId).toBe(context.seeded.budgetId);
          expect(policy.version).toBe(1);
          expect(policy.value).toEqual({
            mode: 'external-allowed', allowedProviderIds: ['valueserp'],
            maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100,
            billingCurrency: 'USD', cacheTtlHours: 1,
          });
        }
        const analyzed = await request(context, '/api/merchant');
        expect(analyzed.response.status).toBe(200);
        const analysis = result<MerchantAnalysisView>(analyzed.body);
        const transactionId = context.seeded.transactionIds['synthetic-holdout-000-02']!;
        const evidenceKey = `merchant:transaction:${transactionId}`;
        const target = analysis.suggestions.find((subject) => subject.transactionId === transactionId);
        expect(target?.accountId).toBe(context.seeded.accountIds['acct-checking']);
        expect(target?.evidenceKey).toBe(evidenceKey);
        if (!target) throw new Error('Compiled seed target was not admitted');
        const grantResponse = await request(context, `/api/spaces/${owner.spaceId}/grants`);
        expect(grantResponse.response.status).toBe(200);
        const current = result<{ grants: GovernanceResourceGrant[] }>(grantResponse.body).grants
          .filter((grant) => grant.membershipId === owner.membershipId && grant.granted && grant.revokedAt === null);
        expect(current.filter((grant) => grant.resourceKind === 'evidence' && grant.resourceId === evidenceKey)
          .map(({ capability }) => capability).sort()).toEqual(['evidence', 'merchant:research', 'normalized-evidence', 'source']);
        expect(current.filter((grant) => grant.resourceKind === 'account' && grant.capability === 'merchant:research')
          .map(({ resourceId }) => resourceId)).toEqual([context.seeded.accountIds['acct-checking']]);
        const publishedKeys = new Set([
          ...analysis.suggestions.map((subject) => subject.evidenceKey),
          ...analysis.recurrences.map((subject) => subject.evidenceKey),
        ]);
        for (const grant of current.filter(({ resourceKind }) => resourceKind === 'evidence')) {
          expect(publishedKeys.has(grant.resourceId)).toBe(true);
          expect(grant.actorId).toBe(owner.actorId);
          expect(grant.spaceId).toBe(owner.spaceId);
          expect(grant.resourceId).not.toBe('*');
        }
        const previewResponse = await request(context, '/api/merchant/research/preview', {
          method: 'POST',
          body: JSON.stringify({
            evidenceKey, evidenceRevision: target.evidenceRevision,
            merchant: 'Aster Atelier', locale: null, publicBusiness: true,
          }),
        });
        expect(previewResponse.response.status).toBe(200);
        const preview = result<MerchantResearchPreview>(previewResponse.body);
        expect(preview.status).toBe('ready');
        if (preview.status !== 'ready') throw new Error('Published subject lacks fixture research authority');
        expect(preview.evidenceKey).toBe(evidenceKey);
        expect(preview.evidenceRevision).toBe(target.evidenceRevision);
        expect(preview.fieldsSent).toEqual(['merchant', 'locale']);
        expect(preview.providerId).toBe('valueserp');
        expect(preview.providerVersion).toBe('scenario-fixture/1');
        expect(preview.maxCostAtoms).toBe('250000');
        expect(preview.billingCurrency).toBe('USD');
        expect(/^[a-f0-9]{32,128}$/.test(preview.previewToken)).toBe(true);
        expect(telemetry(context)).toMatchObject({ calls: 0, held: 0 });
        expect(journal(context)).toEqual([]);
      } finally {
        await stopScenarioProcesses(context.processes);
      }
    }, 180_000,
  );
});

describe('Exact merchant proposal actor initialization', () => {
  const stableContext = z.object({
    scope: z.object({ spaceId: z.string(), budgetId: z.string(), connectionId: z.string() }),
    sourceFactsHash: z.string(), evidenceKey: z.string().nullable(), evidenceRevision: z.string(),
    merchantPolicyVersion: z.string(), visibilityHash: z.string(),
  });
  const privateProposal = z.object({
    id: z.string(), operation: z.enum(['create_rule', 'set_category']), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    requesterActorId: z.string(), requesterMembershipId: z.string(), requiredApprovers: z.number().int(),
    approvers: z.array(z.object({ actorId: z.string() }).passthrough()),
    privateEnvelopeVisible: z.boolean(), canApprove: z.boolean(), canExecute: z.boolean(),
    payload: z.record(z.unknown()), preconditions: z.record(z.unknown()),
  }).passthrough();
  const queue = z.object({
    items: z.array(z.object({
      reviewItem: z.object({ id: z.string(), transactionId: z.string() }).passthrough(),
      evidence: z.object({ merchantEvidence: z.object({ reviewContext: z.record(z.unknown()) }).passthrough().optional() }).passthrough(),
    }).passthrough()),
  });
  const identity = (resource: GovernanceResourceRef) => JSON.stringify([resource.resourceKind, resource.resourceId]);
  const cases = [
    { id: 'merchant-native-rule-lifecycle', transaction: 'synthetic-holdout-000-00', category: 'cat-groceries', operation: 'create_rule', reviewers: ['coapprover', 'approver'], requiredApprovers: 2 },
    { id: 'merchant-alias-conflict', transaction: 'synthetic-holdout-000-03', category: 'cat-other', operation: 'set_category', reviewers: ['approver'], requiredApprovers: 1 },
  ] as const;

  it.each(cases)('$id privately displays the exact normal proposal to independent limited human approvers only', async (recipe) => {
    await withScenario(recipe.id, async (handle) => {
      const owner = handle.initialized.personas.owner!;
      const transactionId = handle.seeded.transactionIds[recipe.transaction]!;
      const categoryId = handle.seeded.categoryIds[recipe.category]!;
      const analyzed = await scenarioRequest(handle, '/api/merchant');
      expect(analyzed.status).toBe(200);
      const analysis = result<MerchantAnalysisView>(analyzed.body);
      const target = analysis.suggestions.find((subject) => subject.transactionId === transactionId);
      expect(target?.evidenceKey).toBe(`merchant:transaction:${transactionId}`);
      if (!target) throw new Error('Native target was not independently published');
      const synced = await scenarioRequest(handle, '/api/review/sync', { method: 'POST', body: {} });
      expect(synced.status).toBe(200);
      expect(result(synced.body)).toMatchObject({ synchronized: true, failed: 0 });
      const listed = await scenarioRequest(handle, '/api/review');
      expect(listed.status).toBe(200);
      const item = queue.parse(result(listed.body)).items.find((row) => row.reviewItem.transactionId === transactionId);
      if (!item) throw new Error('Normal Review omitted the selected actual transaction');
      if (recipe.operation === 'create_rule') {
        const originalContext = stableContext.parse(target.reviewContext);
        expect(originalContext.scope).toMatchObject({ spaceId: owner.spaceId, budgetId: handle.seeded.budgetId });
        expect(stableContext.parse(item.evidence.merchantEvidence?.reviewContext)).toEqual(originalContext);
        const current = await scenarioRequest(handle, `/api/merchant?transactionId=${encodeURIComponent(transactionId)}`);
        expect(current.status).toBe(200);
        const refreshed = result<MerchantAnalysisView>(current.body).suggestions.find((subject) => subject.transactionId === transactionId);
        expect(stableContext.parse(refreshed?.reviewContext)).toEqual(originalContext);
      }
      const created = await scenarioRequest(handle,
        recipe.operation === 'create_rule' ? '/api/review/propose-rule' : '/api/review/correct',
        { method: 'POST', body: { reviewId: item.reviewItem.id, categoryId } });
      expect(created.status).toBe(200);
      const proposal = privateProposal.parse(asObject(result(created.body), 'normal proposal result').proposal);
      expect(proposal).toMatchObject({
        operation: recipe.operation, requesterActorId: owner.actorId, requesterMembershipId: owner.membershipId,
        requiredApprovers: recipe.requiredApprovers, approvers: [], privateEnvelopeVisible: true,
        canApprove: false, canExecute: false,
        payload: { kind: recipe.operation, transactionId, categoryId },
      });
      const ownerView = await scenarioRequest(handle, `/api/proposal/${encodeURIComponent(proposal.id)}`, { freshProof: true });
      expect(ownerView.status).toBe(200);
      const ownerDetail = asObject(result(ownerView.body), 'owner normal proposal detail');
      expect(privateProposal.parse(ownerDetail.proposal)).toMatchObject({
        id: proposal.id, payloadHash: proposal.payloadHash, requesterActorId: owner.actorId,
        privateEnvelopeVisible: true, canApprove: false, canExecute: false,
      });
      if (recipe.operation === 'create_rule') {
        expect(ownerDetail).toMatchObject({ stale: false, simulationStatus: 'present' });
        expect(asObject(ownerDetail.simulation, 'native simulation').examples).toEqual(expect.arrayContaining([
          expect.objectContaining({
            txId: transactionId, amount: { minorUnits: '-74965', currency: 'USD' },
            currentCategory: null, wouldChange: true,
          }),
        ]));
      }
      const facts = deriveProposalAuthorizationFacts(proposal.operation, proposal.payload, proposal.preconditions);
      const baseline = new Set(handle.seeded.readResources.map(identity));
      const evidence = new Set(analysis.suggestions.map(({ evidenceKey }) => identity({ resourceKind: 'evidence', resourceId: evidenceKey })));
      const allowed = new Set([...baseline, ...evidence]);
      const privateResources = new Map(facts.resources.map((resource) => [identity(resource), resource]));
      if (recipe.operation === 'create_rule') {
        const dependencies = z.array(z.object({
          resourceKind: z.enum(['account', 'category', 'transaction', 'rule']), resourceId: z.string(),
        })).parse(proposal.preconditions.sourceDependencies);
        expect(new Set(dependencies.map(identity))).toEqual(baseline);
        for (const resource of dependencies) privateResources.set(identity(resource), resource);
        expect(privateResources.has(identity({ resourceKind: 'evidence', resourceId: target.evidenceKey }))).toBe(true);
      }
      for (const resource of privateResources.values()) {
        expect(resource.resourceKind).not.toBe('budget');
        expect(allowed.has(identity(resource))).toBe(true);
        expect(resource.resourceId).not.toBe('*');
      }
      const grantReply = await scenarioRequest(handle, `/api/spaces/${owner.spaceId}/grants`);
      expect(grantReply.status).toBe(200);
      const allGrants = result<{ grants: GovernanceResourceGrant[] }>(grantReply.body).grants
        .filter((grant) => grant.granted && grant.revokedAt === null);
      const reviewerIds = recipe.reviewers.map((id) => handle.initialized.personas[id]!.actorId);
      expect(new Set(reviewerIds).size).toBe(recipe.requiredApprovers);
      expect(reviewerIds).not.toContain(owner.actorId);
      for (const personaId of recipe.reviewers) {
        const reviewer = handle.initialized.personas[personaId]!;
        expect(reviewer.cookieHeader === owner.cookieHeader).toBe(false);
        expect(reviewer.membershipId).not.toBe(owner.membershipId);
        const grants = allGrants.filter((grant) => grant.membershipId === reviewer.membershipId);
        expect(grants.some((grant) => grant.resourceKind === 'budget' && grant.capability === 'full-read')).toBe(false);
        expect(grants.some((grant) => ['rule:execute', 'categorization:execute', 'session:execute', 'grant:manage', 'policy:manage'].includes(grant.capability))).toBe(false);
        for (const grant of grants.filter((grant) => grant.capability === 'full-read'))
          expect(allowed.has(identity(grant))).toBe(true);
        for (const resource of privateResources.values())
          expect(grants.some((grant) => identity(grant) === identity(resource) && grant.capability === 'full-read')).toBe(true);
        for (const resource of facts.resources)
          expect(grants.some((grant) => identity(grant) === identity(resource) &&
            grant.capability === (recipe.operation === 'create_rule' ? 'rule:approve' : 'categorization:approve'))).toBe(true);
        const displayed = await scenarioRequest(handle, `/api/proposal/${encodeURIComponent(proposal.id)}`, { personaId, freshProof: true });
        expect(displayed.status).toBe(200);
        const detail = asObject(result(displayed.body), 'independent normal proposal detail');
        const visible = privateProposal.parse(detail.proposal);
        expect(visible).toMatchObject({
          id: proposal.id, payloadHash: proposal.payloadHash, requesterActorId: owner.actorId,
          requesterMembershipId: owner.membershipId, privateEnvelopeVisible: true, canApprove: true, canExecute: false,
          payload: { kind: recipe.operation, transactionId, categoryId },
        });
        if (recipe.operation === 'create_rule') expect(detail).toMatchObject({ stale: false, simulationStatus: 'present' });
        const deniedFinancial = await scenarioRequest(handle, '/api/home/budget-summary', { personaId });
        expect(deniedFinancial.status).toBe(403);
        expect(deniedFinancial.body).toMatchObject({ status: 'error', error: { code: 'FORBIDDEN' } });
        const deniedExecution = await scenarioRequest(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/execute`, { personaId, method: 'POST', body: {} });
        expect(deniedExecution.status).toBe(404);
        expect(deniedExecution.body).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } });
      }
      const excluded = await scenarioRequest(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/approve`,
        { method: 'POST', body: { payloadHash: proposal.payloadHash } });
      expect(excluded.status).toBe(403);
      expect(excluded.body).toMatchObject({ status: 'error', error: { code: 'FORBIDDEN' } });
      for (const personaId of recipe.reviewers) {
        const approved = await scenarioRequest(handle, `/api/proposal/${encodeURIComponent(proposal.id)}/approve`,
          { personaId, method: 'POST', body: { payloadHash: proposal.payloadHash } });
        expect(approved.status).toBe(200);
        expect(result(approved.body)).toMatchObject({ proposalId: proposal.id, status: 'active' });
      }
      const approved = await scenarioRequest(handle, `/api/proposal/${encodeURIComponent(proposal.id)}`, { freshProof: true });
      expect(approved.status).toBe(200);
      const approvedProposal = privateProposal.parse(asObject(result(approved.body), 'approved normal detail').proposal);
      expect(approvedProposal.canExecute).toBe(true);
      expect(approvedProposal.approvers.map(({ actorId }) => actorId).sort()).toEqual([...reviewerIds].sort());
      expect(journal(handle)).toEqual([]);
    });
  }, 180_000);
});
