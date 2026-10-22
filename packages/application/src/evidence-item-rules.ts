import { prioritizeEvidenceItemSuggestions } from './evidence-item-ladder.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  EvidenceAccess,
  EvidenceDocument,
  EvidenceScope,
  EvidenceItemRuleRecord,
  EvidenceItemRulePayload,
  EvidenceItemCategoryDecision,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import { canonicalProposalJson } from '@balanceframe/workflow-store';
import type {
  EvidenceRuleProposal,
  EvidenceRuleSimulationResult,
  TransactionEvidenceRequest,
  EvidenceItemRuleLearningResult,
} from '@balanceframe/protocol-generated';
import {
  EvidenceRuleSimulationResultSchema,
  EvidenceRuleCriterionSchema,
  EvidenceItemRuleLearningResultSchema,
  financialSnapshotSchema,
} from '@balanceframe/protocol-generated/validators';
import type { MerchantActor } from './merchant-service.js';
import { merchantConnectionId } from './merchant-service.js';
import type { ConnectionManager } from './connection-manager.js';
const id = z.string().trim().min(1).max(256);
/** Exact local merchant and item criteria; Actual writes remain outside this rule workflow. */
export const evidenceItemRuleInputSchema = z
  .object({
    connectorId: id,
    accountId: id,
    fundingInstrumentId: id,
    counterparty: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0 && !/\p{Cc}/u.test(value)),
    sku: id.nullable(),
    normalizedDescription: id.nullable(),
    criterion: EvidenceRuleCriterionSchema.optional(),
    categoryId: id,
  })
  .strict()
  .refine(
    (input) =>
      input.criterion
        ? input.sku === null && input.normalizedDescription === null
        : input.sku !== null || input.normalizedDescription !== null,
    'Choose either exact item criteria or one explicit contextual criterion',
  );
