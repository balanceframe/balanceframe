import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type {
  AddMembershipInput,
  AcceptInvitedMembershipInput,
  AgentDelegation,
  ApprovalThreshold,
  BindBudgetInput,
  CreateSpaceInput,
  CredentialBinding,
  CredentialPrincipal,
  DelegateAgentInput,
  DelegatedRight,
  GovernanceAgent,
  GovernanceAuthorizationInput,
  GovernanceAuthorizationResult,
  GovernanceDisposition,
  GovernanceOperation,
  GovernancePolicy,
  GovernanceResourceGrant,
  GovernanceResourceKind,
  GovernanceResourceRef,
  HumanControlContext,
  ProvisionResourceGrantInput,
  RegisterAgentInput,
  RegisterCredentialBindingInput,
  RevokeCredentialBindingInput,
  RevokeDelegationInput,
  RevokeMembershipInput,
  ResourceGrantRestrictions,
  SetAgentStatusInput,
  SetGovernancePolicyInput,
  SetResourceGrantInput,
  Space,
  SpaceAuditRecord,
  SpaceMembership,
  VersionedGovernancePolicy,
} from './governance-types.js';

const MAX_I64 = 9_223_372_036_854_775_807n;
const REAUTH_WINDOW_MS = 5 * 60_000;
const CONTROL_CAPABILITIES = [
  'space:manage',
  'identity:manage',
  'membership:manage',
  'connection:manage',
  'policy:manage',
  'grant:manage',
  'agent:manage',
  'delegation:manage',
  'credential:manage',
  'audit:read',
] as const;
function nonDelegableAgentCapability(capability: string): boolean {
  return CONTROL_CAPABILITIES.includes(capability as typeof CONTROL_CAPABILITIES[number]) ||
    /manage|approv|settle|confirm|control/i.test(capability) || capability === 'initiation-report';
}


type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function isoTime(value: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !Number.isFinite(parsed))
    throw new Error('Invalid governance timestamp');
  return parsed;
}


function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function safeMinor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('Invalid money amount');
  const amount = BigInt(value);
  if (amount > MAX_I64) throw new Error('Money amount exceeds i64');
  return amount;
}

function safeCount(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('Invalid governance count');
  return value;
}

function isCurrentAt(from: string, until: string | null, now: string): boolean {
  const instant = isoTime(now);
  return isoTime(from) <= instant && (until === null || instant < isoTime(until));
}

function parseRestrictions(value: unknown): ResourceGrantRestrictions {
  const input = record(value);
  if (!input) throw new Error('Invalid grant restrictions');
  const allowed: Record<string, true> = {
    aggregateOnly: true, accountIds: true, categoryIds: true, operations: true,
    proposalOnly: true, maxGrossOutgoing: true, maxOperationCount: true,
  };
  if (Object.keys(input).some((key) => allowed[key] !== true)) throw new Error('Unknown grant restriction');
  const result: {
    aggregateOnly?: boolean;
    accountIds?: string[];
    categoryIds?: string[];
    operations?: string[];
    proposalOnly?: boolean;
    maxGrossOutgoing?: { currency: string; minorUnits: string }[];
    maxOperationCount?: number;
  } = {};
  for (const key of ['aggregateOnly', 'proposalOnly'] as const) {
    const valueForKey = input[key];
    if (valueForKey !== undefined) {
      if (typeof valueForKey !== 'boolean') throw new Error('Invalid grant restriction');
      result[key] = valueForKey;
    }
  }
  for (const key of ['accountIds', 'categoryIds', 'operations'] as const) {
    const valueForKey = input[key];
    if (valueForKey !== undefined) {
      if (!Array.isArray(valueForKey) || valueForKey.some((item) => typeof item !== 'string' || !item.trim()))
        throw new Error('Invalid grant restriction');
      result[key] = [...valueForKey];
    }
  }
  if (input.maxGrossOutgoing !== undefined) {
    if (!Array.isArray(input.maxGrossOutgoing)) throw new Error('Invalid gross outgoing limit');
    result.maxGrossOutgoing = input.maxGrossOutgoing.map((entry) => {
      const item = record(entry);
      if (!item || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency))
        throw new Error('Invalid gross outgoing limit');
      safeMinor(item.minorUnits);
      return { currency: item.currency, minorUnits: item.minorUnits as string };
    });
  }
  if (input.maxOperationCount !== undefined)
    result.maxOperationCount = safeCount(input.maxOperationCount, 0);
  return result;
}

function delegatedRestrictions(requestedValue: unknown, issuerValue: unknown): ResourceGrantRestrictions {
  const requested = requestedValue === undefined ? {} : parseRestrictions(requestedValue);
  const issuer = parseRestrictions(issuerValue);
  const listWithin = (values: readonly string[] | undefined, bounds: readonly string[] | undefined) =>
    values === undefined || bounds === undefined || values.every((value) => bounds.includes(value));
  const grossWithin = requested.maxGrossOutgoing === undefined || issuer.maxGrossOutgoing === undefined ||
    requested.maxGrossOutgoing.every((limit) => {
      const bound = issuer.maxGrossOutgoing!.find((entry) => entry.currency === limit.currency);
      return bound !== undefined && BigInt(limit.minorUnits) <= BigInt(bound.minorUnits);
    });

  if (
    issuer.aggregateOnly && requested.aggregateOnly === false ||
    issuer.proposalOnly && requested.proposalOnly === false ||
    !listWithin(requested.accountIds, issuer.accountIds) ||
    !listWithin(requested.categoryIds, issuer.categoryIds) ||
    !listWithin(requested.operations, issuer.operations) ||
    !grossWithin ||
    requested.maxOperationCount !== undefined && issuer.maxOperationCount !== undefined &&
      requested.maxOperationCount > issuer.maxOperationCount
  )
    throw new Error('Delegation restrictions exceed issuer grant');

  return { ...issuer, ...requested };
}


function parsePolicy(value: unknown): GovernancePolicy {
  const input = record(value);
  if (!input) throw new Error('Invalid governance policy');
  const minimumApprovers = input.minimumApprovers === undefined ? 1 : safeCount(input.minimumApprovers);
  const rawThresholds = input.approvalThresholds ?? [];
  if (!Array.isArray(rawThresholds)) throw new Error('Invalid approval thresholds');
  const approvalThresholds: ApprovalThreshold[] = rawThresholds.map((raw) => {
    const threshold = record(raw);
    if (
      !threshold ||
      typeof threshold.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(threshold.currency) ||
      typeof threshold.amountMinorUnits !== 'string'
    ) throw new Error('Invalid approval threshold');
    safeMinor(threshold.amountMinorUnits);
    return {
      currency: threshold.currency,
      amountMinorUnits: threshold.amountMinorUnits,
      requiredApprovers: safeCount(threshold.requiredApprovers),
    };
  });
  const operationApprovers = Object.create(null) as Record<string, number>;
  const rawOperations = input.operationApprovers ?? {};
  const operations = record(rawOperations);
  if (!operations) throw new Error('Invalid operation approval requirements');
  for (const [operation, count] of Object.entries(operations)) {
    requireText(operation, 'operation');
    operationApprovers[operation] = safeCount(count);
  }
  return { minimumApprovers, approvalThresholds, operationApprovers };
}

function rowToSpace(row: Row): Space {
  return {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as Space['kind'],
    budgetId: row.budget_id as string | null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    deletedAt: row.deleted_at as string | null,
  };
}

function rowToMembership(row: Row): SpaceMembership {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    actorId: row.actor_id as string,
    grantedBy: row.granted_by as string,
    validFrom: row.valid_from as string,
    validUntil: row.valid_until as string | null,
    revokedAt: row.revoked_at as string | null,
    createdAt: row.created_at as string,
    origin: row.origin as SpaceMembership['origin'],
  };
}

function rowToAgent(row: Row): GovernanceAgent {
  return {
    agentId: row.agent_id as string,
    registeredSpaceId: row.registered_space_id as string,
    status: row.status as GovernanceAgent['status'],
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    disconnectedAt: row.disconnected_at as string | null,
    revokedAt: row.revoked_at as string | null,
  };
}

function rowToDelegation(row: Row): AgentDelegation {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    agentId: row.agent_id as string,
    issuerActorId: row.issuer_actor_id as string,
    issuerMembershipId: row.issuer_membership_id as string,
    version: row.version as string,
    rights: JSON.parse(row.rights as string) as DelegatedRight[],
    validFrom: row.valid_from as string,
    validUntil: row.valid_until as string | null,
    revokedAt: row.revoked_at as string | null,
    createdAt: row.created_at as string,
  };
}

function rowToGrant(row: Row): GovernanceResourceGrant {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    membershipId: row.membership_id as string | null,
    actorId: row.actor_id as string,
    budgetId: row.budget_id as string | null,
    capability: row.capability as string,
    resourceKind: row.resource_kind as GovernanceResourceKind,
    resourceId: row.resource_id as string,
    granted: row.granted === 1,
    restrictions: JSON.parse(row.restrictions as string) as ResourceGrantRestrictions,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revokedAt: row.revoked_at as string | null,
  };
}

function capabilityMatches(required: GovernanceResourceRef & { capability: string }, rights: readonly DelegatedRight[]): boolean {
  return rights.some((right) =>
    right.capability === required.capability &&
    right.resourceKind === required.resourceKind &&
    right.resourceId === required.resourceId,
  );
}

function operationList(value: unknown): GovernanceOperation[] | null {
  if (!Array.isArray(value)) return null;
  const found: GovernanceOperation[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const object = record(item);
    if (!object) return;
    if ('operation' in object) {
      if (typeof object.operation !== 'string' || !object.operation.trim()) throw new Error('Invalid payload operation');
      if (object.direction !== undefined && object.direction !== 'incoming' && object.direction !== 'outgoing')
        throw new Error('Invalid operation direction');
      if (object.amount !== undefined) {
        const amount = record(object.amount);
        if (!amount || typeof amount.currency !== 'string' || !/^[A-Z]{3}$/.test(amount.currency))
          throw new Error('Invalid operation amount');
        safeMinor(amount.minorUnits);
      }
      found.push(object as unknown as GovernanceOperation);
    }
    for (const child of Object.values(object)) visit(child);
  };
  try {
    visit(value);
    return found;
  } catch {
    return null;
  }
}

