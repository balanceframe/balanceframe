import { z } from 'zod';
import {
  CompareSpendSessionReceiptResultSchema,
  SessionReceiptReviewSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  CompareSpendSessionReceiptResult,
  SessionReceiptSnapshot,
  TransactionEvidenceRequest,
} from '@balanceframe/protocol-generated';
import type {
  EvidenceAccess,
  EvidenceDocument,
  EvidenceScope,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import type { MerchantActor } from './merchant-service.js';

const id = z.string().trim().min(1).max(256);
const selector = z.object({ sessionDocumentId: id }).strict();
const compareInput = selector
  .extend({
    receipt: z.object({ documentId: id, receiptId: id }).strict(),
    review: SessionReceiptReviewSchema,
  })
  .strict();
const saveInput = compareInput
  .extend({ comparisonHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
/** A source capture is authorized by the existing evidence service, including its Actual read context. */
export interface SpendSessionReceiptCapture {
  scope: EvidenceScope;
  documents: EvidenceDocument[];
  request: TransactionEvidenceRequest;
  authorize: (additional?: unknown) => boolean;
}
/** Internal composition supplies current authorization; HTTP cannot provide snapshots or native results. */
export interface SpendSessionReceiptHost {
  store: WorkflowStore;
  native: { compareSpendSessionReceipt?(input: string): string };
  now: () => string;
  capture: (actor: MerchantActor) => Promise<SpendSessionReceiptCapture>;
  access: (
    actor: MerchantActor,
    scope: EvidenceScope,
    documents?: EvidenceDocument[],
    additional?: unknown,
    phase?: 'approve',
  ) => EvidenceAccess;
}
/** Compare server-owned archived intent with receipt evidence without acquiring financial write authority. */
export class SpendSessionReceiptService {
  constructor(private readonly host: SpendSessionReceiptHost) {}
  private fresh(actor: MerchantActor): void {
    const auth = actor.auth;
    const now = Date.parse(this.host.now());
    if (
      auth.method !== 'human-session' ||
      auth.actorId !== actor.actorId ||
      !auth.sessionId.trim() ||
      !Number.isFinite(Date.parse(auth.reauthenticatedAt)) ||
      Date.parse(auth.reauthenticatedAt) > now ||
      now - Date.parse(auth.reauthenticatedAt) > 300000
    )
      throw new Error('Fresh human receipt association review required');
  }
  private versionCurrent(actor: MerchantActor, snapshot: SessionReceiptSnapshot): boolean {
    return this.host.store.liquidity.hasCurrentSpendSessionVersion({
      ...actor,
      id: snapshot.intent.id,
      expectedVersion: snapshot.intent.version,
      now: this.host.now(),
    });
  }
  private snapshot(
    actor: MerchantActor,
    capture: SpendSessionReceiptCapture,
    documentId: string,
  ): SessionReceiptSnapshot {
    if (
      !capture.authorize() ||
      capture.request.policyVersion !== actor.governancePolicyVersion ||
      !capture.documents.some((document) => document.id === documentId)
    )
      throw new Error('Session snapshot source is not authorized');
    const access = this.host.access(actor, capture.scope);
    const snapshot = this.host.store.evidence.sessionSnapshots.get(access, documentId);
    if (!snapshot || !this.versionCurrent(actor, snapshot))
      throw new Error('Saved session snapshot version changed or is not authorized');
    return snapshot;
  }
  private fence(
    actor: MerchantActor,
    capture: SpendSessionReceiptCapture,
    snapshot: SessionReceiptSnapshot,
    additional?: unknown,
  ): void {
    const access = this.host.access(actor, capture.scope, capture.documents, additional);
    if (
      !capture.authorize(additional) ||
      !this.versionCurrent(actor, snapshot) ||
      capture.documents.some(
        (document) => !this.host.store.evidence.isCurrent(access, document.id),
      ) ||
      this.host.store.evidence.sessionSnapshots.get(access, snapshot.documentId)?.intentHash !==
        snapshot.intentHash
    )
      throw new Error('Receipt comparison source or authorization changed');
  }
  private async evaluate(actor: MerchantActor, value: unknown) {
    const input = compareInput.parse(value);
    const capture = await this.host.capture(actor);
    const snapshot = this.snapshot(actor, capture, input.sessionDocumentId);
    const receipt = capture.request.receipts.find(
      (candidate) => candidate.id === input.receipt.receiptId,
    );
    const observation = capture.request.observations.find(
      (candidate) => candidate.id === receipt?.observationId,
    );
    if (
      !receipt ||
      observation?.provenance.documentId !== input.receipt.documentId ||
      !capture.documents.some((document) => document.id === input.receipt.documentId)
    )
      throw new Error('Receipt comparison source changed');
    if (!this.host.native.compareSpendSessionReceipt)
      throw new Error('Native receipt comparison unavailable');
    this.fence(actor, capture, snapshot);
    const result = CompareSpendSessionReceiptResultSchema.parse(
      JSON.parse(
        this.host.native.compareSpendSessionReceipt(
          JSON.stringify({
            contractVersion: '1',
            sessionSnapshot: snapshot,
            evidence: capture.request,
            receipt: input.receipt,
            review: input.review,
          }),
        ),
      ) as unknown,
    );
    if (
      result.sessionDocumentId !== snapshot.documentId ||
      result.sessionId !== snapshot.intent.id ||
      result.sessionVersion !== snapshot.intent.version ||
      result.intentHash !== snapshot.intentHash ||
      result.receiptDocumentId !== input.receipt.documentId ||
      result.receiptId !== input.receipt.receiptId
    )
      throw new Error('Native receipt comparison identity changed');
    this.fence(actor, capture, snapshot, result);
    return { input, capture, snapshot, result };
  }
  /** Recompute a native comparison from selectors and explicit reviewed mappings only. */
  async compare(actor: MerchantActor, value: unknown): Promise<CompareSpendSessionReceiptResult> {
    return (await this.evaluate(actor, value)).result;
  }
  /** Save the exact displayed result after fresh human review, without completing or writing Actual. */
  async save(actor: MerchantActor, value: unknown) {
    this.fresh(actor);
    const { comparisonHash, ...input } = saveInput.parse(value);
    const evaluated = await this.evaluate(actor, input);
    if (evaluated.result.comparisonHash !== comparisonHash)
      throw new Error('Receipt comparison changed');
    this.fresh(actor);
    this.fence(actor, evaluated.capture, evaluated.snapshot, evaluated.result);
    return this.host.store.evidence.sessionSnapshots.saveAssociation(
      this.host.access(
        actor,
        evaluated.capture.scope,
        evaluated.capture.documents,
        evaluated.result,
        'approve',
      ),
      {
        result: evaluated.result,
        review: input.review,
        policyVersion: actor.governancePolicyVersion,
        membershipId: actor.membershipId,
      },
      (snapshot) => this.versionCurrent(actor, snapshot),
    );
  }
  /** Publish authorized receipt choices and existing completion identities for one exact archived session. */
  async context(actor: MerchantActor, value: unknown) {
    const input = selector.parse(value);
    const capture = await this.host.capture(actor);
    const snapshot = this.snapshot(actor, capture, input.sessionDocumentId);
    const receipts = capture.request.receipts.flatMap((receipt) => {
      const observation = capture.request.observations.find(
        (candidate) => candidate.id === receipt.observationId,
      );
      return observation &&
        capture.documents.some((document) => document.id === observation.provenance.documentId)
        ? [
            {
              documentId: observation.provenance.documentId,
              receiptId: receipt.id,
              counterparty: observation.counterparty,
              date: observation.date,
              amount: receipt.total,
              lines: receipt.lines.map((line) => ({
                id: line.id,
                description: line.rawDescription,
              })),
            },
          ]
        : [];
    });
    const associations = this.host.store.evidence.sessionSnapshots.associations(
      this.host.access(actor, capture.scope),
      snapshot.documentId,
      { policyVersion: actor.governancePolicyVersion, membershipId: actor.membershipId },
      (current) => this.versionCurrent(actor, current),
    );
    let completionReferences: Array<{
      proposalId: string;
      manualTransactionId: string | null;
      importedTransactionId: string | null;
    }> = [];
    try {
      completionReferences = this.host.store.liquidity
        .listSessionCompletionProposals({
          ...actor,
          sessionId: snapshot.intent.id,
          now: this.host.now(),
        })
        .map((proposal) => ({
          proposalId: proposal.id,
          manualTransactionId: proposal.manualTransactionId,
          importedTransactionId: proposal.importedTransactionId,
        }));
    } catch {
      // Completion identities have independent financial disclosure rights.
    }
    const result = { snapshot, receipts, associations, completionReferences };
    this.fence(actor, capture, snapshot, result);
    return result;
  }
}

/** HTTP inputs contain selectors and reviewed mappings; snapshots, identities and financial facts are server-owned. */
export {
  selector as spendSessionReceiptSelectorSchema,
  compareInput as spendSessionReceiptCompareSchema,
  saveInput as spendSessionReceiptSaveSchema,
};
