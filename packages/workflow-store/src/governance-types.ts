import type { Database } from 'better-sqlite3';

/** Live credential metadata supplied only by a trusted authentication adapter. */
export interface CredentialLifetime {
  /** Null denotes an actual nonexpiring credential; omitted for trusted local auth. */
  readonly credentialExpiresAt?: string | null;
  /** Synchronous authoritative revocation/expiry check at the caller's fresh time. */
  readonly isCredentialValid?: (now: string) => boolean;
}

/** A server-verified, recently reauthenticated human session. */
export interface HumanControlContext extends CredentialLifetime {
  readonly method: 'human-session';
  readonly actorId: string;
  readonly sessionId: string;
  readonly reauthenticatedAt: string;
}

/** Verified execution identity supplied by trusted server code, never an HTTP body. */
export type OperationalAuth = CredentialLifetime & (
  | HumanControlContext
  | { readonly method: 'session'; readonly actorId: string; readonly sessionId: string }
  | {
      readonly method: 'api-key';
      readonly actorId: string;
      readonly credentialId: string;
      readonly credentialOwnerId: string;
      readonly principalType: 'human';
    }
  | {
      readonly method: 'api-key';
      readonly actorId: string;
      readonly credentialId: string;
      readonly credentialOwnerId: string;
      readonly principalType: 'agent';
      readonly delegationId: string;
      readonly delegationVersion: string;
    });

