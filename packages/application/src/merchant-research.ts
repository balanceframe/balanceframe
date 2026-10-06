import type { CapabilityState, MerchantEnrichmentProvider, MerchantResearchFailureCode, MerchantResearchResult, ProviderInfo } from '@balanceframe/inference';
import type { MerchantAuthorizationContext, MerchantCacheKey, MerchantEnrichment, MerchantEvidence, MerchantPolicyValue, MerchantQuotaBucket, MerchantResearchAttempt, MerchantScope, MerchantTariff, MerchantViewAccess, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { MerchantActor, MerchantPolicyView } from './merchant-service.js';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createPolicyEngine, createMerchantResearchRequest, merchantResearchRequestSchema, merchantResearchResultSchema, ValueSerpProvider } from '@balanceframe/inference';
import { merchantPolicyValueSchema } from '@balanceframe/workflow-store';

/** Current server-recaptured merchant evidence selected for optional research. */
export interface MerchantResearchTarget { evidenceKey: string; evidenceRevision: string }
/** Explicit public-business declaration and transient standalone query, never extracted bank text. */
export interface MerchantResearchQuery extends MerchantResearchTarget { merchant: string; locale: 'US' | 'CA' | 'GB' | null; publicBusiness: true }
/** Separate exact-preview consent; clients cannot select providers, credentials, pricing or scope. */
export interface MerchantResearchRequest extends MerchantResearchQuery { previewToken: string; consent: true; idempotencyKey: string }
/** Trusted fresh capture held under the Actual source lock until its consumer resolves. */
export interface MerchantResearchCapture {
  scope: MerchantScope;
  access: MerchantViewAccess;
  evidence: MerchantEvidence;
  budgetPolicy: MerchantPolicyView;
  spacePolicy: MerchantPolicyView;
}
/** Server-owned installation and credential quota identities with account-confirmed exact pricing. */
export interface MerchantResearchConfiguration {
  installationId: string;
  installationVersion: string;
  installationPolicy: MerchantPolicyValue;
  credentialId: string;
  credentialVersion: string;
  credentialLimits: { maxSearchesPerDay: number; maxSpendMinorUnitsPerMonth: number };
  tariff: MerchantTariff;
  apiKey: string;
}
/** Trusted application host supplies fresh source admission and independently persisted policy layers. */
export interface MerchantResearchHost {
  store: SqliteWorkflowStore;
  clock: () => Date;
  configuration: () => MerchantResearchConfiguration | null;
  withCapture: <T>(actor: MerchantActor, target: MerchantResearchTarget, consume: (capture: MerchantResearchCapture) => T | Promise<T>) => Promise<T>;
  providerFor?: (configuration: MerchantResearchConfiguration) => MerchantEnrichmentProvider;
}
/** Content-free refusal codes never include exception causes, query text, credentials or URLs. */
export type MerchantResearchCode = MerchantResearchFailureCode | 'configuration' | 'policy' | 'unauthorized' | 'consent_required' | 'stale_source' | 'daily_cap' | 'monthly_cap' | 'unknown_pricing' | 'stale_generation' | 'restore_pending' | 'restore_billing_hold';
/** Authorized transient disclosure binds exact query, source, provider, cost and five-minute consent. */
export type MerchantResearchPreview =
  | { status: 'ready'; previewToken: string; merchant: string; locale: 'US' | 'CA' | 'GB' | null; providerId: string; providerVersion: string; evidenceKey: string; evidenceRevision: string; expiresAt: string; fieldsSent: ['merchant', 'locale']; disclosure: string; maxCostAtoms: string; billingCurrency: string }
  | { status: 'denied'; code: MerchantResearchCode };
/** Historical untrusted semantic observations are not financial facts, confidence promotion or permission. */
export type MerchantResearchOutcome =
  | { status: 'succeeded' | 'cached'; enrichment: MerchantEnrichment }
  | { status: 'pending'; attemptId: string }
  | { status: 'denied' | 'failed'; code: MerchantResearchCode; billing: 'not_dispatched' | 'uncertain' };
