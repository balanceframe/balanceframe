import { ledgerEvidenceHash } from './evidence-ledger-source.js';
import { WalletStatementService, qualifiedWalletId } from './wallet-statement.js';
import {
  evidenceAllocationPreviewSchema,
  evidenceAllocationSaveSchema,
} from './evidence-allocation.js';
import {
  receiptAnnotationInputSchema,
  receiptReviewSaveSchema,
  prepareReceiptAnnotations,
  applyReceiptAnnotations,
} from './evidence-receipt-annotations.js';
import { ReceiptVersionService, receiptVersionDocuments } from './evidence-receipt-version.js';
import {
  evidenceSettlementPreviewSchema,
  evidenceSettlementSaveSchema,
  evidenceSettlementTargetsInputSchema,
} from './evidence-settlement.js';
import { SpendSessionReceiptService } from './spend-session-receipt.js';
import {
  itemCategoryReviewInputSchema,
  prepareItemCategoryDecisions,
  applyReviewedItemCategories,
} from './evidence-item-categories.js';
import { SavedSessionReceiptIntentSchema } from '@balanceframe/protocol-generated/validators';
import { manualReceiptPhotoExtractionSchema, parseManualReceiptPhoto } from './receipt-photo.js';
import { EvidenceItemRules } from './evidence-item-rules.js';
import { canonicalProposalJson } from '@balanceframe/workflow-store';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  EvidenceAccess,
  EvidenceAudit,
  EvidenceDocument,
  EvidenceScope,
  GovernanceOperation,
  GovernanceResourceKind,
  WorkflowStore,
  LiquidityActor,
  EvidenceResolutionDecision,
  SpaceMembership,
  EvidenceItemCategoryDecision,
} from '@balanceframe/workflow-store';
import type {
  ConsequentialActionPlan,
  AtomicConsequentialActionIntent,
  ConsequentialActionIntent,
  Transaction,
  EvidenceObservation,
  EvidenceSettlementPlan,
  EvidenceAllocationPlan,
  FinancialSnapshot,
  SourceObservation,
  TransactionEvidenceRequest,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
import {
  EvidenceObservationSchema,
  EvidenceAllocationReviewSchema,
  EvidenceAllocationPlanSchema,
  EvidenceSettlementPlanSchema,
  EvidenceRelationshipSchema,
  WalletEvidenceSchema,
  ReceiptEvidenceSchema,
  TransactionEvidenceRequestSchema,
  TransactionEvidenceResultSchema,
  economicEventLedgerEffectSchema,
  financialSnapshotSchema,
} from '@balanceframe/protocol-generated/validators';
import type { MerchantActor } from './merchant-service.js';
import { merchantConnectionId } from './merchant-service.js';
import type { ConnectionManager } from './connection-manager.js';
import { loadNativeBindings } from './composition.js';

const id = z.string().trim().min(1).max(256);
export const transactionEvidenceImportSchema = z
  .object({
    connectorId: id,
    sourceId: id,
    sourceTimestamp: z.string().datetime({ offset: true }),
    mediaType: z.enum([
      'application/json',
      'text/plain',
      'application/pdf',
      'image/png',
      'image/jpeg',
    ]),
    sourceKind: z.enum(['wallet', 'retail']),
    content: z
      .string()
      .min(1)
      .max(14 * 1024 * 1024),
    contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
    retentionDays: z.number().int().min(1).max(30).default(7),
    visibility: z.enum(['private', 'shared']).default('private'),
    userExtraction: manualReceiptPhotoExtractionSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      !input.userExtraction ||
      (input.sourceKind === 'retail' &&
        ['image/jpeg', 'image/png', 'application/pdf'].includes(input.mediaType) &&
        input.contentEncoding === 'base64'),
    'Manual receipt entry requires retail JPEG/PNG/PDF original bytes in base64',
  );
const extractionSchema = z
  .object({
    templateVersion: z.enum(['wallet-v1', 'retail-v1', 'retail-photo-user-v1']),
    observations: z.array(EvidenceObservationSchema.omit({ provenance: true })).max(10000),
    relationships: z.array(EvidenceRelationshipSchema).max(20000).default([]),
    wallets: z.array(WalletEvidenceSchema).max(1000).default([]),
    receipts: z.array(ReceiptEvidenceSchema).max(1000).default([]),
  })
  .strict();
/** Validate exact human decisions without accepting identity or policy grants from documents. */
export const transactionEvidenceDecisionSchema = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: id,
    maxSettlementDays: z.number().int().min(0).max(90).default(5),
    relationships: z.array(EvidenceRelationshipSchema).max(20000),
    ledgerEffects: z
      .array(z.object({ observationId: id, effect: economicEventLedgerEffectSchema }).strict())
      .max(10000)
      .default([]),
    itemCategoryDecisions: z.array(itemCategoryReviewInputSchema).max(10000).default([]),
    receiptAnnotationDecisions: z.array(receiptAnnotationInputSchema).max(10000).default([]),
    allocationReview: EvidenceAllocationReviewSchema.optional(),
    purposeDecisions: z
      .array(
        z
          .object({ observationId: id, eventType: EvidenceObservationSchema.shape.eventType })
          .strict(),
      )
      .max(10000)
      .default([]),
  })
  .strict();
