import { randomBytes, randomUUID } from 'node:crypto';
import { downloadBudget, getAccounts, getCategories, getCategoryGroups, getPayees, getRules, getSchedules, getTransactions, init, shutdown } from '@actual-app/api';
import type { APICategoryEntity } from '@actual-app/api/models';
import { normalizeActualMerchantSource, type ActualMerchantSourceInput } from '@balanceframe/actual-adapter';
import { loadNativeBindings, lookupMerchantCalendar } from '@balanceframe/application';
import { merchantAnalysisRequestSchema, merchantAnalysisResultSchema, merchantScopeSchema, merchantSourceAdmissionSchema } from '@balanceframe/protocol-generated/validators';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteWorkflowStore, merchantPolicyValueSchema, type OperationalAuth, type ResourceRef } from '@balanceframe/workflow-store';
import type { LoadedScenario } from './loader.js';
import { assertScenarioProcessesActive, updateScenarioPersonas, type ScenarioProcesses } from './process-runtime.js';

import type {
  LiquidityPurchaseIntent,
  SpendSessionIntent,
} from '@balanceframe/application';

import type {
  MaterializedScenario,
  ScenarioClaimRecipe,
  ScenarioCompletionRecipe,
  ScenarioEntry,
  ScenarioObservations,
  ScenarioPersona,
  ScenarioPolicy,
} from './catalog.js';
import type {
  SeededActualBudget,
  SeededEntityIds,
} from './actual-seed.js';

type JsonObject = Record<string, unknown>;

type SessionResponse = {
  id: string;
  version: number;
};

type CompletionResponse = {
  id: string;
  version: number;
  phase: string;
  payloadHash: string | null;
};

export interface ScenarioPersonaCredentials {
  readonly actorId: string;
  readonly spaceId: string;
  readonly membershipId: string;
  readonly email: string;
  readonly password: string;
  /** Current Better Auth, selected-space and human-proof cookie name/value pairs. */
  readonly cookieHeader: string;
}

export type ScenarioMappedEntry =
  | { readonly kind: 'purchase'; readonly input: LiquidityPurchaseIntent }
  | { readonly kind: 'session'; readonly sessionKey: string; readonly sessionId: string }
  | {
      readonly kind: 'completion';
      readonly sessionKey: string;
      readonly sessionId: string;
      readonly completionKey: string;
      readonly completionId: string;
    }
  | { readonly kind: 'page'; readonly path: '/spaces' | '/review' | '/rules' | '/' };

export interface ScenarioInitialized {
  readonly spaceId: string;
  readonly budgetId: string;
  readonly groupId: string;
  readonly ids: SeededEntityIds;
  readonly personas: Readonly<Record<string, ScenarioPersonaCredentials>>;
  readonly sessions: Readonly<Record<string, string>>;
  readonly claims: Readonly<Record<string, string>>;
  readonly completions: Readonly<Record<string, string>>;
  readonly entry: ScenarioMappedEntry;
  /** Runner-private invitation tokens and assistant credentials; never forwarded to the browser. */
  readonly governance?: {
    readonly pendingInvitations: Record<string, { readonly invitationId: string; readonly token: string }>;
    readonly assistant?: {
      readonly agentId: string;
      readonly delegationId: string;
      readonly delegationVersion: string;
      readonly credentialId: string;
      readonly apiKey: string;
    };
  };
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`${label} must be a safe integer`);
  return value;
}

function result(value: unknown, label: string): unknown {
  const response = object(value, label);
  if (response.status !== 'ok') throw new Error(`${label} returned an unsuccessful response`);
  if (!Object.prototype.hasOwnProperty.call(response, 'result'))
    throw new Error(`${label} omitted its result`);
  return response.result;
}

function resultObject(value: unknown, label: string): JsonObject {
  return object(result(value, label), `${label}.result`);
}
function safeResponseFailure(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '';
  const response = value as JsonObject;
  const error = response.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return '';
  const details = error as JsonObject;
  const parts: string[] = [];
  if (typeof details.code === 'string' && details.code.length > 0) parts.push(details.code);
  if (Array.isArray(details.reasonCodes)) {
    const codes = details.reasonCodes.filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    if (codes.length > 0) parts.push(`reasonCodes=${codes.join(',')}`);
  }
  return parts.join(' ');
}

function mapId(
  ids: Readonly<Record<string, string>>,
  logicalId: string,
  label: string,
): string {
  const mapped = ids[logicalId];
  if (!mapped) throw new Error(`${label} references unmapped logical ID ${logicalId}`);
  return mapped;
}

function mapNullableId(
  ids: Readonly<Record<string, string>>,
  logicalId: string | null,
  label: string,
): string | null {
  return logicalId === null ? null : mapId(ids, logicalId, label);
}

function assertLoopbackHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error(`${label} must use HTTP or HTTPS`);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`${label} must not contain credentials, paths, query, or fragment data`);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    throw new Error(`${label} must use a loopback host`);
  return parsed;
}

function assertPublicOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('publicOrigin must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('publicOrigin must use HTTP or HTTPS');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('publicOrigin must contain only an origin');
  return parsed;
}

function splitSetCookie(value: string): readonly string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function setCookieValues(headers: Headers): readonly string[] {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === 'function')
    return headersWithSetCookie.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? splitSetCookie(combined) : [];
}

function cookiePair(value: string): [string, string] | null {
  const pair = value.split(';', 1)[0] ?? '';
  const separator = pair.indexOf('=');
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  const cookieValue = pair.slice(separator + 1).trim();
  if (!name || !cookieValue) return null;
  return [name, cookieValue];
}

/**
 * Origin-bound private client for owned initialization and finite fixture controls.
 * It connects to loopback but always presents the configured
 * public Host and Origin so Better Auth uses the same cookie scope as the demo.
 */
export class ScenarioHttpClient {
  private readonly webUrl: URL;
  private readonly publicOrigin: URL;
  private readonly internalSecret: string | undefined;
  private readonly cookies = new Map<string, string>();
  private selectedSpaceId: string | undefined;

  /** Creates an origin-bound client with an independent cookie jar. */
  constructor(webUrl: string, publicOrigin: string, internalSecret?: string) {
    this.webUrl = assertLoopbackHttpUrl(webUrl, 'webUrl');
    this.publicOrigin = assertPublicOrigin(publicOrigin);
    this.internalSecret = internalSecret;
  }

  /** Returns current session, selection and reauthentication cookies. */
  get cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Reads a selected-space endpoint as this client's signed-in persona. */
  async get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  /** Posts an application request without client-supplied authority overrides. */
  async post(path: string, body: JsonObject, spaceId?: string): Promise<unknown> {
    return this.request('POST', path, body, spaceId);
  }

  /** Replaces application state inside the server-verified selected space. */
  async put(path: string, body: JsonObject): Promise<unknown> {
    return this.request('PUT', path, body);
  }

  /** Signs in independently and returns the server-verified actor ID. */
  async signIn(email: string, password: string): Promise<string> {
    await this.post('/api/auth/sign-in/email', { email, password });
    return this.currentActorId();
  }

  /** Resolves the authenticated Source session established by sign-in or invitation redemption. */
  async currentActorId(): Promise<string> {
    return (await this.currentSession()).actorId;
  }

  /** Uses the real Better Auth session response, not a persona-supplied session identifier. */
  async currentSession(): Promise<{ actorId: string; sessionId: string }> {
    const candidate = object(await this.get('/api/auth/get-session'), 'Better Auth get-session response');
    const sessionData = candidate.data === null ? candidate : object(candidate.data ?? candidate, 'session data');
    const user = object(sessionData.user, 'session user');
    const session = object(sessionData.session, 'session');
    const actorId = string(user.id, 'session user ID');
    if (session.userId !== actorId) throw new Error('Better Auth session identity mismatch');
    return { actorId, sessionId: string(session.id, 'session ID') };
  }

  /** Obtains a fresh human control proof using this persona's own password. */
  async reauthenticate(password: string): Promise<void> {
    await this.post('/api/reauth', { password });
  }

  /** Selects a current membership through Source and retains its selection cookie. */
  async selectSpace(spaceId: string): Promise<void> {
    const selected = resultObject(
      await this.request('POST', `/api/spaces/${spaceId}/select`, {}, spaceId), 'space selection',
    );
    if (string(object(selected.space, 'selected space').id, 'selected space ID') !== spaceId)
      throw new Error('Source selected a different scenario space');
    this.selectedSpaceId = spaceId;
  }