/** One independently versioned layer; absent policy is not external opt-in. */
export interface MerchantResearchPolicyLayer { kind: 'installation' | 'space' | 'budget'; version: string; value: MerchantPolicyValue | null }
/** Least-permissive capability with provider intersection and every layer's reason/provenance. */
export interface ResolvedMerchantResearchPolicy {
  mode: CapabilityState;
  allowedProviderIds: string[];
  billingCurrency: string | null;
  cacheTtlHours: number;
  maxSearchesPerDay: number;
  maxSpendMinorUnitsPerMonth: number;
  layers: Array<{ kind: MerchantResearchPolicyLayer['kind']; version: string; mode: CapabilityState; reason: string }>;
}

const id = z.string().min(1).max(512).refine((value) => value.trim() === value && !/\p{C}/u.test(value));
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySchema = merchantResearchRequestSchema.extend({ evidenceKey: id, evidenceRevision: fingerprint, publicBusiness: z.literal(true) }).strict();
const requestSchema = querySchema.extend({ previewToken: z.string().regex(/^[a-f0-9]{32,128}$/), consent: z.literal(true), idempotencyKey: id }).strict();
/** Validate server-owned deployment pricing, quota identities and credentials before admission. */
export const merchantResearchConfigurationSchema = z.object({
  installationId: id, installationVersion: id, installationPolicy: merchantPolicyValueSchema,
  credentialId: id, credentialVersion: id,
  credentialLimits: z.object({ maxSearchesPerDay: count, maxSpendMinorUnitsPerMonth: count }).strict(),
  tariff: z.object({ version: id, billingCurrency: z.string().regex(/^[A-Z]{3}$/), costAtoms: z.string().max(128).regex(/^[1-9]\d*$/) }).strict(),
  apiKey: z.string().regex(/^[!-~]{1,512}$/),
}).strict();
const disclosure = 'Separate external public-business search sends the approved merchant text and optional coarse locale. The provider sees this text and the application server IP and may retain request logs; exact provider retention is unknown. Sent requests cannot be recalled. Only app-dispatched usage is capped; this does not cap other credential usage or delete provider logs. Public-business declaration expresses your intent, not automatic verification that a name identifies a business rather than a person.';
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameScope = (left: MerchantScope, right: MerchantScope): boolean => left.spaceId === right.spaceId && left.budgetId === right.budgetId && left.connectionId === right.connectionId;

class ResearchRefusal extends Error {
  constructor(readonly code: MerchantResearchCode) { super('Merchant research refused'); }
}
function refuse(code: MerchantResearchCode): never { throw new ResearchRefusal(code); }
function safeCode(error: unknown): MerchantResearchCode { return error instanceof ResearchRefusal ? error.code : 'unauthorized'; }
function validatedQuery(input: unknown): MerchantResearchQuery {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) refuse('invalid_request');
  return parsed.data;
}
function configurationProof(configuration: MerchantResearchConfiguration): string {
  // Explicit allowlist: the API key is compared only in memory and never hashed or persisted.
  return digest([configuration.installationId, configuration.installationVersion, configuration.installationPolicy,
    configuration.credentialId, configuration.credentialVersion, configuration.credentialLimits, configuration.tariff]);
}

interface PreparedResearch {
  configuration: MerchantResearchConfiguration;
  provider: MerchantEnrichmentProvider;
  policy: ResolvedMerchantResearchPolicy;
  key: MerchantCacheKey;
  binding: string;
  access: () => MerchantViewAccess;
}
interface ResearchDispatch {
  status: 'dispatch';
  configuration: MerchantResearchConfiguration;
  provider: MerchantEnrichmentProvider;
  binding: string;
  attempt: MerchantResearchAttempt;
  claimToken: string;
  sourceExpiresAt: string;
  controller: AbortController;
  registration: symbol;
  beforeEgress: (() => boolean) | null;
}
interface ActiveResearch { scope: MerchantScope; controller: AbortController }


