import {
  consequentialActionVerificationSchema,
  verifyConsequentialActionRequestSchema,
} from '@balanceframe/protocol-generated/validators';
import type {
  ConsequentialActionVerification,
  VerifyConsequentialActionRequest,
} from '@balanceframe/protocol-generated';
import type {
  ConsequentialActionExecutionIdentity,
  ConsequentialActionInvalidationToken,
  ConsequentialActionVerificationToken,
} from './types.js';

export interface IssueConsequentialActionVerificationTokenInput extends ConsequentialActionExecutionIdentity {
  readonly verification: ConsequentialActionVerification;
  readonly verifyRequest: VerifyConsequentialActionRequest;
  readonly observedState: unknown;
}

export interface ConsequentialActionVerificationProof extends ConsequentialActionExecutionIdentity {
  readonly verification: ConsequentialActionVerification;
  readonly verifyRequest: VerifyConsequentialActionRequest;
  readonly observedState: unknown;
}

export interface IssueConsequentialActionInvalidationTokenInput extends ConsequentialActionExecutionIdentity {
  readonly dispatchCount: 0;
  readonly staleWorkerFenced: true;
}

const verificationProofs = new WeakMap<object, ConsequentialActionVerificationProof>();
const invalidationProofs = new WeakMap<object, ConsequentialActionExecutionIdentity>();

function requireIdentity(input: ConsequentialActionExecutionIdentity): void {
  for (const value of [
    input.proposalId,
    input.payloadHash,
    input.actorId,
    input.idempotencyKey,
    input.acquisitionAuditId,
  ])
    if (typeof value !== 'string' || !value.trim()) throw new Error('Exact consequential-action identity is required');
}

function frozenToken<T>(): T {
  return Object.freeze({}) as T;
}

/** Server-internal capability issued only after native postcondition verification and readback. */
export function issueConsequentialActionVerificationToken(
  input: IssueConsequentialActionVerificationTokenInput,
): ConsequentialActionVerificationToken {
  requireIdentity(input);
  const verifyRequest = verifyConsequentialActionRequestSchema.parse(input.verifyRequest);
  const verification = consequentialActionVerificationSchema.parse(input.verification);
  if (verifyRequest.phase !== 'postconditions' || !verification.valid || verification.reason !== null ||
      verification.actionHash !== verifyRequest.plan.actionHash ||
      typeof input.observedState !== 'object' || input.observedState === null || Array.isArray(input.observedState))
    throw new Error('Native consequential-action postcondition proof is invalid');
  const token = frozenToken<ConsequentialActionVerificationToken>();
  verificationProofs.set(token, structuredClone({
    proposalId: input.proposalId,
    payloadHash: input.payloadHash,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    acquisitionAuditId: input.acquisitionAuditId,
    verification,
    verifyRequest,
    observedState: input.observedState,
  }));
  return token;
}

/** Server-internal capability issued only when no adapter dispatch occurred and its worker is fenced. */
export function issueConsequentialActionInvalidationToken(
  input: IssueConsequentialActionInvalidationTokenInput,
): ConsequentialActionInvalidationToken {
  requireIdentity(input);
  if (input.dispatchCount !== 0 || input.staleWorkerFenced !== true)
    throw new Error('No-dispatch proof is incomplete');
  const token = frozenToken<ConsequentialActionInvalidationToken>();
  invalidationProofs.set(token, structuredClone({
    proposalId: input.proposalId,
    payloadHash: input.payloadHash,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    acquisitionAuditId: input.acquisitionAuditId,
  }));
  return token;
}

/** Internal store lookup; serialized and caller-created values cannot be members of these WeakMaps. */
export function consequentialActionVerificationProof(
  token: unknown,
): ConsequentialActionVerificationProof | null {
  return typeof token === 'object' && token !== null ? verificationProofs.get(token) ?? null : null;
}

/** Internal store lookup for a fenced no-dispatch proof. */
export function consequentialActionInvalidationProof(
  token: unknown,
): ConsequentialActionExecutionIdentity | null {
  return typeof token === 'object' && token !== null ? invalidationProofs.get(token) ?? null : null;
}
