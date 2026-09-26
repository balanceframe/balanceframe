import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { ActionProposal } from './types.js';
import type {
  AdmitTransferInput,
  BackingAllocation,
  ClaimValidationContext,
  ClaimValidator,
  LiquidityActor,
  LiquidityClaimBundle,
  LiquidityClaimSet,
  LiquidityPolicyRecord,
  PaymentPreferenceRecord,
  ProspectiveClaim,
  ProspectiveClaimConsumptionVerifier,
  ProspectiveClaimLifecycle,
  ProspectiveClaimMode,
  RedactedProspectiveScope,
  RecheckTransferCommand,
  ResourceCapability,
  ResourceGrant,
  ResourceRef,
  SaveProspectiveClaimInput,
  SaveTransferPreviewInput,
  StoredProspectiveClaim,
  TransferPreview,
  VisibleStoredProspectiveClaim,
  SavePolicyInput,
  SaveSpendSessionInput,
  SettlementVerifier,
  SpendSession,
  SupplementalFactsRecord,
  TransferCommand,
  TransferPlan,
  TransferProposal,
  TransferState,
  TransitionProspectiveClaimInput,
} from './liquidity-types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function identity(value: unknown): string {
  const intent =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) =>
              key !== 'now' && key !== 'expectedVersion' && key !== 'expectedClaimSetRevision',
          ),
        )
      : value;
  return createHash('sha256').update(canonical(intent)).digest('hex');
}
function time(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp');
}
function future(expiresAt: string, now: string): void {
  time(now);
  time(expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(now)) throw new Error('Expired');
}
function positiveMoney(value: { minorUnits: string; currency: string }): void {
  if (
    !/^[1-9][0-9]*$/.test(value.minorUnits) ||
    BigInt(value.minorUnits) > 9223372036854775807n ||
    !/^[A-Z]{3}$/.test(value.currency)
  )
    throw new Error('Invalid positive Money');
}
function governedReservationMode(
  policy: LiquidityPolicyRecord['policy'],
): ProspectiveClaimMode {
  const mode = policy.reservationMode ?? 'block';
  if (mode !== 'inform' && mode !== 'block')
    throw new Error('Invalid reservation policy mode');
  return mode;
}
const initialState = (): TransferState => ({
  phase: 'proposed',
  sourceObserved: false,
  destinationObserved: false,
  reconciled: false,
  outcome: null,
});
const capabilities: ResourceCapability[] = [
  'conclusion',
  'existence',
  'name',
  'balance',
  'history',
  'liquidity',
  'source',
  'category',
  'proposal',
  'approval',
  'initiation-report',
  'confirmation',
  'audit',
  'policy',
  'session',
  'full-read',
];

/** Typed transfer specialization of the shared action/approval/idempotency/audit tables.
 * All callbacks are synchronous trusted application capabilities, never request bodies.
 */
export class LiquidityWorkflow {
  constructor(
    private readonly db: Database,
    private readonly mapProposal: (row: unknown) => ActionProposal,
  ) {}