/** Resolve independent policy layers once before passing one capability/allowlist to inference. */
export function resolveMerchantResearchPolicy(layers: MerchantResearchPolicyLayer[], providerInfo: ProviderInfo): ResolvedMerchantResearchPolicy {
  const topology = Array.isArray(layers) && layers.length === 3 && ['installation', 'space', 'budget'].every((kind) => layers.filter((layer) => layer.kind === kind).length === 1);
  const evaluated = (Array.isArray(layers) ? layers : []).map((layer) => {
    const parsed = merchantPolicyValueSchema.safeParse(layer.value);
    const valid = parsed.success && id.safeParse(layer.version).success && !(layer.kind === 'space' && parsed.data.calendar);
    const value = valid && parsed.success ? parsed.data : null;
    return { kind: layer.kind, version: layer.version, value, mode: value?.mode ?? 'local-only' as CapabilityState,
      reason: layer.value === null ? 'missing' : !valid ? 'invalid' : value?.mode === 'external-allowed' ? 'allowed' : value?.mode ?? 'invalid' };
  });
  let mode: CapabilityState = evaluated.some((layer) => layer.mode === 'disabled') ? 'disabled'
    : !topology || evaluated.some((layer) => layer.mode !== 'external-allowed') ? 'local-only' : 'external-allowed';
  const currencies = new Set(evaluated.flatMap((layer) => layer.value ? [layer.value.billingCurrency] : []));
  const billingCurrency = topology && evaluated.every((layer) => layer.value !== null) && currencies.size === 1 ? [...currencies][0]! : null;
  if (!billingCurrency && mode === 'external-allowed') mode = 'local-only';
  const intersection = mode === 'external-allowed' ? evaluated[0]!.value!.allowedProviderIds.filter((provider) => evaluated.every((layer) => layer.value!.allowedProviderIds.includes(provider))) : [];
  const engine = createPolicyEngine({ capabilities: { classification: 'disabled', merchantResearch: mode, conversation: 'disabled', telemetry: 'disabled' },
    providerAllowlists: [{ capability: 'merchantResearch', allowedProviderIds: intersection }], policyVersion: digest(evaluated.map((layer) => [layer.kind, layer.version, layer.value])) });
  const allowedProviderIds = engine.getAllowedProviders('merchantResearch', [providerInfo]).map((provider) => provider.id);
  return { mode, allowedProviderIds, billingCurrency,
    cacheTtlHours: Math.min(720, ...evaluated.map((layer) => layer.value?.cacheTtlHours ?? 720)),
    maxSearchesPerDay: topology ? Math.min(...evaluated.map((layer) => layer.value?.maxSearchesPerDay ?? 0)) : 0,
    maxSpendMinorUnitsPerMonth: topology ? Math.min(...evaluated.map((layer) => layer.value?.maxSpendMinorUnitsPerMonth ?? 0)) : 0,
    layers: evaluated.map((layer) => ({ kind: layer.kind, version: layer.version, mode: layer.mode,
      reason: !topology ? 'invalid_layers' : layer.reason !== 'allowed' ? layer.reason : !billingCurrency ? 'currency_mismatch'
        : !layer.value!.allowedProviderIds.includes(providerInfo.id) ? 'provider_excluded' : !allowedProviderIds.includes(providerInfo.id) ? 'provider_unavailable' : layer.reason })) };
}

/** Coordinate separately consented egress through existing durable cache, quota, claim and source fences. */
export class MerchantResearchCoordinator {
  private readonly active = new Map<symbol, ActiveResearch>();

  /** Accept only trusted host dependencies, never request-supplied credentials or authority. */
  constructor(private readonly host: MerchantResearchHost) {}