  /** Retains normal handler denials for bounded private probes; explicit keys never fall back to cookies. */
  async getResponse(path: string, apiKey?: string, spaceId?: string): Promise<HttpResult> {
    return this.response('GET', path, undefined, spaceId, apiKey);
  }

  private async request(method: string, path: string, body?: JsonObject, spaceId = this.selectedSpaceId): Promise<unknown> {
    const result = await this.response(method, path, body, spaceId);
    if (result.status < 200 || result.status >= 300) {
      const details = safeResponseFailure(result.body);
      throw new Error(
        `Scenario HTTP ${method} ${path} failed with status ${result.status}${details ? ` (${details})` : ''}`,
      );
    }
    return result.body;
  }

  private async response(method: string, path: string, body?: JsonObject, spaceId = this.selectedSpaceId, apiKey?: string): Promise<HttpResult> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Scenario HTTP path must be relative');
    const headers: Record<string, string> = {
      accept: 'application/json',
      host: this.publicOrigin.host,
      origin: this.publicOrigin.origin,
      'x-forwarded-host': this.publicOrigin.host,
      'x-forwarded-proto': this.publicOrigin.protocol.slice(0, -1),
    };
    if (this.internalSecret) headers['x-balanceframe-demo-internal'] = this.internalSecret;
    if (spaceId) headers['x-balanceframe-space'] = spaceId;
    const cookie = this.cookieHeader;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    else if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(path, this.webUrl).toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!apiKey) this.rememberCookies(response.headers);
    const responseBody: unknown = await response.json();
    return { status: response.status, body: responseBody };
  }

  private rememberCookies(headers: Headers): void {
    for (const header of setCookieValues(headers)) {
      const pair = cookiePair(header);
      if (pair) this.cookies.set(pair[0], pair[1]);
    }
  }
}

function credentialsFor(persona: Pick<ScenarioPersona, 'id'>, scenarioId: string): { email: string; password: string } {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  return {
    email: `scenario-${scenarioId}-${persona.id}-${suffix}@example.invalid`.toLowerCase(),
    password: randomBytes(24).toString('base64url'),
  };
}

/** Maps policy resource IDs and rebases its anchor-relative validity at submission. */
export function mapPolicy(
  policy: ScenarioPolicy,
  ids: SeededEntityIds,
  anchor: string,
  submittedAt = Date.now(),
): ScenarioPolicy {
  return {
    ...policy,
    expiresAt: materializeExpiryAtSubmission(policy.expiresAt, anchor, submittedAt),
    accounts: policy.accounts.map((account) => ({
      ...account,
      accountId: mapId(ids.accountIds, account.accountId, 'policy account'),
      eligibleCategoryIds: account.eligibleCategoryIds.map((categoryId) =>
        mapId(ids.categoryIds, categoryId, 'policy category')),
    })),
    transferRoutes: policy.transferRoutes.map((route) => ({
      ...route,
      sourceAccountId: mapId(ids.accountIds, route.sourceAccountId, 'transfer source account'),
      destinationAccountId: mapId(
        ids.accountIds,
        route.destinationAccountId,
        'transfer destination account',
      ),
    })),
    categoryPolicies: policy.categoryPolicies?.map((categoryPolicy) => ({
      ...categoryPolicy,
      categoryId: mapId(ids.categoryIds, categoryPolicy.categoryId, 'category policy'),
    })),
  };
}


/**
 * Rebase a catalog expiry at the HTTP submission boundary while preserving the
 * recipe's duration from its materialization anchor.
 */
function materializeExpiryAtSubmission(
  expiresAt: string,
  anchor: string,
  submittedAt = Date.now(),
): string {
  const anchorTime = Date.parse(anchor);
  const expiryTime = Date.parse(expiresAt);
  if (!Number.isFinite(anchorTime) || !Number.isFinite(expiryTime) || !Number.isFinite(submittedAt))
    throw new Error('Scenario workflow expiry timestamps must be valid');
  return new Date(submittedAt + expiryTime - anchorTime).toISOString();
}

/**
 * Maps account observations immediately before submission without rewriting
 * ordinary observation recipe timestamps.
 */
export function mapObservations(
  observations: ScenarioObservations,
  ids: SeededEntityIds,
  anchor: string,
  submittedAt = Date.now(),
): ScenarioObservations {
  return {
    ...observations,
    expiresAt: materializeExpiryAtSubmission(observations.expiresAt, anchor, submittedAt),
    observations: observations.observations.map((observation) => mapObservation(observation, ids)),
  };
}

/**
 * Maps a saved session immediately before submission without shifting its item
 * or price-provenance timestamps.
 */
export function mapSession(
  session: SpendSessionIntent,
  ids: SeededEntityIds,
  anchor: string,
  submittedAt = Date.now(),
): SpendSessionIntent {
  return {
    ...session,
    expiresAt: materializeExpiryAtSubmission(session.expiresAt, anchor, submittedAt),
    accountId: mapNullableId(ids.accountIds, session.accountId, 'session account'),
    items: session.items.map((item) => ({
      ...item,
      categoryId: mapId(ids.categoryIds, item.categoryId, 'session category'),
      accountId: mapNullableId(ids.accountIds, item.accountId, 'session item account'),
      categoryAllocations: item.categoryAllocations?.map((allocation) => ({
        ...allocation,
        categoryId: mapId(ids.categoryIds, allocation.categoryId, 'session allocation category'),
      })),
    })),
    adjustments: session.adjustments?.map((adjustment) => ({
      ...adjustment,
      categoryId: mapId(ids.categoryIds, adjustment.categoryId, 'session adjustment category'),
    })),
    warningThresholds: session.warningThresholds?.map((threshold) =>
      threshold.basis === 'category_charge'
        ? {
            ...threshold,
            categoryId: mapId(ids.categoryIds, threshold.categoryId, 'session warning category'),
          }
        : threshold),
  };
}

function mapObservation(
  observation: ScenarioObservations['observations'][number],
  ids: SeededEntityIds,
): ScenarioObservations['observations'][number] {
  const credit = observation.credit;
  return {
    ...observation,
    accountId: mapId(ids.accountIds, observation.accountId, 'observation account'),
    ...(observation.unsettledFlows
      ? {
          unsettledFlows: observation.unsettledFlows.map((flow) => ({
            ...flow,
            matchedTransactionIds: flow.matchedTransactionIds.map((transactionId) =>
              mapId(ids.transactionIds, transactionId, 'unsettled-flow transaction')),
            transferTransactionId: flow.transferTransactionId
              ? mapId(ids.transactionIds, flow.transferTransactionId, 'transfer transaction')
              : null,
          })),
        }
      : {}),
    ...(observation.obligations
      ? {
          obligations: observation.obligations.map((obligation) => ({
            ...obligation,
            categoryId: obligation.categoryId
              ? mapId(ids.categoryIds, obligation.categoryId, 'obligation category')
              : null,
            matchedTransactionIds: obligation.matchedTransactionIds.map((transactionId) =>
              mapId(ids.transactionIds, transactionId, 'obligation transaction')),
          })),
        }
      : {}),
    ...(credit
      ? {
          credit: {
            ...credit,
            paymentAccountId: mapId(
              ids.accountIds,
              credit.paymentAccountId,
              'credit payment account',
            ),
            paymentCategoryId: mapId(
              ids.categoryIds,
              credit.paymentCategoryId,
              'credit payment category',
            ),
          },
        }
      : {}),
  };
}


function mapPurchase(input: LiquidityPurchaseIntent, ids: SeededEntityIds): LiquidityPurchaseIntent {
  return {
    ...input,
    categoryId: mapId(ids.categoryIds, input.categoryId, 'entry category'),
    ...(input.accountId
      ? { accountId: mapId(ids.accountIds, input.accountId, 'entry account') }
      : {}),
  };
}

function mapEntry(
  entry: ScenarioEntry,
  ids: SeededEntityIds,
  sessions: Readonly<Record<string, string>>,
  completions: Readonly<Record<string, string>>,
): ScenarioMappedEntry {
  if (entry.kind === 'purchase') return { kind: 'purchase', input: mapPurchase(entry.input, ids) };
  if (entry.kind === 'page') return entry;
  const sessionId = sessions[entry.sessionKey];
  if (!sessionId) throw new Error(`Entry references uninitialized session ${entry.sessionKey}`);
  if (entry.kind === 'session') return { kind: 'session', sessionKey: entry.sessionKey, sessionId };
  const completionId = completions[entry.completionKey];
  if (!completionId)
    throw new Error(`Entry references uninitialized completion ${entry.completionKey}`);
  return {
    kind: 'completion',
    sessionKey: entry.sessionKey,
    sessionId,
    completionKey: entry.completionKey,
    completionId,
  };
}

