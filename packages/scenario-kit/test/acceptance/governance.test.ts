import { describe, expect, it } from 'vitest';
import type {
  AgentDelegation,
  CredentialBinding,
  GovernanceAgent,
  GovernanceResourceGrant,
  SpaceMembership,
} from '@balanceframe/workflow-store';

import type { LoadedScenario } from '../../src/loader.js';
import { applyScenarioGovernanceAction } from '../../src/workflow-setup.js';
import { scenarioRequest, withScenario } from './support.js';

const TEST_TIMEOUT = 180_000;

type Envelope<T> =
  | { status: 'ok'; result: T }
  | { status: 'error'; result?: unknown; error?: { code?: string; reasonCodes?: string[] } | null };
type Response<T> = { status: number; body: Envelope<T> };
type Resources = { resources: { resourceKind: string; resourceId: string; name?: string }[] };
type Invitation = {
  id: string;
  status: string;
  spaceId: string;
  claimedEmail: string | null;
  redeemedUserId: string | null;
  claimedAt: string | null;
  redeemedAt: string | null;
};
type Audit = { records: { actorId: string; action: string; entityId: string | null }[]; total: number };

function resultOf<T>(response: Response<T>): T {
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('ok');
  if (response.body.status !== 'ok') throw new Error('Expected successful normal governance response');
  return response.body.result;
}

function denied(response: Response<unknown>, status = 403, code = 'FORBIDDEN'): void {
  expect(response.status).toBe(status);
  expect(response.body.status).toBe('error');
  if (response.body.status !== 'error') throw new Error('Expected denied normal governance response');
  expect(response.body.error?.code).toBe(code);
  expect(response.body.result).toBeNull();
}

function spacePath(handle: LoadedScenario): string {
  return `/api/spaces/${encodeURIComponent(handle.initialized.spaceId)}`;
}

/** Local ACL probe: real HTTP session admission, native Actual metadata, and live governed field grants. */
async function resources(handle: LoadedScenario): Promise<Resources> {
  const response = await applyScenarioGovernanceAction({
    handle, action: 'probe-limited', probe: 'checking-name',
  }) as { status: number; body: Resources };
  expect(response.status).toBe(200);
  return response.body;
}

async function memberships(handle: LoadedScenario): Promise<SpaceMembership[]> {
  return resultOf(await scenarioRequest<Envelope<{ memberships: SpaceMembership[] }>>(
    handle, `${spacePath(handle)}/memberships`,
  )).memberships;
}

async function setAccountGrant(
  handle: LoadedScenario,
  membershipId: string,
  logicalAccountId: 'acct-checking' | 'acct-savings',
  capability: 'name' | 'existence',
  granted: boolean,
): Promise<void> {
  const resourceId = handle.seeded.accountIds[logicalAccountId]!;
  const result = resultOf(await scenarioRequest<Envelope<{ grant: GovernanceResourceGrant | null }>>(
    handle, `${spacePath(handle)}/grants`, {
      method: 'PUT', body: { membershipId, resourceKind: 'account', resourceId, capability, granted },
    },
  ));
  if (!granted) {
    expect(result).toEqual({ grant: null });
    return;
  }
  expect(result.grant).toMatchObject({
    spaceId: handle.initialized.spaceId, membershipId, resourceKind: 'account', resourceId, capability, granted: true, revokedAt: null,
  });
}

async function revokeMembership(handle: LoadedScenario, membershipId: string): Promise<void> {
  expect(resultOf(await scenarioRequest<Envelope<{ revoked: boolean }>>(
    handle, `${spacePath(handle)}/memberships/${encodeURIComponent(membershipId)}/revoke`,
    { method: 'POST', body: {} },
  ))).toEqual({ revoked: true });
}

function noFinancialDisclosure(handle: LoadedScenario, body: unknown, withheldAccount = true): void {
  const serialized = JSON.stringify(body);
  for (const field of ['minorUnits', 'amount', 'balance', 'clearedBalance', 'importedBalance', 'history',
    'transactions', 'source', 'importedPayee', 'payeeName', 'notes']) {
    expect(serialized.includes(`"${field}"`)).toBe(false);
  }
  if (withheldAccount) expect(serialized).not.toContain(handle.seeded.accountIds['acct-savings']);
  for (const transactionId of Object.values(handle.seeded.transactionIds)) {
    expect(serialized).not.toContain(transactionId);
  }
}