  private now(): string { return this.host.clock().toISOString(); }
  private configuration(): MerchantResearchConfiguration {
    try {
      const parsed = merchantResearchConfigurationSchema.safeParse(this.host.configuration());
      if (parsed.success) return parsed.data;
    } catch { /* Configuration failures never disclose secret-bearing causes. */ }
    return refuse('configuration');
  }
  private prepare(actor: MerchantActor, query: MerchantResearchQuery, capture: MerchantResearchCapture): PreparedResearch {
    const configuration = this.configuration();
    let provider: MerchantEnrichmentProvider;
    try { provider = this.host.providerFor ? this.host.providerFor(configuration) : new ValueSerpProvider({ apiKey: configuration.apiKey, now: this.host.clock }); }
    catch { return refuse('configuration'); }
    const { scope, evidence, budgetPolicy, spacePolicy } = capture;
    const expectedSpaceScope = { spaceId: scope.spaceId, budgetId: scope.budgetId, connectionId: 'merchant:space-policy' };
    if (scope.spaceId !== actor.spaceId || scope.budgetId !== actor.budgetId || capture.access.actorId !== actor.actorId
      || !sameScope(scope, capture.access.scope) || !sameScope(scope, evidence.scope) || !sameScope(scope, budgetPolicy.scope)
      || !sameScope(expectedSpaceScope, spacePolicy.scope) || evidence.key !== query.evidenceKey || evidence.revision !== query.evidenceRevision
      || evidence.generation !== budgetPolicy.generation || capture.access.expectedGeneration !== budgetPolicy.generation
      || evidence.policyVersion !== budgetPolicy.version || evidence.factsHash !== evidence.sourceRefs.factsHash
      || evidence.visibility.hash !== capture.access.visibility.hash || evidence.visibility.privateActorId !== capture.access.visibility.privateActorId
      || (capture.access.visibility.privateActorId !== null && capture.access.visibility.privateActorId !== actor.actorId)
      || Date.parse(this.now()) >= Date.parse(evidence.expiresAt)) refuse('stale_source');
    if (!provider || typeof provider.research !== 'function' || provider.providerId !== 'valueserp' || !id.safeParse(provider.providerVersion).success
      || !provider.providerInfo || provider.providerInfo.id !== provider.providerId || provider.providerInfo.endpoint !== 'https://api.valueserp.com/search'
      || provider.providerInfo.locality !== 'external') refuse('configuration');
    const policy = resolveMerchantResearchPolicy([
      { kind: 'installation', version: configuration.installationVersion, value: configuration.installationPolicy },
      { kind: 'space', version: String(spacePolicy.version), value: spacePolicy.version > 0 ? spacePolicy.value : null },
      { kind: 'budget', version: String(budgetPolicy.version), value: budgetPolicy.version > 0 ? budgetPolicy.value : null },
    ], provider.providerInfo);
    if (policy.mode !== 'external-allowed' || !policy.allowedProviderIds.includes(provider.providerId) || policy.billingCurrency !== configuration.tariff.billingCurrency) refuse('policy');
    const configurationHash = configurationProof(configuration);
    const egressPolicyVersion = digest(['merchant-egress/1', configurationHash, spacePolicy.scope, spacePolicy.version, spacePolicy.generation,
      spacePolicy.value, budgetPolicy.version, budgetPolicy.generation, budgetPolicy.value]);
    const key: MerchantCacheKey = { scope, queryFingerprint: digest(['merchant-query/1', [scope.spaceId, scope.budgetId, scope.connectionId], capture.access.visibility.hash,
      query.evidenceKey, query.evidenceRevision, query.merchant, query.locale]), locale: query.locale,
      providerId: provider.providerId, providerVersion: provider.providerVersion,
      parametersHash: digest(['valueserp-search-parameters/1', 'GET', 'https://api.valueserp.com/search', 10, 'json', query.locale]),
      normalizationVersion: evidence.normalizationVersion, egressPolicyVersion, visibilityHash: capture.access.visibility.hash };
    const binding = digest(['merchant-consent/1', key, evidence.key, evidence.revision, evidence.factsHash,
      evidence.calendarVersion, budgetPolicy.generation, spacePolicy.generation]);
    const access = (): MerchantViewAccess => ({ ...capture.access, now: this.now(), authorize: (context: MerchantAuthorizationContext) => {
      try {
        const current = this.configuration();
        const now = this.now();
        return current.apiKey === configuration.apiKey && configurationProof(current) === configurationHash
          && sameScope(context.scope, scope) && context.generation === budgetPolicy.generation
          && this.host.store.merchant.generation(scope) === budgetPolicy.generation
          && this.host.store.merchant.generation(spacePolicy.scope) === spacePolicy.generation
          && Date.parse(now) < Date.parse(evidence.expiresAt)
          && capture.access.authorize({ ...context, now }) === true;
      } catch { return false; }
    } });
    const admitted = access();
    if (!admitted.authorize({ scope, now: admitted.now, generation: admitted.expectedGeneration, visibility: admitted.visibility, sourceRefs: evidence.sourceRefs })) refuse('unauthorized');
    return { configuration, provider, policy, key, binding, access };
  }
  private checkConfiguredCapacity(prepared: PreparedResearch): void {
    const daily = Math.min(prepared.policy.maxSearchesPerDay, prepared.configuration.credentialLimits.maxSearchesPerDay);
    const monthly = Math.min(prepared.policy.maxSpendMinorUnitsPerMonth, prepared.configuration.credentialLimits.maxSpendMinorUnitsPerMonth);
    if (daily === 0) refuse('daily_cap');
    if (BigInt(monthly) * 1000000n < BigInt(prepared.configuration.tariff.costAtoms)) refuse('monthly_cap');
  }
  private previewAccess(prepared: PreparedResearch, actor: MerchantActor): MerchantViewAccess {
    const access = prepared.access();
    return { ...access, visibility: { hash: access.visibility.hash, privateActorId: actor.actorId } };
  }
  private cache(prepared: PreparedResearch, capture: MerchantResearchCapture): MerchantEnrichment | null {
    const value = this.host.store.merchant.cache({ ...prepared.access(), key: prepared.key });
    return value?.evidenceRevision === capture.evidence.revision && value.sourceRefs.factsHash === capture.evidence.factsHash ? value : null;
  }
  private buckets(prepared: PreparedResearch, capture: MerchantResearchCapture): MerchantQuotaBucket[] {
    const limit = (kind: MerchantQuotaBucket['kind'], id: string, value: { maxSearchesPerDay: number; maxSpendMinorUnitsPerMonth: number }): MerchantQuotaBucket =>
      ({ kind, id, maxSearchesPerDay: value.maxSearchesPerDay, maxSpendMinorUnitsPerMonth: value.maxSpendMinorUnitsPerMonth });
    return [limit('installation', prepared.configuration.installationId, prepared.configuration.installationPolicy),
      limit('space', capture.scope.spaceId, capture.spacePolicy.value),
      limit('budget', `${capture.scope.spaceId}/${capture.scope.budgetId}`, capture.budgetPolicy.value),
      limit('credential', prepared.configuration.credentialId, prepared.configuration.credentialLimits)];
  }