/** Approval and revocation bind only an existing displayed immutable proposal. */
export const evidenceItemRuleDecisionSchema = z.object({ proposalId: id, payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Deterministic suggestions are inspectable intent and never mutate Actual. */
export interface EvidenceItemSuggestion { proposalId: string; payloadHash: string; accountId: string; receiptId: string; lineId: string; categoryId: string; sourceDocumentId: string; simulationHash: string; state: 'suggested'|'conflicting_rules'; reasonCodes: string[] }
export interface EvidenceItemRuleCapture {
  scope: EvidenceScope;
  documents: EvidenceDocument[];
  request: TransactionEvidenceRequest;
  outcomes: EvidenceItemCategoryDecision[];
  authorize: () => boolean;
}
/** Internal callbacks preserve the main evidence service's exact authorization and source fence. */
export interface EvidenceItemRuleHost {
  store: WorkflowStore;
  connectionManager?: ConnectionManager;
  native: {
    simulateTransactionEvidenceRule?(input: string): string;
    learnTransactionEvidenceItemRules?(input: string): string;
  };
  now: () => string;
  scope: (actor: MerchantActor) => Promise<EvidenceScope>;
  capture: (actor: MerchantActor, connectorId: string) => Promise<EvidenceItemRuleCapture>;
  access: (actor: MerchantActor, scope: EvidenceScope, documents?: EvidenceDocument[], additional?: unknown) => EvidenceAccess;
}
const digest = (value: unknown): string => createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
type ActualContext = { hash: string; categories: string[]; availableCategoryIds: string[]; ruleIds: string[]; unsupported: boolean; authorize: () => boolean };
/** Application orchestration around native receipt conservation and scoped historical rule simulation. */
export class EvidenceItemRules {
  constructor(private readonly host: EvidenceItemRuleHost) {}
  private require(actor: MerchantActor, scope: EvidenceScope, capability: 'item-rule:propose'|'item-rule:approve'|'item-rule:read'): void {
    if (!this.host.access(actor, scope).authorize({ capability, document: null, scope })) throw new Error('Evidence item rule is not authorized');
  }
  private fresh(actor: MerchantActor): void {
    const auth = actor.auth; const now = Date.parse(this.host.now());
    if (auth.method !== 'human-session' || auth.actorId !== actor.actorId || !auth.sessionId.trim() || !Number.isFinite(Date.parse(auth.reauthenticatedAt)) || Date.parse(auth.reauthenticatedAt) > now || now - Date.parse(auth.reauthenticatedAt) > 300000) throw new Error('Fresh human item-rule approval required');
  }
  private resource(actor: MerchantActor, kind: 'budget'|'account'|'category'|'rule', identity: string, capability: string): boolean {
    return this.host.store.liquidity.isAuthorized({ ...actor, now: this.host.now(), resourceKind: kind, resourceId: identity, capability });
  }
  private async actual(
    actor: MerchantActor,
    scope: EvidenceScope,
    accountId: string,
    categoryId?: string,
  ): Promise<ActualContext> {
    const admitted = (): boolean => this.resource(actor, 'budget', actor.budgetId, 'source') && this.resource(actor, 'budget', actor.budgetId, 'rule:view') && this.resource(actor, 'account', accountId, 'existence') && this.resource(actor, 'account', accountId, 'transaction');
    if (!admitted()) throw new Error('Current Actual rule interaction is not authorized');
    if (!this.host.connectionManager) throw new Error('Current Actual rule interaction unavailable');
    const current = await this.host.connectionManager.withConnection(async (connected) => {
      if (connected.config.budgetId !== actor.budgetId || merchantConnectionId(connected.config) !== scope.connectionId) throw new Error('Selected evidence ledger changed');
      const snapshot = financialSnapshotSchema.parse((connected.synchronization as { financialSnapshot?: unknown }).financialSnapshot);
      if (!['complete','empty'].includes(snapshot.coverage.rules)) throw new Error('Current Actual rule coverage is incomplete');
      if (snapshot.legacySnapshot.rules.some((rule) => !this.resource(actor, 'rule', rule.id, 'rule:view'))) throw new Error('Current Actual rule interaction is not authorized');
      if (!snapshot.legacySnapshot.accounts.some((account) => account.id === accountId && !account.isClosed)) throw new Error('Evidence rule account unavailable');
      const availableCategoryIds = snapshot.legacySnapshot.categories.filter((category) => !category.deleted).map((category) => category.id);
      if (categoryId !== undefined && !availableCategoryIds.includes(categoryId)) throw new Error('Evidence rule category unavailable');
      return { rules: snapshot.legacySnapshot.rules, availableCategoryIds };
    }, { expectedBudgetId: actor.budgetId });
    const { rules, availableCategoryIds } = current;
    const authorize = (): boolean => admitted() && rules.every((rule) => this.resource(actor, 'rule', rule.id, 'rule:view'));
    if (!authorize()) throw new Error('Current Actual rule interaction is not authorized');
    const categories = new Set<string>();
    const ruleIds: string[] = [];
    let unsupported = false;
    for (const rule of rules.filter((rule) => !rule.inactive)) {
      const trigger = rule.trigger as { conditionsOp?: unknown; conditions?: unknown } | null;
      const terms = Array.isArray(trigger?.conditions) ? trigger.conditions : [];
      if (
        trigger?.conditionsOp === 'and' &&
        terms.some((condition: unknown) => {
          const term = condition as { field?: unknown; op?: unknown; value?: unknown };
          return (
            term.field === 'account' && ((term.op === 'is' && typeof term.value === 'string' && term.value !== accountId) || (term.op === 'oneOf' && Array.isArray(term.value) && term.value.every((value: unknown) => typeof value === 'string') && !term.value.includes(accountId)))
          );
        })
      )
        continue;
      ruleIds.push(rule.id);
      if (!Array.isArray(rule.actions)) {
        unsupported = true;
        continue;
      }
      for (const action of rule.actions) {
        const value = action as { field?: unknown; op?: unknown; value?: unknown } | null;
        if (!value || typeof value.field !== 'string') { unsupported = true; continue; }
        if (value.field === 'category') { if (value.op === 'set' && typeof value.value === 'string' && value.value.trim()) categories.add(value.value); else unsupported = true; }
      }
    }
    return { hash: digest(rules), availableCategoryIds, categories: [...categories].sort(), ruleIds: ruleIds.sort(), unsupported, authorize };
  }
  private simulate(rule: EvidenceRuleProposal, source: EvidenceItemRuleCapture, actual: ActualContext): EvidenceRuleSimulationResult {
    if (!this.host.native.simulateTransactionEvidenceRule) throw new Error('Native evidence item-rule simulation unavailable');
    const result = EvidenceRuleSimulationResultSchema.parse(JSON.parse(this.host.native.simulateTransactionEvidenceRule(JSON.stringify({ contractVersion: '1', rule, evidence: source.request, actualRuleCategories: actual.categories }))));
    if (result.ruleId !== rule.id) throw new Error('Evidence item-rule simulation identity changed');
    if (actual.unsupported) { result.conflicts = [...new Set([...result.conflicts, 'actual_rule_interaction_unknown'])]; result.falsePositiveRisk = 'conflicting_history'; }
    if (!source.authorize() || !actual.authorize()) throw new Error('Evidence item-rule source changed or is not authorized');
    return result;
  }
  private visible(
    actor: MerchantActor,
    scope: EvidenceScope,
    record: EvidenceItemRuleRecord,
  ): boolean {
    const documents = record.documentIds.flatMap((identity) => { const document = this.host.store.evidence.get(this.host.access(actor, scope), identity); return document ? [document] : []; });
    return (
      documents.length === record.documentIds.length && this.host.access(actor, scope, documents, record).authorize({ capability: 'normalized-evidence', document: documents[0]!, scope })
    );
  }
  /** Current explicit outcomes remain attributable and never come from imported category hints. */
  async outcomes(actor: MerchantActor, value: unknown): Promise<EvidenceItemCategoryDecision[]> {
    const input = z.object({ connectorId: id, accountId: id }).strict().parse(value);
    const scope = await this.host.scope(actor);
    this.require(actor, scope, 'item-rule:read');
    const source = await this.host.capture(actor, input.connectorId);
    const actual = await this.actual(actor, scope, input.accountId);
    const outcomes = source.outcomes.filter(
      (outcome) =>
        outcome.accountId === input.accountId &&
        (outcome.categoryId === null || actual.availableCategoryIds.includes(outcome.categoryId)),
    );
    if (
      !source.authorize() ||
      !actual.authorize() ||
      !this.host
        .access(actor, scope, source.documents, outcomes)
        .authorize({ capability: 'normalized-evidence', document: source.documents[0]!, scope })
    )
      throw new Error('Item category outcomes changed or are not authorized');
    return outcomes;
  }
  /** Rust derives repeated exact criteria; every result still requires normal proposal and approval. */
  async candidates(
    actor: MerchantActor,
    value: unknown,
  ): Promise<
    EvidenceItemRuleLearningResult & {
      connectorId: string;
      accountId: string;
      generatedAt: string;
      expiresAt: string;
      reviewedOutcomes: EvidenceItemCategoryDecision[];
    }
  > {
    const input = z.object({ connectorId: id, accountId: id }).strict().parse(value);
    const scope = await this.host.scope(actor);
    this.require(actor, scope, 'item-rule:read');
    if (!this.host.native.learnTransactionEvidenceItemRules)
      throw new Error('Native item rule learning unavailable');
    const source = await this.host.capture(actor, input.connectorId);
    const actual = await this.actual(actor, scope, input.accountId);
    const result = this.learn(actor, scope, input.accountId, source, actual);
    const generatedAt = this.host.now();
    if (
      !source.authorize() ||
      !actual.authorize() ||
      !this.host
        .access(actor, scope, source.documents, result)
        .authorize({ capability: 'normalized-evidence', document: source.documents[0]!, scope })
    )
      throw new Error('Item rule candidates changed or are not authorized');
    return {
      ...result,
      ...input,
      reviewedOutcomes: source.outcomes.filter(
        (outcome) =>
          outcome.accountId === input.accountId &&
          (outcome.categoryId === null || actual.availableCategoryIds.includes(outcome.categoryId)),
      ),
      generatedAt,
      expiresAt: new Date(Date.parse(generatedAt) + 300000).toISOString(),
    };
  }
  private learn(
    actor: MerchantActor,
    scope: EvidenceScope,
    accountId: string,
    source: EvidenceItemRuleCapture,
    actual: ActualContext,
  ): EvidenceItemRuleLearningResult {
    const outcomes = source.outcomes
      .filter(
        (outcome) =>
          outcome.accountId === accountId &&
          (outcome.categoryId === null || actual.availableCategoryIds.includes(outcome.categoryId)),
      )
      .map((outcome) => {
        const document = source.documents.find((document) => document.id === outcome.documentId)!;
        return {
          sourceIdentity: digest([
            scope,
            document.connectorId,
            document.sourceId,
            document.privateActorId,
          ]),
          documentId: outcome.documentId,
          contentHash: outcome.contentHash,
          parserVersion: outcome.parserVersion,
          receiptId: outcome.receiptId,
          lineId: outcome.lineId,
          accountId: outcome.accountId,
          categoryId: outcome.categoryId,
          policyVersion: outcome.policyVersion,
        };
      });
    const result = EvidenceItemRuleLearningResultSchema.parse(
      JSON.parse(
        this.host.native.learnTransactionEvidenceItemRules!(
          JSON.stringify({
            contractVersion: '1',
            policyVersion: actor.governancePolicyVersion,
            accountId: accountId,
            includeBroaderCriteria: true,
            evidence: source.request,
            outcomes,
          }),
        ),
      ),
    );
    // Include current Actual interaction so changed native rules invalidate a displayed candidate too.
    result.candidates = result.candidates.map((candidate) => ({
      ...candidate,
      candidateHash: digest([
        candidate.candidateHash,
        actual.hash,
        source.outcomes.filter(
          (outcome) =>
            outcome.accountId === accountId &&
            candidate.examples.some(
              (example) =>
                example.documentId === outcome.documentId &&
                example.receiptId === outcome.receiptId &&
                example.lineId === outcome.lineId,
            ),
        ),
      ]),
    }));
    return result;
  }
  /** Selecting a learned candidate never activates it; ordinary immutable proposal review remains mandatory. */
  async proposeCandidate(actor: MerchantActor, value: unknown): Promise<EvidenceItemRuleRecord> {
    const input = z
      .object({ connectorId: id, accountId: id, candidateHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(value);
    const current = await this.candidates(actor, {
      connectorId: input.connectorId,
      accountId: input.accountId,
    });
    const candidate = current.candidates.find(
      (candidate) => candidate.candidateHash === input.candidateHash,
    );
    if (!candidate) throw new Error('Item rule candidate changed or unavailable');
    return this.propose(
      actor,
      {
        connectorId: input.connectorId,
        accountId: input.accountId,
        counterparty: candidate.rule.counterparty,
        fundingInstrumentId: candidate.rule.fundingInstrumentId,
        sku: candidate.rule.sku,
        normalizedDescription: candidate.rule.normalizedDescription,
        categoryId: candidate.rule.categoryId,
        ...(candidate.rule.criterion ? { criterion: candidate.rule.criterion } : {}),
      },
      input.candidateHash,
    );
  }
  /** Propose exact local item criteria with complete native history and current Actual-rule interaction. */
  async propose(
    actor: MerchantActor,
    value: unknown,
    expectedCandidateHash?: string,
  ): Promise<EvidenceItemRuleRecord> {
    const input = evidenceItemRuleInputSchema.parse(value);
    const scope = await this.host.scope(actor);
    this.require(actor, scope, 'item-rule:propose');
    if (!this.resource(actor, 'category', input.categoryId, 'category')) throw new Error('Evidence item-rule target category is not authorized');
    const source = await this.host.capture(actor, input.connectorId);
    const actual = await this.actual(actor, scope, input.accountId, input.categoryId);
    const sourceIds = [...new Set(source.request.observations.filter((observation) => observation.fundingInstrumentId === input.fundingInstrumentId && source.request.receipts.some((receipt) => receipt.observationId === observation.id)).map((observation) => observation.sourceId))];
    if (sourceIds.length !== 1) throw new Error('Evidence item-rule source family is unavailable or ambiguous');
    const rule: EvidenceRuleProposal = {
      id: randomUUID(),
      sourceId: sourceIds[0]!,
      fundingInstrumentId: input.fundingInstrumentId,
      counterparty: input.counterparty,
      sku: input.sku,
      normalizedDescription: input.normalizedDescription,
      ...(input.criterion ? { criterion: input.criterion } : {}),
      categoryId: input.categoryId,
    };
    const simulation = this.simulate(rule, source, actual);
    const reviewedCandidate =
      expectedCandidateHash || input.criterion
        ? this.learn(actor, scope, input.accountId, source, actual).candidates.find((candidate) =>
            expectedCandidateHash
              ? candidate.candidateHash === expectedCandidateHash
              : candidate.rule.sourceId === rule.sourceId &&
                candidate.rule.counterparty === rule.counterparty &&
                candidate.rule.fundingInstrumentId === rule.fundingInstrumentId &&
                candidate.rule.categoryId === rule.categoryId &&
                canonicalProposalJson(candidate.rule.criterion ?? null) ===
                  canonicalProposalJson(rule.criterion ?? null),
          )
        : undefined;
    if ((expectedCandidateHash || input.criterion) && !reviewedCandidate)
      throw new Error(
        'Broader item rule requires two current reviewed source identities or candidate changed',
      );
    const examples: EvidenceItemRulePayload['examples'] = simulation.matches.flatMap((match) => {
      const receipt = source.request.receipts.find((receipt) => receipt.id === match.receiptId); const line = receipt?.lines.find((line) => line.id === match.lineId); const observation = source.request.observations.find((observation) => observation.id === receipt?.observationId);
      return line && observation ? [{ documentId: observation.provenance.documentId, receiptId: match.receiptId, lineId: match.lineId, rawDescription: line.rawDescription, normalizedDescription: line.normalizedDescription, sku: line.sku, amount: line.net, currentCategoryId: line.categoryId }] : [];
    });
    const learning = reviewedCandidate
      ? {
          candidateHash: reviewedCandidate.candidateHash,
          outcomes: source.outcomes.filter(
            (outcome) =>
              outcome.accountId === input.accountId &&
              simulation.matches.some(
                (match) => match.receiptId === outcome.receiptId && match.lineId === outcome.lineId,
              ),
          ),
        }
      : undefined;
    const access = this.host.access(actor, scope);
    const now = access.now;
    const payload: EvidenceItemRulePayload = {
      connectorId: input.connectorId,
      accountId: input.accountId,
      rule,
      policyVersion: actor.governancePolicyVersion!,
      requesterMembershipId: actor.membershipId!,
      ...(learning ? { learning } : {}),
      documentIds: source.documents.map((document) => document.id),
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 7 * 86400000).toISOString(),
      actualRulesHash: actual.hash,
      simulation,
      examples,
      actualInteraction: { kind: 'local_item_suggestion_only', reasonCode: 'actual_item_predicate_unavailable', actualRuleIds: actual.ruleIds },
    };
    if (!this.host.access(actor, scope, source.documents, payload).authorize({ capability: 'normalized-evidence', document: source.documents[0]!, scope })) throw new Error('Evidence item-rule proposal is not authorized');
    return this.host.store.evidence.itemRules.propose(access, payload);
  }
  /** Read only owner-scoped proposals with currently authorized supporting evidence. */
  async list(actor: MerchantActor): Promise<EvidenceItemRuleRecord[]> {
    const scope = await this.host.scope(actor); this.require(actor, scope, 'item-rule:read');
    const records = this.host.store.evidence.itemRules.list(this.host.access(actor, scope)).filter((record) => this.visible(actor, scope, record));
    const documents = [...new Map(records.flatMap((record) => record.documentIds).map((identity) => { const document = this.host.store.evidence.get(this.host.access(actor, scope), identity); return [identity, document] as const; })).values()].filter((document): document is EvidenceDocument => document !== null);
    if (documents.length && !this.host.access(actor, scope, documents, records).authorize({ capability: 'normalized-evidence', document: documents[0]!, scope })) return [];
    return records;
  }
  private reviewedSupportCurrent(
    proposal: EvidenceItemRuleRecord,
    source: EvidenceItemRuleCapture,
  ): boolean {
    return (
      !proposal.learning ||
      proposal.learning.outcomes.every((outcome) =>
        source.outcomes.some(
          (current) => canonicalProposalJson(current) === canonicalProposalJson(outcome),
        ),
      )
    );
  }
  /** Approve or revoke an exact proposal with fresh human authority; approval reruns the current simulation. */
  async decide(
    actor: MerchantActor,
    value: unknown,
    action: 'approved' | 'revoked',
  ): Promise<EvidenceItemRuleRecord> {
    const input = evidenceItemRuleDecisionSchema.parse(value);
    this.fresh(actor);
    const scope = await this.host.scope(actor);
    this.require(actor, scope, 'item-rule:approve');
    const proposal = this.host.store.evidence.itemRules.get(this.host.access(actor, scope), input.proposalId);
    if (!proposal || !this.visible(actor, scope, proposal) || proposal.payloadHash !== input.payloadHash || proposal.policyVersion !== actor.governancePolicyVersion) throw new Error('Evidence item-rule proposal changed or is not authorized');
    if (action === 'approved') {
      const source = await this.host.capture(actor, proposal.connectorId);
      const actual = await this.actual(actor, scope, proposal.accountId, proposal.rule.categoryId);
      const simulation = this.simulate(proposal.rule, source, actual);
      if (!this.reviewedSupportCurrent(proposal, source))
        throw new Error('Reviewed rule support changed');
      if (actual.hash !== proposal.actualRulesHash || canonicalProposalJson(simulation) !== canonicalProposalJson(proposal.simulation)) throw new Error('Evidence item-rule source or Actual rules changed');
      if (simulation.conflicts.length || !simulation.matches.length) throw new Error('Evidence item-rule history conflicts or has no examples');
    }
    return this.host.store.evidence.itemRules.decide(this.host.access(actor, scope), { ...input, policyVersion: actor.governancePolicyVersion!, membershipId: actor.membershipId!, action });
  }
  /** Apply approved exact rules as suggestions after current Rust conservation and simulation; Actual stays authoritative. */
  async suggestions(actor: MerchantActor, value: unknown): Promise<EvidenceItemSuggestion[]> {
    const input = z.object({ accountId: id }).strict().parse(value);
    const scope = await this.host.scope(actor);
    this.require(actor, scope, 'item-rule:read');
    const proposals = this.host.store.evidence.itemRules.list(this.host.access(actor, scope)).filter((record) => record.state === 'approved' && record.accountId === input.accountId && record.policyVersion === actor.governancePolicyVersion && this.visible(actor, scope, record));
    if (!proposals.length) return [];
    const actual = await this.actual(actor, scope, input.accountId);
    const suggestions: EvidenceItemSuggestion[] = [];
    const matches: Array<{ rule: EvidenceRuleProposal; suggestion: EvidenceItemSuggestion }> = [];
    const witnesses: Array<{ proposal: EvidenceItemRuleRecord; source: EvidenceItemRuleCapture }> = [];
    for (const proposal of proposals) {
      if (actual.hash !== proposal.actualRulesHash || !actual.availableCategoryIds.includes(proposal.rule.categoryId) || !this.resource(actor, 'category', proposal.rule.categoryId, 'category')) continue;
      const source = await this.host.capture(actor, proposal.connectorId);
      const simulation = this.simulate(proposal.rule, source, actual);
      if (!this.reviewedSupportCurrent(proposal, source)) continue;
      if (simulation.conflicts.length) continue;
      witnesses.push({ proposal, source });
      for (const match of simulation.matches) {
        const receipt = source.request.receipts.find((receipt) => receipt.id === match.receiptId);
        const observation = source.request.observations.find((observation) => observation.id === receipt?.observationId);
        if (!observation || match.conflict) continue;
        suggestions.push({
          proposalId: proposal.id,
          payloadHash: proposal.payloadHash,
          accountId: input.accountId,
          receiptId: match.receiptId,
          lineId: match.lineId,
          categoryId: match.proposedCategoryId,
          sourceDocumentId: observation.provenance.documentId,
          simulationHash: simulation.resolutionHash,
          state: 'suggested',
          reasonCodes: [
            proposal.rule.criterion
              ? `approved_${proposal.rule.criterion.kind}_rule`
              : proposal.rule.sku === null ? 'approved_exact_item_rule' : 'approved_exact_sku_rule',
          ],
        });
        matches.push({ rule: proposal.rule, suggestion: suggestions[suggestions.length - 1]! });
      }
      if (!this.host.access(actor, scope, source.documents, suggestions).authorize({ capability: 'normalized-evidence', document: source.documents[0]!, scope })) throw new Error('Evidence item-rule suggestions are not authorized');
    }
    if (
      !actual.authorize() ||
      witnesses.some(({ proposal, source }) => {
        const current = this.host.store.evidence.itemRules.get(this.host.access(actor, scope), proposal.id);
        return (
          !source.authorize() || !current || current.state !== 'approved' || current.payloadHash !== proposal.payloadHash || current.policyVersion !== actor.governancePolicyVersion || !this.visible(actor, scope, current)
        );
      })
    )
      return [];
    const includedDocuments = [...new Map(witnesses.flatMap(({ source }) => source.documents).map((document) => [document.id, document])).values()];
    if (includedDocuments.length && !this.host.access(actor, scope, includedDocuments, suggestions).authorize({ capability: 'normalized-evidence', document: includedDocuments[0]!, scope })) return [];
    return prioritizeEvidenceItemSuggestions(matches);
  }
}
