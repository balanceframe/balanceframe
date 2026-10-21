import { canonicalProposalJson } from '@balanceframe/workflow-store';
import type {
  AtomicConsequentialActionIntent,
  ConsequentialActionEvidence,
  SourceObservation,
} from '@balanceframe/protocol-generated';
type Wallet = Extract<AtomicConsequentialActionIntent, { kind: 'wallet_materialization' }>;
export function walletAnchorEvidence(
  observation: SourceObservation,
  allowed: (id: string) => boolean,
): ConsequentialActionEvidence[] {
  const anchor = observation.walletBalanceAnchor;
  if (
    observation.kind !== 'wallet_statement_anchor' ||
    observation.scope.kind !== 'claim' ||
    !anchor ||
    observation.scope.id !== anchor.walletId ||
    observation.state !== 'resolved' ||
    observation.version !== 'wallet-statement-v1' ||
    observation.contentHash !== anchor.proofSetHash ||
    !observation.observedAt ||
    !anchor.evidenceIds.length ||
    anchor.evidenceIds.length !== observation.evidence.length ||
    observation.evidence.some(
      (r) =>
        r.kind !== 'human_attested_statement' ||
        !r.authorized ||
        r.redaction !== 'visible' ||
        !anchor.evidenceIds.includes(r.evidenceId) ||
        !allowed(r.evidenceId),
    )
  )
    return [];
  return observation.evidence.map((r) => ({
    evidenceId: r.evidenceId,
    subjectId: anchor.walletId,
    state: 'resolved',
    contentHash: anchor.proofSetHash,
    version: observation.version!,
  }));
}
export function bindWalletOpening(
  action: Wallet,
  observations: readonly SourceObservation[],
  allowed: (id: string) => boolean,
): Wallet {
  if (!action.opening) return action;
  const opening = action.opening;
  const matches = [
    ...new Map(
      observations
        .filter(
          (o) =>
            o.kind === 'wallet_statement_anchor' &&
            o.scope.kind === 'claim' &&
            o.scope.id === action.walletId &&
            o.walletBalanceAnchor?.boundary === 'before_day_activity' &&
            o.walletBalanceAnchor.asOfDate === opening.date &&
            o.walletBalanceAnchor.amount.minorUnits === opening.amount.minorUnits &&
            o.walletBalanceAnchor.amount.currency === action.currency &&
            o.walletBalanceAnchor.proofSetHash === opening.proofSetHash &&
            o.walletBalanceAnchor.activityManifestHash === opening.activityManifestHash,
        )
        .map((observation) => [canonicalProposalJson(observation), observation]),
    ).values(),
  ];
  const observation = matches[0],
    anchor = observation?.walletBalanceAnchor;
  if (
    matches.length !== 1 ||
    !observation ||
    !anchor ||
    !walletAnchorEvidence(observation, allowed).length ||
    anchor.boundary !== 'before_day_activity' ||
    anchor.asOfDate !== opening.date ||
    anchor.amount.minorUnits !== opening.amount.minorUnits ||
    anchor.amount.currency !== action.currency ||
    opening.amount.currency !== action.currency ||
    anchor.proofSetHash !== opening.proofSetHash ||
    anchor.activityManifestHash !== opening.activityManifestHash
  )
    throw new Error('Current exact before-day wallet statement anchor unavailable');
  return action;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** This reserves created identity, never claims that the complete financial action succeeded. */
export function verifiedWalletAccount(action: Wallet, value: unknown): string | null {
  const result = record(value);
  if (!result) return null;
  const identity =
    result.success === true && result.verified === true ? result : record(result.createdAccount);
  return identity?.verified === true &&
    identity.walletId === action.walletId &&
    typeof identity.accountId === 'string' &&
    identity.accountId.trim()
    ? identity.accountId
    : null;
}
