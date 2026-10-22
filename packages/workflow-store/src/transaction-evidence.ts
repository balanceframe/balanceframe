import { ReceiptInferenceWorkflow } from './receipt-inference.js';
export * from './receipt-inference.js';
import {ReceiptVersionWorkflow} from './receipt-version.js';
export * from './receipt-version.js';
import { WalletStatementWorkflow } from './wallet-statement.js';
import {
  evidenceReceiptAnnotationSchema,
  receiptAnnotationKey,
  type EvidenceReceiptAnnotation,
} from './evidence-receipt-annotations.js';
export {
  evidenceReceiptAnnotationSchema,
  receiptAnnotationKey,
  type EvidenceReceiptAnnotation,
} from './evidence-receipt-annotations.js';
import {
  evidenceItemCategoryDecisionSchema,
  type EvidenceItemCategoryDecision,
} from './evidence-item-categories.js';
export {
  evidenceItemCategoryDecisionSchema,
  type EvidenceItemCategoryDecision,
} from './evidence-item-categories.js';
import { SpendSessionEvidenceWorkflow } from './spend-session-evidence.js';
import type { SavedSessionReceiptIntent } from '@balanceframe/protocol-generated';
import { EvidenceItemRuleWorkflow } from './evidence-item-rules.js';
import type { Database } from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EvidenceRelationshipSchema,
  EvidenceAllocationReviewSchema,
  economicEventLedgerEffectSchema,
  EvidenceObservationSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  EvidenceRelationship,
  EvidenceAllocationReview,
  EconomicEventLedgerEffect,
  EvidenceObservation,
  EvidenceProvenance,
} from '@balanceframe/protocol-generated';

const id = z.string().trim().min(1).max(512);
const timestamp = z.string().datetime();
const scopeSchema = z.object({ spaceId: id, budgetId: id, connectionId: id }).strict();
const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string().max(100000),
    z.boolean(),
    z.number().finite(),
    z.array(json).max(100000),
    z.record(json),
  ]),
);
const inputSchema = z
  .object({
    connectorId: id,
    sourceId: id,
    sourceTimestamp: timestamp,
    mediaType: id,
    parserVersion: id,
    privateActorId: id.nullable(),
    retentionUntil: timestamp,
    parseStatus: z.enum(['parsed', 'malformed', 'unsupported_template', 'source_conflict']),
    quality: z.array(id).max(100),
    extraction: z.record(json),
    content: z
      .instanceof(Buffer)
      .refine((value) => value.length > 0 && value.length <= 10 * 1024 * 1024),
  })
  .strict();
