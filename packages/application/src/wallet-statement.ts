import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WalletStatementProofSchema,
  WalletStatementPreviewSchema,
  TransactionEvidenceResultSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  WalletStatementProof,
  AtomicConsequentialActionIntent,
  TransactionEvidenceRequest,
} from '@balanceframe/protocol-generated';
import {
  canonicalProposalJson,
  type WorkflowStore,
  type EvidenceAccess,
  type EvidenceDocument,
  type EvidenceScope,
} from '@balanceframe/workflow-store';
import type { MerchantActor } from './merchant-service.js';
const id = z.string().trim().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
const money = z
  .object({
    minorUnits: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .max(19)
      .refine((value) => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9223372036854775807n),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  );
/** Source identity and coverage are selected explicitly; source/human authority is always supplied by the server. */
const statementInput = z
  .object({
    statementDocumentId: id,
    wallet: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('existing'), walletId: id }).strict(),
      z
        .object({ kind: z.literal('new'), label: id, currency: z.string().regex(/^[A-Z]{3}$/) })
        .strict(),
    ]),
    startDate: date,
    endDate: date,
    openingBalance: money.nullable(),
    closingBalance: money.nullable(),
  })
  .strict();
const validPeriod = (input: z.infer<typeof statementInput>) =>
  input.startDate <= input.endDate &&
  (input.openingBalance !== null || input.closingBalance !== null);
export const walletStatementPreviewInputSchema = statementInput.refine(validPeriod);
/** Attestation is an explicit assertion of complete statement coverage, never issuer authentication. */
const confirmationShape = {
  previewHash: hash,
  expectedProofFoldHash: hash,
  originalAcknowledged: z.literal(true),
  completeActivityAcknowledged: z.literal(true),
};
export const walletStatementAttestInputSchema = statementInput
  .extend(confirmationShape)
  .strict()
  .refine(validPeriod);
const attestation = z.object(confirmationShape).strict();
export const walletStatementRevokeInputSchema = z
  .object({ proofId: id, expectedProofFoldHash: hash })
  .strict();
/** Only an exact current native before-day anchor can supply governed opening equity. */
export const walletMaterializationSelectorSchema = z
  .object({
    resolutionHash: hash,
    walletId: id,
    proofSetHash: hash,
    activityManifestHash: hash,
    asOfDate: date,
    accountName: id,
  })
  .strict();
