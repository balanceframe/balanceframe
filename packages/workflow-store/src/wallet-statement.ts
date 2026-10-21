import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { WalletStatementProofSchema } from '@balanceframe/protocol-generated/validators';
import type { WalletStatementProof } from '@balanceframe/protocol-generated';
import type { EvidenceAccess, EvidenceDocument } from './transaction-evidence.js';
import { canonicalProposalJson } from './proposal.js';
const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const review = z.object({ membershipId: id, policyVersion: id }).strict();
const namespace = (access: EvidenceAccess) =>
  JSON.stringify([access.scope.spaceId, access.scope.budgetId, access.scope.connectionId]);
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
const eventSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('wallet_statement_attest'), proof: WalletStatementProofSchema })
    .strict(),
  z
    .object({
      kind: z.literal('wallet_statement_revoke'),
      proofId: id,
      actorId: id,
      membershipId: id,
      policyVersion: id,
      reviewedAt: z.string().datetime(),
    })
    .strict(),
]);
type Event = z.infer<typeof eventSchema>;
/** Append-only human attestations reuse evidence decisions while retaining independently revocable authority. */
export class WalletStatementWorkflow {
  constructor(
    private readonly db: Database,
    private readonly current: (access: EvidenceAccess, id: string) => EvidenceDocument | null,
    private readonly raw: (access: EvidenceAccess, id: string, key: Buffer) => Buffer | null,
  ) {}
  private events(access: EvidenceAccess): Event[] {
    z.object({ spaceId: id, budgetId: id, connectionId: id }).strict().parse(access.scope);
    id.parse(access.actorId);
    z.string().datetime().parse(access.now);
    const rows = this.db
      .prepare(
        "SELECT value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash='wallet-statement:1' ORDER BY sequence DESC LIMIT 10001",
      )
      .all(namespace(access), access.actorId) as { value: string }[];
    if (rows.length > 10000) throw new Error('Wallet statement history limit exceeded');
    return rows.map((row) => eventSchema.parse(JSON.parse(row.value)));
  }
  private folded(events: Event[]): Event[] {
    const latest = new Map<string, Event>();
    for (const event of events) {
      const key = event.kind === 'wallet_statement_attest' ? event.proof.proofId : event.proofId;
      if (!latest.has(key)) latest.set(key, event);
    }
    return [...latest.values()].sort((a, b) =>
      (a.kind === 'wallet_statement_attest' ? a.proof.proofId : a.proofId).localeCompare(
        b.kind === 'wallet_statement_attest' ? b.proof.proofId : b.proofId,
      ),
    );
  }
  private currentProof(access: EvidenceAccess, proof: WalletStatementProof): boolean {
    return [proof.statement, ...proof.activityManifest].every((reference) => {
      const source = this.current(access, reference.documentId);
      return (
        source?.contentHash === reference.contentHash &&
        source.parserVersion === reference.parserVersion
      );
    });
  }
  /** Fold tombstones before eligibility checks so an obsolete approval can never revive. */
  state(
    access: EvidenceAccess,
    value: z.infer<typeof review>,
  ): { foldHash: string; proofs: WalletStatementProof[] } {
    const scope = review.parse(value),
      events = this.folded(this.events(access));
    const proofs = access.authorize({ capability: 'resolve', document: null, scope: access.scope })
      ? events.flatMap((event) =>
          event.kind === 'wallet_statement_attest' &&
          event.proof.actorId === access.actorId &&
          event.proof.membershipId === scope.membershipId &&
          event.proof.policyVersion === scope.policyVersion &&
          this.currentProof(access, event.proof)
            ? [event.proof]
            : [],
        )
      : [];
    return { foldHash: digest(events), proofs };
  }
  private fence(access: EvidenceAccess, expected: string): void {
    hash.parse(expected);
    if (!access.authorize({ capability: 'resolve', document: null, scope: access.scope }))
      throw new Error('Wallet statement review is not authorized');
    if (digest(this.folded(this.events(access))) !== expected)
      throw new Error('Wallet statement proofs changed');
  }
  private append(access: EvidenceAccess, event: Event): void {
    this.db
      .prepare(
        'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
      )
      .run(namespace(access), access.actorId, 'wallet-statement:1', JSON.stringify(event));
  }
  /** Admit only a current original with freshly attributed human review; normalized provenance survives ordinary raw retention. */
  attest(
    access: EvidenceAccess,
    value: { proof: WalletStatementProof; expectedFoldHash: string },
    key: Buffer,
  ): void {
    const input = z
      .object({ proof: WalletStatementProofSchema, expectedFoldHash: hash })
      .strict()
      .parse(value);
    this.db
      .transaction(() => {
        this.fence(access, input.expectedFoldHash);
        const proof = input.proof;
        if (
          proof.actorId !== access.actorId ||
          Date.parse(proof.reviewedAt) > Date.parse(access.now) ||
          Date.parse(access.now) - Date.parse(proof.reviewedAt) > 300000
        )
          throw new Error('Fresh wallet statement human provenance required');
        if (!this.currentProof(access, proof)) throw new Error('Wallet statement source changed');
        const bytes = this.raw(access, proof.statement.documentId, key);
        if (
          !bytes ||
          createHash('sha256').update(bytes).digest('hex') !== proof.statement.contentHash
        )
          throw new Error('Current authorized original raw statement required');
        this.append(access, { kind: 'wallet_statement_attest', proof });
      })
      .immediate();
  }
  /** Revocation remains possible after raw expiry or source replacement and never requires deleted original bytes. */
  revoke(
    access: EvidenceAccess,
    value: {
      proofId: string;
      expectedFoldHash: string;
      membershipId: string;
      policyVersion: string;
    },
  ): void {
    const input = review.extend({ proofId: id, expectedFoldHash: hash }).strict().parse(value);
    this.db
      .transaction(() => {
        this.fence(access, input.expectedFoldHash);
        const known = this.events(access).some(
          (event) =>
            event.kind === 'wallet_statement_attest' &&
            event.proof.proofId === input.proofId &&
            event.proof.actorId === access.actorId,
        );
        if (!known) throw new Error('Known wallet statement proof required');
        this.append(access, {
          kind: 'wallet_statement_revoke',
          proofId: input.proofId,
          actorId: access.actorId,
          membershipId: input.membershipId,
          policyVersion: input.policyVersion,
          reviewedAt: access.now,
        });
      })
      .immediate();
  }
}