function mapClaimScope(
  claim: ScenarioClaimRecipe,
  ids: SeededEntityIds,
): ScenarioClaimRecipe['scope'] {
  return {
    kind: claim.scope.kind,
    id:
      claim.scope.kind === 'account'
        ? mapId(ids.accountIds, claim.scope.id, 'claim account')
        : mapId(ids.categoryIds, claim.scope.id, 'claim category'),
  };
}

function mapGrantResource(
  resourceKind: ScenarioPersona['grants'][number]['resourceKind'],
  resourceId: string,
  ids: SeededEntityIds,
  budgetId: string,
): string {
  if (resourceKind === 'budget') return budgetId;
  if (resourceKind === 'account') return mapId(ids.accountIds, resourceId, 'grant account');
  if (resourceKind === 'category') return mapId(ids.categoryIds, resourceId, 'grant category');
  if (resourceKind === 'transaction') return mapId(ids.transactionIds, resourceId, 'grant transaction');
  if (resourceKind === 'rule') return mapId(ids.ruleIds, resourceId, 'grant rule');
  throw new Error('Session grants are not supported by the public grant catalog');
}

function assertSessionResponse(value: unknown, label: string): SessionResponse {
  const response = resultObject(value, label);
  return { id: string(response.id, `${label}.id`), version: number(response.version, `${label}.version`) };
}

function assertCompletionResponse(value: unknown, label: string): CompletionResponse {
  const response = resultObject(value, label);
  const payloadHash = response.payloadHash;
  if (payloadHash !== null && typeof payloadHash !== 'string')
    throw new Error(`${label}.payloadHash must be a string or null`);
  return {
    id: string(response.id, `${label}.id`),
    version: number(response.version, `${label}.version`),
    phase: string(response.phase, `${label}.phase`),
    payloadHash,
  };
}

function assertConfiguration(value: unknown, label: string): JsonObject {
  const configuration = resultObject(value, label);
  const policy = object(configuration.policy, `${label}.policy`);
  string(policy.version, `${label}.policy.version`);
  string(policy.policyHash, `${label}.policy.policyHash`);
  number(configuration.observationVersion, `${label}.observationVersion`);
  return configuration;
}

