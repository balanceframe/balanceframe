import type { ActualMerchantSource, ActualMerchantSourceCapture } from '@balanceframe/actual-adapter';
import type { MerchantAnalysisRequest, MerchantAnalysisResult, MerchantCategoryClassification, MerchantSuggestion, MerchantRecurrence, MerchantCalendar, MerchantTransaction, Money, ProtocolSnapshot, Transaction } from '@balanceframe/protocol-generated';
import type { LiquidityActor, OperationalAuth, SqliteWorkflowStore, MerchantScope, MerchantDecision, MerchantDecisionPayload, MerchantPolicyValue, MerchantSourceRefs, MerchantVisibility, MerchantAccess, GovernanceResourceKind, GovernanceOperation, MerchantEnrichment } from '@balanceframe/workflow-store';
import type { ConnectedBudget, ConnectionManager } from './connection-manager.js';
import type { PendingReviewResult, CategorizationCandidate } from './commands.js';
import type { RuleReviewContext } from './rule-mutation.js';
import type { MerchantCalendarLookup } from './merchant-calendar.js';
import type { CanonicalReviewSource, CanonicalReviewSourceTransaction } from './review-persistence.js';
import type { MerchantResearchHost, MerchantResearchTarget, MerchantResearchCapture, MerchantResearchOutcome, MerchantResearchPreview, ResolvedMerchantResearchPolicy } from './merchant-research.js';
import type { MerchantResearchSettings } from './merchant-settings.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { merchantAnalysisRequestSchema, merchantAnalysisResultSchema, merchantCategoryClassificationSchema, merchantSuggestionSchema, merchantTransactionSchema, canonicalProtocolSnapshotSchema, moneySchema } from '@balanceframe/protocol-generated/validators';
import { merchantPolicyValueSchema } from '@balanceframe/workflow-store';
import { requireCompleteRulePlanningSource } from './rule-mutation.js';
import { lookupMerchantCalendar } from './merchant-calendar.js';
import { loadNativeBindings } from './composition.js';
import { ApplicationError, ReasonCodes } from './errors.js';
import { MerchantResearchCoordinator, merchantResearchConfigurationSchema, resolveMerchantResearchPolicy } from './merchant-research.js';
import { loadMerchantResearchSettings } from './merchant-settings.js';
import { ValueSerpProvider } from '@balanceframe/inference';

/** Server-authenticated identity; no public request may supply this value. */
export type MerchantActor = LiquidityActor & { auth: OperationalAuth; spaceId: string };
/** Native semantic analysis is read-only and never writes Actual. */
export interface MerchantNativeBindings { analyzeMerchantIntelligence(input: string): string }
/** Trusted application dependencies and source limits. */
export interface MerchantServiceOptions { store: SqliteWorkflowStore; connectionManager: ConnectionManager; native: MerchantNativeBindings; clock?: () => Date; maxTransactions?: number; research?: { settings: () => MerchantResearchSettings; providerFor?: MerchantResearchHost['providerFor'] } }
/** Page selection is not source authority. */
export interface MerchantAnalyzeInput { transactionIds?: string[]; cursor?: string | null; limit?: number; factsHash?: string }
/** Authorized native source details, preserving availability without opaque import IDs or ledger flags. */
export type MerchantPublicSourceTransaction = Pick<MerchantTransaction,'id'|'accountId'|'payeeId'|'payeeName'|'categoryId'|'amount'|'date'|'importedPayee'|'description'|'verboseTitle'|'notes'>;
/** Exact current scoped alias decision metadata; raw stored text and source references stay private. */
export interface MerchantPublicAliasDecision { id:string;sourceField:Extract<MerchantDecisionPayload,{kind:'alias'}>['sourceField'];targetPayeeId:string;accountId:string|null;state:MerchantDecision['state'];version:number;updatedAt:string;visibility:'private'|'shared' }
/** Exact current scoped pattern decision metadata; acceptance is user intent, not ledger proof. */
export interface MerchantPublicPatternDecision { id:string;patternId:string;state:MerchantDecision['state'];version:number;updatedAt:string;visibility:'private'|'shared' }
/** Explainable suggestion with current server-owned source and rule review context. */
export type MerchantPublicSuggestion = MerchantSuggestion & { sourceTransaction:MerchantPublicSourceTransaction;aliasDecisions:MerchantPublicAliasDecision[];evidenceKey: string; reviewContext: RuleReviewContext };
/** Complete currently admitted category target; explanation pagination is not authority. */
export type MerchantReviewProof = MerchantCategoryClassification & { evidenceKey: string; reviewContext: RuleReviewContext };
/** Observed cadence and attributed human decision, never an execution fact. */
export type MerchantPublicRecurrence = MerchantRecurrence & { patternDecisions:MerchantPublicPatternDecision[];evidenceKey: string };
/** Governed native output plus the ordinary admitted Review baseline. */
export interface MerchantAnalysisView extends Pick<MerchantAnalysisResult, 'nativeRuleBlocks'|'nativeRuleParts'|'nativeRuleSets'|'nativeRuleClassifications'> { scope: MerchantScope;normalizationVersion:MerchantAnalysisResult['normalizationVersion'];asOfDate:string;payees:Array<{id:string;name:string}>;categories:Array<{id:string;name:string}>; sourceAdmission: MerchantAnalysisResult['sourceAdmission']; coverage: MerchantAnalysisResult['coverage']; suggestions: MerchantPublicSuggestion[]; recurrences: MerchantPublicRecurrence[]; scheduledExpectations: MerchantAnalysisResult['scheduledExpectations']; suggestionPage: NonNullable<MerchantAnalysisResult['suggestionPage']>; localReview: Omit<PendingReviewResult, 'nativeRuleBlocks'|'nativeRuleParts'|'nativeRuleSets'> }
/** Fresh human decision over current scoped evidence, not ledger mutation approval. */
export type MerchantDecisionInput = { id: string; evidenceKey: string; evidenceRevision: string; expectedVersion: number; visibility: 'private' | 'shared' } & ({ kind: 'alias'; transactionId: string; sourceField: 'importedPayee'|'description'|'verboseTitle'|'notes'|'payeeName'; targetPayeeId: string; accountId: string|null } | { kind: 'pattern'; patternId: string });
/** Persisted policy and optimistic version. */
export interface MerchantPolicyView { scope: MerchantScope; value: MerchantPolicyValue; version: number; generation: number }
/** Effective server policy retains separately versioned installation, space and budget layers. */
export interface MerchantResearchPolicyView { installation: MerchantResearchSettings['installation']; space: MerchantPolicyView; budget: MerchantPolicyView; resolved: ResolvedMerchantResearchPolicy }
/** Full replacement requires authority over every old and new account override. */
export interface MerchantPolicyInput { expectedVersion: number; value: MerchantPolicyValue }
/** Lookup reads persisted selections only. */
export interface MerchantCalendarInput { accountId: string; year: number }
/** Authorized local export; provider content is never read on this path. */
export interface MerchantExport { scope: MerchantScope; analysis: MerchantAnalysisView; decisions: MerchantDecision[]; policy: MerchantPolicyView }

const id = z.string().min(1).max(512).refine((v) => v.trim() === v && !/[^\u0020-\u{10ffff}]|\u007f/u.test(v));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const analyzeInput = z.object({ transactionIds: z.array(id).max(250000).optional(), cursor: id.nullable().optional(), limit: z.number().int().min(1).max(1000).optional(), factsHash: id.optional() }).strict();
const decisionBase = { id:id.refine((value) => Buffer.byteLength(value,'utf8') <= 256), evidenceKey: id, evidenceRevision: id, expectedVersion: count.max(4294967294), visibility: z.enum(['private','shared']) };
const publicSourceTransactionSchema = merchantTransactionSchema.innerType().pick({ id:true,accountId:true,payeeId:true,payeeName:true,categoryId:true,amount:true,date:true,importedPayee:true,description:true,verboseTitle:true,notes:true }).strict();
const sourceTransactionProjection = publicSourceTransactionSchema.strip();
const publicAliasDecisionSchema = z.object({ id,sourceField:z.enum(['importedPayee','description','verboseTitle','notes','payeeName']),targetPayeeId:id,accountId:id.nullable(),state:z.enum(['accepted','rejected','revoked']),version:count,updatedAt:z.string().datetime({offset:true}),visibility:z.enum(['private','shared']) }).strict();
const ruleReviewContextSchema = z.object({
  scope: z.object({ spaceId: id, budgetId: id, connectionId: id }).strict(),
  sourceFactsHash: id, evidenceKey: id.nullable(), evidenceRevision: id,
  merchantPolicyVersion: id, visibilityHash: id, expiresAt: z.string().datetime({ offset:true }),
}).strict();
/** Strict complete target proof; full explanation is independently optional. */
export const merchantReviewProofSchema = merchantCategoryClassificationSchema.extend({
  evidenceKey: id, reviewContext: ruleReviewContextSchema,
}).strict().refine((value) => value.reviewContext.evidenceKey === value.evidenceKey &&
  value.reviewContext.evidenceRevision === value.evidenceRevision, 'Inconsistent merchant review proof');
/** Strict public merchant explanation accepted by the existing Review inbox. */
export const merchantPublicSuggestionSchema = merchantSuggestionSchema.extend({
  evidenceKey: id,
  sourceTransaction:publicSourceTransactionSchema,aliasDecisions:z.array(publicAliasDecisionSchema),
  reviewContext: ruleReviewContextSchema,
}).strict().refine((value) => value.reviewContext.evidenceKey === value.evidenceKey &&
  value.reviewContext.evidenceRevision === value.evidenceRevision,'Inconsistent merchant review context');

/** Compare stable target/authority bindings without treating renewed expiry as a new issue. */
export function sameMerchantReviewBinding(left: MerchantReviewProof, right: MerchantReviewProof | MerchantPublicSuggestion): boolean {
  return left.transactionId === right.transactionId && left.accountId === right.accountId &&
    left.payeeId === right.payeeId && left.categoryId === right.categoryId && left.tier === right.tier &&
    left.evidenceKey === right.evidenceKey && left.evidenceRevision === right.evidenceRevision &&
    left.reviewContext.scope.spaceId === right.reviewContext.scope.spaceId &&
    left.reviewContext.scope.budgetId === right.reviewContext.scope.budgetId &&
    left.reviewContext.scope.connectionId === right.reviewContext.scope.connectionId &&
    left.reviewContext.sourceFactsHash === right.reviewContext.sourceFactsHash &&
    left.reviewContext.evidenceKey === right.reviewContext.evidenceKey &&
    left.reviewContext.evidenceRevision === right.reviewContext.evidenceRevision &&
    left.reviewContext.merchantPolicyVersion === right.reviewContext.merchantPolicyVersion &&
    left.reviewContext.visibilityHash === right.reviewContext.visibilityHash;
}