/** Normalized parser output carries no source authority or executable instructions. */
export interface EvidenceParseResult {
  parserVersion: string;
  parseStatus: 'parsed' | 'malformed' | 'unsupported_template' | 'source_conflict';
  quality: string[];
  extraction: Record<string, unknown>;
}
/** Service-neutral wallet ingestion; private source adapters authenticate before this parser. */
export interface WalletEvidenceConnector {
  readonly sourceKind: 'wallet';
  parse(content: Buffer): EvidenceParseResult;
}
/** Service-neutral receipt ingestion, including authenticated delegated extraction adapters. */
export interface RetailEvidenceConnector {
  readonly sourceKind: 'retail';
  parse(content: Buffer): EvidenceParseResult;
}
function parseLocal(content: Buffer, kind: 'wallet' | 'retail'): EvidenceParseResult {
  const parserVersion = `${kind}-v1`;
  let value: unknown;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch {
    return {
      parserVersion,
      parseStatus: 'malformed',
      quality: ['malformed_document'],
      extraction: {},
    };
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('templateVersion' in value) ||
    value.templateVersion !== parserVersion
  )
    return {
      parserVersion,
      parseStatus: 'unsupported_template',
      quality: ['unsupported_source_template'],
      extraction: {},
    };
  const parsed = extractionSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.observations.some(
      (observation) =>
        observation.reviewedLedgerEffect === true ||
        observation.kind === 'ledger_transaction' ||
        observation.ledgerTransactionId !== null ||
        observation.ledgerAccountId != null ||
        observation.ledgerEffect !== null,
    )
  )
    return {
      parserVersion,
      parseStatus: 'malformed',
      quality: ['invalid_normalized_evidence'],
      extraction: {},
    };
  return {
    parserVersion,
    parseStatus: 'parsed',
    quality: ['user_import', 'normalized_not_verified'],
    extraction: parsed.data,
  };
}
/** Parse a versioned local wallet statement without network or model dependencies. */
export class LocalWalletEvidenceConnector implements WalletEvidenceConnector {
  readonly sourceKind = 'wallet';
  parse(content: Buffer): EvidenceParseResult {
    return parseLocal(content, this.sourceKind);
  }
}
/** Parse a versioned local receipt extraction; unsupported images remain explicit. */
export class LocalRetailEvidenceConnector implements RetailEvidenceConnector {
  readonly sourceKind = 'retail';
  parse(content: Buffer): EvidenceParseResult {
    return parseLocal(content, this.sourceKind);
  }
}
/** Authenticate a forwarding gateway's exact body; sender authentication belongs to that trusted gateway. */
export class PrivateInboundEvidenceAdapter {
  constructor(
    private readonly options: {
      allowedSenders: readonly string[];
      secret: Buffer;
      clock?: () => Date;
    },
  ) {
    if (options.secret.length < 32 || options.allowedSenders.length === 0)
      throw new Error('Private inbound authentication requires configured sender and secret');
  }
  /** Validate sender, fresh gateway timestamp and HMAC before accepting forwarded content. */
  authenticate(input: {
    sender: string;
    receivedAt: string;
    signature: string;
    content: string;
  }): boolean {
    if (
      !this.options.allowedSenders.some(
        (sender) => sender.toLowerCase() === input.sender.toLowerCase(),
      ) ||
      !/^[a-f0-9]{64}$/.test(input.signature)
    )
      return false;
    const receivedAt = Date.parse(input.receivedAt);
    const now = (this.options.clock?.() ?? new Date()).getTime();
    if (!Number.isFinite(receivedAt) || receivedAt > now || now - receivedAt > 300000) return false;
    const expected = createHmac('sha256', this.options.secret)
      .update(`${input.sender.toLowerCase()}\n${input.receivedAt}\n${input.content}`)
      .digest();
    return timingSafeEqual(expected, Buffer.from(input.signature, 'hex'));
  }
}
/** Native consumes normalization only; all financial conservation remains in Rust. */
export interface TransactionEvidenceNative {
  resolveTransactionEvidence(input: string): string;
  simulateTransactionEvidenceRule?(input: string): string;
  compareSpendSessionReceipt?(input: string): string;
  learnTransactionEvidenceItemRules?(input: string): string;
  deriveEvidenceSettlementPlan?(input: string): string;
  deriveEvidenceAllocationPlan?(input: string): string;
  deriveWalletStatementPreview?(input: string): string;
}
/** Trusted composition selects scope and encryption key outside browser input. */
export interface TransactionEvidenceServiceOptions {
  store: WorkflowStore;
  native: TransactionEvidenceNative;
  rawEncryptionKey: Buffer;
  connectionManager?: ConnectionManager;
  scopeFor?: (actor: MerchantActor) => EvidenceScope | Promise<EvidenceScope>;
  clock?: () => Date;
}
/** Import acknowledgement contains no extraction or prior private source references. */
export interface EvidenceImportReceipt {
  document: Pick<
    EvidenceDocument,
    | 'id'
    | 'connectorId'
    | 'sourceId'
    | 'sourceTimestamp'
    | 'receivedAt'
    | 'mediaType'
    | 'parserVersion'
    | 'retentionUntil'
    | 'parseStatus'
    | 'contentHash'
    | 'quality'
  >;
  duplicate: boolean;
}
/** Connector status is derived only from the caller's authorized evidence. */
export interface EvidenceConnectorHealth {
  connectorId: string;
  latestReceivedAt: string;
  latestParsedAt: string | null;
  documentCount: number;
  unsupportedCount: number;
  malformedCount: number;
  duplicateCount: number;
  statementCoverage: null | {
    authorityKind: 'human_attested_statement';
    state: 'evaluated' | 'unavailable';
    wallets: Array<{
      walletId: string;
      balanceState: string;
      reasonCodes: string[];
      coverage: NonNullable<TransactionEvidenceResult['wallets'][number]['coverage']>;
    }>;
    reasonCodes: string[];
  };
}
/** Canonical attention projection; no connector-specific queue is persisted. */
export interface EvidenceAttentionItem {
  id: string;
  classification: 'evidence_connector_degradation' | 'unresolved_material_evidence';
  severity: 'high' | 'medium';
  description: string;
  evidenceIds: string[];
  reasonCodes: string[];
}
/** Evidence orchestration cannot write Actual; proposals use the existing consequential-action service. */
export class TransactionEvidenceService {
  private readonly itemRules: EvidenceItemRules;
  private readonly sessionReceipts: SpendSessionReceiptService;
  private readonly walletStatements: WalletStatementService;
  private readonly receiptVersions: ReceiptVersionService;
  private readonly receiptVersionFences = new WeakMap<TransactionEvidenceRequest, string>();
  constructor(private readonly options: TransactionEvidenceServiceOptions) {
    if (options.rawEncryptionKey.length !== 32 || (!options.scopeFor && !options.connectionManager))
      throw new Error('Evidence key and selected scope are required');
    this.itemRules = new EvidenceItemRules({
      store: options.store,
      connectionManager: options.connectionManager,
      native: options.native,
      now: () => this.now(),
      scope: (actor) => this.scope(actor),
      access: (actor, scope, peers, additional) => this.access(actor, scope, peers, additional),
      capture: async (actor, connectorId) => {
        const scope = await this.scope(actor);
        this.requireBudget(actor, scope, 'normalized-evidence');
        const access = this.access(actor, scope);
        const documents = this.current(
          this.readableDocuments(actor, scope).filter(
            (document) => document.connectorId === connectorId && document.parseStatus === 'parsed',
          ),
          access,
        );
        if (!documents.length) throw new Error('No current authorized receipt evidence');
        const request = this.request(documents, actor.governancePolicyVersion!, 5, actor, scope);
        const decision = this.options.store.evidence.latestDecision(
          access,
          documents.map((document) => document.id),
        );
        this.applyDecision(
          request,
          decision ?? {
            resolutionHash: '0'.repeat(64),
            documentIds: documents.map((document) => document.id),
            relationships: [],
          },
          actor,
          scope,
        );
        const storedOutcomes = this.options.store.evidence.itemCategoryOutcomes(access, {
          documentIds: documents.map((document) => document.id),
          policyVersion: actor.governancePolicyVersion!,
          membershipId: actor.membershipId!,
        });
        const outcomes = applyReviewedItemCategories(
          request,
          storedOutcomes,
          actor,
          (kind, id, capability) =>
            this.options.store.liquidity.isAuthorized({
              ...actor,
              now: this.now(),
              resourceKind: kind,
              resourceId: id,
              capability,
            }),
        );
        const outcomeFingerprint = canonicalProposalJson(storedOutcomes);
        const fingerprint = canonicalProposalJson(
          documents.map((document) => [document.id, document.contentHash]),
        );
        return {
          scope,
          documents,
          request,
          outcomes,
          authorize: () =>
            this.currentSources(actor, scope, documents, request) &&
            canonicalProposalJson(
              this.current(
                this.readableDocuments(actor, scope).filter(
                  (document) =>
                    document.connectorId === connectorId && document.parseStatus === 'parsed',
                ),
                this.access(actor, scope),
              ).map((document) => [document.id, document.contentHash]),
            ) === fingerprint &&
            canonicalProposalJson(
              this.options.store.evidence.itemCategoryOutcomes(this.access(actor, scope), {
                documentIds: documents.map((document) => document.id),
                policyVersion: actor.governancePolicyVersion!,
                membershipId: actor.membershipId!,
              }),
            ) === outcomeFingerprint &&
            this.access(actor, scope, documents, outcomes).authorize({
              capability: 'normalized-evidence',
              document: documents[0]!,
              scope,
            }),
        };
      },
    });
    this.sessionReceipts = new SpendSessionReceiptService({
      store: options.store,
      native: options.native,
      now: () => this.now(),
      access: (actor, scope, peers, additional, phase) =>
        this.access(actor, scope, peers, additional, phase),
      capture: async (actor) => {
        const scope = await this.scope(actor);
        this.requireBudget(actor, scope, 'normalized-evidence');
        const access = this.access(actor, scope);
        const documents = this.current(this.readableDocuments(actor, scope), access).filter(
          (document) => document.parseStatus === 'parsed',
        );
        if (!documents.length) throw new Error('No current authorized session evidence');
        const { request } = await this.reviewRequest(
          actor,
          scope,
          documents,
          actor.governancePolicyVersion!,
          5,
        );
        if (canonicalProposalJson(await this.scope(actor)) !== canonicalProposalJson(scope))
          throw new Error('Selected evidence connection changed');
        const decision = this.options.store.evidence.latestDecision(
          access,
          documents.map((document) => document.id),
        );
        this.applyDecision(
          request,
          decision && this.decisionCurrent(request, decision)
            ? decision
            : {
                resolutionHash: '0'.repeat(64),
                documentIds: documents.map((document) => document.id),
                relationships: [],
              },
          actor,
          scope,
        );
        const fingerprint = canonicalProposalJson(
          documents.map((document) => [document.id, document.contentHash]),
        );
        return {
          scope,
          documents,
          request,
          authorize: (additional?: unknown) =>
            this.currentSources(actor, scope, documents, request) &&
            canonicalProposalJson(
              this.current(this.readableDocuments(actor, scope), this.access(actor, scope))
                .filter((document) => document.parseStatus === 'parsed')
                .map((document) => [document.id, document.contentHash]),
            ) === fingerprint &&
            this.access(actor, scope, documents, additional).authorize({
              capability: 'normalized-evidence',
              document: documents[0]!,
              scope,
            }),
        };
      },
    });
    this.receiptVersions = new ReceiptVersionService({
      store: options.store,
      native: options.native,
      now: () => this.now(),
      fresh: (actor) => this.freshControl(actor),
      access: (actor, scope, documents, additional, phase) =>
        this.access(actor, scope, documents, additional, phase),
      capture: async (actor) => {
        const scope = await this.scope(actor),
          access = this.access(actor, scope);
        this.requireBudget(actor, scope, 'normalized-evidence');
        if (!access.authorize({ capability: 'resolve', document: null, scope }))
          throw new Error('Receipt version review is not authorized');
        const readableDocuments = this.readableDocuments(actor, scope),
          currentDocuments = this.current(readableDocuments, access);
        const { request } = await this.reviewRequest(
          actor,
          scope,
          currentDocuments,
          actor.governancePolicyVersion!,
          5,
        );
        const fingerprint = canonicalProposalJson(
          currentDocuments.map((d) => [d.id, d.contentHash, d.parserVersion]),
        );
        return {
          scope,
          currentDocuments,
          readableDocuments,
          request,
          authorize: (additional?: unknown) =>
            this.currentSources(actor, scope, currentDocuments, request) &&
            canonicalProposalJson(
              this.current(this.readableDocuments(actor, scope), this.access(actor, scope)).map(
                (d) => [d.id, d.contentHash, d.parserVersion],
              ),
            ) === fingerprint &&
            this.access(actor, scope, currentDocuments, additional).authorize({
              capability: 'resolve',
              document: null,
              scope,
            }) &&
            (!currentDocuments.length ||
              this.access(actor, scope, currentDocuments, additional).authorize({
                capability: 'normalized-evidence',
                document: currentDocuments[0]!,
                scope,
              })),
        };
      },
      normalize: (actor, capture, plan) => {
        const request = this.request(
          plan.documents,
          actor.governancePolicyVersion!,
          capture.request.maxSettlementDays,
          actor,
          capture.scope,
          true,
        );
        request.observations.push(
          ...capture.request.observations.filter((o) => o.kind === 'ledger_transaction'),
        );
        return request;
      },
    });
    this.walletStatements = new WalletStatementService({
      store: options.store,
      key: options.rawEncryptionKey,
      native: options.native,
      now: () => this.now(),
      fresh: (actor) => this.freshControl(actor),
      readOriginal: (actor, id) => this.raw(actor, id),
      access: (actor, scope, documents, additional, phase) =>
        this.access(actor, scope, documents, additional, phase),
      capture: async (actor) => {
        const scope = await this.scope(actor),
          access = this.access(actor, scope);
        this.requireBudget(actor, scope, 'normalized-evidence');
        if (!access.authorize({ capability: 'resolve', document: null, scope }))
          throw new Error('Wallet statement review is not authorized');
        const documents = this.current(this.readableDocuments(actor, scope), access);
        const { request } = await this.reviewRequest(
          actor,
          scope,
          documents,
          actor.governancePolicyVersion!,
          5,
        );
        const decision = this.options.store.evidence.latestDecision(
          access,
          documents.map((document) => document.id),
        );
        if (decision && this.decisionCurrent(request, decision))
          this.applyDecision(request, decision, actor, scope);
        const fingerprint = canonicalProposalJson(
          documents.map((document) => [document.id, document.contentHash]),
        );
        return {
          scope,
          documents,
          request,
          authorize: (additional?: unknown) =>
            this.currentSources(actor, scope, documents, request) &&
            canonicalProposalJson(
              this.current(this.readableDocuments(actor, scope), this.access(actor, scope)).map(
                (document) => [document.id, document.contentHash],
              ),
            ) === fingerprint &&
            this.access(actor, scope, documents, additional).authorize({
              capability: 'resolve',
              document: null,
              scope,
            }) &&
            (!documents.length ||
              this.access(actor, scope, documents, additional).authorize({
                capability: 'normalized-evidence',
                document: documents[0]!,
                scope,
              })),
        };
      },
    });
  }
  /** Read current authorized receipt replacement choices and immutable history diagnostics. */
  receiptVersionContext(actor: MerchantActor) {
    return this.receiptVersions.context(actor);
  }
  /** Preview an exact human-reviewed replacement through native receipt conservation. */
  previewReceiptVersion(actor: MerchantActor, input: unknown) {
    return this.receiptVersions.preview(actor, input);
  }
  /** Append a fresh source-bound receipt version review without changing Actual. */
  saveReceiptVersion(actor: MerchantActor, input: unknown) {
    return this.receiptVersions.save(actor, input);
  }
  /** Remove receipt version authority even when predecessor access has expired. */
  revokeReceiptVersion(actor: MerchantActor, input: unknown) {
    return this.receiptVersions.revoke(actor, input);
  }
  private receiptVersionPlan(
    actor: MerchantActor,
    scope: EvidenceScope,
    documents: EvidenceDocument[],
  ) {
    const state = this.options.store.evidence.receiptVersions.state(this.access(actor, scope), {
      membershipId: actor.membershipId!,
      policyVersion: actor.governancePolicyVersion!,
    });
    const plan = receiptVersionDocuments(
      documents,
      this.readableDocuments(actor, scope),
      state.links,
      state.blockedChildren,
      actor,
    );
    return {
      plan,
      fence: canonicalProposalJson({
        foldHash: state.foldHash,
        requiredSources: plan.requiredSources,
        appliedLinks: plan.appliedLinks,
        blockedChildren: plan.blockedChildren,
        sources: plan.documents.map((document) => [
          document.id,
          document.contentHash,
          document.parserVersion,
        ]),
      }),
    };
  }
  /** Preview exact human-attested local statement claims with bounded native coverage diagnostics. */
  previewWalletStatement(actor: MerchantActor, input: unknown) {
    return this.walletStatements.preview(actor, input);
  }
  /** Admit a freshly reviewed local statement without asserting provider authentication. */
  attestWalletStatement(actor: MerchantActor, input: unknown) {
    return this.walletStatements.attest(actor, input);
  }
  /** Revoke local statement authority independently of raw-byte retention. */
  revokeWalletStatement(actor: MerchantActor, input: unknown) {
    return this.walletStatements.revoke(actor, input);
  }
  /** Read current caller-scoped human attestations. */
  prepareWalletMaterialization(actor: MerchantActor, input: unknown) {
    return this.walletStatements.prepareMaterialization(actor, input);
  }
  walletStatementContext(actor: MerchantActor) {
    return this.walletStatements.context(actor);
  }
  walletStatementProofs(actor: MerchantActor) {
    return this.walletStatements.state(actor);
  }
  private canReadOtherMembers(actor: MerchantActor, scope: EvidenceScope): boolean {
    if (!actor.auth || !actor.membershipId || !actor.governancePolicyVersion) return false;
    const result = this.options.store.governance.authorize({
      actorId: actor.actorId,
      spaceId: scope.spaceId,
      membershipId: actor.membershipId,
      expectedPolicyVersion: actor.governancePolicyVersion,
      phase: 'read',
      operation: 'identity:manage',
      required: [
        {
          resourceKind: 'space',
          resourceId: scope.spaceId,
          capability: 'identity:manage',
          visibility: 'resource',
        },
      ],
      payload: { operations: [{ operation: 'identity:manage' }] },
      now: this.now(),
      auth: actor.auth,
    });
    return result.allowed && result.disposition.kind === 'authorized_without_approval';
  }
  private memberPeriods(actor: MerchantActor, scope: EvidenceScope): SpaceMembership[] {
    return this.options.store.governance.listMembershipHistory({
      spaceId: scope.spaceId,
      ...(this.canReadOtherMembers(actor, scope) ? {} : { actorId: actor.actorId }),
    });
  }
  /** Read source-scoped receipt relationships and permitted membership choices without inferring ownership. */
  async receiptReviewContext(actor: MerchantActor) {
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    if (
      !access.authorize({ capability: 'resolve', document: null, scope }) ||
      !access.authorize({ capability: 'normalized-evidence', document: null, scope })
    )
      throw new Error('Receipt review is not authorized');
    const documents = this.current(this.readableDocuments(actor, scope), access);
    if (!documents.length) throw new Error('Current receipt evidence required');
    const { request } = await this.reviewRequest(
      actor,
      scope,
      documents,
      actor.governancePolicyVersion!,
      5,
    );
    const decision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    if (decision && this.decisionCurrent(request, decision))
      this.applyDecision(request, decision, actor, scope);
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    const periods = this.memberPeriods(actor, scope);
    const seeOthers = this.canReadOtherMembers(actor, scope);
    const visible = (member: string) => member === actor.actorId || seeOthers;
    const members = periods
      .filter(
        (period) =>
          this.options.store.governance.getCurrentMembership({
            actorId: period.actorId,
            spaceId: scope.spaceId,
            now: this.now(),
          })?.id === period.id,
      )
      .map((period) => ({
        actorId: period.actorId,
        membershipId: period.id,
        label: period.actorId === actor.actorId ? 'Me' : period.actorId,
      }));
    const annotations = applyReceiptAnnotations(
      structuredClone(request),
      this.options.store.evidence.receiptAnnotations(access, {
        documentIds: documents.map((document) => document.id),
        policyVersion: actor.governancePolicyVersion!,
        membershipId: actor.membershipId!,
      }),
      actor,
      periods,
      visible,
    );
    if (!this.currentSources(actor, scope, documents, request))
      throw new Error('Receipt review source or authorization changed');
    return {
      resolutionHash: result.resolutionHash,
      receipts: request.receipts.flatMap((receipt) => {
        const observation = request.observations.find(
          (source) => source.id === receipt.observationId && source.status === 'completed',
        );
        return observation && !request.receipts.some((newer) => newer.supersedesId === receipt.id)
          ? [
              {
                documentId: observation.provenance.documentId,
                receipt,
                kind: observation.eventType,
                valid: result.receipts.some(
                  (entry) => entry.receiptId === receipt.id && entry.valid,
                ),
              },
            ]
          : [];
      }),
      orders: request.observations
        .filter((source) => source.kind === 'order' && source.status !== 'superseded')
        .map((source) => ({
          documentId: source.provenance.documentId,
          observationId: source.id,
          date: source.date,
          amount: source.amount,
          counterparty: source.counterparty,
        })),
      members,
      annotations,
    };
  }
  /** Save fresh human member, return and fulfillment choices as ordinary immutable evidence decisions. */
  async saveReceiptReview(
    actor: MerchantActor,
    value: unknown,
  ): Promise<TransactionEvidenceResult> {
    const input = receiptReviewSaveSchema.parse(value);
    this.freshControl(actor);
    const current = await this.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    if (current.resolutionHash !== input.resolutionHash) throw new Error('Receipt review changed');
    return this.saveResolutionDecision(actor, {
      resolutionHash: input.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: current.relationships,
      receiptAnnotationDecisions: input.decisions,
    });
  }
  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }
  private async scope(actor: MerchantActor): Promise<EvidenceScope> {
    const provisional = {
      spaceId: actor.spaceId,
      budgetId: actor.budgetId,
      connectionId: 'authorization',
    };
    if (
      !this.access(actor, provisional).authorize({
        capability: 'observe',
        document: null,
        scope: provisional,
      })
    )
      throw new Error('Evidence operation is not authorized');
    const config = this.options.scopeFor
      ? null
      : await this.options.connectionManager!.loadConfig();
    if (!this.options.scopeFor && (!config || config.budgetId !== actor.budgetId))
      throw new Error('Selected evidence budget unavailable');
    const scope = this.options.scopeFor
      ? await this.options.scopeFor(actor)
      : {
          spaceId: actor.spaceId,
          budgetId: config!.budgetId,
          connectionId: merchantConnectionId(config!),
        };
    if (
      scope.spaceId !== actor.spaceId ||
      scope.budgetId !== actor.budgetId ||
      this.options.store.governance.getSpaceForBudget({ budgetId: actor.budgetId })?.id !==
        actor.spaceId
    )
      throw new Error('Evidence operation is not authorized');
    return scope;
  }
  private access(
    actor: MerchantActor,
    scope: EvidenceScope,
    peers?: EvidenceDocument[],
    additional?: unknown,
    controlPhase?: 'approve',
  ): EvidenceAccess {
    return {
      actorId: actor.actorId,
      scope,
      now: this.now(),
      authorize: ({ capability, document }) => {
        if (
          !actor.auth ||
          !actor.membershipId ||
          !actor.governancePolicyVersion ||
          actor.auth.actorId !== actor.actorId
        )
          return false;
        const required: Array<{
          resourceKind: GovernanceResourceKind;
          resourceId: string;
          capability: string;
          visibility: 'resource';
        }> = [
          {
            resourceKind: 'budget',
            resourceId: actor.budgetId,
            capability: 'observe',
            visibility: 'resource',
          },
        ];
        required.push({
          resourceKind: document ? 'evidence' : 'budget',
          resourceId: document?.id ?? actor.budgetId,
          capability,
          visibility: 'resource',
        });
        if (document)
          required.push({
            resourceKind: 'evidence',
            resourceId: document.id,
            capability: 'evidence',
            visibility: 'resource',
          });
        const operations: GovernanceOperation[] = [
          { operation: capability, ...(document ? { evidenceId: document.id } : {}) },
        ];
        if (document) {
          const inspect = (value: unknown): void => {
            if (Array.isArray(value)) {
              for (const item of value) inspect(item);
              return;
            }
            if (!value || typeof value !== 'object') return;
            const object = value as Record<string, unknown>;
            if (
              object.kind === 'local_item_suggestion_only' &&
              Array.isArray(object.actualRuleIds)
            ) {
              required.push(
                {
                  resourceKind: 'budget',
                  resourceId: actor.budgetId,
                  capability: 'source',
                  visibility: 'resource',
                },
                {
                  resourceKind: 'budget',
                  resourceId: actor.budgetId,
                  capability: 'rule:view',
                  visibility: 'resource',
                },
              );
              for (const ruleId of object.actualRuleIds)
                if (typeof ruleId === 'string') {
                  required.push({
                    resourceKind: 'rule',
                    resourceId: ruleId,
                    capability: 'rule:view',
                    visibility: 'resource',
                  });
                  operations.push({
                    operation: 'rule:view',
                    ruleId,
                    accountScope: { kind: 'global' },
                  });
                }
            }
            if (
              object.rule !== null &&
              typeof object.rule === 'object' &&
              typeof object.accountId === 'string'
            )
              operations.push({ operation: capability, accountId: object.accountId });
            if (
              typeof object.minorUnits === 'string' &&
              /^[+-]?\d+$/.test(object.minorUnits) &&
              typeof object.currency === 'string'
            ) {
              const units = BigInt(object.minorUnits);
              operations.push({
                operation: capability,
                direction: 'outgoing',
                amount: {
                  minorUnits: (units < 0n ? -units : units).toString(),
                  currency: object.currency,
                },
              });
            }
            for (const [field, kind, right] of [
              ['accountId', 'account', 'transaction'],
              ['categoryId', 'category', 'category'],
              ['ledgerTransactionId', 'transaction', 'transaction'],
            ] as const)
              if (typeof object[field] === 'string')
                required.push({
                  resourceKind: kind,
                  resourceId: object[field],
                  capability: right,
                  visibility: 'resource',
                });
            for (const entry of Object.values(object)) inspect(entry);
          };
          for (const peer of peers ?? [document]) {
            required.push(
              { resourceKind: 'evidence', resourceId: peer.id, capability, visibility: 'resource' },
              {
                resourceKind: 'evidence',
                resourceId: peer.id,
                capability: 'evidence',
                visibility: 'resource',
              },
            );
            inspect(peer.extraction);
          }
          if (additional !== undefined) inspect(additional);
        }
        const unique = [...new Map(required.map((item) => [JSON.stringify(item), item])).values()];
        const auth = actor.auth;
        const result = this.options.store.governance.authorize({
          actorId: actor.actorId,
          spaceId: actor.spaceId,
          membershipId: actor.membershipId,
          expectedPolicyVersion: actor.governancePolicyVersion,
          phase: controlPhase ?? (capability === 'item-rule:approve' ? 'approve' : 'read'),
          operation: capability,
          required: unique,
          payload: { operations },
          now: this.now(),
          auth,
          ...(auth.method === 'api-key' && auth.principalType === 'agent'
            ? {
                agentId: auth.actorId,
                delegationId: auth.delegationId,
                delegationVersion: auth.delegationVersion,
              }
            : {}),
        });
        return result.allowed && result.disposition.kind === 'authorized_without_approval';
      },
    };
  }
  private freshControl(actor: MerchantActor): void {
    const auth = actor.auth;
    const now = Date.parse(this.now());
    if (
      auth.method !== 'human-session' ||
      auth.actorId !== actor.actorId ||
      !auth.sessionId.trim() ||
      !Number.isFinite(Date.parse(auth.reauthenticatedAt)) ||
      Date.parse(auth.reauthenticatedAt) > now ||
      now - Date.parse(auth.reauthenticatedAt) > 300000
    )
      throw new Error('Fresh human evidence decision required');
  }
  private readableDocuments(actor: MerchantActor, scope: EvidenceScope): EvidenceDocument[] {
    const documents = this.options.store.evidence.list(this.access(actor, scope));
    if (
      documents.length &&
      !this.access(actor, scope, documents).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      return [];
    return documents;
  }
  private requireBudget(
    actor: MerchantActor,
    scope: EvidenceScope,
    capability: 'ingest' | 'normalized-evidence',
  ): void {
    if (!this.access(actor, scope).authorize({ capability, document: null, scope }))
      throw new Error('Evidence operation is not authorized');
  }
  /** Import user evidence; parsing never confers sender identity or ledger approval. */
  async ingest(
    actor: MerchantActor,
    value: unknown,
    connector?: WalletEvidenceConnector | RetailEvidenceConnector,
  ): Promise<EvidenceImportReceipt> {
    const input = transactionEvidenceImportSchema.parse(value);
    const scope = await this.scope(actor);
    this.requireBudget(actor, scope, 'ingest');
    const parser =
      connector ??
      (input.sourceKind === 'wallet'
        ? new LocalWalletEvidenceConnector()
        : new LocalRetailEvidenceConnector());
    if (parser.sourceKind !== input.sourceKind) throw new Error('Evidence connector kind mismatch');
    if (
      input.contentEncoding === 'base64' &&
      (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content) ||
        Buffer.from(input.content, 'base64').toString('base64') !== input.content)
    )
      throw new Error('Invalid canonical evidence base64');
    const content = Buffer.from(
      input.content,
      input.contentEncoding === 'base64' ? 'base64' : 'utf8',
    );
    if (content.length === 0 || content.length > 10 * 1024 * 1024)
      throw new Error('Evidence content size exceeded');
    const parsed = input.userExtraction
      ? parseManualReceiptPhoto(
          input.userExtraction,
          createHash('sha256')
            .update(
              canonicalProposalJson([
                scope.spaceId,
                scope.budgetId,
                scope.connectionId,
                input.connectorId,
                input.sourceId,
                input.visibility === 'private' ? actor.actorId : null,
                createHash('sha256').update(content).digest('hex'),
              ]),
            )
            .digest('hex'),
        )
      : input.mediaType === 'application/pdf' || input.mediaType.startsWith('image/')
        ? {
            parserVersion: `${input.sourceKind}-v1`,
            parseStatus: 'unsupported_template' as const,
            quality: ['document_extraction_unavailable'],
            extraction: {},
          }
        : parser.parse(content);
    const saved = this.options.store.evidence.ingest(
      this.access(actor, scope),
      {
        connectorId: input.connectorId,
        sourceId: input.sourceId,
        sourceTimestamp: input.sourceTimestamp,
        mediaType: input.mediaType,
        ...parsed,
        content,
        privateActorId: input.visibility === 'private' ? actor.actorId : null,
        retentionUntil: new Date(
          Date.parse(this.now()) + input.retentionDays * 86400000,
        ).toISOString(),
      },
      this.options.rawEncryptionKey,
    );
    const {
      extraction: _extraction,
      privateActorId: _privateActorId,
      supersedesId: _supersedesId,
      scope: _scope,
      ...document
    } = saved.document;
    return { document, duplicate: saved.duplicate };
  }
  /** Simulate and persist an exact receipt-item rule proposal without writing Actual. */
  proposeItemRule(actor: MerchantActor, input: unknown) {
    return this.itemRules.propose(actor, input);
  }
  /** Inspect current explicit human line outcomes without treating imported labels as training. */
  itemCategoryOutcomes(actor: MerchantActor, input: unknown) {
    return this.itemRules.outcomes(actor, input);
  }
  /** Inspect repeated exact criteria; no candidate becomes an active rule automatically. */
  itemRuleCandidates(actor: MerchantActor, input: unknown) {
    return this.itemRules.candidates(actor, input);
  }
  /** Recheck one candidate hash before using the ordinary proposal and approval workflow. */
  proposeItemRuleCandidate(actor: MerchantActor, input: unknown) {
    return this.itemRules.proposeCandidate(actor, input);
  }
  /** List inspectable scoped item-rule proposals and their exact approval history. */
  listItemRules(actor: MerchantActor) {
    return this.itemRules.list(actor);
  }
  /** Approve one exact current local item-rule payload with fresh human authority. */
  approveItemRule(actor: MerchantActor, input: unknown) {
    return this.itemRules.decide(actor, input, 'approved');
  }
  /** Revoke one exact local item rule without changing Actual rules or historical evidence. */
  revokeItemRule(actor: MerchantActor, input: unknown) {
    return this.itemRules.decide(actor, input, 'revoked');
  }
  /** Return only freshly conserved and simulated approved exact-item suggestions. */
  itemRuleSuggestions(actor: MerchantActor, input: unknown) {
    return this.itemRules.suggestions(actor, input);
  }
  /** Read permitted receipt choices and provenance for an exact server-origin saved-session archive. */
  spendSessionReceiptContext(actor: MerchantActor, input: unknown) {
    return this.sessionReceipts.context(actor, input);
  }
  /** Compare reviewed receipt mappings with exact planned metadata; no financial action is produced. */
  compareSpendSessionReceipt(actor: MerchantActor, input: unknown) {
    return this.sessionReceipts.compare(actor, input);
  }
  /** Save a freshly reviewed comparison without completing sessions or consuming financial claims. */
  saveSpendSessionReceipt(actor: MerchantActor, input: unknown) {
    return this.sessionReceipts.save(actor, input);
  }
  /** Backfill exact authorized Spend Session item evidence without treating planned prices as settled payments. */
  async ingestSpendSession(actor: MerchantActor, value: unknown): Promise<EvidenceImportReceipt> {
    const input = z
      .object({
        sessionId: id,
        expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(value);
    const scope = await this.scope(actor);
    this.requireBudget(actor, scope, 'ingest');
    const session = this.options.store.liquidity.getSpendSession({
      ...actor,
      id: input.sessionId,
      now: this.now(),
    });
    if (!session || session.version !== input.expectedVersion)
      throw new Error('Spend Session version changed');
    const observations = session.items.map((item) => ({
      id: `session:${session.id}:${item.id}`,
      kind: 'spend_session_item',
      sourceId: `session:${session.id}`,
      externalEventId: null,
      date: item.purchaseAt.slice(0, 10),
      amount: item.amount,
      direction: 'outflow',
      status: 'pending',
      eventType: 'purchase',
      counterparty: null,
      fundingInstrumentId: null,
      walletId: null,
      ledgerTransactionId: null,
      ledgerEffect: null,
      reliability: 0,
    }));
    const intent = SavedSessionReceiptIntentSchema.parse({
      kind: 'session_completion_intent_v1',
      id: session.id,
      version: session.version,
      accountId: session.accountId,
      items: session.items,
      adjustments: session.adjustments ?? [],
      warningThresholds: session.warningThresholds ?? [],
    });
    const saved = this.options.store.evidence.archiveSpendSession(
      this.access(actor, scope),
      {
        connectorId: 'spend-session',
        sourceId: `session:${session.id}`,
        sourceTimestamp: session.updatedAt,
        mediaType: 'application/json',
        parserVersion: 'spend-session-snapshot-v1',
        privateActorId: actor.actorId,
        retentionUntil: new Date(Date.parse(this.now()) + 7 * 86400000).toISOString(),
        parseStatus: 'parsed',
        quality: ['pending_saved_session_reference_prices'],
        extraction: extractionSchema.parse({ templateVersion: 'retail-v1', observations }),
        content: Buffer.from(canonicalProposalJson(intent)),
      },
      intent,
      this.options.rawEncryptionKey,
    );
    const {
      extraction: _extraction,
      privateActorId: _privateActorId,
      supersedesId: _supersedesId,
      scope: _scope,
      ...document
    } = saved.document;
    return { document, duplicate: saved.duplicate };
  }
  /** Return scoped account/category names for exact consequence editing without exposing balances. */
  async ledgerTargets(actor: MerchantActor): Promise<{
    accounts: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string }>;
  }> {
    const scope = await this.scope(actor);
    this.requireBudget(actor, scope, 'normalized-evidence');
    if (!this.options.connectionManager) throw new Error('Selected ledger targets unavailable');
    const result = await this.options.connectionManager.withConnection(
      async (connected) => {
        if (
          connected.config.budgetId !== actor.budgetId ||
          merchantConnectionId(connected.config) !== scope.connectionId
        )
          throw new Error('Selected ledger changed');
        const source = financialSnapshotSchema.parse(
          (connected.synchronization as { financialSnapshot?: unknown }).financialSnapshot,
        );
        return {
          accounts: source.legacySnapshot.accounts.map(({ id, name }) => ({ id, name })),
          categories: source.legacySnapshot.categories
            .filter((category) => !category.deleted)
            .map(({ id, name }) => ({ id, name })),
        };
      },
      { expectedBudgetId: actor.budgetId },
    );
    this.requireBudget(actor, scope, 'normalized-evidence');
    const can = (
      resourceKind: 'account' | 'category',
      resourceId: string,
      capability: string,
    ): boolean =>
      this.options.store.liquidity.isAuthorized({
        ...actor,
        now: this.now(),
        resourceKind,
        resourceId,
        capability,
      });
    return {
      accounts: result.accounts.filter(
        (account) => can('account', account.id, 'existence') && can('account', account.id, 'name'),
      ),
      categories: result.categories.filter(
        (category) =>
          can('category', category.id, 'category') && can('category', category.id, 'name'),
      ),
    };
  }
  /** Export only scoped authorized normalization and provenance; raw bytes require their independent grants. */
  async exportEvidence(
    actor: MerchantActor,
    value: unknown,
  ): Promise<{
    contractVersion: '1';
    exportedAt: string;
    documents: EvidenceDocument[];
    decision: EvidenceResolutionDecision | null;
    walletStatementProofs: ReturnType<WorkflowStore['evidence']['walletStatements']['state']>;
    audit: Array<{ documentId: string; entries: EvidenceAudit[] }>;
    raw: Array<{ documentId: string; contentBase64: string | null }> | null;
  }> {
    const input = z
      .object({ includeRaw: z.boolean().default(false) })
      .strict()
      .parse(value);
    const scope = await this.scope(actor);
    this.requireBudget(actor, scope, 'normalized-evidence');
    const access = this.access(actor, scope);
    const documents = this.readableDocuments(actor, scope);
    const current = this.current(documents, access);
    const decision = this.options.store.evidence.latestDecision(
      access,
      current.map((document) => document.id),
    );
    if (
      decision &&
      current.length &&
      !this.access(actor, scope, current, decision).authorize({
        capability: 'normalized-evidence',
        document: current[0]!,
        scope,
      })
    )
      throw new Error('Evidence decision is not authorized');
    const audit = documents.map((document) => ({
      documentId: document.id,
      entries: this.options.store.evidence.audit(access, document.id),
    }));
    const raw = input.includeRaw
      ? documents.map((document) => ({
          documentId: document.id,
          contentBase64:
            this.options.store.evidence
              .readRaw(access, document.id, this.options.rawEncryptionKey)
              ?.toString('base64') ?? null,
        }))
      : null;
    const walletStatementProofs = this.options.store.evidence.walletStatements.state(access, {
      membershipId: actor.membershipId!,
      policyVersion: actor.governancePolicyVersion!,
    });
    if (
      documents.length &&
      !this.access(actor, scope, documents, walletStatementProofs).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Wallet statement export is not authorized');
    return {
      contractVersion: '1',
      exportedAt: this.now(),
      documents,
      decision,
      walletStatementProofs,
      audit,
      raw,
    };
  }
  /** Return only currently readable scoped documents. */
  async list(actor: MerchantActor): Promise<EvidenceDocument[]> {
    const scope = await this.scope(actor);
    this.requireBudget(actor, scope, 'normalized-evidence');
    return this.readableDocuments(actor, scope);
  }
  /** Return normalized detail without implying raw-document access. */
  async detail(actor: MerchantActor, identity: string): Promise<EvidenceDocument | null> {
    return this.options.store.evidence.get(this.access(actor, await this.scope(actor)), identity);
  }
  /** Read retained source bytes under the distinct raw-document grant. */
  async raw(actor: MerchantActor, identity: string): Promise<Buffer | null> {
    return this.options.store.evidence.readRaw(
      this.access(actor, await this.scope(actor)),
      identity,
      this.options.rawEncryptionKey,
    );
  }
  /** Delete source bytes under an explicit deletion grant; immutable normalization remains. */
  async deleteRaw(actor: MerchantActor, identity: string): Promise<boolean> {
    this.freshControl(actor);
    const scope = await this.scope(actor);
    this.freshControl(actor);
    return this.options.store.evidence.deleteRaw(
      this.access(actor, scope, undefined, undefined, 'approve'),
      identity,
    );
  }
  private request(
    documents: EvidenceDocument[],
    policyVersion: string,
    maxSettlementDays: number,
    actor: MerchantActor,
    scope: EvidenceScope,
    alreadyExpanded = false,
  ): TransactionEvidenceRequest {
    const versionPlan = alreadyExpanded ? null : this.receiptVersionPlan(actor, scope, documents);
    if (versionPlan) documents = versionPlan.plan.documents;
    const observations: EvidenceObservation[] = [];
    const relationships: TransactionEvidenceRequest['relationships'] = [];
    const wallets: TransactionEvidenceRequest['wallets'] = [];
    const receipts: TransactionEvidenceRequest['receipts'] = [];
    for (const document of documents.filter((entry) => entry.parseStatus === 'parsed')) {
      const extraction = extractionSchema.parse(document.extraction);
      observations.push(
        ...extraction.observations.map((observation) => ({
          ...observation,
          sourceId: `user-import:${extraction.templateVersion}:${createHash('sha256').update(document.connectorId).digest('hex')}`,
          externalEventId:
            observation.externalEventId === null
              ? null
              : `user-import:${extraction.templateVersion}:${createHash('sha256')
                  .update(
                    canonicalProposalJson([document.connectorId, observation.externalEventId]),
                  )
                  .digest('hex')}`,
          walletId:
            observation.walletId === null
              ? null
              : qualifiedWalletId(scope, document, observation.walletId),
          reliability: 0,
          reviewedLedgerEffect: false,
          provenance: {
            documentId: document.id,
            contentHash: document.contentHash,
            parserVersion: document.parserVersion,
            sourceTimestamp: document.sourceTimestamp,
            receivedAt: document.receivedAt,
          },
        })),
      );
      relationships.push(
        ...extraction.relationships.map((relationship) => ({
          ...relationship,
          state: 'candidate' as const,
          score: 0,
        })),
      );
      wallets.push(
        ...extraction.wallets.map((wallet) => ({
          ...wallet,
          walletId: qualifiedWalletId(scope, document, wallet.walletId),
          openingBalance: null,
          closingBalance: null,
          completeActivity: false,
          materializedAccountId: null,
        })),
      );
      receipts.push(
        ...extraction.receipts.map((receipt) => ({
          ...receipt,
          lines: receipt.lines.map((line) => ({ ...line, memberId: null })),
        })),
      );
    }
    const request = TransactionEvidenceRequestSchema.parse({
      contractVersion: '1',
      policyVersion,
      maxSettlementDays,
      observations,
      relationships,
      wallets: [
        ...new Map(
          wallets.map((wallet) => {
            const peers = wallets.filter((peer) => peer.walletId === wallet.walletId);
            if (peers.some((peer) => canonicalProposalJson(peer) !== canonicalProposalJson(wallet)))
              throw new Error('Wallet descriptor conflict');
            return [wallet.walletId, wallet] as const;
          }),
        ).values(),
      ],
      receipts,
    });
    const annotations = this.options.store.evidence.receiptAnnotations(this.access(actor, scope), {
      documentIds: documents.map((document) => document.id),
      policyVersion: actor.governancePolicyVersion!,
      membershipId: actor.membershipId!,
    });
    const seeOthers = this.canReadOtherMembers(actor, scope);
    applyReceiptAnnotations(
      request,
      annotations,
      actor,
      this.memberPeriods(actor, scope),
      (member) => member === actor.actorId || seeOthers,
    );
    const statements = this.statementProofsFor(actor, scope, documents);
    if (statements.length) {
      request.statementProofs = statements;
      for (const proof of statements) {
        const wallet = request.wallets.find((wallet) => wallet.walletId === proof.walletId);
        if (wallet && wallet.currency !== proof.currency)
          throw new Error('Wallet currency conflict');
        if (!wallet)
          request.wallets.push({
            walletId: proof.walletId,
            currency: proof.currency,
            openingBalance: null,
            closingBalance: null,
            completeActivity: false,
            materializedAccountId: null,
            requiresStoredValue: true,
          });
      }
    }
    if (versionPlan) this.receiptVersionFences.set(request, versionPlan.fence);
    return request;
  }
  private statementProofsFor(
    actor: MerchantActor,
    scope: EvidenceScope,
    documents: EvidenceDocument[],
  ) {
    const ids = new Set(documents.map((document) => document.id));
    return this.options.store.evidence.walletStatements
      .state(this.access(actor, scope), {
        membershipId: actor.membershipId!,
        policyVersion: actor.governancePolicyVersion!,
      })
      .proofs.filter((proof) =>
        [proof.statement, ...proof.activityManifest].every((reference) =>
          ids.has(reference.documentId),
        ),
      );
  }
  private currentSources(
    actor: MerchantActor,
    scope: EvidenceScope,
    documents: EvidenceDocument[],
    request: TransactionEvidenceRequest,
  ): boolean {
    try {
      if (
        canonicalProposalJson(request.statementProofs ?? []) !==
        canonicalProposalJson(this.statementProofsFor(actor, scope, documents))
      )
        return false;
      if (
        request.receipts.some((receipt) =>
          receipt.lines.some((line) => line.memberId !== null && line.memberId !== actor.actorId),
        ) &&
        !this.canReadOtherMembers(actor, scope)
      )
        return false;
      const access = this.access(actor, scope);
      if (documents.some((document) => !this.options.store.evidence.isCurrent(access, document.id)))
        return false;
      const versionPlan = this.receiptVersionPlan(actor, scope, documents);
      const captured = this.receiptVersionFences.get(request);
      if (captured !== undefined && captured !== versionPlan.fence) return false;
      const sources = versionPlan.plan.documents;
      const sourceById = new Map(sources.map((document) => [document.id, document]));
      return request.observations
        .filter((observation) => observation.kind !== 'ledger_transaction')
        .every((observation) => {
          const document = sourceById.get(observation.provenance.documentId);
          return (
            !!document &&
            document.contentHash === observation.provenance.contentHash &&
            document.parserVersion === observation.provenance.parserVersion
          );
        });
    } catch {
      return false;
    }
  }
  private ledgerObservations(
    access: EvidenceAccess,
    snapshot: FinancialSnapshot,
  ): EvidenceObservation[] {
    return snapshot.legacySnapshot.transactions
      .filter((transaction) => BigInt(transaction.amount.minorUnits) !== 0n)
      .map((transaction) => {
        const units = BigInt(transaction.amount.minorUnits);
        const magnitude = units < 0n ? -units : units;
        if (magnitude > 9223372036854775807n) throw new Error('Unsupported ledger amount');
        return {
          id: `actual:${transaction.id}`,
          kind: 'ledger_transaction',
          sourceId: 'actual',
          externalEventId: transaction.importedId,
          date: transaction.date,
          amount: { minorUnits: magnitude.toString(), currency: transaction.amount.currency },
          direction: units < 0n ? 'outflow' : 'inflow',
          status: 'completed',
          eventType: 'unknown',
          counterparty: transaction.payeeId,
          fundingInstrumentId: null,
          walletId: null,
          ledgerTransactionId: transaction.id,
          ledgerAccountId: transaction.accountId,
          ledgerEffect: null,
          reliability: 100,
          provenance: this.options.store.evidence.ledgerProvenance(access, {
            transactionId: transaction.id,
            contentHash: ledgerEvidenceHash(transaction),
            parserVersion: snapshot.sourceNormalizationVersion,
            observedAt: snapshot.capturedAt,
          }),
        };
      });
  }
  private ledgerFinancialReadable(
    actor: MerchantActor,
    scope: EvidenceScope,
    documents: EvidenceDocument[],
    row: Transaction,
  ): boolean {
    const can = (
      resourceKind: 'budget' | 'transaction' | 'account',
      resourceId: string,
      capability: string,
    ) =>
      this.options.store.liquidity.isAuthorized({
        ...actor,
        now: this.now(),
        resourceKind,
        resourceId,
        capability,
      });
    // Native observations contain these parent facts only; child categorization/notes stay
    // behind the separate complete-source check used for amendment targets and disclosure.
    const financial = {
      ledgerTransactionId: row.id,
      accountId: row.accountId,
      date: row.date,
      amount: row.amount,
      transferAccountId: row.transferAccountId,
      payeeId: row.payeeId,
      importedId: row.importedId,
    };
    return (
      can('budget', actor.budgetId, 'source') &&
      ['transaction.view', 'source', 'history'].every((right) =>
        can('transaction', row.id, right),
      ) &&
      ['source', 'history', 'name', 'existence'].every((right) =>
        can('account', row.accountId, right),
      ) &&
      !!documents[0] &&
      this.access(actor, scope, documents, financial).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    );
  }
  private ledgerReadable(
    actor: MerchantActor,
    scope: EvidenceScope,
    documents: EvidenceDocument[],
    transaction: Transaction,
  ): boolean {
    const can = (
      resourceKind: 'budget' | 'transaction' | 'account' | 'category',
      resourceId: string,
      capability: string,
    ) =>
      this.options.store.liquidity.isAuthorized({
        ...actor,
        now: this.now(),
        resourceKind,
        resourceId,
        capability,
      });
    const visit = (row: Transaction): boolean =>
      ['transaction.view', 'source', 'history'].every((right) =>
        can('transaction', row.id, right),
      ) &&
      ['source', 'history', 'name', 'existence'].every((right) =>
        can('account', row.accountId, right),
      ) &&
      (!row.categoryId ||
        ['category', 'name', 'source'].every((right) => can('category', row.categoryId!, right))) &&
      row.subtransactions.every(visit);
    return (
      can('budget', actor.budgetId, 'source') &&
      visit(transaction) &&
      !!documents[0] &&
      this.access(actor, scope, documents, {
        ledgerTransactionId: transaction.id,
        ...transaction,
      }).authorize({ capability: 'normalized-evidence', document: documents[0]!, scope })
    );
  }
  private async reviewRequest(
    actor: MerchantActor,
    scope: EvidenceScope,
    documents: EvidenceDocument[],
    policyVersion: string,
    maxSettlementDays: number,
  ): Promise<{ request: TransactionEvidenceRequest; snapshot: FinancialSnapshot | null }> {
    const request = this.request(documents, policyVersion, maxSettlementDays, actor, scope);
    if (
      !this.options.connectionManager ||
      !this.options.store.liquidity.isAuthorized({
        ...actor,
        now: this.now(),
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'source',
      })
    )
      return { request, snapshot: null };
    const snapshot = await this.options.connectionManager.withConnection(
      async (connected) => {
        if (
          connected.config.budgetId !== actor.budgetId ||
          merchantConnectionId(connected.config) !== scope.connectionId
        )
          throw new Error('Selected evidence ledger changed');
        return financialSnapshotSchema.parse(
          (connected.synchronization as { financialSnapshot?: unknown }).financialSnapshot,
        );
      },
      { expectedBudgetId: actor.budgetId },
    );
    if (!this.currentSources(actor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    const permitted = snapshot.legacySnapshot.transactions.filter((transaction) =>
      this.ledgerReadable(actor, scope, documents, transaction),
    );
    const visible = {
      ...snapshot,
      legacySnapshot: { ...snapshot.legacySnapshot, transactions: permitted },
    };
    const financial = {
      ...snapshot,
      legacySnapshot: {
        ...snapshot.legacySnapshot,
        transactions: snapshot.legacySnapshot.transactions.filter((row) =>
          this.ledgerFinancialReadable(actor, scope, documents, row),
        ),
      },
    };
    request.observations.push(...this.ledgerObservations(this.access(actor, scope), financial));
    if (request.observations.length > 10000) throw new Error('Evidence source limit exceeded');
    return { request, snapshot: visible };
  }
  private decisionCurrent(
    request: TransactionEvidenceRequest,
    decision: EvidenceResolutionDecision,
  ): boolean {
    return (decision.ledgerSources ?? []).every((proof) =>
      request.observations.some(
        (observation) =>
          observation.ledgerTransactionId === proof.ledgerTransactionId &&
          observation.provenance.contentHash === proof.contentHash,
      ),
    );
  }
  /** Review only exact, currently readable Actual candidates; this grants no mutation authority. */
  async settlementTargets(
    actor: MerchantActor,
    value: unknown,
  ): Promise<{
    transactions: Array<
      Pick<Transaction, 'id' | 'date' | 'amount' | 'payeeName' | 'categoryId' | 'categoryName'> & {
        splits: Array<Pick<Transaction, 'id' | 'categoryId' | 'categoryName' | 'amount'>>;
      }
    >;
  }> {
    const input = evidenceSettlementTargetsInputSchema.parse(value);
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    if (!access.authorize({ capability: 'resolve', document: null, scope }))
      throw new Error('Evidence operation is not authorized');
    const documents = this.current(this.readableDocuments(actor, scope), access);
    const { request, snapshot } = await this.reviewRequest(
      actor,
      scope,
      documents,
      actor.governancePolicyVersion!,
      5,
    );
    const decision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    if (decision && this.decisionCurrent(request, decision))
      this.applyDecision(request, decision, actor, scope);
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (!this.currentSources(actor as MerchantActor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    if (result.resolutionHash !== input.resolutionHash)
      throw new Error('Evidence source or resolution changed');
    const event = result.events.find((event) => event.id === input.eventId);
    if (!event || !snapshot) return { transactions: [] };
    const source = request.observations.filter(
      (observation) =>
        event.observationIds.includes(observation.id) && observation.kind !== 'ledger_transaction',
    );
    const transactions = snapshot.legacySnapshot.transactions
      .filter(
        (transaction) =>
          transaction.accountId === input.accountId &&
          transaction.amount.currency === event.amount.currency &&
          (input.matchMode === 'partial' ||
            (BigInt(transaction.amount.minorUnits) < 0n
              ? -BigInt(transaction.amount.minorUnits)
              : BigInt(transaction.amount.minorUnits)
            ).toString() === event.amount.minorUnits) &&
          source.some(
            (observation) =>
              BigInt(transaction.amount.minorUnits) < 0n ===
                (observation.direction === 'outflow') &&
              Math.abs(Date.parse(transaction.date) - Date.parse(observation.date)) <= 5 * 86400000,
          ) &&
          this.ledgerReadable(actor, scope, documents, transaction),
      )
      .map(({ id, date, amount, payeeName, categoryId, categoryName, subtransactions }) => ({
        id,
        date,
        amount,
        payeeName,
        categoryId,
        categoryName,
        splits: subtransactions.map(({ id, categoryId, categoryName, amount }) => ({
          id,
          categoryId,
          categoryName,
          amount,
        })),
      }));
    if (
      documents.some(
        (document) =>
          !this.options.store.evidence.isCurrent(this.access(actor, scope), document.id),
      )
    )
      throw new Error('Evidence source changed');
    if (
      documents.length &&
      !this.access(actor, scope, documents, { transactions }).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Settlement collection is not authorized');
    return { transactions };
  }
  private async settlementAllocation(
    actor: MerchantActor,
    input: z.infer<typeof evidenceSettlementPreviewSchema>,
  ) {
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    if (
      !access.authorize({ capability: 'resolve', document: null, scope }) ||
      !access.authorize({ capability: 'normalized-evidence', document: null, scope })
    )
      throw new Error('Evidence operation is not authorized');
    const documents = this.current(this.readableDocuments(actor, scope), access);
    if (!documents.length) throw new Error('No authorized evidence available');
    const sourceIds = documents.map((document) => document.id);
    const { request, snapshot } = await this.reviewRequest(
      actor,
      scope,
      documents,
      actor.governancePolicyVersion!,
      5,
    );
    const decision = this.options.store.evidence.latestDecision(access, sourceIds);
    if (decision && this.decisionCurrent(request, decision))
      this.applyDecision(request, decision, actor, scope);
    const current = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (current.resolutionHash !== input.resolutionHash)
      throw new Error('Evidence source or resolution changed');
    const target = snapshot?.legacySnapshot.transactions.find(
      (transaction) => transaction.id === input.targetTransactionId,
    );
    const targetObservation = request.observations.find(
      (observation) =>
        observation.kind === 'ledger_transaction' &&
        observation.ledgerTransactionId === input.targetTransactionId,
    );
    if (
      !target ||
      !targetObservation ||
      target.reconciled ||
      target.transferAccountId ||
      target.subtransactions.some((child) => child.reconciled || child.transferAccountId) ||
      !this.ledgerReadable(actor, scope, documents, target)
    )
      throw new Error('Current readable amendable settlement required');
    const categoryChoices = input.lineCategories.map((entry) => ({
      ...entry,
      accountId: target.accountId,
    }));
    prepareItemCategoryDecisions(
      categoryChoices,
      request,
      current,
      snapshot,
      actor,
      this.now(),
      (kind, resourceId, capability) =>
        this.options.store.liquidity.isAuthorized({
          ...actor,
          now: this.now(),
          resourceKind: kind,
          resourceId,
          capability,
        }),
    );
    if (new Set(input.receiptIds).size !== input.receiptIds.length)
      throw new Error('Duplicate receipt selection');
    const selected = input.receiptIds.map((receiptId) => {
      const receipt = request.receipts.find((receipt) => receipt.id === receiptId);
      const observation = request.observations.find(
        (observation) =>
          observation.id === receipt?.observationId && observation.kind !== 'ledger_transaction',
      );
      if (!receipt || !observation) throw new Error('Current receipt source required');
      return { receipt, observation };
    });
    const edges = selected.map(({ receipt, observation }) => ({
      id: `allocation:${createHash('sha256')
        .update(canonicalProposalJson([receipt.id, targetObservation.id]))
        .digest('hex')}`,
      fromId: observation.id,
      toId: targetObservation.id,
      kind: 'partial_funding' as const,
      state: 'confirmed' as const,
      allocatedAmount: receipt.total,
      partial: true,
      score: 100,
      reasonCodes: ['human_receipt_allocation'],
      evidenceIds: [observation.provenance.documentId, targetObservation.provenance.documentId],
    }));
    request.relationships = [
      ...request.relationships.filter(
        (edge) =>
          !edges.some(
            (replacement) => replacement.fromId === edge.fromId && replacement.toId === edge.toId,
          ),
      ),
      ...edges,
    ];
    if (!this.options.native.deriveEvidenceSettlementPlan)
      throw new Error('Native settlement allocation unavailable');
    const plan = EvidenceSettlementPlanSchema.parse(
      JSON.parse(
        this.options.native.deriveEvidenceSettlementPlan(
          JSON.stringify({
            contractVersion: '1',
            evidence: request,
            targetObservationId: targetObservation.id,
            receiptIds: input.receiptIds,
            lineCategories: input.lineCategories,
          }),
        ),
      ),
    );
    const currentIds = this.current(
      this.readableDocuments(actor, scope),
      this.access(actor, scope),
    ).map((document) => document.id);
    if (
      !this.currentSources(actor, scope, documents, request) ||
      !this.access(actor, scope).authorize({ capability: 'resolve', document: null, scope }) ||
      canonicalProposalJson(currentIds) !== canonicalProposalJson(sourceIds) ||
      !this.ledgerReadable(actor, scope, documents, target) ||
      !this.access(actor, scope, documents, plan).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Evidence source or authorization changed');
    return { plan, relationships: request.relationships, categoryChoices };
  }
  /** Preview native-conserved whole receipts against one existing authorized Actual settlement without saving or writing. */
  async previewSettlementAllocation(
    actor: MerchantActor,
    value: unknown,
  ): Promise<EvidenceSettlementPlan> {
    return (await this.settlementAllocation(actor, evidenceSettlementPreviewSchema.parse(value)))
      .plan;
  }
  /** Save a fresh exact allocation as an ordinary evidence decision; Actual changes still require the governed amendment proposal. */
  async saveSettlementAllocation(
    actor: MerchantActor,
    value: unknown,
  ): Promise<TransactionEvidenceResult> {
    const input = evidenceSettlementSaveSchema.parse(value);
    this.freshControl(actor);
    const { allocationHash, ...selector } = input;
    const preview = await this.settlementAllocation(actor, selector);
    if (preview.plan.allocationHash !== allocationHash)
      throw new Error('Evidence allocation changed');
    this.freshControl(actor);
    return this.saveResolutionDecision(actor, {
      resolutionHash: selector.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: preview.relationships,
      ledgerEffects: [
        { observationId: preview.plan.targetObservationId, effect: preview.plan.ledgerEffect },
      ],
      itemCategoryDecisions: preview.categoryChoices,
    });
  }
  private async allocation(
    actor: MerchantActor,
    input: z.infer<typeof evidenceAllocationPreviewSchema>,
  ) {
    const scope = await this.scope(actor),
      access = this.access(actor, scope);
    if (
      !access.authorize({ capability: 'resolve', document: null, scope }) ||
      !access.authorize({ capability: 'normalized-evidence', document: null, scope })
    )
      throw new Error('Evidence operation is not authorized');
    const documents = this.current(this.readableDocuments(actor, scope), access);
    if (!documents.length) throw new Error('No authorized evidence available');
    const sourceIds = documents.map((document) => document.id);
    const { request, snapshot } = await this.reviewRequest(
      actor,
      scope,
      documents,
      actor.governancePolicyVersion!,
      5,
    );
    const prior = this.options.store.evidence.latestDecision(access, sourceIds);
    if (prior && this.decisionCurrent(request, prior))
      this.applyDecision(request, prior, actor, scope);
    const current = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (current.resolutionHash !== input.resolutionHash)
      throw new Error('Evidence source or resolution changed');
    if (
      new Set(input.targetTransactionIds).size !== input.targetTransactionIds.length ||
      new Set(input.receiptIds).size !== input.receiptIds.length
    )
      throw new Error('Duplicate allocation selection');
    const targets = input.targetTransactionIds.map((identity) => {
      const transaction = snapshot?.legacySnapshot.transactions.find((row) => row.id === identity);
      const observation = request.observations.find(
        (row) => row.kind === 'ledger_transaction' && row.ledgerTransactionId === identity,
      );
      if (
        !transaction ||
        !observation ||
        transaction.reconciled ||
        transaction.transferAccountId ||
        transaction.subtransactions.some((child) => child.reconciled || child.transferAccountId) ||
        !this.ledgerReadable(actor, scope, documents, transaction)
      )
        throw new Error('Current readable amendable settlement required');
      return { transaction, observation };
    });
    if (
      input.lineCategories.some(
        (entry) => !targets.some((target) => target.transaction.accountId === entry.accountId),
      )
    )
      throw new Error('Category account must be a selected settlement account');
    const categories = prepareItemCategoryDecisions(
      input.lineCategories,
      request,
      current,
      snapshot,
      actor,
      this.now(),
      (kind, resourceId, capability) =>
        this.options.store.liquidity.isAuthorized({
          ...actor,
          now: this.now(),
          resourceKind: kind,
          resourceId,
          capability,
        }),
    );
    applyReviewedItemCategories(request, categories, actor, (kind, resourceId, capability) =>
      this.options.store.liquidity.isAuthorized({
        ...actor,
        now: this.now(),
        resourceKind: kind,
        resourceId,
        capability,
      }),
    );
    if (!this.options.native.deriveEvidenceAllocationPlan)
      throw new Error('Native allocation unavailable');
    const plan = EvidenceAllocationPlanSchema.parse(
      JSON.parse(
        this.options.native.deriveEvidenceAllocationPlan(
          JSON.stringify({
            contractVersion: '1',
            evidence: request,
            deriveFundingRelationships: true,
            receiptIds: input.receiptIds,
            targetObservationIds: targets.map((target) => target.observation.id),
            lineCategories: input.lineCategories.map(({ receiptId, lineId, categoryId }) => ({
              receiptId,
              lineId,
              categoryId,
            })),
            cells: input.cells.map(({ targetTransactionId, ...cell }) => {
              const target = targets.find(
                (target) => target.transaction.id === targetTransactionId,
              );
              if (!target) throw new Error('Allocation target changed');
              return { ...cell, targetObservationId: target.observation.id };
            }),
          }),
        ),
      ),
    );
    const currentIds = this.current(
      this.readableDocuments(actor, scope),
      this.access(actor, scope),
    ).map((document) => document.id);
    if (
      !this.currentSources(actor, scope, documents, request) ||
      canonicalProposalJson(currentIds) !== canonicalProposalJson(sourceIds) ||
      !this.access(actor, scope).authorize({ capability: 'resolve', document: null, scope }) ||
      targets.some((target) => !this.ledgerReadable(actor, scope, documents, target.transaction)) ||
      !this.access(actor, scope, documents, plan).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Evidence source or authorization changed');
    return { plan };
  }
  /** Preview a checked explicit many-to-many allocation without saving decisions or changing Actual. */
  async previewAllocation(actor: MerchantActor, value: unknown): Promise<EvidenceAllocationPlan> {
    return (await this.allocation(actor, evidenceAllocationPreviewSchema.parse(value))).plan;
  }
  /** Persist the exact native allocation set and separately reviewed item categories; Actual approval remains independent. */
  async saveAllocation(actor: MerchantActor, value: unknown): Promise<TransactionEvidenceResult> {
    const { allocationSetHash, ...selector } = evidenceAllocationSaveSchema.parse(value);
    this.freshControl(actor);
    const { plan } = await this.allocation(actor, selector);
    if (plan.allocationSetHash !== allocationSetHash || !plan.fundingRelationships)
      throw new Error('Evidence allocation changed');
    this.freshControl(actor);
    return this.saveResolutionDecision(actor, {
      resolutionHash: selector.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: plan.fundingRelationships,
      allocationReview: plan.review,
      itemCategoryDecisions: selector.lineCategories,
      ledgerEffects: plan.projections.map((projection) => ({
        observationId: projection.targetObservationId,
        effect: projection.ledgerEffect,
      })),
    });
  }
  /** Derive an exact action intent from current native financial proof for ordinary proposal approval. */
  async prepareLedgerAction(
    actor: MerchantActor,
    value: unknown,
  ): Promise<ConsequentialActionIntent> {
    const input = z
      .object({
        resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
        eventId: id,
        parentId: id.optional(),
        correlationId: id.optional(),
        allocationSetHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(value);
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    if (!access.authorize({ capability: 'resolve', document: null, scope }))
      throw new Error('Evidence operation is not authorized');
    const documents = this.current(this.readableDocuments(actor, scope), access);
    const { request, snapshot } = await this.reviewRequest(
      actor,
      scope,
      documents,
      actor.governancePolicyVersion!,
      5,
    );
    const decision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    if (decision && this.decisionCurrent(request, decision))
      this.applyDecision(request, decision, actor, scope);
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (!this.currentSources(actor as MerchantActor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    if (result.resolutionHash !== input.resolutionHash)
      throw new Error('Evidence source or resolution changed');
    const event = result.events.find((event) => event.id === input.eventId);
    if (!event) throw new Error('Conserved reviewed ledger effect unavailable');
    if (
      !documents[0] ||
      !this.access(actor, scope, documents, result).authorize({
        capability: 'normalized-evidence',
        document: documents[0],
        scope,
      }) ||
      documents.some(
        (document) =>
          !this.options.store.evidence.isCurrent(this.access(actor, scope), document.id),
      )
    )
      throw new Error('Evidence source is not authorized');
    const compose = (
      observation: SourceObservation | undefined,
      identity: { parentId?: string; correlationId?: string },
    ): AtomicConsequentialActionIntent => {
      const effect = observation?.ledgerEffect;
      if (
        !observation ||
        !effect ||
        observation.state !== 'resolved' ||
        observation.scope.kind !== 'transaction'
      )
        throw new Error('Conserved reviewed ledger effect unavailable');
      const subjectId = observation.scope.id;
      const expectedSource = snapshot?.legacySnapshot.transactions.find(
        (transaction) => transaction.id === subjectId,
      );
      const transaction = {
        ...effect,
        parentId: expectedSource?.id ?? identity.parentId ?? `evidence-${randomUUID()}`,
        correlationId: identity.correlationId ?? randomUUID(),
      };
      const evidenceIds = observation.evidence
        .map((reference) => reference.evidenceId)
        .filter((identity) => documents.some((document) => document.id === identity));
      if (!evidenceIds.length) throw new Error('Reviewed source document proof unavailable');
      if (
        !this.access(actor, scope, documents, { transaction, expectedSource }).authorize({
          capability: 'normalized-evidence',
          document: documents[0]!,
          scope,
        })
      )
        throw new Error('Ledger action is not authorized');
      if (expectedSource) {
        if (!this.ledgerReadable(actor, scope, documents, expectedSource))
          throw new Error('Settlement source is not authorized');
        return {
          kind: 'evidence_amendment',
          resolutionSubjectId: subjectId,
          transaction,
          evidenceIds,
          expectedSource,
          expected: {
            parentId: expectedSource.id,
            accountId: expectedSource.accountId,
            amount: expectedSource.amount,
            date: expectedSource.date,
            categoryId: expectedSource.categoryId,
            payeeName: expectedSource.payeeName,
            notes: expectedSource.notes,
            splits: expectedSource.subtransactions.map((child) => ({
              categoryId: child.categoryId!,
              amount: child.amount,
            })),
            transferAccountId: expectedSource.transferAccountId,
          },
        };
      }
      return {
        kind: BigInt(effect.amount.minorUnits) > 0n ? 'evidence_credit' : 'evidence_projection',
        resolutionSubjectId: subjectId,
        transaction,
        evidenceIds,
      };
    };
    if (input.allocationSetHash) {
      if (
        input.parentId ||
        input.correlationId ||
        !event ||
        event.allocationSetHash !== input.allocationSetHash
      )
        throw new Error('Allocation set changed');
      const outputs = result.events
        .filter((value) => value.allocationSetHash === input.allocationSetHash)
        .flatMap((value) =>
          [
            ...(value.projectionObservation ? [value.projectionObservation] : []),
            ...(value.projectionObservations ?? []),
          ].map((proof) => ({ eventId: value.id, proof })),
        );
      if (!outputs.length) throw new Error('Conserved reviewed allocation unavailable');
      const actions = outputs.map(({ proof }) => {
        if (proof.scope.kind !== 'transaction') throw new Error('Allocation target scope changed');
        const action = compose(proof, {
          correlationId: `allocation-${createHash('sha256')
            .update(
              canonicalProposalJson([
                actor.spaceId,
                actor.budgetId,
                input.resolutionHash,
                input.allocationSetHash,
                proof.scope.id,
              ]),
            )
            .digest('hex')}`,
        });
        if (action.kind !== 'evidence_amendment')
          throw new Error('Existing settlement amendment required');
        return action;
      });
      const fresh = await this.resolve(actor, { policyVersion: actor.governancePolicyVersion });
      if (fresh.resolutionHash !== input.resolutionHash)
        throw new Error('Allocation source or authority changed');
      return { kind: 'composite', actions };
    }
    const proofs = [
      ...(event?.projectionObservation ? [event.projectionObservation] : []),
      ...(event?.projectionObservations ?? []),
    ];
    const observation = proofs.length === 1 ? proofs[0] : undefined;
    return compose(observation, { parentId: input.parentId, correlationId: input.correlationId });
  }
  /** Resolve current authorized normalized evidence entirely in Rust, then persist the immutable result. */
  async resolve(actor: MerchantActor, value: unknown): Promise<TransactionEvidenceResult> {
    const input = z
      .object({ policyVersion: id, maxSettlementDays: z.number().int().min(0).max(90).default(5) })
      .strict()
      .parse(value);
    if (input.policyVersion !== actor.governancePolicyVersion)
      throw new Error('Evidence policy is not current');
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    if (
      !access.authorize({ capability: 'resolve', document: null, scope }) ||
      !access.authorize({ capability: 'normalized-evidence', document: null, scope })
    )
      throw new Error('Evidence operation is not authorized');
    const documents = this.current(this.readableDocuments(actor as MerchantActor, scope), access);
    if (!documents.length) throw new Error('No authorized evidence available');
    const { request } = await this.reviewRequest(
      actor,
      scope,
      documents,
      input.policyVersion,
      input.maxSettlementDays,
    );
    const decision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    if (decision && this.decisionCurrent(request, decision))
      this.applyDecision(request, decision, actor, scope);
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (!this.currentSources(actor as MerchantActor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    if (result.policyVersion !== input.policyVersion) throw new Error('Evidence policy mismatch');
    if (
      documents.length &&
      !this.access(actor, scope, documents, result).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Evidence result is not authorized');
    this.options.store.evidence.saveResolution(
      this.access(actor, scope),
      result.resolutionHash,
      documents.map((document) => document.id),
      result,
    );
    return result;
  }
  private current(documents: EvidenceDocument[], access?: EvidenceAccess): EvidenceDocument[] {
    return [
      ...new Map(
        documents
          .filter(
            (document) => !access || this.options.store.evidence.isCurrent(access, document.id),
          )
          .map((document) => [
            JSON.stringify([document.connectorId, document.sourceId, document.privateActorId]),
            document,
          ]),
      ).values(),
    ];
  }
  /** Save an exact freshly reviewed relationship correction, then rerun Rust conservation. */
  async saveResolutionDecision(
    actor: MerchantActor,
    value: unknown,
  ): Promise<TransactionEvidenceResult> {
    const input = transactionEvidenceDecisionSchema.parse(value);
    this.freshControl(actor);
    const before = await this.resolve(actor, {
      policyVersion: input.policyVersion,
      maxSettlementDays: input.maxSettlementDays,
    });
    if (before.resolutionHash !== input.resolutionHash)
      throw new Error('Evidence source or resolution changed');
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    const documents = this.current(this.readableDocuments(actor as MerchantActor, scope), access);
    const { request, snapshot } = await this.reviewRequest(
      actor,
      scope,
      documents,
      input.policyVersion,
      input.maxSettlementDays,
    );
    const ids = new Set(request.observations.map((observation) => observation.id));
    const evidenceIds = new Set(
      request.observations.map((observation) => observation.provenance.documentId),
    );
    const storedDecision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    const priorDecision =
      storedDecision && this.decisionCurrent(request, storedDecision) ? storedDecision : null;

    const currentRequest = structuredClone(request);
    if (priorDecision) this.applyDecision(currentRequest, priorDecision, actor, scope);
    const currentResolution = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(currentRequest))),
    );
    if (
      currentResolution.policyVersion !== input.policyVersion ||
      currentResolution.resolutionHash !== input.resolutionHash
    )
      throw new Error('Evidence source or resolution changed');
    const receiptAnnotationBaseHash = createHash('sha256')
      .update(
        canonicalProposalJson(
          this.options.store.evidence.receiptAnnotations(access, {
            documentIds: documents.map((document) => document.id),
            policyVersion: actor.governancePolicyVersion!,
            membershipId: actor.membershipId!,
          }),
        ),
      )
      .digest('hex');
    const seeOtherMembers = this.canReadOtherMembers(actor, scope);
    const receiptAnnotations = prepareReceiptAnnotations(
      input.receiptAnnotationDecisions,
      request,
      currentResolution,
      actor,
      this.now(),
      this.memberPeriods(actor, scope),
      (member) => member === actor.actorId || seeOtherMembers,
    );
    const itemCategoryBaseHash = createHash('sha256')
      .update(
        canonicalProposalJson(
          this.options.store.evidence.itemCategoryOutcomes(access, {
            documentIds: documents.map((document) => document.id),
            policyVersion: actor.governancePolicyVersion!,
            membershipId: actor.membershipId!,
          }),
        ),
      )
      .digest('hex');
    const itemCategoryDecisions = prepareItemCategoryDecisions(
      input.itemCategoryDecisions,
      request,
      currentResolution,
      snapshot,
      actor,
      this.now(),
      (kind, id, capability) =>
        this.options.store.liquidity.isAuthorized({
          ...actor,
          now: this.now(),
          resourceKind: kind,
          resourceId: id,
          capability,
        }),
    );
    input.purposeDecisions = [
      ...new Map(
        [...(priorDecision?.purposeDecisions ?? []), ...input.purposeDecisions].map((entry) => [
          entry.observationId,
          entry,
        ]),
      ).values(),
    ];
    input.ledgerEffects = [
      ...new Map(
        [
          ...(priorDecision?.ledgerEffects ?? []).filter(
            (entry) =>
              input.allocationReview ||
              !priorDecision?.allocationReview?.targetObservationIds.includes(entry.observationId),
          ),
          ...input.ledgerEffects,
        ].map((entry) => [entry.observationId, entry]),
      ).values(),
    ];
    if (
      input.relationships.some(
        (relationship) =>
          !ids.has(relationship.fromId) ||
          !ids.has(relationship.toId) ||
          relationship.evidenceIds.some((identity) => !evidenceIds.has(identity)),
      )
    )
      throw new Error('Evidence decision references unknown source');
    if (
      new Set(input.ledgerEffects.map((entry) => entry.observationId)).size !==
        input.ledgerEffects.length ||
      input.ledgerEffects.some((entry) => !ids.has(entry.observationId))
    )
      throw new Error('Evidence decision references unknown source');
    if (
      new Set(input.purposeDecisions.map((entry) => entry.observationId)).size !==
        input.purposeDecisions.length ||
      input.purposeDecisions.some((entry) => !ids.has(entry.observationId))
    )
      throw new Error('Evidence purpose references unknown source');
    const graphRequest = structuredClone(request);
    this.applyDecision(
      graphRequest,
      {
        resolutionHash: input.resolutionHash,
        documentIds: documents.map((document) => document.id),
        relationships: input.relationships,
        purposeDecisions: input.purposeDecisions,
        ledgerEffects: [],
      },
      actor,
      scope,
    );
    const graph = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(graphRequest))),
    );
    for (const entry of input.ledgerEffects) {
      const event = graph.events.find((event) =>
        event.observationIds.includes(entry.observationId),
      );
      const targets = request.observations.filter(
        (observation) =>
          observation.kind === 'ledger_transaction' &&
          event?.observationIds.includes(observation.id),
      );
      const entryTarget = targets.find((target) => target.id === entry.observationId);
      const original =
        entryTarget || targets.length === 1
          ? snapshot?.legacySnapshot.transactions.find(
              (transaction) => transaction.id === (entryTarget ?? targets[0])!.ledgerTransactionId,
            )
          : undefined;
      if (original) {
        if (
          (entry.effect.payeeName !== null && entry.effect.payeeName !== original.payeeName) ||
          (entry.effect.notes !== null && entry.effect.notes !== original.notes)
        )
          throw new Error('Amendment must preserve settlement payee and notes');
        entry.effect = { ...entry.effect, payeeName: original.payeeName, notes: original.notes };
      }
      const synthetic: EvidenceDocument = {
        ...documents[0]!,
        extraction: { effect: entry.effect },
      };
      if (!access.authorize({ capability: 'normalized-evidence', document: synthetic, scope }))
        throw new Error('Evidence effect is not authorized');
    }
    this.applyDecision(
      request,
      {
        resolutionHash: input.resolutionHash,
        documentIds: documents.map((document) => document.id),
        relationships: input.relationships,
        ledgerEffects: input.ledgerEffects,
        purposeDecisions: input.purposeDecisions,
        itemCategoryDecisions,
        ...(input.allocationReview ? { allocationReview: input.allocationReview } : {}),
      },
      actor,
      scope,
      itemCategoryDecisions,
    );
    if (input.allocationReview && !request.allocationReview)
      throw new Error('Evidence allocation changed');
    applyReceiptAnnotations(
      request,
      receiptAnnotations,
      actor,
      this.memberPeriods(actor, scope),
      (member) => member === actor.actorId || this.canReadOtherMembers(actor, scope),
    );
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (!this.currentSources(actor as MerchantActor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    if (result.policyVersion !== input.policyVersion) throw new Error('Evidence policy mismatch');
    if (
      documents.length &&
      !this.access(actor, scope, documents, result).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Evidence result is not authorized');
    const linkedIds = new Set(
      input.relationships
        .filter((relationship) => relationship.state === 'confirmed')
        .flatMap((relationship) => [relationship.fromId, relationship.toId]),
    );
    const ledgerSources = request.observations
      .filter(
        (observation) => observation.kind === 'ledger_transaction' && linkedIds.has(observation.id),
      )
      .map((observation) => ({
        ledgerTransactionId: observation.ledgerTransactionId!,
        contentHash: observation.provenance.contentHash,
      }));
    this.freshControl(actor);
    this.options.store.evidence.saveDecision(
      this.access(actor, scope, undefined, undefined, 'approve'),
      {
        resolutionHash: input.resolutionHash,
        documentIds: documents.map((document) => document.id),
        relationships: input.relationships,
        ledgerEffects: input.ledgerEffects,
        purposeDecisions: input.purposeDecisions,
        itemCategoryDecisions,
        itemCategoryBaseHash,
        receiptAnnotations,
        receiptAnnotationBaseHash,
        ledgerSources,
        ...(input.allocationReview ? { allocationReview: input.allocationReview } : {}),
      },
    );
    this.options.store.evidence.saveResolution(
      this.access(actor, scope),
      result.resolutionHash,
      documents.map((document) => document.id),
      result,
    );
    return result;
  }
  private applyDecision(
    request: TransactionEvidenceRequest,
    decision: EvidenceResolutionDecision,
    actor: LiquidityActor,
    scope: EvidenceScope,
    pendingItemCategoryDecisions: EvidenceItemCategoryDecision[] = [],
  ): void {
    const documents = [
      ...new Set(
        request.observations
          .filter((observation) => observation.kind !== 'ledger_transaction')
          .map((observation) => observation.provenance.documentId),
      ),
    ];
    const stored = this.options.store.evidence.itemCategoryOutcomes(
      this.access(actor as MerchantActor, scope),
      {
        documentIds: documents,
        policyVersion: actor.governancePolicyVersion!,
        membershipId: actor.membershipId!,
      },
    );
    const entries = [
      ...new Map(
        [...stored, ...pendingItemCategoryDecisions].map((entry) => [
          JSON.stringify([entry.documentId, entry.receiptId, entry.lineId]),
          entry,
        ]),
      ).values(),
    ];
    applyReviewedItemCategories(request, entries, actor, (kind, id, capability) =>
      this.options.store.liquidity.isAuthorized({
        ...actor,
        now: this.now(),
        resourceKind: kind,
        resourceId: id,
        capability,
      }),
    );
    if (decision.allocationReview) request.allocationReview = decision.allocationReview;
    else delete request.allocationReview;
    request.relationships = decision.relationships;
    for (const entry of decision.purposeDecisions ?? []) {
      const observation = request.observations.find(
        (candidate) => candidate.id === entry.observationId,
      );
      if (!observation) throw new Error('Evidence purpose source changed');
      observation.eventType = entry.eventType;
    }
    for (const entry of decision.ledgerEffects ?? []) {
      const observation = request.observations.find(
        (candidate) => candidate.id === entry.observationId,
      );
      if (!observation) throw new Error('Evidence decision source changed');
      observation.reviewedLedgerEffect = true;
      observation.ledgerEffect = entry.effect;
    }
    if (request.allocationReview) {
      const review = request.allocationReview;
      try {
        if (!this.options.native.deriveEvidenceAllocationPlan)
          throw new Error('Native allocation unavailable');
        const plan = EvidenceAllocationPlanSchema.parse(
          JSON.parse(
            this.options.native.deriveEvidenceAllocationPlan(
              JSON.stringify({
                contractVersion: '1',
                evidence: request,
                receiptIds: review.receiptIds,
                targetObservationIds: review.targetObservationIds,
                lineCategories: review.lineCategories,
                cells: review.cells,
              }),
            ),
          ),
        );
        if (canonicalProposalJson(plan.review) !== canonicalProposalJson(review))
          throw new Error('Allocation review changed');
      } catch {
        delete request.allocationReview;
        for (const target of request.observations.filter((observation) =>
          review.targetObservationIds.includes(observation.id),
        )) {
          target.ledgerEffect = null;
          target.reviewedLedgerEffect = false;
        }
      }
    }
  }
  /** Recompute projections inside the ordinary Actual capture without opening another connection. */
  async captureObservations(
    actor: LiquidityActor,
    config: { serverUrl: string; budgetId: string },
    snapshot: FinancialSnapshot,
    postconditionPlan?: ConsequentialActionPlan,
  ): Promise<SourceObservation[]> {
    if (
      !actor.spaceId ||
      !actor.auth ||
      !actor.membershipId ||
      !actor.governancePolicyVersion ||
      config.budgetId !== actor.budgetId
    )
      return [];
    const trusted = actor as MerchantActor;
    const scope = {
      spaceId: actor.spaceId,
      budgetId: actor.budgetId,
      connectionId: merchantConnectionId(config),
    };
    const access = this.access(trusted, scope);
    if (
      !access.authorize({ capability: 'resolve', document: null, scope }) ||
      !access.authorize({ capability: 'normalized-evidence', document: null, scope })
    )
      return [];
    const documents = this.current(this.readableDocuments(actor as MerchantActor, scope), access);
    if (!documents.length) return [];
    const decision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    for (const entry of decision?.ledgerEffects ?? [])
      if (
        !access.authorize({
          capability: 'normalized-evidence',
          document: { ...documents[0]!, extraction: { effect: entry.effect } },
          scope,
        })
      )
        return [];
    const request = this.request(documents, actor.governancePolicyVersion, 5, trusted, scope);
    const postconditionActions =
      postconditionPlan?.action.kind === 'composite'
        ? postconditionPlan.action.actions
        : postconditionPlan
          ? [postconditionPlan.action]
          : [];
    const permittedNewRows = postconditionActions.filter(
      (atom) => atom.kind === 'evidence_projection' || atom.kind === 'evidence_credit',
    );
    const exactOwnedRow = (row: FinancialSnapshot['legacySnapshot']['transactions'][number]) =>
      permittedNewRows.some((atom) => {
        if (atom.kind !== 'evidence_projection' && atom.kind !== 'evidence_credit') return false;
        const intent = atom.transaction;
        return (
          row.id === intent.parentId &&
          row.accountId === intent.accountId &&
          row.date === intent.date &&
          canonicalProposalJson(row.amount) === canonicalProposalJson(intent.amount) &&
          row.categoryId === intent.categoryId &&
          row.payeeName === intent.payeeName &&
          row.notes === intent.notes &&
          row.importedId === null &&
          row.importedPayee === null &&
          row.transferAccountId === null &&
          !row.reconciled &&
          canonicalProposalJson(
            row.subtransactions.map((child) => ({
              categoryId: child.categoryId,
              amount: child.amount,
            })),
          ) === canonicalProposalJson(intent.splits)
        );
      });
    const remainingActual = snapshot.legacySnapshot.transactions.filter(
      (row) => !exactOwnedRow(row),
    );
    const resolverSnapshot = {
      ...snapshot,
      legacySnapshot: {
        ...snapshot.legacySnapshot,
        transactions: remainingActual.filter((row) =>
          this.ledgerFinancialReadable(trusted, scope, documents, row),
        ),
      },
    };
    try {
      request.observations.push(...this.ledgerObservations(access, resolverSnapshot));
    } catch {
      return [];
    }
    if (decision) {
      if (!this.decisionCurrent(request, decision)) return [];
      this.applyDecision(request, decision, actor, scope);
    }
    if (request.observations.length > 10000) return [];
    TransactionEvidenceRequestSchema.parse(request);
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (!this.currentSources(actor as MerchantActor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    if (result.policyVersion !== actor.governancePolicyVersion)
      throw new Error('Evidence policy mismatch');
    if (
      !this.access(trusted, scope, documents, result).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      return [];
    const readableParents = new Set(
      request.observations
        .filter((observation) => observation.kind === 'ledger_transaction')
        .map((observation) => observation.ledgerTransactionId),
    );
    const projections = result.events.flatMap((event) => [
      ...(event.projectionObservation ? [event.projectionObservation] : []),
      ...(event.projectionObservations ?? []),
    ]);
    const newProjections = projections.filter(
      (proof) => proof.scope.kind === 'transaction' && !readableParents.has(proof.scope.id),
    );
    const hasUnreadableActual = remainingActual.some(
      (row) => !this.ledgerFinancialReadable(trusted, scope, documents, row),
    );
    let privateGuard: TransactionEvidenceResult | null = null;
    if (newProjections.length && hasUnreadableActual) {
      // Internal duplicate-settlement safety may inspect authoritative Actual facts which
      // this actor cannot publish. Never return their IDs, amounts, diagnostics or hash.
      const privateRequest = this.request(
        documents,
        actor.governancePolicyVersion,
        5,
        trusted,
        scope,
      );
      privateRequest.observations.push(
        ...this.ledgerObservations(access, {
          ...snapshot,
          legacySnapshot: { ...snapshot.legacySnapshot, transactions: remainingActual },
        }),
      );
      if (privateRequest.observations.length <= 10000) {
        if (decision && this.decisionCurrent(privateRequest, decision))
          this.applyDecision(privateRequest, decision, actor, scope);
        privateGuard = TransactionEvidenceResultSchema.parse(
          JSON.parse(
            this.options.native.resolveTransactionEvidence(JSON.stringify(privateRequest)),
          ),
        );
      }
    }
    const privatelySupported = new Set(
      (privateGuard?.events ?? [])
        .flatMap((event) => [
          ...(event.projectionObservation ? [event.projectionObservation] : []),
          ...(event.projectionObservations ?? []),
        ])
        .filter((proof) => proof.scope.kind === 'transaction')
        .map((proof) => canonicalProposalJson([proof.scope, proof.ledgerEffect])),
    );
    if (!this.currentSources(trusted, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    return [
      ...result.wallets.flatMap((wallet) => wallet.anchorObservations ?? []),
      ...projections.filter(
        (proof) =>
          proof.scope.kind === 'transaction' &&
          (readableParents.has(proof.scope.id) ||
            !hasUnreadableActual ||
            privatelySupported.has(canonicalProposalJson([proof.scope, proof.ledgerEffect]))),
      ),
    ];
  }
  /** Derive connector coverage without leaking hidden evidence counts. */
  async health(actor: MerchantActor): Promise<EvidenceConnectorHealth[]> {
    const scope = await this.scope(actor);
    this.requireBudget(actor, scope, 'normalized-evidence');
    const access = this.access(actor, scope);
    const grouped = new Map<string, EvidenceDocument[]>();
    for (const document of this.readableDocuments(actor, scope))
      grouped.set(document.connectorId, [...(grouped.get(document.connectorId) ?? []), document]);
    const admittedStatements = this.options.store.evidence.walletStatements.state(access, {
      membershipId: actor.membershipId!,
      policyVersion: actor.governancePolicyVersion!,
    }).proofs;
    let statementResolution: TransactionEvidenceResult | null = null;
    if (
      admittedStatements.length &&
      access.authorize({ capability: 'resolve', document: null, scope })
    ) {
      try {
        statementResolution = await this.resolve(actor, {
          policyVersion: actor.governancePolicyVersion,
        });
      } catch {
        statementResolution = null;
      }
    }
    const health: EvidenceConnectorHealth[] = [...grouped].map(([connectorId, documents]) => {
      const parsed = documents.filter((document) => document.parseStatus === 'parsed');
      return {
        connectorId,
        latestReceivedAt: documents
          .map((document) => document.receivedAt)
          .sort()
          .at(-1)!,
        latestParsedAt:
          parsed
            .map((document) => document.receivedAt)
            .sort()
            .at(-1) ?? null,
        documentCount: documents.length,
        unsupportedCount: documents.filter(
          (document) => document.parseStatus === 'unsupported_template',
        ).length,
        malformedCount: documents.filter((document) => document.parseStatus === 'malformed').length,
        duplicateCount: documents.reduce(
          (count, document) =>
            count +
            this.options.store.evidence
              .audit(access, document.id)
              .filter((entry) => entry.action === 'duplicate_received').length,
          0,
        ),
        statementCoverage: admittedStatements.some((proof) =>
          documents.some((document) => document.id === proof.statement.documentId),
        )
          ? {
              authorityKind: 'human_attested_statement' as const,
              state: statementResolution ? ('evaluated' as const) : ('unavailable' as const),
              wallets: (statementResolution?.wallets ?? []).flatMap((wallet) =>
                wallet.coverage &&
                admittedStatements.some(
                  (proof) =>
                    proof.walletId === wallet.walletId &&
                    documents.some((document) => document.id === proof.statement.documentId),
                )
                  ? [
                      {
                        walletId: wallet.walletId,
                        balanceState: wallet.balanceState,
                        reasonCodes: wallet.reasonCodes,
                        coverage: wallet.coverage,
                      },
                    ]
                  : [],
              ),
              reasonCodes: statementResolution ? [] : ['current_statement_resolution_unavailable'],
            }
          : null,
      };
    });
    const documents = [...grouped.values()].flat();
    if (
      documents.length &&
      !this.access(actor, scope, documents, health).authorize({
        capability: 'normalized-evidence',
        document: documents[0]!,
        scope,
      })
    )
      throw new Error('Evidence connector health is not authorized');
    if (
      canonicalProposalJson(admittedStatements) !==
      canonicalProposalJson(
        this.options.store.evidence.walletStatements.state(this.access(actor, scope), {
          membershipId: actor.membershipId!,
          policyVersion: actor.governancePolicyVersion!,
        }).proofs,
      )
    )
      throw new Error('Wallet statement proof changed');
    this.requireBudget(actor, scope, 'normalized-evidence');
    return health;
  }
  /** Feed source degradation into the ordinary attention surface. */
  async attentionPublication(
    actor: MerchantActor,
  ): Promise<{ items: EvidenceAttentionItem[]; authorize: () => boolean }> {
    const scope = await this.scope(actor);
    const access = this.access(actor, scope);
    const documents = this.current(this.readableDocuments(actor as MerchantActor, scope), access);
    const items: EvidenceAttentionItem[] = documents
      .filter((document) => document.parseStatus !== 'parsed')
      .map((document) => ({
        id: `evidence:${document.id}`,
        classification: 'evidence_connector_degradation',
        severity: 'medium',
        description: 'Evidence needs a supported extraction before financial resolution.',
        evidenceIds: [document.id],
        reasonCodes: document.quality,
      }));
    const fingerprint = documents
      .map((document) => `${document.id}:${document.contentHash}`)
      .sort()
      .join(',');
    let ledgerSnapshot: FinancialSnapshot | null = null;
    let resolution: TransactionEvidenceResult | null = null;
    let capturedRequest: TransactionEvidenceRequest | null = null;
    const authorize = (): boolean => {
      const current = this.current(this.readableDocuments(actor, scope), this.access(actor, scope));
      return (
        (!capturedRequest || this.currentSources(actor, scope, documents, capturedRequest)) &&
        (!ledgerSnapshot ||
          ledgerSnapshot.legacySnapshot.transactions.every((transaction) =>
            this.ledgerReadable(actor, scope, documents, transaction),
          )) &&
        (!resolution ||
          !documents[0] ||
          this.access(actor, scope, documents, resolution).authorize({
            capability: 'normalized-evidence',
            document: documents[0],
            scope,
          })) &&
        (!items.some((item) => item.classification === 'unresolved_material_evidence') ||
          this.access(actor, scope).authorize({ capability: 'resolve', document: null, scope })) &&
        current
          .map((document) => `${document.id}:${document.contentHash}`)
          .sort()
          .join(',') === fingerprint &&
        this.access(actor, scope).authorize({ capability: 'observe', document: null, scope })
      );
    };
    if (!documents.length || !access.authorize({ capability: 'resolve', document: null, scope }))
      return { items, authorize };
    const reviewed = await this.reviewRequest(
      actor,
      scope,
      documents,
      actor.governancePolicyVersion!,
      5,
    );
    const request = reviewed.request;
    capturedRequest = request;
    for (const blocked of this.receiptVersionPlan(actor, scope, documents).plan.blockedChildren)
      items.push({
        id: `evidence:receipt-history:${blocked.child.documentId}:${blocked.child.receiptId}`,
        classification: 'unresolved_material_evidence',
        severity: 'high',
        description:
          'Reviewed receipt history is unavailable. Review its source permissions or revoke the stale relationship before dependent work.',
        evidenceIds: [blocked.child.documentId],
        reasonCodes: [blocked.reasonCode],
      });

    ledgerSnapshot = reviewed.snapshot;
    const decision = this.options.store.evidence.latestDecision(
      access,
      documents.map((document) => document.id),
    );
    if (decision && this.decisionCurrent(request, decision))
      this.applyDecision(request, decision, actor, scope);
    const result = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.options.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    if (!this.currentSources(actor as MerchantActor, scope, documents, request))
      throw new Error('Evidence history or authorization changed');
    resolution = result;
    const admitted = new Set(documents.map((document) => document.id));
    for (const blocker of result.blockers)
      if (blocker.evidenceIds.some((identity) => admitted.has(identity)))
        items.push({
          id: `evidence:${result.resolutionHash}:${blocker.subjectId}:${blocker.code}`,
          classification: 'unresolved_material_evidence',
          severity: 'high',
          description: 'Financial evidence requires focused review before a ledger projection.',
          evidenceIds: blocker.evidenceIds.filter((identity) => admitted.has(identity)),
          reasonCodes: [blocker.code],
        });
    return { items, authorize };
  }
  /** Read currently authorized attention with a final synchronous publication check. */
  async attention(actor: MerchantActor): Promise<EvidenceAttentionItem[]> {
    const publication = await this.attentionPublication(actor);
    return publication.authorize() ? publication.items : [];
  }
}
/** Construct evidence orchestration with the same lazy native loader as existing services. */
export async function createTransactionEvidenceService(
  options: Omit<TransactionEvidenceServiceOptions, 'native'> & {
    native?: TransactionEvidenceNative;
  },
): Promise<TransactionEvidenceService> {
  if (options.native) return new TransactionEvidenceService({ ...options, native: options.native });
  const native = await loadNativeBindings();
  if (!native.resolveTransactionEvidence)
    throw new Error('Native transaction evidence capability unavailable');
  return new TransactionEvidenceService({
    ...options,
    native: {
      resolveTransactionEvidence: native.resolveTransactionEvidence,
      simulateTransactionEvidenceRule: native.simulateTransactionEvidenceRule,
      compareSpendSessionReceipt: native.compareSpendSessionReceipt,
      learnTransactionEvidenceItemRules: native.learnTransactionEvidenceItemRules,
      deriveEvidenceSettlementPlan: native.deriveEvidenceSettlementPlan,
      deriveEvidenceAllocationPlan: native.deriveEvidenceAllocationPlan,
      deriveWalletStatementPreview: native.deriveWalletStatementPreview,
    },
  });
}