function invitationToken(value: unknown): string {
  const invitation = resultObject(value, 'invitation creation');
  const inviteUrl = string(invitation.inviteUrl, 'invitation URL');
  let parsed: URL;
  try {
    parsed = new URL(inviteUrl);
  } catch {
    throw new Error('Invitation URL is invalid');
  }
  const token = new URLSearchParams(parsed.hash.replace(/^#/, '')).get('token');
  if (!token) throw new Error('Invitation URL omitted its token');
  return token;
}

const MERCHANT_SOURCE_RIGHTS: Partial<Record<ResourceRef['resourceKind'], readonly string[]>> = {
  budget: ['observe', 'merchant:analyze', 'rule:view', 'source'],
  account: ['existence', 'name', 'history', 'source'],
  category: ['existence', 'name', 'source'],
  transaction: ['transaction.view', 'source'],
  rule: ['rule:view', 'source'],
};


async function saveScenarioGrants(
  client: ScenarioHttpClient,
  scenario: MaterializedScenario,
  credentials: Readonly<Record<string, ScenarioPersonaCredentials>>,
  ids: SeededActualBudget,
  budgetId: string,
): Promise<void> {
  for (const persona of scenario.personas) {
    const actor = credentials[persona.id];
    if (!actor) throw new Error(`Missing credentials for grant persona ${persona.id}`);
    const grants = persona.grants.map((grant) => ({
      ...grant, resourceId: mapGrantResource(grant.resourceKind, grant.resourceId, ids, budgetId),
    }));
    if (persona.grants.some((grant) => grant.resourceKind === 'budget' && grant.capability === 'full-read' && grant.granted)) {
      // Full-read covers the real selected-budget baseline, never generated-resource write authority.
      const readCapabilities = ['full-read', 'conclusion', 'existence', 'name', 'balance', 'history', 'source', 'liquidity', 'category'] as const;
      const explicit = new Set(grants.map((grant) => `${grant.resourceKind}:${grant.resourceId}:${grant.capability}`));
      for (const resource of ids.readResources)
        for (const capability of readCapabilities)
          if (!explicit.has(`${resource.resourceKind}:${resource.resourceId}:${capability}`))
            grants.push({ ...resource, capability, granted: true });
    }
    const requested = new Map(grants.map((grant) => [
      `${grant.resourceKind}:${grant.resourceId}:${grant.capability}`, grant,
    ]));
    if (scenario.merchant && (persona.role === 'owner' || persona.role === 'coapprover')) {
      for (const resource of [{ resourceKind: 'budget' as const, resourceId: budgetId }, ...ids.readResources]) {
        for (const capability of MERCHANT_SOURCE_RIGHTS[resource.resourceKind] ?? []) {
          const key = `${resource.resourceKind}:${resource.resourceId}:${capability}`;
          if (!requested.has(key)) requested.set(key, { ...resource, capability, granted: true });
        }
      }
    }
    for (const grant of requested.values()) {
      await client.put(`/api/spaces/${actor.spaceId}/grants`, {
        membershipId: actor.membershipId,
        resourceKind: grant.resourceKind,
        resourceId: grant.resourceId,
        capability: grant.capability,
        granted: grant.granted,
      });
    }
  }
}

async function initializePersonas(
  ownerClient: ScenarioHttpClient,
  scenario: MaterializedScenario,
  bootstrapSecret: string,
  publicOrigin: string,
  webUrl: string,
  internalSecret?: string,
): Promise<{
  readonly ownerPersonaId: string;
  readonly spaceId: string;
  readonly clients: Readonly<Record<string, ScenarioHttpClient>>;
  readonly credentials: Readonly<Record<string, ScenarioPersonaCredentials>>;
}> {
  const ownerPersona = scenario.personas.find((persona) => persona.role === 'owner');
  if (!ownerPersona) throw new Error('Scenario must define an owner persona');
  const ownerCredentials = credentialsFor(ownerPersona, scenario.id);
  await ownerClient.post('/api/registration/bootstrap', {
    name: ownerPersona.displayName,
    email: ownerCredentials.email,
    password: ownerCredentials.password,
    bootstrapSecret,
  });
  const ownerActorId = await ownerClient.signIn(ownerCredentials.email, ownerCredentials.password);
  await ownerClient.reauthenticate(ownerCredentials.password);
  const created = resultObject(await ownerClient.post('/api/spaces', {
    name: `Scenario ${scenario.id}`,
    kind: scenario.personas.length === 1 && !scenario.governance ? 'personal' : 'shared',
  }), 'scenario space creation');
  const spaceId = string(object(created.space, 'scenario space').id, 'scenario space ID');
  await ownerClient.selectSpace(spaceId);
  const clients: Record<string, ScenarioHttpClient> = { [ownerPersona.id]: ownerClient };
  const identities: Record<string, Omit<ScenarioPersonaCredentials, 'membershipId'>> = {
    [ownerPersona.id]: {
      actorId: ownerActorId,
      spaceId,
      email: ownerCredentials.email,
      password: ownerCredentials.password,
      cookieHeader: ownerClient.cookieHeader,
    },
  };

  for (const persona of scenario.personas) {
    if (persona.id === ownerPersona.id) continue;
    await ownerClient.reauthenticate(ownerCredentials.password);
    const invited = await ownerClient.post('/api/invitations', {});
    const token = invitationToken(invited);
    const personaCredentials = credentialsFor(persona, scenario.id);
    const anonymousClient = new ScenarioHttpClient(webUrl, publicOrigin, internalSecret);
    const redeemed = resultObject(await anonymousClient.post('/api/invitations/redeem', {
      token,
      name: persona.displayName,
      email: personaCredentials.email,
      password: personaCredentials.password,
    }), 'scenario invitation redemption');
    if (redeemed.spaceId !== spaceId) throw new Error('Invitation redeemed into a different scenario space');
    const client = anonymousClient;
    const actorId = await client.currentActorId();
    await client.selectSpace(spaceId);
    clients[persona.id] = client;
    identities[persona.id] = {
      actorId,
      spaceId,
      email: personaCredentials.email,
      password: personaCredentials.password,
      cookieHeader: client.cookieHeader,
    };
  }
  const membershipResult = resultObject(
    await ownerClient.get(`/api/spaces/${spaceId}/memberships`), 'scenario memberships',
  );
  if (!Array.isArray(membershipResult.memberships)) throw new Error('Scenario memberships must be an array');
  const actorIds = new Set<string>();
  const credentials: Record<string, ScenarioPersonaCredentials> = {};
  for (const persona of scenario.personas) {
    const credential = identities[persona.id]!;
    if (actorIds.has(credential.actorId)) throw new Error(`Persona ${persona.id} resolved to a duplicate actor`);
    actorIds.add(credential.actorId);
    const membership = membershipResult.memberships.map((value) => object(value, 'scenario membership'))
      .find((member) => member.actorId === credential.actorId && member.revokedAt === null &&
        typeof member.validFrom === 'string' && Date.parse(member.validFrom) <= Date.now() &&
        (member.validUntil === null || (typeof member.validUntil === 'string' && Date.parse(member.validUntil) > Date.now())));
    if (!membership) throw new Error(`Persona ${persona.id} has no current scenario membership`);
    credentials[persona.id] = { ...credential, membershipId: string(membership.id, 'scenario membership ID') };
  }
  return { ownerPersonaId: ownerPersona.id, spaceId, clients, credentials };
}

async function initializeSessions(
  client: ScenarioHttpClient,
  scenario: MaterializedScenario,
  ids: SeededEntityIds,
): Promise<{ sessions: Record<string, string>; versions: Record<string, number> }> {
  const sessions: Record<string, string> = {};
  const versions: Record<string, number> = {};
  for (const [sessionKey, intent] of Object.entries(scenario.sessions)) {
    const response = await client.post(
      '/api/spend-sessions',
      mapSession(intent, ids, scenario.anchor),
    );
    const saved = assertSessionResponse(response, `session ${sessionKey}`);
    sessions[sessionKey] = saved.id;
    versions[sessionKey] = saved.version;
  }
  return { sessions, versions };
}

async function initializeClaims(
  client: ScenarioHttpClient,
  scenario: MaterializedScenario,
  ids: SeededEntityIds,
  sessions: Readonly<Record<string, string>>,
  versions: Readonly<Record<string, number>>,
): Promise<Record<string, string>> {
  const claims: Record<string, string> = {};
  for (const [claimKey, recipe] of Object.entries(scenario.claims)) {
    const sessionId = sessions[recipe.sessionKey];
    const expectedSessionVersion = versions[recipe.sessionKey];
    if (!sessionId || expectedSessionVersion === undefined)
      throw new Error(`Claim ${claimKey} references uninitialized session`);
    const response = await client.post('/api/liquidity/claims', {
      sessionId,
      expectedSessionVersion,
      kind: recipe.kind,
      scope: mapClaimScope(recipe, ids),
      idempotencyKey: `scenario:${scenario.id}:claim:${claimKey}:${randomUUID()}`,
    });
    const claim = resultObject(response, `claim ${claimKey}`);
    claims[claimKey] = string(claim.claimId, `claim ${claimKey}.claimId`);
  }
  return claims;
}

async function initializeCompletions(
  ownerClient: ScenarioHttpClient,
  clients: Readonly<Record<string, ScenarioHttpClient>>,
  credentials: Readonly<Record<string, ScenarioPersonaCredentials>>,
  scenario: MaterializedScenario,
  sessions: Readonly<Record<string, string>>,
  versions: Readonly<Record<string, number>>,
): Promise<Record<string, string>> {
  const completions: Record<string, string> = {};
  for (const [completionKey, recipe] of Object.entries(scenario.completions)) {
    const sessionId = sessions[recipe.sessionKey];
    const expectedSessionVersion = versions[recipe.sessionKey];
    if (!sessionId || expectedSessionVersion === undefined)
      throw new Error(`Completion ${completionKey} references uninitialized session`);
    const currentSession = resultObject(
      await ownerClient.get(`/api/spend-sessions/${sessionId}`),
      `completion ${completionKey} session`,
    );
    const currentCard = object(currentSession.card, `completion ${completionKey} Card`);
    if (currentCard.outcome !== 'funded_now')
      throw new Error(`Completion ${completionKey} requires a funded Card; outcome ${String(currentCard.outcome)}`);
    let completion = assertCompletionResponse(
      await ownerClient.post(`/api/spend-sessions/${sessionId}/completions`, {
        expectedSessionVersion,
        idempotencyKey: `scenario:${scenario.id}:completion:${completionKey}:${randomUUID()}`,
      }),
      `completion ${completionKey} proposal`,
    );
    completions[completionKey] = completion.id;
    if (recipe.stage !== 'proposed') {
      completion = await approveCompletion(
        clients,
        credentials,
        scenario,
        recipe,
        completionKey,
        sessionId,
        completion,
      );
    }
    if (recipe.stage === 'verified') {
      if (!completion.payloadHash)
        throw new Error(`Completion ${completionKey} has no payload hash before execution`);
      const owner = scenario.personas.find((persona) => persona.role === 'owner');
      if (!owner) throw new Error('Scenario must define an owner persona');
      await ownerClient.reauthenticate(credentials[owner.id]!.password);
      completion = assertCompletionResponse(
        await ownerClient.post(
          `/api/spend-sessions/${sessionId}/completions/${completion.id}/execute`,
          {
            payloadHash: completion.payloadHash,
            expectedVersion: completion.version,
            idempotencyKey: `scenario:${scenario.id}:execute:${completionKey}:${randomUUID()}`,
          },
        ),
        `completion ${completionKey} execution`,
      );
      if (completion.phase !== 'verified')
        throw new Error(`completion ${completionKey} did not reach verified state`);
    }
    completions[completionKey] = completion.id;
    if (completion.phase !== recipe.stage)
      throw new Error(`completion ${completionKey} reached ${completion.phase}, expected ${recipe.stage}`);
  }
  return completions;
}

async function approveCompletion(
  clients: Readonly<Record<string, ScenarioHttpClient>>,
  credentials: Readonly<Record<string, ScenarioPersonaCredentials>>,
  scenario: MaterializedScenario,
  recipe: ScenarioCompletionRecipe,
  completionKey: string,
  sessionId: string,
  initial: CompletionResponse,
): Promise<CompletionResponse> {
  let current = initial;
  for (const approverId of recipe.approvers) {
    if (current.phase === 'approved') break;
    const client = clients[approverId];
    if (!client) throw new Error(`Completion ${completionKey} references unknown approver ${approverId}`);
    if (!current.payloadHash) throw new Error(`Completion ${completionKey} has no payload hash`);
    const credential = credentials[approverId];
    if (!credential) throw new Error(`Missing credentials for approver ${approverId}`);
    await client.reauthenticate(credential.password);
    current = assertCompletionResponse(
      await client.post(`/api/spend-sessions/${sessionId}/completions/${current.id}/approve`, {
        payloadHash: current.payloadHash,
        expectedVersion: current.version,
        idempotencyKey: `scenario:${scenario.id}:approve:${completionKey}:${approverId}:${randomUUID()}`,
      }),
      `completion ${completionKey} approval`,
    );
  }
  return current;
}

interface PrivateWorkflowState {
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
  readonly webUrl: string;
  readonly publicOrigin: string;
  readonly internalSecret: string | undefined;
  readonly clients: Record<string, ScenarioHttpClient>;
  readonly credentials: Record<string, ScenarioPersonaCredentials>;
  readonly pendingInvitations: Record<string, { invitationId: string; token: string }>;
  readonly assistant: NonNullable<ScenarioInitialized['governance']>['assistant'];
}

const privateWorkflows = new WeakMap<ScenarioInitialized, PrivateWorkflowState>();

async function initializeGovernance(
  client: ScenarioHttpClient,
  scenario: MaterializedScenario,
  credentials: Readonly<Record<string, ScenarioPersonaCredentials>>,
  seeded: SeededActualBudget,
): Promise<ScenarioInitialized['governance']> {
  const recipe = scenario.governance;
  if (!recipe) return undefined;
  const owner = credentials.owner;
  if (!owner) throw new Error('Governance owner unavailable');
  await client.reauthenticate(owner.password);
  const path = `/api/spaces/${owner.spaceId}`;
  if (recipe.kind === 'coapproval-audit') {
    for (const personaId of recipe.readerPersonaIds) {
      const reader = credentials[personaId];
      if (!reader) throw new Error('Audit reader unavailable');
      await client.put(`${path}/grants`, {
        membershipId: reader.membershipId, resourceKind: 'space', resourceId: owner.spaceId,
        capability: 'audit:read', granted: true,
      });
    }
    return undefined;
  }
  const pendingInvitations: Record<string, { invitationId: string; token: string }> = {};
  if (recipe.kind === 'invitation-lifecycle') {
    for (const pending of recipe.pendingInvitations) {
      const created = await client.post('/api/invitations', {});
      pendingInvitations[pending.personaId] = {
        invitationId: string(object(resultObject(created, 'pending invitation').invitation, 'invitation').id, 'invitation ID'),
        token: invitationToken(created),
      };
    }
  }
  if (recipe.kind !== 'delegated-assistant') return { pendingInvitations };
  const registered = resultObject(await client.post(`${path}/agents`, {
    agentId: `scenario-assistant-${randomUUID()}`,
  }), 'assistant registration');
  const agentId = string(object(registered.agent, 'registered assistant').agentId, 'assistant ID');
  const rights = recipe.assistant.grants.filter(({ granted }) => granted).map((grant) => ({
    resourceKind: grant.resourceKind,
    resourceId: mapGrantResource(grant.resourceKind, grant.resourceId, seeded, seeded.budgetId),
    capability: grant.capability,
  }));
  const delegated = resultObject(await client.post(`${path}/delegations`, {
    agentId, issuerMembershipId: owner.membershipId, expectedVersion: null,
    rights, validFrom: new Date().toISOString(),
  }), 'assistant delegation');
  const delegation = object(delegated.delegation, 'delegation');
  const delegationId = string(delegation.id, 'delegation ID');
  const delegationVersion = string(delegation.version, 'delegation version');
  const key = object(await client.post('/api/auth/api-key/create', {
    name: 'Scenario Budget Assistant', expiresIn: 86400,
  }), 'Better Auth assistant key');
  const credentialId = string(key.id, 'assistant credential ID');
  const apiKey = string(key.key, 'assistant credential secret');
  resultObject(await client.post(`${path}/credentials`, {
    credentialId, principalType: 'agent', principalId: agentId,
    delegationId, expectedDelegationVersion: delegationVersion,
  }), 'assistant credential binding');
  return { pendingInvitations, assistant: { agentId, delegationId, delegationVersion, credentialId, apiKey } };
}

/** Private discovery compiles real admitted source; it never manufactures an opaque pattern ID. */
async function discoverScenarioMerchantPatterns(
  client: ScenarioHttpClient,
  seeded: SeededActualBudget,
  owner: ScenarioPersonaCredentials,
  processes: ScenarioProcesses,
  analysis: JsonObject,
): Promise<readonly string[]> {
  assertScenarioProcessesActive(processes);
  const scope = merchantScopeSchema.parse(analysis.scope);
  if (scope.spaceId !== owner.spaceId || scope.budgetId !== seeded.budgetId)
    throw new Error('Pattern discovery selected a different space or Actual budget');
  const session = await client.currentSession();
  if (session.actorId !== owner.actorId) throw new Error('Pattern discovery owner changed');
  const membership = resultObject(await client.get(`/api/spaces/${owner.spaceId}`), 'pattern discovery membership');
  if (object(object(membership.space, 'pattern discovery space').membership, 'pattern discovery membership').id !== owner.membershipId)
    throw new Error('Pattern discovery membership changed');
  const admission = merchantSourceAdmissionSchema.parse(analysis.sourceAdmission);
  const policyValue = merchantPolicyValueSchema.parse(resultObject(await client.get('/api/merchant/policy'), 'pattern discovery policy').value);
  const store = new SqliteWorkflowStore(processes.workflowDbPath);
  const dataDir = mkdtempSync(join(processes.root, 'merchant-source-discovery-'));
  let active = false;
  try {
    const policy = store.governance.getPolicy({ spaceId: owner.spaceId });
    if (!policy) throw new Error('Pattern discovery governance policy unavailable');
    const required = [{ resourceKind: 'budget' as const, resourceId: seeded.budgetId, capability: 'source' },
      { resourceKind: 'budget' as const, resourceId: seeded.budgetId, capability: 'rule:view' },
      ...seeded.readResources.flatMap((resource) => (MERCHANT_SOURCE_RIGHTS[resource.resourceKind] ?? [])
        .map((capability) => ({ ...resource, capability })))];
    const authorize = (): void => {
      assertScenarioProcessesActive(processes);
      if (!store.governance.authorize({
        actorId: session.actorId, spaceId: owner.spaceId, membershipId: owner.membershipId,
        expectedPolicyVersion: policy.version, phase: 'read', operation: 'merchant:analyze', required,
        payload: { operations: [{ operation: 'merchant:analyze', accountScope: { kind: 'global' } }] },
        auth: { method: 'session', actorId: session.actorId, sessionId: session.sessionId },
        now: new Date().toISOString(),
      }).allowed) throw new Error('Pattern discovery source admission was revoked');
    };
    authorize();
    await init({ serverURL: processes.actualUrl, password: processes.actualSecretKey, dataDir });
    active = true;
    await downloadBudget(seeded.groupId);
    authorize();
    const capturedAt = new Date().toISOString();
    const asOfDate = capturedAt.slice(0, 10);
    const start = new Date(`${asOfDate}T00:00:00Z`);
    start.setUTCFullYear(start.getUTCFullYear() - 5);
    const accounts = await getAccounts();
    const accountIds = seeded.readResources.filter(({ resourceKind }) => resourceKind === 'account').map(({ resourceId }) => resourceId);
    const transactions: ActualMerchantSourceInput['transactions'] = [];
    for (const accountId of accountIds) transactions.push({
      accountId, startDate: '0001-01-01', endDate: '9999-12-31',
      read: { state: 'complete', items: await getTransactions(accountId, '0001-01-01', '9999-12-31') },
    });
    const source = normalizeActualMerchantSource({
      capturedAt, expiresAt: new Date(Date.parse(capturedAt) + 86400000).toISOString(), currency: 'USD',
      accounts, transactions, startDate: start.toISOString().slice(0, 10), endDate: asOfDate, maxTransactions: 250000,
      payees: { state: 'complete', items: await getPayees() },
      categories: { state: 'complete', items: (await getCategories()).filter((row): row is APICategoryEntity => 'group_id' in row) },
      categoryGroups: await getCategoryGroups(), rules: { state: 'complete', items: await getRules() },
      schedules: { state: 'complete', items: await getSchedules() },
      admission: {
        visibilityHash: admission.visibilityHash, accountIds,
        categoryIds: seeded.readResources.filter(({ resourceKind }) => resourceKind === 'category').map(({ resourceId }) => resourceId),
        transactionIds: seeded.readResources.filter(({ resourceKind }) => resourceKind === 'transaction').map(({ resourceId }) => resourceId),
        sourceTransactionIds: seeded.readResources.filter(({ resourceKind }) => resourceKind === 'transaction').map(({ resourceId }) => resourceId),
        sourceAccountIds: accountIds, ruleIds: null, payeeIds: null, sourceScheduleIds: null, schedulePayeeIds: null,
      },
    });
    const calendars = accountIds.flatMap((accountId) => {
      const lookup = lookupMerchantCalendar({
        accountId, year: Number(asOfDate.slice(0, 4)),
        budget: policyValue.calendar?.budget ?? null, accounts: policyValue.calendar?.accounts ?? [],
      });
      return lookup.state === 'known' ? [{ ...lookup.calendar, accountId }] : [];
    });
    const native = await loadNativeBindings();
    if (!native.analyzeMerchantIntelligence) throw new Error('Compiled merchant analysis unavailable');
    const request = merchantAnalysisRequestSchema.parse({
      schemaVersion: '1', scope, snapshotId: `merchant:${source.sourceAdmission.factsHash}:${capturedAt}`,
      normalizationVersion: 'merchant/2', asOfDate, sourceAdmission: source.sourceAdmission,
      transactions: source.transactions, payees: source.payees, categories: source.categories,
      rules: source.rules, schedules: source.schedules, aliases: [], corrections: [], patternDecisions: [],
      calendars, horizonYears: 5, maxEvidence: 20,
    });
    const result = merchantAnalysisResultSchema.parse(JSON.parse(native.analyzeMerchantIntelligence(JSON.stringify(request))));
    if (JSON.stringify(result.scope) !== JSON.stringify(scope) ||
        result.sourceAdmission.factsHash !== source.sourceAdmission.factsHash ||
        result.sourceAdmission.visibilityHash !== source.sourceAdmission.visibilityHash)
      throw new Error('Compiled pattern discovery source changed');
    authorize();
    const current = await client.currentSession();
    if (current.actorId !== session.actorId || current.sessionId !== session.sessionId)
      throw new Error('Pattern discovery human session changed');
    return result.recurrences.map(({ id }) => `merchant:pattern:${id}`);
  } finally {
    try {
      if (active) await shutdown();
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

async function initializeScenarioMerchantSubjects(
  client: ScenarioHttpClient,
  scenario: MaterializedScenario,
  seeded: SeededActualBudget,
  credentials: Readonly<Record<string, ScenarioPersonaCredentials>>,
  processes: ScenarioProcesses,
): Promise<void> {
  if (!scenario.merchant) return;
  const owner = credentials.owner;
  if (!owner) throw new Error('Merchant source owner unavailable');
  const readers = scenario.personas.filter(({ role }) => role === 'owner' || role === 'coapprover')
    .map(({ id }) => credentials[id]!);
  const bootstrap = async (keys: readonly string[]): Promise<void> => {
    await client.reauthenticate(owner.password);
    for (const reader of readers)
      for (const resourceId of keys)
        for (const capability of ['evidence', 'normalized-evidence'])
          resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
            membershipId: reader.membershipId, resourceKind: 'evidence', resourceId, capability, granted: true,
          }), 'exact native evidence namespace grant');
  };
  const transactionKeys = scenario.merchant.targetTransactionIds
    .map((id) => `merchant:transaction:${mapId(seeded.transactionIds, id, 'merchant target transaction')}`);
  await bootstrap(transactionKeys);
  let analysis = resultObject(await client.get('/api/merchant'), 'compiled merchant source analysis');
  if (scenario.merchant.calendar) {
    await bootstrap(await discoverScenarioMerchantPatterns(client, seeded, owner, processes, analysis));
    analysis = resultObject(await client.get('/api/merchant'), 'published compiled calendar analysis');
  }
  if (!Array.isArray(analysis.suggestions) || !Array.isArray(analysis.recurrences))
    throw new Error('Merchant analysis omitted its public subjects');
  const suggestions = analysis.suggestions.map((value) => object(value, 'published merchant suggestion'));
  const recurrences = analysis.recurrences.map((value) => object(value, 'published merchant recurrence'));
  await client.reauthenticate(owner.password);
  for (const reader of readers) {
    for (const subject of [...suggestions, ...recurrences]) {
      const key = string(subject.evidenceKey, 'published native evidence key');
      const capability = scenario.personas.find(({ id }) => credentials[id] === reader)?.role === 'owner' &&
        (scenario.id === 'merchant-alias-conflict' || scenario.id === 'merchant-recurrence-calendar')
        ? ['source', 'merchant:confirm'] : ['source'];
      for (const right of capability)
        resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
          membershipId: reader.membershipId, resourceKind: 'evidence', resourceId: key, capability: right, granted: true,
        }), 'published merchant subject action grant');
    }
  }
  if (scenario.id === 'merchant-native-rule-lifecycle') {
    // Global native-rule intent binds the complete current source graph, not arbitrary financial writes.
    for (const reader of readers) {
      const rights = reader.actorId === owner.actorId
        ? ['full-read', 'rule:propose', 'rule:execute'] : ['full-read', 'rule:approve'];
      for (const resource of seeded.readResources.filter(({ resourceKind }) =>
        ['account', 'category', 'transaction', 'rule'].includes(resourceKind)))
        for (const capability of rights)
          resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
            membershipId: reader.membershipId, ...resource, capability, granted: true,
          }), 'finite native rule source intent grant');
      for (const subject of suggestions)
        for (const capability of rights)
          resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
            membershipId: reader.membershipId, resourceKind: 'evidence',
            resourceId: string(subject.evidenceKey, 'published native rule evidence'), capability, granted: true,
          }), 'exact native rule evidence intent grant');
    }
  }
  if (scenario.id === 'merchant-alias-conflict') {
    const reviewer = credentials.approver;
    if (!reviewer) throw new Error('Independent correction reviewer unavailable');
    const resources = new Map<string, ResourceRef>();
    const admit = (resourceKind: ResourceRef['resourceKind'], resourceId: string) =>
      resources.set(JSON.stringify([resourceKind, resourceId]), { resourceKind, resourceId });
    admit('category', mapId(seeded.categoryIds, 'cat-other', 'explicit correction category'));
    const current = object(analysis.localReview, 'current correction Review').candidates;
    if (!Array.isArray(current)) throw new Error('Current correction Review candidates unavailable');
    const candidates = current.map((row) => object(row, 'current correction candidate'));
    for (const logicalId of scenario.merchant.targetTransactionIds) {
      const transactionId = mapId(seeded.transactionIds, logicalId, 'correction target transaction');
      const target = suggestions.find((subject) => subject.transactionId === transactionId);
      if (!target) throw new Error('Correction target was not published by actual analysis');
      const source = object(target.sourceTransaction, 'published correction source transaction');
      if (source.id !== transactionId) throw new Error('Correction source identity changed');
      admit('transaction', transactionId);
      admit('account', string(source.accountId, 'actual correction account'));
      if (typeof source.categoryId === 'string') admit('category', source.categoryId);
      if (typeof target.categoryId === 'string') admit('category', target.categoryId);
      const candidate = candidates.find((row) => row.transactionId === transactionId);
      if (typeof candidate?.proposedCategoryId === 'string') admit('category', candidate.proposedCategoryId);
    }
    for (const resource of resources.values())
      resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
        membershipId: reviewer.membershipId, ...resource, capability: 'full-read', granted: true,
      }), 'exact correction private envelope read grant');
  }
  if (scenario.research) {
    for (const logicalId of scenario.merchant.targetTransactionIds) {
      const transactionId = mapId(seeded.transactionIds, logicalId, 'research target transaction');
      const transaction = scenario.ledger.transactions.find(({ id }) => id === logicalId);
      if (!transaction) throw new Error('Research target source transaction unavailable');
      const accountId = mapId(seeded.accountIds, transaction.accountId, 'research target account');
      const key = `merchant:transaction:${transactionId}`;
      const subject = suggestions.find((suggestion) => suggestion.transactionId === transactionId);
      if (!subject || subject.evidenceKey !== key || subject.accountId !== accountId)
        throw new Error('Research target was not published by actual analysis');
      for (const resource of [{ resourceKind: 'account', resourceId: accountId }, { resourceKind: 'evidence', resourceId: key }])
        resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
          membershipId: owner.membershipId, ...resource, capability: 'merchant:research', granted: true,
        }), 'published research target grant');
    }
  }
}

