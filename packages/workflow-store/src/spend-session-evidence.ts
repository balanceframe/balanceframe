import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  CompareSpendSessionReceiptResultSchema,
  SessionReceiptReviewSchema,
  SavedSessionReceiptIntentSchema,
  SessionReceiptSnapshotSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  SavedSessionReceiptIntent,
  SessionReceiptSnapshot,
} from '@balanceframe/protocol-generated';
import type { EvidenceAccess, EvidenceDocument } from './transaction-evidence.js';
import { canonicalProposalJson } from './proposal.js';

const contextSchema = z.object({
  policyVersion: z.string().min(1).max(256),
  membershipId: z.string().min(1).max(256),
});
const associationInputSchema = contextSchema
  .extend({ result: CompareSpendSessionReceiptResultSchema, review: SessionReceiptReviewSchema })
  .strict();
const associationSchema = associationInputSchema
  .extend({ actorId: z.string().min(1), at: z.string().datetime() })
  .strict();
/** An immutable reviewed comparison links evidence only; it never completes a session or consumes claims. */
export type SpendSessionReceiptAssociation = z.infer<typeof associationSchema>;
const namespace = (access: EvidenceAccess): string =>
  JSON.stringify([access.scope.spaceId, access.scope.budgetId, access.scope.connectionId]);