/** A personal or shared authorization boundary with an optional unique budget binding. */
export interface Space {
  readonly id: string;
  readonly name: string;
  readonly kind: 'personal' | 'shared';
  readonly budgetId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

/** One immutable temporal membership period. */
export interface SpaceMembership {
  readonly id: string;
  readonly spaceId: string;
  readonly actorId: string;
  readonly grantedBy: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly origin: 'created' | 'managed' | 'migration';
}
/** Safe Native projection of an authorized space audit record. */
export interface SpaceAuditRecord {
  readonly id: string;
  readonly actorId: string;
  readonly classification: string;
  readonly subjectId: string | null;
  readonly timestamp: string;
}

/** Per-currency gross-outgoing threshold that raises the approval count. */
export interface ApprovalThreshold {
  readonly currency: string;
  readonly amountMinorUnits: string;
  readonly requiredApprovers: number;
}

/** Versioned space approval policy, independent from native financial policy. */
export interface GovernancePolicy {
  readonly minimumApprovers: number;
  readonly approvalThresholds: readonly ApprovalThreshold[];
  readonly operationApprovers?: Readonly<Record<string, number>>;
}

/** A persisted governance-policy version. */
export interface VersionedGovernancePolicy extends GovernancePolicy {
  readonly spaceId: string;
  readonly version: string;
  readonly actorId: string;
  readonly createdAt: string;
}

/** Public policy write shape; values are revalidated by the store. */
export interface GovernancePolicyInput {
  readonly minimumApprovers?: unknown;
  readonly approvalThresholds?: unknown;
  readonly operationApprovers?: unknown;
}

/** Resource categories supported by the single resource_grants authority. */
export type GovernanceResourceKind =
  | 'space'
  | 'budget'
  | 'account'
  | 'category'
  | 'transaction'
  | 'rule'
  | 'evidence'
  | 'wallet'
  | 'receipt'
  | 'commitment'
  | 'scenario'
  | 'reservation'
  | 'purchase'
  | 'transfer'
  | 'ledger_effect'
  | 'session'
  | 'proposal';

/** Exact governed resource key. */
export interface GovernanceResourceRef {
  readonly resourceKind: GovernanceResourceKind;
  readonly resourceId: string;
}

/** Grant restrictions are evaluated together on each complete governed request. */
export interface ResourceGrantRestrictions {
  readonly aggregateOnly?: boolean;
  readonly accountIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly operations?: readonly string[];
  readonly proposalOnly?: boolean;
  readonly maxGrossOutgoing?: readonly { readonly currency: string; readonly minorUnits: string }[];
  readonly maxOperationCount?: number;
}

/** One current or revoked grant, always tied to its original membership period. */
export interface GovernanceResourceGrant extends GovernanceResourceRef {
  readonly id: string;
  readonly spaceId: string;
  readonly membershipId: string | null;
  readonly actorId: string;
  readonly budgetId: string | null;
  readonly capability: string;
  readonly granted: boolean;
  readonly restrictions: ResourceGrantRestrictions;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

/** A capability/resource pair delegated to an independently identified agent. */
export interface DelegatedRight extends GovernanceResourceRef {
  readonly capability: string;
  readonly restrictions?: ResourceGrantRestrictions;
}

/** Input to explicitly provision a scoped grant for one current membership. */
export interface SetResourceGrantInput extends GovernanceResourceRef {
  readonly spaceId: string;
  readonly actorId: string;
  readonly budgetId?: string;
  readonly membershipId: string;
  readonly capability: string;
  readonly granted: boolean;
  readonly restrictions?: unknown;
  readonly now: string;
  readonly auth: HumanControlContext;
}
/** Explicit internal bootstrap write; never an HTTP authorization path. */
export type ProvisionResourceGrantInput = Omit<SetResourceGrantInput, 'auth'>;

/** Explicit independently identified automation principal. */
export interface GovernanceAgent {
  readonly agentId: string;
  readonly registeredSpaceId: string;
  readonly status: 'active' | 'disconnected' | 'revoked';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly disconnectedAt: string | null;
  readonly revokedAt: string | null;
}


/** Versioned, bounded agent authority issued by one membership period. */
export interface AgentDelegation {
  readonly id: string;
  readonly spaceId: string;
  readonly agentId: string;
  readonly issuerActorId: string;
  readonly issuerMembershipId: string;
  readonly version: string;
  readonly rights: readonly DelegatedRight[];
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** Exactly the three outcomes consumed by governed application paths. */
export type GovernanceDisposition =
  | { readonly kind: 'authorized_without_approval' }
  | { readonly kind: 'approval_required' }
  | { readonly kind: 'denied'; readonly reason: string };

/** Actual rule effect scope used for account-restricted rights. */
export type GovernanceAccountScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'accounts'; readonly accountIds: readonly string[] };

/** One complete child operation inspected for resource and financial limits. */
export interface GovernanceOperation {
  readonly accountScope?: GovernanceAccountScope;
  readonly operation: string;
  readonly direction?: 'outgoing' | 'incoming';
  readonly amount?: { readonly minorUnits: string; readonly currency: string };
  readonly accountId?: string;
  readonly sourceAccountId?: string;
  readonly destinationAccountId?: string;
  readonly categoryId?: string;
  readonly transactionId?: string;
  readonly ruleId?: string;
  readonly evidenceId?: string;
  readonly resourceKind?: GovernanceResourceKind;
  readonly resourceId?: string;
}

/** Server-derived numerical totals for exactly the private Money occurrences emitted by a read. */
export interface GovernanceFinancialDisclosure {
  readonly operationCount: number;
  readonly grossOutgoing: Readonly<Record<string, bigint>>;
}

/** Additional read-only caps; these totals never replace source/effect or subject authorization. */
export interface GovernanceReadDisclosureLimits {
  readonly collection: GovernanceFinancialDisclosure;
  readonly subject: GovernanceFinancialDisclosure;
}

/** Full request accepted by the deterministic synchronous governance evaluator. */
export interface GovernanceAuthorizationInput {
  readonly actorId: string;
  readonly spaceId: string;
  readonly membershipId?: string;
  readonly expectedPolicyVersion: string;
  readonly phase: 'read' | 'propose' | 'approve' | 'execute';
  readonly operation: string;
  readonly required: readonly (GovernanceResourceRef & {
    readonly capability: string;
    readonly visibility?: 'aggregate' | 'resource';
  })[];
  readonly payload: { readonly operations: readonly GovernanceOperation[]; readonly [key: string]: unknown };
  readonly now: string;
  readonly agentId?: string;
  readonly delegationId?: string;
  readonly delegationVersion?: string;
  readonly auth?: OperationalAuth;
  /** Set only after the approval service verifies exact human approval records. */
  readonly verifiedHumanApproval?: true;
}

/** Current policy result plus the exact approval count required by the payload. */
export interface GovernanceAuthorizationResult {
  readonly allowed: boolean;
  readonly disposition: GovernanceDisposition;
  readonly actorId: string;
  readonly spaceId: string;
  readonly membershipId: string | null;
  readonly policyVersion: string | null;
  readonly requiredApprovers: number;
  readonly reason: string;
}

/** Input to create an unbound space and its creator's control-plane membership. */
export interface CreateSpaceInput {
  readonly actorId: string;
  readonly name: string;
  readonly kind: 'personal' | 'shared';
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to bind one existing budget at the privileged connection boundary. */
export interface BindBudgetInput {
  readonly spaceId: string;
  readonly budgetId: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to append a new membership period. */
export interface AddMembershipInput {
  readonly spaceId: string;
  readonly actorId: string;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Accepts one server-verified claimed invitation using its captured scope and issuer period. */
export interface AcceptInvitedMembershipInput {
  readonly claimId: string;
  readonly email: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to revoke one membership period without deleting its history. */
export interface RevokeMembershipInput {
  readonly spaceId: string;
  readonly membershipId: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to set a compare-and-swap versioned governance policy. */
export interface SetGovernancePolicyInput {
  readonly spaceId: string;
  readonly expectedVersion: string | null;
  readonly policy: GovernancePolicyInput;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to register a separately identified, initially active agent in one selected space. */
export interface RegisterAgentInput {
  readonly spaceId: string;
  readonly agentId: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to disconnect or revoke an agent while retaining its identity history. */
export interface SetAgentStatusInput {
  readonly spaceId: string;
  readonly agentId: string;
  readonly status: 'disconnected' | 'revoked';
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to issue or replace a versioned bounded delegation. */
export interface DelegateAgentInput {
  readonly id?: string;
  readonly spaceId: string;
  readonly agentId: string;
  readonly issuerMembershipId: string;
  readonly expectedVersion: string | null;
  readonly rights: readonly DelegatedRight[];
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to revoke one current delegation. */
export interface RevokeDelegationInput {
  readonly spaceId: string;
  readonly delegationId: string;
  readonly expectedVersion: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Immutable binding between a verified API-key owner and its principal. */
export interface CredentialBinding {
  readonly id: string;
  readonly spaceId: string;
  readonly credentialId: string;
  readonly credentialOwnerId: string;
  readonly principalType: 'human' | 'agent';
  readonly principalId: string;
  readonly delegationId: string | null;
  readonly delegationVersion: string | null;
  readonly issuerMembershipId: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

/** Input to bind a verified credential to a governed principal. */
export interface RegisterCredentialBindingInput {
  readonly spaceId: string;
  readonly credentialId: string;
  readonly credentialOwnerId: string;
  readonly principalType: 'human' | 'agent';
  readonly principalId: string;
  readonly delegationId?: string;
  readonly expectedDelegationVersion?: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Input to revoke a binding without freeing its immutable credential ID. */
export interface RevokeCredentialBindingInput {
  readonly credentialId: string;
  readonly spaceId: string;
  readonly now: string;
  readonly auth: HumanControlContext;
}

/** Principal resolved from a verified credential ID and server-supplied reference ID. */
export type CredentialPrincipal =
  | {
      readonly principalType: 'human';
      readonly actorId: string;
      readonly credentialId: string;
      readonly credentialOwnerId: string;
    }
  | {
      readonly principalType: 'agent';
      readonly actorId: string;
      readonly credentialId: string;
      readonly credentialOwnerId: string;
      readonly delegationId: string;
      readonly delegationVersion: string;
    };

/** The SQLite connection is shared with the main workflow and liquidity store. */
export type GovernanceDatabase = Database;