async function financialReadsDenied(handle: LoadedScenario, personaId: string): Promise<void> {
  for (const path of ['/api/merchant', '/api/home/budget-summary', '/api/review']) {
    const response = await scenarioRequest<Envelope<unknown>>(handle, path, { personaId, freshProof: true });
    denied(response);
    noFinancialDisclosure(handle, response.body);
  }
}

function noCredentialDisclosure(body: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(body);
  for (const secret of secrets) expect(serialized.includes(secret)).toBe(false);
  for (const field of ['password', 'token', 'apiKey', 'cookieHeader']) {
    expect(serialized.includes(`"${field}"`)).toBe(false);
  }
}

describe('real selected-space governance stories', () => {
  it('governance-scoped-access uses local ACL probes for exact account rights, normal owner grant changes, and retained revoked attribution',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('governance-scoped-access', async (handle) => {
        const owner = handle.initialized.personas.owner!;
        const limited = handle.initialized.personas.limited!;
        const checking = handle.seeded.accountIds['acct-checking']!;
        const savings = handle.seeded.accountIds['acct-savings']!;
        expect(limited.actorId === owner.actorId).toBe(false);
        expect(limited.cookieHeader === owner.cookieHeader).toBe(false);
        expect(limited.membershipId === owner.membershipId).toBe(false);
        const admitted = resultOf(await scenarioRequest<Envelope<{ space: { membership: { id: string; actorId: string } } }>>(
          handle, spacePath(handle), { personaId: 'limited', freshProof: true },
        ));
        expect(admitted.space.membership).toMatchObject({ id: limited.membershipId, actorId: limited.actorId });
        noFinancialDisclosure(handle, admitted);
        const initial = await resources(handle);
        expect(initial).toEqual({ resources: [{ resourceKind: 'account', resourceId: checking,
          name: handle.scenario.ledger.accounts.find(({ id }) => id === 'acct-checking')!.name }] });
        noFinancialDisclosure(handle, initial);
        await financialReadsDenied(handle, 'limited');
        const unauthorizedGrant = await scenarioRequest<Envelope<unknown>>(handle, `${spacePath(handle)}/grants`, {
          method: 'PUT', personaId: 'limited', body: {
            membershipId: limited.membershipId, resourceKind: 'account', resourceId: savings, capability: 'name', granted: true,
          },
        });
        denied(unauthorizedGrant);
        noFinancialDisclosure(handle, unauthorizedGrant.body);

        await setAccountGrant(handle, limited.membershipId, 'acct-checking', 'name', false);
        const narrow = await resources(handle);
        expect(narrow).toEqual({ resources: [{ resourceKind: 'account', resourceId: checking }] });
        noFinancialDisclosure(handle, narrow);
        await financialReadsDenied(handle, 'limited');
        await setAccountGrant(handle, limited.membershipId, 'acct-checking', 'name', true);
        expect(await resources(handle)).toEqual({ resources: [{ resourceKind: 'account', resourceId: checking,
          name: handle.scenario.ledger.accounts.find(({ id }) => id === 'acct-checking')!.name }] });
        await setAccountGrant(handle, limited.membershipId, 'acct-checking', 'name', false);
        await setAccountGrant(handle, limited.membershipId, 'acct-checking', 'existence', false);
        expect(await resources(handle)).toEqual({ resources: [] });
        await revokeMembership(handle, limited.membershipId);
        const revokedRead = await scenarioRequest<Envelope<unknown>>(handle, spacePath(handle), {
          personaId: 'limited', freshProof: true,
        });
        denied(revokedRead);
        noFinancialDisclosure(handle, revokedRead.body);
        const retained = (await memberships(handle)).find(({ id }) => id === limited.membershipId)!;
        expect(retained).toMatchObject({ id: limited.membershipId, actorId: limited.actorId, spaceId: owner.spaceId });
        expect(Number.isFinite(Date.parse(retained.revokedAt!))).toBe(true);
        const grants = resultOf(await scenarioRequest<Envelope<{ grants: GovernanceResourceGrant[] }>>(
          handle, `${spacePath(handle)}/grants`,
        )).grants.filter(({ membershipId }) => membershipId === limited.membershipId);
        expect(grants.map(({ resourceId, capability, actorId, granted }) => ({ resourceId, capability, actorId, granted }))
          .sort((left, right) => `${left.resourceId}:${left.capability}`.localeCompare(`${right.resourceId}:${right.capability}`))).toEqual([
            { resourceId: checking, capability: 'existence', actorId: limited.actorId, granted: false },
            { resourceId: checking, capability: 'name', actorId: limited.actorId, granted: false },
            { resourceId: checking, capability: 'name', actorId: limited.actorId, granted: false },
          ].sort((left, right) => `${left.resourceId}:${left.capability}`.localeCompare(`${right.resourceId}:${right.capability}`)));
        const audit = resultOf(await scenarioRequest<Envelope<Audit>>(
          handle, `${spacePath(handle)}/audit?entityId=${encodeURIComponent(limited.membershipId)}&action=membership_revoked`,
        ));
        expect(audit.records.map(({ actorId, action, entityId }) => ({ actorId, action, entityId }))).toEqual([
          { actorId: owner.actorId, action: 'membership_revoked', entityId: limited.membershipId },
        ]);
        noCredentialDisclosure({ grants, audit }, [owner.password, limited.password, owner.cookieHeader, limited.cookieHeader]);
      }, { branches: [
        'scoped-access',
        'grant-change',
        'revoked-membership',
      ] });
    });

  it('governance-invitation-lifecycle creates no pending human, redeems a distinct identity, and rejoins the same actor without old rights',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('governance-invitation-lifecycle', async (handle) => {
        const owner = handle.initialized.personas.owner!;
        const pending = handle.initialized.governance!.pendingInvitations.invitee!;
        expect(Object.keys(handle.initialized.personas)).toEqual(['owner']);
        expect(Object.keys(pending).sort()).toEqual(['invitationId', 'token']);
        expect((await memberships(handle)).map(({ id, actorId }) => ({ id, actorId }))).toEqual([
          { id: owner.membershipId, actorId: owner.actorId },
        ]);
        const before = resultOf(await scenarioRequest<Envelope<{ items: Invitation[]; count: number }>>(
          handle, '/api/invitations', { freshProof: true },
        ));
        expect(before.count).toBe(1);
        expect(before.items).toHaveLength(1);
        expect(before.items[0]).toMatchObject({
          id: pending.invitationId, status: 'active', spaceId: owner.spaceId,
          claimedEmail: null, redeemedUserId: null, claimedAt: null, redeemedAt: null,
        });
        noCredentialDisclosure(before, [pending.token, owner.password, owner.cookieHeader]);
        expect(resultOf(await applyScenarioGovernanceAction({ handle, action: 'redeem-invitee' }) as Response<{ redeemed: boolean; spaceId: string }>))
          .toEqual({ redeemed: true, spaceId: owner.spaceId });
        const invitee = handle.initialized.personas.invitee!;
        expect(invitee.actorId === owner.actorId).toBe(false);
        expect(invitee.cookieHeader === owner.cookieHeader).toBe(false);
        expect(invitee.email === owner.email).toBe(false);
        const joined = await memberships(handle);
        expect(joined.map(({ actorId }) => actorId).sort()).toEqual([owner.actorId, invitee.actorId].sort());
        expect(joined.find(({ id }) => id === invitee.membershipId)).toMatchObject({
          actorId: invitee.actorId, spaceId: owner.spaceId, revokedAt: null,
        });
        const initialGrants = resultOf(await scenarioRequest<Envelope<{ grants: GovernanceResourceGrant[] }>>(
          handle, `${spacePath(handle)}/grants`,
        )).grants;
        expect(initialGrants.filter(({ membershipId }) => membershipId === invitee.membershipId)).toEqual([]);
        await financialReadsDenied(handle, 'invitee');
        const redeemed = resultOf(await scenarioRequest<Envelope<{ items: Invitation[]; count: number }>>(
          handle, '/api/invitations', { freshProof: true },
        ));
        expect(redeemed.items.find(({ id }) => id === pending.invitationId)).toMatchObject({
          status: 'redeemed', claimedEmail: invitee.email, redeemedUserId: invitee.actorId,
        });
        await setAccountGrant(handle, invitee.membershipId, 'acct-checking', 'existence', true);
        await setAccountGrant(handle, invitee.membershipId, 'acct-checking', 'name', true);
        await revokeMembership(handle, invitee.membershipId);
        denied(await scenarioRequest<Envelope<unknown>>(handle, spacePath(handle), { personaId: 'invitee', freshProof: true }));
        expect(resultOf(await applyScenarioGovernanceAction({ handle, action: 'rejoin-invitee' }) as Response<{ redeemed: boolean; spaceId: string }>))
          .toEqual({ redeemed: true, spaceId: owner.spaceId });
        const rejoined = handle.initialized.personas.invitee!;
        expect(rejoined.actorId).toBe(invitee.actorId);
        expect(rejoined.email).toBe(invitee.email);
        expect(rejoined.membershipId === invitee.membershipId).toBe(false);
        const periods = (await memberships(handle)).filter(({ actorId }) => actorId === invitee.actorId);
        expect(periods).toHaveLength(2);
        const oldPeriod = periods.find(({ id }) => id === invitee.membershipId)!;
        const newPeriod = periods.find(({ id }) => id === rejoined.membershipId)!;
        expect(Number.isFinite(Date.parse(oldPeriod.revokedAt!))).toBe(true);
        expect(newPeriod).toMatchObject({ actorId: invitee.actorId, spaceId: owner.spaceId, revokedAt: null });
        expect(Date.parse(newPeriod.validFrom)).toBeGreaterThanOrEqual(Date.parse(oldPeriod.revokedAt!));
        const current = resultOf(await scenarioRequest<Envelope<{ space: { membership: { id: string; actorId: string } } }>>(
          handle, spacePath(handle), { personaId: 'invitee', freshProof: true },
        ));
        expect(current.space.membership).toMatchObject({ id: rejoined.membershipId, actorId: invitee.actorId });
        await financialReadsDenied(handle, 'invitee');
        const grants = resultOf(await scenarioRequest<Envelope<{ grants: GovernanceResourceGrant[] }>>(
          handle, `${spacePath(handle)}/grants`,
        )).grants;
        expect(grants.filter(({ membershipId }) => membershipId === rejoined.membershipId)).toEqual([]);
        expect(grants.filter(({ membershipId }) => membershipId === invitee.membershipId)
          .map(({ actorId, capability }) => ({ actorId, capability })).sort((left, right) => left.capability.localeCompare(right.capability)))
          .toEqual([{ actorId: invitee.actorId, capability: 'existence' }, { actorId: invitee.actorId, capability: 'name' }]);
        noCredentialDisclosure({ redeemed, periods, grants }, [pending.token, owner.password, invitee.password, rejoined.password,
          owner.cookieHeader, invitee.cookieHeader, rejoined.cookieHeader]);
      }, { branches: [
        'pending-invitation',
        'invitation-redemption',
        'membership-rejoin',
      ] });
    });

  it('governance-delegated-assistant reads only delegated Checking metadata and the same real bound key is denied after revocation',
    { timeout: TEST_TIMEOUT }, async () => {
      await withScenario('governance-delegated-assistant', async (handle) => {
        const owner = handle.initialized.personas.owner!;
        const assistant = handle.initialized.governance!.assistant!;
        const checking = handle.seeded.accountIds['acct-checking']!;
        expect(Object.keys(handle.initialized.personas)).toEqual(['owner']);
        const agents = resultOf(await scenarioRequest<Envelope<{ agents: GovernanceAgent[] }>>(
          handle, `${spacePath(handle)}/agents`,
        )).agents;
        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({ agentId: assistant.agentId, registeredSpaceId: owner.spaceId, status: 'active', createdBy: owner.actorId });
        const credentials = resultOf(await scenarioRequest<Envelope<{ credentials: CredentialBinding[] }>>(
          handle, `${spacePath(handle)}/credentials`,
        )).credentials;
        expect(credentials).toHaveLength(1);
        expect(credentials[0]).toMatchObject({ credentialId: assistant.credentialId, principalType: 'agent',
          principalId: assistant.agentId, credentialOwnerId: owner.actorId, delegationId: assistant.delegationId,
          delegationVersion: assistant.delegationVersion, revokedAt: null });
        const before = resultOf(await scenarioRequest<Envelope<{ delegations: AgentDelegation[] }>>(
          handle, `${spacePath(handle)}/delegations`,
        )).delegations;
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ id: assistant.delegationId, version: assistant.delegationVersion,
          agentId: assistant.agentId, issuerActorId: owner.actorId, issuerMembershipId: owner.membershipId, revokedAt: null });
        expect(before[0]!.rights.map(({ resourceKind, resourceId, capability }) => ({ resourceKind, resourceId, capability }))
          .sort((left, right) => left.capability.localeCompare(right.capability))).toEqual([
            { resourceKind: 'account', resourceId: checking, capability: 'existence' },
            { resourceKind: 'account', resourceId: checking, capability: 'name' },
          ]);
        for (const probe of ['checking-name', 'checking-existence'] as const) {
          const response = await applyScenarioGovernanceAction({ handle, action: 'probe-assistant', probe }) as { status: number; body: Resources };
          expect(response.status).toBe(200);
          const view = response.body;
          expect(view).toEqual({ resources: [{ resourceKind: 'account', resourceId: checking,
            name: handle.scenario.ledger.accounts.find(({ id }) => id === 'acct-checking')!.name }] });
          noFinancialDisclosure(handle, view);
          noCredentialDisclosure(response.body, [assistant.apiKey, owner.password, owner.cookieHeader]);
        }
        for (const probe of ['manage-grants', 'financial', 'full-history'] as const) {
          const response = await applyScenarioGovernanceAction({ handle, action: 'probe-assistant', probe }) as Response<unknown>;
          denied(response);
          noFinancialDisclosure(handle, response.body);
          noCredentialDisclosure(response.body, [assistant.apiKey]);
        }
        expect(resultOf(await scenarioRequest<Envelope<{ revoked: boolean }>>(
          handle, `${spacePath(handle)}/delegations/${encodeURIComponent(assistant.delegationId)}/revoke`, {
            method: 'POST', body: { expectedVersion: assistant.delegationVersion },
          },
        ))).toEqual({ revoked: true });
        // Stay below Better Auth's real ten-request/day key quota: these formerly allowed reads prove revocation.
        for (const probe of ['checking-name', 'checking-existence'] as const) {
          const response = await applyScenarioGovernanceAction({ handle, action: 'probe-assistant', probe }) as Response<unknown>;
          denied(response, 401, 'UNAUTHORIZED');
          if (response.body.status !== 'error') throw new Error('Expected revoked credential response');
          expect(response.body.error?.reasonCodes).toEqual(['auth.invalid_credentials']);
          noFinancialDisclosure(handle, response.body);
          noCredentialDisclosure(response.body, [assistant.apiKey]);
        }
        expect(handle.initialized.governance!.assistant!.credentialId).toBe(assistant.credentialId);
        expect(handle.initialized.governance!.assistant!.apiKey === assistant.apiKey).toBe(true);
        const after = resultOf(await scenarioRequest<Envelope<{ delegations: AgentDelegation[] }>>(
          handle, `${spacePath(handle)}/delegations`,
        )).delegations;
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id: assistant.delegationId, agentId: assistant.agentId, version: assistant.delegationVersion });
        expect(Number.isFinite(Date.parse(after[0]!.revokedAt!))).toBe(true);
        const retainedCredentials = resultOf(await scenarioRequest<Envelope<{ credentials: CredentialBinding[] }>>(
          handle, `${spacePath(handle)}/credentials`,
        )).credentials;
        expect(retainedCredentials).toEqual(credentials);
        noCredentialDisclosure({ agents, credentials, retainedCredentials, before, after }, [assistant.apiKey, owner.password, owner.cookieHeader]);
      }, { branches: [
        'assistant-allow-deny',
        'delegation-revocation',
      ] });
    });
});
