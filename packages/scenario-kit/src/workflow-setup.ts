import { randomBytes, randomUUID } from 'node:crypto';

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
    };

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
 * Small, origin-bound HTTP client used only while a private scenario stack is
 * being initialized. It connects to loopback but always presents the configured
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
  async post(path: string, body: JsonObject): Promise<unknown> {
    return this.request('POST', path, body);
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
    const body = await this.get('/api/auth/get-session');
    const candidate = object(body, 'Better Auth get-session response');
    const sessionData = candidate.data === null ? candidate : object(candidate.data ?? candidate, 'session data');
    const user = object(sessionData.user, 'session user');
    const actorId = string(user.id, 'session user ID');
    return actorId;
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

  private async request(method: string, path: string, body?: JsonObject, spaceId = this.selectedSpaceId): Promise<unknown> {
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
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(path, this.webUrl).toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.rememberCookies(response.headers);
    const responseBody = await response.json().catch(() => null);
    const result: HttpResult = { status: response.status, body: responseBody };
    if (!response.ok) {
      const details = safeResponseFailure(result.body);
      throw new Error(
        `Scenario HTTP ${method} ${path} failed with status ${result.status}${details ? ` (${details})` : ''}`,
      );
    }
    return result.body;
  }

  private rememberCookies(headers: Headers): void {
    for (const header of setCookieValues(headers)) {
      const pair = cookiePair(header);
      if (pair) this.cookies.set(pair[0], pair[1]);
    }
  }
}

function credentialsFor(persona: ScenarioPersona, scenarioId: string): { email: string; password: string } {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  return {
    email: `scenario-${scenarioId}-${persona.id}-${suffix}@example.invalid`.toLowerCase(),
    password: randomBytes(24).toString('base64url'),
  };
}

function mapPolicy(policy: ScenarioPolicy, ids: SeededEntityIds): ScenarioPolicy {
  return {
    ...policy,
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
    for (const grant of grants) {
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
    kind: scenario.personas.length === 1 ? 'personal' : 'shared',
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

/** Initializes real scenario identities, exact Native grants and live Actual-backed workflows. */
export async function initializeScenarioWorkflow(options: {
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
  readonly webUrl: string;
  readonly publicOrigin: string;
  readonly bootstrapSecret: string;
  readonly internalSecret?: string;
}): Promise<ScenarioInitialized> {
  const client = new ScenarioHttpClient(options.webUrl, options.publicOrigin, options.internalSecret);
  const { scenario, seeded } = options;
  const personas = await initializePersonas(
    client,
    scenario,
    options.bootstrapSecret,
    options.publicOrigin,
    options.webUrl,
    options.internalSecret,
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
  const policy = mapPolicy(scenario.policy, seeded);
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

  return {
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
  };
}