function payloadResources(value: unknown): GovernanceResourceRef[] | null {
  const resources: Record<string, GovernanceResourceRef> = {};
  const fieldKinds: Record<string, GovernanceResourceKind> = {
    accountId: 'account', sourceAccountId: 'account', destinationAccountId: 'account',
    fromAccountId: 'account', toAccountId: 'account', categoryId: 'category',
    sourceCategoryId: 'category', destinationCategoryId: 'category', transactionId: 'transaction',
    ruleId: 'rule', evidenceId: 'evidence', walletId: 'wallet', receiptId: 'receipt',
    commitmentId: 'commitment', scenarioId: 'scenario', reservationId: 'reservation',
    purchaseId: 'purchase', transferId: 'transfer', transferRecommendationId: 'transfer',
    sessionId: 'session', proposalId: 'proposal', ledgerEffectId: 'ledger_effect',
  };
  const validKinds: Record<string, true> = {
    space: true, budget: true, account: true, category: true, transaction: true,
    rule: true, evidence: true, wallet: true, receipt: true, commitment: true,
    scenario: true, reservation: true, purchase: true, transfer: true, ledger_effect: true,
    session: true, proposal: true,
  };
  const effectKinds: Record<string, GovernanceResourceKind> = {
    category: 'category',
    account_debit: 'account',
    destination_hold: 'account',
  };
  const visit = (item: unknown): boolean => {
    if (Array.isArray(item)) return item.every(visit);
    const object = record(item);
    if (!object) return true;
    const hasResourceKind = Object.prototype.hasOwnProperty.call(object, 'resourceKind');
    const hasResourceId = Object.prototype.hasOwnProperty.call(object, 'resourceId');
    if (hasResourceKind || hasResourceId) {
      if (hasResourceKind && hasResourceId) {
        if (typeof object.resourceKind !== 'string' || validKinds[object.resourceKind] !== true ||
            typeof object.resourceId !== 'string' || !object.resourceId.trim()) return false;
        resources[`${object.resourceKind}:${object.resourceId}`] = {
          resourceKind: object.resourceKind as GovernanceResourceKind,
          resourceId: object.resourceId,
        };
      } else if (!hasResourceKind && hasResourceId && typeof object.resourceId === 'string') {
        const kind = typeof object.kind === 'string' &&
          Object.prototype.hasOwnProperty.call(effectKinds, object.kind)
          ? effectKinds[object.kind]
          : undefined;
        if (!kind || !object.resourceId.trim()) return false;
        resources[`${kind}:${object.resourceId}`] = { resourceKind: kind, resourceId: object.resourceId };
      } else return false;
    }
    for (const [field, kind] of Object.entries(fieldKinds)) {
      const id = object[field];
      if (id !== undefined && id !== null) {
        if (typeof id !== 'string' || !id.trim()) return false;
        resources[`${kind}:${id}`] = { resourceKind: kind, resourceId: id };
      }
    }
    return Object.values(object).every(visit);
  };
  return visit(value) ? Object.values(resources) : null;
}

function financialTotals(operations: readonly GovernanceOperation[]): Record<string, bigint> | null {
  const totals: Record<string, bigint> = {};
  try {
    for (const operation of operations) {
      if (operation.direction !== 'outgoing') continue;
      if (!operation.amount) return null;
      const amount = safeMinor(operation.amount.minorUnits);
      const total = (totals[operation.amount.currency] ?? 0n) + amount;
      if (total > MAX_I64) return null;
      totals[operation.amount.currency] = total;
    }
    return totals;
  } catch {
    return null;
  }
}