/** Assemble admitted Review tables without duplicating or truncating the canonical source graph. */
export function merchantPendingReview(view: MerchantAnalysisView): PendingReviewResult {
  const complete = view.sourceAdmission.collections.rules === 'complete';
  return { ...view.localReview,
    nativeRuleBlocks: complete ? view.nativeRuleBlocks : [],
    nativeRuleParts: complete ? view.nativeRuleParts : [],
    nativeRuleSets: complete ? view.nativeRuleSets : [],
  };
}
const decisionInput = z.discriminatedUnion('kind', [z.object({ ...decisionBase, kind: z.literal('alias'), transactionId: id, sourceField: z.enum(['importedPayee','description','verboseTitle','notes','payeeName']), targetPayeeId: id, accountId: id.nullable() }).strict(), z.object({ ...decisionBase, kind: z.literal('pattern'), patternId: id }).strict()]);
const DEFAULT_POLICY: MerchantPolicyValue = { mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720 };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nativeDecisionId = (decision: MerchantDecision): string => hash([decision.visibility.hash, decision.id]);
const bareHash = (value: string): string => value.startsWith('sha256:') ? value.slice(7) : value;
type Required = MerchantSourceRefs['required'][number];
const ref = (resourceKind: GovernanceResourceKind, resourceId: string, capability: string): Required => ({ resourceKind, resourceId, capability, version: null });
const uniq = (values: string[]): string[] => [...new Set(values)].sort();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new Error('Invalid merchant request'); return result.data; }

function moneyDisclosureOperation(amount: Money, identity: Pick<GovernanceOperation, 'accountId'|'transactionId'>,
  direction?: GovernanceOperation['direction']): GovernanceOperation {
  const signed = BigInt(amount.minorUnits);
  return { operation: 'merchant:analyze', ...identity,
    ...(direction ? { direction } : signed === 0n ? {} : { direction: signed < 0n ? 'outgoing' : 'incoming' }),
    amount: signed < 0n ? { ...amount, minorUnits: (-signed).toString() } : amount };
}

/** Count every returned Review Money slot independently, retaining actual source direction rather than the unsigned display amount. */
export function merchantReviewDisclosureOperations(result: Pick<PendingReviewResult, 'candidates'|'totalUncategorizedAmount'>, source: CanonicalReviewSource): GovernanceOperation[] {
  const transactions = new Map<string, CanonicalReviewSourceTransaction>();
  const collect = (rows: CanonicalReviewSourceTransaction[]): void => {
    for (const transaction of rows) {
      if (transactions.has(transaction.id)) throw new Error('Financial disclosure source has conflicting identities');
      transactions.set(transaction.id, transaction);
      collect(transaction.subtransactions);
    }
  };
  collect(source.transactions);
  const operations: GovernanceOperation[] = [];
  for (const candidate of result.candidates) {
    const transaction = transactions.get(candidate.transactionId);
    if (!transaction) throw new Error('Financial disclosure source is unavailable');
    const signed = BigInt(transaction.amount.minorUnits);
    operations.push(moneyDisclosureOperation(candidate.amount, { transactionId: transaction.id, accountId: transaction.accountId },
      signed < 0n ? 'outgoing' : 'incoming'));
    const evidence = candidate.merchantEvidence?.sourceTransaction;
    if (evidence) operations.push(moneyDisclosureOperation(evidence.amount, { transactionId: evidence.id, accountId: evidence.accountId }));
  }
  // The absolute aggregate has no ledger direction or account identity; it still consumes a returned Money slot.
  operations.push({ operation: 'merchant:analyze', amount: result.totalUncategorizedAmount });
  return operations;
}

function merchantDisclosureOperations(view: MerchantAnalysisView, source: CanonicalReviewSource): GovernanceOperation[] {
  const operations = merchantReviewDisclosureOperations(view.localReview, source);
  for (const suggestion of view.suggestions) {
    const transaction = suggestion.sourceTransaction;
    operations.push(moneyDisclosureOperation(transaction.amount, { transactionId: transaction.id, accountId: transaction.accountId }));
  }
  for (const recurrence of view.recurrences) {
    const direction = recurrence.direction === 'outflow' ? 'outgoing' : 'incoming';
    for (const amount of [recurrence.minimumAmount, recurrence.maximumAmount])
      operations.push(moneyDisclosureOperation(amount, { accountId: recurrence.accountId }, direction));
  }
  for (const expectation of view.scheduledExpectations) {
    const identity = expectation.source.accountId ? { accountId: expectation.source.accountId } : {};
    for (const amount of [expectation.source.amount, expectation.source.minimum, expectation.source.maximum])
      if (amount) operations.push(moneyDisclosureOperation(amount, identity));
  }
  return operations;
}