const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
/** Keep server-observed saved-session origin separate from untrusted imported extraction fields. */
export function migrateSpendSessionEvidence(db: Database): void {
  db.exec(`CREATE TABLE transaction_evidence_session_origins (scope_key TEXT NOT NULL, document_id TEXT NOT NULL, actor_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope_key,document_id));
    CREATE TABLE transaction_evidence_session_associations (scope_key TEXT NOT NULL, actor_id TEXT NOT NULL, comparison_hash TEXT NOT NULL, session_document_id TEXT NOT NULL, session_id TEXT NOT NULL, receipt_source_key TEXT NOT NULL, receipt_content_hash TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope_key,actor_id,comparison_hash));`);
}
/** Read immutable saved-session snapshots only through current scoped source authorization. */
export class SpendSessionEvidenceWorkflow {
  constructor(
    private readonly db: Database,
    private readonly source: (
      access: EvidenceAccess,
      documentId: string,
    ) => EvidenceDocument | null,
  ) {}
  /** Internal admission follows a current authorized saved-session read; uploads cannot call this path. */
  admit(
    access: EvidenceAccess,
    document: EvidenceDocument,
    value: SavedSessionReceiptIntent,
  ): void {
    const intent = SavedSessionReceiptIntentSchema.parse(value);
    const documentId = document.id;
    const stored = this.db
      .prepare('SELECT value FROM transaction_evidence_documents WHERE scope_key=? AND id=?')
      .get(namespace(access), documentId) as { value: string } | undefined;
    const current = this.db
      .prepare(
        "SELECT id FROM transaction_evidence_documents WHERE scope_key=? AND connector_id=? AND source_id=? AND json_extract(value,'$.privateActorId') IS ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(namespace(access), document.connectorId, document.sourceId, access.actorId) as
      { id: string } | undefined;
    if (
      !stored ||
      canonicalProposalJson(JSON.parse(stored.value) as unknown) !==
        canonicalProposalJson(document) ||
      current?.id !== documentId ||
      canonicalProposalJson(document.scope) !== canonicalProposalJson(access.scope) ||
      !access.authorize({ capability: 'ingest', document: null, scope: access.scope }) ||
      document.privateActorId !== access.actorId ||
      document.connectorId !== 'spend-session' ||
      document.sourceId !== `session:${intent.id}` ||
      document.parserVersion !== 'spend-session-snapshot-v1' ||
      document.mediaType !== 'application/json' ||
      document.parseStatus !== 'parsed' ||
      document.contentHash !== digest(intent)
    )
      throw new Error('Saved session snapshot source is not authorized or exact');
    const snapshot: SessionReceiptSnapshot = {
      documentId: document.id,
      contentHash: document.contentHash,
      parserVersion: document.parserVersion,
      intentHash: document.contentHash,
      intent,
    };
    const encoded = canonicalProposalJson(snapshot);
    const prior = this.db
      .prepare(
        'SELECT actor_id,value FROM transaction_evidence_session_origins WHERE scope_key=? AND document_id=?',
      )
      .get(namespace(access), documentId) as { actor_id: string; value: string } | undefined;
    if (prior && (prior.actor_id !== access.actorId || prior.value !== encoded))
      throw new Error('Saved session snapshot origin is immutable');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO transaction_evidence_session_origins(scope_key,document_id,actor_id,value) VALUES(?,?,?,?)',
      )
      .run(namespace(access), documentId, access.actorId, encoded);
  }
  /** Absence of an origin record always abstains, regardless of connector names or uploaded flags. */
  get(access: EvidenceAccess, documentId: string): SessionReceiptSnapshot | null {
    const document = this.source(access, documentId);
    if (!document) return null;
    const row = this.db
      .prepare(
        'SELECT value FROM transaction_evidence_session_origins WHERE scope_key=? AND document_id=? AND actor_id=?',
      )
      .get(namespace(access), documentId, access.actorId) as { value: string } | undefined;
    if (!row) return null;
    const snapshot = SessionReceiptSnapshotSchema.safeParse(JSON.parse(row.value) as unknown);
    if (
      !snapshot.success ||
      snapshot.data.documentId !== document.id ||
      snapshot.data.contentHash !== document.contentHash ||
      snapshot.data.parserVersion !== document.parserVersion ||
      snapshot.data.intentHash !== digest(snapshot.data.intent)
    )
      return null;
    return snapshot.data;
  }
  /** Persist a freshly reviewed exact comparison under current source and session-version fences. */
  saveAssociation(
    access: EvidenceAccess,
    value: unknown,
    versionCurrent: (snapshot: SessionReceiptSnapshot) => boolean,
  ): SpendSessionReceiptAssociation {
    const input = associationInputSchema.parse(value);
    return this.db
      .transaction(() => {
        const snapshot = this.get(access, input.result.sessionDocumentId);
        const receipt = this.source(access, input.result.receiptDocumentId);
        if (
          !snapshot ||
          !receipt ||
          input.result.state === 'blocked' ||
          snapshot.intent.id !== input.result.sessionId ||
          snapshot.intent.version !== input.result.sessionVersion ||
          snapshot.intentHash !== input.result.intentHash ||
          !versionCurrent(snapshot) ||
          !access.authorize({ capability: 'resolve', document: null, scope: access.scope })
        )
          throw new Error('Receipt association source, session or authority changed');
        const sourceKey = canonicalProposalJson([
          receipt.connectorId,
          receipt.sourceId,
          receipt.privateActorId,
        ]);
        const reservations = this.db
          .prepare(
            'SELECT session_id FROM transaction_evidence_session_associations WHERE scope_key=? AND actor_id=? AND (receipt_source_key=? OR receipt_content_hash=?)',
          )
          .all(namespace(access), access.actorId, sourceKey, receipt.contentHash) as {
          session_id: string;
        }[];
        if (reservations.some((entry) => entry.session_id !== snapshot.intent.id))
          throw new Error('Receipt is already associated with another saved session');
        const prior = this.db
          .prepare(
            'SELECT value FROM transaction_evidence_session_associations WHERE scope_key=? AND actor_id=? AND comparison_hash=?',
          )
          .get(namespace(access), access.actorId, input.result.comparisonHash) as
          { value: string } | undefined;
        if (prior) {
          const stored = associationSchema.parse(JSON.parse(prior.value) as unknown);
          const { actorId: _actor, at: _at, ...payload } = stored;
          if (canonicalProposalJson(payload) !== canonicalProposalJson(input))
            throw new Error('Receipt association is immutable');
          return stored;
        }
        const record = associationSchema.parse({
          ...input,
          actorId: access.actorId,
          at: access.now,
        });
        this.db
          .prepare(
            'INSERT INTO transaction_evidence_session_associations(scope_key,actor_id,comparison_hash,session_document_id,session_id,receipt_source_key,receipt_content_hash,value) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            namespace(access),
            access.actorId,
            input.result.comparisonHash,
            snapshot.documentId,
            snapshot.intent.id,
            sourceKey,
            receipt.contentHash,
            canonicalProposalJson(record),
          );
        return record;
      })
      .immediate();
  }
  /** Read only the caller's still-current reviewed comparisons under exact current policy and membership. */
  associations(
    access: EvidenceAccess,
    documentId: string,
    value: unknown,
    versionCurrent: (snapshot: SessionReceiptSnapshot) => boolean,
  ): SpendSessionReceiptAssociation[] {
    const context = contextSchema.parse(value);
    const snapshot = this.get(access, documentId);
    if (!snapshot || !versionCurrent(snapshot)) return [];
    const rows = this.db
      .prepare(
        'SELECT value FROM transaction_evidence_session_associations WHERE scope_key=? AND actor_id=? AND session_document_id=? ORDER BY rowid',
      )
      .all(namespace(access), access.actorId, documentId) as { value: string }[];
    return rows.flatMap((row) => {
      const parsed = associationSchema.safeParse(JSON.parse(row.value) as unknown);
      if (
        !parsed.success ||
        parsed.data.actorId !== access.actorId ||
        parsed.data.policyVersion !== context.policyVersion ||
        parsed.data.membershipId !== context.membershipId ||
        parsed.data.result.intentHash !== snapshot.intentHash ||
        !this.source(access, parsed.data.result.receiptDocumentId)
      )
        return [];
      return [parsed.data];
    });
  }
}