/** Initializes real scenario identities, exact Native grants and live Actual-backed workflows. */
export async function initializeScenarioWorkflow(options: {
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
  readonly processes: ScenarioProcesses;
}): Promise<ScenarioInitialized> {
  const { scenario, seeded, processes } = options;
  assertScenarioProcessesActive(processes);
  const client = new ScenarioHttpClient(processes.webUrl, processes.publicOrigin, processes.internalSecret);
  const personas = await initializePersonas(
    client,
    scenario,
    processes.bootstrapSecret,
    processes.publicOrigin,
    processes.webUrl,
    processes.internalSecret,
  );
  const ownerCredential = personas.credentials[personas.ownerPersonaId]!;
  await client.reauthenticate(ownerCredential.password);
  const connection = resultObject(
    await client.post('/api/connection', { budgetId: seeded.budgetId }),
    'Actual connection',
  );
  const connectedBudget = object(connection.budget, 'Actual connection budget');
  if (
    string(connectedBudget.id, 'Actual connection budget ID') !== seeded.budgetId ||
    string(connectedBudget.groupId, 'Actual connection group ID') !== seeded.groupId
  )
    throw new Error('Actual connection returned a different seeded budget');

  await client.reauthenticate(ownerCredential.password);
  await saveScenarioGrants(client, scenario, personas.credentials, seeded, seeded.budgetId);

  await client.reauthenticate(ownerCredential.password);
  const policy = mapPolicy(scenario.policy, seeded, scenario.anchor);
  const policyResult = assertConfiguration(
    await client.put('/api/liquidity/policy', { expectedVersion: null, ...policy }),
    'liquidity policy',
  );
  const observationVersion = number(
    policyResult.observationVersion,
    'liquidity policy observationVersion',
  );
  await client.reauthenticate(ownerCredential.password);
  assertConfiguration(
    await client.put('/api/liquidity/observations', {
      expectedVersion: observationVersion,
      ...mapObservations(scenario.observations, seeded, scenario.anchor),
    }),
    'liquidity observations',
  );
  if (scenario.merchant?.calendar) {
    await client.reauthenticate(ownerCredential.password);
    const current = resultObject(await client.get('/api/merchant/policy'), 'merchant calendar policy');
    const value = object(current.value, 'merchant policy value');
    resultObject(await client.put('/api/merchant/policy', {
      expectedVersion: number(current.version, 'merchant policy version'),
      value: {
        ...value,
        calendar: {
          ...scenario.merchant.calendar,
          accounts: scenario.merchant.calendar.accounts.map((account) => ({
            ...account, accountId: mapId(seeded.accountIds, account.accountId, 'merchant calendar account'),
          })),
        },
      },
    }), 'merchant calendar policy update');
  }
  if (scenario.research) {
    for (const endpoint of ['/api/merchant/policy', '/api/merchant/space-policy']) {
      await client.reauthenticate(ownerCredential.password);
      const current = resultObject(await client.get(endpoint), 'fixture research policy');
      resultObject(await client.put(endpoint, {
        expectedVersion: number(current.version, 'fixture policy version'),
        value: {
          ...object(current.value, 'fixture policy value'),
          mode: 'external-allowed', allowedProviderIds: ['valueserp'],
          maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 1,
        },
      }), 'fixture research policy update');
    }
  }
  await initializeScenarioMerchantSubjects(client, scenario, seeded, personas.credentials, options.processes);

  const ownerClient = personas.clients[personas.ownerPersonaId];
  if (!ownerClient) throw new Error('Owner client unavailable');
  resultObject(await ownerClient.get('/api/liquidity/grants'), 'liquidity grants');
  const sessionState = await initializeSessions(ownerClient, scenario, seeded);
  const claims = await initializeClaims(
    ownerClient,
    scenario,
    seeded,
    sessionState.sessions,
    sessionState.versions,
  );
  const completions = await initializeCompletions(
    ownerClient,
    personas.clients,
    personas.credentials,
    scenario,
    sessionState.sessions,
    sessionState.versions,
  );

  const governance = await initializeGovernance(client, scenario, personas.credentials, seeded);
  const initialized: ScenarioInitialized = {
    spaceId: personas.spaceId,
    budgetId: seeded.budgetId,
    groupId: seeded.groupId,
    ids: seeded,
    personas: Object.fromEntries(Object.entries(personas.credentials).map(([id, credential]) => [
      id, { ...credential, cookieHeader: personas.clients[id]!.cookieHeader },
    ])),
    sessions: sessionState.sessions,
    claims,
    completions,
    entry: mapEntry(scenario.entry, seeded, sessionState.sessions, completions),
    ...(governance ? { governance } : {}),
  };
  privateWorkflows.set(initialized, {
    scenario, seeded, webUrl: processes.webUrl, publicOrigin: processes.publicOrigin,
    internalSecret: processes.internalSecret,
    clients: { ...personas.clients }, credentials: { ...personas.credentials },
    pendingInvitations: Object.fromEntries(Object.entries(governance?.pendingInvitations ?? {}).map(
      ([id, pending]) => [id, { ...pending }],
    )),
    assistant: governance?.assistant ? { ...governance.assistant } : undefined,
  });
  return initialized;
}