  /** Preview exact transient public-business egress and persist only an opaque fingerprint-bound consent token. */
  async preview(actor: MerchantActor, input: unknown): Promise<MerchantResearchPreview> {
    try {
      const query = validatedQuery(input);
      return await this.host.withCapture<MerchantResearchPreview>(actor, query, (capture) => {
        const prepared = this.prepare(actor, query, capture);
        this.checkConfiguredCapacity(prepared);
        const previewToken = randomBytes(32).toString('hex');
        const access = this.previewAccess(prepared, actor);
        const expiresAt = new Date(Math.min(Date.parse(this.now()) + 300000, Date.parse(capture.evidence.expiresAt))).toISOString();
        const { scope: _scope, generation: _generation, ...evidence } = capture.evidence;
        const saved = this.host.store.merchant.putEvidence({ ...access, expectedRevision: null, value: { ...evidence, key: `research-preview:${previewToken}`,
          revision: prepared.binding, capturedAt: access.now, expiresAt, visibility: access.visibility } });
        if (!saved) refuse('unauthorized');
        return { status: 'ready', previewToken, merchant: query.merchant, locale: query.locale, providerId: prepared.provider.providerId, providerVersion: prepared.provider.providerVersion,
          evidenceKey: query.evidenceKey, evidenceRevision: query.evidenceRevision, expiresAt: saved.expiresAt, fieldsSent: ['merchant', 'locale'], disclosure,
          maxCostAtoms: prepared.configuration.tariff.costAtoms, billingCurrency: prepared.configuration.tariff.billingCurrency };
      });
    } catch (error) { return { status: 'denied', code: safeCode(error) }; }
  }