export interface WalletStatementCapture {
  scope: EvidenceScope;
  documents: EvidenceDocument[];
  request: TransactionEvidenceRequest;
  authorize: (additional?: unknown) => boolean;
}
export interface WalletStatementHost {
  store: WorkflowStore;
  key: Buffer;
  now: () => string;
  fresh: (actor: MerchantActor) => void;
  native: {
    deriveWalletStatementPreview?(input: string): string;
    resolveTransactionEvidence(input: string): string;
  };
  capture: (actor: MerchantActor) => Promise<WalletStatementCapture>;
  access: (
    actor: MerchantActor,
    scope: EvidenceScope,
    documents?: EvidenceDocument[],
    additional?: unknown,
    phase?: 'approve',
  ) => EvidenceAccess;
  readOriginal: (actor: MerchantActor, id: string) => Promise<Buffer | null>;
}
/** Qualify local labels by their source owner and connector so private peers cannot merge wallets. */
export function qualifiedWalletId(
  scope: EvidenceScope,
  source: Pick<EvidenceDocument, 'connectorId' | 'privateActorId'>,
  label: string,
): string {
  return `wallet:${digest([scope.spaceId, scope.budgetId, scope.connectionId, source.connectorId, source.privateActorId, label])}`;
}
/** Review bounded local statement claims through native arithmetic and current source/human authorization. */
export class WalletStatementService {
  constructor(private readonly host: WalletStatementHost) {}
  private scope(actor: MerchantActor) {
    if (!actor.membershipId || !actor.governancePolicyVersion)
      throw new Error('Current wallet statement review scope required');
    return { membershipId: actor.membershipId, policyVersion: actor.governancePolicyVersion };
  }
  /** List current admitted proofs; no source grants are inferred from an earlier review. */
  async state(actor: MerchantActor) {
    const capture = await this.host.capture(actor);
    const result = this.host.store.evidence.walletStatements.state(
      this.host.access(actor, capture.scope),
      this.scope(actor),
    );
    if (!capture.authorize(result)) throw new Error('Wallet statement authority changed');
    return result;
  }
  /** Return authorized source metadata, wallet choices and current bounded coverage for manual review. */
  async context(actor: MerchantActor) {
    const capture = await this.host.capture(actor);
    const state = this.host.store.evidence.walletStatements.state(
      this.host.access(actor, capture.scope),
      this.scope(actor),
    );
    const resolution = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.host.native.resolveTransactionEvidence(JSON.stringify(capture.request))),
    );
    const result = {
      ...state,
      documents: capture.documents.map(
        ({ id, connectorId, sourceId, contentHash, parserVersion, mediaType, retentionUntil }) => ({
          id,
          connectorId,
          sourceId,
          contentHash,
          parserVersion,
          mediaType,
          retentionUntil,
        }),
      ),
      wallets: capture.request.wallets.map(({ walletId, currency }) => ({ walletId, currency })),
      resolution,
    };
    if (!capture.authorize(result)) throw new Error('Wallet statement authority changed');
    return result;
  }
  /** Select exact native opening equity for an ordinary independently approved wallet account proposal. */
  async prepareMaterialization(
    actor: MerchantActor,
    value: unknown,
  ): Promise<AtomicConsequentialActionIntent> {
    const input = walletMaterializationSelectorSchema.parse(value),
      current = await this.context(actor);
    if (current.resolution.resolutionHash !== input.resolutionHash)
      throw new Error('Wallet statement resolution changed');
    const anchors = current.resolution.wallets
      .filter((wallet) => wallet.walletId === input.walletId)
      .flatMap((wallet) => wallet.balanceAnchors ?? [])
      .filter(
        (anchor) =>
          anchor.boundary === 'before_day_activity' &&
          anchor.asOfDate === input.asOfDate &&
          anchor.proofSetHash === input.proofSetHash &&
          anchor.activityManifestHash === input.activityManifestHash &&
          anchor.amount.minorUnits !== '0',
      );
    const unique = [
      ...new Map(anchors.map((anchor) => [canonicalProposalJson(anchor), anchor])).values(),
    ];
    const anchor = unique[0];
    if (unique.length !== 1 || !anchor)
      throw new Error('Current exact before-day wallet opening anchor required');
    return {
      kind: 'wallet_materialization',
      walletId: anchor.walletId,
      accountName: input.accountName,
      currency: anchor.amount.currency,
      opening: {
        amount: anchor.amount,
        date: anchor.asOfDate,
        proofSetHash: anchor.proofSetHash,
        activityManifestHash: anchor.activityManifestHash,
      },
    };
  }
  private async prepare(actor: MerchantActor, value: unknown) {
    const input = walletStatementPreviewInputSchema.parse(value),
      review = this.scope(actor),
      capture = await this.host.capture(actor);
    const access = this.host.access(actor, capture.scope),
      state = this.host.store.evidence.walletStatements.state(access, review);
    const statement = capture.documents.find(
      (document) => document.id === input.statementDocumentId,
    );
    if (!statement) throw new Error('Current authorized original statement required');
    const raw = await this.host.readOriginal(actor, statement.id);
    if (!raw || createHash('sha256').update(raw).digest('hex') !== statement.contentHash)
      throw new Error('Current authorized original raw statement required');
    const request = structuredClone(capture.request);
    let wallet;
    if (input.wallet.kind === 'existing') {
      const identity = input.wallet.walletId;
      wallet = request.wallets.find((entry) => entry.walletId === identity);
      if (!wallet) throw new Error('Current wallet identity required');
    } else {
      const identity = qualifiedWalletId(capture.scope, statement, input.wallet.label);
      wallet = request.wallets.find((entry) => entry.walletId === identity);
      if (wallet && wallet.currency !== input.wallet.currency)
        throw new Error('Wallet currency conflict');
      if (!wallet) {
        wallet = {
          walletId: identity,
          currency: input.wallet.currency,
          openingBalance: null,
          closingBalance: null,
          completeActivity: false,
          materializedAccountId: null,
          requiresStoredValue: true,
        };
        request.wallets.push(wallet);
      }
    }
    if (
      [input.openingBalance, input.closingBalance].some(
        (amount) => amount && amount.currency !== wallet.currency,
      )
    )
      throw new Error('Statement currency mismatch');
    if (!this.host.native.deriveWalletStatementPreview)
      throw new Error('Native statement review unavailable');
    const native = WalletStatementPreviewSchema.parse(
      JSON.parse(
        this.host.native.deriveWalletStatementPreview(
          JSON.stringify({
            contractVersion: '1',
            evidence: request,
            walletId: wallet.walletId,
            startDate: input.startDate,
            endDate: input.endDate,
          }),
        ),
      ),
    );
    const proof = WalletStatementProofSchema.parse({
      proofId: `statement:${digest([capture.scope, actor.actorId, statement.id, wallet.walletId, input.startDate, input.endDate])}`,
      authorityKind: 'human_attested_statement',
      statement: {
        documentId: statement.id,
        contentHash: statement.contentHash,
        parserVersion: statement.parserVersion,
      },
      walletId: wallet.walletId,
      currency: wallet.currency,
      calendarBasis: 'statement_printed_date',
      startDate: input.startDate,
      endDate: input.endDate,
      openingBalance: input.openingBalance,
      closingBalance: input.closingBalance,
      activityManifest: native.activityManifest,
      actorId: actor.actorId,
      ...review,
      reviewedAt: this.host.now(),
    });
    const base = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.host.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    request.statementProofs = [
      ...state.proofs.filter((previous) => previous.proofId !== proof.proofId),
      proof,
    ];
    const resolution = TransactionEvidenceResultSchema.parse(
      JSON.parse(this.host.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
    const { reviewedAt: _time, ...claims } = proof;
    const previewHash = digest({
      input,
      claims,
      native,
      proofFoldHash: state.foldHash,
      baseResolutionHash: base.resolutionHash,
    });
    if (
      !capture.authorize({ proof, resolution }) ||
      this.host.store.evidence.walletStatements.state(
        this.host.access(actor, capture.scope),
        review,
      ).foldHash !== state.foldHash
    )
      throw new Error('Wallet statement source or authority changed');
    return {
      capture,
      proof,
      input,
      public: { previewHash, proofFoldHash: state.foldHash, proof, native, resolution },
    };
  }
  /** Preview exact original, native activity manifest and bounded balance diagnostics without recording approval. */
  async preview(actor: MerchantActor, value: unknown) {
    return (await this.prepare(actor, value)).public;
  }
  /** Reread the exact original and rederive claims before atomically recording fresh human attestation. */
  async attest(actor: MerchantActor, value: unknown) {
    const all = walletStatementAttestInputSchema.parse(value);
    const {
      previewHash,
      expectedProofFoldHash,
      originalAcknowledged,
      completeActivityAcknowledged,
      ...selector
    } = all;
    const confirmation = attestation.parse({
      previewHash,
      expectedProofFoldHash,
      originalAcknowledged,
      completeActivityAcknowledged,
    });
    this.host.fresh(actor);
    const prepared = await this.prepare(actor, selector);
    this.host.fresh(actor);
    if (
      prepared.public.previewHash !== confirmation.previewHash ||
      prepared.public.proofFoldHash !== confirmation.expectedProofFoldHash
    )
      throw new Error('Wallet statement preview changed');
    if (!prepared.capture.authorize(prepared.proof))
      throw new Error('Wallet statement authority changed');
    this.host.store.evidence.walletStatements.attest(
      this.host.access(
        actor,
        prepared.capture.scope,
        prepared.capture.documents,
        prepared.proof,
        'approve',
      ),
      { proof: prepared.proof, expectedFoldHash: confirmation.expectedProofFoldHash },
      this.host.key,
    );
    return { proof: prepared.proof, ...(await this.state(actor)) };
  }
  /** Revoke under fresh current authority even when source bytes were deleted or superseded. */
  async revoke(actor: MerchantActor, value: unknown) {
    const input = walletStatementRevokeInputSchema.parse(value);
    this.host.fresh(actor);
    const capture = await this.host.capture(actor);
    this.host.fresh(actor);
    if (!capture.authorize()) throw new Error('Wallet statement authority changed');
    this.host.store.evidence.walletStatements.revoke(
      this.host.access(actor, capture.scope, undefined, undefined, 'approve'),
      {
        proofId: input.proofId,
        expectedFoldHash: input.expectedProofFoldHash,
        ...this.scope(actor),
      },
    );
    return this.state(actor);
  }
}