export type ScenarioGovernanceAction =
  | { readonly handle: LoadedScenario; readonly action: 'redeem-invitee' | 'rejoin-invitee' }
  | {
      readonly handle: LoadedScenario;
      readonly action: 'probe-assistant' | 'probe-limited';
      readonly probe: 'checking-name' | 'checking-existence' | 'manage-grants' | 'financial' | 'full-history';
    };

function checkedWorkflow(handle: LoadedScenario): PrivateWorkflowState {
  assertScenarioProcessesActive(handle.processes);
  const state = privateWorkflows.get(handle.initialized);
  if (!state || state.scenario !== handle.scenario || state.seeded !== handle.seeded ||
      state.webUrl !== handle.processes.webUrl ||
      handle.initialized.spaceId !== state.credentials.owner?.spaceId ||
      handle.initialized.budgetId !== state.seeded.budgetId) {
    throw new Error('Unregistered or changed scenario workflow');
  }
  return state;
}

async function withScenarioNative<T>(handle: LoadedScenario, consume: () => Promise<T>): Promise<T> {
  checkedWorkflow(handle);
  const dataDir = mkdtempSync(join(handle.processes.root, 'governance-actual-client-'));
  let active = false;
  try {
    await init({ serverURL: handle.processes.actualUrl, password: handle.processes.actualSecretKey, dataDir });
    active = true;
    await downloadBudget(handle.seeded.groupId);
    assertScenarioProcessesActive(handle.processes);
    return await consume();
  } finally {
    try {
      if (active) await shutdown();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

/** Runs only checked-in local governance controls. No caller-selected actor, endpoint, key or payload is accepted. */
export async function applyScenarioGovernanceAction(options: ScenarioGovernanceAction): Promise<HttpResult> {
  const { handle } = options;
  const state = checkedWorkflow(handle);
  const owner = state.credentials.owner!;
  const ownerClient = state.clients.owner!;
  const spaceId = owner.spaceId;
  const path = `/api/spaces/${spaceId}`;
  if (options.action === 'redeem-invitee' || options.action === 'rejoin-invitee') {
    if (state.scenario.governance?.kind !== 'invitation-lifecycle')
      throw new Error('Invitation control requires the invitation story');
    const recipe = state.scenario.governance.pendingInvitations.find(({ personaId }) => personaId === 'invitee');
    if (!recipe) throw new Error('Invitee recipe unavailable');
    let pending = state.pendingInvitations.invitee;
    const prior = state.credentials.invitee;
    let client: ScenarioHttpClient;
    let credential: { email: string; password: string };
    if (options.action === 'redeem-invitee') {
      if (!pending || prior) throw new Error('Invitation is no longer pending');
      credential = credentialsFor({ id: recipe.personaId }, state.scenario.id);
      client = new ScenarioHttpClient(state.webUrl, state.publicOrigin, state.internalSecret);
    } else {
      if (!prior || pending) throw new Error('Rejoin requires a previously redeemed invitation');
      client = state.clients.invitee!;
      const session = await client.currentSession();
      if (session.actorId !== prior.actorId) throw new Error('Invitee identity changed');
      const store = new SqliteWorkflowStore(handle.processes.workflowDbPath);
      try {
        const previous = store.governance.listMembershipHistory({ spaceId })
          .find(({ id }) => id === prior.membershipId);
        if (!previous || previous.actorId !== session.actorId || previous.revokedAt === null)
          throw new Error('Rejoin requires the revoked invitee membership period');
      } finally {
        store.close();
      }
      if (await ownerClient.currentActorId() !== owner.actorId) throw new Error('Scenario owner identity changed');
      await ownerClient.reauthenticate(owner.password);
      const created = await ownerClient.post('/api/invitations', {}, spaceId);
      pending = {
        invitationId: string(object(resultObject(created, 'rejoin invitation').invitation, 'invitation').id, 'invitation ID'),
        token: invitationToken(created),
      };
      credential = prior;
    }
    const redeemed = await client.post('/api/invitations/redeem', {
      token: pending.token, name: recipe.displayName, email: credential.email, password: credential.password,
    }, spaceId);
    const redemption = resultObject(redeemed, 'invitee redemption');
    if (redemption.redeemed !== true || redemption.spaceId !== spaceId)
      throw new Error('Invitation redeemed into a different scenario space');
    const session = await client.currentSession();
    if (prior ? session.actorId !== prior.actorId : Object.values(state.credentials).some(({ actorId }) => actorId === session.actorId))
      throw new Error('Invitation did not establish the required independent human identity');
    await client.selectSpace(spaceId);
    const selected = resultObject(await client.get(path), 'invitee selected space');
    const membership = object(object(selected.space, 'invitee space').membership, 'invitee membership');
    const membershipId = string(membership.id, 'invitee membership ID');
    if (membership.actorId !== session.actorId || membership.revokedAt !== null ||
        (prior && membershipId === prior.membershipId)) throw new Error('Invitee membership period was not established');
    checkedWorkflow(handle);
    const current: ScenarioPersonaCredentials = {
      actorId: session.actorId, membershipId, spaceId,
      email: credential.email, password: credential.password, cookieHeader: client.cookieHeader,
    };
    const personas = handle.initialized.personas as Record<string, ScenarioPersonaCredentials>;
    const previousPublic = personas.invitee;
    personas.invitee = current;
    try {
      await updateScenarioPersonas(handle.processes, handle.initialized);
    } catch (error) {
      if (previousPublic) personas.invitee = previousPublic;
      else delete personas.invitee;
      throw error;
    }
    state.clients.invitee = client;
    state.credentials.invitee = current;
    delete state.pendingInvitations.invitee;
    delete handle.initialized.governance!.pendingInvitations.invitee;
    return { status: 200, body: redeemed };
  }
  if (!('probe' in options)) throw new Error('Unsupported governance probe action');


  const assistantProbe = options.action === 'probe-assistant';
  if (assistantProbe ? state.scenario.governance?.kind !== 'delegated-assistant' :
      options.action !== 'probe-limited' || state.scenario.governance?.kind !== 'scoped-access')
    throw new Error('Probe is not supported by the selected governance story');
  const assistant = assistantProbe ? state.assistant : undefined;
  if (assistantProbe && !assistant) throw new Error('Assistant credential unavailable');
  const client = assistantProbe ? ownerClient : state.clients.limited;
  const persona = assistantProbe ? owner : state.credentials.limited;
  if (!client || !persona) throw new Error('Probe human unavailable');
  if (!assistantProbe && options.probe !== 'checking-name' && options.probe !== 'checking-existence')
    throw new Error('Limited-member probe must be an account metadata probe');
  if (options.probe !== 'checking-name' && options.probe !== 'checking-existence') {
    const endpoints = {
      'manage-grants': `${path}/grants`,
      financial: '/api/merchant',
      'full-history': '/api/home/budget-summary',
    } as const;
    return client.getResponse(endpoints[options.probe], assistant?.apiKey, spaceId);
  }
  const admission = await client.getResponse(path, assistant?.apiKey, spaceId);
  if (admission.status !== 200) return admission;
  const selected = object(resultObject(admission.body, 'probe selected space').space, 'probe space');
  const member = object(selected.membership, 'probe membership');
  if (selected.id !== spaceId || member.id !== persona.membershipId || member.actorId !== persona.actorId)
    throw new Error('Probe selected membership changed');

  const accountId = mapId(state.seeded.accountIds, 'acct-checking', 'probe Checking account');
  const human = assistant ? null : await client.currentSession();
  if (human && human.actorId !== persona.actorId) throw new Error('Probe human session changed');
  checkedWorkflow(handle);
  const store = new SqliteWorkflowStore(handle.processes.workflowDbPath);
  try {
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Current probe governance policy unavailable');
    let auth: OperationalAuth;
    if (assistant) {
      const principal = store.governance.resolveCredentialPrincipal({
        credentialId: assistant.credentialId, referenceId: owner.actorId,
        spaceId, now: new Date().toISOString(),
      });
      if (!principal || principal.principalType !== 'agent' || principal.actorId !== assistant.agentId ||
          principal.delegationId !== assistant.delegationId || principal.delegationVersion !== assistant.delegationVersion ||
          principal.credentialOwnerId !== owner.actorId)
        throw new Error('Probe credential principal changed');
      auth = { method: 'api-key', ...principal };
    } else {
      if (!human) throw new Error('Verified human session unavailable');
      auth = { method: 'session', actorId: human.actorId, sessionId: human.sessionId };
    }
    const allowed = (capability: 'existence' | 'name'): boolean => store.governance.authorize({
      actorId: auth.actorId, spaceId, membershipId: persona.membershipId,
      expectedPolicyVersion: policy.version, phase: 'read', operation: 'account.metadata.read',
      required: [{ resourceKind: 'account', resourceId: accountId, capability }],
      payload: { operations: [{ operation: 'account.metadata.read', accountId }] },
      now: new Date().toISOString(), auth,
      ...(auth.method === 'api-key' && auth.principalType === 'agent' ? {
        agentId: auth.actorId, delegationId: auth.delegationId, delegationVersion: auth.delegationVersion,
      } : {}),
    }).allowed;
    if (!allowed('existence')) return { status: 200, body: { resources: [] } };
    const includeName = allowed('name');
    const accountName = await withScenarioNative(handle, async () => {
      const account = (await getAccounts()).find((candidate) => candidate.id === accountId);
      if (!account) throw new Error('Checking account is unavailable in the selected Actual budget');
      return includeName ? string(account.name, 'native Checking name') : undefined;
    });
    // Re-admit after Actual: reset, session change or delegation revocation fences publication.
    checkedWorkflow(handle);
    const currentAdmission = await client.getResponse(path, assistant?.apiKey, spaceId);
    if (currentAdmission.status !== 200) return currentAdmission;
    const currentMember = object(object(resultObject(currentAdmission.body, 'current probe space').space, 'space').membership, 'membership');
    if (currentMember.id !== persona.membershipId || currentMember.actorId !== persona.actorId)
      throw new Error('Probe membership changed during the Actual read');
    if (human) {
      const current = await client.currentSession();
      if (current.actorId !== human.actorId || current.sessionId !== human.sessionId)
        throw new Error('Probe human session changed during the Actual read');
    }
    checkedWorkflow(handle);
    return { status: 200, body: { resources: allowed('existence') ? [{
      resourceKind: 'account', resourceId: accountId, ...(accountName !== undefined && allowed('name') ? { name: accountName } : {}),
    }] : [] } };
  } finally {
    store.close();
  }
}

/** Explicit merchant-story source grant refresh after native import or rule creation; never a global inherited right. */
export async function refreshScenarioMerchantReadGrants(
  handle: LoadedScenario,
  requested: { readonly transactionIds?: readonly string[]; readonly ruleIds?: readonly string[] },
): Promise<void> {
  const state = checkedWorkflow(handle);
  if (!state.scenario.merchant) throw new Error('Native source grant refresh requires a merchant story');
  const resources: ResourceRef[] = [
    ...(requested.transactionIds ?? []).map((resourceId) => ({ resourceKind: 'transaction' as const, resourceId })),
    ...(requested.ruleIds ?? []).map((resourceId) => ({ resourceKind: 'rule' as const, resourceId })),
  ];
  if (resources.length === 0) throw new Error('Native source grant refresh requires exact resource IDs');
  await withScenarioNative(handle, async () => {
    const transactionIds = new Set<string>();
    const observe = (rows: readonly unknown[]): void => {
      for (const value of rows) {
        const row = object(value, 'native transaction');
        transactionIds.add(string(row.id, 'native transaction ID'));
        if (row.subtransactions !== undefined) {
          if (!Array.isArray(row.subtransactions)) throw new Error('Native transaction children are invalid');
          observe(row.subtransactions);
        }
      }
    };
    if (requested.transactionIds?.length) {
      for (const accountId of Object.values(state.seeded.accountIds))
        observe(await getTransactions(accountId, '1900-01-01', '2999-12-31'));
    }
    const ruleIds = new Set(requested.ruleIds?.length
      ? (await getRules()).map(({ id }) => string(id, 'native rule ID')) : []);
    for (const resource of resources) {
      if (!(resource.resourceKind === 'transaction' ? transactionIds : ruleIds).has(resource.resourceId))
        throw new Error('Requested grant resource is not in the selected native Actual budget');
    }
  });
  checkedWorkflow(handle);
  const owner = state.credentials.owner!;
  const client = state.clients.owner!;
  if (await client.currentActorId() !== owner.actorId) throw new Error('Scenario owner identity changed');
  await client.reauthenticate(owner.password);
  for (const persona of state.scenario.personas) {
    if (persona.role !== 'owner' && persona.role !== 'coapprover') continue;
    const reader = state.credentials[persona.id];
    if (!reader) throw new Error('Merchant source reader unavailable');
    const nativeIntentRights = state.scenario.id === 'merchant-native-rule-lifecycle'
      ? persona.role === 'owner' ? ['full-read', 'rule:propose', 'rule:execute'] : ['full-read', 'rule:approve']
      : [];
    for (const resource of resources)
      for (const capability of [...(MERCHANT_SOURCE_RIGHTS[resource.resourceKind] ?? []), ...nativeIntentRights])
        resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
          membershipId: reader.membershipId, ...resource, capability, granted: true,
        }), 'native merchant source grant');
    for (const resource of resources.filter(({ resourceKind }) => resourceKind === 'transaction'))
      for (const capability of ['evidence', 'normalized-evidence', ...nativeIntentRights])
        resultObject(await client.put(`/api/spaces/${owner.spaceId}/grants`, {
          membershipId: reader.membershipId, resourceKind: 'evidence',
          resourceId: `merchant:transaction:${resource.resourceId}`, capability, granted: true,
        }), 'explicit native transaction evidence admission');
  }
}