  /** Reserve and dispatch once outside source/database locks, then freshly recapture before publishing. */
  async research(actor: MerchantActor, input: unknown): Promise<MerchantResearchOutcome> {
    let dispatch: ResearchDispatch | null = null;
    let ownedAttempt: MerchantResearchAttempt | null = null;
    let possibleDispatch = false;
    let registered: symbol | null = null;
    try {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) refuse('invalid_request');
      const request = parsed.data;
      const query: MerchantResearchQuery = { evidenceKey: request.evidenceKey, evidenceRevision: request.evidenceRevision, merchant: request.merchant, locale: request.locale, publicBusiness: true };
      const admission = await this.host.withCapture<MerchantResearchOutcome | ResearchDispatch>(actor, query, (capture) => {
        const prepared = this.prepare(actor, query, capture);
        const preview = this.host.store.merchant.evidence({ ...this.previewAccess(prepared, actor), key: `research-preview:${request.previewToken}` });
        if (!preview || preview.revision !== prepared.binding || preview.visibility.privateActorId !== actor.actorId) refuse('consent_required');
        const cached = this.cache(prepared, capture);
        if (cached) return { status: 'cached', enrichment: cached };
        this.checkConfiguredCapacity(prepared);
        const reserved = this.host.store.merchant.reserveAttempt({ ...prepared.access(), idempotencyKey: request.idempotencyKey, key: prepared.key,
          sourceRefs: capture.evidence.sourceRefs, policyVersion: capture.budgetPolicy.version, tariff: prepared.configuration.tariff, buckets: this.buckets(prepared, capture) });
        if (reserved.status === 'denied') return { status: 'denied', code: reserved.reason, billing: 'not_dispatched' };
        if (reserved.status === 'pending') return { status: 'pending', attemptId: reserved.attempt.id };
        const attempt = this.host.store.merchant.claimAttempt({ ...prepared.access(), id: reserved.attempt.id });
        if (!attempt?.claimToken) {
          if ((reserved.attempt.phase === 'reserved' || reserved.attempt.phase === 'dispatched') && Date.parse(this.now()) < Date.parse(reserved.attempt.leaseExpiresAt))
            return { status: 'pending', attemptId: reserved.attempt.id };
          return { status: 'failed', code: 'unavailable', billing: reserved.attempt.dispatchedAt === null || reserved.attempt.invocationEvidence === 'not_invoked' ? 'not_dispatched' : 'uncertain' };
        }
        ownedAttempt = attempt;
        const controller = new AbortController();
        const registration = Symbol();
        this.active.set(registration, { scope: capture.scope, controller });
        registered = registration;
        try {
          if (!this.host.store.merchant.dispatchAttempt({ ...prepared.access(), id: attempt.id, claimToken: attempt.claimToken })) {
            this.active.delete(registration);
            return { status: 'failed', code: 'unavailable', billing: 'not_dispatched' };
          }
          const beforeEgress = (): boolean => {
            const access = prepared.access();
            const now = Date.parse(access.now);
            return access.authorize({ scope: attempt.scope, now: access.now, generation: attempt.generation, visibility: attempt.visibility, sourceRefs: attempt.sourceRefs })
              // UTC epoch-day equality also fences the month against the immutable reservation time.
              && Math.floor(now / 86400000) === Math.floor(Date.parse(attempt.createdAt) / 86400000)
              && now < Date.parse(preview.expiresAt) && now < Date.parse(attempt.leaseExpiresAt);
          };
          return { status: 'dispatch', configuration: prepared.configuration, provider: prepared.provider, binding: prepared.binding, attempt,
            claimToken: attempt.claimToken, sourceExpiresAt: capture.evidence.expiresAt, controller, registration, beforeEgress };
        } catch (error) { this.active.delete(registration); throw error; }
      });
      if (admission.status !== 'dispatch') return admission;
      dispatch = admission;
      const authorized = dispatch.beforeEgress?.() === true;
      // Drop the capture/authorization closure before I/O rather than retaining the SDK history during fetch.
      dispatch.beforeEgress = null;
      let result: MerchantResearchResult;
      if (!authorized || dispatch.controller.signal.aborted) return { status: 'failed', code: 'cancelled', billing: 'not_dispatched' };
      possibleDispatch = true;
      try { result = await dispatch.provider.research(createMerchantResearchRequest({ merchant: query.merchant, locale: query.locale }, dispatch.controller.signal)); }
      catch { result = { status: 'failed', providerId: dispatch.provider.providerId, providerVersion: dispatch.provider.providerVersion, retrievedAt: this.now(), code: 'unavailable', billing: 'uncertain' }; }
      const validated = merchantResearchResultSchema.safeParse(result);
      if (!validated.success || result.providerId !== dispatch.provider.providerId || result.providerVersion !== dispatch.provider.providerVersion || Date.parse(result.retrievedAt) > Date.parse(this.now()))
        result = { status: 'failed', providerId: dispatch.provider.providerId, providerVersion: dispatch.provider.providerVersion, retrievedAt: this.now(), code: 'invalid_response', billing: possibleDispatch ? 'uncertain' : 'not_dispatched' };
      else result = validated.data;
      return await this.finish(actor, query, dispatch, result);
    } catch (error) { return { status: 'denied', code: safeCode(error), billing: possibleDispatch ? 'uncertain' : 'not_dispatched' }; }
    finally {
      // This proof is local control flow, never a provider's billing classification or current read grant.
      const owner = ownedAttempt as MerchantResearchAttempt | null;
      if (owner?.claimToken && !possibleDispatch) this.host.store.merchant.releaseUnsentAttempt({
        scope: owner.scope, id: owner.id, expectedGeneration: owner.generation, claimToken: owner.claimToken, now: this.now(),
      });
      if (registered) this.active.delete(registered);
    }
  }

  private async finish(actor: MerchantActor, query: MerchantResearchQuery, dispatch: ResearchDispatch, result: MerchantResearchResult): Promise<MerchantResearchOutcome> {
    return this.host.withCapture<MerchantResearchOutcome>(actor, query, (capture) => {
      const prepared = this.prepare(actor, query, capture);
      if (prepared.binding !== dispatch.binding || prepared.configuration.apiKey !== dispatch.configuration.apiKey
        || Date.parse(this.now()) >= Date.parse(dispatch.sourceExpiresAt)) refuse('stale_source');
      const access = prepared.access();
      if (result.status === 'failed') {
        const settled = this.host.store.merchant.settleAttempt({ ...access, id: dispatch.attempt.id, claimToken: dispatch.claimToken,
          outcome: result.billing === 'not_dispatched' ? { phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' } : { phase: 'uncertain' } });
        if (!settled) refuse('stale_source');
        return { status: 'failed', code: result.code, billing: result.billing };
      }
      if (dispatch.controller.signal.aborted) {
        this.host.store.merchant.settleAttempt({ ...access, id: dispatch.attempt.id, claimToken: dispatch.claimToken, outcome: { phase: 'uncertain' } });
        return { status: 'failed', code: 'cancelled', billing: 'uncertain' };
      }
      const expiresAt = new Date(Math.min(Date.parse(result.retrievedAt) + prepared.policy.cacheTtlHours * 3600000, Date.parse(dispatch.sourceExpiresAt), Date.parse(capture.evidence.expiresAt))).toISOString();
      const stored = this.host.store.merchant.putCache({ ...prepared.access(), attemptId: dispatch.attempt.id, claimToken: dispatch.claimToken, value: {
        key: prepared.key, sources: result.sources, fieldsSent: ['merchant', 'locale'], retrievedAt: result.retrievedAt, expiresAt,
        policyVersion: capture.budgetPolicy.version, evidenceRevision: capture.evidence.revision, confidence: 'uncalibrated',
        visibility: capture.access.visibility, sourceRefs: dispatch.attempt.sourceRefs,
      } });
      if (!stored) refuse('stale_source');
      if (!this.host.store.merchant.settleAttempt({ ...prepared.access(), id: dispatch.attempt.id, claimToken: dispatch.claimToken,
        outcome: { phase: 'succeeded', costAtoms: dispatch.configuration.tariff.costAtoms } })) refuse('stale_source');
      const current = this.cache(prepared, capture);
      if (!current) refuse('unauthorized');
      return { status: 'succeeded', enrichment: current };
    });
  }

  /** Deliver historical cached observations only under freshly recaptured source and external policy authority. */
  async cached(actor: MerchantActor, input: unknown): Promise<MerchantEnrichment | null> {
    try {
      const query = validatedQuery(input);
      return await this.host.withCapture(actor, query, (capture) => this.cache(this.prepare(actor, query, capture), capture));
    } catch { return null; }
  }

  /** Best-effort abort complements durable policy/deletion generations and cannot recall dispatched data. */
  abortBudget(scope: { spaceId: string; budgetId: string }): void {
    for (const active of this.active.values()) if (active.scope.spaceId === scope.spaceId && active.scope.budgetId === scope.budgetId) active.controller.abort();
  }
}