/** Exact database namespace; a budget alone never authorizes evidence. */
export type EvidenceScope = z.infer<typeof scopeSchema>;
/** Current server authority is rechecked for each read or write. */
export interface EvidenceAccess {
  scope: EvidenceScope;
  actorId: string;
  now: string;
  authorize: (context: {
    capability:
      | 'ingest'
      | 'normalized-evidence'
      | 'raw-document'
      | 'delete'
      | 'resolve'
      | 'observe'
      | 'item-rule:propose'
      | 'item-rule:approve'
      | 'item-rule:read'
      | 'receipt-inference:local'
      | 'receipt-inference:external'
      | 'receipt-inference:policy:manage';
    document: EvidenceDocument | null;
    scope: EvidenceScope;
  }) => boolean;
}
/** Immutable source and extraction; raw deletion is separate lifecycle metadata. */
export interface EvidenceDocument {
  id: string;
  scope: EvidenceScope;
  connectorId: string;
  sourceId: string;
  sourceTimestamp: string;
  receivedAt: string;
  mediaType: string;
  parserVersion: string;
  privateActorId: string | null;
  retentionUntil: string;
  parseStatus: z.infer<typeof inputSchema>['parseStatus'];
  contentHash: string;
  supersedesId: string | null;
  quality: string[];
  extraction: Record<string, unknown>;
}
/** Authenticated normalized ingestion; content is encrypted before SQLite receives bytes. */
export type EvidenceIngestInput = z.infer<typeof inputSchema>;
/** Content-free lifecycle evidence survives raw retention. */
export interface EvidenceResolutionDecision {
  allocationReview?: EvidenceAllocationReview;
  receiptAnnotations?: EvidenceReceiptAnnotation[];
  receiptAnnotationBaseHash?: string;
  itemCategoryDecisions?: EvidenceItemCategoryDecision[];
  itemCategoryBaseHash?: string;
  ledgerSources?: Array<{ ledgerTransactionId: string; contentHash: string }>;
  resolutionHash: string;
  documentIds: string[];
  relationships: EvidenceRelationship[];
  ledgerEffects?: Array<{ observationId: string; effect: EconomicEventLedgerEffect }>;
  purposeDecisions?: Array<{ observationId: string; eventType: EvidenceObservation['eventType'] }>;
}
export interface EvidenceAudit {
  action: 'ingested' | 'duplicate_received' | 'raw_deleted' | 'raw_expired';
  at: string;
  actorId: string;
  contentHash: string;
}
const namespace = (scope: EvidenceScope) =>
  JSON.stringify([scope.spaceId, scope.budgetId, scope.connectionId]);
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null');
type Row = { value: string; ciphertext: Buffer | null; iv: Buffer | null; tag: Buffer | null };
/** Add immutable scoped evidence, encrypted content, and minimal provenance tables. */
export function migrateTransactionEvidence(db: Database): void {
  db.exec(`CREATE TABLE transaction_evidence_documents (scope_key TEXT NOT NULL, id TEXT NOT NULL, connector_id TEXT NOT NULL, source_id TEXT NOT NULL, content_hash TEXT NOT NULL, parser_version TEXT NOT NULL, value TEXT NOT NULL, ciphertext BLOB, iv BLOB, tag BLOB, PRIMARY KEY(scope_key,id), UNIQUE(scope_key,connector_id,source_id,content_hash,parser_version));
    CREATE TABLE transaction_evidence_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, document_id TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE transaction_evidence_decisions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, actor_id TEXT NOT NULL, source_hash TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE transaction_evidence_resolutions (scope_key TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope_key,id));`);
}
/** Separate each private owner's delivery identity from shared imports without rewriting immutable content. */
export function migrateEvidenceOwnerNamespace(db: Database): void {
  db.exec(`CREATE TABLE transaction_evidence_documents_v29 (scope_key TEXT NOT NULL, id TEXT NOT NULL, connector_id TEXT NOT NULL, source_id TEXT NOT NULL, content_hash TEXT NOT NULL, parser_version TEXT NOT NULL, value TEXT NOT NULL, ciphertext BLOB, iv BLOB, tag BLOB, PRIMARY KEY(scope_key,id));
    INSERT INTO transaction_evidence_documents_v29 SELECT * FROM transaction_evidence_documents;
    DROP TABLE transaction_evidence_documents;
    ALTER TABLE transaction_evidence_documents_v29 RENAME TO transaction_evidence_documents;
    CREATE UNIQUE INDEX transaction_evidence_delivery_owner ON transaction_evidence_documents(scope_key,connector_id,source_id,content_hash,parser_version,coalesce(json_extract(value,'$.privateActorId'),''));`);
}
/** Preserve real first-observed ledger provenance independently of volatile snapshot capture identities. */
export function migrateEvidenceLedgerProvenance(db: Database): void {
  db.exec(
    'CREATE TABLE transaction_evidence_ledger_provenance (scope_key TEXT NOT NULL, transaction_id TEXT NOT NULL, content_hash TEXT NOT NULL, parser_version TEXT NOT NULL, first_observed_at TEXT NOT NULL, PRIMARY KEY(scope_key,transaction_id,content_hash,parser_version))',
  );
}
/** Evidence persistence uses the workflow database transaction fence. */
export class TransactionEvidenceWorkflow {
  readonly receiptInference: ReceiptInferenceWorkflow;
  readonly itemRules: EvidenceItemRuleWorkflow;
  readonly walletStatements: WalletStatementWorkflow;
  readonly receiptVersions: ReceiptVersionWorkflow;
  readonly sessionSnapshots: SpendSessionEvidenceWorkflow;
  constructor(private readonly db: Database) {
    this.receiptInference = new ReceiptInferenceWorkflow(
      db,
      (access, id) => this.get(access, id),
      (access, id) => this.isCurrent(access, id),
    );
    this.receiptVersions = new ReceiptVersionWorkflow(db,(access,id)=>this.get(access,id),(access,id)=>this.isCurrent(access,id));
    this.walletStatements = new WalletStatementWorkflow(
      db,
      (access, id) => (this.isCurrent(access, id) ? this.get(access, id) : null),
      (access, id, key) => this.readRaw(access, id, key),
    );
    this.sessionSnapshots = new SpendSessionEvidenceWorkflow(db, (access, identity) =>
      this.isCurrent(access, identity) ? this.get(access, identity) : null,
    );
    this.itemRules = new EvidenceItemRuleWorkflow(
      db,
      (access, identities) =>
        identities.length > 0 && identities.every((identity) => this.isCurrent(access, identity)),
    );
  }
  /** Atomically archive exact server-owned session bytes and their independently admitted origin. */
  archiveSpendSession(
    access: EvidenceAccess,
    input: EvidenceIngestInput,
    intent: SavedSessionReceiptIntent,
    key: Buffer,
  ) {
    return this.db
      .transaction(() => {
        const archived = this.ingest(access, input, key);
        this.sessionSnapshots.admit(access, archived.document, intent);
        return archived;
      })
      .immediate();
  }
  /** Bind identical authoritative ledger content to its first real observed timestamp, without publishing ledger data. */
  ledgerProvenance(
    access: EvidenceAccess,
    input: {
      transactionId: string;
      contentHash: string;
      parserVersion: string;
      observedAt: string;
    },
  ): EvidenceProvenance {
    this.validate(access);
    id.parse(input.transactionId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.contentHash);
    id.parse(input.parserVersion);
    timestamp.parse(input.observedAt);
    if (!this.allowed(access, 'resolve', null))
      throw new Error('Evidence operation is not authorized');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO transaction_evidence_ledger_provenance(scope_key,transaction_id,content_hash,parser_version,first_observed_at) VALUES(?,?,?,?,?)',
      )
      .run(
        namespace(access.scope),
        input.transactionId,
        input.contentHash,
        input.parserVersion,
        input.observedAt,
      );
    const row = this.db
      .prepare(
        'SELECT first_observed_at FROM transaction_evidence_ledger_provenance WHERE scope_key=? AND transaction_id=? AND content_hash=? AND parser_version=?',
      )
      .get(
        namespace(access.scope),
        input.transactionId,
        input.contentHash,
        input.parserVersion,
      ) as { first_observed_at: string };
    return {
      documentId: `actual:${input.contentHash}`,
      contentHash: input.contentHash,
      parserVersion: input.parserVersion,
      sourceTimestamp: row.first_observed_at,
      receivedAt: row.first_observed_at,
    };
  }
  /** Destroy expired ciphertext across every scope without granting or publishing content access. */
  expireRaw(now: string): number {
    timestamp.parse(now);
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            "SELECT value FROM transaction_evidence_documents WHERE ciphertext IS NOT NULL AND julianday(json_extract(value,'$.retentionUntil'))<=julianday(?)",
          )
          .all(now) as { value: string }[];
        let expired = 0;
        for (const row of rows) {
          const document = JSON.parse(row.value) as EvidenceDocument;
          if (
            this.erase(
              { scope: document.scope, actorId: 'system:retention', now, authorize: () => false },
              document,
              'raw_expired',
            )
          )
            expired += 1;
        }
        return expired;
      })
      .immediate();
  }
  /** Fail closed after backup restore: never revive raw deletions or previously approved derived actions. */
  quarantineRestore(now: string): void {
    timestamp.parse(now);
    const rows = this.db
      .prepare('SELECT value FROM transaction_evidence_documents WHERE ciphertext IS NOT NULL')
      .all() as { value: string }[];
    for (const row of rows) {
      const document = JSON.parse(row.value) as EvidenceDocument;
      this.erase(
        { scope: document.scope, actorId: 'system:restore', now, authorize: () => true },
        document,
        'raw_deleted',
      );
    }
    this.db.exec(
      'DELETE FROM transaction_evidence_decisions; DELETE FROM transaction_evidence_resolutions; DELETE FROM transaction_evidence_item_rule_approvals; DELETE FROM transaction_evidence_item_rules; DELETE FROM transaction_evidence_session_origins; DELETE FROM transaction_evidence_session_associations;',
    );
  }
  private validate(access: EvidenceAccess): void {
    scopeSchema.parse(access.scope);
    id.parse(access.actorId);
    timestamp.parse(access.now);
    if (typeof access.authorize !== 'function')
      throw new Error('Evidence authorization unavailable');
  }
  private allowed(
    access: EvidenceAccess,
    capability: Parameters<EvidenceAccess['authorize']>[0]['capability'],
    document: EvidenceDocument | null,
  ): boolean {
    if (document?.privateActorId && document.privateActorId !== access.actorId) return false;
    return (
      access.authorize({
        scope: structuredClone(access.scope),
        capability,
        document: structuredClone(document),
      }) === true
    );
  }
  private row(access: EvidenceAccess, identity: string): Row | undefined {
    return this.db
      .prepare(
        'SELECT value,ciphertext,iv,tag FROM transaction_evidence_documents WHERE scope_key=? AND id=?',
      )
      .get(namespace(access.scope), id.parse(identity)) as Row | undefined;
  }
  private append(
    access: EvidenceAccess,
    document: EvidenceDocument,
    action: EvidenceAudit['action'],
  ): void {
    this.db
      .prepare('INSERT INTO transaction_evidence_audit(scope_key,document_id,value) VALUES(?,?,?)')
      .run(
        namespace(access.scope),
        document.id,
        JSON.stringify({
          action,
          at: access.now,
          actorId: access.actorId,
          contentHash: document.contentHash,
        }),
      );
  }
  /** Save immutable normalization and AES-256-GCM raw content; exact delivery is idempotent. */
  ingest(
    access: EvidenceAccess,
    untrusted: EvidenceIngestInput,
    key: Buffer,
  ): { document: EvidenceDocument; duplicate: boolean } {
    this.validate(access);
    const input = inputSchema.parse(untrusted);
    if (
      key.length !== 32 ||
      Date.parse(input.retentionUntil) <= Date.parse(access.now) ||
      Date.parse(input.retentionUntil) - Date.parse(access.now) > 30 * 86400000
    )
      throw new Error('Invalid evidence retention or encryption key');
    if (input.privateActorId !== null && input.privateActorId !== access.actorId)
      throw new Error('Evidence operation is not authorized');
    return this.db
      .transaction(() => {
        if (!this.allowed(access, 'ingest', null))
          throw new Error('Evidence operation is not authorized');
        const contentHash = createHash('sha256').update(input.content).digest('hex');
        const existing = this.db
          .prepare(
            "SELECT value FROM transaction_evidence_documents WHERE scope_key=? AND connector_id=? AND source_id=? AND content_hash=? AND parser_version=? AND json_extract(value,'$.privateActorId') IS ?",
          )
          .get(
            namespace(access.scope),
            input.connectorId,
            input.sourceId,
            contentHash,
            input.parserVersion,
            input.privateActorId,
          ) as { value: string } | undefined;
        if (existing) {
          const document = JSON.parse(existing.value) as EvidenceDocument;
          if (!this.allowed(access, 'normalized-evidence', document))
            throw new Error('Evidence operation is not authorized');
          if (
            canonical(document.extraction) !== canonical(input.extraction) ||
            canonical(document.quality) !== canonical(input.quality) ||
            document.parseStatus !== input.parseStatus ||
            document.privateActorId !== input.privateActorId ||
            document.sourceTimestamp !== input.sourceTimestamp ||
            document.mediaType !== input.mediaType
          )
            throw new Error('Evidence normalization is immutable');
          this.append(access, document, 'duplicate_received');
          return { document, duplicate: true };
        }
        const prior = this.db
          .prepare(
            "SELECT id,value FROM transaction_evidence_documents WHERE scope_key=? AND connector_id=? AND source_id=? AND json_extract(value,'$.privateActorId') IS ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(namespace(access.scope), input.connectorId, input.sourceId, input.privateActorId) as
          { id: string; value: string } | undefined;
        const { content: _content, ...metadata } = input;
        const document: EvidenceDocument = {
          ...metadata,
          id: randomUUID(),
          scope: structuredClone(access.scope),
          receivedAt: access.now,
          contentHash,
          supersedesId:
            prior &&
            this.allowed(access, 'normalized-evidence', JSON.parse(prior.value) as EvidenceDocument)
              ? prior.id
              : null,
        };
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(canonical(document)));
        const ciphertext = Buffer.concat([cipher.update(input.content), cipher.final()]);
        this.db
          .prepare(
            'INSERT INTO transaction_evidence_documents(scope_key,id,connector_id,source_id,content_hash,parser_version,value,ciphertext,iv,tag) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            namespace(access.scope),
            document.id,
            input.connectorId,
            input.sourceId,
            contentHash,
            input.parserVersion,
            JSON.stringify(document),
            ciphertext,
            iv,
            cipher.getAuthTag(),
          );
        this.append(access, document, 'ingested');
        return { document: structuredClone(document), duplicate: false };
      })
      .immediate();
  }
  /** Return only currently authorized normalization in the exact namespace. */
  get(access: EvidenceAccess, identity: string): EvidenceDocument | null {
    this.validate(access);
    const row = this.row(access, identity);
    if (!row) return null;
    const document = JSON.parse(row.value) as EvidenceDocument;
    if (!this.allowed(access, 'normalized-evidence', document)) return null;
    if (Date.parse(document.retentionUntil) <= Date.parse(access.now))
      this.erase(access, document, 'raw_expired');
    return document;
  }
  /** Check source currency without revealing newer private source identifiers. */
  isCurrent(access: EvidenceAccess, identity: string): boolean {
    const document = this.get(access, identity);
    if (!document) return false;
    const row = this.db
      .prepare(
        "SELECT id FROM transaction_evidence_documents WHERE scope_key=? AND connector_id=? AND source_id=? AND json_extract(value,'$.privateActorId') IS ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(
        namespace(access.scope),
        document.connectorId,
        document.sourceId,
        document.privateActorId,
      ) as { id: string } | undefined;
    return row?.id === identity;
  }
  /** Enumerate only authorized documents; private peers do not reveal counts. */
  list(access: EvidenceAccess): EvidenceDocument[] {
    this.validate(access);
    return (
      this.db
        .prepare(
          'SELECT value FROM transaction_evidence_documents WHERE scope_key=? ORDER BY rowid',
        )
        .all(namespace(access.scope)) as { value: string }[]
    )
      .map((row) => JSON.parse(row.value) as EvidenceDocument)
      .filter((document) => this.allowed(access, 'normalized-evidence', document))
      .map((document) => {
        if (Date.parse(document.retentionUntil) <= Date.parse(access.now))
          this.erase(access, document, 'raw_expired');
        return document;
      });
  }
  /** Decrypt with a distinct raw-document grant; expired content is destroyed first. */
  readRaw(access: EvidenceAccess, identity: string, key: Buffer): Buffer | null {
    this.validate(access);
    const row = this.row(access, identity);
    if (!row) return null;
    const document = JSON.parse(row.value) as EvidenceDocument;
    if (!this.allowed(access, 'raw-document', document))
      throw new Error('Evidence operation is not authorized');
    if (Date.parse(document.retentionUntil) <= Date.parse(access.now)) {
      this.erase(access, document, 'raw_expired');
      return null;
    }
    if (!row.ciphertext || !row.iv || !row.tag) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
    decipher.setAAD(Buffer.from(canonical(document)));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  }
  private erase(
    access: EvidenceAccess,
    document: EvidenceDocument,
    action: EvidenceAudit['action'],
  ): boolean {
    return this.db
      .transaction(() => {
        const changed =
          this.db
            .prepare(
              'UPDATE transaction_evidence_documents SET ciphertext=NULL,iv=NULL,tag=NULL WHERE scope_key=? AND id=? AND ciphertext IS NOT NULL',
            )
            .run(namespace(access.scope), document.id).changes > 0;
        if (changed) this.append(access, document, action);
        return changed;
      })
      .immediate();
  }
  /** Delete raw content while retaining allowed hash, normalization and deletion provenance. */
  deleteRaw(access: EvidenceAccess, identity: string): boolean {
    this.validate(access);
    const row = this.row(access, identity);
    if (!row) return false;
    const document = JSON.parse(row.value) as EvidenceDocument;
    if (!this.allowed(access, 'delete', document))
      throw new Error('Evidence operation is not authorized');
    return this.erase(access, document, 'raw_deleted');
  }
  /** Read content-free lifecycle history under normalized authority. */
  audit(access: EvidenceAccess, identity: string): EvidenceAudit[] {
    if (!this.get(access, identity)) return [];
    return (
      this.db
        .prepare(
          'SELECT value FROM transaction_evidence_audit WHERE scope_key=? AND document_id=? ORDER BY sequence',
        )
        .all(namespace(access.scope), identity) as { value: string }[]
    ).map((row) => JSON.parse(row.value) as EvidenceAudit);
  }
  private sourceHash(access: EvidenceAccess, documentIds: string[]): string | null {
    if (documentIds.length === 0 || new Set(documentIds).size !== documentIds.length) return null;
    const documents = documentIds.map((identity) => this.get(access, identity));
    if (
      documents.some((document) => document === null) ||
      documentIds.some((identity) => !this.isCurrent(access, identity))
    )
      return null;
    return createHash('sha256')
      .update(
        canonical(
          documents
            .map((document) => [document!.id, document!.contentHash, document!.parserVersion])
            .sort(),
        ),
      )
      .digest('hex');
  }
  /** Append an attributable exact human relationship decision over current immutable sources. */
  saveDecision(access: EvidenceAccess, input: EvidenceResolutionDecision): void {
    this.validate(access);
    if (input.allocationReview) EvidenceAllocationReviewSchema.parse(input.allocationReview);
    z.array(
      z
        .object({ ledgerTransactionId: id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
    ).parse(input.ledgerSources ?? []);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.resolutionHash);
    z.array(EvidenceRelationshipSchema).max(20000).parse(input.relationships);
    z.array(z.object({ observationId: id, effect: economicEventLedgerEffectSchema }).strict())
      .max(10000)
      .parse(input.ledgerEffects ?? []);
    z.array(
      z
        .object({ observationId: id, eventType: EvidenceObservationSchema.shape.eventType })
        .strict(),
    )
      .max(10000)
      .parse(input.purposeDecisions ?? []);
    const annotations = z
      .array(evidenceReceiptAnnotationSchema)
      .max(10000)
      .parse(input.receiptAnnotations ?? []);
    if (
      annotations.some(
        (entry) =>
          entry.actorId !== access.actorId ||
          Date.parse(entry.reviewedAt) > Date.parse(access.now) ||
          Date.parse(access.now) - Date.parse(entry.reviewedAt) > 300000 ||
          !input.documentIds.includes(entry.documentId),
      )
    )
      throw new Error('Invalid receipt annotation provenance');
    if (
      annotations.some(
        (entry) =>
          entry.membershipId !== annotations[0]?.membershipId ||
          entry.policyVersion !== annotations[0]?.policyVersion,
      )
    )
      throw new Error('Invalid receipt annotation review scope');
    if (new Set(annotations.map(receiptAnnotationKey)).size !== annotations.length)
      throw new Error('Duplicate receipt annotation');
    const categories = z
      .array(evidenceItemCategoryDecisionSchema)
      .max(10000)
      .parse(input.itemCategoryDecisions ?? []);
    if (
      categories.some(
        (entry) =>
          entry.actorId !== access.actorId ||
          Date.parse(entry.reviewedAt) > Date.parse(access.now) ||
          Date.parse(access.now) - Date.parse(entry.reviewedAt) > 300000 ||
          !input.documentIds.includes(entry.documentId),
      )
    )
      throw new Error('Invalid item category decision provenance');
    this.db
      .transaction(() => {
        if (!this.allowed(access, 'resolve', null))
          throw new Error('Evidence decision is not authorized');
        const sourceHash = this.sourceHash(access, input.documentIds);
        if (!sourceHash) throw new Error('Evidence source changed or is not authorized');
        if (annotations.length) {
          const current = this.receiptAnnotations(access, {
            documentIds: input.documentIds,
            policyVersion: annotations[0]!.policyVersion,
            membershipId: annotations[0]!.membershipId,
          });
          if (
            input.receiptAnnotationBaseHash !==
            createHash('sha256').update(canonical(current)).digest('hex')
          )
            throw new Error('Receipt annotations changed');
        }
        for (const entry of annotations) {
          const references = [
            entry,
            ...(entry.change.kind === 'return' && entry.change.original
              ? [entry.change.original]
              : entry.change.kind === 'fulfillment' && entry.change.order
                ? [entry.change.order]
                : []),
          ];
          for (const reference of references) {
            const document = this.get(access, reference.documentId);
            if (
              !document ||
              !input.documentIds.includes(document.id) ||
              !this.isCurrent(access, document.id) ||
              document.contentHash !== reference.contentHash ||
              document.parserVersion !== reference.parserVersion
            )
              throw new Error('Receipt annotation source changed');
          }
        }
        if (categories.length) {
          const current = this.itemCategoryOutcomes(access, {
            documentIds: input.documentIds,
            policyVersion: categories[0]!.policyVersion,
            membershipId: categories[0]!.membershipId,
          });
          if (
            input.itemCategoryBaseHash !==
            createHash('sha256').update(canonical(current)).digest('hex')
          )
            throw new Error('Item category decisions changed');
        }
        for (const entry of categories) {
          const document = this.get(access, entry.documentId);
          if (
            !document ||
            document.contentHash !== entry.contentHash ||
            document.parserVersion !== entry.parserVersion
          )
            throw new Error('Item category source changed');
        }
        this.db
          .prepare(
            'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
          )
          .run(
            namespace(access.scope),
            access.actorId,
            sourceHash,
            JSON.stringify({ ...input, actorId: access.actorId, at: access.now }),
          );
      })
      .immediate();
  }
  /** Load this actor's latest decision only for an identical, still-authorized source set. */
  latestDecision(access: EvidenceAccess, documentIds: string[]): EvidenceResolutionDecision | null {
    this.validate(access);
    const sourceHash = this.sourceHash(access, documentIds);
    if (!sourceHash) return null;
    const row = this.db
      .prepare(
        'SELECT value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(namespace(access.scope), access.actorId, sourceHash) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as EvidenceResolutionDecision) : null;
  }
  /** Fold this actor's latest exact receipt relationships and attribution under current source and review scope. */
  receiptAnnotations(
    access: EvidenceAccess,
    value: { documentIds: string[]; policyVersion: string; membershipId: string },
  ): EvidenceReceiptAnnotation[] {
    this.validate(access);
    const input = z
      .object({ documentIds: z.array(id).max(10000), policyVersion: id, membershipId: id })
      .strict()
      .parse(value);
    const documents = new Map(
      input.documentIds.flatMap((identity) => {
        const document = this.get(access, identity);
        return document && this.isCurrent(access, identity) ? [[identity, document] as const] : [];
      }),
    );
    const rows = this.db
      .prepare(
        'SELECT value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? ORDER BY sequence DESC LIMIT 10000',
      )
      .all(namespace(access.scope), access.actorId) as { value: string }[];
    const entries = new Map<string, EvidenceReceiptAnnotation>();
    const seen = new Set<string>();
    for (const row of rows) {
      const decision = JSON.parse(row.value) as EvidenceResolutionDecision;
      for (const value of decision.receiptAnnotations ?? []) {
        const parsed = evidenceReceiptAnnotationSchema.safeParse(value);
        if (!parsed.success) continue;
        const entry = parsed.data;
        const document = documents.get(entry.documentId);
        if (
          !document ||
          entry.actorId !== access.actorId ||
          entry.membershipId !== input.membershipId ||
          entry.policyVersion !== input.policyVersion ||
          entry.contentHash !== document.contentHash ||
          entry.parserVersion !== document.parserVersion
        )
          continue;
        const key = receiptAnnotationKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        const reference =
          entry.change.kind === 'return'
            ? entry.change.original
            : entry.change.kind === 'fulfillment'
              ? entry.change.order
              : null;
        if (reference) {
          const related = documents.get(reference.documentId);
          if (
            !related ||
            reference.contentHash !== related.contentHash ||
            reference.parserVersion !== related.parserVersion
          )
            continue;
        }
        entries.set(key, entry);
      }
    }
    return [...entries.values()];
  }
  /** Fold append-only human labels per current source; adding another document never renews old proof. */
  itemCategoryOutcomes(
    access: EvidenceAccess,
    value: { documentIds: string[]; policyVersion: string; membershipId: string },
  ): EvidenceItemCategoryDecision[] {
    this.validate(access);
    const input = z
      .object({ documentIds: z.array(id).max(10000), policyVersion: id, membershipId: id })
      .strict()
      .parse(value);
    const documents = new Map(
      input.documentIds.flatMap((identity) => {
        const document = this.get(access, identity);
        return document && this.isCurrent(access, identity) ? [[identity, document] as const] : [];
      }),
    );
    const rows = this.db
      .prepare(
        'SELECT value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? ORDER BY sequence DESC LIMIT 10000',
      )
      .all(namespace(access.scope), access.actorId) as { value: string }[];
    const outcomes = new Map<string, EvidenceItemCategoryDecision>();
    for (const row of rows) {
      const decision = JSON.parse(row.value) as EvidenceResolutionDecision;
      for (const value of decision.itemCategoryDecisions ?? []) {
        const parsed = evidenceItemCategoryDecisionSchema.safeParse(value);
        if (!parsed.success) continue;
        const entry = parsed.data;
        const document = documents.get(entry.documentId);
        if (
          !document ||
          entry.actorId !== access.actorId ||
          entry.policyVersion !== input.policyVersion ||
          entry.membershipId !== input.membershipId ||
          document.contentHash !== entry.contentHash ||
          document.parserVersion !== entry.parserVersion
        )
          continue;
        const key = JSON.stringify([entry.documentId, entry.receiptId, entry.lineId]);
        if (!outcomes.has(key)) outcomes.set(key, entry);
      }
    }
    return [...outcomes.values()];
  }
  /** Persist a versioned native result linked to currently authorized source documents. */
  saveResolution(
    access: EvidenceAccess,
    identity: string,
    documentIds: string[],
    value: Record<string, unknown>,
  ): void {
    this.validate(access);
    id.parse(identity);
    json.parse(value);
    if (
      documentIds.length === 0 ||
      documentIds.some((documentId) => !this.isCurrent(access, documentId))
    )
      throw new Error('Evidence operation is not authorized');
    const stored = canonical({ documentIds, value });
    const prior = this.db
      .prepare('SELECT value FROM transaction_evidence_resolutions WHERE scope_key=? AND id=?')
      .get(namespace(access.scope), identity) as { value: string } | undefined;
    if (prior && prior.value !== stored) throw new Error('Evidence resolution is immutable');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO transaction_evidence_resolutions(scope_key,id,value) VALUES(?,?,?)',
      )
      .run(namespace(access.scope), identity, stored);
  }
}