/** Stable selected Actual namespace; secrets and URL query/fragment never enter its identity. */
export function merchantConnectionId(config: { serverUrl: string; budgetId: string }): string {
  let url: URL;
  try { url = new URL(config.serverUrl); } catch { throw new Error('Invalid Actual connection'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || !id.safeParse(config.budgetId).success) throw new Error('Invalid Actual connection');
  return `sha256:${hash([url.origin, url.pathname.replace(/\/+$/u, '') || '/', config.budgetId])}`;
}
interface Admission { accountIds: string[]; categoryIds: string[]; transactionIds: string[]; sourceTransactionIds: string[]; sourceAccountIds: string[]; ruleIds: string[]|null;payeeIds:string[]|null;sourceScheduleIds:string[]|null;schedulePayeeIds:string[]|null; shared: MerchantVisibility; private: MerchantVisibility; evidence: MerchantVisibility; required: Required[] }
interface Capture { scope: MerchantScope; source: ActualMerchantSource; operations: GovernanceOperation[]; currency:string;asOfDate:string; admission: Admission; policy: MerchantPolicyView; refs: MerchantSourceRefs; decisions: MerchantDecision[]; corrections: MerchantAnalysisRequest['corrections'] }

/** One trusted boundary for source admission, native inference and fenced publication. */
export class MerchantIntelligenceService {
  private readonly clock: () => Date;
  private readonly maxTransactions: number;
  private readonly researchCoordinator: MerchantResearchCoordinator;
  constructor(private readonly options: MerchantServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.maxTransactions = parse(z.number().int().min(1).max(250000), options.maxTransactions ?? 250000);
    this.researchCoordinator = new MerchantResearchCoordinator({
      store: options.store, clock: this.clock, configuration: () => this.researchSettings().configuration,
      withCapture: (actor, target, consume) => this.withResearchCapture(actor, target, consume),
      ...(options.research?.providerFor ? { providerFor: options.research.providerFor } : {}),
    });
  }
  private now(): string { return this.clock().toISOString(); }
  private researchSettings(): MerchantResearchSettings {
    const fallback = (): MerchantResearchSettings => ({ installation: { version: 'unconfigured', value: { ...DEFAULT_POLICY } }, configuration: null });
    try {
      const settings = this.options.research ? this.options.research.settings() : loadMerchantResearchSettings();
      const installation = z.object({ version: id, value: merchantPolicyValueSchema.refine((value) => !value.calendar) }).strict().safeParse(settings.installation);
      if (!installation.success) return fallback();
      const configuration = settings.configuration && merchantResearchConfigurationSchema.safeParse({
        ...settings.configuration, installationVersion: installation.data.version, installationPolicy: installation.data.value,
      });
      return { installation: installation.data, configuration: configuration && configuration.success ? configuration.data : null };
    } catch { return fallback(); }
  }
  private spaceScope(scope: MerchantScope): MerchantScope { return { ...scope, connectionId: 'merchant:space-policy' }; }
  private localEnabled(actor: MerchantActor, capture: Pick<Capture, 'scope'|'policy'>): boolean {
    return capture.policy.value.mode !== 'disabled' && this.researchSettings().installation.value.mode !== 'disabled' &&
      this.readPolicy(actor, this.spaceScope(capture.scope)).value.mode !== 'disabled';
  }
  private async withResearchCapture<T>(actor: MerchantActor, target: MerchantResearchTarget, consume: (capture: MerchantResearchCapture) => T | Promise<T>): Promise<T> {
    return this.capture(actor, async (capture) => {
      if (!this.localEnabled(actor, capture)) throw new Error('Merchant research is disabled');
      const transactionId = target.evidenceKey.startsWith('merchant:transaction:') ? target.evidenceKey.slice('merchant:transaction:'.length) : null;
      const result = this.native(capture, { transactionIds: transactionId ? [transactionId] : [] });
      const subject = transactionId ? result.suggestions.find((item) => item.transactionId === transactionId)
        : result.recurrences.find((item) => `merchant:pattern:${item.id}` === target.evidenceKey);
      if (!subject) throw new Error('Current merchant evidence unavailable');
      const revision = this.evidenceRevision(capture, subject.evidenceRevision);
      if (revision !== target.evidenceRevision || !this.publish(capture, actor, target.evidenceKey, revision)) throw new Error('Merchant evidence changed');
      const current = this.options.store.merchant.evidence({ ...this.access(actor, capture.scope), actorId: actor.actorId, visibility: capture.admission.evidence, key: target.evidenceKey });
      if (!current || current.revision !== revision || current.sourceRefs.factsHash !== capture.refs.factsHash) throw new Error('Merchant source changed');
      const required = [...new Map([...current.sourceRefs.required, ...this.budget(actor, 'merchant:research'),
        ref('account', subject.accountId, 'merchant:research'), ref('evidence', target.evidenceKey, 'merchant:research')]
        .map((item) => [JSON.stringify([item.resourceKind, item.resourceId, item.capability]), item])).values()];
      const configuration = this.researchSettings().configuration;
      const cost = configuration ? [{ operation: 'merchant:research', accountId: subject.accountId, evidenceId: target.evidenceKey,
        amount: { minorUnits: ((BigInt(configuration.tariff.costAtoms) + 999999n) / 1000000n).toString(), currency: configuration.tariff.billingCurrency }, direction: 'outgoing' as const }] : [];
      const operations: GovernanceOperation[] = [
        ...this.operations(capture.source).map((operation) => operation.operation === 'merchant:analyze' ? { ...operation, operation: 'merchant:research' } : operation),
        ...cost,
      ];
      this.require(actor, required, operations, 'merchant:research');
      const sourceRefs = { ...capture.refs, required };
      const evidence = { ...current, sourceRefs };
      const access = { ...this.access(actor, capture.scope, required, 'merchant:research'), actorId: actor.actorId, visibility: evidence.visibility,
        authorize: (context: Parameters<MerchantAccess['authorize']>[0]) =>
        isDeepStrictEqual(context.scope, capture.scope) && context.generation === capture.policy.generation &&
        isDeepStrictEqual(context.sourceRefs, sourceRefs) && isDeepStrictEqual(context.visibility, evidence.visibility) &&
        Date.parse(evidence.expiresAt) > Date.parse(this.now()) && this.authorized(actor, required, operations, 'merchant:research') };
      const value = await consume({ scope: capture.scope, access, evidence, budgetPolicy: capture.policy, spacePolicy: this.readPolicy(actor, this.spaceScope(capture.scope)) });
      if (!access.authorize({ scope: capture.scope, now: this.now(), generation: capture.policy.generation, sourceRefs, visibility: evidence.visibility })) throw new Error('Merchant research authorization changed');
      return value;
    });
  }
  private freshControlAuth(actor: MerchantActor): void {
    const now = Date.parse(this.now()); const auth = actor.auth;
    if (auth?.method !== 'human-session' || auth.actorId !== actor.actorId || !auth.sessionId.trim() || !Number.isFinite(Date.parse(auth.reauthenticatedAt)) || Date.parse(auth.reauthenticatedAt) > now || now - Date.parse(auth.reauthenticatedAt) > 300000) throw new Error('Fresh human merchant control required');
  }
  private authorized(actor: MerchantActor, required: Required[], operations: readonly GovernanceOperation[], operation = 'merchant:analyze', control = false): boolean {
    if (!actor.auth || actor.auth.actorId !== actor.actorId || !actor.spaceId || !actor.membershipId || !actor.governancePolicyVersion) return false;
    if(required.some((item)=>item.resourceKind==='budget'&&item.capability==='rule:view')&&!this.unrestrictedBudgetRight(actor,'rule:view'))return false;
    if(required.some((item)=>item.resourceKind==='budget'&&item.capability==='source')&&!this.unrestrictedBudgetRight(actor,'source'))return false;
    if (required.some((item) => item.resourceKind === 'budget' &&
      (item.capability === 'merchant:delete' || item.capability === 'lifecycle:delete') &&
      !this.unrestrictedBudgetRight(actor,item.capability))) return false;
    if (control) { try { this.freshControlAuth(actor); } catch { return false; } }
    const space = this.options.store.governance.getSpaceForBudget({ budgetId: actor.budgetId });
    if (!space || space.id !== actor.spaceId) return false;
    const auth = actor.auth;
    if (!['session','human-session','api-key'].includes(auth.method)) return false;
    if ((auth.method === 'session' || auth.method === 'human-session') && (typeof auth.sessionId !== 'string' || !auth.sessionId.trim())) return false;
    const result = this.options.store.governance.authorize({ actorId: actor.actorId, spaceId: actor.spaceId, ...(actor.membershipId ? { membershipId: actor.membershipId } : {}), expectedPolicyVersion: actor.governancePolicyVersion, phase: 'read', operation, required: required.map((r) => ({ resourceKind: r.resourceKind, resourceId: r.resourceId, capability: r.capability, visibility: 'resource' as const })), payload: { operations }, now: this.now(), auth,
      ...(auth.method === 'api-key' && auth.principalType === 'agent' ? { agentId: auth.actorId, delegationId: auth.delegationId, delegationVersion: auth.delegationVersion } : {}) });
    return result.allowed && result.disposition.kind === 'authorized_without_approval';
  }
  private require(actor: MerchantActor, required: Required[], operations: GovernanceOperation[] = [], operation = 'merchant:analyze', control = false): void {
    if (!this.authorized(actor, required, operations, operation, control)) throw new Error('Merchant operation is not authorized');
  }
  private budget(actor: MerchantActor, capability = 'merchant:analyze'): Required[] { return [ref('budget', actor.budgetId, 'observe'), ref('budget', actor.budgetId, capability)]; }
  private unrestrictedBudgetRight(actor:MerchantActor,capability:string):boolean {
    const auth=actor.auth;const governance=this.options.store.governance;
    const delegation=auth.method==='api-key'&&auth.principalType==='agent'?governance.listDelegations({spaceId:actor.spaceId,agentId:actor.actorId}).find((item)=>item.id===auth.delegationId&&item.version===auth.delegationVersion):null;
    if(auth.method==='api-key'&&auth.principalType==='agent'&&!delegation)return false;
    const membershipId=delegation?.issuerMembershipId??actor.membershipId;
    if(!membershipId)return false;
    const grant=governance.currentResourceGrant({spaceId:actor.spaceId,actorId:delegation?.issuerActorId??actor.actorId,membershipId,budgetId:actor.budgetId,resourceKind:'budget',resourceId:actor.budgetId,capability});
    const right=delegation?.rights.find((item)=>item.resourceKind==='budget'&&item.resourceId===actor.budgetId&&item.capability===capability);
    if(!grant||(delegation&&!right))return false;
    return [grant.restrictions,right?.restrictions].every((restrictions)=>!restrictions||(!restrictions.aggregateOnly&&!restrictions.proposalOnly&&restrictions.accountIds===undefined&&restrictions.categoryIds===undefined));
  }
  private operations(source: ActualMerchantSource): GovernanceOperation[] {
    const operations: GovernanceOperation[] = [];
    for (const tx of source.dependencies.transactions) {
      if (tx.isCompleteSplitParent) continue;
      const signed = BigInt(tx.amount.minorUnits);
      operations.push({ operation: 'merchant:analyze', transactionId: tx.id, accountId: tx.accountId,
        ...(tx.categoryId ? { categoryId: tx.categoryId } : {}), direction: signed < 0n ? 'outgoing' : 'incoming',
        amount: { ...tx.amount, minorUnits: (signed < 0n ? -signed : signed).toString() } });
    }
    for (const schedule of source.schedules) {
      let selected: MerchantTransaction['amount'] | null = null;
      let magnitude = 0n;
      let outgoing = false;
      // One expectation: use its largest possible outflow, never sum range endpoints.
      for (const amount of [schedule.source.amount, schedule.source.minimum, schedule.source.maximum]) {
        if (amount === null) continue;
        const signed = BigInt(amount.minorUnits);
        const negative = signed < 0n;
        const absolute = negative ? -signed : signed;
        if (selected === null || negative && !outgoing || negative === outgoing && absolute > magnitude) {
          selected = amount; magnitude = absolute; outgoing = negative;
        }
      }
      operations.push({ operation: 'merchant:analyze',
        ...(schedule.source.accountId ? { accountId: schedule.source.accountId } : {}),
        ...(selected ? { direction: outgoing ? 'outgoing' : 'incoming', amount: { ...selected, minorUnits: magnitude.toString() } } : {}) });
    }
    for (const rule of source.rules) operations.push({ operation: 'rule:view', ruleId: rule.id });
    if (source.sourceAdmission.collections.rules === 'complete')
      operations.push({ operation: 'rule:view', accountScope: { kind: 'global' } });
    return operations;
  }
  private admit(actor: MerchantActor): Admission {
    this.require(actor, this.budget(actor));
    const governance = this.options.store.governance;
    const auth = actor.auth;
    const delegation = auth.method === 'api-key' && auth.principalType === 'agent'
      ? governance.listDelegations({ spaceId:actor.spaceId,agentId:actor.actorId }).find((d) => d.id === auth.delegationId && d.version === auth.delegationVersion) : null;
    const principal = delegation?.issuerActorId ?? actor.actorId;
    const delegatedRights = delegation ? new Set(delegation.rights.map((r) => JSON.stringify([r.resourceKind,r.resourceId,r.capability]))) : null;
    const grants = governance.listResourceGrants({ spaceId: actor.spaceId, actorId: principal }).filter((g) => g.granted && !g.revokedAt && g.budgetId === actor.budgetId && g.membershipId === (delegation?.issuerMembershipId ?? actor.membershipId) && (!delegatedRights || delegatedRights.has(JSON.stringify([g.resourceKind,g.resourceId,g.capability]))));
    const rights = new Set(grants.map((g) => JSON.stringify([g.resourceKind, g.resourceId, g.capability])));
    const has = (kind: GovernanceResourceKind, resourceId: string, capability: string) => rights.has(JSON.stringify([kind, resourceId, capability]));
    const ids = (kind: GovernanceResourceKind, capabilities: string[]) => uniq(grants.filter((g) => g.resourceKind === kind && capabilities.every((c) => has(kind, g.resourceId, c))).map((g) => g.resourceId));
    const accountIds = ids('account', ['existence','history']); const categoryIds = ids('category', ['existence','name']);
    const transactionIds = ids('transaction', ['transaction.view']);
    const unrestrictedRules = this.unrestrictedBudgetRight(actor,'rule:view') && this.authorized(actor,[...this.budget(actor),ref('budget',actor.budgetId,'rule:view')],[{operation:'rule:view',accountScope:{kind:'global'}}]);
    const ruleIds = unrestrictedRules ? null : ids('rule',['rule:view']);
    const unrestrictedPayees=this.unrestrictedBudgetRight(actor,'source')&&this.authorized(actor,[...this.budget(actor),ref('budget',actor.budgetId,'source')],[{operation:'merchant:analyze',accountScope:{kind:'global'}}]);
    const sourceAccounts = ids('account', ['source']);
    const sourceTransactionIds = transactionIds.filter((tx) => has('transaction', tx, 'source'));
    const sourceEvidenceIds = ids('evidence',['source']);
    const sourceScheduleIds = unrestrictedPayees ? null : sourceEvidenceIds.flatMap((value) => value.startsWith('merchant:schedule-source:') ? [value.slice('merchant:schedule-source:'.length)] : []);
    const schedulePayeeIds = unrestrictedPayees ? null : sourceEvidenceIds.flatMap((value) => value.startsWith('merchant:payee-source:') ? [value.slice('merchant:payee-source:'.length)] : []);
    const required = [...this.budget(actor),...(unrestrictedRules?[ref('budget',actor.budgetId,'rule:view')]:[]),...(unrestrictedPayees?[ref('budget',actor.budgetId,'source')]:[]), ...accountIds.flatMap((a) => [ref('account', a, 'existence'), ref('account', a, 'history')])];
    this.require(actor, required, accountIds.map((accountId) => ({ operation: 'merchant:analyze', accountId })));
    const domainRights = grants.filter((g) => ['budget', 'account', 'category', 'rule'].includes(g.resourceKind) && ['observe', 'merchant:analyze', 'existence', 'history', 'source', 'name', 'rule:view'].includes(g.capability))
      .map((g) => [g.resourceKind, g.resourceId, g.capability, g.restrictions])
      .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const delegatedDomain = delegation?.rights.filter((r) => ['budget','account','category','rule'].includes(r.resourceKind)).map((r) => [r.resourceKind,r.resourceId,r.capability,r.restrictions]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) ?? [];
    const domain = hash([actor.spaceId, actor.budgetId, accountIds, categoryIds, ruleIds, sourceAccounts, sourceScheduleIds, schedulePayeeIds, domainRights,delegatedDomain]);
    const privateVisibility = { hash: hash([domain, actor.actorId]), privateActorId: actor.actorId };
    const evidenceRights = grants.filter((g) => ['transaction', 'evidence'].includes(g.resourceKind) &&
      ['transaction.view', 'source', 'evidence', 'normalized-evidence'].includes(g.capability))
      .map((g) => [g.resourceKind, g.resourceId, g.capability, g.restrictions])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const delegatedEvidence = delegation?.rights.filter((r) => ['transaction', 'evidence'].includes(r.resourceKind) &&
      ['transaction.view', 'source', 'evidence', 'normalized-evidence'].includes(r.capability))
      .map((r) => [r.resourceKind, r.resourceId, r.capability, r.restrictions])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) ?? [];
    return { accountIds, categoryIds, transactionIds, sourceTransactionIds, sourceAccountIds:sourceAccounts, ruleIds,payeeIds:unrestrictedPayees?null:[],sourceScheduleIds,schedulePayeeIds, required, shared: { hash: domain, privateActorId: null }, private: privateVisibility,
      evidence: { hash: hash([privateVisibility.hash,transactionIds,sourceTransactionIds,evidenceRights,delegatedEvidence]), privateActorId:actor.actorId } };
  }
  private currentEvidenceVisibility(actor: MerchantActor, policy: MerchantPolicyView, shared: boolean): string {
    const admission = this.admit(actor);
    const base = shared ? hash([admission.shared.hash, admission.transactionIds, admission.sourceTransactionIds])
      : admission.evidence.hash;
    return hash([base, policy.generation, policy.version]);
  }
  private access(actor: MerchantActor, scope: MerchantScope, required: Required[] = [], operation = 'merchant:analyze', control = false): MerchantAccess {
    const generation = this.options.store.merchant.generation(scope);
    return { scope, now: this.now(), expectedGeneration: generation, authorize: (context) => {
      if (JSON.stringify(context.scope) !== JSON.stringify(scope) || context.generation !== generation) return false;
      const stored = context.sourceRefs.required;
      const operations: GovernanceOperation[] = operation === 'merchant:delete'
        ? [{ operation, accountScope: { kind: 'global' } }]
        : context.sourceRefs.transactionIds.map((transactionId) => ({ operation, transactionId }));
      return this.authorized(actor, [...this.budget(actor, operation), ...required, ...stored], operations, operation, control);
    } };
  }
  private readPolicy(actor: MerchantActor, scope: MerchantScope, operation = 'merchant:analyze'): MerchantPolicyView {
    const access = this.access(actor, scope, [], operation);
    this.require(actor, this.budget(actor, operation), [], operation);
    const stored = this.options.store.merchant.policy(access);
    const value = stored ? merchantPolicyValueSchema.parse({ mode: stored.mode, allowedProviderIds: stored.allowedProviderIds, maxSearchesPerDay: stored.maxSearchesPerDay, maxSpendMinorUnitsPerMonth: stored.maxSpendMinorUnitsPerMonth, billingCurrency: stored.billingCurrency, cacheTtlHours: stored.cacheTtlHours, ...(stored.calendar ? { calendar: stored.calendar } : {}) }) : { ...DEFAULT_POLICY };
    return { scope, value, version: stored?.version ?? 0, generation: access.expectedGeneration };
  }
  private async selected(actor: MerchantActor, operation = 'merchant:analyze'): Promise<MerchantScope> {
    this.require(actor, this.budget(actor, operation), [], operation);
    const config = await this.options.connectionManager.loadConfig();
    if (!config || config.budgetId !== actor.budgetId) throw new Error('Merchant selected budget changed');
    return { spaceId: actor.spaceId, budgetId: actor.budgetId, connectionId: merchantConnectionId(config) };
  }
  private decisions(actor: MerchantActor, scope: MerchantScope, admission: Admission): MerchantDecision[] {
    const result: MerchantDecision[] = [];
    for (const visibility of [admission.shared, admission.private]) {
      let cursor: string | undefined;
      do {
        const page = this.options.store.merchant.decisions({ ...this.access(actor, scope), actorId: actor.actorId, visibility, limit: 1000, ...(cursor ? { cursor } : {}) });
        result.push(...page.records); cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return result;
  }
  private async capture<T>(actor: MerchantActor, consume: (capture: Capture) => T | Promise<T>, connected?: ConnectedBudget,sharedSource=false): Promise<T> {
    const admission = this.admit(actor);
    if(sharedSource)admission.evidence={hash:hash([admission.shared.hash,admission.transactionIds,admission.sourceTransactionIds]),privateActorId:null};
    const entryScope = await this.selected(actor);
    const operation = async (current: ConnectedBudget) => {
      if (current.config.budgetId !== actor.budgetId || (current.budget.id || current.budget.groupId) !== actor.budgetId || merchantConnectionId(current.config) !== entryScope.connectionId) throw new Error('Merchant selected connection changed');
      const connector = current.connector as typeof current.connector & Partial<ActualMerchantSourceCapture>;
      if (!connector.captureMerchantSource || typeof connector.sourceCurrency !== 'string' || !/^[A-Z]{3}$/u.test(connector.sourceCurrency)) throw new Error('Merchant source capture is unavailable');
      const currency = connector.sourceCurrency;
      const policy = this.readPolicy(actor, entryScope);
      admission.evidence = { ...admission.evidence, hash: hash([admission.evidence.hash,policy.generation,policy.version]) };
      if(admission.payeeIds!==null)admission.payeeIds=uniq(this.decisions(actor,entryScope,admission).flatMap((decision)=>decision.payload.kind==='alias'?[decision.payload.targetPayeeId]:[]));
      const date = this.now().slice(0,10); const start = new Date(`${date}T00:00:00Z`); start.setUTCFullYear(start.getUTCFullYear() - 5);
      return connector.captureMerchantSource({ expiresAt: new Date(Date.parse(this.now()) + 86400000).toISOString(), startDate: start.toISOString().slice(0,10), endDate: date, maxTransactions: this.maxTransactions, admission: { visibilityHash: admission.evidence.hash, accountIds: admission.accountIds, categoryIds: admission.categoryIds, transactionIds: admission.transactionIds, sourceTransactionIds: admission.sourceTransactionIds, sourceAccountIds:admission.sourceAccountIds, ruleIds: admission.ruleIds,payeeIds:admission.payeeIds,sourceScheduleIds:admission.sourceScheduleIds,schedulePayeeIds:admission.schedulePayeeIds } }, async (captured) => {
        const overrides = await this.options.store.getRuleOverrides({spaceId:actor.spaceId,budgetId:actor.budgetId});
        const annotations = captured.rules.flatMap((rule) => { const override = overrides.get(rule.id);return override ? [[rule.id,override.inactive,override.version]]:[]; });
        const source:ActualMerchantSource = annotations.length ? {...captured,rules:captured.rules.map((rule) => {const override=overrides.get(rule.id);return override?.inactive === null || override?.inactive === undefined ? rule:{...rule,inactive:override.inactive};}),sourceAdmission:{...captured.sourceAdmission,factsHash:`sha256:${hash([captured.sourceAdmission.factsHash,annotations])}`}}:captured;
        const operations = this.operations(source);
        const dependencies = source.dependencies;
        const required = [...admission.required, ...dependencies.accountIds.flatMap((a) => [ref('account', a, 'existence'), ref('account', a, 'history')]), ...dependencies.categoryIds.flatMap((c) => [ref('category', c, 'existence'), ref('category', c, 'name')]), ...dependencies.ruleIds.map((ruleId) => ref('rule',ruleId,'rule:view')), ...dependencies.transactions.map((tx) => ref('transaction',tx.id,'transaction.view'))];
        if (dependencies.payeeNamespace || dependencies.scheduleNamespace) required.push(ref('budget',actor.budgetId,'source'));
        for (const tx of dependencies.transactions) if (tx.rawSource) required.push(ref('account',tx.accountId,'source'),ref('transaction',tx.id,'source'));
        for (const schedule of dependencies.schedules) {
          if (schedule.accountId) required.push(ref('account',schedule.accountId,'existence'),ref('account',schedule.accountId,'history'),ref('account',schedule.accountId,'source'));
          if (schedule.ruleId) required.push(ref('rule',schedule.ruleId,'rule:view'));
          if (!dependencies.scheduleNamespace) required.push(ref('evidence',`merchant:schedule-source:${schedule.id}`,'source'));
          if (schedule.payeeId && admission.schedulePayeeIds !== null) required.push(ref('evidence',`merchant:payee-source:${schedule.payeeId}`,'source'));
        }
        const dedup = new Map(required.map((r) => [JSON.stringify([r.resourceKind,r.resourceId,r.capability]), r]));
        const refs: MerchantSourceRefs = { accountIds: uniq(required.filter((item) => item.resourceKind === 'account').map((item) => item.resourceId)), categoryIds: uniq(required.filter((item) => item.resourceKind === 'category').map((item) => item.resourceId)), transactionIds: dependencies.transactions.map((tx) => tx.id), ruleIds: uniq(required.filter((item) => item.resourceKind === 'rule').map((item) => item.resourceId)), factsHash: bareHash(source.sourceAdmission.factsHash), required: [...dedup.values()] };
        this.require(actor, refs.required, operations);
        const decisions = this.decisions(actor, entryScope, admission);
        for (const decision of decisions) {
          refs.accountIds = uniq([...refs.accountIds,...decision.sourceRefs.accountIds]);
          refs.categoryIds = uniq([...refs.categoryIds,...decision.sourceRefs.categoryIds]);
          refs.ruleIds = uniq([...refs.ruleIds,...decision.sourceRefs.ruleIds]);
          refs.transactionIds = uniq([...refs.transactionIds,...decision.sourceRefs.transactionIds]);
          refs.required.push(...decision.sourceRefs.required);
        }
        refs.required = [...new Map(refs.required.map((r) => [JSON.stringify([r.resourceKind,r.resourceId,r.capability]),r])).values()];
        const corrections: MerchantAnalysisRequest['corrections'] = [];
        const transactions = new Map(source.transactions.map((tx) => [tx.id, tx]));
        const eligibleReviews = new Set<string>();
        for (let offset = 0; ; offset += 1000) {
          const page = await this.options.store.listReviewItems({ budgetId: actor.budgetId, limit: 1000, offset });
          for (const review of page) if ((review.status === 'applied' || review.status === 'superseded') && transactions.has(review.transactionId)) eligibleReviews.add(review.transactionId);
          if (page.length < 1000) break;
        }
        for (const transactionId of eligibleReviews) {
          const tx = transactions.get(transactionId)!;
          const evidenceKey = `merchant:transaction:${transactionId}`;
          const requiredEvidence = [ref('evidence',evidenceKey,'evidence'), ref('evidence',evidenceKey,'normalized-evidence')];
          if (!this.authorized(actor,[...refs.required,...requiredEvidence],operations)) continue;
          for (let offset = 0; ; offset += 1000) {
            const page = await this.options.store.queryCorrectionHistory({ transactionId, limit: 1000, offset });
            for (const correction of page) {
              if (!correction.verified || correction.toStatus !== 'applied' || !source.categories.some((category) => category.id === correction.categoryId)) continue;
              const review = await this.options.store.getReviewItem(correction.reviewItemId);
              if (!review || review.budgetId !== actor.budgetId || review.transactionId !== transactionId) continue;
              const provenance = review.sourceTransaction;
              const sourcePayeeId = review.evidence.sourcePayeeId;
              if (!provenance || provenance.accountId !== tx.accountId || provenance.amount.currency !== tx.amount.currency ||
                provenance.direction !== (BigInt(tx.amount.minorUnits) < 0n ? 'outgoing' : 'incoming') ||
                sourcePayeeId !== tx.payeeId || (sourcePayeeId !== null && typeof sourcePayeeId !== 'string')) continue;
              corrections.push({ transactionId, payeeId:tx.payeeId, accountId:tx.accountId, categoryId:correction.categoryId, state:'confirmed', verified:true, actorId:correction.actor, version:correction.transactionVersion });
            }
            if (page.length < 1000) break;
          }
          refs.required.push(...requiredEvidence);
        }
        refs.required = [...new Map(refs.required.map((r) => [JSON.stringify([r.resourceKind,r.resourceId,r.capability]),r])).values()];
        this.require(actor,refs.required,operations);
        return consume({ scope: entryScope, source, operations, currency,asOfDate:date, admission, policy, refs, decisions, corrections });
      });
    };
    return connected ? operation(connected) : this.options.connectionManager.withConnection(operation, { expectedBudgetId: actor.budgetId, synchronize: false });
  }
  private native(capture: Capture, input: MerchantAnalyzeInput): MerchantAnalysisResult {
    const { source, scope, decisions, policy } = capture;
    if (input.factsHash && input.factsHash !== source.sourceAdmission.factsHash) throw new Error('Merchant source facts changed');
    if (input.cursor && !input.factsHash) throw new Error('Merchant page requires current source facts');
    const calendars: MerchantCalendar[] = [];
    for (const accountId of source.sourceAdmission.sourceAccountIds) {
      const lookup = lookupMerchantCalendar({ accountId, year: Number(capture.asOfDate.slice(0,4)), budget: policy.value.calendar?.budget ?? null, accounts: policy.value.calendar?.accounts ?? [] });
      if (lookup.state === 'known') calendars.push({ ...lookup.calendar, accountId });
    }
    const aliases: MerchantAnalysisRequest['aliases'] = decisions.flatMap((d) => d.payload.kind === 'alias' && d.payload.normalizationVersion === 'merchant/2' && d.state !== 'revoked' ? [{ id: nativeDecisionId(d), sourceText: d.payload.sourceText, sourceField: d.payload.sourceField, targetPayeeId: d.payload.targetPayeeId, accountId: d.payload.accountId, state: d.state, actorId: d.actorId, version: d.version, updatedAt: d.updatedAt, sourceTransactionIds: d.payload.sourceTransactionIds }] : []);
    const patternDecisions = decisions.flatMap((d) => d.payload.kind === 'pattern' ? [{ id: nativeDecisionId(d), patternId: d.payload.patternId, state: d.state, actorId: d.actorId, version: d.version, updatedAt: d.updatedAt }] : []);
    const request = merchantAnalysisRequestSchema.parse({ schemaVersion: '1', transactions:source.transactions,payees:source.payees,categories:source.categories,rules:source.rules,schedules:source.schedules,sourceAdmission:source.sourceAdmission, scope, snapshotId: `merchant:${source.sourceAdmission.factsHash}:${source.sourceAdmission.capturedAt}`, asOfDate: capture.asOfDate, normalizationVersion: 'merchant/2', aliases, corrections: capture.corrections, patternDecisions, calendars, horizonYears: 5, maxEvidence: 20, suggestionSelection: { transactionIds: input.transactionIds ?? source.transactions.filter((tx) => tx.categoryId === null && !tx.isSplitParent && !tx.transferAccountId && !tx.startingBalance).map((tx) => tx.id), cursor: input.cursor ?? null, limit: input.limit ?? 200 } });
    let decoded: unknown;
    try { decoded = JSON.parse(this.options.native.analyzeMerchantIntelligence(JSON.stringify(request))); }
    catch { throw new Error('Merchant native analysis is unavailable'); }
    const result = parse(merchantAnalysisResultSchema,decoded);
    if (!result.suggestionPage) throw new Error('Merchant native suggestion page is unavailable');
    const transactions = new Map(source.transactions.map((tx) => [tx.id,tx]));
    const categories = new Set(source.categories.filter((category) => !category.deleted).map((category) => category.id));
    const ruleIds=new Set(source.rules.map((rule)=>rule.id));
    const payeeIds = new Set(source.payees.map((payee) => payee.id));
    if (result.scope.spaceId !== scope.spaceId || result.scope.budgetId !== scope.budgetId || result.scope.connectionId !== scope.connectionId ||
      result.sourceAdmission.factsHash !== source.sourceAdmission.factsHash || result.sourceAdmission.visibilityHash !== source.sourceAdmission.visibilityHash ||
      result.suggestions.some((suggestion) => transactions.get(suggestion.transactionId)?.accountId !== suggestion.accountId || (suggestion.categoryId !== null && !categories.has(suggestion.categoryId))) ||
      result.nativeRuleBlocks.some((block)=>block.ruleIds.some((ruleId)=>!ruleIds.has(ruleId))) ||
      result.nativeRuleClassifications.some((item)=>transactions.get(item.transactionId)?.accountId!==item.accountId||!categories.has(item.categoryId)||item.ruleSetIndex>=result.nativeRuleSets.length) ||
      result.categoryClassifications.some((item) => transactions.get(item.transactionId)?.accountId !== item.accountId ||
        !categories.has(item.categoryId) || (item.payeeId !== null && !payeeIds.has(item.payeeId))) ||
      result.recurrences.some((recurrence) => !source.sourceAdmission.sourceAccountIds.includes(recurrence.accountId)))
      throw new Error('Merchant native source admission is inconsistent');
    return result;
  }
  private evidenceRevision(c: Capture, nativeRevision: string): string { return hash([nativeRevision, c.refs.factsHash, c.asOfDate, c.policy.version, c.policy.generation, c.admission.evidence.hash, c.decisions.map((d) => [d.visibility.hash,d.id,d.version,d.state])]); }
  private context(c: Capture, key: string|null, revision: string, expiresAt = c.source.sourceAdmission.expiresAt): RuleReviewContext { return { scope: c.scope, sourceFactsHash: c.source.sourceAdmission.factsHash, evidenceKey: key, evidenceRevision: revision, merchantPolicyVersion: String(c.policy.version), visibilityHash: c.admission.evidence.hash, expiresAt }; }
  private publish(c: Capture, actor: MerchantActor, key: string, revision: string, calendarVersion: string|null = null): boolean {
    if (this.currentEvidenceVisibility(actor, c.policy, c.admission.evidence.privateActorId === null) !==
        c.admission.evidence.hash) return false;
    const required = [...c.refs.required, ref('evidence', key, 'evidence'), ref('evidence', key, 'normalized-evidence')];
    const evidenceRefs = { ...c.refs, required: [...new Map(required.map((r) => [JSON.stringify([r.resourceKind,r.resourceId,r.capability]),r])).values()] };
    const operations = [...c.operations, { operation: 'merchant:analyze', evidenceId: key }];
    if (!this.authorized(actor, evidenceRefs.required, operations)) return false;
    const access = { ...this.access(actor, c.scope), expectedGeneration: c.policy.generation, actorId: actor.actorId, visibility: c.admission.evidence };
    const prior = this.options.store.merchant.evidence({ ...access, key });
    if (prior?.revision === revision) return true;
    const value = this.options.store.merchant.putEvidence({ ...access, authorize: (context) => context.generation === c.policy.generation && Date.parse(this.now()) < Date.parse(c.source.sourceAdmission.expiresAt) && this.authorized(actor, evidenceRefs.required, operations) && this.authorized(actor, context.sourceRefs.required, operations), expectedRevision: prior?.revision ?? null, value: { key, revision, snapshotId: `merchant:${c.source.sourceAdmission.capturedAt}`, factsHash: c.refs.factsHash, normalizationVersion: 'merchant/2', calendarVersion, policyVersion: c.policy.version, capturedAt: c.source.sourceAdmission.capturedAt, expiresAt: c.source.sourceAdmission.expiresAt, visibility: c.admission.evidence, sourceRefs: evidenceRefs } });
    if (!value) throw new Error('Merchant evidence publication refused');
    return true;
  }
  private admittedEvidenceSubjects(actor: MerchantActor, c: Capture, keys: string[]): Set<string> {
    const auth = actor.auth;
    return new Set(this.options.store.governance.authorizeReadEvidenceSubjects({
      actorId: actor.actorId, spaceId: actor.spaceId, membershipId: actor.membershipId,
      expectedPolicyVersion: actor.governancePolicyVersion!, phase: 'read', operation: 'merchant:analyze',
      required: c.refs.required.map((r) => ({ resourceKind: r.resourceKind, resourceId: r.resourceId, capability: r.capability, visibility: 'resource' as const })),
      payload: { operations: c.operations }, now: this.now(), auth,
      ...(auth.method === 'api-key' && auth.principalType === 'agent'
        ? { agentId: auth.actorId, delegationId: auth.delegationId, delegationVersion: auth.delegationVersion } : {}),
    }, keys));
  }
  private view(actor: MerchantActor, c: Capture, input: MerchantAnalyzeInput): MerchantAnalysisView {
    this.options.store.merchant.prune({ now:this.now() });
    const result = this.native(c, input);
    const enabled = this.localEnabled(actor, c);
    const transactionsById = new Map(c.source.transactions.map((tx) => [tx.id,tx]));
    const decisionsByNativeId = new Map(c.decisions.map((decision) => [nativeDecisionId(decision), decision]));
    const publicEvidence = (evidence: MerchantSuggestion['evidence'][number]): MerchantSuggestion['evidence'][number] => {
      const decision = evidence.kind === 'confirmed_decision' && ['accepted_alias', 'rejected_alias'].includes(evidence.reasonCode)
        ? decisionsByNativeId.get(evidence.sourceId) : undefined;
      return decision ? { ...evidence, sourceId: decision.id } : evidence;
    };
    const suggestions: MerchantPublicSuggestion[] = [];
    this.require(actor, c.refs.required, c.operations);
    const admitted = this.admittedEvidenceSubjects(actor, c, enabled
      ? uniq([...result.categoryClassifications.map((s) => `merchant:transaction:${s.transactionId}`),
        ...result.suggestions.map((s) => `merchant:transaction:${s.transactionId}`),
        ...result.recurrences.map((r) => `merchant:pattern:${r.id}`)])
      : []);
    const proofs = new Map<string, MerchantReviewProof>();
    for (const target of enabled ? result.categoryClassifications : []) {
      const key = `merchant:transaction:${target.transactionId}`;
      if (!admitted.has(key)) continue;
      const revision = this.evidenceRevision(c, target.evidenceRevision);
      proofs.set(target.transactionId, { ...target, evidenceKey: key, evidenceRevision: revision,
        reviewContext: this.context(c, key, revision) });
    }
    for (const s of enabled ? result.suggestions : []) {
      const key = `merchant:transaction:${s.transactionId}`; const revision = this.evidenceRevision(c, s.evidenceRevision);
      if (!admitted.has(key)) continue;
      const tx = transactionsById.get(s.transactionId)!;
      const nativeAliases = new Set([...s.evidence,...s.contradictions].filter((item) => item.kind === 'confirmed_decision' && ['accepted_alias','rejected_alias'].includes(item.reasonCode)).map((item) => item.sourceId));
      const referencedAliases = new Set([...nativeAliases].map((nativeId) => decisionsByNativeId.get(nativeId)));
      const aliasDecisions = c.decisions.flatMap<MerchantPublicAliasDecision>((decision) => decision.payload.kind === 'alias' && (decision.payload.sourceTransactionIds.includes(s.transactionId) || referencedAliases.has(decision)) ? [{ id:decision.id,sourceField:decision.payload.sourceField,targetPayeeId:decision.payload.targetPayeeId,accountId:decision.payload.accountId,state:decision.state,version:decision.version,updatedAt:decision.updatedAt,visibility:decision.visibility.privateActorId === null ? 'shared':'private' }]:[]);
      suggestions.push({ ...s,evidence:s.evidence.map(publicEvidence),contradictions:s.contradictions.map(publicEvidence),sourceTransaction:sourceTransactionProjection.parse(tx),aliasDecisions, evidenceRevision: revision, evidenceKey: key, reviewContext: this.context(c,key,revision) });
    }
    const recurrences: MerchantPublicRecurrence[] = [];
    for (const r of enabled ? result.recurrences : []) {
      const key = `merchant:pattern:${r.id}`; const revision = this.evidenceRevision(c,r.evidenceRevision);
      if (!admitted.has(key)) continue;
      const patternDecisions = c.decisions.flatMap<MerchantPublicPatternDecision>((decision) => decision.payload.kind === 'pattern' && decision.payload.patternId === r.id ? [{id:decision.id,patternId:decision.payload.patternId,state:decision.state,version:decision.version,updatedAt:decision.updatedAt,visibility:decision.visibility.privateActorId === null ? 'shared':'private'}]:[]);
      recurrences.push({ ...r,patternDecisions, evidenceRevision: revision, evidenceKey: key });
    }
    const categoryNames = new Map(c.source.categories.map((v) => [v.id,v.name]));
    const nativeClassifications=new Map(result.nativeRuleClassifications.map((item)=>[item.transactionId,item]));
    const visible = new Map(suggestions.map((v) => [v.transactionId,v]));
    const candidates: CategorizationCandidate[] = [];
    let total = 0n;
    let oldest: string | null = null;
    for (const tx of c.source.transactions) {
      if (tx.categoryId !== null || tx.isSplitParent || tx.transferAccountId || tx.startingBalance || tx.deleted) continue;
      if (oldest === null || tx.date < oldest) oldest = tx.date;
      const nativeTarget=c.source.sourceAdmission.collections.rules==='complete'?nativeClassifications.get(tx.id):undefined;
      const evidence=visible.get(tx.id);
      const proof = proofs.get(tx.id);
      if (proof && evidence && !sameMerchantReviewBinding(proof, evidence))
        throw new Error('Merchant category proof conflicts with its explanation');
      const inferred = proof !== undefined;
      const amount = BigInt(tx.amount.minorUnits); total += amount < 0n ? -amount : amount;
      candidates.push({ transactionId: tx.id, source: nativeTarget ? 'native-rule' : inferred ? 'merchant-inferred' : 'uncategorized', amount: { ...tx.amount, minorUnits: (amount < 0n ? -amount : amount).toString() }, payeeName: tx.payeeName, date: tx.date, reasons: [{ kind: 'uncategorized', details: 'Transaction requires category review' }], ...(nativeTarget ? { proposedCategoryId: nativeTarget.categoryId, proposedCategoryName: categoryNames.get(nativeTarget.categoryId) ?? '', ruleSetIndex: nativeTarget.ruleSetIndex } : proof ? { proposedCategoryId: proof.categoryId, proposedCategoryName: categoryNames.get(proof.categoryId) ?? '', merchantProof: proof, ...(evidence ? { merchantEvidence: evidence } : {}) } : {}) });
    }
    this.require(actor, c.refs.required, c.operations);
    if (this.options.store.merchant.generation(c.scope) !== c.policy.generation) throw new Error('Merchant policy changed');
    const totalAmount = moneySchema.safeParse({ minorUnits: total.toString(), currency: c.currency });
    if (!totalAmount.success) throw new ApplicationError({ code: 'analysis_failed',
      message: 'Merchant uncategorized amount exceeds Money range', reasonCodes: [ReasonCodes.AMOUNT_OVERFLOW] });
    return {
      scope: c.scope,normalizationVersion:result.normalizationVersion,asOfDate:c.asOfDate,payees:c.source.payees.map((payee) => ({id:payee.id,name:payee.name})),categories:c.source.categories.map((category)=>({id:category.id,name:category.name})), sourceAdmission: result.sourceAdmission, coverage: result.coverage, suggestions, recurrences,
      scheduledExpectations: enabled ? result.scheduledExpectations.filter((s) => this.authorized(actor,
        [...c.refs.required,ref('evidence', `merchant:schedule:${s.id}`, 'normalized-evidence')], c.operations)) : [],
      suggestionPage: { ...result.suggestionPage!, returned:suggestions.length },
      nativeRuleBlocks: result.nativeRuleBlocks, nativeRuleParts: result.nativeRuleParts,
      nativeRuleSets: result.nativeRuleSets, nativeRuleClassifications: result.nativeRuleClassifications,
      localReview: {
        uncategorizedCount: candidates.length,
        totalUncategorizedAmount: totalAmount.data,
        candidates, oldestUncategorizedDate:oldest,
        healthState:result.coverage.limited ? 'degraded' : 'healthy', blockers: [],
      },
    };
  }
  private sourcePublicationFence(actor: MerchantActor, c: Capture, subjectKeys: string[], scheduleKeys: string[] = [],
    nativeSource?: { required: Required[]; operations: GovernanceOperation[] }, expiresAt = c.source.sourceAdmission.expiresAt):
    (outbound?: readonly GovernanceOperation[]) => boolean {
    const nativeRequired = nativeSource && [...new Map([...c.refs.required, ...nativeSource.required]
      .map((item) => [JSON.stringify([item.resourceKind,item.resourceId,item.capability]), item])).values()];
    let outboundOperations: readonly GovernanceOperation[] | null = null;
    return (outbound?: readonly GovernanceOperation[]) => {
      if (outbound) outboundOperations = outbound;
      try {
        if (this.options.store.merchant.generation(c.scope) !== c.policy.generation ||
          !(Date.parse(this.now()) < Date.parse(c.source.sourceAdmission.expiresAt)) ||
          !(Date.parse(this.now()) < Date.parse(expiresAt)) ||
          !this.authorized(actor, c.refs.required, c.operations) ||
          (nativeSource && nativeRequired && !this.authorized(actor, nativeRequired, nativeSource.operations)) ||
          (outboundOperations !== null && !this.authorized(actor, c.refs.required, outboundOperations))) return false;
        const policy = this.readPolicy(actor, c.scope);
        if (policy.version !== c.policy.version || policy.generation !== c.policy.generation) return false;
        if (this.currentEvidenceVisibility(actor, policy, c.admission.evidence.privateActorId === null) !==
            c.admission.evidence.hash) return false;
        if (subjectKeys.length === 0 && scheduleKeys.length === 0) return true;
        if (policy.value.mode === 'disabled' || !this.localEnabled(actor, c) ||
          this.admittedEvidenceSubjects(actor, c, subjectKeys).size !== subjectKeys.length) return false;
        return scheduleKeys.every((key) => this.authorized(actor,
          [...c.refs.required, ref('evidence', key, 'normalized-evidence')], c.operations));
      } catch { return false; }
    };
  }
  private analysisPublicationFence(actor: MerchantActor, c: Capture, view: MerchantAnalysisView):
    (outbound?: readonly GovernanceOperation[]) => boolean {
    const subjects = new Set(view.suggestions.map((suggestion) => suggestion.evidenceKey));
    for (const recurrence of view.recurrences) subjects.add(recurrence.evidenceKey);
    for (const candidate of view.localReview.candidates)
      if (candidate.merchantProof) subjects.add(candidate.merchantProof.evidenceKey);
    const subjectKeys = [...subjects].sort();
    const scheduleKeys=view.scheduledExpectations.map((s)=>`merchant:schedule:${s.id}`);
    return this.sourcePublicationFence(actor, c, subjectKeys, scheduleKeys);
  }
  /** Analyze currently admitted source without persisting each displayed explanation. */
  async analyze(actor: MerchantActor, input: unknown = {}): Promise<MerchantAnalysisView> {
    return this.withAnalysis(actor,input,(view,source,authorize)=>{
      if(!authorize(merchantDisclosureOperations(view,source)))throw new Error('Merchant operation is not authorized');
      return view;
    });
  }
  /** Trusted consumers latch their complete outbound monetary collection independently from source admission and retain a current publication fence. */
  async withAnalysis<T>(actor:MerchantActor,input:unknown,consume:(view:MerchantAnalysisView,source:CanonicalReviewSource,authorize:(outbound?:readonly GovernanceOperation[])=>boolean)=>T|Promise<T>):Promise<T> {
    const parsed=parse(analyzeInput,input);
    const publication: { scope?: MerchantScope; authorize?: () => boolean } = {};
    const output = await this.capture(actor,async(c)=>{
      const view=this.view(actor,c,parsed);
      const authorize=this.analysisPublicationFence(actor,c,view);
      publication.scope=c.scope;
      publication.authorize=authorize;
      const source:CanonicalReviewSource={
        transactions:c.source.transactions.map((tx)=>({id:tx.id,accountId:tx.accountId,payeeId:tx.payeeId,payeeName:tx.payeeName,categoryId:tx.categoryId,date:tx.date,amount:tx.amount,subtransactions:[]})),
        merchantDerivation:{scope:c.scope,privateActorId:c.admission.evidence.privateActorId,capturedAt:c.source.sourceAdmission.capturedAt,expiresAt:c.source.sourceAdmission.expiresAt},
      };
      if(!authorize())throw new Error('Merchant operation is not authorized');
      const result=await consume(view,source,authorize);
      if(!authorize())throw new Error('Merchant operation is not authorized');
      return result;
    });
    const config=await this.options.connectionManager.loadConfig();
    if(!publication.scope||!config||config.budgetId!==publication.scope.budgetId||
      merchantConnectionId(config)!==publication.scope.connectionId)throw new Error('Merchant selected connection changed');
    if(!publication.authorize?.())throw new Error('Merchant operation is not authorized');
    return output;
  }
  private async decide(actor: MerchantActor, value: unknown, state: 'accepted'|'rejected'): Promise<MerchantDecision> {
    const input = parse(decisionInput,value); this.freshControlAuth(actor);
    this.require(actor,this.budget(actor,'merchant:confirm'), [], 'merchant:confirm',true);
    return this.capture(actor,(c) => {
      if (!this.localEnabled(actor, c)) throw new Error('Merchant suggestion use is disabled');
      const key = input.kind === 'alias' ? `merchant:transaction:${input.transactionId}` : `merchant:pattern:${input.patternId}`;
      if (key !== input.evidenceKey) throw new Error('Merchant evidence subject mismatch');
      const access = { ...this.access(actor,c.scope), actorId: actor.actorId, visibility: c.admission.evidence };
      const analysis = this.native(c,{ transactionIds:input.kind === 'alias' ? [input.transactionId] : [] });
      const subject = input.kind === 'alias'
        ? analysis.suggestions.find((s) => s.transactionId === input.transactionId)
        : analysis.recurrences.find((r) => r.id === input.patternId);
      if (!subject || this.evidenceRevision(c,subject.evidenceRevision) !== input.evidenceRevision ||
          !this.publish(c,actor,key,input.evidenceRevision,'calendarVersion' in subject ? subject.calendarVersion : null))
        throw new Error('Merchant evidence is no longer current');
      const stored = this.options.store.merchant.evidence({ ...access,key });
      if (!stored || stored.revision !== input.evidenceRevision) throw new Error('Merchant evidence is no longer current');
      let payload: MerchantDecisionPayload;
      const required = [...stored.sourceRefs.required,...this.budget(actor,'merchant:confirm'),ref('evidence',key,'merchant:confirm')];
      let operations: GovernanceOperation[] = [...c.operations,{ operation:'merchant:confirm',evidenceId:key }];
      if (input.kind === 'alias') {
        if(input.accountId===null&&!this.unrestrictedBudgetRight(actor,'merchant:confirm'))throw new Error('Merchant operation is not authorized');
        const tx = c.source.transactions.find((tx) => tx.id === input.transactionId);
        if (!tx || !c.source.payees.some((p) => p.id === input.targetPayeeId) || (input.accountId !== null && input.accountId !== tx.accountId)) throw new Error('Merchant alias source is unavailable');
        const text = input.sourceField === 'payeeName' ? tx.payeeName : tx[input.sourceField].state === 'present' ? tx[input.sourceField].value : null;
        if (!text) throw new Error('Merchant alias source is unavailable');
        required.push(ref('account',tx.accountId,'merchant:confirm'));
        if (input.sourceField !== 'payeeName') required.push(ref('account',tx.accountId,'source'),ref('transaction',tx.id,'source'));
        operations = [...operations,{ operation:'merchant:confirm',transactionId:tx.id,accountId:tx.accountId,accountScope: input.accountId === null ? { kind:'global' } : { kind:'accounts',accountIds:[input.accountId] } }];
        payload = { kind:'alias', sourceText:text, sourceField:input.sourceField, targetPayeeId:input.targetPayeeId, accountId:input.accountId, normalizationVersion:'merchant/2', sourceTransactionIds:[tx.id] };
      } else {
        const current = analysis.recurrences.find((r) => r.id === input.patternId);
        if (!current) throw new Error('Merchant pattern source is unavailable');
        required.push(ref('account',current.accountId,'merchant:confirm')); payload = { kind:'pattern',patternId:input.patternId };
      }
      this.require(actor,required,operations,'merchant:confirm',true);
      const sourceRefs = stored.sourceRefs;
      const result = this.options.store.merchant.decide({ ...access, visibility: input.visibility === 'shared' ? c.admission.shared : c.admission.private, authorize: (context) => !(input.kind==='alias'&&input.accountId===null&&!this.unrestrictedBudgetRight(actor,'merchant:confirm')) && context.generation === c.policy.generation && Date.parse(this.now()) < Date.parse(stored.expiresAt) && this.authorized(actor,[...context.sourceRefs.required,...required],operations,'merchant:confirm',true), id:input.id,payload,state,sourceRefs,expectedVersion:input.expectedVersion });
      if (!result) throw new Error('Merchant decision conflict or authorization changed');
      return result;
    });
  }
  /** Confirm a human evidence decision without writing Actual. */
  async confirm(actor: MerchantActor,input: unknown): Promise<MerchantDecision> { return this.decide(actor,input,'accepted'); }
  /** Rejection remains independent of later source evidence refresh. */
  async reject(actor: MerchantActor,input: unknown): Promise<MerchantDecision> { return this.decide(actor,input,'rejected'); }
  /** Read the current authorized stored policy. */
  async policy(actor: MerchantActor): Promise<MerchantPolicyView> {
    const scope = await this.selected(actor, 'policy');
    const policy = this.readPolicy(actor,scope, 'policy');
    const required = [ref('budget',actor.budgetId,'policy'), ...(policy.value.calendar?.accounts.flatMap((a) => [ref('account',a.accountId,'existence'),ref('account',a.accountId,'policy')]) ?? [])];
    this.require(actor,[...this.budget(actor, 'policy'),...required], [], 'policy:view');
    return policy;
  }
  /** Replace full stored policy under fresh human control and optimistic version. */
  async setPolicy(actor: MerchantActor,input: unknown): Promise<MerchantPolicyView> {
    const parsed = parse(z.object({ expectedVersion:count,value:merchantPolicyValueSchema }).strict(),input);
    if (parsed.value.calendar) lookupMerchantCalendar({
      accountId: parsed.value.calendar.accounts[0]?.accountId ?? 'budget-policy-validation',
      year: this.clock().getUTCFullYear(), budget:parsed.value.calendar.budget, accounts:parsed.value.calendar.accounts,
    });
    const scope = await this.selected(actor, 'policy'); const prior = this.readPolicy(actor,scope, 'policy');
    const accountIds = uniq([...(prior.value.calendar?.accounts.map((a) => a.accountId) ?? []),...(parsed.value.calendar?.accounts.map((a) => a.accountId) ?? [])]);
    const required = [ref('space',actor.spaceId,'policy:manage'),ref('budget',actor.budgetId,'policy'),...accountIds.flatMap((a) => [ref('account',a,'existence'),ref('account',a,'policy')])];
    this.require(actor,[...this.budget(actor, 'policy'),...required],accountIds.map((accountId) => ({ operation:'policy:update',accountId })),'policy:update',true);
    const operations: GovernanceOperation[] = [{ operation:'policy:update',resourceKind:'space',resourceId:actor.spaceId }, ...accountIds.map((accountId) => ({ operation:'policy:update',accountId }))];
    const access = this.access(actor,scope,required,'policy',true);
    const saved = this.options.store.merchant.setPolicy({ ...access,
      authorize: (context) => context.generation === prior.generation && this.authorized(actor,[...this.budget(actor, 'policy'),...required],operations,'policy:update',true),
      value:parsed.value, expectedVersion:parsed.expectedVersion });
    if (!saved) throw new Error('Merchant policy conflict or authorization changed');
    this.researchCoordinator.abortBudget({ spaceId: actor.spaceId, budgetId: actor.budgetId });
    return this.readPolicy(actor,scope, 'policy');
  }
  /** Resolve a stored explicit jurisdiction offline; absent selection is unknown. */
  async calendar(actor: MerchantActor,input: unknown): Promise<MerchantCalendarLookup> {
    const parsed = parse(z.object({ accountId:id,year:z.number().int().min(1).max(9999) }).strict(),input);
    const scope = await this.selected(actor); const required = [ref('budget',actor.budgetId,'policy'),ref('account',parsed.accountId,'existence'),ref('account',parsed.accountId,'policy')];
    this.require(actor,[...this.budget(actor),...required],[{ operation:'calendar:view',accountId:parsed.accountId }]);
    const policy = this.readPolicy(actor,scope);
    const result = lookupMerchantCalendar({ ...parsed,budget:policy.value.calendar?.budget ?? null,accounts:policy.value.calendar?.accounts ?? [] });
    this.require(actor,[...this.budget(actor),...required],[{ operation:'calendar:view',accountId:parsed.accountId }]); return result;
  }
  /** Export only currently readable local source and decisions, never external cache. */
  async export(actor: MerchantActor): Promise<MerchantExport> {
    this.require(actor,this.budget(actor,'merchant:export'),[],'merchant:export',true);
    const publication: { scope?: MerchantScope; authorize?: () => boolean } = {};
    const output = await this.capture(actor,(c) => {
      const policyRights = [ref('budget',actor.budgetId,'policy'),...(c.policy.value.calendar?.accounts ?? []).flatMap((account) => [ref('account',account.accountId,'existence'),ref('account',account.accountId,'policy')])];
      const required = [...this.budget(actor,'merchant:export'),...c.refs.required,...policyRights];
      this.require(actor,required,c.operations,'merchant:export',true);
      const analysis = this.view(actor,c,{});
      const source:CanonicalReviewSource={transactions:c.source.transactions.map((tx)=>({id:tx.id,accountId:tx.accountId,payeeId:tx.payeeId,payeeName:tx.payeeName,categoryId:tx.categoryId,date:tx.date,amount:tx.amount,subtransactions:[]}))};
      const outbound = merchantDisclosureOperations(analysis,source);
      const authority = this.analysisPublicationFence(actor,c,analysis);
      publication.scope=c.scope;
      publication.authorize=()=>authority(outbound)&&
        this.authorized(actor,required,c.operations,'merchant:export',true)&&
        this.authorized(actor,required,outbound,'merchant:export',true);
      if(!publication.authorize())throw new Error('Merchant operation is not authorized');
      return {scope:c.scope,analysis,decisions:c.decisions,policy:c.policy};
    });
    const config=await this.options.connectionManager.loadConfig();
    if(!publication.scope||!config||config.budgetId!==publication.scope.budgetId||
      merchantConnectionId(config)!==publication.scope.connectionId)throw new Error('Merchant selected connection changed');
    if(!publication.authorize?.())throw new Error('Merchant operation is not authorized');
    return output;
  }
  /** Atomically purge derived content and fence every selected space/budget connection under fresh lifecycle authority. */
  async delete(actor: MerchantActor): Promise<{ generation:number }> {
    const scope = await this.selected(actor, 'merchant:delete'); const required = [ref('budget',actor.budgetId,'lifecycle:delete')];
    this.require(actor,[...this.budget(actor,'merchant:delete'),...required],[{ operation:'merchant:delete',accountScope:{kind:'global'} }],'merchant:delete',true);
    const access = this.access(actor,scope,required,'merchant:delete',true);
    const generation = this.options.store.merchant.purgeBudget(access);
    if (generation !== access.expectedGeneration + 1) throw new Error('Merchant purge refused');
    this.researchCoordinator.abortBudget({ spaceId: actor.spaceId, budgetId: actor.budgetId });
    return { generation };
  }
  /**
   * Resolve under the caller's already-held selected connection lock; never recursively acquire it.
   * Snapshot must be a fresh, fully authorized SDK capture in that lock, never request or persisted data.
   * It binds older/excluded financial facts; admitted merchant source is independently recaptured and compared.
   * Direct settings use actor-neutral authority; merchant-linked evidence retains its private visibility.
   */
  async getCurrentRuleReviewContext(actor: MerchantActor,input: { evidenceKey:string|null;connected:ConnectedBudget;snapshot:ProtocolSnapshot;sourceAvailability?:unknown;capturePublicationAuthority?: (authorize: () => boolean) => void }): Promise<RuleReviewContext> {
    const snapshot=canonicalProtocolSnapshotSchema.parse(input.snapshot);
    requireCompleteRulePlanningSource(snapshot,input.sourceAvailability);
    const transactions=new Map<string,Transaction>();
    const collect=(rows:Transaction[]):void=>{for(const tx of rows){if(transactions.has(tx.id))throw new Error('Current rule snapshot has conflicting source identities');transactions.set(tx.id,tx);collect(tx.subtransactions);}};
    collect(snapshot.transactions);
    const required=[...this.budget(actor),ref('budget',actor.budgetId,'rule:view'),...snapshot.accounts.flatMap((account)=>[ref('account',account.id,'existence'),ref('account',account.id,'history')]),...snapshot.categories.flatMap((category)=>[ref('category',category.id,'existence'),ref('category',category.id,'name')]),...snapshot.rules.map((rule)=>ref('rule',rule.id,'rule:view')),...[...transactions.values()].flatMap((tx)=>[ref('transaction',tx.id,'transaction.view'),ref('account',tx.accountId,'existence'),ref('account',tx.accountId,'history'),...(tx.categoryId?[ref('category',tx.categoryId,'existence'),ref('category',tx.categoryId,'name')]:[])])];
    const uniqueRequired=[...new Map(required.map((item)=>[JSON.stringify([item.resourceKind,item.resourceId,item.capability]),item])).values()];
    const operations:GovernanceOperation[]=[{operation:'rule:view',accountScope:{kind:'global'}},...[...transactions.values()].filter((tx)=>tx.subtransactions.length===0).map((tx)=>({operation:'merchant:analyze',transactionId:tx.id,accountId:tx.accountId,...(tx.categoryId?{categoryId:tx.categoryId}:{}),direction:BigInt(tx.amount.minorUnits)<0n?'outgoing' as const:'incoming' as const,amount:{...tx.amount,minorUnits:(BigInt(tx.amount.minorUnits)<0n?-BigInt(tx.amount.minorUnits):BigInt(tx.amount.minorUnits)).toString()}}))];
    this.require(actor,uniqueRequired,operations);
    if(!this.unrestrictedBudgetRight(actor,'rule:view'))throw new Error('Merchant operation is not authorized');
    const publication: { authorize?: () => boolean } = {};
    const context = await this.capture(actor,(c) => {
      const retainAuthority = (context: RuleReviewContext) => {
        const authorize = this.sourcePublicationFence(actor, c, input.evidenceKey === null ? [] : [input.evidenceKey],
          [], { required: uniqueRequired, operations }, context.expiresAt);
        if (!authorize()) throw new Error('Current rule publication authority is unavailable');
        publication.authorize = authorize;
        input.capturePublicationAuthority?.(authorize);
        return context;
      };
      this.require(actor,[...new Map([...uniqueRequired,...c.refs.required].map((item)=>[JSON.stringify([item.resourceKind,item.resourceId,item.capability]),item])).values()],operations);
      for(const tx of c.source.transactions){const current=transactions.get(tx.id);if(!current||current.accountId!==tx.accountId||current.payeeId!==tx.payeeId||(current.categoryId??null)!==tx.categoryId||current.date!==tx.date||current.amount.currency!==tx.amount.currency||current.amount.minorUnits!==tx.amount.minorUnits)throw new Error('Current rule snapshot differs from captured merchant source');}
      const payees=new Map(snapshot.payees.map((payee)=>[payee.id,payee]));
      const categories=new Map(snapshot.categories.map((category)=>[category.id,category]));
      const rules=new Map(snapshot.rules.map((rule)=>[rule.id,rule]));
      for(const payee of c.source.payees){const current=payees.get(payee.id);if(!current||current.name!==payee.name||current.transferAccountId!==payee.transferAccountId)throw new Error('Current rule snapshot payees differ from captured source');}
      for(const category of c.source.categories){const current=categories.get(category.id);if(!current||current.name!==category.name||current.groupName!==category.groupName||current.isIncome!==category.isIncome||current.deleted!==category.deleted)throw new Error('Current rule snapshot categories differ from captured source');}
      for(const rule of c.source.rules){const current=rules.get(rule.id);if(!current||JSON.stringify([current.order,current.trigger,current.actions])!==JSON.stringify([rule.order,rule.trigger,rule.actions]))throw new Error('Current rule snapshot rules differ from captured source');}
      if(input.evidenceKey===null){
        const stable=[...transactions.values()].map((tx)=>({id:tx.id,accountId:tx.accountId,payeeId:tx.payeeId,categoryId:tx.categoryId??null,date:tx.date,amount:tx.amount})).sort((a,b)=>a.id.localeCompare(b.id));
        const factsHash=`sha256:${hash([c.refs.factsHash,stable,snapshot.payees,snapshot.categories,snapshot.rules])}`;
        return retainAuthority({...this.context(c,null,hash([factsHash,c.policy.version,c.admission.evidence.hash])),sourceFactsHash:factsHash});
      }
      if (!this.localEnabled(actor,c)) throw new Error('Merchant review evidence is no longer current');
      const transactionPrefix = 'merchant:transaction:';
      const patternPrefix = 'merchant:pattern:';
      const key = input.evidenceKey;
      const current = this.native(c,{ transactionIds: key.startsWith(transactionPrefix) ? [key.slice(transactionPrefix.length)] : [] });
      const subject = key.startsWith(transactionPrefix)
        ? current.suggestions.find((s) => s.transactionId === key.slice(transactionPrefix.length))
        : key.startsWith(patternPrefix) ? current.recurrences.find((r) => r.id === key.slice(patternPrefix.length)) : undefined;
      if (!subject) throw new Error('Merchant review evidence is no longer current');
      const revision = this.evidenceRevision(c,subject.evidenceRevision);
      if (!this.publish(c,actor,key,revision,'calendarVersion' in subject ? subject.calendarVersion : null))
        throw new Error('Merchant review evidence is no longer current');
      const stored = this.options.store.merchant.evidence({ ...this.access(actor,c.scope),actorId:actor.actorId,visibility:c.admission.evidence,key });
      if (!stored || stored.revision !== revision) throw new Error('Merchant review evidence is no longer current');
      return retainAuthority(this.context(c,key,revision,stored.expiresAt));
    },input.connected,input.evidenceKey===null);
    if (!publication.authorize?.()) throw new Error('Current rule publication authority is unavailable');
    return context;
  }
  /** Retain current stored-subject disclosure authority for terminal replay without reading or replanning Actual. */
  async getRuleReplayPublicationAuthority(actor: MerchantActor, context: RuleReviewContext): Promise<() => boolean> {
    const scope = await this.selected(actor);
    const key = context.evidenceKey;
    if (!key || scope.spaceId !== context.scope.spaceId || scope.budgetId !== context.scope.budgetId ||
        scope.connectionId !== context.scope.connectionId) throw new Error('Stored rule publication namespace is unavailable');
    return () => {
      try {
        const policy = this.readPolicy(actor, scope);
        if (!this.localEnabled(actor, { scope, policy })) return false;
        if (this.currentEvidenceVisibility(actor, policy, false) !== context.visibilityHash) return false;
        return this.options.store.merchant.evidence({
          ...this.access(actor, scope, [ref('evidence', key, 'evidence'), ref('evidence', key, 'normalized-evidence')]),
          actorId: actor.actorId, visibility: { hash: context.visibilityHash, privateActorId: actor.actorId }, key,
        }) !== null;
      } catch { return false; }
    };
  }
  /** Read independently persisted space research policy without inheriting budget opt-in. */
  async spacePolicy(actor: MerchantActor): Promise<MerchantPolicyView> {
    this.require(actor, [...this.budget(actor, 'policy'), ref('space', actor.spaceId, 'policy:manage')], [], 'policy:view');
    return this.readPolicy(actor, this.spaceScope(await this.selected(actor, 'policy')), 'policy');
  }
  /** Replace space policy with fresh human authority; calendar selections remain budget-owned. */
  async setSpacePolicy(actor: MerchantActor, input: unknown): Promise<MerchantPolicyView> {
    const parsed = parse(z.object({ expectedVersion: count, value: merchantPolicyValueSchema.refine((value) => !value.calendar) }).strict(), input);
    const required = [...this.budget(actor, 'policy'), ref('space', actor.spaceId, 'policy:manage')];
    const operations: GovernanceOperation[] = [{ operation: 'policy:update', resourceKind: 'space', resourceId: actor.spaceId }];
    this.require(actor, required, operations, 'policy:update', true);
    const scope = this.spaceScope(await this.selected(actor, 'policy'));
    const prior = this.readPolicy(actor, scope, 'policy');
    const access = this.access(actor, scope, required, 'policy', true);
    const saved = this.options.store.merchant.setPolicy({ ...access, expectedVersion: parsed.expectedVersion, value: parsed.value,
      authorize: (context) => context.generation === prior.generation && this.authorized(actor, required, operations, 'policy:update', true) });
    if (!saved) throw new Error('Merchant space policy conflict or authorization changed');
    this.researchCoordinator.abortBudget({ spaceId: actor.spaceId, budgetId: actor.budgetId });
    return this.readPolicy(actor, scope, 'policy');
  }
  /** Resolve installation, space and budget policy without disclosing credentials. */
  async researchPolicy(actor: MerchantActor): Promise<MerchantResearchPolicyView> {
    const installation = this.researchSettings().installation;
    const budget = await this.policy(actor); const space = await this.spacePolicy(actor);
    const resolved = resolveMerchantResearchPolicy([
      { kind: 'installation', version: installation.version, value: installation.value },
      { kind: 'space', version: String(space.version), value: space.version ? space.value : null },
      { kind: 'budget', version: String(budget.version), value: budget.version ? budget.value : null },
    ], ValueSerpProvider.providerInfo);
    if (!this.researchSettings().configuration) {
      if (resolved.mode !== 'disabled') resolved.mode = 'local-only';
      resolved.allowedProviderIds = [];
    }
    return { installation, budget, space, resolved };
  }
  /** Preview exact public-business egress independently of local evidence decisions. */
  async previewResearch(actor: MerchantActor, input: unknown): Promise<MerchantResearchPreview> { return this.researchCoordinator.preview(actor, input); }
  /** Dispatch only independently consented, freshly authorized public-business research. */
  async research(actor: MerchantActor, input: unknown): Promise<MerchantResearchOutcome> { return this.researchCoordinator.research(actor, input); }
  /** Read authorized historical semantic evidence without another provider request. */
  async cachedResearch(actor: MerchantActor, input: unknown): Promise<{ enrichment: MerchantEnrichment | null }> { return { enrichment: await this.researchCoordinator.cached(actor, input) }; }
}

/** Production composition reuses the existing lazy native loader and caller's connection/store. */
export async function createMerchantIntelligenceService(options: Omit<MerchantServiceOptions,'native'>): Promise<MerchantIntelligenceService> {
  const native = await loadNativeBindings();
  if (!native.analyzeMerchantIntelligence) throw new Error('Native merchant intelligence capability unavailable');
  return new MerchantIntelligenceService({ ...options,native:{ analyzeMerchantIntelligence:native.analyzeMerchantIntelligence } });
}