  private member(actorId: string, budgetId: string): { capabilities: string[] } | null {
    const row = this.db.prepare('SELECT * FROM actor_memberships WHERE actor_id=?').get(actorId) as
      { status: string; scope: string; capabilities: string } | undefined;
    if (
      !row ||
      row.status !== 'active' ||
      (row.scope !== '*' && row.scope !== `budget:${budgetId}`)
    )
      return null;
    return { capabilities: JSON.parse(row.capabilities) as string[] };
  }
  isOwner(input: LiquidityActor): boolean {
    const row = this.db
      .prepare('SELECT owner_user_id FROM registration_state WHERE singleton=1')
      .get() as { owner_user_id: string | null } | undefined;
    return (
      row?.owner_user_id === input.actorId && this.member(input.actorId, input.budgetId) !== null
    );
  }
  /** Trusted provisioning primitive, like upsertActorMembership; HTTP uses manageResourceGrant. */
  setResourceGrant(input: ResourceGrant): void {
    time(input.now);
    if (
      input.capability === 'full-read' &&
      (input.resourceKind !== 'budget' || input.resourceId !== input.budgetId)
    )
      throw new Error('Full-read is a selected-budget-only resource capability');
    this.db
      .prepare(
        'INSERT INTO resource_grants VALUES (@actorId,@budgetId,@capability,@resourceKind,@resourceId,@granted,@now) ON CONFLICT(actor_id,budget_id,capability,resource_kind,resource_id) DO UPDATE SET granted=excluded.granted,updated_at=excluded.updated_at',
      )
      .run({ ...input, granted: input.granted ? 1 : 0 });
  }
  manageResourceGrant(input: ResourceGrant & { managerId: string }): void {
    if (!this.isOwner({ actorId: input.managerId, budgetId: input.budgetId }))
      throw new Error('Resource authorization denied');
    this.db
      .transaction(() => {
        if (!this.isOwner({ actorId: input.managerId, budgetId: input.budgetId }))
          throw new Error('Resource authorization denied');
        const target = this.member(input.actorId, input.budgetId);
        if (!target) throw new Error('Target membership unavailable');
        if (input.granted && !target.capabilities.includes(`liquidity:${input.capability}`))
          this.db
            .prepare('UPDATE actor_memberships SET capabilities=? WHERE actor_id=?')
            .run(
              JSON.stringify([...target.capabilities, `liquidity:${input.capability}`]),
              input.actorId,
            );
        this.setResourceGrant(input);
        this.audit(
          { actorId: input.managerId, budgetId: input.budgetId },
          'resource_grant_changed',
          null,
          input.now,
          null,
        );
      })
      .immediate();
  }
  /** Explicit registered-owner setup; invited observe-only users never inherit resource access. */
  provisionOwnerAccess(input: LiquidityActor & { resources: ResourceRef[]; now: string }): void {
    if (!this.isOwner(input)) throw new Error('Owner authorization denied');
    time(input.now);
    this.db
      .transaction(() => {
        if (!this.isOwner(input)) throw new Error('Owner authorization denied');
        const member = this.member(input.actorId, input.budgetId)!;
        const initialized = this.db
          .prepare('SELECT 1 FROM resource_grants WHERE actor_id=? AND budget_id=? LIMIT 1')
          .get(input.actorId, input.budgetId);
        if (!initialized)
          this.db
            .prepare('UPDATE actor_memberships SET capabilities=? WHERE actor_id=?')
            .run(
              JSON.stringify([
                ...new Set([...member.capabilities, ...capabilities.map((c) => `liquidity:${c}`)]),
              ]),
              input.actorId,
            );
        const insert = this.db.prepare(
          'INSERT INTO resource_grants VALUES (@actorId,@budgetId,@capability,@resourceKind,@resourceId,@granted,@now) ON CONFLICT(actor_id,budget_id,capability,resource_kind,resource_id) DO NOTHING',
        );
        let added = 0;
        for (const resource of [
          { resourceKind: 'budget' as const, resourceId: input.budgetId },
          ...input.resources,
        ])
          for (const capability of capabilities) {
            if (
              capability !== 'full-read' ||
              (resource.resourceKind === 'budget' && resource.resourceId === input.budgetId)
            )
              added += insert.run({ ...input, ...resource, capability, granted: 1 }).changes;
          }
        if (added > 0) this.audit(input, 'owner_liquidity_provisioned', null, input.now, null);
      })
      .immediate();
  }
  isAuthorized(input: LiquidityActor & ResourceRef & { capability: ResourceCapability }): boolean {
    const member = this.member(input.actorId, input.budgetId);
    if (!member?.capabilities.includes(`liquidity:${input.capability}`)) return false;
    if (
      input.capability === 'full-read' &&
      (input.resourceKind !== 'budget' ||
        input.resourceId !== input.budgetId ||
        !member.capabilities.includes('observe'))
    )
      return false;
    const row = this.db
      .prepare(
        'SELECT granted FROM resource_grants WHERE actor_id=@actorId AND budget_id=@budgetId AND capability=@capability AND resource_kind=@resourceKind AND resource_id=@resourceId',
      )
      .get(input) as { granted: number } | undefined;
    return row?.granted === 1;
  }
  requireResource(input: LiquidityActor & ResourceRef & { capability: ResourceCapability }): void {
    if (!this.isAuthorized(input)) throw new Error('Resource authorization denied');
  }
  /** Sensitive server-only input loading; public callers must use an allowlisted projector. */
  loadEvaluationState(input: LiquidityActor & { now: string }): {
    policy: LiquidityPolicyRecord | null;
    supplemental: SupplementalFactsRecord | null;
    claimSet: LiquidityClaimSet;
    priorAllocation: { sequence: number; allocation: BackingAllocation } | null;
  } {
    const member = this.member(input.actorId, input.budgetId);
    const conclusion = this.db
      .prepare(
        "SELECT 1 FROM resource_grants WHERE actor_id=? AND budget_id=? AND capability='conclusion' AND granted=1 LIMIT 1",
      )
      .get(input.actorId, input.budgetId);
    if (!member?.capabilities.includes('liquidity:conclusion') || !conclusion)
      throw new Error('Resource authorization denied');
    return this.db
      .transaction(() => {
        let policy: LiquidityPolicyRecord | null = null;
        try {
          policy = this.currentPolicy(input.budgetId);
        } catch {
          /* Absent policy is a setup state. */
        }
        const facts = this.db
          .prepare(
            'SELECT * FROM liquidity_supplemental_facts WHERE budget_id=? ORDER BY version DESC LIMIT 1',
          )
          .get(input.budgetId) as
          | {
              version: number;
              facts: string;
              actor_id: string;
              expires_at: string;
              created_at: string;
            }
          | undefined;
        const allocation = this.db
          .prepare(
            'SELECT sequence,allocation FROM liquidity_allocations WHERE budget_id=? ORDER BY sequence DESC LIMIT 1',
          )
          .get(input.budgetId) as { sequence: number; allocation: string } | undefined;
        return {
          policy,
          supplemental: facts
            ? {
                actorId: facts.actor_id,
                budgetId: input.budgetId,
                version: facts.version,
                observations: JSON.parse(facts.facts),
                expiresAt: facts.expires_at,
                createdAt: facts.created_at,
              }
            : null,
          claimSet: this.claimSet(input.budgetId, input.now, input.actorId),
          priorAllocation: allocation
            ? {
                sequence: allocation.sequence,
                allocation: JSON.parse(allocation.allocation) as BackingAllocation,
              }
            : null,
        };
      })
      .immediate();
  }
  /** Owner-governed catalog contains workflow membership only, never authentication records. */
  getResourceGrantCatalog(input: LiquidityActor): {
    members: { actorId: string }[];
    grants: Omit<ResourceGrant, 'budgetId' | 'now'>[];
  } {
    if (!this.isOwner(input)) throw new Error('Owner authorization denied');
    const members = (
      this.db
        .prepare(
          "SELECT actor_id FROM actor_memberships WHERE status='active' AND (scope='*' OR scope=?) ORDER BY actor_id",
        )
        .all(`budget:${input.budgetId}`) as { actor_id: string }[]
    ).map((row) => ({ actorId: row.actor_id }));
    const active = new Set(members.map((member) => member.actorId));
    const rows = this.db
      .prepare(
        'SELECT * FROM resource_grants WHERE budget_id=? ORDER BY actor_id,resource_kind,resource_id,capability',
      )
      .all(input.budgetId) as {
      actor_id: string;
      resource_kind: ResourceRef['resourceKind'];
      resource_id: string;
      capability: ResourceCapability;
      granted: number;
    }[];
    return {
      members,
      grants: rows
        .filter((row) => active.has(row.actor_id))
        .map((row) => ({
          actorId: row.actor_id,
          resourceKind: row.resource_kind,
          resourceId: row.resource_id,
          capability: row.capability,
          granted: row.granted === 1,
        })),
    };
  }
  private budget(input: LiquidityActor, capability: ResourceCapability): void {
    this.requireResource({
      ...input,
      capability,
      resourceKind: 'budget',
      resourceId: input.budgetId,
    });
  }
  private resources(plan: TransferPlan): ResourceRef[] {
    const resources: ResourceRef[] = plan.legs.flatMap((l) => [
      { resourceKind: 'account' as const, resourceId: l.sourceAccountId },
      { resourceKind: 'account' as const, resourceId: l.destinationAccountId },
    ]);
    for (const effect of plan.reservations) {
      resources.push({
        resourceKind: effect.kind === 'category' ? 'category' : 'account',
        resourceId: effect.resourceId,
      });
      if (effect.categoryId)
        resources.push({ resourceKind: 'category', resourceId: effect.categoryId });
    }
    if (plan.scenario.kind === 'purchases')
      for (const item of plan.scenario.items) {
        resources.push({ resourceKind: 'category', resourceId: item.categoryId });
        for (const accountId of [
          item.routeSelection.explicitAccountId,
          item.routeSelection.sessionAccountId,
          item.routeSelection.approvedPreference?.accountId,
          item.routeSelection.historicalRoute?.accountId,
        ])
          if (accountId) resources.push({ resourceKind: 'account', resourceId: accountId });
      }
    if (plan.scenario.kind === 'reallocation')
      for (const move of plan.scenario.moves)
        resources.push(
          { resourceKind: 'category', resourceId: move.sourceCategoryId },
          { resourceKind: 'category', resourceId: move.destinationCategoryId },
        );
    return [...new Map(resources.map((r) => [r.resourceKind + ':' + r.resourceId, r])).values()];
  }
  private authorizePlan(
    input: LiquidityActor,
    plan: TransferPlan,
    capability: ResourceCapability,
  ): void {
    this.budget(input, capability);
    for (const resource of this.resources(plan))
      this.requireResource({ ...input, ...resource, capability });
    if (['proposal', 'approval', 'initiation-report'].includes(capability))
      for (const leg of plan.legs)
        this.requireResource({
          ...input,
          capability: 'source',
          resourceKind: 'account',
          resourceId: leg.sourceAccountId,
        });
  }
  private load(id: string): TransferProposal {
    const row = this.db.prepare('SELECT * FROM action_proposals WHERE id=?').get(id);
    if (!row) throw new Error('Proposal unavailable');
    const p = this.mapProposal(row);
    if (p.operation !== 'transfer') throw new Error('Unsupported operation');
    return p;
  }
  getTransferProposal(input: LiquidityActor & { proposalId: string }): TransferProposal {
    this.budget(input, 'proposal');
    const p = this.load(input.proposalId);
    if (p.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
    this.authorizePlan(input, p.payload.plan, 'proposal');
    const projectionResources = [
      ...this.resources(p.payload.plan),
      ...p.payload.plan.backingAfter.lines.flatMap((line) => [
        { resourceKind: 'account' as const, resourceId: line.accountId },
        { resourceKind: 'category' as const, resourceId: line.categoryId },
      ]),
    ];
    for (const resource of projectionResources) {
      for (const capability of ['existence', 'name', 'balance', 'history', 'liquidity'] as const)
        this.requireResource({ ...input, ...resource, capability });
    }
    return p;
  }
  listTransferProposals(input: LiquidityActor): TransferProposal[] {
    this.budget(input, 'proposal');
    return (
      this.db
        .prepare(
          "SELECT id FROM action_proposals WHERE budget_id=? AND operation='transfer' ORDER BY created_at DESC,id",
        )
        .all(input.budgetId) as { id: string }[]
    ).flatMap(({ id }) => {
      const p = this.load(id);
      try {
        return [this.getTransferProposal({ ...input, proposalId: p.id })];
      } catch {
        return [];
      }
    });
  }
  /** The trusted service stores the original native plan; callers receive an allowlisted projection. */
  saveTransferPreview(input: SaveTransferPreviewInput): TransferPreview {
    return this.db
      .transaction(() => {
        this.budget(input, 'conclusion');
        future(input.plan.expiresAt, input.now);
        const id = input.id ?? randomUUID();
        if (this.db.prepare('SELECT id FROM transfer_previews WHERE id=?').get(id))
          throw new Error('Immutable preview already exists');
        const session = input.sessionId
          ? this.getSpendSession({ ...input, id: input.sessionId, now: input.now })
          : null;
        if (
          (input.sessionId && !session) ||
          (input.sessionVersion !== undefined && input.sessionVersion !== session?.version)
        )
          throw new Error('Session version conflict');
        const preview: TransferPreview = {
          id,
          actorId: input.actorId,
          budgetId: input.budgetId,
          plan: structuredClone(input.plan),
          createdAt: input.now,
          sessionId: session?.id ?? null,
          sessionVersion: session?.version ?? null,
        };
        this.db
          .prepare('INSERT INTO transfer_previews VALUES (?,?,?,?)')
          .run(id, input.budgetId, input.actorId, JSON.stringify(preview));
        return preview;
      })
      .immediate();
  }
  /** No expiry filter: only the trusted service may use an expired original for idempotency lookup. */
  getTransferPreview(input: LiquidityActor & { id: string }): TransferPreview | null {
    this.budget(input, 'conclusion');
    const row = this.db.prepare('SELECT * FROM transfer_previews WHERE id=?').get(input.id) as
      { budget_id: string; actor_id: string; record: string } | undefined;
    if (!row) return null;
    if (row.actor_id !== input.actorId || row.budget_id !== input.budgetId)
      throw new Error('Preview authorization denied');
    return JSON.parse(row.record) as TransferPreview;
  }
  private currentPolicy(budgetId: string): LiquidityPolicyRecord {
    const row = this.db
      .prepare(
        'SELECT p.* FROM liquidity_policy_versions p JOIN liquidity_current_policy c ON c.budget_id=p.budget_id AND c.version=p.version WHERE p.budget_id=?',
      )
      .get(budgetId) as
      { policy: string; approval_policy: string; actor_id: string; created_at: string } | undefined;
    if (!row) throw new Error('Liquidity policy unavailable');
    return {
      budgetId,
      policy: JSON.parse(row.policy),
      approvalPolicy: JSON.parse(row.approval_policy),
      actorId: row.actor_id,
      createdAt: row.created_at,
    };
  }
  getPolicy(input: LiquidityActor): LiquidityPolicyRecord | null {
    this.budget(input, 'policy');
    try {
      return this.currentPolicy(input.budgetId);
    } catch {
      return null;
    }
  }
  savePolicy(input: SavePolicyInput): LiquidityPolicyRecord {
    if (!this.isOwner(input)) this.budget(input, 'policy');
    const reservationMode = governedReservationMode(input.policy);
    const governedPolicy = { ...input.policy, reservationMode };
    future(governedPolicy.expiresAt, input.now);
    const counts = [
      input.approvalPolicy.minimumApprovers,
      ...(input.approvalPolicy.thresholds ?? []).map((t) => t.minimumApprovers),
    ];
    if (counts.some((n) => !Number.isInteger(n) || n < 1))
      throw new Error('Invalid approval policy');
    for (const threshold of input.approvalPolicy.thresholds ?? [])
      positiveMoney({ minorUnits: threshold.minimumMinorUnits, currency: threshold.currency });
    return this.db
      .transaction(() => {
        const current = this.db
          .prepare('SELECT version FROM liquidity_current_policy WHERE budget_id=?')
          .get(input.budgetId) as { version: string } | undefined;
        if ((current?.version ?? null) !== input.expectedVersion)
          throw new Error('Policy version conflict');
        this.db
          .prepare('INSERT INTO liquidity_policy_versions VALUES (?,?,?,?,?,?)')
          .run(
            input.budgetId,
            governedPolicy.version,
            JSON.stringify(governedPolicy),
            JSON.stringify(input.approvalPolicy),
            input.actorId,
            input.now,
          );
        this.db
          .prepare(
            'INSERT INTO liquidity_current_policy VALUES (?,?) ON CONFLICT(budget_id) DO UPDATE SET version=excluded.version',
          )
          .run(input.budgetId, governedPolicy.version);
        this.invalidateProposals(input.budgetId, input.now);
        this.audit(input, 'liquidity_policy_changed', null, input.now, null);
        return this.currentPolicy(input.budgetId);
      })
      .immediate();
  }
  private claimSet(budgetId: string, now: string, actorId: string): LiquidityClaimSet {
    time(now);
    const nowTime = Date.parse(now);
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            'SELECT c.id,c.bundle,m.mode,m.policy_version,m.claim,m.updated_at FROM liquidity_claims c LEFT JOIN liquidity_claim_metadata m ON m.budget_id=c.budget_id AND m.claim_id=c.id WHERE c.budget_id=? ORDER BY c.id',
          )
          .all(budgetId) as {
          id: string;
          bundle: string;
          mode: ProspectiveClaimMode | null;
          policy_version: string | null;
          claim: string | null;
          updated_at: string | null;
        }[];
        const bundles: LiquidityClaimBundle[] = [];
        let changed = false;
        for (const row of rows) {
          const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
          const claim = row.claim ? (JSON.parse(row.claim) as ProspectiveClaim) : null;
          const effectiveAt = claim ? Date.parse(claim.effectiveFrom) : NaN;
          if (
            bundle.state === 'active' &&
            !bundle.initiated &&
            Date.parse(bundle.expiresAt) <= nowTime
          ) {
            this.db
              .prepare('UPDATE liquidity_claims SET bundle=? WHERE budget_id=? AND id=?')
              .run(JSON.stringify({ ...bundle, state: 'expired' }), budgetId, row.id);
            this.db
              .prepare(
                "UPDATE liquidity_claim_metadata SET lifecycle_state='expired',updated_at=? WHERE budget_id=? AND claim_id=? AND lifecycle_state='active'",
              )
              .run(now, budgetId, row.id);
            if (row.mode && row.policy_version)
              this.auditProspective(
                { actorId, budgetId },
                'prospective_claim:expire',
                row.id,
                now,
                row.policy_version,
              );
            changed = true;
            continue;
          }
          if (
            claim &&
            bundle.state === 'active' &&
            !bundle.initiated &&
            Number.isFinite(effectiveAt) &&
            effectiveAt > nowTime
          )
            continue;
          if (
            claim &&
            bundle.state === 'active' &&
            !bundle.initiated &&
            Number.isFinite(effectiveAt) &&
            Date.parse(row.updated_at ?? '') < effectiveAt
          ) {
            this.db
              .prepare(
                "UPDATE liquidity_claim_metadata SET updated_at=? WHERE budget_id=? AND claim_id=? AND lifecycle_state='active'",
              )
              .run(now, budgetId, row.id);
            if (row.mode && row.policy_version)
              this.auditProspective(
                { actorId, budgetId },
                'prospective_claim:activate',
                row.id,
                now,
                row.policy_version,
                'active',
              );
            changed = true;
          }
          if (
            (row.mode !== 'inform' || bundle.state !== 'active' || bundle.initiated) &&
            (bundle.state === 'active' ||
              bundle.state === 'initiated' ||
              (bundle.initiated && bundle.state !== 'settled'))
          )
            bundles.push(bundle);
        }
        if (changed) this.bump(budgetId);
        const row = this.db
          .prepare('SELECT revision FROM liquidity_claim_revisions WHERE budget_id=?')
          .get(budgetId) as { revision: number } | undefined;
        return { revision: String(row?.revision ?? 0), bundles };
      })
      .immediate();
  }
  getClaimSet(input: LiquidityActor & { now: string }): LiquidityClaimSet {
    this.budget(input, 'liquidity');
    const set = this.claimSet(input.budgetId, input.now, input.actorId);
    for (const bundle of set.bundles)
      for (const effect of bundle.effects)
        this.requireResource({
          ...input,
          capability: 'liquidity',
          resourceKind: effect.kind === 'category' ? 'category' : 'account',
          resourceId: effect.resourceId,
        });
    return set;
  }
  private bump(budgetId: string): void {
    this.db
      .prepare(
        'INSERT INTO liquidity_claim_revisions VALUES (?,1) ON CONFLICT(budget_id) DO UPDATE SET revision=revision+1',
      )
      .run(budgetId);
  }
  private validate(
    input: LiquidityActor & { now: string },
    expected: string,
    validator: ClaimValidator,
    plan: TransferPlan | null,
    session: SpendSession | null,
    proposedClaim: LiquidityClaimBundle | null,
    ownClaimId: string | null = null,
    rejectInvalid = true,
  ): ReturnType<ClaimValidator> {
    const claimSet = this.claimSet(input.budgetId, input.now, input.actorId);
    if (claimSet.revision !== expected) throw new Error('Claim-set revision conflict');
    const policy = this.currentPolicy(input.budgetId);
    future(policy.policy.expiresAt, input.now);
    if (
      plan &&
      (plan.policyHash !== policy.policy.policyHash || plan.policyVersion !== policy.policy.version)
    )
      throw new Error('Policy changed');
    const context: ClaimValidationContext = {
      ownClaimId,
      budgetId: input.budgetId,
      claimSet,
      plan,
      session,
      proposedClaim,
      policy,
      now: input.now,
    };
    const result = validator(structuredClone(context));
    if (
      !result ||
      ('then' in result && typeof result.then === 'function') ||
      typeof result.valid !== 'boolean'
    )
      throw new Error('Invalid trusted validation result');
    if (!result.valid && rejectInvalid)
      throw new Error(result.reason ?? 'Trusted validation failed');
    return result;
  }
  private replay<T>(
    input: LiquidityActor & { idempotencyKey: string },
    operation: string,
    request: unknown,
  ): T | null {
    const row = this.db
      .prepare('SELECT * FROM idempotency_records WHERE idempotency_key=?')
      .get(input.idempotencyKey) as
      { operation: string; request_identity: string; serialised_effect: string } | undefined;
    if (!row) return null;
    if (row.operation !== operation || row.request_identity !== identity(request))
      throw new Error('Idempotency replay mismatch');
    return JSON.parse(row.serialised_effect) as T;
  }
  private record(
    input: LiquidityActor & { idempotencyKey: string; now: string },
    operation: string,
    proposalId: string,
    request: unknown,
    result: unknown,
  ): void {
    this.db
      .prepare(
        "INSERT INTO idempotency_records (idempotency_key,proposal_id,operation,executed_at,completed,idempotency_status,lease_expires_at,serialised_effect,error_message,updated_at,request_identity) VALUES (?,?,?,?,1,'succeeded',NULL,?,NULL,?,?)",
      )
      .run(
        input.idempotencyKey,
        proposalId,
        operation,
        input.now,
        JSON.stringify(result),
        input.now,
        identity(request),
      );
    this.audit(input, operation, proposalId, input.now, input.idempotencyKey);
  }
  private audit(
    input: LiquidityActor,
    operation: string,
    proposalId: string | null,
    now: string,
    idempotencyKey: string | null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO audit_records (id,classification,timestamp,actor_id,operation,proposal_id,budget_id,result,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        'workflow_transition',
        now,
        input.actorId,
        'transfer',
        proposalId,
        input.budgetId,
        operation,
        idempotencyKey,
      );
  }
  private persistClaim(
    budgetId: string,
    ownerKind: string,
    ownerId: string,
    bundle: LiquidityClaimBundle,
  ): void {
    this.db
      .prepare(
        'INSERT INTO liquidity_claims VALUES (?,?,?,?,?) ON CONFLICT(budget_id,owner_kind,owner_id) DO UPDATE SET bundle=excluded.bundle',
      )
      .run(budgetId, bundle.id, ownerKind, ownerId, JSON.stringify(bundle));
    this.bump(budgetId);
  }
  private assertNoDuplicateEconomicEffect(
    budgetId: string,
    effect: LiquidityClaimBundle['effects'][number],
  ): void {
    const rows = this.db
      .prepare('SELECT bundle FROM liquidity_claims WHERE budget_id=?')
      .all(budgetId) as { bundle: string }[];
    for (const row of rows) {
      const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
      if (bundle.state !== 'active' && bundle.state !== 'initiated') continue;
      if (
        bundle.effects.some(
          (existing) =>
            existing.kind === effect.kind &&
            existing.resourceId === effect.resourceId &&
            existing.economicObligationId === effect.economicObligationId,
        )
      )
        throw new Error('Duplicate economic obligation');
    }
  }
  private prospectiveScope(scope: ProspectiveClaim['scope']): ResourceRef {
    if (scope.kind === 'category' || scope.kind === 'account') {
      if (!scope.id.trim()) throw new Error('Unsupported claim scope');
      return {
        resourceKind: scope.kind,
        resourceId: scope.id,
      };
    }
    throw new Error('Unsupported claim scope');
  }
  private prospectiveInput(
    claim: SaveProspectiveClaimInput['claim'],
    policy: LiquidityPolicyRecord,
    now: string,
  ): {
    mode: ProspectiveClaimMode;
    expiresAt: string;
    effect: LiquidityClaimBundle['effects'][number];
  } {
    if (!claim.claimId.trim()) throw new Error('Invalid claim ID');
    if (claim.kind !== 'reservation' && claim.kind !== 'commitment')
      throw new Error('Invalid claim kind');
    if (claim.status !== 'active') throw new Error('Only active claims may be saved');
    if (!claim.sourceId.trim()) throw new Error('Missing economic obligation source');
    if (!claim.snapshotId.trim()) throw new Error('Missing snapshot identity');
    if (claim.policyVersion !== policy.policy.version) throw new Error('Policy version mismatch');
    const scope = this.prospectiveScope(claim.scope);
    positiveMoney(claim.amount);
    time(claim.effectiveFrom);
    const expiresAt = claim.expiresAt ?? policy.policy.expiresAt;
    future(expiresAt, now);
    if (Date.parse(expiresAt) > Date.parse(policy.policy.expiresAt))
      throw new Error('Claim exceeds policy expiry');
    if (Date.parse(claim.effectiveFrom) >= Date.parse(expiresAt))
      throw new Error('Invalid claim time range');
    if (claim.mode !== undefined && claim.mode !== 'inform' && claim.mode !== 'block')
      throw new Error('Invalid claim mode');
    const mode = governedReservationMode(policy.policy);
    return {
      mode,
      expiresAt,
      effect: {
        kind: scope.resourceKind === 'category' ? 'category' : 'account_debit',
        resourceId: scope.resourceId,
        amount: structuredClone(claim.amount),
        economicObligationId: claim.sourceId,
        categoryId: scope.resourceKind === 'category' ? scope.resourceId : null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    };
  }
  private storedProspectiveClaim(
    claim: ProspectiveClaim,
    mode: ProspectiveClaimMode,
    lifecycleState: ProspectiveClaimLifecycle,
  ): VisibleStoredProspectiveClaim {
    return {
      ...structuredClone(claim),
      status: lifecycleState === 'active' ? 'active' : 'released',
      mode,
      lifecycleState,
    };
  }
  private recordProspective<T>(
    input: LiquidityActor & { idempotencyKey: string; now: string },
    operation: string,
    claimId: string,
    request: unknown,
    result: T,
    policyVersion: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO idempotency_records (idempotency_key,proposal_id,operation,executed_at,completed,idempotency_status,lease_expires_at,serialised_effect,error_message,updated_at,request_identity) VALUES (?, ?, ?, ?, 1, 'succeeded', NULL, ?, NULL, ?, ?)",
      )
      .run(
        input.idempotencyKey,
        claimId,
        operation,
        input.now,
        JSON.stringify(result),
        input.now,
        identity(request),
      );
    const lifecycleState =
      typeof result === 'object' &&
      result !== null &&
      'lifecycleState' in result &&
      typeof result.lifecycleState === 'string'
        ? result.lifecycleState
        : operation;
    this.db
      .prepare(
        'INSERT INTO audit_records (id,classification,timestamp,actor_id,operation,proposal_id,budget_id,policy_version,result,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        'workflow_transition',
        input.now,
        input.actorId,
        operation,
        claimId,
        input.budgetId,
        policyVersion,
        JSON.stringify({ claimId, lifecycleState }),
        input.idempotencyKey,
      );
  }
  private auditProspective(
    input: LiquidityActor,
    operation: string,
    claimId: string,
    now: string,
    policyVersion: string,
    result = 'expired',
  ): void {
    this.db
      .prepare(
        'INSERT INTO audit_records (id,classification,timestamp,actor_id,operation,proposal_id,budget_id,policy_version,result,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
      )
      .run(
        randomUUID(),
        'workflow_transition',
        now,
        input.actorId,
        operation,
        claimId,
        input.budgetId,
        policyVersion,
        result,
      );
  }
  private projectProspectiveClaim(
    row: {
      actor_id: string;
      mode: ProspectiveClaimMode;
      lifecycle_state: ProspectiveClaimLifecycle;
      claim: string;
    },
    input: LiquidityActor,
  ): StoredProspectiveClaim {
    const claim = JSON.parse(row.claim) as ProspectiveClaim;
    const scope = this.prospectiveScope(claim.scope);
    const visible =
      claim.visibility === 'visible' &&
      this.isAuthorized({
        ...input,
        capability: 'liquidity',
        resourceKind: scope.resourceKind,
        resourceId: scope.resourceId,
      });
    const lifecycleState = row.lifecycle_state;
    const projected = this.storedProspectiveClaim(claim, row.mode, lifecycleState);
    if (visible) return projected;
    const redactedScope: RedactedProspectiveScope =
      claim.scope.kind === 'category'
        ? { kind: 'category', id: null }
        : { kind: 'account', id: null };
    return {
      claimId: null,
      kind: claim.kind,
      sourceId: null,
      scope: redactedScope,
      amount: null,
      status: projected.status,
      effectiveFrom: projected.effectiveFrom,
      expiresAt: projected.expiresAt,
      visibility: 'redacted',
      policyVersion: null,
      snapshotId: null,
      mode: projected.mode,
      lifecycleState: projected.lifecycleState,
    };
  }
  /** Atomically admits a prospective claim into the shared liquidity claim revision. */
  saveProspectiveClaim(
    input: SaveProspectiveClaimInput,
    validator: ClaimValidator,
  ): StoredProspectiveClaim {
    this.budget(input, 'liquidity');
    const scope = this.prospectiveScope(input.claim.scope);
    this.requireResource({
      ...input,
      capability: 'liquidity',
      resourceKind: scope.resourceKind,
      resourceId: scope.resourceId,
    });
    time(input.now);
    return this.db
      .transaction(() => {
        this.budget(input, 'liquidity');
        const replay = this.replay<StoredProspectiveClaim>(input, 'prospective_claim:save', input);
        if (replay) return replay;
        const policy = this.currentPolicy(input.budgetId);
        future(policy.policy.expiresAt, input.now);
        const { mode, expiresAt, effect } = this.prospectiveInput(input.claim, policy, input.now);
        this.requireResource({
          ...input,
          capability: 'liquidity',
          resourceKind: scope.resourceKind,
          resourceId: scope.resourceId,
        });
        const existing = this.db
          .prepare('SELECT owner_kind FROM liquidity_claims WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.claim.claimId) as { owner_kind: string } | undefined;
        if (existing) throw new Error('Claim ID already exists');
        this.claimSet(input.budgetId, input.now, input.actorId);
        this.assertNoDuplicateEconomicEffect(input.budgetId, effect);
        const bundle: LiquidityClaimBundle = {
          id: input.claim.claimId,
          creationSnapshotId: input.claim.snapshotId,
          creationPolicyVersion: input.claim.policyVersion,
          state: 'active',
          expiresAt,
          initiated: false,
          effects: [effect],
        };
        const storedClaim: ProspectiveClaim = {
          ...input.claim,
          expiresAt,
        };
        const candidate = { ...bundle, mode };
        this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          null,
          null,
          candidate,
          null,
          mode === 'block',
        );
        this.persistClaim(input.budgetId, 'prospective', input.claim.claimId, bundle);
        this.db
          .prepare(
            'INSERT INTO liquidity_claim_metadata (budget_id,claim_id,actor_id,mode,lifecycle_state,source_id,policy_version,snapshot_id,claim,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            input.budgetId,
            input.claim.claimId,
            input.actorId,
            mode,
            'active',
            input.claim.sourceId,
            input.claim.policyVersion,
            input.claim.snapshotId,
            JSON.stringify(storedClaim),
            input.now,
            input.now,
          );
        const result = this.projectProspectiveClaim(
          {
            actor_id: input.actorId,
            mode,
            lifecycle_state: 'active',
            claim: JSON.stringify(storedClaim),
          },
          input,
        );
        this.recordProspective(
          input,
          'prospective_claim:save',
          input.claim.claimId,
          input,
          result,
          input.claim.policyVersion,
        );
        return result;
      })
      .immediate();
  }
  /** Releases or consumes an uninitiated claim under the shared revision CAS. */
  transitionProspectiveClaim(
    input: TransitionProspectiveClaimInput,
    consumptionVerifier?: ProspectiveClaimConsumptionVerifier,
  ): StoredProspectiveClaim {
    this.budget(input, 'liquidity');
    time(input.now);
    if (!input.claimId.trim()) throw new Error('Invalid claim ID');
    if (input.transition !== 'release' && input.transition !== 'consume')
      throw new Error('Invalid claim transition');
    return this.db
      .transaction(() => {
        const replayAuthorization = this.db
          .prepare(
            'SELECT actor_id,claim FROM liquidity_claim_metadata WHERE budget_id=? AND claim_id=?',
          )
          .get(input.budgetId, input.claimId) as
          | { actor_id: string; claim: string }
          | undefined;
        if (!replayAuthorization) throw new Error('Prospective claim unavailable');
        const replayClaim = JSON.parse(replayAuthorization.claim) as ProspectiveClaim;
        const replayScope = this.prospectiveScope(replayClaim.scope);
        this.requireResource({
          ...input,
          capability: 'liquidity',
          resourceKind: replayScope.resourceKind,
          resourceId: replayScope.resourceId,
        });
        const replayConfirmationAuthorized = this.isAuthorized({
          ...input,
          capability: 'confirmation',
          resourceKind: replayScope.resourceKind,
          resourceId: replayScope.resourceId,
        });
        if (
          replayAuthorization.actor_id !== input.actorId &&
          !replayConfirmationAuthorized
        )
          throw new Error('Claim transition authorization denied');
        const replay = this.replay<StoredProspectiveClaim>(
          input,
          'prospective_claim:transition',
          input,
        );
        if (replay) return replay;
        const set = this.claimSet(input.budgetId, input.now, input.actorId);
        if (set.revision !== input.expectedClaimSetRevision)
          throw new Error('Claim-set revision conflict');
        const row = this.db
          .prepare(
            'SELECT actor_id,mode,lifecycle_state,source_id,policy_version,snapshot_id,claim FROM liquidity_claim_metadata WHERE budget_id=? AND claim_id=?',
          )
          .get(input.budgetId, input.claimId) as
          | {
              actor_id: string;
              mode: ProspectiveClaimMode;
              lifecycle_state: ProspectiveClaimLifecycle;
              source_id: string;
              policy_version: string;
              snapshot_id: string;
              claim: string;
            }
          | undefined;
        if (!row) throw new Error('Prospective claim unavailable');
        const claim = JSON.parse(row.claim) as ProspectiveClaim;
        const scope = this.prospectiveScope(claim.scope);
        this.requireResource({
          ...input,
          capability: 'liquidity',
          resourceKind: scope.resourceKind,
          resourceId: scope.resourceId,
        });
        const confirmationAuthorized = this.isAuthorized({
          ...input,
          capability: 'confirmation',
          resourceKind: scope.resourceKind,
          resourceId: scope.resourceId,
        });
        const owner = row.actor_id === input.actorId;
        if (!owner && !confirmationAuthorized)
          throw new Error('Claim transition authorization denied');
        const evidenceId = input.consumptionEvidenceId?.trim() || null;
        if (input.transition === 'consume' && !evidenceId)
          throw new Error('Verified evidence required');
        if (row.lifecycle_state !== 'active') throw new Error('Claim is not active');
        const bundleRow = this.db
          .prepare(
            "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='prospective' AND owner_id=?",
          )
          .get(input.budgetId, input.claimId) as { bundle: string } | undefined;
        if (!bundleRow) throw new Error('Prospective claim unavailable');
        const bundle = JSON.parse(bundleRow.bundle) as LiquidityClaimBundle;
        if (bundle.initiated || bundle.state === 'initiated')
          throw new Error('Initiated claim cannot be released or consumed');
        if (bundle.state !== 'active') throw new Error('Claim is not active');
        if (input.transition === 'consume') {
          const consumedEvidenceIds = (
            this.db
              .prepare(
                'SELECT consumption_evidence_id FROM liquidity_claim_metadata WHERE budget_id=? AND consumption_evidence_id IS NOT NULL',
              )
              .all(input.budgetId) as { consumption_evidence_id: string }[]
          ).map(({ consumption_evidence_id }) => consumption_evidence_id);
          if (evidenceId && consumedEvidenceIds.includes(evidenceId))
            throw new Error('Consumption evidence already consumed');
          if (!consumptionVerifier) throw new Error('Trusted consumption verifier required');
          if (!evidenceId) throw new Error('Verified evidence required');
          const verified = consumptionVerifier(
            structuredClone({
              actorId: input.actorId,
              budgetId: input.budgetId,
              claim,
              claimSet: set,
              evidenceId,
              consumedEvidenceIds,
              now: input.now,
            }),
          );
          if (
            !verified ||
            ('then' in verified && typeof verified.then === 'function') ||
            typeof verified.valid !== 'boolean'
          )
            throw new Error('Invalid trusted consumption verification result');
          if (!verified.valid)
            throw new Error(verified.reason ?? 'Trusted consumption verification failed');
        }
        const nextState = input.transition === 'release' ? 'cancelled' : 'settled';
        const lifecycleState: ProspectiveClaimLifecycle =
          input.transition === 'release' ? 'released' : 'consumed';
        this.persistClaim(input.budgetId, 'prospective', input.claimId, {
          ...bundle,
          state: nextState,
        });
        this.db
          .prepare(
            'UPDATE liquidity_claim_metadata SET lifecycle_state=?,updated_at=?,consumption_evidence_id=? WHERE budget_id=? AND claim_id=? AND lifecycle_state=?',
          )
          .run(
            lifecycleState,
            input.now,
            evidenceId ?? null,
            input.budgetId,
            input.claimId,
            'active',
          );
        const result = this.projectProspectiveClaim(
          {
            actor_id: row.actor_id,
            mode: row.mode,
            lifecycle_state: lifecycleState,
            claim: row.claim,
          },
          input,
        );
        this.recordProspective(
          input,
          'prospective_claim:transition',
          input.claimId,
          input,
          result,
          row.policy_version,
        );
        return result;
      })
      .immediate();
  }
  /** Lists lifecycle history with scope-aware redaction and informative claims included. */
  listProspectiveClaims(input: LiquidityActor & { now: string }): StoredProspectiveClaim[] {
    this.budget(input, 'liquidity');
    time(input.now);
    this.claimSet(input.budgetId, input.now, input.actorId);
    const rows = this.db
      .prepare(
        'SELECT actor_id,mode,lifecycle_state,claim FROM liquidity_claim_metadata WHERE budget_id=? ORDER BY created_at,claim_id',
      )
      .all(input.budgetId) as {
      actor_id: string;
      mode: ProspectiveClaimMode;
      lifecycle_state: ProspectiveClaimLifecycle;
      claim: string;
    }[];
    return rows.map((row) => this.projectProspectiveClaim(row, input));
  }
  admitTransferProposal(input: AdmitTransferInput, validator: ClaimValidator): TransferProposal {
    this.authorizePlan(input, input.plan, 'proposal');
    if (!/^[a-f0-9]{64}$/.test(input.plan.payloadHash) || !input.plan.legs.length)
      throw new Error('Invalid transfer plan');
    return this.db
      .transaction(() => {
        this.authorizePlan(input, input.plan, 'proposal');
        const replay = this.replay<TransferProposal>(input, 'transfer:admit', input);
        if (replay) return this.getTransferProposal({ ...input, proposalId: replay.id });
        future(input.plan.expiresAt, input.now);
        const session = input.sessionId
          ? this.getSpendSession({ ...input, id: input.sessionId, now: input.now })
          : null;
        if (input.sessionId && !session) throw new Error('Session unavailable');
        if (session && Date.parse(input.plan.expiresAt) > Date.parse(session.expiresAt))
          throw new Error('Plan exceeds session expiry');
        const id = randomUUID();
        const bundle: LiquidityClaimBundle = {
          id,
          creationSnapshotId: input.plan.snapshotId,
          creationPolicyVersion: input.plan.policyVersion,
          state: 'active',
          expiresAt: input.plan.expiresAt,
          initiated: false,
          effects: structuredClone(input.plan.reservations),
        };
        this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          input.plan,
          session,
          bundle,
        );
        const payload = {
          kind: 'transfer',
          plan: input.plan,
          sessionId: session?.id ?? null,
          sessionVersion: session?.version ?? null,
        };
        this.db
          .prepare(
            "INSERT INTO action_proposals (id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,provider_model,correlation_id,superseded_at,created_at,payload,version,state) VALUES (?,'transfer',?,?,?,?,?,?,'human',NULL,NULL,NULL,?,?,1,?)",
          )
          .run(
            id,
            input.budgetId,
            input.plan.payloadHash,
            input.plan.policyVersion,
            '{}',
            input.plan.expiresAt,
            input.actorId,
            input.now,
            JSON.stringify(payload),
            JSON.stringify(initialState()),
          );
        this.persistClaim(input.budgetId, 'proposal', id, bundle);
        const result = this.load(id);
        this.record(input, 'transfer:admit', id, input, result);
        return result;
      })
      .immediate();
  }
  private command(input: TransferCommand, capability: ResourceCapability): TransferProposal {
    this.budget(input, capability);
    const p = this.load(input.proposalId);
    if (p.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
    this.authorizePlan(input, p.payload.plan, capability);
    if (p.payloadHash !== input.payloadHash) throw new Error('Payload hash mismatch');
    return p;
  }
  private cas(p: TransferProposal, input: TransferCommand, allowExpired = false): void {
    if (p.version !== input.expectedVersion) throw new Error('Proposal version conflict');
    if (!allowExpired) {
      future(p.expiresAt, input.now);
      if (p.supersededAt || p.state.phase === 'closed')
        throw new Error('Proposal superseded or closed');
    }
  }
  private update(p: TransferProposal, state: TransferState, now: string): TransferProposal {
    const changed = this.db
      .prepare(
        "UPDATE action_proposals SET state=?,version=version+1,superseded_at=CASE WHEN ?='superseded' THEN ? ELSE superseded_at END WHERE id=? AND version=?",
      )
      .run(JSON.stringify(state), state.outcome, now, p.id, p.version);
    if (changed.changes !== 1) throw new Error('Proposal version conflict');
    return this.load(p.id);
  }
  private approvals(p: TransferProposal, now: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM proposal_approvals WHERE proposal_id=? AND payload_hash=? AND status='active' AND expires_at>? AND consumed_at IS NULL AND superseded_at IS NULL",
      )
      .all(p.id, p.payloadHash, now) as { actor_id: string; id: string }[];
    return rows
      .filter((r) => {
        try {
          this.authorizePlan(
            { actorId: r.actor_id, budgetId: p.budgetId },
            p.payload.plan,
            'approval',
          );
          return true;
        } catch {
          return false;
        }
      })
      .map((r) => r.id);
  }
  private requiredApprovers(p: TransferProposal): number {
    const policy = this.currentPolicy(p.budgetId).approvalPolicy;
    let count = policy.minimumApprovers;
    for (const t of policy.thresholds ?? [])
      if (
        t.currency === p.payload.plan.minimumAmount.currency &&
        BigInt(p.payload.plan.minimumAmount.minorUnits) >= BigInt(t.minimumMinorUnits)
      )
        count = Math.max(count, t.minimumApprovers);
    return count;
  }
  /** Read-only approval summary at the service's trusted time; never expires rows using a second clock. */
  getTransferApprovalSummary(input: LiquidityActor & { proposalId: string; now: string }): {
    requiredApprovals: number;
    approvalCount: number;
    actorHasApproved: boolean;
  } {
    return this.db
      .transaction(() => {
        time(input.now);
        const proposal = this.getTransferProposal(input);
        const ids = this.approvals(proposal, input.now);
        const own = this.db
          .prepare(
            "SELECT id FROM proposal_approvals WHERE proposal_id=? AND actor_id=? AND status='active'",
          )
          .all(proposal.id, input.actorId) as { id: string }[];
        return {
          requiredApprovals: this.requiredApprovers(proposal),
          approvalCount: ids.length,
          actorHasApproved: own.some((row) => ids.includes(row.id)),
        };
      })
      .immediate();
  }
  approveTransfer(input: RecheckTransferCommand, validator: ClaimValidator): TransferProposal {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'approval');
        const replay = this.replay<TransferProposal>(input, 'transfer:approve', input);
        if (replay) {
          future(p.expiresAt, input.now);
          return replay;
        }
        this.cas(p, input);
        if (!['proposed', 'awaiting_approval', 'approved'].includes(p.state.phase))
          throw new Error('Invalid approval phase');
        this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          p.payload.plan,
          this.linkedSession(p, input.now),
          null,
          p.id,
        );
        this.db
          .prepare(
            "INSERT INTO proposal_approvals (id,proposal_id,payload_hash,actor_id,status,expires_at,consumed_at,superseded_at,created_at,proposal_version) VALUES (?,?,?,?,'active',?,NULL,NULL,?,?)",
          )
          .run(randomUUID(), p.id, p.payloadHash, input.actorId, p.expiresAt, input.now, p.version);
        const phase =
          this.approvals(p, input.now).length >= this.requiredApprovers(p)
            ? 'approved'
            : 'awaiting_approval';
        const result = this.update(p, { ...p.state, phase }, input.now);
        this.record(input, 'transfer:approve', p.id, input, result);
        return result;
      })
      .immediate();
  }
  private linkedSession(p: TransferProposal, now: string): SpendSession | null {
    if (!p.payload.sessionId) return null;
    const row = this.db
      .prepare('SELECT record FROM spend_sessions WHERE budget_id=? AND id=?')
      .get(p.budgetId, p.payload.sessionId) as { record: string } | undefined;
    if (!row) throw new Error('Session unavailable');
    const session = JSON.parse(row.record) as SpendSession;
    future(session.expiresAt, now);
    if (session.version !== p.payload.sessionVersion) throw new Error('Session changed');
    return session;
  }
  /** Records a native recheck outcome without allowing an arbitrary state transition. */
  revalidateTransfer(input: RecheckTransferCommand, validator: ClaimValidator): TransferProposal {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'initiation-report');
        const replay = this.replay<TransferProposal>(input, 'transfer:recheck', input);
        if (replay) return replay;
        this.cas(p, input);
        if (p.state.phase === 'confirmed') throw new Error('Transfer already confirmed');
        const checked = this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          p.payload.plan,
          this.linkedSession(p, input.now),
          null,
          p.id,
          false,
        );
        if (!checked.valid)
          this.db
            .prepare(
              "UPDATE proposal_approvals SET status='superseded',superseded_at=? WHERE proposal_id=? AND status='active'",
            )
            .run(input.now, p.id);
        const outcome = checked.valid
          ? null
          : checked.reason?.includes('source_insufficient')
            ? 'source_insufficient'
            : checked.reason?.includes('delayed')
              ? 'delayed'
              : 'reconciliation_required';
        const result = this.update(
          p,
          {
            ...p.state,
            phase: checked.valid || p.state.phase === 'initiated' ? p.state.phase : 'proposed',
            outcome,
          },
          input.now,
        );
        this.record(input, 'transfer:recheck', p.id, input, result);
        return result;
      })
      .immediate();
  }
  getTransferInstructions(input: RecheckTransferCommand, validator: ClaimValidator): TransferPlan {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'initiation-report');
        this.cas(p, input);
        this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          p.payload.plan,
          this.linkedSession(p, input.now),
          null,
          p.id,
        );
        if (
          p.state.phase !== 'approved' ||
          this.approvals(p, input.now).length < this.requiredApprovers(p)
        )
          throw new Error('Current authorized approvals required');
        return p.payload.plan;
      })
      .immediate();
  }
  reportTransferInitiated(
    input: RecheckTransferCommand,
    validator: ClaimValidator,
  ): TransferProposal {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'initiation-report');
        const replay = this.replay<TransferProposal>(input, 'transfer:initiate', input);
        if (replay) return replay;
        this.cas(p, input);
        const approvals = this.approvals(p, input.now);
        if (p.state.phase !== 'approved' || approvals.length < this.requiredApprovers(p))
          throw new Error('Current authorized approvals required');
        // The user is acknowledging an external action, not requesting permission to initiate it.
        // Expected ledger movement may invalidate pre-action equality without invalidating this report.
        const diagnostic = this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          p.payload.plan,
          this.linkedSession(p, input.now),
          null,
          p.id,
          false,
        );
        const outcome = diagnostic.valid
          ? p.state.outcome
          : diagnostic.reason?.includes('delayed')
            ? 'delayed'
            : 'reconciliation_required';
        for (const id of approvals)
          this.db
            .prepare(
              "UPDATE proposal_approvals SET status='consumed',consumed_at=? WHERE id=? AND status='active'",
            )
            .run(input.now, id);
        this.changeClaim(p, 'initiated');
        const result = this.update(p, { ...p.state, phase: 'initiated', outcome }, input.now);
        this.record(input, 'transfer:initiate', p.id, input, result);
        return result;
      })
      .immediate();
  }
  private changeClaim(p: TransferProposal, state: LiquidityClaimBundle['state']): void {
    const row = this.db
      .prepare(
        "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='proposal' AND owner_id=?",
      )
      .get(p.budgetId, p.id) as { bundle: string } | undefined;
    if (!row) throw new Error('Claim missing');
    const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
    if (bundle.state === state) return;
    this.persistClaim(p.budgetId, 'proposal', p.id, {
      ...bundle,
      state,
      initiated: state === 'initiated' || bundle.initiated,
    });
  }
  verifyTransferSettlement(input: TransferCommand, verifier: SettlementVerifier): TransferProposal {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'confirmation');
        const replay = this.replay<TransferProposal>(input, 'transfer:settlement', input);
        if (replay) return replay;
        this.cas(p, input, true);
        if (p.state.phase !== 'initiated') throw new Error('Transfer not initiated');
        const existing = this.db
          .prepare('SELECT evidence_id,proposal_id FROM transfer_evidence WHERE budget_id=?')
          .all(input.budgetId) as { evidence_id: string; proposal_id: string }[];
        const result = verifier({
          plan: structuredClone(p.payload.plan),
          evaluatedAt: input.now,
          consumedEvidenceIds: existing
            .filter((r) => r.proposal_id !== p.id)
            .map((r) => r.evidence_id),
          previousEvidenceIds: existing
            .filter((r) => r.proposal_id === p.id)
            .map((r) => r.evidence_id),
        });
        if (
          !result ||
          ('then' in result && typeof result.then === 'function') ||
          (result.confirmed &&
            (!(result.sourceObserved && result.destinationObserved && result.reconciled) ||
              result.claimEffects === null ||
              result.claimEffects.length !== 0)) ||
          (!result.confirmed && result.claimEffects !== null && result.claimEffects.length === 0) ||
          ((result.sourceObserved || result.destinationObserved) && !result.evidenceIds.length)
        )
          throw new Error('Invalid native settlement result');
        for (const id of new Set(result.evidenceIds)) {
          if (existing.some((r) => r.evidence_id === id && r.proposal_id !== p.id))
            throw new Error('Settlement evidence already consumed');
          this.db
            .prepare('INSERT OR IGNORE INTO transfer_evidence VALUES (?,?,?,?,?)')
            .run(input.budgetId, id, p.id, p.payloadHash, input.now);
        }
        const outcome = result.confirmed
          ? null
          : result.reasons.includes('amount_mismatch')
            ? 'amount_mismatch'
            : result.reasons.includes('duplicate_candidate')
              ? 'duplicate_candidate'
              : result.reasons.includes('delayed')
                ? 'delayed'
                : 'reconciliation_required';
        const updated = this.update(
          p,
          {
            phase: result.confirmed ? 'confirmed' : 'initiated',
            sourceObserved:
              result.claimEffects === null ? p.state.sourceObserved : result.sourceObserved,
            destinationObserved:
              result.claimEffects === null
                ? p.state.destinationObserved
                : result.destinationObserved,
            reconciled: result.claimEffects === null ? p.state.reconciled : result.reconciled,
            outcome,
          },
          input.now,
        );
        if (result.confirmed) this.changeClaim(p, 'settled');
        else if (result.claimEffects !== null) {
          const row = this.db
            .prepare(
              "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='proposal' AND owner_id=?",
            )
            .get(p.budgetId, p.id) as { bundle: string };
          const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
          this.persistClaim(p.budgetId, 'proposal', p.id, {
            ...bundle,
            effects: result.claimEffects,
          });
        }
        this.record(input, 'transfer:settlement', p.id, input, updated);
        return updated;
      })
      .immediate();
  }
  cancelTransfer(input: TransferCommand): TransferProposal {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'proposal');
        const replay = this.replay<TransferProposal>(input, 'transfer:cancel', input);
        if (replay) return replay;
        this.cas(p, input, true);
        if (p.state.phase === 'confirmed') throw new Error('Transfer already confirmed');
        const result = this.closeProposal(p, 'cancelled', input.now);
        this.record(input, 'transfer:cancel', p.id, input, result);
        return result;
      })
      .immediate();
  }
  private closeProposal(
    p: TransferProposal,
    outcome: 'cancelled' | 'expired' | 'superseded',
    now: string,
  ): TransferProposal {
    this.db
      .prepare(
        "UPDATE proposal_approvals SET status='superseded',superseded_at=? WHERE proposal_id=? AND status='active'",
      )
      .run(now, p.id);
    const initiated = p.state.phase === 'initiated';
    if (!initiated) this.changeClaim(p, outcome === 'expired' ? 'expired' : 'cancelled');
    return this.update(p, { ...p.state, phase: initiated ? 'initiated' : 'closed', outcome }, now);
  }
  private invalidateProposals(budgetId: string, now: string, sessionId?: string): void {
    const rows = this.db
      .prepare("SELECT * FROM action_proposals WHERE budget_id=? AND operation='transfer'")
      .all(budgetId);
    for (const row of rows) {
      const p = this.mapProposal(row) as TransferProposal;
      if (
        !['confirmed', 'closed'].includes(p.state.phase) &&
        (!sessionId || p.payload.sessionId === sessionId)
      )
        this.closeProposal(p, 'superseded', now);
    }
  }
  expire(input: LiquidityActor & { now: string }): void {
    this.budget(input, 'proposal');
    time(input.now);
    this.db
      .transaction(() => {
        for (const p of this.listTransferProposals(input))
          if (
            Date.parse(p.expiresAt) <= Date.parse(input.now) &&
            !['confirmed', 'closed'].includes(p.state.phase) &&
            p.state.outcome !== 'expired'
          ) {
            this.closeProposal(p, 'expired', input.now);
            this.audit(input, 'transfer:expire', p.id, input.now, null);
          }
        const rows = this.db
          .prepare('SELECT record FROM spend_sessions WHERE budget_id=?')
          .all(input.budgetId) as { record: string }[];
        for (const row of rows) {
          const session = JSON.parse(row.record) as SpendSession;
          if (Date.parse(session.expiresAt) <= Date.parse(input.now))
            this.invalidateProposals(input.budgetId, input.now, session.id);
        }
      })
      .immediate();
  }
  private sessionResources(
    input: LiquidityActor,
    session: Pick<SpendSession, 'items' | 'accountId'>,
  ): void {
    this.budget(input, 'session');
    for (const item of session.items) {
      this.requireResource({
        ...input,
        capability: 'category',
        resourceKind: 'category',
        resourceId: item.categoryId,
      });
      const accountId = item.routeSelection.explicitAccountId ?? session.accountId;
      if (accountId)
        this.requireResource({
          ...input,
          capability: 'liquidity',
          resourceKind: 'account',
          resourceId: accountId,
        });
    }
  }
  getSpendSession(input: LiquidityActor & { id: string; now: string }): SpendSession | null {
    this.budget(input, 'session');
    const row = this.db
      .prepare('SELECT record FROM spend_sessions WHERE budget_id=? AND id=?')
      .get(input.budgetId, input.id) as { record: string } | undefined;
    if (!row) return null;
    const session = JSON.parse(row.record) as SpendSession;
    if (session.actorId !== input.actorId) throw new Error('Session authorization denied');
    this.sessionResources(input, session);
    future(session.expiresAt, input.now);
    return session;
  }
  listSpendSessions(input: LiquidityActor & { now: string }): SpendSession[] {
    this.budget(input, 'session');
    return (
      this.db
        .prepare('SELECT record FROM spend_sessions WHERE budget_id=?')
        .all(input.budgetId) as { record: string }[]
    )
      .map((r) => JSON.parse(r.record) as SpendSession)
      .filter((s) => s.actorId === input.actorId && Date.parse(s.expiresAt) > Date.parse(input.now))
      .map((s) => {
        this.sessionResources(input, s);
        return s;
      });
  }
  saveSpendSession(input: SaveSpendSessionInput, validator: ClaimValidator): SpendSession {
    this.sessionResources(input, input);
    future(input.expiresAt, input.now);
    if (
      new Set(input.items.map((i) => i.id)).size !== input.items.length ||
      input.items.some((i) => !i.id)
    )
      throw new Error('Duplicate session item ID');
    for (const item of input.items) {
      positiveMoney(item.amount);
      time(item.purchaseAt);
      time(item.requiredBy);
      if (Date.parse(item.requiredBy) > Date.parse(input.expiresAt))
        throw new Error('Session item exceeds expiry');
    }
    return this.db
      .transaction(() => {
        this.sessionResources(input, input);
        const replay = this.replay<SpendSession>(input, 'session:save', input);
        if (replay) return replay;
        const row = this.db
          .prepare('SELECT record FROM spend_sessions WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.id) as { record: string } | undefined;
        const previous = row ? (JSON.parse(row.record) as SpendSession) : null;
        if (previous && previous.actorId !== input.actorId)
          throw new Error('Session authorization denied');
        if ((previous?.version ?? 0) !== input.expectedVersion)
          throw new Error('Session version conflict');
        if (previous) future(previous.expiresAt, input.now);
        const session: SpendSession = {
          actorId: input.actorId,
          budgetId: input.budgetId,
          id: input.id,
          version: input.expectedVersion + 1,
          items: structuredClone(input.items),
          accountId: input.accountId,
          expiresAt: input.expiresAt,
          createdAt: previous?.createdAt ?? input.now,
          updatedAt: input.now,
        };
        this.validate(
          input,
          input.expectedClaimSetRevision ??
            this.claimSet(input.budgetId, input.now, input.actorId).revision,
          validator,
          null,
          session,
          input.claim ?? null,
        );
        if (input.claim) {
          if (
            !input.expectedClaimSetRevision ||
            input.claim.state !== 'active' ||
            input.claim.initiated
          )
            throw new Error('Invalid session claim');
          this.persistClaim(input.budgetId, 'session', input.id, input.claim);
        } else if (previous) {
          const claim = this.db
            .prepare(
              "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='session' AND owner_id=?",
            )
            .get(input.budgetId, input.id) as { bundle: string } | undefined;
          if (claim)
            this.persistClaim(input.budgetId, 'session', input.id, {
              ...(JSON.parse(claim.bundle) as LiquidityClaimBundle),
              state: 'cancelled',
            });
        }
        this.db
          .prepare(
            'INSERT INTO spend_sessions VALUES (?,?,?) ON CONFLICT(budget_id,id) DO UPDATE SET record=excluded.record',
          )
          .run(input.budgetId, input.id, JSON.stringify(session));
        this.invalidateProposals(input.budgetId, input.now, input.id);
        this.record(input, 'session:save', input.id, input, session);
        return session;
      })
      .immediate();
  }
  /** Cancellation expires immutable session intent and releases only uninitiated reservations. */
  cancelSpendSession(
    input: LiquidityActor & {
      id: string;
      expectedVersion: number;
      idempotencyKey: string;
      now: string;
    },
  ): SpendSession {
    return this.db
      .transaction(() => {
        this.budget(input, 'session');
        const row = this.db
          .prepare('SELECT record FROM spend_sessions WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.id) as { record: string } | undefined;
        if (!row) throw new Error('Session unavailable');
        const previous = JSON.parse(row.record) as SpendSession;
        if (previous.actorId !== input.actorId) throw new Error('Session authorization denied');
        this.sessionResources(input, previous);
        const replay = this.replay<SpendSession>(input, 'session:cancel', input);
        if (replay) return replay;
        if (previous.version !== input.expectedVersion) throw new Error('Session version conflict');
        time(input.now);
        const session = {
          ...previous,
          version: previous.version + 1,
          expiresAt: input.now,
          updatedAt: input.now,
        };
        this.db
          .prepare('UPDATE spend_sessions SET record=? WHERE budget_id=? AND id=?')
          .run(JSON.stringify(session), input.budgetId, input.id);
        const claim = this.db
          .prepare(
            "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='session' AND owner_id=?",
          )
          .get(input.budgetId, input.id) as { bundle: string } | undefined;
        if (claim) {
          const bundle = JSON.parse(claim.bundle) as LiquidityClaimBundle;
          if (!bundle.initiated && bundle.state !== 'initiated')
            this.persistClaim(input.budgetId, 'session', input.id, {
              ...bundle,
              state: 'cancelled',
            });
        }
        this.invalidateProposals(input.budgetId, input.now, input.id);
        this.record(input, 'session:cancel', input.id, input, session);
        return session;
      })
      .immediate();
  }
  savePriorAllocation(
    input: LiquidityActor & {
      expectedSequence: number;
      allocation: BackingAllocation;
      now: string;
    },
  ): number {
    this.budget(input, 'liquidity');
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT MAX(sequence) AS sequence FROM liquidity_allocations WHERE budget_id=?')
          .get(input.budgetId) as { sequence: number | null };
        if ((row.sequence ?? 0) !== input.expectedSequence)
          throw new Error('Allocation version conflict');
        const sequence = input.expectedSequence + 1;
        this.db
          .prepare('INSERT INTO liquidity_allocations VALUES (?,?,?,?)')
          .run(input.budgetId, sequence, JSON.stringify(input.allocation), input.now);
        return sequence;
      })
      .immediate();
  }
  getPriorAllocation(
    input: LiquidityActor,
  ): { sequence: number; allocation: BackingAllocation } | null {
    this.budget(input, 'liquidity');
    const row = this.db
      .prepare(
        'SELECT sequence,allocation FROM liquidity_allocations WHERE budget_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(input.budgetId) as { sequence: number; allocation: string } | undefined;
    if (!row) return null;
    const allocation = JSON.parse(row.allocation) as BackingAllocation;
    for (const line of allocation.lines) {
      this.requireResource({
        ...input,
        resourceKind: 'account',
        resourceId: line.accountId,
        capability: 'liquidity',
      });
      this.requireResource({
        ...input,
        resourceKind: 'category',
        resourceId: line.categoryId,
        capability: 'category',
      });
    }
    return { sequence: row.sequence, allocation };
  }
  saveSupplementalFacts(
    input: LiquidityActor & {
      expectedVersion: number;
      observations: SupplementalFactsRecord['observations'];
      expiresAt: string;
      now: string;
    },
  ): SupplementalFactsRecord {
    if (!this.isOwner(input)) this.budget(input, 'policy');
    future(input.expiresAt, input.now);
    if (new Set(input.observations.map((o) => o.accountId)).size !== input.observations.length)
      throw new Error('Duplicate observation account');
    for (const observation of input.observations) {
      const allowed = [
        'accountId',
        'observedAt',
        'expiresAt',
        'currentLedgerConfirmed',
        'ledgerConfirmationHash',
        'currency',
        'kind',
        'owned',
        'holds',
        'unsettledFlows',
        'obligations',
        'credit',
      ];
      if (
        Object.keys(observation).some((key) => !allowed.includes(key)) ||
        (observation.currentLedgerConfirmed !== undefined &&
          observation.currentLedgerConfirmed !== true)
      )
        throw new Error('Unsupported supplemental observation');
      time(observation.observedAt);
      future(observation.expiresAt, input.now);
      if (
        Date.parse(observation.observedAt) > Date.parse(input.now) ||
        Date.parse(observation.expiresAt) < Date.parse(input.expiresAt)
      )
        throw new Error('Observation freshness mismatch');
      if (!this.isOwner(input))
        this.requireResource({
          ...input,
          capability: 'policy',
          resourceKind: 'account',
          resourceId: observation.accountId,
        });
    }
    return this.db
      .transaction(() => {
        const current = this.db
          .prepare(
            'SELECT MAX(version) AS version FROM liquidity_supplemental_facts WHERE budget_id=?',
          )
          .get(input.budgetId) as { version: number | null };
        if ((current.version ?? 0) !== input.expectedVersion)
          throw new Error('Facts version conflict');
        const record = {
          actorId: input.actorId,
          budgetId: input.budgetId,
          version: input.expectedVersion + 1,
          observations: structuredClone(input.observations),
          expiresAt: input.expiresAt,
          createdAt: input.now,
        };
        this.db
          .prepare('INSERT INTO liquidity_supplemental_facts VALUES (?,?,?,?,?,?)')
          .run(
            input.budgetId,
            record.version,
            JSON.stringify(input.observations),
            input.actorId,
            input.expiresAt,
            input.now,
          );
        this.invalidateProposals(input.budgetId, input.now);
        this.audit(input, 'supplemental_facts_changed', null, input.now, null);
        return record;
      })
      .immediate();
  }
  getSupplementalFacts(input: LiquidityActor & { now: string }): SupplementalFactsRecord | null {
    this.budget(input, 'policy');
    const row = this.db
      .prepare(
        'SELECT * FROM liquidity_supplemental_facts WHERE budget_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(input.budgetId) as
      | { version: number; facts: string; actor_id: string; expires_at: string; created_at: string }
      | undefined;
    if (!row || Date.parse(row.expires_at) <= Date.parse(input.now)) return null;
    const observations = JSON.parse(row.facts) as SupplementalFactsRecord['observations'];
    for (const observation of observations)
      this.requireResource({
        ...input,
        capability: 'liquidity',
        resourceKind: 'account',
        resourceId: observation.accountId,
      });
    return {
      actorId: row.actor_id,
      budgetId: input.budgetId,
      version: row.version,
      observations,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
  savePaymentPreference(
    input: LiquidityActor & {
      id: string;
      expectedVersion: number;
      categoryId: string;
      accountId: string;
      expiresAt: string;
      now: string;
    },
  ): PaymentPreferenceRecord {
    this.budget(input, 'approval');
    this.requireResource({
      ...input,
      capability: 'approval',
      resourceKind: 'account',
      resourceId: input.accountId,
    });
    this.requireResource({
      ...input,
      capability: 'category',
      resourceKind: 'category',
      resourceId: input.categoryId,
    });
    future(input.expiresAt, input.now);
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT record FROM payment_preferences WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.id) as { record: string } | undefined;
        const previous = row ? (JSON.parse(row.record) as PaymentPreferenceRecord) : null;
        if (previous && previous.actorId !== input.actorId)
          throw new Error('Preference authorization denied');
        if ((previous?.version ?? 0) !== input.expectedVersion)
          throw new Error('Preference version conflict');
        const record: PaymentPreferenceRecord = {
          actorId: input.actorId,
          budgetId: input.budgetId,
          id: input.id,
          version: input.expectedVersion + 1,
          categoryId: input.categoryId,
          route: {
            accountId: input.accountId,
            referenceId: `${input.id}:${input.expectedVersion + 1}`,
          },
          expiresAt: input.expiresAt,
          approvedBy: input.actorId,
          createdAt: input.now,
        };
        this.db
          .prepare(
            'INSERT INTO payment_preferences VALUES (?,?,?) ON CONFLICT(budget_id,id) DO UPDATE SET record=excluded.record',
          )
          .run(input.budgetId, input.id, JSON.stringify(record));
        this.invalidateProposals(input.budgetId, input.now);
        this.audit(input, 'payment_preference_approved', null, input.now, null);
        return record;
      })
      .immediate();
  }
  getPaymentPreferences(
    input: LiquidityActor & { now: string; includeExpired?: boolean },
  ): PaymentPreferenceRecord[] {
    this.budget(input, 'liquidity');
    return (
      this.db
        .prepare('SELECT record FROM payment_preferences WHERE budget_id=?')
        .all(input.budgetId) as { record: string }[]
    )
      .map((r) => JSON.parse(r.record) as PaymentPreferenceRecord)
      .filter(
        (r) =>
          r.actorId === input.actorId &&
          (input.includeExpired || Date.parse(r.expiresAt) > Date.parse(input.now)) &&
          this.isAuthorized({
            ...input,
            capability: 'liquidity',
            resourceKind: 'account',
            resourceId: r.route.accountId,
          }) &&
          this.isAuthorized({
            ...input,
            capability: 'category',
            resourceKind: 'category',
            resourceId: r.categoryId,
          }) &&
          this.isAuthorized({
            actorId: r.approvedBy,
            budgetId: input.budgetId,
            capability: 'approval',
            resourceKind: 'account',
            resourceId: r.route.accountId,
          }),
      );
  }
  getTransferAudit(input: LiquidityActor & { proposalId: string }): unknown[] {
    const p = this.command(
      {
        ...input,
        payloadHash: this.getTransferProposal(input).payloadHash,
        expectedVersion: 0,
        idempotencyKey: '',
        now: '',
      },
      'audit',
    );
    return this.db
      .prepare('SELECT * FROM audit_records WHERE proposal_id=? ORDER BY timestamp,id')
      .all(p.id);
  }
}