/** Append-only ordered migration for Phase 7 governance and provenance. */
export function migrateGovernance(db: Database): void {
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal','shared')),
      budget_id TEXT UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE space_memberships (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      actor_id TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('created','managed','migration')),
      CHECK (valid_until IS NULL OR valid_until > valid_from)
    );
    CREATE INDEX space_membership_history ON space_memberships(space_id,actor_id,valid_from);
    CREATE INDEX space_membership_current ON space_memberships(space_id,actor_id,revoked_at,valid_from,valid_until);
    CREATE TABLE governance_policies (
      space_id TEXT NOT NULL REFERENCES spaces(id),
      version TEXT NOT NULL,
      policy TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
      PRIMARY KEY(space_id,version)
    );
    CREATE UNIQUE INDEX governance_policy_current ON governance_policies(space_id) WHERE is_current=1;

    ALTER TABLE resource_grants RENAME TO resource_grants_legacy;
    CREATE TABLE resource_grants (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      membership_id TEXT,
      actor_id TEXT NOT NULL,
      budget_id TEXT,
      capability TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      granted INTEGER NOT NULL CHECK (granted IN (0,1)),
      restrictions TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    INSERT INTO resource_grants (id,space_id,membership_id,actor_id,budget_id,capability,resource_kind,resource_id,granted,restrictions,created_at,updated_at,revoked_at)
      SELECT lower(hex(randomblob(16))),NULL,NULL,actor_id,budget_id,capability,resource_kind,resource_id,granted,'{}',updated_at,updated_at,NULL
        FROM resource_grants_legacy;
    DROP TABLE resource_grants_legacy;
    CREATE UNIQUE INDEX resource_grants_current
      ON resource_grants(membership_id,capability,resource_kind,resource_id)
      WHERE membership_id IS NOT NULL AND revoked_at IS NULL;
    CREATE INDEX resource_grants_scope ON resource_grants(space_id,budget_id,actor_id,membership_id);

    CREATE TABLE governance_agents (
      agent_id TEXT PRIMARY KEY,
      registered_space_id TEXT NOT NULL REFERENCES spaces(id),
      status TEXT NOT NULL CHECK(status IN ('active','disconnected','revoked')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      disconnected_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE agent_delegations (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      agent_id TEXT NOT NULL REFERENCES governance_agents(agent_id),
      issuer_actor_id TEXT NOT NULL,
      issuer_membership_id TEXT NOT NULL REFERENCES space_memberships(id),
      rights TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(id,version),
      CHECK (valid_until IS NULL OR valid_until > valid_from)
    );
    CREATE UNIQUE INDEX agent_delegation_current ON agent_delegations(id) WHERE revoked_at IS NULL;
    CREATE INDEX agent_delegation_scope ON agent_delegations(space_id,agent_id,revoked_at);
    CREATE TABLE credential_bindings (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      credential_id TEXT NOT NULL UNIQUE,
      credential_owner_id TEXT NOT NULL,
      principal_type TEXT NOT NULL CHECK(principal_type IN ('human','agent')),
      principal_id TEXT NOT NULL,
      delegation_id TEXT,
      delegation_version TEXT,
      issuer_membership_id TEXT NOT NULL REFERENCES space_memberships(id),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE space_governance_audit (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      subject_id TEXT,
      timestamp TEXT NOT NULL,
      details TEXT NOT NULL
    );
    CREATE INDEX space_governance_audit_space ON space_governance_audit(space_id,timestamp,id);

    ALTER TABLE transfer_previews ADD COLUMN space_id TEXT;
    ALTER TABLE transfer_previews ADD COLUMN membership_id TEXT;
    ALTER TABLE spend_sessions ADD COLUMN space_id TEXT;
    ALTER TABLE spend_sessions ADD COLUMN membership_id TEXT;
    ALTER TABLE payment_preferences ADD COLUMN space_id TEXT;
    ALTER TABLE payment_preferences ADD COLUMN membership_id TEXT;
    ALTER TABLE liquidity_claim_metadata ADD COLUMN space_id TEXT;
    ALTER TABLE liquidity_claim_metadata ADD COLUMN membership_id TEXT;
    ALTER TABLE liquidity_supplemental_facts ADD COLUMN space_id TEXT;
    ALTER TABLE liquidity_supplemental_facts ADD COLUMN membership_id TEXT;
    ALTER TABLE action_proposals ADD COLUMN space_id TEXT;
    ALTER TABLE action_proposals ADD COLUMN requester_membership_id TEXT;
    ALTER TABLE action_proposals ADD COLUMN governance_policy_version TEXT;
  `);
}

/** Shared-space authorization persistence and deterministic current-policy evaluator. */
export class SpaceGovernance {
  constructor(private readonly db: Database) {}

  private activeIdentity(actorId: string): boolean {
    const row = this.db.prepare('SELECT status FROM actor_memberships WHERE actor_id=?').get(actorId) as
      { status: string } | undefined;
    return row?.status === 'active';
  }

  private controlAuth(auth: HumanControlContext, actorId: string, now: string): void {
    const current = isoTime(now);
    const reauth = isoTime(auth.reauthenticatedAt);
    if (
      auth.method !== 'human-session' || auth.actorId !== actorId ||
      typeof auth.sessionId !== 'string' || !auth.sessionId.trim() ||
      reauth > current || current - reauth > REAUTH_WINDOW_MS || !this.activeIdentity(actorId)
    ) throw new Error('Recent reauthenticated human session required');
  }

  private space(spaceId: string, includeDeleted = false): Space | null {
    const row = this.db.prepare(`SELECT * FROM spaces WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`)
      .get(spaceId) as Row | undefined;
    return row ? rowToSpace(row) : null;
  }
  private membershipById(membershipId: string): SpaceMembership | null {
    const row = this.db.prepare('SELECT * FROM space_memberships WHERE id=?').get(membershipId) as Row | undefined;
    return row ? rowToMembership(row) : null;
  }

  private currentMembership(spaceId: string, actorId: string, now: string): SpaceMembership | null {
    if (!this.activeIdentity(actorId) || !this.space(spaceId)) return null;
    const periods = this.db.prepare(`
      SELECT * FROM space_memberships WHERE space_id=? AND actor_id=? AND revoked_at IS NULL
      ORDER BY valid_from DESC,id
    `).all(spaceId, actorId) as Row[];
    const active = periods.filter((row) =>
      isCurrentAt(row.valid_from as string, row.valid_until as string | null, now));
    return active.length === 1 ? rowToMembership(active[0]!) : null;
  }

  private manager(membership: SpaceMembership, capability: string, operation: string): boolean {
    const row = this.db.prepare(`
      SELECT restrictions FROM resource_grants
       WHERE actor_id=? AND space_id=? AND membership_id=? AND capability=?
         AND resource_kind='space' AND resource_id=? AND granted=1 AND revoked_at IS NULL
    `).get(membership.actorId, membership.spaceId, membership.id, capability, membership.spaceId) as
      { restrictions: string } | undefined;
    if (!row) return false;
    const restrictions = parseRestrictions(JSON.parse(row.restrictions) as unknown);
    return (!restrictions.operations || restrictions.operations.includes(operation)) &&
      restrictions.maxOperationCount !== 0 && !restrictions.aggregateOnly && !restrictions.proposalOnly;
  }


  private requireManager(
    spaceId: string,
    actorId: string,
    capability: string,
    now: string,
    operation = capability,
  ): SpaceMembership {
    const membership = this.currentMembership(spaceId, actorId, now);
    if (!membership || !this.manager(membership, capability, operation))
      throw new Error('Space control authorization denied');
    return membership;
  }

  private audit(spaceId: string, actorId: string, classification: string, subjectId: string | null, now: string, details: unknown = {}): void {
    this.db.prepare(`
      INSERT INTO space_governance_audit(id,space_id,actor_id,classification,subject_id,timestamp,details)
      VALUES (?,?,?,?,?,?,?)
    `).run(randomUUID(), spaceId, actorId, classification, subjectId, now, JSON.stringify(details));
  }

  private insertGrant(input: {
    spaceId: string;
    membership: SpaceMembership;
    budgetId: string | null;
    capability: string;
    resourceKind: GovernanceResourceKind;
    resourceId: string;
    restrictions: ResourceGrantRestrictions;
    now: string;
  }): GovernanceResourceGrant {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO resource_grants(id,space_id,membership_id,actor_id,budget_id,capability,resource_kind,resource_id,granted,restrictions,created_at,updated_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,NULL)
    `).run(id, input.spaceId, input.membership.id, input.membership.actorId, input.budgetId,
      input.capability, input.resourceKind, input.resourceId, JSON.stringify(input.restrictions), input.now, input.now);
    const row = this.db.prepare('SELECT * FROM resource_grants WHERE id=?').get(id) as Row;
    return rowToGrant(row);
  }

  private upsertCurrentGrant(
    input: ProvisionResourceGrantInput,
    member: SpaceMembership,
    budgetId: string | null,
    actorId: string,
  ): GovernanceResourceGrant | null {
    const restrictions = parseRestrictions(input.restrictions ?? {});
    const existing = this.db.prepare(`
      SELECT * FROM resource_grants WHERE space_id=? AND membership_id=? AND capability=?
       AND resource_kind=? AND resource_id=? AND revoked_at IS NULL
    `).get(input.spaceId, member.id, input.capability, input.resourceKind, input.resourceId) as Row | undefined;
    if (!input.granted) {
      if (!existing) return null;
      this.db.prepare('UPDATE resource_grants SET granted=0,revoked_at=?,updated_at=? WHERE id=?')
        .run(input.now, input.now, existing.id);
      this.audit(input.spaceId, actorId, 'resource_grant_revoked', existing.id as string, input.now);
      return null;
    }
    if (existing) {
      this.db.prepare('UPDATE resource_grants SET restrictions=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(restrictions), input.now, existing.id);
      const updated = this.db.prepare('SELECT * FROM resource_grants WHERE id=?').get(existing.id) as Row;
      this.audit(input.spaceId, actorId, 'resource_grant_changed', existing.id as string, input.now);
      return rowToGrant(updated);
    }
    const grant = this.insertGrant({
      spaceId: input.spaceId,
      membership: member,
      budgetId,
      capability: input.capability,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      restrictions,
      now: input.now,
    });
    this.audit(input.spaceId, actorId, 'resource_grant_created', grant.id, input.now);
    return grant;
  }

  /** Explicit internal bootstrap/fixture grant write; transport handlers must use setResourceGrant. */
  provisionResourceGrant(input: ProvisionResourceGrantInput): GovernanceResourceGrant | null {
    isoTime(input.now);
    const space = this.space(input.spaceId);
    const member = this.membershipById(input.membershipId);
    if (!space || !member || member.spaceId !== input.spaceId || member.actorId !== input.actorId)
      throw new Error('Grant membership unavailable');
    if (input.granted && this.currentMembership(input.spaceId, input.actorId, input.now)?.id !== member.id)
      throw new Error('Grant requires the current membership period');
    if (space.budgetId && input.budgetId !== undefined && input.budgetId !== space.budgetId)
      throw new Error('Grant budget does not match bound space');
    if (input.resourceKind === 'budget' && (!space.budgetId || input.resourceId !== space.budgetId))
      throw new Error('Budget resource must match the bound space');
    return this.db.transaction(() =>
      this.upsertCurrentGrant(input, member, space.budgetId, space.createdBy)).immediate();
  }

  /** Appends or revokes a membership-bound scoped grant under fresh human control. */
  setResourceGrant(input: SetResourceGrantInput): GovernanceResourceGrant | null {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    requireText(input.capability, 'capability');
    requireText(input.resourceId, 'resource ID');
    isoTime(input.now);
    const space = this.space(input.spaceId);
    const target = this.membershipById(input.membershipId);
    if (!space || !target || target.spaceId !== input.spaceId || target.actorId !== input.actorId)
      throw new Error('Grant membership unavailable');
    this.requireManager(input.spaceId, input.auth.actorId, 'grant:manage', input.now, 'grant:set');
    if (input.granted && this.currentMembership(input.spaceId, input.actorId, input.now)?.id !== target.id)
      throw new Error('Grant requires the current membership period');
    if (space.budgetId && input.budgetId !== undefined && input.budgetId !== space.budgetId)
      throw new Error('Grant budget does not match bound space');
    if (input.resourceKind === 'budget' && (!space.budgetId || input.resourceId !== space.budgetId))
      throw new Error('Budget resource must match the bound space');
    const grantInput: ProvisionResourceGrantInput = {
      spaceId: input.spaceId,
      actorId: input.actorId,
      budgetId: input.budgetId,
      membershipId: input.membershipId,
      capability: input.capability,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      granted: input.granted,
      restrictions: input.restrictions,
      now: input.now,
    };
    return this.db.transaction(() =>
      this.upsertCurrentGrant(grantInput, target, space.budgetId, input.auth.actorId)).immediate();
  }

  /** Creates an unbound space, its creator membership, default policy and control grants. */
  createSpace(input: CreateSpaceInput): Space {
    this.controlAuth(input.auth, input.actorId, input.now);
    requireText(input.name, 'space name');
    const nowMillis = isoTime(input.now);
    return this.db.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO spaces(id,name,kind,budget_id,created_by,created_at) VALUES (?,?,?,NULL,?,?)')
        .run(id, input.name.trim(), input.kind, input.actorId, input.now);
      const membership = this.createMembership(id, input.actorId, input.actorId, nowMillis, null, input.now, 'created');
      for (const capability of CONTROL_CAPABILITIES)
        this.insertGrant({
          spaceId: id,
          membership,
          budgetId: null,
          capability,
          resourceKind: 'space',
          resourceId: id,
          restrictions: {},
          now: input.now,
        });
      const policy = parsePolicy({});
      this.db.prepare(`INSERT INTO governance_policies(space_id,version,policy,actor_id,created_at,is_current)
        VALUES (?, '1', ?, ?, ?, 1)`).run(id, JSON.stringify(policy), input.actorId, input.now);
      this.audit(id, input.actorId, 'space_created', id, input.now, { kind: input.kind });
      return this.space(id)!;
    }).immediate();
  }

  /** Binds one budget through the registered-owner, fresh human connection boundary. */
  bindBudget(input: BindBudgetInput): Space {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    requireText(input.budgetId, 'budget ID');
    isoTime(input.now);
    const space = this.space(input.spaceId);
    if (!space) throw new Error('Space unavailable');
    const connectionOwner = this.db.prepare('SELECT owner_user_id FROM registration_state WHERE singleton=1').get() as
      { owner_user_id: string | null } | undefined;
    if (connectionOwner?.owner_user_id !== input.auth.actorId)
      throw new Error('Registered connection owner required');
    this.requireManager(input.spaceId, input.auth.actorId, 'connection:manage', input.now, 'connection:budget.bind');
    return this.db.transaction(() => {
      const current = this.space(input.spaceId);
      if (!current || current.budgetId !== null) throw new Error('Space budget binding cannot change');
      const owner = this.db.prepare('SELECT owner_user_id FROM registration_state WHERE singleton=1').get() as
        { owner_user_id: string | null } | undefined;
      if (owner?.owner_user_id !== input.auth.actorId) throw new Error('Registered connection owner required');
      this.requireManager(input.spaceId, input.auth.actorId, 'connection:manage', input.now, 'connection:budget.bind');
      if (this.db.prepare('SELECT 1 FROM spaces WHERE budget_id=?').get(input.budgetId))
        throw new Error('Budget is already bound to a space');
      const result = this.db.prepare('UPDATE spaces SET budget_id=? WHERE id=? AND budget_id IS NULL')
        .run(input.budgetId, input.spaceId);
      if (!result.changes) throw new Error('Space budget binding cannot change');
      this.importLegacyApprovalPolicy(input.spaceId, input.budgetId, input.auth.actorId, input.now);
      this.audit(input.spaceId, input.auth.actorId, 'budget_bound', input.budgetId, input.now);
      return this.space(input.spaceId)!;
    }).immediate();
  }
  /**
   * Imports only explicit legacy budget-scope relationships and grants after
   * owner-authorized space creation. Wildcard actor memberships stay inert.
   */
  backfillKnownBudgetSpace(input: CreateSpaceInput & { readonly budgetId: string }): Space {
    const nowMillis = isoTime(input.now);
    const now = input.now;
    requireText(input.budgetId, 'budget ID');
    return this.db.transaction(() => {
      const { budgetId, ...spaceInput } = input;
      let space = this.createSpace(spaceInput);
      space = this.bindBudget({ spaceId: space.id, budgetId, now, auth: input.auth });
      const budgetScope = `budget:${budgetId}`;
      const knownActors: Record<string, true> = {};
      for (const row of this.db.prepare('SELECT actor_id FROM actor_memberships WHERE scope=?')
        .all(budgetScope) as { actor_id: string }[]) knownActors[row.actor_id] = true;
      const oldGrants = this.db.prepare(`
        SELECT * FROM resource_grants WHERE space_id IS NULL AND membership_id IS NULL AND budget_id=?
      `).all(input.budgetId) as Row[];
      for (const row of oldGrants) knownActors[row.actor_id as string] = true;
      let memberships = 0;
      for (const actorId of Object.keys(knownActors)) {
        let member = (this.db.prepare(`SELECT * FROM space_memberships
          WHERE space_id=? AND actor_id=? AND revoked_at IS NULL`).get(space.id, actorId) as Row | undefined);
        if (!member) {
          const created = this.createMembership(space.id, actorId, input.actorId, nowMillis, null, now, 'migration');
          member = this.db.prepare('SELECT * FROM space_memberships WHERE id=?').get(created.id) as Row;
          memberships++;
        }
        const membership = rowToMembership(member);
        for (const legacy of oldGrants) {
          if (legacy.actor_id !== actorId) continue;
          const granted = legacy.granted === 1;
          this.db.prepare(`INSERT INTO resource_grants(id,space_id,membership_id,actor_id,budget_id,capability,
            resource_kind,resource_id,granted,restrictions,created_at,updated_at,revoked_at)
            VALUES (?,?,?,?,?,?,?,?,?,'{}',?,?,?)`)
            .run(randomUUID(), space.id, membership.id, actorId, space.budgetId, legacy.capability,
              legacy.resource_kind, legacy.resource_id, granted ? 1 : 0, now, now, granted ? null : now);
        }
      }
      this.audit(space.id, input.actorId, 'legacy_budget_backfilled', input.budgetId, now, {
        memberships,
        importedGrantCount: oldGrants.length,
        explicitBudgetScope: budgetScope,
      });
      return space;
    }).immediate();
  }

  /** Retires only space access; memberships, grants, policies, audit, and economic records remain. */
  deleteSpace(input: { readonly spaceId: string; readonly auth: HumanControlContext; readonly now: string }): void {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    const member = this.requireManager(input.spaceId, input.auth.actorId, 'space:manage', input.now, 'space:delete');
    this.db.transaction(() => {
      this.db.prepare('UPDATE spaces SET deleted_at=? WHERE id=? AND deleted_at IS NULL')
        .run(input.now, input.spaceId);
      this.audit(input.spaceId, member.actorId, 'space_deleted', input.spaceId, input.now);
    }).immediate();
  }

  private importLegacyApprovalPolicy(spaceId: string, budgetId: string | null, actorId: string, now: string): void {
    if (!budgetId) return;
    const current = this.db.prepare('SELECT version FROM liquidity_current_policy WHERE budget_id=?').get(budgetId) as
      { version: string } | undefined;
    if (!current) return;
    const rows = this.db.prepare(`SELECT * FROM liquidity_policy_versions
      WHERE budget_id=? ORDER BY created_at,rowid`).all(budgetId) as Row[];
    if (!rows.some((row) => row.version === current.version)) throw new Error('Legacy financial policy unavailable');
    const currentGovernance = this.getPolicy({ spaceId });
    let index = Number(currentGovernance?.version ?? '0');
    if (!Number.isSafeInteger(index)) throw new Error('Governance policy version exhausted');
    let importedVersions = 0;
    for (const row of rows) {
      const legacy = JSON.parse(row.approval_policy as string) as {
        minimumApprovers?: unknown;
        thresholds?: unknown;
      };
      const sourceThresholds = legacy.thresholds ?? [];
      if (!Array.isArray(sourceThresholds)) throw new Error('Invalid legacy approval policy');
      const policy = parsePolicy({
        minimumApprovers: legacy.minimumApprovers,
        approvalThresholds: sourceThresholds.map((value) => {
          const threshold = record(value);
          if (!threshold) throw new Error('Invalid legacy approval threshold');
          return {
            currency: threshold.currency,
            amountMinorUnits: threshold.minimumMinorUnits,
            requiredApprovers: threshold.minimumApprovers,
          };
        }),
      });
      index++;
      if (!Number.isSafeInteger(index)) throw new Error('Governance policy version exhausted');
      const isCurrent = row.version === current.version;
      if (isCurrent)
        this.db.prepare('UPDATE governance_policies SET is_current=0 WHERE space_id=? AND is_current=1').run(spaceId);
      this.db.prepare(`INSERT INTO governance_policies(space_id,version,policy,actor_id,created_at,is_current)
        VALUES (?,?,?,?,?,?)`).run(spaceId, String(index), JSON.stringify(policy),
          (row.actor_id as string | null) ?? actorId,
          (row.created_at as string | null) ?? now,
          isCurrent ? 1 : 0);
      importedVersions++;
    }
    this.audit(spaceId, actorId, 'legacy_approval_policy_imported', budgetId, now,
      { versions: importedVersions });
  }

  private createMembership(
    spaceId: string,
    actorId: string,
    grantedBy: string,
    validFrom: number,
    validUntil: number | null,
    now: string,
    origin: SpaceMembership['origin'],
  ): SpaceMembership {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO space_memberships(id,space_id,actor_id,granted_by,valid_from,valid_until,revoked_at,created_at,origin)
      VALUES (?,?,?,?,?,?,NULL,?,?)
    `).run(id, spaceId, actorId, grantedBy, new Date(validFrom).toISOString(),
      validUntil === null ? null : new Date(validUntil).toISOString(), now, origin);
    return this.membershipById(id)!;
  }

  /** Retrieves a space by ID, excluding deleted spaces. */
  getSpace(input: { readonly spaceId: string }): Space | null {
    return this.space(input.spaceId);
  }

  /** Lists non-deleted spaces in which the actor has a current membership. */
  listSpacesForActor(input: { readonly actorId: string; readonly now: string }): Space[] {
    isoTime(input.now);
    const rows = this.db.prepare(`
      SELECT s.*,m.valid_from,m.valid_until FROM spaces s JOIN space_memberships m ON m.space_id=s.id
       WHERE m.actor_id=? AND s.deleted_at IS NULL AND m.revoked_at IS NULL
       ORDER BY s.created_at,s.id
    `).all(input.actorId) as Row[];
    if (!this.activeIdentity(input.actorId)) return [];
    const bySpace = new Map<string, Row[]>();
    for (const row of rows) {
      if (!isCurrentAt(row.valid_from as string, row.valid_until as string | null, input.now)) continue;
      const entries = bySpace.get(row.id as string) ?? [];
      entries.push(row);
      bySpace.set(row.id as string, entries);
    }
    return [...bySpace.values()].filter((memberships) => memberships.length === 1)
      .map(([space]) => rowToSpace(space));
  }

  /** Returns the current half-open membership period, or null when absent/inactive. */
  getCurrentMembership(input: { readonly spaceId: string; readonly actorId: string; readonly now: string }): SpaceMembership | null {
    isoTime(input.now);
    return this.currentMembership(input.spaceId, input.actorId, input.now);
  }

  /** Returns all retained membership periods for an actor in a space. */
  listMembershipHistory(input: { readonly spaceId: string; readonly actorId?: string }): SpaceMembership[] {
    const rows = (input.actorId === undefined
      ? this.db.prepare('SELECT * FROM space_memberships WHERE space_id=? ORDER BY valid_from,id').all(input.spaceId)
      : this.db.prepare('SELECT * FROM space_memberships WHERE space_id=? AND actor_id=? ORDER BY valid_from,id').all(input.spaceId, input.actorId)) as Row[];
    return rows.map(rowToMembership);
  }

  /** Adds a new non-overlapping membership period without inheriting old grants. */
  addMembership(input: AddMembershipInput): SpaceMembership {
    return this.db.transaction(() => {
      this.controlAuth(input.auth, input.auth.actorId, input.now);
      const manager = this.requireManager(input.spaceId, input.auth.actorId, 'identity:manage', input.now, 'membership:add');
      const space = this.space(input.spaceId);
      if (!space || !this.activeIdentity(input.actorId)) throw new Error('Membership identity unavailable');
      const from = isoTime(input.validFrom);
      const until = input.validUntil === undefined ? null : isoTime(input.validUntil);
      if (until !== null && until <= from) throw new Error('Invalid membership interval');
      const periods = this.db.prepare(`SELECT valid_from,valid_until FROM space_memberships
        WHERE space_id=? AND actor_id=? AND revoked_at IS NULL`).all(input.spaceId, input.actorId) as
        { valid_from: string; valid_until: string | null }[];
      if (periods.some((period) => from < (period.valid_until === null ? Number.POSITIVE_INFINITY : isoTime(period.valid_until)) &&
        isoTime(period.valid_from) < (until ?? Number.POSITIVE_INFINITY)))
        throw new Error('Membership periods overlap');
      const membership = this.createMembership(input.spaceId, input.actorId, manager.actorId, from, until, input.now, 'managed');
      this.audit(input.spaceId, manager.actorId, 'membership_added', membership.id, input.now, { actorId: input.actorId });
      return membership;
    }).immediate();
  }

  /** Accepts one verified claimed invitation using its captured space and issuer period. */
  acceptInvitedMembership(input: AcceptInvitedMembershipInput): SpaceMembership {
    return this.db.transaction(() => {
      this.controlAuth(input.auth, input.auth.actorId, input.now);
      const now = isoTime(input.now);
      const email = input.email.trim().toLowerCase();
      if (!input.claimId.trim() || !email) throw new Error('Invitation invalid');
      const invitation = this.db.prepare(`SELECT id,status,claimed_email,expires_at,space_id,
        issuer_membership_id,governance_policy_version FROM invitations WHERE claim_id=?`)
        .get(input.claimId) as Row | undefined;
      if (!invitation || invitation.status !== 'claimed' || invitation.claimed_email !== email ||
          typeof invitation.space_id !== 'string' || typeof invitation.issuer_membership_id !== 'string' ||
          typeof invitation.governance_policy_version !== 'string' ||
          typeof invitation.expires_at !== 'string') throw new Error('Invitation invalid');
      let expiresAt: number;
      try {
        expiresAt = isoTime(invitation.expires_at);
      } catch {
        throw new Error('Invitation invalid');
      }
      const space = this.space(invitation.space_id);
      const policy = this.getPolicy({ spaceId: invitation.space_id });
      if (!space || expiresAt <= now || !policy ||
          policy.version !== invitation.governance_policy_version) throw new Error('Invitation invalid');
      const issuerPeriod = this.membershipById(invitation.issuer_membership_id);
      if (!issuerPeriod || issuerPeriod.spaceId !== space.id) throw new Error('Invitation invalid');
      let issuer: SpaceMembership;
      try {
        issuer = this.requireManager(space.id, issuerPeriod.actorId, 'membership:manage',
          input.now, 'invitation.create');
      } catch {
        throw new Error('Invitation invalid');
      }
      if (issuer.id !== issuerPeriod.id || !this.activeIdentity(input.auth.actorId) ||
          this.getAgent({ agentId: input.auth.actorId }))
        throw new Error('Invitation invalid');
      const current = this.currentMembership(space.id, input.auth.actorId, input.now);
      if (current) {
        this.audit(space.id, input.auth.actorId, 'invitation_membership_accepted', current.id, input.now, {
          invitationId: invitation.id,
          issuerActorId: issuer.actorId,
          issuerMembershipId: issuer.id,
          governancePolicyVersion: policy.version,
          existingMembership: true,
          reauthenticatedSessionId: input.auth.sessionId,
          reauthenticatedAt: input.auth.reauthenticatedAt,
        });
        return current;
      }
      const periods = this.db.prepare(`SELECT valid_until FROM space_memberships
        WHERE space_id=? AND actor_id=? AND revoked_at IS NULL`)
        .all(space.id, input.auth.actorId) as { valid_until: string | null }[];
      if (periods.some((period) => period.valid_until === null || isoTime(period.valid_until) > now))
        throw new Error('Invitation invalid');
      const membership = this.createMembership(space.id, input.auth.actorId, issuer.actorId,
        now, null, input.now, 'managed');
      this.audit(space.id, input.auth.actorId, 'invitation_membership_accepted', membership.id, input.now, {
        invitationId: invitation.id,
        issuerActorId: issuer.actorId,
        issuerMembershipId: issuer.id,
        governancePolicyVersion: policy.version,
        existingMembership: false,
        reauthenticatedSessionId: input.auth.sessionId,
        reauthenticatedAt: input.auth.reauthenticatedAt,
      });
      return membership;
    }).immediate();
  }

  /** Revokes one membership period but preserves its history and grant provenance. */
  revokeMembership(input: RevokeMembershipInput): void {
    isoTime(input.now);
    const target = this.membershipById(input.membershipId);
    if (!target || target.spaceId !== input.spaceId) throw new Error('Membership unavailable');
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    const manager = this.requireManager(input.spaceId, input.auth.actorId, 'identity:manage', input.now, 'membership:revoke');
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE space_memberships SET revoked_at=?
        WHERE space_id=? AND id=? AND revoked_at IS NULL`).run(input.now, input.spaceId, input.membershipId);
      if (!result.changes) throw new Error('Membership already revoked');
      this.audit(input.spaceId, manager.actorId, 'membership_revoked', target.id, input.now);
    }).immediate();
  }

  /** Returns the current governance policy, or null before the first explicit version. */
  getPolicy(input: { readonly spaceId: string }): VersionedGovernancePolicy | null {
    const row = this.db.prepare('SELECT * FROM governance_policies WHERE space_id=? AND is_current=1')
      .get(input.spaceId) as Row | undefined;
    if (!row) return null;
    const policy = JSON.parse(row.policy as string) as GovernancePolicy;
    return { ...policy, spaceId: row.space_id as string, version: row.version as string,
      actorId: row.actor_id as string, createdAt: row.created_at as string };
  }

  /** Appends a policy version with optimistic version matching and fresh human control proof. */
  setPolicy(input: SetGovernancePolicyInput): VersionedGovernancePolicy {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    const manager = this.requireManager(input.spaceId, input.auth.actorId, 'policy:manage', input.now, 'policy:update');
    const policy = parsePolicy(input.policy);
    isoTime(input.now);
    return this.db.transaction(() => {
      const current = this.getPolicy({ spaceId: input.spaceId });
      if ((current?.version ?? null) !== input.expectedVersion) throw new Error('Governance policy version conflict');
      const version = String(Number(current?.version ?? '0') + 1);
      if (!Number.isSafeInteger(Number(version))) throw new Error('Governance policy version exhausted');
      this.db.prepare('UPDATE governance_policies SET is_current=0 WHERE space_id=? AND is_current=1').run(input.spaceId);
      this.db.prepare(`INSERT INTO governance_policies(space_id,version,policy,actor_id,created_at,is_current)
        VALUES (?,?,?,?,?,1)`).run(input.spaceId, version, JSON.stringify(policy), manager.actorId, input.now);
      this.audit(input.spaceId, manager.actorId, 'policy_changed', version, input.now);
      return { ...policy, spaceId: input.spaceId, version, actorId: manager.actorId, createdAt: input.now };
    }).immediate();
  }

  /** Lists all retained policy versions in order. */
  listPolicyHistory(input: { readonly spaceId: string }): VersionedGovernancePolicy[] {
    return (this.db.prepare('SELECT * FROM governance_policies WHERE space_id=? ORDER BY CAST(version AS INTEGER)')
      .all(input.spaceId) as Row[]).map((row) => ({
        ...(JSON.parse(row.policy as string) as GovernancePolicy),
        spaceId: row.space_id as string,
        version: row.version as string,
        actorId: row.actor_id as string,
        createdAt: row.created_at as string,
      }));
  }


  /** Lists grant history, including revoked and inert legacy rows, for one space. */
  listResourceGrants(input: { readonly spaceId: string; readonly actorId?: string }): GovernanceResourceGrant[] {
    const rows = (input.actorId === undefined
      ? this.db.prepare('SELECT * FROM resource_grants WHERE space_id=? ORDER BY actor_id,created_at,id').all(input.spaceId)
      : this.db.prepare('SELECT * FROM resource_grants WHERE space_id=? AND actor_id=? ORDER BY created_at,id').all(input.spaceId, input.actorId)) as Row[];
    return rows.map(rowToGrant);
  }

  /** Registers an independent active agent in one explicitly selected space. */
  registerAgent(input: RegisterAgentInput): GovernanceAgent {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    requireText(input.agentId, 'agent ID');
    return this.db.transaction(() => {
      const manager = this.requireManager(
        input.spaceId, input.auth.actorId, 'agent:manage', input.now, 'agent:register',
      );
      if (this.db.prepare('SELECT 1 FROM actor_memberships WHERE actor_id=?').get(input.agentId))
        throw new Error('Agent identity conflicts with a human identity');
      if (this.getAgent({ agentId: input.agentId }))
        throw new Error('Agent identity is already registered');
      this.db.prepare(`INSERT INTO governance_agents(agent_id,registered_space_id,status,created_by,created_at)
        VALUES (?,?,'active',?,?)`).run(input.agentId, input.spaceId, input.auth.actorId, input.now);
      this.audit(input.spaceId, manager.actorId, 'agent_registered', input.agentId, input.now);
      const agent = this.getAgent({ agentId: input.agentId });
      if (!agent) throw new Error('Agent registration failed');
      return agent;
    }).immediate();
  }

  /** Retrieves an independently registered agent identity. */
  getAgent(input: { readonly agentId: string }): GovernanceAgent | null {
    const row = this.db.prepare('SELECT * FROM governance_agents WHERE agent_id=?').get(input.agentId) as Row | undefined;
    return row ? rowToAgent(row) : null;
  }

  /** Lists retained agents registered in one selected space. */
  listAgents(input: { readonly spaceId: string }): GovernanceAgent[] {
    return (this.db.prepare(`SELECT * FROM governance_agents WHERE registered_space_id=?
      ORDER BY created_at,agent_id`).all(input.spaceId) as Row[]).map(rowToAgent);
  }

  /** Disconnects or revokes an agent without deleting its identity or history. */
  setAgentStatus(input: SetAgentStatusInput): void {
    isoTime(input.now);
    const agent = this.getAgent({ agentId: input.agentId });
    if (!agent || agent.registeredSpaceId !== input.spaceId)
      throw new Error('Agent unavailable');
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    this.requireManager(input.spaceId, input.auth.actorId, 'agent:manage', input.now, 'agent:status');
    const revokedAt = input.status === 'revoked' ? input.now : agent.revokedAt;
    this.db.prepare('UPDATE governance_agents SET status=?,disconnected_at=?,revoked_at=? WHERE agent_id=?')
      .run(input.status, input.status === 'disconnected' ? input.now : agent.disconnectedAt, revokedAt, input.agentId);
    if (input.status === 'revoked')
      this.db.prepare(`UPDATE agent_delegations SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL`)
        .run(input.now, input.agentId);
    this.audit(input.spaceId, input.auth.actorId, `agent_${input.status}`, input.agentId, input.now);
  }

  /** Issues or replaces one exact bounded delegation after rechecking issuer grants. */
  delegate(input: DelegateAgentInput): AgentDelegation {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    const manager = this.requireManager(input.spaceId, input.auth.actorId, 'delegation:manage', input.now, 'delegation:set');
    const member = this.membershipById(input.issuerMembershipId);
    const agent = this.getAgent({ agentId: input.agentId });
    if (!member || member.actorId !== input.auth.actorId || member.spaceId !== input.spaceId ||
        this.currentMembership(input.spaceId, input.auth.actorId, input.now)?.id !== member.id ||
        !agent || agent.status !== 'active') throw new Error('Delegation issuer or agent unavailable');
    const from = isoTime(input.validFrom);
    const until = input.validUntil === undefined ? null : isoTime(input.validUntil);
    if (until !== null && until <= from) throw new Error('Invalid delegation interval');
    if (!Array.isArray(input.rights) || input.rights.length === 0) throw new Error('Delegation rights are required');
    const rightsByKey: Record<string, DelegatedRight> = {};
    for (const right of input.rights) {
      requireText(right.capability, 'delegated capability');
      requireText(right.resourceId, 'delegated resource');
      if (nonDelegableAgentCapability(right.capability))
        throw new Error('Control, approval, and settlement authority is human-only');
      const grant = this.currentGrant(member.actorId, input.spaceId, member.id,
        this.space(input.spaceId)?.budgetId ?? null, right);
      if (!grant) throw new Error('Delegation exceeds issuer grants');
      const restrictions = delegatedRestrictions(right.restrictions, grant.restrictions);
      const key = `${right.capability}:${right.resourceKind}:${right.resourceId}`;
      rightsByKey[key] = {
        capability: right.capability,
        resourceKind: right.resourceKind,
        resourceId: right.resourceId,
        restrictions,
      };
    }
    const rights = Object.values(rightsByKey);
    const id = input.id ?? randomUUID();
    const current = this.db.prepare('SELECT * FROM agent_delegations WHERE id=? AND revoked_at IS NULL')
      .get(id) as Row | undefined;
    if (current && current.space_id !== input.spaceId)
      throw new Error('Delegation space cannot change');
    if (current && (current.agent_id !== input.agentId ||
        current.issuer_actor_id !== member.actorId || current.issuer_membership_id !== member.id))
      throw new Error('Delegation principal and issuer binding cannot change');
    if ((current?.version as string | undefined ?? null) !== input.expectedVersion)
      throw new Error('Delegation version conflict');
    const version = String(Number(current?.version ?? '0') + 1);
    return this.db.transaction(() => {
      if (current) {
        const revoked = this.db.prepare(`UPDATE agent_delegations SET revoked_at=?
          WHERE id=? AND version=? AND space_id=? AND agent_id=? AND issuer_actor_id=?
            AND issuer_membership_id=? AND revoked_at IS NULL`)
          .run(input.now, id, input.expectedVersion, input.spaceId, input.agentId, member.actorId, member.id);
        if (!revoked.changes) throw new Error('Delegation version conflict');
      }
      this.db.prepare(`INSERT INTO agent_delegations(id,version,space_id,agent_id,issuer_actor_id,issuer_membership_id,rights,valid_from,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, version, input.spaceId, input.agentId, member.actorId, member.id,
        JSON.stringify(rights), new Date(from).toISOString(),
        until === null ? null : new Date(until).toISOString(), input.now);
      this.audit(input.spaceId, manager.actorId, 'delegation_issued', id, input.now, { version, agentId: input.agentId });
      return rowToDelegation(this.db.prepare('SELECT * FROM agent_delegations WHERE id=? AND version=?').get(id, version) as Row);
    }).immediate();
  }

  /** Revokes the currently active delegation version. */
  revokeDelegation(input: RevokeDelegationInput): void {
    isoTime(input.now);
    const row = this.db.prepare('SELECT * FROM agent_delegations WHERE id=? AND version=? AND revoked_at IS NULL')
      .get(input.delegationId, input.expectedVersion) as Row | undefined;
    if (!row || row.space_id !== input.spaceId) throw new Error('Delegation version conflict');
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    const manager = this.requireManager(input.spaceId, input.auth.actorId, 'delegation:manage', input.now, 'delegation:revoke');
    const result = this.db.prepare(`UPDATE agent_delegations SET revoked_at=?
      WHERE id=? AND version=? AND space_id=? AND revoked_at IS NULL`)
      .run(input.now, input.delegationId, input.expectedVersion, input.spaceId);
    if (!result.changes) throw new Error('Delegation version conflict');
    this.audit(input.spaceId, manager.actorId, 'delegation_revoked', input.delegationId, input.now);
  }

  /** Lists all retained delegation versions in a space. */
  listDelegations(input: { readonly spaceId: string; readonly agentId?: string }): AgentDelegation[] {
    const rows = (input.agentId === undefined
      ? this.db.prepare('SELECT * FROM agent_delegations WHERE space_id=? ORDER BY id,CAST(version AS INTEGER)').all(input.spaceId)
      : this.db.prepare('SELECT * FROM agent_delegations WHERE space_id=? AND agent_id=? ORDER BY id,CAST(version AS INTEGER)').all(input.spaceId, input.agentId)) as Row[];
    return rows.map(rowToDelegation);
  }

  /** Binds an immutable verified key ID to a human or delegated agent principal. */
  registerCredentialBinding(input: RegisterCredentialBindingInput): CredentialBinding {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    if (input.credentialOwnerId !== input.auth.actorId) throw new Error('Credential owner mismatch');
    const manager = this.requireManager(input.spaceId, input.auth.actorId, 'credential:manage', input.now, 'credential:register');
    const ownerMembership = this.currentMembership(input.spaceId, input.auth.actorId, input.now);
    if (!ownerMembership) throw new Error('Credential issuer membership unavailable');
    let delegation: AgentDelegation | null = null;
    if (input.principalType === 'agent') {
      if (!input.delegationId || !input.expectedDelegationVersion) throw new Error('Agent delegation version required');
      delegation = this.currentDelegation(input.delegationId, input.expectedDelegationVersion, input.now);
      if (!delegation || delegation.spaceId !== input.spaceId || delegation.agentId !== input.principalId ||
          delegation.issuerActorId !== input.auth.actorId || delegation.issuerMembershipId !== ownerMembership.id)
        throw new Error('Credential delegation unavailable');
    } else {
      if (input.principalId !== input.auth.actorId || !this.currentMembership(input.spaceId, input.principalId, input.now))
        throw new Error('Human credential principal unavailable');
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO credential_bindings(id,space_id,credential_id,credential_owner_id,principal_type,principal_id,
      delegation_id,delegation_version,issuer_membership_id,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run(id, input.spaceId, input.credentialId, input.credentialOwnerId, input.principalType, input.principalId,
        delegation?.id ?? null, delegation?.version ?? null, ownerMembership.id, input.now);
    this.audit(input.spaceId, manager.actorId, 'credential_bound', input.credentialId, input.now,
      { principalType: input.principalType, principalId: input.principalId });
    return this.getCredentialBinding(input.credentialId)!;
  }

  /** Revokes a credential binding while retaining its non-reusable tombstone. */
  revokeCredentialBinding(input: RevokeCredentialBindingInput): void {
    this.controlAuth(input.auth, input.auth.actorId, input.now);
    const manager = this.requireManager(input.spaceId, input.auth.actorId, 'credential:manage', input.now, 'credential:revoke');
    const row = this.db.prepare('SELECT * FROM credential_bindings WHERE credential_id=? AND space_id=? AND revoked_at IS NULL')
      .get(input.credentialId, input.spaceId) as Row | undefined;
    if (!row) throw new Error('Credential binding unavailable');
    this.db.prepare('UPDATE credential_bindings SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL')
      .run(input.now, input.credentialId);
    this.audit(input.spaceId, manager.actorId, 'credential_revoked', input.credentialId, input.now);
  }

  /** Lists credential bindings, including revoked tombstones. */
  listCredentialBindings(input: { readonly spaceId: string }): CredentialBinding[] {
    return (this.db.prepare('SELECT * FROM credential_bindings WHERE space_id=? ORDER BY created_at,id')
      .all(input.spaceId) as Row[]).map((row) => this.rowToCredential(row));
  }

  private rowToCredential(row: Row): CredentialBinding {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      credentialId: row.credential_id as string,
      credentialOwnerId: row.credential_owner_id as string,
      principalType: row.principal_type as CredentialBinding['principalType'],
      principalId: row.principal_id as string,
      delegationId: row.delegation_id as string | null,
      delegationVersion: row.delegation_version as string | null,
      issuerMembershipId: row.issuer_membership_id as string,
      createdAt: row.created_at as string,
      revokedAt: row.revoked_at as string | null,
    };
  }

  private getCredentialBinding(credentialId: string): CredentialBinding | null {
    const row = this.db.prepare('SELECT * FROM credential_bindings WHERE credential_id=?').get(credentialId) as Row | undefined;
    return row ? this.rowToCredential(row) : null;
  }

  private currentDelegation(id: string, version: string, now: string): AgentDelegation | null {
    const row = this.db.prepare(`SELECT * FROM agent_delegations WHERE id=? AND version=? AND revoked_at IS NULL`)
      .get(id, version) as Row | undefined;
    if (!row) return null;
    const delegation = rowToDelegation(row);
    if (!isCurrentAt(delegation.validFrom, delegation.validUntil, now)) return null;
    const agent = this.getAgent({ agentId: delegation.agentId });
    if (!agent || agent.status !== 'active') return null;
    if (this.currentMembership(delegation.spaceId, delegation.issuerActorId, now)?.id !== delegation.issuerMembershipId)
      return null;
    return delegation;
  }

  /** Resolves a verified credential without ever falling back from a bound agent to its human owner. */
  resolveCredentialPrincipal(input: {
    readonly credentialId: string;
    readonly referenceId: string;
    readonly spaceId?: string;
    readonly now: string;
  }): CredentialPrincipal | null {
    isoTime(input.now);
    const binding = this.getCredentialBinding(input.credentialId);
    if (!binding) {
      if (!this.activeIdentity(input.referenceId) ||
          (input.spaceId !== undefined && !this.currentMembership(input.spaceId, input.referenceId, input.now)))
        return null;
      return {
        principalType: 'human',
        actorId: input.referenceId,
        credentialId: input.credentialId,
        credentialOwnerId: input.referenceId,
      };
    }
    const issuerMembership = this.membershipById(binding.issuerMembershipId);
    if (
      binding.revokedAt ||
      binding.credentialOwnerId !== input.referenceId ||
      (input.spaceId !== undefined && binding.spaceId !== input.spaceId) ||
      !this.activeIdentity(binding.credentialOwnerId) ||
      issuerMembership?.spaceId !== binding.spaceId ||
      issuerMembership.actorId !== binding.credentialOwnerId ||
      this.currentMembership(binding.spaceId, binding.credentialOwnerId, input.now)?.id !==
        binding.issuerMembershipId
    ) return null;
    if (binding.principalType === 'human') {
      if (binding.principalId !== input.referenceId) return null;
      return {
        principalType: 'human',
        actorId: binding.principalId,
        credentialId: binding.credentialId,
        credentialOwnerId: binding.credentialOwnerId,
      };
    }
    const delegation = binding.delegationId && binding.delegationVersion
      ? this.currentDelegation(binding.delegationId, binding.delegationVersion, input.now)
      : null;
    if (!delegation || delegation.spaceId !== binding.spaceId ||
        delegation.agentId !== binding.principalId || delegation.issuerActorId !== binding.credentialOwnerId ||
        delegation.issuerMembershipId !== binding.issuerMembershipId) return null;
    return {
      principalType: 'agent',
      actorId: binding.principalId,
      credentialId: binding.credentialId,
      credentialOwnerId: binding.credentialOwnerId,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
    };
  }

  private currentGrant(actorId: string, spaceId: string, membershipId: string, budgetId: string | null,
    required: GovernanceResourceRef & { capability: string }): GovernanceResourceGrant | null {
    const row = this.db.prepare(`SELECT * FROM resource_grants WHERE actor_id=? AND space_id=? AND membership_id=?
      AND capability=? AND resource_kind=? AND resource_id=? AND granted=1 AND revoked_at IS NULL`)
      .get(actorId, spaceId, membershipId, required.capability, required.resourceKind, required.resourceId) as Row | undefined;
    if (!row || (required.resourceKind !== 'space' && budgetId !== null && row.budget_id !== budgetId))
      return null;
    return rowToGrant(row);
  }

  private restrictionsAllow(
    restrictions: ResourceGrantRestrictions,
    input: GovernanceAuthorizationInput,
    operations: readonly GovernanceOperation[],
    resources: readonly GovernanceResourceRef[],
    visibility: 'aggregate' | 'resource' | undefined,
    gross: Readonly<Record<string, bigint>>,
    purpose: 'operation' | 'rule_inspection',
  ): boolean {
    if (restrictions.aggregateOnly && (visibility !== 'aggregate' || input.phase !== 'read')) return false;
    if (restrictions.proposalOnly && input.phase !== 'propose') return false;
    const operationNames = [input.operation, ...operations.map((operation) => operation.operation)];
    if (restrictions.operations && operationNames.some((operation) => !restrictions.operations!.includes(operation))) return false;
    if (restrictions.accountIds) {
      const ruleOperations = operations.filter(({ operation }) =>
        operation === 'create_rule' || operation === 'update_rule' || operation === 'delete_rule');
      if (purpose === 'operation' && (
        ((input.operation === 'create_rule' || input.operation === 'update_rule' ||
          input.operation === 'delete_rule') &&
          !ruleOperations.some(({ operation }) => operation === input.operation)) ||
        ruleOperations.some(({ accountScope }) =>
          !accountScope || accountScope.kind !== 'accounts' || accountScope.accountIds.length === 0 ||
          accountScope.accountIds.some((accountId) =>
            !restrictions.accountIds!.includes(accountId) ||
            !resources.some((resource) =>
              resource.resourceKind === 'account' && resource.resourceId === accountId)))
      )) return false;
      if (resources.some((resource) => resource.resourceKind === 'account' &&
        !restrictions.accountIds!.includes(resource.resourceId))) return false;
    }
    if (restrictions.categoryIds && resources.some((resource) => resource.resourceKind === 'category' &&
      !restrictions.categoryIds!.includes(resource.resourceId))) return false;
    if (restrictions.maxOperationCount !== undefined && operations.length > restrictions.maxOperationCount) return false;
    if (restrictions.maxGrossOutgoing) {
      for (const limit of restrictions.maxGrossOutgoing) {
        if ((gross[limit.currency] ?? 0n) > BigInt(limit.minorUnits)) return false;
      }
      for (const [currency, amount] of Object.entries(gross)) {
        const limit = restrictions.maxGrossOutgoing.find((entry) => entry.currency === currency);
        if (!limit || amount > BigInt(limit.minorUnits)) return false;
      }
    }
    return true;
  }

  private denied(input: GovernanceAuthorizationInput, reason: string, policyVersion: string | null = null,
    membershipId: string | null = null, requiredApprovers = 0): GovernanceAuthorizationResult {
    const disposition: GovernanceDisposition = { kind: 'denied', reason };
    return { allowed: false, disposition, actorId: input.actorId, spaceId: input.spaceId,
      membershipId, policyVersion, requiredApprovers, reason };
  }

  /** Admits private baseline inspection only; it never authorizes a rule mutation. */
  authorizeRuleInspection(input: {
    readonly actorId: string;
    readonly auth: NonNullable<GovernanceAuthorizationInput['auth']>;
    readonly spaceId: string;
    readonly membershipId: string;
    readonly expectedPolicyVersion: string;
    readonly budgetId: string;
    readonly ruleId: string;
    readonly operation: 'update_rule' | 'delete_rule';
    readonly now: string;
  }) {
    const agent = input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
      ? input.auth
      : null;
    const request: GovernanceAuthorizationInput = {
      actorId: input.actorId,
      auth: input.auth,
      spaceId: input.spaceId,
      membershipId: input.membershipId,
      expectedPolicyVersion: input.expectedPolicyVersion,
      phase: 'propose',
      operation: input.operation,
      required: [
        { capability: 'rule:propose', resourceKind: 'budget', resourceId: input.budgetId, visibility: 'resource' },
        { capability: 'rule:propose', resourceKind: 'rule', resourceId: input.ruleId, visibility: 'resource' },
      ],
      payload: { operations: [{ operation: input.operation, ruleId: input.ruleId }] },
      now: input.now,
      ...(agent ? {
        agentId: agent.actorId,
        delegationId: agent.delegationId,
        delegationVersion: agent.delegationVersion,
      } : {}),
    };
    const result = input.auth &&
      typeof input.membershipId === 'string' && input.membershipId.trim() &&
      (input.operation === 'update_rule' || input.operation === 'delete_rule')
      ? this.authorizeForPurpose(request, 'rule_inspection')
      : this.denied(request, 'Rule inspection requires a verified selected-space context');
    return {
      inspectionAllowed: result.allowed,
      actorId: result.actorId,
      spaceId: result.spaceId,
      membershipId: result.membershipId,
      policyVersion: result.policyVersion,
      reason: result.allowed ? 'Private rule baseline inspection admitted' : result.reason,
    };
  }

  /** Evaluates current membership, exact grants, policy, complete payload limits and delegation synchronously. */
  authorize(input: GovernanceAuthorizationInput): GovernanceAuthorizationResult {
    return this.authorizeForPurpose(input, 'operation');
  }

  private authorizeForPurpose(
    input: GovernanceAuthorizationInput,
    purpose: 'operation' | 'rule_inspection',
  ): GovernanceAuthorizationResult {
    try {
      isoTime(input.now);
      requireText(input.operation, 'operation');
      const space = this.space(input.spaceId);
      if (!space) return this.denied(input, 'Space unavailable');
      if (purpose === 'rule_inspection' && (
        !space.budgetId ||
        !input.required.some((required) =>
          required.resourceKind === 'budget' && required.resourceId === space.budgetId)
      ))
        return this.denied(input, 'Rule inspection budget does not match the selected space');
      const policy = this.getPolicy({ spaceId: input.spaceId });
      if (!policy) return this.denied(input, 'Current governance policy unavailable');
      if (policy.version !== input.expectedPolicyVersion)
        return this.denied(input, 'Governance policy version mismatch', policy.version);
      const currentOperations = operationList(input.payload.operations);
      if (input.auth && input.auth.actorId !== input.actorId)
        return this.denied(input, 'Verified operation identity does not match actor', policy.version);
      const agentAuth = input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
        ? input.auth
        : null;
      if (input.agentId !== undefined && input.agentId !== agentAuth?.actorId)
        return this.denied(input, 'Agent principal does not match verified credential', policy.version);
      if (input.auth?.method === 'api-key') {
        const principal = this.resolveCredentialPrincipal({
          credentialId: input.auth.credentialId,
          referenceId: input.auth.credentialOwnerId,
          spaceId: input.spaceId,
          now: input.now,
        });
        if (input.auth.principalType === 'human') {
          if (!principal || principal.principalType !== 'human' || principal.actorId !== input.actorId ||
              input.auth.credentialOwnerId !== input.actorId)
            return this.denied(input, 'Human credential binding unavailable', policy.version);
        } else if (!principal || principal.principalType !== 'agent' ||
            principal.actorId !== input.actorId || principal.credentialOwnerId !== input.auth.credentialOwnerId ||
            principal.delegationId !== input.auth.delegationId ||
            principal.delegationVersion !== input.auth.delegationVersion) {
          return this.denied(input, 'Agent credential binding unavailable', policy.version);
        }
      }
      if (input.phase === 'approve') {
        if (!input.auth || input.auth.method !== 'human-session' || input.auth.actorId !== input.actorId)
          return this.denied(input, 'Human approval requires a reauthenticated session', policy.version);
        try {
          this.controlAuth(input.auth, input.actorId, input.now);
        } catch {
          return this.denied(input, 'Recent reauthenticated human session required', policy.version);
        }
      }
      const resources = payloadResources(input.payload);
      if (!currentOperations || !resources || !Array.isArray(input.required) || input.required.length === 0)
        return this.denied(input, 'Malformed or incomplete authorization payload', policy.version);
      const totals = financialTotals(currentOperations);
      if (!totals) return this.denied(input, 'Malformed or overflowing gross outgoing amount', policy.version);
      let requiredApprovers = policy.minimumApprovers;
      for (const threshold of policy.approvalThresholds)
        if ((totals[threshold.currency] ?? 0n) >= BigInt(threshold.amountMinorUnits))
          requiredApprovers = Math.max(requiredApprovers, threshold.requiredApprovers);
      for (const operation of [input.operation, ...currentOperations.map((item) => item.operation)]) {
        const approvers = policy.operationApprovers &&
          Object.prototype.hasOwnProperty.call(policy.operationApprovers, operation)
          ? policy.operationApprovers[operation]
          : 0;
        requiredApprovers = Math.max(requiredApprovers, approvers);
      }
      const expectedRefs: (GovernanceResourceRef & { capability: string; visibility?: 'aggregate' | 'resource' })[] = [];
      for (const item of input.required) {
        if (!item || typeof item.capability !== 'string' || !item.capability.trim() ||
            typeof item.resourceId !== 'string' || !item.resourceId.trim() ||
            typeof item.resourceKind !== 'string') return this.denied(input, 'Malformed required resource', policy.version);
        expectedRefs.push(item);
      }
      if (agentAuth && expectedRefs.some((required) => nonDelegableAgentCapability(required.capability)))
        return this.denied(input, 'Control, approval, and settlement authority requires a human principal', policy.version);
      const requiredKeys: Record<string, true> = {};
      for (const entry of expectedRefs) requiredKeys[`${entry.resourceKind}:${entry.resourceId}`] = true;
      const aggregateGrant = expectedRefs.some((entry) =>
        entry.resourceKind === 'budget' && entry.visibility === 'aggregate');
      const aggregateConclusionRead = input.phase === 'read' && input.operation === 'conclusion' &&
        expectedRefs.some((entry) =>
          entry.capability === 'conclusion' &&
          entry.resourceKind === 'budget' &&
          entry.visibility === 'aggregate');
      const budgetResourceRead = input.phase === 'read' && expectedRefs.some((entry) =>
        entry.capability === 'full-read' &&
        entry.resourceKind === 'budget' &&
        entry.visibility === 'resource');
      for (const resource of resources) {
        if (requiredKeys[`${resource.resourceKind}:${resource.resourceId}`] === true) continue;
        if (
          budgetResourceRead &&
          (resource.resourceKind === 'account' ||
            resource.resourceKind === 'category' ||
            resource.resourceKind === 'transaction' ||
            resource.resourceKind === 'rule')
        )
          continue;
        if ((resource.resourceKind === 'account' || resource.resourceKind === 'category') && aggregateGrant) continue;
        if (
          aggregateConclusionRead &&
          (resource.resourceKind === 'transaction' ||
            resource.resourceKind === 'evidence' ||
            resource.resourceKind === 'reservation' ||
            resource.resourceKind === 'commitment' ||
            resource.resourceKind === 'rule')
        )
          continue;
        return this.denied(input, `Payload resource omitted from authorization: ${resource.resourceKind}`, policy.version);
      }
      const isAgent = agentAuth !== null;
      let member: SpaceMembership | null = null;
      let principalActorId = input.actorId;
      let grantMembershipId = input.membershipId ?? '';
      let delegation: AgentDelegation | null = null;
      if (isAgent) {
        if (input.actorId !== agentAuth!.actorId || !input.delegationId || !input.delegationVersion ||
            input.delegationId !== agentAuth!.delegationId ||
            input.delegationVersion !== agentAuth!.delegationVersion || input.phase === 'approve' ||
            (input.phase === 'execute' && input.verifiedHumanApproval !== true))
          return this.denied(input, 'Agent authority requires a current bounded delegation and exact human approval', policy.version);
        delegation = this.currentDelegation(input.delegationId, input.delegationVersion, input.now);
        if (!delegation || delegation.spaceId !== input.spaceId || delegation.agentId !== agentAuth!.actorId)
          return this.denied(input, 'Current delegation unavailable', policy.version);
        const agent = this.getAgent({ agentId: agentAuth!.actorId });
        member = this.currentMembership(input.spaceId, delegation.issuerActorId, input.now);
        if (!agent || agent.status !== 'active' || !member || member.id !== delegation.issuerMembershipId ||
            (input.membershipId !== undefined && input.membershipId !== member.id))
          return this.denied(input, 'Delegation issuer or agent is inactive', policy.version);
        if (!isCurrentAt(delegation.validFrom, delegation.validUntil, input.now))
          return this.denied(input, 'Delegation expired', policy.version);
        principalActorId = delegation.issuerActorId;
        grantMembershipId = delegation.issuerMembershipId;
      } else {
        member = this.currentMembership(input.spaceId, input.actorId, input.now);
        if (!member || (input.membershipId !== undefined && input.membershipId !== member.id))
          return this.denied(input, 'Current membership unavailable', policy.version);
        grantMembershipId = member.id;
      }
      if (!member || !grantMembershipId) return this.denied(input, 'Membership unavailable', policy.version);
      const budgetId = space.budgetId;
      for (const required of expectedRefs) {
        const delegatedRight = isAgent
          ? delegation?.rights.find((right) => capabilityMatches(required, [right]))
          : undefined;
        if (isAgent && !delegatedRight)
          return this.denied(input, 'Requested right exceeds delegation', policy.version, member.id, requiredApprovers);
        const grant = this.currentGrant(principalActorId, input.spaceId, grantMembershipId, budgetId, required);
        if (!grant) return this.denied(input, 'Current scoped grant unavailable', policy.version, member.id, requiredApprovers);
        const relevantVisibility = required.visibility ?? (input.phase === 'read' ? undefined : 'resource');
        if (!this.restrictionsAllow(grant.restrictions, input, currentOperations, resources,
          relevantVisibility, totals, purpose) ||
          (delegatedRight?.restrictions && !this.restrictionsAllow(delegatedRight.restrictions, input,
            currentOperations, resources, relevantVisibility, totals, purpose)))
          return this.denied(input, 'Grant restrictions deny complete payload', policy.version, member.id, requiredApprovers);
      }
      const needsApproval = (input.phase === 'propose' || input.phase === 'execute') &&
        requiredApprovers > 0 && input.verifiedHumanApproval !== true;
      const disposition: GovernanceDisposition = needsApproval
        ? { kind: 'approval_required' }
        : { kind: 'authorized_without_approval' };
      return { allowed: true, disposition, actorId: input.actorId, spaceId: input.spaceId,
        membershipId: member.id, policyVersion: policy.version, requiredApprovers,
        reason: disposition.kind === 'approval_required' ? 'Human approval required' : 'Authorized' };
    } catch {
      return this.denied(input, 'Malformed governance request');
    }
  }

  /** Resolves the unique current space binding for a budget without provisioning one. */
  getSpaceForBudget(input: { readonly budgetId: string }): Space | null {
    const row = this.db.prepare('SELECT * FROM spaces WHERE budget_id=? AND deleted_at IS NULL').get(input.budgetId) as Row | undefined;
    return row ? rowToSpace(row) : null;
  }

  /** Lists scoped grant, control, and operational events for an authorized space manager. */
  listAuditRecords(input: { readonly spaceId: string; readonly actorId: string; readonly now: string }): SpaceAuditRecord[] {
    const member = this.requireManager(input.spaceId, input.actorId, 'audit:read', input.now, 'audit:read');
    if (!member) return [];

    const controlRecords = (this.db.prepare('SELECT id,actor_id,classification,subject_id,timestamp FROM space_governance_audit WHERE space_id=?')
      .all(input.spaceId) as Row[]).map((row): SpaceAuditRecord => {
        const classification = row.classification as string;
        const privateBudgetSubject = classification === 'budget_bound' ||
          classification === 'legacy_budget_backfilled' ||
          classification === 'legacy_approval_policy_imported';
        return {
          id: row.id as string,
          actorId: row.actor_id as string,
          classification,
          subjectId: privateBudgetSubject ? null : row.subject_id as string | null,
          timestamp: row.timestamp as string,
        };
      });
    const operationalRecords = (this.db.prepare(`
      SELECT audit.id,audit.actor_id,audit.classification,audit.timestamp
      FROM audit_records AS audit
      WHERE audit.budget_id=(SELECT budget_id FROM spaces WHERE id=?)
        OR EXISTS (
          SELECT 1 FROM action_proposals AS proposal
          WHERE proposal.id=audit.proposal_id AND proposal.space_id=?
        )
        OR EXISTS (
          SELECT 1 FROM invitations AS invitation
          WHERE invitation.id=audit.proposal_id AND invitation.space_id=?
        )
    `).all(input.spaceId, input.spaceId, input.spaceId) as Row[]).map((row): SpaceAuditRecord => ({
      id: row.id as string,
      actorId: row.actor_id as string,
      classification: row.classification as string,
      subjectId: null,
      timestamp: row.timestamp as string,
    }));
    return [...controlRecords, ...operationalRecords].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  }
}
